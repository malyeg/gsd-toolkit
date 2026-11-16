// Loaded with `node --import ./tests/win-preload.ts` (CI passes it on Windows only; elsewhere it does nothing).
// The suites in tests/ts spawn the bash launchers in bin/ (and stub scripts) by path, as POSIX allows and
// Windows does not: CreateProcess cannot run an extensionless script, and has no /bin/bash. This wraps the
// child_process entry points so such a command runs the way src/spawn.ts runs it (planSpawn): a script through
// Git for Windows' `sh`, a .cmd through cmd.exe, a bare name resolved on PATH x PATHEXT. Every other call is
// untouched. It only changes how a TEST starts a program, never what the product does.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { planSpawn } from '../src/spawn.ts';

if (process.platform === 'win32' && !(cp as { __gsdWin?: boolean }).__gsdWin) {
  (cp as { __gsdWin?: boolean }).__gsdWin = true;
  type Opts = { env?: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean; shell?: unknown } & Record<string, unknown>;
  const FIX: Record<string, string> = { '/bin/bash': 'bash', '/bin/sh': 'sh', '/usr/bin/env': 'env' };
  function plan(file: unknown, rest: unknown[]): { file: string; args: string[]; opts: Opts | undefined; optIdx: number } | null {
    if (typeof file !== 'string') return null;
    let args: string[] = [];
    let opts: Opts | undefined;
    let optIdx = -1;
    let i = 0;
    if (Array.isArray(rest[0])) {
      args = rest[0] as string[];
      i = 1;
    }
    if (rest[i] && typeof rest[i] === 'object') {
      opts = rest[i] as Opts;
      optIdx = i;
    }
    if (opts?.shell) return null;
    const p = planSpawn(FIX[file] ?? file, args, { env: opts?.env ?? process.env });
    return { file: p.file, args: p.args, opts: p.windowsVerbatimArguments ? { ...(opts ?? {}), windowsVerbatimArguments: true } : opts, optIdx };
  }
  const wrap = (name: 'spawn' | 'spawnSync' | 'execFile' | 'execFileSync'): void => {
    const orig = (cp as unknown as Record<string, (...a: unknown[]) => unknown>)[name] as (...a: unknown[]) => unknown;
    (cp as unknown as Record<string, unknown>)[name] = function (this: unknown, file: unknown, ...rest: unknown[]) {
      const p = plan(file, rest);
      if (!p) return orig.call(this, file, ...rest);
      const tail = rest.slice();
      const hadArgs = Array.isArray(rest[0]);
      if (hadArgs) tail[0] = p.args;
      else tail.unshift(p.args);
      const oi = p.optIdx >= 0 ? p.optIdx + (hadArgs ? 0 : 1) : -1;
      if (oi >= 0 && p.opts) tail[oi] = p.opts;
      else if (p.opts) tail.splice(1, 0, p.opts);
      return orig.call(this, p.file, ...tail);
    };
  };
  for (const n of ['spawn', 'spawnSync', 'execFile', 'execFileSync'] as const) wrap(n);
  syncBuiltinESMExports();
}
