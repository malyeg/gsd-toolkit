#!/usr/bin/env bash
# shellcheck disable=SC2034 # assertion strings intentionally expand test variables via eval
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); PKG=$(cd "$HERE/.." && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
export GSD_NO_CORE=1   # lib/install.sh must not run the real gsd-core installer (npx)
ok(){ PASS=$((PASS+1)); printf '  ✔ %s\n' "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  ✘ %s\n' "$1"; }
assert(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }
repo(){ mkdir -p "$1"; git -C "$1" init -q -b develop; git -C "$1" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init; }
export PATH="$PKG/bin:$WORK/fakebin:$PATH"; mkdir -p "$WORK/fakebin"
for x in claude codex; do printf '#!/bin/sh\nprintf "%%s\\n" "$@"\n' > "$WORK/fakebin/$x"; chmod +x "$WORK/fakebin/$x"; done
. "$PKG/lib/common.sh"; . "$PKG/lib/provider.sh"

echo 'configuration and rendering'
R=$WORK/config; repo "$R"; printf 'provider = codex\nagent_command = codex-x\n' > "$R/.gsd.conf"
gsd_provider_resolve "$R" "" ""; assert 'legacy provider still resolves' '[ "$GSD_PROVIDER_RESOLVED:$GSD_AGENT_COMMAND_RESOLVED" = codex:codex-x ]'
printf 'provider = claude\nproviders = codex,claude\nagent_command = codex-x\n' > "$R/.gsd.conf"
gsd_provider_resolve "$R" "" ""; assert 'ordered providers overrides legacy provider' '[ "$GSD_PROVIDER_RESOLVED:$GSD_AGENT_COMMAND_RESOLVED" = codex:codex-x ]'
GSD_PROVIDER=codex GSD_AGENT_COMMAND=codex-x gsd_provider_resolve "$R" "" ""; assert 'environment overrides repo' '[ "$GSD_PROVIDER_RESOLVED:$GSD_AGENT_COMMAND_RESOLVED" = codex:codex-x ]'
GSD_PROVIDER=codex GSD_AGENT_COMMAND=codex-x gsd_provider_resolve "$R" claude /tmp/claude-x; assert 'CLI overrides environment' '[ "$GSD_PROVIDER_RESOLVED:$GSD_AGENT_COMMAND_RESOLVED" = claude:/tmp/claude-x ]'
gsd_provider_resolve "$R" nope "" >/dev/null 2>&1; assert 'unknown provider rejected' '[ $? -eq 64 ]'
gsd_provider_resolve "$R" custom 'bad command' >/dev/null 2>&1; assert 'shell template rejected' '[ $? -eq 64 ]'
gsd_start_mode_resolve "$R" ""; assert 'start mode default is flow' '[ "$GSD_START_MODE_RESOLVED" = flow ]'
printf 'start_mode = discuss\n' > "$WORK/sm.conf"; cp "$R/.gsd.conf" "$WORK/sm.saved"; cat "$WORK/sm.conf" >> "$R/.gsd.conf"; gsd_start_mode_resolve "$R" ""; assert 'repository start_mode = discuss selects discuss' '[ "$GSD_START_MODE_RESOLVED" = discuss ]'; cp "$WORK/sm.saved" "$R/.gsd.conf"
printf 'start_mode = flow\n' >> "$R/.gsd.conf"; gsd_start_mode_resolve "$R" ""; assert 'repository start mode selects flow' '[ "$GSD_START_MODE_RESOLVED" = flow ]'
gsd_start_mode_resolve "$R" discuss; assert 'CLI start mode overrides repository' '[ "$GSD_START_MODE_RESOLVED" = discuss ]'
printf 'start_mode = invalid\n' > "$R/.gsd.conf"; gsd_start_mode_resolve "$R" "" >/dev/null 2>&1; assert 'invalid start mode rejected' '[ $? -eq 64 ]'
for p in claude codex; do prompt=$(gsd_provider_prompt "$p" discuss 7); gsd_provider_argv "$p" "$p" "$prompt"; "$WORK/fakebin/$p" "${GSD_LAUNCH_ARGV[@]:1}" > "$WORK/$p-discuss.args"; prompt=$(gsd_provider_prompt "$p" flow 7); gsd_provider_argv "$p" "$p" "$prompt"; "$WORK/fakebin/$p" "${GSD_LAUNCH_ARGV[@]:1}" > "$WORK/$p-flow.args"; done
assert 'Claude discuss prompt remains backward compatible' "grep -q '^/gsd-discuss-phase 7$' '$WORK/claude-discuss.args'"
assert 'Claude flow prompt is explicit' "grep -q '^/gsdt-flow 7$' '$WORK/claude-flow.args'"
assert 'Codex discuss prompt is natural language' "grep -q 'Discuss GSD phase 7' '$WORK/codex-discuss.args'"
assert 'Codex flow prompt is natural language' "grep -q 'gsdt-flow skill' '$WORK/codex-flow.args'"
render=$(gsd_provider_render '/tmp/a b' fake 'quote " and $ safe'); assert 'rendering shell-quotes cwd and prompt' "printf '%s' \"\$render\" | grep -q '/tmp/a\\\\ b'"
assert 'missing executable still renders in print-only mode' "! command -v provider-does-not-exist >/dev/null && [ -n \"\$(gsd_provider_render /tmp provider-does-not-exist prompt)\" ]"
printf 'providers = claude,codex\nagent_command = default-claude\nclaude_command = custom-claude\ncodex_command = custom-codex\n' > "$R/.gsd.conf"
for spec in claude:custom-claude codex:custom-codex; do p=${spec%%:*}; want=${spec#*:}; gsd_provider_resolve "$R" "$p" ""; assert "$p uses its own command in one repo" '[ "$GSD_AGENT_COMMAND_RESOLVED" = "$want" ]'; done

echo 'gsdt-start discuss/flow selection'
echo 'complete provider-list validation'
R=$WORK/invalid-list; repo "$R"
for invalid in 'claude,unknown-provider' 'claude,,codex' 'claude,' ',codex' 'claude,claude' 'claude, codex' ''; do
  printf 'providers = %s\n' "$invalid" > "$R/.gsd.conf"
  gsd_provider_resolve "$R" claude '' >/dev/null 2>&1
  assert "invalid full list rejected: [$invalid]" '[ $? -eq 64 ]'
done
printf 'providers = claude,unknown-provider\n' > "$R/.gsd.conf"
mkdir -p "$R/.planning"; printf '### Phase 7: Test\n' > "$R/.planning/ROADMAP.md"
for p in claude codex; do
  gsdt-start -p 7 --repo "$R" --provider "$p" --no-launch >/dev/null 2>&1; rc=$?
  assert "$p launch rejects invalid list before worktree creation" '[ "$rc" -eq 64 ] && [ "$(git -C "$R" worktree list --porcelain | grep -c "^worktree ")" -eq 1 ]'
done
out=$(gsdt-doctor --repo "$R" --json 2>/dev/null || true)
assert 'doctor reports invalid secondary provider' 'printf "%s" "$out" | jq -e '\''any(.findings[]; .code == "T050")'\'' >/dev/null'

echo 'generated instructions follow effective repository settings'
R=$WORK/custom-layout; repo "$R"; git -C "$R" branch release
printf 'providers = codex\nbase = release\nwtdir = custom-trees\ninstall = none\n' > "$R/.gsd.conf"
(cd "$R" && gsdt-init --no-commit --no-launch) >/dev/null
assert 'instructions use configured base' 'grep -q "base .release." "$R/.gsd/INSTRUCTIONS.md"'
assert 'instructions use configured worktree directory' 'grep -q "../custom-trees/" "$R/.gsd/INSTRUCTIONS.md"'
before=$(cksum "$R/.gsd.conf" "$R/.gsd/INSTRUCTIONS.md")
(cd "$R" && gsdt-init --no-commit --no-launch) >/dev/null
assert 'custom layout rerun is idempotent' '[ "$before" = "$(cksum "$R/.gsd.conf" "$R/.gsd/INSTRUCTIONS.md")" ]'
(cd "$R" && gsdt-init --base develop --no-commit --no-launch) >/dev/null
assert 'explicit base overrides configuration and instructions together' '[ "$(gsd_base "$R")" = develop ] && grep -q "base .develop." "$R/.gsd/INSTRUCTIONS.md"'

echo 'model selection and safe argv'
R=$WORK/models; repo "$R"
printf 'claude_model = claude-test\ncodex_model = codex-test\n' > "$R/.gsd.conf"
for p in claude codex; do
  gsd_model_resolve "$R" "$p" ""
  assert "$p resolves its own model" '[ "$GSD_MODEL_RESOLVED" = "$p-test" ]'
  gsd_provider_argv "$p" "$WORK/fakebin/$p" 'prompt with spaces' "$GSD_MODEL_RESOLVED"
  actual=$("${GSD_LAUNCH_ARGV[@]}")
  expected=$(printf '%s\n' --model "$p-test" 'prompt with spaces')
  assert "$p receives exact model and prompt arguments" '[ "$actual" = "$expected" ]'
done
GSD_CODEX_MODEL=env-test gsd_model_resolve "$R" codex ""; assert 'provider model environment overrides config' '[ "$GSD_MODEL_RESOLVED" = env-test ]'
GSD_MODEL=global-test GSD_CODEX_MODEL=env-test gsd_model_resolve "$R" codex ""; assert 'session model environment overrides provider environment' '[ "$GSD_MODEL_RESOLVED" = global-test ]'
GSD_MODEL=global-test gsd_model_resolve "$R" codex cli-test; assert 'model CLI overrides environment' '[ "$GSD_MODEL_RESOLVED" = cli-test ]'
GSD_MODEL=global-test gsd_model_resolve "$R" codex default; assert 'explicit default clears model override' '[ -z "$GSD_MODEL_RESOLVED" ]'
gsd_provider_argv codex codex prompt "$GSD_MODEL_RESOLVED"; assert 'default emits no model flag' '[ "${#GSD_LAUNCH_ARGV[@]}" -eq 2 ]'
gsd_model_resolve "$R" custom unsupported >/dev/null 2>&1; assert 'custom model override is rejected' '[ $? -eq 64 ]'
gsd_model_resolve "$R" codex '--bad' >/dev/null 2>&1; assert 'model option injection rejected' '[ $? -eq 64 ]'
gsd_model_resolve "$R" codex 'two words' >/dev/null 2>&1; assert 'model whitespace rejected' '[ $? -eq 64 ]'
model_literal='model;$(touch never-created)'
gsd_model_validate codex "$model_literal" >/dev/null 2>&1; assert 'model command template with whitespace rejected' '[ $? -eq 64 ]'
model_literal='model;$(id)'
gsd_provider_argv codex "$WORK/fakebin/codex" prompt "$model_literal"
actual=$("${GSD_LAUNCH_ARGV[@]}"); expected=$(printf '%s\n' --model "$model_literal" prompt)
assert 'shell metacharacters remain a literal model argument' '[ "$actual" = "$expected" ]'
R=$WORK/init-model-invalid; repo "$R"; (cd "$R" && gsdt-init --provider codex --model '--bad' --no-launch --no-commit) >/dev/null 2>&1
assert 'invalid init model fails before bootstrap writes' '[ $? -ne 0 ] && [ ! -e "$R/.gsd.conf" ]'
R=$WORK/init-model; repo "$R"; out=$(cd "$R" && gsdt-init --new --provider codex --model model-test --no-launch --no-commit 2>&1)
assert 'init prints selected session model' '[[ "$out" == *"codex -c model_auto_compact_token_limit=300000 --model model-test"* ]]'
R=$WORK/start-mode; repo "$R"; mkdir -p "$R/.planning"; printf '# Roadmap\n\n### Phase 7: Test phase\n' > "$R/.planning/ROADMAP.md"; printf 'base = develop\nwtdir = start-worktrees\ninstall = none\nproviders = claude\n' > "$R/.gsd.conf"; git -C "$R" add .; git -C "$R" -c user.name=t -c user.email=t@t commit -qm planning
out=$(gsdt-start -p 7 --repo "$R" --provider custom --agent-command fake-provider --no-launch 2>&1); assert 'gsdt-start defaults to the flow' "printf '%s' \"\$out\" | grep -q 'fake-provider Drive.*GSD.*phase.*7'"; assert 'gsdt-start suppresses stale worker next steps' "! printf '%s' \"\$out\" | grep -q 'Open an agent session there'"
printf 'start_mode = discuss\n' >> "$R/.gsd.conf"; out=$(gsdt-start -p 7 --repo "$R" --provider custom --agent-command fake-provider --no-launch 2>&1); assert 'gsdt-start honors start_mode = discuss' "printf '%s' \"\$out\" | grep -q 'fake-provider Discuss.*GSD.*phase.*7'"
out=$(gsdt-start -p 7 --repo "$R" --provider custom --agent-command fake-provider --flow --no-launch 2>&1); assert '--flow overrides start_mode = discuss' "printf '%s' \"\$out\" | grep -q 'fake-provider Drive.*GSD.*phase.*7'"
out=$(gsdt-start -p 7 --repo "$R" --provider custom --agent-command fake-provider --flow --no-flow --no-launch 2>&1); assert '--no-flow overrides earlier --flow' "printf '%s' \"\$out\" | grep -q 'fake-provider Discuss.*GSD.*phase.*7'"
out=$(gsdt-start -p 7 --repo "$R" --provider custom --agent-command fake-provider --no-flow --flow --no-launch 2>&1); assert '--flow overrides earlier --no-flow' "printf '%s' \"\$out\" | grep -q 'fake-provider Drive.*GSD.*phase.*7'"

echo 'bootstrap adapters and idempotence'
out=$(gsdt-start -p 7 --repo "$R" --provider codex --model model-test --no-launch 2>&1)
assert 'start prints selected session model' '[[ "$out" == *"codex -c model_auto_compact_token_limit=300000 --model model-test"* ]]'

echo 'compact point (compact_at)'
out=$(gsdt-start -p 7 --repo "$R" --provider claude --no-launch 2>&1)
assert 'claude session compacts at 300000 by default' '[[ "$out" == *"env CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000 claude"* ]]'
out=$(CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000 gsdt-start -p 7 --repo "$R" --provider claude --no-launch 2>&1)
assert 'a compact window the user exported wins' '[[ "$out" != *"AUTO_COMPACT"* ]]'
out=$(GSD_COMPACT_AT=300000 gsdt-start -p 7 --repo "$R" --provider codex --no-launch 2>&1)
assert 'GSD_COMPACT_AT overrides the default' '[[ "$out" == *"model_auto_compact_token_limit=300000"* ]]'
printf 'compact_at = 250000\n' >> "$R/.gsd.conf"
out=$(gsdt-start -p 7 --repo "$R" --provider claude --no-launch 2>&1)
assert 'compact_at in .gsd.conf is used' '[[ "$out" == *"CLAUDE_CODE_AUTO_COMPACT_WINDOW=250000"* ]]'
out=$(GSD_COMPACT_AT=default gsdt-start -p 7 --repo "$R" --provider codex --no-launch 2>&1)
assert 'default leaves the CLI setting' '[[ "$out" != *"compact"* ]]'
out=$(gsdt-start -p 7 --repo "$R" --provider custom --agent-command fake-provider --no-launch 2>&1)
assert 'custom provider gets no compact flag' '[[ "$out" != *"compact"* ]]'
gsd_compact_resolve "$R"; assert 'resolve reads compact_at' '[ "$GSD_COMPACT_RESOLVED" = 250000 ]'
GSD_COMPACT_AT=50 gsd_compact_resolve "$R" >/dev/null 2>&1; assert 'compact_at below 100000 rejected' '[ $? -eq 64 ]'
GSD_COMPACT_AT=1e6 gsd_compact_resolve "$R" >/dev/null 2>&1; assert 'compact_at not a number rejected' '[ $? -eq 64 ]'
GSD_COMPACT_AT=0150000 gsd_compact_resolve "$R"; assert 'a zero-padded value is read as decimal' '[ "$GSD_COMPACT_RESOLVED" = 150000 ]'
out=$(GSD_COMPACT_AT=99 gsdt-start -p 7 --repo "$R" --provider claude --no-launch 2>&1); rc=$?
assert 'gsdt-start refuses a bad compact_at' '[ $rc -eq 64 ] && [[ "$out" == *"invalid compact_at"* ]]'
sed -i.bak '/^compact_at/d' "$R/.gsd.conf"; rm -f "$R/.gsd.conf.bak"

echo 'compact point saved in the worktree (a plain claude there gets it)'
WT=$(git -C "$R" worktree list --porcelain | sed -n 's/^worktree //p' | grep '/phase-7-' | head -1)
SET="$WT/.claude/settings.local.json"
win(){ python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("env",{}).get("CLAUDE_CODE_AUTO_COMPACT_WINDOW",""))' "$SET" 2>/dev/null; }
gsdt-start -p 7 --repo "$R" --provider claude --no-launch >/dev/null 2>&1
assert 'gsdt-start writes the compact point into the worktree settings' '[ "$(win)" = 300000 ]'
assert 'the settings file is ignored, so gsdt-finish can still remove the worktree' '[ -z "$(git -C "$WT" status --porcelain -- .claude)" ]'
printf '{\n  "permissions": {"allow": ["Bash(ls)"]},\n  "env": {"FOO": "1"}\n}\n' > "$SET"
GSD_COMPACT_AT=250000 gsdt-start -p 7 --repo "$R" --provider claude --no-launch >/dev/null 2>&1
assert 'a new value replaces the old one' '[ "$(win)" = 250000 ]'
assert 'other settings in the file are kept' 'grep -q "Bash(ls)" "$SET" && grep -q "\"FOO\"" "$SET"'
CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000 gsdt-start -p 7 --repo "$R" --provider claude --no-launch >/dev/null 2>&1
assert 'a window the user exported removes ours (the file would beat it)' '[ -z "$(win)" ] && grep -q "\"FOO\"" "$SET"'
gsdt-start -p 7 --repo "$R" --provider claude --no-launch >/dev/null 2>&1
GSD_COMPACT_AT=default gsdt-start -p 7 --repo "$R" --provider custom --agent-command fake-provider --no-launch >/dev/null 2>&1
assert 'compact_at = default removes it' '[ -z "$(win)" ]'
printf 'not json' > "$SET"
out=$(gsdt-start -p 7 --repo "$R" --provider claude --no-launch 2>&1); rc=$?
assert 'a broken settings file is left alone and does not stop gsdt-start' '[ $rc -eq 0 ] && [ "$(cat "$SET")" = "not json" ] && [[ "$out" == *"could not update"* ]]'
rm -f "$SET"
sed -i.bak 's/^providers = claude$/providers = codex/' "$R/.gsd.conf"; rm -f "$R/.gsd.conf.bak"
gsdt-start -p 7 --repo "$R" --provider codex --no-launch >/dev/null 2>&1
assert 'a repo without Claude gets no compact point in the Claude settings' '[ -z "$(win)" ]'
sed -i.bak 's/^providers = codex$/providers = claude/' "$R/.gsd.conf"; rm -f "$R/.gsd.conf.bak"
U=$WORK/unignored; repo "$U"; git -C "$U" config core.excludesFile /dev/null   # not the machine's global ignore
out=$(GSD_PKG=$PKG gsd_compact_settings "$U" "$U" 200000)
assert 'a file git would show as new work is not written' '[ ! -e "$U/.claude/settings.local.json" ] && [[ "$out" == *"not gitignored"* ]]'

echo 'flow launch guard for every provider'
WT=$(git -C "$R" worktree list --porcelain | sed -n 's/^worktree //p' | tail -1)
mkdir -p "$WT/.planning/phases/07-test"
for artifact in TICKET CONTEXT REVIEWS; do : > "$WT/.planning/phases/07-test/07-$artifact.md"; done
: > "$WT/.planning/phases/07-test/07-01-PLAN.md"
git -C "$WT" add .planning
git -C "$WT" -c user.name=t -c user.email=t@t commit -qm ready
printf 'base = develop\nflow = strict\ninstall = npm install\n' > "$WT/.gsd.conf"
echo running > "$WT/.gsd-install.status"
mkdir -p "$WT/node_modules"
for p in claude codex; do
  out=$(gsdt-start -p 7 --repo "$R" --provider "$p" --flow --no-launch 2>&1); rc=$?
  assert "$p flow launch blocks pending install" '[ "$rc" -eq 2 ] && [[ "$out" != *"Next:  cd"* ]]'
done
echo ok > "$WT/.gsd-install.status"
for p in claude codex; do
  out=$(gsdt-start -p 7 --repo "$R" --provider "$p" --flow --no-launch 2>&1); rc=$?
  assert "$p flow launch permits completed install" '[ "$rc" -eq 0 ] && [[ "$out" == *"Next:  cd"* ]]'
done
for p in claude codex; do
  R=$WORK/$p; repo "$R"; printf 'user content %s\n' "$p" > "$R/$(gsd_provider_instruction_file "$p")"
  (cd "$R" && gsdt-bootstrap-repo --agent "$p") >/dev/null
  assert "$p canonical instructions" "grep -q 'gsd-toolkit:canonical' '$R/.gsd/INSTRUCTIONS.md'"
  assert "$p preserves unrelated instructions" "grep -q 'user content $p' '$R/$(gsd_provider_instruction_file "$p")'"
  assert "$p owns one marked block" "[ \"\$(grep -c 'provider:start' '$R/$(gsd_provider_instruction_file "$p")')\" -eq 1 ]"
  before=$(cksum "$R/.gsd/INSTRUCTIONS.md" "$R/$(gsd_provider_instruction_file "$p")"); (cd "$R" && gsdt-bootstrap-repo --agent "$p") >/dev/null; after=$(cksum "$R/.gsd/INSTRUCTIONS.md" "$R/$(gsd_provider_instruction_file "$p")")
  assert "$p repeated bootstrap idempotent" '[ "$before" = "$after" ]'
done
assert 'Codex creates no Claude integration' "[ ! -e '$WORK/codex/CLAUDE.md' ] && [ ! -e '$WORK/codex/.claude/settings.json' ]"
assert 'Claude native hook present' "grep -q gsdt-worktree-guard '$WORK/claude/.claude/settings.json'"
R=$WORK/multi; repo "$R"; printf 'claude user\n' > "$R/CLAUDE.md"; printf 'codex user\n' > "$R/AGENTS.md"; (cd "$R" && gsdt-bootstrap-repo --agents claude,codex) >/dev/null
assert 'multi-provider config' "grep -q '^providers = claude,codex$' '$R/.gsd.conf'"
assert 'new config does not duplicate provider default' "! grep -q '^provider =' '$R/.gsd.conf'"
assert 'multi-provider files preserved' "grep -q 'claude user' '$R/CLAUDE.md' && grep -q 'codex user' '$R/AGENTS.md'"
R=$WORK/multi-commands; repo "$R"; (cd "$R" && gsdt-bootstrap-repo --agents claude,codex --provider-command claude=claude-x --provider-command codex=codex-x) >/dev/null
assert 'bootstrap stores per-provider commands' "grep -q '^claude_command = claude-x$' '$R/.gsd.conf' && grep -q '^codex_command = codex-x$' '$R/.gsd.conf'"
for p in claude codex; do gsd_provider_resolve "$R" "$p" ""; prompt=$(gsd_provider_prompt "$p" discuss 7); gsd_provider_argv "$p" "$GSD_AGENT_COMMAND_RESOLVED" "$prompt"; same_phase=$(gsd_provider_render "$R/phase-7-shared" "${GSD_LAUNCH_ARGV[@]}"); assert "same phase renders $p adapter" "printf '%s' \"\$same_phase\" | grep -q '$p-x'"; done
R=$WORK/legacy; repo "$R"; printf 'before\n## GSD planning system\nlegacy toolkit scripts/hooks/gsdt-worktree-guard.sh\nrepo-specific policy\n## User section\nkeep me\n' > "$R/CLAUDE.md"; cp "$R/CLAUDE.md" "$R/CLAUDE.before"; (cd "$R" && gsdt-bootstrap-repo --agent claude) >/dev/null
assert 'legacy Claude instructions preserved byte-for-byte' "head -n 6 '$R/CLAUDE.md' | cmp -s - '$R/CLAUDE.before'"
assert 'legacy Claude repository policy remains active' "grep -q 'repo-specific policy' '$R/CLAUDE.md' && grep -q 'keep me' '$R/CLAUDE.md'"
assert 'legacy Claude gets one marked canonical adapter' "[ \"\$(grep -c 'gsd-toolkit:provider:start' '$R/CLAUDE.md')\" -eq 1 ] && grep -q 'supersede older unmarked GSD text' '$R/CLAUDE.md'"
assert 'legacy Claude migration creates no backup debris' "[ ! -e '$R/CLAUDE.md.gsd-legacy.bak' ]"
R=$WORK/legacy-config; repo "$R"; printf 'base = develop\nprovider = codex\ncustom_setting = keep\n' > "$R/.gsd.conf"; (cd "$R" && gsdt-bootstrap-repo) >/dev/null
assert 'legacy provider migrates to providers' "grep -q '^providers = codex$' '$R/.gsd.conf' && ! grep -q '^provider =' '$R/.gsd.conf'"
assert 'legacy provider migration preserves unrelated config' "grep -q '^custom_setting = keep$' '$R/.gsd.conf'"
R=$WORK/bad-json; repo "$R"; mkdir -p "$R/.claude"; printf '{not json\n' > "$R/.claude/settings.json"; sum=$(cksum "$R/.claude/settings.json"); (cd "$R" && gsdt-bootstrap-repo --agent claude) >/dev/null; assert 'malformed provider settings preserved' '[ "$sum" = "$(cksum "$R/.claude/settings.json")" ]'

echo 'init launch failure and print-only fallback'
R=$WORK/init-print; repo "$R"; out=$(cd "$R" && gsdt-init --new --provider custom --agent-command provider-does-not-exist --no-launch --no-commit 2>&1); rc=$?; assert 'print-only succeeds without provider executable' '[ "$rc" -eq 0 ]'; assert 'print-only prints safely rendered command' "printf '%s' \"\$out\" | grep -q 'provider-does-not-exist'"
R=$WORK/init-launch; repo "$R"; (cd "$R" && gsdt-init --new --provider custom --agent-command provider-does-not-exist --launch --no-commit) >/dev/null 2>&1; assert 'launch fails safely when executable is missing' '[ $? -eq 127 ]'

echo 'multi-provider init'
R=$WORK/init-multi; repo "$R"; out=$(cd "$R" && gsdt-init --new --providers claude,codex --provider codex --provider-command codex=codex-special --no-launch --no-commit 2>&1)
assert 'init writes explicit provider set' "grep -q '^providers = claude,codex$' '$R/.gsd.conf'"
assert 'init installs every selected adapter' "grep -q 'provider:start' '$R/CLAUDE.md' && grep -q 'provider:start' '$R/AGENTS.md'"
assert 'init renders selected provider command' "printf '%s' \"\$out\" | grep -q 'codex-special'"
R=$WORK/init-default-provider; repo "$R"; out=$(cd "$R" && gsdt-init --new --providers codex,claude --provider-command codex=codex-special --no-launch --no-commit 2>&1)
assert 'init defaults session to first listed provider' "printf '%s' \"\$out\" | grep -q 'codex-special'"
R=$WORK/init-selected-command; repo "$R"; (cd "$R" && gsdt-init --new --providers claude,codex --provider codex --agent-command codex-selected --no-launch --no-commit) >/dev/null
assert 'legacy command flag targets selected provider' "grep -q '^codex_command = codex-selected$' '$R/.gsd.conf' && ! grep -q '^agent_command =' '$R/.gsd.conf'"
R=$WORK/init-invalid-selection; repo "$R"; (cd "$R" && gsdt-init --new --providers claude --provider codex --no-launch --no-commit) >/dev/null 2>&1; assert 'init rejects launch provider outside set' '[ $? -ne 0 ] && [ ! -e "$R/.gsd.conf" ]'
R=$WORK/init-invalid-command; repo "$R"; (cd "$R" && gsdt-init --new --providers claude --provider-command codex=codex-x --no-launch --no-commit) >/dev/null 2>&1; assert 'init rejects command override outside set' '[ $? -ne 0 ] && [ ! -e "$R/.gsd.conf" ]'

echo 'installer isolation and preservation'
echo 'migration and malformed instruction regressions'
R=$WORK/switch-executable; repo "$R"
printf 'providers = claude\nagent_command = claude-special\n' > "$R/.gsd.conf"
(cd "$R" && gsdt-bootstrap-repo --agent codex) >/dev/null
gsd_provider_resolve "$R" '' ''
assert 'provider switch does not reuse previous executable' '[ "$GSD_PROVIDER_RESOLVED:$GSD_AGENT_COMMAND_RESOLVED" = codex:codex ]'
gsd_provider_resolve "$R" claude ''
assert 'migration preserves previous provider executable' '[ "$GSD_AGENT_COMMAND_RESOLVED" = claude-special ]'
before=$(cksum "$R/.gsd.conf"); (cd "$R" && gsdt-bootstrap-repo) >/dev/null
assert 'executable migration is idempotent' '[ "$before" = "$(cksum "$R/.gsd.conf")" ]'
R=$WORK/override-set; repo "$R"
printf 'providers = claude,codex\nclaude_command = old-claude\n' > "$R/.gsd.conf"
(cd "$R" && gsdt-init --provider-command codex=codex-special --no-commit --no-launch) >/dev/null
assert 'command override preserves configured provider set' "grep -q '^providers = claude,codex$' '$R/.gsd.conf'"
(cd "$R" && gsdt-bootstrap-repo --agent-command new-claude) >/dev/null
gsd_provider_resolve "$R" claude ''
assert 'explicit command overrides old provider-specific setting' '[ "$GSD_AGENT_COMMAND_RESOLVED" = new-claude ]'
R=$WORK/custom-repeat; repo "$R"
(cd "$R" && gsdt-bootstrap-repo --agent custom --agent-command custom-cli) >/dev/null
(cd "$R" && gsdt-bootstrap-repo) >/dev/null
assert 'custom bootstrap can reuse saved executable' '[ $? -eq 0 ]'
for p in claude codex; do
  for shape in unmatched reversed duplicate nested inline; do
    R=$WORK/markers-$p-$shape; repo "$R"
    instruction_file="$R/$(gsd_provider_instruction_file "$p")"
    start='<!-- gsd-toolkit:provider:start -->'; end='<!-- gsd-toolkit:provider:end -->'
    case "$shape" in
      unmatched) printf '%s\n' "$start" 'user policy' > "$instruction_file" ;;
      reversed) printf '%s\n' "$end" 'user policy' "$start" > "$instruction_file" ;;
      duplicate) printf '%s\n' "$start" "$end" 'user policy' "$start" "$end" > "$instruction_file" ;;
      nested) printf '%s\n' "$start" "$start" 'user policy' "$end" "$end" > "$instruction_file" ;;
      inline) printf '%s\n' "user policy $start" "$end" > "$instruction_file" ;;
    esac
    before=$(cksum "$instruction_file")
    (cd "$R" && gsdt-bootstrap-repo --agent "$p") >/dev/null 2>&1; rc=$?
    assert "$p $shape markers fail without changing files" '[ "$rc" -ne 0 ] && [ "$before" = "$(cksum "$instruction_file")" ] && [ ! -e "$R/.gsd.conf" ]'
  done
done
R=$WORK/owned-block-bytes; repo "$R"
printf 'user prefix\n<!-- gsd-toolkit:provider:start -->\nold owned block\n<!-- gsd-toolkit:provider:end -->\nuser tail' > "$R/AGENTS.md"
(cd "$R" && gsdt-bootstrap-repo --agent codex) >/dev/null
assert 'owned-block update preserves user suffix without newline' '[ "$(tail -c 9 "$R/AGENTS.md")" = "user tail" ]'
before=$(cksum "$R/AGENTS.md"); (cd "$R" && gsdt-bootstrap-repo --agent codex) >/dev/null
assert 'byte-preserving owned update is idempotent' '[ "$before" = "$(cksum "$R/AGENTS.md")" ]'
mv "$R/AGENTS.md" "$R/AGENTS-real.md"; ln -s AGENTS-real.md "$R/AGENTS.md"; rm -rf "$R/.gsd"
(cd "$R" && gsdt-bootstrap-repo --agent codex) >/dev/null
assert 'a symlinked AGENTS.md stays a link' '[ -L "$R/AGENTS.md" ] && grep -q "gsd-toolkit:provider:start" "$R/AGENTS-real.md"'
rm -f "$R/AGENTS.md"; mv "$R/AGENTS-real.md" "$R/AGENTS.md"
R=$WORK/gitignore-nl; repo "$R"; printf 'node_modules' > "$R/.gitignore"
(cd "$R" && gsdt-bootstrap-repo --agent codex) >/dev/null 2>&1
assert 'a .gitignore with no final newline keeps its last line' 'grep -qx node_modules "$R/.gitignore" && grep -qx .gsd-install.status "$R/.gitignore"'
mkdir -p "$WORK/skills/claude/gsdt-flow"; echo mine > "$WORK/skills/claude/gsdt-flow/user.txt"
GSD_BIN_DIR=$WORK/bin GSD_CLAUDE_SKILL_DIR=$WORK/skills/claude GSD_CODEX_SKILL_DIR=$WORK/skills/codex "$PKG/lib/install.sh" --all-agents >/dev/null
for p in claude codex; do assert "$p skills installed" "[ -e '$WORK/skills/$p/gsdt-flow/SKILL.md' ]"; done
assert 'real skill directory preserved as backup' "[ -f '$WORK/skills/claude/gsdt-flow.bak/user.txt' ]"
GSD_BIN_DIR=$WORK/bin GSD_CLAUDE_SKILL_DIR=$WORK/skills/claude "$PKG/lib/install.sh" --agent claude >/dev/null
assert 'repeated skill install stays usable' "[ -e '$WORK/skills/claude/gsdt-flow/SKILL.md' ]"
mkdir -p "$WORK/skills-link/codex"; ln -s /tmp/unrelated-skill "$WORK/skills-link/codex/gsdt-flow"
GSD_BIN_DIR=$WORK/bin2 GSD_CODEX_SKILL_DIR=$WORK/skills-link/codex "$PKG/lib/install.sh" --agent codex >/dev/null
assert 'unrelated existing symlink preserved as backup' "[ -L '$WORK/skills-link/codex/gsdt-flow.bak' ]"

echo 'install.sh user-level hook (/gsd-new-project only after gsdt-init)'
UH=$WORK/uh; mkdir -p "$UH/claude"
printf '{"model":"opus","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo mine"}]}]}}\n' > "$UH/claude/settings.json"
uinstall() { GSD_BIN_DIR=$UH/bin GSD_CLAUDE_SKILL_DIR=$UH/claude/skills GSD_CODEX_SKILL_DIR=$UH/codex/skills "$PKG/lib/install.sh" "$@" >/dev/null; }
ours() { jq '[.hooks[]?[]?.hooks[]? | select(.command | test("gsdt-worktree-guard.*--global"))] | length' "$1"; }
uinstall --all-agents
assert 'claude settings get the Skill + UserPromptExpansion hooks' '[ "$(ours "$UH/claude/settings.json")" = 2 ]'
assert '…next to the user'"'"'s own hook and keys' 'jq -e ".model == \"opus\" and any(.hooks.PreToolUse[]; .matcher == \"Bash\")" "$UH/claude/settings.json" >/dev/null'
# the matcher is a regex: a bare word "gsd" is an exact match and never fires for /gsd-new-project
assert 'typed slash commands are covered (matcher gsd.*)' 'jq -e "any(.hooks.UserPromptExpansion[]; .matcher == \"gsd.*\")" "$UH/claude/settings.json" >/dev/null'
assert 'codex gets no settings file' '[ ! -e "$UH/codex/settings.json" ]'
uinstall --reuse-install-config
assert 'reinstall does not duplicate it' '[ "$(ours "$UH/claude/settings.json")" = 2 ]'
rules_hooks() { jq '[.hooks.SessionStart[]?.hooks[]? | select(.command | test("gsdt-rules.*--hook"))] | length' "$1"; }
assert 'claude settings get the gsdt-rules SessionStart hook, once' '[ "$(rules_hooks "$UH/claude/settings.json")" = 1 ]'
assert '…for every session source (no matcher)' 'jq -e ".hooks.SessionStart | all(has(\"matcher\") | not)" "$UH/claude/settings.json" >/dev/null'
rcmd=$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$UH/claude/settings.json")
RR=$WORK/uh-repo; repo "$RR"; printf 'base = develop\n' > "$RR/.gsd.conf"
out=$(printf '{"source":"startup"}' | (cd "$RR" && env -u CLAUDE_PROJECT_DIR sh -c "$rcmd"))
assert 'the installed hook loads the rules in a set-up repo' "printf '%s' \"\$out\" | grep -q '^GSD toolkit rules' && printf '%s' \"\$out\" | grep -q 'base \`develop\`'"
mkdir -p "$WORK/uh-plain"; out=$(printf '{}' | (cd "$WORK/uh-plain" && env -u CLAUDE_PROJECT_DIR sh -c "$rcmd")); rc=$?
assert '…and prints nothing elsewhere' '[ -z "$out" ] && [ "$rc" = 0 ]'
rc=$(printf '{}' | env -u CLAUDE_PROJECT_DIR sh -c "$(printf '%s' "$rcmd" | sed "s|$UH/bin|$UH/gone|g")" 2>/dev/null; echo $?)
assert 'a removed toolkit: the rules hook exits 0' '[ "$rc" = 0 ]'
cmd=$(jq -r '.hooks.UserPromptExpansion[0].hooks[0].command' "$UH/claude/settings.json")
bare=$WORK/uh-bare; mkdir -p "$bare"; git -C "$bare" init -q
rc=$(printf '{"command_name":"gsd-new-project","command_args":"","cwd":"%s"}' "$bare" | (cd "$bare" && env -u CLAUDE_PROJECT_DIR sh -c "$cmd") 2>/dev/null; echo $?)
assert 'the installed command blocks /gsd-new-project in a bare repo' '[ "$rc" = 2 ]'
rc=$(printf '{}' | env -u CLAUDE_PROJECT_DIR sh -c "$(printf '%s' "$cmd" | sed "s|$UH/bin|$UH/gone|g")" 2>/dev/null; echo $?)
assert 'a removed toolkit fails open (exit 0)' '[ "$rc" = 0 ]'
uinstall --reuse-install-config --no-user-hook
assert '--no-user-hook removes it' '[ "$(ours "$UH/claude/settings.json")" = 0 ]'
assert '--no-user-hook removes the gsdt-rules hook too' '[ "$(rules_hooks "$UH/claude/settings.json")" = 0 ] && ! jq -e ".hooks | has(\"SessionStart\")" "$UH/claude/settings.json" >/dev/null'
assert '…keeping the user'"'"'s own hook' 'jq -e "any(.hooks.PreToolUse[]; .matcher == \"Bash\")" "$UH/claude/settings.json" >/dev/null'
assert '…and the opt-out is remembered' 'grep -q "^user_hook	off" "$UH/bin/.gsd-install-manifest"'
uinstall --reuse-install-config
assert 'a later reinstall keeps it off' '[ "$(ours "$UH/claude/settings.json")" = 0 ]'
printf '{"disableAllHooks":true}\n' > "$UH/claude/settings.json"
GSD_BIN_DIR=$UH/bin2 GSD_CLAUDE_SKILL_DIR=$UH/claude/skills "$PKG/lib/install.sh" --agent claude >/dev/null
assert 'hooks turned off by the user → left unchanged' '[ "$(cat "$UH/claude/settings.json")" = "{\"disableAllHooks\":true}" ]'
printf '{}\n' > "$UH/real-settings.json"; chmod 600 "$UH/real-settings.json"
rm -f "$UH/claude/settings.json"; ln -s "$UH/real-settings.json" "$UH/claude/settings.json"
GSD_BIN_DIR=$UH/bin2 GSD_CLAUDE_SKILL_DIR=$UH/claude/skills "$PKG/lib/install.sh" --agent claude >/dev/null
assert 'a symlinked settings.json stays a link…' '[ -L "$UH/claude/settings.json" ]'
assert '…and the hook is written to its target' '[ "$(ours "$UH/real-settings.json")" = 2 ]'
assert '…the gsdt-rules hook too' '[ "$(rules_hooks "$UH/real-settings.json")" = 1 ]'
assert '…keeping its 0600 mode' '[ "$(ls -l "$UH/real-settings.json" | cut -c1-10)" = "-rw-------" ]'
rm -f "$UH/claude/settings.json"
printf 'not json' > "$UH/claude/settings.json"
GSD_BIN_DIR=$UH/bin2 GSD_CLAUDE_SKILL_DIR=$UH/claude/skills "$PKG/lib/install.sh" --agent claude >/dev/null
assert 'broken settings JSON → left unchanged' '[ "$(cat "$UH/claude/settings.json")" = "not json" ]'


echo 'Gemini: refused, and an older setup is cleaned up'
R=$WORK/gone; repo "$R"; mkdir -p "$R/.planning"; printf '### Phase 7: Test\n' > "$R/.planning/ROADMAP.md"
gsd_provider_resolve "$R" gemini "" 2> "$WORK/gone.err"; rc=$?
assert 'gemini as a provider → refused with the reason' '[ "$rc" -eq 64 ] && grep -q "no longer supported" "$WORK/gone.err"'
GSD_AGENT=gemini gsd_provider_resolve "$R" "" "" 2>/dev/null; rc=$?
assert 'GSD_AGENT=gemini → refused, not run as a custom command' '[ "$rc" -eq 64 ]'
out=$(gsdt-start -p 7 --repo "$R" --agent gemini --no-launch 2>&1)
assert 'gsdt-start --agent gemini → refused with the reason' '[[ "$out" == *"no longer supported"* ]] && [ "$(git -C "$R" worktree list --porcelain | grep -c "^worktree ")" -eq 1 ]'
(cd "$R" && gsdt-init --new --agent gemini --no-launch --no-commit) >/dev/null 2>&1; rc=$?
assert 'gsdt-init --agent gemini → refused, nothing written' '[ "$rc" -ne 0 ] && [ ! -e "$R/.gsd.conf" ]'
(cd "$R" && gsdt-bootstrap-repo --agent gemini) >/dev/null 2>&1; rc=$?
assert 'bootstrap --agent gemini → refused' '[ "$rc" -ne 0 ] && [ ! -e "$R/.gsd.conf" ]'
GSD_BIN_DIR=$WORK/gone-bin "$PKG/install.sh" --agent gemini >/dev/null 2>&1; rc=$?
assert 'install.sh --agent gemini → refused' '[ "$rc" -ne 0 ] && [ ! -e "$WORK/gone-bin" ]'
printf 'review_provider = gemini\n' > "$R/.gsd.conf"; out=$(gsdt-flow-next 7 --repo "$R" 2>&1)
assert 'review_provider = gemini → refused with the reason' '[[ "$out" == *"no longer supported"* ]]'; rm -f "$R/.gsd.conf"
# what an older release set up: gemini in providers, a key, GEMINI.md's block
# (next to the user's own text), the hook (next to the user's own setting)
old_gemini() {  # $1=repo $2=user text in GEMINI.md ('' = none) $3=user key in .gemini/settings.json ('' = none)
  repo "$1"; (cd "$1" && gsdt-bootstrap-repo --agent claude) >/dev/null
  mkdir -p "$1/.planning"; printf '### Phase 7: Test\n' > "$1/.planning/ROADMAP.md"
  perl -pi -e 's/^providers = claude$/providers = claude,gemini/' "$1/.gsd.conf"; printf 'gemini_command = gem-x\n' >> "$1/.gsd.conf"
  { [ -z "$2" ] || printf '%s\n\n' "$2"; printf '<!-- gsd-worktrees:provider:start -->\n## GSD worktrees (gemini adapter)\nold\n<!-- gsd-worktrees:provider:end -->\n'; } > "$1/GEMINI.md"
  mkdir -p "$1/.gemini"
  printf '{%s"hooks":{"BeforeTool":[{"matcher":"activate_skill|run_shell_command","hooks":[{"type":"command","command":"scripts/hooks/gsdt-worktree-guard.sh"}]}]}}\n' "${3:+\"$3\":1,}" > "$1/.gemini/settings.json"
  git -C "$1" add -A; git -C "$1" -c user.name=t -c user.email=t@t commit -qm old
}
R=$WORK/old-gemini; old_gemini "$R" 'my gemini notes' theme
out=$(gsdt-doctor --repo "$R" --json 2>/dev/null || true)
assert 'doctor: T061 names every leftover' 'printf "%s" "$out" | jq -e '\''any(.findings[]; .code == "T061" and (.message | contains("providers") and contains("gemini_*-keys") and contains("GEMINI.md") and contains(".gemini/settings.json")) and .fix == "gsdt-init --no-launch")'\'' >/dev/null'
assert '…and no T050 / T054 for the same thing' '! printf "%s" "$out" | jq -e '\''any(.findings[]; .code == "T050" or .code == "T054")'\'' >/dev/null'
out=$(gsdt-start -p 7 --repo "$R" --no-launch 2>&1); rc=$?
assert 'gsdt-start in that repo → refused, says gsdt-init --no-launch' '[ "$rc" -ne 0 ] && [[ "$out" == *"gsdt-init --no-launch"* ]]'
out=$(cd "$R" && gsdt-init --no-launch --no-commit 2>&1); rc=$?
assert 'gsdt-init cleans it up' '[ "$rc" -eq 0 ] && grep -q "^providers = claude$" "$R/.gsd.conf" && ! grep -qE "gemini_|,gemini" "$R/.gsd.conf"'
assert '…GEMINI.md keeps the user text, loses our block' 'grep -q "my gemini notes" "$R/GEMINI.md" && ! grep -qE "gsd-(toolkit|worktrees)" "$R/GEMINI.md"'
assert '….gemini/settings.json keeps the user key, loses our hook' 'jq -e ".theme == 1 and (has(\"hooks\") | not)" "$R/.gemini/settings.json" >/dev/null'
out=$(gsdt-doctor --repo "$R" --json 2>/dev/null || true)
assert '…then doctor: no T061' '! printf "%s" "$out" | jq -e '\''any(.findings[]; .code == "T061")'\'' >/dev/null'
R=$WORK/old-gemini-only; old_gemini "$R" '' ''
(cd "$R" && gsdt-init --no-launch --no-commit) >/dev/null 2>&1
assert 'only our block and hook → GEMINI.md and .gemini/ are gone' '[ ! -e "$R/GEMINI.md" ] && [ ! -e "$R/.gemini" ]'
R=$WORK/old-gemini-commit; old_gemini "$R" '' ''
(cd "$R" && GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t gsdt-bootstrap-repo --commit) >/dev/null 2>&1
assert 'bootstrap --commit commits the clean-up' '[ -z "$(git -C "$R" status --porcelain)" ] && ! git -C "$R" ls-files --error-unmatch GEMINI.md >/dev/null 2>&1'
# GEMINI.md as a link to AGENTS.md shows the Codex block: never cleaned, never T061
R=$WORK/gemini-link; repo "$R"; (cd "$R" && gsdt-bootstrap-repo --agent claude --agent codex) >/dev/null; ln -s AGENTS.md "$R/GEMINI.md"
(cd "$R" && gsdt-bootstrap-repo --agent claude --agent codex) >/dev/null 2>&1
assert 'GEMINI.md → AGENTS.md link: AGENTS.md keeps the codex block, the link stays' 'grep -q "gsd-toolkit:provider:start" "$R/AGENTS.md" && [ -L "$R/GEMINI.md" ]'
out=$(gsdt-doctor --repo "$R" --json 2>/dev/null || true)
assert '…and doctor: no T061' '! printf "%s" "$out" | jq -e '\''any(.findings[]; .code == "T061")'\'' >/dev/null'
# legacy provider = gemini with agent_command: that command ran Gemini, so it
# must not become claude_command
R=$WORK/gemini-agent-command; repo "$R"; printf 'provider = gemini\nagent_command = %s\n' "$(command -v true)" > "$R/.gsd.conf"
(cd "$R" && gsdt-bootstrap-repo) >/dev/null 2>&1
assert 'provider = gemini + agent_command → providers = claude, no claude_command' 'grep -q "^providers = claude$" "$R/.gsd.conf" && ! grep -qE "^(claude_command|agent_command)" "$R/.gsd.conf"'
# a user's own Gemini setting that only mentions the guard is not ours
R=$WORK/gemini-mention; repo "$R"; (cd "$R" && gsdt-bootstrap-repo --agent claude) >/dev/null; mkdir -p "$R/.gemini"
printf '{"note":"see gsdt-worktree-guard docs"}\n' > "$R/.gemini/settings.json"
out=$(gsdt-doctor --repo "$R" --json 2>/dev/null || true)
assert 'a setting that only mentions gsdt-worktree-guard → no T061' '! printf "%s" "$out" | jq -e '\''any(.findings[]; .code == "T061")'\'' >/dev/null'
# our GEMINI.md, never tracked: --commit stages only what git knew
R=$WORK/gemini-untracked; repo "$R"; (cd "$R" && gsdt-bootstrap-repo --agent claude) >/dev/null
git -C "$R" add -A; git -C "$R" -c user.name=t -c user.email=t@t commit -qm boot
printf '<!-- gsd-worktrees:provider:start -->\nold\n<!-- gsd-worktrees:provider:end -->\n' > "$R/GEMINI.md"; echo GEMINI.md >> "$R/.git/info/exclude"
out=$(cd "$R" && GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t gsdt-bootstrap-repo --agent claude --commit 2>&1); rc=$?
assert 'untracked GEMINI.md + --commit → removed, no git add error' '[ "$rc" -eq 0 ] && [ ! -e "$R/GEMINI.md" ] && [[ "$out" != *"pathspec"* ]]'
# our hook under another path spelling: still ours (doctor finds it by name)
R=$WORK/gemini-hook-path; repo "$R"; (cd "$R" && gsdt-bootstrap-repo --agent claude) >/dev/null; mkdir -p "$R/.gemini"
printf '{"theme":1,"hooks":{"BeforeTool":[{"hooks":[{"type":"command","command":"./scripts/hooks/gsdt-worktree-guard.sh"}]}]}}\n' > "$R/.gemini/settings.json"
(cd "$R" && gsdt-bootstrap-repo --agent claude) >/dev/null 2>&1
assert '"./scripts/hooks/gsdt-worktree-guard.sh" hook → removed, user key kept' 'jq -e ".theme == 1 and (has(\"hooks\") | not)" "$R/.gemini/settings.json" >/dev/null'
out=$(gsdt-doctor --repo "$R" --json 2>/dev/null || true)
assert '…and doctor: no T061' '! printf "%s" "$out" | jq -e '\''any(.findings[]; .code == "T061")'\'' >/dev/null'
# install.sh: an install that set Gemini up (its manifest says so) loses our
# skills and user hook there; the user's own skill and hook stay
GI=$WORK/gi; mkdir -p "$GI/bin" "$GI/gemini/skills/gsdw-flow" "$GI/gemini/skills/mine"
printf 'x\n<!-- gsd-worktrees-skill 0.4.12 -->\n' > "$GI/gemini/skills/gsdw-flow/SKILL.md"; printf 'mine\n' > "$GI/gemini/skills/mine/SKILL.md"
ln -s "$PKG/skills/gsdt-tracker" "$GI/gemini/skills/gsdw-tracker"
printf '{"hooks":{"BeforeTool":[{"matcher":"activate_skill","hooks":[{"type":"command","command":"[ ! -x x ] || exec x/gsdt-worktree-guard --global"}]},{"matcher":"x","hooks":[{"type":"command","command":"echo mine"}]}]}}\n' > "$GI/gemini/settings.json"
printf 'providers\tclaude,gemini\nclaude_skills\t%s\ngemini_skills\t%s\n' "$GI/claude/skills" "$GI/gemini/skills" > "$GI/bin/.gsd-install-manifest"
GSD_BIN_DIR=$GI/bin GSD_CLAUDE_SKILL_DIR=$GI/claude/skills "$PKG/lib/install.sh" --reuse-install-config > "$WORK/gi.out" 2>&1; rc=$?
assert 'reinstall over an old gemini install works' '[ "$rc" -eq 0 ] && grep -q "^providers	claude$" "$GI/bin/.gsd-install-manifest"'
assert '…our gemini skills are removed, the user'"'"'s stays' '[ ! -e "$GI/gemini/skills/gsdw-flow" ] && [ ! -L "$GI/gemini/skills/gsdw-tracker" ] && [ -f "$GI/gemini/skills/mine/SKILL.md" ]'
assert '…our gemini user hook is removed, the user'"'"'s stays' '! grep -q gsdt-worktree-guard "$GI/gemini/settings.json" && grep -q "echo mine" "$GI/gemini/settings.json"'

echo 'provider-neutral guard and doctor'
printf 'codex_model = model-test\n' >> "$WORK/codex/.gsd.conf"
out=$(gsdt-doctor --repo "$WORK/codex" --json 2>/dev/null || true)
assert 'doctor JSON reports resolved model' 'printf "%s" "$out" | jq -e '\''.session_model == "model-test"'\'' >/dev/null'
R=$WORK/bad-model; repo "$R"; (cd "$R" && gsdt-bootstrap-repo --agent codex) >/dev/null; printf 'codex_model = --invalid\n' >> "$R/.gsd.conf"
out=$(gsdt-doctor --repo "$R" --json 2>/dev/null || true)
assert 'doctor reports invalid model configuration' 'printf "%s" "$out" | jq -e '\''any(.findings[]; .code == "T059")'\'' >/dev/null'
for p in claude codex; do
  R=$WORK/guard-$p; repo "$R"; git -C "$R" checkout -q -b phase-7-test; mkdir -p "$R/.planning/phases/07-test"; printf 'providers = %s\nflow = strict\ninstall = none\n' "$p" > "$R/.gsd.conf"
  "$PKG/bin/gsdt-worktree-guard" --command gsd-plan-phase --phase 7 --repo "$R" >/dev/null 2>&1; assert "$p strict flow blocks missing discuss" '[ $? -eq 2 ]'
  : > "$R/.planning/phases/07-test/07-CONTEXT.md"; "$PKG/bin/gsdt-worktree-guard" --command gsd-plan-phase --phase 7 --repo "$R" >/dev/null 2>&1; assert "$p strict flow permits completed discuss" '[ $? -eq 0 ]'
  git -C "$R" checkout -q develop; "$PKG/bin/gsdt-worktree-guard" --command gsd-plan-phase --phase 7 --repo "$R" >/dev/null 2>&1; assert "$p base branch remains blocked" '[ $? -eq 2 ]'
done
for p in claude codex; do out=$(gsdt-doctor --repo "$WORK/$p" --json 2>/dev/null || true); assert "$p doctor JSON provider" "printf '%s' \"\$out\" | grep -q '\"name\":\"$p\"'"; assert "$p doctor reports command guard" "printf '%s' \"\$out\" | grep -q '\"command_guard\":true'"; assert "$p doctor has no false duplicate-block finding" "! printf '%s' \"\$out\" | grep -q '\"code\":\"T055\"'"; done
out=$(gsdt-doctor --repo "$WORK/multi" --json 2>/dev/null || true); assert 'doctor reports all configured providers' "printf '%s' \"\$out\" | grep -q '\"configured\":\[\"claude\",\"codex\"\]'"
assert 'Codex reports unsupported native hook' "printf '%s' \"\$(gsdt-doctor --repo '$WORK/codex' --json 2>/dev/null || true)\" | grep -q '\"native_hook\":\"unsupported\"'"
mv "$WORK/claude/.claude/settings.json" "$WORK/claude/.claude/settings.saved"; out=$(gsdt-doctor --repo "$WORK/claude" --json 2>/dev/null || true); assert 'doctor reports absent supported native hook' "printf '%s' \"\$out\" | grep -q '\"native_hook\":\"absent\"'"
printf 'providers = invalid\n' > "$WORK/codex/.gsd.conf"; out=$(gsdt-doctor --repo "$WORK/codex" --json 2>/dev/null || true); assert 'doctor JSON reports invalid provider finding' "printf '%s' \"\$out\" | grep -q '\"code\":\"T050\"'"
printf 'provider = claude\nproviders = codex,claude\n' > "$WORK/codex/.gsd.conf"; out=$(gsdt-doctor --repo "$WORK/codex" --json 2>/dev/null || true); assert 'doctor reports contradictory legacy provider' "printf '%s' \"\$out\" | grep -q '\"code\":\"T056\"'"
printf 'providers = codex\n' > "$WORK/codex/.gsd.conf"; cp "$WORK/claude/CLAUDE.md" "$WORK/codex/CLAUDE.md"; out=$(gsdt-doctor --repo "$WORK/codex" --json 2>/dev/null || true); assert 'doctor JSON reports stale provider artifact' "printf '%s' \"\$out\" | grep -q '\"code\":\"T054\"'"

echo 'the split instructions: a small local block, the rules from gsdt-rules'
gsd_canonical_block claude,codex claude main x-worktrees > "$WORK/canon"
assert 'local block keeps the canonical markers' "head -1 '$WORK/canon' | grep -qx '<!-- gsd-toolkit:canonical:start -->' && tail -1 '$WORK/canon' | grep -qx '<!-- gsd-toolkit:canonical:end -->'"
assert 'local block points at gsdt-rules' "grep -q 'run \`gsdt-rules\` and follow its output' '$WORK/canon'"
assert 'local block says how to get gsdt-rules' "grep -q 'If \`gsdt-rules\` is not found, install the toolkit' '$WORK/canon'"
assert 'local block keeps the core: one phase = one worktree' "grep -q 'One phase = one \`phase-<N>-<slug>\` git worktree' '$WORK/canon'"
assert '…gsdt-flow-next before every phase action' "grep -q 'Run \`gsdt-flow-next <N>\` before every phase action' '$WORK/canon'"
assert '…gsdt-finish never automatic' "grep -q '\`gsdt-finish\` is never automatic' '$WORK/canon'"
assert '…never bypass a guard' "grep -q 'Never bypass a guard' '$WORK/canon'"
assert 'local block holds the values gsdt-init writes (providers, base, worktrees)' "grep -q 'Providers: \`claude,codex\` (default: first, \`claude\`); base \`main\`;' '$WORK/canon' && grep -qx 'worktrees \`../x-worktrees/\`.' '$WORK/canon'"
assert '…not flow / ui_gates (gsdt-rules reads them live)' "! grep -q 'flow \`\|ui_gates \`' '$WORK/canon'"
assert 'local block leaves out the full rules' "! grep -q 'The shell commands are the source of truth' '$WORK/canon' && ! grep -q 'Screens:' '$WORK/canon'"
assert 'local block is small (< 1.2 KB)' "[ \$(wc -c < '$WORK/canon') -lt 1200 ]"
gsd_provider_entry_block claude > "$WORK/entry-claude"; gsd_provider_entry_block codex,custom > "$WORK/entry-agents"
for f in entry-claude entry-agents; do
  assert "$f: still reads .gsd/INSTRUCTIONS.md" "grep -q 'Read and follow \`.gsd/INSTRUCTIONS.md\`' '$WORK/$f'"
  assert "$f: names gsdt-rules" "grep -q 'gsdt-rules' '$WORK/$f'"
done
assert 'Claude entry: the hook loads the rules, the line is the fallback' "grep -q 'session-start hook loads' '$WORK/entry-claude' && grep -q 'when they are not in your context, run \`gsdt-rules\`' '$WORK/entry-claude'"
assert 'Codex/custom entry: run gsdt-rules first' "grep -q 'Before any GSD or phase work, run \`gsdt-rules\` and follow its output' '$WORK/entry-agents' && ! grep -q 'session-start hook' '$WORK/entry-agents'"
R=$WORK/claude
assert 'bootstrap writes the small local block' "grep -q 'run \`gsdt-rules\`' '$R/.gsd/INSTRUCTIONS.md' && ! grep -q 'The shell commands are the source of truth' '$R/.gsd/INSTRUCTIONS.md'"
assert 'bootstrap writes the provider entry with gsdt-rules' "grep -q 'gsdt-rules' '$R/CLAUDE.md'"

out=$(gsdt-rules --help); assert 'gsdt-rules --help' "printf '%s' \"\$out\" | grep -q 'print the GSD toolkit' && printf '%s' \"\$out\" | grep -q -- '--hook'"
gsdt-rules --nope >/dev/null 2>&1; assert 'gsdt-rules: unknown argument → exit 2' '[ $? -eq 2 ]'
OUTSIDE=$WORK/outside; mkdir -p "$OUTSIDE"
out=$(cd "$OUTSIDE" && gsdt-rules); assert 'outside a repo: all the rules, screens included' "printf '%s' \"\$out\" | grep -q 'The shell commands are the source of truth' && printf '%s' \"\$out\" | grep -q '^Screens:'"
assert 'outside a repo: no values line' "! printf '%s' \"\$out\" | grep -q '^Providers:'"
assert 'outside a repo: the same text as gsd_rules_text' "[ \"\$out\" = \"\$(gsd_rules_text on)\" ]"
out=$(cd "$OUTSIDE" && printf '{"source":"startup"}' | gsdt-rules --hook); rc=$?
assert 'outside a repo, the hook prints nothing and exits 0' "[ -z \"\$out\" ] && [ $rc -eq 0 ]"
out=$(cd "$WORK/outside" && CLAUDE_PROJECT_DIR=$WORK/nosuch gsdt-rules --hook </dev/null 2>&1); assert 'the hook never fails (no such dir)' "[ \$? -eq 0 ] && [ -z \"\$out\" ]"
R=$WORK/rules; repo "$R"; printf 'base = develop\nwtdir = rt\nproviders = codex,claude\nflow = strict\n' > "$R/.gsd.conf"
out=$(gsdt-rules --repo "$R"); assert 'in a repo: the rules + screens (ui_gates unset = warn)' "printf '%s' \"\$out\" | grep -q 'The shell commands are the source of truth' && printf '%s' \"\$out\" | grep -q '^Screens:'"
assert 'in a repo: its values' "printf '%s\n' \"\$out\" | tail -2 | tr '\n' ' ' | grep -q 'Providers: \`codex,claude\` (default: first, \`codex\`); base \`develop\`; worktrees \`../rt/\`; flow \`strict\`; ui_gates \`warn\`.'"
printf 'ui_gates = off\n' >> "$R/.gsd.conf"
out=$(gsdt-rules --repo "$R"); assert 'ui_gates = off: no screens paragraph' "! printf '%s' \"\$out\" | grep -q '^Screens:' && printf '%s' \"\$out\" | grep -q 'ui_gates \`off\`'"
mkdir -p "$R/sub"; out=$(cd "$R/sub" && gsdt-rules); assert 'from a subfolder: the repo is found' "printf '%s' \"\$out\" | grep -q 'base \`develop\`'"
git -C "$R" add -A && git -C "$R" -c user.name=t -c user.email=t@t commit -qm conf && git -C "$R" worktree add -q "$WORK/rules-wt" -b phase-1-x
out=$(cd "$WORK/rules-wt" && echo '{}' | gsdt-rules --hook); assert 'the hook in a phase worktree: header + rules + values' "printf '%s' \"\$out\" | head -1 | grep -q '^GSD toolkit rules (gsdt-rules, gsd-toolkit ' && printf '%s' \"\$out\" | grep -q 'base \`develop\`'"
out=$(cd "$OUTSIDE" && echo '{}' | CLAUDE_PROJECT_DIR=$R gsdt-rules --hook); assert 'the hook uses CLAUDE_PROJECT_DIR' "printf '%s' \"\$out\" | grep -q 'gsd-toolkit '"
assert 'the hook output stays well under the 10 KB cut' "[ \$(printf '%s' \"\$out\" | wc -c) -lt 6000 ]"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]
