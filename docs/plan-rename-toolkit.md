# Plan: rename gsd-worktrees → gsd-toolkit (new repo)

Status: steps 1–5 done 2026-11-04 (uncommitted, all suites green in both
folders). Step 6 (commit, push, release, archive) waits for the user's OK.

Changed while building: the 0.7.1 bridge ships the NEW `install.sh` (same
file as 0.8.0). It picks the tarball name from `SHA256SUMS`, maps a
`…/gsd-worktrees/releases` dir (what an old `gsd-update` passes) to
`…/gsd-toolkit/releases`, and removes the old runtime folder. So hop 2 lands
0.8.0 straight in the new folder. The bridge's `lib/version.sh` also caches
under `~/.cache/gsd-toolkit/`, so the "0.8.0 is out" notice shows at once.
The bridge commit carries the README "Moved" banner too.

## Goal

- New home: `malyeg/gsd-toolkit` (public, empty today). It gets the full git
  history and tags.
- Old home: `arconme/gsd-worktrees` gets one last bridge release, then is
  archived (read-only, marked deprecated). Its old releases stay downloadable.
- The package is called `gsd-toolkit` everywhere. The skills become `gsdt-*`.
- Nobody who installed it already has to do anything by hand. `gsd-update`
  (twice) and `gsd-init --no-launch` (per project) move them over.

## What does NOT change

These are typed by users or stored in their projects. Renaming them costs a lot
and gains nothing.

- Shell commands: `gsd-start`, `gsd-finish`, `gsd-list`, … (all `gsd-*`).
- `.gsd.conf`, `.gsd/`, `GSD_*` env vars, `git config gsd-tracker.*`,
  `~/.config/gsd/`, `.gsd-install-manifest`.
- The frozen shims in `shims/` (target repos hold copies; they call commands by
  name). Only their error text names the old repo, and GitHub's redirect for
  the archived repo still leads people to it. Leave them byte-identical.
- Skill names must not start with `gsd-`: gsd-core's installer deletes every
  `skills/gsd-*` folder. `gsdt-*` is safe.

## What changes

| Old | New | Where |
|---|---|---|
| `arconme/gsd-worktrees` | `malyeg/gsd-toolkit` | `lib/version.sh` (`GSD_UPDATE_REPO_DEFAULT`), `install.sh` (`SLUG`, curl line), `skills/*/SKILL.md`, docs, `LICENSE` holder |
| `gsd-worktrees-X.Y.Z.tar.gz`, prefix `gsd-worktrees-X.Y.Z/` | `gsd-toolkit-X.Y.Z.tar.gz`, `gsd-toolkit-X.Y.Z/` | `.github/workflows/release.yml`, `install.sh` |
| `~/.local/share/gsd-worktrees/releases/` | `~/.local/share/gsd-toolkit/releases/` | `install.sh` (`RELEASES`), `lib/install.sh` (`COPY_REQUEST`, `owned_link`) |
| `~/.cache/gsd-worktrees/` | `~/.cache/gsd-toolkit/` | `lib/version.sh` (cache only; no migration needed) |
| skills `gsdw-flow`, `gsdw-worktrees`, `gsdw-tracker` | `gsdt-flow`, `gsdt-worktrees`, `gsdt-tracker` | `skills/`, `lib/provider.sh` (start argv, entry block), `bin/gsd-doctor` (skill check), `bin/gsd-start`, `bin/gsd-flow-next`, `bin/gsd-tracker` comments |
| skill mark `<!-- gsd-worktrees-skill X -->` | `<!-- gsd-toolkit-skill X -->` | `lib/common.sh` (`GSD_SKILL_MARK`) |
| markers `<!-- gsd-worktrees:canonical:start -->` / `:provider:` | `<!-- gsd-toolkit:canonical:start -->` / `:provider:` | `lib/provider.sh`, `bin/gsd-bootstrap-repo` |
| text "gsd-worktrees" in messages, commit msg `chore: add gsd-worktrees workflow` | "gsd-toolkit" | `bin/*`, `lib/*` |

## Reading the old names (compatibility)

Write only new names. Read both, so old installs and old projects keep working
until they are moved.

1. **Skill ownership** — `gsd_skill_owned` accepts the old mark, the new mark,
   and the older `.gsd-worktrees-skill` file. Then `retire_skills` already
   removes the old `gsdw-*` copies on the first install of 0.8.0 (they are
   ours and no longer shipped). `gsd_skill_differs` strips either mark.
2. **Old runtime links** — `owned_link` accepts `*/gsd-worktrees/releases/*`
   and `*/gsd-toolkit/releases/*`, so `~/.local/bin/gsd-*` links into the old
   runtime are replaced, not moved to `.bak`.
3. **Guard + hook payload** — `gsd-worktree-guard` and
   `lib/gsd_hook_payload.py` map both `gsdw-flow` and `gsdt-flow` to
   `gsd-flow`. A session started before the update still works.
4. **Instruction markers in target repos** — `gsd_owned_block_get`,
   `gsd_owned_markers_valid`, `gsd_provider_instruction_integrated` and the
   replace code read old or new markers. Bootstrap replaces an old-marker
   block with the new block in place (same position, text outside untouched).
   Doctor T016 reports an old-marker block as out of date (fix:
   `gsd-init --no-launch`, already on the safe list). The text changes anyway
   (`gsdw-flow` → `gsdt-flow`), so every project gets one diff.
5. **Old release folder** — after a 0.8.0 install, `install.sh` removes
   `~/.local/share/gsd-worktrees/` only when no `~/.local/bin/gsd-*` link points
   into it any more. Going back to 0.7.x is `gsd-update --version 0.7.1` with
   `GSD_UPDATE_REPO=arconme/gsd-worktrees` (documented in `docs/releases.md`).
6. **User hook** — `gsd-worktree-guard --global` is found by command name and
   points at `~/.local/bin`, so it needs no change. Test it anyway.

## How old installs get here (two hops)

An installed 0.7.0 runs its own `install.sh`, which knows only
`arconme/gsd-worktrees` and `gsd-worktrees-*.tar.gz`. So:

1. **v0.7.1 in the old repo (bridge).** Same code as 0.7.0, except:
   `lib/version.sh` and `install.sh` point at `malyeg/gsd-toolkit` and read the
   new tarball name, and the update notice says "moved to gsd-toolkit".
   Released from the old repo, built by its release workflow.
2. A 0.7.0 user runs `gsd-update` → gets 0.7.1. The notice says a newer
   version exists → `gsd-update` again → gets 0.8.0 from the new repo, which
   cleans up (items 1, 2, 5 above).
3. Then `gsd-init --no-launch` in each project (doctor T016 says so).

0.7.1 must ship before the archive: an archived repo can't take a push.

## Two folders

- `~/projects/gsd-toolkit` — a clone with full history and tags. Remotes:
  `origin` = `https://github.com/malyeg/gsd-toolkit.git`, `old` =
  `arconme/gsd-worktrees`. All 0.8.0 work happens here.
- `~/projects/gsd-worktrees` — stays on the old repo. Used only for the 0.7.1
  bridge, then left as is.

Claude's memory was copied to
`~/.claude/projects/-Users-siminds-ops-projects-gsd-toolkit/memory/`.

## Steps

1. In `~/projects/gsd-toolkit`: do the rename and the compatibility reads.
2. Tests: update names; add tests for each compatibility item (old skill mark
   retired, old runtime link replaced, old markers rewritten by bootstrap, T016
   on old markers, guard accepts `gsdw-flow` + `gsdt-flow`, old release folder
   removed only when unused). `tests/test-update.sh` gets a two-hop case
   (fake GitHub: 0.7.1 in the old slug, 0.8.0 in the new).
3. Run every suite + lint + shellcheck, and `tests/test-e2e.sh`.
4. Docs: README, CLAUDE.md, `docs/*` (not `docs/archive/`), CHANGELOG `## 0.8.0`
   with the move steps for users.
5. In `~/projects/gsd-worktrees`: the 0.7.1 bridge on `main` (the 0.7.1
   changes + CHANGELOG `## 0.7.1`).
6. With the user's OK (outward-facing):
   1. New folder: push `v0.7.0` history + all tags to `origin` first (VERSION
      0.7.0 already tagged, so no release), then `main` with VERSION 0.8.0 →
      the new repo's release workflow publishes 0.8.0. Check CI is green on
      ubuntu + macos.
   2. Old folder: push the 0.7.1 bridge to `main` → it publishes 0.7.1.
   3. Old repo: README banner "Moved to malyeg/gsd-toolkit", description
      "Deprecated — moved to …", then `gh repo archive arconme/gsd-worktrees`.
7. Try it for real: on this machine, `gsd-update` twice from 0.7.0, then
   `gsd-doctor` and `gsd-init --no-launch` in one project.
