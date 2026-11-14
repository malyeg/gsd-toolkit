// src/codex-wait.ts — Codex usage-limit helpers for gsdt-codex-wait: the duration
// parser, human(), the limit-message parser, the session-log scan. Port of
// lib/gsd_codex_limit.py (kept as the oracle in tests/fixtures/p10-old-bins/) and
// the helper functions of bin/gsdt-codex-wait. Reads text and files only; never
// calls Codex.
//
// Codex's message looks like "You’ve hit your usage limit. … try again at Oct
// 11th, 2026 1:22 AM." (curly apostrophe; local time, minutes only). Older
// builds said "try again in 2 days 3 hours".
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PyJsonError, pyLoads } from './pyjson.ts';
import type { PyJson } from './pyjson.ts';

const LIMIT = /hit your usage limit/i;
const MONTHS: Record<string, number> = Object.fromEntries('jan feb mar apr may jun jul aug sep oct nov dec'.split(' ').map((m, i) => [m, i + 1]));
const AMPM = String.raw`(?:\s*([ap])\.?m\.?)?`;
const AT_DATE_SRC =
  String.raw`try again at\s+([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?` + String.raw`\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?` + AMPM;
const AT_TIME_SRC = String.raw`try again at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?` + AMPM;
const IN_DUR_SRC = String.raw`try again in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)`;
const UNIT_SRC = String.raw`(\d+)\s*([dhms])`;
const SECONDS: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };

/** dur(): "90s", "30m", "4h", "1d" or plain seconds → seconds; null when it is not one. */
export function parseDuration(s: string): number | null {
  const n = s.replace(/[smhd]$/, '');
  if (!/^[0-9]+$/.test(n)) return null;
  const v = parseInt(n, 10);
  if (s.endsWith('d')) return v * 86400;
  if (s.endsWith('h')) return v * 3600;
  if (s.endsWith('m')) return v * 60;
  return v;
}

/** human(): seconds → "2h 05m" / "45m" */
export function human(s: number): string {
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor((s + 59) / 60)}m`;
}

function hour24(h: string, ampm: string | undefined): number {
  let n = parseInt(h, 10);
  if (ampm) n = (n % 12) + (ampm.toLowerCase() === 'p' ? 12 : 0);
  return n;
}

/** time.mktime((y, mo, d, h, mi, s, 0, 0, -1)): local time, out-of-range fields roll over. */
export function localEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  const dt = new Date(2000, 0, 1, 0, 0, 0, 0);
  dt.setFullYear(y, mo - 1, d);
  dt.setHours(h, mi, s, 0);
  return Math.floor(dt.getTime() / 1000);
}

/** True when text holds a Codex usage-limit message. */
export const hasLimit = (text: string): boolean => LIMIT.test(text);

/** The reset time (epoch seconds) in the LAST "try again" of text, or null. */
export function resetFrom(text: string, base: number): number | null {
  const found: Array<[number, number]> = [];
  for (const m of text.matchAll(new RegExp(AT_DATE_SRC, 'gi'))) {
    const mo = MONTHS[(m[1] as string).toLowerCase().slice(0, 3)];
    if (mo) {
      found.push([m.index, localEpoch(parseInt(m[3] as string, 10), mo, parseInt(m[2] as string, 10), hour24(m[4] as string, m[7]), parseInt(m[5] as string, 10), parseInt(m[6] ?? '0', 10))]);
    }
  }
  for (const m of text.matchAll(new RegExp(AT_TIME_SRC, 'gi'))) {
    const t = new Date(base * 1000);
    const e = localEpoch(t.getFullYear(), t.getMonth() + 1, t.getDate(), hour24(m[1] as string, m[4]), parseInt(m[2] as string, 10), parseInt(m[3] ?? '0', 10));
    found.push([m.index, e <= base ? e + 86400 : e]);
  }
  for (const m of text.matchAll(new RegExp(IN_DUR_SRC, 'gi'))) {
    let secs = 0;
    for (const u of (m[1] as string).matchAll(new RegExp(UNIT_SRC, 'gi'))) secs += parseInt(u[1] as string, 10) * (SECONDS[(u[2] as string).toLowerCase()] as number);
    if (secs) found.push([m.index, base + secs]);
  }
  if (!found.length) return null;
  let best = found[0] as [number, number];
  for (const f of found) if (f[0] > best[0] || (f[0] === best[0] && f[1] > best[1])) best = f;
  return best[1];
}

export type ParseResult = { rc: 0; epoch: number } | { rc: 1 } | { rc: 2 };

/** `parse --base`: rc 0 = found, 1 = a limit message without a readable time, 2 = no limit message at all. */
export function parse(text: string, base: number): ParseResult {
  if (!hasLimit(text)) return { rc: 2 };
  const e = resetFrom(text, base);
  return e === null ? { rc: 1 } : { rc: 0, epoch: e };
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The C library's zone abbreviation (strftime %Z) at epoch; asks `date`, falls back to Intl. */
function zoneName(epoch: number): string {
  for (const args of [['-d', `@${epoch}`, '+%Z'], ['-r', String(epoch), '+%Z']]) {
    try {
      const z = execFileSync('date', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (z) return z;
    } catch {
      /* the other flavour */
    }
  }
  const p = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date(epoch * 1000));
  return p.find((x) => x.type === 'timeZoneName')?.value ?? '';
}

/** `when EPOCH`: local time for messages, e.g. "Sun Oct 11 01:22 EEST". */
export function when(epoch: number): string {
  const d = new Date(epoch * 1000);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${DAYS[d.getDay()]} ${MONS[d.getMonth()]} ${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())} ${zoneName(epoch)}`;
}

function* strings(o: PyJson): Generator<string> {
  if (typeof o === 'string') yield o;
  else if (o instanceof Map) for (const v of o.values()) yield* strings(v);
  else if (Array.isArray(o)) for (const v of o) yield* strings(v);
}

/**
 * The last usage-limit message recorded in one session log, or null. With `since`, a line whose
 * `timestamp` (Codex writes an ISO time on every line) is older than `since` does not count: a log
 * that hit a limit days ago and was written to since by a healthy run must not make every later
 * failure look like a limit. A line without a readable timestamp still counts.
 */
export function limitMessage(file: string, since?: number): string | null {
  let msg: string | null = null;
  let text: string;
  try {
    text = readFileSync(file).toString('utf8');
  } catch {
    return null;
  }
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!line.includes('usage limit')) continue;
    let o: PyJson;
    try {
      o = pyLoads(line);
    } catch (e) {
      if (e instanceof PyJsonError) continue;
      throw e;
    }
    if (since !== undefined && o instanceof Map) {
      const ts = o.get('timestamp');
      const t = typeof ts === 'string' ? Date.parse(ts) : NaN;
      if (!Number.isNaN(t) && t / 1000 < since) continue;
    }
    for (const s of strings(o)) if (LIMIT.test(s)) msg = s;
  }
  return msg;
}

function walk(dir: string, into: string[]): void {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, into);
    else if (e.name.endsWith('.jsonl')) {
      if (e.isSymbolicLink()) {
        try {
          if (statSync(p).isDirectory()) continue; // os.walk lists it as a dir and does not follow it
        } catch {
          continue;
        }
      }
      into.push(p);
    }
  }
}

/** `scan`: the newest session log under <home>/sessions changed since `since` that records a limit → {mtime, message}. */
export function scan(home: string, since: number): { mtime: number; message: string } | null {
  const files: string[] = [];
  walk(path.join(home, 'sessions'), files);
  const logs: Array<[number, string]> = [];
  for (const p of files) {
    try {
      const mt = statSync(p).mtimeMs / 1000;
      if (mt >= since) logs.push([mt, p]);
    } catch {
      /* gone */
    }
  }
  logs.sort((a, b) => (a[0] !== b[0] ? b[0] - a[0] : a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
  for (const [mt, p] of logs) {
    const msg = limitMessage(p, since);
    if (msg) return { mtime: Math.floor(mt), message: msg.split(/\s+/).filter(Boolean).join(' ') };
  }
  return null;
}
