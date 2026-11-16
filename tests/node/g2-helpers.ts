// Shared by tests/node/{doctor,providers,codex-wait}.test.ts (the node:test ports of
// tests/test-doctor.sh, test-providers.sh, test-codex-wait.sh). Only node:* imports and git;
// runs on macOS, Linux and Windows. Commands run through the checkout's launcher
// (`node src/launch.mjs <command>`), never an installed copy.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const PKG = path.resolve(import.meta.dirname, '..', '..');
export const WIN = process.platform === 'win32';
export const LAUNCH = path.join(PKG, 'src', 'launch.mjs');
/** Reason text for the few Windows-only skips. */
export const winSkip = (reason: string): string | false => WIN && reason;

// The host's GSD/Claude/Codex settings must reach neither the commands nor the in-process calls.
for (const k of Object.keys(process.env)) {
  if (/^(GSD_|CLAUDE_|CODEX_|CLICKUP_)/.test(k)) delete process.env[k];
}
process.env.GSD_NO_UPDATE_CHECK = '1';

const roots: string[] = [];
/** A fresh temp dir (real path, so it equals what git and the commands print). */
export function tmp(prefix = 'gsd-g2-'): string {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  roots.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of roots) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

export const lf = (s: string): string => s.replace(/\r\n/g, '\n');
export const read = (p: string): string => lf(readFileSync(p, 'utf8'));
export function write(file: string, content: string, mode?: number): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode !== undefined && !WIN) chmodSync(file, mode);
  return file;
}
export const exists = (p: string): boolean => existsSync(p);

export type Run = { status: number; stdout: string; stderr: string; out: string };
const shape = (r: ReturnType<typeof spawnSync>): Run => {
  const stdout = String(r.stdout ?? ''),
    stderr = String(r.stderr ?? '');
  return { status: r.status ?? (r.error ? 127 : 1), stdout: lf(stdout), stderr: lf(stderr + (r.error ? r.error.message : '')), out: lf(stdout + stderr) };
};

/** Fixed git identity + no host git config, for every child. */
const GIT_ENV_ROOT = tmp('gsd-g2-gitcfg-');
const EMPTY_GITCONFIG = write(path.join(GIT_ENV_ROOT, 'gitconfig'), '');
export const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
process.env.GIT_CONFIG_GLOBAL = EMPTY_GITCONFIG;
process.env.GIT_CONFIG_NOSYSTEM = '1';
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });

export function git(cwd: string, args: string[], env: Record<string, string | undefined> = {}): Run {
  return shape(spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } as NodeJS.ProcessEnv }));
}
export function gitOk(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.out}`);
  return r.stdout;
}
export const gitTry = (cwd: string, args: string[]): boolean => git(cwd, args).status === 0;

/** A repo on branch `develop` with one empty commit (the old suites' `repo`). */
export function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  gitOk(dir, ['init', '-q', '-b', 'develop']);
  gitOk(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return dir;
}

export type Env = Record<string, string | undefined>;
export type Opts = { cwd?: string; env?: Env; input?: string };

/** process.env plus an overlay (undefined = unset); a PATH key replaces every spelling of PATH (Windows has `Path`). */
export function envWith(overlay: Env = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(overlay)) {
    if (/^path$/i.test(k)) for (const e of Object.keys(env)) if (/^path$/i.test(e)) delete env[e];
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** Run `gsdt-<name>` (name without the prefix) through the checkout's launcher. env undefined values unset a variable. */
export function gsdt(name: string, args: string[] = [], o: Opts = {}): Run {
  return shape(spawnSync(process.execPath, [LAUNCH, name, ...args], { cwd: o.cwd ?? PKG, env: envWith(o.env), encoding: 'utf8', input: o.input ?? '', maxBuffer: 64 << 20 }));
}

/** Run a program (a bash script, sh -c …) with a given env overlay. */
export function exec(file: string, args: string[], o: Opts = {}): Run {
  return shape(spawnSync(file, args, { cwd: o.cwd ?? PKG, env: envWith(o.env), encoding: 'utf8', input: o.input ?? '', maxBuffer: 64 << 20 }));
}

/** Set env vars (undefined = unset) while fn runs, for in-process calls into src/. */
export function withEnv<T>(env: Env, fn: () => T): T {
  const saved: Env = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The PATH entries of the host. */
export const hostPath = (): string[] => (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter((d) => d !== '');
export const joinPath = (dirs: string[]): string => dirs.join(path.delimiter);

/**
 * Stub program on PATH: a POSIX shell script `name` and, for Windows, a `name.cmd` wrapper.
 * `posix` is the shell body (after the shebang); `cmd` is the .cmd body (after @echo off).
 */
export function stubExe(dir: string, name: string, posix: string, cmd: string): string {
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  writeFileSync(f, `#!/bin/sh\n${posix}\n`);
  if (!WIN) chmodSync(f, 0o755);
  writeFileSync(`${f}.cmd`, `@echo off\r\n${cmd.replace(/\n/g, '\r\n')}\r\n`);
  return f;
}

const PATHEXT = WIN ? ['', '.exe', '.cmd', '.bat', '.com'] : [''];
/**
 * A PATH that is the given dirs with every program named in `leaveOut` hidden: a dir that holds one
 * is replaced by a folder of links (copies on Windows) to the rest. Dirs that hold none stay as they are.
 */
export function farm(dirs: string[], leaveOut: string[], into: string): string {
  const hide = new Set(leaveOut.flatMap((n) => PATHEXT.map((e) => (n + e).toLowerCase())));
  const out: string[] = [];
  let i = 0;
  for (const d of dirs) {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    if (!names.some((n) => hide.has(n.toLowerCase()))) {
      out.push(d);
      continue;
    }
    const fd = path.join(into, `farm${i++}`);
    mkdirSync(fd, { recursive: true });
    for (const n of names) {
      if (hide.has(n.toLowerCase())) continue;
      const src = path.join(d, n);
      try {
        if (WIN) copyFileSync(src, path.join(fd, n));
        else symlinkSync(src, path.join(fd, n));
      } catch {
        /* a dir or something unreadable: not a program */
      }
    }
    out.push(fd);
  }
  return joinPath(out);
}

/** Path with every backslash turned into / (and JSON-escaped ones too), to compare path text on Windows. */
export const slashes = (s: string): string => (WIN ? s.replace(/\\\\/g, '/').replace(/\\(?!")/g, '/') : s);
/** Forward-slash spelling of a path, as the toolkit writes it into hooks and messages. */
export const fwd = (p: string): string => (WIN ? p.replace(/\\/g, '/') : p);

export const count = (s: string, needle: string): number => s.split(needle).length - 1;
