# Feature list

Everything the toolkit does, by area. Each line names where it lives.
Flags and config keys are complete as of 2026-09-25; `<cmd> --help` is authoritative.

## 1. Repo setup

| Feature | Where |
|---|---|
| One-command setup of a repo from zero: bootstrap, then open the `/gsd-new-project` or `/gsd-ingest-docs` session (the default in a terminal; `--no-launch` prints it), and when it closes check that `.planning/ROADMAP.md` exists (exit 1 if not, "run gsd-init again") | `gsd-init` |
| Auto-picks new-project vs ingest by scanning for ADR/PRD/RFC/spec/architecture docs (`--new` / `--ingest` force it) | `gsd-init` |
| Idempotent re-run: with an existing `.planning/ROADMAP.md` it only repairs workflow files, never planning state | `gsd-init` |
| Writes `.gsd.conf` (base, wtdir, install, providers, per-provider commands); migrates legacy `provider` / `agent_command` keys | `gsd-bootstrap-repo` |
| Installs the frozen shims into `scripts/` and `scripts/hooks/`, self-checked with `bash -n` | `gsd-bootstrap-repo` |
| Generated instructions: canonical `.gsd/INSTRUCTIONS.md` + marked entrypoints in `CLAUDE.md` / `AGENTS.md`; text outside markers preserved; markers validated before any write | `gsd-bootstrap-repo`, `lib/provider.sh` |
| Registers native guard hooks (Claude `.claude/settings.json`) via a `jq` merge; skips cleanly without `jq` | `gsd-bootstrap-repo` |
| `.planning` merge safety: `.gitattributes` `merge=gsd-planning`, driver registration in git config, `post-merge` hook (husky-aware) | `lib/common.sh` (`gsd_planning_status` / `gsd_planning_apply`) |
| `--commit` stages only installed files; skipped if the repo was already dirty | `gsd-bootstrap-repo` |

## 2. Starting work

| Feature | Where |
|---|---|
| Claim a new phase in one step: claim → push → worktree → session (`-n "desc"`; a bare description is refused) | `gsd-start` |
| Attach to an existing phase, reusing its worktree (`-p N`, idempotent) | `gsd-start` |
| Claim a decimal hotfix phase (`--insert N`) | `gsd-start` |
| Deterministic claim via `gsd_run query phase.add` / `phase.insert` (gsd-core; no LLM call) | `gsd-start` |
| Parallel-safe claim: pull, push with rebase-and-retry, auto-renumber the loser | `gsd-start` |
| Duplicate-description guard (case-insensitive) | `gsd-start` |
| Claim bookkeeping: checklist + Progress rows and STATE.md counters land in the claim commit | `gsd-start`, `lib/roadmap-rows.pl` |
| TDD by default: the claim commit sets `workflow.tdd_mode: true` in `.planning/config.json` when the key is unset (a project's own `false` is kept), so plans list their test cases for the plan review | `gsd-start` |
| Ticket link (`--ticket <id|url>`, old `--cu`): `tk-<id>` at the end of title/slug, duplicate-ticket guard, ticket → "in progress" when a tracker is set. With a tracker set a new claim needs a ticket (`--no-ticket` to skip); `gsd-init` asks for the tracker (`--tracker`) | `gsd-start`, `gsd-tracker` |
| Opens the session in the worktree by default (in a terminal); `--no-launch` prints the command instead, as does a run with no terminal | `gsd-start` |
| `--flow` / `--no-flow` / `start_mode`: resume the full flow (default), or open discuss-phase only | `gsd-start`, `lib/provider.sh` |
| `compact_at` (default 300000 tokens): launched Claude/Codex sessions compact early instead of re-sending a near-full window every turn; the phase worktree's `.claude/settings.local.json` carries it for a plain `claude` | `gsd-start`, `gsd-init`, `lib/provider.sh` (`gsd_compact_resolve`, `gsd_compact_settings`), `lib/gsd_claude_env.py` |
| Guard check before a session is printed or launched | `gsd-start` |
| Worktree creation off the base branch, `phase-<N>-<slug>`; reuse if it exists | `gsd-wt-new` |
| Copies gitignored local config into the worktree (`.env.local`, `.mcp.json`, `.claude/settings.local.json`) | `gsd-wt-new` |
| Sets gsd-core's `worktree.baseRef = "head"` in each worktree's (and the main checkout's) gitignored `.claude/settings.local.json`, keeping its other keys, so `/gsd-execute-phase` runs a wave's plans in parallel — without it gsd-core's base-check sees the phase branch ahead of `origin/HEAD` and runs them one at a time. A different value you set is kept; a tracked or non-JSON file is left alone, with a note | `gsd-wt-new`, `gsd-bootstrap-repo`, `lib/common.sh` (`gsd_baseref`) |
| Dependency install in background / foreground / none, with `.gsd-install.status` + `.gsd-install.log` | `gsd-wt-new`, `lib/common.sh` (`gsd_install_cmd`) |
| Per-worktree dev port: base + phase number | `gsd-derive-port` |

## 3. Finishing work

| Feature | Where |
|---|---|
| Finish from anywhere: no argument inside the worktree, `<N>` / `phase-N-slug` elsewhere, `--repo` outside | `gsd-finish` |
| Auto-returns a clean main checkout to the base branch; safe to run inside the worktree being removed | `gsd-finish` |
| Sync base with origin first; abort (worktree kept) if that fails | `gsd-wt-finish` |
| Validation before merge and on the combined tree after: `scripts/gsd-premerge-check.sh` (or `premerge =`), else the project's tests (`test =` or detection: xcodebuild / make / just / cargo / go / npm / pytest) | `gsd-wt-finish`, `lib/common.sh` (`gsd_test_cmd`) |
| `--no-ff` merge; a conflict aborts and leaves the base branch clean with resolution steps | `gsd-wt-finish` |
| Planning repair after every merge point; never pushes contradictory `.planning` | `gsd-wt-finish` |
| Push with up to 3 retries (pull + repair + re-validate between) | `gsd-wt-finish` |
| Removes worktree + branch; ticket → "in testing" when a tracker is set (also on `--pr`) | `gsd-wt-finish`, `gsd-finish`, `gsd-tracker` |
| `--pr [--draft]`: push (prefers the `*-pr` branch) and open a GitHub PR instead of merging | `gsd-finish` |
| UI gate for a phase with screens: the check of the rendered pages, the look file and the user's approval must be current. `ui_gates = strict` refuses (nothing merged, no PR), `warn` prints a warning; `GSD_SKIP_GUARD=1` escapes | `gsd-wt-finish`, `gsd-finish`, `lib/ui.sh` (`gsd_ui_finish_gate`) |
| Test-audit gate: with `flow = strict`, a phase whose `<P>-VALIDATION.md` is missing or still the plan's draft is refused (nothing merged, no PR); `GSD_SKIP_GUARD=1` escapes | `gsd-wt-finish`, `gsd-finish`, `lib/common.sh` (`gsd_flow_finish_gate`) |
| Post-finish warning if the roadmap ticks look wrong | `gsd-finish` |

## 4. Planning-file integrity

| Feature | Where |
|---|---|
| Git merge driver: union, then reconcile single-value lines | `gsd-planning-merge`, `lib/gsd_planning.py reconcile` |
| Keyed lines keep first position + best content (`[x]` beats `[ ]`, real status beats "Not started", longer wins) | `lib/gsd_planning.py` |
| Section-scoped dedupe; STATE.md `## Session Continuity` never touched | `lib/gsd_planning.py` |
| Counter recompute from ground truth (ROADMAP headings/checklist, `*-PLAN.md`, `*-SUMMARY.md`) | `gsd-planning-repair`, `lib/gsd_planning.py repair` |
| `--check` CI guard (fails on merge damage; drift is advisory) / `--commit` | `gsd-planning-repair` |
| Falls back to plain union with a warning when Python 3.7+ is missing | `gsd-planning-merge`, `lib/common.sh` (`gsd_python`) |
| Audit for two upstream `gsd_run` (gsd-core) bugs: missing checklist row, tick landing on the wrong phase | `lib/roadmap-audit.pl` |

## 5. Enforcement (the guard)

| Feature | Where |
|---|---|
| Provider-neutral guard API: `--command --args --phase --repo` | `gsd-worktree-guard` |
| Rule 0b (set-up repos): `/gsd-autonomous`, `/gsd-manager`, `/gsd-workspace`, `/gsd-workstreams`, `/gsd-phase` add / `--insert` / `--remove` are blocked, naming the toolkit command to use; `/gsd-phase --edit` passes | `gsd-worktree-guard` |
| Rule 1: `/gsd-phase` only on the base branch | `gsd-worktree-guard` |
| Rule 2: per-phase commands only inside the matching `phase-<N>-*` worktree (nested agent worktrees inherit identity) | `gsd-worktree-guard` |
| Rule 3: `/gsd-execute-phase` blocked while the install is `running` / `fail` | `gsd-worktree-guard` |
| Rule 4 (`flow = strict`): plan needs CONTEXT, execute needs REVIEWS, secure needs REVIEW (+ UI-REVIEW when a UI-SPEC exists) and the test audit (`<P>-VALIDATION.md` compliant or audited); `--prd` / `--gaps-only` exemptions | `gsd-worktree-guard` |
| Rule 5 (`ui_gates = strict`): ui-phase needs a filled DESIGN.md + a LAYOUT with a chosen sketch and pages; ui-review needs a passed, current UI check, a complete look file and the user's approval (a phase whose UI review is already on the base branch is exempt) | `gsd-worktree-guard`, `lib/ui.sh` (`gsd_ui_gate`) |
| Native hooks: Claude `UserPromptExpansion` + `PreToolUse(Skill)` (skill calls and typed slash commands; the plugin form `gsd-core:gsd-plan-phase` counts as `gsd-plan-phase`) | `gsd-worktree-guard`, `lib/gsd_hook_payload.py` |
| Rule 0: `/gsd-new-project` / `/gsd-ingest-docs` only in a repo `gsd-init` set up (`.gsd.conf`). Enforced by a user-level hook `install.sh` adds to `~/.claude/settings.json` (`PreToolUse(Skill)` + `UserPromptExpansion`): `gsd-worktree-guard --global` applies rule 0 only in a repo without `.gsd.conf` (every rule in a set-up repo, where it is the only hook that sees typed slash commands) and fails open on an unreadable payload. `--no-user-hook` opts out (remembered); Codex: the skill's written rule only | `install.sh`, `gsd-worktree-guard`, `skills/gsdt-worktrees` |
| Hook JSON parsed without `jq` (Python fallback) | `lib/gsd_hook_payload.py` |
| Escape hatch `GSD_SKIP_GUARD=1`; shim fails open when the toolkit is not installed | `gsd-worktree-guard`, `shims/` |

## 6. Phase flow

| Feature | Where |
|---|---|
| Resumable step engine: ticket (only with a tracker) → discuss → ui-decision → design-system → layout → ui-phase → plan → review → replan → execute → verifier → gaps → verify-work → code-review → ui-check → ui-look → ui-approve → ui-review → validate → secure → done | `gsd-flow-next` |
| Reads artifacts only, so it survives crashes and `/clear` | `gsd-flow-next` |
| Detects an unfolded review (`replan`) from commit times of REVIEWS vs PLAN | `gsd-flow-next` |
| `--all` preview, `--json`, `--ui` / `--no-ui` | `gsd-flow-next` |
| Guard check before every step it returns | `gsd-flow-next` |
| Configurable cross-AI reviewer (`review_provider`, default `codex`) | `gsd-flow-next`, `lib/provider.sh` |
| A `REVIEWS.md` whose configured reviewer failed (empty section, Codex usage limit) passes neither the review step nor the guard's execute rule | `gsd-flow-next`, `gsd-worktree-guard`, `lib/common.sh` (`gsd_reviews_problem`; gsd-core reviewer-instance headings such as `## Codex Review (fast)` count) |
| Wait out a Codex usage limit: wrap a command (re-run after the reset) or `--wait-only`; reset time from Codex's message or session log, `--interval` fallback, `--max-wait` cap (exit 75, never a pass); never calls Codex; keeps a Mac awake | `gsd-codex-wait`, `lib/gsd_codex_limit.py` |
| Agent-facing driver skill with human stop points (discuss, design system + sketch, screens, review, UI approval) | `skills/gsdt-flow` |
| Doctor report of merged phases that skipped a mandatory step (T040: flow steps with `flow = strict`, `ui-check` / `ui-approve` with `ui_gates = strict`; `flow_since` cutoff, `flow_skip` single phases shown as a note) | `gsd-doctor` |

## 6b. UI quality gates ([ui-quality-plan.md](ui-quality-plan.md))

| Feature | Where |
|---|---|
| One design system per project: `.planning/design/DESIGN.md` (stub marker until filled) + `refs/` | `gsd-ui design`, `lib/ui.sh` |
| Per phase with screens: `<P>-LAYOUT.md` — chosen `/gsd-sketch` (`sketch:`, winner read from the sketch README) + `pages:`; `sketch: skip <reason>` | `gsd-ui layout`, `gsd-flow-next` |
| **Check of the rendered pages** ([plan-ui-check.md](plan-ui-check.md)): every `pages:` entry at 375 / 768 / 1440 px in the project's own Playwright; writes `<P>-UI-CHECK.md`, the pictures and a sheet (`<P>-SHOTS/index.html`, not committed). Exit 0 passed / 1 failed / 2 could not run; `--skip "<reason>"` | `gsd-ui check`, `lib/ui-check.mjs` |
| Checks: C1 sideways scroll, C2 possible clipped text (a question), C3 contrast (pinned axe-core; "could not measure" = a question), C4 text under `ui_min_font`, C5 broken `<img>`, C6 uncaught page errors (console errors are listed), C7 the page's main button (one match, on the first screen, not covered), C8 failed load / another page / missing `expect:` text | `lib/ui-check.mjs`, `lib/vendor/axe-core/` |
| Per page in `<P>-LAYOUT.md`: `main_button:` (text, `css=<selector>`, `none`), `expect:`; `app:` = the folder with Playwright; `waive: <check> \| <page> \| <width> \| <target> \| <reason>` lists a finding without counting it. A page without `main_button:` is "not checked" — a failure under `strict` | `gsd-ui check` |
| Playwright lookup with `createRequire`: `GSD_PLAYWRIGHT_ROOT`, `app:`, the repo root, `apps/*` and `packages/*`, then the global npm folder (`npm i -g playwright`, once per machine; `GSD_NPM_GLOBAL_ROOT` overrides); several installs and no `app:` → refuses. Never loads a Playwright config | `lib/ui-check.mjs`, `lib/ui.sh` (`gsd_ui_global_root`) |
| One run = one capture (id = hash of the pictures). `<P>-UI-CHECK.md` also records a hash of the code outside `.planning/` and of `<P>-LAYOUT.md`; a later change to either makes the check stale. Same pictures → same id, so look and approval stay valid | `lib/ui.sh` (`gsd_ui_inputs_state`, `gsd_ui_check_state`) |
| Staged output: a run that cannot finish records `status: error` and removes the old pictures — an old pass never stays | `gsd-ui check` |
| Look file `<P>-UI-LOOK.md`: one answer (`ok` / `fixed` / `bad` / `n/a` + text) per picture and layout rule (R1–R10, or the project's `- R<n>:` lines in DESIGN.md) and per question; the expected set comes from the check, not the look file | `gsd-ui look`, `lib/ui.sh` (`gsd_ui_look_state`) |
| Approval `<P>-UI-APPROVAL.md` names the capture; `--waive "<reason>"` records that the user chose not to look | `gsd-ui approve`, `gsd-ui sheet` |
| Screenshots only, with the Playwright CLI (no checks), recorded in `<P>-SHOTS.md`; `--skip "<reason>"` | `gsd-ui shots` |
| App address: `url:` in `<P>-LAYOUT.md` (per phase — projects with several apps), else `ui_url` in `.gsd.conf`, else `http://localhost:{port}`; `{port}` = the phase's derived port, base from the `gsd-derive-port.sh <base>` dev script or `{port:<base>}` | `gsd-ui check`, `gsd-ui shots` |
| `ui_gates = warn` (default: flow steps, a warning at finish, doctor notes) / `strict` (guard blocks ui-phase and ui-review, finish refuses, doctor T080 / T081 / T040 `ui-check`, `ui-approve`) / `off` | `lib/ui.sh`, guard, finish, doctor |
| `gsd-init --no-ui` for projects without screens (`ui_gates = off`) | `gsd-init`, `gsd-bootstrap-repo` |
| Optional provider tools printed by `gsd-init` (Claude: `frontend-design` plugin, Playwright MCP) — never required | `lib/provider.sh` |

## 7. AI providers

| Feature | Where |
|---|---|
| Providers: `claude`, `codex`, `custom` (`gemini` is refused with a reason; `gsd-init --no-launch` removes an older release's Gemini setup); ordered `providers =` list, first is default | `lib/provider.sh` |
| Precedence chains for provider, executable, model, start mode (CLI > env > repo > legacy > default) | `lib/provider.sh` |
| Safe argv rendering (arrays, no `eval`); positional prompts | `lib/provider.sh` |
| Per-session model (`--model`, `GSD_MODEL`, `GSD_<P>_MODEL`, `<p>_model`, `default`) | `lib/provider.sh` |
| Sequential cross-provider handoff on one phase (`gsd-start -p N --provider X`) | `gsd-start` |
| Skills installed per agent (`install.sh --agent …` / `--all-agents`) | `lib/install.sh`, `lib/provider.sh` |

## 8. Visibility and diagnostics

| Feature | Where |
|---|---|
| Phase table: number, title, plans done/total, stage, worktree; wraps to the terminal (`--compact` for one line) | `gsd-list` |
| Read-only health check, every finding names its fix command; `--quiet`, `--json` | `gsd-doctor` |
| `--fix` (asks y/N, `--yes` for scripts): runs only the safe fixes — gsd-init (T010–T014, T016, T052, T058), gsd-planning-repair (T020, stale counters), `git branch --track` (T015), `chmod +x` pre-merge (T019), dead lock (T030), `worktree.baseRef = "head"` (T034) — then checks again; never commits | `gsd-doctor` |
| Finding codes: T001–T009 toolkit (incl. T005 no gsd-core, T006 no perl, T007 stale skills, T009 gsd-core skill profile is not `full`, T008 a GSD hook runs a file that is gone, e.g. a node path an nvm/Volta/fnm upgrade moved; the fix is to re-run the gsd-core installer — also a one-line warning in `gsd-start`/`gsd-list`), T010–T019 repo setup (T015 base branch, T016 instructions older than the toolkit, T017 unknown `.gsd.conf` key, T018 bad value, T019 pre-merge gate), T020–T026 planning (T025 duplicate phase heading, T026 `phase_id_convention: bracket` is unsupported), T030–T034 hygiene (T032 failed worktree install, T033 a lock with no pid — never removed for you, T034 `worktree.baseRef` not `"head"` in the main checkout or a phase worktree, so a wave's plans run one at a time), T040 flow debt, T050–T061 providers (T061 Gemini setup left from an older release), T070–T073 tracker (T073 no ClickUp token), T080 no design system and T081 committed pictures (`ui_gates = strict`; notes otherwise), W017 / W027 shared with `/gsd-health` | `gsd-doctor` |
| `--json` lists the notes too (`"notes"`) | `gsd-doctor` |
| Optional add-on notes for projects with screens, per provider and stack (files only): Impeccable design skill; shadcn MCP for Tailwind / shadcn | `gsd-doctor`, `lib/ui.sh` (`gsd_ui_stack`), `lib/provider.sh` (`gsd_provider_ui_addon`) |
| Checks for a newer GSD on npm and branches whose upstream is gone | `gsd-doctor` |

## 9. Install and maintenance

| Feature | Where |
|---|---|
| One installer: `install.sh` downloads a release and runs its `lib/install.sh`, which copies it into its own runtime (`GSD_COPY_DIR`); `./install.sh` in a checkout installs the release too, never the checkout; `install.sh --copy` (older releases' get.sh) runs `lib/install.sh` | `install.sh`, `lib/install.sh` |
| Backups before overwrite; prunes links to deleted commands; refuses overlapping destinations | `lib/install.sh` |
| Install manifest + `--reuse-install-config` | `lib/install.sh` |
| One-line install of a GitHub release, SHA256-checked, one folder per release (`--version`, `--agent`) | `install.sh` |
| Install adds gsd-core (`--profile=full`) for each chosen agent that has none, after our skills; never on an update; `--no-core` / `GSD_NO_CORE=1` skip it; a failure only prints the command | `lib/install.sh`, `install.sh` |
| Update / go back: `gsd-update [--check \| --version X.Y.Z \| --no-core]`; keeps the previous release, prunes older ones; then gsd-core to its latest (`--profile=full`) for each installed agent | `gsd-update`, `lib/core.sh` |
| "Newer version" notice for gsd-toolkit and gsd-core (npm) in `gsd-start` / `gsd-list` / `gsd-init` (terminal only) and `gsd-doctor` (also `--quiet`, `updates` in `--json`); day-long cache, background refresh; `GSD_NO_UPDATE_CHECK=1` | `lib/version.sh`, `gsd-doctor` |
| Reinstall replaces the toolkit's own links and skills in place (no `.bak` on PATH or in skill dirs) | `lib/install.sh` |
| Releases from `main`: a push that changes `VERSION` → check → tests → tag + tarball + `SHA256SUMS` → GitHub release; `tools/release.sh X.Y.Z --push` is a helper | `.github/workflows/release.yml`, `tools/release-check.sh`, `tools/release.sh` |

## 10. Tickets and trackers ([trackers.md](trackers.md))

| Feature | Where |
|---|---|
| `start` / `finish` / `comment` / `status` / `snapshot [--out]` / `extract` / `check` / `which` | `gsd-tracker` |
| `tracker = none` (default in a GSD repo) / `clickup` / `custom`; settings from env > git config `gsd-tracker.*` > `.gsd.conf`; `gsd-tracker config` shows them | `gsd-tracker`, `lib/tracker/config.sh` |
| Standalone: `gsd-tracker` works in any folder and uses no GSD code; GSD runs it as a command | `bin/gsd-tracker`, `lib/tracker/` |
| Id parsing: bare, `tk-<id>`, `#<id>`, URL; tags read back from title, then branch | `lib/ticket.sh`, `lib/tracker/ids.sh` |
| Status names from `tracker_status_start` / `_finish` (env `GSD_TRACKER_STATUS_*` wins) | `gsd-tracker` |
| ClickUp: status matched per list, subtask cascade, idempotent, markdown snapshot; token from `CLICKUP_API_TOKEN`, else `~/.config/gsd/clickup-<profile>.env` with `tracker_profile`, else `~/.config/gsd/clickup.env`; `gsd-tracker login` (any folder) saves a token — or reuses the saved one — and sets `git config gsd-tracker.profile` in one step | `lib/tracker/clickup.sh` |
| Custom: `tracker_command` gets `start` / `finish` / `comment` / `status` / `snapshot` / `check` + `<id> [text]` | `lib/tracker/custom.sh` |
| Snapshot `--out` writes only on success (the file marks the flow step done) | `gsd-tracker` |
| Shared verbs `create` / `update` / `tasks` for every tracker (options passed to the connector; `none` fails them); a connector's own commands via `TRACKER_EXTRA` | `gsd-tracker` |
| ClickUp connector: `create` / `update` (name, markdown description, assignees by me/id/email/username, status, priority, tags, parent) / `tasks` (filters, `--match` name search); own commands `lists` / `members` / `api` (any v2 call); workspace from `CLICKUP_TEAM_ID` or the token's only one | `lib/tracker/clickup.sh` |
| Agent skill: read and write the repo's tickets through `gsd-tracker` (checks `which` first) | `skills/gsdt-tracker` |
| Install removes a toolkit skill no longer shipped (renamed or retired) | `lib/install.sh` |
| Legacy read-only: `--cu`, `cu_<id>` tags, `STORY.md` | `lib/ticket.sh` |

## 11. Shared library (`lib/`)

| Module | Provides |
|---|---|
| `lib/common.sh` | `.gsd.conf` reader, main-checkout / base / wtdir detection, checkout lock (`mkdir`, dead-PID reclaim, re-entrant), merge-driver registration, planning-safety status/apply, Python 3.7+ discovery, install/test command detection, the usable-review test (`gsd_reviews_problem`; gsd-core reviewer-instance headings such as `## Codex Review (fast)` count) |
| `lib/provider.sh` | provider identity/validation, instruction file + skill root per provider, native-hook capability + state, resolution chains, argv rendering, owned-marker block helpers |
| `lib/gsd_planning.py` | `reconcile` and `repair` engines for ROADMAP.md / STATE.md |
| `lib/gsd_hook_payload.py` | Claude hook JSON → guard input |
| `lib/gsd_codex_limit.py` | Codex usage-limit message parsing and session-log scan, for `gsd-codex-wait` |
| `lib/roadmap-audit.pl` | read-only ROADMAP bookkeeping audit |
| `lib/roadmap-rows.pl` | adds a claimed phase's missing checklist + Progress rows (the ones gsd-core leaves out) |
| `lib/version.sh` | this package's version, version compare, the cached latest-release check and notice |
| `lib/ticket.sh` | GSD side of tickets: `tk-<id>` tags (parse, extract, match), `gsd_tracker_which` |
| `lib/tracker/config.sh`, `lib/tracker/ids.sh` | gsd-tracker's own settings and id parsing (standalone) |
| `lib/tracker/clickup.sh`, `lib/tracker/custom.sh` | one adapter per tracker, sourced by `gsd-tracker` |
| `lib/ui.sh` | UI gates: `ui_gates`, DESIGN.md / LAYOUT / SHOTS state, sketch winner, Playwright lookup, the DESIGN and LAYOUT templates |
