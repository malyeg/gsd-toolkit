#!/usr/bin/env bash
#
# tools/release.sh — cut a release (maintainers only; not installed).
#
#   tools/release.sh <X.Y.Z> [--push]
#
# A helper: changing VERSION by hand in a commit on main does the same.
#
# 1. Checks: on main, clean, level with origin/main, X.Y.Z newer than VERSION,
#    and CHANGELOG.md has a "## X.Y.Z" section (write it first — it becomes the
#    release notes).
# 2. Writes VERSION and commits "release vX.Y.Z".
# 3. With --push: pushes main. GitHub Actions (release.yml) sees VERSION change,
#    runs every test suite, tags the commit and publishes the release;
#    install.sh / gsdt-update pick it up from there. Without --push it prints the
#    push command.
set -euo pipefail
die() { printf 'release: %s\n' "$*" >&2; exit 1; }
cd "$(dirname "$0")/.."
V=${1:-}; PUSH=0; [ "${2:-}" != --push ] || PUSH=1
printf '%s' "$V" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || die "usage: tools/release.sh X.Y.Z [--push]"
GSD_PKG=$PWD
# shellcheck source=../lib/common.sh
. lib/common.sh
# shellcheck source=../lib/version.sh
. lib/version.sh
CUR=$(gsd_version)
[ "$(git branch --show-current)" = main ] || die "not on main"
[ -z "$(git status --porcelain)" ] || die "uncommitted changes — commit or stash first"
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main is not level with origin/main — pull/push first"
[ -z "$(git ls-remote --tags origin "v$V")" ] || die "tag v$V already exists"
[ "$V" != "$CUR" ] || die "VERSION is already $V: its push started the release (to retry: gh workflow run release.yml)"
gsd_version_gt "$V" "$CUR" || die "$V is older than VERSION ($CUR)"
grep -qE "^## \[?$V\]?" CHANGELOG.md || die "CHANGELOG.md has no '## $V' section — write the release notes first"

printf '%s\n' "$V" > VERSION
git add VERSION
git commit -qm "release v$V"
echo "✔ committed release v$V"
if [ "$PUSH" = 1 ]; then
  git push -q origin main
  echo "✔ pushed — watch: gh run list --workflow release.yml"
else
  echo "next: git push origin main"
fi
