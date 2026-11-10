#!/usr/bin/env bash
#
# install.sh — install (or update) gsd-toolkit from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh | bash
#   curl -fsSL …/install.sh | bash -s -- --agent claude --agent codex
#
# The one way to install. Run as ./install.sh in a checkout it does the same:
# it installs the release, never the checkout's own files, so your repos run
# a release while you work on the toolkit.
#
# Options:
#   --version <X.Y.Z>   install that release (default: the latest)
#   --agent <p>, --all-agents
#                       which agents get the skills (claude, codex; default claude)
#   --reuse-install-config
#                       keep the agents the last install chose (gsdt-update)
#   --no-core           do not install GSD itself (gsd-core); by default it
#                       is added for each agent that has none
#   --no-user-hook      leave out (and remove) the user-level Claude hook
#
# Each release is unpacked to its own folder, checked against the release's
# SHA256SUMS, and installed by its own lib/install.sh:
#   ~/.local/share/gsd-toolkit/releases/<X.Y.Z>/   the runtime
#   ~/.local/bin/gsd-*                            links into it
# The release you had before stays (for going back: --version <old>); older
# ones are removed. No git checkout is needed.
#
# Before 0.8.0 the package was gsd-worktrees (arconme/gsd-worktrees): its
# releases are gsd-worktrees-X.Y.Z.tar.gz and its runtime was
# ~/.local/share/gsd-worktrees/. Both tarball names are read; that old
# runtime folder is removed once no command links into it.
#
# Env: GSD_BIN_DIR (default ~/.local/bin), GSD_RELEASES_DIR (default
#      GSD_BIN_DIR/../share/gsd-toolkit/releases), GSD_UPDATE_REPO
#      (owner/name, default malyeg/gsd-toolkit).
# Needs: bash, curl, tar, git, perl, python 3.7+; Node.js (npx) for gsd-core.
set -euo pipefail

SLUG=${GSD_UPDATE_REPO:-malyeg/gsd-toolkit}
die() { printf 'gsd-toolkit install: %s\n' "$*" >&2; exit 1; }
# --copy installs this unpacked package (what older releases' get.sh ask of
# the release they downloaded)
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
    --all-agents|--reuse-install-config|--no-core|--no-user-hook) PASS+=("$1"); shift ;;
    -h|--help) awk 'NR>1 && /^set -euo/{exit} NR>1 {sub(/^# ?/,""); print}' "$0" 2>/dev/null \
                 || echo "usage: install.sh [--version X.Y.Z] [--agent <p>]... [--all-agents] [--no-core]"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
for tool in curl tar; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
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

BIN=${GSD_BIN_DIR:-$HOME/.local/bin}
mkdir -p "$BIN"; BIN=$(cd "$BIN" && pwd -P)
RELEASES=${GSD_RELEASES_DIR:-$BIN/../share/gsd-toolkit/releases}
# gsdt-update passes the releases dir it runs from: the old name moves here.
case "$RELEASES" in */gsd-worktrees/releases|*/gsd-worktrees/releases/) RELEASES="${RELEASES%/gsd-worktrees/releases*}/gsd-toolkit/releases" ;; esac
mkdir -p "$RELEASES"; RELEASES=$(cd "$RELEASES" && pwd -P)
# The runtime of a release before 0.8.0, beside ours: only the standard
# layout (…/share/gsd-toolkit/releases) has one.
OLD_SHARE=""
case "$RELEASES" in */share/gsd-toolkit/releases) OLD_SHARE="${RELEASES%/gsd-toolkit/releases}/gsd-worktrees" ;; esac

# ── download + verify ────────────────────────────────────────────────────────
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/$SLUG/releases/download/v$VERSION"
echo "▶ downloading gsd-toolkit ${VERSION}…"
curl -fsSL "${RETRY[@]}" --max-time 30 "$URL/SHA256SUMS" -o "$TMP/SHA256SUMS" || die "download failed: $URL/SHA256SUMS"
# The package's name: gsd-toolkit, or gsd-worktrees for a release before 0.8.0.
PKGNAME=gsd-toolkit
for n in gsd-toolkit gsd-worktrees; do
  if awk -v f="$n-$VERSION.tar.gz" '$2 == f || $2 == "*" f {found=1} END {exit !found}' "$TMP/SHA256SUMS"; then PKGNAME=$n; break; fi
done
NAME="$PKGNAME-$VERSION.tar.gz"
curl -fsSL "${RETRY[@]}" --max-time 120 "$URL/$NAME" -o "$TMP/$NAME" || die "download failed: $URL/$NAME"
want=$(awk -v f="$NAME" '$2 == f || $2 == "*" f {print $1}' "$TMP/SHA256SUMS")
if command -v sha256sum >/dev/null 2>&1; then have=$(sha256sum "$TMP/$NAME" | awk '{print $1}')
else have=$(shasum -a 256 "$TMP/$NAME" | awk '{print $1}'); fi
[ -n "$want" ] && [ "$want" = "$have" ] || die "checksum mismatch for $NAME — not installed"
tar -xzf "$TMP/$NAME" -C "$TMP"
SRC="$TMP/$PKGNAME-$VERSION"
[ "$(head -1 "$SRC/VERSION" 2>/dev/null | tr -d '[:space:]')" = "$VERSION" ] \
  || die "the $NAME package does not say it is version $VERSION"

# ── install ──────────────────────────────────────────────────────────────────
# The release the commands used before this one (kept for going back).
# gsd-list: its name before 0.10.0.
PREV=""
for l in gsdt-list gsd-list; do
  [ -z "$PREV" ] && [ -L "$BIN/$l" ] || continue
  case "$(readlink "$BIN/$l")" in
    "$RELEASES"/*/bin/"$l") PREV=$(readlink "$BIN/$l"); PREV=${PREV#"$RELEASES"/}; PREV=${PREV%%/*} ;;
  esac
done
# An older release has its installer at the top (install.sh --copy).
INSTALLER=("$SRC/lib/install.sh")
[ -f "$SRC/lib/install.sh" ] || INSTALLER=("$SRC/install.sh" --copy)
# stdin is not the installer's: under curl | bash it is the rest of this script
if ! GSD_BIN_DIR="$BIN" GSD_COPY_DIR="$RELEASES/$VERSION" \
     bash "${INSTALLER[@]}" ${PASS[@]+"${PASS[@]}"} </dev/null | sed 's/^/  /'; then
  die "the installer failed (see above)"
fi

for d in "$RELEASES"/*; do
  [ -d "$d" ] || continue
  v=$(basename "$d")
  printf '%s' "$v" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || continue
  [ "$v" = "$VERSION" ] || [ "$v" = "$PREV" ] || { rm -rf "$d"; echo "  ✂ removed old release $v"; }
done
# The runtime of a release before 0.8.0 (~/.local/share/gsd-worktrees): gone
# once no command links into it. A link still there (a failed install, a
# second bin dir we do not know), or anything in it but release folders,
# keeps it.
old_runtime_only() {  # $1=dir → 0 when it holds releases/<X.Y.Z>/ and nothing else
  local e
  for e in "$1"/* "$1"/.[!.]*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    [ "$e" = "$1/releases" ] && [ -d "$e" ] && [ ! -L "$e" ] || return 1
  done
  for e in "$1"/releases/* "$1"/releases/.[!.]*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    [ -d "$e" ] && [ ! -L "$e" ] && printf '%s' "$(basename "$e")" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || return 1
  done
}
if [ -n "$OLD_SHARE" ] && [ -d "$OLD_SHARE/releases" ] && [ ! -L "$OLD_SHARE" ] && old_runtime_only "$OLD_SHARE"; then
  used=""
  for l in "$BIN"/gsd-*; do
    [ -L "$l" ] || continue
    case "$(readlink "$l")" in "$OLD_SHARE"/*) used=1; break ;; esac
  done
  if [ -z "$used" ]; then rm -rf "$OLD_SHARE"; echo "  ✂ removed the old gsd-worktrees runtime ($OLD_SHARE)"; fi
fi
echo "✔ gsd-toolkit $VERSION installed${PREV:+ (was $PREV)}"
