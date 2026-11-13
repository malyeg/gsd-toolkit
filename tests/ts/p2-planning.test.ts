// P2 parity (planning): src/planning.ts + src/commands/planning*.ts against
// lib/gsd_planning.py (the oracle) and the pre-P2 bash bins
// (tests/fixtures/p2-old-bins/). Same inputs side by side: stdout, stderr,
// exit status and the resulting file bytes must match.
// Run: node --test 'tests/ts/*.test.ts'
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main as planningMain, parseArgs } from '../../src/commands/planning.ts';
import { PKG, tmp, write } from './helpers.ts';

const PY = path.join(PKG, 'lib', 'gsd_planning.py');
const LAUNCH = path.join(PKG, 'src', 'launch.mjs');
const FIX = path.join(PKG, 'tests', 'fixtures');
const OLD_BINS = path.join(FIX, 'p2-old-bins');
delete process.env.COLUMNS;
// --commit makes its own commit: give git a name (a Linux runner has none and git cannot guess one)
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });

type R = { out: string; err: string; rc: number };
const run = (cmd: string, args: string[], cwd?: string, env?: Record<string, string>): R => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { out: r.stdout ?? '', err: r.stderr ?? '', rc: r.status ?? 1 };
};
const py = (args: string[], cwd?: string): R => run('python3', ['-I', PY, ...args], cwd);
const ts = (args: string[], cwd?: string): R => run('node', [LAUNCH, 'planning', ...args], cwd);

/** every file under dir → bytes (base64), by relative path */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d).sort()) {
      const p = path.join(d, n);
      if (n === '.git') continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p)] = readFileSync(p).toString('base64');
    }
  };
  walk(dir);
  return out;
}

type Files = Record<string, string | Buffer>;
/** two identical .planning trees (one per engine) */
function twin(files: Files): [string, string] {
  const base = tmp();
  const dirs = [path.join(base, 'py'), path.join(base, 'ts')] as [string, string];
  for (const d of dirs) for (const [rel, body] of Object.entries(files)) write(path.join(d, rel), body as string);
  return dirs;
}

/** engine `args` (a function of the tree root) on both twins; everything must match */
function same(label: string, files: Files, args: (root: string) => string[], cwdOf: (root: string) => string = (r) => r): R {
  const [a, b] = twin(files);
  const ra = py(args(a), cwdOf(a));
  const rb = ts(args(b), cwdOf(b));
  // paths in messages differ per twin
  const norm = (r: R, root: string): R => ({ ...r, out: r.out.split(root).join('<root>'), err: r.err.split(root).join('<root>') });
  if (ra.err.startsWith('Traceback')) {
    // a Python traceback (missing/unreadable file): the TS gives a one-line error, same status
    assert.equal(rb.rc, ra.rc, `${label}: rc`);
    assert.equal(rb.out, ra.out, `${label}: stdout`);
    assert.notEqual(rb.err, '', `${label}: says something`);
  } else {
    assert.deepEqual(norm(rb, b), norm(ra, a), `${label}: stdout/stderr/rc`);
  }
  assert.deepEqual(snapshot(b), snapshot(a), `${label}: files`);
  return ra;
}

const read = (f: string): string => readFileSync(f, 'utf8');
const ROADMAP_FIX = ['2026-08-02', 'phase-11-merge'].map((n) => [n, read(path.join(FIX, n, 'ROADMAP.md')), read(path.join(FIX, n, 'STATE.md'))] as const);

const ROADMAP = `# Roadmap

## Phases

- [x] **Phase 1: Alpha** - first (completed 2026-01-01)
- [ ] **Phase 2: Beta** - second
- [ ] **Phase 3: Gamma**

## Progress

| Phase | Plans | Status | Completed |
|-------|-------|--------|-----------|
| 1. Alpha | 1/1 | Complete | 2026-01-01 |
| 2. Beta | 0/1 | Not started | - |

### Phase 1: Alpha

**Goal**: a

### Phase 2: Beta

**Goal**: b
`;
const STATE = `---
gsd_state_version: 1.0
status: planning
last_updated: "2026-08-05T09:34:25.661Z"
progress:
  total_phases: 3
  completed_phases: 1
  total_plans: 2
  completed_plans: 2
  percent: 33
---

# Project State

**Current focus:** Phase 2 — beta

## Current Position

Phase: 2
Plan: Not started
Status: Ready
Progress: [███░░░░░░░] 33%

## Performance Metrics

- Total plans completed: 2
- Average duration: 4 min

| Phase | Plans | Total |
|-------|-------|-------|
| 1 | 2 | 8 min |

## Session Continuity

Last session: 2026-08-01
Stopped at: Phase 1
Last session: 2026-08-02
Stopped at: Phase 2
`;
const PLAN_FILES: Files = {
  '.planning/phases/01-alpha/01-01-PLAN.md': 'p',
  '.planning/phases/01-alpha/01-01-SUMMARY.md': 's',
  '.planning/phases/01-alpha/01-02-PLAN.md': 'p',
  '.planning/phases/02-beta/02-01-PLAN.md': 'p',
};

// ── the real fixtures ───────────────────────────────────────────────────────

test('repair / --check on the shipped fixtures', () => {
  for (const [name, roadmap, state] of ROADMAP_FIX) {
    const plans = read(path.join(FIX, name, 'plans.txt'));
    const files: Files = { '.planning/ROADMAP.md': roadmap, '.planning/STATE.md': state };
    // plans.txt lists "dir<TAB>PLAN or SUMMARY"-like names; make the same count of plan files
    const m = /(\d+)/.exec(plans);
    if (m) for (let i = 0; i < Math.min(Number(m[1]), 40); i++) files[`.planning/phases/p${i % 7}/x${i}-PLAN.md`] = 'p';
    for (const mode of [[], ['--check']]) {
      same(`${name} ${mode.join('')}`, files, (r) => ['repair', ...mode, `${r}/.planning`]);
    }
    for (const f of ['ROADMAP.md', 'STATE.md']) {
      same(`${name} reconcile ${f}`, files, (r) => ['reconcile', `${r}/.planning/${f}`]);
      same(`${name} reconcile --path ${f}`, files, (r) => ['reconcile', `${r}/.planning/x.tmp`, '--path', `.planning/${f}`]);
    }
  }
});

// ── crafted inputs ──────────────────────────────────────────────────────────

const roadmapCases: Record<string, string> = {
  clean: ROADMAP,
  crlf: ROADMAP.replace(/\n/g, '\r\n'),
  'lone CR': ROADMAP.replace(/\n/g, '\r'),
  'no trailing newline': ROADMAP.replace(/\n$/, ''),
  empty: '',
  'only newline': '\n',
  'union damage': ROADMAP.replace('- [ ] **Phase 2: Beta** - second', '- [ ] **Phase 2: Beta** - second\n- [x] **Phase 2: Beta** - second (completed 2026-02-02)').replace(
    '| 2. Beta | 0/1 | Not started | - |',
    '| 2. Beta | 0/1 | Not started | - |\n| 2. Beta | 1/1 | Complete | 2026-02-02 |',
  ) + '\n### Phase 2: Beta\n\n**Goal**: b, longer text here\n',
  'zero padded + decimal': `## Phases\n- [ ] **Phase 02: Two**\n- [x] **Phase 2.1: Ins**\n- [x] **Phase 08: Eight**\n- [ ] **Phase 8.10: x**\n- [ ] **Phase 8.9: y**\n\n## Progress\n| 02. Two | 0/1 | Not started | - |\n| 2.1 Ins | 1/1 | Complete | d |\n\n### Phase 02: Two\nz\n### Phase 2: Two again\n### Phase 02: Two\nlonger longer\n`,
  'gaps sorted': '## Phases\n- [ ] **Phase 10: a**\n- [ ] **Phase 9: b**\n- [ ] **Phase 9.5: c**\n- [ ] **Phase 2: d**\n\n## Progress\n| Phase | x |\n',
  'progress without table': '## Phases\n- [ ] **Phase 1: a**\n## Progress\n',
  'rank ties and statuses': '## Progress\n| 1. a | 2/3 | In progress |\n| 1. a | 3/3 | Complete |\n| 1. a | 1/3 | Blocked |\n| 2 b | x | - |\n| 2 b | x | whatever |\n| 3 c |\n| 3 c | 0/1 | not started |\n',
  'checklist rank': '- [X] **Phase 1: a**\n- [ ] **Phase 1: a, much longer than the other**\n- [x] **Phase 1: a**\n- [ ] **Phase 1x: no boundary**\n- [ ] **Phase 1.x: boundary**\n- [ ] **Phase 1.5.2: more**\n',
  'unicode digits and word boundary': '- [ ] **Phase ٣: arabic**\n- [x] **Phase ٣: arabic**\n- [ ] **Phase 4é: no boundary**\n- [ ] **Phase 5_: no boundary**\n## Progress\n| ٣. x | 1/1 | Complete |\n',
  'astral and cjk lengths': '- [ ] **Phase 1: 😀😀😀**\n- [ ] **Phase 1: ab**\n- [ ] **Phase 2: 日本語日本語**\n- [ ] **Phase 2: abcdefghijkl**\n',
  'exotic line breaks': '- [ ] **Phase 1: a** - [x] **Phase 1: b**\v- [ ] **Phase 2: c**\f## Progress\x1c| 1 a | 1/1 | Complete |\x85| 1 a | 0/1 | Not started |\n',
  'BOM and tabs': '﻿- [ ] **Phase 1: a**\n\t## Progress\n| 1\t. a | 1/1 | Complete |\n|\t1 a | 0/1 | x |\n',
  'headings of every level': '## Progress\n| 1 a | 1/1 | Complete |\n#### Phase 1\n| 1 a | 0/1 | Complete |\n### Phase 1: z\n| 1 a | 0/1 | Complete |\n',
  'progress prefix words': '## Progressive\n| 1 a | 1/1 | Complete |\n| 1 a | 1/1 | Complete |\n',
  'no phases': '# Roadmap\n\nNothing yet.\n',
};

test('ROADMAP.md: reconcile, repair and --check on crafted inputs', () => {
  for (const [name, roadmap] of Object.entries(roadmapCases)) {
    const files: Files = { '.planning/ROADMAP.md': roadmap, '.planning/STATE.md': STATE, ...PLAN_FILES };
    same(`roadmap ${name}: repair`, files, (r) => ['repair', `${r}/.planning`]);
    same(`roadmap ${name}: check`, files, (r) => ['repair', '--check', `${r}/.planning`]);
    same(`roadmap ${name}: reconcile`, files, (r) => ['reconcile', `${r}/.planning/ROADMAP.md`]);
  }
});

const stateCases: Record<string, string> = {
  clean: STATE,
  crlf: STATE.replace(/\n/g, '\r\n'),
  'no trailing newline': STATE.replace(/\n$/, ''),
  'no frontmatter': STATE.replace(/^---[\s\S]*?---\n/, ''),
  'unterminated frontmatter': STATE.replace(/\n---\n/, '\n'),
  'two frontmatter blocks of counters': STATE.replace('percent: 33\n', 'percent: 33\n  total_phases: 30\n  completed_phases: 12\n  total_plans: 96\n  completed_plans: 96\n  percent: 40\n'),
  'conflicting scalars': STATE.replace('status: planning\n', 'status: planning\nstatus: ready\nlast_updated: 2026-09-01\nlast_updated: "2026-07-01"\n'),
  'quoted values': STATE.replace('status: planning', "status: 'planning'\nstatus: \"planning\""),
  'list and comment in frontmatter': STATE.replace('status: planning\n', 'status: planning\n# a comment\nitems:\n  - one\n  - two\n\n'),
  'duplicate position and velocity': STATE.replace('Phase: 2\n', 'Phase: 2\nPhase: 3\nStatus: Done\n').replace('- Average duration: 4 min\n', '- Average duration: 4 min\n- Average duration: 9 min\n- Total plans completed: 7\n- Trend: up\n- Trend: down\n'),
  'duplicate focus': STATE.replace('**Current focus:** Phase 2 — beta\n', '**Current focus:** Phase 2 — beta\n**Current focus:** Phase 3 — gamma\n'),
  'by-phase duplicates': STATE.replace('| 1 | 2 | 8 min |\n', '| 1 | 2 | 8 min |\n| 1 | 3 | 8 min |\n| 1 | 3 | 9 minutes |\n| 02 | 1/2 | x |\n'),
  'progress line forms': STATE.replace('Progress: [███░░░░░░░] 33%\n', 'Progress: [██░░░░░░░░] 20% (1 of 5 phases complete)\n'),
  'progress line odd': STATE.replace('Progress: [███░░░░░░░] 33%\n', 'Progress: oddly shaped\n'),
  'progress line extra text': STATE.replace('Progress: [███░░░░░░░] 33%\n', 'Progress: [█░░░░░░░░░] 9%  extra words (1 of 2 phases complete) more\n'),
  'orphan rows': STATE + '\n| stray | row |\n\n| stray2 | row ' + 'x'.repeat(80) + ' |\n| a |\n| b |\n',
  'orphan row at eof no newline': STATE + '| lonely',
  'session continuity untouched': STATE + 'Phase: 9\nStatus: z\nProgress: [░░░░░░░░░░] 0%\nLast session: 2026-08-03\n',
  'metrics heading then others': '## Performance Metrics\n- Total plans completed: 9\n## Other\n- Total plans completed: 8\n',
  'zero plans claims': STATE.replace('completed_plans: 2', 'completed_plans: 5').replace('total_plans: 2', 'total_plans: 5').replace('- Total plans completed: 2', '- Total plans completed: 5'),
  'empty': '',
  'only frontmatter': '---\na: 1\na: 2\n---\n',
  'frontmatter spaces': '  ---  \nkey:   spaced   \n---\t\nbody\n',
  'unicode keys': '---\nclé: 1\nclé: 2\nstatus:\nstatus: x\n---\n',
  'exotic breaks in frontmatter': '---\nstatus: a status: b\x85progress:\n  percent: 1\v  percent: 2\n---\n',
  'last_updated unicode order': '---\nlast_updated: "😀"\nlast_updated: "￮"\n---\n',
  'huge ints': '---\nprogress:\n  total_phases: 99999999999999999999\n  total_phases: 5\n  percent: -7\n  percent: 3\n---\n',
  'unicode digits in counters': '---\nprogress:\n  total_plans: ٣\n  total_plans: 2\n  completed_plans: 0\n---\n## Performance Metrics\n- Total plans completed: ٣\n',
};

test('STATE.md: reconcile, repair and --check on crafted inputs', () => {
  for (const [name, state] of Object.entries(stateCases)) {
    for (const plans of [PLAN_FILES, {}]) {
      const files: Files = { '.planning/ROADMAP.md': ROADMAP, '.planning/STATE.md': state, ...plans };
      const tag = Object.keys(plans).length ? 'with plans' : 'no phases dir';
      same(`state ${name} (${tag}): repair`, files, (r) => ['repair', `${r}/.planning`]);
      same(`state ${name} (${tag}): check`, files, (r) => ['repair', '--check', `${r}/.planning`]);
    }
    same(`state ${name}: reconcile`, { '.planning/STATE.md': state }, (r) => ['reconcile', `${r}/.planning/STATE.md`]);
  }
});

test('STATE.md: Session Continuity stays byte-identical, repeated lines kept', () => {
  const files: Files = { '.planning/ROADMAP.md': ROADMAP, '.planning/STATE.md': STATE, ...PLAN_FILES };
  const [, b] = twin(files);
  assert.equal(ts(['repair', `${b}/.planning`]).rc, 0);
  const after = read(path.join(b, '.planning/STATE.md'));
  const tail = (s: string): string => s.slice(s.indexOf('## Session Continuity'));
  assert.equal(tail(after), tail(STATE));
});

test('percent rounding is half-to-even like Python round()', () => {
  // 1 of 8 = 12.5 -> 12 ; 3 of 8 = 37.5 -> 38 ; bar: 12 -> round(1.2)=1, 25-> round(2.5)=2, 35 -> 4
  for (const [done, total] of [[1, 8], [3, 8], [5, 8], [7, 8], [1, 40], [7, 20], [1, 3], [2, 3], [0, 5], [5, 5], [1, 7]] as const) {
    let roadmap = '## Phases\n';
    for (let i = 1; i <= total; i++) roadmap += `- [${i <= done ? 'x' : ' '}] **Phase ${i}: p${i}**\n`;
    roadmap += '\n## Progress\n';
    const state = '---\nprogress:\n  percent: 1\n---\n\n## Current Position\nProgress: [░░░░░░░░░░] 1%\n';
    same(`${done}/${total}`, { '.planning/ROADMAP.md': roadmap, '.planning/STATE.md': state }, (r) => ['repair', `${r}/.planning`]);
  }
});

test('repair: missing files, directories and path spellings', () => {
  const some: Files = { '.planning/ROADMAP.md': ROADMAP, '.planning/STATE.md': STATE };
  same('no ROADMAP.md', { '.planning/STATE.md': STATE }, (r) => ['repair', `${r}/.planning`]);
  same('no STATE.md', { '.planning/ROADMAP.md': ROADMAP }, (r) => ['repair', `${r}/.planning`]);
  same('no STATE.md --check', { '.planning/ROADMAP.md': ROADMAP + '- [x] **Phase 2: Beta**\n' }, (r) => ['repair', '--check', `${r}/.planning`]);
  same('missing dir', {}, (r) => ['repair', `${r}/nothere`]);
  same('relative dir', some, () => ['repair', '.planning'], (r) => r);
  same('trailing slash', some, (r) => ['repair', `${r}/.planning/`]);
  same('double slash', some, (r) => ['repair', `${r}//.planning//`]);
  same('dot components', some, (r) => ['repair', `${r}/./.planning/.`]);
  same('dot dot', some, (r) => ['repair', `${r}/.planning/../.planning`]);
  same('empty string', some, () => ['repair', ''], (r) => path.join(r, '.planning'));
  same('dot', some, () => ['repair', '.'], (r) => path.join(r, '.planning'));
  same('phases dir with odd names', { ...some, '.planning/phases/.hidden/a-PLAN.md': 'x', '.planning/phases/x/-PLAN.md': '', '.planning/phases/x/PLAN.md': '', '.planning/phases/x/a-PLAN.md.bak': '', '.planning/phases/loose-PLAN.md': '', '.planning/phases/y/z/q-PLAN.md': '' }, (r) => ['repair', `${r}/.planning`]);
  same('reconcile: not a planning file', { 'x/NOTES.md': 'a\na\n' }, (r) => ['reconcile', `${r}/x/NOTES.md`]);
  same('reconcile: missing non-planning file', {}, (r) => ['reconcile', `${r}/nothing.md`]);
  same('reconcile: --path hint wins', { 'x/NOTES.md': '- [ ] **Phase 1: a**\n- [x] **Phase 1: a**\n' }, (r) => ['reconcile', `${r}/x/NOTES.md`, '--path', 'a/b/ROADMAP.md']);
  same('reconcile: empty --path falls back to the name', { 'x/ROADMAP.md': '- [ ] **Phase 1: a**\n- [x] **Phase 1: a**\n' }, (r) => ['reconcile', `${r}/x/ROADMAP.md`, '--path=']);
  same('reconcile: --path to other kind', { 'x/f.md': '---\na: 1\na: 2\n---\n' }, (r) => ['reconcile', `${r}/x/f.md`, '--path', 'STATE.md']);
});

test('invalid UTF-8: both fail with status 1 (messages differ: no traceback here)', () => {
  const bad = Buffer.concat([Buffer.from('- [ ] **Phase 1: a'), Buffer.from([0xff, 0xfe]), Buffer.from('**\n')]);
  const [a, b] = twin({ '.planning/ROADMAP.md': bad, '.planning/STATE.md': STATE });
  const ra = py(['repair', `${a}/.planning`]);
  const rb = ts(['repair', `${b}/.planning`]);
  assert.equal(rb.rc, ra.rc);
  assert.equal(rb.out, ra.out);
  assert.deepEqual(snapshot(b), snapshot(a));
});

// ── randomized damage ───────────────────────────────────────────────────────

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const roadmapPool = [
  '- [x] **Phase 02: Zero**\n',
  '- [ ] **Phase 2.1: Dec** - text\n',
  '- [ ] **Phase 7: Seven**\n',
  '| 02. Zero | 1/1 | Complete | 2026 |\n',
  '| 2.1 Dec | 0/2 | In progress | - |\n',
  '| 7. Seven | 0/1 | Not started | - |\n',
  '### Phase 7: Seven\n\nbody\n',
  '### Phase 02: Zero\n\nlonger body body\n',
  '\n',
  '## Progress\n',
  '## Phases\n',
  '| orphan |\n',
];
const statePool = [
  'Phase: 3\n',
  'Status: Executing\n',
  'Progress: [█████░░░░░] 50% (5 of 10 phases complete)\n',
  '- Total plans completed: 12\n',
  '- Trend: flat\n',
  '| 3 | 2 | 5 min |\n',
  '| 3 | 1/2 | 5 min |\n',
  '**Current focus:** Phase 9\n',
  'last_updated: 2026-12-01\n',
  '  percent: 77\n',
  '  total_plans: 4\n',
  'status: other\n',
  'Last session: x\n',
  '| orphan row |\n',
];
function mutate(rand: () => number, text: string, pool: string[]): string {
  const lines = text.split(/(?<=\n)/);
  const n = 1 + Math.floor(rand() * 6);
  for (let k = 0; k < n; k++) {
    const i = Math.floor(rand() * lines.length);
    const op = Math.floor(rand() * 6);
    if (op === 0) lines.splice(i, 0, lines[i] ?? '');
    else if (op === 1) lines.splice(i, 0, (lines[i] ?? '').replace(/\[( |x)\]/, (_m, c) => (c === ' ' ? '[x]' : '[ ]')));
    else if (op === 2) lines.splice(i, 1);
    else if (op === 3) lines.splice(i, 0, pool[Math.floor(rand() * pool.length)] as string);
    else if (op === 4) lines.splice(i, 0, (lines[i] ?? '').replace(/Not started|In progress|Complete|\d+/, (m) => (/\d/.test(m) ? String(Number(m) + 1) : 'Complete')));
    else lines.splice(i, 0, (lines[Math.floor(rand() * lines.length)] ?? '') + 'extra tail words');
  }
  let out = lines.join('');
  const r = rand();
  if (r < 0.15) out = out.replace(/\n/g, '\r\n');
  else if (r < 0.25) out = out.replace(/\n$/, '');
  return out;
}

test('randomized union damage: 80 mutated roadmap/state pairs', () => {
  const rand = lcg(20261110);
  const bases: [string, string][] = [
    [ROADMAP, STATE],
    ...ROADMAP_FIX.map(([, r, s]): [string, string] => [r, s]),
  ];
  for (let n = 0; n < 80; n++) {
    const [r0, s0] = bases[n % bases.length] as [string, string];
    const files: Files = { '.planning/ROADMAP.md': mutate(rand, r0, roadmapPool), '.planning/STATE.md': mutate(rand, s0, statePool), ...(n % 3 ? PLAN_FILES : {}) };
    same(`random ${n} repair`, files, (r) => ['repair', `${r}/.planning`]);
    same(`random ${n} check`, files, (r) => ['repair', '--check', `${r}/.planning`]);
    same(`random ${n} reconcile state`, files, (r) => ['reconcile', `${r}/.planning/STATE.md`]);
    same(`random ${n} reconcile roadmap`, files, (r) => ['reconcile', `${r}/.planning/ROADMAP.md`]);
  }
});

test('repair is idempotent and --check agrees with a real repair', () => {
  for (const [, roadmap, state] of ROADMAP_FIX) {
    const [, b] = twin({ '.planning/ROADMAP.md': roadmap, '.planning/STATE.md': state });
    const chk = ts(['repair', '--check', `${b}/.planning`]);
    const first = ts(['repair', `${b}/.planning`]);
    assert.equal(chk.rc, 1);
    assert.equal(first.rc, 0);
    const second = ts(['repair', '--check', `${b}/.planning`]);
    assert.equal(second.rc, 0);
    assert.doesNotMatch(second.out, /repaired union-merge damage|union-merge damage found/);
  }
});

// ── command line ────────────────────────────────────────────────────────────

test('engine CLI: argv, usage, --help and errors match argparse', () => {
  const cases: string[][] = [
    [], ['--help'], ['-h'], ['--h'], ['--he'], ['-hx'], ['--help=x'], ['bogus'], ['rep'], ['recon'], ['repair'], ['reconcile'],
    ['reconcile', '-h'], ['repair', '--help'], ['repair', '-h', 'x'], ['reconcile', 'f', '--path'], ['reconcile', '--path'],
    ['reconcile', '--path', '-x', 'f'], ['reconcile', '--path', '--', 'f'], ['reconcile', '--path', '-1', 'f'], ['reconcile', '--path', 'a b', 'f'],
    ['repair', 'a', 'b'], ['repair', '--bad', 'x'], ['repair', '-c', 'd'], ['repair', 'd', '--check=1'], ['repair', 'd', '--check='],
    ['repair', 'd', '--ch'], ['repair', '--che', 'd'], ['reconcile', 'f', '--pa', 'x'], ['reconcile', 'f', '--path=x', 'extra'],
    ['reconcile', '--', 'f'], ['repair', '--', '--check'], ['repair', '--', '-d'], ['repair', '-1'], ['repair', '-1.5'], ['repair', '-'], ['repair', 'a b'],
    ['--bad', 'repair', 'd'], ['-x'], ['--', 'repair', 'd'], ['repair', '--check', '--check', 'nonexistent-dir'], ['reconcile', 'f', '--path', 'x', '--path', 'y'],
    ['reconcile', '--path=ROADMAP.md', 'missing-file.md'], ['reconcile', 'a', '--bogus', 'b'], ['repair', '--unknown=1', 'nonexistent-dir'],
  ];
  const cwd = tmp();
  for (const c of cases) {
    const a = py(c, cwd);
    const b = ts(c, cwd);
    if (c[0] === 'reconcile' && c.some((x) => x.startsWith('missing-file'))) {
      assert.equal(b.rc, a.rc, `rc of ${JSON.stringify(c)}`); // python prints a traceback here
      continue;
    }
    // older argparse (3.12.3) reads a `--` before the command as the command; newer ones skip it, as the new side does
    if (c[0] === '--' && a.err.includes("invalid choice: '--'")) continue;
    // argparse's wording of a bad choice changes with the python version: 3.12.x
    // quotes the choices or not, 3.15 adds "maybe you meant"; the new side
    // prints 3.15's. Only those two parts are evened out.
    assert.deepEqual({ ...b, err: argparseWording(b.err) }, { ...a, err: argparseWording(a.err) }, `argv ${JSON.stringify(c)}`);
  }
});

function argparseWording(s: string): string {
  return s.replace(/, maybe you meant '[^']*'\?/g, '').replace(/\(choose from ([^)]*)\)/g, (_m, l: string) => `(choose from ${l.replace(/'/g, '')})`);
}

test('parseArgs / main are importable and do no work at import time', () => {
  assert.deepEqual(parseArgs(['repair', '--check', 'd']), { cmd: 'repair', planning: 'd', check: true });
  assert.deepEqual(parseArgs(['reconcile', 'f', '--path', 'p']), { cmd: 'reconcile', file: 'f', path: 'p' });
  assert.equal(typeof planningMain, 'function');
});

// ── old bash bins vs the new launchers ──────────────────────────────────────

/** a package dir with the OLD bins next to a copy of lib/ (they source lib/common.sh and run lib/gsd_planning.py) */
function oldPackage(): string {
  const d = path.join(tmp(), 'old-pkg');
  mkdirSync(path.join(d, 'bin'), { recursive: true });
  cpSync(path.join(PKG, 'lib'), path.join(d, 'lib'), { recursive: true });
  for (const n of ['gsdt-planning-repair', 'gsdt-planning-merge']) {
    copyFileSync(path.join(OLD_BINS, n), path.join(d, 'bin', n));
    chmodSync(path.join(d, 'bin', n), 0o755);
  }
  return d;
}
const OLD = oldPackage();
const oldBin = (n: string): string => path.join(OLD, 'bin', n);
const newBin = (n: string): string => path.join(PKG, 'bin', n);

function git(cwd: string, args: string[]): R {
  return run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], cwd);
}
function gitRepo(files: Files): string {
  const d = path.join(tmp(), 'r');
  mkdirSync(d, { recursive: true });
  git(d, ['init', '-q', '-b', 'main']);
  for (const [rel, body] of Object.entries(files)) write(path.join(d, rel), body as string);
  git(d, ['add', '-A']);
  git(d, ['commit', '-q', '-m', 'base']);
  return d;
}

/** old and new bin on identical repos; stdout/stderr/rc and files must match */
function binSame(label: string, bin: string, files: Files, args: (repo: string) => string[], opts: { cwd?: (repo: string) => string; after?: (repo: string) => string } = {}): R {
  const a = gitRepo(files);
  const b = gitRepo(files);
  const ra = run(oldBin(bin), args(a), opts.cwd ? opts.cwd(a) : a);
  const rb = run(newBin(bin), args(b), opts.cwd ? opts.cwd(b) : b);
  const norm = (r: R, repo: string): R => ({ ...r, out: r.out.split(repo).join('<repo>'), err: r.err.split(repo).join('<repo>') });
  assert.deepEqual(norm(rb, b), norm(ra, a), `${label}: stdout/stderr/rc`);
  assert.deepEqual(snapshot(b), snapshot(a), `${label}: files`);
  if (opts.after) assert.equal(opts.after(b), opts.after(a), `${label}: after`);
  return ra;
}

const dirty: Files = { '.planning/ROADMAP.md': roadmapCases['union damage'] as string, '.planning/STATE.md': STATE, ...PLAN_FILES };
const headSubject = (repo: string): string => git(repo, ['log', '-1', '--format=%s%n%b']).out + git(repo, ['status', '--porcelain']).out + git(repo, ['show', '--stat', '--format=', 'HEAD']).out;

test('gsdt-planning-repair: old bash vs launcher', () => {
  const repo = (r: string): string[] => ['--repo', r];
  binSame('--help', 'gsdt-planning-repair', dirty, () => ['--help']);
  binSame('-h wins over later junk', 'gsdt-planning-repair', dirty, () => ['-h', '--bogus']);
  binSame('junk before -h', 'gsdt-planning-repair', dirty, () => ['--bogus', '-h']);
  binSame('unknown arg', 'gsdt-planning-repair', dirty, () => ['--bogus']);
  binSame('--repo without value', 'gsdt-planning-repair', dirty, () => ['--repo']);
  binSame('check+commit', 'gsdt-planning-repair', dirty, () => ['--check', '--commit']);
  binSame('-n check', 'gsdt-planning-repair', dirty, () => ['-n']);
  binSame('no repo dir', 'gsdt-planning-repair', dirty, () => ['--repo', '/nonexistent-dir-xyz']);
  binSame('check', 'gsdt-planning-repair', dirty, repo);
  binSame('check from cwd', 'gsdt-planning-repair', dirty, () => ['--check']);
  binSame('check from subdir', 'gsdt-planning-repair', { ...dirty, 'sub/x.txt': 'x' }, () => ['--check'], { cwd: (r) => path.join(r, 'sub') });
  binSame('repair', 'gsdt-planning-repair', dirty, repo);
  binSame('clean tree', 'gsdt-planning-repair', { '.planning/ROADMAP.md': ROADMAP, '.planning/STATE.md': STATE, ...PLAN_FILES }, repo);
  binSame('no .planning', 'gsdt-planning-repair', { 'a.txt': 'x' }, repo);
  binSame('no ROADMAP.md', 'gsdt-planning-repair', { '.planning/STATE.md': STATE }, repo);
  binSame('--commit', 'gsdt-planning-repair', dirty, (r) => ['--commit', '--repo', r], { after: headSubject });
  binSame('--commit clean', 'gsdt-planning-repair', { '.planning/ROADMAP.md': ROADMAP, '.planning/STATE.md': STATE, ...PLAN_FILES }, () => ['--commit'], { after: headSubject });
  binSame('--commit, ROADMAP only', 'gsdt-planning-repair', { '.planning/ROADMAP.md': roadmapCases['union damage'] as string }, () => ['--commit'], { after: headSubject });
  for (const [name, roadmap, state] of ROADMAP_FIX) {
    binSame(`${name}: repair --commit`, 'gsdt-planning-repair', { '.planning/ROADMAP.md': roadmap, '.planning/STATE.md': state }, () => ['--commit'], { after: headSubject });
    binSame(`${name}: check`, 'gsdt-planning-repair', { '.planning/ROADMAP.md': roadmap, '.planning/STATE.md': state }, () => ['--check']);
  }
});

test('gsdt-planning-repair --commit keeps other staged files out of the commit', () => {
  const files: Files = { ...dirty, 'other.txt': 'one\n' };
  for (const bin of [oldBin, newBin]) {
    const r = gitRepo(files);
    write(path.join(r, 'other.txt'), 'two\n');
    git(r, ['add', 'other.txt']);
    assert.equal(run(bin('gsdt-planning-repair'), ['--commit'], r).rc, 0);
    assert.equal(git(r, ['status', '--porcelain']).out, 'M  other.txt\n');
  }
});

test('gsdt-planning-repair --commit: a failing commit ends with its status (set -e)', () => {
  const results = [oldBin, newBin].map((bin) => {
    const r = gitRepo(dirty);
    mkdirSync(path.join(r, '.git', 'hooks'), { recursive: true });
    write(path.join(r, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho rejected >&2\nexit 7\n', 0o755);
    const res = run(bin('gsdt-planning-repair'), ['--commit'], r);
    return { ...res, out: res.out.split(r).join('<repo>'), err: res.err.split(r).join('<repo>') };
  });
  assert.deepEqual(results[1], results[0]);
  assert.notEqual(results[0]?.rc, 0);
});

/** the driver the way gsd_register_merge_driver registers it, then a real conflicting merge */
function mergeRepo(bin: string, ours: Files, theirs: Files, base: Files): { repo: string; res: R } {
  const d = gitRepo({ ...base, '.gitattributes': '.planning/ROADMAP.md merge=gsd-planning\n.planning/STATE.md merge=gsd-planning\n' });
  git(d, ['config', 'merge.gsd-planning.driver', `${bin} %O %A %B %P`]);
  git(d, ['checkout', '-q', '-b', 'topic']);
  for (const [rel, body] of Object.entries(theirs)) write(path.join(d, rel), body as string);
  git(d, ['commit', '-qam', 'theirs']);
  git(d, ['checkout', '-q', 'main']);
  for (const [rel, body] of Object.entries(ours)) write(path.join(d, rel), body as string);
  git(d, ['commit', '-qam', 'ours']);
  const res = git(d, ['merge', '--no-edit', 'topic']);
  return { repo: d, res };
}

test('gsdt-planning-merge through a real git merge: old bash vs launcher', () => {
  const base: Files = { '.planning/ROADMAP.md': ROADMAP, '.planning/STATE.md': STATE };
  const variants: [string, Files, Files][] = [
    [
      'same line flipped both ways',
      { '.planning/ROADMAP.md': ROADMAP.replace('- [ ] **Phase 2: Beta** - second', '- [x] **Phase 2: Beta** - second (completed 2026-02-01)'), '.planning/STATE.md': STATE.replace('Phase: 2', 'Phase: 3') },
      { '.planning/ROADMAP.md': ROADMAP.replace('- [ ] **Phase 2: Beta** - second', '- [ ] **Phase 2: Beta** - second, reworded'), '.planning/STATE.md': STATE.replace('Phase: 2', 'Phase: 4').replace('percent: 33', 'percent: 66') },
    ],
    [
      'frontmatter counters differ',
      { '.planning/ROADMAP.md': ROADMAP, '.planning/STATE.md': STATE.replace('completed_phases: 1', 'completed_phases: 2').replace('percent: 33', 'percent: 67') },
      { '.planning/ROADMAP.md': ROADMAP, '.planning/STATE.md': STATE.replace('total_phases: 3', 'total_phases: 4').replace('status: planning', 'status: done') },
    ],
    [
      'disjoint edits',
      { '.planning/ROADMAP.md': ROADMAP + '\n### Phase 3: Gamma\n\nours\n', '.planning/STATE.md': STATE },
      { '.planning/ROADMAP.md': '# Roadmap v2\n' + ROADMAP.slice(10), '.planning/STATE.md': STATE },
    ],
    [
      'crlf on one side',
      { '.planning/ROADMAP.md': ROADMAP.replace(/\n/g, '\r\n').replace('Beta', 'Beta!'), '.planning/STATE.md': STATE },
      { '.planning/ROADMAP.md': ROADMAP.replace('Beta', 'Beta?'), '.planning/STATE.md': STATE },
    ],
  ];
  for (const [name, ours, theirs] of variants) {
    const a = mergeRepo(oldBin('gsdt-planning-merge'), ours, theirs, base);
    const b = mergeRepo(newBin('gsdt-planning-merge'), ours, theirs, base);
    // the merge output names the driver's own stderr; compare it without the repo path
    const norm = (r: R, repo: string): R => ({ ...r, out: r.out.split(repo).join('<repo>').replace(/\b[0-9a-f]{7,}\b/g, '<sha>'), err: r.err.split(repo).join('<repo>') });
    assert.deepEqual(norm(b.res, b.repo), norm(a.res, a.repo), `${name}: git merge output`);
    assert.deepEqual(snapshot(b.repo), snapshot(a.repo), `${name}: merged files`);
  }
});

test('gsdt-planning-merge called directly: old bash vs launcher', () => {
  const trio = (): { dir: string; o: string; a: string; b: string } => {
    const dir = tmp();
    return {
      dir,
      o: write(path.join(dir, 'O'), '- [ ] **Phase 1: a**\n'),
      a: write(path.join(dir, 'A'), '- [x] **Phase 1: a** (done)\n'),
      b: write(path.join(dir, 'B'), '- [ ] **Phase 1: a**, b\n'),
    };
  };
  const callBoth = (extra: (t: ReturnType<typeof trio>) => string[], label: string): void => {
    const ta = trio();
    const tb = trio();
    const ra = run(oldBin('gsdt-planning-merge'), extra(ta), ta.dir);
    const rb = run(newBin('gsdt-planning-merge'), extra(tb), tb.dir);
    // bash's own `${1:?}` error names the script path and line
    // (a Python traceback on the old side, or the TS engine's one-line
    // `gsd_planning: …` error on the new side, is followed by the same warning)
    const norm = (r: R, t: ReturnType<typeof trio>, bin: string): R => ({
      ...r,
      err: r.err.split(t.dir).join('<d>').split(bin).join('<bin>').replace(/line \d+/, 'line N').replace(/^Traceback[\s\S]*?(?=⚠)/, '').replace(/^gsd_planning: [^\n]*\n(?=⚠)/, ''),
    });
    assert.deepEqual(norm(rb, tb, newBin('gsdt-planning-merge')), norm(ra, ta, oldBin('gsdt-planning-merge')), label);
    assert.deepEqual(snapshot(tb.dir), snapshot(ta.dir), `${label}: files`);
  };
  callBoth((t) => [t.o, t.a, t.b, 'a/b/ROADMAP.md'], 'ROADMAP path');
  callBoth((t) => [t.o, t.a, t.b, 'a/b/STATE.md'], 'STATE path (not state-shaped)');
  callBoth((t) => [t.o, t.a, t.b, 'a/b/NOTES.md'], 'other path');
  callBoth((t) => [t.o, t.a, t.b], 'no path');
  callBoth((t) => [t.o, t.a, t.b, ''], 'empty path');
  callBoth((t) => [t.o, t.a], 'missing %B');
  callBoth(() => [], 'no args');
  callBoth((t) => [t.o, path.join(t.dir, 'nonexistent'), t.b, 'ROADMAP.md'], 'missing %A');
});

test('gsdt-planning-merge degrades safely without a usable node', () => {
  const stubs = tmp();
  for (const tool of ['git', 'bash', 'env', 'dirname', 'readlink']) {
    const real = run('sh', ['-c', `command -v ${tool}`]).out.trim();
    symlinkSync(real, path.join(stubs, tool));
  }
  const old = tmp();
  const nodeless = (): { dir: string; env: Record<string, string> } => ({ dir: tmp(), env: { PATH: stubs } });
  const old23 = tmp();
  write(path.join(old23, 'node'), '#!/bin/sh\n[ "$1" = "-e" ] && exit 1\necho v23\n', 0o755);
  for (const env of [{ PATH: stubs }, { PATH: `${old23}:${stubs}` }]) {
    const { dir } = nodeless();
    const o = write(path.join(dir, 'O'), 'a\n');
    const a = write(path.join(dir, 'A'), 'a\nours\n');
    const b = write(path.join(dir, 'B'), 'a\ntheirs\n');
    const r = run(newBin('gsdt-planning-merge'), [o, a, b, 'ROADMAP.md'], dir, env);
    assert.equal(r.rc, 0);
    assert.equal(read(a), 'a\nours\ntheirs\n', 'plain union result');
    assert.match(r.err, /needs Node\.js >= 24/);
    assert.match(r.err, /gsdt-planning-repair/);
  }
  void old;
});

test('launchers: no node means a clear message from repair', () => {
  const stubs = tmp();
  for (const tool of ['bash', 'env', 'dirname', 'readlink']) symlinkSync(run('sh', ['-c', `command -v ${tool}`]).out.trim(), path.join(stubs, tool));
  const r = run(newBin('gsdt-planning-repair'), ['--check'], tmp(), { PATH: stubs });
  assert.equal(r.rc, 1);
  assert.match(r.err, /needs Node\.js >= 24/);
});

test('shipped docs and workflow still reference what exists', () => {
  assert.ok(existsSync(PY), 'lib/gsd_planning.py stays as the oracle');
  assert.match(read(path.join(PKG, '.github', 'workflows', 'tests.yml')), /node --test 'tests\/ts\/\*\.test\.ts'/);
});
