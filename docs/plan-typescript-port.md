# Plan: port the toolkit to TypeScript (Windows + Mac + Linux)

Status: **parked** — decided 2026-09-25 to wait. Windows users use WSL2 until
then (README → Install → "Windows: use WSL2"). Start this when there is real
Windows demand, or when the bash starts to hurt.

## Why

The toolkit is ~5,850 lines of bash + Python + Perl. It needs a Unix system
(symlinks, `~/.local/bin`, `perl`, `python3`, LF line endings, Unix paths).
Patching it for Git Bash (paths, symlinks, CRLF, `py -3`, file locks, mintty,
Windows CI) would cost days and still be fragile — effort thrown away later.

A TypeScript port runs the same on all three systems.

## Why TypeScript (Node), not Go or Rust

- Users **already have Node**: GSD (`get-shit-done-cc`), `gsd-sdk`, Claude
  Code, Codex and Gemini CLI are all npm packages.
- Install/update becomes `npm i -g gsd-toolkit`, the same channel as GSD.
  `get.sh`, `gsd-update`, SHA256 checks and the release-dir pruning go away.
- One language replaces three (bash, Python, Perl).
- Go (second choice): single binary, fast, but a separate install channel.
  Rust: same result as Go, slower to write — overkill here.

## Scope (what gets ported)

| Today | Lines | Becomes |
|---|---|---|
| `lib/gsd_planning.py` (reconcile + repair) | 718 | `src/planning.ts` |
| `bin/gsd-doctor` | 659 | `src/commands/doctor.ts` |
| `bin/gsd-start` + `bin/gsd-wt-new` | 575 + 168 | `src/commands/start.ts` |
| `bin/gsd-list` (incl. embedded Perl) | 314 | `src/commands/list.ts` |
| `lib/provider.sh` | 272 | `src/provider.ts` |
| `lib/common.sh` (conf, lock, base, driver) | 254 | `src/common.ts` |
| `install.sh` | 250 | removed (npm installs the commands); skills installed by a `gsd-setup --agent …` command (no npm postinstall script) |
| `bin/gsd-init` + `bin/gsd-bootstrap-repo` | 248 + 190 | `src/commands/init.ts` |
| `bin/gsd-finish` + `bin/gsd-wt-finish` | 237 + 229 | `src/commands/finish.ts` |
| `bin/gsd-worktree-guard` + `lib/gsd_hook_payload.py` | 209 + 131 | `src/guard.ts` (hook JSON parsed natively — no NUL protocol) |
| `bin/gsd-flow-next` | 194 | `src/commands/flow-next.ts` |
| `bin/gsd-sync` | 162 | dropped for users (npm); kept as a dev script if useful |
| `lib/ticket.sh` + `lib/tracker/*.sh` + `bin/gsd-tracker` | 54 + 182 + 126 | `src/tracker/*.ts` (ClickUp via `fetch`, no `jq`/`curl`) |
| `bin/gsd-planning-repair`, `bin/gsd-planning-merge` | 115 + 57 | thin entries over `planning.ts` |
| `lib/roadmap-audit.pl`, `lib/roadmap-rows.pl` | 98 + 88 | `src/roadmap.ts` |
| `lib/version.sh`, `bin/gsd-update`, `get.sh` | 112 + 77 + 90 | update notice checks the npm registry; the rest is removed |
| `bin/gsd-derive-port`, `bin/gsd-clickup` | 22 + 17 | small entries |

Every command keeps its **name, flags, output and exit codes**. `--help` text
stays the same.

## Design rules

- Node 18+ (what GSD needs). TypeScript compiled to plain JS in the npm
  package. **No runtime dependencies** if possible (`node:fs`,
  `node:child_process`, `fetch`).
- Run `git` with `execFile` (argument array, no shell) — same "never eval"
  rule as today.
- All paths through one `normalizePath()` (git on Windows prints `C:/…`).
  Compare paths only after normalizing.
- Read files as text and accept `\r\n`; write LF.
- The checkout lock (`.git/gsd-cmd.lock`, dead-PID reclaim) uses
  `process.kill(pid, 0)`, which works on Windows too.
- `package.json` `bin` lists every `gsd-*` command; npm makes the `.cmd`
  wrappers on Windows by itself.
- Keep every invariant in `CLAUDE.md` (one phase = one worktree, claim
  serialization, reconcile rules, Session Continuity byte-identical,
  doctor read-only, legacy config keys, finding codes).

## What stays the same in target repos

- `.gsd.conf` — same keys, same meaning.
- **The shims** (`scripts/gsd-*.sh`) — unchanged. They only call `gsd-*` by
  name on PATH, so they work with the new commands. Git for Windows runs them
  with its own `sh`.
- The merge driver (`git config merge.gsd-planning.driver`) and the
  post-merge hook call `gsd-planning-merge` / `gsd-planning-repair` by name —
  also unchanged. Git for Windows runs hooks with its `sh`.
- Generated instruction blocks (`.gsd/INSTRUCTIONS.md`, `CLAUDE.md` /
  `AGENTS.md` / `GEMINI.md` markers) — same markers, same text.
- Native hooks: Claude `PreToolUse(Skill)` / Gemini `BeforeTool` command
  becomes the npm command name; for Gemini on Windows check it runs without a
  `bash` prefix.

## Tests: the safety net

The bash suites are black-box: most drive the `gsd-*` commands and check
output. They are the **parity oracle** — the port is done when they pass
against the new commands.

1. **Phase 1 — parity on Mac + Linux.** Point the existing suites at the new
   commands (PATH to the built package). The 8 suites that call `lib/*` files
   directly need their unit parts moved to the new code:
   `test-install-copy`, `test-gemini-hook`, `test-review-fixes`,
   `test-review-round2`, `test-planning-reconcile`, `test-providers`,
   `test-tracker`, `test-update`. (`test-install-copy` and most of
   `test-update` become npm-install tests.)
2. **Phase 2 — Windows.** Port the suites to `node --test` (still black-box,
   still throwaway repos in a temp dir) and add `windows-latest` to CI next to
   ubuntu + macos. Include `test-e2e` with the real `gsd-sdk`.
3. Delete the bash suites only after phase 2 is green on all three systems.

## Steps

1. Branch `feature/ts-port`. The bash version stays live (0.2.x) the whole
   time.
2. Scaffold: `package.json`, `tsconfig`, `src/`, build to `dist/`, `bin`
   entries.
3. Port in dependency order: `common` → `provider` → `planning` + `roadmap` →
   `guard` → `flow-next` → `list` → `doctor` → `start` → `finish` → `init` →
   `tracker` → the small ones.
4. After each piece: run the matching bash suite against it.
5. Phase 1 green → phase 2 (node tests, Windows CI) → green on 3 systems.
6. Try it on the real projects: `siminds/code/siminds-platform`,
   `medyour/code/medyour-platform`, `siminds/code/l4h-website` (doctor, list,
   one start → finish on a throwaway phase).
7. Release **1.0.0** on npm (`npm publish --provenance` from `release.yml`,
   tag-gated like today).
8. Migration for 0.2.x users:
   - last 0.2.x release: `gsd-update` / the update notice say "moved to npm:
     `npm i -g gsd-toolkit`";
   - a `gsd-migrate` step (or doc) removes the old `~/.local/bin` links and
     `~/.local/share/gsd-toolkit/` using the install manifest (only files it
     owns);
   - skills: re-installed by the new setup command into each agent's skill
     dir, replacing the marked (`<!-- gsd-toolkit-skill -->`) copies.
9. Docs: README install, `docs/releases.md`, `docs/architecture.md`,
   `CLAUDE.md` (commands, tests, bash-3.2 notes can go), CHANGELOG 1.0.0.

## Time (AI doing the work)

| Step | Time |
|---|---|
| Write the TypeScript version | ~1 day |
| All current tests pass on Mac + Linux | ~½–1 day |
| Windows CI runner + fixes | ~½ day |
| Try on the real projects | ~1 hour of your time |
| npm publish, migration, docs | ~½ day |

About **2–3 days**. The slow part is checking and trying it, not writing it.

## Open questions (decide at start)

- npm package name: `gsd-toolkit` free? Else a scope, e.g. `@malyeg/gsd-toolkit`.
- Keep a bash 0.2.x maintenance line for a while, or freeze it at the last
  release?
- Skills install: a `gsd-setup --agent …` command, or fold into `gsd-init`?
