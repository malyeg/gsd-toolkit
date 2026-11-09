# Agent-agnostic architecture

The shell workflow is the source of truth. `bin/`, `lib/common.sh`, the
planning reconciler, worktree rules, and `gsd-flow-next` form the shared core.
They may depend on `lib/provider.sh`; provider adapters must not contain phase
state, merge, claim, or safety policy.

## Provider interface

An adapter supplies CLI discovery/default executable, safe argument-array
rendering, project instruction filename, user skill directory, native-hook
capability, initialization/phase prompts, and warnings. Supported identities
are `claude`, `codex`, and `custom`. `gemini` is refused with a reason
(gsd-core dropped Gemini). Identity and executable are
separate: ordered `providers = codex,claude` makes Codex the default and can
use `agent_command = /opt/bin/codex`, while a multi-provider repository can
define `claude_command` and `codex_command` independently.
The singular `provider` key is a read-only compatibility input used only when
`providers` is absent; bootstrap migrates it to the canonical list.

Provider identity uses CLI, then `GSD_PROVIDER`, then the repository's first
`providers` entry (or legacy `provider`), then compatibility defaults. Executable
selection has its own chain: CLI, `GSD_AGENT_COMMAND`, provider-specific
environment, provider-specific repository command, default-provider legacy
`agent_command`, then built-in name. See the [configuration reference](providers.md#configuration-reference).
`GSD_AGENT` remains a deprecated compatibility input. No adapter uses `eval`.

## Instructions and skills

The workflow rules are not copied into each repo. `gsd-rules` prints them
for the installed release (`gsd_rules_text`, `lib/provider.sh`), plus the
repo's values and, unless `ui_gates = off`, the screens paragraph. So a
release changes the rules in every repo through `gsd-update` alone.

`.gsd/INSTRUCTIONS.md` is the canonical generated block, now small: a pointer
to `gsd-rules`, a core that holds without the toolkit (one phase = one
worktree, `gsd-flow-next` before a phase action, `gsd-finish` never
automatic, never bypass a guard), and the values `gsd-init` writes
(providers, base, worktree dir). `flow` and `ui_gates` stay out: `gsd-rules`
reads them live from `.gsd.conf`, so editing them never makes the file
stale. It changes only when a value or the core changes, so T016 stays
meaningful. Provider files (`CLAUDE.md`, `AGENTS.md`)
receive only a marked, replaceable entrypoint pointing to both. Existing
content outside the markers is preserved.

How each provider gets the rules: Claude through a user-level `SessionStart`
hook (`lib/install.sh`, next to the guard's `--global` hook) that runs
`gsd-rules --hook` — it fires on startup, resume, `/clear` and compaction,
prints nothing outside a repo with `.gsd.conf`, and always exits 0; the
entry line is the fallback. Codex and custom have no such hook: the
`AGENTS.md` entry says to run `gsd-rules` first (checked: fresh Codex
sessions do, see `docs/plan-instructions-split.md`). Keep the output well
under ~10 KB: Claude Code saves a larger hook output to a file and shows
only its start. The shared `gsdt-flow` skill describes state transitions and asks the
active agent to use its own skill mechanism; it never calls a provider-native
skill API directly.

## Enforcement boundary

`gsd-worktree-guard --command … --phase … --repo …` is the mandatory,
provider-neutral validation API. `gsd-flow-next` calls it before it returns a
phase action, so every supported flow path enforces worktree matching,
dependency installation, and strict-flow order. The Claude adapter may
also register native pre-tool hooks for earlier feedback. Hooks are optional
defense in depth and Codex currently has no integration registered here.

No toolkit can stop a user or agent that bypasses GSD and executes arbitrary
shell commands directly. The supported boundary is the `gsd-*` launch/flow
route plus optional provider hooks. `gsd-start` validates the destination before
printing or launching a session; flow launches also check the current step when
phase artifacts exist. `gsd-flow-next` always checks phase identity, including
ticket, UI decisions, and done, even without `.gsd.conf`. Its `--all` preview
checks location but does not authorize future steps. The flow skill checks
`then=` commands immediately before running them.

Nested agent worktrees inherit phase identity only from a containing phase
checkout with the same Git common directory. Naming a branch `agent-*` grants
no exemption. Install status `running` or `fail` blocks execution even if
`node_modules` exists; `ok` continues to strict-flow checks. Only the exact
escape hatch `GSD_SKIP_GUARD=1` disables the guard, with explicit user intent.

## Adding a provider

Extend the capability helpers in `lib/provider.sh`: identity validation,
instruction filename, skill root, argv renderer based on verified CLI help,
review strategy, and honest native-hook metadata. Bootstrap and doctor share
the integration predicates, and installation uses the same skill-root resolver.
If the provider needs a different skill format, extend installer handling too;
update CLI allowlists/help, migration documentation and provider tests. A new
native payload format belongs in the hook adapter, not phase policy. Do not copy
workflow or phase rules into an adapter.

Provider files sharing a filename (Codex/custom) use one block naming all its
configured members. Canonical instructions also use paired owned markers;
bootstrap updates only their span. The flow engine remains authoritative for
order; skills explain how to interpret its output, not a separate state machine.

Finish validates the phase before merging and the combined tree afterward,
including each remote retry. Failed validation retains local commits/worktree
and prevents push; failed initial sync aborts before the phase merge.
