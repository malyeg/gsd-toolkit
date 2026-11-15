// src/version.ts — the toolkit's version, how this copy was installed, what
// gsdt-setup recorded, and the "a newer release is out" check (lib/version.sh).
//
// Two things are checked: gsd-toolkit (GitHub releases of $GSD_UPDATE_REPO for a
// checkout or a release runtime; the npm registry for the npm package) and GSD
// itself (@opengsd/gsd-core on npm). Each latest version is cached for a day in
// ${XDG_CACHE_HOME:-~/.cache}/gsd-toolkit/ so commands never wait on the
// network: updateNotice reads the caches and refreshes stale ones in a detached
// child. Programs (curl, npm) are run as child processes, so a stub on PATH works.
import { spawnX as spawn, spawnSyncX as spawnSync } from './spawn.ts';
import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { err } from './stdio.ts';
import { commandOnPath, gsdPkg } from './common.ts';

/** gsd_version — X.Y.Z of this package ('unknown' without a VERSION file) */
export function gsdVersion(): string {
  try {
    const first = readFileSync(`${gsdPkg()}/VERSION`, 'utf8').split('\n')[0] ?? '';
    return first.replace(/\s/g, '') || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * How this package got here:
 *   checkout — a git checkout (.git): updated with git, never by gsdt-update
 *   release  — a 0.10.x-style release runtime (has install.sh: GitHub tarball)
 *   npm      — the npm package (npm i -g gsd-toolkit; no install.sh shipped)
 */
export type InstallMode = 'checkout' | 'release' | 'npm';
export function installMode(pkg: string = gsdPkg()): InstallMode {
  if (existsSync(`${pkg}/.git`)) return 'checkout';
  if (existsSync(`${pkg}/install.sh`)) return 'release';
  return 'npm';
}

const nz = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);

/**
 * gsdt-setup's record of the machine setup: ${XDG_CONFIG_HOME:-~/.config}/gsd/setup-manifest.
 * Same tab-separated lines as the release install's ~/.local/bin/.gsd-install-manifest
 * (providers, user_hook, <provider>_skills) plus `bin` (the dir the user hooks run
 * the commands from).
 */
export function setupManifestPath(): string {
  return `${nz(process.env.XDG_CONFIG_HOME) ?? `${process.env.HOME ?? ''}/.config`}/gsd/setup-manifest`;
}

/** key → value of a manifest file ({} when missing/unreadable; the first line of a key wins) */
export function readManifest(file: string): Record<string, string> {
  const m: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return m;
  }
  for (const line of text.split('\n')) {
    const i = line.indexOf('\t');
    if (i <= 0) continue;
    const k = line.slice(0, i);
    if (!(k in m)) m[k] = line.slice(i + 1);
  }
  return m;
}

// ── latest-release check ────────────────────────────────────────────────────

const GSD_UPDATE_REPO_DEFAULT = 'malyeg/gsd-toolkit';
const cacheDir = (): string => `${nz(process.env.XDG_CACHE_HOME) ?? `${process.env.HOME ?? ''}/.cache`}/gsd-toolkit`;

/** gsd_update_repo */
export function updateRepo(): string {
  return nz(process.env.GSD_UPDATE_REPO) ?? GSD_UPDATE_REPO_DEFAULT;
}

/** gsd_version_gt — $1 > $2 ? (X.Y.Z, a leading v is fine; anything else → false) */
export function versionGt(a0: string, b0: string): boolean {
  const a = a0.replace(/^v/, '');
  const b = b0.replace(/^v/, '');
  const ok = /^[0-9]+(\.[0-9]+){0,2}$/;
  if (!ok.test(a) || !ok.test(b)) return false;
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < 3; i++) {
    const x = BigInt(pa[i] ?? '0');
    const y = BigInt(pb[i] ?? '0');
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

const updateCache = (): string => `${cacheDir()}/latest-version`;
const gsdCache = (): string => `${cacheDir()}/latest-gsd-core-version`;

function stale(f: string): boolean {
  try {
    return Date.now() - statSync(f).mtimeMs >= 1440 * 60 * 1000;
  } catch {
    return true;
  }
}

function cached(f: string): string {
  try {
    return (readFileSync(f, 'utf8').split('\n')[0] ?? '').replace(/\s/g, '');
  } catch {
    return '';
  }
}

function refresh(f: string, fetch: () => string): void {
  try {
    mkdirSync(path.dirname(f), { recursive: true });
  } catch {
    return;
  }
  const v = fetch();
  try {
    if (v !== '') {
      const t = `${f}.${process.pid}`;
      writeFileSync(t, `${v}\n`);
      renameSync(t, f);
    } else if (existsSync(f)) {
      const now = new Date();
      utimesSync(f, now, now);
    } else {
      writeFileSync(f, '');
    }
  } catch {
    // best effort, like the bash
  }
}

/** The npm package name of this toolkit. */
export const NPM_PACKAGE = 'gsd-toolkit';

/** `npm view gsd-toolkit version` — the latest version on npm ('' when unreachable) */
export function npmLatest(): string {
  if (commandOnPath('npm') === null) return '';
  const r = spawnSync('npm', ['view', NPM_PACKAGE, 'version', '--fetch-retries=0', '--fetch-timeout=5000'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  for (const line of (r.stdout ?? '').split('\n')) if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(line.trim())) return line.trim();
  return '';
}

/**
 * gsd_latest_fetch — this toolkit's latest version ('' when unreachable): GitHub
 * releases for a checkout or a release runtime, npm for the npm package.
 */
export function latestFetch(): string {
  if (installMode() === 'npm') return npmLatest();
  const r = spawnSync(
    'curl',
    ['-fsSL', '--max-time', '5', '-H', 'Accept: application/vnd.github+json', `https://api.github.com/repos/${updateRepo()}/releases/latest`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = /^.*"tag_name"[ \t\n\r\f\v]*:[ \t\n\r\f\v]*"v?([0-9][0-9.]*)".*$/.exec(line);
    if (m) return m[1] as string;
  }
  return '';
}

/** gsd_latest_stale / gsd_latest_refresh / gsd_latest_cached */
export const latestStale = (): boolean => stale(updateCache());
export const latestRefresh = (): void => refresh(updateCache(), latestFetch);
export const latestCached = (): string => cached(updateCache());

/** gsd_gsd_fetch — latest @opengsd/gsd-core on npm ('' when unreachable) */
export function gsdFetch(): string {
  if (commandOnPath('npm') === null) return '';
  const r = spawnSync('npm', ['view', '@opengsd/gsd-core', 'dist-tags.latest', '--fetch-retries=0', '--fetch-timeout=5000'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  for (const line of (r.stdout ?? '').split('\n')) if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(line)) return line;
  return '';
}

/** gsd_gsd_stale / gsd_gsd_refresh / gsd_gsd_cached */
export const gsdStale = (): boolean => stale(gsdCache());
export const gsdRefresh = (): void => refresh(gsdCache(), gsdFetch);
export const gsdCached = (): string => cached(gsdCache());

/** gsd_gsd_installed — installed gsd-core X.Y.Z ('' when not found), without starting node */
export function gsdInstalled(): string {
  const home = process.env.HOME ?? '';
  const cands = [
    process.env.GSD_CLI ?? '',
    commandOnPath('gsd_run') ?? '',
    `${nz(process.env.CLAUDE_CONFIG_DIR) ?? `${home}/.claude`}/gsd-core/bin/gsd_run`,
    `${nz(process.env.CODEX_HOME) ?? `${home}/.codex`}/gsd-core/bin/gsd_run`,
  ];
  for (let c of cands) {
    if (c === '' || !existsSync(c)) continue;
    for (;;) {
      let t: string;
      try {
        t = readlinkSync(c);
      } catch {
        break;
      }
      c = t.startsWith('/') ? t : `${path.dirname(c)}/${t}`;
    }
    c = path.dirname(c);
    let v = '';
    try {
      const first = (readFileSync(`${c}/../VERSION`, 'utf8').split('\n')[0] ?? '');
      v = /^[0-9]+\.[0-9]+\.[0-9]+/.exec(first)?.[0] ?? '';
    } catch {
      // none
    }
    if (v === '') {
      try {
        for (const line of readFileSync(`${c}/../../package.json`, 'utf8').split('\n')) {
          if (!line.includes('"version"')) continue;
          const m = /[0-9]+\.[0-9]+\.[0-9]+/.exec(line);
          if (m) {
            v = m[0];
            break;
          }
        }
      } catch {
        // none
      }
    }
    if (v !== '') return v;
  }
  return '';
}

const GSD_GSD_UPDATE_CMD = 'npx @opengsd/gsd-core@latest';

/** gsd_core_update_how — the command that updates gsd-core here */
export function coreUpdateHow(agent = 'claude'): string {
  return existsSync(`${gsdPkg()}/.git`) ? `${GSD_GSD_UPDATE_CMD} --${agent || 'claude'} --global --profile=full` : 'gsdt-update';
}

/** gsd_update_how — the command that updates THIS install */
export function updateHow(): string {
  return existsSync(`${gsdPkg()}/.git`) ? `${gsdPkg()}/install.sh` : 'gsdt-update';
}

/** Fetch the named latest versions and cache them — the body of the detached refresh child. */
export function refreshCaches(kinds: string[]): void {
  if (kinds.includes('latest')) latestRefresh();
  if (kinds.includes('gsd')) gsdRefresh();
}

/** Refresh in a child that outlives us, so no command waits on the network. */
function refreshInBackground(kinds: string[]): void {
  try {
    const c = spawn(process.execPath, [`${gsdPkg()}/src/launch.mjs`, 'update-refresh', ...kinds], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    c.on('error', () => {});
    c.unref();
  } catch {
    // best effort
  }
}

/**
 * gsd_update_notice — a newer release? One stderr line per newer version known
 * (this toolkit, GSD itself), only for a person at a terminal (stderr is a tty)
 * so piped / JSON / agent output stays clean; GSD_UPDATE_NOTICE=always forces
 * it (tests). gsdt-doctor always reports it.
 */
export function updateNotice(): void {
  if ((process.env.GSD_NO_UPDATE_CHECK ?? '') !== '') return;
  if (!process.stderr.isTTY && process.env.GSD_UPDATE_NOTICE !== 'always') return;
  const kinds: string[] = [];
  if (latestStale()) kinds.push('latest');
  if (gsdInstalled() !== '' && gsdStale()) kinds.push('gsd');
  if (kinds.length > 0) refreshInBackground(kinds);
  let nw = latestCached();
  let cur = gsdVersion();
  if (nw !== '' && versionGt(nw, cur)) err(`• gsd-toolkit ${nw} is out (you have ${cur}) — update: ${updateHow()}\n`);
  nw = gsdCached();
  if (nw !== '') {
    cur = gsdInstalled();
    if (cur !== '' && versionGt(nw, cur)) err(`• GSD ${nw} is out (you have ${cur}) — update: ${coreUpdateHow()}\n`);
  }
}
