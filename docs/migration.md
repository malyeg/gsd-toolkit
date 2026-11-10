# Migration guide

## 0.10.0: commands renamed to gsdt-*

Every toolkit command is now `gsdt-*`: `gsd-start` → `gsdt-start`,
`gsd-finish` → `gsdt-finish`, and so on for all of them. `gsd-*` is gsd-core's
prefix (its skills `/gsd-update`, `/gsd-ui-phase`, …); now a name tells you
who made it. There are no aliases: the old names stop working when 0.10.0
installs.

1. **Update, everyone first.** Run the old `gsd-update` one last time. It
   installs 0.10.0, removes the old `gsd-*` links from `~/.local/bin`, and
   replaces the toolkit's Claude hooks in `~/.claude/settings.json`.
   A teammate on 0.9 in a migrated repo would get "install the toolkit" from
   the new shims, and an old `gsd-init` would write the old blocks back.
2. **In each repo's main checkout:**
   ```sh
   gsdt-migrate             # dry run: every change, nothing changed
   gsdt-migrate --apply     # make them (never commits)
   git add -A && git commit -m "Switch to gsdt-* toolkit commands"
   ```
   Until then `gsdt-start`, `gsdt-finish`, `gsdt-flow-next` and `gsdt-init`
   stop with "run: gsdt-migrate --apply", and `gsdt-doctor` reports T090
   (`gsdt-doctor --fix` runs it for you).
3. **Each teammate's clone:** after pulling that commit,
   `gsdt-migrate --apply` once (the merge driver, the tracker settings and the
   post-merge hook live in `.git/`, which is not committed).

What it changes: the five shims (`scripts/gsd-*.sh` → `scripts/gsdt-*.sh`);
your pre-merge script (`scripts/gsd-premerge-check.sh` →
`scripts/gsdt-premerge-check.sh`, content unchanged); those exact paths in
other tracked files (`package.json`, CI, `Makefile`, `.husky/`); the repo hook
in `.claude/settings.json`; the toolkit's marked blocks in
`.gsd/INSTRUCTIONS.md`, `CLAUDE.md`, `AGENTS.md`; and in this clone the merge
driver's command, the `gsd-tracker` git config section (→ `gsdt-tracker`) and
the post-merge hook. It never rewrites free text (`.planning/`, `*.md`
outside the markers): it lists those lines so you can fix them if you like.
A shim you edited is reported and left for you.

**Open phase worktrees** keep the old files on their branch. Commit the
migration on the base branch first, then merge it into each phase branch (or
finish the phases before migrating). Their planning merges keep working: the
merge driver's key is still `gsd-planning`; only its command changed.

Not renamed: `.gsd.conf`, `.gsd/`, the `GSD_*` variables, `~/.config/gsd/`,
and the skills (already `gsdt-*`).

## 0.5.0: move to gsd-core

GSD is now `@opengsd/gsd-core` (CLI `gsd_run`). The old `get-shit-done-cc`
(`gsd-sdk`) is archived. gsd-worktrees 0.5.0 needs gsd-core and has no
fallback. Gemini is gone too: gsd-core dropped it. Do these steps in order.

1. Back up your settings:
   `cp ~/.claude/settings.json ~/.claude/settings.json.bak`
   (and `$CODEX_HOME/hooks.json`, default `~/.codex/hooks.json`, if you use
   Codex).
2. Update gsd-worktrees first: `gsd-update` (commands linked into a git checkout: `./install.sh --reuse-install-config` there).
   It renames our skills to `gsdw-*` before gsd-core's installer can delete
   the old `gsd-*` ones. It also removes an old Gemini install.
3. Dry run gsd-core and read what it says:
   `npx -y --package=@opengsd/gsd-core@latest -- gsd-core --claude --global --dry-run`
   The dry run only previews the cleanup of the old `get-shit-done-cc` files.
4. Install: `npx @opengsd/gsd-core@latest --claude --global`. Add
   `--force-statusline` if you use GSD's status line and want it replaced.
   For Codex: `npx @opengsd/gsd-core@latest --codex --global`.
5. Remove the old package: `npm rm -g get-shit-done-cc`.
6. In each project: `gsd-init --no-launch` (refreshes the instructions and
   drops the Gemini setup), then `gsd-doctor`.

Notes:

- Do not set `GSD_INSTALLER_MIGRATION_RESOLVE=remove`. It deletes files the
  installer cannot classify.
- If the installer stops on unknown files under `skills/gsd-*`, do step 2
  first.
- Keep the skill profile `full` (doctor T009). The phase flow needs skills
  the smaller profiles leave out.
- Do not turn on `"phase_id_convention": "bracket"` in `.planning/config.json`
  (doctor T026). It is not supported.
- Gemini: `gemini` is refused in `providers`, `--provider`, `--agent` and
  `review_provider`. `gsd-init --no-launch` (or `gsd-doctor --fix`, T061)
  removes an older release's Gemini setup. Switch to `claude`, `codex` or
  `custom`.

## Providers and instructions

Run `gsdt-init` from the desired base checkout. It delegates to the idempotent
bootstrap layer, does not touch existing `.planning/`, and never silently
changes providers.

- Remain Claude-only: `gsdt-init --provider claude --no-launch`
- Switch to Codex: `gsdt-init --provider codex --no-launch`
- Support several: `gsdt-init --providers claude,codex --provider claude --no-launch`

Use repeated `--provider-command provider=executable` flags for nonstandard
executable paths. `--provider` must be a member of `--providers`; invalid
selections fail before repository files are written.

For per-provider executable overrides, use `claude_command` and `codex_command`. Then hand the same phase between providers with repeated
`gsdt-start -p <N> --provider <name> --no-launch` calls. This reuses the phase
worktree and planning state; do not run concurrent mutating sessions there.

Legacy Claude repositories receive `.gsd/INSTRUCTIONS.md`, a marked entrypoint
in `CLAUDE.md`, and an ordered `providers` key. A legacy singular `provider`
key remains readable when `providers` is absent; re-running `gsdt-init` writes
the equivalent one-entry list and removes only that redundant key. Bootstrap never assumes that an
unmarked `## GSD planning system` section is wholly toolkit-owned: it preserves
that section byte-for-byte because it may contain repository-specific policy.
The marked adapter makes the canonical document authoritative for toolkit
command syntax and workflow order while retaining the older section's project
rules. After reviewing and relocating any project-specific rules, maintainers
may remove obsolete legacy wording manually. Invalid JSON settings are left
untouched with a warning.

Repos set up before the instructions split (0.9.0) hold the full rules in
`.gsd/INSTRUCTIONS.md`. They keep working unchanged: that copy is complete,
and Claude sessions also load the current rules from `gsdt-rules`. Doctor
reports T016 one last time; one `gsdt-init --no-launch` (or
`gsdt-doctor --fix`) rewrites the block to the small form and the provider
entries to point at `gsdt-rules`. Commit the result. After that, a rule change
needs only `gsdt-update` on each machine.

Bootstrap validates generated instruction markers before writing any files.
Unmatched, nested, duplicate, reversed, or inline markers stop the migration
with a filename to repair; user content is preserved. Resolve the markers and
rerun `gsdt-init`.

Canonical instructions now have `canonical:start` / `canonical:end` markers;
new bootstrap runs preserve text outside them. The older single-marker format
is backed up as `INSTRUCTIONS.md.bak` (numbered if necessary) before migrating
its recognizable generated span. Keep that backup until you verify local additions.

On migration, legacy `agent_command` is saved under its original provider's
`*_command` key and the generic key is removed. Changing the default provider
therefore cannot accidentally launch the old executable. An explicit command
override updates the provider-specific key, and `--provider-command` alone
preserves an existing configured provider set. To add a new provider, pass the
complete set with `gsdt-init --providers ...`.

To remove one integration, remove its name from `providers =`, then delete only
the text between `gsd-toolkit:provider:start` and
`gsd-toolkit:provider:end` in its instruction file. Remove the matching hook
entry only if it calls `gsdt-worktree-guard`; do not delete unrelated settings.
For Codex/custom, which share `AGENTS.md`, re-run `gsdt-init --no-launch` after
editing the set; do not delete the shared block while either provider remains.

To roll back, remove only the marked provider and canonical instruction
blocks, then remove `providers` (and a legacy `provider`, if still present),
`agent_command`, and any `*_command` keys from `.gsd.conf`. Their absence restores the Claude
compatibility default. Existing `.planning/`, merge behavior, and shims remain
compatible. Preserve any user content outside the canonical block rather than
deleting its whole file. Restore the canonical `.bak` when rolling back a
single-marker migration, after checking for subsequent user edits.
