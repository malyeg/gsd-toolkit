# gsd-toolkit

> Formerly **gsd-worktrees** (`arconme/gsd-worktrees`). Already installed it?
> Run `gsd-update` twice, then `gsd-init --no-launch` in each project — see
> [docs/releases.md](docs/releases.md#moving-from-gsd-worktrees).

Provider-neutral, parallel-session worktree orchestration for **GSD** (Get Shit
Done). The shared shell engine supports Claude Code and OpenAI Codex (plus a `custom` command);
thin adapters select launch syntax, durable instructions, skill destinations,
and optional native hooks.

GSD itself (now [`@opengsd/gsd-core`](https://www.npmjs.com/package/@opengsd/gsd-core))
provides the planning skills (`/gsd-phase`, `/gsd-discuss-phase`,
`/gsd-plan-phase`, `/gsd-execute-phase`, …) and the `gsd_run` CLI. Our install
adds it for you (with `npx`, so it needs Node.js) for each agent that has none;
by hand: `npx @opengsd/gsd-core@latest --claude --global --profile=full` (or `--codex`). Coming
from the old `get-shit-done-cc`? See [docs/migration.md](docs/migration.md). This repo
provides everything around them: one-command feature start/finish, per-phase
git worktrees, claim races resolved automatically, a checkout lock, per-worktree
dev ports, ticket write-back (ClickUp, or any tracker through a script), and
mandatory command-level guards. Native agent hooks are additional early
feedback, not the safety boundary.

`gsd-start` validates the target worktree before printing or opening a session.
`gsd-flow-next` checks location even without `.gsd.conf`, including ticket and
decision steps; normal calls also validate the current phase action. A running
or failed install cannot be bypassed by partially created `node_modules`.
Nested agent workers retain these checks. Only `GSD_SKIP_GUARD=1` explicitly
bypasses them; use it only at the user's request.

## Providers and configuration

Use `gsd-init`, the normal public setup command, to install one or more
integrations and choose which provider should run the initialization session:

```sh
gsd-init --provider claude
gsd-init --provider codex
gsd-init --providers claude,codex --provider codex
gsd-init --providers claude,codex --provider codex \
  --provider-command codex=/opt/bin/codex
```

`--providers` is the installed provider set, in default order; `--provider`
selects the provider for this initialization session. `gsd-bootstrap-repo` is
the lower-level idempotent installer used by `gsd-init`.

`.gsd.conf` separates identity from executable:

```ini
providers = codex,claude
claude_command = /opt/anthropic/bin/claude
codex_command = /opt/openai/bin/codex
claude_model = MODEL_ID
codex_model = MODEL_ID
flow = strict
review_provider = codex
start_mode = flow
tracker = clickup
compact_at = 300000
```

`compact_at` (default `300000`) is when a launched Claude or Codex session
compacts its conversation, in tokens. Without it the CLI waits until its window
is nearly full, and every turn before that re-sends the whole chat. Set
`compact_at = default` to keep the CLI's own setting; `GSD_COMPACT_AT`
overrides the key, and a `CLAUDE_CODE_AUTO_COMPACT_WINDOW` you export wins.
`gsd-start` also saves the value in the phase worktree's
`.claude/settings.local.json`, so a plain `claude` opened there later
compacts at the same point.

The provider-specific `*_model` keys are optional. `gsd-init --model MODEL_ID`
and `gsd-start --model MODEL_ID` override the model for that launched session;
otherwise model selection follows `--model`, `GSD_MODEL`, the matching
`GSD_CLAUDE_MODEL` / `GSD_CODEX_MODEL`, then the matching
repo key above. With no value, the toolkit omits the model flag and lets the
CLI use its default. An explicit `--model` value of `default` also omits that
flag, overriding configured model values. Custom providers reject non-default
model selections because the toolkit cannot assume their CLI flag syntax.
Model selection applies only to the session launched by these commands; it
does not change existing or manually started sessions, or upstream GSD
subagent/review models. Model selection makes no authentication changes or
direct model API calls; each CLI uses its existing authentication.

`providers` is ordered: its first entry is the repository default. The older
singular `provider` key is still read when `providers` is absent, but new and
migrated configuration does not write it.

`gsd-start` starts or resumes the complete artifact-driven workflow
(`/gsdt-flow`) by default. Pass `--no-flow` to open discuss-phase only for one
invocation, or set `start_mode = discuss` to make that the repo's default
(`--flow` overrides it).

Provider identity and executable have separate precedence chains; see the
[configuration reference](docs/providers.md#configuration-reference).
Command values are one executable, never a shell template. `gsd-start` opens
the session in the worktree by default when it runs in a terminal. With
`--no-launch`, or with no terminal (a script, an agent's shell), it prints the
command instead. Print-only does not require an installed agent CLI, but still
validates configuration and guards. It means **no agent launch**, not a dry
run: setup/claims/worktree creation may still occur. A missing executable is
printed by default; an explicit `--launch` exits 127.

Multiple providers can use the same phase sequentially:

```sh
gsd-start -p 7 --provider claude --no-launch
gsd-start -p 7 --provider codex --no-launch
```

Each command targets the existing `phase-7-*` worktree and renders that
provider's valid invocation. Only one mutating session may use the shared
worktree at a time; hand off after committing or otherwise reaching a clean
state. Parallel writers for different phases remain fully supported.

| Provider | Instructions | User skills | Launch prompt | Native hook |
|---|---|---|---|---|
| Claude Code | `CLAUDE.md` | `~/.claude/skills` | positional slash/skill prompt | supported, optional |
| OpenAI Codex | `AGENTS.md` | `~/.agents/skills` | positional natural-language prompt | not registered; command guard applies |

All provider files point to canonical `.gsd/INSTRUCTIONS.md`. Generated blocks
are marked and repeated bootstrap updates only those blocks. See
[`docs/architecture.md`](docs/architecture.md),
[`docs/provider-audit.md`](docs/provider-audit.md),
[`docs/migration.md`](docs/migration.md), and
[`docs/providers.md`](docs/providers.md).

## Which command when

**Every day:**

| Command | What it does | When |
|---|---|---|
| `gsd-init` | Sets up a repo from zero: installs the requested provider set, then opens the agent session that makes the plan (`/gsd-new-project`, or `/gsd-ingest-docs` when docs exist) and checks the ROADMAP when it closes. `--no-launch` prints it | First time in a new repo |
| `gsd-start` | Claims a phase, pushes it, creates the worktree, prints the session command | Begin a feature. `-n "desc"` = new phase, `-p <N>` = existing one |
| `gsd-list` | Table of every phase: number, plans done, stage, worktree | "What's in flight?" Read-only, safe anywhere |
| `gsd-finish` | Merges the phase back to base, pushes, deletes worktree + branch. `--pr` pushes and opens a GitHub PR instead (branch protection) | Phase is done. No argument needed from inside the worktree |
| `gsd-doctor` | Health check that names the command fixing each finding. `--json` for CI; `--fix` runs the safe fixes after asking | Something feels off. Writes nothing unless you pass `--fix` |
| `gsd-update` | Installs a newer release, and the latest gsd-core | When a command says a newer release is out |

**Rarely:**

| Command | What it does | When |
|---|---|---|
| `gsd-bootstrap-repo` | Writes neutral config/shims/instructions plus selected provider adapters | Usually called by `gsd-init`. Re-running is safe |
| `gsd-planning-repair` | Fixes `ROADMAP.md` / `STATE.md` after a merge scrambles them | When `gsd-doctor` tells you to |
| `gsd-tracker` | Moves the phase's ticket to "in progress" / "in testing"; saves it as `<P>-TICKET.md` | Only with `tracker =` set — see [docs/trackers.md](docs/trackers.md) |
| `gsd-codex-wait` | Waits out a Codex usage limit: `-- <command>` runs the command again after the reset Codex gave; `--wait-only` only waits. Never calls Codex; gives up (exit 75, never a pass) past `--max-wait` (24h) | A Codex review stopped on "hit your usage limit". Agents run it as a background job |
| `gsd-ui` | UI quality steps: `design` (DESIGN.md stub), `layout <N>` (the phase's layout contract), `check <N>` (opens the built pages in a browser, measures them, takes the pictures), `look <N>` (what to answer per picture), `sheet <N>` + `approve <N>` (your yes), `status <N>` | When `gsd-flow-next` asks, in a phase with screens |

**Lower-level APIs — usually called by other commands or skills:**

| Command | Called by |
|---|---|
| `gsd-wt-new` | `gsd-start` — the worktree-creating half |
| `gsd-wt-finish` | `gsd-finish` — the merge-and-cleanup half |
| `gsd-worktree-guard` | Provider-neutral validator; also callable from optional native hooks |
| `gsd-flow-next` | Which phase-flow step is next, read from the phase folder. Engine behind the `/gsdt-flow` skill |
| `gsd-planning-merge` | git, as the merge driver for `.planning/` files |
| `gsd-derive-port` | your app's `dev` script, to pick a per-worktree port |

The one-line version: `gsd-init` once → `gsd-start` → work → `gsd-finish`.
`gsd-list` to look, `gsd-doctor` when confused.

## Components

**`bin/` — shared commands** (installed to `~/.local/bin`, canonical here):

| Command | What it does |
|---|---|
| `gsd-start` | Start a feature in one step: claim the phase (deterministic, parallel-safe with auto-renumber), push, create the `phase-<N>-<slug>` worktree, open/print the session. `-n` is required to claim a new phase (a bare description is refused, so nobody — human or agent — opens a duplicate by accident); `-p <N>` re-attaches, `--insert <N>` claims a decimal hotfix phase, `--ticket <id>` links a tracker ticket: the title and slug end in `tk-<id>`, and a phase already tagged with that ticket is refused, whatever the wording (`--cu` is the old name). With a tracker set, a new claim needs its ticket (`--no-ticket` for a chore); `gsd-init` asks which tracker to use. |
| `gsd-finish` | Finish from anywhere: merge the phase branch back into the base branch, push (with retry on parallel pushes), remove the worktree + branch, move the phase's ticket to its testing/review status when a tracker is set. Runs the pre-merge check or the project's tests first. `--pr` (with `--draft`) skips the merge: pushes the branch — the `*-pr` one from `/gsd-pr-branch` when present — and opens a GitHub PR via `gh`; run `gsd-finish` again after it lands to clean up. |
| `gsd-list` | Read-only table of all phases: number, description, plan progress, lifecycle stage (live from the phase's worktree), worktree state. |
| `gsd-init` | Take a repo with no GSD to "ready for gsd-start": bootstrap one or more providers, then open the planning session (`/gsd-new-project` or `/gsd-ingest-docs`) and, when it closes, say whether the ROADMAP is ready (`gsd-start -p <first phase>` next). With `--no-launch` or no terminal it prints the command. |
| `gsd-bootstrap-repo` | Fit a repo with shared workflow files and explicitly selected provider adapters. Marked blocks preserve unrelated instructions. |
| `gsd-tracker` | Tickets, one layer for every tracker: `start` / `finish` / `comment` / `status` / `snapshot` / `create` / `update` / `tasks` / `extract` / `check`, plus a tracker's own commands (ClickUp: `lists` / `members` / `api`). Tracker from `tracker =` in `.gsd.conf`: `none` (default), `clickup`, or `custom` (your script). The `gsdt-tracker` skill teaches agents to use it. See [docs/trackers.md](docs/trackers.md). `gsd-clickup` is the same, fixed to ClickUp. |
| `gsd-update` | Update a release install: `--check`, the latest, or `--version X.Y.Z`. Checksum-verified; keeps the previous release. Then gsd-core to its latest for each installed agent (`--no-core` skips it). |
| `gsd-wt-new` / `gsd-wt-finish` | The worktree workers behind `gsd-start`/`gsd-finish` (create with config-copy + background install; merge back locked and conflict-safe). Callable standalone. |
| `gsd-planning-repair` | Reconcile `.planning/ROADMAP.md` + `STATE.md` after a union merge and recompute their progress counters from the roadmap and the plan files on disk. `--check` is the CI guard (exit 1 on union-merge damage); `--commit` lands the repair. Run automatically by `gsd-finish` and the `post-merge` hook. |
| `gsd-planning-merge` | The git merge driver behind `merge=gsd-planning`: union both sides, then collapse every single-value line back to one value so the contradiction never lands. Registered per clone by `gsd-bootstrap-repo`, re-asserted by `gsd-finish`. |
| `gsd-doctor` | Read-only health check of a repo's GSD setup: toolkit install, shims, `.planning` merge safety, planning-file coherence, worktree hygiene, gsd-core workstreams (not supported here — flagged loud), branches whose upstream is gone, newer GSD on npm. Diagnoses only — every finding names the command that fixes it and carries a code (`W017`/`W027` shared with `/gsd-health`, `T0xx` toolkit-only); `--json` emits them for CI. No `--fix`, by design. |
| `gsd-worktree-guard` | Shared guard API used by `gsd-flow-next`: phase/worktree matching, base restrictions, dependency/install state, and strict phase order. Provider hooks may invoke the same API. |
| `gsd-derive-port` | Per-worktree dev ports (base + phase N), so parallel worktrees never collide on a port. |
| `gsd-codex-wait` | Wait out a Codex usage limit instead of failing. Wrap a command (`gsd-codex-wait -- ./review.sh`): if it fails on Codex's limit, wait until the reset time Codex gave (+2m) and run it again; any other result passes through with its exit code. `--wait-only` just waits (for `/gsd-review`, which cannot be wrapped). The reset time comes from Codex's message or its session log (`$CODEX_HOME/sessions`), else `--interval` (30m); `--max-wait` (24h) caps it — exit 75, never a pass. Run it in the background; on macOS it keeps the Mac awake. |

**`skills/` — canonical agent-facing skills** (installed per selected provider):

`gsdt-worktrees/SKILL.md` teaches any supported agent, in any project, what
these commands are and the order to use them in — `gsd-list` before claiming,
`-p <N>` to attach, `-n` only for genuinely new work. Only its description line
sits in context permanently; the body loads when a session is actually about
GSD. `install.sh` copies it; `gsd-update` keeps it current.

## Per-repo footprint

All logic lives in this package. `gsd-bootstrap-repo` installs into a repo only:

- **`.gsd.conf`** (committed) — `providers`, provider commands/models, `review_provider`,
  `start_mode`, `compact_at`, `base`, `wtdir`, `install`, `premerge`, `test`, `flow`, `tracker`
  (+ `tracker_command`, `tracker_profile`, `tracker_status_start` / `_finish`); keys are optional,
  falling back to auto-detection (develop/main, `<repo>-worktrees`, lockfile).
  `flow = strict` turns on the guard's phase-flow rule (below) and gsd-doctor's
  phase-flow debt report (T040); `flow_since = <N>` limits that report to phases >= N,
  and `flow_skip = <N>, <N>` leaves out single phases (listed as a note — a record, not a gap).
- **`.gsd/INSTRUCTIONS.md`** — canonical marked workflow block. Selected providers
  get minimal entrypoints in `CLAUDE.md` or `AGENTS.md`, plus
  optional native-hook settings where supported. Unrelated content is preserved.
- **`shims/` → `scripts/gsd-*.sh` + `scripts/hooks/gsd-worktree-guard.sh`** —
  frozen 7-line delegators to the PATH commands, so committed references
  (package.json dev scripts, optional provider-hook registration, docs)
  keep working on every checkout. They never change, so there is nothing to
  sync. The port shim fails soft (bare base port) and the guard shim fails open
  on machines without the toolkit; the rest fail with an install pointer.
- **`.gitattributes`** — `.planning/ROADMAP.md` and `STATE.md` get
  `merge=gsd-planning` (repos on the old `merge=union` are migrated in place).
- **a `post-merge` hook** (`.husky/post-merge` when husky owns hooks, otherwise
  the unversioned `.git/hooks/post-merge`) — runs `gsd-planning-repair` so a
  plain `git pull` on the base branch is covered, not just `gsd-finish`.
- **`scripts/gsd-premerge-check.sh`** (optional, repo-authored — not a shim) —
  pre-merge hook `gsd-wt-finish` runs as `<script> <branch> <base>` after the
  origin sync, before the merge, and again on the combined tree after each merge
  (including push retries). Nonzero prevents push and worktree removal. After a
  merge, failure leaves the merge local for inspection; no automatic rollback.
  The home for repo-specific validations (e.g. TypeORM migration-timestamp
  collision checks). Path override: `premerge =` in `.gsd.conf`; `none` disables.
  Without it, `gsd-finish` runs the project's test suite in the worktree
  instead, then on the combined base checkout before pushing. Install needed
  test dependencies in both checkouts. `test =` sets the command, `none` skips, otherwise
  detected (xcodebuild / make / just / cargo / go / npm / pytest).

## Install

Requires Bash, Git, Perl, curl and Python 3.7+ (`python3` or `python`). `jq`
enables native-hook registration/inspection and the ClickUp tracker; the
command-level guards do not require it.

**Use it (a release):**

```sh
curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh | bash
# pick the agents that get the skills (default: claude):
curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh | bash -s -- --agent claude --agent codex
```

Careful? Download the installer, read it, then run it:

```sh
curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh -o install.sh
less install.sh && bash install.sh
```

This downloads the latest GitHub release, checks its SHA256, and installs it to
`~/.local/share/gsd-toolkit/releases/<version>/` with the commands linked in
`~/.local/bin`. `--version X.Y.Z` installs a given release. It also installs
gsd-core (`--profile=full`) for each chosen agent that has none; an agent that
has it is left alone (`gsd-update` updates it). `--no-core` skips this. Without Node.js (`npx`) it prints the command to run
later.

**Windows: use WSL2.** The toolkit is bash and expects a Unix system
(symlinks, `~/.local/bin`, `perl`, Unix process checks). Plain Windows,
PowerShell and Git Bash are not supported. Inside WSL2 it is just Linux, which
CI tests on every push:

```sh
wsl --install                     # in PowerShell (admin), once; installs Ubuntu, then reboot
# then, in the Ubuntu terminal:
sudo apt update && sudo apt install -y git curl perl python3 jq
curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh | bash
```

- Keep your projects on the Linux side (`~/projects`), not under `/mnt/c/…`:
  it is much faster there, and file permissions and line endings behave.
- Install and run the agents (Claude Code, Codex) and Node.js (for gsd-core)
  inside WSL too, so they see the same PATH.
- If `gsd-*` is not found after install, open a new terminal (Ubuntu adds
  `~/.local/bin` to PATH at login once it exists).
- VS Code: the "WSL" extension opens the Linux-side folders directly.

**Updates:** `gsd-start`, `gsd-list`, `gsd-init` and `gsd-doctor` tell you when
a newer release (of this toolkit or of GSD itself) is out (at most one GitHub call a day; `GSD_NO_UPDATE_CHECK=1` turns it
off). Then:

```sh
gsd-update --check        # installed vs latest
gsd-update                # install the latest, then the latest gsd-core
gsd-update --no-core      # the toolkit only
gsd-update --version 0.2.0   # a given release (going back works too)
```

The release you had before stays on disk; older ones are removed. What changed
in each release: [CHANGELOG.md](CHANGELOG.md). More: [docs/releases.md](docs/releases.md).

**Work on the toolkit itself (a git checkout):**

```sh
git clone git@github.com:malyeg/gsd-toolkit.git
cd gsd-toolkit
./install.sh --agent claude      # or --agent codex / --all-agents
```

`./install.sh` here does what the curl line does: it installs the latest
**release**, not this checkout's files. So your other repos run a release
while you edit here, and your edits reach them only once you cut a release
and run `gsd-update`. To try an edit, run it from the checkout
(`./bin/gsd-list …`) or run the tests. The installing itself is done by the
release's `lib/install.sh`; you never run that by hand.
Commands default to `GSD_BIN_DIR` or `~/.local/bin`. Skill roots can be isolated
or relocated with `GSD_CLAUDE_SKILL_DIR` and `GSD_CODEX_SKILL_DIR`. Existing unrelated files are backed up; command links
and skills the toolkit placed earlier are replaced in place.
Stale toolkit skill links are reported; stale toolkit command links are pruned.
For Claude, install also adds one user-level hook (in
`~/.claude/settings.json`, next to the skills dir)
that refuses `/gsd-new-project` and `/gsd-ingest-docs` in a repo `gsd-init` has
not set up — run `gsd-init` instead. In other repos it checks nothing else;
in a set-up repo it also applies the toolkit's guard to slash commands you type.
`./install.sh --no-user-hook` leaves it out and removes it.

**The checkout:** keep it current with `git pull`. Commands still linked into
a checkout (how older versions of `./install.sh` installed) are noted by
`gsd-doctor`; `./install.sh --reuse-install-config` moves them to a release.
Installation records the selected providers and skill destinations in
`GSD_BIN_DIR/.gsd-install-manifest` (data, never sourced as shell);
`gsd-update` reuses that selection instead of defaulting to Claude. Repeat
all desired `--agent` flags when changing the installation set.

## The loop per feature

```sh
gsd-start -n "customer terms rework" --ticket 869e33cv4 --flow
# Run the printed session command; follow gsd-flow-next N through every gate.
# After step=done, only with explicit user intent, as the session's final action:
gsd-finish
```

Every command self-documents: `gsd-start --help`, `gsd-finish --help`, ….

The full order — including independent review, verification, security, conditional UI gates, and
which commands run in the worktree vs the main checkout — is laid out in
[`docs/command-order.html`](docs/command-order.html). Open it in a browser.

## Concurrency model (the point of all this)

- **One feature = one phase = one worktree.** Multiple providers may take turns
  in that worktree, but only one mutating session may use it at a time. The main
  checkout stays on the base branch; nothing edits it directly.
- **Claims serialize through the base branch** — pulled first, pushed with a
  rebase-and-retry loop; two sessions claiming at once get distinct numbers
  (the loser auto-renumbers).
- **A local lock** (`.git/gsd-cmd.lock`) serializes gsd commands touching the
  same checkout on one machine; stale locks from crashed runs are reclaimed
  automatically (dead-PID detection).
- **Merges fail clean:** a conflicting finish aborts the merge, leaves the base
  branch pristine, and prints the resolution steps — it never wedges the shared
  checkout for other sessions.
- **`ROADMAP.md`/`STATE.md` use `merge=gsd-planning`** so parallel finishes never
  stop on trivial shared-state conflicts. The driver unions both sides (so each
  session keeps its own additions) and then reconciles: duplicated checklist
  entries, progress rows and phase sections collapse to one — `[x]` beating
  `[ ]`, at the position of the phase's first occurrence — and duplicated
  single-value lines collapse to the incoming branch's value. `gsd-finish` then
  runs `gsd-planning-repair`, which recomputes the progress counters from the
  roadmap and the `.planning/phases/*/*-PLAN.md` files on disk, because after a
  divergent merge neither side's counters are trustworthy. STATE.md's
  `## Session Continuity` history is never touched.

## The `.planning/` merge problem

`ROADMAP.md` and `STATE.md` are shared state that parallel phase sessions all
write to, so they merge automatically instead of conflicting. The original
strategy was git's built-in `union` — keep both sides — which is right for the
append-only parts of those files and wrong for every line that is a single
source of truth. When a phase branch flipped `- [ ] **Phase 11**` to `- [x]`
and the base branch had also touched the adjacent line, union kept both, and
the roadmap ended up claiming Phase 11 was simultaneously complete and not
started. The frontmatter went the same way: two `status:`/`stopped_at:` values
and two full sets of progress counters.

The fix is three layers, because the damage has three entry points:

1. **`merge=gsd-planning`** (the driver) — union first, so nobody loses their
   additions, then reconcile. Keyed content (checklist entries, progress rows,
   `### Phase N` sections) collapses to one per phase, keeping the position of
   the phase's *first* occurrence and the content of its *best* one — `[x]`
   beats `[ ]`, a real status beats "Not started", and among equals the longer
   line wins because it carries the `(completed <date>)` suffix. Keeping the
   later line instead would push phases out of numeric order, which is exactly
   what happened in one hand repair. Single-value lines collapse to their last
   copy, which is the incoming branch's, because union writes ours-then-theirs.
2. **`gsd-planning-repair`** — run by `gsd-finish` after *both* of its merge
   points (the phase merge, and the `pull` on the push-retry path, which fires
   precisely when a parallel session moved the base branch), and by the
   `post-merge` hook for plain `git pull`. It redoes the structural pass and
   then recomputes the progress counters, which a merge cannot get right by
   picking a side: after one real phase-11 merge the two candidates were
   30 phases/12 complete/96 plans and 28/11/103, and the truth was 30/13/111.
   Counters come from the roadmap's `### Phase` headings and `- [x] **Phase`
   entries, and from `.planning/phases/*/*-PLAN.md` and `*-SUMMARY.md` on disk.
3. **`gsd-planning-repair --check`** — the CI guard, so a corrupted file cannot
   reach the shared branch unnoticed:

   ```yaml
   - uses: actions/checkout@v4
   - run: |
       git clone --depth 1 https://github.com/malyeg/gsd-toolkit.git /tmp/gsd
       /tmp/gsd/bin/gsd-planning-repair --check
   ```

   It exits 1 only on union-merge damage. Drift that merging did not cause — a
   stale counter, a phase missing from the progress table, a table row
   `/gsd-fast` appended past EOF — is reported as an advisory and never fails
   the check.

**What the repair never touches:** STATE.md's `## Session Continuity` section.
Its `Last session:` / `Stopped at:` / `Resume file:` lines are one entry per
past session and legitimately repeat, so every single-value dedupe is scoped to
the block that owns the field (`## Current Position`, the velocity block, the
frontmatter). A global keep-the-last-occurrence pass deletes real history — an
early hand-written attempt at this destroyed seven entries that way, and
`tests/test-planning-reconcile.sh` asserts that section stays byte-identical.

**Fallbacks.** Merge drivers live in git config, which is not versioned, so a
clone that never ran `gsd-init` gets plain union — the repair fixes
that afterwards, and the test suite covers the no-driver path explicitly.
Without `python3`, the driver does the plain union and warns; that is exactly
today's behaviour, never worse.

## Tests

```bash
tests/test-flow-next.sh
tests/test-planning-reconcile.sh
tests/test-worktree-guard.sh
tests/test-providers.sh
tests/test-install-copy.sh
bash tests/test-review-fixes.sh
tests/test-list.sh
tests/test-review-round2.sh
tests/test-commands.sh
tests/test-update.sh     # releases: install.sh, gsd-update, checksums, pruning, the update notice
tests/test-ui.sh         # UI gates: gsd-ui design/layout/shots/check/look/approve (stubs + local server), finish gate, doctor, --no-ui
tests/test-ui-browser.sh # the real page checker in a browser (needs GSD_PLAYWRIGHT_ROOT=<folder with playwright>; skips without)
tests/test-doctor.sh     # doctor checks: missing tools, stale skills, .gsd.conf typos, base branch, pre-merge gate, …
tests/test-tracker.sh    # tickets: id parsing, none/custom/fake-ClickUp, start/finish/doctor paths
tests/test-codex-wait.sh # Codex usage limit: gsd-codex-wait (fake clock), the usable-review test
tests/test-e2e.sh        # whole journey in a fake project; needs gsd-core (skips without it)
```

The suites cover the two real planning corruptions from `medyour-platform`
(`tests/fixtures/`), an end-to-end `git merge` through the driver, the same
merge without the driver, a full `gsd-wt-finish` run, the three collateral-
deletion regressions, the provider adapters, and `gsd-doctor` — including that it leaves the working
tree, git config and every file byte-identical, and that `gsd-doctor` and
`gsd-bootstrap-repo` agree on what "installed" means (both go through
`gsd_planning_status`).

CI runs the suite on Linux and macOS (`.github/workflows/tests.yml`).

## License

MIT — see [LICENSE](LICENSE).

## Current state / roadmap

- This repo is the **single source of truth** — commands, workers, lib, and
  shims all live here; repos carry only `.gsd.conf` + the frozen shims
  ("step two" done 2026-07-18: the old copy-and-perl-rewrite template system
  is gone).
- CI includes shell syntax, ShellCheck (Linux), and Linux/macOS regression suites,
  including a real local-remote push race during finish. Hosted CI must pass before merge.
