// The /gsdt-flow step engine (gsdt-flow-next) walks the agreed order.
// Port of tests/test-flow-next.sh. Run: node --test tests/node/flow-next.test.ts
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { uiCodeState } from '../../src/ui.ts';
import {
  count, env, git, gitAt, gsdt, lf, lines, tmp, touch, uiFixApproval, uiFixCheck, uiFixLook, vals, write,
} from './g1-helpers.ts';
import type { Run } from './g1-helpers.ts';

const REPO = tmp('r');
const PD = path.join(REPO, '.planning', 'phases', '07-thing');
mkdirSync(PD, { recursive: true });
git(REPO, 'init', '-q', '-b', 'develop');
git(REPO, 'commit', '-q', '--allow-empty', '-m', 'init');
git(REPO, 'checkout', '-q', '-b', 'phase-7-thing');

const gcommit = (date: string, msg: string): void => {
  git(REPO, 'add', '-A');
  gitAt(REPO, date, 'commit', '-q', '-m', msg, '--allow-empty');
};
/** GSD_TRACKER for the next runs (the bash suite exports it part-way and unsets it later). */
let TRACKER: string | undefined;
const nx = (phase: string, repo: string, ...args: string[]): Run =>
  gsdt('flow-next', [phase, '--repo', repo, ...args], { env: { GSD_TRACKER: TRACKER } });
const out = (phase: string, repo: string, ...args: string[]): string => nx(phase, repo, ...args).stdout;
const join = (a: string[]): string => a.join('\n');
const step = (...args: string[]): string => join(vals(out('7', REPO, ...args), 'step'));
const fm = (name: string, status: string, extra = ''): void => {
  write(path.join(PD, `07-${name}`), `---\nstatus: ${status}\n${extra}\n---\n`);
};
const rm = (...fs: string[]): void => {
  for (const f of fs) rmSync(f, { force: true });
};
/** `sed -i 's/…/…/'` per line. */
function edit(file: string, fn: (l: string) => string | null): void {
  const t = lf(readFileSync(file, 'utf8'));
  const ls = t.split('\n');
  const trail = ls[ls.length - 1] === '' ? ls.pop() !== undefined : false;
  const o = ls.map(fn).filter((l): l is string => l !== null);
  writeFileSync(file, o.join('\n') + (trail ? '\n' : ''));
}

test('walks the order as artifacts appear', () => {
  assert.equal(step(), 'discuss', 'tracker = none (default): no ticket step');
  assert.equal(count(out('7', REPO), /^then=/), 0, '…and discuss has no ticket then=');
  TRACKER = 'clickup';
  assert.equal(step(), 'ticket', 'tracker set, empty folder → ticket');
  assert.equal(count(out('7', REPO), /^run=/), 0, '…untagged: no run=, asks the user');
  touch(path.join(PD, '07-TICKET.md'));
  assert.equal(step(), 'discuss', 'TICKET.md → discuss');
  assert.equal(join(vals(out('7', REPO), 'then')), 'update the clickup ticket to the agreed scope', '…discuss then= updates the ticket');
  touch(path.join(PD, '07-CONTEXT.md'));
  assert.equal(step(), 'ui-decision', 'discuss → ui-decision');
  assert.equal(step('--no-ui'), 'plan', 'ui-decision --no-ui → plan');
  assert.equal(step('--ui'), 'design-system', 'ui-decision --ui → design-system');
  touch(path.join(PD, '07-UI-SPEC.md'));
  assert.equal(step(), 'plan', 'UI-SPEC → plan (no flag needed)');
  const planrun = (): string => join(vals(out('7', REPO), 'run'));
  assert.equal(planrun(), '/gsd-plan-phase 7 --research', 'plan: no RESEARCH.md, no config → --research (never asks)');
  const cfg = path.join(REPO, '.planning', 'config.json');
  write(cfg, '{"workflow":{"research":false}}');
  assert.equal(planrun(), '/gsd-plan-phase 7 --skip-research', 'plan: workflow.research false → --skip-research');
  write(cfg, '{"workflow":{"research":true}}');
  assert.equal(planrun(), '/gsd-plan-phase 7 --research', 'plan: workflow.research true → --research');
  write(cfg, 'not json');
  assert.equal(planrun(), '/gsd-plan-phase 7 --research', 'plan: broken config → --research');
  rm(cfg);
  touch(path.join(PD, '07-RESEARCH.md'));
  assert.equal(planrun(), '/gsd-plan-phase 7', 'plan: RESEARCH.md exists → plain (reuses it, no prompt)');
  rm(path.join(PD, '07-RESEARCH.md'));
  assert.equal(count(out('7', REPO), /--auto/), 0, 'plan: never --auto (it would skip the review gate)');
  touch(path.join(PD, '07-01-PLAN.md'));
  touch(path.join(PD, '07-02-PLAN.md'));
  assert.equal(step(), 'review', 'plans → review');
  assert.equal(count(out('7', REPO), /gsdt-codex-wait --wait-only/), 1, 'review note (codex): gsdt-codex-wait on a usage limit');
  write(path.join(PD, '07-REVIEWS.md'), '## Codex Review\n\nYou’ve hit your usage limit. Try again at Oct 11th, 2026 1:22 AM.\n');
  assert.equal(step(), 'review', 'REVIEWS whose Codex hit the limit → review again');
  assert.equal(count(out('7', REPO), /not a usable review \(Codex Review — usage limit hit\)/), 1, '…and the note says why');
  assert.equal(count(out('7', REPO, '--all'), /^step=replan/), 0, '…also with --all (no replan after it)');
  assert.equal(count(out('7', REPO), /delete it and run the review again/), 1, '…a short failed file: delete it');
  let big = '## Codex Review\n\n## Consensus Summary\n\n';
  for (let i = 1; i <= 40; i++) big += `line ${i}\n`;
  write(path.join(PD, '07-REVIEWS.md'), big);
  assert.equal(count(out('7', REPO), /open it and check before you delete it/), 1, 'a large rejected file → open it before any rerun');
  assert.equal(count(out('7', REPO), /delete it and run the review again/), 0, '…and no plain delete advice');
  write(path.join(PD, '07-REVIEWS.md'), '## Codex Review\n\n## 07-01\nfinding\n\n---\n\n## 07-02\nfinding\n\n---\n\n## Consensus Summary\n\nok\n');
  assert.equal(count(out('7', REPO), /^step=review$/), 0, '## plan sections in the review → not the review step');
  touch(path.join(PD, '07-REVIEWS.md'));
  assert.equal(step(), 'replan', 'REVIEWS uncommitted → replan');
  gcommit('2026-01-01T10:00:00', 'plans'); // plans + REVIEWS in one commit → counts as replanned
  assert.equal(step(), 'execute', 'REVIEWS + plans same commit → execute');
  write(path.join(PD, '07-REVIEWS.md'), 'x\n');
  gcommit('2026-01-01T11:00:00', 'review again');
  assert.equal(step(), 'replan', 'REVIEWS committed after plans → replan');
  writeFileSync(path.join(PD, '07-01-PLAN.md'), 'y\n', { flag: 'a' });
  gcommit('2026-01-01T12:00:00', 'replan');
  assert.equal(step(), 'execute', 'plan committed after REVIEWS → execute');
  touch(path.join(PD, '07-01-SUMMARY.md'));
  assert.equal(step(), 'execute', 'one summary short → execute');
  touch(path.join(PD, '07-02-SUMMARY.md'));
  assert.equal(step(), 'verifier', 'all summaries, no VERIFICATION → verifier');
  fm('VERIFICATION.md', 'gaps_found');
  assert.equal(step(), 'gaps', 'gaps_found → gaps');
  fm('VERIFICATION.md', 'passed');
  assert.equal(step(), 'verify-work', 'passed → verify-work');
  fm('HUMAN-UAT.md', 'partial');
  assert.equal(step(), 'verify-work', 'partial UAT → verify-work');
  fm('HUMAN-UAT.md', 'complete');
  assert.equal(step(), 'code-review', 'UAT complete → code-review (missing)');
  fm('REVIEW.md', 'issues_found');
  assert.equal(step(), 'code-review', 'issues_found, no FIX → code-review');
  touch(path.join(PD, '07-REVIEW-FIX.md'));
  assert.equal(step(), 'ui-check', 'FIX present → ui-check');
  write(path.join(PD, '07-SHOTS.md'), 'taken: x\n');
  assert.equal(step(), 'ui-check', '0.3.x SHOTS.md alone → still ui-check');
  uiFixCheck(PD, '07', 'failed');
  assert.equal(step(), 'ui-check', 'check failed → ui-check');
  uiFixCheck(PD, '07', 'passed');
  assert.equal(step(), 'ui-look', 'check passed → ui-look');
  uiFixLook(PD, '07');
  assert.equal(step(), 'ui-approve', 'look complete → ui-approve');
  uiFixApproval(PD, '07');
  assert.equal(step(), 'ui-review', 'approved → ui-review');
  touch(path.join(PD, '07-UI-REVIEW.md'));
  assert.equal(step(), 'validate', 'UI-REVIEW → validate (no VALIDATION.md)');
  assert.equal(join(vals(out('7', REPO), 'run')), '/gsd-validate-phase 7', '…run= is validate-phase');
  const val = path.join(PD, '07-VALIDATION.md');
  write(val, '---\nphase: 7\nstatus: draft\nnyquist_compliant: false\n---\n\n# Validation\n\n---\n');
  assert.equal(step(), 'validate', "the plan's draft VALIDATION.md → validate");
  assert.equal(count(out('7', REPO), /07-VALIDATION\.md is the plan's draft/), 1, '…and the note says it is the draft');
  const cfg2 = path.join(REPO, '.planning', 'config.json');
  write(cfg2, '{"workflow":{"nyquist_validation":false}}');
  assert.equal(step(), 'secure', 'workflow.nyquist_validation false → no validate step');
  rm(cfg2);
  writeFileSync(val, '\n## Validation Audit 2026-10-22\n| Gaps found | 2 |\n', { flag: 'a' });
  assert.equal(step(), 'secure', 'audited, gaps left manual-only → secure');
  write(val, '---\nphase: 7\nstatus: validated\nnyquist_compliant: true\n---\n');
  assert.equal(step(), 'secure', 'nyquist_compliant: true → secure');
  for (const v of ['"true"', "'true'", 'True', 'true   # all automated']) {
    write(val, `---\nnyquist_compliant: ${v}\n---\n`);
    assert.equal(step(), 'secure', `nyquist_compliant: ${v} → secure`);
  }
  write(val, '---\r\nnyquist_compliant: true\r\n---\r\n');
  assert.equal(step(), 'secure', '…and with CRLF line ends');
  write(val, '---\nnyquist_compliant: "false"\n---\n');
  assert.equal(step(), 'validate', 'nyquist_compliant: "false" → validate');
  write(val, '---\nphase: 7\nstatus: validated\nnyquist_compliant: true\n---\n');
  fm('SECURITY.md', 'verified', 'threats_open: 2');
  assert.equal(step(), 'secure', '2 open threats → secure');
  fm('SECURITY.md', 'verified', 'threats_open: 0');
  assert.equal(step(), 'done', '0 open → done');
});

test('details', () => {
  assert.equal(join(vals(out('7', REPO), 'run')), 'gsdt-finish', 'done run= is gsdt-finish');
  assert.equal(count(out('7', REPO, '--all'), /^step=/), 1, '--all lists every remaining step');
  rm(path.join(PD, '07-REVIEWS.md'), path.join(PD, '07-UI-REVIEW.md'));
  assert.equal(count(out('7', REPO, '--all'), /^step=/), 3, '--all with two gaps lists 3 (review, ui-review, done)');
  rm(path.join(PD, '07-UI-APPROVAL.md'));
  assert.equal(`${vals(out('7', REPO, '--all'), 'step').join(' ')} `, 'review ui-approve ui-review done ', '--all with the approval gone lists 4');
  uiFixApproval(PD, '07');
  assert.equal(count(lines(out('7', REPO, '--json')).slice(0, 1).join('\n'), /"step":"review"/), 1, '--json emits one object');
  assert.equal(join(vals(out('7', REPO), 'then')), '/gsd-plan-phase 7 --reviews', 'review has a then= replan');
  git(REPO, 'checkout', '-q', '-b', 'phase-8-thing');
  mkdirSync(path.join(REPO, '.planning', 'phases', '08-x-cu_abc'), { recursive: true });
  assert.equal(join(vals(out('8', REPO), 'step')), 'discuss', 'legacy cu_ in dir name counts as the ticket');
  git(REPO, 'checkout', '-q', '-b', 'phase-7.1-fix');
  mkdirSync(path.join(REPO, '.planning', 'phases', '7.1-fix'), { recursive: true });
  assert.equal(join(vals(out('7.1', REPO), 'step')), 'ticket', 'decimal phase dir');
  git(REPO, 'checkout', '-q', '-b', 'phase-11-cart');
  mkdirSync(path.join(REPO, '.planning', 'phases', '11-cart-tk-proj-42'), { recursive: true });
  write(path.join(REPO, '.planning', 'ROADMAP.md'), '# Roadmap\n\n### Phase 11: cart tk-PROJ-42\n');
  assert.equal(
    join(vals(out('11', REPO), 'run')),
    'gsdt-tracker snapshot PROJ-42 --out .planning/phases/11-cart-tk-proj-42/11-TICKET.md',
    'tagged title → run= snapshot (id case from the title)',
  );
  touch(path.join(REPO, '.planning', 'phases', '11-cart-tk-proj-42', '11-STORY.md'));
  assert.equal(join(vals(out('11', REPO), 'step')), 'discuss', 'legacy STORY.md counts as the ticket');
  git(REPO, 'checkout', '-q', '-b', 'phase-9-missing');
  assert.equal(nx('9', REPO).status, 1, 'missing phase dir → exit 1');
});

test('unconditional location guard without configuration', () => {
  assert.equal(nx('7', REPO).status, 2, 'wrong phase without config is blocked');
  assert.equal(nx('7.1', REPO).status, 2, 'ticket step on wrong phase is blocked');
  git(REPO, 'checkout', '-q', 'develop');
  assert.equal(nx('7', REPO, '--all').status, 2, 'preview on base is blocked');
  git(REPO, 'checkout', '-q', 'phase-7-thing');
  write(path.join(REPO, '.gsd.conf'), 'flow = strict\ninstall = none\n');
  assert.equal(nx('7', REPO, '--all').status, 0, 'preview does not enforce gates of future steps');
});

test('UI gates (design system, layout, the checks of the rendered pages)', () => {
  TRACKER = undefined;
  const U = tmp('u');
  const UPD = path.join(U, '.planning', 'phases', '05-shop');
  mkdirSync(UPD, { recursive: true });
  git(U, 'init', '-q', '-b', 'develop');
  git(U, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(U, 'checkout', '-q', '-b', 'phase-5-shop');
  touch(path.join(UPD, '05-CONTEXT.md'));
  const ustep = (...a: string[]): string => join(vals(out('5', U, ...a), 'step'));
  const urun = (...a: string[]): string => join(vals(out('5', U, ...a), 'run'));
  const unote = (): string => join(vals(out('5', U), 'note'));
  const DESIGN = path.join(U, '.planning', 'design', 'DESIGN.md');
  const LAYOUT = path.join(UPD, '05-LAYOUT.md');
  const commit = (msg: string): void => {
    git(U, 'add', '-A');
    git(U, 'commit', '-qm', msg);
  };

  assert.equal(ustep('--ui'), 'design-system', '--ui, no DESIGN.md → design-system');
  assert.equal(urun('--ui'), 'gsdt-ui design', '…run= gsdt-ui design');
  assert.equal(count(out('5', U, '--ui'), /^stop=.*styles\.refero\.design/), 1, '…stop= offers real design systems');
  gsdt('ui', ['design', '--repo', U]);
  assert.equal(ustep('--ui'), 'design-system', 'stub DESIGN.md → still design-system');
  edit(DESIGN, (l) => (l.includes('gsd:design-stub') ? null : l));
  assert.equal(ustep('--ui'), 'layout', 'filled DESIGN.md → layout');
  assert.equal(urun('--ui'), 'gsdt-ui layout 5', '…run= gsdt-ui layout 5');
  assert.equal(join(vals(out('5', U, '--ui'), 'then')).slice(0, 11), '/gsd-sketch', '…then= /gsd-sketch');
  gsdt('ui', ['layout', '5', '--repo', U]);
  assert.equal(ustep(), 'layout', 'LAYOUT settles screens (no --ui needed)');
  assert.equal(urun().slice(0, 11), '/gsd-sketch', 'empty sketch: → run= /gsd-sketch');
  edit(LAYOUT, (l) => (/^sketch:/.test(l) ? 'sketch: .planning/sketches/001-shop' : l));
  assert.equal(`${ustep()}/${urun()}`, 'layout/', 'sketch folder missing → layout, no run=');
  const README = path.join(U, '.planning', 'sketches', '001-shop', 'README.md');
  write(README, '---\nwinner: null\n---\n');
  assert.equal(count(out('5', U), /no winner/), 1, 'no winner → layout');
  write(README, '---\nwinner: "B"\n---\n');
  assert.equal(count(out('5', U), /pages:/), 1, 'winner, no pages → layout (pages)');
  edit(LAYOUT, (l) => (/^pages:/.test(l) ? 'pages: /, /cart' : l));
  assert.equal(ustep(), 'ui-phase', 'sketch chosen + pages → ui-phase');
  assert.equal(
    count(out('5', U), /^note=follow \.planning\/design\/DESIGN\.md and \.planning\/phases\/05-shop\/05-LAYOUT\.md/),
    1,
    '…ui-phase note names DESIGN.md + LAYOUT',
  );
  edit(LAYOUT, (l) => (/^sketch:/.test(l) ? 'sketch: skip tiny change' : l));
  assert.equal(ustep(), 'ui-phase', 'sketch: skip <reason> → ui-phase');
  rm(DESIGN);
  touch(path.join(UPD, '05-UI-SPEC.md'));
  assert.equal(ustep(), 'plan', 'UI-SPEC already there → pre-spec steps skipped');
  write(path.join(U, '.gsd.conf'), 'ui_gates = off\n');
  rm(path.join(UPD, '05-UI-SPEC.md'), LAYOUT);
  assert.equal(ustep('--ui'), 'ui-phase', 'ui_gates = off → straight to ui-phase');
  for (const f of ['05-UI-SPEC.md', '05-01-PLAN.md', '05-01-SUMMARY.md', '05-REVIEWS.md', '05-VERIFICATION.md']) touch(path.join(UPD, f));
  write(path.join(UPD, '05-UAT.md'), '---\nstatus: complete\n---\n');
  touch(path.join(UPD, '05-REVIEW.md'));
  commit('all');
  assert.equal(ustep(), 'ui-review', 'ui_gates = off → no ui-check step');
  rm(path.join(U, '.gsd.conf'));
  assert.equal(ustep(), 'ui-check', 'warn (default) → ui-check before ui-review');
  assert.equal(urun(), 'gsdt-ui check 5', '…run= gsdt-ui check 5');
  assert.equal(`${vals(out('5', U, '--all'), 'step').join(' ')} `, 'ui-check ui-look ui-approve ui-review validate secure done ', '…--all lists check, look, approve, review');
  const CHECK = path.join(UPD, '05-UI-CHECK.md');
  write(CHECK, '---\nstatus: error\nerror: nothing answers at http://localhost:3005\n---\n');
  assert.equal(ustep(), 'ui-check', 'a run that could not finish → ui-check');
  assert.equal(count(unote(), /nothing answers/), 1, '…the note says why');
  uiFixCheck(UPD, '05', 'failed');
  assert.equal(`${ustep()}/${count(unote(), /waive:/)}`, 'ui-check/1', 'failed check → ui-check, note names waive:');
  uiFixCheck(UPD, '05', 'passed', 'cap1', '0000000000000000000000000000000000000000');
  assert.equal(ustep(), 'ui-check', 'code changed since the check → ui-check');
  assert.equal(count(unote(), /the code or 05-LAYOUT\.md changed after the last check/), 1, '…the note says the code changed');
  const state = (): string => uiCodeState(U, env());
  uiFixCheck(UPD, '05', 'passed', 'cap1', state());
  assert.equal(ustep(), 'ui-look', 'check made on this code → ui-look');
  assert.equal(urun(), 'gsdt-ui look 5', '…run= gsdt-ui look 5');
  commit('ui check');
  assert.equal(ustep(), 'ui-look', 'a commit of .planning files keeps it fresh');
  write(path.join(U, 'app.js'), 'code\n');
  assert.equal(ustep(), 'ui-check', 'a new code file → ui-check again');
  rm(path.join(U, 'app.js'));
  uiFixLook(UPD, '05', 'cap1', 'ok', 'R1 R2 R3');
  assert.equal(ustep(), 'ui-look', 'a look with rules deleted → still ui-look');
  uiFixLook(UPD, '05', 'cap1', 'bad');
  assert.equal(`${ustep()}/${count(unote(), /marked bad/)}`, 'ui-look/1', 'a line marked bad → ui-look');
  uiFixLook(UPD, '05', 'cap0');
  assert.equal(ustep(), 'ui-look', 'a look of older pictures → ui-look');
  uiFixLook(UPD, '05', 'cap1');
  edit(path.join(UPD, '05-UI-LOOK.md'), (l) => (l === '- R4: ok — seen in the picture' ? '- R4: ok' : l));
  assert.equal(ustep(), 'ui-look', 'an answer without its text → ui-look');
  uiFixLook(UPD, '05', 'cap1');
  assert.equal(ustep(), 'ui-approve', 'every picture and rule answered → ui-approve');
  assert.equal(count(out('5', U), /^stop=show the user the sheet/), 1, '…stop= asks the user first');
  assert.equal(join(vals(out('5', U), 'then')), 'gsdt-ui approve 5', '…then= gsdt-ui approve 5');
  uiFixApproval(UPD, '05', 'cap0');
  assert.equal(ustep(), 'ui-approve', 'an approval of older pictures → ui-approve');
  uiFixApproval(UPD, '05', 'cap1');
  assert.equal(ustep(), 'ui-review', 'approved → ui-review');
  assert.equal(count(unote(), /hold the pictures in 05-SHOTS\//), 1, '…the note holds the pictures against the sketch');
  write(CHECK, '---\nstatus: skipped\nskipped: the app needs a VPN\n---\n');
  assert.equal(ustep(), 'ui-approve', 'skipped check, approval of pictures → ui-approve');
  write(path.join(UPD, '05-UI-APPROVAL.md'), '---\nstatus: waived\nreason: the app needs a VPN\n---\n');
  assert.equal(`${ustep()}/${unote()}`, 'ui-review/phase has screens', 'skipped check + waived approval → ui-review');
  // A review written in the phase's own worktree exempts nothing…
  rm(CHECK, path.join(UPD, '05-UI-APPROVAL.md'), path.join(UPD, '05-UI-LOOK.md'));
  touch(path.join(UPD, '05-UI-REVIEW.md'));
  commit('review in the worktree');
  assert.equal(ustep(), 'ui-check', 'UI-REVIEW.md only in this branch → ui-check');
  // …one that is already on the base branch does (the phase predates the checks).
  git(U, 'branch', '-f', 'develop', 'phase-5-shop');
  assert.equal(ustep(), 'validate', 'UI-REVIEW.md on the base branch → no UI steps');
});
