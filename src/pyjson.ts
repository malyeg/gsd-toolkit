// src/pyjson.ts — Python's json.loads / json.dumps(indent=2, ensure_ascii=False)
// for the one job gsdt-migrate had python for: editing a user's settings JSON
// and writing it back byte for byte as the python did.
//
// JS objects reorder integer-like keys and lose number spelling, so values are
// kept as: Map (object, insertion order), Array, string, boolean, null, PyNum
// (number, already in python's output spelling).

export class PyNum {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}
export type PyJson = Map<string, PyJson> | PyJson[] | string | boolean | null | PyNum;

export class PyJsonError extends Error {}

/** repr(float) as python prints it */
function floatRepr(raw: string): string {
  const n = Number(raw);
  if (Number.isNaN(n)) return 'NaN';
  if (!Number.isFinite(n)) return n > 0 ? 'Infinity' : '-Infinity';
  if (n === 0) return Object.is(n, -0) ? '-0.0' : '0.0';
  const neg = n < 0;
  const [mant, expS] = Math.abs(n).toExponential().split('e') as [string, string];
  const digits = mant.replace('.', '');
  const e = Number(expS);
  let s: string;
  if (e >= -4 && e < 16) {
    if (e >= 0) {
      const intPart = digits.length > e + 1 ? digits.slice(0, e + 1) : digits.padEnd(e + 1, '0');
      const frac = digits.length > e + 1 ? digits.slice(e + 1) : '0';
      s = `${intPart}.${frac}`;
    } else {
      s = `0.${'0'.repeat(-e - 1)}${digits}`;
    }
  } else {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    s = `${m}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  return neg ? `-${s}` : s;
}

const WS = new Set([' ', '\t', '\n', '\r']);

/** json.loads — throws PyJsonError where python raises ValueError */
export function pyLoads(text: string): PyJson {
  let i = 0;
  const fail = (): never => {
    throw new PyJsonError(`bad json at ${i}`);
  };
  const ws = (): void => {
    while (i < text.length && WS.has(text[i] as string)) i++;
  };
  const str = (): string => {
    i++; // opening quote
    let s = '';
    for (;;) {
      if (i >= text.length) fail();
      const c = text[i] as string;
      if (c === '"') {
        i++;
        return s;
      }
      if (c < ' ') fail(); // strict: control characters
      if (c !== '\\') {
        s += c;
        i++;
        continue;
      }
      i++;
      const e = text[i];
      i++;
      switch (e) {
        case '"': s += '"'; break;
        case '\\': s += '\\'; break;
        case '/': s += '/'; break;
        case 'b': s += '\b'; break;
        case 'f': s += '\f'; break;
        case 'n': s += '\n'; break;
        case 'r': s += '\r'; break;
        case 't': s += '\t'; break;
        case 'u': {
          const h = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail();
          s += String.fromCharCode(parseInt(h, 16));
          i += 4;
          break;
        }
        default:
          fail();
      }
    }
  };
  const value = (): PyJson => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const m = new Map<string, PyJson>();
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
      const a: PyJson[] = [];
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
    for (const [lit, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return v;
      }
    }
    if (text.startsWith('NaN', i)) {
      i += 3;
      return new PyNum('NaN');
    }
    if (text.startsWith('Infinity', i)) {
      i += 8;
      return new PyNum('Infinity');
    }
    if (text.startsWith('-Infinity', i)) {
      i += 9;
      return new PyNum('-Infinity');
    }
    const m = /^(-?(?:0|[1-9][0-9]*))(\.[0-9]+)?([eE][-+]?[0-9]+)?/.exec(text.slice(i));
    if (!m) return fail();
    i += m[0].length;
    if (m[2] === undefined && m[3] === undefined) return new PyNum(BigInt(m[1] as string).toString());
    return new PyNum(floatRepr(m[0]));
  };
  const v = value();
  ws();
  if (i < text.length) fail();
  return v;
}

function dumpStr(s: string): string {
  return `"${s.replace(/[\x00-\x1f\\"]/g, (c) => {
    switch (c) {
      case '"': return '\\"';
      case '\\': return '\\\\';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      case '\b': return '\\b';
      case '\f': return '\\f';
      default: return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  })}"`;
}

/** json.dumps(v, indent=2, ensure_ascii=False) */
export function pyDumps(v: PyJson, level = 0): string {
  if (v === null) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'string') return dumpStr(v);
  if (v instanceof PyNum) return v.text;
  const pad = '\n' + '  '.repeat(level + 1);
  const end = '\n' + '  '.repeat(level);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[${pad}${v.map((x) => pyDumps(x, level + 1)).join(`,${pad}`)}${end}]`;
  }
  if (v.size === 0) return '{}';
  return `{${pad}${[...v].map(([k, x]) => `${dumpStr(k)}: ${pyDumps(x, level + 1)}`).join(`,${pad}`)}${end}}`;
}
