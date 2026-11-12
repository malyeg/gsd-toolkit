// P6 parity (gsdt-start): the TypeScript command behind bin/gsdt-start against the
// pre-P6 bash command (tests/fixtures/p6-old-bins/gsdt-start), each on its own
// copy of the same fixture project. Compared: stdout, stderr, exit code of every
// step, and the files/commits/branches/worktrees left behind.
// Run: node --test tests/ts/p6-start.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ROADMAP_RICH,
  cleanPath,
  commitAll,
  git,
  makeSide,
  runStep,
  scenario,
  sub,
  write,
  type Side,
  type Step,
} from './p6-helpers.ts';

const NL = '--no-launch';
const start = (args: Step['args'], extra: Partial<Step> = {}): Step => ({ cmd: 'start', args, ...extra });

test('refusals: flags, missing values, descriptions', () => {
  const bad: Array<[string[], Partial<Step>]> = [
    [['--bogus'], { rc: 1, err: /unknown flag: --bogus/ }],
    [['-p'], { rc: 1, err: /--phase needs a value/ }],
    [['--repo'], { rc: 1, err: /--repo needs a value/ }],
    [['--slug'], { rc: 1 }],
    [['--ticket'], { rc: 1 }],
    [['--cu'], { rc: 1 }],
    [['--insert'], { rc: 1 }],
    [['--after'], { rc: 1 }],
    [['--provider'], { rc: 1 }],
    [['--model'], { rc: 1 }],
    [['--model', ''], { rc: 1, err: /--model needs a model ID/ }],
    [['--agent-command'], { rc: 1 }],
    [['--agent'], { rc: 1 }],
    [[], { rc: 1, err: /gsdt-start — start a GSD feature/ }],
    [['-n'], { rc: 1, err: /-n\/--new needs a phase description/ }],
    [['--insert', '3'], { rc: 1, err: /--insert needs a phase description/ }],
    [['--insert', 'x', 'desc'], { rc: 1, err: /--insert must be the phase number/ }],
    [['-p', 'abc'], { rc: 1, err: /--phase must be a phase number/ }],
    [['-p', '7.'], { rc: 1 }],
    [['-n', 'x', '-p', '1'], { rc: 1, err: /mutually exclusive/ }],
    [['--insert', '1', 'x', '-p', '1'], { rc: 1, err: /mutually exclusive/ }],
    [['cart', NL], { rc: 1, err: /refusing to guess/ }],
    [['two', 'words', NL], { rc: 1, err: /gsdt-start -n "two words"/ }],
    [['-p', '9', NL], { rc: 1, err: /phase 9 not found/ }],
    [['-p', '1', 'some words', NL], { rc: 0, err: /ignoring "some words"/ }],
    [['-n', 'catalog', NL], { rc: 1, err: /already has this exact description/ }],
    [['-n', 'CATALOG', NL], { rc: 1, err: /already has this exact description/ }],
    [['-n', 'x', '--provider', 'gemini', NL], { rc: 64, err: /Gemini is no longer supported/ }],
    [['-n', 'x', '--provider', 'nope', NL], { rc: 64, err: /unknown provider 'nope'/ }],
    [['-n', 'x', '--provider', 'custom', NL], { rc: 64, err: /requires an explicit agent command/ }],
    [['-n', 'x', '--model', 'a b', NL], { rc: 64, err: /model must be one model ID/ }],
    [['-n', 'x', '--agent-command', 'a b', NL], { rc: 64, err: /one executable/ }],
    [['-n', 'x', '--ticket', '!!', NL], { rc: 1, err: /doesn't look like a ticket id/ }],
  ];
  scenario({}, null, bad.map(([a, e]) => start(a, e)));
});

test('refusals: not a repo, --repo, no ROADMAP, old names, no gsd-core', () => {
  scenario({}, null, [
    start(['-n', 'x', NL], { cwd: () => mkdtempSync(path.join(tmpdir(), 'gsd-p6-')), rc: 1, err: /not inside a git repo/ }),
    start(['-n', 'x', NL, '--repo', '/nonexistent/place'], { rc: 1, err: /--repo is not a git checkout/ }),
  ]);
  scenario({ roadmap: '' }, (s) => rmSync(sub(s, '.planning/ROADMAP.md')), [start(['-n', 'x', NL], { rc: 1, err: /has no \.planning\/ROADMAP\.md/ })]);
  // the 0.10.0 rename: an old shim → refused
  scenario({ files: { 'scripts/gsd-derive-port.sh': '#!/bin/sh\n' } }, null, [start(['-n', 'x', NL], { rc: 1, err: /old gsd-\* names/ })]);
  // no gsd-core anywhere: a claim is refused with the install line, an attach does not need it
  scenario({}, null, [
    start(['-n', 'cart', NL], { env: { GSD_CLI: undefined, PATH: cleanPath }, rc: 1, err: /GSD \(gsd-core\) not found/ }),
  ]);
});

test('-n claims: pushed, --no-push, no origin; rows, STATE note, tdd default', () => {
  scenario({ roadmap: ROADMAP_RICH, state: '# State\n\n### Roadmap Evolution\n\n- Phase 1 added: catalog\n\n## Other\n', config: '{\n  "workflow": {}\n}\n' }, null, [
    start(['-n', 'shopping cart', NL], { rc: 0, out: /claim pushed to origin\/main/ }),
    start(['-n', 'second one', NL, '--no-push'], { rc: 0, out: /--no-push: remember to push/ }),
  ]);
  scenario({ roadmap: ROADMAP_RICH, noOrigin: true }, null, [start(['-n', 'shopping cart', NL], { rc: 0, out: /no 'origin' remote — claim stays local/ })]);
  // STATE.md with no evolution section, a missing STATE.md, tdd_mode chosen false
  scenario({ state: '# State\n' }, null, [start(['-n', 'a', NL], { rc: 0 }), start(['-n', 'b', NL], { rc: 0 })]);
  scenario({ config: '{"workflow": {"tdd_mode": false}}' }, null, [start(['-n', 'a', NL], { rc: 0, not: /TDD mode on/ })]);
  scenario({ config: '{"workflow": {}}' }, null, [start(['-n', 'a', NL], { rc: 0, out: /TDD mode on for this project/ })]);
  // characters that would mean something in a regexp replacement / printf
  scenario({ state: '### Roadmap Evolution\n\n- old\n' }, null, [start(['-n', 'café $1 $& \\n %s 100% ünï', NL], { rc: 0 })]);
});

test('-n claim preconditions: not on the base branch, uncommitted .planning, diverged', () => {
  scenario({}, (s) => git(s.R, 'checkout', '-qb', 'side'), [start(['-n', 'x', NL], { rc: 1, err: /main checkout is on 'side', not 'main'/ })]);
  scenario({}, (s) => write(sub(s, '.planning/ROADMAP.md'), '# changed\n'), [start(['-n', 'x', NL], { rc: 1, err: /uncommitted \.planning\/ changes/ })]);
  scenario({}, (s) => {
    git(s.R, 'commit', '-q', '--allow-empty', '-m', 'local only');
    const other = path.join(s.root, 'other');
    git(s.root, 'clone', '-q', s.origin, other);
    git(other, 'commit', '-q', '--allow-empty', '-m', 'remote only');
    git(other, 'push', '-q', 'origin', 'main');
  }, [start(['-n', 'x', NL], { rc: 1, err: /has diverged from origin/ })]);
  // origin has no such branch / the remote is gone
  scenario({ conf: 'install = none\nbase = main\n' }, (s) => git(s.R, 'remote', 'set-url', 'origin', path.join(s.root, 'nowhere.git')), [
    start(['-n', 'x', NL], { rc: 1, err: /could not fetch 'main' from origin/ }),
  ]);
  scenario({}, (s) => {
    const empty = path.join(s.root, 'empty.git');
    git(s.root, 'init', '-q', '--bare', empty);
    git(s.R, 'remote', 'set-url', 'origin', empty);
  }, [start(['-n', 'x', NL], { rc: 1, err: /origin has no 'main' branch/ })]);
});

test('--insert: decimal phases, with and without STATE.md section', () => {
  scenario({ state: '### Roadmap Evolution\n\n- Phase 1 added: catalog\n' }, null, [
    start(['--insert', '1', 'hotfix reset email', NL], { rc: 0, out: /phase 01\.1 inserted after phase 1/ }),
    start(['--after', '1', 'second hotfix', NL], { rc: 0 }),
    start(['--insert', '1', 'urgent db backfill', '--slug', 'db-backfill', NL], { rc: 0 }),
    start(['--insert', '1', 'hotfix reset email', NL], { rc: 0 }), // inserting beside a same-named phase is allowed
  ]);
  scenario({}, null, [start(['--insert', '1', 'x', NL, '--no-push'], { rc: 0 })]);
  scenario({ config: '{"workflow": {}}' }, null, [start(['--insert', '1', 'x', NL], { rc: 0, out: /TDD mode on/ })]);
});

test('-p attaches: new worktree, reuse, deleted by hand, re-attach, discuss mode', () => {
  scenario({ roadmap: `${ROADMAP_RICH}\n### Phase 2: second thing\n\n### Phase 3.1: decimal\n` }, null, [
    start(['-p', '1', NL], { rc: 0, out: /attaching to existing phase 1: Catalog/ }),
    start(['-p', '1', NL], { rc: 0, out: /already has a worktree — reusing it/ }),
    start(['-p', '2', '--no-flow', NL], { rc: 0, out: /gsd-discuss-phase\\ 2/ }),
    start(['-p', '3.1', NL], { rc: 0 }),
    start(['-p', '2', '--slug', 'other-slug', NL], { rc: 0 }), // the existing branch wins over a new slug
  ]);
  // folder deleted by hand → pruned and re-created
  scenario({}, null, [
    start(['-p', '1', NL], { rc: 0 }),
    start(['-p', '1', NL], { rc: 0, cwd: (s) => s.R, env: {}, out: /reusing it/ }),
  ]);
  scenario({}, (s) => {
    // a first run makes the worktree, then the test removes the folder (the second step sees it gone)
    git(s.R, 'worktree', 'add', '-qb', 'phase-1-catalog', path.join(s.wtdir, 'phase-1-catalog'));
    rmSync(path.join(s.wtdir, 'phase-1-catalog'), { recursive: true, force: true });
  }, [start(['-p', '1', NL], { rc: 0, out: /gone from disk/ })]);
  // the branch exists, its worktree was removed properly → re-attached
  scenario({}, (s) => {
    git(s.R, 'worktree', 'add', '-qb', 'phase-1-catalog', path.join(s.wtdir, 'phase-1-catalog'));
    git(s.R, 'worktree', 'remove', path.join(s.wtdir, 'phase-1-catalog'));
  }, [start(['-p', '1', NL], { rc: 0, out: /re-attaching worktree for existing branch/ })]);
  // the destination is in the way and not a worktree
  scenario({}, (s) => mkdirSync(path.join(s.wtdir, 'phase-1-catalog'), { recursive: true }), [start(['-p', '1', NL], { rc: 1, err: /already exists but is not a registered worktree/ })]);
  // start_mode = discuss in .gsd.conf, --flow overrides it
  scenario({ conf: 'install = none\nstart_mode = discuss\n' }, null, [
    start(['-p', '1', NL], { rc: 0, out: /gsd-discuss-phase\\ 1/ }),
    start(['-p', '1', '--flow', NL], { rc: 0, out: /gsdt-flow\\ 1/ }),
  ]);
  // an existing phase directory with artifacts: gsdt-flow-next runs before the session is printed
  scenario({ phaseDirs: ['01-catalog'] }, null, [start(['-p', '1', NL], { rc: 0 })]);
  // a zero-padded phase number in the roadmap. NOT a parity test: the bash died here (`printf '%02d' 08` is
  // an invalid octal number, so `-p 08` exited 1 right after creating the worktree). The TypeScript reads it as decimal.
  {
    const side = makeSide('new', { roadmap: '# Roadmap\n\n### Phase 08: padded thing\n', phaseDirs: ['08-padded'] });
    const r = runStep(side, start(['-p', '08', NL]));
    assert.equal(r.rc, 0, r.err);
    assert.match(r.out, /Next:  cd .*phase-08-padded-thing/);
  }
  // from inside a worktree, and with --repo
  scenario({}, null, [
    start(['-p', '1', NL]),
    start(['-p', '1', NL], { cwd: (s) => path.join(s.wtdir, 'phase-1-catalog'), rc: 0 }),
    start((s) => ['-p', '1', NL, '--repo', s.R], { cwd: (s) => s.wtdir, rc: 0 }),
  ]);
});

test('the local config is copied, info/exclude is kept', () => {
  scenario(
    { files: { '.gitignore': '.env.local\n.mcp.json\n.claude/settings.local.json\n.claude/worktrees/\n' }, conf: 'install = none\n' },
    (s) => {
      write(sub(s, '.env.local'), 'SECRET=1\n');
      write(sub(s, '.mcp.json'), '{}\n');
      write(sub(s, '.claude/settings.local.json'), '{"permissions": {"allow": ["Bash(ls)"]}}\n');
      write(sub(s, '.claude/worktrees/agent-1/.env.local'), 'nested\n');
      write(sub(s, 'apps/web/.env.local'), 'web\n');
      write(sub(s, '.gitignore'), '.env.local\n.mcp.json\n.claude/settings.local.json\n.claude/worktrees/\n');
      commitAll(s.R);
      write(sub(s, '.env.local'), 'SECRET=1\n');
      write(sub(s, 'apps/web/.env.local'), 'web\n');
      write(sub(s, '.git/info/exclude'), 'already\n.gsd-install.status'); // no final newline
    },
    [start(['-p', '1', NL], { rc: 0, out: /copied \.env\.local/ })],
  );
  scenario({ files: { '.gitignore': '.env.local\n' } }, (s) => write(sub(s, '.env.local'), 'x\n'), [start(['-p', '1', NL], { rc: 0 })]);
  // a tracked settings.local.json is not changed; an unignored one is not written
  scenario({ files: { '.claude/settings.local.json': '{}\n' } }, null, [start(['-p', '1', NL], { rc: 0, out: /is tracked by git/ })]);
  scenario({}, (s) => write(sub(s, '.claude/settings.local.json'), '{"a": 1}\n'), [start(['-p', '1', NL], { rc: 0 })]);
});

test('installs: background by default, none with install = none', () => {
  scenario({ conf: 'install = echo installing && echo done\n' }, null, [start(['-p', '1', NL], { rc: 0, out: /running in background/ })]);
  scenario({ conf: 'install = false\n' }, null, [start(['-p', '1', NL], { rc: 0 })]);
});

test('the claim race: another session pushed first', () => {
  const setup = (s: Side): void => {
    const clone = path.join(s.root, 'racer');
    git(s.root, 'clone', '-q', s.origin, clone);
  };
  // the same phase number: renumbered
  scenario({ roadmap: ROADMAP_RICH }, setup, [
    start(['-n', 'shopping cart', NL], { rc: 0, env: (s) => ({ RACE_CLONE: path.join(s.root, 'racer'), RACE: 'heading' }), out: /claimed by the other session too — renumbering/ }),
  ]);
  // an unrelated commit: rebase and push again
  scenario({ roadmap: ROADMAP_RICH }, setup, [
    start(['-n', 'shopping cart', NL], { rc: 0, env: (s) => ({ RACE_CLONE: path.join(s.root, 'racer'), RACE: 'plain' }), out: /push rejected/ }),
  ]);
  // --insert in the same race
  scenario({ roadmap: ROADMAP_RICH }, setup, [
    start(['--insert', '1', 'urgent', NL], { rc: 0 }),
  ]);
});

test('tickets: tracker none tags only; a tracker set demands a ticket', () => {
  scenario({ roadmap: '# Roadmap\n\n### Phase 1: catalog tk-ABC-1\n' }, null, [
    start(['-n', 'something else', '--ticket', 'ABC-1', NL], { rc: 1, err: /already tracks ticket ABC-1/ }),
    start(['-n', 'new work', '--ticket', 'https://example.com/browse/PROJ-42', NL], { rc: 0, out: /tracker = none — phase tagged tk-PROJ-42 only/ }),
    start(['-n', 'tagged tk-ZZ-9', NL], { rc: 0 }),
    start(['-n', 'more', '--cu', 'abc123', NL], { rc: 0 }),
    start(['-n', 'with slug', '--ticket', 'T-7', '--slug', 'my-slug', NL], { rc: 0, out: /my-slug-tk-T-7/ }),
    start(['-p', '1', NL], { rc: 0 }),
  ]);
  scenario({ conf: 'install = none\ntracker = clickup\n' }, null, [
    start(['-n', 'no ticket', NL], { rc: 1, err: /tracker = clickup is set, but this phase has no ticket/ }),
    start(['-n', 'chore', '--no-ticket', NL], { rc: 0 }),
    start(['-p', '1', NL], { rc: 0, out: /phase 1 has no ticket/ }),
  ]);
  scenario({ conf: 'install = none\ntracker = bogus\n' }, null, [start(['-n', 'x', NL], {})]);
});

test('provider and model resolution; the session command that is printed', () => {
  scenario({}, null, [
    start(['-p', '1', NL, '--provider', 'codex'], { rc: 0, out: /codex/ }),
    start(['-p', '1', NL, '--provider', 'codex', '--model', 'gpt-5'], { rc: 0, out: /--model gpt-5/ }),
    start(['-p', '1', NL, '--model', 'sonnet'], { rc: 0, out: /--model sonnet/ }),
    start(['-p', '1', NL, '--model', 'default'], { rc: 0 }),
    start(['-p', '1', NL, '--agent', 'mycli'], { rc: 0, out: /mycli/ }),
    start(['-p', '1', NL, '--agent', 'codex'], { rc: 0 }),
    start(['-p', '1', NL, '--agent-command', '/opt/some tool'], { rc: 64 }),
    start(['-p', '1', NL, '--provider', 'custom', '--agent-command', 'wrapper'], { rc: 0 }),
  ]);
  scenario({ conf: 'install = none\nproviders = codex,claude\ncodex_model = o3\ncompact_at = 200000\n' }, null, [
    start(['-p', '1', NL], { rc: 0, out: /codex/ }),
    start(['-p', '1', NL, '--provider', 'claude'], { rc: 0, out: /CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000/ }),
    start(['-p', '1', NL, '--provider', 'claude'], { rc: 0, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '123456' } }),
  ]);
  scenario({ conf: 'install = none\ncompact_at = 5\n' }, null, [start(['-p', '1', NL], { rc: 64, err: /invalid compact_at/ })]);
  scenario({ conf: 'install = none\nstart_mode = bogus\n' }, null, [start(['-p', '1', NL], { rc: 64, err: /invalid start_mode/ })]);
  scenario({ conf: 'install = none\nproviders = gemini\n' }, null, [start(['-p', '1', NL], { rc: 64 })]);
  // compact_at is saved into an existing settings.local.json of the worktree
  scenario({}, (s) => write(sub(s, '.claude/settings.local.json'), '{"a": 1}\n'), [start(['-p', '1', NL], { rc: 0 })]);
});

test('the launch: a stub agent under a terminal, the executable check without one', () => {
  scenario({}, null, [
    // a terminal: the agent runs in the worktree, after the lock is released, and its exit code comes back
    start((s) => ['-p', '1', '--agent-command', path.join(s.stub, 'agent')], { tty: true, rc: 5, out: /opening claude session in/ }),
  ]);
  scenario({}, null, [
    start(['-p', '1'], { tty: true, rc: 0, out: /Next:/ }), // claude is not on PATH: printed, not an error
    start(['-p', '1', '--launch'], { tty: true, rc: 127, out: /launch cancelled/ }),
    start(['-p', '1', '--no-launch', '--launch'], { tty: true, rc: 0 }),
    start(['-p', '1', '--launch'], { rc: 127 }), // no terminal, explicit launch, no executable
    start(['-p', '1', '--agent', 'nonexistent-cli'], { rc: 127, err: /launch cancelled/ }),
  ]);
  scenario({}, null, [
    start((s) => ['-p', '1', '--provider', 'codex', '--agent-command', path.join(s.stub, 'agent'), '--model', 'o3'], { tty: true, rc: 5 }),
  ]);
  // no terminal and the agent exists: printed, not run
  scenario({}, null, [start((s) => ['-p', '1', '--agent-command', path.join(s.stub, 'agent')], { rc: 0, out: /Next:/ })]);
});

test('stale hooks and update notice stay on stderr', () => {
  scenario({}, (s) => {
    write(path.join(s.home, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Skill', hooks: [{ type: 'command', command: '/gone/away/gsdt-worktree-guard --global' }] }] } }));
  }, [start(['-p', '1', NL], { rc: 0, env: { GSD_UPDATE_NOTICE: 'always' }, err: /GSD hook\(s\) in .* run a file that is gone/ })]);
});

test('the lock: a stale one is reclaimed', () => {
  scenario({}, (s) => {
    mkdirSync(sub(s, '.git/gsd-cmd.lock'));
    writeFileSync(sub(s, '.git/gsd-cmd.lock/pid'), '2999999\n');
  }, [start(['-p', '1', NL], { rc: 0, out: /reclaimed stale gsd lock/ })]);
});

test('guard and flow-next stop a session that must not start', () => {
  // flow = strict: attaching to a phase whose earlier artifacts are missing is still allowed for the flow's first step
  scenario({ conf: 'install = none\nflow = strict\n', phaseDirs: ['01-catalog'] }, null, [start(['-p', '1', NL])]);
  // GSD_SKIP_GUARD passes the guard
  scenario({ conf: 'install = none\nflow = strict\n' }, null, [start(['-p', '1', NL], { env: { GSD_SKIP_GUARD: '1' }, rc: 0 })]);
});

