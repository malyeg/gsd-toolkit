// ROADMAP.md bookkeeping — port of lib/roadmap-audit.pl and lib/roadmap-rows.pl.
// Bash/perl callers keep using the perl files until P5/P6; the CLI entries are
// src/commands/roadmap-audit.ts and roadmap-rows.ts.
//
// Perl semantics kept on purpose:
//  - Files are read and written as BYTES (latin1 strings here), so substr(…, 0, 40)
//    counts bytes, and \s / /i are ASCII-only (JS \s also matches U+00A0 etc.,
//    which a UTF-8 non-breaking space would turn into under latin1).
//  - `.` never matches "\n" only (JS `.` also skips "\r"), so `[^\n]` is used.
//  - Lines keep "\r"; only a trailing "\n" is dropped (chomp) or kept (rows).
import { readFileSync, writeFileSync } from 'node:fs';

// Perl's ASCII \s: space \t \n \r \f \v.
const SC = ' \\t\\n\\r\\f\\v';
const S = `[${SC}]`;
const NUM = '(\\d+(?:\\.\\d+)?)';

/** Perl's `<$fh>`: lines, each keeping its "\n" (the last may lack one). */
function readLines(file: string): string[] | null {
  let text: string;
  try {
    text = readFileSync(file, 'latin1');
  } catch {
    return null;
  }
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

// ── roadmap-audit.pl ────────────────────────────────────────────────────────

type Box = { tick: string; own: string | null; text: string };

const ownPhaseRe = new RegExp(`\\*\\*Phase${S}+${NUM}${S}*:`);
const detailRe = new RegExp(`^#{2,4}${S}*Phase${S}+${NUM}${S}*:`);
const boxRe = new RegExp(`^${S}*-${S}*\\[([ x])\\]`);
const tableHeadRe = new RegExp(`^\\|${S}*Phase${S}*\\|`, 'i');
const progressRe = new RegExp(`^\\|${S}*${NUM}[.${SC}]`);
const leadTickRe = new RegExp(`^${S}*-${S}*\\[ \\]${S}*`);

/** own_phase: the bolded number of a checklist row, never one in the prose. */
function ownPhase(line: string): string | null {
  return ownPhaseRe.exec(line)?.[1] ?? null;
}

/** The findings of `perl lib/roadmap-audit.pl <file>` (TICK|p|what, NOROW|p,
 *  NOPROG|p — one per line), as a latin1 byte string. */
export function roadmapAuditBytes(file: string): string {
  if (!file || file === '0') return ''; // `my $path = shift or exit 0`
  const raw = readLines(file);
  if (raw === null) return '';
  const L = raw.map((l) => (l.endsWith('\n') ? l.slice(0, -1) : l)); // chomp
  const detail: string[] = [];
  const rowFor = new Map<string, number>();
  const boxes: Box[] = [];
  const progress = new Set<string>();
  let inTable = false;
  for (let i = 0; i < L.length; i++) {
    const l = L[i] as string;
    const d = detailRe.exec(l);
    if (d) detail.push(d[1] as string);
    const b = boxRe.exec(l);
    if (b) {
      const own = ownPhase(l);
      boxes.push({ tick: b[1] as string, own, text: l });
      if (own !== null && !rowFor.has(own)) rowFor.set(own, i);
    }
    if (tableHeadRe.test(l)) inTable = true;
    if (inTable && !l.startsWith('|')) inTable = false;
    if (inTable) {
      const p = progressRe.exec(l);
      if (p) progress.add(p[1] as string);
    }
  }
  const phases = [...new Set(detail)];
  let out = '';
  for (const p of phases) {
    if (!rowFor.has(p)) out += `NOROW|${p}\n`;
    if (!progress.has(p)) out += `NOPROG|${p}\n`;
    const mine = boxes.find((x) => x.own !== null && x.own === p);
    if (mine && mine.tick === 'x') continue;
    const re = new RegExp(`-${S}*\\[ \\]${S}*[^\\n]*Phase${S}+0*${p.replace(/\./g, '\\.')}[:${SC}]`, 'i');
    const hit = boxes.find((x) => x.tick === ' ' && re.test(x.text));
    if (!hit) continue;
    if (hit.own !== null && hit.own === p) continue;
    let what: string;
    if (hit.own !== null) what = `Phase ${hit.own}'s`;
    else {
      const t = hit.text.replace(leadTickRe, '');
      what = `a non-phase line, "${t.slice(0, 40)}"`;
    }
    out += `TICK|${p}|${what}\n`;
  }
  return out;
}

/** roadmapAuditBytes as an ordinary (UTF-8 decoded) string. */
export function roadmapAudit(file: string): string {
  return Buffer.from(roadmapAuditBytes(file), 'latin1').toString('utf8');
}

// ── roadmap-rows.pl ─────────────────────────────────────────────────────────

/** Perl's split /\./ (trailing empty fields dropped; "" gives no fields). */
function splitDots(s: string): string[] {
  const parts = s.split('.');
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Perl's numeric value of a string (leading number, else 0). */
function perlNum(s: string): number {
  const m = /^[ \t\n\r\f\v]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(s);
  return m ? Number(m[1]) : 0;
}

/** before: numeric order for "7", "7.1", "10", part by part. */
function before(a: string, b: string): boolean {
  const pa = splitDots(a);
  const pb = splitDots(b);
  for (let i = 0; i < 2; i++) {
    const x = pa[i] === undefined ? -1 : perlNum(pa[i] as string);
    const y = pb[i] === undefined ? -1 : perlNum(pb[i] as string);
    if (x !== y) return x < y;
  }
  return false;
}

/** same: the same phase however padded (2 = 02, 2.1 = 02.1, 2 != 2.1). */
const same = (a: string, b: string): boolean => !before(a, b) && !before(b, a);

/** Perl's quotemeta on a byte string. */
const quotemeta = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, '\\$&');

const rowRe = new RegExp(`^(${S}*)-${S}*\\[[ x]\\]${S}*\\*\\*Phase${S}+${NUM}${S}*:`);
const headRe = new RegExp(`^\\|${S}*Phase${S}*\\|`, 'i');
const bodyRe = new RegExp(`^\\|${S}*\\d`);
const rowNumRe = new RegExp(`^\\|${S}*${NUM}`);
const trimRe = new RegExp(`^${S}+|${S}+$`, 'g');

export type RowsResult = { rc: number; stderr: string; changed: boolean };

/** `perl lib/roadmap-rows.pl <file> <phase>`: adds the checklist and Progress
 *  rows for `phase` when absent, writing the file only when it changed.
 *  `phase` undefined = the usage error. Returns what perl would: exit code
 *  (die: errno, else 255) and stderr. */
export function roadmapRows(file: string, phase?: string): RowsResult {
  if (phase === undefined) return { rc: 255, stderr: 'usage: roadmap-rows.pl <ROADMAP.md> <N>\n', changed: false };
  const L = readLines(file);
  if (L === null) return { rc: 2, stderr: `cannot read ${file}\n`, changed: false };
  // n and the title are byte strings, as in perl.
  const n = Buffer.from(phase, 'utf8').toString('latin1');
  const titleRe = new RegExp(`^#{2,4}${S}*Phase${S}+${quotemeta(n)}${S}*:${S}*([^\\n]*?)${S}*$`);
  let title: string | undefined;
  for (const l of L) {
    const m = titleRe.exec(l);
    if (m) {
      title = m[1] as string;
      break;
    }
  }
  if (title === undefined) return { rc: 255, stderr: `no '### Phase ${phase}:' heading in ${file}\n`, changed: false };

  let changed = false;

  // checklist row
  const rows: number[] = [];
  for (let i = 0; i < L.length; i++) if (rowRe.test(L[i] as string)) rows.push(i);
  if (rows.length && !rows.some((i) => same((rowRe.exec(L[i] as string) as RegExpExecArray)[2] as string, n))) {
    const last = rows[rows.length - 1] as number;
    let at = last + 1;
    let indent = (rowRe.exec(L[last] as string) as RegExpExecArray)[1] as string;
    for (const i of rows) {
      const m = rowRe.exec(L[i] as string) as RegExpExecArray;
      if (before(n, m[2] as string)) {
        at = i;
        indent = m[1] as string;
        break;
      }
    }
    L.splice(at, 0, `${indent}- [ ] **Phase ${n}: ${title}**\n`);
    changed = true;
  }

  // Progress table row
  const head = L.findIndex((l) => headRe.test(l));
  if (head >= 0) {
    let end = head + 1;
    while (end <= L.length - 1 && (L[end] as string).startsWith('|')) end++;
    const body: number[] = [];
    for (let i = head + 2; i <= end - 1; i++) if (bodyRe.test(L[i] as string)) body.push(i);
    const present = body.some((i) => same((rowNumRe.exec(L[i] as string) as RegExpExecArray)[1] as string, n));
    if (!present) {
      const cols = (L[head] as string)
        .split('|')
        .map((c) => c.replace(trimRe, ''))
        .filter((c) => c.length);
      const cell = title.replace(/\|/g, '/');
      const cells = [`${n}. ${cell}`];
      for (const c of cols.slice(1)) cells.push(/status/i.test(c) ? 'Not started' : /plan/i.test(c) ? '0/TBD' : '-');
      let at = end;
      for (const i of body) {
        const m = rowNumRe.exec(L[i] as string) as RegExpExecArray;
        if (before(n, m[1] as string)) {
          at = i;
          break;
        }
      }
      L.splice(at, 0, `| ${cells.join(' | ')} |\n`);
      changed = true;
    }
  }

  if (changed) {
    try {
      writeFileSync(file, Buffer.from(L.join(''), 'latin1'));
    } catch {
      return { rc: 2, stderr: `cannot write ${file}\n`, changed: false };
    }
  }
  return { rc: 0, stderr: '', changed };
}
