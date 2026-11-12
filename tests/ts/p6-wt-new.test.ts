// P6 parity (gsdt-wt-new): the TypeScript command behind bin/gsdt-wt-new against the
// pre-P6 bash command (tests/fixtures/p6-old-bins/gsdt-wt-new), each on its own copy
// of the same fixture project. Compared: stdout, stderr, exit code of every step, and
// the files/branches/worktrees left behind.
// (gsdt-wt-new --help is new: bash called -h an unknown flag. Not compared here.)
// Run: node --test tests/ts/p6-wt-new.test.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ROADMAP_RICH, commitAll, git, makeSide, runStep, scenario, sub, write, type Step } from './p6-helpers.ts';
import { highestPhase } from '../../src/commands/wt-new.ts';
import assert from 'node:assert/strict';

const wt = (args: Step['args'], extra: Partial<Step> = {}): Step => ({ cmd: 'wt-new', args, ...extra });
const NI = '--no-install';

test('highestPhase = sort -t. -k1,1n -k2,2n | tail -1', () => {
  assert.equal(highestPhase(['1', '9', '10']), '10');
  assert.equal(highestPhase(['10', '10.1', '9.5']), '10.1');
  assert.equal(highestPhase(['02', '2', '1']), '2');
  assert.equal(highestPhase(['02.1', '02.10', '02.2']), '02.10');
  assert.equal(highestPhase([]), '');
});

test('refusals', () => {
  scenario({}, null, [
    wt(['--bogus'], { rc: 1, err: /unknown flag: --bogus/ }),
    wt(['--phase'], { rc: 1, err: /--phase needs a value/ }),
    wt(['--batch'], { rc: 1, err: /--batch needs a name/ }),
    wt(['--batch', 'fix-labels'], { rc: 1, err: /batch-<date>-<slug>/ }),
    wt(['--batch', 'batch-UPPER'], { rc: 1 }),
    wt(['--batch', 'batch-'], { rc: 1 }),
    wt(['--batch', ''], { rc: 1 }),
    wt(['--phase', '9'], { rc: 1, err: /phase 9 not found/ }),
    wt(['--phase', '1+']), // an ERE: matches 'Phase 1:'
  ]);
  scenario({}, (s) => { write(sub(s, '.planning/ROADMAP.md'), '# nothing here\n'); commitAll(s.R, 'no phases'); }, [wt([NI], { rc: 1, err: /no phase found in ROADMAP\.md/ })]);
  scenario({}, (s) => git(s.R, 'rm', '-q', '-f', '.planning/ROADMAP.md'), [wt([NI], { rc: 1, err: /ROADMAP\.md not found/ })]);
  scenario({}, (s) => mkdirSync(path.join(s.wtdir, 'phase-1-catalog'), { recursive: true }), [wt(['--phase', '1', NI], { rc: 1, err: /already exists but is not a registered worktree/ })]);
});

test('not inside a git repository (NOT parity: the bash exited 128 in silence, its "error: …" line never ran)', () => {
  const r = runStep(makeSide('new'), wt([NI], { cwd: () => mkdtempSync(path.join(tmpdir(), 'gsd-p6-')) }));
  assert.equal(r.rc, 1);
  assert.match(r.err, /^error: not inside a git repository\n$/);
});

test('phase detection: --phase, the latest claim commit, the highest number', () => {
  const rm = '# Roadmap\n\n### Phase 1: one\n\n### Phase 9: nine\n\n### Phase 10: ten\n\n### Phase 10.1: ten point one\n\n### Phase 02: padded\n';
  scenario({ roadmap: rm }, null, [
    wt([NI], { rc: 0, out: /phase-02-padded/ }), // the last heading the HEAD commit added
    wt(['--phase', '9', NI], { rc: 0, out: /phase-9-nine/ }),
    wt(['--phase', '02', NI], { rc: 0, out: /phase-02-padded/ }),
    wt(['--phase', '10', 'custom-slug', NI], { rc: 0, out: /phase-10-custom-slug/ }),
  ]);
  // HEAD does not touch the roadmap: the highest number (11 > 9, 10.1 > 10, 02 = 2)
  scenario({ roadmap: rm }, (s) => commitAll(s.R, 'unrelated'), [wt([NI], { rc: 0, out: /phase-10\.1-ten-point-one/ })]);
  scenario({ roadmap: '# Roadmap\n\n### Phase 9: nine\n\n### Phase 02.10: a\n\n### Phase 02.2: b\n\n### Phase 2: c\n' }, (s) => commitAll(s.R, 'unrelated'), [wt([NI], { rc: 0 })]);
  // the claim commit wins over the highest number
  scenario({ roadmap: '# Roadmap\n\n### Phase 1: one\n\n### Phase 7: seven\n' }, (s) => {
    write(sub(s, '.planning/ROADMAP.md'), '# Roadmap\n\n### Phase 1: one\n\n### Phase 3: three\n\n### Phase 7: seven\n');
    commitAll(s.R, 'claim');
  }, [wt([NI], { rc: 0, out: /phase-3-three/ })]);
  // titles: case, punctuation, nothing but symbols
  scenario({ roadmap: '# Roadmap\n\n### Phase 1: Fix the "Café" — API (v2)!\n\n### Phase 2: ***\n\n### Phase 3:\n\n### Phase 4: ' + 'x'.repeat(60) + '\n' }, null, [
    wt(['--phase', '1', NI], { rc: 0 }),
    wt(['--phase', '2', NI], { rc: 0, out: /phase-2-feature/ }),
    wt(['--phase', '3', NI], { rc: 0, out: /phase-3-feature/ }),
    wt(['--phase', '4', NI], { rc: 0 }),
  ]);
  // --phase with a regexp character: matched like bash's ERE
  scenario({ roadmap: '# Roadmap\n\n### Phase 12: twelve\n' }, null, [wt(['--phase', '1.', NI], { rc: 1 }), wt(['--phase', '1.2', NI], { rc: 1 }), wt(['--phase', '12', NI], { rc: 0 })]);
});

test('reuse, re-attach, deleted by hand; -pr helper branches are skipped', () => {
  scenario({}, null, [
    wt(['--phase', '1', NI], { rc: 0, out: /creating worktree/ }),
    wt(['--phase', '1', NI], { rc: 0, out: /already has a worktree — reusing it/ }),
    wt(['--phase', '1', 'other', NI], { rc: 0, out: /reusing it/ }),
  ]);
  scenario({}, null, [
    wt(['--phase', '1', NI], { rc: 0 }),
    wt(['--phase', '1', NI], { rc: 0, cwd: (s) => path.join(s.wtdir, 'phase-1-catalog'), out: /reusing/ }), // from inside the worktree: gsd_main finds the main one
  ]);
  scenario({}, (s) => {
    git(s.R, 'worktree', 'add', '-qb', 'phase-1-catalog', path.join(s.wtdir, 'phase-1-catalog'));
    git(s.R, 'branch', 'phase-1-catalog-pr');
    git(s.R, 'worktree', 'remove', path.join(s.wtdir, 'phase-1-catalog'));
  }, [wt(['--phase', '1', NI], { rc: 0, out: /re-attaching worktree for existing branch 'phase-1-catalog'/ })]);
  scenario({}, (s) => {
    git(s.R, 'worktree', 'add', '-qb', 'phase-1-catalog', path.join(s.wtdir, 'phase-1-catalog'));
    require_rm(path.join(s.wtdir, 'phase-1-catalog'));
  }, [wt(['--phase', '1', NI], { rc: 0, out: /gone from disk/ })]);
  // only a -pr branch: a new worktree is made
  scenario({}, (s) => git(s.R, 'branch', 'phase-1-catalog-pr'), [wt(['--phase', '1', NI], { rc: 0, out: /re-attaching worktree for existing branch 'phase-1-catalog-pr'/ })]);
});

import { rmSync } from 'node:fs';
function require_rm(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

test('--batch: made, reused, with the right closing lines', () => {
  scenario({ conf: null }, null, [
    wt(['--batch', 'batch-2026-11-12-fixes', NI], { rc: 0, out: /Open an agent session there and run \/gsdt-batch\. Finish:  gsdt-finish batch-2026-11-12-fixes/ }),
    wt(['--batch', 'batch-2026-11-12-fixes', NI], { rc: 0, out: /already has a worktree — reusing it/ }),
    wt(['--batch', 'batch-2026-11-12-b.2', NI], { rc: 0, env: { GSD_WT_NEW_SUPPRESS_NEXT: '1' }, not: /Open an agent session/ }),
  ]);
  // a batch needs no ROADMAP.md
  scenario({}, (s) => git(s.R, 'rm', '-q', '-f', '.planning/ROADMAP.md'), [wt(['--batch', 'batch-x-1', NI], { rc: 0 })]);
});

test('the closing lines and SUPPRESS_NEXT', () => {
  scenario({}, null, [
    wt(['--phase', '1', NI], { rc: 0, out: /\/gsd-discuss-phase 1 → \/gsd-plan-phase 1 → \/gsd-execute-phase 1\nFinish:  gsdt-finish 1/ }),
    wt(['--phase', '1', NI], { rc: 0, env: { GSD_WT_NEW_SUPPRESS_NEXT: '1' } }),
  ]);
  scenario({}, null, [wt(['--phase', '1', NI], { rc: 0, env: { GSD_WT_NEW_SUPPRESS_NEXT: '1' }, not: /Finish:/ })]);
});

test('install: background, foreground, none, skipped without a command', () => {
  scenario({ conf: 'install = echo installing && echo done\n' }, null, [wt(['--phase', '1'], { rc: 0, out: /running in background → .*\.gsd-install\.log/ })]);
  scenario({ conf: 'install = false\n' }, null, [wt(['--phase', '1'], { rc: 0 })]);
  scenario({ conf: 'install = echo hello-from-install\n' }, null, [wt(['--phase', '1', '--install'], { rc: 0, out: /installing dependencies \(echo hello-from-install\)…\nhello-from-install/ })]);
  scenario({ conf: 'install = false\n' }, null, [wt(['--phase', '1', '--install'], { rc: 1, not: /worktree ready/ })]);
  scenario({ conf: 'install = echo hi\n' }, null, [wt(['--phase', '1', '--install', '--no-install'], { rc: 0, out: /skipped dependency install/ }), wt(['--phase', '1', '--no-install', '--background'], { rc: 0 })]);
  scenario({ conf: 'install = none\n' }, null, [wt(['--phase', '1', '--install'], { rc: 0, out: /skipped dependency install/ })]);
  // the output must not wait for the background install (a sleeping one)
  scenario({ conf: 'install = sleep 3\n' }, null, [wt(['--phase', '1'], { rc: 0 })]);
});

test('the local config copy and info/exclude', () => {
  const prep = (s: import('./p6-helpers.ts').Side): void => {
    write(sub(s, '.gitignore'), '.env.local\n.mcp.json\n.claude/settings.local.json\n.claude/worktrees/\nnode_modules/\n');
    commitAll(s.R);
    write(sub(s, '.env.local'), 'SECRET=1\n');
    write(sub(s, '.mcp.json'), '{}\n');
    write(sub(s, '.claude/settings.local.json'), '{"permissions": {"allow": ["Bash(ls)"]}}\n');
    write(sub(s, '.claude/worktrees/agent-1/.env.local'), 'nested\n');
    write(sub(s, 'apps/web/.env.local'), 'web\n');
    write(sub(s, 'dir with space/.env.local'), 'sp\n');
  };
  scenario({ conf: 'install = none\n' }, prep, [wt(['--phase', '1', NI], { rc: 0, out: /copied \.claude\/settings\.local\.json[\s\S]*copied \.env\.local[\s\S]*copied dir with space\/\.env\.local/ })]);
  scenario({ conf: 'install = none\n' }, (s) => {
    prep(s);
    writeFileSync(sub(s, '.git/info/exclude'), '# x\n.gsd-install.status');
  }, [wt(['--phase', '1', NI], { rc: 0 })]);
  scenario({ conf: 'install = none\n' }, (s) => {
    prep(s);
    writeFileSync(sub(s, '.git/info/exclude'), '.gsd-install.status\n.gsd-install.log\n.claude/settings.local.json\n');
  }, [wt(['--phase', '1', NI], { rc: 0 })]);
  // the exclude file does not exist yet
  scenario({ conf: 'install = none\n' }, (s) => require_rm(sub(s, '.git/info/exclude')), [wt(['--phase', '1', NI], { rc: 0 })]);
  // baseRef: an existing worktree settings file with another value, tracked, unignored
  scenario({ conf: 'install = none\n' }, (s) => write(sub(s, '.claude/settings.local.json'), '{"worktree": {"baseRef": "main"}}\n'), [wt(['--phase', '1', NI], { rc: 0 })]);
  scenario({ conf: 'install = none\n', files: { '.claude/settings.local.json': '{}\n' } }, null, [wt(['--phase', '1', NI], { rc: 0, out: /is tracked by git/ })]);
  scenario({ conf: 'install = none\n' }, (s) => write(sub(s, '.claude/settings.local.json'), '{"x": 1}\n'), [wt(['--phase', '1', NI], { rc: 0 })]);
  // reusing a worktree adds the baseRef it lacks
  scenario({ conf: 'install = none\n', files: { '.gitignore': '.claude/settings.local.json\n' } }, (s) => {
    git(s.R, 'worktree', 'add', '-qb', 'phase-1-catalog', path.join(s.wtdir, 'phase-1-catalog'));
  }, [wt(['--phase', '1', NI], { rc: 0, out: /reusing it/ })]);
});

test('the lock: re-entrant under GSD_LOCK_HELD, a stale one reclaimed', () => {
  scenario({}, (s) => {
    mkdirSync(sub(s, '.git/gsd-cmd.lock'));
    writeFileSync(sub(s, '.git/gsd-cmd.lock/pid'), '2999999\n');
  }, [wt(['--phase', '1', NI], { rc: 0, out: /reclaimed stale gsd lock/ })]);
  scenario({}, (s) => {
    mkdirSync(sub(s, '.git/gsd-cmd.lock'));
    writeFileSync(sub(s, '.git/gsd-cmd.lock/pid'), `${process.pid}\n`);
  }, [wt(['--phase', '1', NI], { rc: 0, env: { GSD_LOCK_HELD: '1' } })]);
});

test('--base from .gsd.conf, a custom wtdir', () => {
  scenario({ conf: 'install = none\nwtdir = custom-trees\n' }, (s) => git(s.R, 'branch', 'dev'), [wt(['--phase', '1', NI], { rc: 0 })]);
  scenario({ conf: 'install = none\nbase = dev\n' }, (s) => git(s.R, 'branch', 'dev'), [wt(['--phase', '1', NI], { rc: 0, out: /off dev/ })]);
  scenario({ conf: 'install = none\nbase = missing\n', roadmap: ROADMAP_RICH }, null, [wt(['--phase', '1', NI], { rc: 128 })]);
});
