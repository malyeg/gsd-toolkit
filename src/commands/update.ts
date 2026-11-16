// gsdt-update — update gsd-toolkit, and GSD itself (gsd-core) to its latest version.
// The TypeScript port of bin/gsdt-update (the bash one is tests/fixtures/p11-old-bins/gsdt-update).
//
// Three ways a copy of the toolkit got here (installMode, src/version.ts):
//   checkout  a git checkout: updates nothing (pull with git; install.sh / gsdt-setup)
//   release   a GitHub-release runtime (0.10.x): hands over to its install.sh, as before
//   npm       the npm package: the release's gsd-toolkit-X.Y.Z.tgz from GitHub (checked
//             against SHA256SUMS), `npm install -g` on it, then gsdt-setup. The npm
//             registry is never asked.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gsdPkg } from '../common.ts';
import { coreSync, coreVersion } from '../core.ts';
import { err, inherit, out } from '../stdio.ts';
import {
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

// Installed as the npm package: the same text, plus how that differs.
const HELP_NPM = `${HELP}
Installed as the npm package: the latest version comes from the GitHub release;
the update downloads that release's gsd-toolkit-X.Y.Z.tgz, checks it against the
release's SHA256SUMS, runs \`npm install -g\` on it, then the new version's
\`gsdt-setup --no-core\` so skills and hooks match it (--version works the same
way, also to go back). The npm registry is not used.
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
  out(`latest    : ${latest !== '' ? latest : 'unknown (GitHub not reachable)'}  (${updateRepo()})\n`);

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
    else out(`• gsd-toolkit not checked (GitHub not reachable)\n`);
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

/** Download `url` to `file` with curl (retrying a GitHub blip). */
function download(url: string, file: string, maxTime: number): boolean {
  const r = spawnSync('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', '--max-time', String(maxTime), url, '-o', file], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status === 0 && existsSync(file)) return true;
  // say why (a missing curl, its exit code, its last words): a bare "download failed" hides a Windows-only cause
  const why = [r.error?.message, r.status !== null && r.status !== 0 ? `curl exit ${r.status}` : '', String(r.stderr ?? '').trim().split('\n').pop()].filter(Boolean).join('; ');
  if (why !== '') err(`  (${why})\n`);
  return false;
}

/** npm mode: install that release's .tgz globally, then run the NEW package's setup. 0 = fine, 1 = setup failed, 2 = the install failed. */
function npmInstall(version: string): number {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) die('--version needs X.Y.Z');
  const name = `gsd-toolkit-${version}.tgz`;
  const base = `https://github.com/${updateRepo()}/releases/download/v${version}`;
  const tmp = mkdtempSync(path.join(tmpdir(), 'gsdt-update-'));
  try {
    out(`▶ downloading gsd-toolkit ${version}…\n`);
    if (!download(`${base}/SHA256SUMS`, path.join(tmp, 'SHA256SUMS'), 30)) die(`download failed: ${base}/SHA256SUMS`);
    let want = '';
    for (const line of readFileSync(path.join(tmp, 'SHA256SUMS'), 'utf8').split('\n')) {
      const m = /^(\S+)\s+\*?(\S+)\s*$/.exec(line);
      if (m && m[2] === name) want = (m[1] as string).toLowerCase();
    }
    if (want === '') die(`${version} has no npm package; install it with its own installer: curl -fsSL https://raw.githubusercontent.com/${updateRepo()}/v${version}/install.sh | bash`);
    const tgz = path.join(tmp, name);
    if (!download(`${base}/${name}`, tgz, 120)) die(`download failed: ${base}/${name}`);
    const have = createHash('sha256').update(readFileSync(tgz)).digest('hex');
    if (have !== want) die(`checksum mismatch for ${name} — not installed`);
    out(`▶ npm install -g ${name}\n`);
    const r = inherit('npm', ['install', '-g', '--no-audit', '--no-fund', tgz]);
    if (r !== 0) {
      err(`⚠ npm install failed (exit ${r}); the release's ${name} is at ${base}/${name}\n`);
      return 2;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  out(`✔ gsd-toolkit ${version} installed\n`);
  // The new package's setup, so skills and hooks match the new version. It reuses
  // the agents gsdt-setup recorded. gsd-core is synced below, not there.
  const s = inherit(process.execPath, [`${gsdPkg()}/src/launch.mjs`, 'setup', '--no-core']);
  if (s !== 0) {
    err(`⚠ gsdt-setup failed (exit ${s}); run:  gsdt-setup --no-core\n`);
    return 1;
  }
  return 0;
}
