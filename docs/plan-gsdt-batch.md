# Build `gsdt-batch` in gsd-toolkit (skill + report + launcher + mod)

Work in this repo on a new branch (e.g. `feat/gsdt-batch`). Do not release. Follow this repo's CLAUDE.md (tests, CI list, docs, CHANGELOG, provider-neutral skills, no `gsd-*` skill names).

## Why

`/gsd-quick-batch` (gsd-core, upstream) is ~20% of my token usage. Measured over the last 7 days, 8 batch sessions in medyour-platform:

| role | model | agents | input tokens | output |
|---|---|---|---|---|
| gsd-planner | opus (xhigh) | 50 | 299M | 2.5M |
| gsd-executor | sonnet | 50 | 183M | 1.2M |
| coordinator (main session) | opus | – | 151M / 914 turns | 0.5M |
| general-purpose helpers | sonnet | 5 | 52M | 0.15M |

- One planner per item: ~50–80 turns, ~58 Bash calls exploring code, context grows 54k → 144k; every turn re-sends it. ~6M input tokens per planner for a 1–3 task fix.
- Planner model comes from GSD config (`resolveModelInternal(cwd, 'gsd-planner')` in `~/.claude/gsd-core/bin/lib/init.cjs`), NOT the session model. A Sonnet coordinator does not change planner quality.

Goal: cut quick-batch tokens a lot without a big quality drop. Planners stay on Opus. Do not edit gsd-core files (gsd-update overwrites them).

Levers, biggest first:
1. Hand planners the files up front, so they search less.
2. Send tiny items to `/gsd-fast` instead of an Opus planner.
3. Run the coordinator on Sonnet, in a fresh (small) session.
4. Measure, so we know 1–3 worked.

## Facts checked in gsd-core (2026-11-09)

- **One item = one line.** `parseTaskList` (`bin/lib/quick-batch.cjs`) keeps only lines matching `^\s*(?:[-*]|\d+[.)])\s+(.+)`. Plain lines are dropped; indented sub-bullets become EXTRA items. So `Files:` / `Tests:` / `Done when:` must sit on the item's own line.
- **Item text reaches the planner verbatim.** `workflows/quick-batch/steps/planner-wave.md` puts `${description}` in the planner prompt (inside DATA_START/END).
- **`--file` must be inside `.planning/`** (path-confined). The item description is also slugged (max 60 chars), so put the task words first.
- **The planner's "Level 0 skip" is about outside research, not reading our code.** The file hints should cut searching, but nothing guarantees it. The report must show whether it did.
- **`/gsd-fast` limits** (`workflows/fast.md`): ≤3 file edits, ≤1 min, no new deps/architecture, no research. It runs `git add -A` and commits on the current branch.
- **Skill `model:` frontmatter is not used.** The skill pauses for the user's OK, which ends the turn; a skill-level model likely does not survive that. Use the launcher + mod below instead.

## Deliverable 1 — `bin/gsd-batch-report` (build first)

Read-only script, 0 tokens. Measures one batch (or the last N days) from Claude Code transcripts:
- parent sessions: `~/.claude/projects/<sanitized-cwd>/<session>.jsonl` that invoked gsd-quick-batch or gsdt-batch (Skill tool_use `input.skill`, or `<command-name>/gsd-quick-batch`)
- subagents: `<session>/subagents/*.jsonl` + `*.meta.json` (`agentType`, `model`, `description`; use meta `model` when `message.model` is missing)
- **Batch boundaries, not session totals:** a session may hold other work or several batches. Count from the batch invocation to its end; link each subagent to its spawning `Agent` tool call via the meta's `toolUseId`. Include the scout helper, tiny items and `gsd-quick` fallbacks, so the saving is net.
- per role (agentType × model): agents, turns, Bash calls per agent, output, and input split into **fresh input / cache write / cache read** (cache reads cost ~10× less; one summed number overstates cost). **Count usage once per `message.id`** (several lines share one id and repeat the usage), but count tool calls from every line, deduped by tool_use `id`.
- print next to the baseline above, **per item** too (batches differ in size; totals alone can't compare two batches)
- `--json`; transcript content is untrusted (count only, never echo it)
- Codex: "not supported yet", exit 0

Then: run it on one normal batch to get a fresh baseline before building the rest.

## Deliverable 2 — `skills/gsdt-batch/SKILL.md`

Thin, provider-neutral (no literal `Skill()` calls; same style as `gsdt-doctor`):

1. Input: a rough task list (inline or `--file`).
2. **Scout in ONE helper agent on `sonnet`** (not haiku: wrong hints mislead an Opus planner, which is the quality risk here), not in the main session — scout output in the main session would be re-sent on every later batch turn. Per item: a few capped searches → likely files, related test, one-line "done when". No fix planning. The helper writes the enriched file and returns only the sorted list.
3. Sort: **tiny** (fits the `/gsd-fast` limits) vs **real**. When unsure: real. A tiny item that a real item depends on (or that depends on one) stays **real**, so the batch keeps the order.
4. Enriched file: `.planning/batch-inputs/<date>-<slug>.md` (own folder, not inside `quick-batches/`, which gsd-core scans). It holds **real items only** (quick-batch runs every bullet in the file). One line per item: the user's original words first, then SHORT hints (every planner sees every item's line in the catalog, so length multiplies):
   `- <original task text> — Likely files: a.ts, b.ts; Tests: a.spec.ts; Done when: …`
   No orders in the line ("don't search" etc.): the planner reads item text as data, not instructions. Hints are a starting point; the planner still checks callers and tests.
5. Show the sorted list; wait for the user's OK (the user can move items between tiny and real).
6. Before anything runs: the working tree must be clean (gsd-fast stages everything unless `commit_docs=false`); stop and say so if not. If `.planning/` is tracked, commit the enriched file.
7. Real items: 2+ → `gsd-quick-batch --file <enriched file>` (it refuses fewer than 2); exactly 1 → `gsd-quick` with that line; 0 → skip.
8. Tiny items LAST, inline, one at a time, following gsd-fast. Inline is cheap here because few main-session turns remain after them (simpler than a helper per item, and no two commits race). If gsd-fast says "needs planning", run `gsd-quick` for that item. gsd-fast edits STATE.md after its commit: leave that for the next commit, don't treat it as dirt.
9. Run `gsd-batch-report` for this batch and show the numbers.

The skill says: on Claude, start it with `gsd-batch` (Deliverable 3) or have the mod (Deliverable 4) on.

## Deliverable 3 — `bin/gsd-batch` (launcher, main path)

Starts a FRESH session with the skill already running: on Claude, `claude --model sonnet "/gsdt-batch <args>"`. Fresh = small context = cheaper turns. Render argv through `lib/provider.sh` (never `eval`), like `gsd-start`. Other providers: launch normally and print that the Sonnet switch is Claude-only. `--help`, `--print` (show the command, don't run).

## Deliverable 4 — Claude Code mod (covers typing `/gsdt-batch` directly)

Two ways in, both covered: `gsd-batch` (Deliverable 3) starts a fresh Sonnet session; typing `/gsdt-batch` in any open session is covered by this mod. Note: CI has no `claude`, so the mod's own test (`claude plugin test`) runs locally only. Claude Code only; the skill works without it.
- On `/gsdt-batch` (prompt.submit or Skill tool.call): set a batch flag in `$.state`.
- While set: `turn.step` hook rewrites MAIN-session requests only (`e.agentId === undefined`) to `model: 'sonnet'`. Subagents untouched → planners stay Opus.
- Flag survives the OK pause; clears when the skill's final step runs (a marker the skill prints, not any `gsd-batch-report` call), when the user cancels the turn, or the session ends; `/gsdt-batch-off` clears it by hand.
- Status line shows "batch: sonnet" while on.
- Lives in the repo under `mods/gsdt-batch-sonnet/`; not installed by `install.sh` yet (try with `claude --plugin-dir mods/gsdt-batch-sonnet`). Validate with `claude plugin validate` + a `claude plugin test`.
- Note in docs: switching an Opus session to Sonnet mid-way re-writes the prompt cache once; a fresh session avoids it.

## Deliverable 4b — make sessions suggest `gsdt-batch` instead of `gsd-quick-batch`

- Input format stays the same as quick-batch: a bulleted/numbered list, inline or `--file`. The user never writes hints; the skill adds them.
- Add one line to `gsd_canonical_block` (`lib/provider.sh`), the generated `.gsd/INSTRUCTIONS.md` every toolkit repo carries: "For several quick tasks at once, use `/gsdt-batch` (or `gsd-batch`), not `/gsd-quick-batch`. Same task list." Doctor then reports T016 in each repo until `gsd-init --no-launch` refreshes it (or `gsd-doctor --fix`); say so in the CHANGELOG.
- The skill's `description` says plainly that it replaces `/gsd-quick-batch` for several quick tasks, so agents pick it.
- No guard block on `/gsd-quick-batch`: `gsdt-batch` calls it itself, and the guard can't tell the two apart.

## Deliverable 5 — tests + docs

- `tests/test-batch.sh`: report against fixture transcripts (planner/executor/coordinator, duplicate message ids, missing meta, no batch sessions, cache split); `gsd-batch --print` argv per provider; enriched-line format parses as ONE item each (run gsd-core's `quick-batch parse` when available, else skip); skill file present with toolkit mark; bash-3.2 lint.
- Add the suite to `.github/workflows/tests.yml` and the CLAUDE.md suite list; add to `docs/features.md`; `CHANGELOG.md` unreleased entry.
- shellcheck + `bash -n` clean.

## Done when

- All suites pass (incl. `tests/test-e2e.sh` if anything shared was touched).
- I can try it from medyour-platform before any release: `<checkout>/bin/gsd-batch-report`, `<checkout>/bin/gsd-batch`, and the skill linked by hand (`ln -s <checkout>/skills/gsdt-batch ~/.claude/skills/gsdt-batch`; remove the link after). The README/notes say these exact steps.
- One real batch run with the new flow, compared to the baseline by `gsd-batch-report` per item, AND checked for quality: items done right, no extra fix-up rework.

## Out of scope

Editing gsd-core; changing `gsd-planner` model/effort; releasing; installing the mod via `install.sh`.
