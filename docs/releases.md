# Releases, install and updates

Two lines exist:

- **0.11.0 onwards: an npm package, shipped as a GitHub release.** TypeScript on
  Node 24 or newer. The release carries `gsd-toolkit-X.Y.Z.tgz` (`npm pack`) and
  `SHA256SUMS`; `install.sh` and `gsdt-update` download that file and run
  `npm install -g` on it. The npm registry is optional (the package may be
  published there later); nothing depends on it.
- **0.10.x and earlier: GitHub releases** installed by the old bash
  `install.sh`. This line is **frozen**: only fixes for data loss. Each release
  also carries `gsd-toolkit-X.Y.Z.tar.gz` (`git archive`): that is what an
  installed 0.10.x downloads, and its `lib/install.sh` is the **bridge**: it
  hands over to the release's `install.sh` (below).

## For users

```sh
curl -fsSL https://raw.githubusercontent.com/malyeg/gsd-toolkit/main/install.sh | bash
curl -fsSL …/install.sh | bash -s -- --agent claude --agent codex     # more than one agent
```

`install.sh` (bash, also Git Bash on Windows) needs curl, Node 24 or newer and
npm. It reads the latest release from the GitHub API (or takes `--version`),
downloads `SHA256SUMS` and `gsd-toolkit-X.Y.Z.tgz`, checks the checksum,
runs `npm install -g --no-audit --no-fund <tgz>`, then the new package's
`gsdt-setup` with the options it was given (`--agent`, `--all-agents`,
`--no-core`, `--no-user-hook`; `--reuse-install-config` is accepted and ignored).
A release without a `.tgz` line in `SHA256SUMS` (before 0.11.0) is refused with
the line that installs it with its own installer. Windows without bash:
`npm i -g https://github.com/<repo>/releases/download/vX.Y.Z/gsd-toolkit-X.Y.Z.tgz`
then `gsdt-setup`. Env: `GSD_UPDATE_REPO` (owner/name), and npm's own settings.

You need Node 24 or newer and Git (on Windows, Git for Windows). Nothing
else: no Python, Perl or `jq`.

- `npm i -g` puts the `gsdt-*` commands on your `PATH`, and writes the
  `.cmd` / `.ps1` wrappers on Windows. There is no `postinstall` script.
- `gsdt-setup` copies the skills into each agent's skill folder, registers
  the two Claude user-level hooks (using the npm bin folder: `GSD_BIN_DIR`, or
  the first `PATH` folder that holds this package's `gsdt-worktree-guard`),
  and installs gsd-core for an agent that has none. It records your choices in
  `~/.config/gsd/setup-manifest`; the next run keeps those agents (a given
  `--agent` is added). It replaces what it placed earlier, in place, and
  never duplicates a hook. `--no-core` skips gsd-core, `--no-user-hook` leaves
  the hooks out (and removes ours).
- It also removes a 0.10.x install: the old `~/.local/bin/gsdt-*` links and
  `~/.local/share/gsd-toolkit`.

Env: `GSD_BIN_DIR`, the `GSD_CLAUDE_SKILL_DIR` / `GSD_CODEX_SKILL_DIR`
variables, `GSD_CLAUDE_SETTINGS`, `GSD_NO_CORE=1`.

gsd-core is installed with `npx -y --package=@opengsd/gsd-core@latest -- gsd-core
--<agent> --global --profile=full` (`--config-dir` added when
`CLAUDE_CONFIG_DIR` / `CODEX_HOME` moves the agent's dir). It runs after our
skills, which are `gsdt-*`, so gsd-core's installer keeps them. A failed or
impossible install (no `npx`) prints the command and never fails the setup.

### Updating

```sh
gsdt-update --check            # installed vs latest, changes nothing
gsdt-update                    # the latest toolkit (keeps your agents), then gsd-core
gsdt-update --version 0.11.0    # a given version, also how you go back
gsdt-update --no-core          # leave gsd-core as it is
```

As the npm package, `gsdt-update` asks GitHub for the latest release, downloads
its `.tgz` and `SHA256SUMS`, checks the checksum, runs `npm install -g` on the
file, then that version's `gsdt-setup --no-core` so skills and hooks match it. After that it brings gsd-core to its
latest for each agent you set up (an agent without it gets it). Offline, or
without `npx`, it prints the command to run.

A git checkout is not an install: pull it with `git pull`; `gsdt-update` run
from it says so. Projects keep only `.gsd.conf`, the frozen shims and
instruction blocks; after an update, `gsdt-doctor` in a project tells you if
anything there needs `gsdt-init` again.

### Knowing about updates

Two versions are watched: gsd-toolkit (the latest GitHub release, in every install mode) and GSD itself
(`@opengsd/gsd-core` on npm, compared with the installed gsd-core version;
the update command is `npx @opengsd/gsd-core@latest --claude --global`).

- `gsdt-start`, `gsdt-list` and `gsdt-init` print one line on stderr per newer
  version — only when you run them in a terminal, so JSON, pipes and agent
  output stay clean.
- `gsdt-doctor` always shows them (`↑` lines, also with `--quiet`, and an
  `updates` list in `--json`). They are not findings: the exit status is 0.
- The latest versions are cached for a day in
  `${XDG_CACHE_HOME:-~/.cache}/gsd-toolkit/` (`latest-version`,
  `latest-gsd-core-version`). Commands read the cache and refresh it in the
  background, so they never wait on the network.
- `GSD_NO_UPDATE_CHECK=1` turns all of this off.

### Moving from 0.10.x to 0.11.0

```sh
gsdt-update          # the 0.10.x updater; or the curl line above
```

The 0.10.x `install.sh` / `gsdt-update` download the 0.11.0 release's
`gsd-toolkit-0.11.0.tar.gz` and run its `lib/install.sh` (the bridge) with
`GSD_BIN_DIR` / `GSD_COPY_DIR` set. The bridge unsets those (`gsdt-setup` reads
`GSD_BIN_DIR` as the folder its hooks point at) and runs the release's
`install.sh --version 0.11.0` with the agent, hook and core options. That
installs the package from npm's side and `gsdt-setup` removes the old `~/.local/bin/gsdt-*` links and
`~/.local/share/gsd-toolkit/` (only what the old install made), rewrites the
user hooks in `~/.claude/settings.json` to the npm path, and re-installs the
skills. Repos need no change when `gsdt-doctor` shows no T090 (else
`gsdt-migrate --apply` first, best on 0.10.x). See
[migration.md](migration.md#100-npm-package-nodejs-24-windows).

### Moving from gsd-worktrees

This is the 0.10.x line. 0.11.0 no longer reads a gsd-worktrees install on the
machine (its old paths, `gsdw-*` skills, tarball name): go through 0.10.x first.
The repo-level `gsd-worktrees:` instruction markers are still read.

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
GSD_UPDATE_REPO=arconme/gsd-worktrees gsdt-update --version 0.7.1
```

## For maintainers: cutting a release

A push to `main` that changes `VERSION` is a release. Any other push only runs
the tests.

1. Add a `## X.Y.Z` section at the top of `CHANGELOG.md` (it becomes the
   release notes) and commit it on `main`.
2. Change `VERSION` and `package.json` `version` (the release refuses a mismatch;
   `tests/test-npm.sh` checks it too) and push, by hand or with:

   ```sh
   tools/release.sh X.Y.Z --push
   ```

   It checks that `main` is clean and level with origin, writes `VERSION`,
   `package.json` and `package-lock.json`, commits `release vX.Y.Z`, and pushes.
3. `.github/workflows/release.yml` runs `tools/release-check.sh`: it stops with an
   error if `VERSION` is older than the newest tag or `CHANGELOG.md` has no notes
   for it, and does nothing if that version already has its tag. Then it runs the
   whole test suite (`tests.yml`), refuses a `package.json` version that
   differs from `VERSION`, builds `gsd-toolkit-X.Y.Z.tar.gz` (`git archive`, for
   0.10.x installers: the bridge) and `gsd-toolkit-X.Y.Z.tgz` (`npm ci`, `npm
   pack`; the `prepack` script builds `dist/`), tags the commit `vX.Y.Z` and
   publishes the GitHub release with both files and a `SHA256SUMS` that lists
   both.

The npm registry is not part of the release. `npm publish` can be added later
(same `.tgz`); `install.sh` and `gsdt-update` do not need it.

`tests.yml` runs the bash suites and the TypeScript suites on Ubuntu and
macOS, and the cross-platform `tests/os/` suite (the real npm package, packed
and installed into a temporary prefix) on Ubuntu, macOS and Windows.

A failed run tags nothing. Fix it on `main`, then `gh workflow run release.yml`
releases `main` at the same `VERSION`.

Versions are `X.Y.Z`: bump Z for fixes, Y for new features, X for changes that
need users to do something (say so in the changelog).

## The 0.10.x line (frozen)

Installed with `install.sh` (`curl -fsSL …/install.sh | bash`; `./install.sh`
in a checkout installs the release, not the checkout's files). It asks GitHub
for the latest release (or takes `--version`), downloads
`gsd-toolkit-X.Y.Z.tar.gz` and `SHA256SUMS`, refuses a checksum mismatch, runs
the package's `lib/install.sh` into
`~/.local/share/gsd-toolkit/releases/X.Y.Z/` (links in `~/.local/bin`, skills
copied), and keeps the previous release. `gsdt-update` there re-runs its own
runtime's `install.sh`. `tests/test-install.sh` runs the real v0.10.0
`install.sh` and `gsdt-update` against a 0.11.0 release (the bridge); the old
copy installer is `lib/install-copy.sh`, kept as the oracle for `gsdt-setup`
(`tests/test-install-copy.sh`). See
[copy-install.md](copy-install.md).
