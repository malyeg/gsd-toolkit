#!/usr/bin/env bash
# test-list.sh — gsdt-list derives PLANS/STAGE/WORKTREE from the phase files
# and lays the table out without losing text. Read-only command, fixture repo.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; PKG="$(cd "$HERE/.." && pwd)"
LIST="$PKG/bin/gsdt-list"
PASS=0; FAIL=0; WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
ok()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
section() { printf '\n%s\n' "$1"; }

R="$WORK/repo"; P="$R/.planning/phases"; mkdir -p "$P"
git -C "$R" init -qb main
cat > "$R/.planning/ROADMAP.md" <<'EOF'
# Roadmap
### Phase 1: nothing yet
### Phase 2: spec only
### Phase 3: discussed
### Phase 4: has screens
### Phase 5: half executed
### Phase 6: finished work
### Phase 7: in flight in its worktree with a very long description that must wrap across several lines
### Phase 10: two digit
### Phase 10.1: decimal hotfix
EOF
mkdir -p "$P/02-s" "$P/03-d" "$P/04-u" "$P/05-h" "$P/06-f" "$P/10-t" "$P/10.1-h"
touch "$P/02-s/02-SPEC.md" "$P/03-d/03-CONTEXT.md" "$P/04-u/04-UI-SPEC.md" \
      "$P/05-h/05-01-PLAN.md" "$P/05-h/05-02-PLAN.md" "$P/05-h/05-01-SUMMARY.md" \
      "$P/06-f/06-01-PLAN.md" "$P/06-f/06-01-SUMMARY.md" \
      "$P/10-t/10-CONTEXT.md" "$P/10.1-h/10.1-01-PLAN.md"
git -C "$R" add -A; git -C "$R" commit -qm roadmap
# Phase 7's plan exists only on its branch (in its worktree), not in main.
git -C "$R" worktree add -qb phase-7-wt "$WORK/wt7"
mkdir -p "$WORK/wt7/.planning/phases/07-w"; touch "$WORK/wt7/.planning/phases/07-w/07-01-PLAN.md"
git -C "$R" branch phase-6-f-pr            # a PR branch is not the phase branch

OUT="$WORK/out"
COLUMNS=70 "$LIST" --repo "$R" --compact > "$OUT" 2>&1 || bad "gsdt-list --compact exits 0" "$(cat "$OUT")"
cell() {  # $1=phase N  $2=column index (1=N 2=PHASE 3=PLANS 4=STAGE 5=WORKTREE)
  awk -F'│' -v n="$1" -v c="$(( $2 + 1 ))" \
    '{ k=$2; gsub(/^ +| +$/, "", k) } k==n { v=$c; gsub(/^ +| +$/, "", v); print v; exit }' "$OUT"
}

section "PLANS and STAGE come from the phase's artifact files"
is "no dir → no plans"               "$(cell 1 3)" "—"
is "no dir → no stage"               "$(cell 1 4)" "—"
is "SPEC.md → spec"                  "$(cell 2 4)" "spec"
is "CONTEXT.md → discuss"            "$(cell 3 4)" "discuss"
is "UI-SPEC.md → ui (not spec)"      "$(cell 4 4)" "ui"
is "1 of 2 summaries → 1/2"          "$(cell 5 3)" "1/2"
is "1 of 2 summaries → execute"      "$(cell 5 4)" "execute"
is "all summaries → ✔"               "$(cell 6 3)" "✔"
is "all summaries → done"            "$(cell 6 4)" "done"
is "10 is not confused with 1"       "$(cell 10 4)" "discuss"
is "decimal phase 10.1 → its own dir" "$(cell 10.1 3)" "0/1"

section "WORKTREE and in-flight state"
is "attached worktree is marked ●"   "$(cell 7 5)" "phase-7-wt ●"
is "worktree artifacts win over main" "$(cell 7 4)" "plan"
is "a *-pr branch is not the phase branch" "$(cell 6 5)" "—"

section "layout"
is "--compact: one line per phase"   "$(grep -c '^│' "$OUT")" "10"
COLUMNS=70 "$LIST" --repo "$R" > "$OUT" 2>&1
# Phase 7's PHASE cell: its row plus the continuation rows below it, joined.
title7=$(awk -F'│' '{ k=$2; gsub(/^ +| +$/, "", k) }
  k=="7" { on=1 } on && k!="" && k!="7" { exit }
  on && /^│/ { v=$3; gsub(/^ +| +$/, "", v); printf "%s ", v }' "$OUT" | sed 's/ $//')
is "default wraps long titles without truncating" "$title7" \
  "in flight in its worktree with a very long description that must wrap across several lines"
if [ "$(grep -c '^│' "$OUT")" -gt 10 ]; then ok "wrapped title spans several lines"
else bad "wrapped title spans several lines"; fi
unset COLUMNS; "$LIST" --repo "$R" < /dev/null > "$OUT" 2>&1
if [ -s "$OUT" ]; then ok "renders without a terminal or COLUMNS"; else bad "renders without a terminal or COLUMNS"; fi
if "$LIST" --repo "$WORK" > "$OUT" 2>&1; then bad "a repo without ROADMAP.md is refused"
else ok "a repo without ROADMAP.md is refused"; fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
