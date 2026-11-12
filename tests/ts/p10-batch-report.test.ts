// P10 parity (gsdt-batch-report): the TypeScript command behind bin/gsdt-batch-report against the
// pre-P10 bash + python command (tests/fixtures/p10-old-bins/, the python under lib/ of a copied
// package), both reading the same transcript folders: the generator of tests/test-batch.sh, plus
// folders made here (floats/bools in usage, timestamps in odd spellings, a non-ASCII session id,
// ties for "%.1f", /clear, next-batch and done-line endings, unlinked helpers, odd agent names).
// Compared: stdout, stderr, exit code. Only the --help Exit line differs on purpose (exit 69 left).
// Run: node --test tests/ts/p10-batch-report.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PKG } from './helpers.ts';

const W = realpathSync(mkdtempSync(path.join(tmpdir(), 'gsd-p10-')));
process.on('exit', () => rmSync(W, { recursive: true, force: true }));

const OLDPKG = path.join(W, 'oldpkg');
mkdirSync(path.join(OLDPKG, 'bin'), { recursive: true });
cpSync(path.join(PKG, 'lib'), path.join(OLDPKG, 'lib'), { recursive: true });
writeFileSync(path.join(OLDPKG, 'lib', 'gsd_batch_report.py'), readFileSync(path.join(PKG, 'tests/fixtures/p10-old-bins/gsd_batch_report.py')));
writeFileSync(path.join(OLDPKG, 'bin', 'gsdt-batch-report'), readFileSync(path.join(PKG, 'tests/fixtures/p10-old-bins/gsdt-batch-report')));
chmodSync(path.join(OLDPKG, 'bin', 'gsdt-batch-report'), 0o755);
const BINS = { old: path.join(OLDPKG, 'bin', 'gsdt-batch-report'), neu: path.join(PKG, 'bin', 'gsdt-batch-report') };

type R = { out: string; err: string; rc: number };
function run(bin: string, args: string[], o: { cwd?: string; env?: Record<string, string> } = {}): R {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: path.join(W, 'home'), TZ: 'UTC', LC_ALL: 'en_US.UTF-8', ...o.env };
  const r = spawnSync('bash', [bin, ...args], { cwd: o.cwd ?? W, encoding: 'utf8', env });
  return { out: r.stdout ?? '', err: r.stderr ?? '', rc: r.status ?? 1 };
}
/** run both; assert equal (help text: the old Exit line is the one allowed difference) */
function same(args: string[], o: { cwd?: string; env?: Record<string, string> } = {}): R {
  const a = run(BINS.old, args, o);
  const b = run(BINS.neu, args, o);
  a.out = a.out.replace('64 = bad usage;\n69 = no Python 3.7+.\n', '64 = bad usage.\n');
  assert.deepEqual(b, a, `args: ${args.join(' ')}`);
  return b;
}

// ── the generator of tests/test-batch.sh ────────────────────────────────────
const shText = readFileSync(path.join(PKG, 'tests/test-batch.sh'), 'utf8');
const gen = /cat > "\$WORK\/gen\.py" <<'PY'\n([\s\S]*?)\nPY\n/.exec(shText)?.[1];
assert.ok(gen, 'generator found in tests/test-batch.sh');
const P = path.join(W, 'proj');
mkdirSync(P, { recursive: true });
writeFileSync(path.join(W, 'gen.py'), gen);
assert.equal(spawnSync('python3', [path.join(W, 'gen.py'), P]).status, 0);

// ── folders made here ───────────────────────────────────────────────────────
const NOW = Math.floor(Date.now() / 1000);
const SECRET = 'MARKER-TEXT-31337';
const iso = (t: number, f = '.000Z'): string => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, f);
type Line = Record<string, unknown>;
const usage = (fresh: unknown, cw: unknown, cr: unknown, out: unknown, extra: Line = {}): Line => ({
  input_tokens: fresh, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out, ...extra,
});
const asst = (ts: string | undefined, id: string, u: unknown, tools: Array<[string, string, Line]> = [], text?: string, model: string | undefined = 'claude-opus-5-5'): Line => {
  const c: Line[] = [];
  if (text) c.push({ type: 'text', text });
  for (const [name, tid, input] of tools) c.push({ type: 'tool_use', id: tid, name, input });
  const o: Line = { type: 'assistant', message: { id, role: 'assistant', content: c, usage: u, ...(model ? { model } : {}) } };
  if (ts !== undefined) o.timestamp = ts;
  return o;
};
const human = (ts: string, text: string): Line => ({ type: 'user', timestamp: ts, origin: { kind: 'human' }, message: { role: 'user', content: text } });
const cmd = (ts: string, name: string, args = ''): Line => ({ type: 'user', timestamp: ts, message: { role: 'user', content: `<command-name>/${name}</command-name>\n<command-args>${args}</command-args>` } });
const result = (ts: string, tid: string, agent?: string): Line => ({
  type: 'user', timestamp: ts, toolUseResult: { status: 'ok', ...(agent ? { agentId: agent } : {}) },
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: 'x' }] },
});
const spawn = (tid: string, atype: unknown, desc: string): [string, string, Line] => ['Agent', tid, { subagent_type: atype, description: desc, prompt: SECRET }];
function writeSession(dir: string, id: string, lines: Array<Line | string>, helpers: Record<string, { meta?: Line | string; lines: Line[] }> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  for (const [aid, h] of Object.entries(helpers)) {
    const sd = path.join(dir, id, 'subagents');
    mkdirSync(sd, { recursive: true });
    writeFileSync(path.join(sd, `agent-${aid}.jsonl`), h.lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    if (h.meta !== undefined) writeFileSync(path.join(sd, `agent-${aid}.meta.json`), typeof h.meta === 'string' ? h.meta : JSON.stringify(h.meta));
  }
}

const ODD = path.join(W, 'odd');
{
  const t = (m: number): string => iso(NOW - 5 * 86400 + 60 * m);
  // Ties for "%.1f" (1250 → 1.2k, 1350 → 1.4k, 2500), floats and bools count as python counts them,
  // a done line with real/tiny, timestamps in other spellings, a helper nobody linked.
  writeSession(ODD, 'ünï-0001-session', [
    human(t(0), `earlier ${SECRET}`),
    cmd(t(1), 'gsdt-batch', SECRET),
    asst(iso(NOW - 5 * 86400 + 120, '.123456Z'), 'm1', usage(1250, 1350, 2500, 1250, { cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 1250 } })),
    asst(`${iso(NOW - 5 * 86400 + 180, '')}+02:00`, 'm2', usage(5.0, true, -3, null), [spawn('tu1', 'gsd-planner', 'Plan 261109-aa1: x'), spawn('tu2', 'gsd-executor', 'Exec 261109-aa1: x'), spawn('tu3', 'Explore', 'nobody')]),
    result(t(4), 'tu1', 'h1'),
    result(t(4), 'tu2', 'h2'),
    asst(iso(NOW - 5 * 86400 + 300, '.1Z'), 'm3', usage(10, 20, 30, 40), [], `gsdt-batch: done items=7 real=5 tiny=2 ${SECRET}`),
    asst(iso(NOW - 5 * 86400 + 360, ''), 'm4', usage(1, 1, 1, 1)),
  ], {
    h1: { meta: { agentType: 'gsd-planner\n', model: 'opus', toolUseId: 'tu1' }, lines: [asst(t(3), 'ma', usage(100, 200, 300, 400), [['Bash', 'b1', {}]])] },
    h2: { meta: '{broken', lines: [asst(t(3), 'mb', usage(1, 2, 3, 4), [], undefined, '<synthetic>')] },
  });
  // /clear, next batch, QUICK BATCH COMPLETE, a nested helper, an item count from quick ids, a quick-batch run inside gsdt-batch.
  writeSession(ODD, 'bbbb-2', [
    cmd(t(0), 'gsd-quick-batch'),
    asst(t(1), 'q1', usage(1, 2, 3, 4), [spawn('p1', 'gsd-planner', 'Plan 261109-zz1: a'), spawn('p2', 'gsd-planner', 'Plan 261109-zz2: b')]),
    result(t(2), 'p1', 'n1'),
    result(t(2), 'p2', 'n2'),
    cmd(t(5), 'clear'),
    asst(t(6), 'q2', usage(50, 50, 50, 50)),
    { type: 'assistant', timestamp: t(7), message: { id: 'sk', content: [{ type: 'tool_use', id: 'sk1', name: 'Skill', input: { skill: 'gsd-core:gsd-quick-batch' } }], usage: usage(1, 1, 1, 1), model: 'claude-fable-5' } },
    asst(t(8), 'q3', usage(3, 3, 3, 3), [], 'GSD ► QUICK BATCH COMPLETE'),
    cmd(t(9), 'gsdt-batch'),
    cmd(t(10), 'gsd-quick-batch'),
    asst(t(11), 'q4', usage(7, 7, 7, 7), [spawn('p9', 'gsd-executor', 'Exec 261109-yy1: a')]),
    result(t(12), 'p9', 'n9'),
    asst('not a time', 'q5', usage(1, 1, 1, 1)),
    asst(undefined, 'q6', usage(1, 1, 1, 1)),
    cmd(t(13), 'gsdt-batch'),
  ], {
    n1: { meta: { agentType: 'gsd-planner', toolUseId: 'p1' }, lines: [asst(t(3), 'nm1', usage(10, 10, 10, 10), [spawn('inner', 'general-purpose', 'inner job')], undefined, 'gpt-weird'), result(t(3), 'inner', 'n3')] },
    n3: { meta: { agentType: 'general-purpose', model: 'haiku', toolUseId: 'inner' }, lines: [asst(t(4), 'nm3', usage(1, 1, 1, 1), [], undefined, undefined)] },
    n2: { meta: { agentType: 'gsd-planner', toolUseId: 'p2' }, lines: [] },
    n9: { meta: { toolUseId: 'p9', description: 'Exec 261109-yy2: a' }, lines: [asst(t(12), 'nm9', usage(2, 2, 2, 2))] },
  });
}
const EMPTY = path.join(W, 'empty');
mkdirSync(EMPTY);
writeFileSync(path.join(EMPTY, 'x.jsonl'), '');
const TZ_NY = { TZ: 'America/New_York' };

test('--help and every usage error', () => {
  const h = same(['--help']);
  assert.match(h.out, /^\n?gsdt-batch-report — /);
  same(['-h']);
  same(['--last']);
  same(['--days']);
  same(['--items']);
  same(['--last', 'x']);
  same(['--days', '1.5']);
  same(['--items', '-1']);
  same(['--last', '']);
  same(['--last', '2', '--days', '3']);
  same(['--days', '2', '--session', 'aa']);
  same(['--session', 'aa', '--last', '2']);
  same(['--session']);
  same(['--session', 'a_b']);
  same(['--session', '']);
  same(['--baseline']);
  same(['--baseline', path.join(W, 'nope.json')]);
  same(['--repo']);
  same(['--dir']);
  same(['--provider']);
  same(['--bogus']);
  same(['stray']);
  same(['--last', '1', '--help']);
  same(['--bogus', '--help']);
});

test('providers', () => {
  same(['--provider', 'codex']);
  same(['--provider', 'custom', '--dir', P]);
  same(['--provider', 'gemini']);
  same(['--provider', 'gemini', '--dir', P]);
  same(['--provider', 'nope']);
  same(['--provider', 'claude', '--dir', P]);
  same(['--provider', 'Claude', '--dir', P]);
});

test('folders: missing, empty, no batch', () => {
  const m = same(['--dir', path.join(W, 'nowhere')]);
  assert.match(m.out, /looked in /);
  same(['--dir', EMPTY]);
  same(['--dir', EMPTY, '--json']);
  same(['--dir', EMPTY, '--items', '3']);
  const nb = path.join(W, 'nobatch');
  writeSession(nb, 'cccc', [human(iso(NOW), 'hello'), asst(iso(NOW), 'a', usage(1, 1, 1, 1))]);
  same(['--dir', nb]);
  same(['--dir', nb, '--json']);
});

test('the generated fixture: text, json, selection', () => {
  const base = ['--dir', P];
  same(base);
  same([...base, '--json']);
  for (const n of ['1', '2', '3', '9', '0']) {
    same([...base, '--last', n]);
    same([...base, '--last', n, '--json']);
  }
  for (const d of ['0', '1', '3', '30']) {
    same([...base, '--days', d]);
    same([...base, '--days', d, '--json']);
  }
  same([...base, '--session', 'aaaa']);
  same([...base, '--session', 'aaaa1111-0000-4000-8000-000000000001', '--json']);
  same([...base, '--session', 'cccc', '--json']);
  same([...base, '--session', 'bbbb']);
  same([...base, '--session', 'zzzz']);
  same([...base, '--last', '9', '--items', '4']);
  same([...base, '--last', '9', '--items', '0']);
  same([...base, '--last', '9', '--items', '0', '--json']);
  same([...base, '--last', '9', '--items', '7', '--json']);
  same([...base, '--last', '9'], { env: TZ_NY });
  same([...base, '--last', '9', '--json'], { env: TZ_NY });
  same([...base, '--last', '9'], { env: { TZ: 'Asia/Kolkata' } });
});

test('baseline: a saved report, the built-in numbers, unreadable files', () => {
  const saved = run(BINS.neu, ['--dir', P, '--last', '9', '--json']).out;
  const f = path.join(W, 'saved.json');
  writeFileSync(f, saved);
  const t = same(['--dir', P, '--last', '9', '--baseline', f]);
  assert.match(t.out, /from a saved report/);
  same(['--dir', P, '--last', '1', '--baseline', f]);
  same(['--dir', P, '--last', '9', '--baseline', f, '--items', '3']);
  same(['--dir', P, '--last', '9', '--baseline', f, '--json']);
  const put = (name: string, body: string | Buffer): string => {
    const p = path.join(W, name);
    writeFileSync(p, body);
    return p;
  };
  for (const [name, body] of Object.entries({
    'b-empty.json': '',
    'b-bad.json': '{nope',
    'b-list.json': '[]',
    'b-nocombined.json': '{}',
    'b-noroles.json': '{"combined":{"items":2,"batches":1}}',
    'b-emptyroles.json': '{"combined":{"items":2,"batches":1,"roles":[]}}',
    'b-emptystr.json': '{"combined":{"items":2,"batches":1,"roles":""}}',
    'b-emptydict.json': '{"combined":{"items":2,"batches":1,"roles":{}}}',
    'b-dictroles.json': '{"combined":{"items":2,"batches":1,"roles":{"a":1}}}',
    'b-strroles.json': '{"combined":{"items":2,"batches":1,"roles":"ab"}}',
    'b-roles.json': '{"combined":{"items":"4","batches":1.9,"roles":[{"role":"gsd-planner","input":"1_000"},{"role":"gsd-planner","input":2.9},{"role":"x y","input":5},{"role":"coordinator","input":true}]}}',
    'b-zero.json': '{"combined":{"items":0,"batches":0,"roles":[{"role":"gsd-planner","input":5}]}}',
    'b-badinput.json': '{"combined":{"items":2,"batches":1,"roles":[{"role":"gsd-planner","input":null}]}}',
    'b-norole.json': '{"combined":{"items":2,"batches":1,"roles":[{"input":3}]}}',
    'b-nonint.json': '{"combined":{"items":"x","batches":1,"roles":[]}}',
    'b-big.json': '{"combined":{"items":3,"batches":2,"roles":[{"role":"gsd-executor","input":123456789012},{"role":"general-purpose","input":1}]}}',
  })) {
    same(['--dir', P, '--last', '9', '--baseline', put(name, body)]);
  }
  same(['--dir', P, '--last', '9', '--baseline', put('b-badutf.json', Buffer.from([0x7b, 0xff, 0x7d]))]);
  same(['--dir', P, '--last', '9', '--baseline', put('b-bom.json', '﻿{"combined":{"items":1,"batches":1,"roles":[]}}')]);
  same(['--dir', P, '--baseline', W]);
  // no batch found: the baseline is never read
  same(['--dir', EMPTY, '--baseline', put('b-bad2.json', '{')]);
});

test('odd transcripts: floats and bools, odd timestamps, ties, nesting, endings', () => {
  for (const extra of [[], ['--json'], ['--last', '9'], ['--last', '9', '--json'], ['--days', '30'], ['--days', '30', '--json'], ['--last', '9', '--items', '2']]) {
    same(['--dir', ODD, ...extra]);
    same(['--dir', ODD, ...extra], { env: TZ_NY });
  }
  // (--session with a non-ASCII id is not compared: bash's [!A-Za-z0-9-] glob is locale-dependent, the TS check is ASCII-only)
  assert.equal(run(BINS.neu, ['--dir', ODD, '--session', 'ünï']).rc, 64);
  same(['--dir', ODD, '--session', 'bbbb', '--last', '1']);
  same(['--dir', ODD, '--session', 'bbbb', '--json']);
  same(['--dir', ODD, '--last', '1', '--json']);
  same(['--dir', ODD, '--last', '2', '--json']);
});

test('SETTLED end, busy helper, later-finishing helper, wide timestamps', () => {
  const D = path.join(W, 'settled');
  const t = (m: number): string => iso(NOW - 3 * 3600 + 60 * m);
  writeSession(D, 's-1', [
    cmd(t(0), 'gsd-quick-batch'),
    asst(t(1), 'a1', usage(1, 1, 1, 1), [spawn('p1', 'gsd-planner', 'Plan 261109-aa1: x'), spawn('p2', 'gsd-planner', 'Plan 261109-aa2: x')]),
    result(t(1), 'p1', 'x1'),
    result(t(1), 'p2', 'x2'),
    human(t(5), 'wait, no executor yet'),
    asst(t(6), 'a2', usage(1, 1, 1, 1), [spawn('e1', 'gsd-executor', 'Exec 261109-aa1: x'), spawn('e2', 'gsd-executor', 'Exec 261109-aa2: x')]),
    result(t(6), 'e1', 'x3'),
    result(t(6), 'e2', 'x4'),
    human(t(8), 'a helper is still working'),
    asst(t(9), 'a3', usage(2, 2, 2, 2)),
    human(t(30), 'now it is settled'),
    asst(t(31), 'a4', usage(100, 100, 100, 100)),
  ], {
    x1: { meta: { agentType: 'gsd-planner', toolUseId: 'p1' }, lines: [asst(t(2), 'h1', usage(1, 1, 1, 1))] },
    x2: { meta: { agentType: 'gsd-planner', toolUseId: 'p2' }, lines: [asst(t(2), 'h2', usage(1, 1, 1, 1))] },
    x3: { meta: { agentType: 'gsd-executor', toolUseId: 'e1' }, lines: [asst(t(7), 'h3', usage(1, 1, 1, 1))] },
    x4: { meta: { agentType: 'gsd-executor', toolUseId: 'e2' }, lines: [asst(t(15), 'h4', usage(1, 1, 1, 1))] },
  });
  for (const extra of [[], ['--json']]) same(['--dir', D, ...extra]);
});

test('a numbers table with big values (G, M, k, round-half-even)', () => {
  const D = path.join(W, 'big');
  const t = (m: number): string => iso(NOW - 3600 + 60 * m);
  const lines: Line[] = [cmd(t(0), 'gsdt-batch')];
  const vals = [999, 1000, 1049, 1050, 1150, 99949, 99950, 100500, 999999, 12345678, 123456789, 2500000000, 1250000000, 99.5];
  vals.forEach((v, i) => lines.push(asst(t(i + 1), `m${i}`, usage(v, Math.round(v / 2), v * 3, v, { cache_creation: { ephemeral_1h_input_tokens: Math.round(v / 4) } }), [['Bash', `b${i}`, {}]])));
  lines.push(asst(t(20), 'done', usage(0, 0, 0, 0), [], 'gsdt-batch: done items=0'));
  writeSession(D, 'big-1', lines);
  for (const extra of [[], ['--json'], ['--items', '3'], ['--items', '7', '--json'], ['--items', '1']]) same(['--dir', D, ...extra]);
});

test('no transcript text reaches the output', () => {
  for (const d of [P, ODD]) {
    for (const args of [[], ['--json'], ['--last', '9'], ['--last', '9', '--json']]) {
      const r = run(BINS.neu, ['--dir', d, ...args]);
      assert.ok(!r.out.includes(SECRET) && !r.err.includes(SECRET) && !r.out.includes('SECRET-TEXT-42'));
    }
  }
});

test('--repo, --dir, CLAUDE_CONFIG_DIR, the projdir rule', () => {
  const R = path.join(W, 'my repo.x');
  mkdirSync(R);
  spawnSync('git', ['init', '-q', R]);
  const H = path.join(W, 'claudehome');
  mkdirSync(path.join(H, 'projects'), { recursive: true });
  const name = (p: string): string => p.replace(/[^A-Za-z0-9]/gu, '-');
  symlinkSync(P, path.join(H, 'projects', name(R)));
  const env = { CLAUDE_CONFIG_DIR: H };
  same(['--last', '9', '--json'], { cwd: R, env });
  same(['--last', '9'], { cwd: R, env });
  same(['--repo', R, '--last', '9', '--json'], { env });
  same(['--repo', R, '--last', '9'], { env, cwd: path.join(W, 'home') });
  same(['--repo', path.join(W, 'nothing')], { env });
  same(['--repo', R], { env: { CLAUDE_CONFIG_DIR: path.join(W, 'nohome') } });
  same(['--repo', R, '--dir', P, '--last', '1']); // --dir wins; --repo is not even looked at
  same(['--repo', path.join(W, 'nothing'), '--dir', P, '--last', '1']);
  same(['--repo', R + '/'], { env });
  same(['--repo', path.join(R, '..', 'my repo.x')], { env });
  // a relative --repo and an empty one
  same(['--repo', 'my repo.x', '--last', '1'], { env, cwd: W });
  same(['--repo', ''], { env, cwd: R });
  // a symlinked spelling of the same folder: Claude names the folder after the spelling it was started in
  const link = path.join(W, 'link-to-repo');
  symlinkSync(R, link);
  symlinkSync(P, path.join(H, 'projects', name(link)));
  same(['--last', '9'], { cwd: link, env: { ...env, PWD: link } });
  same(['--repo', R, '--last', '9'], { cwd: link, env: { ...env, PWD: link } });
  same(['--repo', link, '--last', '9'], { cwd: R, env: { ...env, PWD: R } });
  // HOME default (~/.claude)
  mkdirSync(path.join(W, 'home', '.claude', 'projects'), { recursive: true });
  symlinkSync(P, path.join(W, 'home', '.claude', 'projects', name(R)));
  same(['--repo', R, '--last', '9']);
  same(['--repo', R, '--last', '9'], { env: { CLAUDE_CONFIG_DIR: '' } });
  // a trailing slash in CLAUDE_CONFIG_DIR
  same(['--repo', R, '--last', '9'], { env: { CLAUDE_CONFIG_DIR: `${H}/` } });
  // a long path: the folder is found by its first 200 characters + a hash suffix
  const long = `/${'x'.repeat(230)}`;
  const lname = name(long);
  const LR = path.join(W, 'long-home');
  mkdirSync(path.join(LR, 'projects', `${lname.slice(0, 200)}-abc123`), { recursive: true });
  mkdirSync(path.join(LR, 'projects', `${lname.slice(0, 200)}-abc000`), { recursive: true });
  // the repo itself must exist: run from a folder with that long a name when the OS allows it
  const longDir = path.join(W, 'l'.repeat(200));
  mkdirSync(longDir, { recursive: true });
  const ldn = name(longDir);
  assert.ok(ldn.length > 200 || true);
  const hashed = path.join(LR, 'projects', `${ldn.slice(0, 200)}-h4sh`);
  mkdirSync(hashed, { recursive: true });
  symlinkSync(P, path.join(hashed, 'x'));
  same(['--repo', longDir], { env: { CLAUDE_CONFIG_DIR: LR } });
  same(['--repo', longDir, '--json'], { env: { CLAUDE_CONFIG_DIR: LR } });
});

test('projdir() of the engine: the long path rule, first spelling when none exists', async () => {
  const { projdir } = await import('../../src/batch-report.ts');
  const H = path.join(W, 'ph');
  const long = `/${'x'.repeat(230)}`;
  const lname = long.replace(/[^A-Za-z0-9]/gu, '-');
  mkdirSync(path.join(H, 'projects', `${lname.slice(0, 200)}-abc123`), { recursive: true });
  assert.equal(projdir(H, [long]), path.join(H, 'projects', `${lname.slice(0, 200)}-abc123`));
  assert.equal(projdir(H, ['/no/such dir']), path.join(H, 'projects', '-no-such-dir'));
  // the same call through the old python
  const old = spawnSync('python3', [path.join(OLDPKG, 'lib', 'gsd_batch_report.py'), 'projdir', '--home', H, '--repo', long, '--repo', '/no/such dir'], { encoding: 'utf8' });
  assert.equal(old.stdout.trim(), projdir(H, [long, '/no/such dir']));
  const old2 = spawnSync('python3', [path.join(OLDPKG, 'lib', 'gsd_batch_report.py'), 'projdir', '--home', H, '--repo', '/no/such dir'], { encoding: 'utf8' });
  assert.equal(old2.stdout.trim(), projdir(H, ['/no/such dir']));
});

test('the launcher: no node on PATH', () => {
  const r = spawnSync('/bin/bash', [BINS.neu, '--help'], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'gsdt-batch-report: needs Node.js >= 24 (node not found on PATH)\n');
});
