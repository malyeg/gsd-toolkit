#!/usr/bin/env bash
# test-update.sh — the "newer release" notice, the doctor note, gsdt-update's
# release-runtime mode (--check, gsd-core) and the release check. CI-safe:
# GitHub is a curl stub. The runtime under test is installed with lib/install-copy.sh
# (the 0.10.x copy installer, the oracle).
# The 0.10.x release line (the old install.sh: fresh install, update, go back,
# prune, checksum refusals, the gsd-worktrees → gsd-toolkit move) is frozen and
# no longer built here; tests/test-install.sh runs the REAL v0.10.0 install.sh
# and gsdt-update against a 1.0.0 release, and the npm mode of gsdt-update is
# in tests/test-npm.sh and tests/ts/p11-update.test.ts.
set -uo pipefail
PKG=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d); WORK=$(cd "$WORK" && pwd -P); trap 'rm -rf "$WORK"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GSD_NO_CORE=1   # install.sh and gsdt-update must not run the real gsd-core installer (npx)
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export XDG_CACHE_HOME="$WORK/cache" GSD_UPDATE_REPO=acme/gsd-toolkit
export GSD_BIN_DIR="$WORK/bin" GSD_CLAUDE_SKILL_DIR="$WORK/skills"
unset GSD_NO_UPDATE_CHECK GSD_UPDATE_NOTICE GSD_RELEASES_DIR GSD_COPY_DIR
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '%s\n' "$2" | sed 's/^/      /'; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
has() { if grep -q -- "$2" "$3"; then ok "$1"; else bad "$1" "$(tail -5 "$3")"; fi; }
hasnt() { if grep -q -- "$2" "$3"; then bad "$1" "$(grep -- "$2" "$3" | head -3)"; else ok "$1"; fi; }
section() { printf '\n%s\n' "$1"; }

GSD_PKG=$PKG; . "$PKG/lib/common.sh"; . "$PKG/lib/version.sh"
section "version compare"
if gsd_version_gt 0.10.0 0.9.9; then ok "0.10.0 > 0.9.9 (numeric, not text)"; else bad "0.10.0 > 0.9.9 (numeric, not text)"; fi
if gsd_version_gt v1.2.3 1.2.3; then bad "equal is not newer"; else ok "equal is not newer"; fi
if gsd_version_gt 1.2.3 1.3.0; then bad "older is not newer"; else ok "older is not newer"; fi
if gsd_version_gt garbage 1.0.0; then bad "garbage is never newer"; else ok "garbage is never newer"; fi
if gsd_version_gt 1.0.08 1.0.7; then ok "zero-padded parts are not octal"; else bad "zero-padded parts are not octal"; fi

section "release-check — is this a new version?"
RC="$WORK/rc"; mkdir -p "$RC"
rc() { (cd "$RC" && printf '%s\n' "$1" > VERSION && printf '%b' "$2" | "$PKG/tools/release-check.sh") > "$WORK/out" 2>&1; }
printf '# Changelog\n\n## 0.7.0\n\n- new thing\n\n## 0.6.30\n\n- other thing\n\n## 0.6.29\n\n## 0.6.2\n\n- old thing\n' > "$RC/CHANGELOG.md"
TAGS='abc\trefs/tags/v0.6.2\nabc\trefs/tags/v0.6.2^{}\n'
if rc 0.7.0 "$TAGS"; then is "a new version with notes is released" "$(cat "$WORK/out")" 0.7.0; else bad "a new version with notes is released" "$(cat "$WORK/out")"; fi
if rc 0.6.2 "$TAGS"; then is "a version with its tag: nothing to do" "$(cat "$WORK/out")" ""; else bad "a version with its tag: nothing to do" "$(cat "$WORK/out")"; fi
if rc 0.7.0 ""; then is "no tags at all: released" "$(cat "$WORK/out")" 0.7.0; else bad "no tags at all: released" "$(cat "$WORK/out")"; fi
if rc 0.6.1 "$TAGS"; then bad "older than the newest tag is refused"; else has "older than the newest tag is refused" "older than the tag v0.6.2" "$WORK/out"; fi
if rc 0.8.0 "$TAGS"; then bad "no CHANGELOG section is refused"; else has "no CHANGELOG section is refused" "no notes under" "$WORK/out"; fi
if rc 0.6.29 "$TAGS"; then bad "an empty CHANGELOG section is refused"; else has "an empty CHANGELOG section is refused" "no notes under" "$WORK/out"; fi
if rc 0.6.3 "$TAGS"; then bad "0.6.3 does not read the notes of 0.6.30"; else has "0.6.3 does not read the notes of 0.6.30" "no notes under" "$WORK/out"; fi
if rc garbage "$TAGS"; then bad "a bad VERSION is refused"; else has "a bad VERSION is refused" "not X.Y.Z" "$WORK/out"; fi

# ── fake GitHub ──────────────────────────────────────────────────────────────
REL="$WORK/releases-served"; mkdir -p "$REL"   # no release is downloaded here: only the latest-version lookup
echo 9.9.9 > "$WORK/latest"
mkdir -p "$WORK/stub"
cat > "$WORK/stub/curl" <<'CURL'
#!/usr/bin/env bash
out=""; url=""
retry=""
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; --retry) retry=" retry=$2"; shift ;; -H|--max-time|--retry-delay) shift ;; http*) url=$1 ;; esac; shift; done
echo "$url" >> "$WORK/curl.log"
case "$url" in */releases/download/*) echo "$url$retry" >> "$WORK/curl-retry.log" ;; esac
case "$url" in
  https://api.github.com/repos/acme/gsd-toolkit/releases/latest)
    [ -s "$WORK/latest" ] || exit 22
    body=$(printf '{"url":"x","tag_name": "v%s","name":"n"}' "$(cat "$WORK/latest")") ;;
  https://github.com/acme/gsd-toolkit/releases/download/*)
    f="$REL/${url#https://github.com/acme/gsd-toolkit/releases/download/}"
    [ -f "$f" ] || exit 22
    if [ -n "$out" ]; then cp "$f" "$out"; exit 0; fi; cat "$f"; exit 0 ;;
  # the move from arconme/gsd-worktrees to malyeg/gsd-toolkit (two hops)
  https://api.github.com/repos/*/releases/latest)
    slug=${url#https://api.github.com/repos/}; slug=${slug%/releases/latest}
    [ -s "$WORK/gh/$slug/latest" ] || exit 22
    body=$(printf '{"tag_name": "v%s"}' "$(cat "$WORK/gh/$slug/latest")") ;;
  https://github.com/*/releases/download/*)
    slug=${url#https://github.com/}; slug=${slug%%/releases/download/*}
    f="$WORK/gh/$slug/${url#*/releases/download/}"
    [ -f "$f" ] || exit 22
    if [ -n "$out" ]; then cp "$f" "$out"; exit 0; fi; cat "$f"; exit 0 ;;
  *) exit 6 ;;
esac
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
CURL
chmod +x "$WORK/stub/curl"
export WORK REL PATH="$WORK/stub:$PATH"
BIN="$WORK/bin"; RUN="$WORK/share/gsd-toolkit/releases"
points() { readlink "$BIN/$1" | sed -E "s#^$RUN/([^/]+)/.*#\1#"; }

section "an installed release runtime (lib/install-copy.sh, 9.9.7)"
d="$WORK/build/gsd-toolkit-9.9.7"; mkdir -p "$d"
cp -R "$PKG/bin" "$PKG/lib" "$PKG/src" "$PKG/shims" "$PKG/skills" "$PKG/install.sh" "$d/"; printf '9.9.7\n' > "$d/VERSION"
GSD_COPY_DIR="$RUN/9.9.7" bash "$d/lib/install-copy.sh" --agent claude > "$WORK/out" 2>&1
is  "installs"                          "$?" 0
is  "commands link into releases/9.9.7" "$(points gsdt-list)" 9.9.7
"$BIN/gsdt-list" --help >/dev/null 2>&1; is "an installed command runs" "$?" 0

section "gsdt-update --check (release runtime)"
"$BIN/gsdt-update" --check > "$WORK/out" 2>&1
has "--check shows the installed version" "installed : 9.9.7" "$WORK/out"
has "…the latest"                       "latest    : 9.9.9" "$WORK/out"
has "…and says an update is there"      "update available" "$WORK/out"
is  "--check changes nothing"           "$(points gsdt-list)" 9.9.7
"$PKG/bin/gsdt-update" > "$WORK/out" 2>&1
has "a git checkout updates nothing, and names install.sh" "not a release — pull it with git; install the release with: $PKG/install.sh" "$WORK/out"

section "the newer-release notice"
# npm is a stub from the start: a background refresh must never reach this machine's real npm
printf '#!/usr/bin/env bash\necho 1.2.0\n' > "$WORK/stub/npm"; chmod +x "$WORK/stub/npm"
rm -rf "$XDG_CACHE_HOME"
GSD_UPDATE_NOTICE=always "$BIN/gsdt-list" --repo "$WORK/nope" > /dev/null 2> "$WORK/err"
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$(gsd_update_cache)" ] && break; sleep 0.5; done
is  "a stale cache is refreshed in the background" "$(gsd_latest_cached)" 9.9.9
GSD_UPDATE_NOTICE=always "$BIN/gsdt-list" --repo "$WORK/nope" > /dev/null 2> "$WORK/err"
has "then one line names the new release" "gsd-toolkit 9.9.9 is out (you have 9.9.7) — update: gsdt-update" "$WORK/err"
"$BIN/gsdt-list" --repo "$WORK/nope" > /dev/null 2> "$WORK/err"
hasnt "not a terminal → no notice"      "is out" "$WORK/err"
GSD_NO_UPDATE_CHECK=1 GSD_UPDATE_NOTICE=always "$BIN/gsdt-list" --repo "$WORK/nope" > /dev/null 2> "$WORK/err"
hasnt "GSD_NO_UPDATE_CHECK=1 → no notice" "is out" "$WORK/err"
: > "$WORK/curl.log"
GSD_UPDATE_NOTICE=always "$BIN/gsdt-list" --repo "$WORK/nope" > /dev/null 2>&1; sleep 1
is  "a fresh cache → no GitHub call"    "$(grep -c api.github.com "$WORK/curl.log")" 0
# GSD itself (npm): a stub gsd-core 1.0.0 (an agent-dir install: VERSION beside
# bin/), npm says 1.2.0. GSD_CLI pins it, so this machine's own GSD never counts.
mkdir -p "$WORK/gc/gsd-core/bin"
printf '#!/usr/bin/env bash\necho '"'"'{"packageName":"@opengsd/gsd-core","version":"1.0.0"}'"'"'\n' > "$WORK/gc/gsd-core/bin/gsd_run"
printf '1.0.0\n' > "$WORK/gc/gsd-core/VERSION"
chmod +x "$WORK/gc/gsd-core/bin/gsd_run"
export GSD_CLI="$WORK/gc/gsd-core/bin/gsd_run"
rm -f "$(gsd_gsd_cache)"   # a real gsd-core on this machine may have filled it already
GSD_UPDATE_NOTICE=always "$BIN/gsdt-list" --repo "$WORK/nope" > /dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$(gsd_gsd_cache)" ] && break; sleep 0.5; done
GSD_UPDATE_NOTICE=always "$BIN/gsdt-list" --repo "$WORK/nope" > /dev/null 2> "$WORK/err"
has "a newer GSD on npm gets its own line" "GSD 1.2.0 is out (you have 1.0.0) — update: gsdt-update" "$WORK/err"
git init -qb main "$WORK/fresh"
# gsdt-init needs gsdt-bootstrap-repo on PATH (the installed one, as a user has it)
(cd "$WORK/fresh" && PATH="$BIN:$PATH" GSD_UPDATE_NOTICE=always "$BIN/gsdt-init" --no-launch --no-commit) > /dev/null 2> "$WORK/err"
has "gsdt-init tells about a newer gsd-toolkit" "gsd-toolkit 9.9.9 is out" "$WORK/err"
has "…and a newer GSD"                  "GSD 1.2.0 is out" "$WORK/err"

section "gsdt-doctor — updates"
R="$WORK/proj"; mkdir -p "$R/.planning"; git -C "$R" init -qb main
"$BIN/gsdt-doctor" --repo "$R" > "$WORK/out" 2>&1
has "gsdt-doctor shows the newer release" "gsd-toolkit 9.9.7 installed, 9.9.9 available — update: gsdt-update" "$WORK/out"
"$BIN/gsdt-doctor" --repo "$R" --quiet > "$WORK/out" 2>&1
has "…even with --quiet (gsd-toolkit)" "gsd-toolkit 9.9.7 installed, 9.9.9 available" "$WORK/out"
has "…even with --quiet (GSD)"          "gsd-core 1.0.0 installed, 1.2.0 available — update: gsdt-update" "$WORK/out"
"$BIN/gsdt-doctor" --repo "$R" --json > "$WORK/out" 2>/dev/null
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); u={x["name"]:x["latest"] for x in d["updates"]}; sys.exit(0 if u=={"gsd-toolkit":"9.9.9","gsd-core":"1.2.0"} else 1)' "$WORK/out"; then
  ok "--json lists both under updates (valid JSON)"; else bad "--json lists both under updates (valid JSON)" "$(head -c 300 "$WORK/out")"; fi
GSD_NO_UPDATE_CHECK=1 "$BIN/gsdt-doctor" --repo "$R" --quiet > "$WORK/out" 2>&1
hasnt "GSD_NO_UPDATE_CHECK=1 → no update lines" "available — update" "$WORK/out"

section "gsdt-update — gsd-core too"
echo 9.9.7 > "$WORK/latest"   # the toolkit is on the latest: only gsd-core is behind
# A throwaway HOME with gsd-core 1.0.0 for claude; npm says 1.2.0; a stub
# npx (the gsd-core installer) records its args and writes 1.2.0.
CH="$WORK/corehome"; mkdir -p "$CH/.claude/gsd-core/bin" "$WORK/npx"
printf '#!/bin/sh\n' > "$CH/.claude/gsd-core/bin/gsd_run"; chmod +x "$CH/.claude/gsd-core/bin/gsd_run"
printf '1.0.0\n' > "$CH/.claude/gsd-core/VERSION"
cat > "$WORK/npx/npx" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$WORK/npx.log"
printf '1.2.0\n' > "$HOME/.claude/gsd-core/VERSION"
SH
chmod +x "$WORK/npx/npx"
cup() { env -u GSD_NO_CORE -u CLAUDE_CONFIG_DIR HOME="$CH" PATH="$WORK/npx:$PATH" "$BIN/gsdt-update" "$@" > "$WORK/out" 2>&1; }
cup --check
has "--check shows gsd-core per agent"  "gsd-core  : claude 1.0.0, latest 1.2.0" "$WORK/out"
has "…and that an update is there"      "update available" "$WORK/out"
if [ -e "$WORK/npx.log" ]; then bad "--check runs no installer"; else ok "--check runs no installer"; fi
cup --no-core
if [ -e "$WORK/npx.log" ]; then bad "--no-core leaves gsd-core alone"; else ok "--no-core leaves gsd-core alone"; fi
cup
is  "gsdt-update updates gsd-core"       "$(cat "$CH/.claude/gsd-core/VERSION")" 1.2.0
is  "…with the full profile"            "$(cat "$WORK/npx.log")" "-y --package=@opengsd/gsd-core@latest -- gsd-core --claude --global --profile=full"
has "…saying so"                        "updating gsd-core for claude (1.0.0 → 1.2.0)" "$WORK/out"
cup
has "on the latest → left alone"        "claude gsd-core 1.2.0 is the latest" "$WORK/out"
is  "…no second run"                    "$(wc -l < "$WORK/npx.log" | tr -d ' ')" 1

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
