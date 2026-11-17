// gsdt-list derives PLANS/STAGE/WORKTREE from the phase files and lays the table
// out without losing text. Read-only command, fixture repo.
// Port of tests/test-list.sh. Run: node --test tests/node/list.test.ts
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { count, git, gsdt, lines, tmp, touch, write } from './g1-helpers.ts';

const WORK = tmp('list');
const R = path.join(WORK, 'repo');
const P = path.join(R, '.planning', 'phases');

write(
  path.join(R, '.planning', 'ROADMAP.md'),
  [
    '# Roadmap',
    '- [x] **Phase 8: verified work**',
    '### Phase 1: nothing yet',
    '### Phase 2: spec only',
    '### Phase 3: discussed',
    '### Phase 4: has screens',
    '### Phase 5: half executed',
    '### Phase 6: finished work',
    '### Phase 7: in flight in its worktree with a very long description that must wrap across several lines',
    '### Phase 8: verified work',
    '### Phase 10: two digit',
    '### Phase 10.1: decimal hotfix',
    '',
  ].join('\n'),
);
for (const f of [
  '02-s/02-SPEC.md',
  '03-d/03-CONTEXT.md',
  '04-u/04-UI-SPEC.md',
  '05-h/05-01-PLAN.md',
  '05-h/05-02-PLAN.md',
  '05-h/05-01-SUMMARY.md',
  '06-f/06-01-PLAN.md',
  '06-f/06-01-SUMMARY.md',
  '08-v/08-01-PLAN.md',
  '08-v/08-01-SUMMARY.md',
  '10-t/10-CONTEXT.md',
  '10.1-h/10.1-01-PLAN.md',
]) {
  touch(path.join(P, f));
}
git(R, 'init', '-qb', 'main');
git(R, 'add', '-A');
git(R, 'commit', '-qm', 'roadmap');
// Phase 7's plan exists only on its branch (in its worktree), not in main.
const WT7 = path.join(WORK, 'wt7');
git(R, 'worktree', 'add', '-qb', 'phase-7-wt', WT7);
touch(path.join(WT7, '.planning', 'phases', '07-w', '07-01-PLAN.md'));
git(R, 'branch', 'phase-6-f-pr'); // a PR branch is not the phase branch

const compact = gsdt('list', ['--repo', R, '--compact'], { env: { COLUMNS: '70' } });
const OUT = compact.out;

/** One cell of the row for phase `n`; col 1=N 2=PHASE 3=PLANS 4=STAGE 5=WORKTREE. */
function cell(out: string, n: string, col: number): string {
  for (const l of lines(out)) {
    const parts = l.split('│');
    if ((parts[1] ?? '').trim() === n) return (parts[col] ?? '').trim();
  }
  return '';
}

test('gsdt-list --compact exits 0', () => {
  assert.equal(compact.status, 0, compact.out);
});

test('PLANS and STAGE come from the phase\'s artifact files', () => {
  assert.equal(cell(OUT, '1', 3), '—', 'no dir → no plans');
  assert.equal(cell(OUT, '1', 4), '—', 'no dir → no stage');
  assert.equal(cell(OUT, '2', 4), 'spec', 'SPEC.md → spec');
  assert.equal(cell(OUT, '3', 4), 'discuss', 'CONTEXT.md → discuss');
  assert.equal(cell(OUT, '4', 4), 'ui', 'UI-SPEC.md → ui (not spec)');
  assert.equal(cell(OUT, '5', 3), '1/2', '1 of 2 summaries → 1/2');
  assert.equal(cell(OUT, '5', 4), 'execute', '1 of 2 summaries → execute');
  assert.equal(cell(OUT, '6', 3), '✔', 'all summaries → ✔');
  assert.equal(cell(OUT, '6', 4), 'verify', 'all summaries, row not ticked → verify');
  assert.equal(cell(OUT, '8', 3), '✔', 'all summaries → ✔');
  assert.equal(cell(OUT, '8', 4), 'done', 'all summaries, row ticked → done');
  assert.equal(cell(OUT, '10', 4), 'discuss', '10 is not confused with 1');
  assert.equal(cell(OUT, '10.1', 3), '0/1', 'decimal phase 10.1 → its own dir');
});

test('WORKTREE and in-flight state', () => {
  assert.equal(cell(OUT, '7', 5), 'phase-7-wt ●', 'attached worktree is marked ●');
  assert.equal(cell(OUT, '7', 4), 'plan', 'worktree artifacts win over main');
  assert.equal(cell(OUT, '6', 5), '—', 'a *-pr branch is not the phase branch');
});

test('layout', () => {
  assert.equal(count(OUT, /^│/), 11, '--compact: one line per phase');
  const wide = gsdt('list', ['--repo', R], { env: { COLUMNS: '70' } }).out;
  // Phase 7's PHASE cell: its row plus the continuation rows below it, joined.
  let on = false;
  let acc = '';
  for (const l of lines(wide)) {
    const parts = l.split('│');
    const k = (parts[1] ?? '').trim();
    if (k === '7') on = true;
    if (on && k !== '' && k !== '7') break;
    if (on && l.startsWith('│')) acc += `${(parts[2] ?? '').trim()} `;
  }
  assert.equal(
    acc.replace(/ $/, ''),
    'in flight in its worktree with a very long description that must wrap across several lines',
    'default wraps long titles without truncating',
  );
  assert.ok(count(wide, /^│/) > 11, 'wrapped title spans several lines');
  const bare = gsdt('list', ['--repo', R], { input: '' });
  assert.ok(bare.out.length > 0, 'renders without a terminal or COLUMNS');
  const noRoadmap = gsdt('list', ['--repo', WORK]);
  assert.notEqual(noRoadmap.status, 0, 'a repo without ROADMAP.md is refused');
});
