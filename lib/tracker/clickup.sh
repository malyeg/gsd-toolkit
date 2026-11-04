# shellcheck shell=bash
# lib/tracker/clickup.sh — ClickUp adapter for bin/gsd-tracker.
#
# Auth: a personal API token (pk_…), first match wins:
#   1. $CLICKUP_API_TOKEN in the environment
#   2. the token file (sourced; must set CLICKUP_API_TOKEN=…), from trk_clickup_env:
#      $GSD_CLICKUP_CONFIG, else ~/.config/gsd/clickup-<profile>.env when a
#      profile is set (lib/tracker/config.sh), else ~/.config/gsd/clickup.env
# Create one in ClickUp: avatar → Settings → Apps → API Token.
# `gsd-tracker login` saves one and picks it for this repo in one step (clickup_login).
#
# start/finish resolve the status against the task's own list: names match
# ignoring case, spaces, hyphens and underscores ("in testing" finds
# "In-Testing"). Candidates, in order:
#   start:  configured status, "in progress", "in development"
#   finish: configured status, "in testing",  "in review"
# They are idempotent (a task already there gets no second comment) and
# cascade to open subtasks. GSD_CLICKUP_ENG_LIST=<list id> prints a reminder
# when a started task lives in another list (the API can't move it).
#
# Shared verbs create/update/tasks, plus this tracker's own commands
# (TRACKER_EXTRA: lists, members, api, login), let an agent work tickets through this
# one connector. Commands that need the workspace use $CLICKUP_TEAM_ID (env or
# the token file), else the only workspace the token sees.
# Sourced by bin/gsd-tracker (die, tracker_status set there).

# shellcheck disable=SC2034  # read by bin/gsd-tracker
TRACKER_EXTRA="lists members api login"  # this tracker's own commands, beyond the shared verbs
trk_get profile; PROFILE=$TRK_VAL
CONFIG=$(trk_clickup_env)

load_token() {
  [ -z "$PROFILE" ] || trk_profile_ok "$PROFILE" \
    || die "profile '$PROFILE' is not a name (letters, digits, . _ -)"
  if [ -z "${CLICKUP_API_TOKEN:-}" ] && [ -f "$CONFIG" ]; then
    # shellcheck disable=SC1090
    . "$CONFIG"
  fi
  [ -n "${CLICKUP_API_TOKEN:-}" ] \
    || die "no CLICKUP_API_TOKEN${PROFILE:+ for profile '$PROFILE'} — run gsd-tracker login${PROFILE:+ $PROFILE}, or put CLICKUP_API_TOKEN=pk_… in $CONFIG"
}

api() {  # api <method> <path> [json-body]; prints response body, fails on HTTP >= 400
  local method="$1" path="$2" body="${3:-}"
  local args=(-sSg --max-time 15 -X "$method"
              -H "Authorization: $CLICKUP_API_TOKEN"
              -H "Content-Type: application/json")
  [ -n "$body" ] && args+=(-d "$body")
  local out http
  out=$(curl "${args[@]}" -w '\n%{http_code}' "https://api.clickup.com/api/v2$path") \
    || { printf 'gsd-tracker: curl failed (network?)\n' >&2; return 2; }
  http="${out##*$'\n'}"
  out="${out%$'\n'*}"
  if [ "$http" -ge 400 ] 2>/dev/null; then
    printf 'gsd-tracker: ClickUp API %s %s → HTTP %s: %s\n' "$method" "$path" "$http" "$out" >&2
    return 2
  fi
  printf '%s\n' "$out"
}

json_escape() {  # minimal JSON string escaper for comment/status payloads
  local py
  py=$(trk_python) || die "no python 3.7+ found (tried python3, then python) — needed to build the request body"
  printf '%s' "$1" | "$py" -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

norm() {  # normalize a status name for comparison: lowercase, alnum only
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9'
}

need_jq() {
  command -v jq >/dev/null 2>&1 || die "jq is required for '$1' — install it, e.g. brew install jq"
}

# resolve_status <list_id> <candidate>… — print the exact spelling of the first
# candidate that exists among the list's statuses (matched via norm). Falls
# back to the first candidate verbatim (with a warning) if the list can't be
# fetched or nothing matches — the PUT then fails visibly.
resolve_status() {
  local list_id="$1"; shift
  local list_json names cand name
  if ! list_json=$(api GET "/list/$list_id"); then
    printf 'gsd-tracker: cannot fetch list %s statuses — trying "%s" verbatim\n' "$list_id" "$1" >&2
    printf '%s\n' "$1"; return 0
  fi
  names=$(printf '%s' "$list_json" | jq -r '.statuses[].status')
  for cand in "$@"; do
    while IFS= read -r name; do
      if [ "$(norm "$name")" = "$(norm "$cand")" ]; then
        printf '%s\n' "$name"; return 0
      fi
    done <<< "$names"
  done
  printf 'gsd-tracker: no candidate (%s) matches list %s statuses [%s] — trying "%s" verbatim\n' \
    "$*" "$list_id" "$(printf '%s' "$names" | paste -sd ',' -)" "$1" >&2
  printf '%s\n' "$1"
}

clickup_move() {  # $1=start|finish $2=id $3=comment
  local cmd="$1" id="$2" text="$3" rc=0 cur_json cur st sid home conf
  need_jq "$cmd"
  load_token
  local cands=()
  conf=$(tracker_status "$cmd")
  [ -z "$conf" ] || cands+=("$conf")
  if [ "$cmd" = start ]; then cands+=("in progress" "in development")
  else cands+=("in testing" "in review"); fi
  # Fetch once, with subtasks for the cascade.
  cur_json=$(api GET "/task/$id?include_subtasks=true") || exit 2
  cur=$(printf '%s' "$cur_json" | jq -r '.status.status')
  st=$(resolve_status "$(printf '%s' "$cur_json" | jq -r '.list.id')" "${cands[@]}")
  if [ "$(norm "$cur")" = "$(norm "$st")" ]; then
    echo "• ClickUp $id already '$st' — status and comment skipped (idempotent)"
  else
    # both attempted independently — a bad status name must not swallow the comment
    api PUT "/task/$id" "{\"status\": $(json_escape "$st")}" >/dev/null \
      && echo "✔ ClickUp $id → status '$st'" || rc=2
    api POST "/task/$id/comment" "{\"comment_text\": $(json_escape "$text")}" >/dev/null \
      && echo "✔ ClickUp $id → comment posted" || rc=2
  fi
  # Open subtasks ride along; closed/complete ones are never touched.
  for sid in $(printf '%s' "$cur_json" | jq -r --arg st "$st" \
      'def n: ascii_downcase | gsub("[^a-z0-9]"; "");
       .subtasks[]? | select(.date_closed == null and (.status.status | n) != ($st | n) and .status.type != "closed" and (.status.status | test("^complete"; "i") | not)) | .id'); do
    api PUT "/task/$sid" "{\"status\": $(json_escape "$st")}" >/dev/null \
      && echo "✔ ClickUp $sid (subtask) → status '$st'" || rc=2
  done
  if [ "$cmd" = start ] && [ -n "${GSD_CLICKUP_ENG_LIST:-}" ]; then
    home=$(printf '%s' "$cur_json" | jq -r '.list.id')
    if [ "$home" != "$GSD_CLICKUP_ENG_LIST" ]; then
      echo "• task lives in list '$(printf '%s' "$cur_json" | jq -r '.list.name')' — move it to list $GSD_CLICKUP_ENG_LIST by hand (the API can't)"
    fi
  fi
  exit "$rc"
}

clickup_snapshot() {  # $1=id → markdown on stdout
  local id="$1" task comments
  need_jq snapshot
  load_token
  task=$(api GET "/task/$id?include_markdown_description=true") || exit 2
  comments=$(api GET "/task/$id/comment") || comments='{"comments":[]}'
  printf '%s' "$task" | jq -r --arg id "$id" '
    "# \(.name)\n\nTicket: ClickUp \($id) · \(.url // "") · status: \(.status.status // "?")\n\n" +
    ((.markdown_description // .description // "") | if . == "" then "_(no description)_" else . end)'
  printf '%s' "$comments" | jq -r '
    [.comments[]? | .comment_text // "" | select(. != "")] as $c
    | if ($c | length) > 0 then "\n## Comments\n\n" + ($c | map("- " + (gsub("\n"; "\n  "))) | join("\n")) else empty end'
}

# ── create / update / tasks, and the ClickUp-only commands ────────────────────────────────────────────────────

uri() { jq -rn --arg v "$1" '$v | @uri'; }

prio_ok() { case "$1" in [1-4]) ;; *) die "priority is 1 (urgent), 2 (high), 3 (normal) or 4 (low), not '$1'" ;; esac; }

desc_arg() {  # $1=markdown, or - for stdin
  if [ "$1" = - ]; then cat; else printf '%s' "$1"; fi
}

clickup_team() {  # → the workspace id: $CLICKUP_TEAM_ID, else the only one the token sees
  local teams n
  if [ -n "${CLICKUP_TEAM_ID:-}" ]; then printf '%s\n' "$CLICKUP_TEAM_ID"; return 0; fi
  teams=$(api GET /team) || exit 2
  n=$(jq '.teams | length' <<< "$teams")
  case "$n" in
    1) jq -r '.teams[0].id' <<< "$teams" ;;
    0) die "the token sees no workspace" ;;
    *) die "the token sees $n workspaces — set CLICKUP_TEAM_ID in $CONFIG to one of: $(jq -r '[.teams[] | "\(.id) (\(.name))"] | join(", ")' <<< "$teams")" ;;
  esac
}

clickup_members_json() {  # → [{id, username, email}] of the workspace
  local team teams
  team=$(clickup_team)
  teams=$(api GET /team) || exit 2
  jq --arg t "$team" '[.teams[] | select(.id == $t) | .members[].user | {id, username, email}]' <<< "$teams"
}

clickup_user() {  # $1=me | user id | email | username → the numeric user id
  local out id
  case "$1" in
    me)
      out=$(api GET /user) || exit 2
      jq -r '.user.id' <<< "$out" ;;
    ''|*[!0-9]*)
      out=$(clickup_members_json)
      id=$(jq -r --arg u "$1" 'first(.[] | select(((.email // "") | ascii_downcase) == ($u | ascii_downcase)
                                               or ((.username // "") | ascii_downcase) == ($u | ascii_downcase)) | .id) // empty' <<< "$out")
      [ -n "$id" ] || die "no workspace member '$1' (see gsd-clickup members)"
      printf '%s\n' "$id" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

clickup_create() {  # <list-id> <name> [options] → prints the new id and url
  [ $# -ge 2 ] || die "usage: gsd-clickup create <list-id> <name> [--desc <md>|-] [--assign <who>]… [--status <s>] [--priority 1-4] [--tag <t>]… [--parent <id>]"
  local list="$1" body out v
  printf '%s' "$list" | grep -qE '^[0-9]+$' || die "not a list id: $list (see gsd-clickup lists)"
  body=$(jq -cn --arg n "$2" '{name: $n}')
  shift 2
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || die "$1 needs a value"
    case "$1" in
      --desc)     v=$(desc_arg "$2"); body=$(jq -c --arg v "$v" '.markdown_content = $v' <<< "$body") ;;
      --assign)   v=$(clickup_user "$2"); body=$(jq -c --argjson v "$v" '.assignees += [$v]' <<< "$body") ;;
      --status)   body=$(jq -c --arg v "$2" '.status = $v' <<< "$body") ;;
      --priority) prio_ok "$2"; body=$(jq -c --argjson v "$2" '.priority = $v' <<< "$body") ;;
      --tag)      body=$(jq -c --arg v "$2" '.tags += [$v]' <<< "$body") ;;
      --parent)   v=$(trk_id_norm "$2" clickup) || die "not a ticket id: $2"
                  body=$(jq -c --arg v "$v" '.parent = $v' <<< "$body") ;;
      *) die "unknown option for create: $1" ;;
    esac
    shift 2
  done
  out=$(api POST "/list/$list/task" "$body") || exit 2
  jq -r '"✔ ClickUp \(.id) created · \(.url // "")"' <<< "$out"
}

clickup_update() {  # <id> [options]
  [ $# -ge 3 ] || die "usage: gsd-clickup update <id> [--name <n>] [--desc <md>|-] [--assign <who>]… [--unassign <who>]… [--status <s>] [--priority 1-4] [--parent <id>]"
  local id body='{}' v
  id=$(trk_id_norm "$1" clickup) || die "not a ticket id: $1"
  shift
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || die "$1 needs a value"
    case "$1" in
      --name)     body=$(jq -c --arg v "$2" '.name = $v' <<< "$body") ;;
      --desc)     v=$(desc_arg "$2"); body=$(jq -c --arg v "$v" '.markdown_content = $v' <<< "$body") ;;
      --assign)   v=$(clickup_user "$2"); body=$(jq -c --argjson v "$v" '.assignees.add += [$v]' <<< "$body") ;;
      --unassign) v=$(clickup_user "$2"); body=$(jq -c --argjson v "$v" '.assignees.rem += [$v]' <<< "$body") ;;
      --status)   body=$(jq -c --arg v "$2" '.status = $v' <<< "$body") ;;
      --priority) prio_ok "$2"; body=$(jq -c --argjson v "$2" '.priority = $v' <<< "$body") ;;
      --parent)   v=$(trk_id_norm "$2" clickup) || die "not a ticket id: $2"
                  body=$(jq -c --arg v "$v" '.parent = $v' <<< "$body") ;;
      *) die "unknown option for update: $1" ;;
    esac
    shift 2
  done
  api PUT "/task/$id" "$body" >/dev/null || exit 2
  echo "✔ ClickUp ${id} updated: $(jq -r 'keys | map(sub("markdown_content"; "description")) | join(", ")' <<< "$body")"
}

clickup_tasks() {  # [filters] → "<id>  [<status>]  <name> · <list>", one per line
  local q="" page=0 match="" pages=1 i=0 n=0 team out v
  while [ $# -gt 0 ]; do
    case "$1" in
      --closed) q="$q&include_closed=true"; shift; continue ;;
    esac
    [ $# -ge 2 ] || die "$1 needs a value"
    case "$1" in
      --list)   printf '%s' "$2" | grep -qE '^[0-9]+$' || die "not a list id: $2"
                q="$q&list_ids%5B%5D=$2" ;;
      --status) q="$q&statuses%5B%5D=$(uri "$2")" ;;
      --assign) v=$(clickup_user "$2"); q="$q&assignees%5B%5D=$v" ;;
      --tag)    q="$q&tags%5B%5D=$(uri "$2")" ;;
      --match)  match="$2"; pages=10 ;;
      --page)   printf '%s' "$2" | grep -qE '^[0-9]+$' || die "--page needs a number"
                page="$2" ;;
      *) die "unknown option for tasks: $1" ;;
    esac
    shift 2
  done
  team=$(clickup_team)
  # --match filters names here (the API has no text search), over up to 10 pages.
  while [ "$i" -lt "$pages" ]; do
    out=$(api GET "/team/$team/task?page=$((page + i))&subtasks=true$q") || exit 2
    n=$(jq '.tasks | length' <<< "$out")
    jq -r --arg m "$match" '.tasks[]
      | select($m == "" or (.name | ascii_downcase | contains($m | ascii_downcase)))
      | "\(.id)  [\(.status.status)]  \(.name) · \(.list.name // "")"' <<< "$out"
    i=$((i + 1))
    [ "$n" -ge 100 ] || break
  done
  [ "$n" -lt 100 ] || echo "• more tasks: add --page $((page + i))" >&2
}

clickup_lists() {  # → the workspace tree with ids
  local team spaces sid out
  team=$(clickup_team)
  spaces=$(api GET "/team/$team/space") || exit 2
  for sid in $(jq -r '.spaces[].id' <<< "$spaces"); do
    jq -r --arg s "$sid" '.spaces[] | select(.id == $s) | "space  \(.id)  \(.name)"' <<< "$spaces"
    out=$(api GET "/space/$sid/folder") || exit 2
    jq -r '.folders[] | "  folder  \(.id)  \(.name)", (.lists[]? | "    list  \(.id)  \(.name)")' <<< "$out"
    out=$(api GET "/space/$sid/list") || exit 2
    jq -r '.lists[] | "  list  \(.id)  \(.name)"' <<< "$out"
  done
}

clickup_raw() {  # <METHOD> </path> [json] → the response body
  [ $# -ge 2 ] || die "usage: gsd-clickup api <GET|POST|PUT|DELETE> </path> [json]"
  case "$1" in GET|POST|PUT|DELETE) ;; *) die "method must be GET, POST, PUT or DELETE, not '$1'" ;; esac
  case "$2" in
    *[[:space:]]*) die "the path has spaces — encode them" ;;
    /*) ;;
    *) die "the path starts with / (it is under /api/v2, e.g. /task/abc123)" ;;
  esac
  [ -z "${3:-}" ] || jq -e . >/dev/null 2>&1 <<< "$3" || die "the body is not JSON"
  api "$1" "$2" "${3:-}" || exit 2
}

# login [<name>]: one step for a token, in any folder. The profile: the
# argument, else the profile in use, else the repo folder's name. When
# ~/.config/gsd/clickup-<name>.env already holds a token, it asks first (on a
# terminal, before anything is typed): use it, or replace it. A new token is
# read hidden on a terminal, else as one line of stdin, and tested: a token
# ClickUp refuses is never saved. The file is mode 600 and keeps its other
# lines. In a git repo, git config gsd-tracker.profile <name> then picks it for
# this clone and all its worktrees. .gsd.conf is never edited.
clickup_login() {
  local p="${1:-}" token="" file tmp verb=saved in_repo=0 reuse=0 ans="" cur conf
  [ $# -le 1 ] || die "usage: gsd-tracker login [<profile>]"
  if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then in_repo=1; fi
  [ -n "$p" ] || p=$PROFILE
  if [ -z "$p" ]; then
    [ "$in_repo" = 1 ] || die "not in a git repo — name the profile: gsd-tracker login <name>"
    p=$(basename "$REPO" | tr '[:upper:]' '[:lower:]' \
          | sed -e 's/[^a-z0-9._-]/-/g' -e 's/^[^a-z0-9]*//' | cut -c1-64)
  fi
  trk_profile_ok "$p" \
    || die "'$p' is not a profile name (letters, digits, . _ -) — use gsd-tracker login <name>"
  file="$HOME/.config/gsd/clickup-$p.env"

  # A token already saved for this profile: offer it before anything is typed.
  # With no terminal (a piped token) there is no one to ask: the new one wins.
  if trk_has_token "$file" && [ -t 0 ]; then
    while :; do
      printf 'A token for profile %s is already saved. Use it, or replace it? [U/r] ' "$p" >&2
      IFS= read -r ans || ans=u
      case "$ans" in
        ''|[Uu]*) reuse=1; break ;;
        [Rr]*)    break ;;
        *)        echo "  type u (use it) or r (replace it)" >&2 ;;
      esac
    done
  fi
  if [ "$reuse" = 1 ]; then
    # shellcheck disable=SC1090  # the profile's token file
    token=$(unset CLICKUP_API_TOKEN; . "$file" >/dev/null 2>&1; printf '%s' "${CLICKUP_API_TOKEN:-}")
    if CLICKUP_API_TOKEN=$token api GET /user >/dev/null; then
      verb=kept
    else
      echo "• ClickUp did not accept the saved token — type a new one" >&2
      reuse=0
    fi
  fi

  if [ "$reuse" = 0 ]; then
    if [ -t 0 ]; then
      # Echo goes off BEFORE the prompt shows: bash 3.2's read -s -p prints the
      # prompt first, and a fast paste in that gap was echoed.
      tty_was=$(stty -g 2>/dev/null) || tty_was=
      stty -echo 2>/dev/null || true
      trap '[ -z "$tty_was" ] || stty "$tty_was" 2>/dev/null; printf "\n" >&2; exit 130' INT TERM
      printf 'ClickUp API token for profile %s (ClickUp → Settings → Apps; typing is hidden): ' "$p" >&2
      IFS= read -rs token || true
      [ -z "$tty_was" ] || stty "$tty_was" 2>/dev/null || true
      trap - INT TERM
      printf '\n' >&2
    else
      IFS= read -r token || true
    fi
    token=$(printf '%s' "$token" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    [ -n "$token" ] || die "no token given — nothing saved"
    # The file is sourced: only token characters may go in it.
    printf '%s' "$token" | grep -qE '^[A-Za-z0-9_-]+$' \
      || die "that does not look like a ClickUp token (pk_…) — nothing saved"
    CLICKUP_API_TOKEN=$token api GET /user >/dev/null \
      || { printf 'gsd-tracker: ClickUp did not accept that token — nothing saved\n' >&2; exit 2; }
    [ ! -f "$file" ] || verb=replaced
    tmp="$file.tmp.$$"
    ( umask 077
      mkdir -p "${file%/*}"
      { [ ! -f "$file" ] || grep -vE '^[[:space:]]*(export[[:space:]]+)?CLICKUP_API_TOKEN=' "$file" || true
        printf 'CLICKUP_API_TOKEN=%s\n' "$token"; } > "$tmp" )
    chmod 600 "$tmp"; mv "$tmp" "$file"
  fi
  echo "✔ ClickUp token OK — ${verb} → ${file} (only you can read it)"

  if [ "$in_repo" = 1 ]; then
    cur=$(trk_git_get "$REPO" profile)
    if [ "$cur" = "$p" ]; then
      echo "✔ this repo already uses profile $p (git config gsd-tracker.profile)"
    elif git -C "$REPO" config --local gsd-tracker.profile "$p"; then
      echo "✔ this repo now uses profile $p (git config gsd-tracker.profile: this clone and its worktrees, never committed)"
    else
      echo "• could not write git config — set it by hand: git -C $REPO config gsd-tracker.profile $p"
    fi
    conf=$(trk_conf_get "$REPO" tracker_profile)
    [ -z "$conf" ] || [ "$conf" = "$p" ] \
      || echo "• .gsd.conf says tracker_profile = $conf; in this clone git config wins, so $p is used"
    trk_get tracker
    [ "$TRK_VAL" = clickup ] \
      || echo "• the tracker here is $TRK_VAL, so start/finish/comment don't use ClickUp yet — set it: git config gsd-tracker.tracker clickup (this clone), or tracker = clickup in .gsd.conf (the team)"
  else
    echo "• not in a git repo, so no repo uses it yet — in the repo, run: gsd-tracker login $p (it offers this saved token)"
  fi
  [ -z "${GSD_TRACKER_PROFILE:-}" ] || [ "$GSD_TRACKER_PROFILE" = "$p" ] \
    || echo "• GSD_TRACKER_PROFILE=$GSD_TRACKER_PROFILE is set in this shell and picks another profile"
  [ -z "${GSD_CLICKUP_CONFIG:-}" ] \
    || echo "• GSD_CLICKUP_CONFIG is set in this shell, so $GSD_CLICKUP_CONFIG is read instead — unset GSD_CLICKUP_CONFIG"
  [ -z "${CLICKUP_API_TOKEN:-}" ] \
    || echo "• CLICKUP_API_TOKEN is set in this shell and wins over the file — unset CLICKUP_API_TOKEN"
  return 0
}

tracker_run() {  # $1=command, rest=args
  case "$1" in
    start|finish) clickup_move "$1" "$2" "$3" ;;
    comment)
      load_token
      api POST "/task/$2/comment" "{\"comment_text\": $(json_escape "$3")}" >/dev/null \
        && echo "✔ ClickUp $2 → comment posted" || exit 2 ;;
    status)
      load_token
      api PUT "/task/$2" "{\"status\": $(json_escape "$3")}" >/dev/null \
        && echo "✔ ClickUp $2 → status '$3'" || exit 2 ;;
    snapshot) clickup_snapshot "$2" ;;
    create|update|tasks|lists|members|api)
      need_jq "$1"
      load_token
      local cmd="$1"; shift
      case "$cmd" in
        create)  clickup_create "$@" ;;
        update)  clickup_update "$@" ;;
        tasks)   clickup_tasks "$@" ;;
        lists)   clickup_lists ;;
        members) clickup_members_json | jq -r '.[] | "\(.id)  \(.username // "-")  \(.email // "-")"' ;;
        api)     clickup_raw "$@" ;;
      esac ;;
    check)
      load_token
      api GET /user >/dev/null && echo "✔ ClickUp token OK${PROFILE:+ (profile $PROFILE)}" || exit 2 ;;
    login) shift; clickup_login "$@" ;;
  esac
}
