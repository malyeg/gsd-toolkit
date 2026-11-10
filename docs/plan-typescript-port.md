# Plan: port the toolkit to TypeScript (Windows + Mac + Linux)

Status: **parked** — decided 2026-09-25 to wait; refreshed 2026-11-10 against
0.10.0 (the `gsdt-*` rename). Windows users use WSL2 until then (README →
Install → "Windows: use WSL2"). Start this when there is real Windows demand,
or when the bash starts to hurt.

## Why

The toolkit is ~11,400 lines of bash + Python + Perl (+ one Node script). It
needs a Unix system: `~/.local/bin` symlinks, `perl`, `python3`, `jq`, LF line
endings, Unix paths, executable bits. Patching it for Git Bash (paths,
symlinks, CRLF, `py -3`, file locks, mintty, Windows CI) would cost days, stay
fragile, and be thrown away later.

A TypeScript port runs the same on all three systems.

## Stack: TypeScript 7 on Node 24

**Why Node.** Every user already has it: gsd-core (`@opengsd/gsd-core`) is an
npm package and needs Node ≥ 24. `lib/ui-check.mjs` is already Node, and
Playwright (which it drives) is Node too — so the port ends at one language,
down from four (bash, Python, Perl, JS).

**Why npm.** `npm i -g gsd-toolkit` (the name is free on npm, checked
2026-11-10). npm makes the Windows command wrappers by itself (`.cmd`, `.ps1`
and an `sh` one for Git Bash). `install.sh`, `gsdt-update`'s download,
SHA256 checks and release-dir pruning all go away.

**Why TypeScript 7.** Stable since July 2026; `tsc` is now the Go-written
compiler (8–12× faster builds). Note: it is written in **Go, not Rust**. It
only changes the build (type checking + emitting JS); the tool still runs on
Node. Its missing piece — the programmatic compiler API, due in 7.1 — is not
something we use.

**Build.** Node won't run `.ts` inside `node_modules`, so the npm package ships
compiled `.js` from `tsc`. In development and tests, Node 24 runs `src/*.ts`
directly (type stripping, stable in 24.12): set `erasableSyntaxOnly` in
`tsconfig` (no `enum`, no parameter properties) so the same files work both
ways, and run `tsc --noEmit` in CI.

**Options turned down:**

| Option | Why not |
|---|---|
| Go | One fast binary, but a separate install channel (PowerShell script, scoop/winget), and `ui-check` stays in Node → two languages. Startup speed (Node ~50 ms) does not matter here, even for the guard hook. |
| Rust | Same result as Go, slower to write. Overkill. |
| Bun / Deno single binary | 50 MB+ per binary for a small tool; another runtime to trust. |
| Python | Not on many Windows machines; `py` vs `python3`; no package channel users already have. |
| Bash on Git Bash | See "Why". Fragile, and thrown away later. |

## What 0.10.0 (the `gsdt-*` rename) means for the port

- **Names are settled.** 21 commands, all `gsdt-*` (including the new
  `gsdt-migrate`). `package.json` `bin` lists exactly these. The port must not
  rename anything — 1.0.0 needs **no repo change**, only a machine-level
  install change.
- **Names kept on purpose stay kept:** merge driver key `gsd-planning`,
  `.gsd.conf`, `.gsd/`, `GSD_*` env vars, `~/.config/gsd/`,
  `.git/gsd-cmd.lock`.
- **Shims** are `scripts/gsdt-*.sh` + `scripts/hooks/gsdt-worktree-guard.sh`,
  frozen. They only call `gsdt-*` by name on PATH, so they work unchanged with
  the npm commands (Git for Windows runs them with its `sh`).
- **Legacy reads.** The bash code still reads many old forms: pre-0.10
  `gsd-*` names, `gsd-tracker.*` git section, `gsd-worktrees` paths and
  markers, `gsdw-*` skills, `cu_<id>` tags, `--cu`, `STORY.md`, the singular
  `provider` key, `agent_command`, `GSD_AGENT`. Proposal: 1.0.0 requires a
  migrated repo (doctor T090 clean on 0.10.x first) and drops the
  machine-level legacy (old install paths, `gsdw-*`, `gsd-worktrees`), but
  keeps the **config** legacy (`provider`, `agent_command`, `--agent`,
  `GSD_AGENT`) because CLAUDE.md lists it as an invariant. Smaller port, fewer
  tests to carry.
- **`gsdt-migrate`** is ported as-is in 1.0.0 (its `--check` backs doctor
  T090), and can be dropped in a later 1.x once nobody is on <0.10.

## Windows specifics

- **Git for Windows is required** (it already is, for `git`). Its `sh` runs
  everything shell-shaped in a target repo: the shims, the post-merge hook,
  the merge driver command, and Claude Code hooks (Claude Code on Windows runs
  hooks in Git Bash).
- **The pre-merge script** (`scripts/gsdt-premerge-check.sh`) has no exec bit
  on Windows: run it as `sh <script>` there, and skip the "not executable"
  doctor check / `chmod +x` fix on Windows.
- **User-level Claude hooks** (`gsdt-worktree-guard --global`,
  `gsdt-rules --hook`) are written today as `[ ! -x '<abs path>' ] || exec
  '<abs path>' …` pointing into `~/.local/bin`. The setup command rewrites
  them in place to the npm path (forward slashes, `C:/…`), the same
  "ours are replaced, never duplicated" rule `lib/install.sh` uses.
- **Paths:** every path through one `normalizePath()` (git on Windows prints
  `C:/…`); compare only after normalizing. Worktree paths can get long — doctor
  notes `core.longpaths` if a worktree path passes 200 chars.
- **Text:** read `\r\n` and `\n`, write LF. STATE.md's Session Continuity must
  stay byte-identical — the reconcile tests check it on Windows too.
- **Lock:** `.git/gsd-cmd.lock` dead-PID reclaim via `process.kill(pid, 0)`
  (works on Windows).
- **No `jq`, `perl`, `python3`, `curl`:** JSON natively, ClickUp via `fetch`.

## Scope (what gets ported, lines today)

| Today | Lines | Becomes |
|---|---|---|
| `bin/gsdt-doctor` + `lib/context.sh` | 1155 + 131 | `src/commands/doctor.ts` |
| `lib/gsd_planning.py` (reconcile + repair) | 733 | `src/planning.ts` |
| `lib/gsd_batch_report.py` + `bin/gsdt-batch-report` | 684 + 105 | `src/batch-report.ts` |
| `bin/gsdt-start` + `bin/gsdt-wt-new` | 627 + 215 | `src/commands/start.ts` |
| `lib/common.sh` (conf, lock, base, driver, reviews/validation checks) | 593 | `src/common.ts` |
| `lib/provider.sh` (adapters, rules text, marked blocks) | 529 | `src/provider.ts` |
| `lib/ui.sh` + `bin/gsdt-ui` | 456 + 373 | `src/ui.ts`, `src/commands/ui.ts` |
| `lib/ui-check.mjs` | 478 | `src/ui-check.ts` (already Node; mostly types) |
| `lib/tracker/*.sh` + `bin/gsdt-tracker` + `lib/ticket.sh` | 641 + 181 + 56 | `src/tracker/*.ts` (stays standalone: no import from core) |
| `bin/gsdt-finish` + `bin/gsdt-wt-finish` | 256 + 273 | `src/commands/finish.ts` |
| `lib/install.sh` + `install.sh` | 434 + 161 | `gsdt-setup` (skills + user hooks); the rest removed |
| `bin/gsdt-init` + `bin/gsdt-bootstrap-repo` | 344 + 258 | `src/commands/init.ts` |
| `bin/gsdt-list` (incl. embedded Perl) | 327 | `src/commands/list.ts` |
| `bin/gsdt-migrate` | 316 | `src/commands/migrate.ts` |
| `bin/gsdt-worktree-guard` + `lib/gsd_hook_payload.py` | 302 + 52 | `src/guard.ts` (hook JSON parsed natively — no NUL protocol) |
| `bin/gsdt-flow-next` | 289 | `src/commands/flow-next.ts` |
| `bin/gsdt-batch` | 186 | `src/commands/batch.ts` |
| `bin/gsdt-codex-wait` + `lib/gsd_codex_limit.py` | 168 + 147 | `src/codex-wait.ts` |
| `lib/version.sh` + `bin/gsdt-update` + `lib/core.sh` | 136 + 120 + 52 | npm registry check; `gsdt-update` = `npm i -g` toolkit + gsd-core |
| `bin/gsdt-planning-repair`, `bin/gsdt-planning-merge` | 117 + 57 | thin entries over `planning.ts` |
| `lib/gsd_hook_paths.py`, `lib/gsd_claude_env.py` | 114 + 73 | `src/claude-settings.ts` |
| `lib/roadmap-audit.pl`, `lib/roadmap-rows.pl` | 98 + 92 | `src/roadmap.ts` |
| `bin/gsdt-rules` | 75 | small entry over `provider.ts` |
| `bin/gsdt-derive-port` | 22 | small entry |

Not ported: `shims/` (frozen, shipped as files for bootstrap to copy),
`lib/vendor/axe-core/` (shipped as-is), `mods/gsdt-batch-sonnet/` (already
TypeScript, separate).

Every command keeps its **name, flags, output and exit codes**. `--help` text
stays the same.

## Design rules

- Node ≥ 24 (what gsd-core needs). **No runtime dependencies** if possible
  (`node:fs`, `node:child_process`, `fetch`, `node:test`). Playwright stays
  the project's own (resolved with `createRequire`, as today).
- Run `git` and providers with `execFile` (argument array, no shell) — same
  "never eval" rule as today.
- `package.json` `bin` lists every `gsdt-*` command.
- Keep every invariant in `CLAUDE.md` (one phase = one worktree, claim
  serialization, reconcile rules, Session Continuity byte-identical, doctor
  read-only, finding codes, tracker standalone, `gsd_ui_gate` as the one UI
  answer, the shared phase-artifact list). The bash-3.2 and BSD/GNU rules go
  away.

## What stays the same in target repos

- `.gsd.conf` — same keys, same meaning.
- The shims, the merge driver (`merge.gsd-planning.driver =
  gsdt-planning-merge …`), the post-merge hook — all call `gsdt-*` by name.
- Generated instruction blocks (`.gsd/INSTRUCTIONS.md`, `CLAUDE.md` /
  `AGENTS.md` `gsd-toolkit:*` markers) — same markers, same text
  (`gsdt-rules` output byte-identical).
- The repo's Claude hook (`$CLAUDE_PROJECT_DIR/scripts/hooks/gsdt-worktree-guard.sh`).

## Tests: the safety net

The 18 bash suites (~6,000 lines) are mostly black-box: they drive the
`gsdt-*` commands in throwaway repos and check output. They are the **parity
oracle** — the port is done when they pass against the new commands.

1. **Phase 1 — parity on Mac + Linux.** Point the suites at the new commands
   (PATH to `bin/` of the built package). Suites that also call `lib/*`
   directly need those parts moved: most of all `test-install-copy` (→ npm
   install + `gsdt-setup` tests), `test-review-round2`,
   `test-planning-reconcile`, `test-providers`, `test-doctor`, `test-batch`,
   `test-commands`; a few lines in the rest. `test-list` and `test-migrate`
   are already pure black-box.
2. **Phase 2 — Windows.** Port the suites to `node --test` (still black-box,
   throwaway repos in a temp dir) and add `windows-latest` to CI next to
   ubuntu + macos, with Git for Windows' `sh` on PATH. Include `test-e2e` with
   the real gsd-core `gsd_run`, and `test-ui-browser` with real Playwright.
3. Delete the bash suites only after phase 2 is green on all three systems.

## Steps

1. Branch `feat/ts-port`. The bash version stays live (0.10.x) the whole time.
2. Scaffold: `package.json`, `tsconfig` (TS 7, `erasableSyntaxOnly`), `src/`,
   build to `dist/`, `bin` entries.
3. Port in dependency order: `common` → `provider` → `planning` + `roadmap` →
   `guard` → `flow-next` → `ui` → `list` → `doctor` → `start` → `finish` →
   `init` → `migrate` → `tracker` → `batch` / `codex-wait` → the small ones →
   `gsdt-setup`.
4. After each piece: run the matching bash suite against it.
5. Phase 1 green → phase 2 (node tests, Windows CI) → green on 3 systems.
6. Try it on the real projects: `siminds/code/siminds-platform`,
   `medyour/code/medyour-platform`, `siminds/code/l4h-website` (doctor, list,
   one start → finish on a throwaway phase) — and one on a Windows machine.
7. Release **1.0.0** on npm (`npm publish --provenance` from `release.yml`,
   tag-gated like today).
8. Move 0.10.x users (machine only — no repo change):
   - last 0.10.x release: `gsdt-update` and the update notice say "moved to
     npm: `npm i -g gsd-toolkit && gsdt-setup`";
   - `gsdt-setup` removes the old `~/.local/bin/gsdt-*` links and
     `~/.local/share/gsd-toolkit/` (only what the toolkit owns:
     `owned_link`-style check), rewrites the user hooks to the npm path, and
     re-installs the skills (replacing the marked
     `<!-- gsd-toolkit-skill X.Y.Z -->` copies).
9. Docs: README install (Windows section replaces "use WSL2"),
   `docs/releases.md`, `docs/architecture.md`, `docs/copy-install.md`
   (retire), `CLAUDE.md` (commands, tests; bash-3.2 notes go), CHANGELOG 1.0.0.

## Time (AI doing the work)

| Step | Time |
|---|---|
| Write the TypeScript version | ~2 days |
| All current tests pass on Mac + Linux | ~1–1½ days |
| Windows CI runner + fixes | ~1 day |
| Try on the real projects (incl. one Windows machine) | ~1–2 hours of your time |
| npm publish, migration, docs | ~½ day |

About **4–5 days** (the code doubled since the first estimate). The slow part
is checking and trying it, not writing it.

## Open questions (decide at start)

Decided 2026-11-10 (P0): all four as proposed — see `docs/ts-port-progress.md` → Decisions.

- npm package name: `gsd-toolkit` (free on 2026-11-10) or a scope, e.g.
  `@malyeg/gsd-toolkit`. Proposal: `gsd-toolkit`, reserve it early.
- Drop the machine-level legacy reads in 1.0.0 (proposal above), or carry
  them all?
- Keep a bash 0.10.x maintenance line for a while, or freeze it at the last
  release? Proposal: freeze; fixes only for data-loss bugs.
- Skills + user hooks: a separate `gsdt-setup [--agent …]` command (proposal;
  no npm postinstall script), or fold into `gsdt-init`?
