// Regression coverage for the 2026-09-25 full-code review (docs/fix-plan.md, R01–R12).
// Every repo is a throwaway fixture; no real remote is touched.
// Port of tests/test-review-round2.sh. Run: node --test tests/node/review-round2.test.ts
import { after, describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  GSD_RUN_JS, PKG, W, WIN, assertionCount, commit, countLines, fails, fwd, git, gitOk, gitOut, gsdt, gsdtAsync, has, is, isDir, linesOf,
  ok, read, readLf, setBaseEnv, setStubDirs, sleep, stubNode, write, exists,
} from './g3-helpers.ts';
import { registerMergeDriver, testCmd } from '../../src/common.ts';
import { providerResolve } from '../../src/provider.ts';

after(() => console.log(`# review-round2: ${assertionCount()} assertions`));

/** a repo on main with a two-phase roadmap (not committed) */
function repo(dir: string): string {
  mkdirSync(path.join(dir, '.planning'), { recursive: true });
  gitOk(dir, ['init', '-qb', 'main']);
  write(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n### Phase 1: first\n### Phase 2: second\n');
  return dir;
}
const status = (wt: string): string => (exists(path.join(wt, '.gsd-install.status')) ? readLf(path.join(wt, '.gsd-install.status')).trim() : '');

describe('R01 — install/test values are shell commands, not word lists', () => {
  const R = path.join(W, 'r01');
  repo(R);
  const WT = path.join(W, 'r01-worktrees', 'phase-1-first');
  const WT2 = path.join(W, 'r01-worktrees', 'phase-2-second');

  it('foreground install runs every part of a compound command', () => {
    write(path.join(R, '.gsd.conf'), 'install = echo one > a.txt && echo two > b.txt\n');
    commit(R);
    gsdt('gsdt-wt-new', ['--phase', '1', '--install'], { cwd: R });
    ok('foreground install runs every part of a compound command', exists(path.join(WT, 'a.txt')) && exists(path.join(WT, 'b.txt')) && readLf(path.join(WT, 'a.txt')).trim() === 'one');
    is('foreground install records ok', status(WT), 'ok');
  });
  it('background install: a failing second command records fail, not ok', async () => {
    write(path.join(R, '.gsd.conf'), 'install = true && false\n');
    commit(R);
    gsdt('gsdt-wt-new', ['--phase', '2'], { cwd: R });
    for (let i = 0; i < 10 && status(WT2) === 'running'; i++) await sleep(1000);
    is('background install: a failing second command records fail, not ok', status(WT2), 'fail');
  });
  it('background install does not hold a $( … ) caller open (gsdt-start hang)', () => {
    write(path.join(R, '.planning', 'ROADMAP.md'), read(path.join(R, '.planning', 'ROADMAP.md')) + '### Phase 3: third\n');
    write(path.join(R, '.gsd.conf'), 'install = sleep 8\n');
    commit(R);
    const t0 = Date.now();
    gsdt('gsdt-wt-new', ['--phase', '3'], { cwd: R });
    const took = (Date.now() - t0) / 1000;
    ok(`background install does not hold a caller's pipe open (took ${took}s)`, took < 5);
    is('…and its status is running', status(path.join(W, 'r01-worktrees', 'phase-3-third')), 'running');
  });
  it('a failing compound test command blocks the finish', () => {
    const T = path.join(W, 'r01t');
    repo(T);
    write(path.join(T, '.gsd.conf'), 'test = true && false\n');
    commit(T);
    const wt = path.join(W, 'r01t-wt');
    gitOk(T, ['worktree', 'add', '-qb', 'phase-1-x', wt]);
    write(path.join(wt, 'feature'), '');
    commit(wt);
    const r = fails('a failing compound test command blocks the finish (exit)', gsdt('gsdt-wt-finish', ['1'], { cwd: T }));
    ok('…naming the failed tests, worktree kept', r.out.includes('tests failed') && isDir(wt));
  });
});

describe('R02 — a non-executable pre-merge check is refused, not skipped', () => {
  it('finish refuses a non-executable pre-merge check; nothing merged, worktree kept', { skip: WIN && 'POSIX file modes: a file without the exec bit cannot be made on Windows' }, () => {
    const R = path.join(W, 'r02');
    repo(R);
    write(path.join(R, '.gsd.conf'), 'test = none\n');
    write(path.join(R, 'scripts', 'gsdt-premerge-check.sh'), '#!/bin/sh\nexit 1\n', 0o644);
    commit(R);
    const wt = path.join(W, 'r02-wt');
    gitOk(R, ['worktree', 'add', '-qb', 'phase-1-x', wt]);
    write(path.join(wt, 'feature'), '');
    commit(wt);
    const before = gitOut(R, ['rev-parse', 'HEAD']);
    const r = fails('finish refuses a non-executable pre-merge check (exit)', gsdt('gsdt-wt-finish', ['1'], { cwd: R }));
    has('finish refuses a non-executable pre-merge check', r.out, 'not executable');
    ok('nothing merged, worktree kept', before === gitOut(R, ['rev-parse', 'HEAD']) && isDir(wt));
  });
});

describe('R04 — deprecated GSD_AGENT never beats --agent-command', () => {
  const R = path.join(W, 'r04');
  mkdirSync(R, { recursive: true });
  /** providerResolve reads process.env: set it for the call */
  const resolve = (env: Record<string, string>, cliC: string): { provider: string; command: string } => {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) saved[k] = process.env[k];
    Object.assign(process.env, env);
    try {
      const r = providerResolve(R, '', cliC);
      if (!r.ok) throw new Error(`providerResolve failed: ${r.message}`);
      return r.value;
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  it('--agent-command wins over GSD_AGENT', () => {
    is('--agent-command wins over GSD_AGENT', resolve({ GSD_AGENT: 'my-legacy-agent' }, '/opt/bin/real-agent').command, '/opt/bin/real-agent');
  });
  it('GSD_AGENT_COMMAND wins over GSD_AGENT', () => {
    is('GSD_AGENT_COMMAND wins over GSD_AGENT', resolve({ GSD_AGENT: 'my-legacy-agent', GSD_AGENT_COMMAND: '/opt/bin/env-agent' }, '').command, '/opt/bin/env-agent');
  });
  it('GSD_AGENT alone still selects a custom executable', () => {
    const r = resolve({ GSD_AGENT: 'my-legacy-agent' }, '');
    is('GSD_AGENT alone: provider custom', r.provider, 'custom');
    is('GSD_AGENT alone: its executable', r.command, 'my-legacy-agent');
  });
});

const R05 = path.join(W, 'r05');

describe('R05 — concurrent gsdt-wt-new runs for one phase reuse, not crash', () => {
  it('both runs succeed, one branch, lock released', async () => {
    repo(R05);
    write(path.join(R05, '.gsd.conf'), 'install = none\n');
    commit(R05);
    const a = gsdtAsync('gsdt-wt-new', ['--phase', '1'], { cwd: R05 });
    const b = gsdtAsync('gsdt-wt-new', ['--phase', '1'], { cwd: R05 });
    const [ra, rb] = await Promise.all([a.done, b.done]);
    ok(`both runs succeed\n${ra.out}\n${rb.out}`, ra.status === 0 && rb.status === 0);
    is('exactly one phase-1 branch', linesOf(gitOut(R05, ['for-each-ref', 'refs/heads/phase-1-*'])).length, 1);
    ok('lock released afterwards', !isDir(path.join(R05, '.git', 'gsd-cmd.lock')));
  });
  it('two racing lock holders never overlap (20 rounds)', async () => {
    // The lock alone, raced 20 times: with the mkdir command of uutils (Ubuntu 26.04) both callers got in
    // about one time in three. Each round has its own folder; the rounds run side by side.
    const script = path.join(W, 'lock-holder.mjs');
    write(
      script,
      `import { appendFileSync } from 'node:fs';
import { acquireLock } from ${JSON.stringify(pathToFileURL(path.join(PKG, 'src', 'common.ts')).href)};
const L = process.argv[2];
acquireLock(L);
appendFileSync(L + '/log', 'in\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
appendFileSync(L + '/log', 'out\\n');
`,
    );
    const rounds = Array.from({ length: 20 }, (_, i) => path.join(W, `r05l-${i}`));
    for (const L of rounds) {
      mkdirSync(path.join(L, '.git'), { recursive: true });
      write(path.join(L, 'log'), '');
    }
    const runs: Promise<unknown>[] = [];
    for (const L of rounds) {
      for (let k = 0; k < 2; k++) runs.push(spawnNode(script, [L]));
    }
    await Promise.all(runs);
    let over = 0;
    for (const L of rounds) if (linesOf(read(path.join(L, 'log')))[1] !== 'out') over++;
    is('two racing lock holders never overlap (20 rounds)', over, 0);
  });
});

function spawnNode(script: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script, ...args], { stdio: 'ignore' });
    c.on('close', (code) => resolve(code ?? 1));
  });
}

describe('R06 — planning-repair --check: no roadmap is not damage', () => {
  it('exit 0 when .planning/ROADMAP.md is missing', () => {
    const R = path.join(W, 'r06');
    mkdirSync(path.join(R, '.planning'), { recursive: true });
    gitOk(R, ['init', '-qb', 'main']);
    is('exit 0 when .planning/ROADMAP.md is missing', gsdt('gsdt-planning-repair', ['--check', '--repo', R]).status, 0);
  });
});

describe('R07 — doctor JSON says whether the repo uses GSD', () => {
  it('plain repo → gsd_repo false; one parseable object; GSD repo → gsd_repo true', () => {
    const R = path.join(W, 'r07');
    mkdirSync(R, { recursive: true });
    gitOk(R, ['init', '-qb', 'main']);
    const out = gsdt('gsdt-doctor', ['--repo', R, '--json']).stdout;
    has('plain repo → gsd_repo false', out, '"gsd_repo":false');
    let parsed = true;
    try {
      JSON.parse(out);
    } catch {
      parsed = false;
    }
    ok('JSON stays one parseable object', parsed, out);
    has('GSD repo → gsd_repo true', gsdt('gsdt-doctor', ['--repo', R05, '--json']).stdout, '"gsd_repo":true');
  });
});

describe('R09 — npm test detection reads scripts.test only', () => {
  it('a dependency named test is not a test script; scripts.test → npm test', () => {
    const R = path.join(W, 'r09');
    write(path.join(R, 'package.json'), '{\n  "dependencies": { "test": "^1.0.0" }\n}\n');
    is('a dependency named test is not a test script', testCmd(R), '');
    write(path.join(R, 'package.json'), '{\n  "scripts": { "build": "tsc", "test": "jest" }\n}\n');
    is('scripts.test → npm test', testCmd(R), 'npm test');
  });
});

describe('R12 — gsdt-start -p says when it ignores a description', () => {
  it('warning names the ignored text', () => {
    const r = gsdt('gsdt-start', ['-p', '1', 'some text', '--repo', R05, '--no-launch']);
    has('warning names the ignored text', r.out, 'ignoring "some text"');
  });
});

describe('R15 — two sessions claiming at once: the loser renumbers, nobody\'s claim is lost', () => {
  const R = path.join(W, 'r15');
  const origin = path.join(W, 'r15.git');
  let originRoadmap = '';
  it('the claim succeeds, the race is detected and renumbered', () => {
    // Stand-in for gsd-core's gsd_run (not on CI runners): phase.add appends the next number.
    const stub = path.join(W, 'stub');
    const gsdRun = stubNode(stub, 'gsd_run', GSD_RUN_JS);
    setStubDirs(stub);
    setBaseEnv({ GSD_CLI: gsdRun });
    gitOk(W, ['init', '-q', '--bare', '-b', 'main', origin]);
    mkdirSync(path.join(R, '.planning'), { recursive: true });
    gitOk(R, ['init', '-qb', 'main']);
    write(path.join(R, '.planning', 'ROADMAP.md'), '# Roadmap\n\n### Phase 1: first\n');
    write(
      path.join(R, '.planning', 'STATE.md'),
      '---\nstatus: planning\nprogress:\n  total_phases: 1\n  completed_phases: 0\n  total_plans: 0\n  completed_plans: 0\n  percent: 0\n---\n\n# Project State\n',
    );
    write(path.join(R, '.gitattributes'), '.planning/ROADMAP.md merge=gsd-planning\n.planning/STATE.md merge=gsd-planning\n');
    write(path.join(R, '.gsd.conf'), 'install = none\n');
    commit(R, 'init');
    gitOk(R, ['remote', 'add', 'origin', origin]);
    gitOk(R, ['push', '-qu', 'origin', 'main']);
    registerMergeDriver(R);
    // The rival session claims phase 2 and pushes it the moment we try to push.
    const rival = path.join(W, 'r15-rival');
    gitOk(W, ['clone', '-q', origin, rival]);
    write(path.join(rival, '.planning', 'ROADMAP.md'), read(path.join(rival, '.planning', 'ROADMAP.md')) + '\n### Phase 2: user login\n');
    commit(rival, 'docs(gsd): claim phase 2 — user login');
    write(path.join(R, '.git', 'hooks', 'pre-push'), '#!/bin/sh\n[ -f "$RIVAL_DONE" ] && exit 0\ntouch "$RIVAL_DONE"\ngit -C "$RIVAL" push -q origin main\n', 0o755);
    const r = gsdt('gsdt-start', ['-n', 'shopping cart', '--no-launch'], { cwd: R, env: { RIVAL: fwd(rival), RIVAL_DONE: fwd(path.join(W, 'r15-done')) } });
    originRoadmap = git(W, ['--git-dir', origin, 'show', 'main:.planning/ROADMAP.md']).stdout.replace(/\r\n/g, '\n');
    is(`claim succeeds\n${r.out}`, r.status, 0);
    has('the race was detected and renumbered', r.out, 'renumbering');
    has("the rival's phase 2 survives on origin", originRoadmap, /^### Phase 2: user login/);
    has('our claim landed as phase 3', originRoadmap, /^### Phase 3: shopping cart/);
    is('exactly one phase 2 heading', countLines(originRoadmap, /^### Phase 2:/), 1);
    is('worktree branch is phase-3', git(R, ['show-ref', '--verify', '--quiet', 'refs/heads/phase-3-shopping-cart']).status, 0);
  });

  describe('R17 — the claim commit carries correct STATE.md counters', () => {
    it('origin STATE.md counts all 3 phases; a later repair leaves main clean', () => {
      has('origin STATE.md counts all 3 phases', git(W, ['--git-dir', origin, 'show', 'main:.planning/STATE.md']).stdout, 'total_phases: 3');
      gsdt('gsdt-planning-repair', ['--repo', R]);
      is('a later repair (the post-merge hook) leaves main clean', gitOut(R, ['status', '--porcelain', '--', '.planning']), '');
    });
  });
});

describe('R16 — a claimed phase gets its checklist + Progress rows', () => {
  const RM = path.join(W, 'r16.md');
  const rows = (n: string): number => gsdt('roadmap-rows', [RM, n]).status;
  const trimEnd = (s: string): string => s.replace(/\n+$/, '');

  it('rows are added for a claimed phase and an inserted decimal one; the audit is clean', () => {
    write(
      RM,
      `# Roadmap

## Phases

- [x] **Phase 1: First** - done
- [ ] **Phase 2: Second** - next

## Phase Details

### Phase 1: First
### Phase 2: Second
### Phase 2.1: Hot fix | urgent (INSERTED)
- [ ] TBD (run /gsd-plan-phase 2.1 to break down)
### Phase 3: Third
- [ ] TBD (run /gsd-plan-phase 3 to break down)

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. First | v1 | 1/1 | Complete | 2026-09-01 |
| 2. Second | v1 | 0/2 | In progress | - |
`,
    );
    is('rows for phase 3 added', rows('3'), 0);
    is('rows for phase 2.1 added', rows('2.1'), 0);
    is('roadmap audit is clean afterwards (no T021/T022/T023)', gsdt('roadmap-audit', [RM]).stdout, '');
    const t = readLf(RM);
    is(
      'checklist rows in numeric order',
      linesOf(t)
        .map((l) => /^- \[.\] \*\*Phase ([0-9.]+)/.exec(l)?.[1])
        .filter((x) => x !== undefined)
        .join(' '),
      '1 2 2.1 3',
    );
    is(
      'Progress rows in numeric order',
      linesOf(t)
        .map((l) => /^\| [0-9.]+\./.exec(l)?.[0].slice(2))
        .filter((x) => x !== undefined)
        .join(' '),
      '1. 2. 2.1. 3.',
    );
    ok("Progress row matches the table's columns", linesOf(t).includes('| 3. Third | - | 0/TBD | Not started | - |'));
    ok('a | in the title does not break the table', linesOf(t).some((l) => l.startsWith('| 2.1. Hot fix / urgent')));
  });
  it('idempotent', () => {
    const before = read(RM);
    rows('3');
    is('idempotent', read(RM), before);
  });
  it('a roadmap without checklist or table is left alone', () => {
    write(RM, '# Roadmap\n### Phase 1: only\n');
    rows('1');
    is('a roadmap without checklist or table is left alone', trimEnd(read(RM)), '# Roadmap\n### Phase 1: only');
  });
  it('a 2.1 row does not stand in for phase 2', () => {
    write(RM, '# Roadmap\n- [ ] **Phase 2.1: Fix**\n### Phase 2: Two\n### Phase 2.1: Fix\n\n| Phase | Status |\n|---|---|\n| 2.1. Fix | Not started |\n');
    rows('2');
    const l = linesOf(readLf(RM));
    ok('a 2.1 row does not stand in for phase 2 (Progress)', l.includes('| 2. Two | Not started |'));
    ok('…nor in the checklist', l.includes('- [ ] **Phase 2: Two**'));
  });
  it('a padded 02 matches the rows of phase 2', () => {
    write(RM, '# Roadmap\n- [ ] **Phase 2: Two**\n### Phase 02: Two\n\n| Phase | Status |\n|---|---|\n| 2. Two | Not started |\n');
    const before = read(RM);
    rows('02');
    is('a padded 02 matches the rows of phase 2', read(RM), before);
  });
});
