// Golden files: the saved, verified expected output of a test.
//
//   import { test, golden } from './golden.ts';   // `test` = node:test's test + a name for the goldens
//   golden(actualText);                           // compare with the saved text, in call order
//
// Goldens live in tests/golden/<test file>/<test name>.txt, one entry per golden() call:
//   @@@ <n> @@@
//   <text>
// Texts are compared after CRLF -> LF; the files are written with LF.
//
// UPDATE_GOLDEN=1 rewrites the goldens of the tests that run from what the code gives now.
// A regenerated golden MUST be reviewed by diff (`git diff tests/golden`) before it is
// committed: the run itself cannot tell a fixed bug from a new one.
//
// Machine-specific text (temp dirs, the package dir, 40-digit hashes) is replaced by
// goldenNorm() before saving and comparing.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test as nodeTest } from 'node:test';

const PKG = path.resolve(import.meta.dirname, '..', '..');
const GOLDEN = path.join(PKG, 'tests', 'golden');
export const UPDATE = process.env.UPDATE_GOLDEN === '1';
const DELIM = /^@@@ (\d+) @@@$/;

let current: { file: string; name: string; n: number; entries: string[]; saved: string[] | null } | null = null;

const slug = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'test';
const fileBase = (): string => {
  const f = process.argv[1] ?? '';
  return f;
};

/** the test file that called test(): taken from the stack of the call */
function callerFile(): string {
  const st = new Error().stack ?? '';
  for (const line of st.split('\n')) {
    const m = /(?:file:\/\/)?(\/[^\s():]*?\.test\.ts|[A-Za-z]:[^\s():]*?\.test\.ts)/.exec(line);
    if (m) return path.basename(decodeURIComponent(m[1] ?? '')).replace(/\.test\.ts$/, '');
  }
  void fileBase;
  return 'unknown';
}

type Fn = (...a: never[]) => unknown;
function wrap(fn: Fn, dir: string, name: string): Fn {
  return async (...a: never[]) => {
    const file = path.join(GOLDEN, dir, `${slug(name)}.txt`);
    current = { file, name, n: 0, entries: [], saved: null };
    try {
      const r = await fn(...a);
      if (UPDATE) {
        if (current.entries.length === 0) return r;
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, current.entries.map((e, i) => `@@@ ${i + 1} @@@\n${e}\n`).join(''));
      }
      return r;
    } finally {
      current = null;
    }
  };
}

type TestFn = typeof nodeTest;
function make(base: (...a: never[]) => unknown): TestFn {
  const f = ((...args: unknown[]) => {
    const dir = callerFile();
    const i = args.findIndex((a) => typeof a === 'function');
    if (i >= 0) {
      const name = typeof args[0] === 'string' ? (args[0] as string) : ((args[0] as { name?: string })?.name ?? 'test');
      args[i] = wrap(args[i] as Fn, dir, name);
    }
    return (base as (...a: unknown[]) => unknown)(...args);
  }) as unknown as TestFn;
  return f;
}
export const test: TestFn = Object.assign(make(nodeTest as never), {
  skip: make(nodeTest.skip as never),
  todo: make(nodeTest.todo as never),
  only: make(nodeTest.only as never),
});

const reEsc = (d: string): string => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WIN = process.platform === 'win32';

/** a folder as it can appear in output on Windows: native, with `/` (git), JSON-escaped (`\\\\`); long and 8.3 (RUNNER~1) spellings */
function spellings(d: string): string[] {
  if (!WIN) return [d];
  const out = new Set<string>();
  for (const x of [d, d.replace(/\\/g, '/')]) {
    out.add(x.replace(/\\/g, '\\\\'));
    out.add(x);
  }
  return [...out].sort((a, b) => b.length - a.length);
}
function folders(...ds: string[]): string[] {
  const set = new Set<string>();
  for (const d of ds) for (const s of spellings(d)) set.add(s);
  return [...set].sort((a, b) => b.length - a.length);
}

/** replace what differs from machine to machine */
export function goldenNorm(s: string): string {
  let t = s.replace(/\r\n/g, '\n');
  const roots = [realpathSync(tmpdir()), tmpdir()];
  if (WIN) roots.push(realpathSync.native(tmpdir()));
  const flags = WIN ? 'gi' : 'g';
  const sep = WIN ? '(?:\\\\\\\\|[\\\\/])' : '[\\\\/]';
  for (const d of folders(...roots)) {
    const re = new RegExp(`${reEsc(d)}${sep}gsd-[A-Za-z0-9-]*?-?[A-Za-z0-9]{6}`, flags);
    t = t.replace(re, '<TMP>');
  }
  for (const d of folders(PKG)) t = t.replace(new RegExp(reEsc(d), flags), '<PKG>');
  if (WIN) {
    // a path after a placeholder (<TMP>, <PKG>, <D>, <W> …): the macOS spelling, `/` between folders
    t = t.replace(/(<[A-Za-z]+>)((?:\\\\|\\|\/)[^\s"'`<>|*?]*)/g, (_m, p: string, rest: string) =>
      p + (rest.includes('\\\\') ? rest.replaceAll('\\\\', '/') : rest.replaceAll('\\', '/')),
    );
  }
  return t;
}

function load(file: string): string[] {
  const out: string[] = [];
  const lines = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // the file's own final newline
  let cur: string[] | null = null;
  for (const l of lines) {
    if (DELIM.test(l)) {
      if (cur) out.push(cur.join('\n'));
      cur = [];
    } else if (cur) cur.push(l);
  }
  if (cur) out.push(cur.join('\n'));
  return out;
}

/**
 * Compare `actual` with the next saved golden of this test (UPDATE_GOLDEN=1: save it instead).
 * `old` is only for the one-time generation: with UPDATE_GOLDEN=1 it must give the same text.
 */
export function golden(actual: string, old?: () => string): void {
  assert.ok(current, 'golden() outside a test');
  const text = goldenNorm(actual);
  assert.ok(!text.split('\n').some((l) => DELIM.test(l)), 'text looks like a golden delimiter');
  const n = ++current.n;
  if (UPDATE) {
    if (old) assert.equal(text, goldenNorm(old()), `golden ${n}: new differs from the old code`);
    current.entries.push(text);
    return;
  }
  if (!current.saved) {
    assert.ok(existsSync(current.file), `no golden file ${path.relative(PKG, current.file)} (run with UPDATE_GOLDEN=1)`);
    current.saved = load(current.file);
  }
  const want = current.saved[n - 1];
  assert.notEqual(want, undefined, `golden ${n} missing in ${path.relative(PKG, current.file)}`);
  assert.equal(text, want, `golden ${n} of "${current.name}" (${path.relative(PKG, current.file)})`);
}
