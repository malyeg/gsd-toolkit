# Provider capability and troubleshooting matrix

| Capability | Claude Code | OpenAI Codex |
|---|---|---|
| Project instructions | `CLAUDE.md` | `AGENTS.md` |
| Skills | `~/.claude/skills` | `~/.agents/skills` (`GSD_CODEX_SKILL_DIR` overrides) |
| Interactive launch | positional prompt | positional prompt |
| Native guard hook | `PreToolUse(Skill)` | not installed by this toolkit |
| User-level hook (`install.sh`: `/gsd-new-project` only after `gsd-init`) | `PreToolUse(Skill)` + `UserPromptExpansion` (matcher `gsd.*`: a plain word is an exact match) in `~/.claude/settings.json` | none (the skill's written rule) |
| Required safety | `gsd-flow-next` command guard | same |

## Session models

`gsd-init` and `gsd-start` accept `--model MODEL_ID` for the session they
launch. Selection precedence is `--model` > `GSD_MODEL` > the matching
`GSD_CLAUDE_MODEL` or `GSD_CODEX_MODEL` > the matching
`claude_model` or `codex_model` key in `.gsd.conf` > no model
flag (the CLI default). The repo keys are optional. `--model default` explicitly
omits the model flag, even when a model is configured. Custom providers reject
non-default model selections because their model flag syntax is unknown.

Both known CLIs use `--model`. This setting affects only the session launched by these
commands, not existing or manually started sessions or upstream GSD subagent
and review models. Model selection makes no authentication changes or direct model API calls;
each CLI uses its existing authentication.

The toolkit does not claim identical skill chaining. Claude may directly invoke
slash skills. Codex receives a natural-language prompt naming the installed
skill and artifacts. When a native GSD
planning skill is unavailable, the adapter prints the exact next action instead
of silently treating the gate as complete.

All configured providers can use the same phase with
`gsd-start -p <N> --provider <name>`. They share the phase artifacts and worktree. This is a
sequential handoff model: commit or clean the worktree before another provider
takes over. Concurrent writers in one worktree are not safe; use parallel
providers on different phases for concurrent mutation.

Configure the set once as an ordered list, for example
`providers = codex,claude`. The first entry is the default when a
session does not pass `--provider`. Legacy repositories containing only
`provider = claude` continue to work; re-running `gsd-init` converts that key
to the canonical list without changing the selected provider.

Launch commands validate the whole `providers` list, even with a session
override. Empty entries, duplicate names, unknown names, and whitespace within
the comma-separated list are rejected before worktree creation. Fix the list
in `.gsd.conf`; `gsd-doctor` reports invalid provider configuration as `T050`.

By default, `gsd-start` opens or prints the full `gsdt-flow` session, which
resumes the phase at its first unfinished step from existing artifacts.
`--no-flow` opens only the provider's discuss-phase prompt for one invocation;
`start_mode = discuss` makes that the repo's default, and `--flow` overrides it.

### Gemini

Gemini is no longer supported, because gsd-core dropped it. `gemini` is
refused with a reason in `providers`, `--provider`, `--agent`, `GSD_AGENT` and
`review_provider`, and is never run as a `custom` command. To clean up a repo
an older release set up for Gemini, run `gsd-init --no-launch` (or
`gsd-doctor --fix`; doctor finding `T061`). It drops gemini from `providers`,
removes `gemini_command` / `gemini_model`, removes our marked block in
`GEMINI.md` (the file is deleted if nothing else is in it) and our hook in
`.gemini/settings.json`.

Run `gsd-doctor --json` to inspect the provider, executable, instruction block,
skill adapter, native hook, mandatory guard, stale artifacts, and remediation.
The doctor is read-only. JSON includes `session_model` (empty means CLI default)
and finding `T059` for malformed model selection. Model availability and account
access remain the provider CLI's responsibility. A missing executable does not
prevent `--no-launch`.

Model flag verification: Claude Code 2.1.280 and Codex CLI 0.153.4 installed help, checked 2026-09-23. Codex also documents the flag in its
[official CLI reference](https://developers.openai.com/codex/cli/reference/).

Native hooks can be disabled, unsupported, or bypassed by arbitrary shell use.
The supported enforcement boundary is the `gsd-*` launch and `gsd-flow-next`
path. No agent tool can prevent a user from directly running unrelated shell
commands outside that path.

Launch and flow guards run for every provider, including repositories without
`.gsd.conf`. A running/failed install blocks execution even if partial
`node_modules` exists. After a successful manual install, record completion
with `printf 'ok\n' > .gsd-install.status` in that worktree. This does not skip
strict-flow gates. A missing phase directory is not evidence that prerequisite
work was completed: discuss may create it, but strict planning still requires
its context artifact (or the explicit `--prd` path).

## Configuration reference

`.gsd.conf` uses `key = value` with `#` comments; do not quote values or write
shell expressions. Names are case-sensitive. Commands are executable names or
paths without whitespace, not templates. Model IDs cannot contain whitespace.

| Selection | Precedence (highest first) |
|---|---|
| Session provider | `--provider` (legacy `--agent` mapping), `GSD_PROVIDER`, first `providers` entry, legacy `provider`, deprecated `GSD_AGENT`, Claude compatibility default |
| Executable | `--agent-command`, `GSD_AGENT_COMMAND`, `GSD_<PROVIDER>_COMMAND`, `<provider>_command`, legacy `agent_command` for repo default only, built-in name |
| Model | `--model`, `GSD_MODEL`, `GSD_<PROVIDER>_MODEL`, `<provider>_model`, CLI default |
| Start behavior | `--flow` / `--no-flow`, `start_mode`, `flow` default |
| Compact point | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` already exported (Claude), `GSD_COMPACT_AT`, `compact_at`, `300000` |

Initialization persists the integration set selected by `--providers`; without
that flag, an explicit `--provider` selects a one-provider setup. Session overrides
on `gsd-start` do not rewrite the set. Refer to `gsd-init --help` for setup flags.

| Repository key | Meaning / default |
|---|---|
| `providers` | Ordered comma-separated known identities, no empty/duplicate entries; first is default |
| `claude_command`, `codex_command`, `custom_command` | Provider executable; custom requires one |
| `claude_model`, `codex_model` | Optional model ID; `default` omits the flag |
| `review_provider` | Independent reviewer: `claude`, `codex` (default), or `custom` |
| `start_mode` | `flow` (default) or `discuss` |
| `compact_at` | Tokens at which a launched session compacts: 100000–1000000, default `300000`; `default` keeps the CLI's own. Claude gets `env CLAUDE_CODE_AUTO_COMPACT_WINDOW=<n>`, and `gsd-start` saves it in the worktree's `.claude/settings.local.json` `env` (a plain `claude` there gets it too; an exported window or `default` removes it); Codex `-c model_auto_compact_token_limit=<n>`, custom nothing |
| `base` | Base branch; detect develop, main, then current branch |
| `wtdir` | Sibling worktree directory; default `<repo>-worktrees` |
| `install` | Dependency install command; detect lockfile; `none` disables |
| `premerge` | Validation script; default `scripts/gsd-premerge-check.sh`; `none` disables the script, not test fallback |
| `test` | Test command; detected by project type, `none` skips tests |
| `flow` | `strict` enables prerequisite checks; unset preserves legacy non-strict behavior |
| `flow_since` | Minimum phase included in doctor's historical flow-debt report |
| `flow_skip` | Phases left out of that report, e.g. `flow_skip = 13.1, 14` (accepted as they are; doctor lists them as a note) |
| `tracker` | Ticket tracker: `none` (default), `clickup`, or `custom` |
| `tracker_command` | Executable for `tracker = custom` (see `docs/trackers.md`) |
| `tracker_profile` | This project's tracker login: ClickUp reads `~/.config/gsd/clickup-<name>.env`; custom gets `GSD_TRACKER_PROFILE` |
| `tracker_status_start`, `tracker_status_finish` | Ticket status set by `gsd-start` / `gsd-finish` |
| `ui_gates` | UI quality gates: `warn` (default), `strict` (the guard and `gsd-finish` enforce), `off` |
| `ui_min_font` | Smallest text size `gsd-ui check` accepts, in px: 8–32, default `12` |
| `ui_url` | App address for `gsd-ui check` / `shots`; default `http://localhost:{port}`; `{port}` / `{port:<base>}` = the phase's derived port. A phase's `url:` in `<P>-LAYOUT.md` wins (projects with several apps) |

`gsd-doctor` reports any other key as a likely typo (T017).

`review_provider` selects a request, not a built-in subprocess runner. The external
`gsd-review` skill supports the three named flags; its installation and CLI access
must be checked by the active agent. If absent, or for `custom`, use a separate
reviewer session and record verified findings in `<P>-REVIEWS.md`. The toolkit
does not invent `--custom`, silently skip review, or promise automatic delegation.
A `<P>-REVIEWS.md` whose configured reviewer's section is empty or holds only
an error (a Codex usage limit) does not count. On a Codex usage limit, run
`gsd-codex-wait --wait-only` as a background job, then review again.

Doctor checks complete instruction blocks and actual command routes. Native-hook
states are `present`, `absent`, `invalid`, `unverified` (no jq), or `unsupported`.
Its remediation uses `gsd-init --no-launch`, preserving the configured provider set.
