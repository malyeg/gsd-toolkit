#!/usr/bin/env bash
#
# install.sh — install (or update) gsd-toolkit from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh | bash
#   curl -fsSL …/install.sh | bash -s -- --agent claude --agent codex
#
# It downloads the release's npm package (gsd-toolkit-X.Y.Z.tgz) and its
# SHA256SUMS, checks the checksum, runs `npm install -g` on it, then runs the
# new package's `gsdt-setup` (skills, user hooks, gsd-core). The GitHub
# release is the only source: nothing needs the npm registry. Run as
# ./install.sh in a checkout it does the same: it installs the release, never
# the checkout's own files.
#
# Options:
#   --version <X.Y.Z>   install that release (default: the latest)
#   --agent <p>, --all-agents
#                       which agents get the skills (claude, codex; default claude)
#   --no-core           do not install GSD itself (gsd-core); by default it
#                       is added for each agent that has none
#   --no-user-hook      leave out (and remove) the user-level Claude hooks
#   --reuse-install-config
#                       accepted and ignored (gsdt-setup keeps the agents the
#                       last install chose)
#
# A 0.10.x install is moved over by gsdt-setup (the ~/.local/bin links and
# ~/.local/share/gsd-toolkit are removed). Releases before 0.11.0 have no npm
# package: install them with their own install.sh.
#
# Env: GSD_UPDATE_REPO (owner/name, default malyeg/gsd-toolkit); npm's own
#      settings (npm_config_prefix, …) say where it installs.
# Needs: bash, curl, node >= 24 and npm. (Windows: Git Bash.)
set -euo pipefail

SLUG=${GSD_UPDATE_REPO:-malyeg/gsd-toolkit}
die() { printf 'gsd-toolkit install: %s\n' "$*" >&2; exit 1; }
# --copy: what a very old release's get.sh passes to the release it downloaded.
# lib/install.sh (the bridge from 0.10.x) takes it from here.
for a in "$@"; do
  [ "$a" = --copy ] || continue
  here=$(dirname "$0")
  [ -f "$here/lib/install.sh" ] || die "--copy installs an unpacked package; run it from one"
  exec bash "$here/lib/install.sh" "$@"
done
VERSION=""; PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs X.Y.Z"; VERSION=${2#v}; shift 2 ;;
    --agent) [ $# -ge 2 ] || die "--agent needs a provider"
      case "$2" in
        claude|codex) ;;
        gemini) die 'Gemini is no longer supported (gsd-core, the new GSD, dropped it); use --agent claude or codex' ;;
        *) die "unknown provider: $2" ;;
      esac
      PASS+=(--agent "$2"); shift 2 ;;
    --all-agents|--no-core|--no-user-hook) PASS+=("$1"); shift ;;
    --reuse-install-config) shift ;;
    -h|--help) awk 'NR>1 && /^set -euo/{exit} NR>1 {sub(/^# ?/,""); print}' "$0" 2>/dev/null \
                 || echo "usage: install.sh [--version X.Y.Z] [--agent <p>]... [--all-agents] [--no-core] [--no-user-hook]"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v node >/dev/null 2>&1 || die "Node.js 24 or newer is required (https://nodejs.org); install it and run this again"
command -v npm >/dev/null 2>&1 || die "npm is required (it comes with Node.js: https://nodejs.org); install it and run this again"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
case "$NODE_MAJOR" in ''|*[!0-9]*) NODE_MAJOR=0 ;; esac
[ "$NODE_MAJOR" -ge 24 ] || die "Node.js 24 or newer is required (found $(node -v 2>/dev/null || echo unknown)); update it (https://nodejs.org) and run this again"
# GitHub's release downloads sometimes answer 500/502/503 for a moment:
# retry those (curl retries only transient errors) before giving up.
RETRY=(--retry 3 --retry-delay 2)

if [ -z "$VERSION" ]; then
  VERSION=$(curl -fsSL "${RETRY[@]}" --max-time 15 -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/$SLUG/releases/latest" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([0-9][0-9.]*\)".*/\1/p' | head -1) \
    || die "cannot reach GitHub to find the latest release of $SLUG"
  [ -n "$VERSION" ] || die "no release found for $SLUG"
fi
printf '%s' "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || die "not a version: $VERSION (want X.Y.Z)"

# ── download + verify ────────────────────────────────────────────────────────
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/$SLUG/releases/download/v$VERSION"
NAME="gsd-toolkit-$VERSION.tgz"
echo "▶ downloading gsd-toolkit ${VERSION}…"
curl -fsSL "${RETRY[@]}" --max-time 30 "$URL/SHA256SUMS" -o "$TMP/SHA256SUMS" || die "download failed: $URL/SHA256SUMS"
awk -v f="$NAME" '$2 == f || $2 == "*" f {found=1} END {exit !found}' "$TMP/SHA256SUMS" \
  || die "$VERSION has no npm package; install it with its own installer: curl -fsSL https://raw.githubusercontent.com/$SLUG/v$VERSION/install.sh | bash"
curl -fsSL "${RETRY[@]}" --max-time 120 "$URL/$NAME" -o "$TMP/$NAME" || die "download failed: $URL/$NAME"
want=$(awk -v f="$NAME" '$2 == f || $2 == "*" f {print $1}' "$TMP/SHA256SUMS")
if command -v sha256sum >/dev/null 2>&1; then have=$(sha256sum "$TMP/$NAME" | awk '{print $1}')
else have=$(shasum -a 256 "$TMP/$NAME" | awk '{print $1}'); fi
[ -n "$want" ] && [ "$want" = "$have" ] || die "checksum mismatch for $NAME — not installed"

# ── install ──────────────────────────────────────────────────────────────────
TGZ="$TMP/$NAME"
# npm is a native program: on Windows (Git Bash) it wants a C:/… path
if command -v cygpath >/dev/null 2>&1; then TGZ=$(cygpath -m "$TGZ"); fi
echo "▶ npm install -g $NAME"
npm install -g --no-audit --no-fund "$TGZ" </dev/null || die "npm install failed (see above)"

PREFIX=$(npm prefix -g </dev/null)
ROOT=$(npm root -g </dev/null)
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) BINDIR=$PREFIX ;;
  *) BINDIR=$PREFIX/bin ;;
esac
LAUNCH="$ROOT/gsd-toolkit/src/launch.mjs"
[ -f "$LAUNCH" ] || die "the installed package has no $LAUNCH"
# The new package's setup. Its hooks point at npm's bin dir, which may not be
# on PATH yet. stdin is not setup's: under curl | bash it is the rest of this script.
GSD_BIN_DIR="$BINDIR" node "$LAUNCH" setup ${PASS[@]+"${PASS[@]}"} </dev/null || die "gsdt-setup failed (see above); run it again: gsdt-setup"

SHOWDIR=$BINDIR
if command -v cygpath >/dev/null 2>&1; then SHOWDIR=$(cygpath -u "$BINDIR"); fi
case ":$PATH:" in
  *":$BINDIR:"*|*":$SHOWDIR:"*) ;;
  *) echo
     echo "• $BINDIR is not on your PATH. Add it (for example in your shell's startup file):"
     echo "    export PATH=\"$SHOWDIR:\$PATH\"" ;;
esac
echo "✔ gsd-toolkit $VERSION installed"
