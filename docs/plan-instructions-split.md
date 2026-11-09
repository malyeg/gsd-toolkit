# Split the generated instructions: global rules + a small local file

Plan only; do not build until the user says go. Work on a new branch (e.g.
`feat/instructions-split`). Follow this repo's CLAUDE.md (tests, CI list,
docs, CHANGELOG, provider-neutral text, edit the block text only in
`lib/provider.sh`).

## Why

Every repo carries its own full copy of the toolkit's rules in
`.gsd/INSTRUCTIONS.md` (`gsd_canonical_block`, `lib/provider.sh`). When a
release changes a rule (0.8.3 added the `/gsdt-batch` line), every repo is
out of date: `gsd-doctor` reports T016 until someone runs
`gsd-init --no-launch` (or `gsd-doctor --fix`) there, and commits the result.
Repos nobody revisits keep the old rules.

Goal: a release updates the rules everywhere through `gsd-update`, with no
step in each repo. T016 becomes rare.

## Today (checked 2026-11-09)

- `gsd_canonical_block <providers> <default> <base> <wtdir> <ui on|off>`
  writes ONE block: the rules (same in every repo) + the repo's values (the
  last two lines: providers, base, worktree dir) + the screens paragraph
  when `ui` is on.
- `gsd_provider_entry_block` writes the marked entry in `CLAUDE.md` /
  `AGENTS.md`: "Read and follow `.gsd/INSTRUCTIONS.md`" (T052 / T058 when
  missing or wrong).
- `gsd-bootstrap-repo` writes both; `gsd-doctor` compares both against what
  this toolkit would write (T016 = canonical block differs).
- The runtime lives in `…/share/gsd-toolkit/releases/<X.Y.Z>/` (two kept);
  there is no stable "current" path yet.

## Design

Three parts:

1. **Global rules — `gsd-rules`** (new command). Prints the rules text for
   the INSTALLED toolkit: everything in today's block except the repo's
   values. The text stays in `lib/provider.sh` (one definition). A command,
   not a file path, so a committed file never holds a machine's path, and
   the rules always match the commands installed next to them. In a repo it
   also reads `.gsd.conf` and adds the screens paragraph when `ui_gates` is
   not `off`, and the repo's values.
2. **Local file — `.gsd/INSTRUCTIONS.md`**, much smaller:
   - the repo's values (providers, base, worktree dir, `flow`, `ui_gates`);
   - "run `gsd-rules` and follow its output" (how each provider gets it:
     below);
   - a short core that holds even when the toolkit is missing (a teammate,
     CI, a cloud session): one phase = one worktree, run `gsd-flow-next <N>`
     before a phase action, `gsd-finish` is never automatic, never bypass a
     guard — and "if `gsd-rules` is not found, install the toolkit (README)".
   It changes only when a repo setting changes, or when this core changes
   (rare, so T016 stays meaningful).
3. **Getting the rules into the session**, per provider:
   - **Claude:** a `SessionStart` hook that runs `gsd-rules` and adds its
     output to the context, only in a repo with `.gsd.conf` (registered the
     way the guard's hook is). Fallback: the entry block's "run `gsd-rules`".
   - **Codex:** no hooks: the `AGENTS.md` entry says to run `gsd-rules`
     first. Less sure than loaded text — see "Check first".
   - **custom:** same as Codex.

Old repos (full block) keep working as they are: their copy is complete.
`gsd-init --no-launch` converts them to the new shape once; T016 asks for
that one last time.

## Check first (before building)

Write what you find here. If 1 or 2 fails, stop and report.

**Findings (2026-11-09, Claude Code 2.1.319, codex-cli 0.164.0): 1 and 2
pass; the split covers all providers.**

- **1 — passes.** A `SessionStart` command hook (no matcher) in a throwaway
  repo; its stdout named a secret word with the hook's `source`. `claude -p`
  saw it on a new session (`startup`), `--continue` (`resume`), after
  `/compact` (`compact`) and after `/clear` (`clear`). The hook runs on every
  one of those; a resumed session keeps the earlier copy too (text repeats,
  harmless). **Size limit:** 9.2 KB arrived whole; 24 KB was cut — Claude Code
  saved it to a file and showed only the first ~2 KB. So keep the output well
  under ~10 KB. **`@~/…` import instead:** rejected without a test — an
  import from outside the repo asks for approval per project, and the path
  would have to be the same on every machine; the runtime has no stable path
  (`releases/<X.Y.Z>/`), and a committed `CLAUDE.md` would hold one
  machine's home. **Choice: the hook.**
- **2 — passes, 3/3.** A throwaway repo shaped like the new design (the new
  `AGENTS.md` entry, a small `.gsd/INSTRUCTIONS.md`, a fake `gsd-rules` on
  PATH that logs its calls), three fresh `codex exec` sessions with different
  phase asks ("Continue phase 2.", "Plan phase 2 for me.", "What's next on
  phase 2? Go ahead and do it."). All three ran `gsd-rules` as their FIRST
  command (exit 0, read the rules), then `gsd-list` / `gsd-flow-next 2`.
  So Codex (and custom, same `AGENTS.md`) uses the pointer; no inline copy.
- **3 — size.** `gsd-rules` prints ~2.2 KB without screens, ~3.0 KB with
  them, plus a header line (well under the 10 KB cut). Today's text is the
  same, but it sits in `.gsd/INSTRUCTIONS.md`, which the model reads only
  when it follows the "Read and follow" line (a tool call). The hook loads it
  in every Claude session in a set-up repo: +~550–750 tokens when the model
  would not have read it, about ±0 when it would. Outside such a repo: 0.

1. **Claude `SessionStart` hook:** does its output reach the model in a new
   session, a resumed one, and after `/clear` and compaction? Is there a size
   limit? Compare with an `@~/…` import in `CLAUDE.md` (does an import from
   outside the repo ask for approval? does it need the same path on every
   machine?). Pick one; the hook is the default choice.
2. **Codex:** in a fresh Codex session in a set-up repo, does it run
   `gsd-rules` on its own before the first phase action, from the `AGENTS.md`
   line alone? Try 3 sessions. If it does not, keep the full rules inline in
   `AGENTS.md` for Codex (the split is then Claude-only) and say so.
3. **Size:** the rules are ~2.5 KB today; check what `gsd-rules` adds to
   every Claude session vs. today's (the same text, so ±0 expected).

## Deliverables

1. `bin/gsd-rules` (+ `--help`, `--repo`): prints the rules; the text in
   `lib/provider.sh` (split `gsd_canonical_block` into `gsd_rules_text` and
   a local block).
2. `gsd_canonical_block` → the small local block (values + core + pointer).
   Keep the `canonical:start/end` markers; bootstrap still writes only
   between them.
3. `gsd_provider_entry_block`: point at `gsd-rules` (Claude: the hook does
   it; the line is the fallback). Codex/custom per check 2.
4. Claude hook: `lib/install.sh` registers it at user level, next to the
   guard's `--global` hook (`--no-user-hook` opts out of both); it prints
   nothing outside a repo with `.gsd.conf`. Doctor T008 already covers a
   GSD hook whose file is gone.
5. Doctor:
   - T016 compares the new local block (old full blocks report T016 once).
   - New code (pick an unused `T0xx`): the Claude hook is not registered, or
     `gsd-rules` is not on PATH. Add it to the `--fix` safe list only if
     the fix is mechanical (re-run the installer).
6. Tests: `tests/test-providers.sh` (local block text, entry blocks per
   provider, `gsd-rules` output with/without `ui_gates`, outside a repo),
   `tests/test-doctor.sh` (T016 on an old full block, the new code),
   `tests/test-install-copy.sh` (hook registered, opt-out). Then
   `tests/test-e2e.sh`.
7. Docs: `docs/architecture.md` (generated instructions), `docs/providers.md`,
   `docs/features.md`, `docs/migration.md` (old repos: one
   `gsd-init --no-launch`), CLAUDE.md "Generated instructions" paragraph,
   CHANGELOG.

## As built (2026-11-09, branch `feat/instructions-split`, not committed)

- `bin/gsd-rules` (`--repo`, `--hook`, `--help`); text in `lib/provider.sh`:
  `gsd_rules_text <ui on|off>`, `gsd_repo_values`, and the small
  `gsd_canonical_block <providers> <default> <base> <wtdir>`.
  Helpers `gsd_flow_mode`, `gsd_conf_providers` in `lib/common.sh`.
- Entry block: still starts "Read and follow `.gsd/INSTRUCTIONS.md`" (so old
  and new blocks both count as installed); Claude's adds "a session-start
  hook loads them; when not in your context, run `gsd-rules`"; Codex/custom
  get the "run `gsd-rules` first" wording check 2 used.
- Hook: `SessionStart`, no matcher, command
  `[ ! -x '<bin>/gsd-rules' ] || exec '<bin>/gsd-rules' --hook`. The header
  line names the toolkit version. `lib/gsd_hook_paths.py` counts it as the
  toolkit's (T008 fix = reinstall).
- Doctor T062 (Claude configured, a canonical block present): `gsd-rules`
  not on PATH, or no user `SessionStart` hook runs it → finding with the
  reinstall command; with `user_hook off` in the install manifest → a note.
  **Not** in the `--fix` safe list: the fix re-runs the installer
  (downloads a release), which is not a small undoable local action.
- Changed from the design: the local block holds only providers, base and
  worktree dir — NOT `flow` / `ui_gates`. With them in, `tests/test-e2e.sh`
  showed T016 right after the common step "set `flow = strict` in
  `.gsd.conf`". `gsd-rules` prints both live from `.gsd.conf`, so the
  committed file does not need them, and editing them never raises T016
  (`ui_gates` did before the split).

## Done when

- All suites pass, including `tests/test-e2e.sh`.
- A rule change in `lib/provider.sh` + `gsd-update` reaches a set-up repo's
  next Claude session with no change in that repo, and no T016.
- A repo set up before this still works unchanged; one
  `gsd-init --no-launch` converts it.
- Codex: the result of check 2 is written down and the docs match it.

## Out of scope

Changing the rules' content; per-user overrides of the rules; Gemini
(refused everywhere); releasing.
