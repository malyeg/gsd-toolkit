#!/usr/bin/env bash
# test-codex-wait.sh — gsdt-codex-wait waits out a Codex usage limit, and a
# REVIEWS.md whose reviewer hit it never passes the review gate.
#
# A fake clock (GSD_CODEX_WAIT_CLOCK) makes hours of waiting take no time;
# stub commands stand in for Codex; CODEX_HOME points at a throwaway folder.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; PKG="$(cd "$HERE/.." && pwd)"
CW="$PKG/bin/gsdt-codex-wait"
PASS=0; FAIL=0; WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
ok()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
has() { if grep -q -- "$2" "$3"; then ok "$1"; else bad "$1" "no '$2' in: $(cat "$3")"; fi; }
section() { printf '\n%s\n' "$1"; }

export TZ=UTC CODEX_HOME="$WORK/codex" GSD_CODEX_WAIT_CLOCK="$WORK/clock"
mkdir -p "$CODEX_HOME/sessions/2026/10/10"
T0=$(date +%s)
reset_clock() { echo "$T0" > "$GSD_CODEX_WAIT_CLOCK"; rm -f "$WORK/runs"; }
clock() { cat "$GSD_CODEX_WAIT_CLOCK"; }
runs() { if [ -f "$WORK/runs" ]; then wc -l < "$WORK/runs" | tr -d ' '; else echo 0; fi; }
# Codex's wording for a reset at epoch $1: "Oct 11th, 2026 1:22 AM" (local = UTC here)
at() { python3 -c 'import sys,time; t=time.gmtime(int(sys.argv[1])); print(time.strftime("%b %dth, %Y %I:%M %p", t))' "$1"; }
RSQ=$(printf '\342\200\231')   # the curly apostrophe Codex prints
limit_msg() { printf 'You%sve hit your usage limit. Upgrade to Pro or try again at %s.' "${RSQ}" "$(at "$1")"; }

# stub: counts its runs; limited (exit 2, message on stderr) for the first $1
# runs, then prints a review and exits 0. $2 = the message.
stub() {
  cat > "$WORK/stub" <<EOF
#!/usr/bin/env bash
echo x >> "$WORK/runs"
if [ "\$(wc -l < "$WORK/runs")" -le $1 ]; then echo "\$STUB_MSG" >&2; exit 2; fi
echo "review: looks fine"; echo "note on stderr" >&2
EOF
  chmod +x "$WORK/stub"; export STUB_MSG="$2"
}

section "help and usage"
"$CW" --help > "$WORK/out" 2>&1; is "--help exits 0" "$?" 0
has "--help explains --wait-only" "--wait-only" "$WORK/out"
"$CW" > /dev/null 2>&1; is "no command → 64" "$?" 64
"$CW" --max-wait soon -- true > /dev/null 2>&1; is "bad duration → 64" "$?" 64
"$CW" --wait-only -- true > /dev/null 2>&1; is "--wait-only with a command → 64" "$?" 64

section "pass-through: no limit"
reset_clock
"$CW" -- sh -c 'echo to-stdout; echo to-stderr >&2' > "$WORK/o" 2> "$WORK/e"; rc=$?
is "exit 0 passes through" "$rc" 0
is "stdout streams to stdout" "$(cat "$WORK/o")" "to-stdout"
is "stderr streams to stderr" "$(cat "$WORK/e")" "to-stderr"
"$CW" -- sh -c 'echo nope >&2; exit 3' > /dev/null 2>&1; is "exit 3 passes through (no limit)" "$?" 3
is "…and no time passed" "$(clock)" "$T0"
"$CW" -- sh -c 'echo "a review quoting: You have hit your usage limit"; exit 0' > /dev/null 2>&1
is "limit text but exit 0 → not a limit" "$?" 0
"$CW" -- sh -c 'exit 7' > /dev/null 2>&1; is "plain failure, no limit message → 7" "$?" 7

section "a parsed reset time"
reset_clock; R=$((T0 / 60 * 60 + 3 * 3600))   # Codex prints whole minutes
stub 1 "$(limit_msg "$R")"
"$CW" -- "$WORK/stub" > "$WORK/o" 2> "$WORK/e"; rc=$?
is "limited once, then ok → exit 0" "$rc" 0
is "ran twice" "$(runs)" 2
is "waited until the reset + 2m margin" "$(clock)" "$((R + 120))"
has "names the reset time" "it resets" "$WORK/e"
is "the review reached stdout" "$(cat "$WORK/o")" "review: looks fine"
reset_clock
"$CW" --margin 10m -- "$WORK/stub" > /dev/null 2>&1
is "--margin 10m" "$(clock)" "$((R + 600))"
reset_clock; stub 1 "You've hit your usage limit. Try again in 2 hours 5 minutes."
"$CW" -- "$WORK/stub" > /dev/null 2>&1
is "'try again in 2 hours 5 minutes' form" "$(clock)" "$((T0 + 7500 + 120))"
reset_clock; stub 1 ""
python3 - "$CODEX_HOME/sessions/2026/10/10/rollout-1.jsonl" "$(limit_msg "$R")" > /dev/null <<'PY'
import json, sys
open(sys.argv[1], "w").write(json.dumps({"type": "event_msg", "payload": {"type": "task_complete", "error": {"message": sys.argv[2]}}}) + "\n")
PY
"$CW" -- "$WORK/stub" > /dev/null 2> "$WORK/e"; rc=$?
is "message hidden, found in Codex's session log → waits, exit 0" "$rc" 0
has "…says it came from the log" "session log" "$WORK/e"
is "…waited until the logged reset + margin" "$(clock)" "$((R + 120))"

section "an unparseable message → fixed interval"
reset_clock; rm -f "$CODEX_HOME"/sessions/2026/10/10/*.jsonl
stub 1 "You've hit your usage limit. Try again later."
"$CW" --interval 45m -- "$WORK/stub" > /dev/null 2> "$WORK/e"; rc=$?
is "waits --interval, then runs again → exit 0" "$rc" 0
is "waited 45m" "$(clock)" "$((T0 + 2700))"
has "says no reset time was found" "no reset time" "$WORK/e"

section "the cap"
reset_clock; stub 9 "$(limit_msg $((T0 / 60 * 60 + 30 * 3600)))"
"$CW" -- "$WORK/stub" > /dev/null 2> "$WORK/e"; rc=$?
is "reset 30h away, cap 24h → 75 at once" "$rc" 75
is "…without waiting" "$(clock)" "$T0"
is "…and without running it again" "$(runs)" 1
has "says it is not a pass" "NOT a pass" "$WORK/e"
reset_clock; stub 99 "You've hit your usage limit."
"$CW" --interval 1h --max-wait 3h -- "$WORK/stub" > /dev/null 2>&1; rc=$?
is "limited every time → 75 when the total would pass the cap" "$rc" 75
is "…after 3 one-hour waits" "$(clock)" "$((T0 + 10800))"
is "…and 4 runs" "$(runs)" 4

section "--wait-only"
reset_clock
"$CW" --wait-only --message "$(limit_msg "$R")" 2> "$WORK/e"; rc=$?
is "--message: waits, exit 0" "$rc" 0
is "…until the reset + margin" "$(clock)" "$((R + 120))"
has "…then says to run the step again" "Run the step again" "$WORK/e"
reset_clock
"$CW" --wait-only --message "all fine" 2> /dev/null; is "--message without a limit → 64" "$?" 64
reset_clock
"$CW" --wait-only --message "$(limit_msg $((T0 / 60 * 60 - 3600)))" 2> /dev/null; rc=$?
is "reset already past → exit 0 at once" "$rc$(clock)" "0$T0"
reset_clock
"$CW" --wait-only --message "$(limit_msg $((T0 / 60 * 60 + 30 * 3600)))" 2> /dev/null; is "past the cap → 75" "$?" 75
reset_clock
python3 - "$CODEX_HOME/sessions/2026/10/10/rollout-2.jsonl" "$(limit_msg "$R")" > /dev/null <<'PY'
import json, sys
open(sys.argv[1], "w").write(json.dumps({"payload": {"error": {"message": sys.argv[2]}}}) + "\n")
PY
"$CW" --wait-only 2> /dev/null; rc=$?
is "no --message: reads Codex's session log" "$rc$(clock)" "0$((R + 120))"
reset_clock; rm -f "$CODEX_HOME"/sessions/2026/10/10/*.jsonl
"$CW" --wait-only --interval 20m 2> /dev/null; rc=$?
is "nothing to go on → waits --interval" "$rc$(clock)" "0$((T0 + 1200))"

section "a REVIEWS.md whose reviewer hit the limit is no review"
# shellcheck source=../lib/common.sh
. "$PKG/lib/common.sh"
RV="$WORK/07-REVIEWS.md"
review() { printf -- '---\nphase: 7\nreviewers: [codex]\n---\n\n# Cross-AI Plan Review — Phase 7\n\n## Codex Review\n\n%s\n\n---\n\n## Consensus Summary\n\nok\n' "$1" > "$RV"; }
review "$(printf 'Strong plan.\n\n### Concerns\n- HIGH: x')"
gsd_reviews_problem "$RV" codex > /dev/null; is "a real Codex review is usable" "$?" 1
review ""
is "an empty Codex section is not" "$(gsd_reviews_problem "$RV" codex)" "Codex Review is empty"
review "ERROR: You${RSQ}ve hit your usage limit. Try again at Oct 11th, 2026 1:22 AM."
is "a Codex section with only the limit error is not" "$(gsd_reviews_problem "$RV" codex)" "Codex Review — usage limit hit"
review "$(printf 'Line one.\nLine two.\nLine three.\nLine four.\nLine five.\nQuotes the message: hit your usage limit.')"
gsd_reviews_problem "$RV" codex > /dev/null; is "a long review that quotes the message is usable" "$?" 1
printf '## Claude Review\n\nGood.\n\n## Codex Review\n\nCodex review failed or returned empty output.\n' > "$RV"
is "configured reviewer failed, another ok → not usable" "$(gsd_reviews_problem "$RV" codex)" "Codex Review — reviewer failed"
gsd_reviews_problem "$RV" claude > /dev/null; is "…but fine when claude is the configured reviewer" "$?" 1
# gsd-core names reviewer instances: "## Codex Review (fast)"
printf '## Claude Review\n\nGood.\n\n## Codex Review (fast)\n\nCodex review failed or returned empty output.\n' > "$RV"
is "an instance section counts as its reviewer's" "$(gsd_reviews_problem "$RV" codex)" "Codex Review (fast) — reviewer failed"
printf '## Codex Review (fast)\n\n\n## Codex Review (deep)\n\n' > "$RV"
is "…and every instance empty is not usable" "$(gsd_reviews_problem "$RV" claude)" "Codex Review (fast) is empty"
printf '## Codex Review (fast)\n\nLooks fine.\n' > "$RV"
gsd_reviews_problem "$RV" codex > /dev/null; is "…a real instance review is usable" "$?" 1
: > "$RV"; gsd_reviews_problem "$RV" codex > /dev/null; is "a hand-recorded file without sections is not judged" "$?" 1
gsd_reviews_problem "$WORK/none.md" codex > /dev/null; is "a missing file is not judged here" "$?" 1

section "a review body runs on past its own ## headings and ---"
usable() { gsd_reviews_problem "$RV" codex > /dev/null; is "$1" "$?" 1; }
rejected() { is "$1" "$(gsd_reviews_problem "$RV" codex)" "$2"; }
LONG=$(printf 'a\nb\nc\nd\ne\nf\ng')
# the layout gsd-core's template asks for: one ## section per plan id
printf '## Codex Review\n\n## 30-01\nx\ny\n\n---\n\n## 30-02\nz\n\n---\n\n## Consensus Summary\n\nok\n' > "$RV"
usable "## plan sections under the review are usable"
printf '## Codex Review\n\n### 30-01\nx\n\n### 30-02\nz\n\n---\n\n## Consensus Summary\n\nok\n' > "$RV"
usable "### plan sections are usable"
printf '## Codex Review (fast)\n\n## 30-01\nx\n\n## 30-02\ny\n' > "$RV"
usable "an instance heading with ## plan sections is usable"
printf '## Codex Review\n\n## Summary\nx\n\n## Concerns\ny\n' > "$RV"
usable "a reviewer's own ## Summary first is usable"
printf '## Codex Review\n\n## 30-01 Code Review\nx\ny\n\n## Plan 30-02 Review\nz\n' > "$RV"
usable "a plan heading ending in Review stays in the body"
printf '## Codex Review\n\n---\n\n## 30-01\nx\ny\n' > "$RV"
usable "a --- before the first plan section is usable"
printf '## Codex Review\n\nAn earlier run hit your usage limit.\n\n---\n\n%s\n' "$LONG" > "$RV"
usable "a --- does not cut a long body that quotes the limit"
printf '## Codex Review\n\n---\n\n## Consensus Summary\n\nok\n' > "$RV"
rejected "nothing but the template's --- is empty" "Codex Review is empty"
printf '## Codex Review\n\n## Consensus Summary (one reviewer)\n\n%s\n' "$LONG" > "$RV"
rejected "the consensus text is not the review's body" "Codex Review is empty"
printf '## Codex Review\n\n## 30-01\n## 30-02\n## 30-03\n## 30-04\n## 30-05\n## 30-06\n\n---\n' > "$RV"
rejected "## headings with no findings are empty" "Codex Review is empty"
printf '## Codex Review\n\n### 30-01\n### 30-02\n\n---\n' > "$RV"
rejected "### headings with no findings are empty" "Codex Review is empty"
printf '## Codex Review\n\n## 30-01\nYou hit your usage limit.\n\n---\n\n## Consensus Summary\n\nok\n' > "$RV"
rejected "a limit message under a plan heading is the limit" "Codex Review — usage limit hit"
printf '## Claude Review\n\n## 30-01\ngood\n\n---\n\n## Codex Review\n\nCodex review failed or returned empty output.\n\n---\n' > "$RV"
rejected "two reviewers, the configured one failed" "Codex Review — reviewer failed"
# notes people add after a review section must not count as its body
printf '## Codex Review\n\n---\n\n## Verification\n\n%s\n' "$LONG" > "$RV"
rejected "an empty review followed by --- and notes is empty" "Codex Review is empty"
printf '## Codex Review\n\nCodex review failed or returned empty output.\n\n---\n\n## Verification\n\n%s\n' "$LONG" > "$RV"
rejected "a failed review followed by --- and notes failed" "Codex Review — reviewer failed"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
