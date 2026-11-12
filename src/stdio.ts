// src/stdio.ts — unbuffered stdout/stderr writes, so our own lines and a child's
// (git, an installer) come out in the order a shell script would print them.
// process.stdout.write may be async for pipes; fd writes are not.
import { spawn, spawnSync } from 'node:child_process';
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

/**
 * Open an agent session in `cwd` and wait for it — bash `exec`'d the session, Node cannot. So that a
 * signal still means what it did then: Ctrl-C / Ctrl-\ (sent by the terminal to the session too) do
 * not kill this launcher and leave the session running behind the shell prompt; a TERM or HUP sent
 * to the launcher is passed on to the session. Resolves to its exit status (128+n on a signal; 127
 * when it cannot start).
 */
export function runSession(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const ignore = (): void => {};
    let done = false;
    const handlers: Array<[NodeJS.Signals, () => void]> = [];
    const finish = (rc: number): void => {
      if (done) return;
      done = true;
      for (const [s, h] of handlers) process.off(s, h);
      resolve(rc);
    };
    const child = spawn(cmd, args, { stdio: 'inherit', cwd });
    const pass = (sig: NodeJS.Signals) => (): void => {
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    };
    handlers.push(['SIGINT', ignore], ['SIGQUIT', ignore], ['SIGTERM', pass('SIGTERM')], ['SIGHUP', pass('SIGHUP')]);
    for (const [s, h] of handlers) process.on(s, h);
    child.on('error', () => finish(127));
    child.on('exit', (code, signal) => finish(code ?? 128 + (signal ? signalNumber(signal) : 0)));
  });
}
