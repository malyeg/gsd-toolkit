// Regression coverage for the fresh-review findings; all mutations are fixtures.
// Port of tests/test-review-fixes.sh. Run: node --test tests/node/review-fixes.test.ts
import { after, describe, it } from 'node:test';
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  PKG, W, WIN, assertionCount, commit, countLines, fails, git, gitOk, gitOut, gsdt, has, hasnt, is, isDir, linesOf,
  ok, read, repoWithCommit, run, write, fwd, envOf,
} from './g3-helpers.ts';
import { planningApply, planningStatus } from '../../src/common.ts';
import { providerHookState, providerInstructionIntegrated } from '../../src/provider.ts';

after(() => console.log(`# review-fixes: ${assertionCount()} assertions`));

const flow = (R: string): ReturnType<typeof gsdt> => gsdt('gsdt-flow-next', ['7', '--repo', R, '--no-ui']);

const R7 = repoWithCommit(path.join(W, 'project with spaces'));
gitOk(R7, ['checkout', '-qb', 'phase-7-test']);

describe('flow-next: paths with spaces, the review provider', () => {
  const R = R7;
  const PD = path.join(R, '.planning', 'phases', '07-test');

  it('space-containing paths recognize completed plans and UAT', () => {
    for (const name of ['TICKET', 'CONTEXT', 'REVIEWS', '01-PLAN', '01-SUMMARY']) write(path.join(PD, `07-${name}.md`), '');
    commit(R, 'artifacts');
    let r = flow(R);
    has('space-containing paths recognize completed plans', r.stdout, /^step=verifier$/);
    write(path.join(PD, '07-VERIFICATION.md'), '---\nstatus: passed\n---\n');
    write(path.join(PD, '07-HUMAN-UAT.md'), '---\nstatus: complete\n---\n');
    r = flow(R);
    has('space-containing paths recognize completed UAT', r.stdout, /^step=code-review$/);
  });

  it('an invalid reviewer is rejected', () => {
    write(path.join(R, '.gsd.conf'), 'review_provider = invalid;echo\n');
    const r = fails('invalid reviewer is rejected (exit)', gsdt('gsdt-flow-next', ['7', '--repo', R]));
    has('invalid reviewer is rejected', r.out, 'invalid review_provider');
  });

  for (const p of ['claude', 'codex', 'custom']) {
    it(`${p} reviewer retains independent review gate`, () => {
      rmSync(path.join(PD, '07-REVIEWS.md'), { force: true });
      write(path.join(R, '.gsd.conf'), `review_provider = ${p}\n`);
      const r = flow(R);
      is(`${p}: flow-next succeeds`, r.status, 0);
      has(`${p}: step=review`, r.stdout, /^step=review$/);
      if (p === 'custom') has('custom: independent custom-provider review', r.stdout, 'independent custom-provider review');
      else has(`${p}: --${p}`, r.stdout, `--${p}`);
    });
  }
});

describe('the guard without jq', () => {
  it('Claude payload without jq or Python blocks nested wrong-phase args', () => {
    const R = R7; // on branch phase-7-test: a call for phase 8 is a wrong-phase call
    // No jq is discoverable in this PATH, even on Linux where jq lives in /usr/bin: a folder holding only git.
    const farm = path.join(W, 'no-jq');
    mkdirSync(farm, { recursive: true });
    const gitBin = run(WIN ? 'where' : 'which', ['git']).stdout.split(/\r?\n/)[0]!.trim();
    let gitDir = path.dirname(gitBin);
    if (!WIN) {
      try {
        symlinkSync(gitBin, path.join(farm, 'git'));
        gitDir = farm;
      } catch {
        /* keep the git folder */
      }
    }
    const env = { ...envOf({ CLAUDE_PROJECT_DIR: R }), PATH: gitDir };
    const payload = '{"tool_name":"Skill","tool_input":{"skill":"gsd-plan-phase","args":"8"}}';
    const r = gsdt('gsdt-worktree-guard', [], { cwd: W, input: payload, rawEnv: env });
    is('guard blocks (exit 2)', r.status, 2);
    has('guard names the targeted phase', r.out, 'targets phase 8');
  });
});

describe('bootstrap: instruction blocks and hooks', () => {
  const bootstrap = (R: string, args: string[]): ReturnType<typeof gsdt> => gsdt('gsdt-bootstrap-repo', args, { cwd: R });
  const doctor = (R: string, env: Record<string, string | undefined> = {}): string => gsdt('gsdt-doctor', ['--repo', R, '--json'], { env }).stdout;

  const R = repoWithCommit(path.join(W, 'bootstrap'));
  it('Codex and custom share an explicitly identified entrypoint', () => {
    bootstrap(R, ['--agents', 'codex,custom', '--provider-command', 'custom=true']);
    ok('codex entrypoint integrated', providerInstructionIntegrated(R, 'codex'));
    ok('custom entrypoint integrated', providerInstructionIntegrated(R, 'custom'));
  });
  it('reversed provider order preserves shared entrypoint and canonical additions', () => {
    const f = path.join(R, '.gsd', 'INSTRUCTIONS.md');
    writeFileSync(f, read(f) + '\nUser policy after generated block\n');
    bootstrap(R, ['--agents', 'custom,codex', '--provider-command', 'custom=true']);
    has('canonical addition kept', read(f), 'User policy after generated block');
    ok('codex entrypoint integrated', providerInstructionIntegrated(R, 'codex'));
    ok('custom entrypoint integrated', providerInstructionIntegrated(R, 'custom'));
  });
  it('legacy canonical migration preserves additions and full backup', () => {
    // Legacy single-marker migration must preserve trailing additions, with a complete backup even if
    // legacy content cannot be recognized automatically.
    const f = path.join(R, '.gsd', 'INSTRUCTIONS.md');
    writeFileSync(f, '<!-- gsd-worktrees:canonical -->\n# GSD worktree workflow\nlegacy generated text\nworktrees `../old/`.\nUser legacy addition\n');
    bootstrap(R, ['--agents', 'codex,custom', '--provider-command', 'custom=true']);
    has('legacy addition kept', read(f), 'User legacy addition');
    has('full backup kept', read(`${f}.bak`), 'legacy generated text');
    ok('codex entrypoint integrated', providerInstructionIntegrated(R, 'codex'));
  });
  it('custom-only instructions are not stale Codex artifacts', () => {
    bootstrap(R, ['--agent', 'custom', '--provider-command', 'custom=true']);
    hasnt('no "stale codex" in doctor', doctor(R), 'stale codex');
  });
  it('doctor rejects incomplete instruction blocks', () => {
    const f = path.join(R, 'AGENTS.md');
    writeFileSync(f, linesOf(read(f)).filter((l) => !l.includes('provider:end')).join('\n') + '\n');
    ok('custom entrypoint no longer integrated', !providerInstructionIntegrated(R, 'custom'));
    has('doctor: instruction_integrated false', doctor(R), '"instruction_integrated":false');
  });

  describe('Claude hooks', () => {
    const H = repoWithCommit(path.join(W, 'hooks'));
    mkdirSync(path.join(H, '.claude'), { recursive: true });
    const settings = path.join(H, '.claude', 'settings.json');
    it('inert hook mention does not prevent real registration', () => {
      writeFileSync(settings, '{"comment":"gsdt-worktree-guard", "hooks":{}}\n');
      bootstrap(H, ['--agent', 'claude']);
      is('hook state present', providerHookState(H, 'claude'), 'present');
    });
    it('incompatible hook JSON preserved without false success', () => {
      writeFileSync(settings, '{"hooks":{"PreToolUse":{}}}\n');
      const original = read(settings);
      const r = bootstrap(H, ['--agent', 'claude']);
      is('settings unchanged', read(settings), original);
      hasnt('no false success line', r.stdout, '(claude native guard hook)');
      is('hook state invalid', providerHookState(H, 'claude'), 'invalid');
    });
    it('explicitly disabled hooks remain disabled', () => {
      writeFileSync(settings, '{"disableAllHooks":true,"hooks":{}}\n');
      bootstrap(H, ['--agent', 'claude']);
      is('hook state absent', providerHookState(H, 'claude'), 'absent');
    });
    it('malformed canonical markers stop bootstrap', () => {
      const f = path.join(H, '.gsd', 'INSTRUCTIONS.md');
      const canonical = read(f);
      writeFileSync(f, canonical + '<!-- gsd-toolkit:canonical:start -->\n');
      const r = fails('bootstrap refuses (exit)', bootstrap(H, ['--agent', 'claude']));
      has('malformed canonical markers stop bootstrap', r.out, 'ambiguous canonical');
      writeFileSync(f, canonical);
    });
    it('non-executable planning hook repaired without duplicate body', { skip: WIN && 'POSIX file modes: chmod -x is not visible on Windows' }, () => {
      const hook = path.join(H, '.git', 'hooks', 'post-merge');
      run('chmod', ['-x', hook]);
      ok('planning status names the hook', planningStatus(H).missing.includes('hook'));
      planningApply(H);
      ok('post-merge hook is executable again', run('test', ['-x', hook]).status === 0);
    });
    it('the repaired planning hook has its body once', () => {
      planningApply(H);
      is('one "gsdt-planning-repair || true" line', countLines(read(path.join(H, '.git', 'hooks', 'post-merge')), /gsdt-planning-repair \|\| true/), 1);
    });
  });
});

describe('doctor: a broken command guard, the skill directory, an unrelated canonical file', () => {
  const R = repoWithCommit(path.join(W, 'doctor'));
  gsdt('gsdt-bootstrap-repo', ['--agent', 'claude'], { cwd: R });

  it('doctor JSON reports broken command guard honestly', { skip: WIN && 'POSIX file modes: chmod -x is not visible on Windows' }, () => {
    const broken = path.join(W, 'broken');
    mkdirSync(path.join(broken, 'shims'), { recursive: true });
    cpSync(path.join(PKG, 'bin'), path.join(broken, 'bin'), { recursive: true });
    cpSync(path.join(PKG, 'lib'), path.join(broken, 'lib'), { recursive: true });
    cpSync(path.join(PKG, 'shims', 'scripts'), path.join(broken, 'shims', 'scripts'), { recursive: true });
    cpSync(path.join(PKG, 'src'), path.join(broken, 'src'), { recursive: true });
    for (const f of ['VERSION', 'package.json']) cpSync(path.join(PKG, f), path.join(broken, f));
    run('chmod', ['-x', path.join(broken, 'bin', 'gsdt-worktree-guard')]);
    const r = run(process.execPath, [path.join(broken, 'src', 'launch.mjs'), 'doctor', '--repo', R, '--json']);
    has('doctor: command_guard false', r.stdout, '"command_guard":false');
  });
  it('doctor respects installer skill destination override', () => {
    mkdirSync(path.join(W, 'skills', 'gsdt-flow'), { recursive: true });
    cpSync(path.join(PKG, 'skills', 'gsdt-flow', 'SKILL.md'), path.join(W, 'skills', 'gsdt-flow', 'SKILL.md'));
    const r = gsdt('gsdt-doctor', ['--repo', R, '--json'], { env: { GSD_CLAUDE_SKILL_DIR: path.join(W, 'skills') } });
    has('doctor: skill_installed true', r.stdout, '"skill_installed":true');
  });
  it('unrelated canonical filename alone is not an integration', () => {
    write(path.join(R, '.gsd', 'INSTRUCTIONS.md'), '# unrelated instructions\n');
    const r = gsdt('gsdt-doctor', ['--repo', R, '--json']);
    has('doctor: instruction_integrated false', r.stdout, '"instruction_integrated":false');
  });
});

describe('finish: branch rejection, remote sync, push race, combined-tree validation', () => {
  const R = repoWithCommit(path.join(W, 'finish'));
  gitOk(R, ['branch', 'unrelated']);
  gitOk(R, ['branch', 'phase-1-feature']);
  gitOk(R, ['branch', 'phase-1-feature-pr']); // /gsd-pr-branch names its helper <branch>-pr
  const phase = path.join(W, 'phase');

  for (const command of ['gsdt-finish', 'gsdt-wt-finish']) {
    for (const branch of ['unrelated', 'phase-1-feature-pr']) {
      it(`${command} rejects ${branch} without deleting it`, () => {
        fails(`${command} rejects ${branch}`, gsdt(command, [branch], { cwd: R }));
        is(`${branch} still exists`, git(R, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status, 0);
      });
    }
  }

  it('failed remote synchronization stops before phase merge', () => {
    write(path.join(R, '.gsd.conf'), 'test = none\n');
    commit(R, 'config');
    gitOk(R, ['worktree', 'add', '-q', phase, 'phase-1-feature']);
    gitOk(R, ['remote', 'add', 'origin', path.join(W, 'missing-remote')]);
    const before = gitOut(R, ['rev-parse', 'HEAD']);
    fails('wt-finish stops on a missing remote', gsdt('gsdt-wt-finish', ['1'], { cwd: R }));
    is('main HEAD unchanged', gitOut(R, ['rev-parse', 'HEAD']), before);
    ok('phase worktree kept', isDir(phase));
  });

  it('concurrent remote changes revalidated before retry push; worktree retained', () => {
    // Real push rejection: the first pre-push hook advances the isolated bare remote through a second
    // checkout. Validation must inspect the combined tree.
    const remote = path.join(W, 'remote.git');
    gitOk(W, ['init', '-q', '--bare', remote]);
    gitOk(R, ['remote', 'set-url', 'origin', remote]);
    gitOk(R, ['push', '-qu', 'origin', 'main']);
    const racer = path.join(W, 'racer');
    gitOk(W, ['clone', '-q', '-b', 'main', remote, racer]);
    write(path.join(racer, 'reject-combined'), 'bad\n');
    commit(racer, 'concurrent');
    write(path.join(R, 'scripts', 'gsdt-premerge-check.sh'), '#!/bin/sh\ntest ! -f reject-combined\n', 0o755);
    commit(R, 'validator');
    gitOk(R, ['push', '-q', 'origin', 'main']);
    gitOk(racer, ['pull', '-q', '--no-rebase', 'origin', 'main']);
    write(path.join(phase, 'feature'), 'phase\n');
    commit(phase, 'feature');
    write(
      path.join(R, '.git', 'hooks', 'pre-push'),
      '#!/bin/sh\nif [ ! -f "$RACE_MARKER" ]; then\n touch "$RACE_MARKER"\n git -C "$RACE_CHECKOUT" push -q origin main || exit 1\nfi\n',
      0o755,
    );
    const r = fails(
      'wt-finish rejects the combined tree',
      gsdt('gsdt-wt-finish', ['1'], { cwd: R, env: { RACE_MARKER: fwd(path.join(W, 'raced')), RACE_CHECKOUT: fwd(racer) } }),
    );
    has('validation failed on the combined tree after the remote retry', r.out, 'validation failed (combined tree after remote retry)');
    ok('phase worktree retained', isDir(phase));
    ok('the feature did not reach the remote', git(W, ['--git-dir', remote, 'cat-file', '-e', 'main:feature']).status !== 0);
  });
});

describe('finish: tests run against combined code', () => {
  it('test fallback validates combined code and keeps worktree on failure', () => {
    const R = repoWithCommit(path.join(W, 'combined'));
    write(path.join(R, '.gsd.conf'), 'test = sh check.sh\n');
    write(path.join(R, 'check.sh'), '#!/bin/sh\nif [ -f base-file ] && [ -f feature-file ]; then exit 1; fi\n');
    commit(R, 'check');
    const wt = path.join(W, 'combined-phase');
    gitOk(R, ['worktree', 'add', '-qb', 'phase-2-combined', wt]);
    write(path.join(R, 'base-file'), '');
    commit(R, 'base');
    write(path.join(wt, 'feature-file'), '');
    commit(wt, 'feature');
    const r = fails('wt-finish fails on the combined tree', gsdt('gsdt-wt-finish', ['2'], { cwd: R }));
    has('tests failed on the combined tree after the phase merge', r.out, 'tests failed (combined tree after phase merge)');
    ok('worktree kept', isDir(wt));
  });
});
