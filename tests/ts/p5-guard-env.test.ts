// P5: the guard's rule 5 (ui_gates = strict) uses the env given to guard(opts),
// not process.env — in the git calls of the UI helpers (the code hash of the
// working files is built with `git add -A`, which reads the env's git config).
// Run: node --test tests/ts/p5-guard-env.test.ts
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { guard } from '../../src/guard.ts';
import { uiCodeState, uiGate } from '../../src/ui.ts';
import { repo, sh, tmp, withEnv, write } from './helpers.ts';

const git = (cwd: string, ...a: string[]): string => sh(cwd, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);

test('rule 5 reads the env passed to guard(), not process.env', () => {
  withEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, () => {
    const d = tmp();
    const R = repo(path.join(d, 'repo'), 'ui_gates = strict\nbase = develop\n');
    write(`${R}/.planning/phases/01-x/01-UI-SPEC.md`, 'spec\n');
    git(R, 'add', '-A');
    git(R, 'commit', '-qm', 'plan');
    const W = path.join(d, 'wt');
    git(R, 'worktree', 'add', '-qb', 'phase-1-x', W);
    write(`${W}/app.js`, 'console.log(1)\n'); // untracked: part of the code hash unless git is told to ignore it
    const code = uiCodeState(W);
    assert.match(code, /^[0-9a-f]{40}$/);
    write(`${W}/.planning/phases/01-x/01-UI-CHECK.md`, `---\nstatus: failed\ncapture: c1\ncode: ${code}\nfailures: 1\nwaived: 0\nquestions: 0\nunchecked: 0\n---\n`);

    // an env whose git config ignores app.js: the code hash differs, so the check is stale
    write(`${d}/ignore`, 'app.js\n');
    write(`${d}/gitconfig`, `[core]\n\texcludesFile = ${d}/ignore\n`);
    const plain: NodeJS.ProcessEnv = { ...process.env };
    const ignoring: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: `${d}/gitconfig` };
    assert.notEqual(uiCodeState(W, ignoring), code, 'the fixture must make the two envs differ');

    const ask = (env?: NodeJS.ProcessEnv) => guard({ command: 'gsd-ui-review', args: '1', repo: W, env });
    const FAILED = /the check found 1 problem\(s\)/;
    const STALE = /the code or 01-LAYOUT\.md changed after the last check/;

    for (const env of [undefined, plain]) {
      const r = ask(env);
      assert.equal(r.rc, 2);
      assert.match(r.stderr, FAILED);
    }
    const stale = ask(ignoring);
    assert.equal(stale.rc, 2);
    assert.match(stale.stderr, STALE);

    // and process.env alone does not matter when an env is given
    withEnv({ GIT_CONFIG_GLOBAL: `${d}/gitconfig` }, () => {
      assert.match(ask(undefined).stderr, STALE, 'no env given: process.env is used');
      assert.match(ask(plain).stderr, FAILED, 'env given: process.env is not');
    });

    // the helper itself
    assert.match(uiGate(W, `${W}/.planning/phases/01-x`, '01', '', ignoring), /^ui-check\|stale\|/);
    assert.match(uiGate(W, `${W}/.planning/phases/01-x`, '01', '', plain), /^ui-check\|failed\|/);
  });
});
