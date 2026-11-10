# Tickets and trackers

A **ticket** is the issue or task in your tracker that a phase implements
(a ClickUp task, a Jira issue, a GitHub issue, …). Linking one is optional.

## Link a phase to a ticket

```sh
gsdt-start -n "shopping cart" --ticket 869e33cv4
gsdt-start -n "login" --ticket https://acme.atlassian.net/browse/PROJ-42
```

The phase title and slug end with the tag `tk-<id>`:

```
### Phase 7: shopping cart tk-869e33cv4       (ROADMAP.md)
phase-7-shopping-cart-tk-869e33cv4            (branch / worktree)
```

`--ticket` takes the bare id, `tk-<id>`, `#<id>`, or the ticket URL (the last
path segment). Ids are letters and digits, with `-` between parts (`PROJ-42`).
A second claim with the same ticket is refused, however it is worded.

The tag is read back from the ROADMAP title (exact case), then the branch name
(lowercased). A tag already in the description works the same as `--ticket`.

## Commands

`gsdt-tracker` is the one layer sessions and scripts call; each tracker is a
connector under it (`lib/tracker/<name>.sh`). Shared verbs, the same for
every tracker:

| Verb | Does |
|---|---|
| `snapshot <id> [--out <file>]` | print the ticket as markdown |
| `comment <id> <text>` · `status <id> <status>` | write back |
| `start` / `finish <id> <text>` | status + comment (called by `gsdt-start` / `gsdt-finish`) |
| `create <where> <title> [option…]` | new ticket; prints its id + url |
| `update <id> <option>…` | change fields |
| `tasks [option…]` | find tickets |
| `check` · `which` | login works · which tracker |
| `config` | the settings in use and where each came from (offline; never prints a token) |

Options for `create` / `update` / `tasks` go to the connector as written; what
`<where>` is and which options work are the connector's. A connector may add
its own commands (`TRACKER_EXTRA`; ClickUp: `lists`, `members`, `api`). With
`tracker = none`, `comment` / `status` / `start` / `finish` do nothing and
succeed (so a claim never fails for want of a tracker), while `snapshot` /
`create` / `update` / `tasks` fail. Agents learn this from the `gsdt-tracker`
skill: it checks `gsdt-tracker which` first.

## Pick a tracker

`gsdt-tracker` is standalone: it works in any folder, GSD repo or not, and GSD
runs it as a command. Each setting, first match wins:

| Setting | Environment | git config (this clone) | `.gsd.conf` (the team) |
|---|---|---|---|
| tracker | `GSD_TRACKER` (`--tracker` wins) | `gsdt-tracker.tracker` | `tracker` |
| login profile | `GSD_TRACKER_PROFILE` | `gsdt-tracker.profile` | `tracker_profile` |
| custom script | – | `gsdt-tracker.command` | `tracker_command` |
| start status | `GSD_TRACKER_STATUS_START` | `gsdt-tracker.statusStart` | `tracker_status_start` |
| finish status | `GSD_TRACKER_STATUS_FINISH` | `gsdt-tracker.statusFinish` | `tracker_status_finish` |

git config lives in `.git/config`: never committed, shared by every worktree of
the clone. With nothing set, the tracker is `none` in a repo with a
`.gsd.conf`, and ClickUp anywhere else. GSD (`gsdt-start`, `gsdt-finish`, the
flow, `gsdt-doctor`) counts only a tracker that is set: that ClickUp default
never makes it move tickets. `gsdt-tracker config` shows what is in use.

A GSD repo picks its tracker for the whole team in `.gsd.conf`:

```ini
tracker = none        # default: tags only, nothing is updated
tracker = clickup     # the ClickUp API
tracker = custom      # your own script
tracker_command = scripts/tracker.sh     # custom only; relative to the repo root
tracker_status_start = In Progress       # optional
tracker_status_finish = In QA            # optional
tracker_profile = acme                   # optional; gsdt-tracker login sets git config instead (below)
```

With a tracker set:

| When | What happens |
|---|---|
| `gsdt-start` claims or attaches | `gsdt-tracker start <id>`: ticket → "in progress", plus a comment |
| `/gsdt-flow` first step | `ticket`: `gsdt-tracker snapshot <id> --out <P>-TICKET.md`, then commit |
| `gsdt-finish --pr` opens the PR | `gsdt-tracker finish <id>`: ticket → "in testing", plus a comment |
| `gsdt-finish` merges | the same, with the merge commit |

A new claim (`gsdt-start -n`, `--insert`) needs its ticket: `--ticket <id>` or
a `tk-<id>` tag in the description. Without one it is refused, and nothing is
claimed; `--no-ticket` claims anyway, for work no ticket covers. `gsdt-start -p`
on a phase with no ticket only notes it.

`gsdt-init` asks which tracker to use (in a terminal, while `.gsd.conf` names
none). A script passes `gsdt-init --tracker none|clickup|custom`
(`--tracker-command <script>` for custom); `gsdt-bootstrap-repo` takes the same
flags.

A tracker failure is only a note. It never blocks a claim or a merge.
With `tracker = none` the `ticket` flow step is skipped.

## ClickUp

Token, first match wins: `$CLICKUP_API_TOKEN`, or `CLICKUP_API_TOKEN=pk_…` in
the token file. Check it: `gsdt-tracker check`. Needs `jq`.

The token file is `~/.config/gsd/clickup.env`, shared by every project. To use
a different ClickUp user in one repo (other workspace, split rate limits), run
this anywhere in the repo (main checkout or a phase worktree, GSD repo or not):

```sh
gsdt-tracker login            # or: gsdt-tracker login acme
```

The profile is the name you give, else the one in use, else the repo folder's
name. If `~/.config/gsd/clickup-<profile>.env` already holds a token, it asks
first: `Use it, or replace it? [U/r]`. Otherwise it asks for the token (typing
is hidden), tests it with ClickUp, and saves it there (only you can read it;
other lines such as `CLICKUP_TEAM_ID` are kept). A token ClickUp refuses is
never saved; a saved one it refuses makes login ask for a new one. Then it sets
`git config gsdt-tracker.profile <profile>`, which picks the profile for this
clone and all its worktrees. It never edits `.gsd.conf`. On another machine or
clone, run `gsdt-tracker login` once more. `echo pk_… | gsdt-tracker login` works
too (no question then; the piped token replaces a saved one).

Outside any repo (e.g. in `~`), `gsdt-tracker login <name>` only saves the token.
In the repo, `gsdt-tracker login <name>` then offers that saved token.

By hand, the same thing is:

```sh
git config gsdt-tracker.profile acme                          # in the repo
echo 'CLICKUP_API_TOKEN=pk_…' > ~/.config/gsd/clickup-acme.env   # on each machine
```

With a profile set, only `clickup-acme.env` is read. There is no fallback to
`clickup.env`: a missing file is an error, not the wrong user. The file sits
outside every checkout, so all phase worktrees see it. An exported
`$CLICKUP_API_TOKEN` still wins (`gsdt-doctor` notes it), and
`GSD_TRACKER_PROFILE=<name>` overrides the profile for one command. A
`tracker_profile` already in `.gsd.conf` still works; git config wins over it.

Status names match the task's own list, ignoring case, spaces, `-` and `_`
("in testing" finds "In-Testing"). Tried in order: the configured status, then
"in progress" / "in development" (start) or "in testing" / "in review"
(finish). Open subtasks move with the task. A task already in the target
status gets no second comment.

### Create, update, find — and ClickUp's own commands

With `tracker = clickup`, `gsdt-tracker create` / `update` / `tasks` work on
ClickUp, and ClickUp's own commands `lists`, `members` and `api` go through
`gsdt-tracker` too:

```sh
gsdt-tracker lists                       # spaces, folders, lists — with ids
gsdt-tracker members                     # id, username, email
gsdt-tracker tasks --list 901 --assign me --status "in progress"
gsdt-tracker tasks --match "login"       # name search over up to 1,000 tasks
gsdt-tracker create 901 "Fix login" --desc "# Steps…" --assign sara@x.io --priority 2 --tag bug
gsdt-tracker update 869e33cv4 --name "Fix login on Safari" --assign me --unassign 42
gsdt-tracker api DELETE /task/869e33cv4/tag/bug   # any API v2 call; prints the body
```

`create`'s `<where>` is a list id. `<who>` is `me`, a user id, an email or a
username. `--desc -` reads the markdown from stdin. Priority: 1 urgent,
2 high, 3 normal, 4 low. `tasks`, `lists` and `members` need the workspace:
`CLICKUP_TEAM_ID` (env or the token file), else the only workspace the token
sees. They use the same token and profile as above.
`gsdt-tracker --tracker clickup <command>` forces ClickUp, whatever the repo
sets. See `gsdt-tracker --help`.

## Custom

Any tracker, through a script you keep in the repo:

```sh
<tracker_command> start    <id> <text>     # GSD_TRACKER_STATUS = configured start status, or empty
<tracker_command> finish   <id> <text>     # GSD_TRACKER_STATUS = configured finish status, or empty
<tracker_command> comment  <id> <text>
<tracker_command> status   <id> <status>
<tracker_command> snapshot <id>            # print the ticket as markdown on stdout
<tracker_command> check                    # exit 0 when set up
<tracker_command> create <where> <title> [option…]   # optional: options as the user wrote them
<tracker_command> update <id> <option>…
<tracker_command> tasks  [option…]
```

A script that can't do a verb exits nonzero (reported as "tracker call
failed"). Connector-only commands (`lists`, …) are not passed to it.

`GSD_TRACKER_PROFILE` holds the profile setting (or is empty), so the script
can pick its own login. The script can come from `gsdt-tracker.command` in git
config instead of `tracker_command`.

Exit 0 on success. Any other exit is reported as "tracker call failed".
A call that runs longer than 60 seconds (`GSD_TRACKER_TIMEOUT` to change it)
is stopped, so a script stuck on the network never hangs `gsdt-start` or
`gsdt-finish`.
Example for GitHub issues:

```sh
#!/usr/bin/env bash
case "$1" in
  start|finish|comment) gh issue comment "$2" --body "$3" ;;
  status)   gh issue edit "$2" --add-label "$3" ;;
  snapshot) gh issue view "$2" --comments ;;
  check)    gh auth status ;;
esac
```

## Old names

Still read, never written:

- `--cu <id>` → same as `--ticket` (also strips a `CU-` prefix).
- `cu_<id>` / `CU-<id>` / `ClickUp <id>` tags in titles and branches.
- `<P>-STORY.md` counts as the ticket snapshot. A `cu_` phase folder counts too.
- `GSD_CLICKUP_STATUS_START` / `_FINISH` still work (`GSD_TRACKER_STATUS_*` win).

`gsdt-doctor` findings (it reads `gsdt-tracker config`):

| Code | Meaning | Fix |
|---|---|---|
| T070 | ROADMAP has `cu_` tags but `tracker = none` | add `tracker = clickup` |
| T071 | unknown tracker value | use none, clickup, or custom (doctor names where it is set) |
| T072 | `tracker = custom` without an executable script | set it, `chmod +x` |
| T018 | the profile is not a name | fix it where it is set |
| T073 | `tracker = clickup` but no token on this machine | `gsdt-tracker login` |
| T040 | (with `flow = strict`) a merged phase has no ticket snapshot | the `gsdt-tracker snapshot` command it prints |
