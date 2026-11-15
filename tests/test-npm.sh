#!/usr/bin/env bash
# test-npm.sh — the npm package, as users get it: `npm pack` this checkout
# (prepack builds dist/), `npm install -g` the tarball into a throwaway prefix,
# then run the installed commands with NOTHING from the checkout on PATH:
# package contents, every entry, the merge driver in a real merge, the guard
# hook, doctor in a set-up repo, gsdt-setup (skills, user hooks, moving a
# 0.10.x install off ~/.local/bin) and gsdt-update's npm mode (npm stubbed).
# Needs node >= 24, npm, and the dev dependencies (npm ci) for the build.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; PKG="$(cd "$HERE/.." && pwd)"
PASS=0; FAIL=0; WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
WORK=$(cd "$WORK" && pwd -P)
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GSD_NO_UPDATE_CHECK=1 GSD_NO_CORE=1
unset CLAUDE_CONFIG_DIR CODEX_HOME GSD_BIN_DIR GSD_CLAUDE_SKILL_DIR GSD_CODEX_SKILL_DIR GSD_SKIP_GUARD
ok()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
has() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1" "no '$3' in: $(printf '%s' "$2" | head -c 600)" ;; esac; }
hasnt() { case "$2" in *"$3"*) bad "$1" "unexpected '$3' in: $(printf '%s' "$2" | head -c 600)" ;; *) ok "$1" ;; esac; }
section() { printf '\n%s\n' "$1"; }
finish() { printf '\n── %d passed, %d failed ──\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; exit $?; }

NODE=$(command -v node || true)
if [ -z "$NODE" ] || ! command -v npm >/dev/null 2>&1; then
  echo "skip: needs node and npm"; exit 0
fi
if [ ! -x "$PKG/node_modules/.bin/tsc" ]; then
  bad "dev dependencies installed (run: npm ci)"; finish
fi
# Only system tools + node: no checkout bin/, no ~/.local/bin 0.10.x install.
SYS="/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$NODE")"
for t in git perl python3 jq; do c=$(command -v "$t" 2>/dev/null) && case ":$SYS:" in *":$(dirname "$c"):"*) ;; *) SYS="$SYS:$(dirname "$c")" ;; esac; done

section "pack"
TGZ_NAME=$(cd "$PKG" && npm pack --silent --pack-destination "$WORK" 2>"$WORK/pack.err" | tail -1)
TGZ="$WORK/$TGZ_NAME"
if [ -f "$TGZ" ]; then ok "npm pack built $TGZ_NAME"; else bad "npm pack" "$(tail -5 "$WORK/pack.err")"; finish; fi
LIST=$(tar tzf "$TGZ" | sed 's|^package/||')
VER=$(head -1 "$PKG/VERSION")
is "package.json version = VERSION" "$("$NODE" -p 'require(process.argv[1]).version' "$PKG/package.json")" "$VER"
want=$( (cd "$PKG/bin" && ls; echo gsdt-setup) | sort -u | tr '\n' ' ')
got=$("$NODE" -p 'Object.keys(require(process.argv[1]).bin).sort().join(" ")+" "' "$PKG/package.json")
is "package.json bin = bin/* + gsdt-setup" "$got" "$want"
miss=""; for n in $want; do printf '%s\n' "$LIST" | grep -qx "dist/bin/$n.js" || miss="$miss $n"; done
is "every bin entry is in the tarball" "$miss" ""
for f in src/launch.mjs dist/commands/start.js dist/tracker/cli.js shims/scripts/hooks/gsdt-worktree-guard.sh \
         skills/gsdt-flow/SKILL.md lib/vendor/axe-core/axe.min.js VERSION LICENSE; do
  printf '%s\n' "$LIST" | grep -qx "$f" && ok "ships $f" || bad "ships $f"
done
is "no TypeScript sources shipped" "$(printf '%s\n' "$LIST" | grep -c '\.ts$')" "0"
is "no bash/python/perl libs shipped" "$(printf '%s\n' "$LIST" | grep -cE '^lib/[^/]+\.(sh|py|pl)$|^lib/tracker/')" "0"
is "no tests or install.sh shipped" "$(printf '%s\n' "$LIST" | grep -cE '^tests/|^install\.sh$|^tools/')" "0"

section "install -g into a throwaway prefix"
PFX="$WORK/pfx"; export npm_config_cache="$WORK/npm-cache"
if npm install -g --prefix "$PFX" --offline --no-audit --no-fund --silent "$TGZ" >"$WORK/inst.out" 2>&1; then ok "npm install -g"
else bad "npm install -g" "$(tail -5 "$WORK/inst.out")"; finish; fi
IPKG=$(cd "$PFX/lib/node_modules/gsd-toolkit" 2>/dev/null && pwd -P)
[ -n "$IPKG" ] && ok "installed at $IPKG" || { bad "package dir"; finish; }
export PATH="$PFX/bin:$SYS"
bad_link=""
for n in $want; do
  p=$(command -v "$n") || { bad_link="$bad_link $n(missing)"; continue; }
  r=$(cd "$(dirname "$p")" && "$NODE" -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$p")
  case "$r" in "$IPKG"/dist/bin/*) ;; *) bad_link="$bad_link $n→$r" ;; esac
done
is "every command on PATH is the package's npm entry" "$bad_link" ""

section "every entry starts"
for n in $want; do
  case "$n" in gsdt-planning-merge|gsdt-wt-finish|gsdt-derive-port|gsdt-worktree-guard) continue ;; esac
  o=$(cd "$WORK" && "$n" --help 2>&1); rc=$?
  if [ "$rc" = 0 ] && printf '%s' "$o" | grep -q "$n"; then ok "$n --help"; else bad "$n --help (rc $rc)" "$(printf '%s' "$o" | head -3)"; fi
  hasnt "$n: no module error" "$o" "Cannot find module"
done
is "gsdt-derive-port 300 (a number, rc 0)" "$(cd "$WORK" && gsdt-derive-port 300 >/dev/null 2>&1; echo $?)" "0"
o=$(cd "$WORK" && gsdt-rules --hook 2>&1); is "gsdt-rules --hook outside a repo: silent" "$o" ""
o=$(cd "$WORK" && printf '{}' | gsdt-worktree-guard --global 2>&1; echo "rc=$?"); is "guard --global on {}: allowed" "$o" "rc=0"
o=$(cd "$WORK" && GSD_SKIP_GUARD=1 gsdt-worktree-guard --command gsd-execute-phase --args 1 --repo "$WORK" 2>&1; echo "rc=$?")
is "GSD_SKIP_GUARD=1: allowed" "$o" "rc=0"

section "a set-up repo, run from the npm install"
R="$WORK/repo"; O="$WORK/origin.git"
git init -q --bare -b main "$O"
git init -q -b main "$R"; git -C "$R" commit -q --allow-empty -m init; git -C "$R" remote add origin "$O"; git -C "$R" push -q -u origin main
o=$(cd "$R" && gsdt-bootstrap-repo --agent claude --no-ui 2>&1); rc=$?
is "gsdt-bootstrap-repo rc" "$rc" "0"
hasnt "bootstrap: no module error" "$o" "Cannot find module"
is "merge driver runs gsdt-planning-merge by name" "$(git -C "$R" config merge.gsd-planning.driver | awk '{print $1}')" "gsdt-planning-merge"
[ -f "$R/scripts/gsdt-finish-worktree-feature.sh" ] && ok "shims copied from the package" || bad "shims copied from the package"
mkdir -p "$R/.planning"
has ".gitattributes routes STATE.md to the driver" "$(cat "$R/.gitattributes" 2>/dev/null)" "merge=gsd-planning"
printf '# State\n\n## Current Position\n\nPhase: 1\nStatus: planning\n\n## Session Continuity\n\nLast session: x\n' > "$R/.planning/STATE.md"
printf '# Roadmap\n\n- [ ] **Phase 1: one**\n' > "$R/.planning/ROADMAP.md"
git -C "$R" add -A; git -C "$R" commit -qm setup
git -C "$R" checkout -qb side
sed -i.bak 's/^Status: planning/Status: executing/' "$R/.planning/STATE.md"; rm -f "$R/.planning/STATE.md.bak"
git -C "$R" commit -qam side
git -C "$R" checkout -q main
sed -i.bak 's/^Status: planning/Status: verifying/' "$R/.planning/STATE.md"; rm -f "$R/.planning/STATE.md.bak"
printf -- '- [ ] **Phase 2: two**\n' >> "$R/.planning/ROADMAP.md"
git -C "$R" commit -qam main
o=$(git -C "$R" merge -q --no-edit side 2>&1); rc=$?
is "planning merge through the npm driver: no conflict" "$rc" "0"
st=$(cat "$R/.planning/STATE.md")
has "merged STATE: Session Continuity kept" "$st" "Last session: x"
has "merged STATE takes side's status" "$st" "Status: executing"
is "one Status line (reconciled, not a plain union)" "$(grep -c '^Status:' "$R/.planning/STATE.md")" "1"
o=$(cd "$R" && gsdt-doctor 2>&1)
hasnt "doctor: no module error" "$o" "Cannot find module"
hasnt "doctor: command guards found in the npm package (no T053)" "$o" "T053"
has "doctor: PATH commands resolve to the package" "$o" "PATH commands resolve to $IPKG"
o=$(cd "$R" && gsdt-list 2>&1); rc=$?
is "gsdt-list rc" "$rc" "0"
o=$(cd "$R" && gsdt-tracker config 2>&1); rc=$?
is "gsdt-tracker config rc (standalone set ships)" "$rc" "0"
has "gsdt-tracker config prints the tracker" "$o" "tracker="
o=$(cd "$R" && gsdt-rules 2>&1)
has "gsdt-rules prints the rules" "$o" "gsdt-start"

section "gsdt-setup (temp HOME)"
H="$WORK/home"; mkdir -p "$H/.local/bin" "$H/.local/share/gsd-toolkit/releases/0.10.0/bin" "$H/.local/share/gsd-toolkit/releases/0.10.0/lib"
OLDRT="$H/.local/share/gsd-toolkit/releases/0.10.0"
touch "$OLDRT/install.sh" "$OLDRT/lib/common.sh"; printf '#!/bin/sh\n' > "$OLDRT/bin/gsdt-list"; chmod +x "$OLDRT/bin/gsdt-list"
ln -s "$OLDRT/bin/gsdt-list" "$H/.local/bin/gsdt-list"
ln -s /usr/bin/true "$H/.local/bin/gsdt-mine"          # not ours: stays
printf 'providers\tclaude,codex\n' > "$H/.local/bin/.gsd-install-manifest"
mkdir -p "$H/.claude"; printf '{\n  "model": "opus",\n  "n": 1.0\n}\n' > "$H/.claude/settings.json"
o=$(HOME="$H" XDG_CONFIG_HOME="$H/.config" gsdt-setup 2>&1); rc=$?
is "gsdt-setup rc" "$rc" "0"
hasnt "setup: no module error" "$o" "Cannot find module"
for a in "$H/.claude/skills" "$H/.agents/skills"; do
  [ -f "$a/gsdt-flow/SKILL.md" ] && ok "skill gsdt-flow in $a (agents kept from the 0.10.x install)" || bad "skill gsdt-flow in $a" "$o"
  has "skill marked with the version" "$(tail -1 "$a/gsdt-flow/SKILL.md" 2>/dev/null)" "$VER"
done
S=$(cat "$H/.claude/settings.json")
has "user hook: guard from the npm bin" "$S" "exec '$PFX/bin/gsdt-worktree-guard' --global"
has "user hook: rules from the npm bin" "$S" "exec '$PFX/bin/gsdt-rules' --hook"
has "other settings kept byte-exact (1.0 stays 1.0)" "$S" '"n": 1.0'
[ -L "$H/.local/bin/gsdt-list" ] && bad "0.10.x link removed" "$o" || ok "0.10.x link removed"
[ -L "$H/.local/bin/gsdt-mine" ] && ok "a link that is not ours stays" || bad "a link that is not ours stays"
[ -d "$H/.local/share/gsd-toolkit" ] && bad "0.10.x runtime removed" "$o" || ok "0.10.x runtime removed"
[ -f "$H/.local/bin/.gsd-install-manifest" ] && bad "old manifest removed" || ok "old manifest removed"
has "manifest records the agents" "$(cat "$H/.config/gsd/setup-manifest" 2>/dev/null)" "providers	claude,codex"
cp "$H/.claude/settings.json" "$WORK/settings.1"
o=$(HOME="$H" XDG_CONFIG_HOME="$H/.config" gsdt-setup 2>&1)
is "second run: settings unchanged (no duplicate hooks)" "$(cmp -s "$WORK/settings.1" "$H/.claude/settings.json" && echo same)" "same"
has "second run: skills already current" "$o" "already current"

section "gsdt-update, npm mode (GitHub = a curl stub serving the release; npm stubbed)"
# The release is the one source: latest from the GitHub API, SHA256SUMS + the .tgz from the
# release download; the npm registry is never asked (the npm stub fails any `view`).
STUB="$WORK/stub"; mkdir -p "$STUB" "$WORK/rel/v99.0.0"
cp "$TGZ" "$WORK/rel/v99.0.0/gsd-toolkit-99.0.0.tgz"
(cd "$WORK/rel/v99.0.0" && { sha256sum gsd-toolkit-99.0.0.tgz 2>/dev/null || shasum -a 256 gsd-toolkit-99.0.0.tgz; } > SHA256SUMS)
cat > "$STUB/curl" <<EOF
#!/bin/sh
echo "\$*" >> "$WORK/curl.log"
out=""; url=""
while [ \$# -gt 0 ]; do case "\$1" in -o) out=\$2; shift ;; -H|--max-time|--retry|--retry-delay) shift ;; http*) url=\$1 ;; esac; shift; done
case "\$url" in
  */releases/latest) printf '{"tag_name": "v%s"}' "\${LATEST:-}" ;;
  */releases/download/*) f="$WORK/rel/\${url#*/releases/download/}"; [ -f "\$f" ] || exit 22; if [ -n "\$out" ]; then cp "\$f" "\$out"; else cat "\$f"; fi ;;
  *) exit 6 ;;
esac
EOF
cat > "$STUB/npm" <<EOF
#!/bin/sh
echo "\$*" >> "$WORK/npm.log"
case "\$1" in
  install|i) exit \${NPM_INSTALL_RC:-0} ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$STUB/npm" "$STUB/curl"
UPD="env HOME=$H XDG_CONFIG_HOME=$H/.config XDG_CACHE_HOME=$WORK/cache GSD_UPDATE_REPO=acme/gsd-toolkit PATH=$STUB:$PATH"
o=$($UPD LATEST=99.0.0 gsdt-update --check --no-core 2>&1); rc=$?
is "update --check rc" "$rc" "0"
has "update --check: installed version" "$o" "installed : $VER"
has "update --check: latest from GitHub" "$o" "latest    : 99.0.0  (acme/gsd-toolkit)"
has "update --check: offers the update" "$o" "update available"
: > "$WORK/npm.log"
o=$($UPD LATEST=99.0.0 gsdt-update --no-core 2>&1); rc=$?
is "update rc" "$rc" "0"
has "update ran npm install -g on the downloaded .tgz" "$(cat "$WORK/npm.log")" "install -g --no-audit --no-fund"
has "…the release's gsd-toolkit-99.0.0.tgz" "$(cat "$WORK/npm.log")" "gsd-toolkit-99.0.0.tgz"
hasnt "no npm registry lookup" "$(cat "$WORK/npm.log")" "view"
has "update says it installed" "$o" "gsd-toolkit 99.0.0 installed"
o=$($UPD LATEST="$VER" gsdt-update --check --no-core 2>&1)
has "same version: up to date" "$o" "up to date"

finish
