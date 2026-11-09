# Plan: gsd-doctor watches context size; gsdt-doctor fixes it

Status: **built** 2026-11-09 (unreleased). Agreed the same day (option A: GSD parts only).

## Why

Every session pays for what loads before you type: skill and agent
descriptions, instruction files, memory, MCP tools. GSD adds a lot of it:
gsd-core installs ~76 `gsd-*` skills and ~35 `gsd-*` agents. Measured on one
machine (2026-11-09): skill descriptions ≈ 3k tokens, agent descriptions ≈ 2k
tokens, every session. The full skill text (≈ 51k tokens) loads only when a
skill runs. Most of those skills are never used.

GSD's own files grow too. `ROADMAP.md`, `STATE.md`, `REQUIREMENTS.md` and
`PROJECT.md` are read at nearly every GSD step.

## What Claude Code already does (so we don't)

- `/doctor` (in a session): unused skills, MCP servers and plugins against
  their context cost; CLAUDE.md text that is duplicated or derivable; offers to
  move always-loaded text into on-demand skills. Asks before changing.
- `/skill-doctor`: each skill's context cost and how often it runs.
- `/context`: the real token numbers, by category. Session only.
- `claude doctor` (shell): install and settings only.

These see Claude only, and they know nothing about GSD. gsd-doctor covers the
rest and points at them.

## gsd-doctor (read-only, as always)

1. **T009 checks skills, not the profile name.** Before: any profile but
   `full` was a finding. Now: the finding names the skills the phase flow runs
   that are missing from the agent's skill folder (`gsd_core_required_skills`:
   discuss, plan, review, execute, code-review, verify-work, validate, secure,
   `gsd-init`'s new-project and ingest-docs, plus ui-phase, ui-review and
   sketch unless `ui_gates = off`). So a skill set trimmed with `/gsd-surface`
   passes as long as the flow's skills are there. With no `gsd-*` skill in the
   folder (gsd-core put them elsewhere) the old profile check stays.
2. **A "context" section.** Per configured agent with a skill folder:
   - a line with the count and estimated tokens (characters / 4) of gsd-core's
     skill and agent descriptions;
   - a note naming the gsd-core skill groups the flow does not use, with the
     skills and tokens each would save, and the command:
     `/gsd-surface disable <group>`. Groups come from gsd-core's own
     `clusters.cjs` (read with node); without node or that file, no note.
     Groups already disabled in `.gsd-surface.json` are left out.
   - Claude only: a note pointing at `/doctor`, `/skill-doctor`, `/context`.
3. **Big GSD files** (GSD repos only): a note when `ROADMAP.md`, `STATE.md`,
   `REQUIREMENTS.md` or `PROJECT.md` is over 32 KiB (~8k tokens). The fix:
   `/gsd-complete-milestone` once the milestone has shipped (it archives the
   milestone's ROADMAP and REQUIREMENTS and keeps ROADMAP short).
4. **AGENTS.md** (Codex configured): a note when the repo's `AGENTS.md` is over
   32 KiB — Codex reads only the first 32 KiB by default
   (`project_doc_max_bytes`).
5. **`--json`** gets a `context` object: `agents` [{name, skills,
   skill_tokens, agents, agent_tokens, hideable [{group, skills, tokens}]}] and
   `big_files` [{path, kib, tokens, fix}].

All of these are notes, not findings: a big context is a cost, not a broken
setup, and must not fail CI. Nothing new goes on `--fix`'s safe list: hiding
skills is a choice, and gsd-core has no shell command for it.

## gsdt-doctor (new skill, does the fixing)

Runs in a session, so it can use skills. Named `gsdt-*` (gsd-core's installer
deletes `skills/gsd-*`). Provider-neutral, like the other toolkit skills. Like
`gsdt-flow`, it only reads `gsd-doctor --json` and acts on it — no second set
of rules.

1. Run `gsd-doctor --json`. Show findings, context cost, hideable groups, big
   files.
2. Safe toolkit fixes: ask, then `gsd-doctor --fix --yes`.
3. Skill groups: ask which to hide; for each, follow gsd-core's `gsd-surface`
   skill (`disable <group>`). Takes effect in the next session.
4. Big files: explain; offer `gsd-complete-milestone` only when the user says
   the milestone has shipped.
5. Other findings: show the fix; run it only on a yes. Never commit, push, or
   edit ROADMAP.md by hand.
6. Claude: tell the user to type `/doctor` and `/skill-doctor` (a skill cannot
   start them).
7. Run `gsd-doctor` again and report.

## Tests

`tests/test-doctor.sh`: T009 by skills (trimmed set passes, missing flow skill
fails, ui_gates = off drops the UI skills, the old profile check without
skills), the context JSON (counts, hideable groups from a stub `clusters.cjs`,
a disabled group left out), big-file notes. Skill list expectations in
`tests/test-update.sh` stay (that test installs a real older release).

## Not doing

- Measuring CLAUDE.md, memory, MCP servers, plugins: Claude's `/doctor` does it.
- Editing `.gsd-surface.json` or any agent settings from the toolkit.
- Hiding single gsd-core skills (decided 2026-11-09). `.gsd-surface.json`
  has `explicitRemoves`, but `/gsd-surface` has no command for it, so the
  toolkit would have to write gsd-core's file. Measured gain: the 4 groups
  that can be hidden save ~500 of ~4k tokens; the big `utility` group holds
  flow skills (execute-phase, code-review), so it stays.
- Suggesting to hide skill groups (decided 2026-11-09, after 0.8.2): on a
  real repo it saved ~200 tokens, so the text note and gsdt-doctor's question
  were noise. `hideable` stays in `--json`; gsdt-doctor hides a group only
  when the user asks.
- A `.gsd.conf` key for the 32 KiB limit (add one if someone needs it).
