#!/usr/bin/env bash
# test-tracker.sh — tickets: id parsing, gsdt-tracker with none / custom /
# clickup, --tracker clickup, and the ticket paths through gsdt-start,
# gsdt-finish and gsdt-doctor.
# CI-safe: the ClickUp API is a curl stub, gsd_run (GSD) and gh are stubbed, and
# remotes are local bare repos.
set -uo pipefail
PKG=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export PATH="$WORK/stub:$PKG/bin:$PATH"
unset GSD_PROVIDER GSD_AGENT GSD_AGENT_COMMAND GSD_LOCK_HELD GSD_SKIP_GUARD GSD_TRACKER \
      GSD_TRACKER_STATUS_START GSD_TRACKER_STATUS_FINISH GSD_CLICKUP_STATUS_START \
      GSD_CLICKUP_STATUS_FINISH GSD_CLICKUP_ENG_LIST
export CLICKUP_API_TOKEN=pk_test GSD_CLICKUP_CONFIG=/dev/null
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '%s\n' "$2" | sed 's/^/      /'; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
has() { if grep -q -- "$2" "$3"; then ok "$1"; else bad "$1" "$(tail -5 "$3")"; fi; }
hasnt() { if grep -q -- "$2" "$3"; then bad "$1" "$(grep -- "$2" "$3" | head -3)"; else ok "$1"; fi; }
fails() { local name=$1; shift; if "$@" > "$WORK/out" 2>&1; then bad "$name" "unexpected success"; else ok "$name"; fi; }
section() { printf '\n%s\n' "$1"; }
commit() { git -C "$1" add -A; git -C "$1" commit -qm "${2:-c}"; }

# ── stubs ────────────────────────────────────────────────────────────────────
mkdir -p "$WORK/stub"
cat > "$WORK/stub/gsd_run" <<'SDK'
#!/usr/bin/env bash
case "$1 $2" in
  "runtime-identity --raw") echo '{"packageName":"@opengsd/gsd-core","version":"1.18.0"}' ;;
  "query phase.add")
    rm="$5/.planning/ROADMAP.md"
    n=$(grep -oE '^### Phase [0-9]+:' "$rm" | grep -oE '[0-9]+' | sort -n | tail -1)
    printf '\n### Phase %s: %s\n' "$((n + 1))" "$3" >> "$rm" ;;
  *) echo "stub gsd_run: unsupported $*" >&2; exit 1 ;;
esac
SDK
cat > "$WORK/stub/gh" <<'GH'
#!/usr/bin/env bash
echo "https://github.com/example/shop/pull/1"
GH
# curl: a fake ClickUp API. Logs "METHOD PATH BODY"; prints body + http code
# (the adapter passes -w '\n%{http_code}').
cat > "$WORK/stub/curl" <<'CURL'
#!/usr/bin/env bash
m=GET; body=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) m=$2; shift ;; -d) body=$2; shift ;; -w|--max-time) shift ;; http*) url=$1 ;;
    -H) case "$2" in Authorization:*) auth=$2; printf '%s\n' "$2" >> "${CURL_AUTH_LOG:-/dev/null}" ;; esac; shift ;;
  esac
  shift
done
path=${url#https://api.clickup.com/api/v2}
printf '%s %s %s\n' "$m" "$path" "$body" >> "$CURL_LOG"
# pk_bad: a token ClickUp refuses
[ "${auth:-}" != "Authorization: pk_bad" ] || { printf '{"err":"Token invalid"}\n401'; exit 0; }
code=200
case "$m $path" in
  "GET /task/abc123?include_subtasks=true")
    out='{"status":{"status":"to do"},"list":{"id":"L1","name":"Backlog"},"subtasks":[
      {"id":"sub1","status":{"status":"to do","type":"open"},"date_closed":null},
      {"id":"sub2","status":{"status":"complete","type":"closed"},"date_closed":"1"}]}' ;;
  "GET /task/done123?include_subtasks=true")
    out='{"status":{"status":"In-Progress"},"list":{"id":"L1","name":"Backlog"},"subtasks":[]}' ;;
  "GET /list/L1") out='{"statuses":[{"status":"to do"},{"status":"In-Progress"},{"status":"In-Testing"}]}' ;;
  "GET /task/abc123?include_markdown_description=true")
    out='{"name":"Cart","url":"https://app.clickup.com/t/abc123","status":{"status":"to do"},"markdown_description":"As a buyer I keep a cart."}' ;;
  "GET /task/abc123/comment") out='{"comments":[{"comment_text":"looks good"}]}' ;;
  "GET /user") out='{"user":{"id":7}}' ;;
  "GET /team") out='{"teams":[{"id":"T1","name":"Acme","members":[{"user":{"id":42,"username":"Sara","email":"sara@x.io"}}]}]}' ;;
  "GET /team/T1/task?page=0"*)
    out='{"tasks":[{"id":"t1","name":"Fix login","status":{"status":"to do"},"list":{"name":"Sprint"}},
      {"id":"t2","name":"Cart totals","status":{"status":"in progress"},"list":{"name":"Sprint"}}]}' ;;
  "GET /team/T1/task?page="*) out='{"tasks":[]}' ;;
  "GET /team/T1/space") out='{"spaces":[{"id":"S1","name":"Eng"}]}' ;;
  "GET /space/S1/folder") out='{"folders":[{"id":"F1","name":"Web","lists":[{"id":"901","name":"Sprint"}]}]}' ;;
  "GET /space/S1/list") out='{"lists":[{"id":"902","name":"Inbox"}]}' ;;
  "POST /list/901/task") out='{"id":"new1","url":"https://app.clickup.com/t/new1"}' ;;
  PUT*|POST*|DELETE*) out='{}' ;;
  *) out='{"err":"not found"}'; code=404 ;;
esac
printf '%s\n%s' "$out" "$code"
CURL
chmod +x "$WORK/stub/gsd_run" "$WORK/stub/gh" "$WORK/stub/curl"
export GSD_CLI="$WORK/stub/gsd_run"
export CURL_LOG="$WORK/curl.log"

# a custom tracker: logs its argv and GSD_TRACKER_STATUS; FAIL-* ids fail
cat > "$WORK/tracker.sh" <<'TR'
#!/usr/bin/env bash
printf '%s|%s|status=%s\n' "$1" "$*" "${GSD_TRACKER_STATUS:-}" >> "$TRACKER_LOG"
case "${2:-}" in FAIL-*) exit 1 ;; esac
[ "$1" != snapshot ] || printf '# Ticket %s\n\nproduct words\n' "$2"
TR
chmod +x "$WORK/tracker.sh"
export TRACKER_LOG="$WORK/tracker.log"

. "$PKG/lib/common.sh"; . "$PKG/lib/ticket.sh"; . "$PKG/lib/tracker/ids.sh"

section "ticket ids — parse, extract, match"
is "bare id"                       "$(gsd_ticket_norm 869e33cv4)" 869e33cv4
is "tk- prefix"                    "$(gsd_ticket_norm tk-PROJ-42)" PROJ-42
is "legacy cu_ prefix"             "$(gsd_ticket_norm cu_869e33cv4)" 869e33cv4
is "CU- kept outside clickup (a Jira key)" "$(gsd_ticket_norm CU-12)" CU-12
is "CU- stripped for clickup"      "$(gsd_ticket_norm CU-869e33cv4 clickup)" 869e33cv4
is "ClickUp URL"                   "$(gsd_ticket_norm https://app.clickup.com/t/869e33cv4)" 869e33cv4
is "Jira URL with a query"         "$(gsd_ticket_norm 'https://x.atlassian.net/browse/PROJ-42?focus=1')" PROJ-42
is "#42"                           "$(gsd_ticket_norm '#42')" 42
if gsd_ticket_norm 'a b' >/dev/null; then bad "a space is refused"; else ok "a space is refused"; fi
if gsd_ticket_norm 'x;rm' >/dev/null; then bad "shell text is refused"; else ok "shell text is refused"; fi
is "extract from a title"          "$(gsd_ticket_extract '### Phase 7: cart tk-PROJ-42')" PROJ-42
is "extract before (INSERTED)"     "$(gsd_ticket_extract 'Phase 2.1: bug tk-abc123 (INSERTED)')" abc123
is "extract from a branch"         "$(gsd_ticket_extract phase-7-cart-tk-proj-42)" proj-42
is "extract legacy cu_"            "$(gsd_ticket_extract 'cart cu_869e33cv4')" 869e33cv4
is "extract legacy ClickUp <id>"   "$(gsd_ticket_extract 'cart ClickUp 869e33cv4')" 869e33cv4
is "no tag → nothing"              "$(gsd_ticket_extract 'plain stuck title')" ""
if gsd_ticket_tagged "cart tk-PROJ-42" PROJ-4; then bad "PROJ-4 is not PROJ-42"; else ok "PROJ-4 is not PROJ-42"; fi
if gsd_ticket_tagged "cart tk-PROJ-42" proj-42; then ok "tag match ignores case"; else bad "tag match ignores case"; fi

section "gsdt-tracker — no .gsd.conf → clickup"
R="$WORK/noconf"; mkdir -p "$R"; git -C "$R" init -qb main
is "which → clickup"                "$(cd "$R" && gsdt-tracker which)" clickup
is "GSD_TRACKER=none still wins"    "$(cd "$R" && GSD_TRACKER=none gsdt-tracker which)" none
is "--tracker still wins"           "$(cd "$R" && gsdt-tracker --tracker custom which)" custom

section "gsdt-tracker — tracker = none (the default in a GSD repo)"
R="$WORK/none"; mkdir -p "$R"; git -C "$R" init -qb main
printf 'base = main\n' > "$R/.gsd.conf"
(cd "$R" && gsdt-tracker which) > "$WORK/out"; is "which → none" "$(cat "$WORK/out")" none
(cd "$R" && gsdt-tracker start PROJ-1 hi) > "$WORK/out" 2>&1
is  "start is a no-op that succeeds" "$?" 0
has "…and says so"                   "tracker = none" "$WORK/out"
fails "snapshot is refused"          bash -c 'cd "$1" && gsdt-tracker snapshot PROJ-1' _ "$R"
fails "an unknown tracker is refused" gsdt-tracker --tracker jira start PROJ-1 hi
fails "a bad id is refused"          gsdt-tracker --tracker custom start 'a b' hi
is "extract works without a tracker" "$(gsdt-tracker extract 'x tk-Z9')" Z9
(cd "$R" && gsdt-tracker update PROJ-1 --name x) > "$WORK/out" 2>&1
is  "update with no tracker fails (exit 1)" "$?" 1
has "…saying none is connected"      "no tracker connected" "$WORK/out"
fails "create with no tracker fails" bash -c 'cd "$1" && gsdt-tracker create 901 x' _ "$R"
fails "tasks with no tracker fails"  bash -c 'cd "$1" && gsdt-tracker tasks' _ "$R"
fails "an unknown command fails"     bash -c 'cd "$1" && gsdt-tracker lists' _ "$R"
has   "…saying the tracker here is none" "the tracker here is none" "$WORK/out"

section "gsdt-tracker — tracker = custom"
R="$WORK/custom"; mkdir -p "$R/scripts"; git -C "$R" init -qb main
cp "$WORK/tracker.sh" "$R/scripts/tracker.sh"
printf 'tracker = custom\ntracker_command = scripts/tracker.sh\ntracker_status_start = Doing\n' > "$R/.gsd.conf"
: > "$TRACKER_LOG"
(cd "$R" && gsdt-tracker start https://x/browse/PROJ-42 "phase 7 started") > "$WORK/out" 2>&1
is  "start runs the script"            "$?" 0
has "…relative command, normalized id, text" "^start|start PROJ-42 phase 7 started|status=Doing$" "$TRACKER_LOG"
(cd "$R" && GSD_TRACKER_STATUS_START=Build gsdt-tracker start PROJ-42 x) >/dev/null 2>&1
has "env status beats .gsd.conf"       "status=Build$" "$TRACKER_LOG"
(cd "$R" && gsdt-tracker comment PROJ-42 note) >/dev/null 2>&1
has "comment gets no status"           "^comment|comment PROJ-42 note|status=$" "$TRACKER_LOG"
printf '#!/usr/bin/env bash\necho "profile=${GSD_TRACKER_PROFILE:-}"\n' > "$R/scripts/prof.sh"; chmod +x "$R/scripts/prof.sh"
printf 'tracker = custom\ntracker_command = scripts/prof.sh\ntracker_profile = acme\n' > "$R/.gsd.conf"
is  "the script gets GSD_TRACKER_PROFILE" "$(cd "$R" && gsdt-tracker check 2>&1)" "profile=acme"
printf 'tracker = custom\ntracker_command = scripts/tracker.sh\ntracker_status_start = Doing\n' > "$R/.gsd.conf"
fails "a failing script → nonzero"     bash -c 'cd "$1" && gsdt-tracker finish FAIL-1 x' _ "$R"
is  "…exit 2 (tracker call failed)"    "$(cd "$R" && gsdt-tracker finish FAIL-1 x >/dev/null 2>&1; echo $?)" 2
(cd "$R" && gsdt-tracker snapshot PROJ-42 --out "$WORK/t.md") > "$WORK/out" 2>&1
has "snapshot --out writes the file"   "product words" "$WORK/t.md"
fails "a failed snapshot → nonzero"    bash -c 'cd "$1" && gsdt-tracker snapshot FAIL-2 --out "$2"' _ "$R" "$WORK/f.md"
if [ -e "$WORK/f.md" ]; then bad "…and leaves no file"; else ok "…and leaves no file"; fi
: > "$TRACKER_LOG"
(cd "$R" && gsdt-tracker create PROJ "New thing" --label x) >/dev/null 2>&1
has "create goes to the script as written" "^create|create PROJ New thing --label x|status=$" "$TRACKER_LOG"
(cd "$R" && gsdt-tracker update https://x/browse/PROJ-42 --title y) >/dev/null 2>&1
has "update gets the normalized id"    "^update|update PROJ-42 --title y|status=$" "$TRACKER_LOG"
(cd "$R" && gsdt-tracker tasks --mine) >/dev/null 2>&1
has "tasks passes its options"         "^tasks|tasks --mine|status=$" "$TRACKER_LOG"
printf '#!/usr/bin/env bash\nsleep 30\n' > "$R/scripts/hang.sh"; chmod +x "$R/scripts/hang.sh"
printf 'tracker = custom\ntracker_command = scripts/hang.sh\n' > "$R/.gsd.conf"
t0=$(date +%s); rc=$(cd "$R" && GSD_TRACKER_TIMEOUT=2 gsdt-tracker start PROJ-42 x >/dev/null 2>"$WORK/err"; echo $?); t1=$(date +%s)
is  "a script that hangs is stopped (exit 2)" "$rc:$([ $((t1 - t0)) -lt 10 ] && echo fast)" "2:fast"
has "…saying so"                       "gave no answer in 2s" "$WORK/err"
printf 'tracker = custom\ntracker_command = scripts/tracker.sh\ntracker_status_start = Doing\n' > "$R/.gsd.conf"
printf '#!/usr/bin/env bash\ncat\n' > "$R/scripts/echo.sh"; chmod +x "$R/scripts/echo.sh"
is  "…and stdin still reaches the script" "$(printf 'desc' | bash -c 'cd "$1" && printf "tracker = custom\ntracker_command = scripts/echo.sh\n" > .gsd.conf && gsdt-tracker check' _ "$R" 2>/dev/null)" desc
printf 'tracker = custom\ntracker_command = scripts/tracker.sh\ntracker_status_start = Doing\n' > "$R/.gsd.conf"
fails "ClickUp's own commands are not custom's" bash -c 'cd "$1" && gsdt-tracker lists' _ "$R"
chmod -x "$R/scripts/tracker.sh"
fails "a non-executable command is refused" bash -c 'cd "$1" && gsdt-tracker start PROJ-42 x' _ "$R"
has   "…naming it"                     "not an executable" "$WORK/out"

section "gsdt-tracker — tracker = clickup (fake API)"
if ! command -v jq >/dev/null 2>&1; then
  echo "  SKIPPED: jq not installed"
else
  R="$WORK/cu"; mkdir -p "$R"; git -C "$R" init -qb main; printf 'tracker = clickup\n' > "$R/.gsd.conf"
  : > "$CURL_LOG"
  (cd "$R" && gsdt-tracker start abc123 "phase started") > "$WORK/out" 2>&1
  is  "start succeeds"                      "$?" 0
  has "status resolved in the list's spelling" 'PUT /task/abc123 {"status": "In-Progress"}' "$CURL_LOG"
  has "comment posted"                      'POST /task/abc123/comment {"comment_text": "phase started"}' "$CURL_LOG"
  has "open subtask cascades"               'PUT /task/sub1 ' "$CURL_LOG"
  hasnt "closed subtask left alone"         'PUT /task/sub2 ' "$CURL_LOG"
  : > "$CURL_LOG"; (cd "$R" && gsdt-tracker start done123 again) > "$WORK/out" 2>&1
  hasnt "already there → no status write (idempotent)" 'PUT /task/done123' "$CURL_LOG"
  hasnt "…and no second comment"            'POST /task/done123' "$CURL_LOG"
  : > "$CURL_LOG"; (cd "$R" && gsdt-tracker finish abc123 merged) >/dev/null 2>&1
  has "finish → In-Testing"                 'PUT /task/abc123 {"status": "In-Testing"}' "$CURL_LOG"
  printf 'tracker = clickup\ntracker_status_finish = to do\n' > "$R/.gsd.conf"
  : > "$CURL_LOG"; (cd "$R" && gsdt-tracker finish done123 back) >/dev/null 2>&1
  has "tracker_status_finish from .gsd.conf wins" 'PUT /task/done123 {"status": "to do"}' "$CURL_LOG"
  (cd "$R" && gsdt-tracker snapshot abc123) > "$WORK/snap" 2>&1
  has "snapshot: title"                     "^# Cart" "$WORK/snap"
  has "snapshot: description"               "As a buyer I keep a cart." "$WORK/snap"
  has "snapshot: comments"                  "^- looks good" "$WORK/snap"
  is  "an API error → exit 2"               "$(cd "$R" && gsdt-tracker start nope404 x >/dev/null 2>&1; echo $?)" 2
  : > "$CURL_LOG"; (cd "$WORK/none" && gsdt-tracker --tracker clickup start abc123 hi) >/dev/null 2>&1
  has "--tracker clickup forces clickup (repo says none)" 'PUT /task/abc123' "$CURL_LOG"
  is  "no gsd-clickup command (gsdt-tracker only)" "$([ -e "$PKG/bin/gsd-clickup" ] && echo there || echo gone)" gone
fi

section "gsdt-tracker — ClickUp-only commands (fake API)"
if ! command -v jq >/dev/null 2>&1; then
  echo "  SKIPPED: jq not installed"
else
  R="$WORK/cu"; printf 'tracker = clickup\n' > "$R/.gsd.conf"
  cu() { (cd "$R" && env -u CLICKUP_TEAM_ID gsdt-tracker "$@"); }
  : > "$CURL_LOG"; cu create 901 'Fix "login"' --desc '# Steps' --assign me --assign sara@x.io \
    --priority 2 --tag bug --parent tk-abc123 > "$WORK/out" 2>&1
  has "create prints the new id + url"      '✔ ClickUp new1 created · https://app.clickup.com/t/new1' "$WORK/out"
  has "create posts to the list, JSON-escaped" 'POST /list/901/task {"name":"Fix \\"login\\"","markdown_content":"# Steps"' "$CURL_LOG"
  has "…me and an email become user ids"    '"assignees":\[7,42\]' "$CURL_LOG"
  has "…priority, tag and parent"           '"priority":2,"tags":\["bug"\],"parent":"abc123"' "$CURL_LOG"
  printf 'line one\nline two\n' | cu create 901 piped --desc - >/dev/null 2>&1
  has "--desc - reads stdin"                '"markdown_content":"line one\\nline two"' "$CURL_LOG"
  fails "create refuses a non-numeric list" cu create Sprint x
  fails "create refuses priority 5"         cu create 901 x --priority 5
  fails "an unknown member fails"           cu create 901 x --assign nobody
  : > "$CURL_LOG"; cu update https://app.clickup.com/t/abc123 --name New --assign Sara --unassign 9 > "$WORK/out" 2>&1
  has "update takes a URL and sends add/rem" 'PUT /task/abc123 {"name":"New","assignees":{"add":\[42\],"rem":\[9\]}}' "$CURL_LOG"
  has "…and names what changed"             'updated: assignees, name' "$WORK/out"
  fails "update with no change fails"       cu update abc123
  : > "$CURL_LOG"; cu tasks --list 901 --status 'in progress' --assign me > "$WORK/out" 2>&1
  has "tasks lists one line per task"       '^t1  \[to do\]  Fix login · Sprint' "$WORK/out"
  has "…filters are encoded"                'list_ids%5B%5D=901&statuses%5B%5D=in%20progress&assignees%5B%5D=7' "$CURL_LOG"
  cu tasks --match CART > "$WORK/out" 2>&1
  has "--match finds by name, any case"     '^t2 ' "$WORK/out"
  hasnt "…and drops the rest"               '^t1 ' "$WORK/out"
  cu lists > "$WORK/out" 2>&1
  has "lists: folder lists"                 '^    list  901  Sprint' "$WORK/out"
  has "lists: lists with no folder"         '^  list  902  Inbox' "$WORK/out"
  is  "members"                             "$(cu members 2>&1)" "42  Sara  sara@x.io"
  : > "$CURL_LOG"; cu api DELETE /task/abc123/tag/bug >/dev/null 2>&1
  has "api passes any call through"         'DELETE /task/abc123/tag/bug' "$CURL_LOG"
  fails "api refuses a path without /"      cu api GET task/abc123
  fails "api refuses a body that is not JSON" cu api POST /task/abc123/comment 'hi'
  : > "$CURL_LOG"; (cd "$R" && CLICKUP_TEAM_ID=T1 gsdt-tracker tasks) >/dev/null 2>&1
  hasnt "CLICKUP_TEAM_ID skips the workspace lookup" 'GET /team ' "$CURL_LOG"
  section "gsdt-tracker — create / update / tasks and ClickUp's own commands (tracker = clickup)"
  : > "$CURL_LOG"; (cd "$R" && gsdt-tracker update tk-abc123 --priority 1) > "$WORK/out" 2>&1
  has "update through gsdt-tracker"          'PUT /task/abc123 {"priority":1}' "$CURL_LOG"
  (cd "$R" && gsdt-tracker create 901 hi) > "$WORK/out" 2>&1
  has "create through gsdt-tracker"          'created · https://app.clickup.com/t/new1' "$WORK/out"
  (cd "$R" && gsdt-tracker tasks --match login) > "$WORK/out" 2>&1
  has "tasks through gsdt-tracker"           '^t1 ' "$WORK/out"
  is  "lists (ClickUp's own) through gsdt-tracker" "$(cd "$R" && gsdt-tracker lists 2>&1 | head -1)" "space  S1  Eng"
  (cd "$R" && gsdt-tracker nope) > "$WORK/out" 2>&1
  has "an unknown command names the tracker's own" 'also has: lists members api' "$WORK/out"
fi

section "gsdt-tracker — tracker_profile picks the ClickUp token file"
# A clean token environment: no exported token, no GSD_CLICKUP_CONFIG, a fake HOME.
H="$WORK/home"; mkdir -p "$H/.config/gsd"
echo 'CLICKUP_API_TOKEN=pk_shared' > "$H/.config/gsd/clickup.env"
echo 'CLICKUP_API_TOKEN=pk_acme'   > "$H/.config/gsd/clickup-acme.env"
R="$WORK/prof"; mkdir -p "$R"; git -C "$R" init -qb main
cuenv() { (cd "$R" && env -u CLICKUP_API_TOKEN -u GSD_CLICKUP_CONFIG -u GSD_TRACKER_PROFILE \
            HOME="$H" CURL_AUTH_LOG="$WORK/auth.log" "$@"); }
printf 'tracker = clickup\n' > "$R/.gsd.conf"
: > "$WORK/auth.log"; cuenv gsdt-tracker check > "$WORK/out" 2>&1
has "no profile → the shared clickup.env"      'Authorization: pk_shared' "$WORK/auth.log"
printf 'tracker = clickup\ntracker_profile = acme\n' > "$R/.gsd.conf"
: > "$WORK/auth.log"; cuenv gsdt-tracker check > "$WORK/out" 2>&1
has "profile → clickup-acme.env"               'Authorization: pk_acme' "$WORK/auth.log"
has "check names the profile"                  'token OK (profile acme)' "$WORK/out"
: > "$WORK/auth.log"; cuenv env GSD_TRACKER_PROFILE=other gsdt-tracker check > "$WORK/out" 2>&1
is  "a profile with no file fails (exit 1)"    "$?" 1
has "…naming the profile's file"               'clickup-other.env' "$WORK/out"
hasnt "…and never falls back to the shared token" 'pk_shared' "$WORK/auth.log"
: > "$WORK/auth.log"; cuenv env CLICKUP_API_TOKEN=pk_env gsdt-tracker check > "$WORK/out" 2>&1
has "\$CLICKUP_API_TOKEN still wins"           'Authorization: pk_env' "$WORK/auth.log"
printf 'tracker = clickup\ntracker_profile = ../acme\n' > "$R/.gsd.conf"
: > "$WORK/auth.log"; cuenv gsdt-tracker check > "$WORK/out" 2>&1
is  "a profile with a slash is refused"        "$?" 1
is  "…before any API call"                     "$(wc -l < "$WORK/auth.log" | tr -d ' ')" 0

section "gsdt-tracker — settings: env > git config > .gsd.conf > default"
cuat() { local dir=$1; shift; (cd "$dir" && env -u CLICKUP_API_TOKEN -u GSD_CLICKUP_CONFIG -u GSD_TRACKER_PROFILE \
           HOME="$H" CURL_AUTH_LOG="$WORK/auth.log" "$@"); }
R="$WORK/prof"
printf 'tracker = clickup\ntracker_profile = other\n' > "$R/.gsd.conf"
git -C "$R" config gsdt-tracker.profile acme
: > "$WORK/auth.log"; cuenv gsdt-tracker check > "$WORK/out" 2>&1
has "git config profile beats .gsd.conf"       'Authorization: pk_acme' "$WORK/auth.log"
cuenv env GSD_TRACKER_PROFILE=other gsdt-tracker check > "$WORK/out" 2>&1
has "GSD_TRACKER_PROFILE beats git config"     'clickup-other.env' "$WORK/out"
git -C "$R" config --rename-section gsdt-tracker gsd-tracker   # a clone not yet migrated (before 0.10.0)
: > "$WORK/auth.log"; cuenv gsdt-tracker check > "$WORK/out" 2>&1
has "the old gsd-tracker git section is still read" 'Authorization: pk_acme' "$WORK/auth.log"
git -C "$R" config --rename-section gsd-tracker gsdt-tracker
cuenv gsdt-tracker config > "$WORK/conf" 2>&1
has "config: tracker and its source"           '^tracker=clickup$' "$WORK/conf"
has "…from .gsd.conf"                          '^tracker_from=gsd.conf$' "$WORK/conf"
has "config: profile from git"                 '^profile_from=git$' "$WORK/conf"
has "config: the token file"                   "^token_file=$H/.config/gsd/clickup-acme.env$" "$WORK/conf"
has "config: a token is found"                 '^token=file$' "$WORK/conf"
hasnt "config never prints a token"            'pk_' "$WORK/conf"
: > "$WORK/auth.log"; cuenv gsdt-tracker config > /dev/null 2>&1
is  "config is offline"                        "$(wc -l < "$WORK/auth.log" | tr -d ' ')" 0
git -C "$R" config --unset gsdt-tracker.profile
R="$WORK/none"
git -C "$R" config gsdt-tracker.tracker custom
is  "git config tracker beats .gsd.conf"       "$(cd "$R" && gsdt-tracker which)" custom
is  "…GSD_TRACKER beats git config"            "$(cd "$R" && GSD_TRACKER=none gsdt-tracker which)" none
git -C "$R" config --unset gsdt-tracker.tracker
R="$WORK/custom"
printf 'tracker = custom\n' > "$R/.gsd.conf"; cp "$WORK/tracker.sh" "$R/scripts/tracker.sh"
chmod +x "$R/scripts/tracker.sh"
git -C "$R" config gsdt-tracker.command scripts/tracker.sh
git -C "$R" config gsdt-tracker.statusStart Building
: > "$TRACKER_LOG"; (cd "$R" && gsdt-tracker start PROJ-5 go) > "$WORK/out" 2>&1
has "custom: command and status from git config" "^start|start PROJ-5 go|status=Building$" "$TRACKER_LOG"
git -C "$R" config --remove-section gsdt-tracker

section "gsdt-tracker login — in a GSD repo: the profile goes in git config"
R="$WORK/MyShop"; mkdir -p "$R"; git -C "$R" init -qb main
printf 'tracker = clickup' > "$R/.gsd.conf"   # no final newline
cp "$R/.gsd.conf" "$WORK/conf.before"
F="$H/.config/gsd/clickup-myshop.env"
echo pk_new | cuenv gsdt-tracker login > "$WORK/out" 2>&1
is  "login exits 0"                            "$?" 0
is  "the profile is the folder's name"         "$(cat "$F" 2>/dev/null)" "CLICKUP_API_TOKEN=pk_new"
is  "…and only you can read the file"          "$(find "$F" -perm 600)" "$F"
is  "git config gets gsdt-tracker.profile"      "$(git -C "$R" config --get gsdt-tracker.profile)" "myshop"
if cmp -s "$R/.gsd.conf" "$WORK/conf.before"; then ok ".gsd.conf is never edited"; else bad ".gsd.conf is never edited" "$(cat "$R/.gsd.conf")"; fi
: > "$WORK/auth.log"; cuenv gsdt-tracker check > "$WORK/out" 2>&1
has "check now uses the saved token"           'Authorization: pk_new' "$WORK/auth.log"
echo 'CLICKUP_TEAM_ID=T9' >> "$F"
echo pk_new2 | cuenv gsdt-tracker login > "$WORK/out" 2>&1
has "a piped token replaces the saved one"     'replaced →' "$WORK/out"
is  "…once, keeping other lines"               "$(sort "$F" | tr '\n' ' ')" "CLICKUP_API_TOKEN=pk_new2 CLICKUP_TEAM_ID=T9 "
has "…and the repo already uses it"            'already uses profile myshop' "$WORK/out"
echo pk_other | cuenv gsdt-tracker login acme2 > "$WORK/out" 2>&1
is  "a named profile switches the repo"        "$(git -C "$R" config --get gsdt-tracker.profile)" "acme2"
is  "…in its own file"                         "$(cat "$H/.config/gsd/clickup-acme2.env")" "CLICKUP_API_TOKEN=pk_other"
printf 'tracker = clickup\ntracker_profile = team\n' > "$R/.gsd.conf"
echo pk_other | cuenv gsdt-tracker login acme2 > "$WORK/out" 2>&1
has "a different tracker_profile in .gsd.conf is named" 'tracker_profile = team; in this clone git config wins' "$WORK/out"
echo pk_bad | cuenv gsdt-tracker login bad1 > "$WORK/out" 2>&1
is  "a refused token fails (exit 2)"           "$?" 2
if [ -e "$H/.config/gsd/clickup-bad1.env" ]; then bad "…and is never saved"; else ok "…and is never saved"; fi
is  "…nor picked for the repo"                 "$(git -C "$R" config --get gsdt-tracker.profile)" "acme2"
: > "$WORK/auth.log"; echo 'pk_x$(touch pwned)' | cuenv gsdt-tracker login > "$WORK/out" 2>&1
is  "a token with shell characters is refused" "$?" 1
is  "…before any API call"                     "$(wc -l < "$WORK/auth.log" | tr -d ' ')" 0
cuenv gsdt-tracker login fresh < /dev/null > "$WORK/out" 2>&1
is  "no token → exit 1"                        "$?" 1
echo pk_new | cuenv gsdt-tracker login ../x > "$WORK/out" 2>&1
is  "a profile with a slash is refused"        "$?" 1
printf 'base = main\n' > "$R/.gsd.conf"
echo pk_new | cuenv gsdt-tracker login > "$WORK/out" 2>&1
has "tracker = none here → says how to set it" 'git config gsdt-tracker.tracker clickup' "$WORK/out"

section "gsdt-tracker login — a plain repo, a worktree, no repo"
R="$WORK/plainrepo"; mkdir -p "$R"; git -C "$R" init -qb main; echo a > "$R/a"; commit "$R" init
echo pk_plain | cuat "$R" gsdt-tracker login plain > "$WORK/out" 2>&1
is  "a plain repo: login works"                "$?" 0
is  "…the profile goes in git config"          "$(git -C "$R" config --get gsdt-tracker.profile)" "plain"
is  "…and no file appears in the repo"         "$(git -C "$R" status --short)" ""
: > "$WORK/auth.log"; cuat "$R" gsdt-tracker check > "$WORK/out" 2>&1
has "…and check uses that profile"             'Authorization: pk_plain' "$WORK/auth.log"
git -C "$R" worktree add -q -b phase-1-x "$WORK/plainrepo-wt"; mkdir -p "$WORK/plainrepo-wt/deep"
echo pk_wt | cuat "$WORK/plainrepo-wt/deep" gsdt-tracker login wtp > "$WORK/out" 2>&1
is  "from a worktree: login works"             "$?" 0
is  "…and the whole clone uses it"             "$(git -C "$R" config --get gsdt-tracker.profile)" "wtp"
: > "$WORK/auth.log"; cuat "$R" gsdt-tracker check > "$WORK/out" 2>&1
has "…the main checkout too"                   'Authorization: pk_wt' "$WORK/auth.log"
N="$WORK/norepo"; mkdir -p "$N"
: > "$WORK/auth.log"; echo pk_solo | cuat "$N" gsdt-tracker login > "$WORK/out" 2>&1
is  "no repo, no name → exit 1"                "$?" 1
has "…asking for the name"                     'name the profile' "$WORK/out"
is  "…before the token is read or sent"        "$(wc -l < "$WORK/auth.log" | tr -d ' ')" 0
echo pk_solo | cuat "$N" gsdt-tracker login solo > "$WORK/out" 2>&1
is  "no repo, a name → the token is saved"     "$?:$(cat "$H/.config/gsd/clickup-solo.env")" "0:CLICKUP_API_TOKEN=pk_solo"
has "…and says how to use it in a repo"        'in the repo, run: gsdt-tracker login solo' "$WORK/out"

section "gsdt-tracker login — a saved profile: use it or replace it"
if command -v expect >/dev/null 2>&1; then
  # Answers $ANS at the [U/r] question and types $TOK at the hidden prompt.
  cat > "$WORK/login.exp" <<'EXP'
spawn gsdt-tracker login $env(PROF)
expect {
  -ex {[U/r] }   { send "$env(ANS)\r"; exp_continue }
  -ex {hidden): } { send "$env(TOK)\r"; exp_continue }
  eof
}
EXP
  typed() { cuat "$WORK/plainrepo" env PROF="$1" ANS="$2" TOK="$3" expect "$WORK/login.exp" > "$WORK/out" 2>&1; }
  typed solo '' pk_unused
  has "Enter uses the saved token"             'kept →' "$WORK/out"
  hasnt "…without asking for one"              'hidden): ' "$WORK/out"
  is  "…the file is unchanged"                 "$(cat "$H/.config/gsd/clickup-solo.env")" "CLICKUP_API_TOKEN=pk_solo"
  is  "…and the repo now uses it"              "$(git -C "$WORK/plainrepo" config --get gsdt-tracker.profile)" "solo"
  typed solo r pk_typed
  is  "r replaces it"                          "$(cat "$H/.config/gsd/clickup-solo.env")" "CLICKUP_API_TOKEN=pk_typed"
  hasnt "…and the typed token is never shown"  'pk_typed' "$WORK/out"
  echo 'CLICKUP_API_TOKEN=pk_bad' > "$H/.config/gsd/clickup-stale.env"
  typed stale u pk_fresh
  has "a saved token ClickUp refuses → asks for a new one" 'did not accept the saved token' "$WORK/out"
  is  "…and saves the new one"                 "$(cat "$H/.config/gsd/clickup-stale.env")" "CLICKUP_API_TOKEN=pk_fresh"
  typed brandnew '' pk_brand
  hasnt "no saved token → no question"         '\[U/r\]' "$WORK/out"
  is  "…just the token prompt"                 "$(cat "$H/.config/gsd/clickup-brandnew.env")" "CLICKUP_API_TOKEN=pk_brand"
else
  ok "SKIP use-or-replace tests (no expect)"
fi

section "gsdt-tracker is standalone"
S="$WORK/solo-pkg"; mkdir -p "$S/bin" "$S/src/commands"
cp "$PKG/bin/gsdt-tracker" "$S/bin/"; cp "$PKG/src/launch.mjs" "$S/src/"
cp "$PKG/src/commands/tracker.ts" "$S/src/commands/"; cp -R "$PKG/src/tracker" "$S/src/"
is  "runs with only its own files"             "$(cd "$WORK/noconf" && "$S/bin/gsdt-tracker" which)" clickup
: > "$CURL_LOG"; (cd "$WORK/noconf" && "$S/bin/gsdt-tracker" --tracker clickup check) > "$WORK/out" 2>&1
has "…and talks to ClickUp"                    'GET /user' "$CURL_LOG"
echo pk_s | cuat "$WORK/noconf" "$S/bin/gsdt-tracker" login standalone > "$WORK/out" 2>&1
is  "…and logs in"                             "$?" 0
uses=$(cd "$PKG" && grep -nE '(^|[^A-Za-z0-9_])gsd_[a-z]|lib/(common|ticket|provider)\.sh' \
         bin/gsdt-tracker lib/tracker/*.sh | grep -vE "^[^:]+:[0-9]+:[[:space:]]*#" || true)
is  "tracker files use no GSD code"            "$uses" ""
# the TypeScript: every import is node:… or a path inside src/tracker (and no GSD name is called)
tsuses=$(cd "$PKG" && grep -nE '(^|[^A-Za-z0-9_])gsd_[a-z]|lib/(common|ticket|provider)\.sh' \
           src/tracker/*.ts src/commands/tracker.ts | grep -vE "^[^:]+:[0-9]+:[[:space:]]*(//|\*)" || true)
is  "tracker TypeScript uses no GSD names"     "$tsuses" ""
ts_foreign_imports() {  # every import/export-from/dynamic import that is not node:… or inside src/tracker
  local f spec
  for f in src/tracker/*.ts src/commands/tracker.ts; do
    grep -hoE "(from|import\\(|require\\()[[:space:]]*['\"][^'\"]*['\"]" "$f" | sed -E "s/^[a-z(]*[[:space:]]*['\"]([^'\"]*)['\"]/\\1/" \
      | while read -r spec; do
          case "$spec" in
            node:*) ;;
            ./*) ;;
            ../tracker/*) [ "$f" = src/commands/tracker.ts ] || echo "$f: $spec" ;;
            *) echo "$f: $spec" ;;
          esac
        done
  done
}
tsimports=$(cd "$PKG" && ts_foreign_imports)
is  "tracker TypeScript imports only node:* and src/tracker" "$tsimports" ""
srcs=$(cd "$PKG" && grep -nE '^[[:space:]]*\. .*lib/tracker/' bin/* lib/*.sh | grep -vE '^bin/gsdt-tracker:' || true)
is  "GSD never sources tracker files"          "$srcs" ""
tsrefs=$(cd "$PKG" && grep -rnE "from[[:space:]]+['\"][^'\"]*tracker/" src --include='*.ts' \
           | grep -vE '^src/(tracker/|commands/tracker\.ts:)' || true)
is  "GSD (src/) never imports from src/tracker" "$tsrefs" ""
is  "GSD: a tracker nobody set counts as none" "$(GSD_PKG=$PKG gsd_tracker_which "$WORK/noconf")" none
is  "…a set one counts"                     "$(GSD_PKG=$PKG gsd_tracker_which "$WORK/custom")" custom
for s in 869e33cv4 tk-PROJ-42 cu_869e33cv4 CU-12 'https://x.atlassian.net/browse/PROJ-42?focus=1' '#42' 'a b' 'x;rm'; do
  for as in '' clickup; do
    a=$(gsd_ticket_norm "$s" "$as" || echo FAIL); b=$(trk_id_norm "$s" "$as" || echo FAIL)
    [ "$a" = "$b" ] || bad "id twins differ on '$s' ($as)" "gsd: $a  tracker: $b"
  done
done
for s in '### Phase 7: cart tk-PROJ-42' 'Phase 2.1: bug tk-abc123 (INSERTED)' phase-7-cart-tk-proj-42 \
         'cart cu_869e33cv4' 'cart ClickUp 869e33cv4' 'plain stuck title'; do
  [ "$(gsd_ticket_extract "$s")" = "$(trk_id_extract "$s")" ] || bad "extract twins differ on '$s'"
done
ok "GSD's id helpers and the tracker's copies agree"

# ── through gsdt-start / gsdt-finish ───────────────────────────────────────────
project() {  # $1=dir $2=extra .gsd.conf lines — repo on main + bare origin
  git init -q --bare -b main "$1.git"
  mkdir -p "$1/.planning/phases" "$1/scripts"; git -C "$1" init -qb main
  printf '# Roadmap\n\n### Phase 1: catalog\n' > "$1/.planning/ROADMAP.md"
  printf 'install = none\ntest = none\n%s' "${2:-}" > "$1/.gsd.conf"
  cp "$WORK/tracker.sh" "$1/scripts/tracker.sh"
  commit "$1" init; git -C "$1" remote add origin "$1.git"; git -C "$1" push -qu origin main
}

section "gsdt-start --ticket / gsdt-finish — tracker = custom"
R="$WORK/shop"; project "$R" 'tracker = custom
tracker_command = scripts/tracker.sh
'
: > "$TRACKER_LOG"
(cd "$R" && gsdt-start -n "shopping cart" --ticket PROJ-42 --no-launch) > "$WORK/out" 2>&1
is  "claim with --ticket succeeds"      "$?" 0
is  "title ends with tk-<id>"           "$(grep -c '^### Phase 2: shopping cart tk-PROJ-42$' "$R/.planning/ROADMAP.md")" 1
if git -C "$R" show-ref -q --verify refs/heads/phase-2-shopping-cart-tk-proj-42; then ok "branch/slug ends with tk-<id>"
else bad "branch/slug ends with tk-<id>" "$(git -C "$R" branch)"; fi
has "ticket moved to started"           "^start|start PROJ-42 🚧 GSD phase 2 started" "$TRACKER_LOG"
fails "same ticket, other words → refused" bash -c 'cd "$1" && gsdt-start -n "cart again" --ticket https://x/browse/PROJ-42 --no-launch' _ "$R"
has   "…naming the phase to attach to"  "phase 2 already tracks ticket PROJ-42" "$WORK/out"
fails "a malformed --ticket is refused" bash -c 'cd "$1" && gsdt-start -n "x" --ticket "a b" --no-launch' _ "$R"
(cd "$R" && gsdt-start -n "legacy flag" --cu CU-abc123 --no-launch) > "$WORK/out" 2>&1
is  "--cu still works, CU- stripped"    "$(grep -c '^### Phase 3: legacy flag tk-abc123$' "$R/.planning/ROADMAP.md")" 1
(cd "$R" && gsdt-start -n "flaky tracker" --ticket FAIL-9 --no-launch) > "$WORK/out" 2>&1
is  "a tracker failure doesn't block the claim" "$?" 0
has "…it is only a note"                "ticket FAIL-9 not updated (non-fatal)" "$WORK/out"
: > "$TRACKER_LOG"
(cd "$R" && gsdt-start -p 2 --no-launch) > "$WORK/out" 2>&1
has "-p re-attach reads the id from the title (case kept)" "^start|start PROJ-42 " "$TRACKER_LOG"
WT=$(git -C "$R" worktree list --porcelain | awk '/^worktree /{w=substr($0,10)} /refs\/heads\/phase-2-/{print w}')
printf 'cart\n' > "$WT/cart.txt"; commit "$WT" cart
: > "$TRACKER_LOG"
(cd "$R" && gsdt-finish 2 --pr) > "$WORK/out" 2>&1
has "finish --pr → finish, PR opened"   "^finish|finish PROJ-42 🔀 GSD phase 2: PR opened" "$TRACKER_LOG"
(cd "$R" && gsdt-finish 2) > "$WORK/out" 2>&1
is  "finish succeeds"                   "$?" 0
has "finish → finish, merged"           "^finish|finish PROJ-42 ✅ GSD phase 2 merged to main" "$TRACKER_LOG"

section "gsdt-start — with a tracker set, a new phase needs its ticket"
R="$WORK/needs"; project "$R" 'tracker = custom
tracker_command = scripts/tracker.sh
'
before=$(git --git-dir="$R.git" rev-parse main)
fails "a claim with no ticket is refused" bash -c 'cd "$1" && gsdt-start -n "search" --no-launch' _ "$R"
has   "…saying how to give one"         "add --ticket <id>" "$WORK/out"
has   "…or to go without"               "add --no-ticket" "$WORK/out"
is    "…and nothing was claimed"        "$(grep -c '^### Phase' "$R/.planning/ROADMAP.md"):$(git --git-dir="$R.git" rev-parse main)" "1:$before"
fails "--insert is refused too"         bash -c 'cd "$1" && gsdt-start --insert 1 "hotfix" --no-launch' _ "$R"
(cd "$R" && gsdt-start -n "search tk-PROJ-7" --no-launch) > "$WORK/out" 2>&1
is  "a tk-<id> tag in the description counts" "$?" 0
(cd "$R" && gsdt-start -n "bump deps" --no-ticket --no-launch) > "$WORK/out" 2>&1
is  "--no-ticket claims anyway"         "$?:$(grep -c '^### Phase 3: bump deps$' "$R/.planning/ROADMAP.md")" "0:1"
(cd "$R" && gsdt-start -p 1 --no-launch) > "$WORK/out" 2>&1
is  "-p on an old phase with no ticket still attaches" "$?" 0
has "…with a note"                      "phase 1 has no ticket" "$WORK/out"

section "gsdt-start --ticket — tracker = none tags only"
R="$WORK/plain"; project "$R"
: > "$TRACKER_LOG"
(cd "$R" && gsdt-start -n "search" --ticket 77 --no-launch) > "$WORK/out" 2>&1
is  "claim succeeds"                    "$?" 0
is  "title tagged"                      "$(grep -c '^### Phase 2: search tk-77$' "$R/.planning/ROADMAP.md")" 1
has "…with a note that nothing is updated" "phase tagged tk-77 only" "$WORK/out"
is  "no tracker call"                   "$(wc -l < "$TRACKER_LOG" | tr -d ' ')" 0

section "gsdt-doctor — tracker config"
doc() { gsdt-doctor --repo "$1" --json 2>/dev/null; }
# file, not a pipe: grep -q would exit early and pipefail would fail the pipe
code() { doc "$1" > "$WORK/dj"; grep -q "\"code\":\"$2" "$WORK/dj"; }
R="$WORK/doc"; project "$R"
printf '\n### Phase 2: old cart cu_869e33cv4\n' >> "$R/.planning/ROADMAP.md"
if code "$R" T070; then ok "T070: cu_ tags with tracker = none"; else bad "T070: cu_ tags with tracker = none"; fi
printf 'tracker = clickup\n' >> "$R/.gsd.conf"
if code "$R" T07; then bad "…gone once tracker = clickup"; else ok "…gone once tracker = clickup"; fi
printf 'install = none\ntracker = jira\n' > "$R/.gsd.conf"
if code "$R" T071; then ok "T071: unknown tracker"; else bad "T071: unknown tracker"; fi
printf 'install = none\n' > "$R/.gsd.conf"; git -C "$R" config gsdt-tracker.tracker jira
if code "$R" T071 && grep -q "git config gsdt-tracker.tracker" "$WORK/dj"; then ok "T071 from git config names git config"; else bad "T071 from git config names git config" "$(cat "$WORK/dj")"; fi
git -C "$R" config --unset gsdt-tracker.tracker
printf 'install = none\ntracker = custom\ntracker_command = scripts/missing.sh\n' > "$R/.gsd.conf"
if code "$R" T072; then ok "T072: custom command missing"; else bad "T072: custom command missing"; fi
R="$WORK/debt"; project "$R" 'flow = strict
tracker = custom
tracker_command = scripts/tracker.sh
'
printf '# Roadmap\n\n- [x] **Phase 1: catalog tk-PROJ-7**\n\n### Phase 1: catalog tk-PROJ-7\n' > "$R/.planning/ROADMAP.md"
mkdir -p "$R/.planning/phases/01-catalog-tk-proj-7"
doc "$R" > "$WORK/out"
has "T040 counts a missing ticket snapshot" "Phase 1 merged without: ticket" "$WORK/out"
has "…fix names the snapshot command"   "gsdt-tracker snapshot proj-7 --out .planning/phases/01-catalog-tk-proj-7/01-TICKET.md" "$WORK/out"
printf 'install = none\nflow = strict\n' > "$R/.gsd.conf"
doc "$R" > "$WORK/out"
hasnt "tracker = none → no ticket debt"  "without: ticket" "$WORK/out"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
