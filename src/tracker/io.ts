// src/tracker/io.ts — gsdt-tracker's output, exits and small helpers. Standalone: this
// folder (and src/commands/tracker.ts) imports only node:* and itself — GSD runs
// gsdt-tracker as a command, never as a library (see CLAUDE.md, "Standalone").
import { readSync, writeSync } from 'node:fs';

/** A bash `exit N` (or a `die`): unwinds to main, which returns N. */
export class TrkExit extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

/** Where stdout goes (fd 1; `snapshot --out` points it at the temp file, like `( … ) > "$tmp"`). */
export const io = { outFd: 1 };

function writeAll(fd: number, s: string): void {
  const b = Buffer.from(s, 'utf8');
  let off = 0;
  while (off < b.length) {
    try {
      off += writeSync(fd, b, off, b.length - off);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') continue;
      if (code === 'EPIPE') return;
      throw e;
    }
  }
}
export const out = (s: string): void => writeAll(io.outFd, s);
export const err = (s: string): void => writeAll(2, s);
/** echo "…" */
export const echo = (s: string): void => out(`${s}\n`);

/** `die` — gsdt-tracker: <msg> on stderr, exit 1. */
export function die(msg: string): never {
  err(`gsdt-tracker: ${msg}\n`);
  throw new TrkExit(1);
}

/** What `$( … )` keeps: no trailing newlines. */
export const chomp = (s: string): string => s.replace(/\n+$/, '');

/** bash `[[:space:]]`. */
export const SP = '[ \\t\\r\\n\\v\\f]';

/** ASCII-only lower case (tr '[:upper:]' '[:lower:]' in the C locale). */
export const lower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** `grep -qE '<re>'` over a value printed without a final newline: true when ANY line matches. */
export const grepQ = (re: RegExp, s: string): boolean => s.split('\n').some((l) => re.test(l));

/** cat on stdin to the end. */
export function readAllStdin(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        continue;
      }
      if (code === 'EOF') break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `IFS= read -r line` from a pipe or file on fd 0: byte by byte, so nothing past the line is consumed. */
export function readLineSync(): { line: string; eof: boolean } {
  const bytes: number[] = [];
  const one = Buffer.alloc(1);
  for (;;) {
    let n: number;
    try {
      n = readSync(0, one, 0, 1, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        continue;
      }
      if (code === 'EOF') n = 0;
      else throw e;
    }
    if (n === 0) return { line: Buffer.from(bytes).toString('utf8'), eof: true };
    if (one[0]! === 10) return { line: Buffer.from(bytes).toString('utf8'), eof: false };
    bytes.push(one[0]!);
  }
}
