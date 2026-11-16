// Shared by tests/node/{ui,ui-browser,batch,migrate}.test.ts (the ports of tests/test-{ui,ui-browser,batch,migrate}.sh).
// Only node:* imports: no sed/awk/grep/find, so the suites run the same on macOS, Linux and Windows.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess, SpawnSyncReturns } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync, statSync, appendFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const PKG = path.resolve(import.meta.dirname, '..', '..');
export const WIN = process.platform === 'win32';
export const LAUNCH = path.join(PKG, 'src', 'launch.mjs');

/** Read BEFORE the host's GSD_* settings are dropped from the test env. */
export const HOST_PLAYWRIGHT_ROOT: string = process.env.GSD_PLAYWRIGHT_ROOT ?? '';

// ── counting, so the report can compare with the bash suite's "N passed" ──
let COUNT = 0;
export const count = (): number => COUNT;
process.on('exit', () => {
  process.stderr.write(`# g4 assertions: ${COUNT}\n`);
});

/** One spelling of the line endings, to compare text from files. */
export const lf = (s: string): string => s.replace(/\r\n/g, '\n');
const tail = (s: string, n = 8): string => lf(s).split('\n').slice(-n).join('\n');

export function ok(label: string, cond: unknown, detail = ''): void {
  COUNT++;
  assert.ok(cond, detail === '' ? label : `${label}\n${detail}`);
}
export function is(label: string, got: unknown, want: unknown): void {
  COUNT++;
  assert.equal(String(got), String(want), label);
}
const matches = (t: string, pat: string | RegExp): boolean => (typeof pat === 'string' ? t.includes(pat) : pat.test(t));
/** grep -q: a string is a literal, a RegExp is matched (use /m for ^ and $ per line) */
export function has(label: string, text: string, pat: string | RegExp): void {
  COUNT++;
  const t = lf(text);
  assert.ok(matches(t, pat), `${label}\n  no ${String(pat)} in:\n${tail(t)}`);
}
export function hasnt(label: string, text: string, pat: string | RegExp): void {
  COUNT++;
  const t = lf(text);
  assert.ok(!matches(t, pat), `${label}\n  ${String(pat)} found in:\n${tail(t)}`);
}
export const read = (f: string): string => readFileSync(f, 'utf8');
export const fileHas = (label: string, file: string, pat: string | RegExp): void => has(label, read(file), pat);
export const fileHasnt = (label: string, file: string, pat: string | RegExp): void => hasnt(label, read(file), pat);

// ── files ──
export function w(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}
export const add = (file: string, text: string): void => appendFileSync(file, text);
export function mkexec(file: string, text: string): void {
  w(file, text);
  chmodSync(file, 0o755);
}
export const real = (p: string): string => realpathSync.native(p);
const roots: string[] = [];
/** A throwaway folder (real path, as `pwd -P` would give). */
export function mkWork(prefix: string): string {
  const d = real(mkdtempSync(path.join(tmpdir(), prefix)));
  roots.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of roots) rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
/** every file under dir (relative, / separators), skipping names in `skip` */
export function files(dir: string, skip: string[] = []): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (!skip.includes(e.name)) out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}
/** sed -n 's/^key: //p' — every matching line's rest, joined by newlines */
export function fmv(file: string, key: string): string {
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (.*)$`);
  return lf(read(file)).split('\n').map((l) => re.exec(l)?.[1]).filter((x): x is string => x !== undefined).join('\n');
}
export const lines = (s: string): string[] => lf(s).split('\n');
export const isExec = (f: string): boolean => {
  try { return (statSync(f).mode & 0o111) !== 0; } catch { return false; }
};

// ── env ──
const DROP = /^(GSD_|CLAUDE_|CODEX_|GIT_|CLICKUP_|XDG_|NPM_CONFIG_|npm_config_)/i;
export type Env = Record<string, string | undefined>;
/** A clean env: the host's GSD_/CLAUDE_/CODEX_/GIT_ settings dropped, HOME and git identity in `work`. */
export function baseEnv(work: string, extra: Env = {}): Env {
  const env: Env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (DROP.test(k)) continue;
    if (/^(home|userprofile|appdata|localappdata)$/i.test(k)) continue;
    env[k] = v;
  }
  const home = path.join(work, 'home');
  mkdirSync(home, { recursive: true });
  const gitconfig = path.join(work, 'gitconfig');
  writeFileSync(gitconfig, '');
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    GSD_NO_UPDATE_CHECK: '1', LANG: 'en_US.UTF-8',
  });
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}
function finalEnv(env: Env, extra: Env = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries({ ...env, ...extra })) if (v !== undefined) out[k] = v;
  return out;
}
/** PATH with PKG/bin first (the checkout's own launchers, never an installed copy). */
export function pathWith(...dirs: string[]): string {
  return [path.join(PKG, 'bin'), ...dirs].join(path.delimiter);
}

export type Run = { status: number; stdout: string; stderr: string; out: string };
export type Opts = { cwd?: string; env?: Env; input?: string };
const mk = (r: SpawnSyncReturns<string>): Run => {
  const stdout = r.stdout ?? '', stderr = r.stderr ?? '';
  return { status: r.status ?? (r.error ? 127 : 1), stdout, stderr: r.error ? `${stderr}${r.error.message}` : stderr, out: stdout + stderr };
};
/** Run a toolkit command (`gsdt-ui`, or `ui`) through its launcher, the way bin/gsdt-* does: node src/launch.mjs <name> … */
export function gsdt(base: Env, cmd: string, args: string[] = [], o: Opts = {}): Run {
  const name = cmd.replace(/^gsdt-/, '');
  const r = spawnSync(process.execPath, [LAUNCH, name, ...args], { cwd: o.cwd, env: finalEnv(base, o.env), encoding: 'utf8', input: o.input ?? '', maxBuffer: 64 << 20 });
  return mk(r);
}
/** Run any program (git, bash, node) with the env. */
export function run(base: Env, cmd: string, args: string[], o: Opts = {}): Run {
  const r = spawnSync(cmd, args, { cwd: o.cwd, env: finalEnv(base, o.env), encoding: 'utf8', input: o.input ?? '', maxBuffer: 64 << 20 });
  return mk(r);
}
/** What `$(git …)` would capture: stdout without the trailing newlines. */
export function git(base: Env, cwd: string, args: string[]): Run {
  return run(base, 'git', args, { cwd });
}
export const chomp = (s: string): string => s.replace(/\n+$/, '');
export function gitOut(base: Env, cwd: string, args: string[]): string {
  return chomp(lf(git(base, cwd, args).stdout));
}
export function gitOk(base: Env, cwd: string, args: string[]): string {
  const r = git(base, cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) failed: ${r.out}`);
  return r.stdout;
}
export function gitHashObject(base: Env, cwd: string, file: string): string {
  return gitOut(base, cwd, ['hash-object', file]);
}
/** git's hash of a text (a blob), as `git hash-object --stdin` would print it */
export function gitHashText(base: Env, text: string): string {
  return chomp(run(base, 'git', ['hash-object', '--stdin'], { input: text }).stdout);
}
export function initRepo(base: Env, dir: string, branch = 'develop'): void {
  mkdirSync(dir, { recursive: true });
  gitOk(base, dir, ['init', '-q', '-b', branch]);
}

// ── stubs on PATH: a POSIX script, plus a .cmd wrapper for Windows (which runs it with Git for Windows' sh) ──
export function stubSh(dir: string, name: string, script: string): string {
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  writeFileSync(f, script);
  chmodSync(f, 0o755);
  if (WIN) writeFileSync(`${f}.cmd`, `@echo off\r\nsh "%~dp0${name}" %*\r\n`);
  return f;
}
/** a link (or, where links are refused, a copy) of a program in `dir` */
export function linkProgram(dir: string, name: string, target: string): void {
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, WIN ? path.basename(target) : name);
  try { symlinkSync(target, f); } catch { copyFileSync(target, f); }
}

// ── a static file server in another process (spawnSync blocks this one) ──
const kids: ChildProcess[] = [];
process.on('exit', () => {
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
});
export type Server = { port: number; stop: () => void };
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}
export function startServer(dir: string, port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const kid = spawn(process.execPath, [path.join(import.meta.dirname, 'g4-static-server.ts'), dir, String(port)], { stdio: ['ignore', 'pipe', 'ignore'] });
    kids.push(kid);
    let buf = '';
    const t = setTimeout(() => reject(new Error('the static server did not start')), 15000);
    kid.once('error', reject);
    kid.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /^port (\d+)\n/.exec(buf);
      if (m) {
        clearTimeout(t);
        kid.stdout!.removeAllListeners('data');
        kid.stdout!.destroy();
        kid.unref();
        resolve({ port: Number(m[1]), stop: () => { try { kid.kill(); } catch { /* gone */ } } });
      }
    });
    kid.once('exit', () => { clearTimeout(t); reject(new Error(`the static server exited early: ${buf}`)); });
  });
}
