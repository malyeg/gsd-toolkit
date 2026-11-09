#!/usr/bin/env bash
# test-doctor.sh — the gsd-doctor checks added in 0.2.3: missing tools (T005,
# T006), stale skills (T007), .gsd.conf typos and bad values (T017, T018), a
# missing base branch (T015), the pre-merge gate (T019), duplicate phase
# headings (T025), failed worktree installs (T032), a ClickUp tracker with no
# token (T073), worktree.baseRef (T034), and the reinstall command it names. Also install.sh
# --reuse-install-config keeping recorded agents when --agent adds one.
# Everything runs in throwaway repos; HOME is a temp dir.
set -uo pipefail
PKG=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d); WORK=$(cd "$WORK" && pwd -P); trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"; mkdir -p "$HOME"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GSD_NO_CORE=1   # lib/install.sh must not run the real gsd-core installer (npx)
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GSD_NO_UPDATE_CHECK=1 GSD_CLAUDE_SKILL_DIR="$WORK/skills" GSD_CLICKUP_CONFIG="$WORK/clickup.env"
unset CLICKUP_API_TOKEN GSD_SKIP_GUARD GSD_CLI CLAUDE_CONFIG_DIR CODEX_HOME
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '%s\n' "$2" | sed 's/^/      /'; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
has() { if grep -q -- "$2" "$3"; then ok "$1"; else bad "$1" "$(tail -8 "$3")"; fi; }
hasnt() { if grep -q -- "$2" "$3"; then bad "$1" "$(grep -- "$2" "$3" | head -3)"; else ok "$1"; fi; }
section() { printf '\n%s\n' "$1"; }

# A stand-in gsd-core gsd_run so T005 only fires where a test removes it.
STUB="$WORK/stub"; mkdir -p "$STUB"
printf '#!/bin/sh\necho %s\n' "'{\"packageName\":\"@opengsd/gsd-core\",\"version\":\"1.18.0\"}'" > "$STUB/gsd_run"; chmod +x "$STUB/gsd_run"
BASEPATH="$PKG/bin:$PATH:$STUB"

# A PATH with every command except the named ones: a dir of links to the first
# copy of each executable on BASEPATH.
farm() {  # $1=dir  $2...=names to leave out
  local dir=$1 d f n; shift; mkdir -p "$dir"
  local skip=" $* "   # before IFS changes: "$*" joins with IFS's first char
  local IFS=:
  for d in $BASEPATH; do
    [ -d "$d" ] || continue
    for f in "$d"/*; do
      n=${f##*/}
      [ -x "$f" ] && [ ! -d "$f" ] && [ ! -e "$dir/$n" ] && [ ! -L "$dir/$n" ] || continue
      case "$skip" in *" $n "*) continue ;; esac
      ln -s "$f" "$dir/$n"
    done
  done
}

OUT="$WORK/out"
doc()  { PATH="${DPATH:-$BASEPATH}" gsd-doctor --repo "$1" > "$OUT" 2>&1; }
json() { PATH="${DPATH:-$BASEPATH}" gsd-doctor --json --repo "$1" > "$OUT" 2>&1; }

mkrepo() {  # $1=dir — a small GSD repo on develop with an origin
  git init -q -b develop "$1"
  mkdir -p "$1/.planning"
  printf '# Roadmap\n\n### Phase 1: One\n\n### Phase 2: Two\n' > "$1/.planning/ROADMAP.md"
  printf 'base = develop\n' > "$1/.gsd.conf"
  git -C "$1" add -A && git -C "$1" commit -qm init
  git init -q --bare "$1.origin.git"
  git -C "$1" remote add origin "$1.origin.git"
  git -C "$1" push -q -u origin develop
}
R="$WORK/repo"; mkrepo "$R"

section "missing tools"
json "$R"
hasnt "gsd-core's gsd_run on PATH → no T005" '"T005"' "$OUT"
hasnt "perl on PATH → no T006" '"T006"' "$OUT"
farm "$WORK/nosdk" gsd_run gsd-sdk
DPATH="$WORK/nosdk" json "$R"
has "no GSD → T005" '"T005"' "$OUT"
has "T005 names the gsd-core install" 'npx @opengsd/gsd-core@latest --claude --global' "$OUT"
printf '#!/bin/sh\necho 1.42.3\n' > "$WORK/nosdk/gsd-sdk"; chmod +x "$WORK/nosdk/gsd-sdk"
DPATH="$WORK/nosdk" json "$R"
has "the old GSD (gsd-sdk) is no GSD → T005" '"T005"' "$OUT"
hasnt "…and is never named" 'get-shit-done' "$OUT"
printf '#!/bin/sh\necho nope\n' > "$WORK/nosdk/gsd_run"; chmod +x "$WORK/nosdk/gsd_run"
DPATH="$WORK/nosdk" json "$R"
has "a gsd_run that is not gsd-core's does not count" '"T005"' "$OUT"
rm "$WORK/nosdk/gsd_run"
mkdir -p "$HOME/.claude/gsd-core/bin"; cp "$STUB/gsd_run" "$HOME/.claude/gsd-core/bin/gsd_run"
DPATH="$WORK/nosdk" doc "$R"
has "an npx install (~/.claude/gsd-core, nothing on PATH) counts" "gsd-core .*$HOME/.claude/gsd-core/bin/gsd_run" "$OUT"
rm -rf "$HOME/.claude/gsd-core" "$WORK/nosdk/gsd-sdk"
# T009: gsd-core's skill profile (its installer writes <agent dir>/.gsd-profile)
mkdir -p "$HOME/.claude" "$HOME/.codex"
printf 'core\n' > "$HOME/.claude/.gsd-profile"
json "$R"
has "profile core → T009" '"T009"' "$OUT"
has "…with the reinstall that sets full" 'npx @opengsd/gsd-core@latest --claude --global --profile=full' "$OUT"
printf 'core,audit\n' > "$HOME/.codex/.gsd-profile"
json "$R"
hasnt "…a Codex profile counts only when codex is a provider" "gsd-core for codex" "$OUT"
printf 'full\n' > "$HOME/.claude/.gsd-profile"
json "$R"
hasnt "profile full → no T009" '"T009"' "$OUT"
printf 'core,full\n' > "$HOME/.claude/.gsd-profile"
json "$R"
hasnt "a profile that includes full → no T009" '"T009"' "$OUT"
rm -f "$HOME/.claude/.gsd-profile" "$HOME/.codex/.gsd-profile"
json "$R"
hasnt "no profile file (the default is full) → no T009" '"T009"' "$OUT"

section "T009 by skills + the context section (lib/context.sh)"
SK="$WORK/skills"; mkdir -p "$SK"
mkskill() { mkdir -p "$SK/gsd-$1"; printf -- '---\nname: gsd-%s\ndescription: "%s"\n---\nbody\n' "$1" "$2" > "$SK/gsd-$1/SKILL.md"; }
for s in new-project ingest-docs discuss-phase plan-phase review execute-phase code-review verify-work validate-phase secure-phase ui-phase ui-review sketch; do mkskill "$s" "the $s step"; done
mkskill new-milestone "start a milestone"; mkskill thread "a thread"; mkskill stats "numbers"
printf 'core\n' > "$HOME/.claude/.gsd-profile"
json "$R"
hasnt "gsd-core skills found: the flow's skills decide, not the profile name" '"T009"' "$OUT"
has "context: the skill count (16 gsd-* skills)" '"name":"claude","skills":16,' "$OUT"
rm -rf "$SK/gsd-validate-phase"
json "$R"
has "a flow skill missing → T009 names it" 'missing skills the phase flow runs: gsd-validate-phase' "$OUT"
has "…fix without gsd-core's group list: the installer" 'profile=full' "$OUT"
rm -rf "$SK/gsd-sketch"; mkskill validate-phase "back"
printf 'base = develop\nui_gates = off\n' > "$R/.gsd.conf"
json "$R"
hasnt "ui_gates = off: sketch is not needed" '"T009"' "$OUT"
git -C "$R" checkout -q -- .gsd.conf
json "$R"
has "…with the UI gates on it is" 'missing skills the phase flow runs: gsd-sketch' "$OUT"
mkskill sketch "sketch"
mkdir -p "$HOME/.claude/agents"
printf -- '---\nname: gsd-planner\ndescription: plans\ntools: Read\n---\nlong body\n' > "$HOME/.claude/agents/gsd-planner.md"
printf -- '---\nname: other\ndescription: not ours\n---\n' > "$HOME/.claude/agents/other.md"
json "$R"
has "context: gsd-* agents counted, others not" '"agents":1,' "$OUT"
if command -v node >/dev/null 2>&1; then
  mkdir -p "$HOME/.claude/gsd-core/bin/lib"
  cat > "$HOME/.claude/gsd-core/bin/lib/clusters.cjs" <<'EOF'
exports.CLUSTERS = Object.freeze({
  core_loop: ['plan-phase', 'execute-phase', 'help'],
  audit_review: ['validate-phase', 'audit-uat'],
  milestone: ['new-milestone', 'health'],
  workspace_state: ['thread'],
  docs: ['ingest-docs', 'docs-update'],
  empty_one: ['not-installed'],
  stats_group: ['stats'],
});
EOF
  json "$R"
  has "hideable: a group with no flow skill" '"group":"milestone","skills":1,' "$OUT"
  has "…another one" '"group":"workspace_state","skills":1,' "$OUT"
  hasnt "…never a group holding a flow skill" '"group":"docs"' "$OUT"
  hasnt "…never a group with nothing installed" '"group":"empty_one"' "$OUT"
  printf '{"baseProfile":"full","disabledClusters":["stats_group","audit_review"],"explicitAdds":[],"explicitRemoves":[]}\n' > "$HOME/.claude/.gsd-surface.json"
  rm -rf "$SK/gsd-validate-phase"
  json "$R"
  hasnt "…a group already disabled is left out" '"group":"stats_group"' "$OUT"
  has "T009 in a disabled group → /gsd-surface enable it" '/gsd-surface enable audit_review' "$OUT"
  doc "$R"
  hasnt "text: no hint to hide skill groups (JSON only)" '/gsd-surface disable' "$OUT"
  mkskill validate-phase "back"; rm -rf "$HOME/.claude/gsd-core" "$HOME/.claude/.gsd-surface.json"
else
  echo "  (node not found — group tests skipped)"
fi
doc "$R"
has "text: the cost line" 'claude: 16 gsd-core skills + 1 agents, ~' "$OUT"
has "text: Claude's own checks are named" 'run /doctor and /skill-doctor' "$OUT"
awk 'BEGIN { for (i = 0; i < 900; i++) print "filler line " i " that is long enough to fill the roadmap up" }' >> "$R/.planning/ROADMAP.md"
json "$R"
has "big_files: ROADMAP.md over 32 KiB" '"big_files":\[{"path":".planning/ROADMAP.md"' "$OUT"
has "…fixed by /gsd-complete-milestone" 'gsd-complete-milestone' "$OUT"
hasnt "…a note, never a finding" '"message":"[^"]*KiB' "$OUT"
git -C "$R" checkout -q -- .planning/ROADMAP.md
rm -rf "$SK"/gsd-* "$HOME/.claude/agents" "$HOME/.claude/.gsd-profile"
json "$R"
has "no gsd-core skills: no context entry" '"context":{"agents":\[\]' "$OUT"
farm "$WORK/noperl" perl
DPATH="$WORK/noperl" json "$R"
has "no perl → T006" '"T006"' "$OUT"
DPATH="$WORK/noperl" doc "$R"
has "no perl → roadmap row check is skipped, not passed" 'roadmap row check skipped' "$OUT"

section "skills (T007)"
doc "$R"
has "no skills → a note with the reinstall command" 'claude skills not installed' "$OUT"
mkdir -p "$WORK/skills"; cp -R "$PKG/skills/." "$WORK/skills/"
printf '<!-- gsd-toolkit-skill 0.0.0 -->\n' >> "$WORK/skills/gsdt-flow/SKILL.md"
json "$R"
hasnt "skills same as the toolkit → no T007" '"T007"' "$OUT"
echo "old step" >> "$WORK/skills/gsdt-flow/SKILL.md"
json "$R"
has "an edited skill → T007" '"T007"' "$OUT"
has "T007 names the stale skill" 'differ from this toolkit.*gsdt-flow' "$OUT"
has "a checkout reinstalls with its install.sh" 'install.sh --reuse-install-config --agent claude' "$OUT"

# A release runtime has no .git: it re-runs its own install.sh for its version.
RT="$WORK/runtime"; mkdir -p "$RT"
cp -R "$PKG/bin" "$PKG/lib" "$PKG/shims" "$PKG/skills" "$PKG/install.sh" "$PKG/VERSION" "$RT/"
PATH="$RT/bin:$PATH:$STUB" "$RT/bin/gsd-doctor" --json --repo "$R" > "$OUT" 2>&1
has "a release reinstalls with its install.sh and version" "install.sh --version $(cat "$PKG/VERSION") --reuse-install-config" "$OUT"
rm -rf "$WORK/skills"

section ".gsd.conf (T017, T018)"
json "$R"
hasnt "a clean .gsd.conf → no T017" '"T017"' "$OUT"
hasnt "a clean .gsd.conf → no T018" '"T018"' "$OUT"
cp "$R/.gsd.conf" "$WORK/conf.bak"
printf 'colour = red\nthis is not a setting\ntracker = none\nclaude_model = opus\n' >> "$R/.gsd.conf"
json "$R"
has "an unknown key → T017" 'unknown .gsd.conf key(s): colour' "$OUT"
has "a non key=value line → T017" '1 line(s) that are not' "$OUT"
hasnt "tracker and <provider>_model are known keys" 'key(s):[^"]*\(tracker\|claude_model\)' "$OUT"
cp "$WORK/conf.bak" "$R/.gsd.conf"
printf 'flow = on\nflow_since = soon\nstart_mode = go\n' >> "$R/.gsd.conf"
json "$R"
is "bad flow, flow_since and start_mode → 3× T018" "$(grep -o '"T018"' "$OUT" | wc -l | tr -d ' ')" 3
cp "$WORK/conf.bak" "$R/.gsd.conf"

section "base branch and origin (T015)"
printf 'base = nope\n' > "$R/.gsd.conf"
json "$R"
has "a base branch that is nowhere → T015" "base branch 'nope' does not exist" "$OUT"
git -C "$R" branch -q release && git -C "$R" push -q origin release && git -C "$R" branch -q -D release
printf 'base = release\n' > "$R/.gsd.conf"
json "$R"
has "a base only on origin → T015 with the track command" 'git branch --track release origin/release' "$OUT"
cp "$WORK/conf.bak" "$R/.gsd.conf"
json "$R"
hasnt "base present → no T015" '"T015"' "$OUT"
L="$WORK/local"; mkrepo "$L"; git -C "$L" remote remove origin
doc "$L"
has "no origin → a note" "no 'origin' remote" "$OUT"
json "$L"
hasnt "no origin is not a finding" 'origin remote' "$OUT"

section "pre-merge gate (T019)"
mkdir -p "$R/scripts"; printf '#!/bin/sh\nexit 0\n' > "$R/scripts/gsd-premerge-check.sh"
json "$R"
has "a pre-merge script that is not executable → T019" 'is not executable' "$OUT"
chmod +x "$R/scripts/gsd-premerge-check.sh"
json "$R"
hasnt "executable → no T019" '"T019"' "$OUT"
printf 'premerge = scripts/nope.sh\n' >> "$R/.gsd.conf"
json "$R"
has "a premerge path that does not exist → T019" 'premerge = scripts/nope.sh, but that file does not exist' "$OUT"
printf 'base = develop\npremerge = none\n' > "$R/.gsd.conf"
json "$R"
hasnt "premerge = none → no T019" '"T019"' "$OUT"
cp "$WORK/conf.bak" "$R/.gsd.conf"; rm -rf "$R/scripts"

section "duplicate phase headings (T025)"
cp "$R/.planning/ROADMAP.md" "$WORK/roadmap.bak"
printf '\n### Phase 02: Two again\n' >> "$R/.planning/ROADMAP.md"
json "$R"
has "Phase 2 and Phase 02 → T025" 'more than one heading for phase(s): 2' "$OUT"
cp "$WORK/roadmap.bak" "$R/.planning/ROADMAP.md"
json "$R"
hasnt "one heading per phase → no T025" '"T025"' "$OUT"

section "bracket phase ids (T026)"
printf '{\n  "phase_id_convention": "bracket"\n}\n' > "$R/.planning/config.json"
json "$R"
has "phase_id_convention = bracket → T026" '"T026"' "$OUT"
printf '{\n  "phase_id_convention": null\n}\n' > "$R/.planning/config.json"
json "$R"
hasnt "null (numbers) → no T026" '"T026"' "$OUT"
rm -f "$R/.planning/config.json"

section "worktree installs (T032)"
git -C "$R" worktree add -q -b phase-1-one "$WORK/phase-1-one"
echo fail > "$WORK/phase-1-one/.gsd-install.status"
json "$R"
has "a failed install → T032" 'dependency install failed in phase-1-one' "$OUT"
echo running > "$WORK/phase-1-one/.gsd-install.status"
json "$R"
hasnt "a running install is not a finding" '"T032"' "$OUT"
doc "$R"
has "a running install is a note" 'install still running in phase-1-one' "$OUT"
git -C "$R" worktree remove --force "$WORK/phase-1-one"

section "ClickUp token (T073)"
printf 'tracker = clickup\n' >> "$R/.gsd.conf"
json "$R"
has "clickup with no token → T073" '"T073"' "$OUT"
echo 'CLICKUP_API_TOKEN=pk_test' > "$WORK/clickup.env"
json "$R"
hasnt "a token in the config file → no T073" '"T073"' "$OUT"
rm -f "$WORK/clickup.env"
CLICKUP_API_TOKEN=pk_env json "$R"
hasnt "a token in the env → no T073" '"T073"' "$OUT"
# A profile reads ~/.config/gsd/clickup-<profile>.env (GSD_CLICKUP_CONFIG unset, fake HOME).
printf 'tracker_profile = acme\n' >> "$R/.gsd.conf"
mkdir -p "$WORK/home/.config/gsd"
echo 'CLICKUP_API_TOKEN=pk_shared' > "$WORK/home/.config/gsd/clickup.env"
( unset GSD_CLICKUP_CONFIG; HOME="$WORK/home" json "$R" )
has "a profile ignores the shared token → T073" '"T073"' "$OUT"
has "…naming the profile's file" 'clickup-acme.env' "$OUT"
echo 'CLICKUP_API_TOKEN=pk_acme' > "$WORK/home/.config/gsd/clickup-acme.env"
( unset GSD_CLICKUP_CONFIG; HOME="$WORK/home" json "$R" )
hasnt "the profile's token file → no T073" '"T073"' "$OUT"
( unset GSD_CLICKUP_CONFIG; HOME="$WORK/home" CLICKUP_API_TOKEN=pk_env doc "$R" )
has "an env token notes that it hides the profile" 'profile .acme. .* is not used' "$OUT"
cp "$WORK/conf.bak" "$R/.gsd.conf"; printf 'tracker = clickup\ntracker_profile = ../x\n' >> "$R/.gsd.conf"
json "$R"
has "a profile with a slash → T018" '"T018"' "$OUT"
hasnt "…and no unknown-key T017" '"T017"' "$OUT"
cp "$WORK/conf.bak" "$R/.gsd.conf"

section "flow debt: flow_skip leaves out single phases (T040)"
S="$WORK/skip"; mkrepo "$S"
mkdir -p "$S/.planning/phases/03-a" "$S/.planning/phases/04-b" "$S/.planning/phases/04.1-c"
printf '# Roadmap\n\n- [x] **Phase 3: A**\n- [x] **Phase 4: B**\n- [x] **Phase 4.1: C**\n\n### Phase 3: A\n\n### Phase 4: B\n\n### Phase 4.1: C\n' > "$S/.planning/ROADMAP.md"
printf 'base = develop\nflow = strict\n' > "$S/.gsd.conf"
git -C "$S" add -A && git -C "$S" commit -qm phases
json "$S"
is "no flow_skip → 3 phases in debt" "$(grep -o '"T040"' "$OUT" | wc -l | tr -d ' ')" 3
printf 'base = develop\nflow = strict\nflow_skip = 03, 4.1   # shipped before the rules\n' > "$S/.gsd.conf"
json "$S"
is "flow_skip = 03, 4.1 → only phase 4 left" "$(grep -o '"T040"' "$OUT" | wc -l | tr -d ' ')" 1
has "…and it is phase 4" 'Phase 4 merged without' "$OUT"
has "…the missing test audit is part of the debt" 'validate' "$OUT"
printf -- '---\nnyquist_compliant: true\n---\n' > "$S/.planning/phases/04-b/04-VALIDATION.md"
json "$S"
hasnt "…not once 04-VALIDATION.md is compliant" 'merged without:[^"]*validate' "$OUT"
rm "$S/.planning/phases/04-b/04-VALIDATION.md"
hasnt "flow_skip is a known key" '"T017"' "$OUT"
doc "$S"
has "skipped phases are listed as a note" 'not checked (flow_skip in .gsd.conf): 3 4.1' "$OUT"
printf 'base = develop\nflow = strict\nflow_skip = 3, four\n' > "$S/.gsd.conf"
json "$S"
has "a bad flow_skip entry → T018" "flow_skip has 'four'" "$OUT"

section "instructions older than the toolkit (T016)"
I="$WORK/instr"; mkrepo "$I"
(cd "$I" && PATH="$BASEPATH" gsd-bootstrap-repo --agents claude,codex) >/dev/null 2>&1
git -C "$I" add -A && git -C "$I" commit -qm bootstrap
doc "$I"
has "fresh instructions pass" "GSD instructions match this toolkit" "$OUT"
printf '\nMy own project notes.\n' >> "$I/CLAUDE.md"
json "$I"
hasnt "text outside the marked blocks is ignored" '"T016"' "$OUT"
sed -i.bak 's/^- Run `gsd-flow-next <N>` before every phase action/- Run `gsd-flow-next <N>` before most phase actions/' "$I/.gsd/INSTRUCTIONS.md"
json "$I"
has "an old canonical block → T016" 'older than this toolkit.*INSTRUCTIONS.md' "$OUT"
sed -i.bak 's/^Read and follow/Please read and follow/' "$I/AGENTS.md"
json "$I"
has "…an old provider block is named too" 'INSTRUCTIONS.md AGENTS.md' "$OUT"
PATH="$BASEPATH" gsd-doctor --fix --yes --repo "$I" > "$OUT" 2>&1
json "$I"
hasnt "--fix refreshes them" '"T016"' "$OUT"
has "…and keeps the user's own text" "My own project notes." "$I/CLAUDE.md"
# A project set up before 0.8.0 (package gsd-worktrees, skill gsdw-flow):
# its blocks still count as installed, but are out of date; gsd-init
# --no-launch rewrites them in place.
for f in .gsd/INSTRUCTIONS.md CLAUDE.md AGENTS.md; do
  sed -i.bak 's/<!-- gsd-toolkit:/<!-- gsd-worktrees:/; s/gsdt-flow/gsdw-flow/' "$I/$f"
done
printf 'Top note of mine.\n\n' | cat - "$I/CLAUDE.md" > "$I/CLAUDE.tmp" && mv "$I/CLAUDE.tmp" "$I/CLAUDE.md"
json "$I"
has "pre-0.8.0 marker blocks → T016 for every file" 'older than this toolkit.*INSTRUCTIONS.md CLAUDE.md AGENTS.md' "$OUT"
hasnt "…but they still count as installed (no T052)" '"T052"' "$OUT"
hasnt "…(no T058)" '"T058"' "$OUT"
(cd "$I" && PATH="$BASEPATH" gsd-bootstrap-repo --agents claude,codex) >/dev/null 2>&1
json "$I"
hasnt "gsd-init rewrites them → no T016" '"T016"' "$OUT"
for f in .gsd/INSTRUCTIONS.md CLAUDE.md AGENTS.md; do
  hasnt "…no old marker left in $f" 'gsd-worktrees:\|gsdw-flow' "$I/$f"
done
is "…one provider block in CLAUDE.md" "$(grep -c '^<!-- gsd-toolkit:provider:start -->$' "$I/CLAUDE.md")" 1
is "…in the same place, the user's text around it kept" "$(head -1 "$I/CLAUDE.md"):$(tail -1 "$I/CLAUDE.md")" "Top note of mine.:My own project notes."
rm -f "$I"/*.bak "$I"/.gsd/*.bak
printf 'base = develop\nproviders = claude,codex\nui_gates = off\n' > "$I/.gsd.conf"
json "$I"
hasnt "ui_gates changed since the last gsd-init → no T016 (gsd-rules reads it live)" '"T016"' "$OUT"

# A repo set up before the split: its .gsd/INSTRUCTIONS.md holds the full
# rules. It still works (the text is complete); T016 asks for one gsd-init.
# shellcheck source=../lib/provider.sh
. "$PKG/lib/provider.sh"
{ echo '<!-- gsd-toolkit:canonical:start -->'; gsd_rules_text on
  printf 'Providers: `claude,codex` (default: first, `claude`); base `develop`;\nworktrees `../instr-worktrees/`.\n'
  echo '<!-- gsd-toolkit:canonical:end -->'; } > "$I/.gsd/INSTRUCTIONS.md"
printf 'base = develop\nproviders = claude,codex\n' > "$I/.gsd.conf"
json "$I"
has "a full block from before the split → T016" 'older than this toolkit.*INSTRUCTIONS.md' "$OUT"
(cd "$I" && PATH="$BASEPATH" gsd-bootstrap-repo --agents claude,codex) >/dev/null 2>&1
json "$I"
hasnt "…one gsd-init converts it (no T016)" '"T016"' "$OUT"
has "…to the small block that points at gsd-rules" 'run `gsd-rules` and follow its output' "$I/.gsd/INSTRUCTIONS.md"
hasnt "…without the full rules" 'The shell commands are the source of truth' "$I/.gsd/INSTRUCTIONS.md"
printf 'base = develop\nproviders = claude,codex\nflow = strict\n' > "$I/.gsd.conf"
json "$I"
hasnt "flow changed since the last gsd-init → no T016 (gsd-rules reads it live)" '"T016"' "$OUT"

section "Claude sessions load the rules (T062)"
HS="$WORK/rules-hook.json"
printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"[ ! -x %s ] || exec %s --hook"}]}]}}\n' \
  "$PKG/bin/gsd-rules" "$PKG/bin/gsd-rules" > "$HS"
GSD_CLAUDE_SETTINGS="$HS" doc "$I"
has "the hook is registered → pass" "Claude sessions load the toolkit rules" "$OUT"
GSD_CLAUDE_SETTINGS="$HS" json "$I"
hasnt "…no T062" '"T062"' "$OUT"
echo '{"hooks":{}}' > "$WORK/nohook.json"
GSD_CLAUDE_SETTINGS="$WORK/nohook.json" json "$I"
has "no SessionStart hook runs gsd-rules → T062" '"code":"T062","message":"no Claude SessionStart hook' "$OUT"
GSD_CLAUDE_SETTINGS="$WORK/nosuch.json" json "$I"
has "…a missing settings file too" '"T062"' "$OUT"
grep -q '"safe":\[[^]]*reinstall' "$OUT" && bad "…T062 adds no safe action" || ok "…T062 adds no safe action"
farm "$WORK/norules" gsd-rules
GSD_CLAUDE_SETTINGS="$HS" DPATH="$WORK/norules" json "$I"
has "gsd-rules not on PATH → T062" '"code":"T062","message":"gsd-rules is not on PATH' "$OUT"
farm "$WORK/optout"; printf 'providers\tclaude\nuser_hook\toff\n' > "$WORK/optout/.gsd-install-manifest"
GSD_CLAUDE_SETTINGS="$WORK/nohook.json" DPATH="$WORK/optout" json "$I"
hasnt "installed with --no-user-hook → no T062" '"T062"' "$OUT"
has "…a note instead" 'installed with --no-user-hook' "$OUT"
printf 'base = develop\nproviders = codex\n' > "$I/.gsd.conf"
GSD_CLAUDE_SETTINGS="$WORK/nohook.json" json "$I"
hasnt "Claude not configured → no T062" '"T062"' "$OUT"
printf 'base = develop\nproviders = claude,codex\n' > "$I/.gsd.conf"

section "doctor only reads"
before="$(git -C "$R" status --porcelain; git -C "$R" config --local --list | sort)"
DPATH="$WORK/nosdk" doc "$R"
is "the repo is unchanged" "$(git -C "$R" status --porcelain; git -C "$R" config --local --list | sort)" "$before"

section "--fix runs only the safe fixes, after asking"
F="$WORK/fixme"; mkrepo "$F"
git -C "$F" branch -q release && git -C "$F" push -q origin release && git -C "$F" branch -q -D release
printf 'base = release\n' > "$F/.gsd.conf"
mkdir -p "$F/scripts"; printf '#!/bin/sh\nexit 0\n' > "$F/scripts/gsd-premerge-check.sh"
mkdir -p "$F/.git/gsd-cmd.lock"; echo 999999 > "$F/.git/gsd-cmd.lock/pid"
git -C "$F" add -A && git -C "$F" commit -qm "fixture"; head_before=$(git -C "$F" rev-parse HEAD)
origin_before=$(git -C "$F.origin.git" rev-parse develop)
doc "$F"
has "without --fix it points at --fix" "gsd-doctor --fix" "$OUT"
PATH="$BASEPATH" gsd-doctor --fix --repo "$F" </dev/null > "$OUT" 2>&1
has "--fix lists what it would run" "--fix will run" "$OUT"
has "…no terminal: asks for --yes" "add --yes" "$OUT"
[ -d "$F/.git/gsd-cmd.lock" ] && ok "…and changed nothing" || bad "…and changed nothing"
PATH="$BASEPATH" gsd-doctor --fix --yes --repo "$F" > "$OUT" 2>&1
[ ! -d "$F/.git/gsd-cmd.lock" ] && ok "--yes: dead lock removed (T030)" || bad "--yes: dead lock removed (T030)" "$(tail -5 "$OUT")"
git -C "$F" show-ref --verify --quiet refs/heads/release && ok "--yes: base tracked from origin (T015)" || bad "--yes: base tracked from origin (T015)"
[ -x "$F/scripts/gsd-premerge-check.sh" ] && ok "--yes: pre-merge script made executable (T019)" || bad "--yes: pre-merge script made executable (T019)"
[ -f "$F/scripts/hooks/gsd-worktree-guard.sh" ] && ok "--yes: gsd-init ran (shims, T010)" || bad "--yes: gsd-init ran (shims, T010)"
is "--yes: nothing committed" "$(git -C "$F" rev-parse HEAD)" "$head_before"
is "--yes: nothing pushed" "$(git -C "$F.origin.git" rev-parse develop)" "$origin_before"
has "…checks again after fixing" "Checking again" "$OUT"
has "…and lists the changed files to review" "not committed" "$OUT"
json "$F"
hasnt "the safe findings are gone" '"T0\(10\|11\|12\|13\|14\|15\|19\|30\)"' "$OUT"
mkdir -p "$F/.git/gsd-cmd.lock"; : > "$F/.git/gsd-cmd.lock/pid"
json "$F"
has "a lock with no pid yet is its own finding (T033)" '"T033"' "$OUT"
PATH="$BASEPATH" gsd-doctor --fix --yes --repo "$F" > /dev/null 2>&1
[ -d "$F/.git/gsd-cmd.lock" ] && ok "…which --fix never removes (it may be a command starting)" || bad "…which --fix never removes (it may be a command starting)"
rm -rf "$F/.git/gsd-cmd.lock"
section "--fix is offered only when a fix would change something"
# F's findings left here have no safe fix, so the offer comes from STATE.md alone
printf '# Project State\n\n## Current Position\n\nPhase: 1 of 2\nProgress: [░░░░░░░░░░] 0%%\n' > "$F/.planning/STATE.md"
doc "$F"
hasnt "GSD's own STATE.md form → no --fix offer" "safe to run for you" "$OUT"
hasnt "…and no note about it" "progress bar recomputed" "$OUT"
printf '# Project State\n\n## Current Position\n\nPhase: 1 of 2\nProgress: [█████░░░░░] 50%%\n' > "$F/.planning/STATE.md"
doc "$F"
has "a stale percent → a note" "progress bar recomputed to 0%" "$OUT"
has "…and the --fix offer" "safe to run for you" "$OUT"
rm "$F/.planning/STATE.md"
printf '\n### Phase 02: dup\n' >> "$F/.planning/ROADMAP.md"
PATH="$BASEPATH" gsd-doctor --fix --yes --repo "$F" > "$OUT" 2>&1
has "a judgment finding (T025) is not auto-fixed" "none of these findings has a safe automatic fix" "$OUT"
PATH="$BASEPATH" gsd-doctor --fix --json --repo "$F" > "$OUT" 2>&1
has "--fix and --json don't mix" "don't mix" "$OUT"
PATH="$BASEPATH" gsd-doctor --yes --repo "$F" > "$OUT" 2>&1
has "--yes alone is refused" "only goes with --fix" "$OUT"

section "worktree.baseRef (T034)"
B="$WORK/baseref"; mkrepo "$B"; printf '.claude/settings.local.json\n' > "$B/.gitignore"
git -C "$B" add -A && git -C "$B" commit -qm ignore
BW="$WORK/baseref-worktrees/phase-1-one"; git -C "$B" worktree add -q "$BW" -b phase-1-one
mkdir -p "$B/.claude"; printf '{"permissions":{"allow":["Bash(ls)"]}}\n' > "$B/.claude/settings.local.json"
git -C "$B" worktree add -q "$B/.claude/worktrees/agent-a1" -b worktree-agent-a1   # Claude's per-plan copy
baseref() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("worktree",{}).get("baseRef"))' "$1/.claude/settings.local.json" 2>/dev/null; }
json "$B"
has "not set in the main checkout or a worktree → T034" '"T034"' "$OUT"
doc "$B"
has "…naming both" "not set (in: main checkout phase-1-one)" "$OUT"
has "…and the safe fix" "gsd-doctor --fix" "$OUT"
hasnt "…not Claude's agent-* copies" "agent-a1" "$OUT"
PATH="$BASEPATH" gsd-doctor --fix --yes --repo "$B" > "$OUT" 2>&1
is "--fix sets it in the main checkout" "$(baseref "$B")" head
is "…keeping the other keys" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["permissions"]["allow"][0])' "$B/.claude/settings.local.json")" "Bash(ls)"
is "…and in the phase worktree" "$(baseref "$BW")" head
is "…which stays clean" "$(git -C "$BW" status --porcelain)" ""
is "…and an agent-* copy is left alone" "$([ -e "$B/.claude/worktrees/agent-a1/.claude/settings.local.json" ] && echo written || echo untouched)" untouched
json "$B"
hasnt "…and T034 is gone" '"T034"' "$OUT"
printf '{"worktree":{"baseRef":"origin"}}\n' > "$BW/.claude/settings.local.json"
json "$B"
hasnt "another value is the user's choice: no finding" '"T034"' "$OUT"
has "…only a note" 'baseRef = \\"origin\\" in phase-1-one' "$OUT"
printf '{ "worktree": ' > "$BW/.claude/settings.local.json"
json "$B"
has "a file that is not JSON → T034" '"T034"' "$OUT"
rm "$BW/.claude/settings.local.json"
mkdir -p "$HOME/.claude"; printf '{"worktree":{"baseRef":"head"}}\n' > "$HOME/.claude/settings.json"
json "$B"
hasnt "set in ~/.claude/settings.json → no finding (gsd-core reads it too)" '"T034"' "$OUT"
rm "$HOME/.claude/settings.json"

section "GSD hooks that run a missing file (T008)"
HK="$WORK/hk"; mkdir -p "$HK/bin" "$R/.claude"
export GSD_CLAUDE_SETTINGS="$HK/claude.json" GSD_CODEX_HOOKS="$HK/codex.json"
touch "$HK/bin/node" "$HK/gsd-context-monitor.js"
hook() {  # $1=event $2=command → one settings object
  printf '{"hooks":{"%s":[{"matcher":"Bash","hooks":[{"type":"command","command":%s}]}]}}\n' "$1" "$(printf '%s' "$2" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
}
hook PostToolUse "\"$HK/bin/node\" \"$HK/gsd-context-monitor.js\"" > "$GSD_CLAUDE_SETTINGS"
json "$R"
hasnt "a GSD hook whose files exist → no T008" '"T008"' "$OUT"
hook PostToolUse "\"$HK/old/node\" \"$HK/gsd-context-monitor.js\"" > "$GSD_CLAUDE_SETTINGS"
json "$R"
has "a GSD hook on a node that is gone → T008" '"T008"' "$OUT"
has "T008 names the file and the missing path" "1 GSD hook(s) in $GSD_CLAUDE_SETTINGS run a missing file: $HK/old/node" "$OUT"
has "a missing node → says why" 'a Node upgrade moved it' "$OUT"
has "a gone node → gsd-core's installer (it rewrites its hooks)" 'npx @opengsd/gsd-core@latest --claude --global' "$OUT"
hook PostToolUse "/Applications/Gone.app/cc-status" > "$GSD_CLAUDE_SETTINGS"
json "$R"
hasnt "a hook that is not GSD's is left alone" '"T008"' "$OUT"
hook PostToolUse "\"\$NODE_HOME/node\" \"$HK/gsd-context-monitor.js\"" > "$GSD_CLAUDE_SETTINGS"
json "$R"
hasnt "a path inside another \$VARIABLE is not guessed at" '"T008"' "$OUT"
# gsd-core finds node at run time: a stale saved path there is not broken.
hook PostToolUse "\"\$(for n in \"$HK/old/node\" \"\$(command -v node)\" $HK/no/node; do [ -x \"\$n\" ] && printf '%s' \"\$n\" && break; done)\" \"$HK/gsd-context-monitor.js\"" > "$GSD_CLAUDE_SETTINGS"
json "$R"
hasnt "a node picked at run time (gsd-core) → no T008" '"T008"' "$OUT"
hook PostToolUse "\"\$(for n in \"$HK/bin/node\"; do printf '%s' \"\$n\"; done)\" \"$HK/gone/gsd-context-monitor.js\"" > "$GSD_CLAUDE_SETTINGS"
json "$R"
has "…but its gsd-* script gone → T008" "run a missing file: $HK/gone/gsd-context-monitor.js" "$OUT"
hook PreToolUse "[ ! -x '$HK/gone/gsd-worktree-guard' ] || exec '$HK/gone/gsd-worktree-guard' --global" > "$GSD_CLAUDE_SETTINGS"
json "$R"
has "our --global guard gone → T008" '"T008"' "$OUT"
has "…counted once, though named twice" '1 GSD hook(s)' "$OUT"
hasnt "…fixed by reinstalling the toolkit, not GSD" 'gsd-core@latest --claude' "$OUT"
has "…with the reinstall command" 'install.sh --reuse-install-config' "$OUT"
rm "$GSD_CLAUDE_SETTINGS"
printf '{"statusLine":{"type":"command","command":"\\"%s/old/node\\" \\"%s/gsd-statusline.js\\""}}\n' "$HK" "$HK" > "$GSD_CLAUDE_SETTINGS"
json "$R"
has "a status line on missing files → T008, --force-statusline (the installer keeps one otherwise)" 'npx @opengsd/gsd-core@latest --claude --global --force-statusline' "$OUT"
has "…both missing files listed" "$HK/old/node, $HK/gsd-statusline.js" "$OUT"
rm "$GSD_CLAUDE_SETTINGS"
hook SessionStart "\"$HK/bin/node\" \"$HK/gsd-check-update.js\"" > "$GSD_CODEX_HOOKS"
json "$R"
has "a Codex hooks.json → T008 for codex" 'npx @opengsd/gsd-core@latest --codex --global' "$OUT"
rm "$GSD_CODEX_HOOKS"
hook PreToolUse "node \"\$CLAUDE_PROJECT_DIR/.claude/hooks/gsd-read-guard.js\"" > "$R/.claude/settings.json"
json "$R"
has "a repo-level GSD hook on a missing file → T008, local fix" 'npx @opengsd/gsd-core@latest --claude --local' "$OUT"
has "…\$CLAUDE_PROJECT_DIR read as the repo" "$R/.claude/hooks/gsd-read-guard.js" "$OUT"
printf 'not json' > "$R/.claude/settings.json"
json "$R"
hasnt "settings that are not JSON → skipped, no crash" '"T008"' "$OUT"
rm -rf "$R/.claude"
hook PostToolUse "\"$HK/old/node\" \"$HK/gsd-context-monitor.js\"" > "$GSD_CLAUDE_SETTINGS"
PATH="$BASEPATH" GSD_UPDATE_NOTICE=always gsd-list --repo "$R" > "$OUT" 2>&1
has "gsd-list warns at a terminal" "⚠ 1 GSD hook(s) in $GSD_CLAUDE_SETTINGS run a file that is gone" "$OUT"
PATH="$BASEPATH" gsd-list --repo "$R" > "$OUT" 2>&1
hasnt "…and stays quiet when piped" '⚠' "$OUT"
rm -f "$GSD_CLAUDE_SETTINGS"
unset GSD_CLAUDE_SETTINGS GSD_CODEX_HOOKS

section "lib/install.sh --reuse-install-config keeps recorded agents"
export GSD_BIN_DIR="$WORK/ibin" GSD_CODEX_SKILL_DIR="$WORK/codex-skills"
export GSD_CLAUDE_SKILL_DIR="$WORK/claude-skills"
(cd "$PKG" && lib/install.sh --agent claude) > "$OUT" 2>&1 || bad "first install" "$(tail -5 "$OUT")"
(cd "$PKG" && lib/install.sh --reuse-install-config --agent codex) > "$OUT" 2>&1 || bad "reuse install" "$(tail -5 "$OUT")"
prov=$(awk -F'\t' '$1 == "providers" { print $2 }' "$GSD_BIN_DIR/.gsd-install-manifest")
case ",$prov," in *,claude,*) ok "claude is kept" ;; *) bad "claude is kept" "providers: $prov" ;; esac
case ",$prov," in *,codex,*) ok "codex is added" ;; *) bad "codex is added" "providers: $prov" ;; esac
[ -f "$GSD_CODEX_SKILL_DIR/gsdt-flow/SKILL.md" ] && ok "codex skills installed" || bad "codex skills installed"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
