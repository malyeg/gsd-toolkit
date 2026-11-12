# TypeScript port — progress

The design is `docs/plan-typescript-port.md`. This file is the **state**: what
is done, what is next. Each session does **one phase**, updates this file,
commits, and stops. A fresh session (after `/clear`) starts by reading this
file — nothing else from earlier chats is needed.

## Rules for every session

1. Read this file, then only the plan sections and code the phase needs.
2. Do the phase under **Next**. Delegate the porting/test work to subagents
   (`model: "sonnet"` to port, `"haiku"` to search/check) so the main chat
   stays small; the main chat plans, checks results, and updates this file.
3. Done = the phase's suites pass. Never skip or weaken a test to pass it;
   report failures with their output.
4. At the end: tick the phase, fill its log line (commit hash, suites, notes),
   set **Next**, write anything the next session must know under **Notes**,
   commit on `feat/ts-port`. Then stop and give a 3-line status.
5. Never push to `main`, change `VERSION`, or publish to npm.

## Approach (strangler)

The bash version keeps working the whole time. When a command is ported, its
`bin/gsdt-X` becomes a tiny launcher that runs the TypeScript entry with Node
(`node "$GSD_PKG/src/…ts"`, type stripping, no build). Unported commands stay
bash. So **every bash suite runs at every step**, and each phase proves
parity for what it ported without breaking the rest. P11 flips the launchers
to `package.json` `bin` + `dist/`. P0 refinement: the launcher runs
`node src/launch.mjs <name>`, not the `.ts` directly, so an old Node gets a
clear "needs Node ≥ 24" message instead of a syntax error (see Notes).

## Next

**P10** — The rest: `gsdt-batch`, `gsdt-batch-report` (+ `lib/gsd_batch_report.py`), `gsdt-codex-wait` (+ `lib/gsd_codex_limit.py`) → TS, through the launcher. Oracles in `tests/fixtures/p10-old-bins/`. Suites: `test-batch`, `test-codex-wait` (+ P10 parity tests under `tests/ts/`).

**After P10: stop and test** (user's decision, 2026-11-12, see "Order change" below). Do NOT start P11 until the user says the test went well.

## Phases

| | Phase | Ports | Suites that must pass |
|---|---|---|---|
| [x] | P0 Decisions + scaffold | Ask the plan's Open questions (one AskUserQuestion each, context in the question); record answers below. `package.json`, `tsconfig` (TS 7, `erasableSyntaxOnly`, Node ≥ 24), `src/`, launcher pattern, `tsc --noEmit` in CI, one trivial command (`gsdt-derive-port`) through the launcher. | `tests/test-commands.sh` (derive-port part) + all suites still green |
| [x] | P1 Core libs | `lib/common.sh` → `src/common.ts`, `lib/provider.sh` → `src/provider.ts`, `gsdt-rules` | `test-providers` (rules/blocks parts), `test-commands` |
| [x] | P2 Planning | `gsd_planning.py`, `roadmap-*.pl`, `gsdt-planning-repair`, `gsdt-planning-merge` | `test-planning-reconcile`, `test-review-round2` |
| [x] | P3 Guard + flow | `gsdt-worktree-guard` (+ hook payload), `gsdt-flow-next` | `test-worktree-guard`, `test-flow-next` |
| [x] | P4 UI | `lib/ui.sh`, `gsdt-ui`, `ui-check.mjs` → TS | `test-ui`, `test-ui-browser` (if Playwright available) |
| [x] | P5 List + doctor | `gsdt-list`, `gsdt-doctor` (+ `context.sh`, hook paths) | `test-list`, `test-doctor` |
| [x] | P6 Start | `gsdt-start`, `gsdt-wt-new` | `test-commands`, `test-e2e` |
| [x] | P7 Finish | `gsdt-finish`, `gsdt-wt-finish` | `test-commands`, `test-review-fixes`, `test-e2e` |
| [x] | P8 Init + migrate | `gsdt-init`, `gsdt-bootstrap-repo`, `gsdt-migrate`, Claude env helper | `test-providers`, `test-migrate`, `test-doctor` |
| [x] | P9 Tracker | `gsdt-tracker`, `lib/tracker/*`, `ticket.sh` (stays standalone) | `test-tracker` |
| [ ] | P10 The rest | `gsdt-batch`, `gsdt-batch-report`, `gsdt-codex-wait` | `test-batch`, `test-codex-wait` |
| [ ] | — Test (user) | After P10: the user runs the port on real projects with this checkout's `bin/` first on PATH (`export PATH="/Users/siminds-ops/projects/gsd-toolkit-ts-port/bin:$PATH"`), no release. Fix what breaks, one session per fix. | the user's go to continue |
| [ ] | P11 Install | `gsdt-setup`, `gsdt-update` (npm), version notice; launchers → `package.json` `bin` + `dist/` | `test-install-copy` / `test-update` reworked as npm-install tests; **all suites** on Mac + Linux CI |
| [ ] | P12 Windows | Suites → `node --test`; `windows-latest` in CI; Windows fixes (paths, CRLF, `sh` for scripts) | all, on 3 systems |
| [ ] | P13 Try + docs | Real projects (plan Step 6), docs (Step 9), migration message in last bash release. **Release needs the user's go.** | — |

## Log

<!-- one line per finished phase: P<n> · date · commit · suites passed · notes -->
- P0 · 2026-11-10 · (this commit: `git log --grep "ts-port P0"`) · all 17 runnable suites green locally on macOS + shellcheck + `tsc --noEmit` (test-ui-browser skipped: no `GSD_PLAYWRIGHT_ROOT`; test-e2e ran with real gsd-core, 38 passed) · decisions recorded; scaffold + launcher; `gsdt-derive-port` ported. CI changes (setup-node 24, `npm ci` + `tsc`) not yet seen running on GitHub — check the first push's run.
- P1 · 2026-11-10 · (this commit: `git log --grep "ts-port P1"`) · all 17 runnable bash suites green on macOS (test-e2e 38 with real gsd-core; test-ui-browser skipped) + new `node --test 'tests/ts/*.test.ts'` 31/31 + `tsc` · `src/common.ts`, `src/provider.ts` (every function), `src/version.ts`, `src/ui.ts` (`uiGates` only), `gsdt-rules` ported; old vs new `gsdt-rules` byte-identical in 25 cases (stdout, stderr, exit). No legacy read dropped.
- P2 · 2026-11-10 · (this commit: `git log --grep "ts-port P2"`) · all 17 runnable bash suites green on macOS (test-planning-reconcile 149, test-review-round2 39, test-e2e 38 with real gsd-core; test-ui-browser skipped) + `node --test 'tests/ts/*.test.ts'` 127/127 + `tsc` + shellcheck · `src/planning.ts` (engine; CLI `launch.mjs planning reconcile|repair`, same argv/output as `gsd_planning.py`), `src/commands/planning-repair.ts`, `src/roadmap.ts` + `roadmap-audit`/`roadmap-rows` entries (not wired yet: doctor/start still call perl until P5/P6). `gsdt-planning-repair` + `gsdt-planning-merge` are launchers. `test-planning-reconcile` now drives the TS engine; `test-install-copy`'s fixture copies `src/`. No legacy read dropped.
- P3 · 2026-11-11 · (this commit: `git log --grep "ts-port P3"`) · all 17 runnable bash suites green on macOS (test-worktree-guard 123, test-flow-next 116, test-review-fixes 27, test-e2e 38 with real gsd-core; test-ui-browser skipped) + `node --test 'tests/ts/*.test.ts'` 155/155 + `tsc` + shellcheck · `src/guard.ts` (hook JSON parsed natively, jq semantics), `src/commands/worktree-guard.ts`, `src/commands/flow-next.ts` (guard in-process), `src/bash-bridge.ts`. Both bins are launchers. The guard now needs node instead of jq/python: the no-jq tests in test-worktree-guard / test-review-fixes link `node` instead of `python3`; the `gsd_hook_payload.py` loop became a guard-level check (gsdt-flow/gsdw-flow treated as gsd-flow); new tests for "no node". `gsd_command_guards_active` (bash + TS) also accepts the in-process guard call in `src/commands/flow-next.ts`. No legacy read dropped.
- P4 · 2026-11-11 · (this commit: `git log --grep "ts-port P4"`) · all 18 bash suites green on macOS (test-ui 179, test-ui-browser 63 with real Playwright, test-flow-next 116, test-worktree-guard 123, test-doctor 172, test-e2e 38 with real gsd-core) + `node --test 'tests/ts/*.test.ts'` 177/177 + `tsc` + shellcheck · `src/ui.ts` (all of ui.sh), `src/commands/ui.ts` (`gsdt-ui` is a launcher), `src/ui-check.ts` + `src/commands/ui-check.ts` (runner; `lib/ui-check.mjs` deleted). Guard, flow-next and `finishGates` call TS for UI (no bash). `lib/ui.sh` stays for unported bash callers. No legacy read dropped.
- P5 · 2026-11-11 · (this commit: `git log --grep "ts-port P5"`) · all 18 bash suites green on macOS (test-list 19, test-doctor 172, test-providers 240, test-tracker 202, test-migrate 89, test-ui 179, test-ui-browser 63 with real Playwright, test-e2e 38 with real gsd-core) + `node --test 'tests/ts/*.test.ts'` 316/316 (~4.5 min) + `tsc` + shellcheck · `src/commands/list.ts` (embedded perl ported), `src/commands/doctor.ts` (all codes, `--json`, `--fix` by name), `src/context.ts`, `src/hook-paths.ts` (`staleHooks` native, no python), `src/update-check.ts`; guard rule 5 UI helpers now take the guard's `env`. Both bins are launchers. Doctor T021–T023 use `src/roadmap.ts` in-process. Suites that copy a package now copy `src/` too (test-doctor, test-planning-reconcile, test-review-fixes, test-update) — no test weakened. No legacy read dropped.
- P6 · 2026-11-12 · (this commit: `git log --grep "ts-port P6"`) · all 18 bash suites green on macOS (test-commands 135, test-e2e 38 with real gsd-core, test-doctor 173, test-providers 240, test-ui-browser 63 with real Playwright) + `node --test 'tests/ts/*.test.ts'` 342/342 (~5.5 min) + `tsc` + shellcheck · `src/commands/start.ts`, `src/commands/wt-new.ts`, `src/stdio.ts`; both bins are launchers. Roadmap rows after a claim use `src/roadmap.ts` in-process; STATE.md note edits in JS — start needs no perl. Doctor: the "roadmap row check skipped — needs perl" gate is gone (roadmap check always runs); T006 stays (unported bash still uses perl) with new text. `test-doctor`'s no-perl assertion now checks the roadmap check still runs (T022 shows, no "skipped"); `p5-doctor`'s `no perl` scenario is new-side only (old bin skipped the check), the old side's T006 text is mapped to the new wording. `test-commands`' bare-PATH no-gsd-core case gets a folder with only a `node` link. No legacy read dropped.
- P7 · 2026-11-12 · (this commit: `git log --grep "ts-port P7"`) · all 18 bash suites green on macOS (test-commands 135, test-review-fixes 27, test-e2e 38 with real gsd-core, test-planning-reconcile 149, test-doctor 173, test-ui-browser 63 with real Playwright) + `node --test tests/ts/p7-*.test.ts tests/ts/p6-*.test.ts` 56/56 (p7 30 tests, ~105 s) + `tsc` + shellcheck · `src/commands/finish.ts` (holds `--help`), `src/commands/wt-finish.ts`; both bins are launchers. Gates use TS `finishGates`; finish takes the lock and runs wt-finish as a child with `GSD_LOCK_HELD=1`. No bash suite changed. No legacy read dropped. Full `tests/ts/*.test.ts` glob not re-run this phase (only p6+p7).
- P8 · 2026-11-12 · (this commit: `git log --grep "ts-port P8"`) · all 17 runnable bash suites green on macOS (test-providers 240, test-migrate 89, test-doctor 173, test-install-copy pass, test-commands 135, test-e2e 38 with real gsd-core, test-ui 179, test-update 86; test-ui-browser not run — no UI change) + `node --test` p8-* + p5-doctor + p1-parity 199/199 (~6 min), p6+p7 re-run 56/56 + `tsc` + shellcheck · `src/commands/init.ts` (runs bootstrap in-process), `src/commands/bootstrap-repo.ts`, `src/commands/migrate.ts`, `src/claude-settings.ts` (`claudeEnv`, `baserefState`, `removeGuardHook` — native, python-exact JSON bytes), `src/pyjson.ts` (migrate's python-exact JSON). All three bins are launchers. No python left in these commands or in `baseref`/`compactSettings`; `src/baseref-py.ts` deleted, `nopython` state gone. One test change: `p5-doctor` "no python" is new-side-only (doctor now reports T034 without python; old skipped the baseRef check). No bash suite changed. No legacy read dropped.
- P9 · 2026-11-12 · (this commit: `git log --grep "ts-port P9"`) · all 17 runnable bash suites green on macOS (test-tracker 205, test-commands 135, test-flow-next 116, test-e2e 38 with real gsd-core, test-doctor 173, test-update 86; test-ui-browser not run — no UI change) + `node --test` p9-tracker 31/31 + p9-ticket 5/5, p3-flow-next + p5-doctor + p6-start + p7-finish 161/161 + `tsc` + shellcheck · `src/tracker/{cli,config,ids,custom,clickup,io,json}.ts` + `src/commands/tracker.ts` (standalone: imports only `node:*` + each other); `bin/gsdt-tracker` is a launcher; no jq/python needed. `src/ticket.ts` (`trackerWhich`, `ticketNorm`, `ticketExtract` — moved out of doctor.ts — `ticketTagged`); start/finish/flow-next/doctor use it; `src/bash-bridge.ts` deleted. `test-tracker`'s standalone section now copies the TS files and lints TS imports (3 new asserts; nothing removed). New twin test `src/ticket.ts` ↔ `src/tracker/ids.ts` caught a `ClickUp<VT>id` split bug in `trkIdExtract` (fixed). No legacy read dropped (the `gsd-tracker.*` git section and legacy env names still read).

## Decisions (from P0)

Asked 2026-11-10; all four took the plan's proposal.

- **npm name:** `gsd-toolkit` (unscoped). Reserve it before the first release.
- **Legacy reads:** 1.0.0 needs a migrated repo (doctor T090 clean on 0.10.x
  first). Drop the **machine-level** legacy (old install paths
  `share/gsd-worktrees`, `gsdw-*` skills, `gsd-worktrees` markers/tarball
  names, pre-0.10 `gsd-*` command names). Keep the **config** legacy
  (`provider`, `agent_command`, `--agent`, `GSD_AGENT`) — it is a CLAUDE.md
  invariant. `gsdt-migrate` is ported as-is (backs T090). When a ported
  command drops a legacy read, its bash test for that read goes too — say so
  in the log line.
- **Bash line:** freeze at the last 0.10.x release; after 1.0.0 only
  data-loss fixes. That last release points users to npm.
- **Machine setup:** a separate `gsdt-setup [--agent …]` (skills + user
  hooks, moves 0.10.x users off `~/.local/bin`). No npm postinstall.
  `gsdt-init` stays repo-only. That makes 22 commands in `bin`.

## Order change (2026-11-12, user)

Only the user uses gsd-toolkit. So after P10 the port is tested on real
projects **from this checkout** (its `bin/` first on PATH) — no release, no
npm. P11 (npm install) starts only after the user says the test went well;
P12 (Windows) needs P11 (Windows can't run the bash launchers); then P13.


## Notes for the next session

**Launcher pattern (P0, keep it):** a ported `bin/gsdt-X` is a ~15-line bash
file: short help comment, the usual symlink walk, `command -v node` check,
then `exec node "$PKG/src/launch.mjs" X "$@"`. `src/launch.mjs` checks Node
≥ 24 and imports `src/commands/X.ts`, which must export
`main(argv: string[]): number | Promise<number>` (no work at import time; it
returns the exit code — so a later `node --test` can call it directly). Pure
logic goes in exported functions next to `main` (e.g. `derivePort`).

- Imports between `.ts` files use the `.ts` extension
  (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`, so P11's
  `tsc` emits `.js` paths). Only erasable syntax (`erasableSyntaxOnly`).
- Run git/providers with `execFileSync`/`execFile` (argv array, no shell).
- `npm install` once in a fresh checkout (dev deps: `typescript` 7,
  `@types/node`), then `npx tsc --noEmit`. CI does `npm ci` + `tsc` and pins
  Node 24 with `actions/setup-node` before all suites.
- `lib/install.sh` now copies `src/` into the release runtime too, so a
  release made from this branch would still run its launchers.
- `package.json` is `"private": true` on purpose (rule 5: no npm publish).
  P11 removes that, adds `bin`, `files`, and the build.
- **P1 conventions** (top of `src/common.ts`): camelCase, no `gsd_` prefix,
  bash name in each doc comment (`gsd_main` → `findMain`). Bash globals →
  returned objects (`phaseDir` → `{pd,p,n}|null`, `planningStatus`,
  `gateTree`). Resolvers return `Result<T>` (`{ok:false,code,message}`, caller
  prints); validators `Failure|null`; `reviewsProblem`/`validationProblem`
  return the reason or null. A bash `exit` → throw `GsdExit(code,msg)`.
  Printing functions return their lines; `acquireLock` (sync, same
  `.git/gsd-cmd.lock/pid` format, interlocks with bash) prints itself.
- **Rules text lives twice until P5/P8:** `src/rules-text.ts` (TS
  `gsdt-rules`) and `lib/provider.sh` (bash bootstrap + doctor T016). Edit
  both; the parity suite fails if they drift.
- **TODOs left in TS:** `staleHooks` runs `gsd_hook_paths.py` (P5); `providerHookState` still uses
  `jq` (P5 may drop); `compactSettings` runs `gsd_claude_env.py` (P8); the
  baseref python (`src/baseref-py.ts`) runs verbatim (P8).
- **Parity tests:** `node --test 'tests/ts/*.test.ts'` (not `tests/ts/` —
  Node 24 reads a dir as a module). `tests/ts/helpers.ts` clears `GSD_*`,
  `CLAUDE_*`, `CODEX_*` and runs bash vs TS side by side; ~90 s. Add one file
  per phase.
- `gsdt-rules --hook` must never fail: `bin/gsdt-rules` exits 0 silently
  without node, and `src/launch.mjs` does too on old Node / import error
  (only for `rules … --hook`).
- Bash quirks kept for parity (fix later, both sides, if wanted):
  `gsd_replace_owned_block` on a missing file makes an empty 0600 file with no
  block; `gsd_planning_apply` glues its line onto a `.gitattributes` with no
  final newline; unknown provider → empty default command / skill root, rc 0.
  `shellQuote` matches bash 5, not bash 3.2's mangling of non-Latin-1.
- `tests/test-install-copy.sh`'s fixture now copies `src/` too (a launcher in
  the isolated runtime needs it). P11 reworks that suite anyway.
- **P2 notes.** `bin/gsdt-planning-merge` is NOT the plain launcher shape: the
  `${1:?}` checks, the `git merge-file --union` and the no-node fallback stay
  in bash, then it runs `launch.mjs planning reconcile "$A" --path "$P"` — so
  the union lands even if node dies, and it always exits 0 (git reads nonzero
  as a conflict). There is no `src/commands/planning-merge.ts` on purpose.
- `lib/gsd_planning.py` and `lib/roadmap-*.pl` stay as parity oracles (the
  perl is still live for gsdt-doctor T021–T023 and gsdt-start's rows). When
  P5/P6 switch those callers to `src/roadmap.ts`, keep `test-review-round2`'s
  perl lines as the oracle or move them to `tests/ts/p2-roadmap.test.ts`.
  `gsd_python` stays while any bash caller uses it.
- `tests/fixtures/p2-old-bins/` holds the old bash `gsdt-planning-*` bins
  (HEAD has the launchers now); `p2-planning.test.ts` diffs old vs new.
- Python quirks kept in `src/planning.ts`: half-to-even `round` (`pyRound`),
  code-point `len`, Unicode `\d\s\w\b`, `splitlines` + newline translation
  (a rewritten CRLF file comes back LF). Not reproduced (stderr only, rc
  matches): tracebacks → one `gsd_planning: …` line; argparse `--help` width
  fixed at 80; argparse's "maybe you meant" text (matches Python 3.14+);
  hash-order ties ("02" vs "2") use insertion order.
- Perl quirks kept in `src/roadmap.ts`: bytes as latin1 (40-byte cut can split
  a UTF-8 char), ASCII `\s` and `/i`, `.` matches `\r`, missing file rc 2,
  usage/no-heading rc 255 (perl's "no heading" rc is errno, may be 25 on
  Linux — the test accepts perl's rc only for that case). A non-numeric phase
  arg (`1+`) gives no perl-style warning.
- The node parity glob now takes ~2 minutes (p2-planning ~70 s).
- `gsdt-derive-port` parity note: a base with leading zeros (`0300`) is now
  decimal; bash read it as octal. Nobody passes that; not tested.
- **P3 notes.** Guard fail rules (keep them): `GSD_SKIP_GUARD=1` exits 0 before node is needed. No node / old Node / import or runtime error → with `--global` exit 0 silently (fail open), otherwise one `BLOCKED: …` line, exit 2 (never exit 1: Claude reads non-2 as "allow"). Done in `bin/gsdt-worktree-guard` and `src/launch.mjs`. Gap: a node that starts and itself exits 1 passes that through (a test documents it).
- `guard(opts)` → `{rc, stdout, stderr}`; `guardArgv(argv, {stdin, env, cwd})` does SKIP + parse + guard. flow-next calls `guardArgv` in-process (no subprocess).
- `src/bash-bridge.ts` `bashLib(fn, args, env)` sources common/ticket.sh and runs one bash function. Deleted in P9 (`src/ticket.ts` replaced it).
- Payload: the port follows jq semantics (the old guard used jq when present): `//` treats null/false as missing; a non-object `tool_input` is invalid only when the first alternative is missing; trailing newlines dropped from command/args/cwd; one leading `/` stripped. The python reader differed in edge cases; `lib/gsd_hook_payload.py` is now only the oracle's (old bin in `tests/fixtures/p3-old-bins/`); delete it with the oracle later.
- Not matched (stderr only, rc same): flow-next `--repo` without a value names `gsdt-flow-next:` instead of the script path. Globs (`<P>-*` dirs, PLANs, UATs) sort in byte order, bash by locale (same for normal names). A two-value JSON payload (`{} {}`) is invalid now (jq joined them).
- The node parity glob now takes ~4–5 minutes (p3-guard ~55 s, p3-flow-next ~85 s).
- **P4 notes.** `src/ui.ts` has a twin of every `gsd_ui_*` (`uiGate` stays the ONE "which UI step is open"). `lib/ui.sh` STAYS live for the bash callers (doctor P5, finish/wt-finish P7, init/bootstrap P8); keep both in step until then — `tests/ts/p4-ui.test.ts` diffs them. `finishGates` (common.ts) → `uiFinishGate` makes a `common.ts` ↔ `ui.ts` import cycle; safe (call-time only), keep it that way (no top-level use across the cycle).
- The runner is `src/ui-check.ts` + `src/commands/ui-check.ts`, run as a child: `node <pkg>/src/launch.mjs ui-check job.tsv` (via `process.execPath`). `lib/ui-check.mjs` is deleted; axe-core stays in `lib/vendor/` (path passed in the job file). Playwright typed with small local interfaces, no dependency. CI's `node --check lib/ui-check.mjs` is gone (tsc covers it).
- `bin/gsdt-ui` is a launcher; `--help` still reads its header comment. It never took the lock (still doesn't). Oracles: `tests/fixtures/p4-old-bins/{gsdt-ui,ui-check.mjs}`; `p4-ui-command.test.ts` (113 steps) normalizes only `<W>` root, `<PKG>` dirs, ISO timestamps.
- Open gap (P5): the guard's rule 5 UI helpers read `process.env`, not the guard's `opts.env` (`confGet`/`findMain`/`git()`/`uiCodeState` all read process.env). Only matters when flow-next calls the guard in-process with its own env; no test differs.
- Quirks kept: `uiField`/`uiFm` strip trailing space only and take the first `key:` line even if empty (flow-next's own `fm()` strips all — on purpose); `uiLookState` counts answer text in bytes; `uiLookKeys` numeric `==` (`0375` = `375`); a page with `|` shifts fields as awk did; `uiInputsState` hashes LAYOUT in the caller's cwd; a missing/non-exec `GSD_UI_RUNNER` writes a bash-style `…/bin/gsdt-ui: line 242: …` line (rc 127/126) into `err.txt`, since that text becomes the check's error reason; a runner without shebang runs via `bash`.
- Not reproduced: awk `-v` backslash escapes in page names; locale sort of `apps/*`/`packages/*` and `<cand>-*` dirs (byte order now); `pages:` globbing (`*` is literal now); `look` compares page/width as strings (awk compared numerically). `sheet`'s open-in-viewer branch (TTY only) is untested.
- `test-ui-browser` runs locally with `GSD_PLAYWRIGHT_ROOT=/Users/siminds-ops/projects/cerebrox/code/cerebrox-website` (has playwright + chromium; read only).
- **P5 notes.** Oracles: `tests/fixtures/p5-old-bins/{gsdt-list,gsdt-doctor}`. `p5-doctor.test.ts` (120 scenarios, ~2.5 min; `P5_ONLY=<regex>` runs a subset), `p5-list.test.ts` (~40 s), `p5-hook-paths.test.ts` (python oracle vs TS), `p5-guard-env.test.ts`, `p5-context.test.ts`.
- **Any suite that copies `bin/` into a fake package must copy `src/` too** (launchers need it).
- `lib/gsd_hook_paths.py` stays (bash `gsd_stale_hooks` for unported `gsdt-start`; delete after P6). `lib/context.sh` has no live caller now (oracle only). `providerHookState` stays on jq (bash bootstrap twin; P8 may drop). `baseref` still python (P8).
- `src/update-check.ts` = the parts of `lib/version.sh` doctor needs (runs `curl`/`npm` as subprocesses so test stubs work). `gsdt-list` prints the update notice via bash `gsd_update_notice` (bridge). P11: merge both into `src/version.ts`.
- `src/common.ts` `findMain`/`base`/`git` and the UI helpers in `src/ui.ts` take an optional `env` (default `process.env`); the guard passes its `opts.env`. Closes the P4 gap.
- Doctor: T006 "roadmap row check skipped — needs perl" is kept only because `test-doctor` asserts it (T021–T023 no longer need perl) — remove in P6. T062 reads Claude settings natively (old needed python). T002 compares realpaths (old string compare). `gsd_listing_size` counts bytes (BSD awk/mawk; gawk UTF-8 counted chars).
- Old doctor bugs kept for parity: `--json` with a failing T020 still prints `      · …` lines to stdout (breaks the JSON); planning-repair `  - ` notes show in text but never in `--json` `notes`. Not reproduced: old bin's stray `line 939: …: No such file` stderr when REQUIREMENTS/STATE/PROJECT.md is missing (the test strips it). Untested: the real-tty `Run these? [y/N]` prompt.
- List: non-numeric `COLUMNS` gives no perl "isn't numeric" warning (table + rc same); unreadable ROADMAP → `cannot read <file>`, rc 13/255; two stale settings files print in insertion order (awk's was arbitrary; test sorts).
- **P6 notes.** Oracles: `tests/fixtures/p6-old-bins/{gsdt-start,gsdt-wt-new}`. `tests/ts/p6-helpers.ts` builds an old package (fixtures + current launchers), fixture projects with a bare origin and a stub `gsd_run`, push-race env (`RACE_CLONE`/`RACE`), and runs launches under a pty (python3 `pty.fork`); it filters claude/codex/gsd_run off PATH and sets `XDG_CONFIG_HOME` to a missing dir (the machine's global git ignore hides `.claude/settings.local.json`). Reuse it for P7.
- start runs wt-new as a child (`GSD_LOCK_HELD=1 GSD_WT_NEW_SUPPRESS_NEXT=1`, stdout captured, printed only on success). The guard call is in-process (`guardArgv`), so `commandGuardsActive` / bash `gsd_command_guards_active` also accept `guardArgv(['--command'` in `src/commands/start.ts` (else T053). Any test grepping `bin/gsdt-start` for the guard must look at the TS too.
- No exec in Node: the launch is `releaseLock()` then `spawnSync` with inherited stdio in the worktree (signal → 128+n). `releaseLock` now clears its dir so the exit hook can't remove a lock another command took meanwhile.
- `src/update-check.ts` `updateNotice()` (bash `gsd_update_notice` via bash) is shared by list and start. `src/stdio.ts` (`out`/`err`/`inherit`, unbuffered so lines interleave with git's in shell order) — use it in P7.
- Parity not matched (all old-bash bugs): `-p 08` (bash died on octal after making the worktree; TS works); wt-new outside a repo (bash rc 128 silent; TS prints the error, rc 1); `gsdt-wt-new --help` (bash: unknown flag); `--phase '('` (bash leaked grep's error); unclaim's phase-dir pad is decimal. The push-race renumber path is tested only with a stub `gsd_run`.
- Dead now, not deleted: bash `gsd_stale_hooks`/`gsd_stale_hooks_notice` (`lib/provider.sh`) and `lib/gsd_hook_paths.py` (only oracles use them). `lib/roadmap-rows.pl` stays as the p2 oracle.
- **P7 notes.** Oracles: `tests/fixtures/p7-old-bins/{gsdt-finish,gsdt-wt-finish}`. `tests/ts/p7-helpers.ts` has fixtures (phase, batch, onMain, racer = a competing session pushing to origin, addTracker = custom tracker script logging argv, tool stubs). `p6-helpers.ts` now copies the p7 oracles into the old package, `Step.cmd` accepts finish/wt-finish, and `snapshot` also records tracker.log, gh.log, doctor.log and the merge-driver config. The p7 tests put stubs for gsdt-planning-repair, gsdt-planning-merge, gsdt-doctor, gh, race.sh first on PATH.
- (P9: finish/start now use `src/ticket.ts`; the bridge is gone.) finish and wt-finish call `gsdt-planning-repair` and `gsdt-doctor` from PATH, as bash did. Neither calls the guard (T053 unaffected).
- Not matched: wt-finish outside a repo (bash rc 128 silent; TS prints the error, rc 1). Test command with the worktree dir gone: bash wrote `…/bin/gsdt-wt-finish: line N: cd: …`, TS writes `gsdt-wt-finish: cd: <dir>: No such file or directory` (new-side test). Untested: `registerMergeDriver` failing (TS rc 255; bash had git's rc); a multi-line ID.
- Dead in bash now (only oracles + p4-ui use them; delete when the oracles go): `gsd_finish_gates`, `gsd_gate_tree(_done)`, `gsd_flow_finish_gate`, `gsd_origin_lacks`, `gsd_is_pr_helper`, `gsd_test_cmd`, `gsd_phase_branch`, `gsd_ui_finish_gate`. Still live: `gsd_acquire_lock` (gsdt-migrate, P8), `gsd_register_merge_driver` (`gsd_planning_apply`, bootstrap P8).
- **P8 notes.** Oracles: `tests/fixtures/p8-old-bins/{gsdt-init,gsdt-bootstrap-repo,gsdt-migrate,baseref.py,gsd_claude_env.py,drop_gemini_hook.py}`. Tests: `p8-init.test.ts` (22, ~3.5 min, `P8_ONLY=<regex>`), `p8-claude-settings.test.ts`, `p8-migrate.test.ts` (20, ~70 s; builds its 0.9.0 fixture from `git archive HEAD`'s bootstrap — now the TS one). `p6-helpers.ts` gained `Step.input` (stdin), `Step.fail`, `Project.noPlanning`, an optional full-tree snapshot; the old package also copies `shims/` + p8 oracles.
- **Two python-exact JSON writers** (`src/claude-settings.ts`, `src/pyjson.ts`) — made in parallel; merge them into one later (P11 or a cleanup). Never swap either for `JSON.parse`/`JSON.stringify`: that changes numbers (`1.0`, `1e5`, big ints) in people's settings files.
- **Rules text:** bootstrap + doctor T016 now read only `src/rules-text.ts` / `src/provider.ts`. The bash copy in `lib/provider.sh` is oracle-only (p1 parity still diffs it).
- Still on `jq`: bootstrap's hook merge into `.claude/settings.json` and `providerHookState` (kept for the "no jq → unverified" state + tests). Small follow-up to make native.
- Doctor T003 text ("no python 3.7+ … planning merges fall back to plain union") is stale (planning is TS) but `test-doctor` asserts it; `python()` in `src/common.ts` still used by doctor and `start.ts` (~line 513). Revisit in P11 when python stops being a requirement.
- Not matched (old bugs, new-side-only tests): `.gsd.conf` without final newline (bash glued the new key on); settings.json mode after the hook merge (bash left 0600; TS keeps the mode); init doesn't check `gsdt-bootstrap-repo` on PATH (in-process); init's planning-docs list is in name order (find's order before); "inside the toolkit repo" refusal; migrate without python works (old rc 2); a hook `matcher` that is a list/object (old python traceback, same result); a lone-surrogate escape → U+FFFD (untested).
- Dead in bash now (oracles only): `lib/gsd_claude_env.py`, `gsd_compact_settings`, `gsd_baseref*`, `gsd_acquire_lock` (no bin uses it), the `gsd_owned_*` / block helpers bootstrap used. `gsd_python` still used by `lib/install.sh`. CLAUDE.md still describes `lib/gsd_claude_env.py` as live — fix in P13 docs.
- **P9 notes.** Oracles: `tests/fixtures/p9-old-bins/gsdt-tracker` + `lib/tracker/*.sh` (left in place, unchanged, as its library — the old bin finds `../lib/tracker`). `lib/ticket.sh` stays too (oracle; `test-tracker` still unit-tests it and diffs it against `lib/tracker/ids.sh`). `p9-tracker.test.ts` (~90 s) builds an old package = fixture bin + a `lib/tracker/` copy; `p9-ticket.test.ts` diffs `lib/ticket.sh` vs `src/ticket.ts`, and `src/ticket.ts` vs `src/tracker/ids.ts` (the twins).
- Standalone layout: `bin/gsdt-tracker` + `src/launch.mjs` + `src/commands/tracker.ts` + `src/tracker/`. Nothing else in `src/` may import `tracker/` (linted in `test-tracker`). P11's `files`/`bin` must keep that set working alone.
- ClickUp still goes through `curl` as a child (stubs need it); request bodies are python-`json.dumps`-style (`\uXXXX`). Token files: only `KEY=value` / `export KEY=value` lines are read (bash sourced the whole file). Not matched (new-side tests): `snapshot --out` into a missing folder and `--page 08` (bash's own line-numbered errors); jq's error text on malformed JSON replies; jq's `1.0` number formatting.
- `ticketNorm` returns the id unchomped (like bash's `printf '%s\n'` before `$( )`); callers chomp. `trkIdNorm` chomps itself.
- **Flaky (not P9):** `test-update` "a newer GSD on npm…" (4 asserts) can fail when the machine's real `npm` is slow: lines ~134–146 run `gsdt-list` before the `npm` stub exists, so a background refresh with the REAL npm writes `latest-gsd-core-version` after line 155's `rm`. Seen once on this branch; reran 86/86 twice on both this tree and HEAD. Fix later: create the npm stub before the first notice test.
- Dead now: `lib/tracker/*.sh` and `lib/ticket.sh` (oracles only). CLAUDE.md's tracker bullets still describe the bash files — fix in P13 docs.
