// Shared by tests/node/{install,install-copy,update,npm,e2e}.test.ts: throwaway
// dirs, a scrubbed env, a PATH without this machine's own gsdt install, node-written
// stubs (curl, npm, npx, ...) that work on POSIX and Windows, checksums and tarballs,
// and the is/has/hasnt/ok assertions the bash suites had.
// Only node:* imports (plus src/spawn.ts for the Windows command resolution).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSyncX, spawnX } from '../../src/spawn.ts';

export const PKG = path.resolve(import.meta.dirname, '..', '..');
export const WIN = process.platform === 'win32';
export const CI = !!process.env.CI;
export type R = { status: number; stdout: string; stderr: string; out: string };

// ── dirs ─────────────────────────────────────────────────────────────────────
const roots: string[] = [];
/** A fresh, realpath'd temp dir, removed at exit. */
export function mkTmp(prefix = 'gsdt-g5-'): string {
  const d = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  roots.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of roots) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
  }
});

export const fwd = (p: string): string => p.replace(/\\/g, '/');
export const lf = (s: string): string => s.replace(/\r\n/g, '\n');
export const read = (f: string): string => readFileSync(f, 'utf8');
export const readLF = (f: string): string => lf(readFileSync(f, 'utf8'));
export const tryRead = (f: string): string => { try { return readLF(f); } catch { return ''; } };
export const exists = (p: string): boolean => existsSync(p);
export function isLink(p: string): boolean { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
/** exists, counting a dangling link */
export const lexists = (p: string): boolean => { try { lstatSync(p); return true; } catch { return false; } };
export function write(file: string, text: string, mode?: number): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (mode !== undefined && !WIN) chmodSync(file, mode);
  return file;
}
export const mkdirp = (d: string): string => { mkdirSync(d, { recursive: true }); return d; };
export function link(target: string, at: string): void {
  mkdirSync(path.dirname(at), { recursive: true });
  symlinkSync(target, at);
}
/** every file under dir (relative, forward slashes), or [] */
export function walk(dir: string, base = dir): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: string[] = [];
  for (const n of names) {
    const p = path.join(dir, n);
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(p, base));
    else out.push(fwd(path.relative(base, p)));
  }
  return out.sort();
}
/** names under dir (recursive) matching re, as find -name would */
export const findNames = (dir: string, re: RegExp): string[] => walk(dir).filter((f) => re.test(f.split('/').pop() ?? ''));

// ── env and PATH ─────────────────────────────────────────────────────────────
const hostPath = (): string => process.env.PATH ?? process.env.Path ?? '';

/** The first PATH dir (of the host) that holds an executable `name`; null when none. */
export function whichHost(name: string, pathStr: string = hostPath()): string | null {
  const exts = WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of pathStr.split(path.delimiter)) {
    if (d === '') continue;
    for (const e of exts) {
      const f = path.join(d, name + e);
      try {
        if (statSync(f).isFile() && (WIN || (statSync(f).mode & 0o111) !== 0)) return f;
      } catch { /* next */ }
    }
  }
  return null;
}

/**
 * The PATH of a test machine: `front` dirs first, then the system dirs and the
 * dirs of the tools the installers need (and node), the way the bash suites built
 * SYS. It never adds this machine's npm global bin beyond the dir node itself sits
 * in. On Windows the host PATH is kept whole (Git for Windows, bsdtar, npm.cmd).
 */
export function sysPath(front: string[] = [], tools: string[] = ['git', 'perl', 'python3', 'jq', 'bash', 'tar', 'sh'], withNode = true): string {
  const dirs: string[] = [...front];
  if (WIN) dirs.push(hostPath());
  else {
    dirs.push('/usr/bin', '/bin', '/usr/sbin', '/sbin');
    for (const t of tools) {
      const c = whichHost(t);
      if (c !== null && !dirs.includes(path.dirname(c))) dirs.push(path.dirname(c));
    }
    if (withNode) dirs.push(path.dirname(process.execPath));
  }
  return dirs.join(path.delimiter);
}
/** the dir holding the node binary running the tests */
export const NODEDIR = path.dirname(process.execPath);

let gitConfigFile: string | null = null;
/** An empty file to stand in for the global git config (/dev/null does not exist on Windows). */
export function emptyGitConfig(): string {
  if (gitConfigFile === null) gitConfigFile = write(path.join(mkTmp('gsdt-g5-gc-'), 'gitconfig'), '');
  return gitConfigFile;
}

/**
 * The host env minus everything that could leak into a run (GSD_, CLAUDE_, CODEX_,
 * GIT_, XDG_, npm settings), git made deterministic, then `extra` (undefined = unset).
 */
export function baseEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(GSD_|CLAUDE_|CODEX_|GIT_|XDG_|NPM_CONFIG_|npm_config_|CI$)/i.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: emptyGitConfig(), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    LANG: 'en_US.UTF-8',
  });
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}
/** Point HOME (and Windows' equivalents) at `h` in an env. */
export function withHome(env: NodeJS.ProcessEnv, h: string): NodeJS.ProcessEnv {
  return Object.assign(env, { HOME: h, USERPROFILE: h, APPDATA: path.join(h, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(h, 'AppData', 'Local') });
}

// ── running things ───────────────────────────────────────────────────────────
type RunOpts = { cwd?: string; env?: NodeJS.ProcessEnv; input?: string };
/** spawnSync with a closed stdin (like </dev/null), both streams captured; .cmd stubs work on Windows. */
export function run(file: string, args: string[] = [], o: RunOpts = {}): R {
  const r = spawnSyncX(file, args, {
    cwd: o.cwd, env: o.env ?? process.env, encoding: 'utf8', input: o.input ?? '', maxBuffer: 64 << 20,
  });
  const stdout = r.stdout ?? '', stderr = r.stderr ?? '';
  const err = r.error ? `${r.error.message}\n` : '';
  return { status: r.status ?? (r.error ? 127 : 1), stdout: lf(stdout), stderr: lf(stderr + err), out: lf(stdout + stderr + err) };
}
/** like run(), but asynchronous: two of these overlap (two laptops acting at the same moment) */
export function runAsync(file: string, args: string[] = [], o: Omit<RunOpts, 'input'> = {}): Promise<R> {
  return new Promise((resolve) => {
    const p = spawnX(file, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', stdout = '', stderr = '';
    p.stdout?.on('data', (d: Buffer) => { stdout += d; out += d; });
    p.stderr?.on('data', (d: Buffer) => { stderr += d; out += d; });
    p.on('error', (e: Error) => resolve({ status: 127, stdout: lf(stdout), stderr: lf(stderr + e.message), out: lf(out + e.message) }));
    p.on('close', (code: number | null) => resolve({ status: code ?? 1, stdout: lf(stdout), stderr: lf(stderr), out: lf(out) }));
  });
}
/** a bash script, `bash <script> args…` (script path with forward slashes: Git Bash) */
export const bash = (script: string, args: string[] = [], o: RunOpts = {}): R => run('bash', [fwd(script), ...args], o);
/** a toolkit command of the checkout through its launcher: node src/launch.mjs <name> */
export const launch = (name: string, args: string[] = [], o: RunOpts = {}): R =>
  run(process.execPath, [path.join(PKG, 'src', 'launch.mjs'), name, ...args], o);
export const git = (cwd: string, args: string[], env?: NodeJS.ProcessEnv): R => run('git', args, { cwd, env: env ?? baseEnv() });
export function gitOk(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const r = git(cwd, args, env);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) failed: ${r.out}`);
  return r.stdout;
}

/** synchronous sleep (the e2e suite waits a second so file times differ) */
export const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** `npm` through the Windows command resolution; a throwaway cache and offline by default. */
export function npm(args: string[], o: RunOpts = {}): R {
  return run('npm', args, o);
}
export const HAVE_NPM = ((): boolean => {
  const r = spawnSyncX('npm', ['--version'], { encoding: 'utf8', env: process.env, input: '' });
  return r.status === 0;
})();
/** the dev dependencies (npm ci) the pack's build needs */
export const HAVE_TSC = existsSync(path.join(PKG, 'node_modules', '.bin', WIN ? 'tsc.cmd' : 'tsc'));

// ── stubs ────────────────────────────────────────────────────────────────────
/**
 * A fake command on PATH, written in node: <dir>/<name>.mjs holds `body`, <dir>/<name>
 * (a POSIX shell shim) and <dir>/<name>.cmd run it with the node that runs the tests.
 * `body` is an ES module; it gets the args as process.argv.slice(2).
 */
export function stub(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.mjs`), body);
  write(path.join(dir, name), `#!/bin/sh\nexec "${fwd(process.execPath)}" "${fwd(path.join(dir, `${name}.mjs`))}" "$@"\n`, 0o755);
  writeFileSync(path.join(dir, `${name}.cmd`), `@"${process.execPath}" "${path.join(dir, `${name}.mjs`)}" %*\r\n`);
}
/** A fake command that is a plain shell script (POSIX) plus the given .cmd text (Windows). */
export function stubSh(dir: string, name: string, sh: string, cmd = '@exit /b 0\r\n'): void {
  mkdirSync(dir, { recursive: true });
  write(path.join(dir, name), sh, 0o755);
  writeFileSync(path.join(dir, `${name}.cmd`), cmd);
}

// ── checksums, trees, tarballs ───────────────────────────────────────────────
export const sha256 = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');
/** SHA256SUMS in `dir` listing `files` (sha256sum's "hash  name" lines) */
export function sums(dir: string, files: string[]): void {
  writeFileSync(path.join(dir, 'SHA256SUMS'), files.map((f) => `${sha256(path.join(dir, f))}  ${f}\n`).join(''));
}
/** `tar -czf <out> -C <cwd> <name>`, with relative names so a Windows drive letter is never a tar "host". */
export function tarCz(cwd: string, outName: string, name: string): void {
  const r = spawnSync('tar', ['-czf', outName, name], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tar -czf ${outName} failed: ${r.stderr}${r.error ?? ''}`);
}
/** the member names of a .tgz / .tar.gz (tar tzf), "package/" stripped when asked */
export function tarList(file: string): string[] {
  const r = spawnSync('tar', ['tzf', path.basename(file)], { cwd: path.dirname(file), encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`tar tzf ${file} failed: ${r.stderr}`);
  return lf(r.stdout).split('\n').filter((l) => l !== '');
}
/** untar a .tar into `dest` */
export function untar(file: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const r2 = spawnSync('tar', ['-xf', path.basename(file), '-C', path.relative(path.dirname(file), dest) || '.'], { cwd: path.dirname(file), encoding: 'utf8' });
  if (r2.status !== 0) throw new Error(`tar -xf ${file} failed: ${r2.stderr}`);
}
/** copy the files `git ls-files` lists in PKG (tracked, working-tree content) into dest */
export function copyTracked(dest: string): void {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: PKG, encoding: 'buffer', maxBuffer: 64 << 20 });
  for (const rel of r.stdout.toString('utf8').split('\0').filter((x) => x !== '')) {
    const src = path.join(PKG, rel);
    if (!existsSync(src)) continue;   // tracked but deleted in the working tree
    mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    copyFileSync(src, path.join(dest, rel));
  }
}
/** copy dirs/files of PKG (relative names) into dest, keeping modes */
export function copyFromPkg(dest: string, names: string[]): void {
  mkdirSync(dest, { recursive: true });
  for (const n of names) cpSync(path.join(PKG, n), path.join(dest, n), { recursive: true, verbatimSymlinks: true });
}

// ── assertions (the bash suites' is / has / hasnt / ok) ──────────────────────
let assertions = 0;   // G5_COUNT=1 prints how many assertions ran (to compare with the bash suites' check counts)
process.on('exit', () => { if (process.env.G5_COUNT) process.stderr.write(`g5-assertions ${assertions}\n`); });
const tail = (s: string, n = 700): string => (s.length > n ? `…${s.slice(-n)}` : s);
export function ok(label: string, cond: unknown, detail = ''): void { assertions++; assert.ok(cond, detail === '' ? label : `${label}\n${tail(detail)}`); }
export function is<T>(label: string, got: T, want: T): void { assertions++; assert.equal(got, want, `${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); }
export function has(label: string, hay: string, needle: string): void { assertions++; assert.ok(hay.includes(needle), `${label}: no ${JSON.stringify(needle)} in: ${tail(hay)}`); }
export function hasnt(label: string, hay: string, needle: string): void { assertions++; assert.ok(!hay.includes(needle), `${label}: unexpected ${JSON.stringify(needle)} in: ${tail(hay)}`); }
export function matches(label: string, hay: string, re: RegExp): void { assertions++; assert.ok(re.test(hay), `${label}: ${re} does not match: ${tail(hay)}`); }
/** number of lines of `hay` that satisfy re (grep -c) */
export const countLines = (hay: string, re: RegExp): number => lf(hay).split('\n').filter((l) => re.test(l)).length;

/** The sh/bash scripts of the repo need an executable bit on POSIX; Windows has none. */
export const SKIP_WIN_MODE = WIN && 'POSIX file modes are not visible on Windows';
export const SKIP_WIN_LINKS = WIN && 'creating symlinks needs developer mode / admin on Windows';
