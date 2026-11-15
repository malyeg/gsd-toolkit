# gsd-toolkit

[![tests](https://github.com/malyeg/gsd-toolkit/actions/workflows/tests.yml/badge.svg)](https://github.com/malyeg/gsd-toolkit/actions/workflows/tests.yml)
[![release](https://img.shields.io/github/v/release/malyeg/gsd-toolkit)](https://github.com/malyeg/gsd-toolkit/releases)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Run GSD phases in parallel, each in its own git worktree, with any coding agent.**

gsd-toolkit is a set of commands (TypeScript, on Node.js) built around
[GSD](https://www.npmjs.com/package/@opengsd/gsd-core) (Get Shit Done), a
planning workflow for AI coding agents. GSD plans and runs phases. The
toolkit lets you run many phases at once without them stepping on each
other, and turns the multi-step chores around each phase into single
commands.

- [Features](#features)
- [Quick start](#quick-start)
- [Requirements](#requirements)
- [Commands](#commands)
- [Providers](#providers)
- [Configuration](#configuration)
- [What it adds to your repo](#what-it-adds-to-your-repo)
- [Install](#install)
- [How it stays safe](#how-it-stays-safe)
- [Documentation](#documentation)
- [Development](#development)

## Features

- **One phase, one worktree.** `gsdt-start` claims a phase, pushes the claim,
  creates a `phase-<N>-<slug>` worktree and opens an agent session in it.
  `gsdt-finish` tests, merges it back, pushes and cleans up.
- **Safe in parallel.** Two sessions claiming at once get different phase
  numbers. A merge conflict aborts cleanly and never leaves the base branch
  broken. Each worktree gets its own dev port.
- **No broken planning files.** A custom merge driver and a repair step keep
  `.planning/ROADMAP.md` and `STATE.md` correct when phases finish in
  parallel ([how](docs/planning-merge.md)).
- **Works with more than one agent.** Claude Code and OpenAI Codex are built
  in, and `custom` covers any other CLI. Agents can hand one phase over to
  each other.
- **A guard that enforces the rules.** It refuses work in the wrong worktree
  or out of phase order, and blocks steps whose required artifacts are
  missing. The commands check it themselves; agent hooks are only an extra
  layer.
- **The whole phase, in order.** `gsdt-flow-next` reads the phase folder and
  says which step is next: discuss, plan, cross-AI review, execute, verify,
  UI checks, and finish. It can resume at any point.
- **UI quality gates.** For phases with screens: a design file, a layout
  contract, a real-browser check at three widths, a visual review and your
  sign-off, before the phase can land.
- **Cheaper small tasks.** `gsdt-batch` runs a list of quick tasks in one
  batch worktree, and `gsdt-batch-report` shows what it cost.
- **Ticket sync.** Phases link to ClickUp tickets (or any tracker, through a
  script) and move them along as work starts and lands.
- **A health check.** `gsdt-doctor` finds setup problems and names the
  command that fixes each one. It also shows what GSD adds to your context,
  and what you could hide.

See [docs/features.md](docs/features.md) for the full list.

## Quick start

```sh
# 1. Install (also installs gsd-core for your agent if it is missing)
npm i -g gsd-toolkit && gsdt-setup

# 2. Set up a repo and make its plan
cd ~/projects/my-app
gsdt-init

# 3. Work on a phase
gsdt-start -p 1          # an existing phase; or: gsdt-start -n "description" for new work
# ... the agent session runs the phase flow in the worktree ...
gsdt-finish              # test, merge, push, remove the worktree

# Any time
gsdt-list                # what is in flight
gsdt-doctor              # what is wrong, and how to fix it
```

> **On 0.10.x (the bash version)?** 1.0.0 comes from npm: `npm i -g gsd-toolkit && gsdt-setup`.
> Your repos need no change. See [Moving from 0.10.x](#moving-from-010x).
>
> **Upgrading from 0.9 or older?** The commands are now `gsdt-*` (`gsd-start`
> → `gsdt-start`, …); `gsd-*` is gsd-core's prefix. Run the old `gsd-update`
> one last time, then in each repo `gsdt-migrate` (shows the changes),
> `gsdt-migrate --apply`, and commit. See [docs/migration.md](docs/migration.md#0100-commands-renamed-to-gsdt-).

Every command has `--help`. The full order of a phase, and which steps run
in the worktree vs the main checkout, is in
[docs/command-order.html](docs/command-order.html) (open it in a browser).

## Requirements

- macOS, Linux or Windows (no WSL needed; see [Windows](#windows))
- Node.js 24 or newer (with `npm` and `npx`; gsd-core needs it too)
- Git. On Windows, [Git for Windows](https://gitforwindows.org): its `sh`
  runs the repo scripts and hooks.
- At least one agent CLI: [Claude Code](https://claude.com/claude-code) or
  [Codex](https://github.com/openai/codex)
- Optional: `gh` (`gsdt-finish --pr`), `jq` (merging the Claude hook into a
  repo's `.claude/settings.json`), `curl` (only with `tracker = clickup`),
  [Playwright](https://playwright.dev) (`gsdt-ui check`, for phases with screens)

Python and Perl are not needed. `jq` and `curl` are optional, as listed.

## Commands

**Daily use**

| Command | What it does |
|---|---|
| `gsdt-init` | Sets up a repo from zero, then opens the session that writes the plan (`/gsd-new-project`, or `/gsd-ingest-docs` when docs exist). |
| `gsdt-start` | Claims a phase and opens a session in its worktree. `-n "desc"` for a new phase, `-p <N>` for an existing one, `--insert <N>` for a hotfix, `--ticket <id>` to link a ticket, `--provider <name>` to pick the agent. |
| `gsdt-list` | Shows every phase: number, plans done, stage, worktree. Read-only. |
| `gsdt-finish` | Tests, merges into the base branch, pushes, then removes the worktree and branch. `--pr` opens a GitHub PR instead. |
| `gsdt-doctor` | Checks the repo's setup and names the fix for each finding. `--json` for CI; `--fix` runs the safe fixes after asking. |
| `gsdt-update` | Installs the latest toolkit from npm and the latest gsd-core. `--check` only compares. |

**Occasional use**

| Command | What it does |
|---|---|
| `gsdt-batch` | Runs several quick tasks as one batch, in its own `batch-*` worktree and a fresh session. Scouts files first, sends tiny items to `gsd-fast`, and reports the cost. Land it with `gsdt-finish batch-…`. Use it instead of `/gsd-quick-batch`. |
| `gsdt-batch-report` | Tokens a batch used, per role and per item (read-only, from Claude Code's transcripts). |
| `gsdt-ui` | UI quality steps for phases with screens: design, layout, browser check, review, approval. |
| `gsdt-tracker` | Reads and updates tickets ([docs/trackers.md](docs/trackers.md)). Works in any repo, GSD or not. |
| `gsdt-planning-repair` | Fixes `ROADMAP.md` / `STATE.md` after a bad merge. `--check` for CI. |
| `gsdt-bootstrap-repo` | Writes the repo files (config, shims, instruction blocks). Called by `gsdt-init`; safe to re-run. |
| `gsdt-rules` | Prints the workflow rules of the installed release, which agents load at the start of a session. |
| `gsdt-codex-wait` | Waits out a Codex usage limit, then runs the command again. |
| `gsdt-setup` | Machine setup after `npm i -g`: skills and the Claude user hooks for each agent, and gsd-core where it is missing. Safe to re-run. |
| `gsdt-migrate` | Moves a repo set up before 0.10.0 to the `gsdt-*` names. Dry run by default; `--apply` changes (and offers to commit), `--check` for CI. |

**Called by other commands:** `gsdt-wt-new`, `gsdt-wt-finish`,
`gsdt-worktree-guard`, `gsdt-flow-next`, `gsdt-planning-merge` (the git merge
driver) and `gsdt-derive-port` (per-worktree dev ports).

### Agent skills

`gsdt-setup` also adds these skills to each agent, so you can ask in plain
words instead of typing commands:

| Skill | Use it to |
|---|---|
| `gsdt-worktrees` | Start, finish, list or set up phases with the commands above. |
| `gsdt-flow` | Run or resume one phase from start to finish, step by step. |
| `gsdt-doctor` | Run `gsdt-doctor` and fix what it finds, asking first. |
| `gsdt-tracker` | Read, update, create or search tickets. |
| `gsdt-batch` | Run a batch of small tasks (started with `gsdt-batch`). |

## Providers

| Provider | Instructions file | Skills folder | Native hook |
|---|---|---|---|
| Claude Code | `CLAUDE.md` | `~/.claude/skills` | yes (optional) |
| OpenAI Codex | `AGENTS.md` | `~/.agents/skills` | no (the command guard still applies) |
| `custom` | `AGENTS.md` | none | no |

```sh
gsdt-init --provider claude
gsdt-init --providers claude,codex --provider codex   # install both, start with Codex
```

One phase can move between agents: `gsdt-start -p 7 --provider codex` reuses
the phase's worktree and work. Take turns, though: only one agent may write
in a worktree at a time. Run agents in parallel on *different* phases.

Details: [docs/providers.md](docs/providers.md).

## Configuration

Each repo has a committed `.gsd.conf`. Every key is optional and falls back
to auto-detection.

```ini
providers = claude,codex      # installed agents; the first is the default
review_provider = codex       # who does the cross-AI plan review
flow = strict                 # enforce the phase step order
tracker = clickup             # none (default), clickup or custom
compact_at = 300000           # compact agent sessions at this many tokens (default)
```

Base branch, worktree folder, install and test commands, models, UI gates
and more are listed in the
[configuration reference](docs/providers.md#configuration-reference).

## What it adds to your repo

All logic lives in the installed toolkit. A repo carries only:

- **`.gsd.conf`**: the settings above.
- **`.gsd/INSTRUCTIONS.md`**: the repo's settings, a few core rules, and a
  pointer to `gsdt-rules` for the rest. An update changes the rules in every
  repo, with no step there. Plus a short marked block in `CLAUDE.md` /
  `AGENTS.md` that points to both. Text outside the markers is never
  touched.
- **`scripts/gsdt-*.sh`**: small, frozen scripts that call the installed
  commands, so `package.json` scripts and hooks work on every checkout.
  Git for Windows' `sh` runs them on Windows.
- **`.gitattributes`** and a `post-merge` hook: the planning merge driver
  and repair.
- **`scripts/gsdt-premerge-check.sh`** (optional, yours): extra checks before
  each merge. Without it, `gsdt-finish` runs the project's tests. It needs
  the exec bit on macOS/Linux; on Windows it runs through `sh` and needs none.

## Install

```sh
npm i -g gsd-toolkit
gsdt-setup                                  # skills + Claude user hooks, gsd-core if missing
gsdt-setup --agent claude --agent codex     # skills for more than one agent
```

npm puts the `gsdt-*` commands on your `PATH` (and makes the Windows
wrappers). `gsdt-setup` does the machine-level part, and is safe to re-run.
There is no npm `postinstall` script: nothing runs until you run it.

| `gsdt-setup` option | Effect |
|---|---|
| `--agent <name>` | Set up this agent (repeatable). Default: the agents recorded by the last run, else `claude`. |
| `--all-agents` | Set up every supported agent. |
| `--no-core` | Do not install gsd-core. |
| `--no-user-hook` | Leave out the two Claude user-level hooks (below), and remove ours. |

For Claude, `gsdt-setup` adds two user-level hooks. One refuses
`/gsd-new-project` and `/gsd-ingest-docs` in a repo that `gsdt-init` has not
set up. The other loads the workflow rules (`gsdt-rules`) when a session
starts in a set-up repo.

### Updates

Commands tell you when a newer version is out (at most one registry call a
day; `GSD_NO_UPDATE_CHECK=1` turns it off).

```sh
gsdt-update --check            # installed vs latest
gsdt-update                    # the latest toolkit + gsd-core
gsdt-update --version 1.0.0    # a given version; going back works too
```

`gsdt-update` runs `npm install -g gsd-toolkit@<version>` and then the new
version's `gsdt-setup`, so skills and hooks always match. See
[CHANGELOG.md](CHANGELOG.md) and [docs/releases.md](docs/releases.md).

### Moving from 0.10.x

0.10.x was installed with `install.sh` into `~/.local/bin`. From 1.0.0 the
toolkit is an npm package. On the machine:

```sh
npm i -g gsd-toolkit && gsdt-setup
```

`gsdt-setup` removes the old `~/.local/bin/gsdt-*` links and
`~/.local/share/gsd-toolkit` (only what the old install made), rewrites the
user hooks to the npm path, and re-installs the skills. Repos need no change
when `gsdt-doctor` shows no T090. If it does, run `gsdt-migrate --apply`
first, best on 0.10.x. Details: [docs/migration.md](docs/migration.md#100-npm-package-nodejs-24-windows).

> **Coming from `gsd-worktrees`** (before 0.8.0)? 1.0.0 does not move that
> install. Go through 0.10.x first, as in
> [Moving from gsd-worktrees](docs/releases.md#moving-from-gsd-worktrees).

### Windows

Windows is supported without WSL. You need Node.js 24+ and
[Git for Windows](https://gitforwindows.org). Run the commands in
PowerShell, cmd or Git Bash.

```sh
git config --global core.longpaths true   # recommended: worktree paths get long
npm i -g gsd-toolkit
gsdt-setup
```

- Git for Windows' `sh` runs everything shell-shaped in a repo: the
  `scripts/gsdt-*.sh` shims, the post-merge hook, the planning merge driver
  and Claude Code's hooks.
- The pre-merge script (`scripts/gsdt-premerge-check.sh`) runs through
  `sh` and needs no exec bit.
- Git stops at paths longer than 260 characters unless `core.longpaths` is on.

## How it stays safe

- **One phase = one worktree = one branch.** The main checkout stays on the
  base branch.
- **Claims go through the base branch.** Pull, push, rebase and retry; if
  two sessions race, the loser takes the next number.
- **A local lock** (`.git/gsd-cmd.lock`) stops two commands from changing
  the same checkout at once. Locks left by crashed runs are reclaimed.
- **Finishing fails clean.** Tests run before the merge and again on the
  merged result. A conflict or failed check never reaches the remote base
  branch.
- **Planning files merge correctly.** See
  [docs/planning-merge.md](docs/planning-merge.md).

Architecture: [docs/architecture.md](docs/architecture.md).

## Documentation

| Doc | About |
|---|---|
| [features.md](docs/features.md) | Every feature and where it lives |
| [providers.md](docs/providers.md) | Agents, precedence rules, full `.gsd.conf` reference |
| [architecture.md](docs/architecture.md) | Core vs adapters, the guard, adding a provider |
| [command-order.html](docs/command-order.html) | The phase flow, step by step |
| [trackers.md](docs/trackers.md) | Tickets: ClickUp, custom trackers |
| [planning-merge.md](docs/planning-merge.md) | How `.planning/` files merge |
| [releases.md](docs/releases.md) | Releases, updates, moving from gsd-worktrees |
| [migration.md](docs/migration.md) | Moving to 1.0.0, 0.10.0 and 0.5.0 |
| [copy-install.md](docs/copy-install.md) | Retired: the 0.10.x installer |

## Development

```sh
git clone git@github.com:malyeg/gsd-toolkit.git && cd gsd-toolkit
npm ci                        # TypeScript and the Node types (dev only)
npx tsc --noEmit              # type check
tests/test-commands.sh        # each suite is standalone
```

The commands are TypeScript. A checkout runs `src/*.ts` directly (Node 24
strips the types); `node tools/build.mjs` compiles to `dist/`, which is
what npm ships. The scripts in `bin/` are bash launchers for running from a
checkout: put `<checkout>/bin` first on `PATH` to try your edits. Edits
never reach an installed copy until a release. Commands that call other
toolkit commands find them on `PATH`.

The `gsdt-batch-sonnet` Claude Code mod (moves the main session to Sonnet
while a batch runs) is not installed yet; try it with
`claude --plugin-dir <checkout>/mods/gsdt-batch-sonnet`.

The test suites, lint commands and release steps are listed in
[CLAUDE.md](CLAUDE.md#commands). CI runs the bash suites on Linux and macOS,
and a cross-platform suite (`node --test tests/os/os.test.ts`, the real npm
package) on Linux, macOS and Windows.

## License

[MIT](LICENSE)
