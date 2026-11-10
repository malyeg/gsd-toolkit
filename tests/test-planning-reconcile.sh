#!/usr/bin/env bash
#
# test-planning-reconcile.sh — regression tests for the .planning merge fix.
#
# Fixtures are the two real corruptions from medyour-platform, checked in under
# tests/fixtures/ so the tests run anywhere:
#
#   phase-11-merge/   the raw `git merge` result that produced today's damage
#                     (ROADMAP: phases 10 + 11 listed twice with contradictory
#                     marks; STATE: two frontmatter blocks, duplicate focus /
#                     position / velocity lines). Ground truth for its counters
#                     is 30 phases / 13 complete / 111 plans / 111 summaries /
#                     43% — neither frontmatter block had it.
#   2026-08-02/       the earlier corruption, which also carries a table row
#                     that /gsd-fast appended past EOF.
#
# Run:  tests/test-planning-reconcile.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
FIX="$HERE/fixtures"
ENGINE="$PKG/lib/gsd_planning.py"
# The engine the commands now run is src/planning.ts, through the launcher.
# lib/gsd_planning.py stays as the parity oracle (tests/ts/p2-planning.test.ts)
# and is what the "python interpreter fallback" section below still exercises.
engine() { node "$PKG/src/launch.mjs" planning "$@"; }

PASS=0
FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Doctor reports a missing gsd-core (T005). CI may have none, and these checks
# are about the repo under inspection, so give them a stand-in.
mkdir -p "$WORK/stub-bin"
printf '#!/bin/sh\necho '"'"'{"packageName":"@opengsd/gsd-core","version":"1.0.0"}'"'"'\n' > "$WORK/stub-bin/gsd_run"
chmod +x "$WORK/stub-bin/gsd_run"
export GSD_CLI="$WORK/stub-bin/gsd_run"
# …and reads the user's agent settings for broken GSD hooks (T008): point it
# at files that don't exist, so the machine running the tests can't fail them.
export GSD_CLAUDE_SETTINGS="$WORK/none" GSD_CODEX_HOOKS="$WORK/none"

ok()   { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }

# Build a .planning tree from a fixture: the two markdown files plus empty
# PLAN/SUMMARY files, which is all compute_truth() counts.
stage() {  # $1=fixture name  $2=dest dir
  local src="$FIX/$1" dest="$2"
  mkdir -p "$dest/.planning/phases"
  cp "$src/ROADMAP.md" "$src/STATE.md" "$dest/.planning/"
  local n=0 phase
  while read -r phase; do
    [ -n "$phase" ] || continue
    mkdir -p "$dest/.planning/phases/$phase"
  done < <(cut -d/ -f1 "$src/plans.txt" | sort -u)
  while read -r rel; do
    [ -n "$rel" ] || continue
    : > "$dest/.planning/phases/$rel"
    n=$((n + 1))
  done < "$src/plans.txt"
}

section() { printf '\n%s\n' "$1"; }

# ── 1. the phase-11 merge: counters must be RECOMPUTED, not picked ───────────
section "phase-11 merge — counters recomputed from ground truth"
stage phase-11-merge "$WORK/a"
engine repair "$WORK/a/.planning" > "$WORK/a.log" 2>&1
FM="$(sed -n '/^---$/,/^---$/p' "$WORK/a/.planning/STATE.md")"
is "total_phases is 30"     "$(grep -c 'total_phases: 30' <<<"$FM")"     1
is "completed_phases is 13" "$(grep -c 'completed_phases: 13' <<<"$FM")" 1
is "total_plans is 111"     "$(grep -c 'total_plans: 111' <<<"$FM")"     1
is "completed_plans is 111" "$(grep -c 'completed_plans: 111' <<<"$FM")" 1
is "percent is 43"          "$(grep -c 'percent: 43' <<<"$FM")"          1
is "exactly one frontmatter block" "$(grep -c '^---$' "$WORK/a/.planning/STATE.md")" 2
for key in status stopped_at last_updated last_activity; do
  is "one '$key:' in frontmatter" "$(grep -c "^$key:" <<<"$FM")" 1
done

section "phase-11 merge — single-value lines take the incoming branch's value"
# Verified against the real merge parents: develop said 'planning' / Phase 11,
# the phase-11 branch said 'ready_to_plan' / Phase 12, and the hand repair kept
# the branch's. union writes ours-then-theirs, so last-occurrence == theirs.
is "status is the branch's"  "$(grep -c '^status: ready_to_plan' <<<"$FM")" 1
is "focus is Phase 12"       "$(grep -c '^\*\*Current focus:\*\* Phase 12' "$WORK/a/.planning/STATE.md")" 1
is "Current Position Phase 12" \
   "$(awk '/^## Current Position/,/^## [^C]/' "$WORK/a/.planning/STATE.md" | grep -c '^Phase: 12')" 1

section "phase-11 merge — checklist and tables keep first position, best content"
is "one Phase 10 checklist entry" "$(grep -c '^- \[.\] \*\*Phase 10:' "$WORK/a/.planning/ROADMAP.md")" 1
is "one Phase 11 checklist entry" "$(grep -c '^- \[.\] \*\*Phase 11:' "$WORK/a/.planning/ROADMAP.md")" 1
is "Phase 11 survives as [x]"     "$(grep -c '^- \[x\] \*\*Phase 11:' "$WORK/a/.planning/ROADMAP.md")" 1
is "Phase 11 keeps '(completed 2026-08-05)'" \
   "$(grep -c '^- \[x\] \*\*Phase 11:.*(completed 2026-08-05)$' "$WORK/a/.planning/ROADMAP.md")" 1
# Trap 3: the stale '- [ ] Phase 11' sat ABOVE the correct '- [x] Phase 11', so
# keeping the later line would have pushed phase 11 below phase 10's duplicate.
is "phases stay in numeric order" \
   "$(grep -o '^- \[.\] \*\*Phase [0-9.]*' "$WORK/a/.planning/ROADMAP.md" | sed 's/.*Phase //' | sort -c -V 2>&1 && echo sorted)" \
   "sorted"
is "one Phase 11 progress row" "$(grep -c '^| 11\. ' "$WORK/a/.planning/ROADMAP.md")" 1
is "Phase 11 row says Complete" "$(grep -c '^| 11\..*| 15/15 | Complete' "$WORK/a/.planning/ROADMAP.md")" 1

# ── 2. trap 1: history must survive ──────────────────────────────────────────
section "history is never damaged (trap 1)"
for fixture in phase-11-merge 2026-08-02; do
  stage "$fixture" "$WORK/h-$fixture"
  before="$(awk '/^## Session Continuity/,0' "$FIX/$fixture/STATE.md")"
  engine repair "$WORK/h-$fixture/.planning" >/dev/null 2>&1
  after="$(awk '/^## Session Continuity/,0' "$WORK/h-$fixture/.planning/STATE.md")"
  if [ "$before" = "$after" ]; then
    ok "$fixture: ## Session Continuity is byte-identical"
  else
    bad "$fixture: ## Session Continuity changed" "$(diff <(echo "$before") <(echo "$after") | head -5)"
  fi
  is "$fixture: every 'Resume file:' entry kept" \
     "$(grep -c '^Resume file:' <<<"$after")" "$(grep -c '^Resume file:' <<<"$before")"
done

# ── 3. idempotence + the check gate ──────────────────────────────────────────
section "idempotence and --check"
stage phase-11-merge "$WORK/i"
engine repair --check "$WORK/i/.planning" >/dev/null 2>&1
is "--check on a corrupt tree exits 1" "$?" 1
engine repair "$WORK/i/.planning" >/dev/null 2>&1
cp "$WORK/i/.planning/ROADMAP.md" "$WORK/i-road" && cp "$WORK/i/.planning/STATE.md" "$WORK/i-state"
engine repair "$WORK/i/.planning" >/dev/null 2>&1
if diff -q "$WORK/i-road" "$WORK/i/.planning/ROADMAP.md" >/dev/null \
   && diff -q "$WORK/i-state" "$WORK/i/.planning/STATE.md" >/dev/null; then
  ok "a second repair changes nothing"
else
  bad "a second repair changed the files"
fi
engine repair --check "$WORK/i/.planning" >/dev/null 2>&1
is "--check on a repaired tree exits 0" "$?" 0

# ── 4. the 2026-08-02 corruption, including the row past EOF ─────────────────
section "2026-08-02 corruption"
stage 2026-08-02 "$WORK/b"
out="$(engine repair --check "$WORK/b/.planning" 2>&1)"
for n in 5 6 7 8; do
  is "Phase $n duplicate checklist entry found" \
     "$(grep -c "duplicate checklist entry for Phase $n\$" <<<"$out")" 1
done
is "the row /gsd-fast left past EOF is reported" \
   "$(grep -c 'table row outside any table' <<<"$out")" 1
engine repair "$WORK/b/.planning" >/dev/null 2>&1
is "the stray row is preserved, not silently re-homed" \
   "$(grep -c 'gitignore apps/mobile/design/verification' "$WORK/b/.planning/STATE.md")" 1
for n in 5 6 7 8; do
  is "one Phase $n checklist entry after repair" \
     "$(grep -c "^- \[.\] \*\*Phase $n:" "$WORK/b/.planning/ROADMAP.md")" 1
done

# ── 5. end-to-end: a real git merge through the driver ───────────────────────
# Reproduces the exact shape of the real corruption: two sessions each flip a
# DIFFERENT phase's line, and the lines are adjacent, so the two edits land in
# one overlapping hunk. That is what makes union keep all four lines.
section "end-to-end: git merge through the gsd-planning driver"
E2E="$WORK/e2e"
mkdir -p "$E2E/.planning/phases/01-a" "$E2E/.planning/phases/02-b"
git init -q "$E2E"
git -C "$E2E" config user.email t@example.com
git -C "$E2E" config user.name test
git -C "$E2E" config merge.gsd-planning.driver "$PKG/bin/gsdt-planning-merge %O %A %B %P"
: > "$E2E/.planning/phases/01-a/01-01-PLAN.md"
: > "$E2E/.planning/phases/01-a/01-01-SUMMARY.md"
: > "$E2E/.planning/phases/02-b/02-01-PLAN.md"
printf '.planning/ROADMAP.md merge=gsd-planning\n.planning/STATE.md merge=gsd-planning\n' \
  > "$E2E/.gitattributes"

roadmap() {  # $1/$2 = phase 1/2 checklist line tail, $3/$4 = their progress cells
  cat > "$E2E/.planning/ROADMAP.md" <<EOF
# Roadmap

## Phases

- [$1] **Phase 1: Alpha** - first phase$2
- [$3] **Phase 2: Beta** - second phase$4

## Phase Details

### Phase 1: Alpha

Goal: alpha.

### Phase 2: Beta

Goal: beta.

## Progress

| Phase | Plans | Status | Completed |
|-------|-------|--------|-----------|
| 1. Alpha | $5 |
| 2. Beta | $6 |
EOF
}

state() {  # $1=status  $2=focus phase  $3=completed_phases  $4=timestamp
  cat > "$E2E/.planning/STATE.md" <<EOF
---
milestone: v1.0
status: $1
stopped_at: Phase $2 pending
last_updated: "$4"
progress:
  total_phases: 9
  completed_phases: $3
  total_plans: 9
  completed_plans: 9
  percent: 11
---

# Project State

**Current focus:** Phase $2

## Current Position

Phase: $2
Status: $1

Progress: [░░░░░░░░░░] 0%

## Session Continuity

Last session: 2026-01-01T00:00:00.000Z
Stopped at: one
Resume file: a.md
Last session: 2026-01-02T00:00:00.000Z
Stopped at: two
Resume file: b.md
EOF
}

roadmap ' ' '' ' ' '' '0/TBD | Not started | - ' '0/TBD | Not started | - '
state planning 1 0 '2026-01-01T00:00:00.000Z'
git -C "$E2E" add -A
git -C "$E2E" commit -qm base
BASE_BRANCH="$(git -C "$E2E" branch --show-current)"

# The phase-1 session finishes phase 1.
git -C "$E2E" checkout -qb phase-1
roadmap 'x' ' (completed 2026-03-01)' ' ' '' '1/1 | Complete | 2026-03-01 ' '0/TBD | Not started | - '
state ready_to_plan 2 1 '2026-03-01T00:00:00.000Z'
git -C "$E2E" commit -qam "phase 1 done"

# In parallel, another session finishes phase 2 on the base branch.
git -C "$E2E" checkout -q "$BASE_BRANCH"
roadmap ' ' '' 'x' ' (completed 2026-03-02)' '0/TBD | Not started | - ' '2/2 | Complete | 2026-03-02 '
state executing 2 1 '2026-03-02T00:00:00.000Z'
git -C "$E2E" commit -qam "phase 2 done in a parallel session"
git -C "$E2E" tag diverged

if git -C "$E2E" merge -q --no-ff phase-1 -m "Merge phase-1" >/dev/null 2>&1; then
  ok "the merge completes without conflicts"
else
  bad "the merge conflicted"
fi

R="$E2E/.planning/ROADMAP.md"
S="$E2E/.planning/STATE.md"
is "driver left one Phase 1 checklist entry" "$(grep -c '^- \[.\] \*\*Phase 1:' "$R")" 1
is "driver left one Phase 2 checklist entry" "$(grep -c '^- \[.\] \*\*Phase 2:' "$R")" 1
is "both phases survive as [x]"              "$(grep -c '^- \[x\] \*\*Phase' "$R")" 2
is "each side's completion date survives"    "$(grep -c '(completed 2026-03-0[12])$' "$R")" 2
is "driver left one Phase 1 progress row"    "$(grep -c '^| 1\. Alpha' "$R")" 1
is "driver left one Phase 2 progress row"    "$(grep -c '^| 2\. Beta' "$R")" 1
is "driver left one '### Phase 1' section"   "$(grep -c '^### Phase 1:' "$R")" 1
is "driver left one frontmatter block"       "$(grep -c '^---$' "$S")" 2
is "driver left one 'status:'"               "$(grep -c '^status:' "$S")" 1
is "driver left one 'stopped_at:'"           "$(grep -c '^stopped_at:' "$S")" 1
is "driver left one '**Current focus:**'"    "$(grep -c '^\*\*Current focus:\*\*' "$S")" 1
is "driver left one 'Phase:' in position"    "$(awk '/^## Current Position/,/^## S/' "$S" | grep -c '^Phase:')" 1
is "driver kept both history entries"        "$(grep -c '^Resume file:' "$S")" 2

engine repair "$E2E/.planning" >/dev/null 2>&1
is "repair recomputes total_phases from the roadmap"  "$(grep -c '  total_phases: 2' "$S")" 1
is "repair recomputes completed_phases"               "$(grep -c '  completed_phases: 2' "$S")" 1
is "repair recomputes total_plans from disk"          "$(grep -c '  total_plans: 2' "$S")" 1
is "repair recomputes completed_plans from disk"      "$(grep -c '  completed_plans: 1' "$S")" 1
is "repair recomputes percent"                        "$(grep -c '  percent: 100' "$S")" 1
engine repair --check "$E2E/.planning" >/dev/null 2>&1
is "the merged tree passes --check" "$?" 0

# ── 6. the same merge WITHOUT the driver — repair still fixes it ─────────────
# The driver lives in git config, which is not versioned, so a clone that never
# ran gsdt-bootstrap-repo still gets plain union. gsdt-finish's post-merge repair
# has to be able to clean that up on its own.
section "no driver registered — plain union, repaired afterwards"
git -C "$E2E" config merge.gsd-planning.driver 'git merge-file -q --union %A %O %B'
git -C "$E2E" reset -q --hard diverged
git -C "$E2E" merge -q --no-ff phase-1 -m "Merge phase-1 (plain union)" >/dev/null 2>&1
is "plain union DOES duplicate the checklist entry" "$(grep -c '^- \[.\] \*\*Phase 1:' "$R")" 2
is "plain union DOES duplicate the frontmatter"     "$(grep -c '^status:' "$S")" 2
engine repair "$E2E/.planning" >/dev/null 2>&1
is "repair alone fixes the checklist"    "$(grep -c '^- \[.\] \*\*Phase 1:' "$R")" 1
is "repair alone keeps both [x] marks"   "$(grep -c '^- \[x\] \*\*Phase' "$R")" 2
is "repair alone collapses frontmatter"  "$(grep -c '^status:' "$S")" 1
is "repair alone keeps history intact"   "$(grep -c '^Resume file:' "$S")" 2
engine repair --check "$E2E/.planning" >/dev/null 2>&1
is "the repaired tree passes --check" "$?" 0

# ── 7. the real gsdt-finish path ──────────────────────────────────────────────
# The guarantee the whole change exists for: a normal finish must never leave
# .planning self-contradictory on the base branch.
section "gsdt-finish leaves the base branch coherent"
WT="$WORK/wt"
mkdir -p "$WT/repo/.planning/phases/01-a"
git init -q -b develop "$WT/repo"
git -C "$WT/repo" config user.email t@example.com
git -C "$WT/repo" config user.name test
E2E="$WT/repo"   # roadmap()/state() write into $E2E
: > "$WT/repo/.planning/phases/01-a/01-01-PLAN.md"
printf 'base = develop\nwtdir = wt\ninstall = none\n' > "$WT/repo/.gsd.conf"
printf '.planning/ROADMAP.md merge=gsd-planning\n.planning/STATE.md merge=gsd-planning\n' \
  > "$WT/repo/.gitattributes"
roadmap ' ' '' ' ' '' '0/TBD | Not started | - ' '0/TBD | Not started | - '
state planning 1 0 '2026-01-01T00:00:00.000Z'
git -C "$WT/repo" add -A && git -C "$WT/repo" commit -qm base

git -C "$WT/repo" worktree add -q -b phase-1-alpha "$WT/wt/phase-1-alpha" develop
E2E="$WT/wt/phase-1-alpha"
: > "$WT/wt/phase-1-alpha/.planning/phases/01-a/01-01-SUMMARY.md"
roadmap 'x' ' (completed 2026-03-01)' ' ' '' '1/1 | Complete | 2026-03-01 ' '0/TBD | Not started | - '
state ready_to_plan 2 1 '2026-03-01T00:00:00.000Z'
git -C "$WT/wt/phase-1-alpha" add -A
git -C "$WT/wt/phase-1-alpha" commit -qm "phase 1 done"

E2E="$WT/repo"
roadmap ' ' '' 'x' ' (completed 2026-03-02)' '0/TBD | Not started | - ' '2/2 | Complete | 2026-03-02 '
state executing 2 1 '2026-03-02T00:00:00.000Z'
git -C "$WT/repo" commit -qam "parallel session finished phase 2"

finish_out="$( cd "$WT/wt/phase-1-alpha" && PATH="$PKG/bin:$PATH" gsdt-wt-finish 1 2>&1 )"
finish_rc=$?
is "gsdt-wt-finish succeeds" "$finish_rc" 0
is "it reports reconciling .planning" "$(grep -c 'reconciling .planning after the phase merge' <<<"$finish_out")" 1

R="$WT/repo/.planning/ROADMAP.md"
S="$WT/repo/.planning/STATE.md"
is "develop has one Phase 1 checklist entry" "$(grep -c '^- \[.\] \*\*Phase 1:' "$R")" 1
is "develop has both phases complete"        "$(grep -c '^- \[x\] \*\*Phase' "$R")" 2
is "develop has one 'status:'"               "$(grep -c '^status:' "$S")" 1
is "develop's counters were recomputed"      "$(grep -c '  completed_phases: 2' "$S")" 1
is "develop's history is intact"             "$(grep -c '^Resume file:' "$S")" 2
( cd "$WT/repo" && PATH="$PKG/bin:$PATH" gsdt-planning-repair --check >/dev/null 2>&1 )
is "develop passes --check after the finish" "$?" 0
is "the repair left no uncommitted changes"  "$(git -C "$WT/repo" status --porcelain -- .planning | wc -l | tr -d ' ')" 0

# ── 8. content the reconciler must never touch ───────────────────────────────
# Three defects found reviewing the committed fix. All three are the same class
# of failure the tool exists to prevent: silently deleting real content.
section "no collateral deletion"

# A: ROADMAP.md puts every '### Phase N:' detail AFTER '## Progress'. When the
# Progress section was bounded only at '##' it ran to EOF, so the progress-row
# dedupe reached into the phase details and deleted a numbered table row in one
# phase because another phase's detail happened to use the same number.
COLL="$WORK/collateral"
mkdir -p "$COLL/.planning/phases"
# (built with python: the injected rows contain '|', which fights every sed delimiter)
python3 - "$FIX/phase-11-merge/ROADMAP.md" "$COLL/.planning/ROADMAP.md" <<'INJECT'
import sys
src, dst = sys.argv[1], sys.argv[2]
doc = open(src).read()
table = "\n| Step | What |\n|------|------|\n| %s | who |\n"
doc = doc.replace("### Phase 20: Verify and dispense\n",
                  "### Phase 20: Verify and dispense\n" + table % "1. Scan the QR code")
doc = doc.replace("### Phase 21: Branch self-service and admin queue\n",
                  "### Phase 21: Branch self-service and admin queue\n" + table % "1. Open the queue")
open(dst, "w").write(doc)
INJECT
cp "$FIX/phase-11-merge/STATE.md" "$COLL/.planning/"
engine repair "$COLL/.planning" >/dev/null 2>&1
is "a phase detail's numbered row survives"        "$(grep -c '^| 1\. Scan the QR code' "$COLL/.planning/ROADMAP.md")" 1
is "the same number in another phase survives too" "$(grep -c '^| 1\. Open the queue' "$COLL/.planning/ROADMAP.md")" 1
is "the real progress table is still deduped"      "$(grep -c '^| 11\. Catalogs' "$COLL/.planning/ROADMAP.md")" 1

# B: the frontmatter emitter used to rebuild from parsed keys, so any line it
# had no model for — YAML lists, comments — was dropped on the floor.
FM="$WORK/frontmatter"
mkdir -p "$FM/.planning/phases/01-a"
: > "$FM/.planning/phases/01-a/01-01-PLAN.md"
printf '# Roadmap\n\n## Phases\n\n- [x] **Phase 1: A** - a\n' > "$FM/.planning/ROADMAP.md"
cat > "$FM/.planning/STATE.md" <<'EOF'
---
milestone: v1.0
status: planning
tags:
  - alpha
  - beta
# a comment the parser has no model for
progress:
  total_phases: 9
  completed_phases: 9
status: executing
---

# Project State

## Current Position

Phase: 1
EOF
engine repair "$FM/.planning" >/dev/null 2>&1
is "a YAML list item survives"        "$(grep -c '^  - alpha' "$FM/.planning/STATE.md")" 1
is "every list item survives"         "$(grep -c '^  - beta' "$FM/.planning/STATE.md")" 1
is "a comment survives"               "$(grep -c '^# a comment' "$FM/.planning/STATE.md")" 1
is "the list's parent key survives"   "$(grep -c '^tags:' "$FM/.planning/STATE.md")" 1
is "the duplicate key still collapses" "$(grep -c '^status:' "$FM/.planning/STATE.md")" 1
is "and takes the incoming value"     "$(grep -c '^status: executing' "$FM/.planning/STATE.md")" 1
is "counters still recomputed"        "$(grep -c '  total_phases: 1' "$FM/.planning/STATE.md")" 1

# C: --commit ran `git add` on both planning files unconditionally, which is
# fatal when one is absent. Called from gsdt-finish that aborted the repair with
# the merge already committed.
NOSTATE="$WORK/nostate"
mkdir -p "$NOSTATE/.planning/phases"
git init -q "$NOSTATE"
git -C "$NOSTATE" config user.email t@example.com
git -C "$NOSTATE" config user.name test
printf '# Roadmap\n\n## Phases\n\n- [x] **Phase 1: A** - a\n' > "$NOSTATE/.planning/ROADMAP.md"
git -C "$NOSTATE" add -A && git -C "$NOSTATE" commit -qm init
printf '# Roadmap\n\n## Phases\n\n- [ ] **Phase 1: A** - a\n- [x] **Phase 1: A** - a (completed 2026-01-01)\n' \
  > "$NOSTATE/.planning/ROADMAP.md"
PATH="$PKG/bin:$PATH" gsdt-planning-repair --repo "$NOSTATE" --commit >/dev/null 2>&1
is "--commit succeeds with no STATE.md" "$?" 0
is "the repair was committed"           "$(git -C "$NOSTATE" status --porcelain -- .planning | wc -l | tr -d ' ')" 0
is "the duplicate was collapsed"        "$(grep -c '^- \[.\] \*\*Phase 1:' "$NOSTATE/.planning/ROADMAP.md")" 1
printf -- '- [ ] **Phase 2: B** - b\n- [ ] **Phase 2: B** - b\n' >> "$NOSTATE/.planning/ROADMAP.md"
printf 'mine\n' > "$NOSTATE/src.txt"; git -C "$NOSTATE" add src.txt
PATH="$PKG/bin:$PATH" gsdt-planning-repair --repo "$NOSTATE" --commit >/dev/null 2>&1
is "--commit leaves out a file the user staged" "$(git -C "$NOSTATE" show --name-only --format= HEAD | tr '\n' ' ')" ".planning/ROADMAP.md "
is "…which stays staged"                "$(git -C "$NOSTATE" diff --cached --name-only)" "src.txt"

# ── 9. gsdt-doctor ────────────────────────────────────────────────────────────
# It diagnoses and never fixes. The read-only guarantee is the whole reason it
# is safe to run on a repo you are mid-feature in, so it is asserted, not
# assumed. (Toolkit-level findings are ignored here: they reflect the state of
# the checkout the tests run from, not the repo under inspection.)
section "gsdt-doctor"

DOC="$WORK/doctor"
mkdir -p "$DOC/.planning/phases/01-a" "$DOC/scripts"
git init -q -b develop "$DOC"
git -C "$DOC" config user.email t@example.com
git -C "$DOC" config user.name test
printf '.planning/ROADMAP.md merge=union\n.planning/STATE.md merge=union\n' > "$DOC/.gitattributes"
cp "$FIX/phase-11-merge/ROADMAP.md" "$FIX/phase-11-merge/STATE.md" "$DOC/.planning/"
git -C "$DOC" add -A && git -C "$DOC" commit -qm init

out="$(PATH="$PKG/bin:$PATH" gsdt-doctor --repo "$DOC" 2>&1)"
is "reports merge=union"          "$(grep -c 'still on merge=union' <<<"$out")" 1
is "reports the missing driver"   "$(grep -c 'merge driver not registered' <<<"$out")" 1
is "reports the missing hook"     "$(grep -c 'no post-merge hook' <<<"$out")" 1
is "reports missing shims"        "$(grep -c 'shims: .* missing' <<<"$out")" 1
is "reports the planning damage"  "$(grep -c 'contradicts itself' <<<"$out")" 1
is "names gsdt-init as the fix"    "$([ "$(grep -c 'gsdt-init' <<<"$out")" -ge 4 ] && echo yes)" yes
is "names the repair as the fix"  "$([ "$(grep -c 'gsdt-planning-repair' <<<"$out")" -ge 1 ] && echo yes)" yes

# THE guarantee: a diagnosis must not change the thing it diagnoses.
before_tree="$(git -C "$DOC" status --porcelain)"
before_cfg="$(git -C "$DOC" config --local --list | sort)"
before_files="$(find "$DOC" -type f -not -path '*/.git/*' | sort | xargs shasum 2>/dev/null | shasum)"
PATH="$PKG/bin:$PATH" gsdt-doctor --repo "$DOC" >/dev/null 2>&1
is "working tree untouched"  "$(git -C "$DOC" status --porcelain)" "$before_tree"
is "git config untouched"    "$(git -C "$DOC" config --local --list | sort)" "$before_cfg"
is "no file contents changed" "$(find "$DOC" -type f -not -path '*/.git/*' | sort | xargs shasum 2>/dev/null | shasum)" "$before_files"
# --fix is opt-in AND asks: with no terminal and no --yes it changes nothing.
PATH="$PKG/bin:$PATH" gsdt-doctor --fix --repo "$DOC" </dev/null >/dev/null 2>&1
is "--fix unanswered: working tree untouched" "$(git -C "$DOC" status --porcelain)" "$before_tree"
is "--fix unanswered: git config untouched"   "$(git -C "$DOC" config --local --list | sort)" "$before_cfg"

# --fix --yes runs the scoped writers (gsdt-init, gsdt-planning-repair) itself;
# the repo-setup and planning findings clear, and nothing is committed.
head_before="$(git -C "$DOC" rev-parse HEAD)"
out="$(PATH="$PKG/bin:$PATH" gsdt-doctor --fix --yes --repo "$DOC" 2>&1)"
is "--fix ran gsdt-init and the repair" "$(grep -c '^▶ gsdt-init\|^▶ gsdt-planning-repair' <<<"$out")" 2
is "--fix committed nothing"            "$(git -C "$DOC" rev-parse HEAD)" "$head_before"
out="$(PATH="$PKG/bin:$PATH" gsdt-doctor --repo "$DOC" 2>&1)"
is "merge=union finding clears"   "$(grep -c 'still on merge=union' <<<"$out")" 0
is "driver finding clears"        "$(grep -c 'merge driver not registered' <<<"$out")" 0
is "hook finding clears"          "$(grep -c 'no post-merge hook' <<<"$out")" 0
is "planning reports coherent"    "$(grep -c '.planning is coherent' <<<"$out")" 1

# ── 10. one predicate for "installed" ────────────────────────────────────────
# gsdt-bootstrap-repo writes the merge safety and gsdt-doctor reports on it. When
# those were two implementations they could disagree — doctor calling a repo
# clean that bootstrap would still change. Both now go through
# gsd_planning_status, and this asserts the contract directly.
section "gsd_planning_status is the single source of truth"
# shellcheck source=../lib/common.sh
. "$PKG/lib/common.sh"

PRED="$WORK/predicate"
mkdir -p "$PRED"
git init -q -b main "$PRED"
git -C "$PRED" config user.email t@example.com
git -C "$PRED" config user.name test
printf '.planning/ROADMAP.md merge=union\n.planning/STATE.md merge=union\n' > "$PRED/.gitattributes"

gsd_planning_status "$PRED"
is "a legacy repo reports all three missing" \
   "$(echo "$GSD_PLANNING_MISSING" | tr ' ' '\n' | sort | tr '\n' ' ')" "attributes driver hook "
is "and flags the attributes as merge=union" "$GSD_ATTRS_STATE" union

PATH="$PKG/bin:$PATH" gsd_planning_apply "$PRED" >/dev/null 2>&1
gsd_planning_status "$PRED"
is "after apply, nothing is missing" "$GSD_PLANNING_MISSING" ""
is "attributes now read as ok"       "$GSD_ATTRS_STATE" ok

# Applying twice must be a no-op, or the hook body would be appended repeatedly.
PATH="$PKG/bin:$PATH" gsd_planning_apply "$PRED" >/dev/null 2>&1
is "apply is idempotent (hook not duplicated)" \
   "$(grep -c 'gsdt-planning-repair || true' "$PRED/.git/hooks/post-merge")" 1
is "apply is idempotent (attributes not duplicated)" \
   "$(grep -c 'merge=gsd-planning' "$PRED/.gitattributes")" 2

# ── 11. gsdt-doctor knows what it is looking at ───────────────────────────────
# It used to run the setup checks on anything, so a repo with no interest in GSD
# — including the toolkit itself, which is the SOURCE of the scripts and is
# deliberately not a GSD project — got four red lines telling it to run gsdt-init.
section "gsdt-doctor does not demand GSD from repos that do not use it"

PLAIN="$WORK/plain"
mkdir -p "$PLAIN"
git init -q -b main "$PLAIN"
git -C "$PLAIN" config user.email t@example.com
git -C "$PLAIN" config user.name test
echo hi > "$PLAIN/f" && git -C "$PLAIN" add -A && git -C "$PLAIN" commit -qm init

out="$(PATH="$PKG/bin:$PATH" gsdt-doctor --repo "$PLAIN" 2>&1)"; rc=$?
is "a plain repo has no findings"       "$rc" 0
is "it says the repo does not use GSD"  "$(grep -c 'does not use GSD' <<<"$out")" 1
is "no red line about .gitattributes"   "$(grep -c 'gitattributes' <<<"$out")" 0
is "no red line about the driver"       "$(grep -c 'merge driver not registered' <<<"$out")" 0
is "no red line about the hook"         "$(grep -c 'no post-merge hook' <<<"$out")" 0
is "no red line about shims"            "$(grep -c 'shims:' <<<"$out")" 0

out="$(PATH="$PKG/bin:$PATH" gsdt-doctor --repo "$PKG" 2>&1)"
is "the toolkit is recognised as itself" "$(grep -c 'toolkit itself, not a GSD project' <<<"$out")" 1
is "and its setup checks are skipped"    "$(grep -c 'merge driver not registered' <<<"$out")" 0

# Exercise linked toolkit execution even when CI runs from a normal checkout.
# All copied commands, Git config, and worktree metadata stay in the fixture.
TOOLKIT_FIXTURE="$WORK/toolkit fixture"
TOOLKIT_LINKED="$WORK/toolkit linked"
mkdir -p "$TOOLKIT_FIXTURE"
cp -R "$PKG/bin" "$PKG/lib" "$PKG/shims" "$PKG/install.sh" "$TOOLKIT_FIXTURE/"
git -C "$TOOLKIT_FIXTURE" init -q -b main
git -C "$TOOLKIT_FIXTURE" add .
git -C "$TOOLKIT_FIXTURE" -c user.name=t -c user.email=t@t commit -qm toolkit
git -C "$TOOLKIT_FIXTURE" worktree add -q -b test-linked "$TOOLKIT_LINKED"
for target in "$TOOLKIT_FIXTURE" "$TOOLKIT_LINKED"; do
  out="$(PATH="$TOOLKIT_LINKED/bin:$PATH" "$TOOLKIT_LINKED/bin/gsdt-doctor" --repo "$target" 2>&1)"; rc=$?
  is "linked toolkit recognises $(basename "$target")" "$(grep -c 'toolkit itself, not a GSD project' <<<"$out")" 1
  is "linked toolkit setup checks produce no findings" "$rc" 0
done
out="$(PATH="$TOOLKIT_LINKED/bin:$PATH" "$TOOLKIT_LINKED/bin/gsdt-doctor" --repo "$DOC" 2>&1)"
is "linked toolkit still checks an unrelated GSD repo" "$(grep -c 'merge=gsd-planning on ROADMAP' <<<"$out")" 1

# Toolkit housekeeping is a note, not a finding: it is about the toolkit
# checkout, not the repo you asked about.
is "a dirty toolkit does not fail another repo's check" \
   "$(PATH="$PKG/bin:$PATH" gsdt-doctor --repo "$PLAIN" 2>&1 | grep -c '✖.*toolkit has')" 0

# A real GSD repo must still get the full treatment.
out="$(PATH="$PKG/bin:$PATH" gsdt-doctor --repo "$DOC" 2>&1)"
is "a real GSD repo is still checked in full" "$(grep -c 'merge=gsd-planning on ROADMAP' <<<"$out")" 1

section "gsdt-doctor tells you what to run"
# Every finding used to carry its own 'cd <absolute path> && <cmd>', repeated
# verbatim on each line, which pushed the actual command off the right edge and
# read as noise. The commands are now collected once, at the end, in order.
# a repo with findings — the earlier fixtures have all been fitted by now
SUMM="$WORK/summary"
mkdir -p "$SUMM/.planning"
git init -q -b main "$SUMM"
git -C "$SUMM" config user.email t@example.com
git -C "$SUMM" config user.name test
printf '.planning/ROADMAP.md merge=union\n.planning/STATE.md merge=union\n' > "$SUMM/.gitattributes"
printf '# Roadmap\n' > "$SUMM/.planning/ROADMAP.md"
git -C "$SUMM" add -A && git -C "$SUMM" commit -qm init

# strip colour codes: they sit between words and break plain greps
out="$(PATH="$PKG/bin:$PATH" gsdt-doctor --repo "$SUMM" 2>&1 | sed 's/\x1b\[[0-9;]*m//g')"
is "the summary says what to run"      "$(grep -c 'finding(s)\.' <<<"$out")" 1
is "no repeated 'cd … &&' on findings" "$(grep -c '→ cd ' <<<"$out")" 0
is "the cd is given once"              "$(grep -c '^  cd .*/summary$' <<<"$out")" 1
is "gsdt-init listed once, not 3×"      "$(grep -c '^  gsdt-init$' <<<"$out")" 1
is "and it says how to confirm"        "$(grep -c 're-run gsdt-doctor to confirm' <<<"$out")" 1

section "post-merge hook: versioned when it lands in the working tree"
# A repo may point core.hooksPath at a TRACKED directory (scripts/git-hooks is
# a common convention). The hook there belongs in the commit like any other
# file. Assuming .git/hooks left it untracked in exactly such a repo — it
# protected the clone that ran the bootstrap and nobody else.
# shellcheck source=../lib/common.sh
. "$PKG/lib/common.sh"

HK="$WORK/hookrepo"
mkdir -p "$HK/scripts/git-hooks"
git init -q -b develop "$HK"
# CI runners have no global git identity — without this the commits below fail
# and every assertion after them is measuring the wrong thing.
git -C "$HK" config user.email t@example.com
git -C "$HK" config user.name test
git -C "$HK" config core.hooksPath "$HK/scripts/git-hooks"
echo x > "$HK/f.txt"; git -C "$HK" add -A; git -C "$HK" commit -qm init
gsd_planning_hook "$HK"
is "custom hooks path is treated as versioned" "$GSD_HOOK_VERSIONED" "1"
is "and its label is repo-relative"            "$GSD_HOOK_LABEL" "scripts/git-hooks/post-merge"

# The default .git/hooks case must still be reported as per-clone.
PLAIN="$WORK/plainrepo"
mkdir -p "$PLAIN"; git init -q -b develop "$PLAIN"
git -C "$PLAIN" config user.email t@example.com
git -C "$PLAIN" config user.name test
echo x > "$PLAIN/f.txt"; git -C "$PLAIN" add -A; git -C "$PLAIN" commit -qm init
gsd_planning_hook "$PLAIN"
is "default .git/hooks stays unversioned" "$GSD_HOOK_VERSIONED" "0"

# End to end: the bootstrap must COMMIT the hook in the custom-path repo.
( cd "$HK" && PATH="$PKG/bin:$PATH" gsdt-bootstrap-repo --commit >/dev/null 2>&1 )
is "the hook is tracked after bootstrap" \
   "$(git -C "$HK" ls-files scripts/git-hooks/post-merge | wc -l | tr -d ' ')" "1"
is "and nothing is left untracked" \
   "$(git -C "$HK" status --porcelain | grep -c '^??' || true)" "0"

section "python interpreter fallback"
# Not every system names it python3 — minimal images and Windows use `python`.
# The name alone is not enough to trust: `python` is still Python 2 in places,
# and Python 2 cannot run the reconciler at all.
# shellcheck source=../lib/common.sh
. "$PKG/lib/common.sh"

unset GSD_PYTHON
resolved="$(gsd_python || true)"
is "resolves an interpreter here" "$([ -n "$resolved" ] && echo yes)" "yes"
is "and it really is python 3"    "$("$resolved" -c 'import sys; print(sys.version_info[0])')" "3"

# A PATH holding ONLY a fake `python` — no python3 to fall back on, which is
# what a minimal image looks like. PATH must exclude /usr/bin or the real
# python3 is found first and the fallback is never exercised.
REALPY="$(command -v python3)"
FAKEBIN="$WORK/fakebin"
mkdir -p "$FAKEBIN"

# Case 1: `python` is Python 2 — must be REJECTED, not handed back to break
# mid-merge. The probe asks the interpreter, so a stub that fails it is enough.
cat > "$FAKEBIN/python" <<'STUB'
#!/bin/bash
case "$*" in
  *version_info*) exit 1 ;;              # fails the >= 3.7 probe, as py2 does
  --version) echo "Python 2.7.18"; exit 0 ;;
esac
exit 1
STUB
chmod +x "$FAKEBIN/python"
unset GSD_PYTHON
out="$(PATH="$FAKEBIN" /bin/bash -c ". '$PKG/lib/common.sh'; gsd_python && echo PICKED || echo REJECTED" 2>&1)"
is "rejects a python 2 named 'python'" "$(grep -c REJECTED <<<"$out")" 1

# Case 2: `python` IS Python 3 — must be ACCEPTED. That is the whole point.
printf '#!/bin/bash\nexec %s "$@"\n' "$REALPY" > "$FAKEBIN/python"
chmod +x "$FAKEBIN/python"
unset GSD_PYTHON
out="$(PATH="$FAKEBIN" /bin/bash -c ". '$PKG/lib/common.sh'; gsd_python" 2>&1)"
is "accepts a python 3 named 'python'" "$out" "python"

# And the reconciler genuinely runs under that name, not just the name check.
unset GSD_PYTHON
out="$(PATH="$FAKEBIN" /bin/bash -c "\"\$(. '$PKG/lib/common.sh'; gsd_python)\" '$ENGINE' --help" 2>&1 | head -1)"
is "the engine runs under 'python'" "$(grep -c usage <<<"$out")" 1
unset GSD_PYTHON

section "GSD's own STATE.md form is not drift"
G="$WORK/gsdform/.planning"; mkdir -p "$G/phases"
printf '# Roadmap\n\n- [ ] **Phase 1: A**\n- [ ] **Phase 2: B**\n\n### Phase 1: A\n\n### Phase 2: B\n' > "$G/ROADMAP.md"
gstate() { printf '# Project State\n\n## Current Position\n\nPhase: 1 of 2 (A)\n%s\n' "$1" > "$G/STATE.md"; }
gstate 'Progress: [░░░░░░░░░░] 0%'
out=$(engine repair --check "$G")
is "a new project's STATE.md (no frontmatter, bar without a count) → consistent" "$out" "✔ .planning/ is consistent"
gstate 'Progress: [█████░░░░░] 50%'
out=$(engine repair --check "$G")
is "…a stale percent is still caught" "$(grep -c 'progress bar recomputed to 0%' <<<"$out")" 1
is "…and offered as an update" "$(grep -c '^• a repair would update: STATE.md' <<<"$out")" 1
engine repair "$G" >/dev/null
is "…the repair keeps GSD's form (no count added)" "$(grep '^Progress:' "$G/STATE.md")" "Progress: [░░░░░░░░░░] 0%"
gstate 'Progress: [█████░░░░░] 50% (1 of 2 phases complete)'
engine repair "$G" >/dev/null
is "a line with a count keeps it, recomputed" "$(grep '^Progress:' "$G/STATE.md")" "Progress: [░░░░░░░░░░] 0% (0 of 2 phases complete)"
printf '# Project State\n\ntext\n| stray | row |\ntext\n' > "$G/STATE.md"
out=$(engine repair --check "$G")
is "a hand-edit advisory is still reported" "$(grep -c 'table row outside any table' <<<"$out")" 1
is "…but offers no repair" "$(grep -c 'a repair would update' <<<"$out")" 0

printf '\n%s\n' "── $PASS passed, $FAIL failed ──"
[ "$FAIL" -eq 0 ]
