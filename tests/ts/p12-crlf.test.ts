// P12: Git for Windows checks repo text out with CRLF (core.autocrlf=true). Every reader of
// repo text must give the same answer for a CRLF file as for the LF version, and an edit in
// place must keep the file's own ending. TypeScript only (no bash oracle): each scenario builds
// the SAME repo twice, once LF and once with every text file converted to CRLF, runs the
// command in both and compares (paths normalized).
// Run: node --test tests/ts/p12-crlf.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { LOCALE_ENV, PKG, tmp, write, subst } from './helpers.ts';
import { confGet, planningApply, planningStatus, reviewsProblem, validationProblem } from '../../src/common.ts';
import { roadmapAudit, roadmapRows } from '../../src/roadmap.ts';
import { ownedBlockGet, ownedMarkersValid, replaceOwnedBlock } from '../../src/provider.ts';
import { parseEnvFile } from '../../src/tracker/clickup.ts';
import { trkConfGet } from '../../src/tracker/config.ts';

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
});

const LAUNCH = path.join(PKG, 'src', 'launch.mjs');
const toCrlf = (s: string): string => s.replace(/\r?\n/g, '\r\n');
const toLf = (s: string): string => s.replace(/\r\n/g, '\n');
const g = (cwd: string, ...a: string[]): string => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout ?? '';

type World = { root: string; home: string; repo: string; env: NodeJS.ProcessEnv; wt: string };

function isText(f: string): boolean {
  return !readFileSync(f).includes(0);
}
/** every file under dir (not .git, not node_modules) → CRLF, like a Windows checkout */
function crlfTree(dir: string): void {
  for (const n of readdirSync(dir)) {
    if (n === '.git' || n === 'node_modules') continue;
    const p = path.join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) crlfTree(p);
    else if (st.isFile() && isText(p)) writeFileSync(p, toCrlf(readFileSync(p, 'utf8')), { mode: st.mode });
  }
}

const ROADMAP = `# Roadmap

- [x] **Phase 1: Alpha**
- [ ] **Phase 2: Beta**

### Phase 1: Alpha

Goal: alpha

### Phase 2: Beta

Goal: beta

## Progress

| Phase | Plans | Status |
|-------|-------|--------|
| 1. Alpha | 1/1 | Complete |
| 2. Beta | 0/TBD | Not started |
`;
const STATE = `---
status: executing
progress:
  total_phases: 2
  completed_phases: 1
  percent: 50
---

# State

## Current Position

Phase 1

## Session Continuity

Last session: 2026-01-01
Stopped at: the middle of things
`;
const CONF = `# toolkit
providers = claude # the default
base = develop   
flow = strict
ui_gates = off
tracker = none
`;
const CLAUDE_MD = `# My project

Some notes of my own.

- keep this line
`;

function build(eol: 'lf' | 'crlf', name: string): World {
  const root = tmp();
  const home = path.join(root, 'home');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  const repo = path.join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  g(repo, 'init', '-q', '-b', 'develop');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    GSD_NO_UPDATE_CHECK: '1',
    ...LOCALE_ENV,
    TERMCOLS: '120',
    COLUMNS: '120',
  };
  write(path.join(repo, '.gsd.conf'), CONF);
  write(path.join(repo, '.planning/ROADMAP.md'), ROADMAP);
  write(path.join(repo, '.planning/STATE.md'), STATE);
  write(path.join(repo, '.planning/phases/01-alpha/01-CONTEXT.md'), '# Context\n\nDecisions.\n');
  write(path.join(repo, '.planning/phases/01-alpha/01-01-PLAN.md'), '---\nphase: 1\n---\n# Plan\n');
  write(path.join(repo, '.planning/phases/01-alpha/01-01-SUMMARY.md'), '# Summary\n');
  write(path.join(repo, '.planning/phases/01-alpha/01-REVIEWS.md'), '---\nphase: 1\n---\n# Reviews\n\n## Claude Review\n\n' + 'Fine plan.\n'.repeat(8) + '\n## Codex Review\n\n' + 'Looks right.\n'.repeat(8));
  write(path.join(repo, '.planning/phases/01-alpha/01-VALIDATION.md'), '---\nnyquist_compliant: false\n---\n# Validation\n');
  write(path.join(repo, '.planning/phases/02-beta/02-CONTEXT.md'), '# Context\n');
  write(path.join(repo, 'CLAUDE.md'), CLAUDE_MD);
  g(repo, 'add', '-A');
  g(repo, 'commit', '-qm', 'init');
  const bs = spawnSync('node', [LAUNCH, 'bootstrap-repo', '--agent', 'claude'], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(bs.status, 0, `bootstrap (${name}): ${bs.stdout}${bs.stderr}`);
  g(repo, 'add', '-A');
  g(repo, 'commit', '-qm', 'bootstrap');
  // the phase worktree (flow-next and the guard's strict rules run there)
  const wt = path.join(root, 'phase-1-alpha');
  g(repo, 'worktree', 'add', '-q', '-b', 'phase-1-alpha', wt);
  if (eol === 'crlf') {
    crlfTree(repo); // after the commit: the committed blobs stay LF, the checkout is CRLF
    crlfTree(wt);
  }
  return { root, home, repo, env, wt };
}

const lf = build('lf', 'lf');
const crlf = build('crlf', 'crlf');

type R = { out: string; err: string; rc: number };
function run(w: World, argv: string[], extraEnv: Record<string, string> = {}, input?: string, cwd?: string): R {
  const r = spawnSync('node', [LAUNCH, ...argv.map((a) => a.split('{R}').join(w.repo).split('{WT}').join(w.wt))], {
    cwd: cwd ?? w.repo,
    env: { ...w.env, ...extraEnv },
    encoding: 'utf8',
    input: input ?? '',
  });
  const norm = (s: string): string => subst(subst(s, w.root, '<W>'), w.root.replace(/\\/g, '/'), '<W>'); // doctor prints git's `/` form on Windows
  return { out: norm(r.stdout ?? ''), err: norm(r.stderr ?? ''), rc: r.status ?? -1 };
}
/** the same command in both worlds: identical stdout, stderr, exit code */
function same(label: string, argv: string[], extraEnv: Record<string, string> = {}, input?: string, inWt = false): R {
  const a = run(lf, argv, extraEnv, input, inWt ? lf.wt : undefined);
  const b = run(crlf, argv, extraEnv, input, inWt ? crlf.wt : undefined);
  assert.equal(toLf(b.out), a.out, `${label}: stdout`);
  assert.equal(toLf(b.err), a.err, `${label}: stderr`);
  assert.equal(b.rc, a.rc, `${label}: exit code`);
  return a;
}

test('the fixture really is CRLF (and the LF one is not)', () => {
  assert.ok(readFileSync(path.join(crlf.repo, '.gsd.conf'), 'utf8').includes('\r\n'));
  assert.ok(readFileSync(path.join(crlf.repo, 'CLAUDE.md'), 'utf8').includes('\r\n'));
  assert.ok(readFileSync(path.join(crlf.repo, 'scripts/gsdt-planning-repair.sh'), 'utf8').includes('\r\n'));
  assert.ok(!readFileSync(path.join(lf.repo, '.gsd.conf'), 'utf8').includes('\r'));
});

test('confGet: same values, no stray CR', () => {
  for (const k of ['providers', 'base', 'flow', 'ui_gates', 'tracker', 'nokey']) {
    assert.equal(confGet(crlf.repo, k), confGet(lf.repo, k), k);
  }
  assert.equal(confGet(crlf.repo, 'providers'), 'claude');
  assert.equal(confGet(crlf.repo, 'base'), 'develop');
  assert.equal(trkConfGet(crlf.repo, 'tracker'), trkConfGet(lf.repo, 'tracker'));
});

test('reviews / validation / roadmap audit readers', () => {
  const pd = (w: World): string => `${w.repo}/.planning/phases/01-alpha`;
  assert.equal(reviewsProblem(`${pd(crlf)}/01-REVIEWS.md`, 'codex'), reviewsProblem(`${pd(lf)}/01-REVIEWS.md`, 'codex'));
  assert.equal(validationProblem(pd(crlf), '01', crlf.repo), validationProblem(pd(lf), '01', lf.repo));
  assert.equal(roadmapAudit(`${crlf.repo}/.planning/ROADMAP.md`), roadmapAudit(`${lf.repo}/.planning/ROADMAP.md`));
  // a nyquist_compliant: true with a trailing CR is still compliant
  const v = tmp();
  write(`${v}/01-VALIDATION.md`, '---\r\nnyquist_compliant: true\r\n---\r\n# V\r\n');
  assert.equal(validationProblem(v, '01', lf.repo), null);
});

test('gsdt-list table', () => {
  const r = same('list', ['list']);
  assert.match(r.out, /Alpha/);
});

test('gsdt-doctor --json: no findings that the LF repo does not have', () => {
  const r = same('doctor json', ['doctor', '--json', '--repo', '{R}']);
  assert.ok(r.out.includes('"code"') || r.out.includes('['), 'doctor produced findings JSON');
  assert.doesNotMatch(r.out, /T016|T010|T02\d/);
  same('doctor text', ['doctor', '--repo', '{R}']);
});

test('gsdt-flow-next: the same step', () => {
  for (const p of ['1', '2']) {
    const r = same(`flow-next ${p}`, ['flow-next', p, '--repo', '{WT}'], {}, undefined, true);
    if (p === '1') assert.match(r.out, /step=/, `flow-next ${p} printed a step: ${r.err}`);
  }
});

test('gsdt-flow-next: a CRLF VERIFICATION.md with gaps is read like the LF one', () => {
  for (const w of [lf, crlf]) {
    const f = `${w.wt}/.planning/phases/01-alpha/01-VERIFICATION.md`;
    write(f, w === crlf ? '---\r\nstatus: gaps_found\r\n---\r\n' : '---\nstatus: gaps_found\n---\n');
  }
  const r = same('flow-next verification', ['flow-next', '1', '--repo', '{WT}'], {}, undefined, true);
  assert.match(r.out, /gaps/);
});

test('the guard: the same decision', () => {
  let blocked = 0;
  for (const [cmd, p] of [['gsd-execute-phase', '1'], ['gsd-plan-phase', '1'], ['gsd-execute-phase', '2'], ['gsd-ship', '1']] as const) {
    const gr = same(`guard ${cmd} ${p}`, ['worktree-guard', '--command', cmd, '--phase', p, '--repo', '{WT}'], {}, undefined, true);
    if (gr.rc === 2) blocked++;
  }
  assert.ok(blocked > 0, 'at least one command was blocked (so the comparison is not vacuous)');
});

test('marked blocks: found, valid, and read as the same text', () => {
  for (const [f, kind] of [['CLAUDE.md', 'provider'], ['.gsd/INSTRUCTIONS.md', 'canonical']] as const) {
    assert.ok(ownedMarkersValid(`${crlf.repo}/${f}`, kind), `${f} markers valid`);
    const a = ownedBlockGet(`${lf.repo}/${f}`, kind);
    assert.notEqual(a, '', `${f} has a block`);
    assert.equal(ownedBlockGet(`${crlf.repo}/${f}`, kind), a, `${f} block text`);
  }
});

test('bootstrap re-run on a CRLF repo: block replaced once, text outside untouched, endings kept, no T016', () => {
  const before = readFileSync(path.join(crlf.repo, 'CLAUDE.md'), 'utf8');
  const starts = (t: string): number => (t.match(/<!-- gsd-toolkit:provider:start -->/g) ?? []).length;
  assert.equal(starts(before), 1);
  // make the block stale, so the re-run really has to replace it
  const stale = before.replace(/(<!-- gsd-toolkit:provider:start -->\r\n)/, '$1STALE LINE\r\n');
  writeFileSync(path.join(crlf.repo, 'CLAUDE.md'), stale);
  const bs = run(crlf, ['bootstrap-repo', '--agent', 'claude']);
  assert.equal(bs.rc, 0, bs.out + bs.err);
  const after = readFileSync(path.join(crlf.repo, 'CLAUDE.md'), 'utf8');
  assert.equal(starts(after), 1, 'one block, not two');
  assert.ok(!after.includes('STALE LINE'));
  assert.equal(after, before, 'back to exactly the CRLF text it had');
  assert.ok(!/(^|[^\r])\n/.test(after), 'every line still CRLF');
  assert.ok(after.startsWith(toCrlf(CLAUDE_MD)), 'the user text outside the block is byte-identical');
  const inst = readFileSync(path.join(crlf.repo, '.gsd/INSTRUCTIONS.md'), 'utf8');
  assert.ok(!/(^|[^\r])\n/.test(inst), 'INSTRUCTIONS.md still CRLF');
  const conf = readFileSync(path.join(crlf.repo, '.gsd.conf'), 'utf8');
  assert.ok(!/(^|[^\r])\n/.test(conf), '.gsd.conf still CRLF after the bootstrap key edits');
  assert.equal(toLf(conf).split('\n').filter((l) => /^providers\b/.test(l)).length, 1);
  const d = run(crlf, ['doctor', '--json', '--repo', '{R}']);
  assert.doesNotMatch(d.out, /T016/);
});

test('replaceOwnedBlock: appends with the file ending; old marker names are replaced in place', () => {
  const d = tmp();
  const blk = `${d}/blk`;
  write(blk, '<!-- gsd-toolkit:provider:start -->\nnew\n<!-- gsd-toolkit:provider:end -->\n');
  write(`${d}/A.md`, 'one\r\ntwo\r\n');
  assert.ok(replaceOwnedBlock(`${d}/A.md`, 'provider', blk));
  assert.equal(readFileSync(`${d}/A.md`, 'utf8'), 'one\r\ntwo\r\n\r\n<!-- gsd-toolkit:provider:start -->\r\nnew\r\n<!-- gsd-toolkit:provider:end -->\r\n');
  write(`${d}/B.md`, 'top\r\n<!-- gsd-worktrees:provider:start -->\r\nold\r\n<!-- gsd-worktrees:provider:end -->\r\nbottom\r\n');
  assert.ok(replaceOwnedBlock(`${d}/B.md`, 'provider', blk));
  assert.equal(readFileSync(`${d}/B.md`, 'utf8'), 'top\r\n<!-- gsd-toolkit:provider:start -->\r\nnew\r\n<!-- gsd-toolkit:provider:end -->\r\nbottom\r\n');
  // LF is untouched
  write(`${d}/C.md`, 'top\n<!-- gsd-toolkit:provider:start -->\nold\n<!-- gsd-toolkit:provider:end -->\nbottom\n');
  assert.ok(replaceOwnedBlock(`${d}/C.md`, 'provider', blk));
  assert.equal(readFileSync(`${d}/C.md`, 'utf8'), 'top\n<!-- gsd-toolkit:provider:start -->\nnew\n<!-- gsd-toolkit:provider:end -->\nbottom\n');
});

test('.gitattributes: a CRLF file is seen as installed; an edit keeps CRLF and does not duplicate', () => {
  const r = tmp();
  g(r, 'init', '-q', '-b', 'develop');
  write(`${r}/.gitattributes`, '*.png binary\r\n.planning/ROADMAP.md merge=gsd-planning\r\n.planning/STATE.md merge=gsd-planning\r\n');
  assert.equal(planningStatus(r).attrsState, 'ok');
  write(`${r}/.gitattributes`, '*.png binary\r\n.planning/ROADMAP.md merge=union\r\n.planning/STATE.md merge=union\r\n');
  assert.equal(planningStatus(r).attrsState, 'union');
  planningApply(r);
  const t = readFileSync(`${r}/.gitattributes`, 'utf8');
  assert.equal(t, '*.png binary\r\n.planning/ROADMAP.md merge=gsd-planning\r\n.planning/STATE.md merge=gsd-planning\r\n');
  write(`${r}/.gitattributes`, '*.png binary\r\n');
  planningApply(r);
  assert.equal(readFileSync(`${r}/.gitattributes`, 'utf8'), '*.png binary\r\n.planning/ROADMAP.md merge=gsd-planning\r\n.planning/STATE.md merge=gsd-planning\r\n');
  assert.equal(planningStatus(r).attrsState, 'ok');
});

test('roadmap rows: the same rows, added with the file ending', () => {
  const body = ROADMAP.replace('### Phase 2: Beta', '### Phase 2: Beta\n\nGoal: beta\n\n### Phase 3: Gamma | x');
  const d = tmp();
  write(`${d}/lf.md`, body);
  write(`${d}/crlf.md`, toCrlf(body));
  const a = roadmapRows(`${d}/lf.md`, '3');
  const b = roadmapRows(`${d}/crlf.md`, '3');
  assert.deepEqual(b, a);
  assert.ok(a.changed);
  const out = readFileSync(`${d}/crlf.md`, 'utf8');
  assert.equal(out, toCrlf(readFileSync(`${d}/lf.md`, 'utf8')));
  assert.ok(!/(^|[^\r])\n/.test(out));
  assert.match(out, /- \[ \] \*\*Phase 3: Gamma \| x\*\*\r\n/);
});

// ── planning repair / reconcile ─────────────────────────────────────────────

const DAMAGED_ROADMAP = ROADMAP.replace('- [ ] **Phase 2: Beta**', '- [ ] **Phase 2: Beta**\n- [x] **Phase 2: Beta**').replace('| 2. Beta | 0/TBD | Not started |', '| 2. Beta | 0/TBD | Not started |\n| 2. Beta | 1/1 | Complete |');
const DAMAGED_STATE = STATE.replace('status: executing', 'status: executing\nstatus: paused').replace('Last session: 2026-01-01', 'Last session: 2025-12-30\nLast session: 2026-01-01');

function sessionContinuity(t: string): string {
  const i = t.indexOf('## Session Continuity');
  assert.ok(i >= 0);
  return t.slice(i);
}

test('gsdt-planning-repair: same repair; a CRLF file stays CRLF; Session Continuity bytes identical', () => {
  const a = tmp();
  const b = tmp();
  for (const [d, conv] of [[a, (s: string) => s], [b, toCrlf]] as const) {
    g(d, 'init', '-q', '-b', 'develop');
    write(`${d}/.planning/ROADMAP.md`, conv(DAMAGED_ROADMAP));
    write(`${d}/.planning/STATE.md`, conv(DAMAGED_STATE));
    write(`${d}/.planning/phases/01-alpha/01-01-PLAN.md`, conv('# p\n'));
    write(`${d}/.planning/phases/01-alpha/01-01-SUMMARY.md`, conv('# s\n'));
  }
  const go = (d: string, extra: string[] = []): R => {
    const r = spawnSync('node', [LAUNCH, 'planning-repair', '--repo', d, ...extra], { cwd: d, env: lf.env, encoding: 'utf8' });
    return { out: subst((r.stdout ?? ''), d, '<D>'), err: subst((r.stderr ?? ''), d, '<D>'), rc: r.status ?? -1 };
  };
  const ca = go(a, ['--check']);
  const cb = go(b, ['--check']);
  assert.deepEqual({ ...cb, out: toLf(cb.out) }, ca);
  assert.equal(ca.rc, 1, 'the damage is seen');
  assert.match(ca.out, /union-merge damage/);
  const ra = go(a);
  const rb = go(b);
  assert.deepEqual({ ...rb, out: toLf(rb.out) }, ra);
  for (const f of ['ROADMAP.md', 'STATE.md']) {
    const ta = readFileSync(`${a}/.planning/${f}`, 'utf8');
    const tb = readFileSync(`${b}/.planning/${f}`, 'utf8');
    assert.equal(tb, toCrlf(ta), `${f}: same content, CRLF kept`);
  }
  assert.equal(sessionContinuity(readFileSync(`${b}/.planning/STATE.md`, 'utf8')), toCrlf(sessionContinuity(DAMAGED_STATE)), 'Session Continuity byte-identical');
  assert.equal(go(b).out.includes('consistent'), true);
  // and a consistent CRLF repo is not rewritten at all
  const before = readFileSync(`${b}/.planning/STATE.md`);
  go(b);
  assert.ok(readFileSync(`${b}/.planning/STATE.md`).equals(before));
});

test('the merge driver on CRLF files (mixed endings possible)', () => {
  const d = tmp();
  const O = `${d}/O`;
  const A = `${d}/A`;
  const B = `${d}/B`;
  write(O, toCrlf(ROADMAP));
  write(A, toCrlf(ROADMAP.replace('- [ ] **Phase 2: Beta**', '- [x] **Phase 2: Beta**')));
  write(B, ROADMAP.replace('Goal: beta', 'Goal: beta!')); // an LF side
  const r = spawnSync('node', [LAUNCH, 'planning-merge', O, A, B, '.planning/ROADMAP.md'], { cwd: d, env: lf.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const t = readFileSync(A, 'utf8');
  assert.equal((t.match(/\*\*Phase 2: Beta\*\*/g) ?? []).length, 1, 'one checklist row for phase 2');
  assert.match(t, /- \[x\] \*\*Phase 2: Beta\*\*/);
  assert.match(t, /Goal: beta!/);
});

// ── start's STATE note, migrate ─────────────────────────────────────────────

test('gsdt-migrate --check: a CRLF repo is "nothing to migrate" like the LF one', () => {
  const a = run(lf, ['migrate', '--check', '--repo', '{R}']);
  const b = run(crlf, ['migrate', '--check', '--repo', '{R}']);
  assert.equal(b.rc, a.rc);
  assert.equal(toLf(b.out), a.out);
});

test('migrate --apply on a CRLF repo with old-name references keeps the file endings', () => {
  const w = build('crlf', 'mig');
  write(`${w.repo}/ci.yml`, 'steps:\r\n  - run: scripts/gsd-planning-repair.sh\r\n  - run: echo hi\r\n');
  g(w.repo, 'add', '-A');
  const dry = run(w, ['migrate', '--repo', '{R}']);
  assert.match(dry.out, /ci\.yml:2: .*scripts\/gsd-planning-repair\.sh/);
  assert.doesNotMatch(dry.out, /\r/);
  const ap = run(w, ['migrate', '--apply', '--repo', '{R}']);
  assert.equal(ap.rc, 0, ap.out + ap.err);
  assert.equal(readFileSync(`${w.repo}/ci.yml`, 'utf8'), 'steps:\r\n  - run: scripts/gsdt-planning-repair.sh\r\n  - run: echo hi\r\n');
});

test('the ClickUp token file with CRLF: no CR in the token', () => {
  assert.deepEqual(parseEnvFile('# c\r\n  export CLICKUP_API_TOKEN="pk_x"\r\nOTHER=1\r\n'), [['CLICKUP_API_TOKEN', 'pk_x'], ['OTHER', '1']]);
  assert.deepEqual(parseEnvFile('CLICKUP_API_TOKEN=pk_y\r\n'), [['CLICKUP_API_TOKEN', 'pk_y']]);
});
