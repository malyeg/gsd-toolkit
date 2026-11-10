# How a package is installed (lib/install.sh)

You install with `install.sh` (or update with `gsdt-update`), see
[releases.md](releases.md). It downloads a release and runs that release's
`lib/install.sh`. This page is about that second step. Nobody runs it by
hand; the tests run it straight on a checkout. It only copies: the old
link install (commands linked into a checkout) is gone.

Installation requires Python 3.7+ (`python3` or `python`), checked before writing
destinations. Bash, Git and Perl are also required by the toolkit.

The installer copies `bin/`, `lib/`, `shims/`, `skills/`, `install.sh` and
`VERSION` into a dedicated runtime directory. Commands in `GSD_BIN_DIR` are symlinks to that copied runtime,
so they continue to work after the checkout is removed. The selected agent's
skills are also copied into its skill directory.

By default, `GSD_BIN_DIR` is `~/.local/bin` and the runtime directory is
`~/.local/share/gsd-toolkit` (`install.sh` sets it to
`…/releases/X.Y.Z`). `GSD_COPY_DIR` chooses another runtime directory. Both paths are resolved to absolute paths before installation.

Installing again into the same runtime directory preserves unrelated paths. If a package path has local changes, its old version
is moved to `.bak`, `.bak.1`, and so on before replacement. An unchanged
installation is idempotent. `install.sh --copy` runs this
file too: releases before the split ran their downloaded package that way.

Use `--reuse-install-config` when updating to reuse providers and skill roots
recorded in `GSD_BIN_DIR/.gsd-install-manifest`; any `--agent` given with it is
added to the recorded ones. The manifest is parsed as data, never evaluated. Copy runtimes
record owned command names in `.gsd-owned-commands`; removed commands are moved
to backups and only their matching PATH symlinks are removed. Older runtimes
without an inventory cannot safely have obsolete files automatically retired.

The runtime and command directories must be separate from one another and from
the source checkout. The installer refuses overlapping destinations and runtime
root symlinks, including paths ending in a slash. Backups allow recovery.
