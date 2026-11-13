// Shared by the parity suites: run a bash function from lib/*.sh and compare
// with its TypeScript port. Throwaway repos live under os.tmpdir().
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const PKG = path.resolve(import.meta.dirname, '..', '..');
export type BashResult = { out: string; err: string; rc: number };

// Keep the host's settings out of both sides.
for (const k of Object.keys(process.env)) {
  if (/^(GSD_|CLAUDE_|CODEX_)/.test(k)) delete process.env[k];
}
process.env.GSD_NO_UPDATE_CHECK = '1';
// One locale for both sides: UTF-8 characters (bash counts é as one letter),
// C collation. GNU sed/grep read a range like [a-z] by the locale's collation,
// so under en_US.UTF-8 on Linux é falls inside [a-z] and the old code keeps it
// in slugs and ticket ids; BSD (macOS) reads ranges as ASCII, which is what the
// old code means and what the new code does. LC_ALL would override
// LC_COLLATE, so it is unset. Files that build their own env use LOCALE_ENV.
export const LOCALE_ENV = { LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8', LC_COLLATE: 'C' } as const;
delete process.env.LC_ALL;
Object.assign(process.env, LOCALE_ENV);

/** Run `script` in bash with common.sh, provider.sh and ui.sh sourced; args are $1… */
export function bash(script: string, args: string[] = [], env: Record<string, string> = {}): BashResult {
  const r = spawnSync(
    'bash',
    ['-c', `. "$GSD_PKG/lib/common.sh"; . "$GSD_PKG/lib/provider.sh"; . "$GSD_PKG/lib/ui.sh"; ${script}`, '_', ...args],
    { encoding: 'utf8', env: { ...process.env, GSD_PKG: PKG, ...env } },
  );
  return { out: r.stdout ?? '', err: r.stderr ?? '', rc: r.status ?? 1 };
}

/** What `$( … )` would capture. */
export const chomp = (s: string): string => s.replace(/\n+$/, '');

/** Set env vars (undefined = unset) while fn runs, so bash and TS see the same. */
export function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
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

const roots: string[] = [];
export function tmp(): string {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), 'gsd-p1-')));
  roots.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

export function sh(cwd: string, cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return r.stdout ?? '';
}

/** A repo on branch `develop` with one commit (the way the bash suites make them). */
export function repo(dir: string = path.join(tmp(), 'r'), conf?: string): string {
  mkdirSync(dir, { recursive: true });
  sh(dir, 'git', ['init', '-q', '-b', 'develop']);
  sh(dir, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  if (conf !== undefined) writeFileSync(path.join(dir, '.gsd.conf'), conf);
  return dir;
}

export function write(file: string, content: string, mode?: number): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode !== undefined) chmodSync(file, mode);
  return file;
}
