#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2012  # vars are read inside check()'s eval strings; ls globs toolkit-made phase dirs
# test-e2e.sh — the whole journey, end to end, in a throwaway fake project.
#
# Runs the REAL commands from this checkout (bin/ first on PATH) and the REAL
# gsd-core (gsd_run), against a local bare repo standing in for GitHub. The AI's work is
# simulated with plain files and commits, so it costs nothing. It covers what
# unit suites cannot: pieces working together —
#   gsdt-init for claude+codex · two clones claiming at the same moment ·
#   gsdt-list · a hotfix --insert · the guard · the flow order with a
#   Claude → Codex handoff · both clones finishing at once · doctor + repair.
# It found the claim-race phase loss (R15), missing roadmap rows (R16), the
# pull-then-claim block (R17) and the padded-decimal guard block (R18).
#
# Run it after any change to start / finish / guard / flow / planning code:
#   tests/test-e2e.sh            (≈1 min; needs gsd-core — skipped without it)
set -uo pipefail
PKG=$(cd "$(dirname "$0")/.." && pwd)
# GSD_TEST_REQUIRE_GSD=1 (CI) turns the skip into a failure.
# shellcheck source=../lib/common.sh disable=SC1091
if ! (GSD_PKG="$PKG"; . "$PKG/lib/common.sh"; gsd_cli >/dev/null); then
  echo "SKIPPED: gsd-core not installed (npm i -g @opengsd/gsd-core) — this suite drives the real claim path"
  [ "${GSD_TEST_REQUIRE_GSD:-}" != 1 ] || exit 1
  exit 0
fi
S=$(mktemp -d); trap 'rm -rf "$S"' EXIT; cd "$S" || exit 1
export PATH="$PKG/bin:$PATH"
# the agent CLIs: doctor wants them installed; this suite never opens a session
mkdir -p "$S/agents"; for a in claude codex; do printf '#!/bin/sh\nexit 0\n' > "$S/agents/$a"; chmod +x "$S/agents/$a"; done
export PATH="$PATH:$S/agents"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@t GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@t
# the laptop's installed skills are not what this checkout is testing
export GSD_CLAUDE_SKILL_DIR="$S/skills" GSD_CODEX_SKILL_DIR="$S/skills-codex"
# …and its Claude settings hold what an install writes: the gsdt-rules session hook
export GSD_CLAUDE_SETTINGS="$S/claude-settings.json"
printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"exec %s/bin/gsdt-rules --hook"}]}]}}\n' "$PKG" > "$GSD_CLAUDE_SETTINGS"
unset GSD_PROVIDER GSD_AGENT GSD_AGENT_COMMAND GSD_LOCK_HELD GSD_SKIP_GUARD
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '%s\n' "$2" | sed 's/^/      /'; }
check() { if eval "$2"; then ok "$1"; else bad "$1" "${3:-}"; fi; }
step() { printf '\n== %s\n' "$1"; }
art() { git -C "$1" add -A; git -C "$1" commit -qm "$2"; }   # simulate an AI step's commit

step "1. project + gsdt-init (claude, codex)"
git init -q --bare -b main origin.git
mkdir shop; git -C shop init -qb main
printf '# Fake Shop\n' > shop/README.md; printf 'test:\n\t@test -f README.md\n' > shop/Makefile
art shop "initial code"; git -C shop remote add origin "$S/origin.git"; git -C shop push -qu origin main
(cd shop && gsdt-init --providers claude,codex --provider claude --no-launch) > init.log 2>&1
check "gsdt-init succeeds" '[ $? = 0 ]'
check "2 instruction entrypoints" '[ -f shop/CLAUDE.md ] && [ -f shop/AGENTS.md ] && [ ! -e shop/GEMINI.md ]'
check "main checkout: worktree.baseRef = head" 'grep -q "\"baseRef\": \"head\"" shop/.claude/settings.local.json'
check "claude hook, codex none" 'grep -q gsdt-worktree-guard shop/.claude/settings.json && grep -q "codex native guard hook: unsupported" init.log'
printf 'flow = strict\ntest = test -f README.md && test -f Makefile\n' >> shop/.gsd.conf

step "2. simulated /gsd-new-project"
mkdir -p shop/.planning/phases
printf '# Fake Shop\n\n## Core Value\nCustomers can buy things.\n' > shop/.planning/PROJECT.md
cat > shop/.planning/ROADMAP.md <<'EOF'
# Roadmap: Fake Shop

## Phases

- [ ] **Phase 1: Product catalog** - List products

## Phase Details

### Phase 1: Product catalog
**Goal**: Customers can browse products
**Depends on**: Nothing (first phase)
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Product catalog | 0/0 | Not started | - |
EOF
cat > shop/.planning/STATE.md <<'EOF'
---
gsd_state_version: 1.0
milestone: v1.0
status: planning
stopped_at: Project initialized
progress:
  total_phases: 1
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Current Position

Phase: 1 of 1 (Product catalog)
Status: Ready to plan

## Session Continuity

Last session: 2026-09-25
Stopped at: Project initialized
Resume file: None
EOF
art shop "docs: initialize project"; git -C shop push -q
(cd shop && gsdt-doctor --quiet) > doctor0.log 2>&1; d0=$?
check "doctor clean after init" '[ "$d0" = 0 ]' "$(cat doctor0.log)"

step "3. two sessions claim at the same moment (second clone = second laptop)"
git clone -q origin.git laptop2
# a fresh clone has no merge driver (git config is not versioned) — as on a new laptop
git -C laptop2 config merge.gsd-planning.driver "gsdt-planning-merge %O %A %B %P"
(cd shop && gsdt-start -n "shopping cart" --no-launch > "$S/start-a.log" 2>&1; echo $? > "$S/rc-a") &
(cd laptop2 && gsdt-start -n "user login" --provider codex --no-launch > "$S/start-b.log" 2>&1; echo $? > "$S/rc-b") &
wait
check "both claims succeed" '[ "$(cat rc-a)" = 0 ] && [ "$(cat rc-b)" = 0 ]' "$(tail -5 start-a.log start-b.log)"
ROAD=$(git --git-dir=origin.git show main:.planning/ROADMAP.md)
check "origin has phases 2 AND 3, one each" \
  '[ "$(printf "%s" "$ROAD" | grep -c "^### Phase 2:")" = 1 ] && [ "$(printf "%s" "$ROAD" | grep -c "^### Phase 3:")" = 1 ]' "$ROAD"
check "both titles survive" 'printf "%s" "$ROAD" | grep -q "shopping cart" && printf "%s" "$ROAD" | grep -q "user login"'
CART_N=$(printf '%s' "$ROAD" | sed -nE 's/^### Phase ([0-9]+): shopping cart.*/\1/p')
LOGIN_N=$(printf '%s' "$ROAD" | sed -nE 's/^### Phase ([0-9]+): user login.*/\1/p')
echo "  (cart = phase $CART_N, login = phase $LOGIN_N)"
git -C shop pull -q --ff-only
WT_CART=$(git -C shop worktree list --porcelain | awk -v b="refs/heads/phase-$CART_N-shopping-cart" '/^worktree /{w=substr($0,10)} $2==b{print w}')
[ -n "$WT_CART" ] || WT_CART=$(ls -d "$S"/shop-worktrees/phase-"$CART_N"-* 2>/dev/null | head -1)
check "cart worktree exists" '[ -d "$WT_CART" ]'
check "codex launch line printed for login" 'grep -q "&& codex " start-b.log'
# gsd-core's own check, as /gsd-execute-phase runs it: a phase branch is ahead
# of origin/HEAD, so without worktree.baseRef = "head" every wave runs one plan
# at a time. An empty CLAUDE_CONFIG_DIR: this machine's settings do not count.
GSD_RUN=$(GSD_PKG="$PKG"; . "$PKG/lib/common.sh"; gsd_cli)
(cd "$WT_CART" && CLAUDE_CONFIG_DIR="$S/no-claude" "$GSD_RUN" query worktree.base-check --mode harness-worktree) > basecheck.log 2>&1
check "fresh worktree: gsd-core base-check does not degrade" 'grep -q "\"shouldDegrade\": false" basecheck.log' "$(cat basecheck.log)"

step "4. gsdt-list"
(cd shop && COLUMNS=100 gsdt-list) > list.log 2>&1
check "list shows all 3 phases" 'grep -q "Product catalog" list.log && grep -q "shopping cart" list.log && grep -q "user login" list.log' "$(cat list.log)"
check "cart worktree marked attached" 'grep "shopping cart" list.log | grep -q "●"'

step "4b. hotfix phase (--insert) and roadmap rows"
(cd shop && gsdt-start --insert "$CART_N" "urgent price bug" --no-launch) > insert.log 2>&1; ri=$?
check "hotfix claim succeeds (padded decimal phase)" '[ "$ri" = 0 ]' "$(tail -3 insert.log)"
git -C shop push -q 2>/dev/null
AUD=$(perl "$PKG/lib/roadmap-audit.pl" shop/.planning/ROADMAP.md)
check "every claimed phase has its checklist + Progress rows" '[ -z "$AUD" ]' "$AUD"

step "5. the guard"
G() { gsdt-worktree-guard --command "$1" --phase "$2" --repo "$3" > guard.log 2>&1; echo $?; }
check "feature work on main is blocked"              '[ "$(G gsd-discuss-phase "$CART_N" "$S/shop")" = 2 ]'
check "wrong phase in cart worktree is blocked"      '[ "$(G gsd-discuss-phase "$LOGIN_N" "$WT_CART")" = 2 ]'
check "discuss in its own worktree is allowed"       '[ "$(G gsd-discuss-phase "$CART_N" "$WT_CART")" = 0 ]'
check "strict: plan before discuss is blocked"       '[ "$(G gsd-plan-phase "$CART_N" "$WT_CART")" = 2 ]'
check "/gsd-phase off main is blocked"               '[ "$(gsdt-worktree-guard --command gsd-phase --repo "$WT_CART" >/dev/null 2>&1; echo $?)" = 2 ]'
P=$(printf '%02d' "$CART_N")
check "zero-padded phase ($P) works"                 '[ "$(G gsd-discuss-phase "$P" "$WT_CART")" = 0 ]'

step "6. flow, with a Claude → Codex handoff on the cart phase"
PD=$(ls -d "$WT_CART"/.planning/phases/"$P"-* 2>/dev/null | head -1)
[ -n "$PD" ] || { PD="$WT_CART/.planning/phases/$P-shopping-cart"; mkdir -p "$PD"; }
NEXT() { gsdt-flow-next "$CART_N" --repo "$WT_CART" --no-ui 2>&1 | sed -n 's/^step=//p'; }
check "no tracker → first step is discuss" '[ "$(NEXT)" = discuss ]'
printf '# context (by claude)\n' > "$PD/$P-CONTEXT.md"; art "$WT_CART" "discuss (claude)"
(cd shop && gsdt-start -p "$CART_N" --provider codex --no-launch) > handoff.log 2>&1
check "handoff to codex reuses the same worktree" 'grep -q "$WT_CART" handoff.log && grep -q "&& codex " handoff.log' "$(tail -4 handoff.log)"
check "after discuss → plan"  '[ "$(NEXT)" = plan ]'
: > "$PD/$P-01-PLAN.md"; art "$WT_CART" "plan (codex)"
check "then cross-AI review"  '[ "$(NEXT)" = review ]'
check "strict: execute before review is blocked" '[ "$(G gsd-execute-phase "$CART_N" "$WT_CART")" = 2 ]'
sleep 1; : > "$PD/$P-REVIEWS.md"; art "$WT_CART" "review"
check "review not folded in → replan" '[ "$(NEXT)" = replan ]'
sleep 1; echo "revised" >> "$PD/$P-01-PLAN.md"; art "$WT_CART" "replan"
check "then execute"          '[ "$(NEXT)" = execute ]'
check "strict: execute allowed now" '[ "$(G gsd-execute-phase "$CART_N" "$WT_CART")" = 0 ]'
printf 'cart\n' > "$WT_CART/cart.txt"; : > "$PD/$P-01-SUMMARY.md"; art "$WT_CART" "execute"
check "then verifier"         '[ "$(NEXT)" = verifier ]'

step "7. finish both phases (login has a change too)"
# login was claimed on laptop2, so laptop2 does its work and finishes it
WT_LOGIN=$(git -C laptop2 worktree list --porcelain | awk '/^worktree /{w=substr($0,10)} /^branch refs\/heads\/phase-/{print w}' | head -1)
printf 'login\n' > "$WT_LOGIN/login.txt"; art "$WT_LOGIN" "login work"
(cd shop && gsdt-finish "$CART_N") > finish-0.log 2>&1; r0=$?
check "strict: finish without the test audit is refused" '[ "$r0" != 0 ] && grep -q "gsd-validate-phase $CART_N" finish-0.log' "$(tail -4 finish-0.log)"
check "…and the cart worktree is kept" '[ -d "$WT_CART" ]'
audit() {  # $1=worktree $2=phase → a compliant <P>-VALIDATION.md (what /gsd-validate-phase leaves)
  local p d; p=$(printf '%02d' "$2"); d=$(ls -d "$1"/.planning/phases/"$p"-* 2>/dev/null | head -1)
  [ -n "$d" ] || { d="$1/.planning/phases/$p-work"; mkdir -p "$d"; }
  printf -- '---\nnyquist_compliant: true\n---\n' > "$d/$p-VALIDATION.md"; art "$1" "validate"
}
audit "$WT_CART" "$CART_N"; audit "$WT_LOGIN" "$LOGIN_N"
(cd shop && gsdt-finish "$CART_N") > finish-a.log 2>&1 & pa=$!
(cd laptop2 && gsdt-finish "$LOGIN_N") > finish-b.log 2>&1 & pb=$!
wait $pa; ra=$?; wait $pb; rb=$?
check "cart finish succeeds"  '[ "$ra" = 0 ]' "$(tail -8 finish-a.log)"
check "login finish succeeds" '[ "$rb" = 0 ]' "$(tail -8 finish-b.log)"
check "both changes on origin" 'git --git-dir=origin.git cat-file -e main:cart.txt && git --git-dir=origin.git cat-file -e main:login.txt'
check "worktrees removed" '[ ! -d "$WT_CART" ] && [ ! -d "$WT_LOGIN" ]'
git -C shop pull -q --ff-only 2>/dev/null
(cd shop && gsdt-planning-repair --check) > repair.log 2>&1; rr=$?
check "planning files coherent" '[ "$rr" = 0 ]' "$(cat repair.log)"
(cd shop && gsdt-doctor --quiet) > doctor1.log 2>&1; d1=$?
check "doctor after finishing" '[ "$d1" = 0 ]' "$(grep -E '✖|T0' doctor1.log)"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
