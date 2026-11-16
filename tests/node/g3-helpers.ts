// Shared by tests/node/{tracker,commands,review-fixes,review-round2}.test.ts: a scrubbed
// environment (temp HOME, no host GSD_/CLAUDE_/CODEX_ settings, no git config), throwaway
// repos under os.tmpdir(), the toolkit's commands run through src/launch.mjs with node (the
// bin/* launchers are bash), stub tools (gsd_run, gh, curl, claude) written as a node script
// plus a POSIX launcher and a .cmd wrapper, and counting assertion helpers that mirror the
// bash suites' is / has / hasnt / ok.
// Runs on macOS, Linux and Windows. Only node:* imports; bash is used for what is bash by nature.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess, SpawnSyncReturns } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const PKG = path.resolve(import.meta.dirname, '..', '..');
export const WIN = process.platform === 'win32';
export const LAUNCH = path.join(PKG, 'src', 'launch.mjs');

// ── the environment ──────────────────────────────────────────────────────────

/** A temp root for the whole file; removed at exit. */
export const W = realpathSync(mkdtempSync(path.join(tmpdir(), 'gsd-g3-')));
process.on('exit', () => {
  try {
    rmSync(W, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* best effort */
  }
});

export const HOME = path.join(W, 'home');
mkdirSync(HOME, { recursive: true });
const GITCONFIG = path.join(W, 'gitconfig');
writeFileSync(GITCONFIG, '');

// Nothing of this machine leaks in: no GSD_/CLAUDE_/CODEX_/CLICKUP_/GIT_/XDG_/npm settings, a temp HOME.
for (const k of Object.keys(process.env)) {
  if (/^(GSD_|CLAUDE_|CODEX_|CLICKUP_|GIT_|XDG_|NPM_CONFIG_|npm_|LC_ALL$)/i.test(k)) delete process.env[k];
}
Object.assign(process.env, {
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
  LANG: 'en_US.UTF-8',
  LC_CTYPE: 'en_US.UTF-8',
  LC_COLLATE: 'C',
});

// The checkout's own bin/ first (never the 0.11.0 that may be installed on this machine): the repo hooks and
// the merge driver the toolkit writes call gsdt-* by name, and in-process helpers look commands up on PATH.
const hostPath = [path.join(PKG, 'bin'), process.env.PATH ?? process.env.Path ?? ''].join(path.delimiter);
for (const k of Object.keys(process.env)) if (/^path$/i.test(k)) delete process.env[k];
process.env.PATH = hostPath;
let pathFront: string[] = [];
let baseExtra: Record<string, string | undefined> = {};

/** Directories put first on PATH (stub tools). The checkout's own bin/ follows. */
export function setStubDirs(...dirs: string[]): void {
  pathFront = dirs;
}
/** Variables every spawned command gets (a GSD_CLI stub, a log path, …). undefined = removed. */
export function setBaseEnv(extra: Record<string, string | undefined>): void {
  baseExtra = { ...baseExtra, ...extra };
}

/** The full environment for one run. */
export function envOf(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^path$/i.test(k)) env[k] = v;
  }
  env.PATH = [...pathFront, hostPath].join(path.delimiter);
  for (const [k, v] of Object.entries({ ...baseExtra, ...extra })) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

// ── running things ───────────────────────────────────────────────────────────

export type Run = { status: number; signal: string | null; stdout: string; stderr: string; out: string };
export type RunOpts = { cwd?: string; env?: Record<string, string | undefined>; input?: string; timeout?: number; rawEnv?: NodeJS.ProcessEnv };

const cmdName = (c: string): string => c.replace(/^gsdt-/, '');

function toRun(r: SpawnSyncReturns<string>): Run {
  const stdout = r.stdout ?? '';
  const stderr = (r.stderr ?? '') + (r.error ? r.error.message : '');
  return { status: r.status ?? (r.signal ? 128 : 127), signal: r.signal, stdout, stderr, out: stdout + stderr };
}

/** Run a toolkit command (`gsdt-tracker` or `tracker`) the way a user does, through its launcher with node. */
export function gsdt(cmd: string, args: string[] = [], o: RunOpts = {}): Run {
  return toRun(
    spawnSync(process.execPath, [LAUNCH, cmdName(cmd), ...args], {
      cwd: o.cwd ?? W,
      env: o.rawEnv ?? envOf(o.env),
      input: o.input ?? '',
      encoding: 'utf8',
      timeout: o.timeout ?? 300000,
      maxBuffer: 64 << 20,
    }),
  );
}

/** Start a toolkit command without waiting. */
export function gsdtAsync(cmd: string, args: string[] = [], o: RunOpts = {}): { child: ChildProcess; done: Promise<Run> } {
  const child = spawn(process.execPath, [LAUNCH, cmdName(cmd), ...args], {
    cwd: o.cwd ?? W,
    env: o.rawEnv ?? envOf(o.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  const done = new Promise<Run>((resolve) => {
    child.on('close', (code, signal) => resolve({ status: code ?? (signal ? 128 : 1), signal, stdout, stderr, out: stdout + stderr }));
  });
  return { child, done };
}

/** Run any program (git, bash, node, …). */
export function run(cmd: string, args: string[] = [], o: RunOpts = {}): Run {
  return toRun(
    spawnSync(cmd, args, {
      cwd: o.cwd ?? W,
      env: o.rawEnv ?? envOf(o.env),
      input: o.input ?? '',
      encoding: 'utf8',
      timeout: o.timeout ?? 300000,
      maxBuffer: 64 << 20,
    }),
  );
}

/** `bash -c` — for what is bash by nature (the shims, scripts the toolkit hands to sh). */
export const bash = (script: string, o: RunOpts = {}): Run => run('bash', ['-c', script], o);

/** `node -e` of an ES module that imports from the checkout (`__PKG__` is replaced by its path as a file URL base). */
export function nodeModule(source: string, o: RunOpts = {}): Run {
  const file = path.join(W, `child-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, source.replaceAll('__PKG__', pathToUrl(PKG)));
  return run(process.execPath, [file], o);
}
const pathToUrl = (p: string): string => `file://${WIN ? '/' : ''}${p.replace(/\\/g, '/')}`;

// ── git and files ────────────────────────────────────────────────────────────

export function git(dir: string, args: string[], o: RunOpts = {}): Run {
  return run('git', ['-C', dir, ...args], o);
}
/** git's stdout without its trailing newline; throws when git fails. */
export function gitOut(dir: string, args: string[]): string {
  const r = git(dir, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${dir}) failed: ${r.out}`);
  return r.stdout.replace(/\n+$/, '');
}
export function gitOk(dir: string, args: string[]): void {
  gitOut(dir, args);
}
/** `git add -A; git commit -qm` */
export function commit(dir: string, msg = 'c'): void {
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '-qm', msg]);
}
/** A repo on `branch` with one empty commit (the bash `repo` helper of review-fixes). */
export function repoWithCommit(dir: string, branch = 'main'): string {
  mkdirSync(dir, { recursive: true });
  gitOk(dir, ['init', '-qb', branch]);
  gitOk(dir, ['commit', '-qm', 'init', '--allow-empty']);
  return dir;
}

export function write(file: string, text: string, mode?: number): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (mode !== undefined && !WIN) chmodSync(file, mode);
  return file;
}
export const read = (file: string): string => readFileSync(file, 'utf8');
/** CRLF → LF (Windows git may check out CRLF). */
export const lf = (s: string): string => s.replace(/\r\n/g, '\n');
export const readLf = (file: string): string => lf(read(file));
export const exists = (p: string): boolean => existsSync(p);
export const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
/** A path as written into a shell script: forward slashes. */
export const fwd = (p: string): string => p.replace(/\\/g, '/');
/** Lines of a text that contain `s` (grep -c). */
export const countLines = (text: string, re: RegExp): number => lf(text).split('\n').filter((l) => re.test(l)).length;
/** The lines of a text, without a trailing empty one. */
export const linesOf = (text: string): string[] => {
  const l = lf(text).split('\n');
  if (l.length > 0 && l[l.length - 1] === '') l.pop();
  return l;
};
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let counter = 0;
/** A fresh path under W (not created). */
export const fresh = (name: string): string => path.join(W, `${name}-${++counter}`);

/** Does git's output name a worktree for a branch starting with `prefix`? The path of it, or ''. */
export function worktreeOf(repo: string, branchPrefix: string): string {
  const out = gitOut(repo, ['worktree', 'list', '--porcelain']);
  let wt = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) wt = line.slice(9);
    else if (line.startsWith(`branch refs/heads/${branchPrefix}`)) return wt;
  }
  return '';
}

// ── stub tools ───────────────────────────────────────────────────────────────

/** A stub command written in JavaScript (CommonJS), runnable by name from PATH. Returns the path to run it by. */
export function stubNode(dir: string, name: string, js: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.js`), js);
  if (WIN) {
    const cmd = path.join(dir, `${name}.cmd`);
    writeFileSync(cmd, `@"${process.execPath}" "%~dp0${name}.js" %*\r\n`);
    return cmd;
  }
  const f = path.join(dir, name);
  writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "${dir}/${name}.js" "$@"\n`);
  chmodSync(f, 0o755);
  return f;
}
/** A stub command written in POSIX sh (Git for Windows' sh there, through a .cmd wrapper). */
export function stubSh(dir: string, name: string, script: string): string {
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  writeFileSync(f, script);
  if (!WIN) {
    chmodSync(f, 0o755);
    return f;
  }
  const cmd = path.join(dir, `${name}.cmd`);
  writeFileSync(cmd, `@sh "%~dp0${name}" %*\r\n`);
  return cmd;
}

/**
 * gsd-core's gsd_run, enough for the claim paths: phase.add appends the next integer phase;
 * phase.insert adds a zero-padded decimal after phase N (as gsd-core does) and prints JSON;
 * config-set edits .planning/config.json.
 */
export const GSD_RUN_JS = `
const fs = require('fs');
const a = process.argv.slice(2);
const key = a[0] + ' ' + a[1];
if (key === 'runtime-identity --raw') {
  console.log('{"packageName":"@opengsd/gsd-core","version":"1.18.0"}');
} else if (key === 'query phase.add') {
  const rm = a[4] + '/.planning/ROADMAP.md';
  let n = 0;
  for (const l of fs.readFileSync(rm, 'utf8').split('\\n')) {
    const m = /^### Phase ([0-9]+):/.exec(l);
    if (m && Number(m[1]) > n) n = Number(m[1]);
  }
  fs.appendFileSync(rm, '\\n### Phase ' + (n + 1) + ': ' + a[2] + '\\n');
} else if (key === 'query phase.insert') {
  const rm = a[5] + '/.planning/ROADMAP.md';
  const num = String(Number(a[2])).padStart(2, '0') + '.1';
  fs.appendFileSync(rm, '\\n### Phase ' + num + ': ' + a[3] + ' (INSERTED)\\n');
  console.log('{\\n  "phase_number": "' + num + '",\\n  "slug": "' + a[3].replace(/ /g, '-') + '"\\n}');
} else if (key === 'query config-set') {
  const f = a[5] + '/.planning/config.json';
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  let d = c;
  const parts = a[2].split('.');
  for (const k of parts.slice(0, -1)) { if (typeof d[k] !== 'object' || d[k] === null) d[k] = {}; d = d[k]; }
  d[parts[parts.length - 1]] = a[3] === 'true' ? true : a[3] === 'false' ? false : a[3];
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
} else {
  console.error('stub gsd_run: unsupported ' + a.join(' '));
  process.exit(1);
}
`;

/** gh: record the call in $GH_LOG (when set), print a PR URL. */
export const GH_JS = `
const fs = require('fs');
if (process.env.GH_LOG) fs.appendFileSync(process.env.GH_LOG, process.argv.slice(2).join(' ') + '\\n');
console.log('https://github.com/example/shop/pull/1');
`;

/** A repo on main + a bare origin, roadmap with phase 1 (catalog); .gsd.conf install/test = none (+ extra lines). */
export function project(dir: string, extraConf = '', extraFiles: Record<string, string | [string, number]> = {}): string {
  gitOk(W, ['init', '-q', '--bare', '-b', 'main', `${dir}.git`]);
  mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });
  gitOk(dir, ['init', '-qb', 'main']);
  write(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n### Phase 1: catalog\n');
  write(path.join(dir, '.gsd.conf'), `install = none\ntest = none\n${extraConf}`);
  for (const [f, c] of Object.entries(extraFiles)) write(path.join(dir, f), typeof c === 'string' ? c : c[0], typeof c === 'string' ? undefined : c[1]);
  commit(dir, 'init');
  gitOk(dir, ['remote', 'add', 'origin', `${dir}.git`]);
  gitOk(dir, ['push', '-qu', 'origin', 'main']);
  return dir;
}

// ── a pty (POSIX `script`) ───────────────────────────────────────────────────

export const HAS_SCRIPT: boolean = !WIN && spawnSync('script', ['-q', '/dev/null', 'true'], { stdio: 'ignore' }).status !== null;
export const NO_PTY: string | false = WIN ? 'needs a pty (script(1)); there is none on Windows' : HAS_SCRIPT ? false : 'script(1) not installed';

/** Run a shell command with a terminal (BSD and util-linux `script` differ). */
export function inTty(cmd: string, o: RunOpts = {}): Run {
  const util = spawnSync('script', ['--version'], { encoding: 'utf8' });
  const isUtil = /util-linux/.test((util.stdout ?? '') + (util.stderr ?? ''));
  const args = isUtil ? ['-qec', cmd, '/dev/null'] : ['-q', '/dev/null', 'bash', '-c', cmd];
  // stdin must be /dev/null, not a pipe: BSD script wants a terminal or a file there
  return toRun(spawnSync('script', args, { cwd: o.cwd ?? W, env: o.rawEnv ?? envOf(o.env), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: o.timeout ?? 300000, maxBuffer: 64 << 20 }));
}

/** inTty without waiting: the child process (script) and its result. */
export function inTtyAsync(cmd: string, o: RunOpts = {}): { child: ChildProcess; done: Promise<Run> } {
  const util = spawnSync('script', ['--version'], { encoding: 'utf8' });
  const isUtil = /util-linux/.test((util.stdout ?? '') + (util.stderr ?? ''));
  const args = isUtil ? ['-qec', cmd, '/dev/null'] : ['-q', '/dev/null', 'bash', '-c', cmd];
  const child = spawn('script', args, { cwd: o.cwd ?? W, env: o.rawEnv ?? envOf(o.env), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  const done = new Promise<Run>((resolve) => {
    child.on('close', (code, signal) => resolve({ status: code ?? (signal ? 128 : 1), signal, stdout, stderr, out: stdout + stderr }));
  });
  return { child, done };
}

// ── assertions that count, named like the bash helpers ───────────────────────

let assertions = 0;
export const assertionCount = (): number => assertions;

/** ok "name" (condition) */
export function ok(name: string, cond: unknown, detail = ''): void {
  assertions++;
  assert.ok(cond, detail ? `${name}\n${detail}` : name);
}
/** is "name" got want */
export function is(name: string, got: unknown, want: unknown): void {
  assertions++;
  assert.equal(got, want, name);
}
/** has "name" pattern text — a string is a literal substring; a RegExp is read per line (^ and $ match at line ends) */
export function has(name: string, text: string, pat: string | RegExp): void {
  assertions++;
  const t = lf(text);
  const hit = typeof pat === 'string' ? t.includes(pat) : new RegExp(pat.source, pat.flags.includes('m') ? pat.flags : `${pat.flags}m`).test(t);
  assert.ok(hit, `${name}\n  expected to find ${String(pat)} in:\n${t.split('\n').slice(-8).join('\n')}`);
}
/** hasnt "name" pattern text */
export function hasnt(name: string, text: string, pat: string | RegExp): void {
  assertions++;
  const t = lf(text);
  const hit = typeof pat === 'string' ? t.includes(pat) : new RegExp(pat.source, pat.flags.includes('m') ? pat.flags : `${pat.flags}m`).test(t);
  assert.ok(!hit, `${name}\n  found ${String(pat)} in:\n${t.split('\n').slice(0, 5).join('\n')}`);
}
/** fails "name" run — the command must exit non-zero (it is the caller's `fails … gsdt-x`). */
export function fails(name: string, r: Run): Run {
  assertions++;
  assert.notEqual(r.status, 0, `${name}: unexpected success\n${r.out}`);
  return r;
}
