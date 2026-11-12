// P7 parity (gsdt-finish): the TypeScript command behind bin/gsdt-finish against the
// pre-P7 bash command (tests/fixtures/p7-old-bins/gsdt-finish, which runs the old
// gsdt-wt-finish), each on its own copy of the same fixture project. Compared: stdout,
// stderr, exit code of every step, and the files/commits/branches/worktrees/origin,
// the tracker log, the gh log and the doctor log left behind.
// Run: node --test tests/ts/p7-finish.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  E,
  RACE_CONF,
  TRACKER_CONF,
  addTracker,
  batch,
  fin,
  git,
  noGhPath,
  onMain,
  phase,
  racer,
  scenario,
  tools,
  write,
  type Side,
} from './p7-helpers.ts';

const T = (s: Side): void => tools(s);
const both = (...fs: Array<(s: Side) => void>) => (s: Side): void => fs.forEach((f) => f(s));
const P = both(T, (s) => void phase(s));
const wt = (s: Side, d = 'phase-1-catalog'): string => path.join(s.wtdir, d);
const tmpCwd = (): string => mkdtempSync(path.join(tmpdir(), 'gsd-p7-'));
const TK = '# Roadmap\n\n### Phase 1: catalog tk-ABC-1\n';

test('--help is the same text, wherever it sits', () => {
  scenario({}, null, [
    fin(['--help'], { rc: 0, out: /^gsdt-finish — finish a GSD phase: merge back, push, clean up\n/ }),
    fin(['-h'], { rc: 0 }),
    fin(['1', '--pr', '--help'], { rc: 0 }),
    fin(['--bogus', '--help'], { rc: 1 }), // the first problem wins
  ]);
});

test('usage errors', () => {
  scenario({}, P, [
    fin(['--bogus'], { rc: 1, err: /✖ unknown flag: --bogus \(see gsdt-finish --help\)\n/ }),
    fin(['--repo'], { rc: 1, err: /✖ --repo needs a value/ }),
    fin(['1', '2'], { rc: 1, err: /✖ unexpected argument: 2/ }),
    fin(['--repo', '/nonexistent/x', '1'], { rc: 1, err: /✖ --repo path not found: \/nonexistent\/x/ }),
    fin(['--pr', '--draft', '--bogus'], { rc: 1 }),
    fin([], { rc: 1, err: /✖ no phase given and current branch 'main' is not a phase-\* or batch-\* worktree\n✖ usage: gsdt-finish \[N \| phase-N-slug \| batch-…\] \[--repo <path>\]\n/ }),
    fin(['foo'], { rc: 1, err: /✖ finish requires a phase number, a phase-N-slug branch or a batch-\* branch/ }),
    fin(['phase-x'], { rc: 1 }),
    fin(['1.'], { rc: 1 }),
    fin([''], { rc: 1, err: /no phase given/ }),
  ]);
  scenario({}, null, [fin(['1'], { rc: 1, err: /✖ not inside a git repo — cd into the repo\/worktree or pass --repo <path>/, cwd: tmpCwd })]);
  scenario({}, both(T, (s) => {
    phase(s);
    git(s.R, 'branch', 'phase-1-catalog-pr', 'phase-1-catalog');
  }), [
    fin(['phase-1-catalog-pr'], { rc: 1, err: /✖ finish the phase branch, not a PR-helper branch/ }),
    fin(['9'], { rc: 1, err: /no 'phase-9-\*' branch found/ }),
  ]);
  // no base branch can be told (detached HEAD in a repo with neither develop nor main)
  scenario({ conf: null }, both(T, (s) => {
    git(s.R, 'branch', '-m', 'trunk');
    git(s.R, 'checkout', '-q', '--detach');
  }), [fin(['1'], { rc: 1, err: /✖ could not determine the base branch — set 'base = <branch>' in .*\/\.gsd\.conf/ })]);
});

test('--repo from outside the repo, by number and by branch', () => {
  scenario({}, P, [fin((s) => ['1', '--repo', s.R], { cwd: tmpCwd, rc: 0, out: /If your shell was inside the removed worktree: {2}cd .*shop\n$/ })]);
  scenario({}, P, [fin((s) => ['--repo', wt(s), 'phase-1-catalog'], { cwd: tmpCwd, rc: 0 })]);
});

test('no argument: the branch of the worktree it runs in', () => {
  scenario({}, P, [fin([], { cwd: (s) => wt(s), rc: 0, out: /▶ syncing local 'main'[^]*merged into 'main', pushed, and cleaned up\.\n\nIf your shell/ })]);
  scenario({ conf: 'install = none\ntest = none\nflow = strict\nui_gates = strict\n' }, both(T, (s) => void batch(s)), [fin([], { cwd: (s) => wt(s, 'batch-2026-11-09-fix'), rc: 0 })]);
  scenario({}, both(T, (s) => void batch(s)), [fin(['batch-2026-11-09-fix'], { rc: 0 })]);
  scenario({}, both(T, (s) => void batch(s, 'batch-2026-11-09-fix', { 'b.txt': 'x' })), [fin(['batch-nope'], { rc: 1, err: /branch 'batch-nope' not found/ })]);
  // a worktree on another kind of branch
  scenario({}, both(T, (s) => {
    git(s.R, 'worktree', 'add', '-q', '-b', 'feature-x', path.join(s.wtdir, 'feature-x'));
  }), [fin([], { cwd: (s) => wt(s, 'feature-x'), rc: 1, err: /current branch 'feature-x' is not a phase-\* or batch-\*/ })]);
});

test('the main checkout is switched back to the base branch when clean', () => {
  scenario({}, both(P, (s) => git(s.R, 'checkout', '-qb', 'parked')), [
    fin(['1'], { rc: 0, out: /▶ main checkout was on 'parked' — switching to 'main'…\n/ }),
  ]);
  scenario({}, both(P, (s) => {
    git(s.R, 'checkout', '-qb', 'parked');
    write(path.join(s.R, 'wip.txt'), 'wip');
  }), [
    fin(['1'], { rc: 1, err: /✖ main checkout is on 'parked' with uncommitted changes — clean it up, then re-run/ }),
  ]);
  // the base branch to switch to does not exist locally
  scenario({ conf: 'install = none\ntest = none\nbase = gone\n' }, P, [fin(['1'], { rc: 1, err: /pathspec 'gone' did not match/ })]);
});

test('the worker\'s verdict is the command\'s: no ticket, no "cd" line when it fails', () => {
  scenario({ conf: 'install = none\ntest = false\n' }, P, [fin(['1'], { rc: 1, err: /tests failed \(before merge\)/, not: /If your shell/ })]);
  scenario({ roadmap: TK, conf: TRACKER_CONF }, both(P, addTracker, (s) => onMain(s, { 'f.txt': 'main\n' })), [
    fin(['1'], { rc: 1, err: /merge conflict/, not: /If your shell/ }),
  ]);
  // lands with the files the tests left in the worktree removed
  scenario({ conf: 'install = none\ntest = mkdir -p cov && echo a > cov/out\n' }, P, [fin(['1'], { rc: 0, out: /removing files the tests left/ })]);
  // a push that never works
  scenario({}, both(P, (s) => write(path.join(s.origin, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', 0o755)), [fin(['1'], { rc: 1, err: /could not push/ })]);
  // a competing session
  scenario({ conf: RACE_CONF }, both(T, racer, (s) => void phase(s)), [fin(['1'], { rc: 0, out: /push rejected/ })]);
  scenario({ noOrigin: true }, P, [fin(['1'], { rc: 0, out: /skipping push/ })]);
  // a stale lock is reclaimed once (finish takes it; the worker is told it is held)
  scenario({}, both(P, (s) => {
    write(path.join(s.R, '.git/gsd-cmd.lock/pid'), '2999999\n');
  }), [fin(['1'], { rc: 0, out: /^▶ reclaimed stale gsd lock \(owner PID 2999999 no longer running\)\n/ })]);
});

test('an old repo (before 0.10.0) is refused', () => {
  scenario({ files: { 'scripts/gsd-new-worktree-feature.sh': '#!/bin/sh\n' } }, P, [
    fin(['1'], { rc: 1, err: /this repo uses the old gsd-\* names \(before 0\.10\.0\) — run: gsdt-migrate --apply\n {2}\(in .*shop; plain gsdt-migrate first shows what it changes\)\n/ }),
  ]);
});

test('tickets: the id from the ROADMAP title, the branch name, none; the tracker failing; a batch has none', () => {
  const tk = (extra = '') => ({ roadmap: TK, conf: TRACKER_CONF + extra });
  const prep = both(P, addTracker);
  scenario(tk(), prep, [fin(['1'], { rc: 0, out: /^[^]*merged into 'main', pushed, and cleaned up\.\n\nIf your shell/ })]);
  scenario(tk('tracker_status_finish = Testing\n'), prep, [fin(['phase-1-catalog'], { rc: 0 })]);
  // the tracker fails: a note, still 0
  scenario(tk(), prep, [fin(['1'], { rc: 0, env: E({ TRACKER_FAIL: '1' }), out: /• ticket ABC-1 not updated \(non-fatal\) — check: gsdt-tracker check\n/ })]);
  // the id only in the branch name (lowercased slug)
  scenario({ roadmap: '# Roadmap\n\n### Phase 1: catalog\n', conf: TRACKER_CONF }, both(T, (s) => void phase(s, '1', 'catalog-tk-abc-9'), addTracker), [fin(['1'], { rc: 0 })]);
  // a title without a tag and a branch without one: nothing to update
  scenario({ conf: TRACKER_CONF }, prep, [fin(['1'], { rc: 0 })]);
  // tracker = none: the ticket in the title is not acted on
  scenario({ roadmap: TK }, P, [fin(['1'], { rc: 0 })]);
  // legacy cu_ tag
  scenario({ roadmap: '# Roadmap\n\n### Phase 1: catalog cu_abc123\n', conf: TRACKER_CONF }, prep, [fin(['1'], { rc: 0 })]);
  // zero-padded phase heading and decimal numbers
  scenario({ roadmap: '# Roadmap\n\n### Phase 2.1: hot tk-ABC-2\n', conf: TRACKER_CONF }, both(T, (s) => void phase(s, '2.1', 'hot'), addTracker), [fin(['2.1'], { rc: 0 })]);
  // a batch: no ticket even with a tracker
  scenario(tk(), both(T, (s) => void batch(s), addTracker), [fin(['batch-2026-11-09-fix'], { rc: 0 })]);
  // an unknown tracker name
  scenario({ roadmap: TK, conf: 'install = none\ntest = none\ntracker = bogus\n' }, P, [fin(['1'], { rc: 0 })]);
});

test('roadmap bookkeeping: the doctor note, quiet when there is none', () => {
  const rows = '  ⚠ T021 phase 1: no checklist row in ROADMAP.md\n  ✓ other check\n  ⚠ T022 Progress table has no row for phase 1\n  tick me\n';
  scenario({}, P, [fin(['1'], { rc: 0, env: E({ DOCTOR_OUT: rows }), out: /⚠ roadmap bookkeeping needs a hand \(the merge itself is fine\):\n {2}⚠ T021[^]*tick me\n {2}full report: gsdt-doctor\n\nIf your shell/ })]);
  scenario({}, P, [fin(['1'], { rc: 0, env: E({ DOCTOR_OUT: '  ✓ all fine\n' }), not: /bookkeeping/ })]);
  scenario({}, P, [fin(['1'], { rc: 0, not: /bookkeeping/ })]);
  // no gsdt-doctor on PATH: skipped
  scenario({}, both(P, (s) => rmSync(path.join(s.stub, 'gsdt-doctor'))), [fin(['1'], { rc: 0, env: E({ DOCTOR_OUT: 'tick' }), not: /bookkeeping/ })]);
  // a doctor that fails is ignored
  scenario({}, both(P, (s) => write(path.join(s.stub, 'gsdt-doctor'), '#!/bin/sh\nexit 127\n', 0o755)), [fin(['1'], { rc: 0 })]);
});

test('--pr: push the branch and open a PR, change nothing else', () => {
  scenario({}, P, [
    fin(['1', '--pr'], { rc: 0, out: /▶ pushing 'phase-1-catalog'…\n▶ opening PR phase-1-catalog → main…\nhttps:\/\/github\.com\/x\/y\/pull\/1\n\nWorktree kept\. After the PR merges: {2}gsdt-finish phase-1-catalog\n$/ }),
    fin(['1', '--pr'], { rc: 0 }), // again: nothing new to push, the PR call repeats
  ]);
  scenario({}, P, [fin(['1', '--pr', '--draft'], { rc: 0, out: /pull\/1/ }), fin(['phase-1-catalog', '--draft', '--pr'], { rc: 0 })]);
  scenario({}, P, [fin(['--pr'], { cwd: (s) => wt(s), rc: 0, out: /opening PR phase-1-catalog → main/ })]);
  // the first gh call (with --fill-verbose, stderr hidden) fails: the second runs
  scenario({}, P, [fin(['1', '--pr'], { rc: 0, env: E({ GH_MODE: 'first' }), out: /pull\/2/ })]);
  // both fail
  scenario({}, P, [fin(['1', '--pr'], { rc: 1, env: E({ GH_MODE: 'fail' }), err: /✖ gh pr create failed \(is origin a GitHub repo and gh authenticated\?\)/ })]);
  // no gh on PATH
  scenario({}, both((s) => tools(s, { gh: false }), (s) => void phase(s)), [fin(['1', '--pr'], { rc: 1, env: E((s) => ({ PATH: `${s.stub}${path.delimiter}${noGhPath}` })), err: /✖ --pr needs the GitHub CLI \(gh\) on PATH/ })]);
  // the title is the ROADMAP heading
  scenario({ roadmap: '# Roadmap\n\n### Phase 1: Catalog rework\n' }, P, [fin(['1', '--pr'], { rc: 0 })]);
  // a -pr helper branch is what gets pushed
  scenario({}, both(P, (s) => git(s.R, 'branch', 'phase-1-catalog-pr', 'phase-1-catalog')), [fin(['1', '--pr'], { rc: 0, out: /pushing 'phase-1-catalog-pr'…\n▶ opening PR phase-1-catalog-pr → main/ })]);
  // no origin: the push fails
  scenario({ noOrigin: true }, P, [fin(['1', '--pr'], { rc: 1, err: /✖ push of 'phase-1-catalog' failed — if origin has newer commits, run 'git pull --rebase origin phase-1-catalog'/ })]);
  // refusals before the push
  scenario({}, P, [
    fin(['9', '--pr'], { rc: 1, err: /✖ no phase-9-\* branch found/ }),
    fin(['phase-9-nope', '--pr'], { rc: 1, err: /✖ branch 'phase-9-nope' not found/ }),
    fin(['batch-nope', '--pr'], { rc: 1, err: /✖ branch 'batch-nope' not found/ }),
  ]);
  // a batch
  scenario({ conf: 'install = none\ntest = none\nflow = strict\nui_gates = strict\n' }, both(T, (s) => void batch(s)), [fin(['batch-2026-11-09-fix', '--pr'], { rc: 0, out: /opening PR batch-2026-11-09-fix → main/ })]);
  // the main checkout parked elsewhere is switched back first
  scenario({}, both(P, (s) => git(s.R, 'checkout', '-qb', 'parked')), [fin(['1', '--pr'], { rc: 0, out: /switching to 'main'/ })]);
  // the PR path does not need the merge's sync, and holds the lock to the end
  scenario({ conf: 'install = none\ntest = false\n' }, P, [fin(['1', '--pr'], { rc: 0 })]);
});

test('--pr: the gates, with the worktree and without it', () => {
  const ui = { conf: 'install = none\ntest = none\nui_gates = strict\n' };
  const withUi = both(T, (s) => void phase(s, '1', 'catalog', { 'f.txt': 'x\n', '.planning/phases/01-catalog/01-UI-SPEC.md': '' }));
  scenario(ui, withUi, [
    fin(['1', '--pr'], { rc: 1, err: /UI steps are open \(ui_gates = strict\)[^]*✖ no PR was opened\n/ }),
    fin(['1', '--pr'], { rc: 0, env: E({ GSD_SKIP_GUARD: '1' }), err: /finishing anyway/ }),
  ]);
  const strict = { conf: 'install = none\ntest = none\nflow = strict\n' };
  const audit = both(T, (s) => void phase(s, '1', 'catalog', { 'f.txt': 'x\n', '.planning/phases/01-catalog/.gitkeep': '' }));
  scenario(strict, audit, [
    fin(['1', '--pr'], { rc: 1, err: /has no test audit \(flow = strict\)[^]*✖ no PR was opened/ }),
    fin(['1'], { rc: 1, err: /Nothing was merged\. The phase worktree is kept\./ }),
    fin(['1', '--pr'], { rc: 0, env: E({ GSD_SKIP_GUARD: '1' }) }),
  ]);
  scenario(strict, both(audit, (s) => git(s.R, 'worktree', 'remove', wt(s))), [fin(['1', '--pr'], { rc: 1, err: /has no test audit/ })]);
});

test('--pr with a ticket: the tracker hears about the PR', () => {
  const tk = { roadmap: TK, conf: TRACKER_CONF };
  scenario(tk, both(P, addTracker), [fin(['1', '--pr'], { rc: 0 })]);
  scenario(tk, both(P, addTracker), [fin(['1', '--pr'], { rc: 0, env: E({ TRACKER_FAIL: '1' }), out: /• ticket ABC-1 not updated \(non-fatal\)/ })]);
  // the PR first, then the merge after it landed (the branch tracks origin now)
  scenario(tk, both(P, addTracker), [fin(['1', '--pr'], { rc: 0 }), fin(['1'], { rc: 0 })]);
});

test('--repo given twice: the last one wins (as before)', () => {
  scenario({}, P, [fin((s) => ['--repo', '/nonexistent', '--repo', s.R, '1'], { cwd: tmpCwd, rc: 0 })]);
});
