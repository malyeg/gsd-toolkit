#!/usr/bin/env bash
# shellcheck disable=SC2034  # variables are read inside check()'s eval strings
# Regression coverage for the 2026-09-25 full-code review (docs/fix-plan.md,
# R01–R12). Every repo is a throwaway fixture; no real remote is touched.
set -uo pipefail
PKG=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export PATH="$PKG/bin:$PATH"
unset GSD_PROVIDER GSD_AGENT GSD_AGENT_COMMAND GSD_LOCK_HELD
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
section() { printf '\n%s\n' "$1"; }
repo() {  # $1=dir — a repo on main with a one-phase roadmap
  mkdir -p "$1/.planning"; git -C "$1" init -qb main
  printf '# Roadmap\n### Phase 1: first\n### Phase 2: second\n' > "$1/.planning/ROADMAP.md"
}
commit() { git -C "$1" add -A; git -C "$1" commit -qm "${2:-c}"; }
# shellcheck source=../lib/common.sh
. "$PKG/lib/common.sh"
# shellcheck source=../lib/provider.sh
. "$PKG/lib/provider.sh"

section "R01 — install/test values are shell commands, not word lists"
R="$WORK/r01"; repo "$R"
printf 'install = echo one > a.txt && echo two > b.txt\n' > "$R/.gsd.conf"; commit "$R"
(cd "$R" && gsdt-wt-new --phase 1 --install) > "$WORK/out" 2>&1
WT="$WORK/r01-worktrees/phase-1-first"
check "foreground install runs every part of a compound command" \
  '[ -f "$WT/a.txt" ] && [ -f "$WT/b.txt" ] && [ "$(cat "$WT/a.txt")" = one ]'
check "foreground install records ok" '[ "$(cat "$WT/.gsd-install.status")" = ok ]'
printf 'install = true && false\n' > "$R/.gsd.conf"; commit "$R"
(cd "$R" && gsdt-wt-new --phase 2) > "$WORK/out" 2>&1
WT2="$WORK/r01-worktrees/phase-2-second"
for _ in 1 2 3 4 5 6 7 8 9 10; do [ "$(cat "$WT2/.gsd-install.status")" = running ] || break; sleep 1; done
check "background install: a failing second command records fail, not ok" \
  '[ "$(cat "$WT2/.gsd-install.status")" = fail ]'
printf '### Phase 3: third\n' >> "$R/.planning/ROADMAP.md"
printf 'install = sleep 8\n' > "$R/.gsd.conf"; commit "$R"
t0=$(date +%s); out=$(cd "$R" && gsdt-wt-new --phase 3 2>&1); t1=$(date +%s)
check "background install does not hold a \$( … ) caller open (gsdt-start hang)" \
  '[ $((t1 - t0)) -lt 5 ] && [ "$(cat "$WORK/r01-worktrees/phase-3-third/.gsd-install.status")" = running ]'

R="$WORK/r01t"; repo "$R"
printf 'test = true && false\n' > "$R/.gsd.conf"; commit "$R"
git -C "$R" worktree add -qb phase-1-x "$WORK/r01t-wt"
touch "$WORK/r01t-wt/feature"; commit "$WORK/r01t-wt"
if (cd "$R" && gsdt-wt-finish 1) > "$WORK/out" 2>&1; then bad "a failing compound test command blocks the finish"
else check "a failing compound test command blocks the finish" 'grep -q "tests failed" "$WORK/out" && [ -d "$WORK/r01t-wt" ]'; fi

section "R02 — a non-executable pre-merge check is refused, not skipped"
R="$WORK/r02"; repo "$R"; mkdir -p "$R/scripts"
printf 'test = none\n' > "$R/.gsd.conf"
printf '#!/bin/sh\nexit 1\n' > "$R/scripts/gsdt-premerge-check.sh"; chmod -x "$R/scripts/gsdt-premerge-check.sh"
commit "$R"
git -C "$R" worktree add -qb phase-1-x "$WORK/r02-wt"
touch "$WORK/r02-wt/feature"; commit "$WORK/r02-wt"
before=$(git -C "$R" rev-parse HEAD)
if (cd "$R" && gsdt-wt-finish 1) > "$WORK/out" 2>&1; then bad "finish refuses a non-executable pre-merge check"
else check "finish refuses a non-executable pre-merge check" 'grep -q "not executable" "$WORK/out"'; fi
check "nothing merged, worktree kept" '[ "$before" = "$(git -C "$R" rev-parse HEAD)" ] && [ -d "$WORK/r02-wt" ]'

section "R04 — deprecated GSD_AGENT never beats --agent-command"
R="$WORK/r04"; mkdir -p "$R"
GSD_AGENT=my-legacy-agent gsd_provider_resolve "$R" "" "/opt/bin/real-agent"
check "--agent-command wins over GSD_AGENT" '[ "$GSD_AGENT_COMMAND_RESOLVED" = /opt/bin/real-agent ]'
GSD_AGENT=my-legacy-agent GSD_AGENT_COMMAND=/opt/bin/env-agent gsd_provider_resolve "$R" "" ""
check "GSD_AGENT_COMMAND wins over GSD_AGENT" '[ "$GSD_AGENT_COMMAND_RESOLVED" = /opt/bin/env-agent ]'
GSD_AGENT=my-legacy-agent gsd_provider_resolve "$R" "" ""
check "GSD_AGENT alone still selects a custom executable" \
  '[ "$GSD_PROVIDER_RESOLVED" = custom ] && [ "$GSD_AGENT_COMMAND_RESOLVED" = my-legacy-agent ]'

section "R05 — concurrent gsdt-wt-new runs for one phase reuse, not crash"
R="$WORK/r05"; repo "$R"; printf 'install = none\n' > "$R/.gsd.conf"; commit "$R"
(cd "$R" && gsdt-wt-new --phase 1) > "$WORK/a" 2>&1 & a=$!
(cd "$R" && gsdt-wt-new --phase 1) > "$WORK/b" 2>&1 & b=$!
wait $a; ra=$?; wait $b; rb=$?
check "both runs succeed" '[ "$ra" = 0 ] && [ "$rb" = 0 ]' || cat "$WORK/a" "$WORK/b"
check "exactly one phase-1 branch" '[ "$(git -C "$R" for-each-ref "refs/heads/phase-1-*" | wc -l | tr -d " ")" = 1 ]'
check "lock released afterwards" '[ ! -d "$R/.git/gsd-cmd.lock" ]'
# The lock alone, raced 20 times: with the mkdir command of uutils (Ubuntu
# 26.04) both callers got in about one time in three.
L="$WORK/r05l"; mkdir -p "$L/.git"; over=0
for i in $(seq 1 20); do
  : > "$L/log"
  pids=""
  for k in 1 2; do
    GSD_PKG="$PKG" bash -c '. "$GSD_PKG/lib/common.sh"; gsd_acquire_lock "$1" >/dev/null
      echo in >> "$1/log"; sleep 0.05; echo out >> "$1/log"' _ "$L" & pids="$pids $!"
  done
  # shellcheck disable=SC2086 # two PIDs, split on purpose
  wait $pids
  [ "$(sed -n 2p "$L/log")" = out ] || over=$((over + 1))
done
check "two racing lock holders never overlap (20 rounds)" '[ "$over" = 0 ]'

section "R06 — planning-repair --check: no roadmap is not damage"
R="$WORK/r06"; mkdir -p "$R/.planning"; git -C "$R" init -qb main
gsdt-planning-repair --check --repo "$R" > "$WORK/out" 2>&1; rc=$?
check "exit 0 when .planning/ROADMAP.md is missing" '[ "$rc" = 0 ]'

section "R07 — doctor JSON says whether the repo uses GSD"
R="$WORK/r07"; mkdir -p "$R"; git -C "$R" init -qb main
out=$(gsdt-doctor --repo "$R" --json 2>/dev/null || true)
check "plain repo → gsd_repo false" 'printf "%s" "$out" | grep -q "\"gsd_repo\":false"'
check "JSON stays one parseable object" 'printf "%s" "$out" | python3 -c "import json,sys; json.load(sys.stdin)"'
out=$(gsdt-doctor --repo "$WORK/r05" --json 2>/dev/null || true)
check "GSD repo → gsd_repo true" 'printf "%s" "$out" | grep -q "\"gsd_repo\":true"'

section "R09 — npm test detection reads scripts.test only"
R="$WORK/r09"; mkdir -p "$R"
printf '{\n  "dependencies": { "test": "^1.0.0" }\n}\n' > "$R/package.json"
check "a dependency named test is not a test script" '[ -z "$(gsd_test_cmd "$R")" ]'
printf '{\n  "scripts": { "build": "tsc", "test": "jest" }\n}\n' > "$R/package.json"
check "scripts.test → npm test" '[ "$(gsd_test_cmd "$R")" = "npm test" ]'

section "R12 — gsdt-start -p says when it ignores a description"
gsdt-start -p 1 "some text" --repo "$WORK/r05" --no-launch > "$WORK/out" 2>&1 || true
check "warning names the ignored text" 'grep -q "ignoring \"some text\"" "$WORK/out"'

section "R15 — two sessions claiming at once: the loser renumbers, nobody's claim is lost"
# Stand-in for gsd-core's gsd_run (not on CI runners): phase.add appends the next number.
mkdir -p "$WORK/stub"
cat > "$WORK/stub/gsd_run" <<'SDK'
#!/usr/bin/env bash
[ "$1" != runtime-identity ] || { echo '{"packageName":"@opengsd/gsd-core","version":"1.18.0"}'; exit 0; }
[ "$1 $2" = "query phase.add" ] || { echo "stub: unsupported $*" >&2; exit 1; }
desc=$3; dir=$5; rm="$dir/.planning/ROADMAP.md"
n=$(grep -oE '^### Phase [0-9]+' "$rm" | grep -oE '[0-9]+' | sort -n | tail -1)
printf '\n### Phase %s: %s\n' "$((n + 1))" "$desc" >> "$rm"
SDK
chmod +x "$WORK/stub/gsd_run"
export GSD_CLI="$WORK/stub/gsd_run"
git init -q --bare -b main "$WORK/r15.git"
R="$WORK/r15"; mkdir -p "$R/.planning"; git -C "$R" init -qb main
printf '# Roadmap\n\n### Phase 1: first\n' > "$R/.planning/ROADMAP.md"
printf -- '---\nstatus: planning\nprogress:\n  total_phases: 1\n  completed_phases: 0\n  total_plans: 0\n  completed_plans: 0\n  percent: 0\n---\n\n# Project State\n' > "$R/.planning/STATE.md"
printf '.planning/ROADMAP.md merge=gsd-planning\n.planning/STATE.md merge=gsd-planning\n' > "$R/.gitattributes"
printf 'install = none\n' > "$R/.gsd.conf"
commit "$R" init; git -C "$R" remote add origin "$WORK/r15.git"; git -C "$R" push -qu origin main
gsd_register_merge_driver "$R"
# The rival session claims phase 2 and pushes it the moment we try to push.
git clone -q "$WORK/r15.git" "$WORK/r15-rival"
printf '\n### Phase 2: user login\n' >> "$WORK/r15-rival/.planning/ROADMAP.md"
commit "$WORK/r15-rival" "docs(gsd): claim phase 2 — user login"
printf '#!/bin/sh\n[ -f "$RIVAL_DONE" ] && exit 0\ntouch "$RIVAL_DONE"\ngit -C "$RIVAL" push -q origin main\n' > "$R/.git/hooks/pre-push"
chmod +x "$R/.git/hooks/pre-push"
(cd "$R" && RIVAL="$WORK/r15-rival" RIVAL_DONE="$WORK/r15-done" PATH="$WORK/stub:$PATH" \
   gsdt-start -n "shopping cart" --no-launch) > "$WORK/out" 2>&1; rc=$?
ORIGIN_RM=$(git --git-dir="$WORK/r15.git" show main:.planning/ROADMAP.md)
check "claim succeeds" '[ "$rc" = 0 ]' || cat "$WORK/out"
check "the race was detected and renumbered" 'grep -q "renumbering" "$WORK/out"'
check "the rival's phase 2 survives on origin" 'printf "%s" "$ORIGIN_RM" | grep -q "^### Phase 2: user login"'
check "our claim landed as phase 3" 'printf "%s" "$ORIGIN_RM" | grep -q "^### Phase 3: shopping cart"'
check "exactly one phase 2 heading" '[ "$(printf "%s" "$ORIGIN_RM" | grep -c "^### Phase 2:")" = 1 ]'
check "worktree branch is phase-3" 'git -C "$R" show-ref --verify --quiet refs/heads/phase-3-shopping-cart'

section "R17 — the claim commit carries correct STATE.md counters"
check "origin STATE.md counts all 3 phases" \
  'git --git-dir="$WORK/r15.git" show main:.planning/STATE.md | grep -q "total_phases: 3"'
gsdt-planning-repair --repo "$R" > /dev/null 2>&1
check "a later repair (the post-merge hook) leaves main clean" '[ -z "$(git -C "$R" status --porcelain -- .planning)" ]' \
  || git -C "$R" diff -- .planning

section "R16 — a claimed phase gets its checklist + Progress rows"
RM="$WORK/r16.md"
cat > "$RM" <<'EOF'
# Roadmap

## Phases

- [x] **Phase 1: First** - done
- [ ] **Phase 2: Second** - next

## Phase Details

### Phase 1: First
### Phase 2: Second
### Phase 2.1: Hot fix | urgent (INSERTED)
- [ ] TBD (run /gsd-plan-phase 2.1 to break down)
### Phase 3: Third
- [ ] TBD (run /gsd-plan-phase 3 to break down)

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. First | v1 | 1/1 | Complete | 2026-09-01 |
| 2. Second | v1 | 0/2 | In progress | - |
EOF
perl "$PKG/lib/roadmap-rows.pl" "$RM" 3 && perl "$PKG/lib/roadmap-rows.pl" "$RM" 2.1
check "roadmap audit is clean afterwards (no T021/T022/T023)" '[ -z "$(perl "$PKG/lib/roadmap-audit.pl" "$RM")" ]' || perl "$PKG/lib/roadmap-audit.pl" "$RM"
check "checklist rows in numeric order" \
  '[ "$(grep -oE "^- \[.\] \*\*Phase [0-9.]+" "$RM" | grep -oE "[0-9.]+$" | tr "\n" " ")" = "1 2 2.1 3 " ]'
check "Progress rows in numeric order" \
  '[ "$(grep -oE "^\| [0-9.]+\." "$RM" | grep -oE "[0-9.]+" | tr "\n" " ")" = "1. 2. 2.1. 3. " ]'
check "Progress row matches the table's columns" \
  'grep -qxF "| 3. Third | - | 0/TBD | Not started | - |" "$RM"'
check "a | in the title does not break the table" 'grep -q "^| 2.1. Hot fix / urgent" "$RM"'
before=$(cat "$RM"); perl "$PKG/lib/roadmap-rows.pl" "$RM" 3
check "idempotent" '[ "$before" = "$(cat "$RM")" ]'
printf '# Roadmap\n### Phase 1: only\n' > "$RM"; perl "$PKG/lib/roadmap-rows.pl" "$RM" 1
check "a roadmap without checklist or table is left alone" '[ "$(cat "$RM")" = "$(printf "# Roadmap\n### Phase 1: only")" ]'
printf '# Roadmap\n- [ ] **Phase 2.1: Fix**\n### Phase 2: Two\n### Phase 2.1: Fix\n\n| Phase | Status |\n|---|---|\n| 2.1. Fix | Not started |\n' > "$RM"
perl "$PKG/lib/roadmap-rows.pl" "$RM" 2
check "a 2.1 row does not stand in for phase 2 (Progress)" 'grep -qxF "| 2. Two | Not started |" "$RM"'
check "…nor in the checklist" 'grep -qxF -- "- [ ] **Phase 2: Two**" "$RM"'
printf '# Roadmap\n- [ ] **Phase 2: Two**\n### Phase 02: Two\n\n| Phase | Status |\n|---|---|\n| 2. Two | Not started |\n' > "$RM"
before=$(cat "$RM"); perl "$PKG/lib/roadmap-rows.pl" "$RM" 02
check "a padded 02 matches the rows of phase 2" '[ "$before" = "$(cat "$RM")" ]'

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
