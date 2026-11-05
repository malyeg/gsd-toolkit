#!/usr/bin/env bash
# test-flow-next.sh — the /gsdt-flow step engine walks the agreed order.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; PKG="$(cd "$HERE/.." && pwd)"
NEXT="$PKG/bin/gsd-flow-next"
PASS=0; FAIL=0; WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
ok()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
section() { printf '\n%s\n' "$1"; }
# shellcheck source=ui-fixture.sh
. "$HERE/ui-fixture.sh"

REPO="$WORK/r"; PD="$REPO/.planning/phases/07-thing"; mkdir -p "$PD"
git -C "$REPO" init -q -b develop
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git -C "$REPO" checkout -q -b phase-7-thing
gcommit() { git -C "$REPO" add -A >/dev/null; GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git -C "$REPO" -c user.email=t@t -c user.name=t commit -q -m "$2" --allow-empty; }
step() { "$NEXT" 7 --repo "$REPO" "$@" | sed -n 's/^step=//p'; }
fm() { printf -- '---\nstatus: %s\n%s\n---\n' "$2" "${3:-}" > "$PD/07-$1"; }

section "walks the order as artifacts appear"
is "tracker = none (default): no ticket step" "$(step)" discuss
is "…and discuss has no ticket then=" "$("$NEXT" 7 --repo "$REPO" | grep -c '^then=')" 0
export GSD_TRACKER=clickup
is "tracker set, empty folder → ticket" "$(step)" ticket
is "…untagged: no run=, asks the user" "$("$NEXT" 7 --repo "$REPO" | grep -c '^run=')" 0
: > "$PD/07-TICKET.md";     is "TICKET.md → discuss"           "$(step)" discuss
is "…discuss then= updates the ticket" "$("$NEXT" 7 --repo "$REPO" | sed -n 's/^then=//p')" "update the clickup ticket to the agreed scope"
: > "$PD/07-CONTEXT.md";    is "discuss → ui-decision"         "$(step)" ui-decision
is "ui-decision --no-ui → plan"       "$(step --no-ui)" plan
is "ui-decision --ui → design-system" "$(step --ui)" design-system
: > "$PD/07-UI-SPEC.md";    is "UI-SPEC → plan (no flag needed)" "$(step)" plan
planrun() { "$NEXT" 7 --repo "$REPO" | sed -n 's/^run=//p'; }
is "plan: no RESEARCH.md, no config → --research (never asks)" "$(planrun)" "/gsd-plan-phase 7 --research"
printf '{"workflow":{"research":false}}' > "$REPO/.planning/config.json"
is "plan: workflow.research false → --skip-research" "$(planrun)" "/gsd-plan-phase 7 --skip-research"
printf '{"workflow":{"research":true}}' > "$REPO/.planning/config.json"
is "plan: workflow.research true → --research" "$(planrun)" "/gsd-plan-phase 7 --research"
printf 'not json' > "$REPO/.planning/config.json"
is "plan: broken config → --research" "$(planrun)" "/gsd-plan-phase 7 --research"
rm -f "$REPO/.planning/config.json"
: > "$PD/07-RESEARCH.md"
is "plan: RESEARCH.md exists → plain (reuses it, no prompt)" "$(planrun)" "/gsd-plan-phase 7"
rm -f "$PD/07-RESEARCH.md"
is "plan: never --auto (it would skip the review gate)" "$("$NEXT" 7 --repo "$REPO" | grep -c -- '--auto')" 0
: > "$PD/07-01-PLAN.md"; : > "$PD/07-02-PLAN.md"
is "plans → review"                   "$(step)" review
is "review note (codex): gsd-codex-wait on a usage limit" "$("$NEXT" 7 --repo "$REPO" | grep -c 'gsd-codex-wait --wait-only')" 1
printf '## Codex Review\n\nYou\342\200\231ve hit your usage limit. Try again at Oct 11th, 2026 1:22 AM.\n' > "$PD/07-REVIEWS.md"
is "REVIEWS whose Codex hit the limit → review again" "$(step)" review
is "…and the note says why" "$("$NEXT" 7 --repo "$REPO" | grep -c 'not a usable review (Codex Review — usage limit hit)')" 1
is "…also with --all (no replan after it)" "$("$NEXT" 7 --repo "$REPO" --all | grep -c '^step=replan')" 0
is "…a short failed file: delete it" "$("$NEXT" 7 --repo "$REPO" | grep -c 'delete it and run the review again')" 1
{ printf '## Codex Review\n\n## Consensus Summary\n\n'; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40; do echo "line $i"; done; } > "$PD/07-REVIEWS.md"
is "a large rejected file → open it before any rerun" "$("$NEXT" 7 --repo "$REPO" | grep -c 'open it and check before you delete it')" 1
is "…and no plain delete advice" "$("$NEXT" 7 --repo "$REPO" | grep -c 'delete it and run the review again')" 0
printf '## Codex Review\n\n## 07-01\nfinding\n\n---\n\n## 07-02\nfinding\n\n---\n\n## Consensus Summary\n\nok\n' > "$PD/07-REVIEWS.md"
is "## plan sections in the review → not the review step" "$("$NEXT" 7 --repo "$REPO" | grep -c '^step=review$')" 0
: > "$PD/07-REVIEWS.md";    is "REVIEWS uncommitted → replan"  "$(step)" replan
gcommit 2026-01-01T10:00:00 "plans"          # plans + REVIEWS in one commit → counts as replanned
is "REVIEWS + plans same commit → execute"  "$(step)" execute
: > "$PD/07-REVIEWS.md"; echo x >> "$PD/07-REVIEWS.md"; gcommit 2026-01-01T11:00:00 "review again"
is "REVIEWS committed after plans → replan" "$(step)" replan
echo y >> "$PD/07-01-PLAN.md"; gcommit 2026-01-01T12:00:00 "replan"
is "plan committed after REVIEWS → execute" "$(step)" execute
: > "$PD/07-01-SUMMARY.md"; is "one summary short → execute"  "$(step)" execute
: > "$PD/07-02-SUMMARY.md"
is "all summaries, no VERIFICATION → verifier" "$(step)" verifier
fm VERIFICATION.md gaps_found; is "gaps_found → gaps"          "$(step)" gaps
fm VERIFICATION.md passed;     is "passed → verify-work"       "$(step)" verify-work
fm HUMAN-UAT.md partial;       is "partial UAT → verify-work"  "$(step)" verify-work
fm HUMAN-UAT.md complete;      is "UAT complete → code-review (missing)" "$(step)" code-review
fm REVIEW.md issues_found;     is "issues_found, no FIX → code-review" "$(step)" code-review
: > "$PD/07-REVIEW-FIX.md";    is "FIX present → ui-check"      "$(step)" ui-check
printf 'taken: x\n' > "$PD/07-SHOTS.md"; is "0.3.x SHOTS.md alone → still ui-check" "$(step)" ui-check
ui_fix_check "$PD" 07 failed;  is "check failed → ui-check"     "$(step)" ui-check
ui_fix_check "$PD" 07 passed;  is "check passed → ui-look"      "$(step)" ui-look
ui_fix_look "$PD" 07;          is "look complete → ui-approve"  "$(step)" ui-approve
ui_fix_approval "$PD" 07;      is "approved → ui-review"        "$(step)" ui-review
: > "$PD/07-UI-REVIEW.md";     is "UI-REVIEW → validate (no VALIDATION.md)" "$(step)" validate
is "…run= is validate-phase" "$("$NEXT" 7 --repo "$REPO" | sed -n 's/^run=//p')" "/gsd-validate-phase 7"
printf -- '---\nphase: 7\nstatus: draft\nnyquist_compliant: false\n---\n\n# Validation\n\n---\n' > "$PD/07-VALIDATION.md"
is "the plan's draft VALIDATION.md → validate" "$(step)" validate
is "…and the note says it is the draft" "$("$NEXT" 7 --repo "$REPO" | grep -c "07-VALIDATION.md is the plan's draft")" 1
printf '{"workflow":{"nyquist_validation":false}}' > "$REPO/.planning/config.json"
is "workflow.nyquist_validation false → no validate step" "$(step)" secure
rm -f "$REPO/.planning/config.json"
printf '\n## Validation Audit 2026-10-22\n| Gaps found | 2 |\n' >> "$PD/07-VALIDATION.md"
is "audited, gaps left manual-only → secure" "$(step)" secure
printf -- '---\nphase: 7\nstatus: validated\nnyquist_compliant: true\n---\n' > "$PD/07-VALIDATION.md"
is "nyquist_compliant: true → secure"        "$(step)" secure
for v in '"true"' "'true'" 'True' 'true   # all automated'; do
  printf -- '---\nnyquist_compliant: %s\n---\n' "$v" > "$PD/07-VALIDATION.md"
  is "nyquist_compliant: $v → secure"      "$(step)" secure
done
printf -- '---\r\nnyquist_compliant: true\r\n---\r\n' > "$PD/07-VALIDATION.md"
is "…and with CRLF line ends"                "$(step)" secure
printf -- '---\nnyquist_compliant: "false"\n---\n' > "$PD/07-VALIDATION.md"
is 'nyquist_compliant: "false" → validate'   "$(step)" validate
printf -- '---\nphase: 7\nstatus: validated\nnyquist_compliant: true\n---\n' > "$PD/07-VALIDATION.md"
fm SECURITY.md verified "threats_open: 2"; is "2 open threats → secure" "$(step)" secure
fm SECURITY.md verified "threats_open: 0"; is "0 open → done"  "$(step)" "done"

section "details"
is "done run= is gsd-finish" "$("$NEXT" 7 --repo "$REPO" | sed -n 's/^run=//p')" gsd-finish
is "--all lists every remaining step" "$("$NEXT" 7 --repo "$REPO" --all | grep -c '^step=')" 1
rm "$PD/07-REVIEWS.md" "$PD/07-UI-REVIEW.md"
is "--all with two gaps lists 3 (review, ui-review, done)" "$("$NEXT" 7 --repo "$REPO" --all | grep -c '^step=')" 3
rm "$PD/07-UI-APPROVAL.md"
is "--all with the approval gone lists 4" "$("$NEXT" 7 --repo "$REPO" --all | sed -n 's/^step=//p' | tr '\n' ' ')" "review ui-approve ui-review done "
ui_fix_approval "$PD" 07
is "--json emits one object" "$("$NEXT" 7 --repo "$REPO" --json | head -1 | grep -c '"step":"review"')" 1
is "review has a then= replan" "$("$NEXT" 7 --repo "$REPO" | sed -n 's/^then=//p')" "/gsd-plan-phase 7 --reviews"
git -C "$REPO" checkout -q -b phase-8-thing
is "legacy cu_ in dir name counts as the ticket" "$(mkdir -p "$REPO/.planning/phases/08-x-cu_abc" && "$NEXT" 8 --repo "$REPO" | sed -n 's/^step=//p')" discuss
git -C "$REPO" checkout -q -b phase-7.1-fix
is "decimal phase dir" "$(mkdir -p "$REPO/.planning/phases/7.1-fix" && "$NEXT" 7.1 --repo "$REPO" | sed -n 's/^step=//p')" ticket
git -C "$REPO" checkout -q -b phase-11-cart
mkdir -p "$REPO/.planning/phases/11-cart-tk-proj-42"
printf '# Roadmap\n\n### Phase 11: cart tk-PROJ-42\n' > "$REPO/.planning/ROADMAP.md"
is "tagged title → run= snapshot (id case from the title)" "$("$NEXT" 11 --repo "$REPO" | sed -n 's/^run=//p')" \
  "gsd-tracker snapshot PROJ-42 --out .planning/phases/11-cart-tk-proj-42/11-TICKET.md"
: > "$REPO/.planning/phases/11-cart-tk-proj-42/11-STORY.md"
is "legacy STORY.md counts as the ticket" "$("$NEXT" 11 --repo "$REPO" | sed -n 's/^step=//p')" discuss
git -C "$REPO" checkout -q -b phase-9-missing
"$NEXT" 9 --repo "$REPO" >/dev/null 2>&1; is "missing phase dir → exit 1" "$?" 1

section "unconditional location guard without configuration"
"$NEXT" 7 --repo "$REPO" >/dev/null 2>&1; is "wrong phase without config is blocked" "$?" 2
"$NEXT" 7.1 --repo "$REPO" >/dev/null 2>&1; is "ticket step on wrong phase is blocked" "$?" 2
git -C "$REPO" checkout -q develop
"$NEXT" 7 --repo "$REPO" --all >/dev/null 2>&1; is "preview on base is blocked" "$?" 2
git -C "$REPO" checkout -q phase-7-thing
printf 'flow = strict\ninstall = none\n' > "$REPO/.gsd.conf"
"$NEXT" 7 --repo "$REPO" --all >/dev/null 2>&1; is "preview does not enforce gates of future steps" "$?" 0

section "UI gates (design system, layout, the checks of the rendered pages)"
unset GSD_TRACKER
U="$WORK/u"; UPD="$U/.planning/phases/05-shop"; mkdir -p "$UPD"
git -C "$U" init -q -b develop
git -C "$U" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git -C "$U" checkout -q -b phase-5-shop
: > "$UPD/05-CONTEXT.md"
ustep() { "$NEXT" 5 --repo "$U" "$@" | sed -n 's/^step=//p'; }
urun()  { "$NEXT" 5 --repo "$U" "$@" | sed -n 's/^run=//p'; }
is "--ui, no DESIGN.md → design-system"        "$(ustep --ui)" design-system
is "…run= gsd-ui design"                        "$(urun --ui)" "gsd-ui design"
is "…stop= offers real design systems"          "$("$NEXT" 5 --repo "$U" --ui | grep -c '^stop=.*styles.refero.design')" 1
PATH="$PKG/bin:$PATH" gsd-ui design --repo "$U" >/dev/null
is "stub DESIGN.md → still design-system"       "$(ustep --ui)" design-system
sed -i.bak '/gsd:design-stub/d' "$U/.planning/design/DESIGN.md"
is "filled DESIGN.md → layout"                  "$(ustep --ui)" layout
is "…run= gsd-ui layout 5"                      "$(urun --ui)" "gsd-ui layout 5"
is "…then= /gsd-sketch"                         "$("$NEXT" 5 --repo "$U" --ui | sed -n 's/^then=//p' | cut -c1-11)" "/gsd-sketch"
PATH="$PKG/bin:$PATH" gsd-ui layout 5 --repo "$U" >/dev/null
is "LAYOUT settles screens (no --ui needed)"    "$(ustep)" layout
is "empty sketch: → run= /gsd-sketch"           "$(urun | cut -c1-11)" "/gsd-sketch"
sed -i.bak 's#^sketch:.*#sketch: .planning/sketches/001-shop#' "$UPD/05-LAYOUT.md"
is "sketch folder missing → layout, no run="    "$(ustep)/$(urun)" "layout/"
mkdir -p "$U/.planning/sketches/001-shop"; printf -- '---\nwinner: null\n---\n' > "$U/.planning/sketches/001-shop/README.md"
is "no winner → layout"                         "$("$NEXT" 5 --repo "$U" | grep -c 'no winner')" 1
printf -- '---\nwinner: "B"\n---\n' > "$U/.planning/sketches/001-shop/README.md"
is "winner, no pages → layout (pages)"          "$("$NEXT" 5 --repo "$U" | grep -c 'pages:')" 1
sed -i.bak 's#^pages:.*#pages: /, /cart#' "$UPD/05-LAYOUT.md"
is "sketch chosen + pages → ui-phase"           "$(ustep)" ui-phase
is "…ui-phase note names DESIGN.md + LAYOUT"    "$("$NEXT" 5 --repo "$U" | grep -c '^note=follow .planning/design/DESIGN.md and .planning/phases/05-shop/05-LAYOUT.md')" 1
sed -i.bak 's#^sketch:.*#sketch: skip tiny change#' "$UPD/05-LAYOUT.md"
is "sketch: skip <reason> → ui-phase"           "$(ustep)" ui-phase
rm -f "$U/.planning/design/DESIGN.md"; : > "$UPD/05-UI-SPEC.md"
is "UI-SPEC already there → pre-spec steps skipped" "$(ustep)" plan
printf 'ui_gates = off\n' > "$U/.gsd.conf"
rm -f "$UPD/05-UI-SPEC.md" "$UPD/05-LAYOUT.md"
is "ui_gates = off → straight to ui-phase"      "$(ustep --ui)" ui-phase
: > "$UPD/05-UI-SPEC.md"; : > "$UPD/05-01-PLAN.md"; : > "$UPD/05-01-SUMMARY.md"; : > "$UPD/05-REVIEWS.md"; : > "$UPD/05-VERIFICATION.md"
printf -- '---\nstatus: complete\n---\n' > "$UPD/05-UAT.md"; : > "$UPD/05-REVIEW.md"
git -C "$U" add -A >/dev/null; git -C "$U" -c user.name=t -c user.email=t@t commit -qm all
is "ui_gates = off → no ui-check step"          "$(ustep)" ui-review
rm "$U/.gsd.conf"
unote() { "$NEXT" 5 --repo "$U" | sed -n 's/^note=//p'; }
is "warn (default) → ui-check before ui-review" "$(ustep)" ui-check
is "…run= gsd-ui check 5"                       "$(urun)" "gsd-ui check 5"
is "…--all lists check, look, approve, review"  "$("$NEXT" 5 --repo "$U" --all | sed -n 's/^step=//p' | tr '\n' ' ')" "ui-check ui-look ui-approve ui-review validate secure done "
printf -- '---\nstatus: error\nerror: nothing answers at http://localhost:3005\n---\n' > "$UPD/05-UI-CHECK.md"
is "a run that could not finish → ui-check"     "$(ustep)" ui-check
is "…the note says why"                         "$(unote | grep -c 'nothing answers')" 1
ui_fix_check "$UPD" 05 failed
is "failed check → ui-check, note names waive:" "$(ustep)/$(unote | grep -c 'waive:')" "ui-check/1"
ui_fix_check "$UPD" 05 passed cap1 0000000000000000000000000000000000000000
is "code changed since the check → ui-check"    "$(ustep)" ui-check
is "…the note says the code changed"            "$(unote | grep -c 'the code or 05-LAYOUT.md changed after the last check')" 1
. "$PKG/lib/common.sh"; . "$PKG/lib/ui.sh"
ui_fix_check "$UPD" 05 passed cap1 "$(gsd_ui_code_state "$U")"
is "check made on this code → ui-look"          "$(ustep)" ui-look
is "…run= gsd-ui look 5"                        "$(urun)" "gsd-ui look 5"
git -C "$U" add -A >/dev/null; git -C "$U" -c user.name=t -c user.email=t@t commit -qm "ui check"
is "a commit of .planning files keeps it fresh" "$(ustep)" ui-look
echo code > "$U/app.js"
is "a new code file → ui-check again"           "$(ustep)" ui-check
rm "$U/app.js"
ui_fix_look "$UPD" 05 cap1 ok "R1 R2 R3"
is "a look with rules deleted → still ui-look"  "$(ustep)" ui-look
ui_fix_look "$UPD" 05 cap1 bad
is "a line marked bad → ui-look"                "$(ustep)/$(unote | grep -c 'marked bad')" "ui-look/1"
ui_fix_look "$UPD" 05 cap0
is "a look of older pictures → ui-look"         "$(ustep)" ui-look
ui_fix_look "$UPD" 05 cap1
sed -i.bak 's/^- R4: ok — seen in the picture$/- R4: ok/' "$UPD/05-UI-LOOK.md"; rm -f "$UPD/05-UI-LOOK.md.bak"
is "an answer without its text → ui-look"       "$(ustep)" ui-look
ui_fix_look "$UPD" 05 cap1
is "every picture and rule answered → ui-approve" "$(ustep)" ui-approve
is "…stop= asks the user first"                 "$("$NEXT" 5 --repo "$U" | grep -c '^stop=show the user the sheet')" 1
is "…then= gsd-ui approve 5"                    "$("$NEXT" 5 --repo "$U" | sed -n 's/^then=//p')" "gsd-ui approve 5"
ui_fix_approval "$UPD" 05 cap0
is "an approval of older pictures → ui-approve" "$(ustep)" ui-approve
ui_fix_approval "$UPD" 05 cap1
is "approved → ui-review"                       "$(ustep)" ui-review
is "…the note holds the pictures against the sketch" "$(unote | grep -c 'hold the pictures in 05-SHOTS/')" 1
printf -- '---\nstatus: skipped\nskipped: the app needs a VPN\n---\n' > "$UPD/05-UI-CHECK.md"
is "skipped check, approval of pictures → ui-approve" "$(ustep)" ui-approve
printf -- '---\nstatus: waived\nreason: the app needs a VPN\n---\n' > "$UPD/05-UI-APPROVAL.md"
is "skipped check + waived approval → ui-review" "$(ustep)/$(unote)" "ui-review/phase has screens"
# A review written in the phase's own worktree exempts nothing…
rm "$UPD/05-UI-CHECK.md" "$UPD/05-UI-APPROVAL.md" "$UPD/05-UI-LOOK.md"; : > "$UPD/05-UI-REVIEW.md"
git -C "$U" add -A >/dev/null; git -C "$U" -c user.name=t -c user.email=t@t commit -qm "review in the worktree"
is "UI-REVIEW.md only in this branch → ui-check" "$(ustep)" ui-check
# …one that is already on the base branch does (the phase predates the checks).
git -C "$U" branch -f develop phase-5-shop
is "UI-REVIEW.md on the base branch → no UI steps" "$(ustep)" validate

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]
