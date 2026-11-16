// Loaded with `node --import ./tests/win-preload.ts` (CI passes it on Windows only; elsewhere it does nothing).
// The suites in tests/ts spawn the bash launchers in bin/ (and stub scripts) by path, as POSIX allows and
// Windows does not: CreateProcess cannot run an extensionless script, and has no /bin/bash. This wraps the
// child_process entry points so such a command runs the way src/spawn.ts runs it (planSpawn): a script through
// Git for Windows' `sh`, a .cmd through cmd.exe, a bare name resolved on PATH x PATHEXT. Every other call is
// untouched. It only changes how a TEST starts a program, never what the product does.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planSpawn, resolveWin } from '../src/spawn.ts';

if (process.platform === 'win32' && !(cp as { __gsdWin?: boolean }).__gsdWin) {
  (cp as { __gsdWin?: boolean }).__gsdWin = true;
  // The suites write PATH the POSIX way (`dir:dir:/usr/bin:/bin`). On Windows that is one broken entry, so no program is found.
  // Entries with a drive (C:\x or C:/x) are kept, `/usr/bin`-style ones dropped, and the PATH this run started with is
  // appended (it holds git, node and Git's sh: what `/usr/bin:/bin` stands for).
  // only the folders of the tools a test needs (git, Git's sh and usr/bin, node, System32): not the whole machine PATH,
  // which would let a test find a gsd_run or claude of the runner.
  const HOSTPATH = process.env.PATH ?? process.env.Path ?? '';
  const BASE = (() => {
    const dirs = new Set<string>();
    for (const n of ['git', 'sh', 'bash', 'node', 'tar', 'curl']) {
      const r = resolveWin(n, { env: process.env });
      if (!r) continue;
      const d = path.win32.dirname(r);
      // npm puts gsd_run (and a user's claude, codex, gh) next to node.exe: a test that says "no gsd-core" must be right.
      // Such a folder is replaced by a copy of the one program that was asked for.
      let agents = false;
      try {
        agents = readdirSync(d).some((f) => /^(?:gsd_run|claude|codex|gh|gsdt-[^.]*)(?:\.|$)/i.test(f));
      } catch {
        /* not listable: used as it is */
      }
      if (!agents || n !== 'node') {
        dirs.add(d);
        continue;
      }
      const shadow = path.join(tmpdir(), 'gsdt-win-shadow');
      const to = path.join(shadow, path.win32.basename(r));
      try {
        mkdirSync(shadow, { recursive: true });
        if (!existsSync(to)) {
          const part = `${to}.${process.pid}.tmp`;
          copyFileSync(r, part);
          renameSync(part, to);
        }
        dirs.add(shadow);
      } catch {
        dirs.add(d);
      }
    }
    if (process.env.SystemRoot) dirs.add(`${process.env.SystemRoot}\\System32`);
    return dirs.size ? [...dirs].join(';') : HOSTPATH;
  })();
  const fixPath = (v: string): string => {
    if (!v.replace(/(^|[;:])[A-Za-z]:(?=[\\/])/g, '$1$2').includes(':')) return v;
    const keep = v.match(/[A-Za-z]:[\\/][^;:]*|[^;:]+/g)?.filter((e) => /^[A-Za-z]:[\\/]/.test(e)) ?? [];
    return [...keep, BASE].join(';');
  };
  const fixEnv = <T extends { env?: NodeJS.ProcessEnv }>(o: T | undefined): T | undefined => {
    if (!o?.env) return o;
    const keys = Object.keys(o.env).filter((k) => /^path$/i.test(k));
    if (keys.length === 0) return o;
    const env = { ...o.env };
    const k = keys.includes('PATH') ? 'PATH' : (keys[0] as string);
    const v = fixPath(String(env[k] ?? ''));
    for (const x of keys) delete env[x];
    env.PATH = v;
    return { ...o, env };
  };
  process.env = new Proxy(process.env, {
    set(target, key, value) {
      target[key as string] = typeof key === 'string' && /^path$/i.test(key) && typeof value === 'string' ? fixPath(value) : value;
      return true;
    },
  });
  type Opts = { env?: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean; shell?: unknown } & Record<string, unknown>;
  // `/bin/true`, and also `custom=/opt/x/run` (MSYS rewrites the path after an `=` as well)
  const POSIXARG = /^(?:[A-Za-z_][\w-]*=|--?[\w-]+=)?\/[^/]/;
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
    if (opts) opts = fixEnv(opts);
    const p = planSpawn(FIX[file] ?? file, args, { env: opts?.env ?? process.env });
    // a script run by Git's sh must not have its /-leading arguments (/bin/true, /nonexistent) rewritten into C:/Program Files/Git/...
    // (only those arguments are excluded: the launchers' own /d/a/... paths still need the conversion to D:/a/...)
    if (/^(?:.*[\\/])?(?:sh|bash)(?:\.exe)?$/i.test(p.file)) {
      const base = opts?.env ?? process.env;
      const args = p.args.slice(1).filter((x) => POSIXARG.test(x));
      // environment values too (GSD_CLAUDE_COMMAND=/opt/x/claude): MSYS rewrites them as well
      const vars = Object.keys(base).filter((k) => !/^(?:path|home|tmp|temp|tmpdir)$/i.test(k) && typeof base[k] === 'string' && POSIXARG.test(base[k] as string));
      if (args.length > 0 || vars.length > 0) {
        opts = { ...(opts ?? {}), env: { ...base, ...(args.length ? { MSYS2_ARG_CONV_EXCL: args.join(';') } : {}), ...(vars.length ? { MSYS2_ENV_CONV_EXCL: vars.join(';') } : {}) } };
      }
    }
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
