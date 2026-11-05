#!/usr/bin/env bash
#
# test-worktree-guard.sh — the guard's phase-flow rule (`flow = strict`).
#
# Builds a throwaway repo with a phase worktree branch checked out, feeds the
# guard the PreToolUse(Skill) payload Claude Code sends, and asserts exit codes:
# 0 = allowed, 2 = blocked. The rule is opt-in, so the first section proves a
# repo WITHOUT `flow = strict` is untouched.
#
# Run:  tests/test-worktree-guard.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
GUARD="$PKG/bin/gsd-worktree-guard"

PASS=0; FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ok()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; }
section() { printf '\n%s\n' "$1"; }

# guard <skill> <args> → exit code
guard() {
  printf '{"tool_name":"Skill","tool_input":{"skill":"%s","args":"%s"}}' "$1" "$2" \
    | CLAUDE_PROJECT_DIR="$REPO" "$GUARD" >/dev/null 2>"$WORK/err"
  echo $?
}
allowed() { local rc; rc=$(guard "$2" "$3"); if [ "$rc" = 0 ]; then ok "$1"; else bad "$1" "exit $rc: $(cat "$WORK/err")"; fi; }
blocked() { local rc; rc=$(guard "$2" "$3"); if [ "$rc" = 2 ]; then ok "$1"; else bad "$1" "expected block (2), got $rc"; fi; }

# A repo on a phase-7 branch with an empty phase dir. `install = none` keeps
# rule 3 (deps installed) out of the picture.
mkrepo() {  # $1=flow value ('' = unset)  $2=branch  $3=phase dir name
  REPO="$WORK/$RANDOM"; mkdir -p "$REPO"
  git -C "$REPO" init -q -b develop
  git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  { echo "base = develop"; echo "install = none"; [ -n "$1" ] && echo "flow = $1"; } > "$REPO/.gsd.conf"
  git -C "$REPO" checkout -q -b "$2"
  PDIR="$REPO/.planning/phases/$3"; mkdir -p "$PDIR"
}

section "flow unset — the rule is opt-in, nothing is blocked"
mkrepo "" phase-7-thing 07-thing
allowed "plan-phase without CONTEXT passes"     gsd-plan-phase    "7"
allowed "execute-phase without REVIEWS passes"  gsd-execute-phase "7"
allowed "secure-phase without REVIEW passes"    gsd-secure-phase  "7"

section "flow = strict — plan-phase needs discuss"
mkrepo strict phase-7-thing 07-thing
blocked "plan-phase without CONTEXT is blocked"  gsd-plan-phase "7"
allowed "plan-phase --prd skips discuss"         gsd-plan-phase "7 --prd docs/x.md"
: > "$PDIR/07-CONTEXT.md"
allowed "plan-phase with CONTEXT passes"         gsd-plan-phase "7"
allowed "a number inside a path is not the phase" gsd-plan-phase "--files src/v2/a.ts"
blocked "…but a real other phase number still is" gsd-plan-phase "2 --files src/v7/a.ts"
allowed "discuss-phase itself is never gated"    gsd-discuss-phase "7"

section "flow = strict — execute-phase needs the cross-AI review"
blocked "execute without REVIEWS is blocked"     gsd-execute-phase "7"
allowed "execute --gaps-only skips it"           gsd-execute-phase "7 --gaps-only"
printf '## Codex Review\n\nCodex review failed or returned empty output.\n' > "$PDIR/07-REVIEWS.md"
blocked "execute with a failed Codex review is blocked" gsd-execute-phase "7"
printf '## Codex Review\n\n' > "$PDIR/07-REVIEWS.md"
blocked "execute with an empty Codex section is blocked" gsd-execute-phase "7"
printf '## Codex Review\n\n## 07-01\nfinding\n\n---\n\n## Consensus Summary\n\nok\n' > "$PDIR/07-REVIEWS.md"
allowed "execute with ## plan sections in the review passes" gsd-execute-phase "7"
: > "$PDIR/07-REVIEWS.md"
allowed "execute with REVIEWS passes"            gsd-execute-phase "7"

section "flow = strict — secure-phase is the last gate"
blocked "secure without REVIEW is blocked"       gsd-secure-phase "7"
: > "$PDIR/07-REVIEW.md"
blocked "secure without the test audit is blocked" gsd-secure-phase "7"
printf -- '---\nnyquist_compliant: false\n---\n' > "$PDIR/07-VALIDATION.md"
blocked "secure with the plan's draft VALIDATION is blocked" gsd-secure-phase "7"
mkdir -p "$REPO/.planning"; printf '{"workflow":{"nyquist_validation":false}}' > "$REPO/.planning/config.json"
allowed "secure with nyquist_validation off passes" gsd-secure-phase "7"
rm "$REPO/.planning/config.json"
printf -- '---\nnyquist_compliant: true\n---\n' > "$PDIR/07-VALIDATION.md"
allowed "secure with REVIEW + audit, no screens, passes" gsd-secure-phase "7"
allowed "validate-phase itself is never gated"   gsd-validate-phase "7"
: > "$PDIR/07-UI-SPEC.md"
blocked "secure with UI-SPEC but no UI-REVIEW is blocked" gsd-secure-phase "7"
: > "$PDIR/07-UI-REVIEW.md"
allowed "secure with UI-REVIEW passes"           gsd-secure-phase "7"

section "flow = strict — decimal phases and fresh claims"
mkrepo strict phase-7.1-fix 7.1-fix
blocked "7.1 plan-phase without CONTEXT is blocked" gsd-plan-phase "7.1"
: > "$PDIR/7.1-CONTEXT.md"
allowed "7.1 plan-phase with CONTEXT passes"        gsd-plan-phase "7.1"
mkrepo strict phase-8-new 08-new; rmdir "$PDIR"
blocked "missing phase dir cannot bypass discuss gate" gsd-plan-phase "8"
allowed "fresh phase can still discuss" gsd-discuss-phase "8"
GSD_SKIP_GUARD=1 allowed "GSD_SKIP_GUARD=1 bypasses"  gsd-plan-phase "8"
GSD_SKIP_GUARD=0 blocked "GSD_SKIP_GUARD=0 does not bypass" gsd-plan-phase "8"

section "flow = strict — zero-padded phase numbers (08/09 are not octal)"
mkrepo strict phase-8-pad 08-pad; : > "$PDIR/08-CONTEXT.md"
allowed "plan-phase 08 in phase-8 worktree passes"  gsd-plan-phase "08"
allowed "plan-phase 8 finds the 08-* dir"           gsd-plan-phase "8"
mkrepo strict phase-09-legacy 09-legacy; : > "$PDIR/09-CONTEXT.md"
allowed "phase from a phase-09-* branch pads correctly" gsd-plan-phase ""

section "flow = strict — gsd-core decimal inserts are zero-padded (02.1)"
mkrepo strict phase-02.1-hotfix 02.1-hotfix
blocked "02.1 plan-phase without CONTEXT is blocked"   gsd-plan-phase "02.1"
: > "$PDIR/02.1-CONTEXT.md"
allowed "02.1 plan-phase with CONTEXT passes"          gsd-plan-phase "02.1"
allowed "2.1 names the same phase as 02.1"             gsd-plan-phase "2.1"
allowed "phase taken from a phase-02.1-* branch"       gsd-discuss-phase ""
blocked "02.2 is still another phase"                  gsd-plan-phase "02.2"

section "flow = strict — policy comes from the MAIN checkout, not the worktree copy"
mkrepo "" phase-7-thing 07-thing          # branch carries NO flow key
git -C "$REPO" -c user.email=t@t -c user.name=t add -A >/dev/null 2>&1
git -C "$REPO" -c user.email=t@t -c user.name=t commit -q -m wt >/dev/null 2>&1
MAIN="$REPO"; WT="$WORK/wt-$RANDOM"
git -C "$MAIN" checkout -q develop
echo "flow = strict" >> "$MAIN/.gsd.conf"   # main turns it on later
git -C "$MAIN" worktree add -q "$WT" phase-7-thing
REPO="$WT"; PDIR="$WT/.planning/phases/07-thing"; mkdir -p "$PDIR"
blocked "old worktree (no flow key in its .gsd.conf) is still gated" gsd-plan-phase "7"

section "flow = strict — the older rules still fire first"
mkrepo strict phase-7-thing 07-thing
blocked "wrong phase worktree is still blocked"  gsd-plan-phase "9"

section "install completion never bypasses strict gates"
printf 'base = develop\nflow = strict\ninstall = npm install\n' > "$REPO/.gsd.conf"
echo ok > "$REPO/.gsd-install.status"
blocked "install ok still requires review" gsd-execute-phase "7"
: > "$PDIR/07-REVIEWS.md"
allowed "install ok and review permit execution" gsd-execute-phase "7"
mkdir -p "$REPO/node_modules"
echo running > "$REPO/.gsd-install.status"
blocked "partial node_modules cannot bypass running install" gsd-execute-phase "7"
echo fail > "$REPO/.gsd-install.status"
blocked "node_modules cannot bypass failed install" gsd-execute-phase "7"
echo ok > "$REPO/.gsd-install.status"
blocked "review in wrong phase is blocked" gsd-review "--phase 9 --codex"
blocked "flow in wrong phase is blocked" gsd-flow "9"
blocked "…by its skill name gsdt-flow too" gsdt-flow "9"
blocked "…and by its pre-0.8.0 name gsdw-flow" gsdw-flow "9"
blocked "a plugin-namespaced skill (gsd-core:gsd-review) is guarded" gsd-core:gsd-review "--phase 9 --codex"
blocked "omitted phase still enforces discuss gate" gsd-plan-phase ""
git -C "$REPO" checkout -q -b agent-untrusted
blocked "agent branch name alone is not an exemption" gsd-execute-phase "7"

section "nested workers retain phase checks"
git -C "$REPO" checkout -q phase-7-thing
git -C "$REPO" add .
git -C "$REPO" -c user.name=t -c user.email=t@t commit -qm artifacts
PARENT=$REPO
NESTED="$PARENT/.claude/worktrees/worker"
git -C "$PARENT" worktree add -q -b agent-nested "$NESTED"
REPO=$NESTED; PDIR="$REPO/.planning/phases/07-thing"
allowed "nested worker in same repository inherits phase" gsd-execute-phase "7"
blocked "nested worker cannot target another phase" gsd-execute-phase "9"
rm "$PDIR/07-REVIEWS.md"
blocked "nested worker still requires strict review" gsd-execute-phase "7"

section "ui_gates — warn (default) never blocks"
mkrepo "" phase-5-shop 05-shop
allowed "ui-phase without DESIGN/LAYOUT passes" gsd-ui-phase  "5"
allowed "ui-review without SHOTS passes"        gsd-ui-review "5"

section "ui_gates = strict — ui-phase needs the design system and a chosen layout"
echo "ui_gates = strict" >> "$REPO/.gsd.conf"
blocked "no DESIGN.md → blocked"                 gsd-ui-phase "5"
grep -q 'DESIGN.md' "$WORK/err" && ok "…the message names DESIGN.md" || bad "…the message names DESIGN.md" "$(cat "$WORK/err")"
mkdir -p "$REPO/.planning/design"; printf '# Design\n<!-- gsd:design-stub -->\n' > "$REPO/.planning/design/DESIGN.md"
blocked "stub DESIGN.md → blocked"               gsd-ui-phase "5"
printf '# Design\ntokens\n' > "$REPO/.planning/design/DESIGN.md"
blocked "filled DESIGN.md, no LAYOUT → blocked"  gsd-ui-phase "5"
printf 'sketch: .planning/sketches/001-shop\npages: /\n' > "$PDIR/05-LAYOUT.md"
mkdir -p "$REPO/.planning/sketches/001-shop"; printf -- '---\nwinner: null\n---\n' > "$REPO/.planning/sketches/001-shop/README.md"
blocked "sketch without a winner → blocked"      gsd-ui-phase "5"
printf -- '---\nwinner: A\n---\n' > "$REPO/.planning/sketches/001-shop/README.md"
allowed "design + chosen sketch + pages → allowed" gsd-ui-phase "5"
printf 'sketch: skip one button\n' > "$PDIR/05-LAYOUT.md"
allowed "sketch: skip <reason> → allowed"        gsd-ui-phase "5"

section "ui_gates = strict — ui-review needs the check, the look and the approval"
# shellcheck source=ui-fixture.sh
. "$(dirname "$0")/ui-fixture.sh"
blocked_why() {  # label, text the block must carry
  out=$("$GUARD" --command gsd-ui-review --phase 5 --repo "$REPO" 2>&1); rc=$?
  if [ "$rc" = 2 ] && printf '%s' "$out" | grep -q -- "$2"; then ok "$1"; else bad "$1" "exit $rc: $out"; fi
}
blocked_why "no UI-CHECK.md → blocked, run gsd-ui check"   "Run: gsd-ui check 5"
printf 'taken: now\n' > "$PDIR/05-SHOTS.md"
blocked_why "0.3.x SHOTS.md alone → still blocked"         "never checked"
rm "$PDIR/05-SHOTS.md"
ui_fix_check "$PDIR" 05 failed
blocked_why "a failed check → blocked"                     "the check found 2 problem"
ui_fix_check "$PDIR" 05 passed cap1 0000000000000000000000000000000000000000
blocked_why "code changed after the check → blocked"       "the code or 05-LAYOUT.md changed after the last check"
ui_fix_check "$PDIR" 05 passed
blocked_why "check passed, no look → blocked"              "Run: gsd-ui look 5"
ui_fix_look "$PDIR" 05 cap1 ok "R1 R2"
blocked_why "a look with rules deleted → blocked"          "lines without an answer"
ui_fix_look "$PDIR" 05
blocked_why "look complete, no approval → blocked"         "the user has not approved"
ui_fix_approval "$PDIR" 05 cap0
blocked_why "an approval of older pictures → blocked"      "approved older pictures"
ui_fix_approval "$PDIR" 05
allowed "check + look + approval → allowed"      gsd-ui-review "5"
printf -- '---\nstatus: skipped\nskipped: no browser here\n---\n' > "$PDIR/05-UI-CHECK.md"
blocked_why "a skipped check needs a waived approval"      "approved older pictures"
printf -- '---\nstatus: waived\nreason: no browser here\n---\n' > "$PDIR/05-UI-APPROVAL.md"
allowed "skipped check + waived approval → allowed" gsd-ui-review "5"
allowed "other commands are not UI-gated"        gsd-plan-phase "5"
rm "$PDIR/05-UI-CHECK.md" "$PDIR/05-UI-LOOK.md" "$PDIR/05-UI-APPROVAL.md"
rc=$(GSD_SKIP_GUARD=1 "$GUARD" --command gsd-ui-review --phase 5 --repo "$REPO" 2>/dev/null; echo $?)
[ "$rc" = 0 ] && ok "GSD_SKIP_GUARD=1 still escapes" || bad "GSD_SKIP_GUARD=1 still escapes" "rc=$rc"

section "rule 0 — /gsd-new-project only after gsd-init (--global = the user-level hook)"
# gg <payload> [extra guard args] → exit code; no project dir in the env, so
# the payload's cwd decides, as in a user hook
gg() { local p=$1; shift; printf '%s' "$p" | env -u CLAUDE_PROJECT_DIR "$GUARD" --global "$@" >/dev/null 2>"$WORK/err"; echo $?; }
gis() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected $3, got $2: $(cat "$WORK/err")"; fi; }
BARE="$WORK/bare-$RANDOM"; mkdir -p "$BARE"; git -C "$BARE" init -q -b main
upe() { printf '{"hook_event_name":"UserPromptExpansion","expansion_type":"slash_command","command_name":"%s","command_args":"","cwd":"%s","prompt":"/%s"}' "$1" "$2" "$1"; }
skl() { printf '{"tool_name":"Skill","tool_input":{"skill":"%s","args":""},"cwd":"%s"}' "$1" "$2"; }
gis "typed /gsd-new-project in a repo without .gsd.conf → blocked"  "$(gg "$(upe gsd-new-project "$BARE")")" 2
grep -q "Run gsd-init" "$WORK/err" && ok "…and says to run gsd-init" || bad "…and says to run gsd-init" "$(cat "$WORK/err")"
gis "the namespaced /gsd:new-project → blocked too"                 "$(gg "$(upe gsd:new-project "$BARE")")" 2
gis "the Skill tool calling gsd-ingest-docs → blocked"              "$(gg "$(skl gsd-ingest-docs "$BARE")")" 2
gis "…in its plugin form gsd-core:gsd-ingest-docs → blocked"        "$(gg "$(skl gsd-core:gsd-ingest-docs "$BARE")")" 2
gis "a subdirectory of that repo → blocked"                         "$(mkdir -p "$BARE/src" && gg "$(upe gsd-new-project "$BARE/src")")" 2
gis "other GSD commands in a non-toolkit repo → allowed"            "$(gg "$(upe gsd-plan-phase "$BARE")")" 0
gis "non-GSD commands → allowed"                                    "$(gg "$(upe review "$BARE")")" 0
gis "an unreadable payload → allowed (fails open)"                  "$(gg 'not json')" 0
# a hook an older release left in ~/.gemini: its payload is not read any more
gis "an old Gemini activate_skill payload → allowed (Gemini is gone)" "$(gg '{"tool_name":"activate_skill","tool_input":{"name":"gsd-new-project"}}')" 0
# <<< not a pipe: the guard exits before reading, and a late write into the
# closed pipe failed the test under pipefail (macOS CI)
gis "GSD_SKIP_GUARD=1 escapes"                     "$(GSD_SKIP_GUARD=1 "$GUARD" --global 2>/dev/null <<<"$(upe gsd-new-project "$BARE")"; echo $?)" 0
printf 'install = none\n' > "$BARE/.gsd.conf"
gis "after gsd-init (.gsd.conf) → allowed"                          "$(gg "$(upe gsd-new-project "$BARE")")" 0
mkrepo "" phase-7-thing 07-thing
gis "--global skips the phase rules (plan-phase on a phase branch)" "$(gg "$(upe gsd-plan-phase "$REPO")")" 0
allowed "the repo hook: new-project in a set-up repo passes"        gsd-new-project ""
NOJQ="$WORK/no-jq"; mkdir -p "$NOJQ"
for c in bash cat dirname sed head grep git python3 tr awk env readlink; do ln -sf "$(command -v "$c")" "$NOJQ/$c"; done
rm -f "$BARE/.gsd.conf"
gis "no jq: the Python reader takes the cwd too → blocked" "$(printf '%s' "$(upe gsd-new-project "$BARE")" | PATH="$NOJQ" env -u CLAUDE_PROJECT_DIR "$GUARD" --global >/dev/null 2>"$WORK/err"; echo $?)" 2
# the flow skill by both names (gsdw-flow: a session started before 0.8.0)
for fs in gsdt-flow gsdw-flow; do
  r=$(skl "$fs" "$BARE" | python3 "$PKG/lib/gsd_hook_payload.py" --claude | tr '\0' ' ' | cut -d' ' -f1-2); [ "$r" = "guard gsd-flow" ] && ok "the Python reader maps $fs to gsd-flow" || bad "the Python reader maps $fs to gsd-flow" "got: $r"
done

section "rule 0b — GSD skills that clash with the worktree model (set-up repos)"
mkrepo "" phase-7-thing 07-thing
says() { grep -q -- "$1" "$WORK/err" && ok "…$2" || bad "…$2" "$(cat "$WORK/err")"; }
blocked "/gsd-autonomous is blocked"              gsd-autonomous ""
says "gsd-start" "and names gsd-start instead"
blocked "/gsd-manager is blocked"                 gsd-manager ""
blocked "/gsd-workspace is blocked"               gsd-workspace "--new feature"
blocked "/gsd-workstreams is blocked"             gsd-workstreams "create x"
blocked "/gsd-phase (add) is blocked"             gsd-phase "checkout flow"
says 'gsd-start -n' "and names gsd-start -n"
blocked "/gsd-phase --insert is blocked"          gsd-phase "--insert 7 hotfix"
says 'gsd-start --insert' "and names gsd-start --insert"
blocked "/gsd-phase --remove is blocked"          gsd-phase "--remove 9"
says 'renumbers' "and says why"
git -C "$REPO" checkout -q develop
allowed "/gsd-phase --edit on the base passes"    gsd-phase "--edit 7"
blocked "…but --remove with --edit is still blocked" gsd-phase "--remove 3 --edit"
blocked "…and --edit --insert is still blocked" gsd-phase "--edit --insert 3 x"
blocked "/gsd-autonomous on the base is blocked too" gsd-autonomous ""
GSD_SKIP_GUARD=1 allowed "GSD_SKIP_GUARD=1 escapes"  gsd-autonomous ""
git -C "$REPO" checkout -q phase-7-thing
blocked "/gsd-phase --edit off the base is blocked (rule 1)" gsd-phase "--edit 7"
gis "--global: typed /gsd-autonomous in a set-up repo → blocked" "$(gg "$(upe gsd-autonomous "$REPO")")" 2
git -C "$REPO" checkout -q develop
gis "--global: typed feature work on the base of a set-up repo → blocked (all rules apply)" "$(gg "$(upe gsd-discuss-phase "$REPO")")" 2
gis "--global: /gsd-autonomous in a repo without .gsd.conf → allowed" "$(gg "$(upe gsd-autonomous "$BARE")")" 0

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
