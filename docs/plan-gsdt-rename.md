# Plan: rename the toolkit's commands to `gsdt-*`

Status: built 2026-11-10 on feat/gsdt-rename (ships as 0.10.0: 0.9.0 went out first with the rules split). `gsd-rules` was added after this plan and is renamed too.

## Why

Skills are `gsdt-*`, but commands are `gsd-*` — the same start as every
gsd-core skill. A user can't tell from a name who made it.

- Exact clash: gsd-core's skill `/gsd-update` and our command `gsd-update`.
- Near clashes: `gsd-ui` next to `/gsd-ui-phase`, `/gsd-ui-review`;
  `gsd-batch` next to `/gsd-quick-batch`.
- gsd-core can add any `gsd-*` name later.

New rule: **`gsd-*` = gsd-core. `gsdt-*` = this toolkit.** No exceptions.

## Decisions (made)

- Rename **every** command in `bin/`, the user-facing and the internal ones.
- **No aliases.** Old names stop working the moment the new release installs.
- A new command, **`gsdt-migrate`**, switches a repo (and the user's settings)
  to the new names.
- Breaking change → release **0.9.0**.

## Rename map

### Commands (`bin/`)

| old | new |
|---|---|
| `gsd-init` | `gsdt-init` |
| `gsd-start` | `gsdt-start` |
| `gsd-list` | `gsdt-list` |
| `gsd-finish` | `gsdt-finish` |
| `gsd-doctor` | `gsdt-doctor` |
| `gsd-update` | `gsdt-update` |
| `gsd-bootstrap-repo` | `gsdt-bootstrap-repo` |
| `gsd-planning-repair` | `gsdt-planning-repair` |
| `gsd-tracker` | `gsdt-tracker` |
| `gsd-ui` | `gsdt-ui` |
| `gsd-codex-wait` | `gsdt-codex-wait` |
| `gsd-batch` | `gsdt-batch` (unreleased — rename only, nothing to migrate) |
| `gsd-batch-report` | `gsdt-batch-report` (unreleased — same) |
| `gsd-wt-new` | `gsdt-wt-new` |
| `gsd-wt-finish` | `gsdt-wt-finish` |
| `gsd-worktree-guard` | `gsdt-worktree-guard` |
| `gsd-flow-next` | `gsdt-flow-next` |
| `gsd-planning-merge` | `gsdt-planning-merge` |
| `gsd-derive-port` | `gsdt-derive-port` |

Skill and command now share a name in three cases (`gsdt-doctor`,
`gsdt-tracker`, `gsdt-batch`). That is fine: `/gsdt-doctor` is the skill,
`gsdt-doctor` in a shell is the command, and the skill runs the command.

### Files in target repos

| old | new | who writes it |
|---|---|---|
| `scripts/gsd-new-worktree-feature.sh` | `scripts/gsdt-new-worktree-feature.sh` | bootstrap (shim) |
| `scripts/gsd-finish-worktree-feature.sh` | `scripts/gsdt-finish-worktree-feature.sh` | bootstrap (shim) |
| `scripts/gsd-derive-port.sh` | `scripts/gsdt-derive-port.sh` | bootstrap (shim) |
| `scripts/gsd-planning-repair.sh` | `scripts/gsdt-planning-repair.sh` | bootstrap (shim) |
| `scripts/hooks/gsd-worktree-guard.sh` | `scripts/hooks/gsdt-worktree-guard.sh` | bootstrap (shim) |
| `scripts/gsd-premerge-check.sh` | `scripts/gsdt-premerge-check.sh` | **the user** (finish looks it up) |

### Settings

| where | old | new |
|---|---|---|
| `.git/config` | `merge.gsd-planning.driver = gsd-planning-merge %O %A %B %P` | same key, command `gsdt-planning-merge …` |
| `.git/config` | `[gsd-tracker] profile = …` (and every other key) | `[gsdt-tracker]` (`git config --rename-section`) |
| repo `.claude/settings.json` | hook `$CLAUDE_PROJECT_DIR/scripts/hooks/gsd-worktree-guard.sh` | `…/gsdt-worktree-guard.sh` |
| `~/.claude/settings.json` | `[ ! -x '…/gsd-worktree-guard' ] \|\| exec … --global` | `…/gsdt-worktree-guard …` |
| `.gsd/INSTRUCTIONS.md`, `CLAUDE.md`, `AGENTS.md` | marked blocks name `gsd-*` commands | regenerated with `gsdt-*` |

### Not renamed (on purpose)

- **Merge driver key `gsd-planning`** (in `.gitattributes` and `.git/config`).
  It is a git setting, not something anyone types. Renaming it breaks merges
  in open phase worktrees: their branch still has the old `.gitattributes`,
  so git would find no driver and fall back to a plain text merge of
  ROADMAP/STATE. Only its command changes.
- **Config and data names:** `.gsd.conf`, `.gsd/`, `GSD_*` env vars,
  `~/.config/gsd/`, `.git/gsd-cmd.lock`, `gsd_*` shell functions,
  `lib/gsd_*.py`. Not commands; gsd-core uses none of them. Can be a later,
  separate plan if wanted.
- **Package name** `gsd-toolkit`, runtime dir `share/gsd-toolkit/`, repo
  `malyeg/gsd-toolkit`.
- **Marker text** `gsd-toolkit:<kind>:start/end` (already says "toolkit").
- **The guard's internal name** `gsd-flow` for the flow skill
  (`lib/gsd_hook_payload.py`) — never shown to users.
- **History:** past CHANGELOG entries, `docs/archive/`, and finished plans
  (`plan-rename-toolkit.md`, `plan-gsd-core.md`, `plan-tracker-split.md`,
  `fix-plan.md`, `provider-audit.md`) stay as written.

## Trap: blind search-and-replace is wrong

Some old names are also gsd-core names, or the start of one:

- `gsd-update` — also the gsd-core skill `/gsd-update`.
- `gsd-ui` — start of `gsd-ui-phase`, `gsd-ui-review`.
- `gsd-planning` (driver key) — start of `gsd-planning-merge` / `-repair`.
- `gsd-tracker` — also `gsd-tracker.` git config keys (these DO move).

So the rename inside this repo is done by a small one-off script (in the
scratchpad, not committed) with the exact list, matching a whole name only
(not followed by `[A-Za-z0-9-]`). Then every hit of `gsd-update` and
`gsd-ui` is checked by hand: a slash form (`/gsd-update`) stays.

For the same reason, **`gsdt-migrate` never rewrites free text** (plans,
READMEs, `.planning/`). It only changes exact paths, structured settings and
our own marked blocks.

## `gsdt-migrate`

```
gsdt-migrate            # dry run: list every change, change nothing (exit 1 if any)
gsdt-migrate --apply    # make the changes
gsdt-migrate --check    # quiet; exit 1 if anything is old (for doctor / CI)
```

Run in a repo's main checkout. Safe to run twice. Never commits, pushes or
checks out. Takes the checkout lock (`.git/gsd-cmd.lock`).

### What it changes

Each step is reported in the dry run as `file: old → new`.

1. **Shims.** Write the 5 new shims (same code as bootstrap), delete the old
   ones. Only when the old file is our shim (its first comment line says
   `gsd-worktrees shim` or `gsd-toolkit shim`); a file the user edited is
   reported and left alone.
2. **The user's pre-merge script.** `git mv scripts/gsd-premerge-check.sh
   scripts/gsdt-premerge-check.sh` (plain `mv` if untracked). Refuses if both
   exist.
3. **References to those 6 paths** in other tracked files (`git ls-files`):
   `package.json`, `.github/workflows/*`, `Makefile`, `.husky/*`, etc.
   Exact path match only (`scripts/gsd-derive-port.sh` →
   `scripts/gsdt-derive-port.sh`). Skips `.planning/`. Each line is shown.
4. **Repo hook** in `.claude/settings.json`: replace the old command, never
   add a second one (same JSON edit as bootstrap).
5. **Marked blocks** in `.gsd/INSTRUCTIONS.md` and each provider's
   instruction file: regenerate (bootstrap's own code; text outside the
   markers is never touched).
6. **`.git/config`:** merge driver command; `git config --rename-section
   gsd-tracker gsdt-tracker`. Shared by all worktrees of this clone.
7. **User settings:** the `--global` guard hook in `~/.claude/settings.json`,
   if an old one is there. (install already does this; repeated here for
   safety. If there is no hook — `--no-user-hook` — none is added.)

### What it only reports

- **Open phase worktrees.** Their branches still hold the old files until
  they take the migration commit. It lists them and says: commit the
  migration on main first, then merge main into each one (or finish them
  before migrating).
- **Old names in free text** (`.planning/`, docs): a short list with line
  numbers, as a note. Not changed.
- **Each teammate's clone** needs its own run for steps 6–7 (the repo files
  come with the commit). The commit message it prints says so.

### At the end it prints

```
✔ migrated to gsdt-* (N changes)
next:  git add -A && git commit -m "Switch to gsdt-* toolkit commands"
       then in each teammate's clone: gsdt-migrate --apply
```

## Making sure nobody misses it

- **Install (`lib/install.sh`)** — already removes our old links from
  `~/.local/bin` (line ~227: a link we own that this version doesn't ship).
  Change: `ours()` in `user_hook` must match `gsd-worktree-guard` too, so the
  user hook is replaced, not doubled. At the end print once:
  `commands are now gsdt-* — run gsdt-migrate in each repo`.
- **The upgrade itself:** the user types the OLD `gsd-update`. It runs the old
  `install.sh`, which downloads 0.9.0 and runs 0.9.0's `lib/install.sh`. So
  the first upgrade works with no new steps. A test covers this hop.
- **Refuse in an unmigrated repo:** `gsdt-start`, `gsdt-finish`,
  `gsdt-flow-next` and `gsdt-init` stop with
  `this repo uses the old gsd-* names — run: gsdt-migrate --apply`
  (exit 1). One shared check, `gsd_migrate_needed` in `lib/common.sh`
  (fast: file tests + two `git config` reads). `GSD_SKIP_GUARD` does not skip it.
- **Doctor:** new finding **T090** "old gsd-* names in this repo", fix =
  `gsdt-migrate --apply`. Added to `--fix`'s safe list (mechanical, undoable
  with git, never commits). T008 (`lib/gsd_hook_paths.py`): `GSD_WORD`
  becomes `^gsdt?-`, and an old `gsd-worktree-guard` hook counts as ours,
  fix = `gsdt-migrate`.
- **Silent breaks we accept until migrated** (all fail open, by design):
  old `scripts/gsd-derive-port.sh` prints the bare base port; old repo hook
  shim exits 0. The mandatory guard runs inside `gsdt-start` /
  `gsdt-flow-next`, which refuse anyway.
- **Teammate on an old toolkit, repo already migrated:** new shims can't find
  `gsdt-*` → the worktree shims print "install the toolkit", the rest fail
  open. Worse: an old `gsd-init` would write the old blocks back. The
  CHANGELOG and the migration commit message say: everyone updates first.

## Work, in order

1. **Rename in this repo.** `git mv` each `bin/` file and shim; run the
   one-off rename script over code, tests, skills, live docs and
   `CLAUDE.md`; hand-check `gsd-update` / `gsd-ui` hits. Update `lib/install.sh`
   `ours()`, `bin/gsd-bootstrap-repo`'s shim list and hook check,
   `lib/provider.sh` hook command + blocks, `lib/common.sh` merge driver
   command, `lib/tracker/config.sh` git section (`gsdt-tracker.`), the
   pre-merge script name in `gsd-wt-finish`, `GSD_WORD` in
   `lib/gsd_hook_paths.py`. Shim text: drop the stale
   `arconme/gsd-worktrees` line, say `gsd-toolkit shim`.
2. **`gsd_migrate_needed`** + the refusals + doctor T090 / T008.
3. **`bin/gsdt-migrate`.** Reuses bootstrap's shim, hook and block code — no
   second copy of the block text.
4. **Tests.**
   - All suites: mechanical rename (same script).
   - New `tests/test-migrate.sh`: a repo set up by the 0.8.2 layout
     (old shims, old hook, old driver, `gsd-tracker.profile`, a
     user-written `scripts/gsd-premerge-check.sh`, `package.json` calling
     `scripts/gsd-derive-port.sh`, an edited shim, an open phase worktree,
     free text in `.planning/`) → dry run lists all and changes nothing →
     `--apply` → `--check` clean → second `--apply` changes nothing →
     `gsdt-start` refuses before, works after → text outside markers and
     `.planning/` untouched → merge of a planning file in the open worktree
     still uses the driver.
   - `tests/test-update.sh`: upgrade from 0.8.2 → old links gone, user hook
     replaced (one entry, new path), notice printed.
   - `tests/test-tracker.sh`: standalone check under the new name; git key
     `gsdt-tracker.profile`.
   - Lint: no file in `bin/` may be named `gsd-*`; no shim or block may name
     an old command (a grep in `tests/test-commands.sh`).
   - Add `test-migrate.sh` to `.github/workflows/tests.yml` and the suite
     list in `CLAUDE.md`.
   - Run `tests/test-e2e.sh` with `GSD_TEST_REQUIRE_GSD=1`.
5. **Docs.** README, `docs/features.md`, `providers.md`, `architecture.md`,
   `migration.md` (new section: 0.8 → 0.9), `copy-install.md`,
   `command-order.html`, `trackers.md`, `releases.md`, `planning-merge.md`,
   the design docs `CLAUDE.md` links to (`ui-quality-plan.md`,
   `plan-ui-check.md`, `plan-context-doctor.md`, `plan-gsdt-batch.md`),
   all `skills/*/SKILL.md`.
   `CLAUDE.md` invariants change:
   - "Keep shims unchanged" → frozen again from 0.9.0; the 0.9.0 rename is
     the one change, done by `gsdt-migrate`.
   - New: "Never name a command `gsd-*` — that prefix is gsd-core's."
   - Memory note "shell commands stay gsd-*" is replaced.
6. **Release 0.9.0.** CHANGELOG `## 0.9.0` starts with the upgrade steps:
   1) `gsd-update` (the old name, one last time),
   2) in each repo: `gsdt-migrate`, then `--apply`, then commit,
   3) teammates: update, then `gsdt-migrate --apply` in their clone.

## Size

About 80 files touched; most are the mechanical rename. New code:
`bin/gsdt-migrate` (~200 lines), `gsd_migrate_needed` + refusals (~40),
doctor T090 (~30), `tests/test-migrate.sh` (~250).
