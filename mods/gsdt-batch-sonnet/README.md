# gsdt-batch-sonnet (Claude Code mod)

While a `/gsdt-batch` run is on, the MAIN session's model requests go to
Sonnet (the coordinator). Subagents keep their own model, so gsd-core's
planners stay on Opus. Claude Code only; the `gsdt-batch` skill works without
it.

- **On:** the `gsdt-batch` skill starts (typed `/gsdt-batch`, or the Skill
  tool). It stays on through the skill's pause for your OK.
- **Off:** the turn that prints `gsdt-batch: done …` ends, you cancel a turn
  (Esc), the session ends, or you type `/gsdt-batch-off`.
- The status line shows `batch: sonnet` while it is on.

The other way in needs no mod: `gsd-batch <task list>` starts a fresh session
on Sonnet with the skill running. That is cheaper too: switching an Opus
session to Sonnet mid-way writes the prompt cache again once (Sonnet has its
own cache), and a fresh session starts small.

## Try it

Not installed by `install.sh` yet. From a checkout:

```sh
claude --plugin-dir <checkout>/mods/gsdt-batch-sonnet
```

## Check it

```sh
claude plugin validate mods/gsdt-batch-sonnet
claude plugin test mods/gsdt-batch-sonnet     # needs `claude`: not run in CI
```
