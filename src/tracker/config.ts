// src/tracker/config.ts — gsdt-tracker's settings (lib/tracker/config.sh). Standalone: nothing
// here (or anywhere in src/tracker/) uses the GSD toolkit's code.
//
// Each setting, first match wins:
//   1. the environment (GSD_TRACKER, GSD_TRACKER_PROFILE, GSD_TRACKER_STATUS_*)
//   2. the repo's git config, section gsdt-tracker (.git/config: never committed, shared by
//      every worktree of the clone); the pre-0.10.0 section gsd-tracker is still read
//   3. .gsd.conf in the repo (a GSD repo's team-shared settings; read only)
//   4. the default: tracker = none in a repo with a .gsd.conf, clickup elsewhere
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { chomp, grepQ, lower, SP } from './io.ts';

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** trk_main: any path inside a repo → its MAIN checkout ('' outside a repo). */
export function trkMain(p: string): string {
  const r = spawnSync('git', ['-C', p || '.', 'worktree', 'list', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  for (const line of (r.stdout ?? '').split('\n')) if (line.startsWith('worktree ')) return line.slice(9);
  return '';
}

/** trk_conf_get: a .gsd.conf key's value ('' when unset). */
export function trkConfGet(repo: string, key: string): string {
  const f = `${repo}/.gsd.conf`;
  if (!isFile(f)) return '';
  const re = new RegExp(`^${SP}*${key}${SP}*=${SP}*`);
  let text: string;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    return '';
  }
  for (const line of text.split('\n')) {
    if (re.test(line)) {
      return line
        .replace(re, '')
        .replace(new RegExp(`${SP}*$`), '')
        .replace(new RegExp(`${SP}*#.*$`), '');
    }
  }
  return '';
}

/** trk_git_get: gsdt-tracker.<key> from the repo's own git config ('' when unset or not a repo). */
export function trkGitGet(repo: string, key: string): string {
  for (const section of ['gsdt-tracker', 'gsd-tracker']) {
    const r = spawnSync('git', ['-C', repo, 'config', '--local', '--get', `${section}.${key}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status === 0) return chomp(r.stdout ?? '');
  }
  return '';
}

export type Setting = 'tracker' | 'profile' | 'command' | 'status_start' | 'status_finish';

/** trk_get: the value and where it came from (env, git, gsd.conf, default, or '' when unset). */
export function trkGet(repo: string, setting: Setting): { val: string; from: string } {
  const e = process.env;
  let envv = '';
  let gitk: string;
  let confk: string;
  switch (setting) {
    case 'tracker':
      envv = e.GSD_TRACKER ?? '';
      gitk = 'tracker';
      confk = 'tracker';
      break;
    case 'profile':
      envv = e.GSD_TRACKER_PROFILE ?? '';
      gitk = 'profile';
      confk = 'tracker_profile';
      break;
    case 'command':
      gitk = 'command';
      confk = 'tracker_command';
      break;
    case 'status_start':
      envv = e.GSD_TRACKER_STATUS_START || e.GSD_CLICKUP_STATUS_START || '';
      gitk = 'statusStart';
      confk = 'tracker_status_start';
      break;
    case 'status_finish':
      envv = e.GSD_TRACKER_STATUS_FINISH || e.GSD_CLICKUP_STATUS_FINISH || '';
      gitk = 'statusFinish';
      confk = 'tracker_status_finish';
      break;
  }
  let val = envv;
  let from = 'env';
  if (!val) {
    val = trkGitGet(repo, gitk);
    from = 'git';
  }
  if (!val) {
    val = trkConfGet(repo, confk);
    from = 'gsd.conf';
  }
  if (!val && setting === 'tracker') {
    val = isFile(`${repo}/.gsd.conf`) ? 'none' : 'clickup';
    from = 'default';
  }
  if (!val) from = '';
  if (setting === 'tracker') val = lower(val);
  return { val, from };
}

export const trkKnown = (t: string): boolean => t === 'none' || t === 'clickup' || t === 'custom';

/** trk_profile_ok: a profile becomes part of a file name. */
export const trkProfileOk = (p: string): boolean => grepQ(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, p);

/** trk_command: the custom tracker's script, absolute ('' when unset). */
export function trkCommand(repo: string): string {
  const c = trkGet(repo, 'command').val;
  if (c === '' || c.startsWith('/')) return c;
  if (c.startsWith('~/')) return `${process.env.HOME ?? homedir()}/${c.slice(2)}`;
  return `${repo}/${c}`;
}

/**
 * trk_clickup_env: the ClickUp token file: $GSD_CLICKUP_CONFIG, else
 * ~/.config/gsd/clickup-<profile>.env with a profile, else ~/.config/gsd/clickup.env.
 * A profile never falls back to the shared file: that would act as the wrong user.
 */
export function trkClickupEnv(repo: string): string {
  if (process.env.GSD_CLICKUP_CONFIG) return process.env.GSD_CLICKUP_CONFIG;
  const home = process.env.HOME ?? homedir();
  const p = trkGet(repo, 'profile').val;
  return p ? `${home}/.config/gsd/clickup-${p}.env` : `${home}/.config/gsd/clickup.env`;
}

/** trk_has_token: the token file sets CLICKUP_API_TOKEN. */
export function trkHasToken(file: string): boolean {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .some((l) => new RegExp(`^${SP}*(export${SP}+)?CLICKUP_API_TOKEN=.`).test(l));
  } catch {
    return false;
  }
}

/** The repo folder's name as a profile (login's default): lower case, odd characters → -, ≤ 64. */
export function profileFromRepo(repo: string): string {
  return lower(basename(repo))
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[^a-z0-9]*/, '')
    .slice(0, 64);
}

/** trk_print_config: the resolved settings, offline, one key=value per line (never the token). */
export function trkPrintConfig(repo: string): string[] {
  const o: string[] = [];
  const t = trkGet(repo, 'tracker');
  o.push(`tracker=${t.val}`, `tracker_from=${t.from}`, `tracker_ok=${trkKnown(t.val) ? 'yes' : 'no'}`);
  const p = trkGet(repo, 'profile');
  o.push(`profile=${p.val}`, `profile_from=${p.from}`);
  if (p.val) o.push(`profile_ok=${trkProfileOk(p.val) ? 'yes' : 'no'}`);
  if (t.val === 'clickup') {
    const f = trkClickupEnv(repo);
    o.push(`token_file=${f}`);
    o.push(process.env.CLICKUP_API_TOKEN ? 'token=env' : trkHasToken(f) ? 'token=file' : 'token=missing');
  }
  if (t.val === 'custom') {
    o.push(`command=${trkCommand(repo)}`, `command_from=${trkGet(repo, 'command').from}`);
  }
  o.push(`status_start=${trkGet(repo, 'status_start').val}`, `status_finish=${trkGet(repo, 'status_finish').val}`);
  return o;
}
