# Plan: make gsd-tracker a standalone tool that GSD uses

Status: **built** 2026-11-04 (unreleased). Written and approved the same day.

## Why

`gsd-tracker` works in any repo, but its settings live in `.gsd.conf`, and a
`.gsd.conf` means "GSD is set up here". So `gsd-tracker login` cannot remember
a profile in a plain repo: making a `.gsd.conf` there would turn off the
guard's rule 0 (`/gsd-new-project` before `gsd-init`, `bin/gsd-worktree-guard:169`),
turn on every other rule (`:173`), and drop an untracked file in the repo.

The tracker is ~800 lines and borrows only a few GSD helpers (`gsd_conf_get`,
`gsd_main`, `gsd_base`, the checkout lock, `gsd_python`). The split is small.

## Decision (2026-11-04)

Same repo, same installer, same release. The tracker stops using GSD code and
gets its own settings. GSD uses it only through its commands. Command names stay
`gsd-tracker` / `gsd-clickup` (shell commands stay `gsd-*`). A move to its own
repo later is a copy, not a rewrite. That move is not part of this plan.

## The new shape

```
bin/gsd-tracker, bin/gsd-clickup     the commands (unchanged names)
lib/tracker/config.sh                settings: where each value comes from
lib/tracker/ids.sh                   ticket id normalizing (its own copy)
lib/tracker/clickup.sh, custom.sh    the adapters (from lib/trackers/)
lib/ticket.sh                        GSD side: tk-<id> tags in phase titles/slugs
```

Rules, checked by a test:

- `bin/gsd-tracker`, `bin/gsd-clickup` and `lib/tracker/` never source
  `lib/common.sh` or anything else outside `lib/tracker/`, and call no `gsd_*`
  function. Their own functions use the `trk_` prefix.
- GSD scripts never source `lib/tracker/`. They run `gsd-tracker …`.

## Settings

Each value, first match wins:

1. environment: `GSD_TRACKER`, `GSD_TRACKER_PROFILE`, `GSD_TRACKER_STATUS_START`
   / `_FINISH` (legacy `GSD_CLICKUP_*` still read), `GSD_CLICKUP_CONFIG`,
   `CLICKUP_API_TOKEN`
2. the repo's git config, section `gsd-tracker`: `tracker`, `profile`,
   `command`, `statusStart`, `statusFinish`. It lives in `.git/config`: never
   committed, shared by all worktrees of the clone.
3. `.gsd.conf` keys `tracker`, `tracker_profile`, `tracker_command`,
   `tracker_status_start` / `_finish` — read only, with the tracker's own small
   reader. This is the team-shared setting in a GSD repo.
4. default tracker: `none` when a `.gsd.conf` exists, else `clickup`.
   GSD (`gsd_tracker_which`, doctor) counts only a tracker that is set, so this
   default never makes GSD move tickets (found by `tests/test-flow-next.sh`).

Tokens stay where they are: `~/.config/gsd/clickup.env` and
`~/.config/gsd/clickup-<profile>.env`. A profile never falls back to
`clickup.env` (unchanged).

## `gsd-tracker login [<name>]`

- **Inside any git repo** (GSD or not, main checkout or worktree): saves the
  token file, then `git config gsd-tracker.profile <name>`. It no longer edits
  or commits `.gsd.conf`, so the checkout lock, the commit prompt and the
  "main checkout only" rule go away.
- **Outside a git repo** (e.g. `~`): needs `<name>`. Saves the token file only,
  and says: run `gsd-tracker login <name>` inside the repo to use it there.
- **No `<name>`:** the profile in use, else the repo folder's name (as today).
- **The profile's file already exists:** before any token is typed, asks
  `token for <name> is saved — [U]se it / [r]eplace it?`
  - Use: tests the saved token (`GET /user`). If ClickUp refuses it, says so and
    asks for a new one.
  - Replace: asks for the token, as today.
  - No terminal (token piped on stdin): replaces, as today.
- A `tracker_profile` in `.gsd.conf` is still read, but git config wins. When
  they differ, `login` prints one line saying so.

## New: `gsd-tracker config`

Prints the resolved settings, offline, one `key=value` per line, each with its
source (`env`, `git`, `gsd.conf`, `default`):
`tracker`, `profile`, `token_file`, `token` (`env` / `file` / `missing`, never
the token itself), `command`, `status_start`, `status_finish`.
`gsd-doctor` reads this for T018, T071 and T073, so it no longer needs the
tracker's code. Doctor stays offline and read-only.

## GSD side

- `lib/ticket.sh` (new, from `lib/tracker.sh`): `gsd_ticket_extract`,
  `gsd_ticket_tagged`, and GSD's own `gsd_ticket_norm` (used to build the
  `tk-<id>` tag). A test runs both normalizers over the same inputs so the two
  copies cannot drift.
- `gsd-start`, `gsd-finish`, `gsd-flow-next`: `gsd-tracker --repo <main> which`
  instead of `gsd_tracker`. Calls to `start` / `finish` / `snapshot` stay as
  they are.
- `gsd-doctor`: `gsd-tracker --repo <main> config` (see above).
- `gsd-init`, `gsd-bootstrap-repo`: unchanged. They still write `tracker =` to
  `.gsd.conf`, because that one is shared with the team.

## What stays the same

Command names, verbs, options, exit codes (0 ok, 1 config, 2 tracker call
failed), token files, env vars, `.gsd.conf` keys, legacy `cu_<id>` tags, and
"a tracker failure never blocks start/finish".

## What users will notice

- `login` works everywhere, including worktrees and plain repos.
- `login` no longer changes or commits `.gsd.conf`. Each clone runs `login` once
  (the token file has to be on each machine anyway).
- A saved profile is offered for reuse instead of being silently replaced.

## Steps

1. Move `lib/trackers/*` → `lib/tracker/`. Add `config.sh` and `ids.sh`. Rename
   functions to `trk_*`. Copy the main-checkout finder and the Python finder.
2. Settings order above, plus `gsd-tracker config`.
3. `login` changes.
4. `lib/ticket.sh`. GSD scripts switch to `which` / `config`.
5. Tests in `tests/test-tracker.sh`:
   - standalone: copy only `bin/gsd-tracker`, `bin/gsd-clickup` and
     `lib/tracker/` to a temp dir and run them (fake ClickUp via the curl stub)
   - lint: no `gsd_` calls and no `common.sh` source in tracker files
   - settings order (env > git > `.gsd.conf` > default)
   - login: plain repo, worktree, outside a repo, existing profile (use / replace /
     refused token / piped)
   - `config` output, and the two normalizers agreeing
   - Update `test-doctor.sh` for T018/T071/T073. Run `test-e2e.sh`.
6. Docs: `docs/trackers.md`, `skills/gsdw-tracker/SKILL.md`, `CLAUDE.md`
   (architecture list), `docs/architecture.md`, README, CHANGELOG.

## Not in this plan

- Its own repo or release.
- New trackers.
- Moving existing `tracker_profile` lines out of `.gsd.conf` (they keep working).
