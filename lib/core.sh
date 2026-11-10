# shellcheck shell=bash
# lib/core.sh — install or update GSD itself (gsd-core) for one agent, with
# its own installer (npx). lib/install.sh installs it where it is missing;
# gsdt-update also brings it to the latest version. Always the full skill
# profile: the phase flow runs skills only it has (doctor T009). Needs
# lib/common.sh (GSD_CORE_INSTALL); update mode needs lib/version.sh.

gsd_core_dir() {  # $1=provider → the agent's config dir
  case "$1" in
    claude) printf '%s\n' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" ;;
    codex) printf '%s\n' "${CODEX_HOME:-$HOME/.codex}" ;;
    *) return 1 ;;
  esac
}

gsd_core_version() {  # $1=provider → its gsd-core X.Y.Z ('' when none)
  local d; d=$(gsd_core_dir "$1") || return 0
  [ -x "$d/gsd-core/bin/gsd_run" ] || return 0
  head -1 "$d/gsd-core/VERSION" 2>/dev/null | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+' || true
}

# $1=provider  $2=install|update  $3=the latest version (update; '' = unknown)
# install: only where there is none. update: also where it is older than $3.
# Never fails: a failed or impossible run prints the command to run.
gsd_core_sync() {
  local p=$1 mode=$2 latest=${3:-} d moved cmd have did=installed act=installing
  d=$(gsd_core_dir "$p") || return 0
  case "$p" in claude) moved=${CLAUDE_CONFIG_DIR:-} ;; codex) moved=${CODEX_HOME:-} ;; esac
  # --config-dir only when the agent's dir is moved
  local args=("--$p" --global --profile=full)
  [ -z "$moved" ] || args+=(--config-dir "$d")
  cmd="$GSD_CORE_INSTALL$(printf ' %s' "${args[@]}")"   # a caller's IFS may be ","
  have=$(gsd_core_version "$p")
  if [ -n "$have" ]; then
    did=updated; act="updating"
    if [ "$mode" = install ]; then echo "• $p already has gsd-core $have"; return 0; fi
    if [ -z "$latest" ]; then echo "• $p gsd-core $have — the latest is unknown (offline?); later: $cmd"; return 0; fi
    if ! gsd_version_gt "$latest" "$have"; then echo "✔ $p gsd-core $have is the latest"; return 0; fi
  fi
  if ! command -v npx >/dev/null 2>&1; then
    echo "⚠ gsd-core not $did for $p: no npx (install Node.js), then run:  $cmd"; return 0
  fi
  echo "▶ $act gsd-core for ${p}${have:+ ($have → ${latest})}…"
  # stdin is not the installer's (under curl | bash it is the rest of install.sh)
  if npx -y --package=@opengsd/gsd-core@latest -- gsd-core "${args[@]}" </dev/null 2>&1 | sed 's/^/  /' \
     && [ -x "$d/gsd-core/bin/gsd_run" ]; then
    echo "✔ $p gsd-core $(gsd_core_version "$p") → $d"
  else
    echo "⚠ gsd-core for $p not $did (see above); run:  $cmd"
  fi
  return 0
}
