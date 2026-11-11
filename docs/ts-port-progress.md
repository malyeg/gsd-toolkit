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

**P5** — List + doctor: `bin/gsdt-list` → `src/commands/list.ts`, `bin/gsdt-doctor` → `src/commands/doctor.ts` (+ `lib/context.sh`, `lib/gsd_hook_paths.py` → `staleHooks` in TS, `providerHookState` without `jq` if easy), through the launcher. Doctor's T021–T023 switch from `roadmap-audit.pl` to `src/roadmap.ts` (keep the perl as the parity oracle). Doctor stays read-only; `--fix` dispatches by name. Also: thread the guard's `opts.env` into rule 5's UI helpers (see P4 notes). Suites: `test-list`, `test-doctor` (+ P5 parity tests under `tests/ts/`).

## Phases

| | Phase | Ports | Suites that must pass |
|---|---|---|---|
| [x] | P0 Decisions + scaffold | Ask the plan's Open questions (one AskUserQuestion each, context in the question); record answers below. `package.json`, `tsconfig` (TS 7, `erasableSyntaxOnly`, Node ≥ 24), `src/`, launcher pattern, `tsc --noEmit` in CI, one trivial command (`gsdt-derive-port`) through the launcher. | `tests/test-commands.sh` (derive-port part) + all suites still green |
| [x] | P1 Core libs | `lib/common.sh` → `src/common.ts`, `lib/provider.sh` → `src/provider.ts`, `gsdt-rules` | `test-providers` (rules/blocks parts), `test-commands` |
| [x] | P2 Planning | `gsd_planning.py`, `roadmap-*.pl`, `gsdt-planning-repair`, `gsdt-planning-merge` | `test-planning-reconcile`, `test-review-round2` |
| [x] | P3 Guard + flow | `gsdt-worktree-guard` (+ hook payload), `gsdt-flow-next` | `test-worktree-guard`, `test-flow-next` |
| [x] | P4 UI | `lib/ui.sh`, `gsdt-ui`, `ui-check.mjs` → TS | `test-ui`, `test-ui-browser` (if Playwright available) |
| [ ] | P5 List + doctor | `gsdt-list`, `gsdt-doctor` (+ `context.sh`, hook paths) | `test-list`, `test-doctor` |
| [ ] | P6 Start | `gsdt-start`, `gsdt-wt-new` | `test-commands`, `test-e2e` |
| [ ] | P7 Finish | `gsdt-finish`, `gsdt-wt-finish` | `test-commands`, `test-review-fixes`, `test-e2e` |
| [ ] | P8 Init + migrate | `gsdt-init`, `gsdt-bootstrap-repo`, `gsdt-migrate`, Claude env helper | `test-providers`, `test-migrate`, `test-doctor` |
| [ ] | P9 Tracker | `gsdt-tracker`, `lib/tracker/*`, `ticket.sh` (stays standalone) | `test-tracker` |
| [ ] | P10 The rest | `gsdt-batch`, `gsdt-batch-report`, `gsdt-codex-wait` | `test-batch`, `test-codex-wait` |
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
- `src/bash-bridge.ts` `bashLib(fn, args, env)` sources common/ticket.sh and runs one bash function. Since P4 its only user is flow-next (`gsd_tracker_which`/`gsd_ticket_extract` → P9; delete the file then).
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
