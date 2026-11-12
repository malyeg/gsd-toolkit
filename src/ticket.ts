// src/ticket.ts — the GSD side of tickets: the tk-<id> tag that links a phase to
// its ticket. Twin of lib/ticket.sh (kept as the parity oracle; tests/ts/p9-ticket.test.ts).
// Talking to the tracker is gsdt-tracker's job; GSD only runs it as a command.
//
// Bash semantics kept on purpose:
//  - every `grep` works per LINE: a multi-line value matches when ANY line does;
//  - `${#id}` counts characters of the current locale (code points here, as in a
//    UTF-8 locale; in the C locale bash counts bytes — such ids fail the regex anyway
//    unless another line of a multi-line value matches);
//  - ticketTagged inserts `id` into the regex raw, like bash. Callers validate ids
//    (ticketNorm) first. An id that is not a valid regex counts as "not tagged"
//    (grep exits 2 on a bad pattern; the callers test only for success).
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const PKG = path.resolve(import.meta.dirname, '..');

/** gsd_tracker_which — none|clickup|custom (or the invalid value as written). Only a SET tracker counts. */
export function trackerWhich(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  let conf: string;
  try {
    conf = execFileSync(path.join(PKG, 'bin', 'gsdt-tracker'), ['--repo', repo, 'config'], {
      env: { ...env, GSD_PKG: PKG },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return 'none';
  }
  const lines = conf.split('\n');
  const first = (prefix: string): string => {
    const l = lines.find((x) => x.startsWith(prefix));
    return l === undefined ? '' : l.slice(prefix.length);
  };
  const t = first('tracker=');
  const from = first('tracker_from=');
  return t === '' || from === 'default' ? 'none' : t;
}

/** gsd_ticket_norm — the bare id, or null when it is not one (bash: nonzero). A multi-line value is returned whole. */
export function ticketNorm(id0: string, as = ''): string | null {
  let id = id0;
  if (id.includes('://')) {
    let i = id.indexOf('?');
    if (i >= 0) id = id.slice(0, i);
    i = id.indexOf('#');
    if (i >= 0) id = id.slice(0, i);
    if (id.endsWith('/')) id = id.slice(0, -1);
    id = id.slice(id.lastIndexOf('/') + 1);
  }
  if (id.startsWith('#')) id = id.slice(1);
  if (/^(tk-|cu_)/i.test(id)) id = id.slice(3);
  if (as === 'clickup' && /^cu-/i.test(id)) id = id.slice(3);
  if ([...id].length > 64) return null;
  if (!id.split('\n').some((l) => /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/.test(l))) return null;
  return id;
}

const lines = (s: string): string[] => s.split('\n');

/** gsd_ticket_extract — the tagged id of a title/branch/dir ('' when none) */
export function ticketExtract(s: string): string {
  for (const l of lines(s)) {
    const m = /(^|[^A-Za-z0-9])[Tt][Kk]-[A-Za-z0-9]+(-[A-Za-z0-9]+)*/.exec(l);
    if (m) return m[0].replace(/^[^A-Za-z0-9]?[Tt][Kk]-/, '');
  }
  for (const l of lines(s)) {
    const m = /(^|[^a-z0-9])cu[-_][a-z0-9]{6,}/i.exec(l);
    if (m) return m[0].replace(/^[^A-Za-z0-9]?[Cc][Uu][-_]/, '');
  }
  for (const l of lines(s)) {
    const m = /clickup[ \t\v\f\r]+[a-z0-9]{6,}/i.exec(l);
    // awk's default fields split on blanks, tabs and newlines only
    if (m) return m[0].split(/[ \t\n]+/)[1] ?? '';
  }
  return '';
}

/** gsd_ticket_tagged — true when s carries tk-<id> (or legacy cu_<id>/cu-<id>), case-insensitively */
export function ticketTagged(s: string, id: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp(`(^|[^A-Za-z0-9])(tk-|cu[-_])${id}([^A-Za-z0-9-]|-pr$|$)`, 'i');
  } catch {
    return false;
  }
  return lines(s).some((l) => re.test(l));
}
