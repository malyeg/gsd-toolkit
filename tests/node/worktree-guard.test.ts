// The guard's phase-flow rule (`flow = strict`) and its other rules.
//
// Builds a throwaway repo with a phase worktree branch checked out, feeds the guard the
// PreToolUse(Skill) payload Claude Code sends, and asserts exit codes: 0 = allowed, 2 = blocked.
// The rule is opt-in, so the first section proves a repo WITHOUT `flow = strict` is untouched.
// Port of tests/test-worktree-guard.sh. Run: node --test tests/node/worktree-guard.test.ts
import assert from 'node:assert/strict';
import { accessSync, appendFileSync, constants, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PKG, WIN, env, git, gsdt, run, tmp, touch, write } from './g1-helpers.ts';
import { uiFixApproval, uiFixCheck, uiFixLook } from './ui-fixture.ts';
import type { Run } from './g1-helpers.ts';

let REPO = '';
let PDIR = '';
let lastErr = '';

type Extra = Record<string, string | undefined>;

/** The guard, as Claude's hook runs it (through the launcher). */
function guardRun(args: string[], input: string, e: Extra = {}): Run {
  const r = gsdt('worktree-guard', args, { input, env: e });
  lastErr = r.stderr;
  return r;
}
/** guard <skill> <args> → exit code, with the repo hook's payload. */
function guard(skill: string, args: string, e: Extra = {}): number {
  const payload = JSON.stringify({ tool_name: 'Skill', tool_input: { skill, args } });
  return guardRun([], payload, { CLAUDE_PROJECT_DIR: REPO, ...e }).status;
}
function allowed(label: string, skill: string, args: string, e: Extra = {}): void {
  const rc = guard(skill, args, e);
  assert.equal(rc, 0, `${label}: exit ${rc}: ${lastErr}`);
}
function blocked(label: string, skill: string, args: string, e: Extra = {}): void {
  const rc = guard(skill, args, e);
  assert.equal(rc, 2, `${label}: expected block (2), got ${rc}`);
}

// A repo on a phase-7 branch with an empty phase dir. `install = none` keeps rule 3 (deps installed)
// out of the picture.
function mkrepo(flow: string, branch: string, phaseDir: string): void {
  REPO = tmp('guard');
  git(REPO, 'init', '-q', '-b', 'develop');
  git(REPO, 'commit', '-q', '--allow-empty', '-m', 'init');
  write(path.join(REPO, '.gsd.conf'), `base = develop\ninstall = none\n${flow !== '' ? `flow = ${flow}\n` : ''}`);
  git(REPO, 'checkout', '-q', '-b', branch);
  PDIR = path.join(REPO, '.planning', 'phases', phaseDir);
  mkdirSync(PDIR, { recursive: true });
}
const rm = (...fs: string[]): void => {
  for (const f of fs) rmSync(f, { force: true });
};

test('flow unset — the rule is opt-in, nothing is blocked', () => {
  mkrepo('', 'phase-7-thing', '07-thing');
  allowed('plan-phase without CONTEXT passes', 'gsd-plan-phase', '7');
  allowed('execute-phase without REVIEWS passes', 'gsd-execute-phase', '7');
  allowed('secure-phase without REVIEW passes', 'gsd-secure-phase', '7');
});

test('flow = strict — plan-phase needs discuss', () => {
  mkrepo('strict', 'phase-7-thing', '07-thing');
  blocked('plan-phase without CONTEXT is blocked', 'gsd-plan-phase', '7');
  allowed('plan-phase --prd skips discuss', 'gsd-plan-phase', '7 --prd docs/x.md');
  touch(path.join(PDIR, '07-CONTEXT.md'));
  allowed('plan-phase with CONTEXT passes', 'gsd-plan-phase', '7');
  allowed('a number inside a path is not the phase', 'gsd-plan-phase', '--files src/v2/a.ts');
  blocked('…but a real other phase number still is', 'gsd-plan-phase', '2 --files src/v7/a.ts');
  allowed('discuss-phase itself is never gated', 'gsd-discuss-phase', '7');
});

test('flow = strict — execute-phase needs the cross-AI review', () => {
  // continues on the repo of the previous section (REPO / PDIR carry over)
  blocked('execute without REVIEWS is blocked', 'gsd-execute-phase', '7');
  allowed('execute --gaps-only skips it', 'gsd-execute-phase', '7 --gaps-only');
  const rev = path.join(PDIR, '07-REVIEWS.md');
  write(rev, '## Codex Review\n\nCodex review failed or returned empty output.\n');
  blocked('execute with a failed Codex review is blocked', 'gsd-execute-phase', '7');
  write(rev, '## Codex Review\n\n');
  blocked('execute with an empty Codex section is blocked', 'gsd-execute-phase', '7');
  write(rev, '## Codex Review\n\n## 07-01\nfinding\n\n---\n\n## Consensus Summary\n\nok\n');
  allowed('execute with ## plan sections in the review passes', 'gsd-execute-phase', '7');
  write(rev, '');
  allowed('execute with REVIEWS passes', 'gsd-execute-phase', '7');
});

test('flow = strict — secure-phase is the last gate', () => {
  blocked('secure without REVIEW is blocked', 'gsd-secure-phase', '7');
  touch(path.join(PDIR, '07-REVIEW.md'));
  blocked('secure without the test audit is blocked', 'gsd-secure-phase', '7');
  const val = path.join(PDIR, '07-VALIDATION.md');
  write(val, '---\nnyquist_compliant: false\n---\n');
  blocked("secure with the plan's draft VALIDATION is blocked", 'gsd-secure-phase', '7');
  const cfg = path.join(REPO, '.planning', 'config.json');
  write(cfg, '{"workflow":{"nyquist_validation":false}}');
  allowed('secure with nyquist_validation off passes', 'gsd-secure-phase', '7');
  rm(cfg);
  write(val, '---\nnyquist_compliant: true\n---\n');
  allowed('secure with REVIEW + audit, no screens, passes', 'gsd-secure-phase', '7');
  allowed('validate-phase itself is never gated', 'gsd-validate-phase', '7');
  touch(path.join(PDIR, '07-UI-SPEC.md'));
  blocked('secure with UI-SPEC but no UI-REVIEW is blocked', 'gsd-secure-phase', '7');
  touch(path.join(PDIR, '07-UI-REVIEW.md'));
  allowed('secure with UI-REVIEW passes', 'gsd-secure-phase', '7');
});

test('flow = strict — decimal phases and fresh claims', () => {
  mkrepo('strict', 'phase-7.1-fix', '7.1-fix');
  blocked('7.1 plan-phase without CONTEXT is blocked', 'gsd-plan-phase', '7.1');
  touch(path.join(PDIR, '7.1-CONTEXT.md'));
  allowed('7.1 plan-phase with CONTEXT passes', 'gsd-plan-phase', '7.1');
  mkrepo('strict', 'phase-8-new', '08-new');
  rmSync(PDIR, { recursive: true });
  blocked('missing phase dir cannot bypass discuss gate', 'gsd-plan-phase', '8');
  allowed('fresh phase can still discuss', 'gsd-discuss-phase', '8');
  allowed('GSD_SKIP_GUARD=1 bypasses', 'gsd-plan-phase', '8', { GSD_SKIP_GUARD: '1' });
  blocked('GSD_SKIP_GUARD=0 does not bypass', 'gsd-plan-phase', '8', { GSD_SKIP_GUARD: '0' });
});

test('flow = strict — zero-padded phase numbers (08/09 are not octal)', () => {
  mkrepo('strict', 'phase-8-pad', '08-pad');
  touch(path.join(PDIR, '08-CONTEXT.md'));
  allowed('plan-phase 08 in phase-8 worktree passes', 'gsd-plan-phase', '08');
  allowed('plan-phase 8 finds the 08-* dir', 'gsd-plan-phase', '8');
  mkrepo('strict', 'phase-09-legacy', '09-legacy');
  touch(path.join(PDIR, '09-CONTEXT.md'));
  allowed('phase from a phase-09-* branch pads correctly', 'gsd-plan-phase', '');
});

test('flow = strict — gsd-core decimal inserts are zero-padded (02.1)', () => {
  mkrepo('strict', 'phase-02.1-hotfix', '02.1-hotfix');
  blocked('02.1 plan-phase without CONTEXT is blocked', 'gsd-plan-phase', '02.1');
  touch(path.join(PDIR, '02.1-CONTEXT.md'));
  allowed('02.1 plan-phase with CONTEXT passes', 'gsd-plan-phase', '02.1');
  allowed('2.1 names the same phase as 02.1', 'gsd-plan-phase', '2.1');
  allowed('phase taken from a phase-02.1-* branch', 'gsd-discuss-phase', '');
  blocked('02.2 is still another phase', 'gsd-plan-phase', '02.2');
});

test('flow = strict — policy comes from the MAIN checkout, not the worktree copy', () => {
  mkrepo('', 'phase-7-thing', '07-thing'); // branch carries NO flow key
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '-q', '-m', 'wt');
  const MAIN = REPO;
  const WT = path.join(tmp('wt'), 'wt');
  git(MAIN, 'checkout', '-q', 'develop');
  appendFileSync(path.join(MAIN, '.gsd.conf'), 'flow = strict\n'); // main turns it on later
  git(MAIN, 'worktree', 'add', '-q', WT, 'phase-7-thing');
  REPO = WT;
  PDIR = path.join(WT, '.planning', 'phases', '07-thing');
  mkdirSync(PDIR, { recursive: true });
  blocked('old worktree (no flow key in its .gsd.conf) is still gated', 'gsd-plan-phase', '7');
});

test('flow = strict — the older rules still fire first', () => {
  mkrepo('strict', 'phase-7-thing', '07-thing');
  blocked('wrong phase worktree is still blocked', 'gsd-plan-phase', '9');
});

test('install completion never bypasses strict gates', () => {
  write(path.join(REPO, '.gsd.conf'), 'base = develop\nflow = strict\ninstall = npm install\n');
  const status = path.join(REPO, '.gsd-install.status');
  write(status, 'ok\n');
  blocked('install ok still requires review', 'gsd-execute-phase', '7');
  touch(path.join(PDIR, '07-REVIEWS.md'));
  allowed('install ok and review permit execution', 'gsd-execute-phase', '7');
  mkdirSync(path.join(REPO, 'node_modules'), { recursive: true });
  write(status, 'running\n');
  blocked('partial node_modules cannot bypass running install', 'gsd-execute-phase', '7');
  write(status, 'fail\n');
  blocked('node_modules cannot bypass failed install', 'gsd-execute-phase', '7');
  write(status, 'ok\n');
  blocked('review in wrong phase is blocked', 'gsd-review', '--phase 9 --codex');
  blocked('flow in wrong phase is blocked', 'gsd-flow', '9');
  blocked('…by its skill name gsdt-flow too', 'gsdt-flow', '9');
  blocked('…and by its pre-0.8.0 name gsdw-flow', 'gsdw-flow', '9');
  blocked('a plugin-namespaced skill (gsd-core:gsd-review) is guarded', 'gsd-core:gsd-review', '--phase 9 --codex');
  blocked('omitted phase still enforces discuss gate', 'gsd-plan-phase', '');
  git(REPO, 'checkout', '-q', '-b', 'agent-untrusted');
  blocked('agent branch name alone is not an exemption', 'gsd-execute-phase', '7');
});

test('nested workers retain phase checks', () => {
  git(REPO, 'checkout', '-q', 'phase-7-thing');
  git(REPO, 'add', '.');
  git(REPO, 'commit', '-qm', 'artifacts');
  const PARENT = REPO;
  const NESTED = path.join(PARENT, '.claude', 'worktrees', 'worker');
  git(PARENT, 'worktree', 'add', '-q', '-b', 'agent-nested', NESTED);
  REPO = NESTED;
  PDIR = path.join(REPO, '.planning', 'phases', '07-thing');
  allowed('nested worker in same repository inherits phase', 'gsd-execute-phase', '7');
  blocked('nested worker cannot target another phase', 'gsd-execute-phase', '9');
  rm(path.join(PDIR, '07-REVIEWS.md'));
  blocked('nested worker still requires strict review', 'gsd-execute-phase', '7');
});

test('ui_gates — warn (default) never blocks', () => {
  mkrepo('', 'phase-5-shop', '05-shop');
  allowed('ui-phase without DESIGN/LAYOUT passes', 'gsd-ui-phase', '5');
  allowed('ui-review without SHOTS passes', 'gsd-ui-review', '5');
});

test('ui_gates = strict — ui-phase needs the design system and a chosen layout', () => {
  appendFileSync(path.join(REPO, '.gsd.conf'), 'ui_gates = strict\n');
  blocked('no DESIGN.md → blocked', 'gsd-ui-phase', '5');
  assert.ok(lastErr.includes('DESIGN.md'), `…the message names DESIGN.md: ${lastErr}`);
  const design = path.join(REPO, '.planning', 'design', 'DESIGN.md');
  write(design, '# Design\n<!-- gsd:design-stub -->\n');
  blocked('stub DESIGN.md → blocked', 'gsd-ui-phase', '5');
  write(design, '# Design\ntokens\n');
  blocked('filled DESIGN.md, no LAYOUT → blocked', 'gsd-ui-phase', '5');
  write(path.join(PDIR, '05-LAYOUT.md'), 'sketch: .planning/sketches/001-shop\npages: /\n');
  const readme = path.join(REPO, '.planning', 'sketches', '001-shop', 'README.md');
  write(readme, '---\nwinner: null\n---\n');
  blocked('sketch without a winner → blocked', 'gsd-ui-phase', '5');
  write(readme, '---\nwinner: A\n---\n');
  allowed('design + chosen sketch + pages → allowed', 'gsd-ui-phase', '5');
  write(path.join(PDIR, '05-LAYOUT.md'), 'sketch: skip one button\n');
  allowed('sketch: skip <reason> → allowed', 'gsd-ui-phase', '5');
});

test('ui_gates = strict — ui-review needs the check, the look and the approval', () => {
  const blockedWhy = (label: string, text: string): void => {
    const r = gsdt('worktree-guard', ['--command', 'gsd-ui-review', '--phase', '5', '--repo', REPO]);
    assert.ok(r.status === 2 && r.out.includes(text), `${label}: exit ${r.status}: ${r.out}`);
  };
  blockedWhy('no UI-CHECK.md → blocked, run gsdt-ui check', 'Run: gsdt-ui check 5');
  write(path.join(PDIR, '05-SHOTS.md'), 'taken: now\n');
  blockedWhy('0.3.x SHOTS.md alone → still blocked', 'never checked');
  rm(path.join(PDIR, '05-SHOTS.md'));
  uiFixCheck(PDIR, '05', 'failed');
  blockedWhy('a failed check → blocked', 'the check found 2 problem');
  uiFixCheck(PDIR, '05', 'passed', 'cap1', '0000000000000000000000000000000000000000');
  blockedWhy('code changed after the check → blocked', 'the code or 05-LAYOUT.md changed after the last check');
  uiFixCheck(PDIR, '05', 'passed');
  blockedWhy('check passed, no look → blocked', 'Run: gsdt-ui look 5');
  uiFixLook(PDIR, '05', 'cap1', 'ok', 'R1 R2');
  blockedWhy('a look with rules deleted → blocked', 'lines without an answer');
  uiFixLook(PDIR, '05');
  blockedWhy('look complete, no approval → blocked', 'the user has not approved');
  uiFixApproval(PDIR, '05', 'cap0');
  blockedWhy('an approval of older pictures → blocked', 'approved older pictures');
  uiFixApproval(PDIR, '05');
  allowed('check + look + approval → allowed', 'gsd-ui-review', '5');
  write(path.join(PDIR, '05-UI-CHECK.md'), '---\nstatus: skipped\nskipped: no browser here\n---\n');
  blockedWhy('a skipped check needs a waived approval', 'approved older pictures');
  write(path.join(PDIR, '05-UI-APPROVAL.md'), '---\nstatus: waived\nreason: no browser here\n---\n');
  allowed('skipped check + waived approval → allowed', 'gsd-ui-review', '5');
  allowed('other commands are not UI-gated', 'gsd-plan-phase', '5');
  rm(path.join(PDIR, '05-UI-CHECK.md'), path.join(PDIR, '05-UI-LOOK.md'), path.join(PDIR, '05-UI-APPROVAL.md'));
  const r = gsdt('worktree-guard', ['--command', 'gsd-ui-review', '--phase', '5', '--repo', REPO], { env: { GSD_SKIP_GUARD: '1' } });
  assert.equal(r.status, 0, 'GSD_SKIP_GUARD=1 still escapes');
});

// ── rule 0 ───────────────────────────────────────────────────────────────────
// gg <payload> [extra guard args] → exit code; no project dir in the env, so the payload's cwd
// decides, as in a user hook
const gg = (payload: string, ...extra: string[]): number => guardRun(['--global', ...extra], payload).status;
const gis = (label: string, got: number, want: number): void => assert.equal(got, want, `${label}: expected ${want}, got ${got}: ${lastErr}`);
const upe = (cmd: string, cwd: string): string =>
  JSON.stringify({ hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command', command_name: cmd, command_args: '', cwd, prompt: `/${cmd}` });
const skl = (skill: string, cwd: string): string => JSON.stringify({ tool_name: 'Skill', tool_input: { skill, args: '' }, cwd });
const BARE = tmp('bare');
git(BARE, 'init', '-q', '-b', 'main');

/** A PATH that holds only these tools (symlinks to the real ones), where symlinks exist. */
function pathWith(tools: string[]): string {
  const dir = tmp('toolpath');
  const where = (c: string): string | null => {
    for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
      const p = path.join(d, c);
      try {
        accessSync(p, constants.X_OK);
        return p;
      } catch {
        // not in this dir
      }
    }
    return null;
  };
  for (const c of tools) {
    const p = c === 'node' ? process.execPath : where(c);
    if (p) symlinkSync(p, path.join(dir, c));
  }
  return dir;
}
/** The bash launcher (bin/gsdt-worktree-guard) with an exact PATH: the hook's own entry on POSIX. */
function guardBin(args: string[], input: string, pathVar: string, e: Extra = {}): Run {
  const r = run(path.join(PKG, 'bin', 'gsdt-worktree-guard'), args, { input, fullEnv: { ...env(e), PATH: pathVar } });
  lastErr = r.stderr;
  return r;
}

test('rule 0 — /gsd-new-project only after gsdt-init (--global = the user-level hook)', () => {
  gis('typed /gsd-new-project in a repo without .gsd.conf → blocked', gg(upe('gsd-new-project', BARE)), 2);
  assert.ok(lastErr.includes('Run gsdt-init'), `…and says to run gsdt-init: ${lastErr}`);
  gis('the namespaced /gsd:new-project → blocked too', gg(upe('gsd:new-project', BARE)), 2);
  gis('the Skill tool calling gsd-ingest-docs → blocked', gg(skl('gsd-ingest-docs', BARE)), 2);
  gis('…in its plugin form gsd-core:gsd-ingest-docs → blocked', gg(skl('gsd-core:gsd-ingest-docs', BARE)), 2);
  mkdirSync(path.join(BARE, 'src'), { recursive: true });
  gis('a subdirectory of that repo → blocked', gg(upe('gsd-new-project', path.join(BARE, 'src'))), 2);
  gis('other GSD commands in a non-toolkit repo → allowed', gg(upe('gsd-plan-phase', BARE)), 0);
  gis('non-GSD commands → allowed', gg(upe('review', BARE)), 0);
  gis('an unreadable payload → allowed (fails open)', gg('not json'), 0);
  // a hook an older release left in ~/.gemini: its payload is not read any more
  gis('an old Gemini activate_skill payload → allowed (Gemini is gone)', gg('{"tool_name":"activate_skill","tool_input":{"name":"gsd-new-project"}}'), 0);
  gis('GSD_SKIP_GUARD=1 escapes', guardRun(['--global'], upe('gsd-new-project', BARE), { GSD_SKIP_GUARD: '1' }).status, 0);
  write(path.join(BARE, '.gsd.conf'), 'install = none\n');
  gis('after gsdt-init (.gsd.conf) → allowed', gg(upe('gsd-new-project', BARE)), 0);
  mkrepo('', 'phase-7-thing', '07-thing');
  gis('--global skips the phase rules (plan-phase on a phase branch)', gg(upe('gsd-plan-phase', REPO)), 0);
  allowed('the repo hook: new-project in a set-up repo passes', 'gsd-new-project', '');
  rm(path.join(BARE, '.gsd.conf')); // the next section runs without it
});

// A PATH without jq (and without Python): the guard reads the payload itself, including the cwd. It
// needs node, which is linked in. (The bash launcher, with an exact PATH of symlinks: POSIX only.)
test('rule 0 — a PATH without jq', { skip: WIN && 'builds a PATH of symlinked tools to run the bash launcher: symlinks need privileges on Windows' }, () => {
  const NOJQ = pathWith(['bash', 'cat', 'dirname', 'sed', 'head', 'grep', 'git', 'tr', 'awk', 'env', 'readlink', 'node']);
  gis('no jq, no python: the guard reads the cwd of the payload too → blocked', guardBin(['--global'], upe('gsd-new-project', BARE), NOJQ).status, 2);
});

test('rule 0 — gsdt-flow / gsdw-flow are the guard\'s gsd-flow', () => {
  // the flow skill by both names (gsdw-flow: a session started before 0.8.0) is the guard's gsd-flow:
  // feature work, so blocked on the base branch of a set-up repo, and blocked in a phase worktree for
  // another phase
  mkrepo('', 'phase-7-thing', '07-thing');
  git(REPO, 'checkout', '-q', 'develop');
  const viaRepo = (skill: string, args: string): number =>
    guardRun([], JSON.stringify({ tool_name: 'Skill', tool_input: { skill, args } }), { CLAUDE_PROJECT_DIR: REPO }).status;
  for (const fs of ['gsdt-flow', 'gsdw-flow']) {
    gis(`the guard treats ${fs} as gsd-flow: feature work on the base → blocked`, viaRepo(fs, '7'), 2);
    assert.ok(lastErr.includes('is feature work'), `…as gsd-flow (${fs}) and says so: ${lastErr}`);
  }
  git(REPO, 'checkout', '-q', 'phase-7-thing');
  for (const fs of ['gsdt-flow', 'gsdw-flow']) {
    gis(`${fs} for another phase in a phase worktree → blocked (gsd-flow)`, viaRepo(fs, '9'), 2);
    gis(`${fs} for the matching phase → allowed`, viaRepo(fs, '7'), 0);
  }
});

// no node on PATH: the guard cannot read anything, so it blocks (fail closed); the user-level
// --global hook lets it through like an unreadable payload. (The bash launcher's own fallback.)
test('rule 0 — no node on PATH', { skip: WIN && 'builds a PATH of symlinked tools to run the bash launcher: symlinks need privileges on Windows' }, () => {
  const NONODE = pathWith(['bash', 'cat', 'dirname', 'sed', 'head', 'grep', 'git', 'tr', 'awk', 'env', 'readlink']);
  const payload = skl('gsd-plan-phase', REPO);
  gis('no node: the guard blocks (exit 2)', guardBin([], payload, NONODE).status, 2);
  assert.ok(lastErr.includes('needs Node.js'), `…and says it needs Node.js: ${lastErr}`);
  gis('no node: --global lets it through (exit 0, silent)', guardBin(['--global'], payload, NONODE).status, 0);
  assert.equal(lastErr, '', '…without a word');
  gis('no node: GSD_SKIP_GUARD=1 still escapes', guardBin([], payload, NONODE, { GSD_SKIP_GUARD: '1' }).status, 0);
});

test('rule 0b — GSD skills that clash with the worktree model (set-up repos)', () => {
  mkrepo('', 'phase-7-thing', '07-thing');
  const says = (text: string, label: string): void => assert.ok(lastErr.includes(text), `…${label}: ${lastErr}`);
  blocked('/gsd-autonomous is blocked', 'gsd-autonomous', '');
  says('gsdt-start', 'and names gsdt-start instead');
  blocked('/gsd-manager is blocked', 'gsd-manager', '');
  blocked('/gsd-workspace is blocked', 'gsd-workspace', '--new feature');
  blocked('/gsd-workstreams is blocked', 'gsd-workstreams', 'create x');
  blocked('/gsd-phase (add) is blocked', 'gsd-phase', 'checkout flow');
  says('gsdt-start -n', 'and names gsdt-start -n');
  blocked('/gsd-phase --insert is blocked', 'gsd-phase', '--insert 7 hotfix');
  says('gsdt-start --insert', 'and names gsdt-start --insert');
  blocked('/gsd-phase --remove is blocked', 'gsd-phase', '--remove 9');
  says('renumbers', 'and says why');
  git(REPO, 'checkout', '-q', 'develop');
  allowed('/gsd-phase --edit on the base passes', 'gsd-phase', '--edit 7');
  blocked('…but --remove with --edit is still blocked', 'gsd-phase', '--remove 3 --edit');
  blocked('…and --edit --insert is still blocked', 'gsd-phase', '--edit --insert 3 x');
  blocked('/gsd-autonomous on the base is blocked too', 'gsd-autonomous', '');
  allowed('GSD_SKIP_GUARD=1 escapes', 'gsd-autonomous', '', { GSD_SKIP_GUARD: '1' });
  git(REPO, 'checkout', '-q', 'phase-7-thing');
  blocked('/gsd-phase --edit off the base is blocked (rule 1)', 'gsd-phase', '--edit 7');
  gis('--global: typed /gsd-autonomous in a set-up repo → blocked', gg(upe('gsd-autonomous', REPO)), 2);
  git(REPO, 'checkout', '-q', 'develop');
  gis('--global: typed feature work on the base of a set-up repo → blocked (all rules apply)', gg(upe('gsd-discuss-phase', REPO)), 2);
  gis('--global: /gsd-autonomous in a repo without .gsd.conf → allowed', gg(upe('gsd-autonomous', BARE)), 0);
});

test('BLOCKED texts name /gsdt-flow, the skill that exists, not /gsd-flow', () => {
  mkrepo('', 'phase-7-thing', '07-thing');
  git(REPO, 'checkout', '-q', 'develop'); // the base branch: feature work is refused here
  for (const skill of ['gsdt-flow', 'gsdw-flow']) {
    blocked(`${skill} on the base branch`, skill, '7');
    assert.match(lastErr, /\/gsdt-flow is feature work/, `${skill}: names /gsdt-flow: ${lastErr}`);
    assert.doesNotMatch(lastErr, /\/gsd-flow/, `${skill}: never /gsd-flow: ${lastErr}`);
  }
});

test('/gsd-verify-work on the base branch only for a merged phase that was never marked complete (doctor T027)', () => {
  mkrepo('', 'phase-7-thing', '07-thing');
  write(path.join(PDIR, '07-01-PLAN.md'), 'x\n');
  write(path.join(PDIR, '07-01-SUMMARY.md'), 'x\n');
  write(path.join(REPO, '.planning', 'ROADMAP.md'), '# Roadmap\n\n- [ ] **Phase 7: Thing**\n- [ ] **Phase 8: Next**\n');
  git(REPO, 'checkout', '-q', 'develop');
  blocked('phase 7 still has its branch: verify it in the worktree', 'gsd-verify-work', '7');
  git(REPO, 'branch', '-q', '-D', 'phase-7-thing');
  allowed('merged, every plan ran, row not ticked → allowed on the base', 'gsd-verify-work', '7');
  allowed('…zero-padded too', 'gsd-verify-work', '07');
  blocked('phase 8 (no plans ran) is still feature work', 'gsd-verify-work', '8');
  blocked('other feature work on phase 7 stays blocked', 'gsd-plan-phase', '7');
  gis('--global: typed /gsd-verify-work 7 → allowed', gg(JSON.stringify({ hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command', command_name: 'gsd-verify-work', command_args: '7', cwd: REPO, prompt: '/gsd-verify-work 7' })), 0);
  write(path.join(REPO, '.planning', 'ROADMAP.md'), '# Roadmap\n\n- [x] **Phase 7: Thing**\n');
  blocked('once ticked, back to the rule', 'gsd-verify-work', '7');
});
