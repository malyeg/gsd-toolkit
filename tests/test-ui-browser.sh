#!/usr/bin/env bash
# test-ui-browser.sh — the REAL runner behind `gsdt-ui check` (lib/ui-check.mjs)
# in a real browser, against the pages in tests/fixtures/ui/: one page per
# check (C1–C8), the questions, waivers, the capture id, the sheet, and how
# the runner finds the project's Playwright.
#
# Needs Node and a folder with Playwright and its Chromium installed:
#   mkdir pw && cd pw && npm init -y && npm i -D playwright && npx playwright install chromium
#   GSD_PLAYWRIGHT_ROOT=$PWD tests/test-ui-browser.sh
# Without GSD_PLAYWRIGHT_ROOT (or node) it SKIPS, exit 0. CI sets it.
# GSD_TEST_REQUIRE_BROWSER=1 turns the skip into a failure.
set -uo pipefail
PKG=$(cd "$(dirname "$0")/.." && pwd)
skip() { printf 'SKIP: %s\n' "$1"; [ "${GSD_TEST_REQUIRE_BROWSER:-}" != 1 ] || exit 1; exit 0; }
command -v node >/dev/null 2>&1 || skip "node is not installed"
PWROOT=${GSD_PLAYWRIGHT_ROOT:-}
[ -n "$PWROOT" ] || skip "GSD_PLAYWRIGHT_ROOT is not set (a folder with playwright installed)"
[ -e "$PWROOT/node_modules/playwright/package.json" ] || [ -e "$PWROOT/node_modules/@playwright/test/package.json" ] \
  || skip "no playwright in $PWROOT/node_modules"
PWROOT=$(cd "$PWROOT" && pwd -P)

WORK=$(mktemp -d); WORK=$(cd "$WORK" && pwd -P)
SERVER=""; SERVER2=""
cleanup() {
  [ -z "$SERVER" ] || { kill "$SERVER"; wait "$SERVER"; } 2>/dev/null
  [ -z "$SERVER2" ] || { kill "$SERVER2"; wait "$SERVER2"; } 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GSD_NO_UPDATE_CHECK=1 GSD_UI_BUDGET_MS=4000
unset GSD_PLAYWRIGHT GSD_UI_RUNNER GSD_SKIP_GUARD
# The machine's own global npm folder must not change the results.
export GSD_NPM_GLOBAL_ROOT="$WORK/global/node_modules"
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '%s\n' "$2" | sed 's/^/      /'; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
has() { if grep -q -- "$2" "$3"; then ok "$1"; else bad "$1" "$(tail -8 "$3")"; fi; }
hasnt() { if grep -q -- "$2" "$3"; then bad "$1" "$(grep -- "$2" "$3" | head -3)"; else ok "$1"; fi; }
section() { printf '\n%s\n' "$1"; }
export PATH="$PKG/bin:$PATH"
PY=$(command -v python3 || command -v python)
OUT="$WORK/out"

PORT=$(( 21000 + RANDOM % 8000 ))
(cd "$PKG/tests/fixtures/ui" && exec "$PY" -m http.server "$PORT" --bind 127.0.0.1) >/dev/null 2>&1 &
SERVER=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do curl -s -o /dev/null "http://127.0.0.1:$PORT/good.html" && break; sleep 0.3; done

R="$WORK/app"; git init -q -b develop "$R"
PD="$R/.planning/phases/07-blog"; mkdir -p "$PD"
printf 'base = develop\ninstall = none\n' > "$R/.gsd.conf"
git -C "$R" add -A && git -C "$R" commit -qm init
git -C "$R" checkout -q -b phase-7-blog
CHECK="$PD/07-UI-CHECK.md"
# layout <line>… — write the phase LAYOUT: the address, then the lines given
layout() { { printf 'sketch: skip a test\nurl: http://127.0.0.1:%s\n' "$PORT"; printf '%s\n' "$@"; } > "$PD/07-LAYOUT.md"; }
check() { (cd "$R" && GSD_PLAYWRIGHT_ROOT="$PWROOT" gsdt-ui check 7) > "$OUT" 2>&1; }
nocheck() { (cd "$R" && env -u GSD_PLAYWRIGHT_ROOT gsdt-ui check 7) > "$OUT" 2>&1; }
fmv() { sed -n '/^---$/,/^---$/p' "$CHECK" | sed -n "s/^$1: //p"; }
# finds <section> <start of a line> — how many lines of that report section start so
finds() { awk -v want="## $1" '/^## /{on = ($0 == want); next} on' "$CHECK" | grep -c -- "^- $2" | tr -d ' '; }

section "a clean page passes"
layout 'pages: /good.html' 'main_button: Get started' 'expect: /good.html = Welcome home'
check; rc=$?
is "exit 0" "$rc" 0
is "status: passed, nothing open" "$(fmv status)/$(fmv failures)/$(fmv unchecked)/$(fmv questions)" "passed/0/0/0"
is "three pictures are listed" "$(finds Shots '/good.html | ')" 3
is "…and are on disk, with the sheet" "$(find "$PD/07-SHOTS" -name 'good-html-*.png' | wc -l | tr -d ' ')/$([ -f "$PD/07-SHOTS/index.html" ] && echo sheet)" "3/sheet"
has "the report names the runner and its version" "^runner: [@a-z/]* [0-9]" "$CHECK"
has "…and the pinned axe-core" "^axe: $(cat "$PKG/lib/vendor/axe-core/VERSION")$" "$CHECK"
is "pictures are not staged by git add -A" "$(git -C "$R" add -A -n | grep -c 'SHOTS')" 0
cap1=$(fmv capture)
check
is "the same pages give the same capture id" "$(fmv capture)" "$cap1"

section "one page per check"
layout 'pages: /wide.html, /contrast.html, /small.html, /image.html, /error.html, /covered.html, /low.html, /twice.html, /clip.html, /redirect.html, /nope.html, /good.html' \
  'main_button: /covered.html = Buy now' 'main_button: /low.html = Buy now' 'main_button: /twice.html = Buy now' \
  'main_button: /good.html = css=button' 'main_button: /wide.html = none' \
  'expect: /error.html = Text that is not on the page'
check; rc=$?
is "exit 1" "$rc" 1
is "status: failed" "$(fmv status)" failed
if [ "$(fmv capture)" != "$cap1" ]; then ok "other pages give another capture id"; else bad "other pages give another capture id"; fi
is "C1 the page scrolls sideways, at each width" "$(finds Failures 'C1 | /wide.html | [0-9]* | div.too-wide | ')" 3
is "C3 low contrast"                       "$(finds Failures 'C3 | /contrast.html | 375 | .faint | contrast 2.32:1 (needs 4.5:1)')" 1
is "C3 text over a picture is a question, not a pass" "$(finds Questions 'Q[0-9]* | /contrast.html | 375 | C3 | contrast could not be measured for 1 element')" 1
is "C4 small text"                         "$(finds Failures 'C4 | /small.html | 375 | span.tiny | text at 10px (minimum 12px)')" 1
is "C4 text hidden from screen readers only is still seen" "$(finds Failures 'C4 | /small.html | 375 | span.decor | ')" 1
is "C4 text shrunk by a transform"         "$(finds Failures 'C4 | /small.html | 375 | div.shrunk | text at 8px')" 1
is "C4 a fractional box width (49.6px, offsetWidth 50) is rounding, not a shrink" "$(finds Failures 'C4 | /small.html | 375 | span.frac')" 0
is "C4 text for screen readers (a 1px box) is not counted" "$(finds Failures 'C4 | /small.html | 375 | span.reader-only')" 0
is "C5 a lazy image far down the page"     "$(finds Failures 'C5 | /image.html | 375 | img.late | image did not load')" 1
is "C6 an uncaught error fails"            "$(finds Failures 'C6 | /error.html | 375 | page error | boom in the page')" 1
is "C6 a console error is only listed"     "$(finds Listed 'C6 | /error.html | 375 | console error: listed only')/$(finds Failures 'C6 | /error.html | 375 | .*listed only')" "1/0"
is "C7 the button is covered"              "$(finds Failures 'C7 | /covered.html | 375 | Buy now | the main button is covered by div.banner')" 1
is "C7 the button is below the first screen" "$(finds Failures 'C7 | /low.html | 375 | Buy now | the main button is not on the first screen')" 1
is "C7 two matches"                        "$(finds Failures 'C7 | /twice.html | 375 | Buy now | the main button is 2 matches')" 1
is "C7 css=<selector> finds the button"    "$(finds Failures 'C7 | /good.html')" 0
is "C7 a page without main_button: is not checked" "$(finds 'Not checked' 'C7 | /clip.html | [*] | main_button: is not set')" 1
is "C7 main_button: none is not reported"  "$(finds 'Not checked' 'C7 | /wide.html')" 0
is "C8 the expected text is missing"       "$(finds Failures 'C8 | /error.html | 375 | expect | the text "Text that is not on the page" is not visible')" 1
is "C8 the page is another page (a redirect)" "$(finds Failures 'C8 | /redirect.html | 375 | load | ')" 1
is "C8 HTTP 404"                           "$(finds Failures 'C8 | /nope.html | 375 | load | HTTP 404')" 1
is "C2 clipped text is a question"         "$(finds Questions 'Q[0-9]* | /clip.html | 375 | C2 | possible clipped text in 1 element(s): div.box')" 1
is "C2 text cut with dots on purpose is not asked about" "$(finds Questions '.*div.dots')" 0
is "the clean page has no failure"         "$(finds Failures '[A-Z0-9]* | /good.html')" 0
has "the output lists the findings" "C1 | /wide.html | 375" "$OUT"
has "the sheet shows a page path" "<h2>/wide.html</h2>" "$PD/07-SHOTS/index.html"

section "waivers, strict, the minimum font"
layout 'pages: /contrast.html, /small.html' 'main_button: none' \
  'waive: C3 | /contrast.html | * | .faint | the brand grey, agreed with the user' \
  'waive: C4 | * | 375 | span.tiny | legal line' \
  'waive: C1 | * | * | * | matches nothing'
check
is "a waived finding is listed, not counted" "$(finds Waived 'C3 | /contrast.html | 375 | .faint | .* — waived: the brand grey')/$(finds Failures 'C3 | ')" "1/0"
is "a waiver for one width leaves the others" "$(finds Waived 'C4 | /small.html | 375 | span.tiny')/$(finds Failures 'C4 | /small.html | 768 | span.tiny')" "1/1"
is "a waiver that matched nothing is listed" "$(finds Listed 'waive | [*] | [*] | matched nothing: C1')" 1
is "waived: counts them" "$(fmv waived)" 4
layout 'pages: /good.html'
check; rc=$?
is "warn: a page without main_button: passes, counted as not checked" "$rc/$(fmv status)/$(fmv unchecked)" "0/passed/1"
printf 'base = develop\ninstall = none\nui_gates = strict\nui_min_font = 20\n' > "$R/.gsd.conf"
check; rc=$?
is "strict: not checked is a failure" "$rc/$(fmv status)" "1/failed"
is "ui_min_font = 20 → the 16px text fails" "$(finds Failures 'C4 | /good.html | 375 | .* | text at 16px (minimum 20px)')" 2
printf 'base = develop\ninstall = none\n' > "$R/.gsd.conf"

section "bad LAYOUT lines stop the run"
refuses() {  # label, text of the reason — after a layout call
  check; rc=$?
  if [ "$rc" = 2 ] && grep -q -- "$2" "$OUT" && [ "$(fmv status)" = error ]; then ok "$1"; else bad "$1" "exit $rc: $(tail -4 "$OUT")"; fi
}
layout 'pages: /good.html' 'waive: C3 | /good.html | 375 | .x'
refuses "a waiver without a reason" "waive: needs 5 fields"
layout 'pages: /good.html' 'waive: C8 | * | * | * | we like 404'
refuses "a waiver for a check that cannot be waived" "C8 is not a check that can be waived"
layout 'pages: /good.html' 'waive: C3 | /other.html | * | * | reason'
refuses "a waiver for a page that is not in pages:" "which is not in pages:"
layout 'pages: /good.html' 'main_button: /other.html = Go'
refuses "main_button: for a page that is not in pages:" "main_button: names /other.html"
layout 'pages: /good.html' 'main_button: /good.html = Go' 'main_button: /good.html = Stop'
refuses "two main_button: lines for one page" "main_button: has two lines for /good.html"
is "no pictures stay after a run that could not finish" "$(find "$PD/07-SHOTS" -type f ! -name .gitignore | wc -l | tr -d ' ')" 0

section "finding the project's Playwright"
layout 'pages: /good.html' 'main_button: Get started'
# a folder that resolves `playwright` but is not the real one (never loaded:
# the runner stops at "several installs" before it loads anything)
fake() {
  mkdir -p "$R/$1/node_modules/playwright"
  printf '{"name":"playwright","version":"0.0.1","main":"index.js"}\n' > "$R/$1/node_modules/playwright/package.json"
  echo 'module.exports = {};' > "$R/$1/node_modules/playwright/index.js"
  printf '{"name":"x"}\n' > "$R/$1/package.json"
}
printf 'node_modules/\n' > "$R/.gitignore"
nocheck; rc=$?
is "no Playwright anywhere → exit 2" "$rc" 2
has "…says how to install it once per machine" "npm i -g playwright" "$OUT"
mkdir -p "$WORK/global"; ln -s "$PWROOT/node_modules" "$WORK/global/node_modules"
nocheck; rc=$?
is "no Playwright in the project → the global one" "$rc/$(fmv status)" "0/passed"
has "…and the report says so" "^runner: .* (global)$" "$CHECK"
fake apps/web; fake apps/admin
nocheck; rc=$?
# (the global install is still there: a project with its own installs never falls back to it)
is "two installs, no app: → exit 2" "$rc" 2
has "…asks for app: and names both" "several Playwright installs (apps/admin, apps/web)" "$OUT"
rm -rf "$R/apps/admin" "$R/apps/web" "$WORK/global"
mkdir -p "$R/apps/web"; printf '{"name":"web"}\n' > "$R/apps/web/package.json"; ln -s "$PWROOT/node_modules" "$R/apps/web/node_modules"
nocheck; rc=$?
is "one install in apps/* is found" "$rc/$(fmv status)" "0/passed"
has "…and recorded with its folder" "^runner: .* (apps/web)$" "$CHECK"
fake apps/admin
printf 'app: apps/web\n' >> "$PD/07-LAYOUT.md"
nocheck; rc=$?
is "app: picks one of several" "$rc/$(fmv status)" "0/passed"
sed -i.bak 's#^app:.*#app: apps/none#' "$PD/07-LAYOUT.md"; rm -f "$PD/07-LAYOUT.md.bak"
nocheck; rc=$?
is "app: without Playwright → exit 2" "$rc" 2
has "…names the folder" "no Playwright in apps/none (app: in 07-LAYOUT.md)" "$OUT"
rm -rf "$R/apps"

section "the sheet escapes what it shows"
mkdir -p "$WORK/site2"
{ printf '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>x</title></head><body style="font:16px sans-serif">\n'
  printf '<h1>Inject</h1><span class="a&quot;><script>alert(1)</script>" style="font-size:9px">tiny &lt;img src=x onerror=alert(2)&gt; text</span>\n'
  printf '</body></html>\n'; } > "$WORK/site2/x.html"
PORT2=$((PORT + 1))
(cd "$WORK/site2" && exec "$PY" -m http.server "$PORT2" --bind 127.0.0.1) >/dev/null 2>&1 &
SERVER2=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null "http://127.0.0.1:$PORT2/x.html" && break; sleep 0.3; done
printf 'sketch: skip a test\nurl: http://127.0.0.1:%s\npages: /x.html\nmain_button: none\n' "$PORT2" > "$PD/07-LAYOUT.md"
check
is "the finding is reported" "$(finds Failures 'C4 | /x.html | 375 | ')" 1
hasnt "no tag from the page reaches the sheet" "<script>alert\|<img src=x" "$PD/07-SHOTS/index.html"
has "…it is shown as text" "&lt;img src=x onerror=alert(2)&gt;" "$PD/07-SHOTS/index.html"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]
