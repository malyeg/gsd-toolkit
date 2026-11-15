#!/usr/bin/env bash
# test-install.sh — the install script (npm way) and the bridge from 0.10.x.
#
#  1. install.sh against a fake GitHub release whose .tgz is a real `npm pack`
#     of this checkout, into a throwaway npm prefix and HOME (offline).
#  2. the bridge: a real v0.10.0 is installed by the REAL 0.10.0 install.sh;
#     then that same install.sh, and separately the installed 0.10.0 gsdt-update,
#     install a "new" release built from this checkout. lib/install.sh (in the
#     new .tar.gz) hands over to the new install.sh, which npm-installs the
#     .tgz and runs gsdt-setup, which removes the 0.10.x install.
# GitHub is a curl stub; npm is real but offline, with a throwaway prefix.
# Needs node >= 24, npm and the dev dependencies (npm ci) for `npm pack`.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; PKG="$(cd "$HERE/.." && pwd)"
PASS=0; FAIL=0; WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
WORK=$(cd "$WORK" && pwd -P)
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GSD_NO_UPDATE_CHECK=1 GSD_NO_CORE=1 GSD_UPDATE_REPO=acme/gsd-toolkit
unset CLAUDE_CONFIG_DIR CODEX_HOME GSD_BIN_DIR GSD_COPY_DIR GSD_RELEASES_DIR GSD_CLAUDE_SKILL_DIR GSD_CODEX_SKILL_DIR GSD_CLAUDE_SETTINGS GSD_SKIP_GUARD
ok()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '%s\n' "$2" | sed 's/^/      /'; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
has() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "no '$3' in: $(printf '%s' "$2" | tail -c 700)" ;; esac; }
hasnt() { case "$2" in *"$3"*) bad "$1" "unexpected '$3' in: $(printf '%s' "$2" | tail -c 700)" ;; *) ok "$1" ;; esac; }
section() { printf '\n%s\n' "$1"; }
finish() { printf '\n── %d passed, %d failed ──\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; exit $?; }

NODE=$(command -v node || true)
if [ -z "$NODE" ] || ! command -v npm >/dev/null 2>&1; then echo "skip: needs node and npm"; exit 0; fi
if [ ! -x "$PKG/node_modules/.bin/tsc" ]; then bad "dev dependencies installed (run: npm ci)"; finish; fi
NODEDIR=$(dirname "$NODE")
SYS="/usr/bin:/bin:/usr/sbin:/sbin"
for t in git perl python3 jq; do c=$(command -v "$t" 2>/dev/null) && case ":$SYS:" in *":$(dirname "$c"):"*) ;; *) SYS="$SYS:$(dirname "$c")" ;; esac; done

# ── the fake GitHub ──────────────────────────────────────────────────────────
REL="$WORK/served"; mkdir -p "$REL" "$WORK/stub"
export WORK REL
cat > "$WORK/stub/curl" <<'CURL'
#!/usr/bin/env bash
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; -H|--max-time|--retry|--retry-delay) shift ;; http*) url=$1 ;; esac; shift; done
echo "$url" >> "$WORK/curl.log"
case "$url" in
  https://api.github.com/repos/acme/gsd-toolkit/releases/latest)
    [ -s "$WORK/latest" ] || exit 22
    printf '{"url":"x","tag_name": "v%s","name":"n"}' "$(cat "$WORK/latest")" ;;
  https://github.com/acme/gsd-toolkit/releases/download/*)
    f="$REL/${url#https://github.com/acme/gsd-toolkit/releases/download/}"
    [ -f "$f" ] || exit 22
    if [ -n "$out" ]; then cp "$f" "$out"; else cat "$f"; fi ;;
  *) exit 6 ;;
esac
CURL
chmod +x "$WORK/stub/curl"
sums() {  # $1=dir, then files → SHA256SUMS
  local d=$1; shift
  (cd "$d" && for f in "$@"; do { sha256sum "$f" 2>/dev/null || shasum -a 256 "$f"; }; done > SHA256SUMS)
}

section "pack this checkout (the release's .tgz)"
export npm_config_cache="$WORK/npm-cache" npm_config_offline=true npm_config_update_notifier=false
TGZ_NAME=$(cd "$PKG" && npm pack --silent --pack-destination "$WORK" 2>"$WORK/pack.err" | tail -1)
TGZ="$WORK/$TGZ_NAME"
if [ -f "$TGZ" ]; then ok "npm pack built $TGZ_NAME"; else bad "npm pack" "$(tail -5 "$WORK/pack.err")"; finish; fi
VER=$(head -1 "$PKG/VERSION")
NEWV=77.0.0   # the release's label (the packed package keeps this checkout's own version)

# release $1: the .tgz of this checkout + SHA256SUMS; the .tar.gz (what a 0.10.x installer
# downloads) holds install.sh, lib/install.sh and the tracked files of this checkout
release() {
  local v=$1 d="$REL/v$1"
  mkdir -p "$d"
  cp "$TGZ" "$d/gsd-toolkit-$v.tgz"
  local b="$WORK/build/gsd-toolkit-$v"; rm -rf "$b"; mkdir -p "$b"
  (cd "$PKG" && git ls-files -z | tar --null -T - -cf - 2>/dev/null) | tar -xf - -C "$b"
  cp "$PKG/install.sh" "$b/install.sh"; cp "$PKG/lib/install.sh" "$b/lib/install.sh"
  printf '%s\n' "$v" > "$b/VERSION"
  tar -czf "$d/gsd-toolkit-$v.tar.gz" -C "$WORK/build" "gsd-toolkit-$v"
  sums "$d" "gsd-toolkit-$v.tar.gz" "gsd-toolkit-$v.tgz"
}
release "$NEWV"; release 76.0.0
echo "$NEWV" > "$WORK/latest"

# a throwaway machine: HOME + npm prefix; PATH has the stubs, system tools and node only
new_machine() {  # $1=name → sets H, PFX
  H="$WORK/m-$1/home"; PFX="$WORK/m-$1/pfx"; mkdir -p "$H" "$PFX"
}
run() {  # run a command in the machine (H, PFX): HOME, npm prefix, PATH without npm's bin
  env HOME="$H" XDG_CONFIG_HOME="$H/.config" XDG_CACHE_HOME="$H/.cache" npm_config_prefix="$PFX" \
    PATH="$WORK/stub:$SYS:$NODEDIR" "$@"
}
sk() { printf '%s' "$H/.claude/skills/$1/SKILL.md"; }

section "install.sh — latest release, from GitHub"
new_machine a
o=$(run bash "$PKG/install.sh" --no-core 2>&1 </dev/null); rc=$?
is "installs (rc)" "$rc" "0"
has "…says what it installed" "$o" "✔ gsd-toolkit $NEWV installed"
[ -f "$PFX/lib/node_modules/gsd-toolkit/package.json" ] && ok "the package is in the npm prefix" || bad "the package is in the npm prefix" "$o"
is "…it is this checkout's package" "$(head -1 "$PFX/lib/node_modules/gsd-toolkit/VERSION")" "$VER"
[ -e "$PFX/bin/gsdt-start" ] && ok "npm linked gsdt-start into the prefix bin" || bad "npm linked gsdt-start into the prefix bin"
grep -q "releases/latest" "$WORK/curl.log" && ok "latest came from the GitHub API" || bad "latest came from the GitHub API"
grep -q "v$NEWV/SHA256SUMS" "$WORK/curl.log" && grep -q "v$NEWV/gsd-toolkit-$NEWV.tgz" "$WORK/curl.log" && ok "SHA256SUMS and the .tgz were downloaded" || bad "SHA256SUMS and the .tgz were downloaded"
hasnt "…the .tar.gz was not" "$(cat "$WORK/curl.log")" "$NEWV.tar.gz"
[ -f "$(sk gsdt-flow)" ] && ok "setup ran: the Claude skills are in HOME" || bad "setup ran: the Claude skills are in HOME" "$o"
S=$(cat "$H/.claude/settings.json" 2>/dev/null)
has "…user hook: guard from the npm bin dir" "$S" "exec '$PFX/bin/gsdt-worktree-guard' --global"
has "…user hook: rules from the npm bin dir" "$S" "exec '$PFX/bin/gsdt-rules' --hook"
has "npm's bin dir is not on PATH: the line to add is printed" "$o" "export PATH=\"$PFX/bin:\$PATH\""
o=$(run env PATH="$PFX/bin:$WORK/stub:$SYS:$NODEDIR" bash "$PKG/install.sh" --no-core 2>&1 </dev/null); rc=$?
is "a second run (npm's bin dir on PATH) succeeds" "$rc" "0"
hasnt "…and prints no PATH line" "$o" "is not on your PATH"

section "install.sh — --version, agents, options"
new_machine b
: > "$WORK/curl.log"
o=$(run bash "$PKG/install.sh" --version v76.0.0 --agent codex --no-core --reuse-install-config 2>&1 </dev/null); rc=$?
is "--version 76.0.0 --agent codex (rc)" "$rc" "0"
hasnt "--version: no latest lookup" "$(cat "$WORK/curl.log")" "releases/latest"
[ -f "$H/.agents/skills/gsdt-flow/SKILL.md" ] && ok "--agent codex: skills in the Codex dir" || bad "--agent codex: skills in the Codex dir" "$o"
[ -f "$(sk gsdt-flow)" ] && bad "…and not in Claude's" || ok "…and not in Claude's"
has "says 76.0.0" "$o" "✔ gsd-toolkit 76.0.0 installed"
new_machine c
o=$(run bash "$PKG/install.sh" --no-core --no-user-hook 2>&1 </dev/null); rc=$?
is "--no-user-hook (rc)" "$rc" "0"
hasnt "…no hooks written" "$(cat "$H/.claude/settings.json" 2>/dev/null)" "gsdt-worktree-guard"
new_machine d
o=$(run bash "$PKG/install.sh" --agent gemini 2>&1 </dev/null); rc=$?
is "gemini is refused (rc)" "$rc" "1"; has "…with its reason" "$o" "no longer supported"
o=$(run bash "$PKG/install.sh" --bogus 2>&1 </dev/null); rc=$?
is "an unknown option is refused" "$rc" "1"
o=$(run bash "$PKG/install.sh" --version latest 2>&1 </dev/null); rc=$?
is "a non-version is refused" "$rc" "1"
is "…nothing was installed" "$(find "$PFX/lib/node_modules" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')" "0"
o=$(run bash "$PKG/install.sh" --help 2>&1 </dev/null); has "--help prints the usage header" "$o" "curl -fsSL"

section "install.sh — refusals leave nothing behind"
release 75.0.0; printf '%s\n' "0000000000000000000000000000000000000000000000000000000000000000  gsd-toolkit-75.0.0.tgz" > "$REL/v75.0.0/SHA256SUMS"
new_machine e
o=$(run bash "$PKG/install.sh" --version 75.0.0 --no-core 2>&1 </dev/null); rc=$?
is "a checksum mismatch is refused" "$rc" "1"; has "…saying so" "$o" "checksum mismatch"
[ -e "$PFX/lib/node_modules/gsd-toolkit" ] && bad "…nothing installed" || ok "…nothing installed"
[ -e "$H/.claude" ] && bad "…no skills or hooks written" || ok "…no skills or hooks written"
# a release before 1.0.0: its SHA256SUMS lists only the .tar.gz
mkdir -p "$REL/v0.10.0"; printf 'old\n' > "$REL/v0.10.0/gsd-toolkit-0.10.0.tar.gz"; sums "$REL/v0.10.0" gsd-toolkit-0.10.0.tar.gz
o=$(run bash "$PKG/install.sh" --version 0.10.0 --no-core 2>&1 </dev/null); rc=$?
is "a release with no npm package is refused" "$rc" "1"
has "…with its own installer's line" "$o" "0.10.0 has no npm package; install it with its own installer: curl -fsSL https://raw.githubusercontent.com/acme/gsd-toolkit/v0.10.0/install.sh | bash"
o=$(run bash "$PKG/install.sh" --version 5.5.5 --no-core 2>&1 </dev/null); rc=$?
is "a missing release is refused" "$rc" "1"; has "…as a failed download" "$o" "download failed"
# node
mkdir -p "$WORK/oldnode"
printf '#!/bin/sh\ncase "$*" in -v) echo v20.1.0 ;; *) echo 20 ;; esac\n' > "$WORK/oldnode/node"; chmod +x "$WORK/oldnode/node"
o=$(run env PATH="$WORK/oldnode:$WORK/stub:$SYS:$NODEDIR" bash "$PKG/install.sh" --no-core 2>&1 </dev/null); rc=$?
is "node 20 is refused" "$rc" "1"; has "…saying node 24 is needed" "$o" "Node.js 24 or newer is required (found v20.1.0)"
[ -e "$PFX/lib/node_modules/gsd-toolkit" ] && bad "…nothing installed" || ok "…nothing installed"
NONODE=1; PATH="$WORK/stub:$SYS" command -v node >/dev/null 2>&1 && NONODE=0
if [ "$NONODE" = 1 ]; then
  o=$(run env PATH="$WORK/stub:$SYS" bash "$PKG/install.sh" --no-core 2>&1 </dev/null); rc=$?
  is "no node: refused" "$rc" "1"; has "…saying what to install" "$o" "Node.js 24 or newer is required"
else
  printf '  • skipped "no node": a node sits in a system dir here\n'
fi

section "the bridge — a real 0.10.0 install, then 0.10.0's own installer / gsdt-update get the new release"
if ! git -C "$PKG" rev-parse -q --verify 'v0.10.0^{commit}' >/dev/null; then
  if [ -n "${CI:-}" ]; then bad "the bridge needs the v0.10.0 tag (checkout with fetch-depth: 0)"; else printf '  • skipped: no v0.10.0 tag here (git fetch --tags)\n'; fi
  finish
fi
OLD="$WORK/src-0100"; mkdir -p "$OLD"; git -C "$PKG" archive v0.10.0 | tar -x -C "$OLD"
git -C "$PKG" show v0.10.0:install.sh > "$WORK/install-0.10.0.sh"
mkdir -p "$REL/v0.10.0"
tar -czf "$REL/v0.10.0/gsd-toolkit-0.10.0.tar.gz" -C "$WORK" --transform 's#^src-0100#gsd-toolkit-0.10.0#' src-0100 2>/dev/null \
  || { mkdir -p "$WORK/b0"; cp -R "$OLD" "$WORK/b0/gsd-toolkit-0.10.0"; tar -czf "$REL/v0.10.0/gsd-toolkit-0.10.0.tar.gz" -C "$WORK/b0" gsd-toolkit-0.10.0; }
sums "$REL/v0.10.0" gsd-toolkit-0.10.0.tar.gz   # a 0.10.0 release: no .tgz
echo 0.10.0 > "$WORK/latest"

old_machine() {  # $1=name: a machine with the real 0.10.0 installed
  new_machine "$1"
  run bash "$WORK/install-0.10.0.sh" --version 0.10.0 --agent claude > "$WORK/old-$1.out" 2>&1 </dev/null
}
old_machine f
[ -L "$H/.local/bin/gsdt-list" ] && [ -f "$H/.local/share/gsd-toolkit/releases/0.10.0/VERSION" ] && ok "0.10.0 is installed by its own install.sh (links + runtime)" \
  || { bad "0.10.0 installed" "$(tail -8 "$WORK/old-f.out")"; finish; }
has "…with its Claude user hooks in ~/.local/bin" "$(cat "$H/.claude/settings.json")" "$H/.local/bin/gsdt-worktree-guard"
echo "$NEWV" > "$WORK/latest"

check_moved() {  # $1=label, $2=output file
  local l=$1
  [ -f "$PFX/lib/node_modules/gsd-toolkit/package.json" ] && ok "$l: gsd-toolkit is in the npm prefix" || bad "$l: gsd-toolkit is in the npm prefix" "$(tail -15 "$2")"
  is "$l: it is this checkout's package" "$(head -1 "$PFX/lib/node_modules/gsd-toolkit/VERSION" 2>/dev/null)" "$VER"
  is "$l: no 0.10.x gsdt-* link is left in ~/.local/bin" "$(find "$H/.local/bin" -name 'gsdt-*' 2>/dev/null | wc -l | tr -d ' ')" "0"
  [ -e "$H/.local/share/gsd-toolkit" ] && bad "$l: ~/.local/share/gsd-toolkit is gone" "$(find "$H/.local/share" | head -5)" || ok "$l: ~/.local/share/gsd-toolkit is gone"
  local s; s=$(cat "$H/.claude/settings.json" 2>/dev/null)
  has "$l: Claude hooks point at the npm bin dir (guard)" "$s" "exec '$PFX/bin/gsdt-worktree-guard' --global"
  has "$l: Claude hooks point at the npm bin dir (rules)" "$s" "exec '$PFX/bin/gsdt-rules' --hook"
  hasnt "$l: no hook still points at ~/.local/bin" "$s" "$H/.local/bin"
  [ -f "$(sk gsdt-flow)" ] && ok "$l: skills present" || bad "$l: skills present"
  has "$l: …marked with the new package's version" "$(tail -1 "$(sk gsdt-flow)")" "$VER"
}

# a: the 0.10.0 install.sh
run bash "$WORK/install-0.10.0.sh" --agent claude > "$WORK/bridge-a.out" 2>&1 </dev/null; rc=$?
is "0.10.0's install.sh gets $NEWV (rc)" "$rc" "0"
has "…its own closing line" "$(cat "$WORK/bridge-a.out")" "✔ gsd-toolkit $NEWV installed"
check_moved "install.sh" "$WORK/bridge-a.out"
has "…the 0.10.x download was the .tar.gz, then the .tgz" "$(grep -c "v$NEWV/gsd-toolkit-$NEWV.tar.gz" "$WORK/curl.log")" "1"
grep -q "v$NEWV/gsd-toolkit-$NEWV.tgz" "$WORK/curl.log" && ok "…and the bridge downloaded the .tgz" || bad "…and the bridge downloaded the .tgz"

# b: the installed 0.10.0 gsdt-update
old_machine g
echo "$NEWV" > "$WORK/latest"
o=$(run "$H/.local/bin/gsdt-update" 2>&1 </dev/null); rc=$?
printf '%s\n' "$o" > "$WORK/bridge-b.out"
is "0.10.0's gsdt-update gets $NEWV (rc, GSD_NO_CORE=1)" "$rc" "0"
check_moved "gsdt-update" "$WORK/bridge-b.out"
# without GSD_NO_CORE gsdt-update would go on to sync gsd-core with its already-sourced functions: not run here (npx)

# c: a bridge that cannot finish leaves the 0.10.x install as it was
section "the bridge — a failure removes nothing"
old_machine h
snap() { (cd "$H" && find .local .claude -type f -o -type l 2>/dev/null | sort | while read -r f; do printf '%s %s\n' "$f" "$( [ -L "$f" ] && readlink "$f" || cksum < "$f")"; done) | cksum; }
before=$(snap)
o=$(run env PATH="$WORK/oldnode:$WORK/stub:$SYS:$NODEDIR" bash "$WORK/install-0.10.0.sh" --agent claude 2>&1 </dev/null); rc=$?
is "node 20: the bridge exits non-zero" "$rc" "1"
has "…saying node 24 is needed" "$o" "Node.js 24 or newer is required"
is "…the 0.10.0 install is untouched" "$(snap)" "$before"
[ -e "$PFX/lib/node_modules/gsd-toolkit" ] && bad "…no npm package" || ok "…no npm package"
if [ "$NONODE" = 1 ]; then
  o=$(run env PATH="$WORK/stub:$SYS" bash "$WORK/install-0.10.0.sh" --agent claude 2>&1 </dev/null); rc=$?
  is "no node: the bridge exits non-zero" "$rc" "1"
  is "…the 0.10.0 install is untouched" "$(snap)" "$before"
  o=$(run env PATH="$WORK/stub:$SYS" "$H/.local/bin/gsdt-update" 2>&1 </dev/null); rc=$?
  is "no node: the 0.10.0 gsdt-update exits non-zero" "$rc" "1"
  is "…and leaves its install untouched" "$(snap)" "$before"
fi
echo 76.0.0 > "$WORK/latest"
{ grep 'tar.gz' "$REL/v76.0.0/SHA256SUMS"; printf '%s\n' "0000000000000000000000000000000000000000000000000000000000000000  gsd-toolkit-76.0.0.tgz"; } > "$WORK/sums.new"
cp "$WORK/sums.new" "$REL/v76.0.0/SHA256SUMS"
o=$(run bash "$WORK/install-0.10.0.sh" --agent claude 2>&1 </dev/null); rc=$?
is "a bad .tgz checksum: the bridge exits non-zero" "$rc" "1"
is "…the 0.10.0 install is untouched" "$(snap)" "$before"

finish
