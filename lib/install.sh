#!/usr/bin/env bash
#
# lib/install.sh — the bridge from 0.10.x. A 0.10.x install.sh (and so a 0.10.x
# gsdt-update) downloads the newest release's .tar.gz, unpacks it and runs this
# file with GSD_BIN_DIR / GSD_COPY_DIR set and stdin on /dev/null. From 1.0.0
# the toolkit is an npm package, so this hands over to the install.sh of the
# SAME unpacked package, which downloads that release's gsd-toolkit-X.Y.Z.tgz,
# runs `npm install -g` and then gsdt-setup (which removes the 0.10.x install:
# the ~/.local/bin links and ~/.local/share/gsd-toolkit).
#
# Nothing is removed before the npm package is installed: a missing node, a
# failed download or a failed npm install exits non-zero and leaves the 0.10.x
# install as it was.
#
# Options (as 0.10.x passes them): --agent, --all-agents, --no-core,
# --no-user-hook, --reuse-install-config and --copy (both dropped).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
die() { printf 'gsd-toolkit install: %s\n' "$*" >&2; exit 1; }
[ -f "$HERE/install.sh" ] && [ -f "$HERE/VERSION" ] || die "run this from an unpacked gsd-toolkit release"
VER=$(head -1 "$HERE/VERSION" | tr -d '[:space:]')

# gsdt-setup reads GSD_BIN_DIR as the dir its user hooks point at: here that
# would be the 0.10.x ~/.local/bin it is about to empty. install.sh sets it
# to npm's bin dir itself.
unset GSD_BIN_DIR GSD_COPY_DIR GSD_RELEASES_DIR

PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --agent) [ $# -ge 2 ] || die "--agent needs a provider"; PASS+=(--agent "$2"); shift 2 ;;
    --all-agents|--no-core|--no-user-hook) PASS+=("$1"); shift ;;
    --reuse-install-config|--copy) shift ;;
    -h|--help) sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done
exec bash "$HERE/install.sh" --version "$VER" ${PASS[@]+"${PASS[@]}"}
