// src/tracker/json.ts — what the bash adapter got from jq and Python, done natively and
// matching their text exactly: jq's compact output and `-r` strings, `@uri`, and Python's
// json.dumps (ASCII only).
import { err, TrkExit } from './io.ts';

type J = unknown;

/** jq's compact dump: JSON.stringify, but DEL is \u007f. */
export function jqDump(v: J): string {
  return JSON.stringify(v).replace(/\x7f/g, '\\u007f');
}

/** A value as `jq -r` / "\(…)" prints it: strings bare, everything else as JSON. */
export function jqStr(v: J): string {
  if (v === undefined) return 'null';
  return typeof v === 'string' ? v : jqDump(v);
}

/** jq's `a // b`: b unless a is null or false. */
export const alt = (a: J, b: J): J => (a === undefined || a === null || a === false ? b : a);

/** .a.b.c — null where a step is missing or not an object. */
export function get(v: J, ...path: string[]): J {
  let cur = v;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return null;
    cur = (cur as Record<string, J>)[k];
    if (cur === undefined) return null;
  }
  return cur;
}

/** `jq … <<< text` on a document that is not JSON: jq's exit 2. */
export function parse(text: string): J {
  try {
    return JSON.parse(text);
  } catch {
    err('jq: error (at <stdin>:0): Invalid JSON text\n');
    throw new TrkExit(2);
  }
}

/** `.x[]` — a jq iteration; an error (exit 5) when it is not an array/object. */
export function iter(v: J): J[] {
  if (Array.isArray(v)) return v;
  if (v !== null && typeof v === 'object') return Object.values(v as Record<string, J>);
  err(`jq: error (at <stdin>:0): Cannot iterate over ${v === null ? 'null' : typeof v}\n`);
  throw new TrkExit(5);
}

/** Python's json.dumps of a string: ASCII only, \uXXXX for the rest. */
export function pyJsonString(s: string): string {
  let o = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '"') o += '\\"';
    else if (ch === '\\') o += '\\\\';
    else if (c === 10) o += '\\n';
    else if (c === 13) o += '\\r';
    else if (c === 9) o += '\\t';
    else if (c === 8) o += '\\b';
    else if (c === 12) o += '\\f';
    else if (c < 0x20 || c > 0x7e) o += `\\u${c.toString(16).padStart(4, '0')}`;
    else o += ch;
  }
  return `${o}"`;
}

/** jq's `@uri`: everything but A-Za-z0-9 - _ . ~ percent-encoded (UTF-8 bytes). */
export function jqUri(s: string): string {
  let o = '';
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b);
    o += /[A-Za-z0-9\-_.~]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return o;
}

/** A request body, compact like `jq -c` (keys in insertion order; bigint = an exact integer). */
export function ser(v: J): string {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return `[${v.map(ser).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, J>)
      .map(([k, x]) => `${jqDump(k)}:${ser(x)}`)
      .join(',')}}`;
  }
  return jqDump(v);
}
