#!/usr/bin/env bash
# test-update.sh — releases: install.sh installs a release, gsd-update moves
# between releases, checksums are enforced, old releases are pruned, and the
# "newer release" notice / doctor note. CI-safe: GitHub is a curl stub serving
# fake releases built from this checkout.
set -uo pipefail
PKG=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d); WORK=$(cd "$WORK" && pwd -P); trap 'rm -rf "$WORK"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GSD_NO_CORE=1   # install.sh and gsd-update must not run the real gsd-core installer (npx)
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
REL="$WORK/releases-served"
release() {  # $1=version [$2=bad] — build a release tarball + SHA256SUMS from this checkout
  local v=$1 d="$WORK/build/gsd-toolkit-$1"
  mkdir -p "$d" "$REL/v$v"
  cp -R "$PKG/bin" "$PKG/lib" "$PKG/shims" "$PKG/skills" "$PKG/install.sh" "$d/"
  printf '%s\n' "$v" > "$d/VERSION"
  tar -czf "$REL/v$v/gsd-toolkit-$v.tar.gz" -C "$WORK/build" "gsd-toolkit-$v"
  if [ "${2:-}" = bad ]; then echo "0000  gsd-toolkit-$v.tar.gz" > "$REL/v$v/SHA256SUMS"
  else (cd "$REL/v$v" && { sha256sum "gsd-toolkit-$v.tar.gz" 2>/dev/null || shasum -a 256 "gsd-toolkit-$v.tar.gz"; } > SHA256SUMS); fi
}
for v in 9.9.7 9.9.8 9.9.9; do release "$v"; done
release 9.9.6 bad
echo 9.9.9 > "$WORK/latest"
mkdir -p "$WORK/stub"
cat > "$WORK/stub/curl" <<'CURL'
#!/usr/bin/env bash
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; -H|--max-time) shift ;; http*) url=$1 ;; esac; shift; done
echo "$url" >> "$WORK/curl.log"
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

section "install.sh — fresh install of a release"
bash "$PKG/install.sh" --version 9.9.8 --agent claude > "$WORK/out" 2>&1
is  "installs"                          "$?" 0
is  "commands link into releases/9.9.8" "$(points gsd-list)" 9.9.8
is  "the runtime says 9.9.8"            "$(cat "$RUN/9.9.8/VERSION")" 9.9.8
if [ -f "$RUN/9.9.8/install.sh" ]; then ok "the runtime carries install.sh (for gsd-update)"; else bad "the runtime carries install.sh (for gsd-update)"; fi
if grep -q '^<!-- gsd-toolkit-skill ' "$WORK/skills/gsdt-flow/SKILL.md"; then ok "the skill copy is marked as the toolkit's"; else bad "the skill copy is marked as the toolkit's"; fi
if [ -z "$(find "$WORK/skills/gsdt-flow" -type f ! -name SKILL.md)" ]; then ok "…in SKILL.md: no other file (gsd-core's installer stops on one)"; else bad "…in SKILL.md: no other file (gsd-core's installer stops on one)"; fi
"$BIN/gsd-list" --help >/dev/null 2>&1; is "an installed command runs" "$?" 0

section "gsd-update — check, update, go back, prune"
"$BIN/gsd-update" --check > "$WORK/out" 2>&1
has "--check shows the installed version" "installed : 9.9.8" "$WORK/out"
has "…the latest"                       "latest    : 9.9.9" "$WORK/out"
has "…and says an update is there"      "update available" "$WORK/out"
is  "--check changes nothing"           "$(points gsd-list)" 9.9.8
"$BIN/gsd-update" > "$WORK/out" 2>&1
is  "update succeeds"                   "$?" 0
is  "commands now link into 9.9.9"      "$(points gsd-finish)" 9.9.9
if [ -d "$RUN/9.9.8" ]; then ok "the previous release is kept"; else bad "the previous release is kept"; fi
is  "no .bak left in bin or skills"     "$(find "$BIN" "$WORK/skills" -name '*.bak*' | wc -l | tr -d ' ')" 0
if [ -f "$WORK/skills/gsdt-flow/SKILL.md" ] && [ ! -L "$WORK/skills/gsdt-flow" ]; then ok "the skill was replaced in place"; else bad "the skill was replaced in place"; fi
"$BIN/gsd-update" > "$WORK/out" 2>&1
has "on the latest → up to date"        "up to date" "$WORK/out"
"$BIN/gsd-update" --version 9.9.7 > "$WORK/out" 2>&1
is  "--version goes back"               "$(points gsd-list)" 9.9.7
if [ -d "$RUN/9.9.9" ]; then ok "…keeping the one it left"; else bad "…keeping the one it left"; fi
if [ -d "$RUN/9.9.8" ]; then bad "…and removing older ones"; else ok "…and removing older ones"; fi

section "refusals"
if "$BIN/gsd-update" --version 9.9.6 > "$WORK/out" 2>&1; then bad "a checksum mismatch is refused"; else ok "a checksum mismatch is refused"; fi
has "…saying so"                        "checksum mismatch" "$WORK/out"
is  "…commands unchanged"               "$(points gsd-list)" 9.9.7
if "$BIN/gsd-update" --version 1.2.3 > "$WORK/out" 2>&1; then bad "a missing release is refused"; else ok "a missing release is refused"; fi
if bash "$PKG/install.sh" --version latest > "$WORK/out" 2>&1; then bad "a non-version is refused"; else ok "a non-version is refused"; fi
"$PKG/bin/gsd-update" > "$WORK/out" 2>&1
has "a git checkout updates nothing, and names install.sh" "not a release — pull it with git; install the release with: $PKG/install.sh" "$WORK/out"

section "the newer-release notice"
rm -rf "$XDG_CACHE_HOME"
GSD_UPDATE_NOTICE=always "$BIN/gsd-list" --repo "$WORK/nope" > /dev/null 2> "$WORK/err"
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$(gsd_update_cache)" ] && break; sleep 0.5; done
is  "a stale cache is refreshed in the background" "$(gsd_latest_cached)" 9.9.9
GSD_UPDATE_NOTICE=always "$BIN/gsd-list" --repo "$WORK/nope" > /dev/null 2> "$WORK/err"
has "then one line names the new release" "gsd-toolkit 9.9.9 is out (you have 9.9.7) — update: gsd-update" "$WORK/err"
"$BIN/gsd-list" --repo "$WORK/nope" > /dev/null 2> "$WORK/err"
hasnt "not a terminal → no notice"      "is out" "$WORK/err"
GSD_NO_UPDATE_CHECK=1 GSD_UPDATE_NOTICE=always "$BIN/gsd-list" --repo "$WORK/nope" > /dev/null 2> "$WORK/err"
hasnt "GSD_NO_UPDATE_CHECK=1 → no notice" "is out" "$WORK/err"
: > "$WORK/curl.log"
GSD_UPDATE_NOTICE=always "$BIN/gsd-list" --repo "$WORK/nope" > /dev/null 2>&1; sleep 1
is  "a fresh cache → no GitHub call"    "$(grep -c api.github.com "$WORK/curl.log")" 0
# GSD itself (npm): a stub gsd-core 1.0.0 (an agent-dir install: VERSION beside
# bin/), npm says 1.2.0. GSD_CLI pins it, so this machine's own GSD never counts.
mkdir -p "$WORK/gc/gsd-core/bin"
printf '#!/usr/bin/env bash\necho '"'"'{"packageName":"@opengsd/gsd-core","version":"1.0.0"}'"'"'\n' > "$WORK/gc/gsd-core/bin/gsd_run"
printf '1.0.0\n' > "$WORK/gc/gsd-core/VERSION"
printf '#!/usr/bin/env bash\necho 1.2.0\n' > "$WORK/stub/npm"
chmod +x "$WORK/gc/gsd-core/bin/gsd_run" "$WORK/stub/npm"
export GSD_CLI="$WORK/gc/gsd-core/bin/gsd_run"
rm -f "$(gsd_gsd_cache)"   # a real gsd-core on this machine may have filled it already
GSD_UPDATE_NOTICE=always "$BIN/gsd-list" --repo "$WORK/nope" > /dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$(gsd_gsd_cache)" ] && break; sleep 0.5; done
GSD_UPDATE_NOTICE=always "$BIN/gsd-list" --repo "$WORK/nope" > /dev/null 2> "$WORK/err"
has "a newer GSD on npm gets its own line" "GSD 1.2.0 is out (you have 1.0.0) — update: gsd-update" "$WORK/err"
git init -qb main "$WORK/fresh"
# gsd-init needs gsd-bootstrap-repo on PATH (the installed one, as a user has it)
(cd "$WORK/fresh" && PATH="$BIN:$PATH" GSD_UPDATE_NOTICE=always "$BIN/gsd-init" --no-launch --no-commit) > /dev/null 2> "$WORK/err"
has "gsd-init tells about a newer gsd-toolkit" "gsd-toolkit 9.9.9 is out" "$WORK/err"
has "…and a newer GSD"                  "GSD 1.2.0 is out" "$WORK/err"

section "gsd-doctor — updates"
R="$WORK/proj"; mkdir -p "$R/.planning"; git -C "$R" init -qb main
"$BIN/gsd-doctor" --repo "$R" > "$WORK/out" 2>&1
has "gsd-doctor shows the newer release" "gsd-toolkit 9.9.7 installed, 9.9.9 available — update: gsd-update" "$WORK/out"
"$BIN/gsd-doctor" --repo "$R" --quiet > "$WORK/out" 2>&1
has "…even with --quiet (gsd-toolkit)" "gsd-toolkit 9.9.7 installed, 9.9.9 available" "$WORK/out"
has "…even with --quiet (GSD)"          "gsd-core 1.0.0 installed, 1.2.0 available — update: gsd-update" "$WORK/out"
"$BIN/gsd-doctor" --repo "$R" --json > "$WORK/out" 2>/dev/null
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); u={x["name"]:x["latest"] for x in d["updates"]}; sys.exit(0 if u=={"gsd-toolkit":"9.9.9","gsd-core":"1.2.0"} else 1)' "$WORK/out"; then
  ok "--json lists both under updates (valid JSON)"; else bad "--json lists both under updates (valid JSON)" "$(head -c 300 "$WORK/out")"; fi
GSD_NO_UPDATE_CHECK=1 "$BIN/gsd-doctor" --repo "$R" --quiet > "$WORK/out" 2>&1
hasnt "GSD_NO_UPDATE_CHECK=1 → no update lines" "available — update" "$WORK/out"

section "the move: gsd-worktrees 0.7.0 → 0.7.1 (bridge) → gsd-toolkit 0.8.0"
# The real 0.7.0 (its git tag) installed from the old repo, as users have it;
# 0.7.1 = 0.7.0 with this install.sh and the new repo in lib/version.sh (the
# bridge); 0.8.0 = this checkout, from the new repo. Each served under its
# real slug, so each install.sh finds its own default.
gh_release() {  # $1=slug $2=package name $3=version $4=source dir
  local d="$WORK/ghbuild/$2-$3" out="$WORK/gh/$1/v$3"
  rm -rf "$d"; mkdir -p "$d" "$out"; cp -R "$4/." "$d/"; printf '%s\n' "$3" > "$d/VERSION"
  tar -czf "$out/$2-$3.tar.gz" -C "$WORK/ghbuild" "$2-$3"
  (cd "$out" && { sha256sum "$2-$3.tar.gz" 2>/dev/null || shasum -a 256 "$2-$3.tar.gz"; } > SHA256SUMS)
  printf '%s\n' "$3" > "$WORK/gh/$1/latest"
}
if git -C "$PKG" rev-parse -q --verify 'v0.7.0^{commit}' >/dev/null; then
  OLD="$WORK/src-070"; mkdir -p "$OLD"; git -C "$PKG" archive v0.7.0 | tar -x -C "$OLD"
  BR="$WORK/src-071"; cp -R "$OLD" "$BR"; cp "$PKG/install.sh" "$BR/install.sh"
  sed -i.bak 's#^GSD_UPDATE_REPO_DEFAULT=.*#GSD_UPDATE_REPO_DEFAULT=malyeg/gsd-toolkit#' "$BR/lib/version.sh"; rm -f "$BR/lib/version.sh.bak"
  NEW="$WORK/src-080"; mkdir -p "$NEW"; cp -R "$PKG/bin" "$PKG/lib" "$PKG/shims" "$PKG/skills" "$PKG/install.sh" "$NEW/"
  gh_release arconme/gsd-worktrees gsd-worktrees 0.7.0 "$OLD"
  H="$WORK/hop"; HB="$H/bin"; HS="$H/skills"; mkdir -p "$HB" "$HS"
  hop() { env -u GSD_UPDATE_REPO GSD_BIN_DIR="$HB" GSD_CLAUDE_SKILL_DIR="$HS" XDG_CACHE_HOME="$H/cache" "$@" > "$WORK/out" 2>&1; }
  hop bash "$OLD/install.sh" --version 0.7.0 --agent claude
  is  "0.7.0 installs from the old repo"     "$(cat "$H/share/gsd-worktrees/releases/0.7.0/VERSION" 2>/dev/null)" 0.7.0
  if [ -f "$HS/gsdw-flow/SKILL.md" ]; then ok "…with its gsdw-* skills"; else bad "…with its gsdw-* skills" "$(cat "$WORK/out")"; fi
  gh_release arconme/gsd-worktrees gsd-worktrees 0.7.1 "$BR"
  hop "$HB/gsd-update"
  is  "hop 1: gsd-update gets the bridge 0.7.1" "$(readlink "$HB/gsd-list" | sed -E 's#.*/releases/([^/]+)/.*#\1#')" 0.7.1
  gh_release malyeg/gsd-toolkit gsd-toolkit 0.8.0 "$NEW"
  hop "$HB/gsd-update" --check
  has "…which sees 0.8.0 in the new repo"    "latest    : 0.8.0  (malyeg/gsd-toolkit)" "$WORK/out"
  hop "$HB/gsd-update"
  is  "hop 2: gsd-update gets 0.8.0"         "$(readlink "$HB/gsd-list")" "$H/share/gsd-toolkit/releases/0.8.0/bin/gsd-list"
  is  "…every command links into the new runtime" "$(for l in "$HB"/gsd-*; do readlink "$l"; done | grep -vc "^$H/share/gsd-toolkit/releases/0.8.0/bin/")" 0
  if [ -e "$H/share/gsd-worktrees" ]; then bad "…the old runtime folder is removed" "$(find "$H/share" | head)"; else ok "…the old runtime folder is removed"; fi
  is  "…skills are gsdt-* only"              "$(cd "$HS" && printf "%s " *)" "gsdt-flow gsdt-tracker gsdt-worktrees "
  has "…marked with the new name"            '^<!-- gsd-toolkit-skill 0.8.0 -->' "$HS/gsdt-flow/SKILL.md"
  is  "…no .bak anywhere"                    "$(find "$HB" "$HS" -name '*.bak*' | wc -l | tr -d ' ')" 0
  "$HB/gsd-list" --help >/dev/null 2>&1;  is "…and the commands run" "$?" 0
  hop "$HB/gsd-update" --check
  has "then it is up to date"                "up to date" "$WORK/out"

  # The old folder stays while something still links into it, or holds
  # anything but release folders.
  H="$WORK/hop2"; HB="$H/bin"; HS="$H/skills"; mkdir -p "$HB" "$HS"
  hop bash "$OLD/install.sh" --version 0.7.0 --agent claude
  ln -s "$H/share/gsd-worktrees/releases/0.7.0" "$HB/gsd-mine"   # not a command of ours: install leaves it
  hop bash "$PKG/install.sh" --version 0.8.0
  if [ -d "$H/share/gsd-worktrees/releases/0.7.0" ]; then ok "a link still into the old folder keeps it"; else bad "a link still into the old folder keeps it"; fi
  rm -f "$HB/gsd-mine"; mkdir -p "$H/share/gsd-worktrees/notes"
  hop bash "$PKG/install.sh" --version 0.8.0
  if [ -d "$H/share/gsd-worktrees/notes" ]; then ok "…and so does anything else in it"; else bad "…and so does anything else in it"; fi
  rmdir "$H/share/gsd-worktrees/notes"
  hop bash "$PKG/install.sh" --version 0.8.0
  if [ -e "$H/share/gsd-worktrees" ]; then bad "…then the next install removes it"; else ok "…then the next install removes it"; fi
  # going back: the old repo, its tarball name
  hop env GSD_UPDATE_REPO=arconme/gsd-worktrees bash "$PKG/install.sh" --version 0.7.0
  is  "install.sh still installs a gsd-worktrees release (going back)" "$(readlink "$HB/gsd-list")" "$H/share/gsd-toolkit/releases/0.7.0/bin/gsd-list"
elif [ -n "${CI:-}" ]; then
  bad "the move needs the v0.7.0 tag (checkout with fetch-depth: 0)"
else
  printf '  • skipped: no v0.7.0 tag here (git fetch --tags)\n'
fi

section "gsd-update — gsd-core too"
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
cup() { env -u GSD_NO_CORE -u CLAUDE_CONFIG_DIR HOME="$CH" PATH="$WORK/npx:$PATH" "$BIN/gsd-update" "$@" > "$WORK/out" 2>&1; }
cup --check
has "--check shows gsd-core per agent"  "gsd-core  : claude 1.0.0, latest 1.2.0" "$WORK/out"
has "…and that an update is there"      "update available" "$WORK/out"
if [ -e "$WORK/npx.log" ]; then bad "--check runs no installer"; else ok "--check runs no installer"; fi
cup --no-core
if [ -e "$WORK/npx.log" ]; then bad "--no-core leaves gsd-core alone"; else ok "--no-core leaves gsd-core alone"; fi
cup
is  "gsd-update updates gsd-core"       "$(cat "$CH/.claude/gsd-core/VERSION")" 1.2.0
is  "…with the full profile"            "$(cat "$WORK/npx.log")" "-y --package=@opengsd/gsd-core@latest -- gsd-core --claude --global --profile=full"
has "…saying so"                        "updating gsd-core for claude (1.0.0 → 1.2.0)" "$WORK/out"
cup
has "on the latest → left alone"        "claude gsd-core 1.2.0 is the latest" "$WORK/out"
is  "…no second run"                    "$(wc -l < "$WORK/npx.log" | tr -d ' ')" 1

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
