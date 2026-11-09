# Changelog

Each release is a GitHub release `vX.Y.Z` with `gsd-toolkit-X.Y.Z.tar.gz`
(`gsd-worktrees-X.Y.Z.tar.gz` before 0.8.0, in `arconme/gsd-worktrees`) and
`SHA256SUMS`. Install or update: see the README. The section for a version
becomes its release notes.

## Unreleased

- **`gsd-doctor` and `gsdt-doctor` no longer suggest hiding gsd-core skill
  groups.** It saves only a few hundred tokens. The groups stay in `--json`
  (`context.agents[].hideable`); `gsdt-doctor` hides them only if you ask.

## 0.8.2

- **`gsd-doctor` shows what GSD adds to your context.** A new "context"
  section: what gsd-core's skill and agent descriptions cost in every
  session, the gsd-core skill groups the phase flow never runs (hide them
  with `/gsd-surface disable <group>`), and GSD files over 32 KiB
  (`ROADMAP.md`, `STATE.md`, …). Notes only — never a finding. `--json` has
  it under `context`, and the safe fixes under `safe`.
- **T009 checks skills, not the profile name.** A skill set trimmed with
  `/gsd-surface` is fine as long as the skills the phase flow runs are there.
- **New skill `gsdt-doctor`**: runs `gsd-doctor` and fixes what it finds,
  one item at a time, after you say yes.

## 0.8.1

- **`gsd-clickup` is removed.** Use `gsd-tracker` (it does everything
  `gsd-clickup` did; `--tracker clickup` forces ClickUp). `gsd-update` removes
  the old `gsd-clickup` from your PATH. ClickUp's options are now in
  `gsd-tracker --help`.

## 0.8.0

- **gsd-worktrees is now gsd-toolkit**, at
  [malyeg/gsd-toolkit](https://github.com/malyeg/gsd-toolkit). The old repo is
  archived; its releases stay downloadable.
- **The skills are renamed**: `gsdw-flow` → `gsdt-flow`, `gsdw-worktrees` →
  `gsdt-worktrees`, `gsdw-tracker` → `gsdt-tracker`. `gsd-start` opens
  `/gsdt-flow`. The guard still knows `/gsdw-flow`, for a session started
  before the update.
- **Nothing else you type changes**: the `gsd-*` commands, `.gsd.conf`,
  `.gsd/`, `GSD_*` variables and `git config gsd-tracker.*` stay.
- **How to move** (from 0.7.0 or older):
  1. `gsd-update` — gets 0.7.1, the bridge release of gsd-worktrees.
  2. `gsd-update` again — gets 0.8.0 from the new repo. It removes the
     `gsdw-*` skills and `~/.local/share/gsd-worktrees/` (the runtime is now
     `~/.local/share/gsd-toolkit/`).
  3. In each project: `gsd-init --no-launch`, then commit. It rewrites the
     marked blocks in `.gsd/INSTRUCTIONS.md`, `CLAUDE.md` and `AGENTS.md` in
     place; `gsd-doctor` reports them as out of date (T016) until then.
- `install.sh` reads both tarball names, so `--version` can still install a
  gsd-worktrees release (with `GSD_UPDATE_REPO=arconme/gsd-worktrees`).

## 0.7.0

- **`gsd-tracker` is standalone and works in any folder.** It no longer uses
  GSD's code; GSD runs it as a command. In a repo with no `.gsd.conf` it uses
  ClickUp instead of `none` (`GSD_TRACKER=none` turns it off); GSD itself still
  counts only a tracker that is set, so nothing changes for GSD repos.
- **Its settings can live in git config.** `gsd-tracker.tracker`, `.profile`,
  `.command`, `.statusStart`, `.statusFinish` in `.git/config` (per clone,
  never committed) sit between the environment and `.gsd.conf`, which still
  works. `gsd-tracker config` shows the settings in use and where each came from.
- **`gsd-tracker login` works anywhere** — plain repos, phase worktrees, or no
  repo at all (`login <name>` then only saves the token). It sets
  `git config gsd-tracker.profile` and no longer edits or commits `.gsd.conf`.
  When the profile already has a saved token, it asks: use it, or replace it.
- `gsd-tracker <unknown command>` with the tracker `none` now says so, and how
  to set one.

## 0.6.3

- **A real review is no longer rejected as empty.** A review counted as empty
  when the reviewer wrote its own `##` sections (such as the `## <plan-id>`
  ones the gsd-core template asks for) or a `---` line inside its output. Empty
  and failed reviews are still rejected.
- **Open a rejected review before deleting it.** A rerun costs a full review, so
  `gsd-flow-next` now says to open a rejected file of more than 40 lines first,
  and the guard says to open it.
- **For maintainers: a push to `main` that changes `VERSION` is a release.** It
  checks, tests, tags and publishes; no tag to push by hand. See
  `docs/releases.md`.

## 0.6.2

- **`gsd-update` updates gsd-core too.** After the toolkit, it brings GSD
  itself to npm's latest for each agent you installed (full skill profile);
  an agent without it gets it. `gsd-update --check` shows both versions;
  `--no-core` leaves gsd-core alone. The update notice and `gsd-doctor` now
  say `gsd-update` for a newer gsd-core too.
- **No more old-GSD special cases.** The toolkit no longer looks for the old
  `get-shit-done-cc` (`gsd-sdk`): install no longer skips gsd-core when it
  finds it, and doctor, `gsd-start` and the update notice no longer name it.
  Without gsd-core you get the plain "gsd-core not found" with the install
  command.

- **`gsd-tracker login` runs in the main checkout only.** In a phase
  worktree it refuses before asking for the token, and names the main
  checkout: it edits and commits that checkout's `.gsd.conf`, not the folder
  you are in. It now edits `.gsd.conf` under the checkout lock, so it waits
  for a running `gsd-start` or `gsd-finish` instead of changing the file under
  them. The commit question comes first, so they never wait on your answer.

- **`gsd-tracker login` hides the token from the first key.** The prompt
  showed before typing was hidden, so a token pasted at once could be
  echoed on screen. Now typing is hidden before the prompt shows.

- **`gsd-sync` is removed.** It had little left to do: pull the toolkit
  checkout (use `git pull`) and check a repo's shims (`gsd-doctor` T010 does
  that). What you do: nothing; the next `gsd-update` removes the command.
  `gsd-doctor` now notes when your commands run from a git checkout, with
  the line that moves them to a release.

- **`gsd-tracker login`: a ClickUp token for one repo in one step.** It asks
  for the token (hidden), tests it, saves it to
  `~/.config/gsd/clickup-<profile>.env` (mode 600, outside the repo) and sets
  `tracker_profile` in `.gsd.conf`. The profile defaults to the repo folder's
  name. A token ClickUp refuses is never saved. When the token was typed, it
  offers to commit `.gsd.conf` (that file only, never pushed). `gsd-doctor`
  T073 now names it.

- **One installer: `install.sh`.** `get.sh` is gone; the curl line is now
  `curl -fsSL https://raw.githubusercontent.com/arconme/gsd-worktrees/main/install.sh | bash`.
  `./install.sh` in a git checkout installs the release too, never the
  checkout's own files, so your repos run a release while you work on the
  toolkit. The old link install (commands linked into a checkout, live with
  every edit) is gone. What you do: if your commands link into a checkout
  (`gsd-doctor` notes it), run `./install.sh --reuse-install-config` there
  once. Installed releases update as before with `gsd-update`. The copying
  step moved to `lib/install.sh`, which only the downloaded release runs.
- **Install also installs gsd-core.** `install.sh` now adds GSD itself
  (`@opengsd/gsd-core`, full skill profile) for each agent that has none, so
  a new machine needs one command. An agent that already has gsd-core is
  left alone, `gsd-update` never runs it, and `--no-core` skips it. Needs
  Node.js (`npx`); without it the install finishes and prints the gsd-core
  command to run.

- **Phase sessions compact at 300k, not 200k.** `/gsd-plan-phase` reads a
  47k-token workflow and reached 140k before its planner returned, so a 200k
  window showed 84% and gsd-core warned "context critical" mid-plan. Set
  `compact_at = 200000` in `.gsd.conf` to keep the old point. Existing
  worktrees get the new value on their next `gsd-start -p <N>`.
- **`/gsdw-flow` no longer stops at gsd-core's context warning.** Its
  context monitor fires at 65% of the compact point and says to tell the
  user, so the flow stopped and asked for `/clear` and a rerun long before
  the session would compact. The skill now ignores the warning and keeps
  looping; after a compact it re-reads the step from `gsd-flow-next`. Run
  `gsd-update` to get the new skill.

## 0.5.2

- **The checkout lock works on Ubuntu 26.04.** Its `mkdir` (uutils) can tell
  two racing gsd commands both that they made the lock folder, so both ran at
  once. The lock now makes it with Perl's `mkdir`, the plain system call.
- **A wave's plans run in parallel again.** gsd-core runs them in parallel
  only with `worktree.baseRef = "head"`, read from the phase worktree's
  `.claude/settings.local.json`. Nothing ever set it, so `/gsd-execute-phase`
  saw the phase branch ahead of `origin/HEAD` and ran every plan one at a
  time. `gsd-start` (new and reused worktrees) and `gsd-init` now add it,
  keeping the file's other keys; `gsd-doctor` reports it missing (T034) and
  `--fix` adds it.
- **A phase reopened with a plain `claude` compacts at 200k too.** Only the
  session `gsd-start` launched got `compact_at`; one opened later in the
  worktree with `claude` waited until ~366k. `gsd-start` now also saves it in
  the worktree's `.claude/settings.local.json` (`env`), keeping the file's
  other keys. An exported `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or
  `compact_at = default` removes it. Existing worktrees get it on their next
  `gsd-start -p <N>`.

## 0.5.1

- **Cheaper phase sessions.** A `/gsdw-flow` phase ran in one chat that grew
  to ~366k tokens before Claude compacted it, and every turn re-sent all of
  it (100–180M input tokens per phase). `gsd-start` and `gsd-init` now launch
  Claude and Codex so they compact at 200k tokens (`compact_at` in
  `.gsd.conf`; `compact_at = default` keeps the CLI's own setting). Applies
  to sessions opened after the update; a running session keeps its setting.
- **Fixes to the 0.5.0 Gemini clean-up** (from a Claude and a Codex review):
  - A `GEMINI.md` that is a link (to `AGENTS.md`, say) is left alone. Before,
    `gsd-init --no-launch` removed the Codex block through the link.
  - A legacy `provider = gemini` with `agent_command` no longer turns that
    command into `claude_command`.
  - An old Gemini hook is removed however its path was written; doctor's T061
    now looks only for a hook command, not any mention of the guard.
  - `gsd-bootstrap-repo --commit` no longer fails on a removed `GEMINI.md`
    that git never tracked.
- `install.sh`: an old install's `~/.codex/skills` moves to `~/.agents/skills`
  also when `CODEX_HOME` is set.

## 0.5.0

Breaking:

- **Needs gsd-core.** GSD is now `@opengsd/gsd-core` (CLI `gsd_run`); the old
  `get-shit-done-cc` / `gsd-sdk` is archived and no longer used. `gsd-start`
  claims phases with `gsd_run query phase.add` / `phase.insert`. With only
  the old GSD installed it refuses and points to `docs/migration.md`. What
  you do: follow "0.5.0: move to gsd-core" in `docs/migration.md`
  (`npx @opengsd/gsd-core@latest --claude --global`, then
  `npm rm -g get-shit-done-cc`).
- **Gemini is removed** (gsd-core dropped it). `gemini` is refused with a
  reason in `providers`, `--provider`, `--agent`, `GSD_AGENT`,
  `review_provider` and `install.sh --agent gemini`. What you do: run
  `gsd-init --no-launch` in each repo (drops gemini from `providers`,
  removes `gemini_command` / `gemini_model`, our block in `GEMINI.md`, our
  hook in `.gemini/settings.json`). `install.sh` removes our skills and user
  hook under `~/.gemini` when its install manifest lists gemini.
- **Skills are renamed:** `gsd-flow` -> `gsdw-flow`, `gsd-worktrees` ->
  `gsdw-worktrees`, `gsd-tracker` -> `gsdw-tracker`, because gsd-core's
  installer deletes every `skills/gsd-*` folder. What you do: update
  gsd-worktrees first (`gsd-update`), then install gsd-core. In Claude, type
  `/gsdw-flow <N>`.

Also:

- `gsd-start` now opens the full flow (`/gsdw-flow`) by default: the session
  resumes the phase at its first unfinished step. `--no-flow` opens
  discuss-phase only for one run; `start_mode = discuss` in `.gsd.conf` makes
  that the repo's default, and `--flow` overrides it.
- `gsd-doctor` T005 looks for gsd-core (`GSD_CLI`, `gsd_run` on PATH, then
  `gsd-core/bin/gsd_run` under the Claude or Codex folder) and notes an old
  `get-shit-done-cc` still installed.
- New doctor codes: T009 (gsd-core installed with a skill profile other than
  `full`; fix `npx @opengsd/gsd-core@latest --claude --global --profile=full`),
  T026 (`"phase_id_convention": "bracket"` in `.planning/config.json`; not
  supported), T061 (Gemini setup left from an older release; fix
  `gsd-init --no-launch`, also run by `gsd-doctor --fix`).
- T008 (a GSD hook runs a missing file) now says to re-run the gsd-core
  installer (`--force-statusline` when the status line is affected).
- The update notice and doctor check the latest `@opengsd/gsd-core` on npm.
  The cache file is now `latest-gsd-core-version`.
- A `<P>-REVIEWS.md` with gsd-core reviewer-instance headings
  (`## Codex Review (fast)`) now counts as a review.
- The guard reads the Claude plugin form `gsd-core:gsd-plan-phase` as
  `gsd-plan-phase`.
- Codex skills now go to `~/.agents/skills` (`GSD_CODEX_SKILL_DIR` overrides).
  Ours left in the old `~/.codex/skills` are removed by `install.sh`.
- A `--copy` install marks a skill with a last line
  `<!-- gsd-worktrees-skill X.Y.Z -->` in its `SKILL.md` (it was a
  `.gsd-worktrees-skill` file).
- The Codex hook file is `$CODEX_HOME/hooks.json`.
- `tests/test-gemini-hook.sh` and `docs/gemini-hooks.md` are gone. CI installs
  `@opengsd/gsd-core@1.18.0`, so `tests/test-e2e.sh` runs for real;
  `GSD_TEST_REQUIRE_GSD=1` turns its skip into a failure.

## 0.4.12

- `gsd-init` now opens the planning session by default: the agent starts
  with `/gsd-new-project` (or `/gsd-ingest-docs` when it finds PRDs/specs).
  When you close it, `gsd-init` checks the plan: "✔ plan ready: N phases —
  next: gsd-start -p 1", or, with no ROADMAP yet, exit 1 and "run gsd-init
  again". So a new repo is `gsd-init` → answer the questions → `gsd-start`.
- Like `gsd-start`: `--no-launch` prints the command instead, and so does a
  run with no terminal (a script, an agent's shell). A repo that already has
  a plan opens nothing. A missing agent CLI just prints, unless `--launch`
  was given (exit 127).

## 0.4.11

- `gsd-start` now opens the session in the new worktree by default. Pass
  `--no-launch` to only print the command. With no terminal (a script, or an
  agent running it in its shell) it still prints. `--launch` is kept, and an
  explicit `--launch` still exits 127 when the agent CLI is missing.

- With a tracker set (`tracker = clickup|custom`), `gsd-start -n` and
  `--insert` need a ticket: `--ticket <id>` or a `tk-<id>` tag in the
  description. Without one the claim is refused and nothing is claimed.
  `--no-ticket` claims anyway, for a chore. `gsd-start -p` on an older phase
  with no ticket only notes it.
- `gsd-init` asks where the tickets live (none, ClickUp, or your own script)
  when `.gsd.conf` sets no tracker. It asks only in a terminal; scripts pass
  `--tracker none|clickup|custom` (and `--tracker-command <script>`).
  `gsd-bootstrap-repo` takes the same flags.

## 0.4.10

Fixes from a bug scan. Run `gsd-update` (it re-runs the installer, which
fixes the hook below).

- The user-level hook now really sees typed slash commands. 0.4.8/0.4.9 used
  the matcher `gsd`, which Claude Code reads as an exact name, so a typed
  `/gsd-new-project` was never checked. It is `gsd.*` now.
- Install writes `~/.claude/settings.json` through a symlink and keeps its
  mode (a 0600 file stayed 0600). Bootstrap writes a linked `AGENTS.md` /
  `CLAUDE.md` through the link.
- Guard: the phase number is the first word that is only a number, so
  `--files src/v2/a.ts` is no longer read as phase 2. `/gsd-phase --remove`
  and `--insert` stay blocked with `--edit` added.
- Ctrl-C or a kill now stops a gsd command (exit 130/143). Before, it
  released the lock and carried on.
- `gsd-finish`: files the tests leave in the worktree (coverage, caches) no
  longer stop the cleanup after the push. A worktree changed while the
  finish ran is kept, and the finish still succeeds.
- A phase whose title ends in "PR" (slug `-pr`) can be started and finished.
  A `/gsd-pr-branch` helper `X-pr` is still skipped when `X` exists.
- `gsd-wt-new` re-creates a worktree whose folder was deleted by hand, instead
  of saying "ready" for a folder that is not there.
- The finish gates (UI steps, test audit) check the branch's own files when
  its worktree is gone, for `gsd-finish --pr` too. Before, they passed.
- An origin without the base branch gets "push it first", not a raw git
  error. `gsd-start -p` catches up with origin first.
- A test audit with `nyquist_compliant: "true"`, `True`, a comment, or CRLF
  line ends counts.
- A phase 2.1 row no longer stands in for phase 2 when `gsd-start` adds the
  ROADMAP rows.
- A UI check goes stale when `<P>-LAYOUT.md` changes (pages, expect, waive,
  …), not only when the code does.
- `gsd-planning-repair --commit` commits only ROADMAP.md / STATE.md; other
  staged files stay staged.
- `gsd-doctor --fix` never removes a lock with no pid (a command that is just
  starting); that is its own finding, T033.
- A `tracker = custom` script is stopped after 60 s (`GSD_TRACKER_TIMEOUT`).
- UI check C4: a text box whose width is off by 1px or less (rounding) is no
  longer reported as shrunk text.
- Bootstrap no longer glues its line onto a `.gitignore` with no final
  newline. `gsd-doctor` offers `--fix` only when a repair would change
  something.

## 0.4.9

- In a repo set up with `gsd-init`, the guard blocks GSD skills that clash
  with one phase per worktree, and names the toolkit command to use:
  `/gsd-autonomous` and `/gsd-manager` (many phases in one checkout →
  `gsd-start` per phase, then `/gsd-flow`), `/gsd-workspace` and
  `/gsd-workstreams` (GSD's own isolation → `gsd-start -n`), and `/gsd-phase`
  add / `--insert` (unpushed claim → `gsd-start -n` / `--insert`) /
  `--remove` (renumbers phases that may have worktrees). `/gsd-phase --edit`
  still works on the base branch. `GSD_SKIP_GUARD=1` escapes.
- Slash commands you type are now checked too: in a set-up repo the
  user-level hook applies the whole guard (the repo hook only saw skill
  calls). In other repos it still checks only `/gsd-new-project` and
  `/gsd-ingest-docs`.
- The `gsd-worktrees` skill lists these rules, plus care notes for
  `/gsd-ship`, `/gsd-complete-milestone`, `/gsd-cleanup`, `/gsd-quick` and
  `/gsd-progress` — for Codex, which has no hooks, the rules are the guard.

## 0.4.8

- TDD is on by default: the first `gsd-start` after `gsd-init` sets GSD's
  `workflow.tdd_mode` to true (in the claim commit) when the project hasn't
  set it. Plans then list each test case (input → expected result), so the
  cross-AI plan review can check them, and execute writes each test before
  its code. A project that chose `false` (`/gsd-settings`) keeps it.
- `/gsd-validate-phase` is now a required `gsd-flow` step, after the UI
  checks and before `secure`: it finds requirements with no test and writes
  the missing tests. Done = `<P>-VALIDATION.md` says `nyquist_compliant: true`
  or has a `## Validation Audit` (gaps left manual-only). Skipped when the
  project turned off `workflow.nyquist_validation`.
- With `flow = strict`: the guard blocks `/gsd-secure-phase`, and
  `gsd-finish` (merge and `--pr`) refuses, until the test audit is done.
  `gsd-doctor` lists a merged phase without it as debt (T040) — use
  `flow_skip` / `flow_since` for phases shipped before this.
- `/gsd-new-project` and `/gsd-ingest-docs` are refused in a repo `gsd-init`
  hasn't set up (no `.gsd.conf`): run `gsd-init` instead, which installs the
  toolkit's files first. Install adds one user-level hook for this to
  `~/.claude/settings.json` (typed slash commands and skill calls) and
  `~/.gemini/settings.json`; it checks nothing else, in any repo, and lets
  everything through if the toolkit is removed. `install.sh --no-user-hook`
  opts out. Codex has no hooks: the skill tells it the same rule.

## 0.4.7

- `gsd-flow` no longer asks whether to run a step the flow already agreed
  (e.g. "shall I run `/gsd-ui-phase`?"): it starts the step and pauses only
  where your answer is needed. The "does this phase have screens?" question
  reuses an answer you already gave in discuss, the ticket or the session.
- Browser testing (`verify-work` UAT and other page checks) runs in headless
  Playwright with no window — never in your own browser, so it doesn't take
  over the window you work in.

## 0.4.6

- `gsd-start` no longer hangs at "Preparing worktree" until a background
  dependency install (`yarn install`, …) finishes: the install now fully
  detaches, and the session opens while it runs.

## 0.4.5

- `gsd-tracker` is the one ticket layer: `create`, `update` and `tasks` are
  now shared verbs for every tracker (options go to the connector as written;
  `custom` scripts receive them; `tracker = none` fails them), and a
  connector's own commands come from its `TRACKER_EXTRA` (ClickUp: `lists`,
  `members`, `api`), so `gsd-tracker` names no ClickUp command. `gsd-clickup`
  is unchanged.
- The agent skill is now `gsd-tracker` (was `gsd-clickup`): it checks
  `gsd-tracker which` first and stops on `none`, instead of a write that does
  nothing and succeeds.
- Install removes a toolkit skill it no longer ships (the old `gsd-clickup`
  skill), so a retired skill can't keep loading with old advice.

## 0.4.4

- Per-project tracker login: `tracker_profile = <name>` in `.gsd.conf` makes
  the ClickUp tracker read `~/.config/gsd/clickup-<name>.env` instead of the
  shared `clickup.env` (no fallback, so a missing file is an error, not the
  wrong user). `GSD_TRACKER_PROFILE` overrides it for one command; custom
  tracker scripts get it too. `gsd-doctor` knows the key, flags a bad name
  (T018), and notes when an exported `CLICKUP_API_TOKEN` hides the profile.
- `gsd-clickup` gains ClickUp-only commands: `create`, `update` (name,
  markdown description, assignees, status, priority, parent), `tasks`
  (filters and `--match` name search), `lists`, `members`, and `api` for any
  other v2 call. A new `gsd-clickup` skill points agents at them, so one
  connector serves both the scripts and the chat, on the user's own token.

## 0.4.3

- `gsd-flow-next`: the plan step settles the research question up front
  (`--research`, or `--skip-research` when `workflow.research` is false in
  `.planning/config.json`), so `/gsd-flow` no longer stops at it.
- New `gsd-codex-wait`: waits out a Codex usage limit instead of failing.
  `gsd-codex-wait -- <command>` runs the command; if it fails on "You've hit
  your usage limit … try again at <time>", it waits until that time (+2m)
  and runs it again. Any other result passes through with its exit code.
  `--wait-only` just waits, for `/gsd-review`. The reset time comes from
  Codex's message or its session log; without one it re-checks every 30m.
  It gives up past `--max-wait` (24h) with exit 75 — never a pass. It never
  calls Codex. Run it as a background job; on macOS it keeps the Mac awake.
- A `REVIEWS.md` whose reviewer failed (an empty or error-only Codex section,
  e.g. after a usage limit) no longer counts: `gsd-flow-next` asks for the
  review again, and the guard (`flow = strict`) blocks `/gsd-execute-phase`.
- With `review_provider = codex`, the review step says what to do on a usage
  limit.

## 0.4.2

- `gsd-ui check` works without Playwright in the project: when the project
  has none of its own, it uses the machine's global install. Once per
  machine: `npm i -g playwright && npx playwright install chromium`. A
  project's own Playwright still wins, and the report says which one ran
  (`runner: … (global)`). The browser was always shared; now the package is
  too.
- `gsd-doctor` looks in the global npm folder too before it notes a missing
  Playwright, and its tip says to install it once per machine.

## 0.4.1

Better first drafts, from the "25 tricks for Claude design" tips that fit a
code project.

- The `DESIGN.md` stub (new projects) now says where to start: a real design
  system from styles.refero.design (the agent offers the 3 closest, you
  pick or mix), fonts chosen on purpose (Fontshare, FontJoy), and tested
  parts before drawn ones (shadcn, 21st.dev, React Bits). It also lists the
  layout rules R1–R10 that `gsd-ui look` uses. An existing `DESIGN.md` is
  never touched.
- The `design-system` flow step asks the agent to offer those real systems.
- `gsd-doctor` suggests optional add-ons for projects with screens, as notes
  (never findings), in the words of each configured provider: the Impeccable
  design skill (audit / polish commands, automatic checks), and the shadcn
  MCP when the app uses Tailwind or shadcn. It reads files only and stops
  suggesting what is already installed.

## 0.4.0

The UI steps now look at the built page, not only at the code
(`docs/plan-ui-check.md`).

- `gsd-ui check <N>`: opens every page of the phase at 375, 768 and 1440 px
  in the project's own Playwright, measures it, takes the pictures, and
  writes `<P>-UI-CHECK.md` and a sheet (`<P>-SHOTS/index.html`). Checks: the
  page scrolls sideways (C1), text may be cut off (C2), contrast (C3, a
  pinned axe-core ships with the toolkit), small text (C4, `ui_min_font`,
  default 12), broken images (C5), page errors (C6), the main button is
  missing, below the first screen or covered (C7), the page did not load or
  is another page such as a login (C8). Exit 0 passed, 1 failed, 2 could not
  run. Needs Node and Playwright in the project.
- New lines in `<P>-LAYOUT.md`: `main_button: /path = Text` (or
  `css=<selector>`, or `none`), `expect: /path = text on the page`,
  `app: <folder with Playwright>`, and
  `waive: <check> | <page> | <width> | <target> | <reason>` for a finding you
  accept.
- `gsd-ui look <N>` writes `<P>-UI-LOOK.md`: the agent answers one line per
  picture and layout rule (R1–R10; edit them in `DESIGN.md`) with what it
  saw. `gsd-ui sheet <N>` shows you the pictures; `gsd-ui approve <N>`
  records your yes (`--waive "<reason>"` when you choose not to look).
- Flow: `ui-check → ui-look → ui-approve → ui-review` replaces the
  `screenshots` step. The check remembers the code it ran on: change the code
  and the step opens again. Pages that still look the same keep their look
  and approval.
- `ui_gates = strict`: the guard blocks `/gsd-ui-review`, and `gsd-finish`
  (also `--pr`) refuses, until check, look and approval are current.
  `warn` (default) shows the steps and warns at finish. A phase whose UI
  review is already merged is left alone.
- `gsd-doctor`: UI debt of merged phases (T040 `ui-check`, `ui-approve`) no
  longer needs `flow = strict`; T081 = pictures committed by mistake;
  `ui_min_font` is checked (T018); notes are listed in `--json`; the
  Playwright note also looks in `apps/*` and `packages/*`.
- `gsd-ui shots` stays for pictures without checks. Picture names now carry a
  short hash, so `/a/b` and `/a-b` no longer share one file.
- **After updating:** the instruction text changed, so `gsd-doctor` reports
  T016 in each project. `gsd-doctor --fix` refreshes it.

## 0.3.4

- `gsd-doctor` T016: the project's GSD instructions (`.gsd/INSTRUCTIONS.md`
  and the marked blocks in `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`) are older
  than the installed toolkit, so agents follow old rules. Doctor compares
  each block with what `gsd-init` would write today — a release that doesn't
  change the text raises nothing, and your own text outside the blocks is
  ignored. `gsd-doctor --fix` refreshes them (runs `gsd-init`).
- The instruction text now has one definition in `lib/provider.sh`, shared by
  `gsd-bootstrap-repo` and `gsd-doctor` (output unchanged).

## 0.3.3

- `flow_skip` in `.gsd.conf`: leave single merged phases out of doctor's
  flow-debt report (T040), e.g. `flow_skip = 13.1, 14   # shipped before the
  rules`. Unlike `flow_since` (a cutoff), phases around them are still
  checked, and doctor lists the skipped ones as a note. Bad entries are T018.
- Fix: the T040 report now finds zero-padded decimal phase folders
  (`04.1-…`, as gsd-sdk writes them) — such phases were silently skipped.

## 0.3.2

- `gsd-doctor --fix`: after the normal check, runs only the safe fixes it
  found — `gsd-init --no-launch --no-commit` (shims, merge rules, driver,
  hook, instructions), `gsd-planning-repair` (planning damage and stale
  STATE.md counters), `git branch --track <base>`, `chmod +x` on the pre-merge
  script, and removing a lock whose process is gone. It lists them, asks
  (y/N; `--yes` for scripts), runs them, checks again, and lists the changed
  files. It never commits, pushes, checks out, deletes branches or edits
  ROADMAP.md — those stay commands for you. Without `--fix`, doctor still
  writes nothing, and it now says when `--fix` could help.

## 0.3.1

- `gsd-ui shots`: a phase can name its app with `url:` in `<P>-LAYOUT.md`
  (e.g. `url: http://localhost:{port:3100}`). It wins over `ui_url` in
  `.gsd.conf`, so projects with several apps (two portals, an API) screenshot
  the right one per phase. The LAYOUT template has the new `url:` line, and
  the "several base ports" message says where to put it.

## 0.3.0

UI quality gates — so phases with screens stop shipping ugly pages. See
`docs/ui-quality-plan.md`.

- **Design system, once per project:** `.planning/design/DESIGN.md`
  (references, tokens, components, page templates). `gsd-ui design` makes the
  stub.
- **Layout, per phase with screens:** before the UI-SPEC, `/gsd-sketch` the main
  screen, the user picks the winner, and `<P>-LAYOUT.md` records it with the
  pages. `gsd-ui layout <N>` makes the template.
- **Screenshots before ui-review:** `gsd-ui shots <N>` shoots every page at
  phone, tablet and desktop size with the Playwright CLI; ui-review compares
  them with the sketch. `--skip "<reason>"` when it is impossible.
- `gsd-flow-next` has the new steps: design-system, layout, screenshots.
  Phases whose UI-SPEC already exists skip the two pre-spec steps.
- `ui_gates` in `.gsd.conf`: `warn` (default — steps and doctor notes),
  `strict` (the guard blocks `/gsd-ui-phase` and `/gsd-ui-review` until done;
  doctor T080), `off`. `gsd-init --no-ui` sets `off` for projects without
  screens.
- `ui_url` in `.gsd.conf` for the app address; `{port}` follows each
  worktree's port.
- `gsd-init` prints optional tools per provider (Claude: `frontend-design`
  plugin, Playwright MCP).
- The e2e suite no longer reads the laptop's installed skills.

## 0.2.3

`gsd-doctor` checks more (all read-only, as before):

- Toolkit: GSD's `gsd-sdk` missing (T005), `perl` missing (T006), installed
  skills that differ from this version (T007, for every configured provider).
- `.gsd.conf`: unknown keys and lines that are not `key = value` (T017), bad
  `flow` / `flow_since` / `start_mode` values (T018).
- Base branch missing, or only on origin (T015). No `origin` is a note.
- Pre-merge gate: script not executable, or a configured path that does not
  exist (T019).
- ROADMAP with two headings for one phase (T025). Without perl the roadmap row
  check says it was skipped instead of passing.
- A worktree whose dependency install failed (T032).
- `tracker = clickup` with no token on this machine (T073).
- Fix lines name the right reinstall command for a release install
  (`get.sh --version X --reuse-install-config`) or a git checkout.
- `install.sh --reuse-install-config --agent <p>` now adds `<p>` to the agents
  recorded by the last install instead of ignoring it.

## 0.2.2

Same as 0.2.1, which was tagged but never released (a test needed a command on
PATH that CI does not have):

- `gsd-doctor` shows newer versions (gsd-worktrees and GSD itself) even with
  `--quiet`, and lists them under `updates` in `--json`. Still never a finding.
- `gsd-start`, `gsd-list` and now `gsd-init` also tell you about a newer GSD on
  npm, not only a newer gsd-worktrees (terminal only, checked once a day).

## 0.2.0

- **Install from GitHub releases.** One `curl … get.sh | bash` line; no git
  checkout needed. `gsd-update` installs newer releases (or an older one with
  `--version`). `gsd-start`, `gsd-list` and `gsd-doctor` say when a newer
  release is out (at most one GitHub call a day; `GSD_NO_UPDATE_CHECK=1` turns
  it off).
- **Tickets from any tracker.** `gsd-tracker` with `tracker = none` (default),
  `clickup`, or `custom` (your script). `gsd-start --ticket <id|url>` tags the
  phase `tk-<id>`; the flow's `ticket` step saves `<P>-TICKET.md`.
  `--cu`, `cu_` tags, `STORY.md` and `gsd-clickup` still work.
- **Any AI agent.** Claude Code, Codex, Gemini and custom agents as adapters;
  hand one phase between them with `gsd-start -p N --provider X`.
- **Safer claims.** The claim race is decided on origin before merging; a claim
  writes its checklist and Progress rows and correct STATE counters; zero-padded
  decimal phases (`02.1`) work everywhere.
- MIT license.
- Fixes from two full reviews (docs/fix-plan.md), an end-to-end test suite, and
  `gsd-list` that honors `COLUMNS`.

## 0.1.0

- First tagged version: per-phase worktrees, `gsd-start` / `gsd-finish` /
  `gsd-list` / `gsd-doctor`, the `.planning` merge driver, and the guard.
