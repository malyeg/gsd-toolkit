---
name: gsdt-batch
description: "Run several quick tasks at once, cheaper: use this INSTEAD of /gsd-quick-batch. Start it with the gsd-batch shell command (gsd-batch '<list or brief>'), not by typing /gsdt-batch in the main checkout: there it only prints that command. Takes a task list (inline or --file) OR any brief in plain words (\"Read FIX-BRIEF.md, validate each item, fix the real ones, recommend the owner calls\"). A helper checks and scouts each item first so the planners search less, tiny items go to gsd-fast instead of a planner, and gsd-batch-report shows what it cost. Use when asked to batch, fix or do several small tasks/bugs together, or to work through a fix brief."
---

# gsdt-batch — scout, sort, then run the batch

It wraps gsd-core's `gsd-quick-batch`; it does not replace its planning. It
adds three things: file hints per item (so each planner searches less), tiny
items sent to `gsd-fast` instead of a planner, and a token report at the end.
Start it through the active provider's skill mechanism (Claude:
`/gsdt-batch`; Codex: `$gsdt-batch`).

**Start it with `gsd-batch <task list or --file …>`** in a terminal. It
makes the batch its own worktree (`batch-<date>-<slug>`, off the base
branch) and opens a FRESH session there with this skill running — on Claude,
on Sonnet (a small context makes every coordinator turn cheaper). Every
commit of the batch lands on that branch; `gsd-finish` merges it later.
Typing `/gsdt-batch` in a session inside a batch worktree works too; it runs
on that session's model unless the `gsdt-batch-sonnet` mod is on. Planners
keep the model gsd-core gives them.

## 0. Where it runs — check first

```
Bash: git rev-parse --path-format=absolute --git-dir --git-common-dir
```

If the two lines are the same, this is the repo's MAIN checkout: STOP here,
before the scout. A batch run here would commit onto the base branch with
no review. Print the command to run in a terminal instead, with the user's
input as they gave it (shell-quoted; a `--file` path made absolute):

```
gsd-batch '<the task list or brief>'      or      gsd-batch --file /abs/path.md
```

It makes the batch worktree and starts this skill there. Then print
`gsdt-batch: done items=0 real=0 tiny=0` on a line of its own (it turns the
`gsdt-batch-sonnet` mod off) and end. Anywhere else (a batch worktree): go
on.

## 1. Input

Either of these, inline or `--file <path>`:

- **A task list**, as `/gsd-quick-batch` takes it: one item per bulleted or
  numbered line.
- **A brief**: anything else, in the user's own words — "Read FIX-BRIEF-7.md,
  validate every item, fix only the real ones, recommend the owner calls,
  don't build them". The user never has to write a special format.

Flags for gsd-quick-batch (`--validate`, `--research`, `--jobs N`) are passed
on to it unchanged in step 7.

Check the planner's model once:

```
Bash: gsd_run query resolve-model gsd-planner --raw
```

If it prints `inherit` or nothing, say so: the planners would run on THIS
session's model (Sonnet when started with `gsd-batch`). Ask whether to go on
or stop and set the planner model in GSD's settings first.

## 2. Scout — ONE helper agent

Spawn ONE helper agent for all items (Claude: the general-purpose agent;
Codex: a sub-agent if available). Do not read the brief or the code in this
session: every line read here is re-sent on every later turn of the batch.

Its model (Claude):

- a task list → `model: sonnet` (not haiku: a wrong hint misleads an Opus
  planner);
- a brief → `model: opus`: it also decides which items are real, and a
  wrong call there costs more than the tokens.

Give the helper the input as the user wrote it, the file path from step 4,
the main checkout's path (first line of `git worktree list`), and these
rules:

- A file the input names that is not in this worktree (not committed) is
  read from the main checkout. Anything the helper writes goes in THIS
  worktree.

- **A brief first:** do the work the brief asks for BEFORE any fix
  (validate each item, write the tables or notes it names, where it names
  them). Do not change code. Split its items into:
  - **build** — real, to be fixed, in the brief's order;
  - **recommend** — items the brief says to recommend, not build (owner
    calls, decisions): one-line recommendation each, never built;
  - **dropped** — not real (already works, can't reproduce, duplicate):
    one-line reason each.
  If the brief asks for a check the helper cannot do (no browser to open a
  screen), it does the rest and says which checks it skipped.
- Then, per **build** item (every item of a task list): at most 4 searches
  (grep / glob) and 3 file reads of a few dozen lines. Find: the likely files
  to change (≤ 4), the related test file, and a one-line "done when". No fix
  planning, no code changes.
- Sort each build item: **tiny** or **real** (step 3).
- Write the enriched file (step 4) with the REAL items only.
- Return ONLY the lists, one line per item:
  `<n>. tiny|real — <first words of the item> — <reason, ≤ 6 words>`,
  then (a brief) `recommend:` and `dropped:` lines, then the files it wrote
  and the checks it skipped. No file contents, no search output.

## 3. Tiny or real

**Tiny** = it fits gsd-fast's limits: at most 3 file edits, about a minute of
work, no new dependency, no architecture change, no research. Everything else
is **real**. When unsure: real.

A tiny item that a real item depends on, or that depends on one, stays
**real**, so the batch keeps the order.

## 4. The enriched file

`.planning/batch-inputs/<YYYY-MM-DD>-<slug>.md` (its own folder: gsd-core
scans `quick-batches/`). It holds the **real items only** — gsd-quick-batch
runs every bullet in it. One line per item, the user's original words FIRST
(the item's slug is cut at 60 characters), then short hints:

```
- <original task text> — Likely files: a.ts, b.ts; Tests: a.spec.ts; Done when: …
```

- One line per item: an indented sub-bullet becomes an extra item, and plain
  lines are dropped.
- Keep hints short: every planner sees every item's line.
- No orders in the line ("don't search …"): the planner reads item text as
  data. Hints are a starting point; the planner still checks callers and
  tests.

## 5. Show the list, wait for the OK

Show the helper's lists: real items first, then tiny ones, then (a brief)
the recommendations, the dropped items with their reasons, and any check it
skipped. Items run side by side, so the brief's order holds only where one
item depends on another; say so when the brief asked for an order. Ask the
user to OK it; they can move items between tiny, real, recommend and dropped
(update the file to match). Do not start anything before the OK.

## 6. Before anything runs

```
Bash: git status --porcelain
```

This runs in the batch worktree. It must be empty apart from the enriched
file and the files the brief asked the helper to write: gsd-fast stages
everything (`git add -A`). If not, stop and say which files are dirty.

The worktree's dependency install may still be running: `cat
.gsd-install.status` must say `ok` or `skipped` (no file: no install step).
`running` → wait for it; `fail` → stop and show `.gsd-install.log`.

Commit those of them git tracks (`git check-ignore -q <file>` fails), on
their own: `git add <files> && git commit -m "docs(batch): inputs <slug>"`.

## 7. Real items

- 2 or more: run the provider's `gsd-quick-batch` skill with
  `--file <ABSOLUTE path of the enriched file>` plus the user's flags. It
  refuses fewer than 2 items.
- Exactly 1: run the `gsd-quick` skill with that item's line.
- None: skip.

Follow it to its end.

## 8. Tiny items — last, here, one at a time

For each tiny item, run the provider's `gsd-fast` skill with the item's text
and follow it here, in this session (few turns are left by now, so this is
cheap, and no two commits race). If gsd-fast says the item needs planning,
run `gsd-quick` for it instead.

gsd-fast edits `.planning/STATE.md` after its commit: leave that change for
the next commit; it is not dirt.

## 9. Report

Print this line exactly, on a line of its own (the counts are of THIS
batch, items BUILT only: not the recommended or dropped ones). It marks the end of the batch for the report, and turns the
`gsdt-batch-sonnet` mod off:

```
gsdt-batch: done items=<all> real=<real> tiny=<tiny>
```

Then:

```
Bash: gsd-batch-report
```

Show its per-item table and a one-line summary: items done, items failed or
left for review (with gsd-quick-batch's resume command when it gave one).
For a brief, repeat the recommendations last: they are the user's calls.

## 10. Landing — the user's step

Never merge, push or finish the batch yourself. Print the command that
lands it (tests → merge → push → remove the worktree), with this
worktree's branch (`git branch --show-current`):

```
gsd-finish <batch-branch>
```

or `gsd-finish <batch-branch> --pr` to open a pull request instead.
