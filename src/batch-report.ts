// gsdt-batch-report engine (port of lib/gsd_batch_report.py, kept as the parity
// oracle in tests/fixtures/p10-old-bins/). Reads Claude Code transcripts only;
// writes nothing, calls nothing.
//
// A BATCH starts where the main session invokes /gsd-quick-batch or /gsdt-batch
// (a Skill tool call, or a typed slash command) and ends at the first of: the
// next batch start (a /gsd-quick-batch run BY an open /gsdt-batch is part of
// it) or /clear; a done line ("gsdt-batch: done items=N real=N tiny=N" or
// "GSD ► QUICK BATCH COMPLETE"); the next prompt the user types once the batch
// is SETTLED (its run has started, no helper it spawned is still working, every
// item a planner took has an executor); the end of the session file.
// Helpers link to their Agent call by meta toolUseId, else the call's result
// agentId. Usage is counted once per message.id, tool calls once per tool_use
// id. Transcript text is untrusted: matched and counted, never printed.
//
// Python quirks kept: half-to-even round and "%.1f", code-point len/slices,
// Unicode \s \w \b, `$` matching before a trailing newline, bool counting as
// an int, int vs float told apart in the JSON (PyFloat), json.dumps(indent=1,
// ensure_ascii) spelling.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { cmpStr, pyRound } from './planning.ts';

// ── Python-isms ─────────────────────────────────────────────────────────────

/** a JSON number written with . or e (python float) */
export class PyFloat {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
}

type Obj = Record<string, unknown>;
const isDict = (v: unknown): v is Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof PyFloat);
/** python truthiness of a parsed JSON value */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0;
  if (v instanceof PyFloat) return v.v !== 0;
  if (typeof v === 'string') return v !== '';
  if (Array.isArray(v)) return v.length > 0;
  return Object.keys(v as object).length > 0;
}
const isStr = (v: unknown): v is string => typeof v === 'string';
/** isinstance(v, int) (bool counts) */
const isInt = (v: unknown): boolean => typeof v === 'number' || typeof v === 'boolean';
const intVal = (v: unknown): number => (v === true ? 1 : v === false ? 0 : (v as number));

const PYWS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PYWS_START = new RegExp(`^[${PYWS}]+`);
const PYWS_END = new RegExp(`[${PYWS}]+$`);
const pyLstrip = (s: string): string => s.replace(PYWS_START, '');
const pyStrip = (s: string): string => pyLstrip(s).replace(PYWS_END, '');
const W = '[\\p{L}\\p{N}_]';
const cpLen = (s: string): number => Array.from(s).length;
const cpSlice = (s: string, a: number, b?: number): string => Array.from(s).slice(a, b).join('');
const padL = (s: string, n: number): string => ' '.repeat(Math.max(0, n - cpLen(s))) + s;
const padR = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - cpLen(s)));

/** "%.<d>f" % x for x >= 0, d >= 1 — exact decimal rounding, ties to even (toFixed rounds ties up) */
export function pyFixed(x: number, d: number): string {
  const long = x.toFixed(d + 25);
  const cut = long.indexOf('.') + 1 + d;
  if (/^50*$/.test(long.slice(cut))) {
    const head = long.slice(0, cut);
    if (Number(head[head.length - 1]) % 2 === 0) return head;
  }
  return x.toFixed(d);
}
/** Python float repr for the values this tool prints */
function floatText(x: number): string {
  const s = String(x);
  return Number.isInteger(x) && !s.includes('e') ? `${s}.0` : s;
}

// ── transcripts ─────────────────────────────────────────────────────────────

const BATCH_SKILLS = ['gsd-quick-batch', 'gsdt-batch'];
const RUN_SKILLS = ['gsd-quick-batch', 'gsd-quick', 'gsd-fast'];
const RUN_AGENTS = ['gsd-planner', 'gsd-executor'];
const CMD_RE = new RegExp(`<command-name>[${PYWS}]*/?([A-Za-z0-9:_-]+)[${PYWS}]*</command-name>`, 'u');
const DONE_RE = new RegExp(`(?<=^|\\n)${'[^\\p{L}\\p{N}_]'}*gsdt-batch: done(?!${W})([^\\n]*)`, 'u');
const QB_DONE_RE = new RegExp(`GSD[${PYWS}]*[^${PYWS}]?[${PYWS}]*QUICK BATCH COMPLETE`, 'u');
const KV_RE = new RegExp(`(?<!${W})(items|real|tiny)=([0-9]+)(?!${W})`, 'gu');
const QUICK_ID_RE = new RegExp(`(?<!${W})([0-9]{6}-[a-z0-9]{3,4})(?!${W})`, 'gu');
const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,40}\n?$/;
const NOT_HUMAN = [
  '<task-notification>',
  '<local-command-stdout>',
  '<local-command-caveat>',
  '<local-command-stderr>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
];

/** The week before 2026-11-09 (docs/plan-gsdt-batch.md). Input is ONE summed number. */
const BASELINE = {
  items: 50,
  batches: 8,
  roles: {
    'gsd-planner': { model: 'opus', agents: 50, input: 299e6, output: 2.5e6 },
    'gsd-executor': { model: 'sonnet', agents: 50, input: 183e6, output: 1.2e6 },
    coordinator: { model: 'opus', agents: 0, turns: 914, input: 151e6, output: 0.5e6 },
    'general-purpose': { model: 'sonnet', agents: 5, input: 52e6, output: 0.15e6 },
  } as Record<string, Obj>,
};

function family(model: unknown): string | null {
  if (!isStr(model) || model === '' || model === '<synthetic>') return null;
  const m = model.toLowerCase();
  for (const f of ['opus', 'sonnet', 'haiku', 'fable']) if (m.includes(f)) return f;
  return 'other';
}
function safe(name: unknown, dflt = 'other'): string {
  return isStr(name) && SAFE_NAME.test(name) ? name : dflt;
}
function skillName(s: unknown): string {
  if (!isStr(s)) return '';
  const parts = pyStrip(s).replace(/^\/+/, '').split(':');
  return parts[parts.length - 1] as string;
}

/** json.loads for one line; floats stay marked */
function parseJson(text: string): unknown {
  return (JSON.parse as (t: string, r: (k: string, v: unknown, c: { source?: string }) => unknown) => unknown)(
    text,
    (_k, v, c) => (typeof v === 'number' && c?.source !== undefined && /[.eE]/.test(c.source) ? new PyFloat(v) : v),
  );
}

function readJsonl(file: string): Obj[] {
  const out: Obj[] = [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r\n|\r|\n/)) {
    let o: unknown;
    try {
      o = parseJson(line);
    } catch {
      continue;
    }
    if (isDict(o)) out.push(o);
  }
  return out;
}

function blocks(o: Obj): Obj[] {
  const m = o.message;
  if (!isDict(m)) return [];
  return Array.isArray(m.content) ? m.content.filter(isDict) : [];
}
function textOf(o: Obj): string {
  const m = o.message;
  if (!isDict(m)) return '';
  const c = m.content;
  if (isStr(c)) return c;
  return blocks(o)
    .filter((b) => b.type === 'text' && isStr(b.text))
    .map((b) => b.text as string)
    .join('\n');
}
/** a prompt the user typed (slash commands included) */
function isHuman(o: Obj): boolean {
  if (o.type !== 'user' || truthy(o.isMeta) || truthy(o.isCompactSummary) || truthy(o.isSidechain)) return false;
  if (o.toolUseResult !== undefined && o.toolUseResult !== null) return false;
  const origin = o.origin;
  if (isDict(origin) && truthy(origin.kind) && origin.kind !== 'human') return false;
  if (blocks(o).some((b) => b.type === 'tool_result')) return false;
  const t = pyLstrip(textOf(o));
  return t !== '' && !NOT_HUMAN.some((p) => t.startsWith(p));
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:.(\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?)?(?:([+-])(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?)?$/s;
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
/** datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp(), null where python raises */
function tsEpoch(o: Obj): number | null {
  const t = o.timestamp;
  if (!isStr(t)) return null;
  const m = ISO_RE.exec(t.replaceAll('Z', '+00:00'));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hh = m[4] === undefined ? 0 : Number(m[4]);
  const mi = m[5] === undefined ? 0 : Number(m[5]);
  const ss = m[6] === undefined ? 0 : Number(m[6]);
  const micro = m[7] === undefined ? 0 : Number(`${m[7]}000000`.slice(0, 6));
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || hh > 23 || mi > 59 || ss > 59) return null;
  const dim = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (d > (dim[mo - 1] as number)) return null;
  if (m[8] === undefined) {
    // naive: local time (mktime), then + microseconds
    const dt = new Date(2000, 0, 1, hh, mi, ss);
    dt.setFullYear(y, mo - 1, d);
    return dt.getTime() / 1000 + micro / 1e6;
  }
  const oh = Number(m[9]);
  const om = m[10] === undefined ? 0 : Number(m[10]);
  const os = m[11] === undefined ? 0 : Number(m[11]);
  if (oh > 23 || om > 59 || os > 59) return null;
  const off = (oh * 3600 + om * 60 + os) * (m[8] === '-' ? -1 : 1);
  const secs = daysFromCivil(y, mo, d) * 86400 + hh * 3600 + mi * 60 + ss - off;
  return (secs * 1e6 + micro) / 1e6;
}

export class Tally {
  agents = 0;
  turns = 0;
  bash = 0;
  fresh = 0;
  cacheWrite = 0;
  cacheWrite1h = 0;
  cacheRead = 0;
  output = 0;
  add(o: Tally): void {
    this.agents += o.agents;
    this.turns += o.turns;
    this.bash += o.bash;
    this.fresh += o.fresh;
    this.cacheWrite += o.cacheWrite;
    this.cacheWrite1h += o.cacheWrite1h;
    this.cacheRead += o.cacheRead;
    this.output += o.output;
  }
  get input(): number {
    return this.fresh + this.cacheWrite + this.cacheRead;
  }
  get weighted(): number {
    const w5 = this.cacheWrite - this.cacheWrite1h;
    return this.fresh + 1.25 * w5 + 2.0 * this.cacheWrite1h + 0.1 * this.cacheRead;
  }
}

function countLines(lines: Obj[], seenMsg: Set<string>, seenTool: Set<string>): { t: Tally; model: string | null; uses: Obj[] } {
  const t = new Tally();
  let model: string | null = null;
  const uses: Obj[] = [];
  for (const o of lines) {
    if (o.type !== 'assistant') continue;
    const m = o.message;
    if (!isDict(m)) continue;
    model = model || family(m.model);
    for (const b of blocks(o)) {
      if (b.type !== 'tool_use') continue;
      const tid = b.id;
      if (!isStr(tid) || seenTool.has(tid)) continue;
      seenTool.add(tid);
      uses.push(b);
      if (b.name === 'Bash') t.bash += 1;
    }
    const mid = m.id;
    const u = m.usage;
    if (!isStr(mid) || seenMsg.has(mid) || !isDict(u)) continue;
    seenMsg.add(mid);
    t.turns += 1;
    const num = (k: string, d: Obj = u): number => {
      const v = d[k];
      return isInt(v) && intVal(v) > 0 ? intVal(v) : 0;
    };
    t.fresh += num('input_tokens');
    t.cacheWrite += num('cache_creation_input_tokens');
    const cc = u.cache_creation;
    if (isDict(cc)) t.cacheWrite1h += Math.min(num('ephemeral_1h_input_tokens', cc), num('cache_creation_input_tokens'));
    t.cacheRead += num('cache_read_input_tokens');
    t.output += num('output_tokens');
  }
  return { t, model, uses };
}

function readStrict(file: string): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
}

class Session {
  path: string;
  id: string;
  lines: Obj[];
  subDir: string;
  metas = new Map<string, string>(); // toolUseId → agent id
  metaOf = new Map<string, Obj>(); // agent id → meta
  resultAgent = new Map<string, string>(); // tool_use id → agent id
  agentCache = new Map<string, Obj[]>();
  lastCache = new Map<string, number | null>();
  constructor(file: string) {
    this.path = file;
    this.id = path.basename(file).slice(0, -'.jsonl'.length);
    this.lines = readJsonl(file);
    this.subDir = path.join(path.dirname(file), this.id, 'subagents');
    this.noteResults(this.lines);
    let names: string[] = [];
    try {
      names = readdirSync(this.subDir).filter((n) => n.startsWith('agent-') && n.endsWith('.meta.json')).sort();
    } catch {
      /* none */
    }
    for (const n of names) {
      const aid = n.slice('agent-'.length, -'.meta.json'.length);
      let meta: unknown;
      try {
        meta = parseJson(readStrict(path.join(this.subDir, n)));
      } catch {
        continue;
      }
      if (!isDict(meta)) continue;
      this.metaOf.set(aid, meta);
      if (isStr(meta.toolUseId)) this.metas.set(meta.toolUseId, aid);
    }
  }
  noteResults(lines: Obj[]): void {
    for (const o of lines) {
      const r = o.toolUseResult;
      if (!isDict(r) || !isStr(r.agentId)) continue;
      for (const b of blocks(o)) {
        if (b.type === 'tool_result' && isStr(b.tool_use_id) && !this.resultAgent.has(b.tool_use_id)) {
          this.resultAgent.set(b.tool_use_id, r.agentId);
        }
      }
    }
  }
  agentOf(toolId: string): string | undefined {
    return this.metas.get(toolId) || this.resultAgent.get(toolId) || undefined;
  }
  agentLast(aid: string): number | null {
    if (!this.lastCache.has(aid)) {
      let last: number | null = null;
      for (const o of this.agentLines(aid)) {
        const t = tsEpoch(o);
        if (t && (last === null || t > last)) last = t;
      }
      this.lastCache.set(aid, last);
    }
    return this.lastCache.get(aid) ?? null;
  }
  busy(toolIds: string[], when: number | null): boolean {
    if (when === null) return false;
    for (const tid of toolIds) {
      const aid = this.agentOf(tid);
      const last = aid ? this.agentLast(aid) : null;
      if (last !== null && last > when) return true;
    }
    return false;
  }
  agentLines(aid: string): Obj[] {
    let v = this.agentCache.get(aid);
    if (v === undefined) {
      v = /^[A-Za-z0-9_-]+\n?$/.test(aid) ? readJsonl(path.join(this.subDir, `agent-${aid}.jsonl`)) : [];
      this.agentCache.set(aid, v);
      this.noteResults(v);
    }
    return v;
  }
}

type Spawned = { id: string; atype: unknown; ids: Set<string> };
type Event = {
  start: string | null;
  human: string | null;
  run: boolean;
  marker: string | null;
  done: Record<string, number> | null;
  spawned: Spawned[];
};

const findall = (re: RegExp, s: string): RegExpMatchArray[] => Array.from(s.matchAll(re));

function classify(o: Obj): Event {
  const e: Event = { start: null, human: null, run: false, marker: null, done: null, spawned: [] };
  if (truthy(o.isSidechain)) return e;
  if (o.type === 'assistant') {
    for (const b of blocks(o)) {
      if (b.type !== 'tool_use') continue;
      const inp: Obj = isDict(b.input) ? b.input : {};
      if (b.name === 'Skill') {
        const s = skillName(inp.skill);
        if (BATCH_SKILLS.includes(s)) e.start = s;
        else if (RUN_SKILLS.includes(s)) e.run = true;
      } else if ((b.name === 'Agent' || b.name === 'Task') && isStr(b.id)) {
        const atype = inp.subagent_type;
        const desc = isStr(inp.description) ? inp.description : '';
        e.spawned.push({ id: b.id, atype, ids: new Set(findall(QUICK_ID_RE, desc).map((m) => m[1] as string)) });
        e.run = e.run || (isStr(atype) && RUN_AGENTS.includes(atype));
      }
    }
    const t = textOf(o);
    const m = DONE_RE.exec(t);
    if (m) {
      e.marker = 'gsdt-batch';
      e.done = {};
      for (const kv of findall(KV_RE, m[1] as string)) e.done[kv[1] as string] = Number(kv[2]);
    } else if (QB_DONE_RE.test(t)) {
      e.marker = 'gsd-quick-batch';
    }
    return e;
  }
  if (o.type !== 'user') return e;
  if (isHuman(o)) {
    const t = textOf(o);
    const m = CMD_RE.exec(t);
    if (!m) {
      e.human = pyLstrip(t).startsWith('/') ? 'command' : 'text';
    } else if (BATCH_SKILLS.includes(skillName(m[1]))) {
      e.start = skillName(m[1]);
    } else {
      e.human = skillName(m[1]) === 'clear' ? 'clear' : 'command';
    }
  }
  return e;
}

type Batch = { start: number; end: number; skill: string; done: Record<string, number> | null; endedBy: string };

function findBatches(sess: Session): Batch[] {
  const ev = sess.lines.map(classify);
  const n = ev.length;
  const out: Batch[] = [];
  let i = 0;
  while (i < n) {
    const skill = (ev[i] as Event).start;
    if (!skill) {
      i += 1;
      continue;
    }
    let running = skill === 'gsd-quick-batch';
    const spawned: string[] = [];
    const planned = new Set<string>();
    const executed = new Set<string>();
    let end = n;
    let endedBy = 'end of session';
    let done: Record<string, number> | null = null;
    for (let j = i + 1; j < n; j++) {
      const e = ev[j] as Event;
      if (e.start) {
        if (skill === 'gsdt-batch' && e.start === 'gsd-quick-batch') {
          running = true;
          continue;
        }
        end = j;
        endedBy = 'next batch';
        break;
      }
      if (e.human === 'clear') {
        end = j;
        endedBy = '/clear';
        break;
      }
      running = running || e.run;
      for (const s of e.spawned) {
        spawned.push(s.id);
        if (s.atype === 'gsd-planner') for (const x of s.ids) planned.add(x);
        else if (s.atype === 'gsd-executor') for (const x of s.ids) executed.add(x);
      }
      if (e.marker === skill) {
        end = j + 1;
        endedBy = 'done line';
        done = e.done;
        break;
      }
      if (
        e.human === 'text' &&
        running &&
        [...planned].every((x) => executed.has(x)) &&
        !sess.busy(spawned, tsEpoch(sess.lines[j] as Obj))
      ) {
        end = j;
        endedBy = 'your next prompt';
        break;
      }
    }
    out.push({ start: i, end, skill, done, endedBy });
    i = Math.max(end, i + 1);
  }
  return out;
}

type RoleEntry = { name: string; model: string; t: Tally };
type Measured = {
  session: string;
  skill: string;
  start: number | null;
  end: number | null;
  items: number;
  itemsFrom: string;
  real: number | null;
  tiny: number | null;
  unlinked: number;
  endedBy: string;
  roles: Map<string, RoleEntry>;
};

function roleOf(roles: Map<string, RoleEntry>, name: string, model: string | null): Tally {
  const m = model || 'other';
  const key = `${name}\0${m}`;
  let r = roles.get(key);
  if (!r) {
    r = { name, model: m, t: new Tally() };
    roles.set(key, r);
  }
  return r.t;
}

function measure(sess: Session, b: Batch, seenMsg: Set<string>, seenTool: Set<string>): Measured {
  const window = sess.lines.slice(b.start, b.end).filter((o) => !truthy(o.isSidechain));
  const roles = new Map<string, RoleEntry>();
  const c = countLines(window, seenMsg, seenTool);
  if (c.t.turns) roleOf(roles, 'coordinator', c.model).add(c.t);
  const quickIds = new Set<string>();
  let planners = 0;
  let unlinked = 0;
  const queue = [...c.uses];
  const doneAgents = new Set<string>();
  while (queue.length) {
    const u = queue.shift() as Obj;
    if (u.name !== 'Agent' && u.name !== 'Task') continue;
    const aid = sess.agentOf(u.id as string);
    if (!aid) {
      unlinked += 1;
      continue;
    }
    if (doneAgents.has(aid)) continue;
    doneAgents.add(aid);
    const inp: Obj = isDict(u.input) ? u.input : {};
    const meta: Obj = sess.metaOf.get(aid) ?? {};
    const atype = safe(truthy(meta.agentType) ? meta.agentType : truthy(inp.subagent_type) ? inp.subagent_type : 'general-purpose');
    const desc = isStr(meta.description) ? meta.description : isStr(inp.description) ? inp.description : '';
    const lines = sess.agentLines(aid);
    const a = countLines(lines, seenMsg, seenTool);
    const amodel = a.model || family(meta.model) || family(inp.model);
    const r = roleOf(roles, atype, amodel);
    a.t.agents = 1;
    r.add(a.t);
    if (RUN_AGENTS.includes(atype)) for (const m of findall(QUICK_ID_RE, desc)) quickIds.add(m[1] as string);
    if (atype === 'gsd-planner') planners += 1;
    queue.push(...a.uses);
  }
  const done = b.done ?? {};
  let items: number;
  let src: string;
  if ('items' in done) {
    items = done.items as number;
    src = 'done line';
  } else if (quickIds.size) {
    items = quickIds.size;
    src = 'quick ids';
  } else {
    items = planners;
    src = 'planners';
  }
  let lastTs: number | null = null;
  for (let k = window.length - 1; k >= 0; k--) {
    const o = window[k] as Obj;
    lastTs = o.type === 'assistant' ? tsEpoch(o) : null;
    if (lastTs) break;
  }
  return {
    session: sess.id,
    skill: b.skill,
    start: tsEpoch(sess.lines[b.start] as Obj),
    end: lastTs,
    items,
    itemsFrom: src,
    real: 'real' in done ? (done.real as number) : null,
    tiny: 'tiny' in done ? (done.tiny as number) : null,
    unlinked,
    endedBy: b.endedBy,
    roles,
  };
}

function scan(dir: string): Measured[] {
  const batches: Measured[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl') && !n.startsWith('.'));
  } catch {
    /* none */
  }
  for (const n of names) {
    const p = path.join(dir, n);
    let raw: string;
    try {
      if (statSync(p).isDirectory()) continue;
      raw = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    if (!BATCH_SKILLS.some((s) => raw.includes(s))) continue;
    const sess = new Session(p);
    const seenMsg = new Set<string>();
    const seenTool = new Set<string>();
    for (const b of findBatches(sess)) batches.push(measure(sess, b, seenMsg, seenTool));
  }
  // stable, like python's sort
  return batches
    .map((b, i) => ({ b, i }))
    .sort((x, y) => (x.b.start || 0) - (y.b.start || 0) || x.i - y.i)
    .map((x) => x.b);
}

// ── output ──────────────────────────────────────────────────────────────────

function humanN(n: number): string {
  for (const [unit, div] of [['G', 1e9], ['M', 1e6], ['k', 1e3]] as Array<[string, number]>) {
    if (Math.abs(n) >= div) {
      const v = n / div;
      return v < 100 ? `${pyFixed(v, 1)}${unit}` : `${pyRound(v)}${unit}`;
    }
  }
  return `${pyRound(n)}`;
}
function localTime(e: number | null): string {
  if (!e) return '?';
  const d = new Date(Math.floor(e) * 1000);
  const p = (x: number, w = 2): string => String(x).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function roleRows(roles: Map<string, RoleEntry>): RoleEntry[] {
  const order: Record<string, number> = { coordinator: 0, 'gsd-planner': 1, 'gsd-executor': 2 };
  return [...roles.values()].sort(
    (a, b) => (order[a.name] ?? 3) - (order[b.name] ?? 3) || cmpStr(a.name, b.name) || cmpStr(a.model, b.model),
  );
}
function total(roles: Map<string, RoleEntry>): Tally {
  const t = new Tally();
  for (const v of roles.values()) t.add(v.t);
  return t;
}

// json.dumps(indent=1, ensure_ascii=True)
type J = null | boolean | number | PyFloat | string | J[] | { [k: string]: J };
function jstr(s: string): string {
  let o = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === '"') o += '\\"';
    else if (ch === '\\') o += '\\\\';
    else if (ch === '\n') o += '\\n';
    else if (ch === '\r') o += '\\r';
    else if (ch === '\t') o += '\\t';
    else if (ch === '\b') o += '\\b';
    else if (ch === '\f') o += '\\f';
    else if (c < 0x20 || (c > 0x7e && c !== 0x7f)) {
      if (c > 0xffff) {
        const x = c - 0x10000;
        o += `\\u${(0xd800 + (x >> 10)).toString(16).padStart(4, '0')}\\u${(0xdc00 + (x & 0x3ff)).toString(16).padStart(4, '0')}`;
      } else o += `\\u${c.toString(16).padStart(4, '0')}`;
    } else o += ch;
  }
  return `${o}"`;
}
function dumps(v: J, level = 0): string {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return String(v);
  if (v instanceof PyFloat) return floatText(v.v);
  if (typeof v === 'string') return jstr(v);
  const pad = ' '.repeat(level + 1);
  const close = ' '.repeat(level);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return `[\n${v.map((x) => pad + dumps(x, level + 1)).join(',\n')}\n${close}]`;
  }
  const ks = Object.keys(v);
  if (!ks.length) return '{}';
  return `{\n${ks.map((k) => `${pad}${jstr(k)}: ${dumps((v as { [k: string]: J })[k] as J, level + 1)}`).join(',\n')}\n${close}}`;
}
const fl = (x: number): PyFloat => new PyFloat(x);
const flOrNull = (x: number | null): J => (x === null ? null : fl(x));

function toJson(batches: Measured[], combined: Map<string, RoleEntry>, items: number): J {
  const tj = (t: Tally): { [k: string]: J } => ({
    agents: t.agents,
    turns: t.turns,
    bash: t.bash,
    fresh_input: t.fresh,
    cache_write: t.cacheWrite,
    cache_write_1h: t.cacheWrite1h,
    cache_read: t.cacheRead,
    input: t.input,
    output: t.output,
    weighted_input: pyRound(t.weighted),
  });
  const rj = (roles: Map<string, RoleEntry>, n: number): J[] =>
    roleRows(roles).map((r) => {
      const o: { [k: string]: J } = tj(r.t);
      o.role = r.name;
      o.model = r.model;
      if (n) {
        o.per_item = { input: pyRound(r.t.input / n), output: pyRound(r.t.output / n), weighted_input: pyRound(r.t.weighted / n) };
      }
      return o;
    });
  const base: { [k: string]: J } = {};
  for (const [k, v] of Object.entries(BASELINE.roles)) {
    const o: { [k: string]: J } = {};
    for (const [kk, vv] of Object.entries(v)) o[kk] = kk === 'model' ? (vv as string) : kk === 'input' || kk === 'output' ? fl(vv as number) : (vv as number);
    base[k] = o;
  }
  return {
    batches: batches.map((b) => ({
      session: b.session,
      skill: b.skill,
      start: flOrNull(b.start),
      end: flOrNull(b.end),
      items: b.items,
      items_from: b.itemsFrom,
      real: b.real,
      tiny: b.tiny,
      unlinked_agents: b.unlinked,
      ended_by: b.endedBy,
      roles: rj(b.roles, b.items),
    })),
    combined: { batches: batches.length, items, roles: rj(combined, items), total: tj(total(combined)) },
    baseline: { items: BASELINE.items, batches: BASELINE.batches, roles: base },
  };
}

export type Baseline = { builtin: boolean; items: number; roles: Record<string, number>; label: string };

function pyInt(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof PyFloat) {
    if (!Number.isFinite(v.v)) throw new Error('int');
    return Math.trunc(v.v);
  }
  if (isStr(v)) {
    if (!new RegExp(`^[${PYWS}]*[+-]?[0-9]+(_[0-9]+)*[${PYWS}]*$`).test(v)) throw new Error('int');
    return Number(pyStrip(v).replaceAll('_', ''));
  }
  throw new Error('int');
}

/** a saved --json run, or the built-in numbers; null = unreadable file */
export function loadBaseline(file: string | undefined): Baseline | null {
  if (!file) {
    const roles: Record<string, number> = {};
    for (const [k, v] of Object.entries(BASELINE.roles)) roles[k] = v.input as number;
    return {
      builtin: true,
      items: BASELINE.items,
      roles,
      label:
        `${BASELINE.batches} /gsd-quick-batch runs, ${BASELINE.items} items, the week before 2026-11-09 ` +
        '(docs/plan-gsdt-batch.md). It summed WHOLE sessions, so its ' +
        'coordinator and helper numbers include work outside the batches.',
    };
  }
  try {
    const j = parseJson(readStrict(file));
    if (!isDict(j)) return null;
    const c = j.combined;
    if (!isDict(c)) return null;
    const rs = c.roles;
    const roles: Record<string, number> = {};
    if (Array.isArray(rs)) {
      for (const r of rs) {
        if (!isDict(r)) return null;
        if (!('role' in r) || !('input' in r)) return null;
        const k = safe(r.role);
        roles[k] = (roles[k] ?? 0) + pyInt(r.input);
      }
    } else if (!((isStr(rs) && rs === '') || (isDict(rs) && Object.keys(rs).length === 0))) {
      return null;
    }
    if (!('items' in c) || !('batches' in c)) return null;
    const items = pyInt(c.items);
    return { builtin: false, items, roles, label: `${pyInt(c.batches)} batch(es), ${items} items, from a saved report` };
  } catch {
    return null;
  }
}

function textReport(d: string, batches: Measured[], combined: Map<string, RoleEntry>, items: number, base: Baseline): string {
  const out: string[] = [];
  const s = (n: number): string => (n === 1 ? '' : 's');
  out.push(`gsdt-batch-report — ${batches.length} batch${batches.length === 1 ? '' : 'es'} · ${items} item${s(items)} · ${d}`);
  for (const b of batches) {
    let extra = '';
    if (b.real !== null || b.tiny !== null) extra = ` (real ${b.real ?? '?'}, tiny ${b.tiny ?? '?'})`;
    out.push(
      `  ${cpSlice(b.session, 0, 8)}  ${localTime(b.start)} → ${cpSlice(localTime(b.end), 11)}  /${b.skill}  ${b.items} item${s(b.items)}${extra} [${b.itemsFrom}]${b.unlinked ? `  ⚠ ${b.unlinked} helper(s) not found` : ''}`,
    );
  }
  out.push('');
  const hdr = (a: string[]): string =>
    [padR(a[0] as string, 28), ...[6, 6, 7, 9, 9, 9, 8, 9].map((w, i) => padL(a[i + 1] as string, w))].join(' ');
  out.push(hdr(['ROLE', 'AGENTS', 'TURNS', 'BASH/AG', 'FRESH IN', 'CACHE WR', 'CACHE RD', 'OUTPUT', 'WEIGHTED']));
  const rows: Array<[string, string, Tally]> = [...roleRows(combined).map((r) => [r.name, r.model, r.t] as [string, string, Tally]), ['TOTAL', '', total(combined)]];
  for (const [name, model, t] of rows) {
    const label = !model ? name : `${name} · ${model}`;
    const per = t.agents ? pyFixed(t.bash / t.agents, 1) : '–';
    out.push(hdr([cpSlice(label, 0, 28), t.agents ? String(t.agents) : '–', String(t.turns), per, humanN(t.fresh), humanN(t.cacheWrite), humanN(t.cacheRead), humanN(t.output), humanN(t.weighted)]));
  }
  out.push('');
  if (!items) {
    out.push('Per item: no item count (pass --items N).');
    return `${out.join('\n')}\n`;
  }
  out.push(`PER ITEM — input = fresh + cache write + cache read (${base.builtin ? 'the baseline' : 'BASE IN'} has only this sum)`);
  const h2 = (a: string[]): string =>
    [padR(a[0] as string, 28), ...[9, 9, 9, 10, 8].map((w, i) => padL(a[i + 1] as string, w))].join(' ');
  out.push(h2(['ROLE', 'INPUT', 'WEIGHTED', 'OUTPUT', 'BASE IN', 'CHANGE']));
  const byName = new Map<string, Tally>();
  const models = new Map<string, string[]>();
  for (const r of roleRows(combined)) {
    let t = byName.get(r.name);
    if (!t) byName.set(r.name, (t = new Tally()));
    t.add(r.t);
    const ms = models.get(r.name) ?? [];
    ms.push(r.model);
    models.set(r.name, ms);
  }
  const rows2: Array<[string, string, Tally]> = [...byName].map(([n, t]) => [n, (models.get(n) as string[]).join('+'), t]);
  rows2.push(['TOTAL', '', total(combined)]);
  for (const [name, model, t] of rows2) {
    const label = !model ? name : `${name} · ${model}`;
    let baseIn: number | null;
    if (name === 'TOTAL') baseIn = base.items ? Object.values(base.roles).reduce((a, b) => a + b, 0) / base.items : null;
    else if (Object.hasOwn(base.roles, name) && base.items) baseIn = (base.roles[name] as number) / base.items;
    else baseIn = null;
    let change: string;
    if (baseIn) {
      const pct = (100.0 * (t.input / items - baseIn)) / baseIn;
      const r = pyRound(pct);
      change = r ? `${r > 0 ? '+' : ''}${r}%` : '0%';
    } else change = 'new';
    out.push(h2([cpSlice(label, 0, 28), humanN(t.input / items), humanN(t.weighted / items), humanN(t.output / items), baseIn ? humanN(baseIn) : '–', change]));
  }
  out.push('');
  out.push(`Baseline: ${base.label}`);
  return `${out.join('\n')}\n`;
}

export type ReportOpts = { dir: string; last?: number; days?: number; session?: string; items?: number; json?: boolean; baseline?: string; now?: number };
export type Result = { rc: number; stdout: string; stderr: string };

/** `report --dir DIR …` of the python */
export function report(a: ReportOpts): Result {
  let batches = scan(a.dir);
  if (a.session) batches = batches.filter((b) => b.session.startsWith(a.session as string));
  else if (a.days !== undefined) {
    const cut = (a.now || Date.now() / 1000) - a.days * 86400;
    batches = batches.filter((b) => (b.start || 0) >= cut);
  } else batches = batches.slice(-(a.last || 1));
  const combined = new Map<string, RoleEntry>();
  for (const b of batches) {
    for (const [k, r] of b.roles) {
      let c = combined.get(k);
      if (!c) combined.set(k, (c = { name: r.name, model: r.model, t: new Tally() }));
      c.t.add(r.t);
    }
  }
  const items = a.items !== undefined ? a.items : batches.reduce((s, b) => s + b.items, 0);
  if (a.json) return { rc: 0, stdout: `${dumps(toJson(batches, combined, items))}\n`, stderr: '' };
  if (!batches.length) return { rc: 0, stdout: `gsdt-batch-report: no /gsd-quick-batch or /gsdt-batch run found in ${a.dir}\n`, stderr: '' };
  const base = loadBaseline(a.baseline);
  if (base === null) {
    return { rc: 64, stdout: '', stderr: `gsdt-batch-report: cannot read --baseline ${a.baseline} (a saved --json report)\n` };
  }
  return { rc: 0, stdout: textReport(a.dir, batches, combined, items, base), stderr: '' };
}

// ── project folder ──────────────────────────────────────────────────────────

const pyJoin = (a: string, b: string): string => (b.startsWith('/') ? b : a === '' || a.endsWith('/') ? a + b : `${a}/${b}`);
function pyRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Claude Code's folder for a working directory: every character that is not a
 *  letter or digit becomes '-'; a name over 200 characters is cut and gets a
 *  hash suffix. The real path is tried too (macOS /tmp → /private/tmp). */
export function projdir(home: string, repos: string[]): string {
  const baseDir = pyJoin(home, 'projects');
  let first: string | null = null;
  for (const p of repos.flatMap((r) => [r, pyRealpath(r)])) {
    const name = p.replace(/[^A-Za-z0-9]/gu, '-');
    const cand = pyJoin(baseDir, name);
    first = first || cand;
    if (isDir(cand)) return cand;
    if (cpLen(name) > 200) {
      const pre = `${cpSlice(name, 0, 200)}-`;
      let names: string[] = [];
      try {
        names = readdirSync(baseDir);
      } catch {
        /* none */
      }
      const hits = names.filter((n) => n.startsWith(pre)).map((n) => pyJoin(baseDir, n)).sort(cmpStr);
      if (hits.length) return hits[0] as string;
    }
  }
  return first as string;
}
