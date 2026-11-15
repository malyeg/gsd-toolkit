// src/spawn.ts — the process and path layer for Windows (docs/plan-typescript-port.md, "Windows specifics").
//
// On macOS/Linux every function here is a pass-through (spawn/spawnSync with the
// arguments given, normalizePath = identity). On win32:
//   - a bare command name is resolved on PATH × PATHEXT (Node does not apply PATHEXT);
//   - .exe/.com run directly; .cmd/.bat run through cmd.exe (Node refuses to spawn
//     them without a shell since the CVE-2024-27980 fix), every argument quoted so
//     nothing in it is read by cmd; anything else (an extensionless file or .sh: a
//     stub, a hook script, the pre-merge script) runs as `sh <script>` (Git for Windows).
// src/tracker/ has its own copy (winexec.ts): it must stay standalone.
import { spawn, spawnSync } from 'node:child_process';
import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptions,
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

export const WIN = process.platform === 'win32';
/** The POSIX shell the toolkit runs repo-authored command lines with: bash here, Git for Windows' sh there. */
export const SH = WIN ? 'sh' : 'bash';

/** A path as git prints it vs. as node does: win32 → `/`, uppercase drive, no trailing slash; POSIX → unchanged. */
export function normalizePath(p: string, platform: string = process.platform): string {
  if (platform !== 'win32') return p;
  let s = p.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(s)) s = s[0]!.toUpperCase() + s.slice(1);
  if (s.length > 1 && !/^[A-Za-z]:\/$/.test(s)) s = s.replace(/\/+$/, '');
  return s;
}

/** A path to write into a hook / script text: forward slashes on win32, unchanged elsewhere. */
export function shellPath(p: string, platform: string = process.platform): string {
  return platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

export type Plan = { file: string; args: string[]; windowsVerbatimArguments?: boolean };
export type PlanEnv = { platform?: string; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean };

const isFileSync = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** One argument for cmd.exe (the cross-spawn rules): CRT quoting, then ^ before every cmd metacharacter. Throws on a newline or NUL. */
export function cmdEscapeArg(arg: string): string {
  if (/[\r\n\0]/.test(arg)) throw new Error('an argument with a newline cannot be passed through cmd.exe');
  let a = arg.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\+)$/, '$1$1');
  a = `"${a}"`;
  return a.replace(/([()[\]%!^"`<>&|;, *?])/g, '^$1');
}

/** The command line for `cmd.exe /d /s /c` (outer quotes are removed by /s). */
export function cmdLine(file: string, args: string[]): string {
  return `"${[file, ...args].map(cmdEscapeArg).join(' ')}"`;
}

const hasExt = (name: string): boolean => path.win32.extname(name) !== '';

/** Resolve `name` the way Windows would (PATH × PATHEXT), plus extensionless and .sh files (run by sh). null when not found. */
export function resolveWin(name: string, o: PlanEnv = {}): string | null {
  const env = o.env ?? process.env;
  const exists = o.exists ?? isFileSync;
  const pathext = (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((e) => e !== '')
    .map((e) => e.toLowerCase());
  const sepInName = /[\\/]/.test(name);
  const dirs = sepInName ? [''] : (env.PATH ?? env.Path ?? '').split(';').filter((d) => d !== '');
  const cands = (base: string): string[] => {
    const out: string[] = [];
    if (hasExt(base)) out.push(base);
    for (const e of pathext) out.push(base + e);
    if (!hasExt(base)) out.push(base);
    return out;
  };
  for (const d of dirs) {
    const base = d === '' ? name : `${d.replace(/[\\/]+$/, '')}\\${name}`;
    for (const c of cands(base)) if (exists(c)) return c;
  }
  return null;
}

/**
 * What to hand to spawn so `cmd args…` runs. POSIX: as is. win32: see the header.
 * A command that cannot be resolved is left as is (spawn then reports ENOENT).
 */
export function planSpawn(cmd: string, args: string[], o: PlanEnv = {}): Plan {
  if ((o.platform ?? process.platform) !== 'win32') return { file: cmd, args };
  const r = resolveWin(cmd, o);
  if (r === null) return { file: cmd, args };
  const ext = path.win32.extname(r).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { file: r, args };
  if (ext === '.cmd' || ext === '.bat') {
    const comspec = (o.env ?? process.env).ComSpec ?? (o.env ?? process.env).COMSPEC ?? 'cmd.exe';
    return { file: comspec, args: ['/d', '/s', '/c', cmdLine(r, args)], windowsVerbatimArguments: true };
  }
  // extensionless, .sh, anything else: a shell script
  return { file: 'sh', args: [shellPath(r, 'win32'), ...args] };
}

/** spawnSync through planSpawn. */
export function spawnSyncX(cmd: string, args: string[], opts: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
export function spawnSyncX(cmd: string, args: string[], opts?: SpawnSyncOptions): SpawnSyncReturns<Buffer>;
export function spawnSyncX(cmd: string, args: string[], opts: SpawnSyncOptions = {}): SpawnSyncReturns<string | Buffer> {
  if (!WIN) return spawnSync(cmd, args, opts);
  const p = planSpawn(cmd, args, { env: opts.env as NodeJS.ProcessEnv | undefined });
  return spawnSync(p.file, p.args, p.windowsVerbatimArguments ? { ...opts, windowsVerbatimArguments: true } : opts);
}

/** spawn through planSpawn. */
export const spawnX = ((cmd: string, args: string[] = [], opts: SpawnOptions = {}): ChildProcess => {
  if (!WIN) return spawn(cmd, args, opts);
  const p = planSpawn(cmd, args, { env: opts.env as NodeJS.ProcessEnv | undefined });
  return spawn(p.file, p.args, p.windowsVerbatimArguments ? { ...opts, windowsVerbatimArguments: true } : opts);
}) as typeof spawn;

/** `node <pkg>/src/launch.mjs <name> args…` — how one command runs another of ours (no bash launcher, no PATH). */
export function selfArgv(name: string, args: string[], pkg: string = path.resolve(import.meta.dirname, '..')): [string, string[]] {
  return [process.execPath, [`${pkg}/src/launch.mjs`, name, ...args]];
}
