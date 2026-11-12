// P7 parity (gsdt-wt-finish): the TypeScript command behind bin/gsdt-wt-finish against
// the pre-P7 bash command (tests/fixtures/p7-old-bins/gsdt-wt-finish), each on its own
// copy of the same fixture project. Compared: stdout, stderr, exit code of every step,
// and the files/commits/branches/worktrees/origin left behind.
// Run: node --test tests/ts/p7-wt-finish.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  E,
  RACE_CONF,
  ROADMAP_RICH,
  batch,
  commitAll,
  git,
  makeSide,
  onMain,
  phase,
  racer,
  runStep,
  scenario,
  sub,
  tools,
  wf,
  write,
  type Side,
} from './p7-helpers.ts';

const T = (s: Side): void => tools(s);
const wt = (s: Side, d = 'phase-1-catalog'): string => path.join(s.wtdir, d);
const both = (...fs: Array<(s: Side) => void>) => (s: Side): void => fs.forEach((f) => f(s));
const P = both(T, (s) => void phase(s));

test('usage and refusals', () => {
  scenario({}, both(T, (s) => {
    phase(s);
    git(s.R, 'branch', 'phase-1-catalog-pr', 'phase-1-catalog');
  }), [
    wf([], { rc: 1, err: /usage: gsdt-wt-finish/ }),
    wf([''], { rc: 1, err: /usage: gsdt-wt-finish/ }),
    wf(['--help'], { rc: 1, err: /finish requires a phase number/ }),
    wf(['foo'], { rc: 1, err: /finish requires/ }),
    wf(['phase-x'], { rc: 1 }),
    wf(['1.x'], { rc: 1 }),
    wf(['9'], { rc: 1, err: /no 'phase-9-\*' branch found/ }),
    wf(['phase-9-nope'], { rc: 1, err: /branch 'phase-9-nope' not found/ }),
    wf(['batch-nope'], { rc: 1, err: /branch 'batch-nope' not found/ }),
    wf(['phase-1-catalog-pr'], { rc: 1, err: /PR-helper branch/ }),
    wf(['phase-1-catalog-pr', 'main'], { rc: 1 }),
  ]);
});

test('not inside a git repository (NOT parity: the bash exited 128 in silence — its failed `git worktree list` pipeline hit set -e)', () => {
  const s = makeSide('new');
  const r = runStep(s, wf(['1'], { cwd: () => mkdtempSync(path.join(tmpdir(), 'gsd-p7-')) }));
  assert.equal(r.rc, 1);
  assert.equal(r.err, 'error: not inside a git repository\n');
  const o = makeSide('old');
  const ro = runStep(o, wf(['1'], { cwd: () => mkdtempSync(path.join(tmpdir(), 'gsd-p7-')) }));
  assert.equal(ro.rc, 128);
  assert.equal(ro.err, '');
});

test('uncommitted changes, main on another branch, an explicit base', () => {
  scenario({}, both(T, (s) => void phase(s), (s) => write(path.join(wt(s), 'dirty.txt'), 'x')), [
    wf(['1'], { rc: 1, err: /has uncommitted changes — commit them in the worktree first/ }),
    wf(['phase-1-catalog'], { rc: 1, err: /has uncommitted changes/ }),
  ]);
  scenario({}, both(T, (s) => void phase(s), (s) => git(s.R, 'checkout', '-qb', 'other')), [
    wf(['1'], { rc: 1, err: /main checkout is on 'other', not 'main'/ }),
    wf(['1', 'nobase'], { rc: 1, err: /main checkout is on 'other', not 'nobase'/ }),
    wf(['1', 'other'], { rc: 1, err: /origin has no 'other' branch/ }),
    wf(['1', 'main'], { rc: 1, err: /main checkout is on 'other', not 'main'/ }),
  ]);
});

test('lands: by number, by branch, padded and decimal numbers, an explicit base, an empty base', () => {
  scenario({}, P, [wf(['1'], { rc: 0, out: /merged into 'main', pushed, and cleaned up/ })]);
  scenario({}, P, [wf(['phase-1-catalog', 'main'], { rc: 0 })]);
  scenario({}, P, [wf(['1', ''], { rc: 0 })]);
  scenario({}, both(T, (s) => void phase(s, '02.1', 'hot')), [wf(['02.1'], { rc: 0 })]);
  scenario({}, both(T, (s) => void phase(s, '02.1', 'hot')), [wf(['phase-02.1-hot'], { rc: 0 })]);
  scenario({}, both(T, (s) => void phase(s, '2', 'two')), [wf(['2'], { rc: 0 })]);
  // the lock is held by the caller
  scenario({}, P, [wf(['1'], { rc: 0, env: E({ GSD_LOCK_HELD: '1' }) })]);
  // a worktree outside the conventional dir
  scenario({}, both(T, (s) => void phase(s, '1', 'catalog', undefined, path.join(s.root, 'elsewhere', 'wt'))), [wf(['1'], { rc: 0 })]);
  // a stale lock is reclaimed
  scenario({}, both(P, (s) => {
    mkdirSync(sub(s, '.git/gsd-cmd.lock'));
    writeFileSync(sub(s, '.git/gsd-cmd.lock/pid'), '2999999\n');
  }), [wf(['1'], { rc: 0, out: /reclaimed stale gsd lock/ })]);
});

test('no origin: no sync, no push', () => {
  scenario({ noOrigin: true }, P, [wf(['1'], { rc: 0, out: /no 'origin' remote — skipping push/ })]);
});

test('a batch worktree lands without the per-phase gates', () => {
  scenario({ conf: 'install = none\ntest = none\nflow = strict\nui_gates = strict\n' }, both(T, (s) => void batch(s)), [
    wf(['batch-2026-11-09-fix'], { rc: 0, out: /'batch-2026-11-09-fix' merged into 'main'/ }),
  ]);
  scenario({ conf: 'install = false\ntest = false\n' }, both(T, (s) => void batch(s)), [
    wf(['batch-2026-11-09-fix'], { rc: 1, err: /tests failed \(before merge\) — not pushing or removing the batch worktree/ }),
  ]);
});

test('the sync with origin', () => {
  // origin has no base branch
  scenario({}, both(P, (s) => git(s.origin, 'update-ref', '-d', 'refs/heads/main')), [wf(['1'], { rc: 1, err: /origin has no 'main' branch — push it first/ })]);
  // origin unreachable
  scenario({}, both(P, (s) => git(s.R, 'remote', 'set-url', 'origin', path.join(s.root, 'gone.git'))), [wf(['1'], { rc: 1, err: /could not synchronize 'main'/ })]);
  // diverged
  scenario({}, both(P, racer, (s) => {
    write(path.join(s.root, 'racer', 'o.txt'), 'o');
    commitAll(path.join(s.root, 'racer'), 'theirs');
    git(path.join(s.root, 'racer'), 'push', '-q', 'origin', 'main');
    onMain(s, { 'mine.txt': 'm' }, { push: false });
  }), [wf(['1'], { rc: 1, err: /could not synchronize 'main'; resolve remote connectivity or divergence/ })]);
  // origin ahead: fast-forwarded first
  scenario({}, both(P, racer, (s) => {
    write(path.join(s.root, 'racer', 'o.txt'), 'o');
    commitAll(path.join(s.root, 'racer'), 'theirs');
    git(path.join(s.root, 'racer'), 'push', '-q', 'origin', 'main');
  }), [wf(['1'], { rc: 0, out: /Fast-forward/ })]);
});

test('the gates: UI steps, test audit', () => {
  const ui = { conf: 'install = none\ntest = none\nui_gates = strict\n' };
  const withUi = both(T, (s) => void phase(s, '1', 'catalog', { 'f.txt': 'x\n', '.planning/phases/01-catalog/01-UI-SPEC.md': '' }));
  scenario(ui, withUi, [
    wf(['1'], { rc: 1, err: /UI steps are open \(ui_gates = strict\)/ }),
    wf(['1'], { rc: 1, err: /Nothing was merged\. The phase worktree is kept\./, env: E({ GSD_SKIP_GUARD: undefined }) }),
    wf(['1'], { rc: 0, env: E({ GSD_SKIP_GUARD: '1' }), err: /finishing anyway/ }),
  ]);
  scenario({ conf: 'install = none\ntest = none\n' }, withUi, [wf(['1'], { rc: 0, err: /UI steps are open/ })]); // warn (default)
  const strict = { conf: 'install = none\ntest = none\nflow = strict\n' };
  const audit = both(T, (s) => void phase(s, '1', 'catalog', { 'f.txt': 'x\n', '.planning/phases/01-catalog/.gitkeep': '' }));
  scenario(strict, audit, [
    wf(['1'], { rc: 1, err: /has no test audit \(flow = strict\)/ }),
    wf(['1'], { rc: 0, env: E({ GSD_SKIP_GUARD: '1' }) }),
  ]);
  // the audit is there
  scenario(strict, both(T, (s) => void phase(s, '1', 'catalog', { 'f.txt': 'x\n', '.planning/phases/01-catalog/01-VALIDATION.md': '---\nnyquist_compliant: true\n---\n' })), [wf(['1'], { rc: 0 })]);
  // the worktree is gone: the gates read the branch
  scenario(strict, both(audit, (s) => git(s.R, 'worktree', 'remove', wt(s))), [
    wf(['1'], { rc: 1, err: /has no test audit/ }),
    wf(['1'], { rc: 0, env: E({ GSD_SKIP_GUARD: '1' }), out: /worktree already removed/ }),
  ]);
});

test('the pre-merge script: passes, fails, not executable, none, absolute path', () => {
  const hook = (body: string, mode = 0o755) => both(P, (s) => onMain(s, { 'scripts/gsdt-premerge-check.sh': body }, { mode }));
  scenario({}, hook('#!/bin/sh\necho "check $1 $2 in $(pwd -P | sed "s|.*/||")"\n'), [wf(['1'], { rc: 0, out: /pre-merge check \(scripts\/gsdt-premerge-check\.sh\)…\ncheck phase-1-catalog main in shop/ })]);
  scenario({}, hook('#!/bin/sh\necho no >&2\nexit 3\n'), [wf(['1'], { rc: 1, err: /validation failed \(before merge\) — not pushing or removing the phase worktree/ })]);
  scenario({}, hook('#!/bin/sh\nexit 0\n', 0o644), [wf(['1'], { rc: 1, err: /scripts\/gsdt-premerge-check\.sh exists but is not executable/ })]);
  scenario({ conf: 'install = none\ntest = none\npremerge = none\n' }, hook('#!/bin/sh\nexit 3\n'), [wf(['1'], { rc: 0 })]);
  scenario({ conf: 'install = none\ntest = false\npremerge = none\n' }, hook('#!/bin/sh\nexit 0\n', 0o644), [wf(['1'], { rc: 1, err: /skip with 'test = none' in \.gsd\.conf, or provide none/ })]);
  scenario({ conf: 'install = none\ntest = false\n' }, hook('#!/bin/sh\nexit 0\n'), [wf(['1'], { rc: 0 })]); // the script wins over tests
  scenario({ conf: 'install = none\npremerge = custom/check.sh\n' }, both(P, (s) => onMain(s, { 'custom/check.sh': '#!/bin/sh\necho custom $1\n' }, { mode: 0o755 })), [wf(['1'], { rc: 0, out: /custom phase-1-catalog/ })]);
  scenario({}, both(P, (s) => {
    write(path.join(s.root, 'abs.sh'), '#!/bin/sh\necho abs ok\n', 0o755);
    write(sub(s, '.gsd.conf'), `install = none\npremerge = ${path.join(s.root, 'abs.sh')}\n`);
    commitAll(s.R, 'conf');
    git(s.R, 'push', '-q', 'origin', 'main');
  }), [wf(['1'], { rc: 0, out: /abs ok/ })]);
});

test('the test command: passes, fails, in which dir, after the merge, a missing dir', () => {
  scenario({ conf: 'install = none\ntest = echo ran-here; pwd -P | sed "s|.*/||"\n' }, P, [wf(['1'], { rc: 0, out: /tests \(echo ran-here.*in .*phase-1-catalog; before merge\)…\nran-here\nphase-1-catalog\n.*combined tree after phase merge/s })]);
  scenario({ conf: 'install = none\ntest = echo boom >&2; exit 3\n' }, P, [wf(['1'], { rc: 1, err: /boom\n✗ tests failed \(before merge\) — not pushing or removing the phase worktree\. Any merge remains local\.\n {2}\(skip with 'test = none' in \.gsd\.conf, or provide scripts\/gsdt-premerge-check\.sh\)/ })]);
  // passes in the worktree (a .git file), fails in the main checkout (a .git dir): the merge is kept local
  scenario({ conf: 'install = none\ntest = [ -f .git ]\n' }, P, [wf(['1'], { rc: 1, err: /tests failed \(combined tree after phase merge\)/ })]);
  // the worktree dir is gone by hand and tests exist: cd fails (bash's own wording differs; checked on the new side below)
  scenario({ conf: 'install = none\ntest = none\n' }, both(P, (s) => rmSync(wt(s), { recursive: true })), [wf(['1'], { rc: 0, out: /worktree already removed/ })]);
});

test('NOT parity: tests in a worktree dir that is gone fail with our own cd message', () => {
  const s = makeSide('new', { conf: 'install = none\ntest = true\n' });
  tools(s);
  phase(s);
  rmSync(wt(s), { recursive: true });
  const r = runStep(s, wf(['1']));
  assert.equal(r.rc, 1);
  assert.match(r.err, /cd: .*phase-1-catalog: No such file or directory\n✗ tests failed \(before merge\)/);
});

test('a conflicting merge is aborted and the base left clean', () => {
  scenario({}, both(P, (s) => onMain(s, { 'f.txt': 'main version\n' })), [
    wf(['1'], { rc: 1, err: /merge conflict with 'main' — aborted, 'main' left clean\. Conflicts: f\.txt \n {2}Resolve in the worktree: git -C .*phase-1-catalog merge main/ }),
    wf(['1'], { rc: 1 }), // again: same state
  ]);
  // two conflicting files
  scenario({}, both(T, (s) => void phase(s, '1', 'catalog', { 'a.txt': '1\n', 'b.txt': '1\n' }), (s) => onMain(s, { 'a.txt': '2\n', 'b.txt': '2\n' })), [wf(['1'], { rc: 1, err: /Conflicts: a\.txt b\.txt \n/ })]);
});

test('.planning: the driver reconciles a conflicting ROADMAP; the repair runs after the merge', () => {
  const rm = ROADMAP_RICH;
  const mk = both(T, (s) => {
    write(sub(s, '.gitattributes'), '.planning/ROADMAP.md merge=gsd-planning\n.planning/STATE.md merge=gsd-planning\n');
    commitAll(s.R, 'attrs');
    git(s.R, 'push', '-q', 'origin', 'main');
    const d = phase(s, '1', 'catalog', { 'f.txt': 'x\n' });
    write(path.join(d, '.planning/ROADMAP.md'), rm.replace('| 1. Catalog | 1/1 | Complete |', '| 1. Catalog | 1/1 | In Progress |'));
    commitAll(d, 'roadmap');
    onMain(s, { '.planning/ROADMAP.md': rm.replace('| 1. Catalog | 1/1 | Complete |', '| 1. Catalog | 0/1 | Planned |') });
  });
  scenario({ roadmap: rm }, mk, [wf(['1'], { out: /reconciling \.planning after the phase merge/ })]);
  // a plain tick on the branch: merged, repaired
  scenario({ roadmap: rm.replace('- [x]', '- [ ]') }, both(T, (s) => {
    const d = phase(s, '1', 'catalog', { 'f.txt': 'x\n' });
    write(path.join(d, '.planning/ROADMAP.md'), rm);
    commitAll(d, 'tick');
  }), [wf(['1'], { rc: 0 })]);
  scenario({ roadmap: rm }, P, [wf(['1'], { rc: 1, env: E({ REPAIR_MODE: 'badcheck' }), err: /STILL self-contradictory after the repair — not pushing\.\nstub: ROADMAP is self-contradictory\nstub check failed\n {2}The merge is committed locally only/ })]);
  scenario({ roadmap: rm }, P, [wf(['1'], { rc: 0, env: E({ REPAIR_MODE: 'failcommit' }), err: /stub repair broke\n⚠ \.planning reconcile exited nonzero — verifying before we go on/ })]);
  scenario({ roadmap: rm }, P, [wf(['1'], { rc: 1, env: E({ REPAIR_MODE: 'dirty' }), err: /the \.planning repair was not committed — not pushing\.\n\?\? \.planning\/NOTES\.md\n {2}Commit it, then re-run finish\./ })]);
  // no repair tool on PATH: a warning, and the finish goes on
  scenario({ roadmap: rm }, both((s) => tools(s, { repair: false }), (s) => void phase(s)), [wf(['1'], { rc: 0, err: /gsdt-planning-repair not on PATH — skipping the \.planning reconcile/ })]);
  // no ROADMAP at all: nothing to reconcile
  scenario({}, both(P, (s) => {
    git(s.R, 'rm', '-q', '-f', '.planning/ROADMAP.md');
    commitAll(s.R, 'no roadmap');
    git(s.R, 'push', '-q', 'origin', 'main');
  }), [wf(['1'], { rc: 0 })]);
});

test('push: a competing session moved the base (retry), conflicts, a push that never works', () => {
  const rc = { conf: RACE_CONF };
  scenario(rc, both(T, racer, (s) => void phase(s)), [wf(['1'], { rc: 0, out: /push rejected \(parallel session moved 'main'\) — merging origin\/main and retrying…/ })]);
  scenario(rc, both(T, racer, (s) => void phase(s)), [wf(['1'], { rc: 0, env: E({ RACE_MODE: 'conflict' }) })].map((st) => ({ ...st, rc: 1, err: /conflict syncing with origin\/main — aborted, 'main' left clean\. Conflicts: f\.txt \n {2}Resolve manually: git -C .* pull --no-rebase origin main/ })));
  scenario({ conf: RACE_CONF, roadmap: ROADMAP_RICH }, both(T, racer, (s) => void phase(s)), [wf(['1'], { rc: 0, env: E({ RACE_MODE: 'roadmap' }) })]);
  // the race and the repair tool breaking: not pushed
  scenario(rc, both(T, racer, (s) => void phase(s)), [wf(['1'], { rc: 1, env: E({ REPAIR_MODE: 'badcheck' }), err: /not pushing/ })]);
  // origin refuses every push: three attempts
  scenario({}, both(P, (s) => write(path.join(s.origin, 'hooks/pre-receive'), '#!/bin/sh\necho "no pushes today" >&2\nexit 1\n', 0o755)), [
    wf(['1'], { rc: 1, out: /(push rejected[^]*){3}/, err: /could not push 'main' after 3 attempts — push manually, then re-run to clean up\./ }),
  ]);
  // the tests run again after the retry
  scenario({ conf: 'install = none\ntest = bash "$RACE_SH"; echo validated\n' }, both(T, racer, (s) => void phase(s)), [wf(['1'], { rc: 0, out: /validated\n[^]*after remote retry/ })]);
});

test('cleanup: files the tests left go, other changes keep the worktree (exit 0)', () => {
  scenario({ conf: 'install = none\ntest = mkdir -p cov && echo a > cov/out; echo b > leftover.txt\n' }, P, [
    wf(['1'], { rc: 0, out: /• removing files the tests left in the worktree:\n {4}cov\/\n {4}leftover\.txt\n/ }),
  ]);
  scenario({ conf: 'install = none\ntest = [ -f .git ] && echo more >> f.txt; true\n' }, P, [
    wf(['1'], { rc: 0, err: /has changes made while the finish ran — kept it and 'phase-1-catalog':\n M f\.txt\n {2}The phase IS merged and pushed\. Once you have looked at them:\n {4}git worktree remove --force ".*" && git branch -D phase-1-catalog\n/ }),
  ]);
  // untracked + modified: kept, with both listed
  scenario({ conf: 'install = none\ntest = [ -f .git ] && { echo more >> f.txt; echo n > new.txt; }; true\n' }, P, [wf(['1'], { rc: 0, err: /\?\? new\.txt/ })]);
  // gitignored files are not "left"
  scenario({ conf: 'install = none\ntest = echo i > ignored.log\n' }, both(T, (s) => void phase(s, '1', 'catalog', { 'f.txt': 'x\n', '.gitignore': '*.log\n' })), [wf(['1'], { rc: 0 })]);
});

test('worktree already removed: only the branch is cleaned up', () => {
  scenario({}, both(P, (s) => rmSync(wt(s), { recursive: true })), [wf(['1'], { rc: 0, out: /worktree already removed — cleaning up the branch only/ })]);
  scenario({}, both(P, (s) => git(s.R, 'worktree', 'remove', wt(s))), [wf(['1'], { rc: 0, out: /worktree already removed/ })]);
});

test('--help on the worker is an id (parity: the bash had no --help)', () => {
  const s = makeSide('new');
  tools(s);
  const r = runStep(s, wf(['--help']));
  assert.equal(r.rc, 1);
  assert.match(r.err, /finish requires a phase number/);
});
