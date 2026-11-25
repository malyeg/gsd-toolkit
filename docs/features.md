# Feature list

Everything the toolkit does, by area. Each line names where it lives.
Flags and config keys are complete as of 2026-09-25; `<cmd> --help` is authoritative.

## 1. Repo setup

| Feature | Where |
|---|---|
| One-command setup of a repo from zero: bootstrap, then open the `/gsd-new-project` or `/gsd-ingest-docs` session (the default in a terminal; `--no-launch` prints it), and when it closes check that `.planning/ROADMAP.md` exists (exit 1 if not, "run gsdt-init again") | `gsdt-init` |
| Auto-picks new-project vs ingest by scanning for ADR/PRD/RFC/spec/architecture docs (`--new` / `--ingest` force it) | `gsdt-init` |
| Idempotent re-run: with an existing `.planning/ROADMAP.md` it only repairs workflow files, never planning state | `gsdt-init` |
| Writes `.gsd.conf` (base, wtdir, install, providers, per-provider commands); migrates legacy `provider` / `agent_command` keys | `gsdt-bootstrap-repo` |
| Installs the frozen shims into `scripts/` and `scripts/hooks/`, self-checked with `sh -n` (Git for Windows' `sh` on Windows) | `gsdt-bootstrap-repo` |
| Generated instructions: a small canonical `.gsd/INSTRUCTIONS.md` (repo values, a core that holds without the toolkit, a pointer to `gsdt-rules`) + marked entrypoints in `CLAUDE.md` / `AGENTS.md`; text outside markers preserved; markers validated before any write | `gsdt-bootstrap-repo`, `src/provider.ts` |
| The workflow rules come from the installed toolkit: `gsdt-rules` prints them (+ the repo's values; the screens paragraph unless `ui_gates = off`), so an update changes them in every repo with no step there. Claude loads them with a user-level `SessionStart` hook (`gsdt-rules --hook`: startup, resume, `/clear`, compaction; nothing outside a set-up repo); Codex/custom run it from the `AGENTS.md` line | `gsdt-rules`, `src/commands/setup.ts`, `src/provider.ts` (`rulesText`) |
| Registers native guard hooks (Claude `.claude/settings.json`), merged natively with the python-exact JSON writer (no `jq`) | `gsdt-bootstrap-repo` |
| `.planning` merge safety: `.gitattributes` `merge=gsd-planning`, driver registration in git config, `post-merge` hook (husky-aware) | `src/common.ts` (`planningStatus` / `planningApply`) |
| `--commit` stages only installed files; skipped if the repo was already dirty | `gsdt-bootstrap-repo` |

## 2. Starting work

| Feature | Where |
|---|---|
| Before a phase: an idea, a rough requirement or a thin ticket (words, a ticket id or URL) is talked through and sorted (drop, later, small job, one phase, several); only after the user's yes a ticket is created or completed (text someone else wrote is never removed) and the `gsdt-start` line printed. Claims nothing, writes nothing to the repo | `skills/gsdt-idea` |
| Claim a new phase in one step: claim → push → worktree → session (`-n "desc"`; a bare description is refused) | `gsdt-start` |
| Attach to an existing phase, reusing its worktree (`-p N`, idempotent) | `gsdt-start` |
| Claim a decimal hotfix phase (`--insert N`) | `gsdt-start` |
| Deterministic claim via `gsd_run query phase.add` / `phase.insert` (gsd-core; no LLM call) | `gsdt-start` |
| Parallel-safe claim: pull, push with rebase-and-retry, auto-renumber the loser | `gsdt-start` |
| Duplicate-description guard (case-insensitive) | `gsdt-start` |
| Claim bookkeeping: checklist + Progress rows and STATE.md counters land in the claim commit | `gsdt-start`, `src/roadmap.ts` |
| TDD by default: the claim commit sets `workflow.tdd_mode: true` in `.planning/config.json` when the key is unset (a project's own `false` is kept), so plans list their test cases for the plan review | `gsdt-start` |
| Start from the ticket alone: `gsdt-start --ticket <id|url>` (no `-n`) names the new phase after the ticket's title, read through `gsdt-tracker snapshot` before anything is claimed; a ticket that cannot be read, or no tracker set, claims nothing and names the fix; `--insert <N> --ticket …` works the same | `gsdt-start`, `src/ticket.ts` (`ticketTitle`) |
| Ticket link (`--ticket <id|url>`, old `--cu`): `tk-<id>` at the end of title/slug, duplicate-ticket guard, ticket → "in progress" when a tracker is set. With a tracker set a new claim needs a ticket (`--no-ticket` to skip); `gsdt-init` asks for the tracker (`--tracker`) | `gsdt-start`, `gsdt-tracker` |
| Opens the session in the worktree by default (in a terminal); `--no-launch` prints the command instead, as does a run with no terminal | `gsdt-start` |
| `--flow` / `--no-flow` / `start_mode`: resume the full flow (default), or open discuss-phase only | `gsdt-start`, `src/provider.ts` |
| `compact_at` (default 300000 tokens): launched Claude/Codex sessions compact early instead of re-sending a near-full window every turn; the phase worktree's `.claude/settings.local.json` carries it for a plain `claude` | `gsdt-start`, `gsdt-init`, `src/provider.ts` (`compactResolve`, `compactSettings`), `src/claude-settings.ts` |
| A launched Claude session has a name and Remote Control: `claude --name <prefix>-<N>-<slug> --remote-control <name>` (no `/rename`, no `/rc`); prefix = `session_prefix`, else the repo folder; `session_name = off` / `remote_control = off` (env `GSD_SESSION_NAME`, `GSD_REMOTE_CONTROL`); also `gsdt-init` (`<prefix>-planning`) and `gsdt-batch` | `gsdt-start`, `gsdt-init`, `gsdt-batch`, `src/provider.ts` (`sessionResolve`, `providerArgv`) |
| Guard check before a session is printed or launched | `gsdt-start` |
| Worktree creation off the base branch, `phase-<N>-<slug>`; reuse if it exists | `gsdt-wt-new` |
| Copies gitignored local files into the worktree: `.mcp.json`, `.claude/settings.local.json`, and the env files migrations and tests need — `.env` / `.env.<x>` in any folder where every part is `local`, `dev`, `develop`, `development`, `e2e` or `test` (never prod/production/staging/…: listed as not copied); `copy_files` in `.gsd.conf` adds files or turns env copying off (`none`); reusing a worktree fills in what it lacks, never overwrites | `gsdt-wt-new`, `src/local-files.ts` |
| Sets gsd-core's `worktree.baseRef = "head"` in each worktree's (and the main checkout's) gitignored `.claude/settings.local.json`, keeping its other keys, so `/gsd-execute-phase` runs a wave's plans in parallel — without it gsd-core's base-check sees the phase branch ahead of `origin/HEAD` and runs them one at a time. A different value you set is kept; a tracked or non-JSON file is left alone, with a note | `gsdt-wt-new`, `gsdt-bootstrap-repo`, `src/common.ts` (`baseref`) |
| Dependency install in background / foreground / none, with `.gsd-install.status` + `.gsd-install.log` | `gsdt-wt-new`, `src/common.ts` (`installCmd`) |
| Per-worktree dev port: base + phase number | `gsdt-derive-port` |

## 3. Finishing work

| Feature | Where |
|---|---|
| Finish from anywhere: no argument inside the worktree, `<N>` / `phase-N-slug` elsewhere, `--repo` outside | `gsdt-finish` |
| Land a `gsdt-batch` worktree: `gsdt-finish batch-…` (or no argument inside it; `--pr` too) — same tests → merge → repair → push → cleanup, no UI / test-audit gates, no ticket | `gsdt-finish`, `gsdt-wt-finish` |
| Auto-returns a clean main checkout to the base branch; safe to run inside the worktree being removed | `gsdt-finish` |
| Sync base with origin first; abort (worktree kept) if that fails | `gsdt-wt-finish` |
| Validation before merge and on the combined tree after: `scripts/gsdt-premerge-check.sh` (or `premerge =`), else the project's tests (`test =` or detection: xcodebuild / make / just / cargo / go / npm / pytest) | `gsdt-wt-finish`, `src/common.ts` (`testCmd`) |
| `--no-ff` merge; a conflict aborts and leaves the base branch clean with resolution steps | `gsdt-wt-finish` |
| Planning repair after every merge point; never pushes contradictory `.planning` | `gsdt-wt-finish` |
| Push with up to 3 retries (pull + repair + re-validate between) | `gsdt-wt-finish` |
| Removes worktree + branch; ticket → "in testing" when a tracker is set (also on `--pr`) | `gsdt-wt-finish`, `gsdt-finish`, `gsdt-tracker` |
| `--pr [--draft]`: push (prefers the `*-pr` branch) and open a GitHub PR instead of merging | `gsdt-finish` |
| UI gate for a phase with screens: the check of the rendered pages, the look file and the user's approval must be current. `ui_gates = strict` refuses (nothing merged, no PR), `warn` prints a warning; `GSD_SKIP_GUARD=1` escapes | `gsdt-wt-finish`, `gsdt-finish`, `src/ui.ts` (`uiFinishGate`) |
| Test-audit gate: with `flow = strict`, a phase whose `<P>-VALIDATION.md` is missing or still the plan's draft is refused (nothing merged, no PR); `GSD_SKIP_GUARD=1` escapes | `gsdt-wt-finish`, `gsdt-finish`, `src/common.ts` (`flowFinishGate`) |
| Post-finish warning if the roadmap ticks look wrong | `gsdt-finish` |

## 4. Planning-file integrity

| Feature | Where |
|---|---|
| Git merge driver: union, then reconcile single-value lines | `gsdt-planning-merge`, `src/planning.ts (reconcile)` |
| Keyed lines keep first position + best content (`[x]` beats `[ ]`, real status beats "Not started", longer wins) | `src/planning.ts` |
| Section-scoped dedupe; STATE.md `## Session Continuity` never touched | `src/planning.ts` |
| Counter recompute from ground truth (ROADMAP headings/checklist, `*-PLAN.md`, `*-SUMMARY.md`) | `gsdt-planning-repair`, `src/planning.ts (repair)` |
| `--check` CI guard (fails on merge damage; drift is advisory) / `--commit` | `gsdt-planning-repair` |
| Without a usable Node (>= 24) the driver does the plain union and warns (`gsdt-planning-repair` fixes the counters later) | `gsdt-planning-merge` |
| Audit for two upstream `gsd_run` (gsd-core) bugs: missing checklist row, tick landing on the wrong phase | `src/roadmap.ts` |

## 5. Enforcement (the guard)

| Feature | Where |
|---|---|
| Provider-neutral guard API: `--command --args --phase --repo` | `gsdt-worktree-guard` |
| Rule 0b (set-up repos): `/gsd-autonomous`, `/gsd-manager`, `/gsd-workspace`, `/gsd-workstreams`, `/gsd-phase` add / `--insert` / `--remove` are blocked, naming the toolkit command to use; `/gsd-phase --edit` passes | `gsdt-worktree-guard` |
| Rule 1: `/gsd-phase` only on the base branch | `gsdt-worktree-guard` |
| Rule 2: per-phase commands only inside the matching `phase-<N>-*` worktree (nested agent worktrees inherit identity); one exception: `/gsd-verify-work <N>` runs on the base branch when phase N is merged (no branch), every plan ran and its row is not ticked (doctor T027) | `gsdt-worktree-guard` |
| Rule 3: `/gsd-execute-phase` blocked while the install is `running` / `fail` | `gsdt-worktree-guard` |
| Rule 4 (`flow = strict`): plan needs CONTEXT, execute needs REVIEWS, secure needs REVIEW (+ UI-REVIEW when a UI-SPEC exists) and the test audit (`<P>-VALIDATION.md` compliant or audited); `--prd` / `--gaps-only` exemptions | `gsdt-worktree-guard` |
| Rule 5 (`ui_gates = strict`): ui-phase needs a filled DESIGN.md + a LAYOUT with a chosen sketch and pages; ui-review needs a passed, current UI check, a complete look file and the user's approval (a phase whose UI review is already on the base branch is exempt) | `gsdt-worktree-guard`, `src/ui.ts` (`uiGate`) |
| Native hooks: Claude `UserPromptExpansion` + `PreToolUse(Skill)` (skill calls and typed slash commands; the plugin form `gsd-core:gsd-plan-phase` counts as `gsd-plan-phase`) | `gsdt-worktree-guard`, `src/guard.ts` |
| Rule 0: `/gsd-new-project` / `/gsd-ingest-docs` only in a repo `gsdt-init` set up (`.gsd.conf`). Enforced by a user-level hook `gsdt-setup` adds to `~/.claude/settings.json` (`PreToolUse(Skill)` + `UserPromptExpansion`): `gsdt-worktree-guard --global` applies rule 0 only in a repo the toolkit has not set up — a `.gsd.conf` with only `tracker*` keys does not count (every rule in a set-up repo, where it is the only hook that sees typed slash commands) and fails open on an unreadable payload. `--no-user-hook` opts out of it and of the `gsdt-rules` session hook (remembered); Codex: the skill's written rule only | `gsdt-setup`, `gsdt-worktree-guard`, `skills/gsdt-worktrees` |
| Hook JSON parsed natively (no `jq`, no Python) | `src/guard.ts` |
| Escape hatch `GSD_SKIP_GUARD=1`; shim fails open when the toolkit is not installed | `gsdt-worktree-guard`, `shims/` |

## 6. Phase flow

| Feature | Where |
|---|---|
| Resumable step engine: ticket (only with a tracker) → discuss → ui-decision → design-system → layout → ui-phase → plan → review → replan → execute → verifier → gaps → verify-work → code-review → ui-check → ui-look → ui-approve → ui-review → validate → secure → done | `gsdt-flow-next` |
| Reads artifacts only, so it survives crashes and `/clear` | `gsdt-flow-next` |
| Detects an unfolded review (`replan`) from commit times of REVIEWS vs PLAN | `gsdt-flow-next` |
| `--all` preview, `--json`, `--ui` / `--no-ui` | `gsdt-flow-next` |
| Guard check before every step it returns | `gsdt-flow-next` |
| Configurable cross-AI reviewer (`review_provider`, default `codex`) | `gsdt-flow-next`, `src/provider.ts` |
| A `REVIEWS.md` whose configured reviewer failed (empty section, Codex usage limit) passes neither the review step nor the guard's execute rule | `gsdt-flow-next`, `gsdt-worktree-guard`, `src/common.ts` (`reviewsProblem`; gsd-core reviewer-instance headings such as `## Codex Review (fast)` count) |
| Wait out a Codex usage limit: wrap a command (re-run after the reset) or `--wait-only`; reset time from Codex's message or session log, `--interval` fallback, `--max-wait` cap (exit 75, never a pass); never calls Codex; keeps a Mac awake | `gsdt-codex-wait`, `src/codex-wait.ts` |
| How to ask the user, in the rules every session loads and in the flow skill: one question at a time in plain words, at most three options, the recommended one first with its reason, what each choice changes, a costly or irreversible choice said plainly, everything inside the question | `gsdt-rules` (`RULES_ASKING` in `src/rules-text.ts`), `skills/gsdt-flow` |
| Agent-facing driver skill with human stop points (discuss, design system + sketch, screens, review, UI approval) | `skills/gsdt-flow` |
| Discuss starts from the saved ticket (`<P>-TICKET.md`): its scope is carried in and not asked again | `skills/gsdt-flow` |
| Doctor report of merged phases that skipped a mandatory step (T040: flow steps with `flow = strict`, `ui-check` / `ui-approve` with `ui_gates = strict`; `flow_since` cutoff, `flow_skip` single phases shown as a note) | `gsdt-doctor` |

## 6b. UI quality gates ([ui-quality-plan.md](ui-quality-plan.md))

| Feature | Where |
|---|---|
| One design system per project: `.planning/design/DESIGN.md` (stub marker until filled) + `refs/` | `gsdt-ui design`, `src/ui.ts` |
| Per phase with screens: `<P>-LAYOUT.md` — chosen `/gsd-sketch` (`sketch:`, winner read from the sketch README) + `pages:`; `sketch: skip <reason>` | `gsdt-ui layout`, `gsdt-flow-next` |
| **Check of the rendered pages** ([plan-ui-check.md](plan-ui-check.md)): every `pages:` entry at 375 / 768 / 1440 px in the project's own Playwright; writes `<P>-UI-CHECK.md`, the pictures and a sheet (`<P>-SHOTS/index.html`, not committed). Exit 0 passed / 1 failed / 2 could not run; `--skip "<reason>"` | `gsdt-ui check`, `src/ui-check.ts` |
| Checks: C1 sideways scroll, C2 possible clipped text (a question), C3 contrast (pinned axe-core; "could not measure" = a question), C4 text under `ui_min_font`, C5 broken `<img>`, C6 uncaught page errors (console errors are listed), C7 the page's main button (one match, on the first screen, not covered), C8 failed load / another page / missing `expect:` text | `src/ui-check.ts`, `lib/vendor/axe-core/` |
| Per page in `<P>-LAYOUT.md`: `main_button:` (text, `css=<selector>`, `none`), `expect:`; `app:` = the folder with Playwright; `waive: <check> \| <page> \| <width> \| <target> \| <reason>` lists a finding without counting it. A page without `main_button:` is "not checked" — a failure under `strict` | `gsdt-ui check` |
| Playwright lookup with `createRequire`: `GSD_PLAYWRIGHT_ROOT`, `app:`, the repo root, `apps/*` and `packages/*`, then the global npm folder (`npm i -g playwright`, once per machine; `GSD_NPM_GLOBAL_ROOT` overrides); several installs and no `app:` → refuses. Never loads a Playwright config | `src/ui-check.ts`, `src/ui.ts` (`uiGlobalRoot`) |
| One run = one capture (id = hash of the pictures). `<P>-UI-CHECK.md` also records a hash of the code outside `.planning/` and of `<P>-LAYOUT.md`; a later change to either makes the check stale. Same pictures → same id, so look and approval stay valid | `src/ui.ts` (`uiInputsState`, `uiCheckState`) |
| Staged output: a run that cannot finish records `status: error` and removes the old pictures — an old pass never stays | `gsdt-ui check` |
| Look file `<P>-UI-LOOK.md`: one answer (`ok` / `fixed` / `bad` / `n/a` + text) per picture and layout rule (R1–R10, or the project's `- R<n>:` lines in DESIGN.md) and per question; the expected set comes from the check, not the look file | `gsdt-ui look`, `src/ui.ts` (`uiLookState`) |
| Approval `<P>-UI-APPROVAL.md` names the capture; `--waive "<reason>"` records that the user chose not to look | `gsdt-ui approve`, `gsdt-ui sheet` |
| Screenshots only, with the Playwright CLI (no checks), recorded in `<P>-SHOTS.md`; `--skip "<reason>"` | `gsdt-ui shots` |
| App address: `url:` in `<P>-LAYOUT.md` (per phase — projects with several apps), else `ui_url` in `.gsd.conf`, else `http://localhost:{port}`; `{port}` = the phase's derived port, base from the `gsdt-derive-port.sh <base>` dev script or `{port:<base>}` | `gsdt-ui check`, `gsdt-ui shots` |
| `ui_gates = warn` (default: flow steps, a warning at finish, doctor notes) / `strict` (guard blocks ui-phase and ui-review, finish refuses, doctor T080 / T081 / T040 `ui-check`, `ui-approve`) / `off` | `src/ui.ts`, guard, finish, doctor |
| `gsdt-init --no-ui` for projects without screens (`ui_gates = off`) | `gsdt-init`, `gsdt-bootstrap-repo` |
| Optional provider tools printed by `gsdt-init` (Claude: `frontend-design` plugin, Playwright MCP) — never required | `src/provider.ts` |

## 7. AI providers

| Feature | Where |
|---|---|
| Providers: `claude`, `codex`, `custom` (`gemini` is refused with a reason; `gsdt-init --no-launch` removes an older release's Gemini setup); ordered `providers =` list, first is default | `src/provider.ts` |
| Precedence chains for provider, executable, model, start mode (CLI > env > repo > legacy > default) | `src/provider.ts` |
| Safe argv rendering (arrays, no `eval`); positional prompts | `src/provider.ts` |
| Per-session model (`--model`, `GSD_MODEL`, `GSD_<P>_MODEL`, `<p>_model`, `default`) | `src/provider.ts` |
| Sequential cross-provider handoff on one phase (`gsdt-start -p N --provider X`) | `gsdt-start` |
| Skills installed per agent (`gsdt-setup --agent …` / `--all-agents`) | `src/commands/setup.ts`, `src/provider.ts` |

## 8. Visibility and diagnostics

| Feature | Where |
|---|---|
| Phase table: number, title, plans done/total, stage (`verify` once every plan ran but the ROADMAP checklist row is not ticked yet — `/gsd-verify-work` ticks it; `done` only when ticked, also for a phase with no plan files: work done outside GSD), worktree; wraps to the terminal (`--compact` for one line); under it, the `batch-*` branches not landed yet (● = worktree attached), then how many gsd-core todos wait in `.planning/todos/pending` | `gsdt-list` |
| Archived milestones (what `/gsd-complete-milestone` moved to `.planning/milestones/`): `--milestones` = one line each, oldest first (version, name and shipped date from `MILESTONES.md`, phase count), then the current milestone (STATE.md's `milestone:`, named by ROADMAP's `**v1.1 <name>**` bullet; SHIPPED = `current`; left out when that version is already archived); `--milestone <v>` = that milestone's phase table from `<v>-ROADMAP.md` (only the phases under its `## v<version>` sections when it has them: gsd-core copies the whole ROADMAP) and `<v>-phases/`, no worktree column data; the current milestone's version gives the usual table | `gsdt-list` |
| Read-only health check, every finding names its fix command; the default output is findings, updates, notes that point at something to do here and one `✔ N checks passed` line; `--verbose` lists every passed check and the optional tips (the old full report); `--quiet` is an accepted no-op; `--json` | `gsdt-doctor` |
| `--fix` (asks y/N, `--yes` for scripts): runs only the safe fixes — `git worktree prune` (W027, shown first: only records whose folder is already gone), gsdt-init (T010–T014, T016, T052, T058), gsdt-planning-repair (T020, stale counters), `git branch --track` (T015), `chmod +x` pre-merge (T019), dead lock (T030), `worktree.baseRef = "head"` (T034) — then checks again; never commits | `gsdt-doctor` |
| Finding codes: T001–T009 toolkit (incl. T005 no gsd-core, T007 stale skills, T009 a gsd-core skill the phase flow runs is missing (a set trimmed with `/gsd-surface` passes while they are there; the profile name decides only where the skills are not found), T008 a GSD hook runs a file that is gone, e.g. a node path an nvm/Volta/fnm upgrade moved; the fix is to re-run the gsd-core installer — also a one-line warning in `gsdt-start`/`gsdt-list`), T010–T019 repo setup (T015 base branch, T016 instructions older than the toolkit, T017 unknown `.gsd.conf` key, T018 bad value, T019 pre-merge gate), T020–T027 planning (T025 duplicate phase heading, T026 `phase_id_convention: bracket` is unsupported, T027 a merged phase whose plans all ran but whose checklist row is not ticked: never marked complete — a warning (⚠, one line for all such phases, `warnings` in `--json`; not a finding, so the exit status stays 0), e.g. verification left `human_needed`; `gsdt-finish` warns before the merge and again after it, and `gsdt-list` shows the phase as `verify`; T028 planning files over `planning_max_kib` (default 64 KiB): a warning, a finding with `planning_size = strict`, which also makes `gsdt-start` refuse a new phase; `gsdt-start` and `gsdt-flow-next` print the same warning on stderr), T030–T034 hygiene (T032 failed worktree install, T033 a lock with no pid — never removed for you, T035 a phase or batch worktree lacks an env file (or a `copy_files` file) the main checkout has: a warning, fix `gsdt-start -p <N> --no-launch`, T034 `worktree.baseRef` not `"head"` in the main checkout or a phase or batch worktree, so a wave's plans (a batch's items) run one at a time), T040 flow debt, T050–T062 providers (T061 Gemini setup left from an older release, T062 Claude sessions cannot load `gsdt-rules`: not on PATH or no user `SessionStart` hook; a note after `--no-user-hook`), T070–T073 tracker (T073 no ClickUp token), T080 no design system and T081 committed pictures (`ui_gates = strict`; notes otherwise), T090 old `gsd-*` command names (before 0.10.0; fix `gsdt-migrate --apply`), W017 (a phase or batch branch with no worktree) / W027 shared with `/gsd-health` | `gsdt-doctor` |
| `--json` lists the notes too (`"notes"`) and the safe fixes (`"safe"`) | `gsdt-doctor` |
| A desktop notification when a Claude session in a set-up repo waits for you: a question (`AskUserQuestion`), a permission prompt, or a minute idle — a user-level hook (`Notification`, `PreToolUse(AskUserQuestion)`) from `gsdt-setup`; the title names the repo and the worktree; one per session in 5 s; macOS `osascript`, Linux `notify-send`, Windows nothing yet; silent and exit 0 whatever happens; `GSD_NOTIFY=off`; `gsdt-notify "<text>"` shows one by hand | `gsdt-notify`, `src/commands/notify.ts`, `src/commands/setup.ts` |
| `--all [<folder>...]` (same as `gsdt-repos`): one line per GSD repo — `ok` or the finding codes — for the repos in `~/.config/gsd/repos` (added by `gsdt-init`, `gsdt-bootstrap-repo`, `gsdt-start`, `gsdt-finish`) plus those found under each folder; read-only (never writes that list), no version check, no `--fix`; exit 1 if any repo has findings; `--json` | `gsdt-doctor`, `gsdt-repos` |
| Context section (notes, never findings): what gsd-core's skill and agent descriptions cost every session (the skill groups the flow never runs are in `--json` only: hiding them saves too little to suggest); `ROADMAP.md` / `REQUIREMENTS.md` / `STATE.md` / `PROJECT.md` over 32 KiB (`/gsd-complete-milestone`); a Codex `AGENTS.md` over 32 KiB; a pointer to Claude's `/doctor`, `/skill-doctor`, `/context`. `--json`: `context` | `gsdt-doctor`, `src/context.ts` |
| Agent skill: run `gsdt-doctor --json` and fix what it finds, one item at a time on the user's yes (safe fixes, `gsd-complete-milestone` once a milestone shipped; it does not offer to hide skill groups). With Claude it also runs `claude -p "/skill-doctor"` and `claude -p "/context"` (free) and, last and only on a yes, `claude -p "/doctor"`, which applies its own fixes | `skills/gsdt-doctor` |
| Optional add-on notes for projects with screens, per provider and stack (files only): Impeccable design skill; shadcn MCP for Tailwind / shadcn | `gsdt-doctor`, `src/ui.ts` (`uiStack`), `src/provider.ts` (`providerUiAddon`) |
| Checks for a newer GSD on npm and branches whose upstream is gone | `gsdt-doctor` |
| Several quick tasks at once, cheaper than `/gsd-quick-batch`: takes its task list (inline or `--file`) or any brief in plain words — then ONE Opus helper does the brief's checks first (validate, write the tables it names) and splits it into build / recommend-only / later / dropped; before it lands, the later items are filed (phase-sized → `/gsd-capture --backlog`, small → a todo) and the owner calls go in one todo, each with the decided rule word for word; for a plain list ONE Sonnet helper scouts each item's likely files, test and "done when"; tiny items (gsd-fast's limits) run last via `gsd-fast`, real ones via `gsd-quick-batch --file .planning/batch-inputs/<date>-<slug>.md` (1 item: `gsd-quick`); shows the sorted list and goes on without asking (`--confirm` = wait for the user's OK first); refuses a dirty tree; ends with the line `gsdt-batch: done items=N real=N tiny=N` and `gsdt-batch-report` | `skills/gsdt-batch` |
| Start that batch in a FRESH session; on Claude on Sonnet (`--model` to change): `claude --model sonnet "/gsdt-batch …"`; `--advisor <m>` (Claude only, experimental) adds `claude --advisor <m>`: a stronger model the session asks for advice at hard spots; other providers launch with their usual model; `--print` | `gsdt-batch`, `src/provider.ts` (`providerPrompt … batch`) |
| The batch runs in its OWN worktree: `batch-<date>-<slug>` off the base branch (slug from the list, the `--file` name or `--name`; a taken derived name gets `-2`; run inside a `batch-*` worktree it uses that one), with the phase worktree's setup (local config, `worktree.baseRef = "head"`, install); `--file` made absolute (a committed file: the worktree's copy); refuses when `.planning/` is not committed; `/gsdt-batch` in the main checkout stops and prints the `gsdt-batch` command | `gsdt-batch`, `gsdt-wt-new --batch`, `skills/gsdt-batch` |
| Claude Code mod: while `/gsdt-batch` runs, the main session's requests go to Sonnet, subagents keep theirs; off at the done line, a cancelled turn, session end or `/gsdt-batch-off`; status line `batch: sonnet`. Not installed yet: `claude --plugin-dir mods/gsdt-batch-sonnet` | `mods/gsdt-batch-sonnet` |
| Token report for quick-task batches (`/gsd-quick-batch`, `/gsdt-batch`) from Claude Code transcripts: from the batch's start to its end (not the whole session), per role (agent type × model): agents, turns, Bash calls per helper, fresh input / cache write / cache read, output, a cache-weighted input; per item next to the baseline or a saved `--json` run (`--baseline`); `--last` / `--days` / `--session`; never prints transcript text; Codex: "not supported yet" | `gsdt-batch-report`, `src/batch-report.ts` |

## 9. Install and maintenance

| Feature | Where |
|---|---|
| Install: `install.sh` downloads the GitHub release's `.tgz` + `SHA256SUMS`, verifies, `npm install -g`, then `gsdt-setup` (Node >= 24; npm makes the commands, with Windows wrappers); a 0.10.x install moves over through `lib/install.sh` (the bridge) | `install.sh`, `lib/install.sh`, `package.json` `bin`, `tools/build.mjs` |
| `gsdt-setup [--agent claude\|codex]... [--all-agents] [--no-user-hook] [--no-core]`: copies the skills into each agent's skill folder (marked as the toolkit's, replaced in place), registers the two Claude user hooks, installs gsd-core for an agent that has none, records the agents in `~/.config/gsd/setup-manifest` (the next run keeps them) | `src/commands/setup.ts` |
| Moves a 0.10.x release install off the machine: removes the old `~/.local/bin` links and `~/.local/share/gsd-toolkit`, and rewrites the user hooks to the npm path | `src/commands/setup.ts` |
| Update / go back: `gsdt-update [--check \| --version X.Y.Z \| --no-core]`; as the npm package it downloads the release's `.tgz` (checked against `SHA256SUMS`), runs `npm install -g` on it and the new version's `gsdt-setup --no-core`, then brings gsd-core to its latest for each installed agent. A git checkout updates nothing | `src/commands/update.ts`, `src/core.ts` |
| Install mode is detected: checkout (`.git`), 0.10.x release runtime (`install.sh`), or npm | `src/version.ts` (`installMode`) |
| Commands are `gsdt-*` since 0.10.0 (`gsd-*` is gsd-core's): `gsdt-migrate` (dry run / `--apply` / `--check`) moves a repo's shims, pre-merge script, path references, repo hook, marked blocks and this clone's driver, tracker section and post-merge hook; `--apply` then offers to commit the repo files it changed (`--commit` = yes); start/finish/flow-next/init refuse an unmigrated repo; doctor T090 (`--fix` runs it) | `gsdt-migrate`, `migrateNeeded` (`src/common.ts`) |
| "Newer version" notice for gsd-toolkit and gsd-core (npm) in `gsdt-start` / `gsdt-list` / `gsdt-init` (terminal only) and `gsdt-doctor` (also in the default output, `updates` in `--json`); day-long cache, background refresh; `GSD_NO_UPDATE_CHECK=1` | `src/version.ts`, `gsdt-doctor` |
| Install removes a toolkit skill no longer shipped (renamed or retired) | `src/commands/setup.ts` |
| Windows without WSL: Git for Windows' `sh` runs the shims, hooks, merge driver and the pre-merge script; commands run through Node, paths are normalized, no exec bit is needed | `src/spawn.ts`, `tests/os/` |
| Releases (0.10.x, frozen): a push that changes `VERSION` → check → tests → tag + tarball + `SHA256SUMS` → GitHub release; `install.sh` / `lib/install.sh` install it. 1.0.0 onwards is npm (see [releases.md](releases.md)) | `.github/workflows/release.yml`, `tools/release-check.sh`, `tools/release.sh`, `install.sh` |

## 10. Tickets and trackers ([trackers.md](trackers.md))

| Feature | Where |
|---|---|
| `start` / `finish` / `comment` / `status` / `snapshot [--out]` / `extract` / `check` / `which` | `gsdt-tracker` |
| `tracker = none` (default in a GSD repo) / `clickup` / `custom`; settings from env > git config `gsdt-tracker.*` > `.gsd.conf`; `gsdt-tracker config` shows them | `gsdt-tracker`, `src/tracker/config.ts` |
| Standalone: `gsdt-tracker` works in any folder and uses no GSD code; GSD runs it as a command | `bin/gsdt-tracker`, `src/tracker/` |
| Id parsing: bare, `tk-<id>`, `#<id>`, URL; tags read back from title, then branch | `src/ticket.ts`, `src/tracker/ids.ts` |
| Status names from `tracker_status_start` / `_finish` (env `GSD_TRACKER_STATUS_*` wins) | `gsdt-tracker` |
| A default place for new tickets: `tracker_list` / `git config gsdt-tracker.list` / `GSD_TRACKER_LIST`, printed by `gsdt-tracker config` as `list=` (the `gsdt-idea` skill reads it) | `gsdt-tracker` |
| ClickUp: status matched per list, subtask cascade, idempotent, markdown snapshot; token from `CLICKUP_API_TOKEN`, else `~/.config/gsd/clickup-<profile>.env` with `tracker_profile`, else `~/.config/gsd/clickup.env`; `gsdt-tracker login` (any folder) saves a token — or reuses the saved one — and sets `git config gsdt-tracker.profile` in one step | `src/tracker/clickup.ts` |
| Custom: `tracker_command` gets `start` / `finish` / `comment` / `status` / `snapshot` / `check` + `<id> [text]` | `src/tracker/custom.ts` |
| Snapshot `--out` writes only on success (the file marks the flow step done) | `gsdt-tracker` |
| Shared verbs `create` / `update` / `tasks` for every tracker (options passed to the connector; `none` fails them); a connector's own commands via `TRACKER_EXTRA` | `gsdt-tracker` |
| ClickUp connector: `create` / `update` (name, markdown description, assignees by me/id/email/username, status, priority, tags, parent) / `tasks` (filters, `--match` name search); own commands `lists` / `members` / `api` (any v2 call); workspace from `CLICKUP_TEAM_ID` or the token's only one | `src/tracker/clickup.ts` |
| Agent skill: read and write the repo's tickets through `gsdt-tracker` (checks `which` first) | `skills/gsdt-tracker` |
| Install removes a toolkit skill no longer shipped (renamed or retired) | `src/commands/setup.ts` |
| Legacy read-only: `--cu`, `cu_<id>` tags, `STORY.md` | `src/ticket.ts` |

## 11. Source modules (`src/`)

| Module | Provides |
|---|---|
| `src/common.ts` | `.gsd.conf` reader, main-checkout / base / wtdir detection, checkout lock (dead-PID reclaim, re-entrant), merge-driver registration, planning-safety status/apply, install/test command detection, the usable-review test (`reviewsProblem`; gsd-core reviewer-instance headings such as `## Codex Review (fast)` count) |
| `src/provider.ts`, `src/rules-text.ts` | provider identity/validation, instruction file + skill root per provider, native-hook capability + state, resolution chains, argv rendering, owned-marker block helpers; the `gsdt-rules` text |
| `src/planning.ts` | `reconcile` and `repair` engines for ROADMAP.md / STATE.md |
| `src/guard.ts` | the guard's rules, and Claude hook JSON → guard input |
| `src/codex-wait.ts` | Codex usage-limit message parsing and session-log scan, for `gsdt-codex-wait` |
| `src/batch-report.ts` | batch boundaries and token counts from Claude Code transcripts, for `gsdt-batch-report` |
| `src/roadmap.ts` | the read-only ROADMAP bookkeeping audit, and a claimed phase's missing checklist + Progress rows (the ones gsd-core leaves out) |
| `src/version.ts` | this package's version, install mode, version compare, the cached latest-version check and notice |
| `src/core.ts` | installs or updates gsd-core for an agent |
| `src/context.ts` | the doctor's context section (what gsd-core's skills cost every session) |
| `src/hook-paths.ts`, `src/claude-settings.ts` | stale GSD hooks in agents' settings (doctor T008); edits to Claude settings files that keep every other key |
| `src/spawn.ts` | the process and path layer: PATHEXT lookup, `.cmd` and `sh` scripts on Windows, path normalizing |
| `src/ticket.ts` | GSD side of tickets: `tk-<id>` tags (parse, extract, match), `trackerWhich` |
| `src/tracker/` | gsdt-tracker's own settings, id parsing, ClickUp and custom adapters (standalone: imports only `node:*` and each other) |
| `src/ui.ts`, `src/ui-check.ts` | UI gates (`ui_gates`, DESIGN.md / LAYOUT / SHOTS state, sketch winner, Playwright lookup, the DESIGN and LAYOUT templates); the browser runner behind `gsdt-ui check` |
| `src/commands/` | one file per command, each exporting `main(argv)` |
| `src/launch.mjs` | the entry every command goes through: checks Node >= 24, loads the TypeScript (from a checkout) or the compiled `dist/` (from npm) |

The old bash, Python and Perl files are deleted; `lib/install.sh` (the bridge from 0.10.x) and `lib/vendor/` stay (see [architecture.md](architecture.md)).
