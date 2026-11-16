// src/tracker/winexec.ts — running a command on Windows (a copy of the small part of
// src/spawn.ts the tracker needs: src/tracker/ stays standalone). POSIX: unchanged.
// win32: PATH × PATHEXT; .exe/.com direct; .cmd/.bat via cmd.exe with every argument
// quoted; an extensionless file or .sh (a custom tracker script) via Git for Windows' sh.
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

export type Plan = { file: string; args: string[]; windowsVerbatimArguments?: boolean };
export type PlanEnv = { platform?: string; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean };

const isFileSync = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export function cmdEscapeArg(arg: string): string {
  if (/[\r\n\0]/.test(arg)) throw new Error('an argument with a newline cannot be passed through cmd.exe');
  let a = arg.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\+)$/, '$1$1');
  a = `"${a}"`;
  return a.replace(/([()[\]%!^"`<>&|;, *?])/g, '^$1');
}

export function cmdLine(file: string, args: string[]): string {
  return `"${[file, ...args].map(cmdEscapeArg).join(' ')}"`;
}

export function resolveWin(name: string, o: PlanEnv = {}): string | null {
  const env = o.env ?? process.env;
  const exists = o.exists ?? isFileSync;
  const pathext = (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((e) => e !== '')
    .map((e) => e.toLowerCase());
  const dirs = /[\\/]/.test(name) ? [''] : (env.PATH ?? env.Path ?? '').split(';').filter((d) => d !== '');
  const has = path.win32.extname(name) !== '';
  for (const d of dirs) {
    const base = d === '' ? name : `${d.replace(/[\\/]+$/, '')}\\${name}`;
    const cands = [...(has ? [base] : []), ...pathext.map((e) => base + e), ...(has ? [] : [base])];
    for (const c of cands) if (exists(c)) return c;
  }
  return null;
}

export function planSpawn(cmd: string, args: string[], o: PlanEnv = {}): Plan {
  if ((o.platform ?? process.platform) !== 'win32') return { file: cmd, args };
  const r = resolveWin(cmd, o);
  if (r === null) return { file: cmd, args };
  const ext = path.win32.extname(r).toLowerCase();
  if (ext === '.exe' || ext === '.com') return { file: r, args };
  if (ext === '.cmd' || ext === '.bat') {
    const env = o.env ?? process.env;
    return { file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', cmdLine(r, args)], windowsVerbatimArguments: true };
  }
  return { file: 'sh', args: [r.replace(/\\/g, '/'), ...args] };
}

export function spawnSyncX(cmd: string, args: string[], opts: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
export function spawnSyncX(cmd: string, args: string[], opts?: SpawnSyncOptions): SpawnSyncReturns<Buffer>;
export function spawnSyncX(cmd: string, args: string[], opts: SpawnSyncOptions = {}): SpawnSyncReturns<string | Buffer> {
  if (!WIN) return spawnSync(cmd, args, opts);
  const p = planSpawn(cmd, args, { env: opts.env as NodeJS.ProcessEnv | undefined });
  return spawnSync(p.file, p.args, p.windowsVerbatimArguments ? { ...opts, windowsVerbatimArguments: true } : opts);
}

export const spawnX = ((cmd: string, args: string[] = [], opts: SpawnOptions = {}): ChildProcess => {
  if (!WIN) return spawn(cmd, args, opts);
  const p = planSpawn(cmd, args, { env: opts.env as NodeJS.ProcessEnv | undefined });
  return spawn(p.file, p.args, p.windowsVerbatimArguments ? { ...opts, windowsVerbatimArguments: true } : opts);
}) as typeof spawn;
