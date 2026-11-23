---
name: gsdt-idea
description: "Turn an idea, a high-level requirement or a thin ticket into work that is ready to start. Takes plain words, a ticket id or a ticket URL. It talks the idea through with the user, sorts it (drop it, keep it for later, a small job, one phase, several phases) and, only after the user agrees, creates or completes the ticket and prints the gsdt-start command. It claims no phase and writes nothing to the repo. Use when the user has an idea or a rough requirement, asks whether or how to build something, wants to brainstorm a feature, or has a ticket that is only a title."
---

# gsdt-idea — from an idea to work that is ready to start

`gsdt-start` builds a feature whose scope is already clear. This skill is the
step before it: the user has an idea, a rough requirement, or a ticket that
says too little. Start it through the active provider's skill mechanism
(Claude: `/gsdt-idea <idea | ticket id | ticket URL>`; Codex: `$gsdt-idea …`).
It runs in any session and any checkout: it only reads.

## What it never does

- **It claims nothing.** Never run `gsdt-start`, `gsd-phase` or anything else
  that adds a phase or a worktree. The last step prints the command; the user
  runs it. `gsdt-start` claims and pushes the phase at once, even when it
  cannot open a session.
- **It writes nothing to the repo.** No file, no commit. The draft lives in
  this conversation until the user picks an outcome. Do not run `gsd-explore`
  here: it saves files in the checkout and commits them.
- **It writes no ticket without a yes to the exact text.** The user may not
  like where the talk went: then nothing is made.

## 1. Read the input

Run `gsdt-tracker which` once.

- **A ticket id or URL** (`869e33cv4`, `PROJ-42`, `tk-<id>`, `#<id>`, a link):
  read it with `gsdt-tracker snapshot <id>`. If that fails, say so and ask the
  user what they meant. A failed lookup is never a reason to treat the text
  as an idea or to create a ticket. With `none`, no ticket can be read: tell
  the user and ask for the idea in words.
- **Plain words:** that is the idea.
- **One odd word that could be either:** ask.

## 2. Look before you talk

Keep it short; this is a check, not research.

- `gsdt-list`, and `.planning/ROADMAP.md` (backlog phases 999.x too): does a
  phase already cover it? Then say so and name `gsdt-start -p <N>`.
- With a tracker that can search: `gsdt-tracker tasks --match "<words>"`. A
  ticket that already covers it is the one to use.
- The code and docs, just enough to say what the product does today.

## 3. Is it ready?

Work is ready when these four are answered, in product words:

1. **Who** is it for, and why do they need it?
2. **What** can they do afterwards that they cannot do now?
3. **What is left out** on purpose?
4. **Done when:** how will the user see that it works?

A ticket that answers all four is a good ticket: ask nothing, go to step 5.
Anything less is thin: go on to step 4.

## 4. Talk it through

- One question at a time, in plain words, at most three options, the one you
  recommend first with a one-line reason.
- Ask only for what is missing from the four points. Three to six questions
  is normal. Stop when the four are answered or the user says it is enough.
- What the code or the docs can answer (how it works today), find out
  yourself: do not ask the user.
- **Never invent product intent.** What the product should do is the user's
  call. A guess is asked as a question with your recommended answer; it is
  never written down as a fact. What stays unanswered goes under "Open
  questions".

## 5. Sort it

Propose one outcome and why; the user decides.

| Outcome | When | What happens |
|---|---|---|
| drop | the talk showed it is not worth doing | nothing is made |
| later | worth doing, not now | ask before running `gsd-capture` (a todo) or `gsd-capture --backlog` (phase-sized): it writes to the repo |
| small job | no product decision is open and a few files change | say so and name `gsdt-batch '<task>'` (a terminal) or `gsd-quick`; a hint only, the user may still want a phase |
| one phase | one feature that ships on its own | steps 6–8 |
| several phases | too big for one, or parts that ship on their own | show the split and the order first; each part gets its own brief and ticket |

## 6. The brief

Write it in the conversation, in product words (no file or function names):

```
Title:          short; it becomes the phase name
Why / for whom:
What changes:   what the user can do afterwards
Out of scope:
Done when:
Open questions: (what nobody answered yet; discuss picks these up)
```

Show it and ask for a yes to this exact text. Change it until the user
agrees, or stop when they say no.

## 7. The ticket (only with a tracker, only after the yes)

**No ticket yet — create it.**

- Where: `gsdt-tracker config` prints `list=`. If it is empty, show the
  choices (ClickUp: `gsdt-tracker lists`), let the user pick, and offer to
  remember it for this clone: `git config gsdt-tracker.list <id>`.
- `gsdt-tracker create <list> "<Title>" --desc -` with the brief on stdin.
- Several tickets: one at a time. If one fails, stop, report the ids already
  made, and search (`tasks --match`) before any retry: a timed-out create
  may have worked.

**A thin ticket — complete it.**

- Read it again (`snapshot`) right before writing. If it changed since step
  1, show the user the new text and agree again.
- Its description is empty: `gsdt-tracker update <id> --desc -` with the
  brief.
- Its description has text: that text is someone's intent. Never remove or
  reword it. Add the brief as a comment (`gsdt-tracker comment <id> "…"`,
  the default: the flow reads comments too), or, if the user asks, write the
  description as the original text unchanged with the brief below it.

A tracker that cannot create or update says so: report it and give the user
the brief to paste. Report every id or URL you touched.

## 8. Hand over

Print the command; do not run it. Running it is the user's decision to start
building: it claims a phase, makes its worktree and moves the ticket to "in
progress".

- With a ticket: `gsdt-start --flow --ticket <id>`
- No tracker: `gsdt-start --flow -n "<Title>"`, and below it the brief in a
  block to paste as the first message of the phase session.
- Several phases: one line each, in the agreed order; say which can run at
  the same time.
- Add `--provider <name>` when the user named one.

End with one short list: what was made (ticket ids), what was not, and the
command(s) to run.
