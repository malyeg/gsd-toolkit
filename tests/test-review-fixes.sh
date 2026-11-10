#!/usr/bin/env bash
# Regression coverage for the fresh-review findings; all mutations are fixtures.
set -euo pipefail
PKG=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export PATH="$PKG/bin:$PATH"
PASS=0
ok() { PASS=$((PASS+1)); printf '  ✔ %s\n' "$1"; }
repo() { mkdir -p "$1"; git -C "$1" init -qb main; git -C "$1" commit -qm init --allow-empty; }
reject() { if "$@" > "$WORK/rejected" 2>&1; then echo "unexpected success: $*" >&2; exit 1; fi; }
. "$PKG/lib/common.sh"
. "$PKG/lib/provider.sh"

R="$WORK/project with spaces"; repo "$R"
git -C "$R" checkout -qb phase-7-test
PD="$R/.planning/phases/07-test"; mkdir -p "$PD"
for name in TICKET CONTEXT REVIEWS 01-PLAN 01-SUMMARY; do touch "$PD/07-$name.md"; done
git -C "$R" add .; git -C "$R" commit -qm artifacts
flow=$(gsdt-flow-next 7 --repo "$R" --no-ui); grep -q '^step=verifier$' <<< "$flow"
ok 'space-containing paths recognize completed plans'
printf -- '---\nstatus: passed\n---\n' > "$PD/07-VERIFICATION.md"
printf -- '---\nstatus: complete\n---\n' > "$PD/07-HUMAN-UAT.md"
flow=$(gsdt-flow-next 7 --repo "$R" --no-ui); grep -q '^step=code-review$' <<< "$flow"
ok 'space-containing paths recognize completed UAT'
printf 'review_provider = invalid;echo\n' > "$R/.gsd.conf"
reject gsdt-flow-next 7 --repo "$R"
grep -q 'invalid review_provider' "$WORK/rejected"; ok 'invalid reviewer is rejected'
rm "$PD/07-REVIEWS.md"
for p in claude codex custom; do
  printf 'review_provider = %s\n' "$p" > "$R/.gsd.conf"
  gsdt-flow-next 7 --repo "$R" --no-ui > "$WORK/flow"
  grep -q '^step=review$' "$WORK/flow"
  if [ "$p" = custom ]; then grep -q 'independent custom-provider review' "$WORK/flow"
  else grep -q -- "--$p" "$WORK/flow"; fi
  ok "$p reviewer retains independent review gate"
done

# No jq is discoverable in this PATH, even on Linux where jq lives in /usr/bin.
mkdir "$WORK/no-jq"
for cmd in bash cat dirname sed head grep git python3 tr awk; do ln -s "$(command -v "$cmd")" "$WORK/no-jq/$cmd"; done
set +e
printf '%s' '{"tool_name":"Skill","tool_input":{"skill":"gsd-plan-phase","args":"8"}}' |
  PATH="$WORK/no-jq" CLAUDE_PROJECT_DIR="$R" "$PKG/bin/gsdt-worktree-guard" > "$WORK/hook" 2>&1
rc=$?
set -e
[ "$rc" = 2 ]; grep -q 'targets phase 8' "$WORK/hook"
ok 'Claude no-jq fallback blocks nested wrong-phase args'

R="$WORK/bootstrap"; repo "$R"
(cd "$R" && gsdt-bootstrap-repo --agents codex,custom --provider-command custom=true) >/dev/null
gsd_provider_instruction_integrated "$R" codex
gsd_provider_instruction_integrated "$R" custom
ok 'Codex and custom share an explicitly identified entrypoint'
printf '\nUser policy after generated block\n' >> "$R/.gsd/INSTRUCTIONS.md"
(cd "$R" && gsdt-bootstrap-repo --agents custom,codex --provider-command custom=true) >/dev/null
grep -q 'User policy after generated block' "$R/.gsd/INSTRUCTIONS.md"
gsd_provider_instruction_integrated "$R" codex
gsd_provider_instruction_integrated "$R" custom
ok 'reversed provider order preserves shared entrypoint and canonical additions'
# Legacy single-marker migration must preserve trailing additions, with a
# complete backup even if legacy content cannot be recognized automatically.
printf '<!-- gsd-worktrees:canonical -->\n# GSD worktree workflow\nlegacy generated text\nworktrees `../old/`.\nUser legacy addition\n' > "$R/.gsd/INSTRUCTIONS.md"
(cd "$R" && gsdt-bootstrap-repo --agents codex,custom --provider-command custom=true) >/dev/null
grep -q 'User legacy addition' "$R/.gsd/INSTRUCTIONS.md"
grep -q 'legacy generated text' "$R/.gsd/INSTRUCTIONS.md.bak"
gsd_provider_instruction_integrated "$R" codex
ok 'legacy canonical migration preserves additions and full backup'
(cd "$R" && gsdt-bootstrap-repo --agent custom --provider-command custom=true) >/dev/null
gsdt-doctor --repo "$R" --json > "$WORK/doctor" || true
if grep -q 'stale codex' "$WORK/doctor"; then exit 1; fi
ok 'custom-only instructions are not stale Codex artifacts'
sed -i.bak '/provider:end/d' "$R/AGENTS.md"
if gsd_provider_instruction_integrated "$R" custom; then exit 1; fi
gsdt-doctor --repo "$R" --json > "$WORK/doctor" || true
grep -q '"instruction_integrated":false' "$WORK/doctor"
ok 'doctor rejects incomplete instruction blocks'

R="$WORK/hooks"; repo "$R"; mkdir "$R/.claude"
printf '%s\n' '{"comment":"gsdt-worktree-guard", "hooks":{}}' > "$R/.claude/settings.json"
(cd "$R" && gsdt-bootstrap-repo --agent claude) >/dev/null
[ "$(gsd_provider_hook_state "$R" claude)" = present ]
ok 'inert hook mention does not prevent real registration'
printf '%s\n' '{"hooks":{"PreToolUse":{}}}' > "$R/.claude/settings.json"
cp "$R/.claude/settings.json" "$WORK/original-json"
(cd "$R" && gsdt-bootstrap-repo --agent claude) > "$WORK/bootstrap-output"
cmp "$R/.claude/settings.json" "$WORK/original-json"
if grep -q '(claude native guard hook)' "$WORK/bootstrap-output"; then exit 1; fi
[ "$(gsd_provider_hook_state "$R" claude)" = invalid ]
ok 'incompatible hook JSON preserved without false success'
printf '%s\n' '{"disableAllHooks":true,"hooks":{}}' > "$R/.claude/settings.json"
(cd "$R" && gsdt-bootstrap-repo --agent claude) >/dev/null
[ "$(gsd_provider_hook_state "$R" claude)" = absent ]
ok 'explicitly disabled hooks remain disabled'
cp "$R/.gsd/INSTRUCTIONS.md" "$WORK/canonical"
printf '<!-- gsd-toolkit:canonical:start -->\n' >> "$R/.gsd/INSTRUCTIONS.md"
reject bash -c 'cd "$1" && "$2/bin/gsdt-bootstrap-repo" --agent claude' _ "$R" "$PKG"
grep -q 'ambiguous canonical' "$WORK/rejected"; ok 'malformed canonical markers stop bootstrap'
cp "$WORK/canonical" "$R/.gsd/INSTRUCTIONS.md"
chmod -x "$R/.git/hooks/post-merge"
gsd_planning_status "$R"; [[ " $GSD_PLANNING_MISSING " == *' hook '* ]]
gsd_planning_apply "$R" >/dev/null
[ -x "$R/.git/hooks/post-merge" ]
[ "$(grep -c 'gsdt-planning-repair || true' "$R/.git/hooks/post-merge")" = 1 ]
ok 'non-executable planning hook repaired without duplicate body'

mkdir -p "$WORK/broken/bin" "$WORK/broken/lib" "$WORK/broken/shims"
cp "$PKG"/bin/* "$WORK/broken/bin/"
cp "$PKG"/lib/* "$WORK/broken/lib/" 2>/dev/null || true
cp -R "$PKG/shims/scripts" "$WORK/broken/shims/"
chmod -x "$WORK/broken/bin/gsdt-worktree-guard"
"$WORK/broken/bin/gsdt-doctor" --repo "$R" --json > "$WORK/doctor" || true
grep -q '"command_guard":false' "$WORK/doctor"
ok 'doctor JSON reports broken command guard honestly'
mkdir -p "$WORK/skills/gsdt-flow"
cp "$PKG/skills/gsdt-flow/SKILL.md" "$WORK/skills/gsdt-flow/SKILL.md"
GSD_CLAUDE_SKILL_DIR="$WORK/skills" gsdt-doctor --repo "$R" --json > "$WORK/doctor" || true
grep -q '"skill_installed":true' "$WORK/doctor"
ok 'doctor respects installer skill destination override'
printf '# unrelated instructions\n' > "$R/.gsd/INSTRUCTIONS.md"
gsdt-doctor --repo "$R" --json > "$WORK/doctor" || true
grep -q '"instruction_integrated":false' "$WORK/doctor"
ok 'unrelated canonical filename alone is not an integration'

R="$WORK/finish"; repo "$R"
git -C "$R" branch unrelated
git -C "$R" branch phase-1-feature; git -C "$R" branch phase-1-feature-pr   # /gsd-pr-branch names its helper <branch>-pr
for command in gsdt-finish gsdt-wt-finish; do
  for branch in unrelated phase-1-feature-pr; do
    reject bash -c 'cd "$1" && "$2" "$3"' _ "$R" "$command" "$branch"
    git -C "$R" show-ref --verify --quiet "refs/heads/$branch"
    ok "$command rejects $branch without deleting it"
  done
done
printf 'test = none\n' > "$R/.gsd.conf"
git -C "$R" add .; git -C "$R" commit -qm config
git -C "$R" worktree add -q "$WORK/phase" phase-1-feature
git -C "$R" remote add origin "$WORK/missing-remote"
before=$(git -C "$R" rev-parse HEAD)
reject bash -c 'cd "$1" && gsdt-wt-finish 1' _ "$R"
[ "$before" = "$(git -C "$R" rev-parse HEAD)" ]; [ -d "$WORK/phase" ]
ok 'failed remote synchronization stops before phase merge'

# Real push rejection: the first pre-push hook advances the isolated bare
# remote through a second checkout. Validation must inspect the combined tree.
git init -q --bare "$WORK/remote.git"
git -C "$R" remote set-url origin "$WORK/remote.git"
git -C "$R" push -qu origin main
git clone -q -b main "$WORK/remote.git" "$WORK/racer"
printf 'bad\n' > "$WORK/racer/reject-combined"
git -C "$WORK/racer" add .; git -C "$WORK/racer" commit -qm concurrent
mkdir -p "$R/scripts"
printf '#!/bin/sh\ntest ! -f reject-combined\n' > "$R/scripts/gsdt-premerge-check.sh"
chmod +x "$R/scripts/gsdt-premerge-check.sh"
git -C "$R" add .; git -C "$R" commit -qm validator
git -C "$R" push -q origin main
git -C "$WORK/racer" pull -q --no-rebase origin main
printf 'phase\n' > "$WORK/phase/feature"
git -C "$WORK/phase" add .; git -C "$WORK/phase" commit -qm feature
printf '#!/bin/sh\nif [ ! -f "$RACE_MARKER" ]; then\n touch "$RACE_MARKER"\n git -C "$RACE_CHECKOUT" push -q origin main || exit 1\nfi\n' > "$R/.git/hooks/pre-push"
chmod +x "$R/.git/hooks/pre-push"
export RACE_MARKER="$WORK/raced" RACE_CHECKOUT="$WORK/racer"
reject bash -c 'cd "$1" && gsdt-wt-finish 1' _ "$R"
grep -q 'validation failed (combined tree after remote retry)' "$WORK/rejected"
[ -d "$WORK/phase" ]
if git --git-dir="$WORK/remote.git" cat-file -e main:feature 2>/dev/null; then exit 1; fi
ok 'concurrent remote changes revalidated before retry push; worktree retained'

# Tests must run against combined code, not only the pre-merge feature tree.
R="$WORK/combined"; repo "$R"
printf 'test = sh check.sh\n' > "$R/.gsd.conf"
printf '#!/bin/sh\nif [ -f base-file ] && [ -f feature-file ]; then exit 1; fi\n' > "$R/check.sh"
git -C "$R" add .; git -C "$R" commit -qm check
git -C "$R" worktree add -qb phase-2-combined "$WORK/combined-phase"
touch "$R/base-file"; git -C "$R" add .; git -C "$R" commit -qm base
touch "$WORK/combined-phase/feature-file"
git -C "$WORK/combined-phase" add .; git -C "$WORK/combined-phase" commit -qm feature
reject bash -c 'cd "$1" && gsdt-wt-finish 2' _ "$R"
grep -q 'tests failed (combined tree after phase merge)' "$WORK/rejected"
[ -d "$WORK/combined-phase" ]
ok 'test fallback validates combined code and keeps worktree on failure'

printf '\n%d passed, 0 failed\n' "$PASS"
