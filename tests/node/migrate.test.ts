// tests/test-migrate.sh → node:test. gsdt-migrate: a repo set up before 0.10.0 (old gsd-* shims, repo hook, instruction
// blocks, merge driver, gsd-tracker git section, post-merge hook, the user's pre-merge script, package.json naming a
// shim, the user's Claude hooks, an open phase worktree, free text in .planning/) → dry run lists it all and changes
// nothing → the commands refuse → --apply → --check clean → a second --apply changes nothing → the commands run →
// text outside the markers and .planning/ untouched → a planning merge in the open worktree still uses the driver.
// Also: an edited shim, two pre-merge scripts, doctor T090 (+ --fix), --commit, and a repo bootstrapped by the real
// v0.9.0. Everything runs in throwaway repos; HOME is a temp dir.
// Run: node --test tests/node/migrate.test.ts
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  PKG, WIN, add, baseEnv, chomp, files, gitOk, gitOut, gsdt, has, hasnt, initRepo, is, isExec, lf, mkWork, mkexec, ok, pathWith, read, run, stubSh, w, fileHas, fileHasnt,
} from './g4-env.ts';
import type { Env } from './g4-env.ts';
import { normalizePath } from '../../src/spawn.ts';

/** the repo path as the product prints it in a command: git's spelling (long names, `/`) on Windows */
const gp = (p: string): string => (WIN ? normalizePath(realpathSync.native(p)) : p);

const WORK = mkWork('g4mig-');
const SETTINGS = path.join(WORK, 'user-settings.json');
const ENV: Env = baseEnv(WORK, { GSD_NO_CORE: '1', GSD_CLAUDE_SKILL_DIR: path.join(WORK, 'skills'), GSD_CLAUDE_SETTINGS: SETTINGS });
ENV.PATH = pathWith(...(process.env.PATH ?? '').split(path.delimiter).filter((d) => d !== ''));
// A gsd-core that answers who it is and fails everything else: gsdt-start stops right after the check under test
// (it never claims a phase here).
{
  const f = stubSh(path.join(WORK, 'stub'), 'gsd_run',
    `#!/bin/sh\n[ "$1" = runtime-identity ] && echo '{"packageName":"@opengsd/gsd-core","version":"1.18.0"}' && exit 0\nexit 1\n`);
  ENV.GSD_CLI = WIN ? `${f}.cmd` : f;
}
const git = (cwd: string, ...args: string[]): void => { gitOk(ENV, cwd, args); };
const g = (cmd: string, args: string[], cwd: string, env: Env = {}, input = '') => gsdt(ENV, cmd, args, { cwd, env, input });
let OUT = '';
const out = (r: { out: string }): string => (OUT = r.out);
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const POSIX = WIN && 'POSIX mode bits (chmod +x) are not visible on Windows';

const SHIMS = ['scripts/gsdt-new-worktree-feature.sh', 'scripts/gsdt-finish-worktree-feature.sh', 'scripts/gsdt-derive-port.sh', 'scripts/gsdt-planning-repair.sh', 'scripts/hooks/gsdt-worktree-guard.sh'];
const oldOf = (s: string): string => s.replace('gsdt-', 'gsd-');
/** Turn text from this release into what 0.9.0 wrote: the command names only. */
function age(file: string): void {
  const t = readFileSync(file, 'utf8')
    .replace(/(?<![\w/-])gsdt-(rules|flow-next|worktree-guard|wt-new|wt-finish|derive-port|planning-repair|bootstrap-repo|init|start|finish)(?![\w-])/g, 'gsd-$1')
    .replace(/scripts\/(hooks\/)?gsdt-/g, (_m, h: string | undefined) => `scripts/${h ?? ''}gsd-`)
    .replace(/gsd-toolkit shim/g, 'gsd-worktrees shim');
  writeFileSync(file, t);
}
/** A repo as 0.9.0 left it: set up by this release's bootstrap, then aged. */
function mkold(R: string): void {
  initRepo(ENV, R, 'main');
  mkdirSync(path.join(R, '.planning'), { recursive: true });
  w(path.join(R, '.planning/ROADMAP.md'), '# Roadmap\n\n### Phase 1: One\n');
  w(path.join(R, '.planning/STATE.md'), '# State\n');
  w(path.join(R, '.planning/notes.md'), 'Run gsd-start -p 1, then gsd-finish.\n');
  w(path.join(R, 'CLAUDE.md'), '# My project\n\nOur own text: run gsd-start for a phase.\n');
  git(R, 'add', '-A'); git(R, 'commit', '-qm', 'init');
  const b = g('gsdt-bootstrap-repo', ['--agents', 'claude,codex'], R);
  if (b.status !== 0) throw new Error(`bootstrap of the fixture failed: ${b.out}`);
  for (const rel of SHIMS) { age(path.join(R, rel)); renameSync(path.join(R, rel), path.join(R, oldOf(rel))); }
  for (const f of ['.claude/settings.json', '.gsd/INSTRUCTIONS.md', 'CLAUDE.md', 'AGENTS.md', '.git/hooks/post-merge']) age(path.join(R, f));
  git(R, 'config', 'merge.gsd-planning.driver', 'gsd-planning-merge %O %A %B %P');
  git(R, 'config', 'gsd-tracker.profile', 'acme');
  git(R, 'config', 'gsd-tracker.statusStart', 'in progress');
  mkexec(path.join(R, 'scripts/gsd-premerge-check.sh'), "#!/bin/sh\n# the team's own checks\nexit 0\n");
  w(path.join(R, 'package.json'), '{"scripts":{"dev":"PORT=$(bash ../../scripts/gsd-derive-port.sh 3000) next dev","repair":"scripts/gsd-planning-repair.sh"}}\n');
  git(R, 'add', '-A'); git(R, 'commit', '-qm', 'gsd setup (0.9.0)');
}
/** The user's Claude settings as the 0.9.0 install wrote them, plus one of theirs. */
function mkuser(): void {
  w(SETTINGS, `{
  "model": "opus",
  "hooks": {
    "PreToolUse": [{"matcher": "Skill", "hooks": [{"type": "command", "command": "[ ! -x '/u/bin/gsd-worktree-guard' ] || exec '/u/bin/gsd-worktree-guard' --global"}]}],
    "SessionStart": [{"hooks": [{"type": "command", "command": "[ ! -x '/u/bin/gsd-rules' ] || exec '/u/bin/gsd-rules' --hook"}, {"type": "command", "command": "echo mine"}]}]
  }
}
`);
}
const sha = (b: Buffer | string): string => createHash('sha1').update(b).digest('hex');
/** cksum of every file under dir */
const sums = (dir: string): string => files(dir).map((f) => `${sha(readFileSync(path.join(dir, f)))} ${f}`).join('\n');
const snap = (R: string): string => [gitOut(ENV, R, ['status', '--porcelain']), gitOut(ENV, R, ['config', '--local', '--list']), read(path.join(R, '.git/hooks/post-merge')), read(SETTINGS)].join('\n--\n');
const countLines = (s: string): number => lf(s).split('\n').filter((l) => l !== '').length;
const sameBytes = (a: string, b: string): boolean => { try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; } };

const R = path.join(WORK, 'proj');
const WT = path.join(WORK, 'proj-wt');
let claudeBefore = '', pmBefore = '';

test('the fixture is a 0.9.0 repo', () => {
  mkold(R); mkuser();
  git(R, 'worktree', 'add', '-q', WT, '-b', 'phase-1-one');
  for (const rel of SHIMS) ok(`fixture: ${oldOf(rel)}`, existsSync(path.join(R, oldOf(rel))));
  fileHas('fixture: old repo hook', path.join(R, '.claude/settings.json'), 'hooks/gsd-worktree-guard.sh');
  fileHas('fixture: old block', path.join(R, 'CLAUDE.md'), '`gsd-rules`');
});

test('dry run: lists everything, changes nothing', () => {
  const before = snap(R);
  let r = g('gsdt-migrate', [], R);
  OUT = r.out;
  is('exit 1 (there is work)', r.status, 1);
  for (const rel of SHIMS) has(`lists ${oldOf(rel)}`, OUT, `${oldOf(rel)} → ${rel}`);
  has('lists the pre-merge script', OUT, 'scripts/gsd-premerge-check.sh → scripts/gsdt-premerge-check.sh');
  has('lists package.json, per line', OUT, 'package.json:1: ');
  has('lists the repo hook', OUT, '.claude/settings.json: hook');
  has('lists .gsd/INSTRUCTIONS.md', OUT, '.gsd/INSTRUCTIONS.md: the gsd-toolkit:canonical block');
  has('lists CLAUDE.md', OUT, 'CLAUDE.md: the gsd-toolkit:provider block');
  has('lists AGENTS.md', OUT, 'AGENTS.md: the gsd-toolkit:provider block');
  has('lists the merge driver', OUT, 'merge.gsd-planning.driver: gsd-planning-merge → gsdt-planning-merge');
  has('lists the tracker section', OUT, 'gsd-tracker → gsdt-tracker (2 key(s))');
  has('lists the post-merge hook', OUT, /post-merge.*gsd-planning-repair → gsdt-planning-repair/);
  has("lists the user's hooks", OUT, 'user-settings.json: the toolkit\'s hooks');
  has('notes the open worktree', OUT, 'open worktree phase-1-one still has the old files');
  has('notes free text', OUT, '.planning/notes.md:1');
  has('…and our own text outside the markers', OUT, 'CLAUDE.md:3');
  has('says how to apply', OUT, 'run: gsdt-migrate --apply');
  is('…and nothing changed', snap(R), before);
  r = g('gsdt-migrate', ['--check'], R);
  is('--check: exit 1', r.status, 1);
  is('--check is quiet', r.out, '');
});

test('the commands refuse an unmigrated repo', () => {
  for (const c of [['gsdt-start', '-n', 'x', '--no-launch'], ['gsdt-flow-next', '1'], ['gsdt-finish', '1'], ['gsdt-init', '--no-launch']]) {
    const r = g(c[0]!, c.slice(1), R, { GSD_SKIP_GUARD: '1' });
    is(`${c[0]} refuses (exit 1), even with GSD_SKIP_GUARD=1`, r.status, 1);
    has('…and names gsdt-migrate', r.out, 'old gsd-* names (before 0.10.0) — run: gsdt-migrate --apply');
  }
  has('…also from the phase worktree (checks the main checkout)', g('gsdt-flow-next', ['1'], WT).out, 'gsdt-migrate --apply');
  has('doctor: T090', g('gsdt-doctor', ['--repo', R, '--quiet'], WORK).out, /old gsd-\* command names.*gsdt-migrate --apply.*T090/);
  const j = g('gsdt-doctor', ['--repo', R, '--json'], WORK);
  let safe: string[] = [];
  try { const d = JSON.parse(j.stdout) as Record<string, string[]>; safe = d.safe_fixes ?? d.safe ?? []; } catch { /* not json: the check below fails with the text */ }
  ok('doctor --json: migrate is a safe fix', safe.includes('migrate'), j.stdout.slice(0, 300));
});

test('--apply', async (t: TestContext) => {
  claudeBefore = read(path.join(R, 'CLAUDE.md'));
  pmBefore = path.join(WORK, 'pm.before');
  writeFileSync(pmBefore, readFileSync(path.join(R, 'scripts/gsd-premerge-check.sh')));
  const planningBefore = sums(path.join(R, '.planning'));
  const r = g('gsdt-migrate', ['--apply'], R);
  OUT = r.out;
  is('exit 0', r.status, 0);
  has('says what to commit', OUT, '✔ migrated to gsdt-* (15 change(s), not committed)');
  hasnt("…no teammates' step (every commit is by t@t)", OUT, 'then each teammate');
  for (const rel of SHIMS) {
    ok(`${rel}: this release's shim, old one gone`, sameBytes(path.join(PKG, 'shims', rel), path.join(R, rel)) && !existsSync(path.join(R, oldOf(rel))), files(path.join(R, 'scripts')).join(' '));
    await t.test(`${rel}: executable`, { skip: POSIX }, () => ok(`${rel}: executable`, isExec(path.join(R, rel))));
  }
  ok('pre-merge script renamed, its content as it was', sameBytes(pmBefore, path.join(R, 'scripts/gsdt-premerge-check.sh')) && !existsSync(path.join(R, 'scripts/gsd-premerge-check.sh')));
  await t.test('pre-merge script: executable', { skip: POSIX }, () => ok('pre-merge script: executable', isExec(path.join(R, 'scripts/gsdt-premerge-check.sh'))));
  is('package.json: exact paths renamed', chomp(read(path.join(R, 'package.json'))), '{"scripts":{"dev":"PORT=$(bash ../../scripts/gsdt-derive-port.sh 3000) next dev","repair":"scripts/gsdt-planning-repair.sh"}}');
  const hook = lf(read(path.join(R, '.claude/settings.json'))).split('\n');
  is('repo hook: one, the new path', `${hook.filter((l) => l.includes('worktree-guard')).length}/${hook.filter((l) => l.includes('hooks/gsdt-worktree-guard.sh')).length}`, '1/1');
  for (const f of ['.gsd/INSTRUCTIONS.md', 'CLAUDE.md', 'AGENTS.md']) {
    // the lines from each gsd-toolkit:<kind>:start marker to its :end marker
    let on = false;
    const blk: string[] = [];
    for (const l of lf(read(path.join(R, f))).split('\n')) {
      if (/<!-- gsd-toolkit:[a-z]+:start -->/.test(l)) on = true;
      if (on) blk.push(l);
      if (/<!-- gsd-toolkit:[a-z]+:end -->/.test(l)) on = false;
    }
    hasnt(`${f}: block has no old name`, blk.join('\n'), /(^|[^/a-z-])gsd-(rules|flow-next|start|finish|init)([^a-z-]|$)/m);
  }
  is('CLAUDE.md: our own text outside the markers kept', lf(read(path.join(R, 'CLAUDE.md'))).split('\n').slice(0, 3).join('\n'), lf(claudeBefore).split('\n').slice(0, 3).join('\n'));
  ok('.planning/ untouched', sums(path.join(R, '.planning')) === planningBefore);
  is('merge driver: the new command', gitOut(ENV, R, ['config', '--get', 'merge.gsd-planning.driver']), 'gsdt-planning-merge %O %A %B %P');
  is('.gitattributes keeps merge=gsd-planning', lf(read(path.join(R, '.gitattributes'))).split('\n').filter((l) => /merge=gsd-planning$/.test(l)).length, 2);
  is('tracker: gsdt-tracker.profile', gitOut(ENV, R, ['config', '--get', 'gsdt-tracker.profile']), 'acme');
  is('…every key moved', gitOut(ENV, R, ['config', '--get', 'gsdt-tracker.statusStart']), 'in progress');
  is('…the old section gone', countLines(gitOut(ENV, R, ['config', '--get-regexp', '^gsd-tracker\\.'])), 0);
  const pm = path.join(R, '.git/hooks/post-merge');
  fileHasnt('post-merge hook: no old name', pm, 'gsd-planning-repair');
  fileHas('…runs gsdt-planning-repair', pm, 'command -v gsdt-planning-repair');
  const us = lf(read(SETTINGS)).split('\n');
  is('user hooks: renamed in place', `${us.filter((l) => l.includes("gsdt-worktree-guard' --global")).length}/${us.filter((l) => l.includes("gsdt-rules' --hook")).length}/${us.filter((l) => l.includes('gsd-worktree-guard') || l.includes('gsd-rules')).length}`, '1/1/0');
  fileHas("…the user's own hook and keys kept", SETTINGS, '"echo mine"');
  fileHas('…the user\'s own keys kept', SETTINGS, '"model": "opus"');
  ok('nothing committed', gitOut(ENV, R, ['log', '-1', '--format=%s']).includes('0.9.0'));
});

test('after: clean, idempotent, the commands run', () => {
  is('--check: exit 0', g('gsdt-migrate', ['--check'], R).status, 0);
  const r = g('gsdt-migrate', ['--apply'], R);
  is('second --apply: exit 0', r.status, 0);
  has('…changes nothing', r.out, 'nothing to migrate');
  is('dry run: exit 0', g('gsdt-migrate', [], R).status, 0);
  hasnt('gsdt-flow-next no longer refuses', g('gsdt-flow-next', ['1'], R, { GSD_SKIP_GUARD: '1' }).out, 'gsdt-migrate');
  hasnt('gsdt-start no longer refuses', g('gsdt-start', ['-n', 'x', '--no-launch'], R).out, 'gsdt-migrate');
  OUT = g('gsdt-doctor', ['--repo', R, '--quiet'], WORK).out;
  hasnt('doctor: no T090', OUT, 'T090');
  hasnt('doctor: no T010 (shims current)', OUT, 'T010');
  hasnt('doctor: no T013/T014 (driver, hook)', OUT, /T01[34]/);
  hasnt('doctor: no T016 (blocks current)', OUT, 'T016');
});

test('the open worktree still merges .planning with the driver', () => {
  git(R, 'add', '-A'); git(R, 'commit', '-qm', 'Switch to gsdt-* toolkit commands');
  add(path.join(R, '.planning/ROADMAP.md'), '\n### Phase 2: Two\n');
  git(R, 'commit', '-qam', 'main: phase 2');
  add(path.join(WT, '.planning/ROADMAP.md'), '\n### Phase 3: Three\n');
  git(WT, 'commit', '-qam', 'branch: phase 3');
  const attr = gitOut(ENV, WT, ['check-attr', 'merge', '.planning/ROADMAP.md']);
  is('the branch still says merge=gsd-planning', attr.slice(attr.lastIndexOf(': ') + 2), 'gsd-planning');
  const m = run(ENV, 'git', ['merge', '-q', '--no-edit', 'main'], { cwd: WT });
  is('merging main into it: no conflict', m.status, 0);
  const rm = lf(read(path.join(WT, '.planning/ROADMAP.md')));
  ok('…both phases kept (the driver ran)', rm.includes('Phase 2: Two') && rm.includes('Phase 3: Three'), rm);
  for (const rel of SHIMS) ok(`worktree took the new shim: ${rel}`, existsSync(path.join(WT, rel)) && !existsSync(path.join(WT, oldOf(rel))));
});

test('what it leaves to you', () => {
  const R2 = path.join(WORK, 'proj2');
  mkold(R2);
  const dp = path.join(R2, 'scripts/gsd-derive-port.sh');
  add(dp, '# my own change\n');
  const ls = lf(read(dp)).split('\n'); ls[1] = '# our derive-port, changed'; writeFileSync(dp, ls.join('\n'));
  w(path.join(R2, 'scripts/gsdt-premerge-check.sh'), '#!/bin/sh\nexit 0\n');
  const r = g('gsdt-migrate', ['--apply'], R2);
  is('an edited shim / two pre-merge scripts: exit 1', r.status, 1);
  has('…the edited shim is named', r.out, 'scripts/gsd-derive-port.sh: not the toolkit\'s shim');
  has('…both pre-merge scripts are named', r.out, 'both scripts/gsd-premerge-check.sh and scripts/gsdt-premerge-check.sh exist');
  ok('…the edited shim is left alone', existsSync(dp) && !existsSync(path.join(R2, 'scripts/gsdt-derive-port.sh')));
  ok('…both pre-merge scripts left', existsSync(path.join(R2, 'scripts/gsd-premerge-check.sh')));
  ok('…the other shims moved', existsSync(path.join(R2, 'scripts/gsdt-new-worktree-feature.sh')) && !existsSync(path.join(R2, 'scripts/gsd-new-worktree-feature.sh')));
  is('--check still exit 1', g('gsdt-migrate', ['--check'], R2).status, 1);
});

test('doctor --fix runs it', () => {
  const R3 = path.join(WORK, 'proj3');
  mkold(R3);
  const r = g('gsdt-doctor', ['--repo', R3, '--fix', '--yes'], WORK);
  has('--fix lists it', r.out, 'gsdt-migrate --apply');
  is('…and the repo is migrated', g('gsdt-migrate', ['--check'], R3).status, 0);
});

const R5 = path.join(WORK, 'proj5');
test('--commit: exactly the repo files this run changed, nothing else, no push', () => {
  rmSync(SETTINGS, { force: true });          // no user settings: step 7 has nothing to say
  mkold(R5);
  const origin = path.join(WORK, 'origin5.git');
  gitOk(ENV, WORK, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(R5, 'remote', 'add', 'origin', origin); git(R5, 'push', '-q', 'origin', 'main');
  const originBefore = gitOut(ENV, origin, ['rev-parse', 'main']);
  w(path.join(R5, 'unrelated-staged.txt'), 'mine\n'); git(R5, 'add', 'unrelated-staged.txt');
  add(path.join(R5, '.planning/notes.md'), '\n# my note\n');       // unstaged edit to a tracked file
  w(path.join(R5, 'untracked.txt'), 'scratch\n');
  const r = g('gsdt-migrate', ['--apply', '--commit'], R5);
  OUT = r.out;
  is('exit 0', r.status, 0);
  has('says committed', OUT, '(14 change(s), committed)');
  has('prints the short hash', OUT, /^commit [0-9a-f]{7,}: Switch to gsdt-\* toolkit commands/m);
  has('prints the push hint (only a hint)', OUT, `push when ready: git -C '${gp(R5)}' push`);
  hasnt("no teammates' line (every commit is by t@t)", OUT, 'then each teammate');
  has('lists the files first, git-style', OUT, /^files to commit \(17\):$/m);
  has('…a deletion', OUT, /^ {2}D scripts\/gsd-premerge-check\.sh$/m);
  has('…an add', OUT, /^ {2}A scripts\/gsdt-premerge-check\.sh$/m);
  has('…a modify', OUT, /^ {2}M package\.json$/m);
  has('…the commit line counts files', OUT, '(17 files)');
  hasnt('no old add -A hint', OUT, 'add -A &&');
  hasnt("no empty 'your Claude settings:' heading", OUT, 'your Claude settings');
  const show = lf(gitOk(ENV, R5, ['show', '--no-renames', '--name-status', '--format=%s', 'HEAD'])).split('\n');
  is('the commit message', show[0], 'Switch to gsdt-* toolkit commands');
  const exp = [
    ...SHIMS.flatMap((rel) => [`A\t${rel}`, `D\t${oldOf(rel)}`]),
    'A\tscripts/gsdt-premerge-check.sh', 'D\tscripts/gsd-premerge-check.sh',
    'M\tpackage.json', 'M\t.claude/settings.json', 'M\t.gsd/INSTRUCTIONS.md', 'M\tCLAUDE.md', 'M\tAGENTS.md',
  ].sort();
  const got = show.slice(1).filter((l) => l !== '').sort();
  is('the commit holds exactly the changed repo files (adds, deletions, edits)', got.join('\n'), exp.join('\n'));
  is('…17 files, no .git/config or hook involved', `${got.length}/${got.filter((l) => /^.\s\.git/.test(l)).length}`, '17/0');
  is('an unrelated staged file stays staged, uncommitted', gitOut(ENV, R5, ['diff', '--cached', '--name-only']), 'unrelated-staged.txt');
  is('an unrelated unstaged edit stays unstaged', gitOut(ENV, R5, ['diff', '--name-only']), '.planning/notes.md');
  is('an untracked file stays untracked', gitOut(ENV, R5, ['ls-files', '--others', '--exclude-standard']), 'untracked.txt');
  is('nothing was pushed: origin is where it was', gitOut(ENV, origin, ['rev-parse', 'main']), originBefore);
  is("this clone's config was changed too (not by the commit)", gitOut(ENV, R5, ['config', '--get', 'merge.gsd-planning.driver']), 'gsdt-planning-merge %O %A %B %P');
});

test('--commit is refused without --apply', () => {
  for (const a of [['--commit'], ['--commit', '--check'], ['--apply', '--check', '--commit']]) {
    const r = g('gsdt-migrate', a, R5);
    is(`gsdt-migrate ${a.join(' ')}: usage error`, r.status, 2);
    has('…says it needs --apply', r.out, '--commit only works with --apply');
  }
});

test('no terminal, no --commit: nothing committed, the path-limited command is printed', () => {
  const R6 = path.join(WORK, 'proj6');
  mkold(R6);
  const head6 = gitOut(ENV, R6, ['rev-parse', 'HEAD']);
  const r = g('gsdt-migrate', ['--apply'], R6);   // stdin is empty, not a terminal
  OUT = r.out;
  is('exit 0', r.status, 0);
  has('says not committed', OUT, '(14 change(s), not committed)');
  is('HEAD did not move', gitOut(ENV, R6, ['rev-parse', 'HEAD']), head6);
  has('prints add -- <paths> for exactly those paths', OUT, new RegExp(`^to commit by hand: {2}git -C '${esc(gp(R6))}' add -A -- scripts/gsd-new-worktree-feature\\.sh scripts/gsdt-new-worktree-feature\\.sh `, 'm'));
  has('…and the commit limited to the same paths', OUT, new RegExp(`&& git -C '${esc(gp(R6))}' commit -m 'Switch to gsdt-\\* toolkit commands' -- scripts/gsd-new-worktree-feature\\.sh `));
  hasnt('…never the whole tree (no bare add -A)', OUT, /add -A &&|add -A$/m);
  hasnt('no prompt', OUT, '[y/N]');
  // the printed command works as printed
  const cmd = lf(OUT).split('\n').filter((l) => l.startsWith('to commit by hand:  ')).map((l) => l.slice('to commit by hand:  '.length))[0] ?? '';
  run(ENV, 'bash', ['-c', cmd], { cwd: WORK });
  is('…and running it commits them', gitOut(ENV, R6, ['log', '-1', '--format=%s']), 'Switch to gsdt-* toolkit commands');
});

test('--commit with a file that was dirty before: no commit, the file is listed', () => {
  const R7 = path.join(WORK, 'proj7');
  mkold(R7);
  const head7 = gitOut(ENV, R7, ['rev-parse', 'HEAD']);
  add(path.join(R7, 'scripts/gsd-derive-port.sh'), '# changed by hand\n');
  let r = g('gsdt-migrate', ['--apply', '--commit'], R7);
  is('exit 0 (the migration itself worked)', r.status, 0);
  has('says not committed', r.out, 'not committed');
  has('says why', r.out, 'had uncommitted changes before the migration');
  has('lists the file', r.out, /^ {2}scripts\/gsd-derive-port\.sh$/m);
  has('prints the command to commit by hand', r.out, new RegExp(`^to commit by hand: {2}git -C '${esc(gp(R7))}' add -A -- `, 'm'));
  is('HEAD did not move', gitOut(ENV, R7, ['rev-parse', 'HEAD']), head7);
  const R7b = path.join(WORK, 'proj7b');
  mkold(R7b);
  const head7b = gitOut(ENV, R7b, ['rev-parse', 'HEAD']);
  w(path.join(R7b, 'scripts/gsdt-derive-port.sh'), 'untracked, in our way\n');   // untracked, and a path we write
  r = g('gsdt-migrate', ['--apply', '--commit'], R7b);
  has('an untracked file at a path we write counts as dirty', r.out, /^ {2}scripts\/gsdt-derive-port\.sh$/m);
  is('…no commit', gitOut(ENV, R7b, ['rev-parse', 'HEAD']), head7b);
});

test('--commit when the main checkout is not on the base branch: no commit', () => {
  const R8 = path.join(WORK, 'proj8');
  mkold(R8);
  git(R8, 'checkout', '-q', '-b', 'side');
  const head8 = gitOut(ENV, R8, ['rev-parse', 'HEAD']);
  const r = g('gsdt-migrate', ['--apply', '--commit'], R8);
  is('exit 0', r.status, 0);
  has('says why', r.out, "not committing: this checkout is on 'side', not the base branch 'main'");
  has('prints the command', r.out, new RegExp(`^to commit by hand: {2}git -C '${esc(gp(R8))}' add -A -- `, 'm'));
  is('HEAD did not move', gitOut(ENV, R8, ['rev-parse', 'HEAD']), head8);
});

test("--commit when the commit fails (a pre-commit hook says no): git's error, the command, exit 1", () => {
  const R9 = path.join(WORK, 'proj9');
  mkold(R9);
  const head9 = gitOut(ENV, R9, ['rev-parse', 'HEAD']);
  mkexec(path.join(R9, '.git/hooks/pre-commit'), '#!/bin/sh\necho "hook says no" >&2\nexit 1\n');
  const r = g('gsdt-migrate', ['--apply', '--commit'], R9);
  is('exit 1', r.status, 1);
  has("prints git's error", r.out, 'hook says no');
  has('says not committed', r.out, 'not committed');
  has('prints the command', r.out, new RegExp(`^to commit by hand: {2}git -C '${esc(gp(R9))}' add -A -- `, 'm'));
  is('HEAD did not move', gitOut(ENV, R9, ['rev-parse', 'HEAD']), head9);
});

test("the 'your Claude settings:' heading comes only with a line under it", () => {
  const R10 = path.join(WORK, 'proj10');
  mkold(R10); mkuser();
  has('a dry run with an old user hook: heading + its line', g('gsdt-migrate', [], R10).out, /^your Claude settings:$/m);
  rmSync(SETTINGS, { force: true });
  hasnt('…and without one: no heading', g('gsdt-migrate', [], R10).out, 'your Claude settings');
});

let r11out = '';
test("one --apply is enough: the renamed pre-merge script's own old paths", async (t: TestContext) => {
  const R11 = path.join(WORK, 'proj11');
  initRepo(ENV, R11, 'main');
  w(path.join(R11, '.gsd.conf'), 'providers = claude\n');
  mkexec(path.join(R11, 'scripts/gsd-premerge-check.sh'), '#!/bin/sh\n# scripts/gsd-premerge-check.sh: run before the merge\n# try it: bash scripts/gsd-premerge-check.sh\nexit 0\n');
  git(R11, 'add', '-A'); git(R11, 'commit', '-qm', 'init');
  const r = g('gsdt-migrate', ['--apply'], R11);
  is('--apply: exit 0', r.status, 0);
  r11out = r.out;
  has("…lists the renamed script's references", r.out, /^ {2}scripts\/gsdt-premerge-check\.sh:2: /m);
  const nf = path.join(R11, 'scripts/gsdt-premerge-check.sh');
  fileHasnt('…no old path left in it', nf, 'scripts/gsd-premerge-check');
  fileHas('…its other text kept', nf, /^# try it: bash scripts\/gsdt-premerge-check\.sh$/m);
  await t.test('…still executable', { skip: POSIX }, () => ok('…still executable', isExec(nf)));
  is('…then --check exits 0', g('gsdt-migrate', ['--check'], R11).status, 0);
  has('…and a dry run finds nothing', g('gsdt-migrate', [], R11).out, 'nothing to migrate');
  // the renamed script, left untracked by an earlier run of an older release, with its old paths
  const R12 = path.join(WORK, 'proj12');
  initRepo(ENV, R12, 'main');
  w(path.join(R12, '.gsd.conf'), 'providers = claude\n');
  git(R12, 'add', '-A'); git(R12, 'commit', '-qm', 'init');
  w(path.join(R12, 'scripts/gsdt-premerge-check.sh'), '#!/bin/sh\n# scripts/gsd-premerge-check.sh\nexit 0\n');
  is('an untracked renamed script with old paths: --check exits 1', g('gsdt-migrate', ['--check'], R12).status, 1);
});

test('a step heading comes only with a line under it', () => {
  // the --apply of the first case above changed only the shims and references steps
  has('the steps with changes are there', r11out, /^references:$/m);
  for (const h of ['repo hook:', 'instruction blocks:', 'this clone (.git/config):', 'your Claude settings:']) {
    hasnt(`no empty '${h}'`, r11out, new RegExp(`^${esc(h)}$`, 'm'));
  }
});

test("the teammates' line: only when HEAD has another author", () => {
  const R13 = path.join(WORK, 'proj13');
  initRepo(ENV, R13, 'main');
  w(path.join(R13, '.gsd.conf'), 'providers = claude\n');
  w(path.join(R13, 'scripts/gsd-premerge-check.sh'), '#!/bin/sh\nexit 0\n');
  git(R13, 'add', '-A'); git(R13, 'commit', '-qm', 'init');
  const c = run(ENV, 'git', ['commit', '-q', '--allow-empty', '-m', "a teammate's commit"], { cwd: R13, env: { GIT_AUTHOR_EMAIL: 'mate@x' } });
  is('a teammate commits', c.status, 0);
  has('another author: the line is there', g('gsdt-migrate', ['--apply'], R13).out, /^then each teammate: gsdt-update, then gsdt-migrate --apply in their clone$/m);
});

const OLDTAG = spawnSync('git', ['-C', PKG, 'rev-parse', '-q', '--verify', 'v0.9.0^{commit}'], { encoding: 'utf8' }).status === 0;
if (!OLDTAG && process.env.CI) {
  test('a repo bootstrapped by the real 0.9.0', () => { ok('the real 0.9.0 needs the v0.9.0 tag (checkout with fetch-depth: 0)', false); });
} else {
  test('a repo bootstrapped by the real 0.9.0', { skip: OLDTAG ? false : 'no v0.9.0 tag here (git fetch --tags)' }, () => {
    const OLD = path.join(WORK, 'src-090');
    mkdirSync(OLD, { recursive: true });
    const tarball = path.join(WORK, 'v090.tar');
    gitOk(ENV, PKG, ['archive', '--format=tar', '-o', tarball, 'v0.9.0']);
    const x = spawnSync('tar', ['-xf', 'v090.tar', '-C', 'src-090'], { cwd: WORK, encoding: 'utf8' }); // relative: GNU tar reads `D:\\…` as a remote host;
    is('the 0.9.0 sources unpack', x.status, 0);
    const R4 = path.join(WORK, 'proj4');
    initRepo(ENV, R4, 'main');
    w(path.join(R4, '.planning/ROADMAP.md'), '# Roadmap\n');
    git(R4, 'add', '-A'); git(R4, 'commit', '-qm', 'init');
    const fwd = (p: string): string => p.replace(/\\/g, '/');
    const b = run(ENV, 'bash', [fwd(path.join(OLD, 'bin/gsd-bootstrap-repo')), '--agents', 'claude,codex'], { cwd: R4, env: { PATH: `${path.join(OLD, 'bin')}${path.delimiter}${ENV.PATH}` } });
    is('the real 0.9.0 bootstrap ran', b.status, 0);
    git(R4, 'add', '-A'); git(R4, 'commit', '-qm', '0.9.0 setup');
    is('--apply: exit 0', g('gsdt-migrate', ['--apply'], R4).status, 0);
    is('…then --check clean', g('gsdt-migrate', ['--check'], R4).status, 0);
    // This repo names claude + codex as providers. Doctor's T057 wants their executables, which CI does not have:
    // put stand-ins on PATH for this call only, so the check below still sees every other T05x finding.
    const AG = path.join(WORK, 'agents');
    for (const a of ['claude', 'codex']) stubSh(AG, a, '#!/bin/sh\nexit 0\n');
    const d = g('gsdt-doctor', ['--repo', R4, '--quiet'], WORK, { PATH: `${AG}${path.delimiter}${ENV.PATH}` });
    hasnt('…and doctor reports no shim, block or setup finding', d.out, /T01[0-6]|T090|T05[2-8]/);
  });
}
