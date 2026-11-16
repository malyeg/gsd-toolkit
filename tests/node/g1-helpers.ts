// Shared by tests/node/{planning-reconcile,list,flow-next,worktree-guard}.test.ts.
// Only node:* imports and git/bash on PATH: no sed, awk, grep, find, cut, python.
// Everything runs in a throwaway HOME / git config, never the real ones.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const PKG = path.resolve(import.meta.dirname, '..', '..');
export const LAUNCH = path.join(PKG, 'src', 'launch.mjs');
export const WIN = process.platform === 'win32';
export const FIX = path.join(PKG, 'tests', 'fixtures');

export type Run = { status: number; stdout: string; stderr: string; out: string };

/** Forward slashes (a path written into a git config value or a shell line). */
export const fwd = (p: string): string => p.replace(/\\/g, '/');

export const ROOT: string = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'gsdt-g1-')));
process.on('exit', () => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    // a temp dir left behind is not a failure
  }
});
export const HOME = path.join(ROOT, 'home');
mkdirSync(HOME, { recursive: true });
const GITCONFIG = path.join(ROOT, 'gitconfig');
writeFileSync(GITCONFIG, '[core]\n\tautocrlf = false\n');

let counter = 0;
/** A fresh empty directory under the sandbox. */
export function tmp(name = 'd'): string {
  const d = path.join(ROOT, `${name}-${++counter}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/** The host environment minus everything that could leak into a run, with the checkout's bin/ first on PATH. */
export function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(GSD_|CLAUDE_|CODEX_|GIT_|XDG_|NPM_CONFIG_|npm_|COLUMNS$|LINES$)/i.test(k)) continue;
    if (/^(path|home|userprofile|appdata|localappdata)$/i.test(k)) continue;
    e[k] = v;
  }
  const hostPath = process.env.PATH ?? process.env.Path ?? '';
  Object.assign(e, {
    PATH: [path.join(PKG, 'bin'), hostPath].join(path.delimiter),
    HOME,
    USERPROFILE: HOME,
    APPDATA: path.join(HOME, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(HOME, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(HOME, '.config'),
    XDG_CACHE_HOME: path.join(HOME, '.cache'),
    GIT_CONFIG_GLOBAL: GITCONFIG,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    GSD_NO_UPDATE_CHECK: '1',
    GSD_UPDATE_NOTICE: 'never',
    LANG: 'en_US.UTF-8',
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete e[k];
    else e[k] = v;
  }
  return e;
}

export type Opts = { cwd?: string; env?: Record<string, string | undefined>; input?: string; fullEnv?: NodeJS.ProcessEnv };

export function run(file: string, args: string[], o: Opts = {}): Run {
  const r = spawnSync(file, args, {
    cwd: o.cwd,
    env: o.fullEnv ?? env(o.env),
    input: o.input ?? '',
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  const stdout = r.stdout ?? '';
  const stderr = (r.stderr ?? '') + (r.error ? r.error.message : '');
  return { status: r.status ?? (r.error ? 127 : 1), stdout, stderr, out: stdout + stderr };
}

/** A gsdt command through its launcher (works on every OS; never the installed copy). */
export function gsdt(name: string, args: string[] = [], o: Opts = {}): Run {
  return run(process.execPath, [LAUNCH, name, ...args], o);
}

export function git(cwd: string, ...args: string[]): Run {
  return run('git', args, { cwd });
}
/** git, on the repo's behalf, with a fixed commit date. */
export function gitAt(cwd: string, date: string, ...args: string[]): Run {
  return run('git', args, { cwd, env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}

export const lf = (t: string): string => t.replace(/\r\n/g, '\n');
export function read(f: string): string {
  return lf(readFileSync(f, 'utf8'));
}
export function write(f: string, content: string): string {
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, content);
  return f;
}
export const touch = (f: string): string => write(f, '');

/** The lines of a text (no trailing empty element, CRLF → LF). */
export function lines(t: string): string[] {
  const l = lf(t).split('\n');
  if (l.length > 0 && l[l.length - 1] === '') l.pop();
  return l;
}
/** `grep -c`: how many lines match. */
export function count(t: string, re: RegExp): number {
  return lines(t).filter((l) => re.test(l)).length;
}
/** `sed -n 's/^key=//p'` — the value of every line that starts with `key=`. */
export function vals(t: string, key: string): string[] {
  return lines(t)
    .filter((l) => l.startsWith(`${key}=`))
    .map((l) => l.slice(key.length + 1));
}
/** Strip ANSI colour codes. */
export const plain = (t: string): string => t.replace(/\x1b\[[0-9;]*m/g, '');

// ── the files gsdt-ui would write (tests/ui-fixture.sh) ─────────────────────

/** <P>-UI-CHECK.md for the pages / and /cart at 375px. An empty code means "not compared". */
export function uiFixCheck(dir: string, p: string, status = 'passed', capture = 'cap1', code = ''): void {
  write(
    path.join(dir, `${p}-UI-CHECK.md`),
    `---\nstatus: ${status}\ncapture: ${capture}\ntaken: 2026-01-01T00:00:00Z\ncode: ${code}\n` +
      `url: http://localhost:3005\nfailures: ${status === 'failed' ? 2 : 0}\nwaived: 0\nquestions: 1\nunchecked: 0\n---\n\n` +
      '## Failures\n\nNone.\n\n## Questions\n\n- Q1 | /cart | 375 | C2 | possible clipped text in 1 element(s): div.box "long"\n\n' +
      '## Shots\n\n- / | 375 | home-375-aaaaaa.png\n- /cart | 375 | cart-375-bbbbbb.png\n',
  );
}

/** <P>-UI-LOOK.md answering every rule for both pictures. */
export function uiFixLook(dir: string, p: string, capture = 'cap1', verdict = 'ok', rules = 'R1 R2 R3 R4 R5 R6 R7 R8 R9 R10'): void {
  const rs = rules.split(/\s+/).filter((r) => r !== '');
  let t = `---\ncapture: ${capture}\n---\n\n# look\n\n## / at 375px\n\n`;
  for (const r of rs) t += `- ${r}: ${verdict} — seen in the picture\n`;
  t += '\n## /cart at 375px\n\n';
  for (const r of rs) t += `- ${r}: ok — seen in the picture\n`;
  t += '- Q1: n/a — the box scrolls\n';
  write(path.join(dir, `${p}-UI-LOOK.md`), t);
}

export function uiFixApproval(dir: string, p: string, capture = 'cap1'): void {
  write(path.join(dir, `${p}-UI-APPROVAL.md`), `---\nstatus: approved\ncapture: ${capture}\nby: t\napproved: 2026-01-01T00:00:00Z\n---\n`);
}
