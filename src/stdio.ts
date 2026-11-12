// src/stdio.ts — unbuffered stdout/stderr writes, so our own lines and a child's
// (git, an installer) come out in the order a shell script would print them.
// process.stdout.write may be async for pipes; fd writes are not.
import { spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';

function writeAll(fd: number, s: string): void {
  const b = Buffer.from(s, 'utf8');
  let off = 0;
  while (off < b.length) {
    try {
      off += writeSync(fd, b, off, b.length - off);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') continue; // a non-blocking pipe that is full: retry
      if (code === 'EPIPE') return; // the reader is gone, like a shell writing to a closed pipe
      throw e;
    }
  }
}

/** echo -n to stdout */
export const out = (s: string): void => writeAll(1, s);
/** echo -n to stderr */
export const err = (s: string): void => writeAll(2, s);

/** Run a program with stdout/stderr/stdin passed through (or given); returns its exit status (127 when it cannot start). */
export function inherit(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: Array<'inherit' | 'ignore' | 'pipe'> } = {},
): number {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: opts.stdio ?? ['inherit', 'inherit', 'inherit'],
  });
  if (r.error) return 127;
  if (r.status === null) return 128 + (r.signal ? signalNumber(r.signal) : 0);
  return r.status;
}

/** A signal name → its number (the common ones; 128+n is how a shell reports it). */
export function signalNumber(sig: string): number {
  const n: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15 };
  return n[sig] ?? 0;
}
