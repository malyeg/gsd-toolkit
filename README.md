# gsd-toolkit

[![tests](https://github.com/malyeg/gsd-toolkit/actions/workflows/tests.yml/badge.svg)](https://github.com/malyeg/gsd-toolkit/actions/workflows/tests.yml)
[![release](https://img.shields.io/github/v/release/malyeg/gsd-toolkit)](https://github.com/malyeg/gsd-toolkit/releases)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Run GSD phases in parallel, each in its own git worktree, with any coding agent.**

gsd-toolkit is a set of shell commands built around [GSD](https://www.npmjs.com/package/@opengsd/gsd-core)
(Get Shit Done), a planning workflow for AI coding agents. GSD plans and runs
phases. The toolkit lets you run many phases at once without them stepping
on each other, and turns the multi-step chores around each phase into
single commands.

> **Formerly `gsd-worktrees`** (`arconme/gsd-worktrees`). Already installed?
> Run `gsd-update` twice, then `gsd-init --no-launch` in each project. See
> [Moving from gsd-worktrees](docs/releases.md#moving-from-gsd-worktrees).

## Features

- **One phase, one worktree.** `gsd-start` claims a phase, pushes the claim,
  creates a `phase-<N>-<slug>` worktree and opens an agent session in it.
  `gsd-finish` merges it back, pushes and cleans up.
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
  missing. It is checked by the commands themselves, not only by optional
  agent hooks.
- **The whole phase, in order.** `gsd-flow-next` reads the phase folder and
  says which step is next: discuss, plan, cross-AI review, execute, verify,
  UI checks, and finish. It can resume at any point.
- **Ticket sync.** Phases link to ClickUp tickets (or any tracker, through
  a script) and move them along as work starts and lands.
- **A health check.** `gsd-doctor` finds setup problems and names the
  command that fixes each one. It also shows what GSD adds to your context,
  and what you could hide. The `gsdt-doctor` skill fixes it all with you,
  asking first.

See [docs/features.md](docs/features.md) for the full list.

## Quick start

```sh
# 1. Install (also installs gsd-core for your agent if it is missing)
curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh | bash

# 2. Set up a repo and make its plan
cd ~/projects/my-app
gsd-init

# 3. Work on a phase
gsd-start -p 1          # or: gsd-start -n "short description" for new work
# ... the agent session runs the phase flow in the worktree ...
gsd-finish              # merge, push, remove the worktree

# Anytime
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
- Optional: `jq` (native hooks, ClickUp), `gh` (`gsd-finish --pr`)

## Commands

**Daily use**

| Command | What it does |
|---|---|
| `gsd-init` | Sets up a repo from zero, then opens the session that writes the plan (`/gsd-new-project`, or `/gsd-ingest-docs` when docs exist). |
| `gsd-start` | Claims a phase and opens a session in its worktree. `-n "desc"` for a new phase, `-p <N>` for an existing one, `--insert <N>` for a hotfix, `--ticket <id>` to link a ticket. |
| `gsd-list` | Shows every phase: number, plans done, stage, worktree. Read-only. |
| `gsd-finish` | Tests, merges into the base branch, pushes, then removes the worktree and branch. `--pr` opens a GitHub PR instead. |
| `gsd-doctor` | Checks the repo's setup and names the fix for each finding, and what GSD adds to your context. `--json` for CI, `--fix` runs the safe fixes after asking. In a session, the `gsdt-doctor` skill fixes the rest with you. |
| `gsd-update` | Installs the latest release (checksum-verified) and the latest gsd-core. `--check` only compares. |

**Occasional use**

| Command | What it does |
|---|---|
| `gsd-bootstrap-repo` | Writes the repo files (config, shims, instruction blocks). Called by `gsd-init`; safe to re-run. |
| `gsd-planning-repair` | Fixes `ROADMAP.md` / `STATE.md` after a bad merge. `--check` for CI. |
| `gsd-tracker` | Reads and updates tickets ([docs/trackers.md](docs/trackers.md)). |
| `gsd-ui` | UI quality steps for phases with screens: design, layout, browser check, review, approval. |
| `gsd-codex-wait` | Waits out a Codex usage limit, then runs the command again. |

**Called by other commands:** `gsd-wt-new`, `gsd-wt-finish`,
`gsd-worktree-guard`, `gsd-flow-next`, `gsd-planning-merge` (the git merge
driver) and `gsd-derive-port` (per-worktree dev ports).

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

Each repo has a committed `.gsd.conf`. Every key is optional and falls back to
auto-detection.

```ini
providers = claude,codex      # installed agents; the first is the default
review_provider = codex       # who does the cross-AI plan review
flow = strict                 # enforce the phase step order
tracker = clickup             # none (default), clickup or custom
compact_at = 300000           # compact agent sessions at this many tokens
```

Base branch, worktree folder, install and test commands, models, UI gates
and more are listed in the
[configuration reference](docs/providers.md#configuration-reference).

## What it adds to your repo

All logic lives in the installed toolkit. A repo carries only:

- **`.gsd.conf`**: the settings above.
- **`.gsd/INSTRUCTIONS.md`**: the workflow rules for agents, plus a short
  marked block in `CLAUDE.md` / `AGENTS.md` that points to it. Text outside
  the markers is never touched.
- **`scripts/gsd-*.sh`**: frozen one-line delegators to the installed
  commands, so `package.json` scripts and hooks work on every checkout.
- **`.gitattributes`** + a `post-merge` hook: the planning merge driver and
  repair.
- **`scripts/gsd-premerge-check.sh`** (optional, yours): extra checks before
  each merge. Without it, `gsd-finish` runs the project's tests.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh | bash
# skills for more than one agent:
curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh | bash -s -- --agent claude --agent codex
```

Prefer to read it first?
`curl -fsSL …/install.sh -o install.sh && less install.sh && bash install.sh`

The installer downloads the latest GitHub release, checks its SHA256, installs
it to `~/.local/share/gsd-toolkit/releases/<version>/` and links the commands
into `~/.local/bin`. It also installs gsd-core for each chosen agent that has
none (`--no-core` skips this). `--version X.Y.Z` installs a given release.

For Claude, it adds one user-level hook that refuses `/gsd-new-project` and
`/gsd-ingest-docs` in a repo that `gsd-init` has not set up.
`--no-user-hook` leaves it out.

### Updates

Commands tell you when a newer release is out (at most one GitHub call a day;
`GSD_NO_UPDATE_CHECK=1` turns it off).

```sh
gsd-update --check            # installed vs latest
gsd-update                    # the latest toolkit + gsd-core
gsd-update --version 0.7.1    # a given release; going back works too
```

The previous release stays on disk. See [CHANGELOG.md](CHANGELOG.md) and
[docs/releases.md](docs/releases.md).

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
- **Claims go through the base branch.** Pull, push, rebase and retry; if two
  sessions race, the loser takes the next number.
- **A local lock** (`.git/gsd-cmd.lock`) stops two commands from changing the
  same checkout at once. Locks left by crashed runs are reclaimed.
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
| [migration.md](docs/migration.md) | Coming from the old `get-shit-done-cc` |

## Development

```sh
git clone git@github.com:malyeg/gsd-toolkit.git && cd gsd-toolkit
tests/test-commands.sh        # each suite is standalone
```

Edits in a checkout never reach your installed commands until a release.
Try them as `./bin/gsd-…` or through the tests. The test suites, lint
commands and release steps are listed in [CLAUDE.md](CLAUDE.md#commands).
CI runs everything on Linux and macOS.

## License

[MIT](LICENSE)
