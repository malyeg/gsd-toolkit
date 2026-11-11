// src/update-check.ts — the "a newer release is out" half of lib/version.sh, as
// far as gsdt-doctor needs it (P5). lib/version.sh stays for the bash callers
// (gsdt-start/list notice, gsdt-update); P11 moves the rest and merges this
// with src/version.ts.
//
// Two things are checked: gsd-toolkit (GitHub releases of $GSD_UPDATE_REPO) and
// GSD itself (@opengsd/gsd-core on npm). Each latest version is cached for a
// day in ${XDG_CACHE_HOME:-~/.cache}/gsd-toolkit/ so commands never wait on the
// network. Programs (curl, npm) are run as child processes, so a stub on PATH
// works like it does for the bash.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { commandOnPath, gsdPkg } from './common.ts';

const GSD_UPDATE_REPO_DEFAULT = 'malyeg/gsd-toolkit';
const nz = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);
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

/** gsd_latest_fetch — latest release version from GitHub ('' when unreachable) */
function latestFetch(): string {
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
function gsdFetch(): string {
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
