// src/claude-settings.ts — editing Claude's settings JSON without python:
//   - claudeEnv        port of lib/gsd_claude_env.py (set/remove one env variable)
//   - baserefState     port of the python in lib/common.sh `gsd__baseref_py` (worktree.baseRef)
//   - removeGuardHook  port of the python in bin/gsdt-bootstrap-repo `drop_gemini` (hook removal)
//
// The files are rewritten the way python's `json.dump(indent=2, ensure_ascii=False)` wrote
// them, so a settings file a person edited keeps its numbers (1.0 stays 1.0, a long integer
// stays exact) and its key order. JSON.parse would lose both, hence the small parser here.
// Python quirks kept: NaN / Infinity / -Infinity are accepted and written back; a duplicate key
// keeps the first position and the last value; a leading BOM is an error; control characters
// inside a string are an error.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/** a number as written (python kept ints exact and floats as repr) */
export class JNum {
  lex: string;
  constructor(lex: string) {
    this.lex = lex;
  }
}
export type JVal = null | boolean | string | JNum | JVal[] | Map<string, JVal>;

class JsonError extends Error {}

const WS = new Set([' ', '\t', '\n', '\r']);

/** python `json.loads` (strict): throws JsonError on anything python would reject */
export function parseJson(text: string): JVal {
  let i = 0;
  const fail = (): never => {
    throw new JsonError(`bad JSON at ${i}`);
  };
  const ws = (): void => {
    while (i < text.length && WS.has(text[i] as string)) i++;
  };
  const str = (): string => {
    // text[i] is the opening quote
    i++;
    let out = '';
    for (;;) {
      if (i >= text.length) fail();
      const c = text[i] as string;
      if (c === '"') {
        i++;
        return out;
      }
      if (c === '\\') {
        const e = text[i + 1];
        i += 2;
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const h = text.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(h)) fail();
            i += 4;
            out += String.fromCharCode(parseInt(h, 16));
            break;
          }
          default:
            fail();
        }
        continue;
      }
      if (c < ' ') fail(); // strict: no raw control characters
      out += c;
      i++;
    }
  };
  const value = (): JVal => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const m = new Map<string, JVal>();
      ws();
      if (text[i] === '}') {
        i++;
        return m;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const k = str();
        ws();
        if (text[i] !== ':') fail();
        i++;
        m.set(k, value());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return m;
        }
        fail();
      }
    }
    if (c === '[') {
      i++;
      const a: JVal[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return a;
      }
      for (;;) {
        a.push(value());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return a;
        }
        fail();
      }
    }
    if (c === '"') return str();
    for (const [tok, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(tok, i)) {
        i += tok.length;
        return v;
      }
    }
    for (const tok of ['NaN', 'Infinity', '-Infinity']) {
      if (text.startsWith(tok, i)) {
        i += tok.length;
        return new JNum(tok);
      }
    }
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?/.exec(text.slice(i, i + 4096));
    if (!m) return fail();
    i += m[0].length;
    return new JNum(m[0]);
  };
  const v = value();
  ws();
  if (i < text.length) fail();
  return v;
}

/** python's repr of a float */
function pyFloat(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const neg = x < 0;
  const [m, e] = Math.abs(x).toExponential().split('e') as [string, string];
  const digits = m.replace('.', '');
  const exp = Number(e);
  let s: string;
  if (exp >= -4 && exp < 16) {
    if (exp >= 0) {
      const ip = digits.padEnd(exp + 1, '0').slice(0, exp + 1);
      s = `${ip}.${digits.slice(exp + 1) || '0'}`;
    } else {
      s = `0.${'0'.repeat(-exp - 1)}${digits}`;
    }
  } else {
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : (digits[0] as string);
    s = `${mant}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  return neg ? `-${s}` : s;
}

function numberText(n: JNum): string {
  const l = n.lex;
  if (l === 'NaN' || l === 'Infinity' || l === '-Infinity') return l;
  if (/[.eE]/.test(l)) return pyFloat(Number(l));
  return l.replace(/^-0+$/, '0'); // python int('-0') is 0
}

/** python `json.dumps(v, indent=2, ensure_ascii=False)` (keys in their order, or sorted) */
export function dumpJson(v: JVal, sort = false): string {
  const go = (x: JVal, level: number): string => {
    if (x === null) return 'null';
    if (x === true) return 'true';
    if (x === false) return 'false';
    if (typeof x === 'string') return JSON.stringify(x);
    if (x instanceof JNum) return numberText(x);
    const pad = '  '.repeat(level + 1);
    const end = '  '.repeat(level);
    if (Array.isArray(x)) {
      if (x.length === 0) return '[]';
      return `[\n${x.map((e) => pad + go(e, level + 1)).join(',\n')}\n${end}]`;
    }
    let keys = [...x.keys()];
    if (keys.length === 0) return '{}';
    if (sort) keys = keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{\n${keys.map((k) => `${pad}${JSON.stringify(k)}: ${go(x.get(k) as JVal, level + 1)}`).join(',\n')}\n${end}}`;
  };
  return go(v, 0);
}

/** python str.strip() whitespace */
const PY_SPACE_CHARS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_SPACE = new RegExp(`^[${PY_SPACE_CHARS}]+|[${PY_SPACE_CHARS}]+$`, 'g');

/** read a file as strict UTF-8 text (a BOM stays, invalid bytes throw) */
function readStrict(file: string): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
}

/** python tempfile.mkstemp: a new 0600 file next to the target */
function mkstemp(dir: string, prefix: string, content: string): string {
  for (let n = 0; n < 100; n++) {
    const tmp = path.join(dir, `${prefix}${randomBytes(4).toString('hex').slice(0, 8)}`);
    try {
      writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
      return tmp;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new Error('no temporary file name');
}

/** write `text` to `file` the way python did: a temporary file in the same folder, then replace */
function replaceFile(file: string, text: string, tmpPrefix: string): void {
  const folder = path.dirname(file) || '.';
  mkdirSync(folder, { recursive: true });
  const tmp = mkstemp(folder, tmpPrefix, text);
  try {
    chmodSync(tmp, existsSync(file) ? statSync(file).mode & 0o777 : 0o644);
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // gone already
    }
    throw e;
  }
}

/**
 * lib/gsd_claude_env.py — set env.NAME (value given) or remove it (no value) in a Claude settings
 * file. Returns python's exit status: 0 done / nothing to do, 3 the file is not a JSON object
 * (left alone), 1 it could not be written.
 */
export function claudeEnv(file: string, name: string, value?: string): number {
  let data: Map<string, JVal> = new Map();
  if (existsSync(file)) {
    try {
      const text = readStrict(file);
      const v: JVal = text.replace(PY_SPACE, '') === '' ? new Map() : parseJson(text);
      if (!(v instanceof Map)) return 3;
      data = v;
    } catch {
      return 3;
    }
  } else if (value === undefined) return 0;
  const env = data.get('env');
  if (env !== undefined && env !== null && !(env instanceof Map)) return 3;
  const before = dumpJson(data, true);
  if (value === undefined) {
    if (env instanceof Map) {
      env.delete(name);
      if (env.size === 0) data.delete('env');
    }
  } else if (env === undefined) {
    data.set('env', new Map<string, JVal>([[name, value]]));
  } else if (env instanceof Map) {
    env.set(name, value);
  } else {
    return 1; // "env": null — python's `None[name] = …` raised
  }
  if (dumpJson(data, true) === before && existsSync(file)) return 0;
  try {
    replaceFile(file, `${dumpJson(data)}\n`, '.gsd-settings.');
  } catch {
    return 1;
  }
  return 0;
}

// ── worktree.baseRef ────────────────────────────────────────────────────────

/** python os.path.realpath: symlinks resolved as far as the path exists */
function pyRealpath(p: string): string {
  const abs = path.resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const d = path.dirname(abs);
    return d === abs ? abs : path.join(pyRealpath(d), path.basename(abs));
  }
}

function readSettings(file: string): [Map<string, JVal> | null, boolean] {
  if (!existsSync(file)) return [null, true];
  try {
    const v = parseJson(readStrict(file));
    return v instanceof Map ? [v, true] : [null, false];
  } catch {
    return [null, false];
  }
}

/**
 * The python of gsd__baseref_py: `files` = the local settings file, the project's, the user's.
 * check → head | other:<v> | invalid | missing; ensure → the same, or `set` after writing
 * worktree.baseRef = "head" into the local file ('invalid' when that failed, as the bash said).
 */
export function baserefState(mode: 'check' | 'ensure', files: string[]): string {
  const localArg = files[0] as string;
  const local = pyRealpath(localArg);
  const [data, ok] = readSettings(local);
  for (const f of files) {
    const s = f === localArg ? data : readSettings(f)[0];
    const wt = s && s.size > 0 ? s.get('worktree') : undefined;
    const ref = wt instanceof Map ? wt.get('baseRef') : undefined;
    if (typeof ref === 'string') return ref === 'head' ? 'head' : `other:${ref}`;
  }
  if (!ok || (data !== null && data.has('worktree') && !(data.get('worktree') instanceof Map))) return 'invalid';
  if (mode !== 'ensure') return 'missing';
  const d = data ?? new Map<string, JVal>();
  let wt = d.get('worktree');
  if (wt === undefined) {
    wt = new Map<string, JVal>();
    d.set('worktree', wt);
  }
  (wt as Map<string, JVal>).set('baseRef', 'head');
  try {
    replaceFile(local, `${dumpJson(d)}\n`, '.settings.local.');
  } catch {
    return 'invalid';
  }
  return 'set';
}

// ── removing the toolkit's guard hook (an older release's Gemini setup) ─────

/** python `str(x)` closely enough to look for a name in it */
const pyStr = (x: JVal | undefined): string => (x === undefined ? '' : typeof x === 'string' ? x : dumpJson(x));

/**
 * Remove every hook whose command names the worktree guard from a settings file (the file goes
 * when nothing else is left). false = nothing was changed (not JSON, no hooks, none of ours).
 */
export function removeGuardHook(file: string): boolean {
  let data: JVal;
  try {
    data = parseJson(readStrict(file));
  } catch {
    return false;
  }
  if (!(data instanceof Map)) return false;
  const hooks = data.get('hooks');
  if (!(hooks instanceof Map)) return false;
  const ours = (h: JVal): boolean => {
    if (!(h instanceof Map)) return false;
    const c = pyStr(h.get('command'));
    return c.includes('gsdt-worktree-guard') || c.includes('gsd-worktree-guard');
  };
  let found = false;
  for (const [event, groups] of [...hooks.entries()]) {
    if (!Array.isArray(groups)) continue;
    const kept: JVal[] = [];
    for (const g of groups) {
      if (g instanceof Map && Array.isArray(g.get('hooks'))) {
        const list = g.get('hooks') as JVal[];
        const rest = list.filter((h) => !ours(h));
        if (rest.length < list.length) {
          found = true;
          if (rest.length === 0) continue;
        }
        g.set('hooks', rest);
      }
      kept.push(g);
    }
    if (kept.length > 0) hooks.set(event, kept);
    else hooks.delete(event);
  }
  if (!found) return false;
  if (hooks.size === 0) data.delete('hooks');
  if (data.size > 0) {
    writeFileSync(file, `${dumpJson(data)}\n`);
  } else {
    unlinkSync(file);
    try {
      rmdirSync(path.dirname(file));
    } catch {
      // not empty: stays
    }
  }
  return true;
}
