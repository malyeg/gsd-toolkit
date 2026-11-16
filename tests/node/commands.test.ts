// Command paths no other suite exercised: gsdt-derive-port, gsdt-start's refusals / --insert / -p / --flow /
// TDD default, a conflicting finish, stale lock reclaim, gsdt-init's docs detection, and gsdt-finish --pr.
// CI-safe: GSD's gsd_run and gh are stubbed; remotes are local bare repos.
// (gsdt-tracker has its own suite: tests/node/tracker.test.ts.)
// Port of tests/test-commands.sh. Run: node --test tests/node/commands.test.ts
import { after, describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  GH_JS, GSD_RUN_JS, LAUNCH, NO_PTY, PKG, W, WIN, assertionCount, commit, countLines, envOf, exists, fails, fwd, git, gitOk, gitOut, gsdt, has, hasnt, inTty, inTtyAsync,
  is, isDir, linesOf, nodeModule, ok, project, read, readLf, run, setBaseEnv, setStubDirs, sleep, stubNode, stubSh, worktreeOf, write,
} from './g3-helpers.ts';
import { confGet, phaseBranch } from '../../src/common.ts';
import { canonicalBlock, providerEntryBlock, rulesText } from '../../src/provider.ts';

after(() => console.log(`# commands: ${assertionCount()} assertions`));

// ── stubs ────────────────────────────────────────────────────────────────────
const STUB = path.join(W, 'stub');
const GH_LOG = path.join(W, 'gh.log');
const GSD_RUN = stubNode(STUB, 'gsd_run', GSD_RUN_JS);
stubNode(STUB, 'gh', GH_JS);
setStubDirs(STUB);
setBaseEnv({ GSD_CLI: GSD_RUN, GH_LOG });
const rmStub = (name: string): void => {
  for (const f of [name, `${name}.js`, `${name}.cmd`]) rmSync(path.join(STUB, f), { force: true });
};
const T = { tdd: (R: string): unknown => (JSON.parse(gitOut(R, ['show', 'HEAD:.planning/config.json'])) as { workflow: Record<string, unknown> }).workflow.tdd_mode };
const originShow = (R: string, spec: string): string => readLf2(git(W, ['--git-dir', `${R}.git`, 'show', spec]).stdout);
const readLf2 = (s: string): string => s.replace(/\r\n/g, '\n');
const start = (R: string, args: string[], env: Record<string, string | undefined> = {}): ReturnType<typeof gsdt> => gsdt('gsdt-start', args, { cwd: R, env });

describe('gsdt-derive-port — base + phase number', () => {
  const portOn = (branch: string): string => {
    const d = path.join(W, `port-${Math.random().toString(36).slice(2)}`);
    gitOk(W, ['init', '-q', '-b', branch, d]);
    gitOk(d, ['commit', '-qm', 'i', '--allow-empty']);
    return gsdt('gsdt-derive-port', ['3000'], { cwd: d }).out.trim();
  };
  it('ports follow the phase number', () => {
    is('phase-7-x → 3007', portOn('phase-7-x'), '3007');
    is('phase-12-x → 3012', portOn('phase-12-x'), '3012');
    is('phase-3.1-x uses the integer part', portOn('phase-3.1-x'), '3003');
    is('padded phase-08.1-x is not octal', portOn('phase-08.1-x'), '3008');
    is('a non-phase branch → the base', portOn('main'), '3000');
    is('outside git → the base', gsdt('gsdt-derive-port', ['3000'], { cwd: W }).out.trim(), '3000');
    fails('a non-numeric base is refused', gsdt('gsdt-derive-port', ['abc']));
  });
});

describe('gsdt-start — refusals', () => {
  const R = path.join(W, 'shop');
  project(R);
  it('a bare description, -n with -p, an unknown phase, a duplicate title are refused', () => {
    let r = fails('a bare description is refused (must say -n/-p/--insert)', start(R, ['cart', '--no-launch']));
    has('…and the refusal lists the three choices', r.out, 'gsdt-start -n');
    fails('-n and -p together are refused', start(R, ['-n', 'x', '-p', '1', '--no-launch']));
    r = fails('-p of a phase not in the roadmap', start(R, ['-p', '9', '--no-launch']));
    has('…and says so', r.out, 'phase 9 not found');
    fails('re-claiming an existing title', start(R, ['-n', 'Catalog', '--no-launch']));
  });
  it('no gsd-core, only the old gsd-sdk → a claim is refused, with the install command', () => {
    // no gsd-core (the old GSD's gsd-sdk does not count) → refused, with the install.
    // A bare PATH and an empty HOME, so no gsd-core of this machine is found.
    const oldgsd = path.join(W, 'oldgsd');
    const oldhome = path.join(W, 'oldhome');
    mkdirSync(oldhome, { recursive: true });
    stubSh(oldgsd, 'gsd-sdk', '#!/bin/sh\necho 1.42.0\n');
    // the TypeScript gsdt-start needs node (run by its full path here) and git: a PATH holding only those
    const gitBin = run(WIN ? 'where' : 'which', ['git']).stdout.split(/\r?\n/)[0]!.trim();
    const env = envOf({ GSD_CLI: undefined, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, HOME: oldhome, USERPROFILE: oldhome, PATH: [oldgsd, path.dirname(gitBin)].join(path.delimiter) });
    const r = fails('no gsd-core, only the old gsd-sdk → a claim is refused', gsdt('gsdt-start', ['-n', 'cart', '--no-launch'], { cwd: R, rawEnv: env }));
    has('…and says gsd-core is missing', r.out, 'GSD (gsd-core) not found');
    has('…with the install command', r.out, 'npx @opengsd/gsd-core@latest --claude --global');
  });
});

describe('gsdt-start — claim, attach, insert, flow mode', () => {
  const R = path.join(W, 'shop');
  const hasWt = (n: string): boolean => gitOut(R, ['worktree', 'list']).includes(`phase-${n}-`);
  it('-n claims phase 2', () => {
    const r = start(R, ['-n', 'shopping cart', '--no-launch']);
    is('-n claims phase 2', r.status, 0);
    has('…prints the flow launch (the default)', r.out, 'gsdt-flow');
    ok('…and creates the phase-2 worktree', hasWt('2'));
    is('…and pushes the claim', countLines(originShow(R, 'main:.planning/ROADMAP.md'), /^### Phase 2: shopping cart/), 1);
  });
  it('-p re-attaches (idempotent)', () => {
    is('-p re-attaches (idempotent)', start(R, ['-p', '2', '--no-launch']).status, 0);
    is('…without a second worktree', countLines(gitOut(R, ['worktree', 'list']), /phase-2-/), 1);
  });
  it('--insert claims a padded decimal phase', () => {
    const r = start(R, ['--insert', '1', 'price bug', '--no-launch']);
    is('--insert claims a padded decimal phase', r.status, 0);
    ok('…on a phase-01.1 worktree (guard accepts it)', gitOut(R, ['worktree', 'list']).includes('phase-01.1-'), r.out.split('\n').slice(-3).join('\n'));
  });
  it('--flow prints the gsdt-flow launch', () => {
    has('--flow prints the gsdt-flow launch', start(R, ['-p', '2', '--flow', '--no-launch']).out, 'gsdt-flow');
  });
});

describe('gsdt-start — opens the session by default (in a terminal)', () => {
  const R = path.join(W, 'launch');
  const launched = path.join(W, 'launched');
  project(R);
  const agent = (): void => {
    // a fake agent CLI records that it was launched, and where
    stubNode(STUB, 'claude', `require('fs').writeFileSync(${JSON.stringify(launched)}, process.cwd() + '\\n');\n`);
  };
  it('in a terminal the agent opens, in the worktree; --no-launch only prints', { skip: NO_PTY }, () => {
    agent();
    rmSync(launched, { force: true });
    let r = inTty(`cd '${R}' && gsdt-start -p 1`);
    ok('in a terminal the agent opens, in the worktree', exists(launched) && /[\\/]phase-1-/.test(read(launched)), r.out.split('\n').slice(-5).join('\n'));
    rmSync(launched, { force: true });
    r = inTty(`cd '${R}' && gsdt-start -p 1 --no-launch`);
    ok('--no-launch only prints', !exists(launched));
    has('…the command to run', r.out, 'Next:');
  });
  it('with no terminal it only prints; with no agent CLI the default still succeeds', () => {
    agent();
    rmSync(launched, { force: true });
    start(R, ['-p', '1']);
    ok('with no terminal it only prints', !exists(launched));
    rmStub('claude');
    is('no agent CLI installed → the default still succeeds (prints)', start(R, ['-p', '1']).status, 0);
  });
});

describe('gsdt-start — TDD mode is the default', () => {
  const R = path.join(W, 'tdd');
  project(R);
  it('no config.json (before /gsd-new-project) → claim still works, makes no config.json', () => {
    is('no config.json (before /gsd-new-project) → claim still works', start(R, ['-n', 'no config yet', '--no-launch']).status, 0);
    ok('…and makes no config.json', !exists(path.join(R, '.planning', 'config.json')));
  });
  it('tdd_mode unset → the claim commit turns it on', () => {
    write(path.join(R, '.planning', 'config.json'), '{\n  "workflow": {\n    "research": true\n  }\n}\n');
    commit(R, 'config');
    gitOk(R, ['push', '-q']);
    const r = start(R, ['-n', 'first claim', '--no-launch']);
    is('tdd_mode unset → the claim commit turns it on', T.tdd(R), true);
    has('…and says so', r.out, 'TDD mode on');
    is('…in the pushed claim', countLines(originShow(R, 'main:.planning/config.json'), /"tdd_mode": true/), 1);
  });
  it('tdd_mode false (the project chose) → kept', () => {
    write(path.join(R, '.planning', 'config.json'), '{\n  "workflow": {\n    "tdd_mode": false\n  }\n}\n');
    commit(R, 'tdd-off');
    gitOk(R, ['push', '-q']);
    start(R, ['-n', 'after opting out', '--no-launch']);
    is('tdd_mode false (the project chose) → kept', T.tdd(R), false);
  });
  it('--insert turns it on too', () => {
    write(path.join(R, '.planning', 'config.json'), '{\n  "workflow": {}\n}\n');
    commit(R, 'tdd-unset');
    gitOk(R, ['push', '-q']);
    start(R, ['--insert', '1', 'hotfix', '--no-launch']);
    is('--insert turns it on too', T.tdd(R), true);
  });
});

describe('gsdt-wt-finish — a conflicting merge aborts cleanly', () => {
  it('finish refuses, names the conflict, leaves main, origin and the worktree alone', () => {
    const R = path.join(W, 'conflict');
    const wt = path.join(W, 'conflict-wt');
    project(R);
    write(path.join(R, 'shared.txt'), 'base\n');
    commit(R, 'base-file');
    gitOk(R, ['push', '-q']);
    gitOk(R, ['worktree', 'add', '-qb', 'phase-1-catalog', wt]);
    write(path.join(wt, 'shared.txt'), 'phase version\n');
    commit(wt, 'phase-edit');
    write(path.join(R, 'shared.txt'), 'main version\n');
    commit(R, 'main-edit');
    gitOk(R, ['push', '-q']);
    const before = gitOut(R, ['rev-parse', 'HEAD']);
    const r = fails('finish refuses', gsdt('gsdt-wt-finish', ['1'], { cwd: R }));
    has('…naming the conflict', r.out, 'merge conflict');
    is('…main HEAD unchanged', gitOut(R, ['rev-parse', 'HEAD']), before);
    ok('…no merge left in progress', !exists(path.join(R, '.git', 'MERGE_HEAD')));
    is('…main working tree clean', gitOut(R, ['status', '--porcelain']), '');
    ok('…worktree kept', isDir(wt));
    is('…origin untouched', git(W, ['--git-dir', `${R}.git`, 'rev-parse', 'main']).stdout.trim(), before);
  });
});

describe('checkout lock — a crashed run\'s lock is reclaimed', () => {
  const R = path.join(W, 'lock');
  project(R);
  const lock = path.join(R, '.git', 'gsd-cmd.lock');
  it('a stale lock is reclaimed and released at the end', () => {
    mkdirSync(lock);
    writeFileSync(path.join(lock, 'pid'), '999999\n');
    const r = gsdt('gsdt-wt-new', ['--phase', '1'], { cwd: R });
    is('the command still runs', r.status, 0);
    has('…after reclaiming the lock', r.out, 'reclaimed stale gsd lock');
    ok('…and releases it at the end', !isDir(lock));
  });
  it('a TERM stops the command at once (killed by the signal)', { skip: WIN && 'POSIX signals: process.kill(SIGTERM) is a hard kill on Windows' }, () => {
    // Port note: the bash lock trapped TERM, released the lock and exited 143. The TypeScript lock
    // (src/common.ts acquireLock) has no signal handler on purpose: a signal kills the process at once and the
    // lock it leaves names a dead PID, which the next command reclaims (asserted here and in the signal section).
    const r = nodeModule(
      `import { acquireLock } from '__PKG__/src/common.ts';\nacquireLock(${JSON.stringify(R)});\nprocess.kill(process.pid, 'SIGTERM');\nsetTimeout(() => console.log('went-on'), 500);\n`,
    );
    is('a TERM stops the command (exit 143 = killed by SIGTERM)…', `${r.signal}:${r.stdout.includes('went-on') ? 'went-on' : ''}`, 'SIGTERM:');
    ok('…and the lock it left names a dead PID', isDir(lock) && Number.isInteger(Number(read(path.join(lock, 'pid')).trim())));
    const dead = Number(read(path.join(lock, 'pid')).trim());
    let alive = true;
    try {
      process.kill(dead, 0);
    } catch {
      alive = false;
    }
    ok('…(that PID is gone)', !alive);
    const next = gsdt('gsdt-wt-new', ['--phase', '1'], { cwd: R });
    has('…which the next command reclaims', next.out, 'reclaimed stale gsd lock');
    ok('…and releases the lock', !isDir(lock));
  });
});

describe('gsdt-init — picks ingest when planning docs exist', () => {
  const plain = (name: string, files: Record<string, string>): string => {
    const R = path.join(W, name);
    mkdirSync(R, { recursive: true });
    gitOk(R, ['init', '-qb', 'main']);
    for (const [f, c] of Object.entries(files)) write(path.join(R, f), c);
    commit(R, 'docs');
    return R;
  };
  it('a PRD → /gsd-ingest-docs; no docs → /gsd-new-project', () => {
    const docs = plain('docs', { 'docs/PRD-checkout.md': '# PRD\n' });
    has('a PRD → /gsd-ingest-docs', gsdt('gsdt-init', ['--provider', 'claude', '--no-launch'], { cwd: docs }).out, 'gsd-ingest-docs');
    const nodocs = plain('nodocs', { 'a.txt': 'x\n' });
    has('no docs → /gsd-new-project', gsdt('gsdt-init', ['--provider', 'claude', '--no-launch'], { cwd: nodocs }).out, 'gsd-new-project');
  });

  describe('gsdt-init — asks where the tickets live', () => {
    it('the answer lands in .gsd.conf, is committed, and is not asked again', () => {
      const R = plain('ask', { 'a.txt': 'x\n' });
      const env = { GSD_TRACKER_ASK: 'always' };
      let r = gsdt('gsdt-init', ['--provider', 'claude', '--no-launch'], { cwd: R, input: '3\nscripts/t.sh\n', env });
      is('the answer lands in .gsd.conf', `${confGet(R, 'tracker')}/${confGet(R, 'tracker_command')}`, 'custom/scripts/t.sh');
      has('…and the next steps say what it needs', r.out, 'write scripts/t.sh');
      is('…committed with the bootstrap', gitOut(R, ['status', '--porcelain', '--', '.gsd.conf']), '');
      r = gsdt('gsdt-init', ['--provider', 'claude', '--no-launch'], { cwd: R, input: '', env });
      hasnt('a set tracker is not asked again', r.out, 'Where do this project');
    });
    it('--tracker clickup sets it without a question; jira and a script-less custom are refused', () => {
      const R = plain('askflag', { 'a.txt': 'x\n' });
      gsdt('gsdt-init', ['--provider', 'claude', '--tracker', 'clickup', '--no-launch'], { cwd: R });
      is('--tracker clickup sets it, no question', confGet(R, 'tracker'), 'clickup');
      fails('--tracker jira is refused', gsdt('gsdt-init', ['--provider', 'claude', '--tracker', 'jira', '--no-launch'], { cwd: R }));
      fails('--tracker custom needs its script', gsdt('gsdt-bootstrap-repo', ['--agent', 'claude', '--tracker', 'custom'], { cwd: path.join(W, 'nodocs') }));
    });
    it('no terminal, no flag → no question, no tracker key, and a hint how to set one', () => {
      const R = plain('noask', { 'a.txt': 'x\n' });
      const r = gsdt('gsdt-init', ['--provider', 'claude', '--no-launch'], { cwd: R, input: '' });
      is('no terminal, no flag → no question, no tracker key', `${countLines(r.out, /Where do this project/)}:${confGet(R, 'tracker')}`, '0:');
      has('…and a hint how to set one', r.out, 'gsdt-init --tracker clickup|custom');
    });
  });

  describe('gsdt-init — opens the planning session, then checks the plan', () => {
    const initArgs = path.join(W, 'init-args');
    // a fake agent: records its argv; with PLAN=1 it writes a two-phase roadmap, as /gsd-new-project would
    const agent = (): void => {
      stubNode(
        STUB,
        'claude',
        `const fs = require('fs');
fs.writeFileSync(${JSON.stringify(initArgs)}, process.argv.slice(2).join(' ') + '\\n');
if (process.env.PLAN === '1') {
  fs.mkdirSync('.planning', { recursive: true });
  fs.writeFileSync('.planning/ROADMAP.md', '# Roadmap\\n\\n### Phase 1: catalog\\n\\n### Phase 2: cart\\n');
}
`,
      );
    };
    it('in a terminal it runs the session, and the plan is there → exit 0', { skip: NO_PTY }, () => {
      agent();
      const R = plain('plan', { 'a.txt': 'x\n' });
      const r = inTty(`cd '${R}' && PLAN=1 gsdt-init --provider claude --tracker none`);
      is('in a terminal it runs the session, and the plan is there → exit 0', r.status, 0);
      has('…the session got /gsd-new-project', read(initArgs), 'gsd-new-project');
      has('…it says the plan is ready', r.out, 'plan ready: 2 phase');
      has('…and names the first phase', r.out, 'gsdt-start -p 1');
    });
    it('a session closed with no ROADMAP → exit 1; --no-launch only prints', { skip: NO_PTY }, () => {
      agent();
      const R = plain('quit', { 'a.txt': 'x\n' });
      let r = inTty(`cd '${R}' && gsdt-init --provider claude --tracker none; echo rc=$?`);
      has('a session closed with no ROADMAP → exit 1', r.out, 'rc=1');
      has('…saying to run gsdt-init again', r.out, 'Run gsdt-init again');
      rmSync(initArgs, { force: true });
      r = inTty(`cd '${R}' && gsdt-init --provider claude --tracker none --no-launch`);
      ok('--no-launch only prints', !exists(initArgs));
      has('…the command', r.out, 'Next:');
      rmStub('claude');
    });
  });
});

describe('gsdt-finish --pr — push + open a PR, keep the worktree', () => {
  it('pushes the branch, opens a PR with gh, merges nothing', () => {
    const R = path.join(W, 'pr');
    const wt = path.join(W, 'pr-wt');
    project(R);
    gitOk(R, ['worktree', 'add', '-qb', 'phase-1-catalog', wt]);
    write(path.join(wt, 'f.txt'), 'feature\n');
    commit(wt, 'feature');
    writeFileSync(GH_LOG, '');
    const r = gsdt('gsdt-finish', ['1', '--pr'], { cwd: R });
    is('--pr succeeds', r.status, 0);
    ok('…branch pushed', git(W, ['--git-dir', `${R}.git`, 'rev-parse', '-q', '--verify', 'refs/heads/phase-1-catalog']).status === 0, r.out.split('\n').slice(-4).join('\n'));
    has('…gh pr create, base main', read(GH_LOG), /pr create.*--base main/);
    has('…head is the phase branch', read(GH_LOG), '--head phase-1-catalog');
    ok('…worktree kept', isDir(wt));
    is('…nothing merged into main', countLines(gitOut(R, ['log', '--oneline', 'main']), /feature/), 0);
  });
});

describe('gsdt-finish — flow = strict refuses a phase without the test audit', () => {
  it('refuses without the audit, then lands once audited', () => {
    const R = path.join(W, 'audit');
    const wt = path.join(W, 'audit-wt');
    project(R);
    write(path.join(R, '.gsd.conf'), 'install = none\ntest = none\nflow = strict\n');
    commit(R, 'strict');
    gitOk(R, ['push', '-q']);
    gitOk(R, ['worktree', 'add', '-qb', 'phase-1-catalog', wt]);
    mkdirSync(path.join(wt, '.planning', 'phases', '01-catalog'), { recursive: true });
    write(path.join(wt, 'f.txt'), 'feature\n');
    commit(wt, 'feature');
    const before = gitOut(R, ['rev-parse', 'HEAD']);
    let r = fails('finish refuses without 01-VALIDATION.md', gsdt('gsdt-wt-finish', ['1'], { cwd: R }));
    has('…names the step', r.out, '/gsd-validate-phase 1');
    is('…nothing merged', gitOut(R, ['rev-parse', 'HEAD']), before);
    r = fails('--pr refuses too', gsdt('gsdt-finish', ['1', '--pr'], { cwd: R }));
    has('…and opens no PR', r.out, 'no PR was opened');
    write(path.join(wt, '.planning', 'phases', '01-catalog', '01-VALIDATION.md'), '---\nnyquist_compliant: false\n---\n');
    commit(wt, 'draft');
    fails("the plan's draft does not count", gsdt('gsdt-wt-finish', ['1'], { cwd: R }));
    r = gsdt('gsdt-finish', ['1', '--pr'], { cwd: R, env: { GSD_SKIP_GUARD: '1' } });
    is('GSD_SKIP_GUARD=1 skips the gate (--pr opens the PR)', r.status, 0);
    git(R, ['branch', '-q', '--unset-upstream', 'phase-1-catalog']); // the PR push tracked it; the merge path below expects none
    write(path.join(wt, '.planning', 'phases', '01-catalog', '01-VALIDATION.md'), '---\nnyquist_compliant: true\n---\n');
    commit(wt, 'audited');
    r = gsdt('gsdt-wt-finish', ['1'], { cwd: R });
    is('audited → finish lands', r.status, 0);
    is('…the feature is on main', countLines(gitOut(R, ['log', '--oneline', 'main']), /feature/), 1);
  });
});

describe('finish — the gates read the branch when its worktree is gone', () => {
  it('--pr and the merge path still refuse a missing audit, leaving no throwaway worktree', () => {
    const R = path.join(W, 'gone');
    const wt = path.join(W, 'gone-wt');
    project(R);
    write(path.join(R, '.gsd.conf'), 'install = none\ntest = none\nflow = strict\n');
    commit(R, 'strict');
    gitOk(R, ['push', '-q']);
    gitOk(R, ['worktree', 'add', '-qb', 'phase-1-catalog', wt]);
    write(path.join(wt, '.planning', 'phases', '01-catalog', '.gitkeep'), '');
    write(path.join(wt, 'f.txt'), 'feature\n');
    commit(wt, 'feature');
    gitOk(R, ['worktree', 'remove', wt]);
    const r = fails('--pr with no worktree still refuses a missing audit', gsdt('gsdt-finish', ['1', '--pr'], { cwd: R }));
    has('…names the step', r.out, '/gsd-validate-phase 1');
    fails('…and so does the merge path', gsdt('gsdt-wt-finish', ['1'], { cwd: R }));
    is('…leaving no throwaway worktree', linesOf(gitOut(R, ['worktree', 'list'])).length, 1);
  });
});

describe('finish — files the tests leave behind do not stop the cleanup', () => {
  it('finish succeeds, says what it removed, removes the worktree and branch', () => {
    const R = path.join(W, 'leftover');
    project(R);
    write(path.join(R, '.gsd.conf'), 'install = none\ntest = mkdir -p cov && echo a > cov/out\n');
    commit(R, 'tests');
    gitOk(R, ['push', '-q']);
    gsdt('gsdt-wt-new', ['--phase', '1'], { cwd: R });
    const wt = worktreeOf(R, 'phase-1-');
    write(path.join(wt, 'f.txt'), 'x\n');
    commit(wt, 'feat');
    const r = gsdt('gsdt-wt-finish', ['1'], { cwd: R });
    is('finish succeeds', r.status, 0);
    has('…saying what it removed', r.out, 'cov/');
    ok('…worktree removed', !isDir(wt), r.out.split('\n').slice(-3).join('\n'));
    is('…branch deleted', linesOf(gitOut(R, ['branch', '--list', 'phase-1-*'])).length, 0);
  });
});

describe('finish — a gsdt-batch worktree (batch-*)', () => {
  const R = path.join(W, 'batch');
  const BB = 'batch-2026-11-09-fix-labels';
  const bw = path.join(W, 'batch-worktrees', BB);
  it('gsdt-wt-new --batch makes a clean worktree off main, and reuses it', () => {
    project(R);
    // strict gates on: a batch has no phase folder, and must land anyway
    write(path.join(R, '.gsd.conf'), 'install = none\ntest = none\nflow = strict\nui_gates = strict\n');
    commit(R, 'strict');
    gitOk(R, ['push', '-q']);
    fails('gsdt-wt-new --batch refuses a name that is not batch-…', gsdt('gsdt-wt-new', ['--batch', 'fix-labels'], { cwd: R }));
    let r = gsdt('gsdt-wt-new', ['--batch', BB], { cwd: R });
    is('gsdt-wt-new --batch makes the worktree', r.status, 0);
    is('…on its own branch, off main', `${gitOut(bw, ['branch', '--show-current'])}:${gitOut(R, ['merge-base', 'main', BB])}`, `${BB}:${gitOut(R, ['rev-parse', 'main'])}`);
    is('…no ROADMAP change', linesOf(gitOut(R, ['status', '--porcelain'])).length, 0);
    is('…and a clean worktree', linesOf(gitOut(bw, ['status', '--porcelain'])).length, 0);
    r = gsdt('gsdt-wt-new', ['--batch', BB], { cwd: R });
    has('…reused when run again', r.out, 'already has a worktree');
  });
  it('--pr from inside the batch worktree keeps it; gsdt-finish with no argument lands it', () => {
    write(path.join(bw, 'f.txt'), 'label\n');
    commit(bw, 'fix: labels');
    writeFileSync(GH_LOG, '');
    let r = gsdt('gsdt-finish', ['--pr'], { cwd: bw });
    is('--pr from inside the batch worktree', r.status, 0);
    has('…head is the batch branch', read(GH_LOG), `--head ${BB}`);
    ok('…worktree kept', isDir(bw));
    is('…nothing merged into main', countLines(gitOut(R, ['log', '--oneline', 'main']), /fix: labels/), 0);
    git(R, ['branch', '-q', '--unset-upstream', BB]);
    r = gsdt('gsdt-finish', [], { cwd: bw });
    is('gsdt-finish with no argument lands it', r.status, 0);
    is('…the fix is on main', countLines(gitOut(R, ['log', '--oneline', 'main']), /fix: labels/), 1);
    is('…and pushed', countLines(git(W, ['--git-dir', `${R}.git`, 'log', '--oneline', 'main']).stdout, /fix: labels/), 1);
    ok('…worktree removed', !isDir(bw), r.out.split('\n').slice(-3).join('\n'));
    is('…branch deleted', linesOf(gitOut(R, ['branch', '--list', BB])).length, 0);
  });
  it('failing tests stop a batch finish', () => {
    write(path.join(R, '.gsd.conf'), 'install = none\ntest = false\n');
    commit(R, 'failing');
    gitOk(R, ['push', '-q']);
    gsdt('gsdt-wt-new', ['--batch', `${BB}-2`], { cwd: R });
    write(path.join(`${bw}-2`, 'g.txt'), 'y\n');
    commit(`${bw}-2`, 'fix: other');
    const before = gitOut(R, ['rev-parse', 'main']);
    const r = fails('failing tests stop a batch finish', gsdt('gsdt-finish', [`${BB}-2`], { cwd: R }));
    has('…naming the batch worktree', r.out, 'removing the batch worktree');
    is('…nothing merged', gitOut(R, ['rev-parse', 'main']), before);
    ok('…worktree kept', isDir(`${bw}-2`));
  });
});

describe('phase branches — a slug ending in -pr, a worktree deleted by hand', () => {
  it('a phase titled "improve PR" gets phase-1-improve-pr, is re-created, and finishes', () => {
    const R = path.join(W, 'slugpr');
    project(R);
    write(path.join(R, '.planning', 'ROADMAP.md'), '# Roadmap\n\n### Phase 1: improve PR\n');
    commit(R, 'title');
    gitOk(R, ['push', '-q']);
    gsdt('gsdt-wt-new', ['--phase', '1'], { cwd: R });
    const wt = path.join(W, 'slugpr-worktrees', 'phase-1-improve-pr');
    ok("a phase titled 'improve PR' gets phase-1-improve-pr", isDir(wt));
    rmSync(wt, { recursive: true, force: true });
    const r = gsdt('gsdt-wt-new', ['--phase', '1'], { cwd: R });
    is('a deleted worktree folder is re-created', `${r.status}:${isDir(wt) ? 'yes' : ''}`, '0:yes');
    write(path.join(wt, 'f.txt'), 'x\n');
    commit(wt, 'feat');
    is('…and the -pr phase finishes', gsdt('gsdt-wt-finish', ['1'], { cwd: R }).status, 0);
    gitOk(R, ['branch', '-q', 'phase-2-thing']);
    gitOk(R, ['branch', '-q', 'phase-2-thing-pr']);
    is('a real /gsd-pr-branch helper is still skipped', phaseBranch(R, '2'), 'phase-2-thing');
    fails('…and finishing it by name is refused', gsdt('gsdt-wt-finish', ['phase-2-thing-pr'], { cwd: R }));
  });
});

describe("origin without the base branch, gsdt-start -p after another machine's claim", () => {
  it('an empty origin is refused with a hint (start and wt-finish)', () => {
    const R = path.join(W, 'noorigin');
    gitOk(W, ['init', '-q', '--bare', '-b', 'main', `${R}.git`]);
    mkdirSync(path.join(R, '.planning', 'phases'), { recursive: true });
    gitOk(R, ['init', '-qb', 'main']);
    write(path.join(R, '.planning', 'ROADMAP.md'), '# Roadmap\n\n### Phase 1: catalog\n');
    write(path.join(R, '.gsd.conf'), 'install = none\ntest = none\n');
    commit(R, 'init');
    gitOk(R, ['remote', 'add', 'origin', `${R}.git`]);
    let r = fails('gsdt-start on an empty origin refuses', start(R, ['-n', 'next', '--no-launch']));
    has("…saying to push the base branch", r.out, "origin has no 'main' branch");
    gsdt('gsdt-wt-new', ['--phase', '1'], { cwd: R });
    r = fails('gsdt-wt-finish on an empty origin refuses', gsdt('gsdt-wt-finish', ['1'], { cwd: R }));
    has('…with the same hint', r.out, "origin has no 'main' branch");
  });
  it('gsdt-start -p sees a phase claimed elsewhere', () => {
    const R = path.join(W, 'attach');
    project(R);
    const other = path.join(W, 'attach-other');
    gitOk(W, ['clone', '-q', `${R}.git`, other]);
    write(path.join(other, '.planning', 'ROADMAP.md'), read(path.join(other, '.planning', 'ROADMAP.md')) + '\n### Phase 2: other\n');
    commit(other, 'claim2');
    gitOk(other, ['push', '-q']);
    is('gsdt-start -p sees a phase claimed elsewhere', start(R, ['-p', '2', '--no-launch']).status, 0);
  });
});

describe('worktree.baseRef = head — a wave\'s plans can run in parallel', () => {
  // gsd-core's base-check reads it from the PHASE worktree's .claude/ (or the user's ~/.claude) — an empty
  // HOME, so this machine's settings do not count.
  const brhome = path.join(W, 'brhome');
  mkdirSync(brhome, { recursive: true });
  const bh = { CLAUDE_CONFIG_DIR: undefined, HOME: brhome, USERPROFILE: brhome };
  const baseref = (dir: string): unknown => {
    try {
      return (JSON.parse(readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8')) as { worktree?: { baseRef?: unknown } }).worktree?.baseRef;
    } catch {
      return undefined;
    }
  };
  it('gsdt-start: the new worktree has worktree.baseRef = head, keeping the copied permissions', () => {
    const R = path.join(W, 'baseref');
    project(R);
    write(path.join(R, '.gitignore'), '.claude/settings.local.json\n');
    commit(R, 'ignore');
    gitOk(R, ['push', '-q']);
    write(path.join(R, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(ls)"]}}\n');
    start(R, ['-n', 'cart', '--no-launch'], bh);
    const wt = worktreeOf(R, 'phase-2-');
    is('gsdt-start: the new worktree has worktree.baseRef = head', baseref(wt), 'head');
    is('…keeping the copied permissions', (JSON.parse(read(path.join(wt, '.claude', 'settings.local.json'))) as { permissions: { allow: string[] } }).permissions.allow[0], 'Bash(ls)');
    is("…the main checkout's copy is untouched", baseref(R), undefined);
    is('…and the worktree stays clean', gitOut(wt, ['status', '--porcelain']), '');
    rmSync(path.join(wt, '.claude', 'settings.local.json'));
    start(R, ['-p', '2', '--no-launch'], bh);
    is('gsdt-start -p adds it to a reused worktree without it', baseref(wt), 'head');
    write(path.join(wt, '.claude', 'settings.local.json'), '{"worktree":{"baseRef":"origin"}}\n');
    const r = start(R, ['-p', '2', '--no-launch'], bh);
    is("another value is the user's: kept", baseref(wt), 'origin');
    has('…and said', r.out, 'keeps worktree.baseRef = "origin"');
  });
  it("no .gitignore line: still set (the repo's exclude list covers it)", () => {
    const R = path.join(W, 'baseref-noignore');
    project(R);
    gsdt('gsdt-wt-new', ['--phase', '1'], { cwd: R, env: bh });
    const wt = path.join(W, 'baseref-noignore-worktrees', 'phase-1-catalog');
    is("no .gitignore line: still set (the repo's exclude list covers it)", baseref(wt), 'head');
    is('…and the worktree stays clean', gitOut(wt, ['status', '--porcelain']), '');
  });
  it('a TRACKED settings.local.json is not changed', () => {
    const R = path.join(W, 'baseref-tracked');
    project(R);
    write(path.join(R, '.claude', 'settings.local.json'), '{}\n');
    gitOk(R, ['add', '-f', '.claude/settings.local.json']);
    commit(R, 'tracked');
    gitOk(R, ['push', '-q']);
    const r = gsdt('gsdt-wt-new', ['--phase', '1'], { cwd: R, env: bh });
    const wt = path.join(W, 'baseref-tracked-worktrees', 'phase-1-catalog');
    is('a TRACKED settings.local.json is not changed', gitOut(wt, ['status', '--porcelain']), '');
    has('…and said', r.out, 'is tracked by git');
  });
});

describe('a signal stops a command that holds the lock (TS port review, 2026-11-12)', () => {
  const R = path.join(W, 'sig');
  let wt = '';
  it('set up: a finished phase whose test command takes a while', { skip: WIN && 'POSIX signals' }, () => {
    project(R);
    write(path.join(R, '.gsd.conf'), `install = none\ntest = touch "${fwd(path.join(W, 'sig-started'))}"; sleep 4\n`);
    commit(R, 'tests');
    gitOk(R, ['push', '-q']);
    gsdt('gsdt-wt-new', ['--phase', '1'], { cwd: R });
    wt = worktreeOf(R, 'phase-1-');
    write(path.join(wt, 'f.txt'), 'x\n');
    commit(wt, 'feat');
  });
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    it(`${sig} → the command stops at once, nothing merged, worktree kept`, { skip: WIN && 'POSIX signals: kill(SIGTERM/SIGINT) is a hard kill on Windows' }, async () => {
      // gsdt-wt-finish gets the signal while its tests run
      rmSync(path.join(W, 'sig-started'), { force: true });
      const before = gitOut(R, ['rev-parse', 'main']);
      const child = spawn(process.execPath, [LAUNCH, 'wt-finish', '1'], { cwd: R, env: envOf(), stdio: 'ignore' });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
      for (let n = 0; n < 100 && !exists(path.join(W, 'sig-started')); n++) await sleep(100);
      const t0 = Date.now();
      child.kill(sig);
      const r = await exited;
      const took = (Date.now() - t0) / 1000;
      await sleep(5000); // let the orphaned test command end
      is(`${sig} → the command stops at once`, `${r.signal}:${took < 3 ? 'fast' : ''}`, `${sig}:fast`);
      is('…nothing merged', gitOut(R, ['rev-parse', 'main']), before);
      is('…origin untouched', git(W, ['--git-dir', `${R}.git`, 'rev-parse', 'main']).stdout.trim(), before);
      ok('…worktree kept', isDir(wt));
    });
  }
  it('…the next command reclaims the lock it left', { skip: WIN && 'POSIX signals' }, () => {
    const r = gsdt('gsdt-wt-new', ['--phase', '1'], { cwd: R });
    has('…the next command reclaims the lock it left', r.out, 'reclaimed stale gsd lock');
  });
});

describe('a launched session gets the signals bash\'s exec gave it', () => {
  const R = path.join(W, 'sigl');
  const f = (n: string): string => path.join(W, n);
  const agent = (): void => {
    stubSh(
      STUB,
      'claude',
      `#!/usr/bin/env bash
trap 'echo term > "${f('claude-sig')}"; exit 0' TERM
trap 'echo int >> "${f('claude-int')}"' INT
echo $$ > "${f('claude-pid')}"
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do sleep 0.1; done
echo done > "${f('claude-done')}"; exit 7
`,
    );
  };
  /** the signal goes to the gsdt launcher only, not the session */
  const launchSig = async (sig: NodeJS.Signals, what: string): Promise<void> => {
    for (const n of ['claude-sig', 'claude-int', 'claude-pid', 'claude-done', 'l-pid', 'l-rc']) rmSync(f(n), { force: true });
    const tty = inTtyAsync(`cd '${R}' && { perl -e '$SIG{INT}="DEFAULT"; exec @ARGV' ${what} < /dev/tty & echo $! > '${f('l-pid')}'; wait $!; echo $? > '${f('l-rc')}'; }`);
    for (let n = 0; n < 100 && !exists(f('claude-pid')); n++) await sleep(100);
    process.kill(Number(read(f('l-pid')).trim()), sig);
    await tty.done;
  };
  const cat = (n: string): string => (exists(f(n)) ? read(f(n)).trim() : '');
  it('gsdt-start: a TERM reaches the session', { skip: NO_PTY }, async () => {
    agent();
    project(R);
    await launchSig('SIGTERM', 'gsdt-start -p 1');
    is('gsdt-start: a TERM reaches the session', cat('claude-sig'), 'term');
  });
  it('gsdt-batch: an INT to it alone neither kills it nor the session', { skip: NO_PTY }, async () => {
    await launchSig('SIGINT', "gsdt-batch '- fix a typo'");
    is('gsdt-batch: an INT to it alone neither kills it nor the session', `${cat('claude-done')}:${cat('l-rc')}`, 'done:7');
    rmStub('claude');
  });
});

describe('gsdt-start — losing a claim race keeps uncommitted work in the main checkout', () => {
  it('the claim is renumbered and pushed; the uncommitted edit is still there', () => {
    const R = path.join(W, 'race');
    project(R);
    write(path.join(R, 'notes.txt'), 'local edit\n');
    commit(R, 'notes');
    gitOk(R, ['push', '-q']);
    const other = path.join(W, 'race-other');
    gitOk(W, ['clone', '-q', `${R}.git`, other]);
    write(
      path.join(R, '.git', 'hooks', 'pre-push'),
      `#!/bin/sh
[ -e "${fwd(path.join(W, 'raced'))}" ] && exit 0
touch "${fwd(path.join(W, 'raced'))}"
cd "${fwd(other)}" && printf '\\n### Phase 2: theirs\\n' >> .planning/ROADMAP.md && git commit -qam theirs && git push -q origin main
exit 1
`,
      0o755,
    );
    write(path.join(R, 'notes.txt'), 'uncommitted edit\n');
    const r = start(R, ['-n', 'mine', '--no-launch']);
    is('the claim is renumbered and pushed', `${r.status}:${countLines(originShow(R, 'main:.planning/ROADMAP.md'), /^### Phase 3: mine/)}`, '0:1');
    has('…after losing phase 2', r.out, 'renumbering');
    is('…and the uncommitted edit is still there', readLf(path.join(R, 'notes.txt')).replace(/\n+$/, ''), 'uncommitted edit');
  });
});

describe('finish — a stray untracked file in .planning/ does not strand the merge', () => {
  it('finish succeeds, the merge is on origin, the stray file is left alone', () => {
    const R = path.join(W, 'stray');
    project(R);
    gsdt('gsdt-wt-new', ['--phase', '1'], { cwd: R });
    const wt = worktreeOf(R, 'phase-1-');
    write(path.join(wt, 'f.txt'), 'x\n');
    commit(wt, 'feat');
    write(path.join(R, '.planning', 'scratch.md'), 'notes\n');
    const r = gsdt('gsdt-wt-finish', ['1'], { cwd: R });
    is('finish succeeds', r.status, 0);
    is('…the merge is on origin', originShow(R, 'main:f.txt').replace(/\n+$/, ''), 'x');
    is('…the stray file is left alone', readLf(path.join(R, '.planning', 'scratch.md')).replace(/\n+$/, ''), 'notes');
  });
});

// ── lints ────────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    out.push(p);
    if (statSync(p).isDirectory()) walk(p, out);
  }
  return out;
}
const filesIn = (dir: string, re: RegExp): string[] => (existsSync(path.join(PKG, dir)) ? readdirSync(path.join(PKG, dir)).filter((n) => re.test(n)).map((n) => path.join(dir, n)) : []);

describe('lint — bash 3.2 traps', () => {
  it('no $VAR directly followed by a non-ASCII character', () => {
    // macOS bash 3.2 in a UTF-8 locale reads "$VAR…" as a variable named VAR plus the first byte of "…" →
    // "unbound variable" under set -u. Worse, with the lock's EXIT trap installed the script then exits 0, so the
    // crash looks like success. Always brace a variable that touches a non-ASCII character: ${VAR}…
    const files = [
      ...filesIn('bin', /.*/),
      ...filesIn('lib', /\.sh$/),
      ...filesIn(path.join('lib', 'tracker'), /\.sh$/),
      'install.sh',
      ...filesIn('tools', /\.sh$/),
      ...filesIn(path.join('shims', 'scripts'), /\.sh$/),
      ...filesIn(path.join('shims', 'scripts', 'hooks'), /\.sh$/),
    ].filter((f) => existsSync(path.join(PKG, f)) && statSync(path.join(PKG, f)).isFile());
    const risky: string[] = [];
    for (const f of files) {
      readFileSync(path.join(PKG, f), 'latin1')
        .split('\n')
        .forEach((l, i) => {
          if (/\$[A-Za-z_][A-Za-z0-9_]*[^\x20-\x7e\t\n\v\f\r]/.test(l)) risky.push(`${f}:${i + 1}:${l}`);
        });
    }
    is('no $VAR directly followed by a non-ASCII character', risky.join('\n'), '');
  });
});

describe('lint — gsd-* is gsd-core\'s prefix (0.10.0)', () => {
  // Our commands are gsdt-*: a gsd-* one could clash with a gsd-core skill.
  const OLD_RE = /(^|[^/A-Za-z0-9_.-])gsd-(init|start|list|finish|doctor|update|bootstrap-repo|planning-repair|tracker|ui|codex-wait|batch|batch-report|wt-new|wt-finish|worktree-guard|flow-next|planning-merge|derive-port|rules|migrate)([^A-Za-z0-9-]|$)/;
  it('no command or shim is named gsd-*', () => {
    const old = [...walk(path.join(PKG, 'bin')), ...walk(path.join(PKG, 'shims'))].filter((p) => path.basename(p).startsWith('gsd-'));
    is('no command or shim is named gsd-*', old.join('\n'), '');
  });
  it('no shim names an old command', () => {
    // Shims and generated text must never send anyone to an old command.
    const hits: string[] = [];
    for (const p of walk(path.join(PKG, 'shims'))) {
      if (!statSync(p).isFile()) continue;
      readFileSync(p, 'utf8')
        .split('\n')
        .forEach((l, i) => {
          if (OLD_RE.test(l)) hits.push(`${path.relative(PKG, p)}:${i + 1}:${l}`);
        });
    }
    is('no shim names an old command', hits.join('\n'), '');
  });
  it('no rule or instruction block names an old command', () => {
    const blocks = [rulesText('on'), canonicalBlock('claude,codex', 'claude', 'main', 'x-worktrees'), providerEntryBlock('claude'), providerEntryBlock('codex,custom')].join('\n');
    const hits = blocks.split('\n').filter((l) => OLD_RE.test(l));
    is('no rule or instruction block names an old command', hits.join('\n'), '');
  });
});
