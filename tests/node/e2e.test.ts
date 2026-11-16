// e2e.test.ts — the whole journey, end to end, in a throwaway fake project
// (was tests/test-e2e.sh).
//
// Runs the REAL commands from this checkout (its launchers first on PATH) and the
// REAL gsd-core (gsd_run), against a local bare repo standing in for GitHub. The AI's
// work is simulated with plain files and commits, so it costs nothing. It covers what
// unit suites cannot: pieces working together —
//   gsdt-init for claude+codex · two clones claiming at the same moment ·
//   gsdt-list · a hotfix --insert · the guard · the flow order with a
//   Claude → Codex handoff · both clones finishing at once · doctor + repair.
// It found the claim-race phase loss (R15), missing roadmap rows (R16), the
// pull-then-claim block (R17) and the padded-decimal guard block (R18).
//
// Run it after any change to start / finish / guard / flow / planning code.
// Skipped without gsd-core (npm i -g @opengsd/gsd-core); GSD_TEST_REQUIRE_GSD=1 (CI)
// turns the skip into a failure.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  PKG, WIN, baseEnv, fwd, git, gitOk, launch, mkTmp, mkdirp, ok, readLF, run, runAsync, sleep, stubSh, tryRead, whichHost, withHome, write,
} from './g5-helpers.ts';

// ── gsd-core (gsd_cli): the first of GSD_CLI, PATH, ~/.claude, ~/.codex that is the real thing ──
function findGsdRun(): string | null {
  const home = process.env.HOME ?? homedir();
  const cands = [
    process.env.GSD_CLI ?? '', whichHost('gsd_run') ?? '',
    `${process.env.CLAUDE_CONFIG_DIR || `${home}/.claude`}/gsd-core/bin/gsd_run`,
    `${process.env.CODEX_HOME || `${home}/.codex`}/gsd-core/bin/gsd_run`,
  ];
  for (const c of cands) {
    if (c === '' || !existsSync(c)) continue;
    const r = run(c, ['runtime-identity', '--raw']);
    if (r.status !== 0) continue;
    if (r.stdout.includes('"packageName":"@opengsd/gsd-core"') || r.stdout.includes('"packageName": "@opengsd/gsd-core"')) return c;
  }
  return null;
}
const GSD_RUN = findGsdRun();
const REQUIRE = process.env.GSD_TEST_REQUIRE_GSD === '1';
if (GSD_RUN === null && REQUIRE) {
  test('gsd-core is installed', () => { ok('gsd-core not installed (npm i -g @opengsd/gsd-core) — this suite drives the real claim path', false); });
}
const SKIP: string | false = GSD_RUN === null && 'SKIPPED: gsd-core not installed (npm i -g @opengsd/gsd-core) — this suite drives the real claim path';

const S = mkTmp('gsdt-e2e-');
const HOME_ = mkdirp(path.join(S, 'home'));
// the commands by name: this checkout's launchers (bin/*: bash) on POSIX; on Windows a dir of
// shims that run `node src/launch.mjs <name>`, which is what the bash launchers do
const COMMANDS = readdirSync(path.join(PKG, 'bin')).filter((n) => n.startsWith('gsdt-'));
let BINDIR = path.join(PKG, 'bin');
if (WIN) {
  BINDIR = mkdirp(path.join(S, 'bin'));
  for (const n of COMMANDS) {
    const launcher = `"${fwd(process.execPath)}" "${fwd(path.join(PKG, 'src', 'launch.mjs'))}" ${n.replace(/^gsdt-/, '')}`;
    stubSh(BINDIR, n, `#!/bin/sh\nexec ${launcher} "$@"\n`, `@"${process.execPath}" "${path.join(PKG, 'src', 'launch.mjs')}" ${n.replace(/^gsdt-/, '')} %*\r\n`);
  }
}
// the agent CLIs: doctor wants them installed; this suite never opens a session
const AGENTS = path.join(S, 'agents');
for (const a of ['claude', 'codex']) stubSh(AGENTS, a, '#!/bin/sh\nexit 0\n');
const SETTINGS = path.join(S, 'claude-settings.json');
// the laptop's Claude settings hold what an install writes: the gsdt-rules session hook
writeFileSync(SETTINGS, `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `exec ${fwd(PKG)}/bin/gsdt-rules --hook` }] }] } })}\n`);

const ENV = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => withHome(baseEnv({
  PATH: [BINDIR, process.env.PATH ?? process.env.Path ?? '', AGENTS].join(path.delimiter),
  GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@t', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@t',
  // the laptop's installed skills are not what this checkout is testing
  GSD_CLAUDE_SKILL_DIR: path.join(S, 'skills'), GSD_CODEX_SKILL_DIR: path.join(S, 'skills-codex'), GSD_CLAUDE_SETTINGS: SETTINGS,
  GSD_CLI: GSD_RUN ?? undefined, GSD_NO_UPDATE_CHECK: '1', XDG_CONFIG_HOME: path.join(HOME_, '.config'), XDG_CACHE_HOME: path.join(HOME_, '.cache'),
  ...extra,
}), HOME_);
/** a toolkit command, by name, through the PATH launchers */
const cmd = (name: string, args: string[], cwd: string, extra: Record<string, string | undefined> = {}) =>
  run(WIN ? process.execPath : path.join(BINDIR, name), WIN ? [path.join(PKG, 'src', 'launch.mjs'), name.replace(/^gsdt-/, ''), ...args] : args, { cwd, env: ENV(extra) });
const cmdAsync = (name: string, args: string[], cwd: string, extra: Record<string, string | undefined> = {}) =>
  runAsync(WIN ? process.execPath : path.join(BINDIR, name), WIN ? [path.join(PKG, 'src', 'launch.mjs'), name.replace(/^gsdt-/, ''), ...args] : args, { cwd, env: ENV(extra) });
const art = (dir: string, msg: string): void => { gitOk(dir, ['add', '-A']); gitOk(dir, ['commit', '-qm', msg]); };   // simulate an AI step's commit
const P2 = (n: string | number): string => String(Number(n)).padStart(2, '0');
const lines = (s: string): string[] => s.split('\n');
const count = (hay: string, re: RegExp): number => lines(hay).filter((l) => re.test(l)).length;
const dirsStarting = (d: string, prefix: string): string[] => {
  try { return readdirSync(d).filter((n) => n.startsWith(prefix) && statSync(path.join(d, n)).isDirectory()).sort().map((n) => path.join(d, n)); } catch { return []; }
};
/** [worktree path, branch] pairs from `git worktree list --porcelain` */
function worktrees(repo: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let w = '';
  for (const l of lines(gitOk(repo, ['worktree', 'list', '--porcelain']))) {
    if (l.startsWith('worktree ')) w = l.slice(9);
    else if (l.startsWith('branch ')) out.push([w, l.slice(7)]);
  }
  return out;
}

const ROADMAP = `# Roadmap: Fake Shop

## Phases

- [ ] **Phase 1: Product catalog** - List products

## Phase Details

### Phase 1: Product catalog
**Goal**: Customers can browse products
**Depends on**: Nothing (first phase)
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Product catalog | 0/0 | Not started | - |
`;
const STATE = `---
gsd_state_version: 1.0
milestone: v1.0
status: planning
stopped_at: Project initialized
progress:
  total_phases: 1
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Current Position

Phase: 1 of 1 (Product catalog)
Status: Ready to plan

## Session Continuity

Last session: 2026-09-25
Stopped at: Project initialized
Resume file: None
`;

const origin = path.join(S, 'origin.git'), shop = path.join(S, 'shop'), laptop2 = path.join(S, 'laptop2');
let CART_N = '', LOGIN_N = '', WT_CART = '', PD = '', P = '', WT_LOGIN = '';
const G = (command: string, phase: string, repo: string): number => cmd('gsdt-worktree-guard', ['--command', command, '--phase', phase, '--repo', repo], S).status;
const NEXT = (): string => lines(cmd('gsdt-flow-next', [CART_N, '--repo', WT_CART, '--no-ui'], S).out).filter((l) => l.startsWith('step=')).map((l) => l.slice(5)).join('\n');
const done = (code: number, label: string, detail = ''): void => ok(label, code === 0, detail);

test('end to end: the whole journey in a fake project', { skip: SKIP }, async (t) => {
  await t.test('1. project + gsdt-init (claude, codex)', () => {
    gitOk(S, ['init', '-q', '--bare', '-b', 'main', origin]);
    mkdirp(shop); gitOk(shop, ['init', '-qb', 'main']);
    write(path.join(shop, 'README.md'), '# Fake Shop\n'); write(path.join(shop, 'Makefile'), 'test:\n\t@test -f README.md\n');
    art(shop, 'initial code'); gitOk(shop, ['remote', 'add', 'origin', origin]); gitOk(shop, ['push', '-qu', 'origin', 'main']);
    const r = cmd('gsdt-init', ['--providers', 'claude,codex', '--provider', 'claude', '--no-launch'], shop);
    writeFileSync(path.join(S, 'init.log'), r.out);
    done(r.status, 'gsdt-init succeeds', r.out);
    ok('2 instruction entrypoints', existsSync(path.join(shop, 'CLAUDE.md')) && existsSync(path.join(shop, 'AGENTS.md')) && !existsSync(path.join(shop, 'GEMINI.md')));
    ok('main checkout: worktree.baseRef = head', tryRead(path.join(shop, '.claude', 'settings.local.json')).includes('"baseRef": "head"'));
    ok('claude hook, codex none', tryRead(path.join(shop, '.claude', 'settings.json')).includes('gsdt-worktree-guard') && r.out.includes('codex native guard hook: unsupported'), r.out);
    writeFileSync(path.join(shop, '.gsd.conf'), `${readLF(path.join(shop, '.gsd.conf'))}flow = strict\ntest = test -f README.md && test -f Makefile\n`);
  });

  await t.test('2. simulated /gsd-new-project', () => {
    mkdirp(path.join(shop, '.planning', 'phases'));
    write(path.join(shop, '.planning', 'PROJECT.md'), '# Fake Shop\n\n## Core Value\nCustomers can buy things.\n');
    write(path.join(shop, '.planning', 'ROADMAP.md'), ROADMAP);
    write(path.join(shop, '.planning', 'STATE.md'), STATE);
    art(shop, 'docs: initialize project'); gitOk(shop, ['push', '-q']);
    const d0 = cmd('gsdt-doctor', ['--quiet'], shop);
    ok('doctor clean after init', d0.status === 0, d0.out);
  });

  await t.test('3. two sessions claim at the same moment (second clone = second laptop)', async () => {
    gitOk(S, ['clone', '-q', origin, laptop2]);
    // a fresh clone has no merge driver (git config is not versioned) — as on a new laptop
    gitOk(laptop2, ['config', 'merge.gsd-planning.driver', 'gsdt-planning-merge %O %A %B %P']);
    const [a, b] = await Promise.all([
      cmdAsync('gsdt-start', ['-n', 'shopping cart', '--no-launch'], shop),
      cmdAsync('gsdt-start', ['-n', 'user login', '--provider', 'codex', '--no-launch'], laptop2),
    ]);
    writeFileSync(path.join(S, 'start-a.log'), a.out); writeFileSync(path.join(S, 'start-b.log'), b.out);
    ok('both claims succeed', a.status === 0 && b.status === 0, `${a.out.split('\n').slice(-5).join('\n')}\n${b.out.split('\n').slice(-5).join('\n')}`);
    const ROAD = gitOk(S, ['--git-dir', origin, 'show', 'main:.planning/ROADMAP.md']).replace(/\r\n/g, '\n');
    ok('origin has phases 2 AND 3, one each', count(ROAD, /^### Phase 2:/) === 1 && count(ROAD, /^### Phase 3:/) === 1, ROAD);
    ok('both titles survive', ROAD.includes('shopping cart') && ROAD.includes('user login'));
    CART_N = /^### Phase ([0-9]+): shopping cart/m.exec(ROAD)?.[1] ?? '';
    LOGIN_N = /^### Phase ([0-9]+): user login/m.exec(ROAD)?.[1] ?? '';
    process.stdout.write(`  (cart = phase ${CART_N}, login = phase ${LOGIN_N})\n`);
    gitOk(shop, ['pull', '-q', '--ff-only']);
    WT_CART = worktrees(shop).find(([, br]) => br === `refs/heads/phase-${CART_N}-shopping-cart`)?.[0] ?? '';
    if (WT_CART === '') WT_CART = dirsStarting(path.join(S, 'shop-worktrees'), `phase-${CART_N}-`)[0] ?? '';
    ok('cart worktree exists', WT_CART !== '' && existsSync(WT_CART));
    ok('codex launch line printed for login', b.out.includes('&& codex '), b.out);
    // gsd-core's own check, as /gsd-execute-phase runs it: a phase branch is ahead
    // of origin/HEAD, so without worktree.baseRef = "head" every wave runs one plan
    // at a time. An empty CLAUDE_CONFIG_DIR: this machine's settings do not count.
    const bc = run(GSD_RUN!, ['query', 'worktree.base-check', '--mode', 'harness-worktree'], { cwd: WT_CART, env: ENV({ CLAUDE_CONFIG_DIR: path.join(S, 'no-claude') }) });
    ok('fresh worktree: gsd-core base-check does not degrade', bc.out.includes('"shouldDegrade": false'), bc.out);
  });

  await t.test('4. gsdt-list', () => {
    const r = cmd('gsdt-list', [], shop, { COLUMNS: '100' });
    ok('list shows all 3 phases', r.out.includes('Product catalog') && r.out.includes('shopping cart') && r.out.includes('user login'), r.out);
    ok('cart worktree marked attached', lines(r.out).some((l) => l.includes('shopping cart') && l.includes('●')), r.out);
  });

  await t.test('4b. hotfix phase (--insert) and roadmap rows', () => {
    const ins = cmd('gsdt-start', ['--insert', CART_N, 'urgent price bug', '--no-launch'], shop);
    ok('hotfix claim succeeds (padded decimal phase)', ins.status === 0, ins.out.split('\n').slice(-3).join('\n'));
    git(shop, ['push', '-q']);
    const aud = launch('roadmap-audit', [path.join(shop, '.planning', 'ROADMAP.md')]);
    ok('every claimed phase has its checklist + Progress rows', aud.stdout === '', aud.stdout);
  });

  await t.test('5. the guard', () => {
    ok('feature work on main is blocked', G('gsd-discuss-phase', CART_N, shop) === 2);
    ok('wrong phase in cart worktree is blocked', G('gsd-discuss-phase', LOGIN_N, WT_CART) === 2);
    ok('discuss in its own worktree is allowed', G('gsd-discuss-phase', CART_N, WT_CART) === 0);
    ok('strict: plan before discuss is blocked', G('gsd-plan-phase', CART_N, WT_CART) === 2);
    ok('/gsd-phase off main is blocked', cmd('gsdt-worktree-guard', ['--command', 'gsd-phase', '--repo', WT_CART], S).status === 2);
    P = P2(CART_N);
    ok(`zero-padded phase (${P}) works`, G('gsd-discuss-phase', P, WT_CART) === 0);
  });

  await t.test('6. flow, with a Claude → Codex handoff on the cart phase', () => {
    PD = dirsStarting(path.join(WT_CART, '.planning', 'phases'), `${P}-`)[0] ?? '';
    if (PD === '') { PD = path.join(WT_CART, '.planning', 'phases', `${P}-shopping-cart`); mkdirp(PD); }
    ok('no tracker → first step is discuss', NEXT() === 'discuss', NEXT());
    write(path.join(PD, `${P}-CONTEXT.md`), '# context (by claude)\n'); art(WT_CART, 'discuss (claude)');
    const h = cmd('gsdt-start', ['-p', CART_N, '--provider', 'codex', '--no-launch'], shop);
    writeFileSync(path.join(S, 'handoff.log'), h.out);
    ok('handoff to codex reuses the same worktree', h.out.includes(WT_CART) && h.out.includes('&& codex '), h.out.split('\n').slice(-4).join('\n'));
    ok('after discuss → plan', NEXT() === 'plan', NEXT());
    write(path.join(PD, `${P}-01-PLAN.md`), ''); art(WT_CART, 'plan (codex)');
    ok('then cross-AI review', NEXT() === 'review', NEXT());
    ok('strict: execute before review is blocked', G('gsd-execute-phase', CART_N, WT_CART) === 2);
    sleep(1000); write(path.join(PD, `${P}-REVIEWS.md`), ''); art(WT_CART, 'review');
    ok('review not folded in → replan', NEXT() === 'replan', NEXT());
    sleep(1000); writeFileSync(path.join(PD, `${P}-01-PLAN.md`), `${readFileSync(path.join(PD, `${P}-01-PLAN.md`), 'utf8')}revised\n`); art(WT_CART, 'replan');
    ok('then execute', NEXT() === 'execute', NEXT());
    ok('strict: execute allowed now', G('gsd-execute-phase', CART_N, WT_CART) === 0);
    write(path.join(WT_CART, 'cart.txt'), 'cart\n'); write(path.join(PD, `${P}-01-SUMMARY.md`), ''); art(WT_CART, 'execute');
    ok('then verifier', NEXT() === 'verifier', NEXT());
  });

  await t.test('7. finish both phases (login has a change too)', async () => {
    // login was claimed on laptop2, so laptop2 does its work and finishes it
    WT_LOGIN = worktrees(laptop2).find(([, br]) => br.startsWith('refs/heads/phase-'))?.[0] ?? '';
    write(path.join(WT_LOGIN, 'login.txt'), 'login\n'); art(WT_LOGIN, 'login work');
    const f0 = cmd('gsdt-finish', [CART_N], shop);
    ok('strict: finish without the test audit is refused', f0.status !== 0 && f0.out.includes(`gsd-validate-phase ${CART_N}`), f0.out.split('\n').slice(-4).join('\n'));
    ok('…and the cart worktree is kept', existsSync(WT_CART));
    const audit = (wt: string, n: string): void => {   // a compliant <P>-VALIDATION.md (what /gsd-validate-phase leaves)
      const p = P2(n);
      let d = dirsStarting(path.join(wt, '.planning', 'phases'), `${p}-`)[0] ?? '';
      if (d === '') { d = path.join(wt, '.planning', 'phases', `${p}-work`); mkdirp(d); }
      write(path.join(d, `${p}-VALIDATION.md`), '---\nnyquist_compliant: true\n---\n'); art(wt, 'validate');
    };
    audit(WT_CART, CART_N); audit(WT_LOGIN, LOGIN_N);
    const [a, b] = await Promise.all([cmdAsync('gsdt-finish', [CART_N], shop), cmdAsync('gsdt-finish', [LOGIN_N], laptop2)]);
    ok('cart finish succeeds', a.status === 0, a.out.split('\n').slice(-8).join('\n'));
    ok('login finish succeeds', b.status === 0, b.out.split('\n').slice(-8).join('\n'));
    ok('both changes on origin',
      git(S, ['--git-dir', origin, 'cat-file', '-e', 'main:cart.txt']).status === 0 && git(S, ['--git-dir', origin, 'cat-file', '-e', 'main:login.txt']).status === 0);
    ok('worktrees removed', !existsSync(WT_CART) && !existsSync(WT_LOGIN));
    git(shop, ['pull', '-q', '--ff-only']);
    const rr = cmd('gsdt-planning-repair', ['--check'], shop);
    ok('planning files coherent', rr.status === 0, rr.out);
    const d1 = cmd('gsdt-doctor', ['--quiet'], shop);
    ok('doctor after finishing', d1.status === 0, lines(d1.out).filter((l) => /✖|T0/.test(l)).join('\n'));
  });
});
