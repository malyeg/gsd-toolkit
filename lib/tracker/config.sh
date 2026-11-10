# shellcheck shell=bash
# lib/tracker/config.sh — gsdt-tracker's settings. Standalone: nothing here (or
# anywhere in lib/tracker/) uses the GSD toolkit's code; GSD runs gsdt-tracker
# as a command.
#
# Each setting, first match wins:
#   1. the environment (GSD_TRACKER, GSD_TRACKER_PROFILE, GSD_TRACKER_STATUS_*)
#   2. the repo's git config, section gsdt-tracker (.git/config: never committed,
#      shared by every worktree of the clone)
#   3. .gsd.conf in the repo (a GSD repo's team-shared settings; read only)
#   4. the default: tracker = none in a repo with a .gsd.conf, clickup elsewhere
# Sourced by bin/gsdt-tracker after REPO is set.

trk_main() {  # $1=any path inside a repo → its MAIN checkout ('' outside a repo)
  # substr, not $2: a checkout path with a space in it would be cut at the space
  git -C "${1:-.}" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10); exit}' || true
}

trk_conf_get() {  # $1=repo root  $2=.gsd.conf key → value ('' when unset)
  [ -f "$1/.gsd.conf" ] || return 0
  sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1/.gsd.conf" \
    | head -1 | sed -e 's/[[:space:]]*$//' -e 's/[[:space:]]*#.*$//'
}

trk_git_get() {  # $1=repo root  $2=gsdt-tracker.<key> → value ('' when unset or not a repo)
  # gsd-tracker.<key>: the section before 0.10.0, read until gsdt-migrate
  # renames it in this clone
  git -C "$1" config --local --get "gsdt-tracker.$2" 2>/dev/null \
    || git -C "$1" config --local --get "gsd-tracker.$2" 2>/dev/null || true
}

# trk_get <setting> → sets TRK_VAL (the value) and TRK_FROM (env, git,
# gsd.conf, default, or '' when unset). No subshell, so both survive.
# Settings: tracker, profile, command, status_start, status_finish.
trk_get() {
  local envv="" gitk confk
  case "$1" in
    tracker)       envv=${GSD_TRACKER:-};         gitk=tracker;      confk=tracker ;;
    profile)       envv=${GSD_TRACKER_PROFILE:-}; gitk=profile;      confk=tracker_profile ;;
    command)                                      gitk="command";    confk=tracker_command ;;
    status_start)  envv=${GSD_TRACKER_STATUS_START:-${GSD_CLICKUP_STATUS_START:-}}
                                                  gitk=statusStart;  confk=tracker_status_start ;;
    status_finish) envv=${GSD_TRACKER_STATUS_FINISH:-${GSD_CLICKUP_STATUS_FINISH:-}}
                                                  gitk=statusFinish; confk=tracker_status_finish ;;
    *) printf 'gsdt-tracker: unknown setting %s\n' "$1" >&2; return 1 ;;
  esac
  TRK_VAL=$envv; TRK_FROM="env"
  if [ -z "$TRK_VAL" ]; then TRK_VAL=$(trk_git_get "$REPO" "$gitk"); TRK_FROM=git; fi
  if [ -z "$TRK_VAL" ]; then TRK_VAL=$(trk_conf_get "$REPO" "$confk"); TRK_FROM=gsd.conf; fi
  if [ -z "$TRK_VAL" ] && [ "$1" = tracker ]; then
    if [ -f "$REPO/.gsd.conf" ]; then TRK_VAL=none; else TRK_VAL=clickup; fi
    TRK_FROM=default
  fi
  [ -n "$TRK_VAL" ] || TRK_FROM=""
  [ "$1" != tracker ] || TRK_VAL=$(printf '%s' "$TRK_VAL" | tr '[:upper:]' '[:lower:]')
  return 0
}

trk_known() { case "$1" in none|clickup|custom) return 0 ;; esac; return 1; }

# A profile becomes part of a file name: no slashes, no leading dot or dash.
trk_profile_ok() { printf '%s' "$1" | grep -qE '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'; }

trk_command() {  # → the custom tracker's script, absolute ('' when unset)
  local c
  trk_get command; c=$TRK_VAL
  case "$c" in ''|/*) ;; \~/*) c="$HOME/${c#\~/}" ;; *) c="$REPO/$c" ;; esac
  printf '%s\n' "$c"
}

# trk_clickup_env → the ClickUp token file: $GSD_CLICKUP_CONFIG, else
# ~/.config/gsd/clickup-<profile>.env with a profile, else ~/.config/gsd/clickup.env.
# A profile never falls back to the shared file: that would act as the wrong user.
trk_clickup_env() {
  if [ -n "${GSD_CLICKUP_CONFIG:-}" ]; then printf '%s\n' "$GSD_CLICKUP_CONFIG"; return 0; fi
  trk_get profile
  if [ -n "$TRK_VAL" ]; then printf '%s\n' "$HOME/.config/gsd/clickup-$TRK_VAL.env"
  else printf '%s\n' "$HOME/.config/gsd/clickup.env"; fi
}

trk_has_token() {  # $1=token file → true when it sets CLICKUP_API_TOKEN
  grep -qE '^[[:space:]]*(export[[:space:]]+)?CLICKUP_API_TOKEN=.' "$1" 2>/dev/null
}

trk_python() {  # → a Python 3.7+ interpreter; nonzero when none
  # `python` is still Python 2 on older systems: ask the interpreter its version.
  if [ -n "${GSD_PYTHON:-}" ]; then printf '%s\n' "$GSD_PYTHON"; return 0; fi
  local py
  for py in python3 python; do
    command -v "$py" >/dev/null 2>&1 || continue
    "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)' 2>/dev/null || continue
    GSD_PYTHON="$py"
    printf '%s\n' "$py"
    return 0
  done
  return 1
}

# gsdt-tracker config: the resolved settings, offline, one key=value per line.
# <key>_from names where a value came from. The token itself is never printed.
trk_print_config() {
  local t f
  trk_get tracker; t=$TRK_VAL
  printf 'tracker=%s\ntracker_from=%s\n' "$t" "$TRK_FROM"
  if trk_known "$t"; then echo tracker_ok=yes; else echo tracker_ok=no; fi
  trk_get profile
  printf 'profile=%s\nprofile_from=%s\n' "$TRK_VAL" "$TRK_FROM"
  if [ -n "$TRK_VAL" ]; then
    if trk_profile_ok "$TRK_VAL"; then echo profile_ok=yes; else echo profile_ok=no; fi
  fi
  if [ "$t" = clickup ]; then
    f=$(trk_clickup_env)
    printf 'token_file=%s\n' "$f"
    if [ -n "${CLICKUP_API_TOKEN:-}" ]; then echo token=env
    elif trk_has_token "$f"; then echo token=file
    else echo token=missing; fi
  fi
  if [ "$t" = custom ]; then
    printf 'command=%s\n' "$(trk_command)"
    trk_get command; printf 'command_from=%s\n' "$TRK_FROM"
  fi
  trk_get status_start;  printf 'status_start=%s\n' "$TRK_VAL"
  trk_get status_finish; printf 'status_finish=%s\n' "$TRK_VAL"
}
