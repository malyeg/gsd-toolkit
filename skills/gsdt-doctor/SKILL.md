---
name: gsdt-doctor
description: "Check this repo's GSD setup with gsdt-doctor and fix what it finds, asking first — including a context that got too big: oversized ROADMAP/STATE files, and (Claude) skills, plugins and CLAUDE.md text via Claude's /skill-doctor, /context and /doctor. Use when asked to run the doctor, fix GSD setup problems, or slim down the context GSD adds."
---

# gsdt-doctor — find with gsdt-doctor, fix with the user's yes

`gsdt-doctor` only reads. This skill does the fixing, one item at a time, after
the user agrees. It follows `gsdt-doctor --json`; it adds no rules of its own.
Start it through the active provider's skill mechanism (Claude:
`/gsdt-doctor`; Codex: `$gsdt-doctor`).

## 1. Read

```
Bash: gsdt-doctor --json
```

From the JSON use:

- `findings` [{code, message, fix}] — real problems (exit status 1).
- `context.agents` [{name, skills, skill_tokens, agents, agent_tokens, …}] —
  what gsd-core adds to every session. Ignore `hideable`: see step 3.
- `context.big_files` [{path, kib, tokens, fix}] — GSD files too big to keep
  reading at every step.
- `safe` — the fixes `gsdt-doctor --fix` would run (empty: none).
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
Bash: gsdt-doctor --fix --yes
```

It changes files but never commits. Show `git status --short` and ask before
committing.

## 3. gsd-core skill groups — do not offer

Do not ask to hide gsd-core skill groups. The saving is a few hundred tokens,
not worth a question. Only if the user asks to hide skills: show `hideable`
and follow gsd-core's `gsd-surface` skill with `disable <group>`. Never edit
`.gsd-surface.json` or the skills folder yourself.

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

## 6. The agent's own context (Claude only)

Claude's built-in checks see what gsdt-doctor does not: CLAUDE.md files,
memory, MCP servers, plugins, unused skills. They run from the shell with
`claude -p` (one command, print, exit). Skip this step and step 8 when the
agent is not Claude or `claude` is not on PATH.

These two are free (no model call). Run them and give a short summary — the
biggest costs and the skills never used:

```
Bash: claude -p "/skill-doctor"
Bash: claude -p "/context"
```

`/context` measures a fresh session: what every session costs before the user
types, not this session.

## 7. Check again

```
Bash: gsdt-doctor
```

Report what is fixed, what is left, and what the user chose to keep.

## 8. Last: Claude's /doctor (ask first)

Ask once: run Claude's `/doctor` to clean up the rest (unused plugins and
skills, CLAUDE.md text to cut or move)? Say it is a real model run (a minute
or two) and that it applies its own fixes without asking each one. Only on a
yes:

```
Bash: claude -p "/doctor"
```

(timeout 10 minutes). It uses the user's permission mode: when that mode
blocks edits, it only reports. Show its summary: what it changed, how to undo
it, and what it left for the user.
