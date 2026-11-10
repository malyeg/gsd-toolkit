# shellcheck shell=bash
# lib/tracker/ids.sh — ticket ids, for gsdt-tracker. Its own copy: the GSD
# toolkit keeps a twin in lib/ticket.sh, and tests/test-tracker.sh runs both
# over the same inputs so they cannot drift.

# trk_id_norm <id|tag|url> [clickup] → the bare id; nonzero when it isn't one.
# Accepts a URL (last path segment), #42, tk-<id>, cu_<id>; with "clickup" also
# CU-<id> (elsewhere CU-12 may be a real key, e.g. a Jira project named CU).
trk_id_norm() {
  local id="$1"
  case "$id" in *://*) id=${id%%\?*}; id=${id%%#*}; id=${id%/}; id=${id##*/} ;; esac
  id=${id#\#}
  case "$id" in [Tt][Kk]-*) id=${id#???} ;; [Cc][Uu]_*) id=${id#???} ;; esac
  if [ "${2:-}" = clickup ]; then case "$id" in [Cc][Uu]-*) id=${id#???} ;; esac; fi
  [ "${#id}" -le 64 ] || return 1
  printf '%s' "$id" | grep -qE '^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$' || return 1
  printf '%s\n' "$id"
}

# trk_id_extract <title|branch|dir> → the tagged id (tk-<id>; legacy cu_<id>,
# CU-<id>, "ClickUp <id>"), or nothing. Safe under set -e.
trk_id_extract() {
  local id
  id=$(printf '%s\n' "$1" | grep -oE '(^|[^A-Za-z0-9])[Tt][Kk]-[A-Za-z0-9]+(-[A-Za-z0-9]+)*' \
         | head -1 | sed -E 's/^[^A-Za-z0-9]?[Tt][Kk]-//' || true)
  [ -n "$id" ] || id=$(printf '%s\n' "$1" | grep -oiE '(^|[^a-z0-9])cu[-_][a-z0-9]{6,}' \
         | head -1 | sed -E 's/^[^A-Za-z0-9]?[Cc][Uu][-_]//' || true)
  [ -n "$id" ] || id=$(printf '%s\n' "$1" | grep -oiE 'clickup[[:space:]]+[a-z0-9]{6,}' \
         | head -1 | awk '{print $2}' || true)
  [ -z "$id" ] || printf '%s\n' "$id"
}
