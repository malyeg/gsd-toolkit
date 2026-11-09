---
name: gsdt-doctor
description: "Check this repo's GSD setup with gsd-doctor and fix what it finds, asking first — including a context that got too big: unused gsd-core skill groups, oversized ROADMAP/STATE files. Use when asked to run the doctor, fix GSD setup problems, or slim down the context GSD adds."
---

# gsdt-doctor — find with gsd-doctor, fix with the user's yes

`gsd-doctor` only reads. This skill does the fixing, one item at a time, after
the user agrees. It follows `gsd-doctor --json`; it adds no rules of its own.
Start it through the active provider's skill mechanism (Claude:
`/gsdt-doctor`; Codex: `$gsdt-doctor`).

## 1. Read

```
Bash: gsd-doctor --json
```

From the JSON use:

- `findings` [{code, message, fix}] — real problems (exit status 1).
- `context.agents` [{name, skills, skill_tokens, agents, agent_tokens,
  hideable [{group, skills, tokens}]}] — what gsd-core adds to every session,
  and the skill groups the phase flow never runs.
- `context.big_files` [{path, kib, tokens, fix}] — GSD files too big to keep
  reading at every step.
- `safe` — the fixes `gsd-doctor --fix` would run (empty: none).
- `updates` — newer gsd-toolkit / gsd-core (the user's call).
- `notes` — everything else, as text.

Show the user a short list: findings first, then context, then updates. Plain
words, one line each. Then go through the steps below in order. Skip a step
with nothing in it.

## 2. Safe toolkit fixes

If `safe` is not empty, name what it will do (these are mechanical and
undoable: regenerate shims and instructions, repair `.planning` counters,
remove a dead lock, …), ask once, then:

```
Bash: gsd-doctor --fix --yes
```

It changes files but never commits. Show `git status --short` and ask before
committing.

## 3. Hide gsd-core skill groups

For each agent with `hideable` groups: list the groups with their skill count
and tokens, and the skills in each (`/gsd-surface list` shows them). Ask which
to hide — the user may want none. A group is listed only when the phase flow
never runs any of its skills, so hiding it cannot break the flow; the user
loses only those commands, and `/gsd-surface enable <group>` brings them back.

For each chosen group, invoke or follow gsd-core's `gsd-surface` skill with
`disable <group>`. Never edit `.gsd-surface.json` or the skills folder
yourself. Tell the user it takes effect in the next session.

## 4. Big GSD files

For each `big_files` entry, say its size and why it costs (GSD reads it at
nearly every step). The fix is `gsd-complete-milestone`, and it is only right
when the current milestone has shipped: it archives the milestone, moves its
phase folders and rewrites STATE.md. Ask the user whether the milestone is
done; run it only on a clear yes. Never trim ROADMAP.md, STATE.md or
REQUIREMENTS.md by hand.

For a big `AGENTS.md`: suggest which parts could move to a doc file it links
to; edit only with the user's yes, and never inside the
`gsd-toolkit:provider:start` / `end` markers.

## 5. Other findings

Show each finding's `fix`. Run a command only after the user says yes. Never
commit, push, delete branches, or edit ROADMAP.md by hand — when a fix needs
that, show the command and let the user decide. Missing gsd-core skills
(T009): the fix names `/gsd-surface enable <group>` or the gsd-core installer;
run it on a yes.

## 6. The agent's own context (Claude)

Claude's built-in checks see what gsd-doctor does not: CLAUDE.md files,
memory, MCP servers, plugins, unused skills. A skill cannot start them. Tell
the user to type:

- `/doctor` — unused skills, MCP servers and plugins against their cost, and
  CLAUDE.md text to cut or move.
- `/skill-doctor` — each skill's cost and how often it runs.
- `/context` — the real token numbers.

## 7. Check again

```
Bash: gsd-doctor
```

Report what is fixed, what is left, and what the user chose to keep.
