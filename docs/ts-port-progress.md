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
to `package.json` `bin` + `dist/`. (P0 may refine this; if so, say why here.)

## Next

**P0** — decisions + scaffold.

## Phases

| | Phase | Ports | Suites that must pass |
|---|---|---|---|
| [ ] | P0 Decisions + scaffold | Ask the plan's Open questions (one AskUserQuestion each, context in the question); record answers below. `package.json`, `tsconfig` (TS 7, `erasableSyntaxOnly`, Node ≥ 24), `src/`, launcher pattern, `tsc --noEmit` in CI, one trivial command (`gsdt-derive-port`) through the launcher. | `tests/test-commands.sh` (derive-port part) + all suites still green |
| [ ] | P1 Core libs | `lib/common.sh` → `src/common.ts`, `lib/provider.sh` → `src/provider.ts`, `gsdt-rules` | `test-providers` (rules/blocks parts), `test-commands` |
| [ ] | P2 Planning | `gsd_planning.py`, `roadmap-*.pl`, `gsdt-planning-repair`, `gsdt-planning-merge` | `test-planning-reconcile`, `test-review-round2` |
| [ ] | P3 Guard + flow | `gsdt-worktree-guard` (+ hook payload), `gsdt-flow-next` | `test-worktree-guard`, `test-flow-next` |
| [ ] | P4 UI | `lib/ui.sh`, `gsdt-ui`, `ui-check.mjs` → TS | `test-ui`, `test-ui-browser` (if Playwright available) |
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

## Decisions (from P0)

<!-- npm name · legacy reads · bash maintenance line · gsdt-setup vs gsdt-init -->

## Notes for the next session

<!-- gotchas, half-done work, anything not obvious from the code -->
