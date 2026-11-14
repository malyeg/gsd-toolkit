// gsdt-update — update gsd-toolkit, and GSD itself (gsd-core) to its latest version.
// The TypeScript port of bin/gsdt-update (the bash one is tests/fixtures/p11-old-bins/gsdt-update).
//
// Three ways a copy of the toolkit got here (installMode, src/version.ts):
//   checkout  a git checkout: updates nothing (pull with git; ./install.sh installs the release)
//   release   a GitHub-release runtime (0.10.x): hands over to its install.sh, as before
//   npm       the npm package: `npm install -g gsd-toolkit@<version>`, then gsdt-setup
import { existsSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gsdPkg } from '../common.ts';
import { coreSync, coreVersion } from '../core.ts';
import { err, inherit, out } from '../stdio.ts';
import {
  NPM_PACKAGE,
  gsdFetch,
  gsdVersion,
  installMode,
  latestFetch,
  readManifest,
  setupManifestPath,
  updateRepo,
  versionGt,
} from '../version.ts';

const HELP = `
gsdt-update — update gsd-toolkit to the latest GitHub release, and GSD
itself (gsd-core) to its latest version.

Usage:
  gsdt-update                   install the latest release, if it is newer;
                               then gsd-core for each installed agent
  gsdt-update --check           print the installed and latest versions only
  gsdt-update --version <X.Y.Z> install that release (also to go back)
  gsdt-update --no-core         leave gsd-core as it is

gsd-core is updated for each agent the install chose (claude, codex), with
the full skill profile; an agent without it gets it.

Commands and skills are replaced in place; the agents you installed for are
kept (install manifest). The release you had before stays on disk, so
going back is \`gsdt-update --version <old>\`.

Run from a git checkout, it updates nothing: the checkout is pulled with
git, and ./install.sh installs the release.

Other commands (gsdt-start, gsdt-list) print one line when a newer release is
out, at most one GitHub call a day; gsdt-doctor reports it too.
Env: GSD_NO_UPDATE_CHECK=1 turns those checks off; GSD_UPDATE_REPO=owner/name;
     GSD_NO_CORE=1 same as --no-core (tests).
`;

// Installed from npm the same text, plus how that differs.
const HELP_NPM = `${HELP}
Installed from npm (npm i -g gsd-toolkit): the latest version comes from the npm
registry; the update is \`npm install -g gsd-toolkit@<version>\`, then the new
version's \`gsdt-setup --no-core\` so skills and hooks match it (--version works the
same way, also to go back).
`;

class Die extends Error {}
const die = (m: string): never => {
  throw new Die(m);
};

/** Write the latest version to its cache file (best effort, like the bash). */
function cacheWrite(file: string, v: string): void {
  if (v === '') return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${v}\n`);
  } catch {
    // best effort
  }
}
const cacheDir = (): string => `${process.env.XDG_CACHE_HOME || `${process.env.HOME ?? ''}/.cache`}/gsd-toolkit`;

export function main(argv: string[]): number {
  // the launcher passes the dir a symlinked bin/gsdt-update sits in (the bash used `$0`)
  const linkDir = process.env.GSD_UPDATE_LINK_DIR ?? '';
  delete process.env.GSD_UPDATE_LINK_DIR;
  try {
    return run(argv, linkDir);
  } catch (e) {
    if (!(e instanceof Die)) throw e;
    err(`gsdt-update: ${e.message}\n`);
    return 1;
  }
}

function run(argv: string[], linkDir: string): number {
  let check = false;
  let want = '';
  let core = (process.env.GSD_NO_CORE ?? '') === '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--check' || a === '-n') check = true;
    else if (a === '--version') {
      if (i + 1 >= argv.length) die('--version needs X.Y.Z');
      want = (argv[++i] as string).replace(/^v/, '');
    } else if (a === '--no-core') core = false;
    else if (a === '-h' || a === '--help') {
      out(installMode() === 'npm' ? HELP_NPM : HELP);
      return 0;
    } else die(`unknown option: ${a} (see gsdt-update --help)`);
  }

  const pkg = gsdPkg();
  const mode = installMode(pkg);
  const home = process.env.HOME ?? '';
  const installBin = linkDir !== '' ? linkDir : process.env.GSD_BIN_DIR || `${home}/.local/bin`;

  const cur = gsdVersion();
  const latest = latestFetch();
  const cacheFile = `${cacheDir()}/latest-version`;
  cacheWrite(cacheFile, latest);
  out(`installed : ${cur}  (${pkg})\n`);
  out(`latest    : ${latest !== '' ? latest : mode === 'npm' ? 'unknown (npm not reachable)' : 'unknown (GitHub not reachable)'}  (${mode === 'npm' ? `npm ${NPM_PACKAGE}` : updateRepo()})\n`);

  if (mode === 'checkout') {
    out(`• this is a git checkout, not a release — pull it with git; install the release with: ${pkg}/install.sh\n`);
    return 0;
  }

  // gsd-core: the agents this install chose (its manifest), and npm's latest
  const manifest = readManifest(mode === 'npm' ? setupManifestPath() : `${installBin}/.gsd-install-manifest`);
  const agents = (manifest.providers ?? '') || 'claude';
  let coreLatest = '';
  let coreBehind = false;
  if (core) {
    coreLatest = gsdFetch();
    cacheWrite(`${cacheDir()}/latest-gsd-core-version`, coreLatest);
    for (const a of agents.split(',')) {
      const have = coreVersion(a);
      out(`gsd-core  : ${a} ${have !== '' ? have : 'not installed'}, latest ${coreLatest !== '' ? coreLatest : 'unknown (npm not reachable)'}\n`);
      if (have === '' || (coreLatest !== '' && versionGt(coreLatest, have))) coreBehind = true;
    }
  }

  const toolkitNew = latest !== '' && versionGt(latest, cur);
  if (check) {
    out(toolkitNew || coreBehind ? '▶ update available: gsdt-update\n' : '✔ up to date\n');
    return 0;
  }
  if (want === '') {
    if (toolkitNew) want = latest;
    else if (latest !== '') out('✔ gsd-toolkit is up to date\n');
    else if (!core) die(mode === 'npm' ? 'cannot find the latest version — try again online, or pass --version X.Y.Z' : 'cannot find the latest release — try again online, or pass --version X.Y.Z');
    else out(`• gsd-toolkit not checked (${mode === 'npm' ? 'npm' : 'GitHub'} not reachable)\n`);
  }
  let rc = 0;
  if (want !== '') {
    if (mode === 'npm') {
      rc = npmInstall(want);
      if (rc === 2) return 1; // the install itself failed: leave gsd-core alone, like a failed release download
    }
    else {
      if (!existsSync(`${pkg}/install.sh`)) die(`${pkg} has no install.sh — reinstall once with the curl line in the README`);
      // Keep this install's places: its bin dir, and (for a release runtime) its
      // releases dir. Anything else (an old --copy runtime) moves to the default.
      const relDir = path.basename(path.dirname(pkg)) === 'releases' ? path.dirname(pkg) : '';
      const r = inherit('bash', [`${pkg}/install.sh`, '--version', want, '--reuse-install-config'], {
        env: { ...process.env, GSD_BIN_DIR: installBin, GSD_RELEASES_DIR: relDir !== '' ? relDir : (process.env.GSD_RELEASES_DIR ?? '') },
      });
      if (r !== 0) return r; // set -e in the bash
    }
  }

  // After the toolkit, so a failed release download leaves gsd-core alone.
  if (core) for (const a of agents.split(',')) coreSync(a, 'update', coreLatest);
  return rc;
}

/** npm mode: install that version globally, then run the NEW package's setup. 0 = fine, 1 = setup failed, 2 = the install failed. */
function npmInstall(version: string): number {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) die('--version needs X.Y.Z');
  const spec = `${NPM_PACKAGE}@${version}`;
  out(`▶ npm install -g ${spec}\n`);
  const r = inherit('npm', ['install', '-g', spec]);
  if (r !== 0) {
    err(`⚠ npm install failed (exit ${r}); run:  npm install -g ${spec}\n`);
    return 2;
  }
  out(`✔ ${spec} installed\n`);
  // The new package's setup, so skills and hooks match the new version. It reuses
  // the agents gsdt-setup recorded. gsd-core is synced below, not there.
  const s = inherit(process.execPath, [`${gsdPkg()}/src/launch.mjs`, 'setup', '--no-core']);
  if (s !== 0) {
    err(`⚠ gsdt-setup failed (exit ${s}); run:  gsdt-setup --no-core\n`);
    return 1;
  }
  return 0;
}
