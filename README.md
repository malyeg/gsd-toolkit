# gsd-toolkit

[![tests](https://github.com/malyeg/gsd-toolkit/actions/workflows/tests.yml/badge.svg)](https://github.com/malyeg/gsd-toolkit/actions/workflows/tests.yml)
[![release](https://img.shields.io/github/v/release/malyeg/gsd-toolkit)](https://github.com/malyeg/gsd-toolkit/releases)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Run GSD phases in parallel, each in its own git worktree, with any coding agent.**

gsd-toolkit is a set of shell commands built around
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

- **One phase, one worktree.** `gsd-start` claims a phase, pushes the claim,
  creates a `phase-<N>-<slug>` worktree and opens an agent session in it.
  `gsd-finish` tests, merges it back, pushes and cleans up.
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
- **The whole phase, in order.** `gsd-flow-next` reads the phase folder and
  says which step is next: discuss, plan, cross-AI review, execute, verify,
  UI checks, and finish. It can resume at any point.
- **UI quality gates.** For phases with screens: a design file, a layout
  contract, a real-browser check at three widths, a visual review and your
  sign-off, before the phase can land.
- **Cheaper small tasks.** `gsd-batch` runs a list of quick tasks in one
  batch worktree, and `gsd-batch-report` shows what it cost.
- **Ticket sync.** Phases link to ClickUp tickets (or any tracker, through a
  script) and move them along as work starts and lands.
- **A health check.** `gsd-doctor` finds setup problems and names the
  command that fixes each one. It also shows what GSD adds to your context,
  and what you could hide.

See [docs/features.md](docs/features.md) for the full list.

## Quick start

```sh
# 1. Install (also installs gsd-core for your agent if it is missing)
curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh | bash

# 2. Set up a repo and make its plan
cd ~/projects/my-app
gsd-init

# 3. Work on a phase
gsd-start -p 1          # an existing phase; or: gsd-start -n "description" for new work
# ... the agent session runs the phase flow in the worktree ...
gsd-finish              # test, merge, push, remove the worktree

# Any time
gsd-list                # what is in flight
gsd-doctor              # what is wrong, and how to fix it
```

Every command has `--help`. The full order of a phase, and which steps run
in the worktree vs the main checkout, is in
[docs/command-order.html](docs/command-order.html) (open it in a browser).

## Requirements

- macOS or Linux (on Windows, use [WSL2](#windows-wsl2))
- Bash, Git, Perl, curl, Python 3.7+
- Node.js (`npx`), to install gsd-core
- At least one agent CLI: [Claude Code](https://claude.com/claude-code) or
  [Codex](https://github.com/openai/codex)
- Optional: `jq` (native hooks, ClickUp), `gh` (`gsd-finish --pr`),
  [Playwright](https://playwright.dev) (`gsd-ui check`, for phases with screens)

## Commands

**Daily use**

| Command | What it does |
|---|---|
| `gsd-init` | Sets up a repo from zero, then opens the session that writes the plan (`/gsd-new-project`, or `/gsd-ingest-docs` when docs exist). |
| `gsd-start` | Claims a phase and opens a session in its worktree. `-n "desc"` for a new phase, `-p <N>` for an existing one, `--insert <N>` for a hotfix, `--ticket <id>` to link a ticket, `--provider <name>` to pick the agent. |
| `gsd-list` | Shows every phase: number, plans done, stage, worktree. Read-only. |
| `gsd-finish` | Tests, merges into the base branch, pushes, then removes the worktree and branch. `--pr` opens a GitHub PR instead. |
| `gsd-doctor` | Checks the repo's setup and names the fix for each finding. `--json` for CI; `--fix` runs the safe fixes after asking. |
| `gsd-update` | Installs the latest release (checksum-verified) and the latest gsd-core. `--check` only compares. |

**Occasional use**

| Command | What it does |
|---|---|
| `gsd-batch` | Runs several quick tasks as one batch, in its own `batch-*` worktree and a fresh session. Scouts files first, sends tiny items to `gsd-fast`, and reports the cost. Land it with `gsd-finish batch-…`. Use it instead of `/gsd-quick-batch`. |
| `gsd-batch-report` | Tokens a batch used, per role and per item (read-only, from Claude Code's transcripts). |
| `gsd-ui` | UI quality steps for phases with screens: design, layout, browser check, review, approval. |
| `gsd-tracker` | Reads and updates tickets ([docs/trackers.md](docs/trackers.md)). Works in any repo, GSD or not. |
| `gsd-planning-repair` | Fixes `ROADMAP.md` / `STATE.md` after a bad merge. `--check` for CI. |
| `gsd-bootstrap-repo` | Writes the repo files (config, shims, instruction blocks). Called by `gsd-init`; safe to re-run. |
| `gsd-rules` | Prints the workflow rules of the installed release, which agents load at the start of a session. |
| `gsd-codex-wait` | Waits out a Codex usage limit, then runs the command again. |

**Called by other commands:** `gsd-wt-new`, `gsd-wt-finish`,
`gsd-worktree-guard`, `gsd-flow-next`, `gsd-planning-merge` (the git merge
driver) and `gsd-derive-port` (per-worktree dev ports).

### Agent skills

The installer also adds these skills to each agent, so you can ask in plain
words instead of typing commands:

| Skill | Use it to |
|---|---|
| `gsdt-worktrees` | Start, finish, list or set up phases with the commands above. |
| `gsdt-flow` | Run or resume one phase from start to finish, step by step. |
| `gsdt-doctor` | Run `gsd-doctor` and fix what it finds, asking first. |
| `gsdt-tracker` | Read, update, create or search tickets. |
| `gsdt-batch` | Run a batch of small tasks (started with `gsd-batch`). |

## Providers

| Provider | Instructions file | Skills folder | Native hook |
|---|---|---|---|
| Claude Code | `CLAUDE.md` | `~/.claude/skills` | yes (optional) |
| OpenAI Codex | `AGENTS.md` | `~/.agents/skills` | no (the command guard still applies) |
| `custom` | `AGENTS.md` | none | no |

```sh
gsd-init --provider claude
gsd-init --providers claude,codex --provider codex   # install both, start with Codex
```

One phase can move between agents: `gsd-start -p 7 --provider codex` reuses
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
  pointer to `gsd-rules` for the rest. An update changes the rules in every
  repo, with no step there. Plus a short marked block in `CLAUDE.md` /
  `AGENTS.md` that points to both. Text outside the markers is never
  touched.
- **`scripts/gsd-*.sh`**: small, frozen scripts that call the installed
  commands, so `package.json` scripts and hooks work on every checkout.
- **`.gitattributes`** and a `post-merge` hook: the planning merge driver
  and repair.
- **`scripts/gsd-premerge-check.sh`** (optional, yours): extra checks before
  each merge. Without it, `gsd-finish` runs the project's tests.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh | bash
# skills for more than one agent:
curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh | bash -s -- --agent claude --agent codex
```

Prefer to read it first?

```sh
curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh -o install.sh
less install.sh
bash install.sh
```

The installer downloads the latest GitHub release, checks its SHA256,
installs it to `~/.local/share/gsd-toolkit/releases/<version>/` and links
the commands into `~/.local/bin`. It also installs gsd-core for each chosen
agent that has none.

| Option | Effect |
|---|---|
| `--agent <name>` | Install skills for this agent (repeatable). |
| `--all-agents` | Install skills for every supported agent. |
| `--version X.Y.Z` | Install a given release. |
| `--no-core` | Do not install gsd-core. |
| `--no-user-hook` | Leave out the two Claude user-level hooks (below). |

For Claude, the installer adds two user-level hooks. One refuses
`/gsd-new-project` and `/gsd-ingest-docs` in a repo that `gsd-init` has not
set up. The other loads the workflow rules (`gsd-rules`) when a session
starts in a set-up repo.

### Updates

Commands tell you when a newer release is out (at most one GitHub call a
day; `GSD_NO_UPDATE_CHECK=1` turns it off).

```sh
gsd-update --check            # installed vs latest
gsd-update                    # the latest toolkit + gsd-core
gsd-update --version 0.8.3    # a given release; going back works too
```

The previous release stays on disk. See [CHANGELOG.md](CHANGELOG.md) and
[docs/releases.md](docs/releases.md).

> **Coming from `gsd-worktrees`?** That is this project's old name
> (`arconme/gsd-worktrees`). Run `gsd-update` twice, then
> `gsd-init --no-launch` in each project. See
> [Moving from gsd-worktrees](docs/releases.md#moving-from-gsd-worktrees).

### Windows (WSL2)

The toolkit needs a Unix system. Plain Windows, PowerShell and Git Bash are
not supported. Inside WSL2 it is just Linux, which CI tests on every push.

```sh
wsl --install                     # PowerShell (admin), once; then reboot
# in the Ubuntu terminal:
sudo apt update && sudo apt install -y git curl perl python3 jq
curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh | bash
```

Keep projects on the Linux side (`~/projects`, not `/mnt/c/…`), and install
your agents and Node.js inside WSL too.

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
| [copy-install.md](docs/copy-install.md) | What the installer copies, and where |
| [migration.md](docs/migration.md) | Coming from the old `get-shit-done-cc` |

## Development

```sh
git clone git@github.com:malyeg/gsd-toolkit.git && cd gsd-toolkit
tests/test-commands.sh        # each suite is standalone
```

Edits in a checkout never reach your installed commands until a release.
Try them as `./bin/gsd-…` or through the tests. Commands that call other
toolkit commands find them on `PATH`, so put `<checkout>/bin` first on
`PATH` to try those from a checkout.

The `gsdt-batch-sonnet` Claude Code mod (moves the main session to Sonnet
while a batch runs) is not installed yet; try it with
`claude --plugin-dir <checkout>/mods/gsdt-batch-sonnet`.

The test suites, lint commands and release steps are listed in
[CLAUDE.md](CLAUDE.md#commands). CI runs everything on Linux and macOS.

## License

[MIT](LICENSE)
