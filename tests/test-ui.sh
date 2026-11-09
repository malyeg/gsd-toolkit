#!/usr/bin/env bash
# test-ui.sh — the UI quality gates outside the flow engine: the gsd-ui command
# (design, layout, shots with a stub Playwright and a local web server, the
# port slot, --skip, status; check / look / approve / sheet with a stub
# runner), the finish gate, gsd-doctor's UI checks (T080, T081, T018, the UI
# debt of merged phases) and gsd-bootstrap-repo --no-ui / the instruction
# text. The flow steps are in test-flow-next.sh, the strict guard rules in
# test-worktree-guard.sh, and the real runner in test-ui-browser.sh.
set -uo pipefail
PKG=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d); WORK=$(cd "$WORK" && pwd -P)
SERVER=""
cleanup() { [ -z "$SERVER" ] || { kill "$SERVER"; wait "$SERVER"; } 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
export HOME="$WORK/home"; mkdir -p "$HOME"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GSD_NO_UPDATE_CHECK=1 GSD_CLAUDE_SKILL_DIR="$WORK/skills"
unset GSD_PLAYWRIGHT GSD_PLAYWRIGHT_ROOT GSD_UI_RUNNER GSD_UI_BUDGET_MS GSD_SKIP_GUARD GSD_TRACKER
# The machine's own global npm folder must not change the results.
export GSD_NPM_GLOBAL_ROOT="$WORK/global/node_modules"
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '%s\n' "$2" | sed 's/^/      /'; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
has() { if grep -q -- "$2" "$3"; then ok "$1"; else bad "$1" "$(tail -6 "$3")"; fi; }
hasnt() { if grep -q -- "$2" "$3"; then bad "$1" "$(grep -- "$2" "$3" | head -3)"; else ok "$1"; fi; }
section() { printf '\n%s\n' "$1"; }
# …nor a playwright command on PATH (an nvm/npm global bin): drop those dirs,
# keeping node itself, which gsd-ui check asks for.
mkdir -p "$WORK/keep-bin"
for c in node npm npx; do p=$(command -v "$c" 2>/dev/null) && ln -s "$p" "$WORK/keep-bin/$c"; done
clean=""; oldifs=$IFS; IFS=:
for d in $PATH; do [ -x "$d/playwright" ] || clean="${clean:+$clean:}$d"; done
IFS=$oldifs
export PATH="$PKG/bin:$clean:$WORK/keep-bin"
PY=$(command -v python3 || command -v python)
OUT="$WORK/out"

# A stub Playwright CLI: `screenshot --viewport-size=W,H --full-page URL FILE`
# writes FILE and logs the call.
STUB="$WORK/stub"; mkdir -p "$STUB"
cat > "$STUB/playwright" <<'EOF'
#!/bin/sh
echo "$*" >> "$(dirname "$0")/calls.log"
[ "$1" = screenshot ] || exit 1
for a; do last=$a; done
echo png > "$last"
EOF
chmod +x "$STUB/playwright"

# A GSD repo on a phase-5 worktree branch. The app's dev script derives its
# port from a base, the way projects wire gsd-derive-port.
R="$WORK/app"; git init -q -b develop "$R"
BASEPORT=$(( 20000 + RANDOM % 9000 )); PORT=$((BASEPORT + 5))
printf '{ "scripts": { "dev": "PORT=$(bash ../../scripts/gsd-derive-port.sh %s) next dev" } }\n' "$BASEPORT" > "$R/package.json"
mkdir -p "$R/.planning/phases/05-shop"
printf '# Roadmap\n\n### Phase 5: Shop\n' > "$R/.planning/ROADMAP.md"
printf 'base = develop\ninstall = none\n' > "$R/.gsd.conf"
git -C "$R" add -A && git -C "$R" commit -qm init
git -C "$R" checkout -q -b phase-5-shop
PD="$R/.planning/phases/05-shop"

section "gsd-ui design"
(cd "$R" && gsd-ui design) > "$OUT" 2>&1
has "creates the stub" "stub) and .planning/design/refs/ created" "$OUT"
[ -f "$R/.planning/design/refs/.gitkeep" ] && ok "refs/ is kept in git" || bad "refs/ is kept in git"
grep -q 'gsd:design-stub' "$R/.planning/design/DESIGN.md" && ok "stub carries the marker" || bad "stub carries the marker"
has "stub: start from a real design system" "styles.refero.design" "$R/.planning/design/DESIGN.md"
has "stub: pick fonts on purpose" "fontshare.com" "$R/.planning/design/DESIGN.md"
has "stub: take tested parts" "21st.dev" "$R/.planning/design/DESIGN.md"
has "stub: the layout rules R1–R10" "^- R10: Matches the chosen sketch" "$R/.planning/design/DESIGN.md"
echo "## Tokens: ours" > "$R/.planning/design/DESIGN.md"
(cd "$R" && gsd-ui design) > "$OUT" 2>&1
has "a filled DESIGN.md is left alone" "is filled" "$OUT"
is "…and not overwritten" "$(cat "$R/.planning/design/DESIGN.md")" "## Tokens: ours"

section "gsd-ui layout"
(cd "$R" && gsd-ui layout) > "$OUT" 2>&1
has "phase from the branch; creates LAYOUT" "05-LAYOUT.md created" "$OUT"
grep -q '^sketch:' "$PD/05-LAYOUT.md" && grep -q '^pages:' "$PD/05-LAYOUT.md" && grep -q '^url:' "$PD/05-LAYOUT.md" && ok "template has sketch:, pages: and url:" || bad "template has sketch:, pages: and url:"
echo "pages: /, /cart" > "$PD/05-LAYOUT.md"
(cd "$R" && gsd-ui layout 5) > "$OUT" 2>&1
has "an existing LAYOUT is not overwritten" "already exists" "$OUT"
is "…content kept" "$(cat "$PD/05-LAYOUT.md")" "pages: /, /cart"
(cd "$R" && gsd-ui layout 9) > "$OUT" 2>&1; is "no phase folder → exit 1" "$?" 1

section "gsd-ui shots — refusals"
(cd "$R" && gsd-ui shots 5) > "$OUT" 2>&1; rc=$?
is "no Playwright → exit 1" "$rc" 1
has "…says how to install it" "npm i -D playwright" "$OUT"
export GSD_PLAYWRIGHT="$STUB/playwright"
(cd "$R" && gsd-ui shots 5) > "$OUT" 2>&1; rc=$?
is "nothing listening → exit 1" "$rc" 1
has "…names the derived address" "nothing answers at http://localhost:$PORT" "$OUT"
[ ! -f "$PD/05-SHOTS.md" ] && ok "…and records nothing" || bad "…and records nothing"

section "gsd-ui shots — against a running app"
mkdir -p "$WORK/site/cart"; echo home > "$WORK/site/index.html"; echo cart > "$WORK/site/cart/index.html"
(cd "$WORK/site" && exec "$PY" -m http.server "$PORT" --bind 127.0.0.1) >/dev/null 2>&1 &
SERVER=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do curl -s -o /dev/null "http://localhost:$PORT/" && break; sleep 0.3; done
(cd "$R" && gsd-ui shots 5) > "$OUT" 2>&1; rc=$?
is "shots succeed" "$rc" 0
has "2 pages × 3 sizes" "6 screenshot(s)" "$OUT"
for f in home-375 home-768 home-1440 cart-375 cart-768 cart-1440; do
  ls "$PD/05-SHOTS/$f"-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].png >/dev/null 2>&1 || bad "missing $f-<hash>.png"
done
is "files named <page>-<width>-<hash>.png" "$(basename "$(ls "$PD/05-SHOTS"/cart-1440-*.png)")" "cart-1440-$(printf /cart | git hash-object --stdin | cut -c1-6).png"
grep -q -- "--viewport-size=375,812 --full-page http://localhost:$PORT/cart " "$STUB/calls.log" && ok "calls the CLI with size, full page, url" || bad "calls the CLI with size, full page, url" "$(head -2 "$STUB/calls.log")"
has "SHOTS.md records the url" "url: http://localhost:$PORT" "$PD/05-SHOTS.md"
is "PNGs are ignored by git" "$(cat "$PD/05-SHOTS/.gitignore")" "*"
git -C "$R" add -A
is "…only SHOTS.md is staged, no PNG" "$(git -C "$R" diff --cached --name-only | grep -c '\.png$')" 0
git -C "$R" reset -q

printf 'ui_url = http://127.0.0.1:{port:%s}\n' "$BASEPORT" >> "$R/.gsd.conf"
(cd "$R" && gsd-ui shots 5) > "$OUT" 2>&1
has "{port:<base>} in ui_url" "url: http://127.0.0.1:$PORT" "$PD/05-SHOTS.md"
printf 'base = develop\ninstall = none\nui_url = http://localhost:%s\n' "$PORT" > "$R/.gsd.conf"
(cd "$R" && gsd-ui shots 5) > "$OUT" 2>&1
has "a fixed ui_url works too" "url: http://localhost:$PORT" "$PD/05-SHOTS.md"
printf 'base = develop\ninstall = none\n' > "$R/.gsd.conf"

section "gsd-ui shots — a project with several apps"
mkdir -p "$R/apps/admin"
printf '{ "scripts": { "dev": "PORT=$(bash ../../scripts/gsd-derive-port.sh 3100) next dev" } }\n' > "$R/apps/admin/package.json"
(cd "$R" && gsd-ui shots 5) > "$OUT" 2>&1; rc=$?
is "two base ports, no url → exit 1" "$rc" 1
has "…asks for url: in the phase LAYOUT" "in 05-LAYOUT.md:  url: http://localhost:{port:<base>}" "$OUT"
printf 'pages: /, /cart\nurl: http://localhost:{port:%s}\n' "$BASEPORT" > "$PD/05-LAYOUT.md"
(cd "$R" && gsd-ui shots 5) > "$OUT" 2>&1; rc=$?
is "url: in LAYOUT picks the app" "$rc" 0
has "…with this phase's port" "url: http://localhost:$PORT" "$PD/05-SHOTS.md"
printf 'base = develop\ninstall = none\nui_url = http://localhost:1\n' > "$R/.gsd.conf"
(cd "$R" && gsd-ui shots 5) > "$OUT" 2>&1
is "url: in LAYOUT wins over ui_url" "$?" 0
printf 'pages: /\nurl: http://localhost:{port:x}\n' > "$PD/05-LAYOUT.md"
(cd "$R" && gsd-ui shots 5) > "$OUT" 2>&1
has "a bad slot names where it came from" "url: in 05-LAYOUT.md has a bad" "$OUT"
printf 'base = develop\ninstall = none\n' > "$R/.gsd.conf"; rm -rf "$R/apps"
echo "pages: /, /cart" > "$PD/05-LAYOUT.md"

section "gsd-ui shots --skip and status"
(cd "$R" && gsd-ui shots 5 --skip "no browser on this box") > "$OUT" 2>&1
has "--skip records the reason" "skipped: no browser on this box" "$PD/05-SHOTS.md"
(cd "$R" && gsd-ui status 5) > "$OUT" 2>&1
has "status: gates"       "ui_gates    warn" "$OUT"
has "status: design"      "design      ok" "$OUT"
has "status: layout"      "layout      nosketch" "$OUT"
has "status: screenshots" "screenshots skip" "$OUT"
(cd "$R" && gsd-ui shots 5 --skip) > "$OUT" 2>&1; is "--skip needs a reason" "$?" 1

section "gsd-ui check — with a stub runner"
# The stub stands in for lib/ui-check.mjs: it reads the job file and writes
# what a run writes (test-ui-browser.sh runs the real one in a browser).
cat > "$STUB/runner" <<'EOF'
#!/bin/sh
job=$1; out=$(awk -F'\t' '$1 == "out" {print $2}' "$job")
cp "$job" "$(dirname "$0")/job.last"
case "${STUB_MODE:-pass}" in
  crash) echo "boom" >&2; exit 3 ;;
  cannot) echo "Playwright not found in this project" > "$out/error.txt"; exit 2 ;;
  noreport) echo png > "$out/home-375-aaaaaa.png"; exit 0 ;;
esac
st=passed; rc=0; n=0
[ "${STUB_MODE:-pass}" = fail ] && { st=failed; rc=1; n=1; }
echo "png ${STUB_CAP:-capA}" > "$out/home-375-aaaaaa.png"; echo html > "$out/index.html"
{ printf -- '---\nstatus: %s\ncapture: %s\ncode: %s\n' "$st" "${STUB_CAP:-capA}" "$(awk -F'\t' '$1 == "code" {print $2}' "$job")"
  printf 'failures: %s\nwaived: 0\nquestions: 1\nunchecked: 0\n---\n\n## Failures\n\n' "$n"
  [ "$n" = 0 ] && printf 'None.\n' || printf -- '- C4 | / | 375 | span.x | text at 10px\n'
  printf '\n## Questions\n\n- Q1 | / | 375 | C2 | possible clipped text in 1 element(s): div.box "long | text"\n'
  printf '\n## Shots\n\n- / | 375 | home-375-aaaaaa.png\n'; } > "$out/UI-CHECK.md"
exit $rc
EOF
chmod +x "$STUB/runner"
export GSD_UI_RUNNER="$STUB/runner"
job() { awk -F'\t' -v k="$1" '$1 == k {print $2}' "$STUB/job.last"; }
rm -rf "$PD/05-SHOTS" "$PD/05-SHOTS.md"
cat > "$PD/05-LAYOUT.md" <<'EOF'
sketch: skip a test
pages: /, cart
app: apps/web
main_button: / = Start now
main_button: /cart = none
expect: /cart = cart
waive: C3 | * | * | .brand | agreed with the user
EOF
git -C "$R" add -A && git -C "$R" commit -qm layout
(cd "$R" && gsd-ui check 5) > "$OUT" 2>&1; rc=$?
is "a passed run → exit 0" "$rc" 0
has "…says passed and names the capture" "passed — capture capA" "$OUT"
has "…and the next step" "Next: gsd-ui look 5" "$OUT"
is "the report is published" "$(sed -n 's/^status: //p' "$PD/05-UI-CHECK.md")" passed
[ -f "$PD/05-SHOTS/home-375-aaaaaa.png" ] && [ -f "$PD/05-SHOTS/index.html" ] && ok "pictures and sheet are published" || bad "pictures and sheet are published" "$(ls -a "$PD/05-SHOTS")"
[ ! -e "$PD/05-SHOTS/.run" ] && ok "the run folder is gone" || bad "the run folder is gone"
is "pictures are ignored by git" "$(git -C "$R" status --porcelain | grep -c 'SHOTS')" 0
is "job: the phase's address" "$(job url)" "http://localhost:$PORT"
is "job: pages, each with a leading /" "$(job page | tr '\n' ' ')" "/ /cart "
is "job: main_button lines" "$(job main_button | tr '\n' ';')" "/ = Start now;/cart = none;"
is "job: expect and waive lines" "$(job expect)|$(job waive)" "/cart = cart|C3 | * | * | .brand | agreed with the user"
is "job: app: from LAYOUT" "$(job approot)/$(job approot_from)" "apps/web/app: in 05-LAYOUT.md"
is "job: default minimum font" "$(job minfont)" 12
is "job: the global npm folder" "$(job globalroot)" "$WORK/global/node_modules"
is "job: warn → not strict" "$(job strict)" 0
is "job: the pinned axe-core" "$(basename "$(job axe)")/$(job axever)" "axe.min.js/$(cat "$PKG/lib/vendor/axe-core/VERSION")"
is "job: the code + LAYOUT state is recorded" "$(job code)" "$(. "$PKG/lib/common.sh"; . "$PKG/lib/ui.sh"; gsd_ui_code_state "$R")+$(git hash-object "$PD/05-LAYOUT.md")"
printf 'base = develop\ninstall = none\nui_min_font = 14\nui_gates = strict\n' > "$R/.gsd.conf"
(cd "$R" && GSD_PLAYWRIGHT_ROOT=/somewhere gsd-ui check 5) > "$OUT" 2>&1
is "ui_min_font, ui_gates = strict and GSD_PLAYWRIGHT_ROOT reach the job" "$(job minfont)/$(job strict)/$(job approot)" "14/1//somewhere"
printf 'base = develop\ninstall = none\nui_min_font = 99\n' > "$R/.gsd.conf"
(cd "$R" && gsd-ui check 5) > "$OUT" 2>&1
is "an out-of-range ui_min_font falls back to 12" "$(job minfont)" 12
printf 'base = develop\ninstall = none\n' > "$R/.gsd.conf"
(cd "$R" && STUB_MODE=fail gsd-ui check 5) > "$OUT" 2>&1; rc=$?
is "failed checks → exit 1" "$rc" 1
has "…lists the finding" "C4 | / | 375 | span.x | text at 10px" "$OUT"
has "…names the waive: way out" "a waive: line in" "$OUT"
is "…the report says failed" "$(sed -n 's/^status: //p' "$PD/05-UI-CHECK.md")" failed

section "gsd-ui check — a run that could not finish leaves no old pass"
(cd "$R" && gsd-ui check 5) > "$OUT" 2>&1
(cd "$R" && STUB_MODE=cannot gsd-ui check 5) > "$OUT" 2>&1; rc=$?
is "the runner cannot run → exit 2" "$rc" 2
is "…status: error replaces the old pass" "$(sed -n 's/^status: //p' "$PD/05-UI-CHECK.md")" error
has "…with the reason" "error: Playwright not found in this project" "$PD/05-UI-CHECK.md"
is "…the old pictures and sheet are gone" "$(find "$PD/05-SHOTS" -type f ! -name .gitignore | wc -l | tr -d ' ')" 0
(cd "$R" && gsd-ui check 5) > "$OUT" 2>&1
(cd "$R" && STUB_MODE=crash gsd-ui check 5) > "$OUT" 2>&1; rc=$?
is "the runner crashes → exit 2, status error" "$rc/$(sed -n 's/^status: //p' "$PD/05-UI-CHECK.md")" "2/error"
has "…with what it printed" "error: boom" "$PD/05-UI-CHECK.md"
(cd "$R" && STUB_MODE=noreport gsd-ui check 5) > "$OUT" 2>&1; rc=$?
is "exit 0 without a report is not a pass" "$rc/$(sed -n 's/^status: //p' "$PD/05-UI-CHECK.md")" "2/error"
(cd "$R" && gsd-ui check 5) > "$OUT" 2>&1
sed -i.bak 's#^app:.*#url: http://localhost:1#' "$PD/05-LAYOUT.md"; rm -f "$PD/05-LAYOUT.md.bak"
(cd "$R" && gsd-ui check 5) > "$OUT" 2>&1; rc=$?
is "the app is down → exit 2, status error" "$rc/$(sed -n 's/^status: //p' "$PD/05-UI-CHECK.md")" "2/error"
has "…says to start the app" "nothing answers at http://localhost:1" "$OUT"
sed -i.bak '/^url:/d' "$PD/05-LAYOUT.md"; rm -f "$PD/05-LAYOUT.md.bak"
(cd "$R" && gsd-ui status 5) > "$OUT" 2>&1
has "status names the open step" "open        ui-check: the last check could not run" "$OUT"
(cd "$R" && gsd-ui check 5 --skip "the app needs a VPN") > "$OUT" 2>&1
is "--skip records status: skipped" "$(sed -n 's/^status: //p' "$PD/05-UI-CHECK.md")/$(sed -n 's/^skipped: //p' "$PD/05-UI-CHECK.md")" "skipped/the app needs a VPN"
has "…and points at the waiver the user must give" "gsd-ui approve 5 --waive" "$OUT"
(cd "$R" && gsd-ui look 5) > "$OUT" 2>&1; is "look after a skip → exit 1 (no pictures)" "$?" 1
(cd "$R" && gsd-ui approve 5) > "$OUT" 2>&1; is "approve after a skip → exit 1" "$?" 1
has "…asks for --waive" "--waive" "$OUT"
(cd "$R" && gsd-ui approve 5 --waive "the app needs a VPN") > "$OUT" 2>&1
is "approve --waive records the reason" "$(sed -n 's/^status: //p' "$PD/05-UI-APPROVAL.md")/$(sed -n 's/^reason: //p' "$PD/05-UI-APPROVAL.md")" "waived/the app needs a VPN"
(cd "$R" && gsd-ui status 5) > "$OUT" 2>&1
has "skip + waiver → nothing open" "open        nothing" "$OUT"
rm "$PD/05-UI-APPROVAL.md"

section "gsd-ui look and approve"
(cd "$R" && STUB_MODE=fail gsd-ui check 5) > "$OUT" 2>&1
(cd "$R" && gsd-ui look 5) > "$OUT" 2>&1; is "look after a failed check → exit 1" "$?" 1
(cd "$R" && gsd-ui sheet 5) > "$OUT" 2>&1
is "sheet prints the path" "$(cat "$OUT")" "$PD/05-SHOTS/index.html"
(cd "$R" && gsd-ui check 5) > "$OUT" 2>&1
(cd "$R" && gsd-ui look 5) > "$OUT" 2>&1; rc=$?
is "look after a passed check → exit 0" "$rc" 0
has "…10 rules + 1 question for the one picture" "11 line(s) to answer" "$OUT"
is "the look names the capture" "$(sed -n 's/^capture: //p' "$PD/05-UI-LOOK.md")" capA
has "…a section per picture" "^## / at 375px$" "$PD/05-UI-LOOK.md"
has "…with its file" "^picture: 05-SHOTS/home-375-aaaaaa.png$" "$PD/05-UI-LOOK.md"
has "…the question, with its text" 'asks (C2): possible clipped text in 1 element(s): div.box "long | text"' "$PD/05-UI-LOOK.md"
(cd "$R" && gsd-ui status 5) > "$OUT" 2>&1
has "an empty template is open" "look        open" "$OUT"
(cd "$R" && gsd-ui approve 5) > "$OUT" 2>&1; is "approve with an open look → exit 1" "$?" 1
has "…says what is open" "lines without an answer" "$OUT"
sed -i.bak -E 's/^- (R[0-9]+): $/- \1: ok — looks right in the picture/' "$PD/05-UI-LOOK.md"; rm -f "$PD/05-UI-LOOK.md.bak"
(cd "$R" && gsd-ui status 5) > "$OUT" 2>&1
has "rules answered, the question not → still open" "look        open" "$OUT"
sed -i.bak -E 's/^- Q1: $/- Q1: bad — the title is cut off/' "$PD/05-UI-LOOK.md"; rm -f "$PD/05-UI-LOOK.md.bak"
(cd "$R" && gsd-ui status 5) > "$OUT" 2>&1
has "a bad answer keeps it open" "look        bad" "$OUT"
(cd "$R" && gsd-ui look 5) > "$OUT" 2>&1
has "look on the same capture keeps the answers" "is for this capture (capA)" "$OUT"
has "…the file is untouched" "^- Q1: bad — the title is cut off$" "$PD/05-UI-LOOK.md"
(cd "$R" && STUB_CAP=capB gsd-ui check 5) > "$OUT" 2>&1
(cd "$R" && gsd-ui status 5) > "$OUT" 2>&1
has "new pictures → the look is stale" "look        stale" "$OUT"
(cd "$R" && gsd-ui look 5) > "$OUT" 2>&1
is "look on a new capture writes a new template" "$(sed -n 's/^capture: //p' "$PD/05-UI-LOOK.md")" capB
has "…with the old answer beside the line" "^  was: bad — the title is cut off$" "$PD/05-UI-LOOK.md"
has "…and the line itself open again" "^- Q1: $" "$PD/05-UI-LOOK.md"
sed -i.bak -E 's/^- (R[0-9]+): $/- \1: ok — looks right in the picture/; s/^- Q1: $/- Q1: fixed — the title wraps now/' "$PD/05-UI-LOOK.md"; rm -f "$PD/05-UI-LOOK.md.bak"
(cd "$R" && gsd-ui status 5) > "$OUT" 2>&1
has "every line answered → complete" "look        complete" "$OUT"
has "…the approval is the open step" "open        ui-approve: the user has not approved the pages" "$OUT"
(cd "$R" && gsd-ui approve 5) > "$OUT" 2>&1; rc=$?
is "approve → exit 0" "$rc" 0
is "the approval names the capture" "$(sed -n 's/^status: //p' "$PD/05-UI-APPROVAL.md")/$(sed -n 's/^capture: //p' "$PD/05-UI-APPROVAL.md")" "approved/capB"
git -C "$R" add -A && git -C "$R" commit -qm "ui check, look, approval"
(cd "$R" && gsd-ui status 5) > "$OUT" 2>&1
has "after the commit nothing is open" "open        nothing" "$OUT"
(cd "$R" && STUB_CAP=capB gsd-ui check 5) > "$OUT" 2>&1
(cd "$R" && gsd-ui status 5) > "$OUT" 2>&1
has "a new check with the same pictures keeps look and approval" "open        nothing" "$OUT"
cp "$PD/05-LAYOUT.md" "$WORK/layout.saved"; printf 'expect: /cart = basket\n' >> "$PD/05-LAYOUT.md"
(cd "$R" && gsd-ui status 5) > "$OUT" 2>&1
has "a LAYOUT edit after the check → stale" "check       stale" "$OUT"
cp "$WORK/layout.saved" "$PD/05-LAYOUT.md"
(cd "$R" && gsd-ui status 5) > "$OUT" 2>&1
has "…and putting it back undoes that" "open        nothing" "$OUT"
c=$(sed -n 's/^code: //p' "$PD/05-UI-CHECK.md"); sed -i.bak "s/^code: .*/code: ${c%%+*}/" "$PD/05-UI-CHECK.md"; rm -f "$PD/05-UI-CHECK.md.bak"
(cd "$R" && gsd-ui status 5) > "$OUT" 2>&1
has "a check from before (code hash only) still counts" "check       passed" "$OUT"
echo "change" > "$R/page.js"
(cd "$R" && gsd-ui status 5) > "$OUT" 2>&1
has "a code change after the check → stale" "check       stale" "$OUT"
(cd "$R" && gsd-ui look 5) > "$OUT" 2>&1; is "look on a stale check → exit 1" "$?" 1
(cd "$R" && gsd-ui approve 5) > "$OUT" 2>&1; is "approve on a stale check → exit 1" "$?" 1
(cd "$R" && STUB_CAP=capC gsd-ui check 5) > "$OUT" 2>&1
(cd "$R" && gsd-ui status 5) > "$OUT" 2>&1
has "the page changed → look and approval open again" "open        ui-look" "$OUT"
rm "$R/page.js"
git -C "$R" add -f "$PD/05-SHOTS/home-375-aaaaaa.png" >/dev/null 2>&1
(cd "$R" && gsd-ui check 5) > "$OUT" 2>&1
has "committed pictures → a warning" "are committed" "$OUT"
git -C "$R" reset -q
(cd "$R" && gsd-ui look 5 --skip x) > "$OUT" 2>&1; is "--skip does not go with look" "$?" 1
(cd "$R" && gsd-ui check 5 --waive x) > "$OUT" 2>&1; is "--waive does not go with check" "$?" 1
unset GSD_UI_RUNNER

section "gsd-finish — the UI steps must be current"
# shellcheck source=ui-fixture.sh
. "$PKG/tests/ui-fixture.sh"
F="$WORK/fin"; git init -q -b develop "$F"
printf 'base = develop\ninstall = none\ntest = none\nui_gates = strict\n' > "$F/.gsd.conf"
git -C "$F" add -A && git -C "$F" commit -qm init
newphase() {  # $1=N $2=slug → a worktree with a committed phase that has screens
  git -C "$F" worktree add -q -b "phase-$1-$2" "$WORK/fin-worktrees/phase-$1-$2" develop
  FW="$WORK/fin-worktrees/phase-$1-$2"; FPD="$FW/.planning/phases/0$1-$2"; mkdir -p "$FPD"
  : > "$FPD/0$1-UI-SPEC.md"; echo "code $1" > "$FW/page-$1.js"
  git -C "$FW" add -A && git -C "$FW" commit -qm "phase $1"
}
finish() { (cd "$F" && "$@" gsd-wt-finish "$N6") > "$OUT" 2>&1; }
newphase 6 page; N6=6
before=$(git -C "$F" rev-parse develop)
finish env; rc=$?
is "strict, no check → finish refuses" "$rc" 1
has "…names the open step" "UI steps are open (ui_gates = strict): the rendered pages were never checked" "$OUT"
has "…and the command" "gsd-ui check 6" "$OUT"
is "…nothing was merged" "$(git -C "$F" rev-parse develop)" "$before"
[ -d "$FW" ] && ok "…the worktree is kept" || bad "…the worktree is kept"
ui_fix_all "$FPD" 06; git -C "$FW" add -A && git -C "$FW" commit -qm ui
sed -i.bak 's/^code: $/code: 0000000000000000000000000000000000000000/' "$FPD/06-UI-CHECK.md"; rm -f "$FPD/06-UI-CHECK.md.bak"
git -C "$FW" commit -qam "stale check"
finish env; rc=$?
is "strict, code changed after the check → finish refuses" "$rc" 1
has "…says the check is stale" "changed after the last check" "$OUT"
finish env GSD_SKIP_GUARD=1; rc=$?
is "GSD_SKIP_GUARD=1 → finishes" "$rc" 0
has "…and says it skipped the gate" "finishing anyway" "$OUT"
[ -f "$F/page-6.js" ] && ok "…the phase is merged" || bad "…the phase is merged" "$(tail -5 "$OUT")"
printf 'base = develop\ninstall = none\ntest = none\n' > "$F/.gsd.conf"; git -C "$F" commit -qam "warn"
newphase 7 cart; N6=7
finish env; rc=$?
is "warn (default), no check → finishes" "$rc" 0
has "…with a warning" "⚠ phase 7 has screens and its UI steps are open" "$OUT"
printf 'base = develop\ninstall = none\ntest = none\nui_gates = strict\n' > "$F/.gsd.conf"; git -C "$F" commit -qam "strict"
newphase 8 list; N6=8
ui_fix_all "$FPD" 08; git -C "$FW" add -A && git -C "$FW" commit -qm ui
finish env; rc=$?
is "strict, check + look + approval → finishes" "$rc" 0
hasnt "…without a UI message" "UI steps are open" "$OUT"
git -C "$F" worktree add -q -b phase-9-api "$WORK/fin-worktrees/phase-9-api" develop
mkdir -p "$WORK/fin-worktrees/phase-9-api/.planning/phases/09-api"; : > "$WORK/fin-worktrees/phase-9-api/.planning/phases/09-api/09-CONTEXT.md"
git -C "$WORK/fin-worktrees/phase-9-api" add -A && git -C "$WORK/fin-worktrees/phase-9-api" commit -qm "phase 9"
N6=9; finish env; rc=$?
is "strict, a phase without screens → finishes" "$rc" 0

section "gsd-doctor UI checks"
D="$WORK/doc"; git init -q -b develop "$D"
mkdir -p "$D/.planning/phases/03-web" "$D/.planning/phases/04-api"
: > "$D/.planning/phases/03-web/03-UI-SPEC.md"
printf '# Roadmap\n\n### Phase 3: Web\n\n### Phase 4: Api\n' > "$D/.planning/ROADMAP.md"
printf 'base = develop\ninstall = none\n' > "$D/.gsd.conf"
git -C "$D" add -A && git -C "$D" commit -qm init
gsd-doctor --repo "$D" > "$OUT" 2>&1
has "warn: a stub/missing DESIGN.md is a note" "DESIGN.md is missing" "$OUT"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
hasnt "…not a finding" '"T080"' "$OUT"
printf 'ui_gates = strict\nui_url = http://localhost:{port}\n' >> "$D/.gsd.conf"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
has "strict: T080" '"T080"' "$OUT"
hasnt "ui_gates and ui_url are known keys" '"T017"' "$OUT"
mkdir -p "$D/.planning/design"; echo "# filled" > "$D/.planning/design/DESIGN.md"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
hasnt "a filled DESIGN.md → no T080" '"T080"' "$OUT"
printf 'base = develop\ninstall = none\nui_gates = maybe\n' > "$D/.gsd.conf"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
has "a bad ui_gates value → T018" "ui_gates = 'maybe' is not a value" "$OUT"
printf 'base = develop\ninstall = none\nui_gates = off\n' > "$D/.gsd.conf"; rm -rf "$D/.planning/design"
gsd-doctor --repo "$D" > "$OUT" 2>&1
hasnt "ui_gates = off → no UI section" "DESIGN.md" "$OUT"
printf 'base = develop\ninstall = none\nui_min_font = big\n' > "$D/.gsd.conf"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
has "a bad ui_min_font → T018" "ui_min_font = 'big' is not a number" "$OUT"
printf 'base = develop\ninstall = none\nui_min_font = 4\n' > "$D/.gsd.conf"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
has "an out-of-range ui_min_font → T018" "ui_min_font = '4' is out of range" "$OUT"
printf 'base = develop\ninstall = none\nui_min_font = 14\n' > "$D/.gsd.conf"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
hasnt "ui_min_font = 14 is fine" '"T01[78]"' "$OUT"
has "--json lists the notes" '"notes":\[".*DESIGN.md is missing' "$OUT"
has "…the missing Playwright among them" "no Playwright for gsd-ui check" "$OUT"
has "…it says install it once per machine" "npm i -g playwright" "$OUT"
mkdir -p "$WORK/global/node_modules/playwright"; echo '{}' > "$WORK/global/node_modules/playwright/package.json"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
hasnt "a global Playwright → no note" "no Playwright for" "$OUT"
rm -rf "$WORK/global"
mkdir -p "$D/node_modules/@playwright/test"; echo '{}' > "$D/node_modules/@playwright/test/package.json"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
hasnt "a Playwright package on disk → no note (files only, nothing is run)" "no Playwright for" "$OUT"
rm -rf "$D/node_modules"; mkdir -p "$D/apps/web/node_modules/playwright"; echo '{}' > "$D/apps/web/node_modules/playwright/package.json"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
hasnt "…also found in apps/*" "no Playwright for" "$OUT"
rm -rf "$D/apps"
mkdir -p "$D/.planning/phases/03-web/03-SHOTS"; echo png > "$D/.planning/phases/03-web/03-SHOTS/home-375-aaaaaa.png"
git -C "$D" add -A && git -C "$D" commit -qm "pictures committed"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
hasnt "warn: committed pictures are a note…" '"T081"' "$OUT"
has "…that names the folder" "pictures are committed in: .planning/phases/03-web/03-SHOTS" "$OUT"
printf 'base = develop\ninstall = none\nui_gates = strict\n' > "$D/.gsd.conf"
mkdir -p "$D/.planning/design"; echo "# filled" > "$D/.planning/design/DESIGN.md"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
has "strict: committed pictures → T081" '"T081"' "$OUT"
git -C "$D" rm -r -q --cached .planning/phases/03-web/03-SHOTS; rm -rf "$D/.planning/phases/03-web/03-SHOTS"
git -C "$D" commit -qm "pictures out"

section "gsd-doctor — UI debt of merged phases (ui_gates = strict, no flow = strict)"
DP="$D/.planning/phases/03-web"
printf '# Roadmap\n\n- [x] **Phase 3: Web**\n- [x] **Phase 4: Api**\n\n### Phase 3: Web\n\n### Phase 4: Api\n' > "$D/.planning/ROADMAP.md"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
has "a merged phase with screens and no check → T040 ui-check" "Phase 3 merged without: ui-check" "$OUT"
hasnt "…the flow steps are not judged (flow is not strict)" "code-review" "$OUT"
hasnt "…a phase without screens is left alone" "Phase 4 merged" "$OUT"
printf 'taken: x\n' > "$DP/03-SHOTS.md"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
hasnt "merged with 0.3.x screenshots → no debt" '"T040"' "$OUT"
rm "$DP/03-SHOTS.md"; ui_fix_check "$DP" 03 failed
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
has "a failed check → ui-check" "Phase 3 merged without: ui-check" "$OUT"
ui_fix_check "$DP" 03 passed cap1 0000000000000000000000000000000000000000
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
has "a passed check, no approval → ui-approve" "Phase 3 merged without: ui-approve" "$OUT"
hasnt "…later code changes are not held against a merged phase" "ui-check" "$OUT"
ui_fix_approval "$DP" 03
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
hasnt "check + approval → no debt" '"T040"' "$OUT"
rm "$DP/03-UI-CHECK.md" "$DP/03-UI-APPROVAL.md"
printf 'base = develop\ninstall = none\nui_gates = strict\nflow_skip = 3\n' > "$D/.gsd.conf"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
hasnt "flow_skip leaves the phase out" '"T040"' "$OUT"
printf 'base = develop\ninstall = none\n' > "$D/.gsd.conf"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
hasnt "warn: no UI debt is reported" '"T040"' "$OUT"
printf 'base = develop\ninstall = none\nflow = strict\n' > "$D/.gsd.conf"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
has "flow = strict alone: the flow steps…" "Phase 3 merged without:.* ui-review" "$OUT"
hasnt "…but not the UI checks" "ui-check" "$OUT"
section "gsd-doctor — optional add-ons (notes only)"
printf 'base = develop\ninstall = none\n' > "$D/.gsd.conf"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
has "screens → Impeccable is suggested" "optional for claude — Impeccable design skill" "$OUT"
hasnt "no Tailwind / shadcn → no shadcn MCP" "shadcn MCP" "$OUT"
hasnt "…suggestions are never findings" '"T0[0-9]*","message":"[^"]*optional' "$OUT"
printf '{ "devDependencies": { "tailwindcss": "^4" } }\n' > "$D/package.json"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
has "Tailwind → the shadcn MCP too" "shadcn MCP (the agent picks real components): npx shadcn@latest mcp init --client claude" "$OUT"
rm "$D/package.json"; mkdir -p "$D/apps/web"; echo '{}' > "$D/apps/web/components.json"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
has "a components.json in apps/* → the shadcn MCP" "shadcn MCP" "$OUT"
mkdir -p "$D/.claude/skills/impeccable"; printf '{"mcpServers":{"shadcn":{}}}\n' > "$D/.mcp.json"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
hasnt "installed add-ons are not suggested again" "optional for" "$OUT"
printf 'base = develop\ninstall = none\nproviders = codex\n' > "$D/.gsd.conf"; rm -rf "$D/.claude" "$D/.mcp.json"
gsd-doctor --json --repo "$D" > "$OUT" 2>&1
has "the text follows the provider" "optional for codex — shadcn MCP: add \[mcp_servers.shadcn\]" "$OUT"
rm -rf "$D/apps"; printf 'base = develop\ninstall = none\n' > "$D/.gsd.conf"
B="$WORK/backend"; git init -q -b develop "$B"; mkdir -p "$B/.planning/phases/01-api"
printf '# Roadmap\n' > "$B/.planning/ROADMAP.md"; git -C "$B" add -A && git -C "$B" commit -qm init
gsd-doctor --repo "$B" > "$OUT" 2>&1
hasnt "a project without screens gets no UI notes" "DESIGN.md" "$OUT"

section "gsd-bootstrap-repo: --no-ui and the instructions"
for name in plain noui; do
  T="$WORK/$name"; git init -q -b develop "$T"; git -C "$T" commit -q --allow-empty -m init
done
(cd "$WORK/plain" && gsd-bootstrap-repo) > "$OUT" 2>&1 || bad "bootstrap runs" "$(tail -5 "$OUT")"
gsd-rules --repo "$WORK/plain" > "$WORK/plain.rules"
has "the rules (gsd-rules) carry the screens rule" "Screens: every screen uses the design system" "$WORK/plain.rules"
has "the flow order names the UI steps" "design" "$WORK/plain.rules"
has "…the checks of the built pages" "UI check, UI look, UI approval, UI review" "$WORK/plain.rules"
has "…and the commands" "gsd-ui check <N>" "$WORK/plain.rules"
hasnt ".gsd.conf leaves ui_gates at the default" "^ui_gates" "$WORK/plain/.gsd.conf"
[ ! -e "$WORK/plain/.planning" ] && ok "no .planning/ is created (ingest-docs would switch to merge mode)" || bad "no .planning/ is created"
(cd "$WORK/noui" && gsd-bootstrap-repo --no-ui) > "$OUT" 2>&1 || bad "bootstrap --no-ui runs" "$(tail -5 "$OUT")"
has "--no-ui writes ui_gates = off" "^ui_gates = off" "$WORK/noui/.gsd.conf"
gsd-rules --repo "$WORK/noui" > "$WORK/noui.rules"
hasnt "…and no screens rule" "Screens:" "$WORK/noui.rules"
(cd "$WORK/plain" && gsd-bootstrap-repo --no-ui) > "$OUT" 2>&1
has "--no-ui on an existing .gsd.conf sets the key" "^ui_gates = off" "$WORK/plain/.gsd.conf"
gsd-rules --repo "$WORK/plain" > "$WORK/plain.rules"
hasnt "…and drops the screens rule" "Screens:" "$WORK/plain.rules"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
