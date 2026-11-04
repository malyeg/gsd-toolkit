# shellcheck shell=bash
# lib/ticket.sh — the GSD side of tickets: the tk-<id> tag that links a phase
# to its ticket. Talking to the tracker is gsd-tracker's job, and GSD only
# runs it as a command (it is standalone: see lib/tracker/).
#
# A phase is linked to a ticket by a tag in its ROADMAP title and slug:
#   ### Phase 7: shopping cart tk-869e33cv4      branch phase-7-shopping-cart-tk-869e33cv4
# The tag is written as tk-<id>. Legacy cu_<id> / CU-<id> / "ClickUp <id>" tags
# are still read, never written. Which tracker the id belongs to is the
# tracker's setting (gsd-tracker which), not part of the tag.
# Sourced after lib/common.sh.

# gsd_tracker_which <repo root> → none|clickup|custom (or the invalid value as written).
# For GSD a tracker counts only when one is SET (env, git config or .gsd.conf).
# gsd-tracker's own default (clickup in a repo with no .gsd.conf, for use
# outside GSD) means none here: an unset tracker must never start moving tickets.
gsd_tracker_which() {
  local conf t from
  conf=$("$GSD_PKG/bin/gsd-tracker" --repo "$1" config 2>/dev/null) || { echo none; return 0; }
  t=$(printf '%s\n' "$conf" | sed -n 's/^tracker=//p' | head -1)
  from=$(printf '%s\n' "$conf" | sed -n 's/^tracker_from=//p' | head -1)
  if [ -z "$t" ] || [ "$from" = default ]; then echo none; else printf '%s\n' "$t"; fi
}

# gsd_ticket_norm <id|tag|url> [clickup] → the bare id; nonzero when it isn't one.
# Accepts a URL (last path segment), #42, tk-<id>, cu_<id>; with "clickup" also
# CU-<id> (elsewhere CU-12 may be a real key, e.g. a Jira project named CU).
# Twin of trk_id_norm (lib/tracker/ids.sh); tests/test-tracker.sh keeps them equal.
gsd_ticket_norm() {
  local id="$1"
  case "$id" in *://*) id=${id%%\?*}; id=${id%%#*}; id=${id%/}; id=${id##*/} ;; esac
  id=${id#\#}
  case "$id" in [Tt][Kk]-*) id=${id#???} ;; [Cc][Uu]_*) id=${id#???} ;; esac
  if [ "${2:-}" = clickup ]; then case "$id" in [Cc][Uu]-*) id=${id#???} ;; esac; fi
  [ "${#id}" -le 64 ] || return 1
  printf '%s' "$id" | grep -qE '^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$' || return 1
  printf '%s\n' "$id"
}

# gsd_ticket_extract <title|branch|dir> → the tagged id, or nothing. Safe under set -e.
# Twin of trk_id_extract (lib/tracker/ids.sh).
gsd_ticket_extract() {
  local id
  id=$(printf '%s\n' "$1" | grep -oE '(^|[^A-Za-z0-9])[Tt][Kk]-[A-Za-z0-9]+(-[A-Za-z0-9]+)*' \
         | head -1 | sed -E 's/^[^A-Za-z0-9]?[Tt][Kk]-//' || true)
  [ -n "$id" ] || id=$(printf '%s\n' "$1" | grep -oiE '(^|[^a-z0-9])cu[-_][a-z0-9]{6,}' \
         | head -1 | sed -E 's/^[^A-Za-z0-9]?[Cc][Uu][-_]//' || true)
  [ -n "$id" ] || id=$(printf '%s\n' "$1" | grep -oiE 'clickup[[:space:]]+[a-z0-9]{6,}' \
         | head -1 | awk '{print $2}' || true)
  [ -z "$id" ] || printf '%s\n' "$id"
}

# gsd_ticket_tagged <string> <id> — true when <string> carries tk-<id> (or legacy cu_<id>).
gsd_ticket_tagged() {
  printf '%s\n' "$1" | grep -qiE "(^|[^A-Za-z0-9])(tk-|cu[-_])$2([^A-Za-z0-9-]|-pr\$|\$)"
}
