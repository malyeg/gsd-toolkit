#!/usr/bin/env bash
# test-migrate.sh — gsdt-migrate: a repo set up before 0.10.0 (old gsd-* shims,
# repo hook, instruction blocks, merge driver, gsd-tracker git section,
# post-merge hook, the user's pre-merge script, package.json naming a shim, the
# user's Claude hooks, an open phase worktree, free text in .planning/) →
# dry run lists it all and changes nothing → the commands refuse → --apply →
# --check clean → a second --apply changes nothing → the commands run → text
# outside the markers and .planning/ untouched → a planning merge in the open
# worktree still uses the driver. Also: an edited shim, two pre-merge
# scripts, doctor T090 (+ --fix), and a repo bootstrapped by the real v0.9.0.
# Everything runs in throwaway repos; HOME is a temp dir.
set -uo pipefail
PKG=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d); WORK=$(cd "$WORK" && pwd -P); trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"; mkdir -p "$HOME"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GSD_NO_UPDATE_CHECK=1 GSD_NO_CORE=1 GSD_CLAUDE_SKILL_DIR="$WORK/skills"
export GSD_CLAUDE_SETTINGS="$WORK/user-settings.json"
unset CLICKUP_API_TOKEN GSD_SKIP_GUARD CLAUDE_CONFIG_DIR CODEX_HOME GSD_TRACKER GSD_TRACKER_PROFILE
export PATH="$PKG/bin:$PATH"
# A gsd-core that answers who it is and fails everything else: gsdt-start
# stops right after the check under test (it never claims a phase here).
mkdir -p "$WORK/stub"
printf '#!/bin/sh\n[ "$1" = runtime-identity ] && echo %s && exit 0\nexit 1\n' "'{\"packageName\":\"@opengsd/gsd-core\",\"version\":\"1.18.0\"}'" > "$WORK/stub/gsd_run"
chmod +x "$WORK/stub/gsd_run"; export GSD_CLI="$WORK/stub/gsd_run"
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '%s\n' "$2" | sed 's/^/      /'; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
has() { if grep -q -- "$2" "$3"; then ok "$1"; else bad "$1" "$(tail -8 "$3")"; fi; }
hasnt() { if grep -q -- "$2" "$3"; then bad "$1" "$(grep -- "$2" "$3" | head -3)"; else ok "$1"; fi; }
section() { printf '\n%s\n' "$1"; }
OUT="$WORK/out"

SHIMS="scripts/gsdt-new-worktree-feature.sh scripts/gsdt-finish-worktree-feature.sh scripts/gsdt-derive-port.sh scripts/gsdt-planning-repair.sh scripts/hooks/gsdt-worktree-guard.sh"
old_of() { printf '%s' "$1" | sed 's#gsdt-#gsd-#'; }
# Turn text from this release into what 0.9.0 wrote: the command names only.
age() { perl -pi -e 's/(?<![\w\/-])gsdt-(rules|flow-next|worktree-guard|wt-new|wt-finish|derive-port|planning-repair|bootstrap-repo|init|start|finish)(?![\w-])/gsd-$1/g; s#scripts/(hooks/)?gsdt-#scripts/$1gsd-#g; s/gsd-toolkit shim/gsd-worktrees shim/' "$@"; }

# A repo as 0.9.0 left it: set up by this release's bootstrap, then aged.
mkold() {  # $1=dir
  local R=$1 rel
  git init -q -b main "$R"
  mkdir -p "$R/.planning"
  printf '# Roadmap\n\n### Phase 1: One\n' > "$R/.planning/ROADMAP.md"
  printf '# State\n' > "$R/.planning/STATE.md"
  printf 'Run gsd-start -p 1, then gsd-finish.\n' > "$R/.planning/notes.md"
  printf '# My project\n\nOur own text: run gsd-start for a phase.\n' > "$R/CLAUDE.md"
  git -C "$R" add -A && git -C "$R" commit -qm init
  (cd "$R" && gsdt-bootstrap-repo --agents claude,codex) > /dev/null 2>&1 || { bad "bootstrap of the fixture"; return 1; }
  for rel in $SHIMS; do age "$R/$rel"; mv "$R/$rel" "$R/$(old_of "$rel")"; done
  age "$R/.claude/settings.json" "$R/.gsd/INSTRUCTIONS.md" "$R/CLAUDE.md" "$R/AGENTS.md" "$R/.git/hooks/post-merge"
  git -C "$R" config merge.gsd-planning.driver "gsd-planning-merge %O %A %B %P"
  git -C "$R" config gsd-tracker.profile acme
  git -C "$R" config gsd-tracker.statusStart "in progress"
  printf '#!/bin/sh\n# the team'"'"'s own checks\nexit 0\n' > "$R/scripts/gsd-premerge-check.sh"; chmod +x "$R/scripts/gsd-premerge-check.sh"
  printf '{"scripts":{"dev":"PORT=$(bash ../../scripts/gsd-derive-port.sh 3000) next dev","repair":"scripts/gsd-planning-repair.sh"}}\n' > "$R/package.json"
  git -C "$R" add -A && git -C "$R" commit -qm "gsd setup (0.9.0)"
}
# The user's Claude settings as the 0.9.0 install wrote them, plus one of theirs.
mkuser() {
  cat > "$GSD_CLAUDE_SETTINGS" <<EOF
{
  "model": "opus",
  "hooks": {
    "PreToolUse": [{"matcher": "Skill", "hooks": [{"type": "command", "command": "[ ! -x '/u/bin/gsd-worktree-guard' ] || exec '/u/bin/gsd-worktree-guard' --global"}]}],
    "SessionStart": [{"hooks": [{"type": "command", "command": "[ ! -x '/u/bin/gsd-rules' ] || exec '/u/bin/gsd-rules' --hook"}, {"type": "command", "command": "echo mine"}]}]
  }
}
EOF
}

section "the fixture is a 0.9.0 repo"
R="$WORK/proj"; mkold "$R"; mkuser
git -C "$R" worktree add -q "$WORK/proj-wt" -b phase-1-one
for rel in $SHIMS; do [ -f "$R/$(old_of "$rel")" ] || bad "fixture: $(old_of "$rel")"; done
has "fixture: old repo hook" 'hooks/gsd-worktree-guard.sh' "$R/.claude/settings.json"
has "fixture: old block"     '`gsd-rules`' "$R/CLAUDE.md"

section "dry run: lists everything, changes nothing"
before=$(cd "$R" && git status --porcelain; git config --local --list; cat .git/hooks/post-merge "$GSD_CLAUDE_SETTINGS")
(cd "$R" && gsdt-migrate) > "$OUT" 2>&1; rc=$?
is  "exit 1 (there is work)" "$rc" 1
for rel in $SHIMS; do has "lists $(old_of "$rel")" "$(old_of "$rel") → $rel" "$OUT"; done
has "lists the pre-merge script"   "scripts/gsd-premerge-check.sh → scripts/gsdt-premerge-check.sh" "$OUT"
has "lists package.json, per line" "package.json:1: " "$OUT"
has "lists the repo hook"          ".claude/settings.json: hook" "$OUT"
has "lists .gsd/INSTRUCTIONS.md"   ".gsd/INSTRUCTIONS.md: the gsd-toolkit:canonical block" "$OUT"
has "lists CLAUDE.md"              "CLAUDE.md: the gsd-toolkit:provider block" "$OUT"
has "lists AGENTS.md"              "AGENTS.md: the gsd-toolkit:provider block" "$OUT"
has "lists the merge driver"       "merge.gsd-planning.driver: gsd-planning-merge → gsdt-planning-merge" "$OUT"
has "lists the tracker section"    "gsd-tracker → gsdt-tracker (2 key(s))" "$OUT"
has "lists the post-merge hook"    "post-merge.*gsd-planning-repair → gsdt-planning-repair" "$OUT"
has "lists the user's hooks"       "user-settings.json: the toolkit's hooks" "$OUT"
has "notes the open worktree"      "open worktree phase-1-one still has the old files" "$OUT"
has "notes free text"              ".planning/notes.md:1" "$OUT"
has "…and our own text outside the markers" "CLAUDE.md:3" "$OUT"
has "says how to apply"            "run: gsdt-migrate --apply" "$OUT"
after=$(cd "$R" && git status --porcelain; git config --local --list; cat .git/hooks/post-merge "$GSD_CLAUDE_SETTINGS")
is  "…and nothing changed" "$after" "$before"
(cd "$R" && gsdt-migrate --check) > "$OUT" 2>&1; rc=$?
is  "--check: exit 1"  "$rc" 1
is  "--check is quiet" "$(cat "$OUT")" ""

section "the commands refuse an unmigrated repo"
for c in "gsdt-start -n x --no-launch" "gsdt-flow-next 1" "gsdt-finish 1" "gsdt-init --no-launch"; do
  # shellcheck disable=SC2086
  (cd "$R" && GSD_SKIP_GUARD=1 $c) > "$OUT" 2>&1; rc=$?
  is  "${c%% *} refuses (exit 1), even with GSD_SKIP_GUARD=1" "$rc" 1
  has "…and names gsdt-migrate" "old gsd-\* names (before 0.10.0) — run: gsdt-migrate --apply" "$OUT"
done
(cd "$WORK/proj-wt" && gsdt-flow-next 1) > "$OUT" 2>&1
has "…also from the phase worktree (checks the main checkout)" "gsdt-migrate --apply" "$OUT"
gsdt-doctor --repo "$R" --quiet > "$OUT" 2>&1
has "doctor: T090" "old gsd-\* command names.*gsdt-migrate --apply.*T090" "$OUT"
gsdt-doctor --repo "$R" --json > "$OUT" 2>/dev/null
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if "migrate" in d.get("safe_fixes", d.get("safe", [])) else 1)' "$OUT" 2>/dev/null; then
  ok "doctor --json: migrate is a safe fix"; else bad "doctor --json: migrate is a safe fix" "$(grep -o '"safe[^]]*]' "$OUT")"; fi

section "--apply"
cp "$R/CLAUDE.md" "$WORK/claude.before"
cp "$R/scripts/gsd-premerge-check.sh" "$WORK/pm.before"
(cd "$R/.planning" && find . -type f -exec cksum {} + | sort) > "$WORK/planning.before"
(cd "$R" && gsdt-migrate --apply) > "$OUT" 2>&1; rc=$?
is  "exit 0" "$rc" 0
has "says what to commit" "✔ migrated to gsdt-\* (15 change(s), not committed)" "$OUT"
has "…and the teammates' step" "gsdt-migrate --apply in their clone" "$OUT"
for rel in $SHIMS; do
  if cmp -s "$PKG/shims/$rel" "$R/$rel" && [ -x "$R/$rel" ] && [ ! -e "$R/$(old_of "$rel")" ]; then ok "$rel: this release's shim, old one gone"
  else bad "$rel: this release's shim, old one gone" "$(ls -l "$R/scripts" "$R/scripts/hooks")"; fi
done
if cmp -s "$WORK/pm.before" "$R/scripts/gsdt-premerge-check.sh" && [ -x "$R/scripts/gsdt-premerge-check.sh" ] && [ ! -e "$R/scripts/gsd-premerge-check.sh" ]; then
  ok "pre-merge script renamed, its content as it was"; else bad "pre-merge script renamed, its content as it was"; fi
is  "package.json: exact paths renamed" "$(cat "$R/package.json")" '{"scripts":{"dev":"PORT=$(bash ../../scripts/gsdt-derive-port.sh 3000) next dev","repair":"scripts/gsdt-planning-repair.sh"}}'
is  "repo hook: one, the new path" "$(grep -c 'worktree-guard' "$R/.claude/settings.json")/$(grep -c 'hooks/gsdt-worktree-guard.sh' "$R/.claude/settings.json")" "1/1"
for f in .gsd/INSTRUCTIONS.md CLAUDE.md AGENTS.md; do
  blk=$(awk '/<!-- gsd-toolkit:[a-z]+:start -->/{on=1} on{print} /<!-- gsd-toolkit:[a-z]+:end -->/{on=0}' "$R/$f")
  if printf '%s\n' "$blk" | grep -qE '(^|[^/a-z-])gsd-(rules|flow-next|start|finish|init)([^a-z-]|$)'; then bad "$f: block has no old name" "$blk"; else ok "$f: block has no old name"; fi
done
is  "CLAUDE.md: our own text outside the markers kept" "$(sed -n 1,3p "$R/CLAUDE.md")" "$(sed -n 1,3p "$WORK/claude.before")"
(cd "$R/.planning" && find . -type f -exec cksum {} + | sort) > "$WORK/planning.after"
if cmp -s "$WORK/planning.before" "$WORK/planning.after"; then ok ".planning/ untouched"; else bad ".planning/ untouched" "$(diff "$WORK/planning.before" "$WORK/planning.after")"; fi
is  "merge driver: the new command" "$(git -C "$R" config --get merge.gsd-planning.driver)" "gsdt-planning-merge %O %A %B %P"
is  ".gitattributes keeps merge=gsd-planning" "$(grep -c 'merge=gsd-planning$' "$R/.gitattributes")" 2
is  "tracker: gsdt-tracker.profile" "$(git -C "$R" config --get gsdt-tracker.profile)" acme
is  "…every key moved"               "$(git -C "$R" config --get gsdt-tracker.statusStart)" "in progress"
is  "…the old section gone"          "$(git -C "$R" config --get-regexp '^gsd-tracker\.' | wc -l | tr -d ' ')" 0
hasnt "post-merge hook: no old name"   'gsd-planning-repair' "$R/.git/hooks/post-merge"
has   "…runs gsdt-planning-repair"     'command -v gsdt-planning-repair' "$R/.git/hooks/post-merge"
is  "user hooks: renamed in place" "$(grep -c "gsdt-worktree-guard' --global" "$GSD_CLAUDE_SETTINGS")/$(grep -c "gsdt-rules' --hook" "$GSD_CLAUDE_SETTINGS")/$(grep -c "gsd-worktree-guard\|gsd-rules" "$GSD_CLAUDE_SETTINGS")" "1/1/0"
has "…the user's own hook and keys kept" '"echo mine"' "$GSD_CLAUDE_SETTINGS"
has "…the user's own keys kept"         '"model": "opus"' "$GSD_CLAUDE_SETTINGS"
if git -C "$R" log -1 --format=%s | grep -q "0.9.0"; then ok "nothing committed"; else bad "nothing committed"; fi

section "after: clean, idempotent, the commands run"
(cd "$R" && gsdt-migrate --check) > "$OUT" 2>&1; is "--check: exit 0" "$?" 0
(cd "$R" && gsdt-migrate --apply) > "$OUT" 2>&1; rc=$?
is  "second --apply: exit 0" "$rc" 0
has "…changes nothing" "nothing to migrate" "$OUT"
(cd "$R" && gsdt-migrate) > "$OUT" 2>&1; is "dry run: exit 0" "$?" 0
(cd "$R" && GSD_SKIP_GUARD=1 gsdt-flow-next 1) > "$OUT" 2>&1
hasnt "gsdt-flow-next no longer refuses" "gsdt-migrate" "$OUT"
(cd "$R" && gsdt-start -n x --no-launch) > "$OUT" 2>&1
hasnt "gsdt-start no longer refuses" "gsdt-migrate" "$OUT"
gsdt-doctor --repo "$R" --quiet > "$OUT" 2>&1
hasnt "doctor: no T090" "T090" "$OUT"
hasnt "doctor: no T010 (shims current)" "T010" "$OUT"
hasnt "doctor: no T013/T014 (driver, hook)" "T01[34]" "$OUT"
hasnt "doctor: no T016 (blocks current)" "T016" "$OUT"

section "the open worktree still merges .planning with the driver"
git -C "$R" add -A && git -C "$R" commit -qm "Switch to gsdt-* toolkit commands"
printf '\n### Phase 2: Two\n' >> "$R/.planning/ROADMAP.md"
git -C "$R" commit -qam "main: phase 2"
WT="$WORK/proj-wt"
printf '\n### Phase 3: Three\n' >> "$WT/.planning/ROADMAP.md"
git -C "$WT" commit -qam "branch: phase 3"
is  "the branch still says merge=gsd-planning" "$(git -C "$WT" check-attr merge .planning/ROADMAP.md | sed 's/.*: //')" gsd-planning
git -C "$WT" merge -q --no-edit main > "$OUT" 2>&1; rc=$?
is  "merging main into it: no conflict" "$rc" 0
if grep -q 'Phase 2: Two' "$WT/.planning/ROADMAP.md" && grep -q 'Phase 3: Three' "$WT/.planning/ROADMAP.md"; then ok "…both phases kept (the driver ran)"; else bad "…both phases kept (the driver ran)" "$(cat "$WT/.planning/ROADMAP.md")"; fi
for rel in $SHIMS; do [ -f "$WT/$rel" ] && [ ! -e "$WT/$(old_of "$rel")" ] || bad "worktree took the new shims: $rel"; done
ok "…and took the new shims"

section "what it leaves to you"
R2="$WORK/proj2"; mkold "$R2"
printf '# my own change\n' >> "$R2/scripts/gsd-derive-port.sh"
sed -i.bak '2s/.*/# our derive-port, changed/' "$R2/scripts/gsd-derive-port.sh"; rm -f "$R2/scripts/gsd-derive-port.sh.bak"
printf '#!/bin/sh\nexit 0\n' > "$R2/scripts/gsdt-premerge-check.sh"
(cd "$R2" && gsdt-migrate --apply) > "$OUT" 2>&1; rc=$?
is  "an edited shim / two pre-merge scripts: exit 1" "$rc" 1
has "…the edited shim is named" "scripts/gsd-derive-port.sh: not the toolkit's shim" "$OUT"
has "…both pre-merge scripts are named" "both scripts/gsd-premerge-check.sh and scripts/gsdt-premerge-check.sh exist" "$OUT"
if [ -f "$R2/scripts/gsd-derive-port.sh" ] && [ ! -e "$R2/scripts/gsdt-derive-port.sh" ]; then ok "…the edited shim is left alone"; else bad "…the edited shim is left alone"; fi
if [ -f "$R2/scripts/gsd-premerge-check.sh" ]; then ok "…both pre-merge scripts left"; else bad "…both pre-merge scripts left"; fi
if [ -f "$R2/scripts/gsdt-new-worktree-feature.sh" ] && [ ! -e "$R2/scripts/gsd-new-worktree-feature.sh" ]; then ok "…the other shims moved"; else bad "…the other shims moved"; fi
(cd "$R2" && gsdt-migrate --check); is "--check still exit 1" "$?" 1

section "doctor --fix runs it"
R3="$WORK/proj3"; mkold "$R3"
gsdt-doctor --repo "$R3" --fix --yes > "$OUT" 2>&1
has "--fix lists it" "gsdt-migrate --apply" "$OUT"
(cd "$R3" && gsdt-migrate --check); is "…and the repo is migrated" "$?" 0

section "a repo bootstrapped by the real 0.9.0"
if git -C "$PKG" rev-parse -q --verify 'v0.9.0^{commit}' >/dev/null; then
  OLD="$WORK/src-090"; mkdir -p "$OLD"; git -C "$PKG" archive v0.9.0 | tar -x -C "$OLD"
  R4="$WORK/proj4"; git init -q -b main "$R4"; mkdir -p "$R4/.planning"; printf '# Roadmap\n' > "$R4/.planning/ROADMAP.md"
  git -C "$R4" add -A && git -C "$R4" commit -qm init
  (cd "$R4" && PATH="$OLD/bin:$PATH" "$OLD/bin/gsd-bootstrap-repo" --agents claude,codex) > /dev/null 2>&1
  git -C "$R4" add -A && git -C "$R4" commit -qm "0.9.0 setup"
  (cd "$R4" && gsdt-migrate --apply) > "$OUT" 2>&1; is "--apply: exit 0" "$?" 0
  (cd "$R4" && gsdt-migrate --check); is "…then --check clean" "$?" 0
  gsdt-doctor --repo "$R4" --quiet > "$OUT" 2>&1
  hasnt "…and doctor reports no shim, block or setup finding" "T01[0-6]\|T090\|T05[2-8]" "$OUT"
elif [ -n "${CI:-}" ]; then
  bad "the real 0.9.0 needs the v0.9.0 tag (checkout with fetch-depth: 0)"
else
  printf '  • skipped: no v0.9.0 tag here (git fetch --tags)\n'
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
