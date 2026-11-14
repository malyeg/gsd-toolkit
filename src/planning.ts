// src/planning.ts — port of lib/gsd_planning.py: reconcile GSD planning files
// after a union-style merge (`reconcile`: one file, structural only; `repair`:
// ROADMAP.md + STATE.md with every derived counter recomputed from disk).
//
// The Python file stays in the tree as the parity oracle
// (tests/ts/p2-planning.test.ts runs both on the same inputs). Rules of the
// design are in its docstring — keyed lines keep the FIRST occurrence's
// position and the BEST occurrence's content; single-value lines keep the LAST
// copy; STATE.md's `## Session Continuity` is never touched.
//
// Python-vs-JS traps handled here (each one is a place a naive port drifts):
//  - text mode read: \r\n and lone \r become \n; `splitlines(keepends=True)`
//    also splits on \v \f \x1c-\x1e \x85 U+2028 U+2029 (`splitLines`).
//  - `re`: `\s` `\d` `\w` `\b` are Unicode (`WS`, `D`, `W` below, `\b` becomes
//    a lookahead because every `\b` here follows a digit or a letter); `.`
//    excludes only "\n"; `$` also matches before one trailing "\n" (`EOL`).
//  - `len()` counts code points (`cpLen`), `round()` is half-to-even
//    (`pyRound`), `max(key=)` keeps the first maximum, strings compare by code
//    point (`cmpStr`), `str.strip()` uses Python's whitespace set (`pyStrip`).
//  - Kept Python quirk: a set difference sorted by `phase_sort_key` is stable
//    only for distinct keys; "02" and "2" tie, and Python's order there is
//    hash-dependent (random per process). Here ties keep insertion order.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

export const CORRUPT = 'corrupt';
export const ADVISORY = 'advisory';
export type Level = typeof CORRUPT | typeof ADVISORY;
export type Problem = [Level, string];
export type Truth = Record<string, number>;

// ── Python-compatible text helpers ──────────────────────────────────────────

// Python's str.isspace() set (what `\s` and str.strip() use).
const WS_CHARS = '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const WS = `[${WS_CHARS}]`;
const NWS = `[^${WS_CHARS}]`;
const D = '\\p{Nd}';
const W = '[\\p{L}\\p{N}_]';
const NB = `(?!${W})`; // Python's \b after a word character
const EOL = '(?=\\n?$)'; // Python's `$` (no re.M): end, or before one final "\n"
const NUM = `${D}+(?:\\.${D}+)?`; // PHASE_NUM
const rx = (src: string): RegExp => new RegExp(src, 'u');

const STRIP_RX = new RegExp(`^${WS}+|${WS}+$`, 'gu');
/** str.strip() */
export const pyStrip = (s: string): string => s.replace(STRIP_RX, '');

/** len(s): code points, not UTF-16 units */
export function cpLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** round(x) for a float: half to even */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** Python string order: by code point (JS compares UTF-16 units). */
export function cmpStr(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = (x[i] as string).codePointAt(0) as number;
    const q = (y[i] as string).codePointAt(0) as number;
    if (p !== q) return p < q ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

const isNd = (ch: string): boolean => /^\p{Nd}$/u.test(ch);
/** int(str of \d characters): Unicode decimal digits count, like Python's int() */
export function digitsToBig(s: string): bigint {
  let out = '';
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') {
      out += ch;
      continue;
    }
    if (ch === '-') {
      out += ch;
      continue;
    }
    // Nd digits come in aligned runs of ten starting at zero
    const cp = ch.codePointAt(0) as number;
    let start = cp;
    while (start > 0 && isNd(String.fromCodePoint(start - 1))) start--;
    out += String((cp - start) % 10);
  }
  return BigInt(out);
}

/** str.splitlines(keepends=True) */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a || c === 0x0b || c === 0x0c || c === 0x1c || c === 0x1d || c === 0x1e || c === 0x85 || c === 0x2028 || c === 0x2029) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (c === 0x0d) {
      const end = text.charCodeAt(i + 1) === 0x0a ? i + 2 : i + 1;
      out.push(text.slice(start, end));
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** str.splitlines() (no terminators) */
const splitLinesPlain = (text: string): string[] =>
  splitLines(text).map((l) => l.replace(/(\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029])$/u, ''));

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Path.read_text(encoding="utf-8"): strict UTF-8, universal newlines. */
export function readText(file: string): string {
  return UTF8.decode(readFileSync(file)).replace(/\r\n?/g, '\n');
}
/** read() in gsd_planning.py */
export const readLines = (file: string): string[] => splitLines(readText(file));

// ── generic helpers ─────────────────────────────────────────────────────────

type Rank = bigint[];
const cmpRank = (a: Rank, b: Rank): number => {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as bigint;
    const y = b[i] as bigint;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

/** phase_sort_key */
export function phaseSortKey(key: string): [bigint, bigint] {
  const i = key.indexOf('.');
  const major = i < 0 ? key : key.slice(0, i);
  const minor = i < 0 ? '' : key.slice(i + 1);
  return [digitsToBig(major), minor ? digitsToBig(minor) : 0n];
}

/** dedupe_keyed */
export function dedupeKeyed(
  lines: string[],
  keyOf: (l: string) => string | null,
  rankOf: (l: string) => Rank,
): [string[], string[]] {
  const best = new Map<string, string>();
  for (const line of lines) {
    const key = keyOf(line);
    if (key === null) continue;
    const cur = best.get(key);
    if (cur === undefined || cmpRank(rankOf(line), rankOf(cur)) > 0) best.set(key, line);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const dropped: string[] = [];
  for (const line of lines) {
    const key = keyOf(line);
    if (key === null) {
      out.push(line);
      continue;
    }
    if (seen.has(key)) {
      dropped.push(key);
      continue;
    }
    seen.add(key);
    out.push(best.get(key) as string);
  }
  return [out, dropped];
}

const ANY_HEADING = rx(`^#{1,6}${WS}`);

/** section_bounds: [start, end) of a section, or null */
export function sectionBounds(lines: string[], headingRx: RegExp, stopRx: RegExp = ANY_HEADING): [number, number] | null {
  for (let i = 0; i < lines.length; i++) {
    if (headingRx.test(lines[i] as string)) {
      for (let j = i + 1; j < lines.length; j++) if (stopRx.test(lines[j] as string)) return [i, j];
      return [i, lines.length];
    }
  }
  return null;
}

/** apply_to_section */
function applyToSection(
  lines: string[],
  bounds: [number, number] | null,
  fn: (block: string[]) => [string[], string[]],
): [string[], string[]] {
  if (bounds === null) return [lines, []];
  const [start, end] = bounds;
  const [nw, dropped] = fn(lines.slice(start, end));
  return [[...lines.slice(0, start), ...nw, ...lines.slice(end)], dropped];
}

/** dedupe_last */
export function dedupeLast(lines: string[], prefixes: readonly string[]): [string[], string[]] {
  const dropped: string[] = [];
  for (const prefix of prefixes) {
    const hits: number[] = [];
    lines.forEach((l, i) => {
      if (l.startsWith(prefix)) hits.push(i);
    });
    if (hits.length <= 1) continue;
    const winner = lines[hits[hits.length - 1] as number] as string;
    const keep = hits[0] as number;
    const drop = new Set(hits.slice(1));
    const next: string[] = [];
    lines.forEach((l, i) => {
      if (drop.has(i)) return;
      next.push(i === keep ? winner : l);
    });
    lines = next;
    for (let k = 0; k < hits.length - 1; k++) dropped.push(prefix);
  }
  return [lines, dropped];
}

// ── ROADMAP.md ──────────────────────────────────────────────────────────────

const CHECKLIST_RX = rx(`^- \\[([ xX])\\] \\*\\*Phase (${NUM})${NB}`);
const DETAIL_RX = rx(`^### Phase (${NUM})${NB}`);
const TABLE_ROW_RX = rx(`^\\|${WS}*(${NUM})${WS}*\\.?${WS}+${NWS}`);
const STATUS_RANK: [string, number][] = [
  ['not started', 0],
  ['blocked', 1],
  ['in progress', 2],
  ['complete', 3],
];
const PROGRESS_HEAD_RX = rx(`^## Progress${NB}`);
const POSITION_HEAD_RX = rx(`^## Current Position${NB}`);
const METRICS_HEAD_RX = rx(`^## Performance Metrics${NB}`);
const DETAIL_STOP_RX = rx(`^#{1,3}${WS}`);

const checklistKey = (line: string): string | null => CHECKLIST_RX.exec(line)?.[2] ?? null;
const tableKey = (line: string): string | null => TABLE_ROW_RX.exec(line)?.[1] ?? null;

/** "a | b | c" → trimmed cells, the way the Python splits them */
function cellsOf(line: string): string[] {
  return pyStrip(pyStrip(line).replace(/^\|+|\|+$/g, '')).split('|').map(pyStrip);
}
const LEAD_DIGITS_RX = rx(`^(${D}+)`);
const leadDigits = (s: string): bigint => {
  const m = LEAD_DIGITS_RX.exec(s);
  return m ? digitsToBig(m[1] as string) : 0n;
};

function checklistRank(line: string): Rank {
  const mark = ((CHECKLIST_RX.exec(line) as RegExpExecArray)[1] as string).toLowerCase();
  return [mark === 'x' ? 1n : 0n, BigInt(cpLen(line))];
}

function tableRowRank(line: string): Rank {
  const cells = cellsOf(line);
  const plans = cells.length > 1 ? (cells[1] as string) : '';
  const status = (cells.length > 2 ? (cells[2] as string) : '').toLowerCase();
  let rank = status !== '' && status !== '-' ? 1 : 0;
  for (const [name, value] of STATUS_RANK) {
    if (status.startsWith(name)) {
      rank = value;
      break;
    }
  }
  return [BigInt(rank), leadDigits(plans), BigInt(cpLen(line))];
}

/** dedupe_detail_sections */
export function dedupeDetailSections(lines: string[]): [string[], string[]] {
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (DETAIL_RX.test(l)) starts.push(i);
  });
  if (starts.length === 0) return [lines, []];

  const blocks: { key: string; start: number; end: number }[] = [];
  for (const start of starts) {
    let end = lines.length;
    for (let j = start + 1; j < lines.length; j++) {
      if (DETAIL_STOP_RX.test(lines[j] as string)) {
        end = j;
        break;
      }
    }
    blocks.push({ key: (DETAIL_RX.exec(lines[start] as string) as RegExpExecArray)[1] as string, start, end });
  }

  const best = new Map<string, { len: number; lines: string[] }>();
  for (const { key, start, end } of blocks) {
    const part = lines.slice(start, end);
    const len = cpLen(part.join(''));
    const cur = best.get(key);
    if (cur === undefined || len > cur.len) best.set(key, { len, lines: part });
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const dropped: string[] = [];
  const span = new Map(blocks.map((b) => [b.start, b] as const));
  let i = 0;
  while (i < lines.length) {
    const b = span.get(i);
    if (b !== undefined) {
      if (seen.has(b.key)) dropped.push(b.key);
      else {
        seen.add(b.key);
        out.push(...(best.get(b.key) as { lines: string[] }).lines);
      }
      i = b.end;
      continue;
    }
    out.push(lines[i] as string);
    i++;
  }
  return [out, dropped];
}

/** reconcile_roadmap */
export function reconcileRoadmap(lines: string[]): [string[], Problem[]] {
  const problems: Problem[] = [];
  let dropped: string[];

  [lines, dropped] = dedupeKeyed(lines, checklistKey, checklistRank);
  for (const key of dropped) problems.push([CORRUPT, `ROADMAP.md: duplicate checklist entry for Phase ${key}`]);

  const progress = sectionBounds(lines, PROGRESS_HEAD_RX);
  [lines, dropped] = applyToSection(lines, progress, (block) => dedupeKeyed(block, tableKey, tableRowRank));
  for (const key of dropped) problems.push([CORRUPT, `ROADMAP.md: duplicate progress-table row for Phase ${key}`]);

  [lines, dropped] = dedupeDetailSections(lines);
  for (const key of dropped) problems.push([CORRUPT, `ROADMAP.md: duplicate '### Phase ${key}' detail section`]);

  problems.push(...detectTableGaps(lines));
  return [lines, problems];
}

/** detect_table_gaps */
export function detectTableGaps(lines: string[]): Problem[] {
  const listed: string[] = [];
  for (const l of lines) {
    const k = checklistKey(l);
    if (k !== null && !listed.includes(k)) listed.push(k);
  }
  const progress = sectionBounds(lines, PROGRESS_HEAD_RX);
  if (progress === null || listed.length === 0) return [];
  const tabled = new Set<string>();
  for (const l of lines.slice(progress[0], progress[1])) {
    const k = tableKey(l);
    if (k !== null) tabled.add(k);
  }
  const missing = listed.filter((k) => !tabled.has(k));
  missing.sort((a, b) => {
    const [a1, a2] = phaseSortKey(a);
    const [b1, b2] = phaseSortKey(b);
    return a1 !== b1 ? (a1 < b1 ? -1 : 1) : a2 !== b2 ? (a2 < b2 ? -1 : 1) : 0;
  });
  return missing.map((key): Problem => [ADVISORY, `ROADMAP.md: Phase ${key} is in the checklist but has no ## Progress row`]);
}

// ── STATE.md frontmatter ────────────────────────────────────────────────────

const IDENT = '[A-Za-z_][\\p{L}\\p{N}_\\-]*';
const FM_TOP_RX = rx(`^(${IDENT}):${WS}*([^\\n]*)${EOL}`);
const FM_SUB_RX = rx(`^(${WS}+)(${IDENT}):${WS}*([^\\n]*)${EOL}`);

/** unquote */
export function unquote(value: string): string {
  value = pyStrip(value);
  const a = Array.from(value);
  if (a.length >= 2 && a[0] === a[a.length - 1] && (a[0] === '"' || a[0] === "'")) return a.slice(1, -1).join('');
  return value;
}

const INT_RX = rx(`^-?${D}+`);
/** as_int */
export function asInt(value: string): bigint {
  const m = INT_RX.exec(unquote(value));
  return m ? digitsToBig(m[0]) : -1n;
}

/** split_frontmatter: [start, end) of the body, or null */
export function splitFrontmatter(lines: string[]): [number, number] | null {
  if (lines.length === 0 || pyStrip(lines[0] as string) !== '---') return null;
  for (let i = 1; i < lines.length; i++) if (pyStrip(lines[i] as string) === '---') return [1, i];
  return null;
}

/** parse_frontmatter */
export function parseFrontmatter(body: string[]): [string[], Map<string, string[]>] {
  const order: string[] = [];
  const values = new Map<string, string[]>();
  const record = (p: string, v: string): void => {
    let cur = values.get(p);
    if (cur === undefined) {
      order.push(p);
      cur = [];
      values.set(p, cur);
    }
    cur.push(v);
  };
  let parent: string | null = null;
  for (const line of body) {
    if (pyStrip(line) === '') continue;
    const sub = FM_SUB_RX.exec(line);
    if (sub && parent) {
      record(`${parent}.${sub[2]}`, sub[3] as string);
      continue;
    }
    const top = FM_TOP_RX.exec(line);
    if (!top) continue;
    const key = top[1] as string;
    const value = top[2] as string;
    if (pyStrip(value) === '') {
      parent = key;
      record(key, '');
    } else {
      parent = null;
      record(key, value);
    }
  }
  return [order, values];
}

/** `max(seq, key=key)` — the first maximum wins */
function maxBy<T>(seq: T[], cmp: (a: T, b: T) => number): T {
  let best = seq[0] as T;
  for (const v of seq.slice(1)) if (cmp(v, best) > 0) best = v;
  return best;
}
const cmpBig = (a: bigint, b: bigint): number => (a === b ? 0 : a < b ? -1 : 1);

/** resolve_frontmatter */
export function resolveFrontmatter(
  order: string[],
  values: Map<string, string[]>,
  truth: Truth | null = null,
): [Map<string, string>, Problem[]] {
  const resolved = new Map<string, string>();
  const problems: Problem[] = [];
  for (const path of order) {
    const seen = values.get(path) as string[];
    const distinct = new Set(seen.map(unquote));
    if (
      truth &&
      (path === 'progress.total_plans' || path === 'progress.completed_plans') &&
      truth[path] === 0 &&
      seen.some((v) => asInt(v) > 0n)
    ) {
      const kept = maxBy(seen, (a, b) => cmpBig(asInt(a), asInt(b)));
      resolved.set(path, kept);
      problems.push([
        ADVISORY,
        `STATE.md: ${path} left at ${unquote(kept)} — no plan files found ` +
          `under .planning/phases/*/, so the recomputed 0 is not believable`,
      ]);
      continue;
    }
    if (truth && path in truth) {
      const want = String(truth[path]);
      resolved.set(path, want);
      if (!(distinct.size === 1 && distinct.has(want))) {
        problems.push([
          distinct.size > 1 ? CORRUPT : ADVISORY,
          `STATE.md: ${path} recomputed to ${truth[path]} (file had ${seen.map(unquote).join(', ')})`,
        ]);
      }
      continue;
    }
    if (distinct.size === 1) {
      resolved.set(path, seen[0] as string);
      continue;
    }
    problems.push([
      CORRUPT,
      `STATE.md: conflicting '${path}' in frontmatter (${seen.length} values: ${seen.map(unquote).join(', ')})`,
    ]);
    if (path === 'last_updated') resolved.set(path, maxBy(seen, (a, b) => cmpStr(unquote(a), unquote(b))));
    else if (path.startsWith('progress.')) resolved.set(path, maxBy(seen, (a, b) => cmpBig(asInt(a), asInt(b))));
    else resolved.set(path, seen[seen.length - 1] as string);
  }
  return [resolved, problems];
}

/** emit_frontmatter */
export function emitFrontmatter(body: string[], resolved: Map<string, string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let parent: string | null = null;
  for (const line of body) {
    let path: string | null = null;
    let indent = '';
    let key = '';
    const sub = FM_SUB_RX.exec(line);
    const top = FM_TOP_RX.exec(line);
    if (sub && parent) {
      path = `${parent}.${sub[2]}`;
      indent = sub[1] as string;
      key = sub[2] as string;
    } else if (top) {
      key = top[1] as string;
      path = key;
      indent = '';
      parent = pyStrip(top[2] as string) === '' ? key : null;
    }
    if (path === null) {
      out.push(line);
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    const value = resolved.get(path) ?? '';
    out.push(pyStrip(value) === '' ? `${indent}${key}:\n` : `${indent}${key}: ${value}\n`);
  }
  return out;
}

// ── STATE.md body ───────────────────────────────────────────────────────────

const POSITION_KEYS = ['Phase:', 'Plan:', 'Worktree:', 'Status:', 'Last activity:', 'Progress:'] as const;
const VELOCITY_KEYS = [
  '- Total plans completed:',
  '- Average duration:',
  '- Total execution time:',
  '- Last 5 plans:',
  '- Trend:',
] as const;
const BY_PHASE_ROW_RX = rx(`^\\|${WS}*(${NUM})${WS}*\\|${WS}*[${D}/]+${WS}*\\|`);
const byPhaseKey = (line: string): string | null => BY_PHASE_ROW_RX.exec(line)?.[1] ?? null;

function byPhaseRank(line: string): Rank {
  const cells = cellsOf(line);
  return [leadDigits(cells.length > 1 ? (cells[1] as string) : ''), BigInt(cpLen(line))];
}

/** reconcile_state_body */
export function reconcileStateBody(lines: string[], truth: Truth | null = null): [string[], Problem[]] {
  const problems: Problem[] = [];
  let dropped: string[];

  [lines, dropped] = dedupeLast(lines, ['**Current focus:**']);
  for (let i = 0; i < dropped.length; i++) problems.push([CORRUPT, "STATE.md: duplicate '**Current focus:**' line"]);

  const position = sectionBounds(lines, POSITION_HEAD_RX);
  [lines, dropped] = applyToSection(lines, position, (block) => dedupeLast(block, POSITION_KEYS));
  for (const key of dropped) problems.push([CORRUPT, `STATE.md: duplicate '${key}' in ## Current Position`]);

  let metrics = sectionBounds(lines, METRICS_HEAD_RX);
  [lines, dropped] = applyToSection(lines, metrics, (block) => dedupeLast(block, VELOCITY_KEYS));
  for (const key of dropped) problems.push([CORRUPT, `STATE.md: duplicate '${pyStrip(key)}' in the velocity block`]);

  metrics = sectionBounds(lines, METRICS_HEAD_RX);
  [lines, dropped] = applyToSection(lines, metrics, (block) => dedupeKeyed(block, byPhaseKey, byPhaseRank));
  for (const key of dropped) problems.push([CORRUPT, `STATE.md: duplicate by-phase row for Phase ${key}`]);

  if (truth) {
    const [nl, fixed] = recomputeStateBody([...lines], truth);
    lines = nl;
    problems.push(...fixed);
  }

  problems.push(...detectOrphanRows(lines));
  return [lines, problems];
}

const PROGRESS_RX = rx(`^Progress: \\[[^\\]]*\\]${WS}*${D}+%([^\\n]*)${EOL}`);
const COUNT_RX = rx(`^${WS}*\\(${D}+ of ${D}+ phases complete\\)${WS}*$`);

/** recompute_state_body (mutates and returns `lines`) */
export function recomputeStateBody(lines: string[], truth: Truth): [string[], Problem[]] {
  const problems: Problem[] = [];
  const done = truth['progress.completed_phases'] as number;
  const total = truth['progress.total_phases'] as number;
  const percent = truth['progress.percent'] as number;
  const filled = pyRound(percent / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const count = ` (${done} of ${total} phases complete)`;

  const position = sectionBounds(lines, POSITION_HEAD_RX);
  if (position) {
    const [start, end] = position;
    for (let i = start; i < end; i++) {
      if ((lines[i] as string).startsWith('Progress:')) {
        const m = PROGRESS_RX.exec((lines[i] as string).replace(/\n+$/, ''));
        let rest = m ? (m[1] as string) : count;
        if (COUNT_RX.test(rest)) rest = count;
        const want = `Progress: [${bar}] ${percent}%${rest}\n`;
        if (lines[i] !== want) {
          problems.push([ADVISORY, `STATE.md: progress bar recomputed to ${percent}% (was ${pyStrip(lines[i] as string)})`]);
          lines[i] = want;
        }
        break;
      }
    }
  }

  if (!('progress.completed_plans' in truth)) return [lines, problems];
  const completed = truth['progress.completed_plans'] as number;
  const wantTotal = `- Total plans completed: ${completed}\n`;
  const metrics = sectionBounds(lines, METRICS_HEAD_RX);
  if (metrics) {
    const [start, end] = metrics;
    for (let i = start; i < end; i++) {
      const l = lines[i] as string;
      if (l.startsWith('- Total plans completed:')) {
        if (completed === 0 && asInt(l.slice(l.indexOf(':') + 1)) > 0n) break;
        if (l !== wantTotal) {
          problems.push([ADVISORY, `STATE.md: velocity total recomputed to ${completed} (was ${pyStrip(l)})`]);
          lines[i] = wantTotal;
        }
        break;
      }
    }
  }
  return [lines, problems];
}

/** detect_orphan_rows */
export function detectOrphanRows(lines: string[]): Problem[] {
  const problems: Problem[] = [];
  lines.forEach((line, i) => {
    if (!line.startsWith('|')) return;
    const prev = i > 0 ? (lines[i - 1] as string) : '';
    const nxt = i + 1 < lines.length ? (lines[i + 1] as string) : '';
    if (!prev.startsWith('|') && !nxt.startsWith('|')) {
      problems.push([
        ADVISORY,
        `STATE.md:${i + 1}: table row outside any table — move it into the table it belongs to by hand: ${Array.from(pyStrip(line)).slice(0, 60).join('')}`,
      ]);
    }
  });
  return problems;
}

/** reconcile_state */
export function reconcileState(lines: string[], truth: Truth | null = null): [string[], Problem[]] {
  const bounds = splitFrontmatter(lines);
  const problems: Problem[] = [];
  if (bounds) {
    const [start, end] = bounds;
    const [order, values] = parseFrontmatter(lines.slice(start, end));
    const [resolved, fm] = resolveFrontmatter(order, values, truth);
    problems.push(...fm);
    lines = [...lines.slice(0, start), ...emitFrontmatter(lines.slice(start, end), resolved), ...lines.slice(end)];
  }
  const [nl, body] = reconcileStateBody(lines, truth);
  problems.push(...body);
  return [nl, problems];
}

// ── ground truth ────────────────────────────────────────────────────────────

const isDirectory = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** count entries matching pathlib's `phases/*\/*<suffix>` (hidden names included) */
function globCount(phasesDir: string, suffix: string): number {
  let n = 0;
  let subs: string[];
  try {
    subs = readdirSync(phasesDir);
  } catch {
    return 0;
  }
  for (const sub of subs) {
    const dir = `${phasesDir}/${sub}`;
    if (!isDirectory(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) if (name.endsWith(suffix)) n++;
  }
  return n;
}

/** compute_truth: counters from the roadmap and the files on disk (null = no ROADMAP.md) */
export function computeTruth(planning: string): Truth | null {
  const roadmap = `${planning}/ROADMAP.md`;
  if (!existsSync(roadmap)) return null;
  const phases = new Set<string>();
  const complete = new Set<string>();
  for (const line of splitLinesPlain(readText(roadmap))) {
    const detail = DETAIL_RX.exec(line);
    if (detail) phases.add(detail[1] as string);
    const entry = CHECKLIST_RX.exec(line);
    if (entry) {
      phases.add(entry[2] as string);
      if ((entry[1] as string).toLowerCase() === 'x') complete.add(entry[2] as string);
    }
  }
  const total = phases.size;
  const truth: Truth = {
    'progress.total_phases': total,
    'progress.completed_phases': complete.size,
    'progress.percent': total ? pyRound((complete.size / total) * 100) : 0,
  };
  const phasesDir = `${planning}/phases`;
  if (isDirectory(phasesDir)) {
    truth['progress.total_plans'] = globCount(phasesDir, '-PLAN.md');
    truth['progress.completed_plans'] = globCount(phasesDir, '-SUMMARY.md');
  }
  return truth;
}

// ── entry points ────────────────────────────────────────────────────────────

/** pathlib.PurePosixPath(s) as a string: collapse "//" and "/./" and a trailing "/" */
export function pyPath(s: string): string {
  if (s === '') return '.';
  const lead = s.startsWith('//') && !s.startsWith('///') ? '//' : s.startsWith('/') ? '/' : '';
  const parts = s.split('/').filter((p) => p !== '' && p !== '.');
  const joined = parts.join('/');
  return lead + joined || (lead === '' ? '.' : lead);
}
/** PurePosixPath(s).name */
export function pyName(s: string): string {
  const parts = pyPath(s).split('/').filter((p) => p !== '');
  const last = parts[parts.length - 1] ?? '';
  return last === '.' ? '' : last;
}

/** kind_of */
export function kindOf(file: string, hint?: string | null): 'roadmap' | 'state' | null {
  const raw = hint ? hint : pyName(file);
  const name = raw.slice(raw.lastIndexOf('/') + 1);
  if (name === 'ROADMAP.md') return 'roadmap';
  if (name === 'STATE.md') return 'state';
  return null;
}

const sameLines = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** process */
export function processFile(file: string, kind: 'roadmap' | 'state', truth: Truth | null = null): [string[], Problem[]] {
  const lines = readLines(file);
  return kind === 'roadmap' ? reconcileRoadmap(lines) : reconcileState(lines, truth);
}

export type Out = { out: string; err: string; rc: number };

/** cmd_reconcile: one file, in place, structural only. */
export function reconcileFile(file: string, hint?: string | null): Out {
  const f = pyPath(file);
  const kind = kindOf(f, hint);
  if (kind === null) return { out: '', err: '', rc: 0 };
  const before = readLines(f);
  const [after, problems] = processFile(f, kind);
  if (!sameLines(after, before)) writeFileSync(f, after.join(''), 'utf8');
  let err = '';
  for (const [level, message] of problems) if (level === CORRUPT) err += `  reconciled — ${message}\n`;
  return { out: '', err, rc: 0 };
}

/** cmd_repair: both files + counters; `check` writes nothing and rc 1 on merge damage. */
export function repairDir(planningArg: string, check: boolean): Out {
  const planning = pyPath(planningArg);
  const truth = computeTruth(planning);
  if (truth === null) return { out: '', err: `✖ ${planning}/ROADMAP.md not found\n`, rc: 2 };

  const all: Problem[] = [];
  const changed: string[] = [];
  for (const [name, kind] of [
    ['ROADMAP.md', 'roadmap'],
    ['STATE.md', 'state'],
  ] as const) {
    const file = `${planning}/${name}`;
    if (!existsSync(file)) continue;
    const before = readLines(file);
    const [after, problems] = kind === 'roadmap' ? reconcileRoadmap(before) : reconcileState(before, truth);
    const differs = !sameLines(after, before);
    if (differs && !check) writeFileSync(file, after.join(''), 'utf8');
    if (differs) changed.push(name);
    all.push(...problems);
  }

  const corrupt = all.filter(([l]) => l === CORRUPT).map(([, m]) => m);
  const advisory = all.filter(([l]) => l === ADVISORY).map(([, m]) => m);
  if (all.length === 0) return { out: '✔ .planning/ is consistent\n', err: '', rc: 0 };

  let out = '';
  if (corrupt.length) {
    const verb = check ? 'union-merge damage found' : 'repaired union-merge damage';
    out += `${check ? '✖' : '▶'} ${verb} in ${changed.length ? changed.join(', ') : '.planning/'}:\n`;
    for (const m of corrupt) out += `  • ${m}\n`;
  }
  if (advisory.length) {
    out += '• advisories (not merge damage — reported, never fail a check):\n';
    for (const m of advisory) out += `  - ${m}\n`;
  }
  if (check && changed.length && !corrupt.length) out += `• a repair would update: ${changed.join(', ')}\n`;
  return { out, err: '', rc: check && corrupt.length ? 1 : 0 };
}
