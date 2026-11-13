// P5 parity (gsdt-list): the TypeScript command behind bin/gsdt-list against
// the pre-P5 bash+Perl command (tests/fixtures/p5-old-bins/gsdt-list, run in a
// package dir holding a copy of lib/). Both run on the SAME fixture repos (the
// command is read-only), so stdout, stderr and the exit code are compared as
// they are, with no normalizing.
// Run: node --test tests/ts/p5-list.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PKG, repo, sh, tmp, write, LOCALE_ENV } from './helpers.ts';
import { renderList } from '../../src/commands/list.ts';

const NEW_BIN = path.join(PKG, 'bin', 'gsdt-list');
const OLD_SRC = path.join(PKG, 'tests', 'fixtures', 'p5-old-bins', 'gsdt-list');

const root = tmp();
const oldPkg = path.join(root, 'oldpkg');
mkdirSync(path.join(oldPkg, 'bin'), { recursive: true });
cpSync(path.join(PKG, 'lib'), path.join(oldPkg, 'lib'), { recursive: true });
copyFileSync(OLD_SRC, path.join(oldPkg, 'bin', 'gsdt-list'));
chmodSync(path.join(oldPkg, 'bin', 'gsdt-list'), 0o755);
const OLD_BIN = path.join(oldPkg, 'bin', 'gsdt-list');
cpSync(path.join(PKG, 'VERSION'), path.join(oldPkg, 'VERSION'));
writeFileSync(path.join(oldPkg, '.git'), ''); // like a checkout: the update notice names <pkg>/install.sh

const home = path.join(root, 'home');
mkdirSync(home, { recursive: true });
const baseEnv = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    GSD_NO_UPDATE_CHECK: '1',
    ...LOCALE_ENV,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  delete e.COLUMNS;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete e[k];
    else e[k] = v;
  }
  return e;
};

type R = { out: string; err: string; rc: number };
const go = (bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): R => {
  const r = spawnSync(bin, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { out: r.stdout, err: r.stderr, rc: r.status ?? -1 };
};
/** assert.equal, but name the first differing line instead of dumping both texts */
const eq = (got: string, want: string, label: string): void => {
  if (got === want) return;
  const g = got.split('\n');
  const w = want.split('\n');
  const i = g.findIndex((l, k) => l !== w[k]);
  assert.fail(`${label}: line ${i + 1}\n  new: ${JSON.stringify(g[i])}\n  old: ${JSON.stringify(w[i])}`);
};
const both = (label: string, args: string[], cwd: string, extraEnv: Record<string, string | undefined> = {}, opts: { sortErr?: boolean; rc?: number; out?: RegExp; err?: RegExp } = {}): R => {
  const env = baseEnv(extraEnv);
  const o = go(OLD_BIN, args, cwd, env);
  const n = go(NEW_BIN, args, cwd, env);
  o.err = o.err.split(oldPkg).join('<PKG>');
  n.err = n.err.split(PKG).join('<PKG>');
  const norm = (s: string): string => (opts.sortErr ? s.split('\n').sort().join('\n') : s);
  eq(n.out, o.out, `${label}: stdout`);
  eq(norm(n.err), norm(o.err), `${label}: stderr`);
  assert.equal(n.rc, o.rc, `${label}: exit code`);
  if (opts.rc !== undefined) assert.equal(n.rc, opts.rc, `${label}: expected rc`);
  if (opts.out) assert.match(n.out, opts.out, label);
  if (opts.err) assert.match(n.err, opts.err, label);
  return n;
};
const git = (cwd: string, ...a: string[]): string => sh(cwd, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
const commit = (r: string): void => {
  git(r, 'add', '-A');
  git(r, 'commit', '-qm', 'x', '--allow-empty');
};

// the fixture of tests/test-list.sh, plus odd cases
function mainFixture(): { R: string; WT7: string } {
  const R = path.join(tmp(), 'repo');
  const P = `${R}/.planning/phases`;
  repo(R);
  write(`${R}/.planning/ROADMAP.md`, [
    '# Roadmap',
    '### Phase 1: nothing yet',
    '### Phase 2: spec only',
    '### Phase 3: discussed',
    '### Phase 4: has screens',
    '### Phase 5: half executed',
    '### Phase 6: finished work',
    '### Phase 7: in flight in its worktree with a very long description that must wrap across several lines',
    '### Phase 10: two digit',
    '### Phase 10.1: decimal hotfix',
    '',
  ].join('\n'));
  for (const d of ['02-s', '03-d', '04-u', '05-h', '06-f', '10-t', '10.1-h']) mkdirSync(`${P}/${d}`, { recursive: true });
  for (const f of ['02-s/02-SPEC.md', '03-d/03-CONTEXT.md', '04-u/04-UI-SPEC.md', '05-h/05-01-PLAN.md', '05-h/05-02-PLAN.md', '05-h/05-01-SUMMARY.md', '06-f/06-01-PLAN.md', '06-f/06-01-SUMMARY.md', '10-t/10-CONTEXT.md', '10.1-h/10.1-01-PLAN.md']) write(`${P}/${f}`, '');
  commit(R);
  const WT7 = path.join(tmp(), 'wt7');
  git(R, 'worktree', 'add', '-qb', 'phase-7-wt', WT7);
  write(`${WT7}/.planning/phases/07-w/07-01-PLAN.md`, '');
  git(R, 'branch', 'phase-6-f-pr');
  return { R, WT7 };
}

test('the test-list.sh fixture: widths, compact and wrapped, every COLUMNS', () => {
  const { R } = mainFixture();
  for (const cols of ['20', '40', '50', '70', '71', '80', '100', '120', '200', '1000', '0', '', ' 90', '-5', '60.9', '1e2']) {
    for (const flags of [[], ['--compact'], ['-c'], ['--full'], ['-c', '--full']]) {
      both(`COLUMNS=${cols} ${flags.join(' ')}`, ['--repo', R, ...flags], R, { COLUMNS: cols });
    }
  }
  // A COLUMNS that is not a number: Perl warns on stderr ("Argument … isn't numeric … at - line N, <$fh> line M"); the table is the same
  for (const cols of ['abc', '70abc']) {
    const env = baseEnv({ COLUMNS: cols });
    const o = go(OLD_BIN, ['--repo', R], R, env);
    const n = go(NEW_BIN, ['--repo', R], R, env);
    eq(n.out, o.out, `COLUMNS=${cols}: stdout`);
    assert.equal(n.rc, o.rc);
    assert.match(o.err, /isn't numeric/);
    assert.equal(n.err, '');
  }
  both('no COLUMNS (tput)', ['--repo', R], R, {}, { out: /┌/ });
  both('no COLUMNS, TERM unset', ['--repo', R, '-c'], R, { TERM: undefined });
  both('TERM=dumb', ['--repo', R], R, { TERM: 'dumb' });
});

test('how the repo is found', () => {
  const { R, WT7 } = mainFixture();
  const plain = tmp();
  both('from the main checkout', [], R, { COLUMNS: '90' }, { rc: 0 });
  both('from a subfolder', [], (() => { mkdirSync(`${R}/.planning/phases/02-s/sub`, { recursive: true }); return `${R}/.planning/phases/02-s/sub`; })(), { COLUMNS: '90' }, { rc: 0 });
  both('from inside the phase worktree', [], WT7, { COLUMNS: '90' }, { rc: 0 });
  both('--repo given a worktree path', ['--repo', WT7], plain, { COLUMNS: '90' });
  both('--repo given a subfolder', ['--repo', `${R}/.planning`], plain, { COLUMNS: '90' }, { rc: 0 });
  both('--repo relative', ['--repo', path.basename(R)], path.dirname(R), { COLUMNS: '90' }, { rc: 0 });
  both('--repo empty value = derive from cwd', ['--repo', ''], R, { COLUMNS: '90' }, { rc: 0 });
  both('--repo twice, last wins', ['--repo', plain, '--repo', R], plain, { COLUMNS: '90' }, { rc: 0 });
  both('outside any repo', [], plain, {}, { rc: 1, err: /not inside a git repo/ });
  both('--repo not a git checkout', ['--repo', plain], plain, {}, { rc: 1, err: /--repo is not a git checkout/ });
  both('--repo missing folder', ['--repo', path.join(plain, 'nope')], plain, {}, { rc: 1 });
  const bare = repo(path.join(tmp(), 'noplan'));
  both('a repo without ROADMAP.md', ['--repo', bare], bare, {}, { rc: 1, err: /ROADMAP\.md not found/ });
  both('a repo path with a space', ['--repo', bare], bare, {});
  const sp = path.join(tmp(), 'my repo');
  repo(sp);
  write(`${sp}/.planning/ROADMAP.md`, '### Phase 1: spaced\n');
  both('repo path with a space', [], sp, { COLUMNS: '80' }, { rc: 0 });
});

test('arguments: help, order, errors', () => {
  const { R } = mainFixture();
  const plain = tmp();
  for (const args of [['-h'], ['--help'], ['--help', '--bogus'], ['--bogus', '--help'], ['--compact', '-h'], ['--repo', R, '-h'], ['--repo'], ['--repo', R, '--repo'], ['-x'], ['extra'], ['--repo', R, 'extra'], [''], ['--compact', '--bogus'], ['-c', '-c'], ['--Compact']]) {
    both(`args ${JSON.stringify(args)}`, args, plain, { COLUMNS: '80' });
  }
  both('--help text', ['--help'], plain, {}, { rc: 0, out: /^gsdt-list — list GSD phases/ });
  both('--repo needs a value', ['--repo'], plain, {}, { rc: 1, err: /✖ --repo needs a value/ });
  both('unknown argument', ['--bogus'], plain, {}, { rc: 1, err: /unknown argument: --bogus \(see gsdt-list --help\)/ });
});

test('roadmaps and phase folders in odd shapes', () => {
  const mk = (roadmap: string, files: string[] = [], dirs: string[] = []): string => {
    const R = path.join(tmp(), 'r');
    repo(R);
    write(`${R}/.planning/ROADMAP.md`, roadmap);
    for (const d of dirs) mkdirSync(`${R}/.planning/phases/${d}`, { recursive: true });
    for (const f of files) write(`${R}/.planning/phases/${f}`, '');
    commit(R);
    return R;
  };
  const cases: Array<[string, string, string[], string[]?]> = [
    ['no phases', '# Roadmap\n\nnothing\n', []],
    ['empty roadmap', '', []],
    ['zero-padded numbers', '### Phase 08: padded\n### Phase 8.1: dot\n### Phase 02.1: two dot one\n### Phase 2: two\n### Phase 02: padded two\n', ['08-x/08-01-PLAN.md', '08.1-y/08.1-CONTEXT.md', '02.1-z/02.1-SPEC.md', '02-w/02-UI-SPEC.md']],
    ['stage ladder', '### Phase 1: a\n### Phase 2: b\n### Phase 3: c\n### Phase 4: d\n### Phase 5: e\n### Phase 6: f\n### Phase 7: g\n### Phase 8: h\n### Phase 9: i\n', ['01-a/01-SPEC.md', '01-a/01-RESEARCH.md', '02-b/02-PATTERNS.md', '03-c/03-PLAN-OUTLINE.md', '04-d/04-UI-SPEC.md', '04-d/04-SPEC.md', '05-e/05-DISCUSSION-LOG.md', '06-f/06-TICKET.md', '07-g/07-STORY.md', '08-h/08-DISCUSS-CHECKPOINT.json', '09-i/09-context.md', '09-i/09-01-plan.md', '09-i/09-01-summary.md', '09-i/09-02-Plan.md']],
    ['CRLF roadmap', '### Phase 1: crlf title\r\n### Phase 2: another\r\n', ['01-a/01-01-PLAN.md']],
    ['odd heading shapes', '### Phase 1:no space\n### Phase 2:   many spaces   \n### Phase 3:\n### Phase 4:  \n### Phase 5: tab\there\n###  Phase 6: two spaces\n## Phase 7: h2\n### Phase 8 : space before colon\n### Phase 9: ok\n    ### Phase 10: indented\n### Phase 11: trailing \t \n### Phase x: not a number\n### Phase 12.: dot\n### Phase 13.5.1: two dots\n', []],
    ['unicode titles', '### Phase 1: Zürich — café ☕ 日本語のとても長い説明文がここにあります and more words to wrap around the screen\n### Phase 2: 🚀 emoji launch pad with a rather long description for wrapping purposes ok\n### Phase 3: é\n', ['01-z/01-SPEC.md']],
    ['a very long word', '### Phase 1: ' + 'x'.repeat(200) + '\n### Phase 2: short ' + 'y'.repeat(90) + ' tail\n', []],
    ['many phases', Array.from({ length: 120 }, (_, i) => `### Phase ${i + 1}: phase number ${i + 1}`).join('\n') + '\n', ['100-x/100-01-PLAN.md', '99-x/99-01-PLAN.md']],
    ['duplicate phase numbers', '### Phase 1: first\n### Phase 1: second\n', ['01-a/01-01-PLAN.md']],
    ['phase dir collisions and junk', '### Phase 3: three\n### Phase 4: four\n', ['03-a/03-SPEC.md', '.hidden/x', 'README.md', '04-b/04-PLAN.md', '04-b/nested/05-PLAN.md']],
    ['dir without a dash', '### Phase 3: three\n', ['3/3-SPEC.md']],
    ['no trailing newline', '### Phase 1: end', []],
    ['phase heading only (no list)', '# Roadmap\n- [ ] **Phase 1: a**\n', []],
  ];
  for (const [label, roadmap, files, dirs] of cases) {
    const R = mk(roadmap, files, dirs ?? []);
    for (const cols of ['50', '80', '140']) for (const flags of [[], ['--compact']]) both(`${label} COLUMNS=${cols} ${flags.join('')}`, ['--repo', R, ...flags], R, { COLUMNS: cols });
  }
});

test('branches: -pr slugs, padding, batches, detached, non-ASCII', () => {
  const R = path.join(tmp(), 'repo');
  repo(R);
  write(`${R}/.planning/ROADMAP.md`, '### Phase 1: one\n### Phase 08: eight\n### Phase 2: two\n### Phase 02.1: two one\n### Phase 3: three with a slug that is a pr\n### Phase 4: four a quite long branch slug here\n### Phase 5: five\n### Phase 9: nine\n');
  write(`${R}/.planning/phases/08-e/08-01-PLAN.md`, '');
  write(`${R}/.planning/phases/03-t/03-01-PLAN.md`, '');
  commit(R);
  const wts = tmp();
  for (const b of ['phase-1-one', 'phase-8-eight-pr', 'phase-8-eight', 'phase-08-padded', 'phase-2-two-pr', 'phase-02.1-x', 'phase-3-do-the-pr', 'phase-3-do-the-pr-pr', 'phase-4-a-very-long-branch-slug-that-goes-on-and-on-and-on-forever-and-ever', 'phase-10-other', 'phase-5']) git(R, 'branch', b);
  git(R, 'worktree', 'add', '-q', `${wts}/w1`, 'phase-1-one');
  git(R, 'worktree', 'add', '-q', `${wts}/w8`, 'phase-8-eight');
  write(`${wts}/w8/.planning/phases/08-e/08-01-SUMMARY.md`, '');
  git(R, 'worktree', 'add', '-q', `${wts}/w3`, 'phase-3-do-the-pr');
  git(R, 'worktree', 'add', '-q', `${wts}/w4`, 'phase-4-a-very-long-branch-slug-that-goes-on-and-on-and-on-forever-and-ever');
  git(R, 'worktree', 'add', '-q', '--detach', `${wts}/det`);
  for (const cols of ['50', '70', '90', '160']) for (const flags of [[], ['--compact']]) both(`branches COLUMNS=${cols} ${flags.join('')}`, ['--repo', R, ...flags], R, { COLUMNS: cols }, { out: cols === '160' ? /phase-1-one ●/ : /┌/ });
  // batches
  for (const b of ['batch-20261101-fix-things', 'batch-20261102-other-with-a-long-slug']) git(R, 'branch', b);
  git(R, 'worktree', 'add', '-q', `${wts}/b1`, 'batch-20261102-other-with-a-long-slug');
  both('batches listed', ['--repo', R], R, { COLUMNS: '90' }, { out: /batches \(gsdt-batch; land with gsdt-finish <branch>\):\n    {3}batch-20261101-fix-things\n    ● batch-20261102/ });
  both('batches, compact', ['--repo', R, '-c'], R, { COLUMNS: '60' });
  both('from a batch worktree', [], `${wts}/b1`, { COLUMNS: '90' });
  // a branch whose name is not ASCII (Perl saw it as bytes)
  git(R, 'branch', 'phase-9-é-ü');
  git(R, 'worktree', 'add', '-q', `${wts}/w9`, 'phase-9-é-ü');
  both('non-ASCII branch', ['--repo', R], R, { COLUMNS: '90' });
  both('non-ASCII branch compact', ['--repo', R, '-c'], R, { COLUMNS: '50' });
  git(R, 'branch', 'batch-é-1');
  both('non-ASCII batch', ['--repo', R], R, { COLUMNS: '90' });
  // a branch name with a slash
  git(R, 'branch', 'phase-5/sub-x');
  both('slash in a branch', ['--repo', R], R, { COLUMNS: '90' });
  // a missing worktree folder (pruned later): the branch is still attached in git's eyes
  const gone = path.join(wts, 'gone');
  git(R, 'worktree', 'add', '-q', '-b', 'phase-11-gone', gone);
  sh(wts, 'rm', ['-rf', gone]);
  write(`${R}/.planning/ROADMAP.md`, `### Phase 11: gone\n`);
  both('worktree folder deleted', ['--repo', R], R, { COLUMNS: '90' });
});

test('notices on stderr: stale hooks and a newer release', () => {
  const { R } = mainFixture();
  const d = tmp();
  const stale = (n: string): string => JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: `node /gone/${n}/gsd-x.js` }, { command: `node /gone/${n}/gsd-y.js` }] }] } });
  write(`${d}/claude.json`, stale('c'));
  write(`${d}/codex.json`, stale('x'));
  const quiet = both('no notice without a terminal', ['--repo', R], R, { COLUMNS: '90', GSD_CLAUDE_SETTINGS: `${d}/claude.json` });
  assert.equal(quiet.err, '');
  const one = both('stale hooks, one file', ['--repo', R], R, { COLUMNS: '90', GSD_UPDATE_NOTICE: 'always', GSD_CLAUDE_SETTINGS: `${d}/claude.json` });
  assert.equal(one.err, `⚠ 2 GSD hook(s) in ${d}/claude.json run a file that is gone, so they fail silently — run gsdt-doctor\n`);
  both('stale hooks, two files', ['--repo', R], R, { COLUMNS: '90', GSD_UPDATE_NOTICE: 'always', GSD_CLAUDE_SETTINGS: `${d}/claude.json`, GSD_CODEX_HOOKS: `${d}/codex.json` }, { sortErr: true, err: /codex\.json/ });
  both('stale hooks, repo hooks are not listed', ['--repo', R], R, { COLUMNS: '90', GSD_UPDATE_NOTICE: 'always' });
  write(`${R}/.claude/settings.json`, stale('repo'));
  both('repo settings file is ignored by the notice', ['--repo', R], R, { COLUMNS: '90', GSD_UPDATE_NOTICE: 'always' });
  both('error paths print the notice first', ['--bogus'], R, { GSD_UPDATE_NOTICE: 'always', GSD_CLAUDE_SETTINGS: `${d}/claude.json` });
  both('help prints no notice', ['--help'], R, { GSD_UPDATE_NOTICE: 'always', GSD_CLAUDE_SETTINGS: `${d}/claude.json` });
  both('a bad repo prints the notice, then dies', ['--repo', d], R, { GSD_UPDATE_NOTICE: 'always', GSD_CLAUDE_SETTINGS: `${d}/claude.json` }, { rc: 1 });
  // a newer release known from the cache (fresh files: nothing is fetched)
  const cache = path.join(d, 'xdg', 'gsd-toolkit');
  write(`${cache}/latest-version`, '99.0.0\n');
  write(`${cache}/latest-gsd-core-version`, '99.0.0\n');
  const rel = both('a newer release', ['--repo', R], R, { COLUMNS: '90', GSD_UPDATE_NOTICE: 'always', GSD_NO_UPDATE_CHECK: undefined, XDG_CACHE_HOME: `${d}/xdg`, GSD_CLAUDE_SETTINGS: `${d}/claude.json` }, { err: /gsd-toolkit 99\.0\.0 is out/ });
  assert.match(rel.err, /⚠ 2 GSD hook/);
  both('release check off', ['--repo', R], R, { COLUMNS: '90', GSD_UPDATE_NOTICE: 'always', GSD_NO_UPDATE_CHECK: '1', XDG_CACHE_HOME: `${d}/xdg` });
});

test('renderList: odd widths in-process (no repo needed)', () => {
  const mkP = (n: number): string => Array.from({ length: n }, (_, i) => `### Phase ${i + 1}: title ${'w'.repeat(i * 7)}`).join('\n');
  for (const termcols of [0, 5, 30, 60, 100]) {
    for (const full of [true, false]) {
      const o = renderList({ roadmap: '/r', text: mkP(6), wt: new Map([['phase-1-a', '/x']]), branches: ['phase-1-a', 'phase-2-b-' + 'z'.repeat(60)], batches: [], phasesRoot: '/nonexistent', termcols, full });
      assert.match(o, /^┌/);
      assert.ok(o.endsWith('● worktree attached\n'));
    }
  }
});

test('symlinked launcher still finds the package', () => {
  const { R } = mainFixture();
  const bin = path.join(tmp(), 'bin');
  mkdirSync(bin);
  symlinkSync(NEW_BIN, path.join(bin, 'gsdt-list'));
  const env = baseEnv({ COLUMNS: '90' });
  const viaLink = go(path.join(bin, 'gsdt-list'), ['--repo', R], R, env);
  const direct = go(NEW_BIN, ['--repo', R], R, env);
  assert.deepEqual(viaLink, direct);
  assert.equal(viaLink.rc, 0);
  writeFileSync(path.join(bin, 'x'), '');
});
