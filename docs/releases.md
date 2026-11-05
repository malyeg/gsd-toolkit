# Releases, install and updates

## For users

Install the latest release (no git checkout needed):

```sh
curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh | bash
curl -fsSL …/install.sh | bash -s -- --agent claude --agent codex    # choose agents
curl -fsSL …/install.sh | bash -s -- --version 0.2.0                  # a given release
```

Read it before running:

```sh
curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh -o install.sh
less install.sh && bash install.sh
```

`./install.sh` in a git checkout does the same: it installs the release, not
the checkout's files. So repos on a machine where you work on the toolkit
still run a release.

`install.sh`:

1. asks GitHub for the latest release (or takes `--version`);
2. downloads `gsd-toolkit-X.Y.Z.tar.gz` and `SHA256SUMS` from that release,
   and refuses to install when the checksum does not match;
3. runs the package's `lib/install.sh` (an older release: its `install.sh --copy`) into
   `~/.local/share/gsd-toolkit/releases/X.Y.Z/`, linking the commands in
   `~/.local/bin` and copying the skills into each agent's skill folder;
4. keeps the release you had before, removes older ones.

`lib/install.sh` then installs GSD itself (gsd-core) for each chosen agent that
has none: `npx -y --package=@opengsd/gsd-core@latest -- gsd-core --<agent>
--global --profile=full` (`--config-dir` added when `CLAUDE_CONFIG_DIR` /
`CODEX_HOME` moves the agent's dir). It runs after our skills, which are
`gsdt-*`, so gsd-core's installer keeps them. It is skipped when the agent
already has gsd-core (`gsd-update` updates it), on an update
(`--reuse-install-config`, which `gsd-update` uses), and with `--no-core`. A failed or
impossible install (no `npx`) prints the command and never fails the
toolkit install.

Env: `GSD_BIN_DIR`, `GSD_RELEASES_DIR`, the `GSD_CLAUDE_SKILL_DIR` / `GSD_CODEX_SKILL_DIR` variables,
and `GSD_UPDATE_REPO=owner/name` (a fork).

### Knowing about updates

Two versions are watched: gsd-toolkit (GitHub releases) and GSD itself
(`@opengsd/gsd-core` on npm, compared with the installed gsd-core version;
the update command is `npx @opengsd/gsd-core@latest --claude --global`).

- `gsd-start`, `gsd-list` and `gsd-init` print one line on stderr per newer
  version — only when you run them in a terminal, so JSON, pipes and agent
  output stay clean.
- `gsd-doctor` always shows them (`↑` lines, also with `--quiet`, and an
  `updates` list in `--json`). They are not findings: the exit status is 0.
- The latest versions are cached for a day in
  `${XDG_CACHE_HOME:-~/.cache}/gsd-toolkit/` (`latest-version`,
  `latest-gsd-core-version`). Commands read the cache and refresh it in the
  background, so they never wait on the network.
- `GSD_NO_UPDATE_CHECK=1` turns all of this off.

### Moving from gsd-worktrees

Before 0.8.0 the toolkit was called gsd-worktrees and lived in
`arconme/gsd-worktrees` (now archived; its releases stay downloadable). The
shell commands, `.gsd.conf`, `.gsd/` and `GSD_*` variables did not change. The
skills are now `gsdt-flow`, `gsdt-worktrees` and `gsdt-tracker`.

An install of 0.7.0 or older moves over by itself:

1. `gsd-update` — installs 0.7.1, the last gsd-worktrees release. It only
   points the updater at the new repo.
2. `gsd-update` again — installs gsd-toolkit 0.8.0 from `malyeg/gsd-toolkit`
   into `~/.local/share/gsd-toolkit/`. The `gsdw-*` skills are removed and the
   `gsdt-*` ones installed; `~/.local/share/gsd-worktrees/` is removed once no
   command links into it.
3. In each project: `gsd-doctor` reports the instruction files as out of date
   (T016). `gsd-init --no-launch` rewrites the marked blocks in place
   (`gsd-worktrees:` markers become `gsd-toolkit:`, `/gsdw-flow` becomes
   `/gsdt-flow`); nothing outside them changes. Commit that.

A session still open from before the move may call `/gsdw-flow`: the guard
still knows it. Going back to a gsd-worktrees release:

```sh
GSD_UPDATE_REPO=arconme/gsd-worktrees gsd-update --version 0.7.1
```

### Updating

```sh
gsd-update --check            # installed vs latest, changes nothing
gsd-update                    # install the latest (keeps your agent choice), then gsd-core
gsd-update --version 0.2.0    # a given release — also how you go back
gsd-update --no-core          # leave gsd-core as it is
```

After the toolkit, `gsd-update` brings gsd-core to npm's latest for each
agent the install chose (`lib/core.sh`, the same `--profile=full` installer
run as a fresh install). An agent without gsd-core gets it; one on the latest
is left alone. Offline, or without `npx`, it prints the command to run. The
update notice and `gsd-doctor` name `gsd-update` for both.

A git checkout is not an install: pull it with `git pull`; `gsd-update` run
from it says so. Commands still linked into a checkout (how older versions of
`./install.sh` installed) move to a release with
`./install.sh --reuse-install-config`; `gsd-doctor` notes when you have them.

Projects keep only `.gsd.conf`, the frozen shims and instruction blocks. After
an update, `gsd-doctor` in a project tells you if its shims need
`gsd-init` again.

## For maintainers: cutting a release

A push to `main` that changes `VERSION` is a release. Any other push only runs
the tests.

1. Add a `## X.Y.Z` section at the top of `CHANGELOG.md` (it becomes the
   release notes) and commit it on `main`.
2. Change `VERSION` and push, by hand or with:

   ```sh
   tools/release.sh X.Y.Z --push
   ```

   It checks that `main` is clean and level with origin, writes `VERSION`,
   commits `release vX.Y.Z`, and pushes.
3. `.github/workflows/release.yml` runs `tools/release-check.sh`: it stops with an
   error if `VERSION` is older than the newest tag or `CHANGELOG.md` has no notes
   for it, and does nothing if that version already has its tag. Then it runs the
   whole test suite (Ubuntu + macOS), builds the tarball with `git archive`, tags
   the commit `vX.Y.Z` and publishes the GitHub release with the tarball and
   `SHA256SUMS`.
4. Within a day, every install sees the new version.

A failed run tags nothing. Fix it on `main`, then `gh workflow run release.yml`
releases `main` at the same `VERSION`.

Versions are `X.Y.Z`: bump Z for fixes, Y for new features, X for changes that
need users to do something (say so in the changelog).
