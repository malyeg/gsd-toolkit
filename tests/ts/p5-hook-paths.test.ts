// P5 parity: src/hook-paths.ts (and staleHooks in src/provider.ts) against the
// python oracle lib/gsd_hook_paths.py and bash gsd_stale_hooks, same inputs.
// Run: node --test tests/ts/p5-hook-paths.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { hookPaths, shlexSplit } from '../../src/hook-paths.ts';
import { staleHooks } from '../../src/provider.ts';
import { PKG, bash, tmp, withEnv, write } from './helpers.ts';

const PY = path.join(PKG, 'lib', 'gsd_hook_paths.py');
const py = (argv: string[], env: Record<string, string | undefined> = {}): string => {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete e[k];
    else e[k] = v;
  }
  const r = spawnSync('python3', [PY, ...argv], { encoding: 'utf8', env: e });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const same = (label: string, argv: string[], env: Record<string, string | undefined> = {}): string => {
  const want = py(argv, env);
  const got = withEnv(env, () => hookPaths(argv));
  assert.equal(got, want, label);
  return want;
};

const hook = (command: string, event = 'PreToolUse'): string => JSON.stringify({ hooks: { [event]: [{ matcher: '', hooks: [{ type: 'command', command }] }] } });

test('shlexSplit equals python shlex.split', () => {
  const inputs = [
    '', ' ', 'a b', "a 'b c' d", 'a "b c" d', 'a\\ b', '"a\\"b"', '"a\\qb"', "'a\\b'", "''", '""', "a''b", 'x"" y', '"unclosed', "'unclosed",
    'trailing\\', '"a\\', 'tab\tsep\nnl', 'a\\\\b', '"a\\\\b"', '\\\\', "a'b'c\"d\"e", '$(x y) `z`', 'é "ü ö"', "'a\nb'", '#not a comment', 'a b', 'a\fb',
  ];
  for (const s of inputs) {
    const r = spawnSync('python3', ['-c', 'import shlex,sys,json\ntry: print(json.dumps(shlex.split(sys.argv[1])))\nexcept ValueError: print("null")', s], { encoding: 'utf8' });
    assert.deepEqual(shlexSplit(s), JSON.parse(r.stdout), JSON.stringify(s));
  }
});

test('settings files: missing, bad JSON, wrong shape', () => {
  const d = tmp();
  write(`${d}/empty.json`, '');
  write(`${d}/bad.json`, '{"hooks": ');
  write(`${d}/arr.json`, '[1,2]');
  write(`${d}/str.json`, '"x"');
  write(`${d}/null.json`, 'null');
  write(`${d}/bom.json`, `﻿${hook('node /gone/gsd-x.js')}`);
  writeFileSync(`${d}/latin1.json`, Buffer.from(`{"hooks":{"A":[{"hooks":[{"command":"node /gone/\xe9/gsd-x"}]}]}}`, 'latin1'));
  write(`${d}/dup.json`, '{"hooks":{"A":[{"hooks":[{"command":"node /gone/a/gsd-x"}]}]},"hooks":{"B":[{"hooks":[{"command":"node /gone/b/gsd-x"}]}]}}');
  write(`${d}/nan.json`, '{"x": [NaN, -Infinity, Infinity, "NaN"], "hooks":{"A":[{"hooks":[{"command":"node /gone/nan/gsd-x"}]}]}}');
  write(`${d}/nohooks.json`, '{"statusLine":{"type":"command"}}');
  write(`${d}/status.json`, '{"statusLine":{"type":"command","command":"node /gone/gsd-statusline.js"}}');
  write(`${d}/badstatus.json`, '{"statusLine":{"command":5},"hooks":{"E":"x"}}');
  write(`${d}/shapes.json`, JSON.stringify({
    hooks: {
      A: 'str', B: [1, null, 'x', { hooks: 'no', command: 'node /gone/flat/gsd-a' }, { hooks: [{ command: 3 }, null, { command: 'node /gone/n/gsd-b' }] }],
      C: [{ command: 'node /gone/flat2/gsd-c' }], D: { nope: 1 },
    },
    statusLine: { command: 'node /gone/gsd-s' },
  }));
  for (const f of ['empty', 'bad', 'arr', 'str', 'null', 'bom', 'latin1', 'nan', 'dup', 'nohooks', 'status', 'badstatus', 'shapes', 'nonexistent']) {
    same(f, [`user:${d}/${f}.json`]);
  }
  same('no argv', []);
  same('arg without a colon', [`${d}/status.json`]);
  same('empty arg', ['']);
  same('several files, numbering per file', [`user:${d}/shapes.json`, `user:${d}/status.json`, `codex:${d}/dup.json`]);
  assert.notEqual(same('shapes finds things', [`user:${d}/shapes.json`]), '');
});

test('commands: which words are judged, quoting, expansion', () => {
  const d = tmp();
  const real = write(`${d}/real dir/gsd-real.js`, '');
  symlinkSync(`${d}/nowhere`, `${d}/broken-gsd-link`);
  mkdirSync(`${d}/e`, { recursive: true });
  const cmds = [
    'node /gone/gsd-guard.js',
    'bash /gone/gsdt-rules --hook',
    '"/gone dir/gsdt-worktree-guard" --global',
    "'/gone/gsd-x'",
    '~/nope/gsd-hook.js',
    '~ gsd-x',
    '~user/gsd-x',
    '$HOME/nope/gsdt-x',
    '${HOME}/nope/gsd-x',
    '$HOMEX/nope/gsd-x',
    '$FOO/gsd-x',
    '$CLAUDE_PROJECT_DIR/.claude/hooks/gsd-x.sh',
    '${CLAUDE_PROJECT_DIR}/.claude/hooks/gsd-x.sh',
    'gsd-statusline',
    'node ./rel/gsd-x.js',
    'node /gone/other.js',
    'node "/gone/gsd-x',
    'node /gone/gsd-x\\',
    '$(for n in /gone/node /gone/node2; do [ -x $n ] && echo $n; done) /gone/gsd-core/hooks/gsd-check.js /gone/other.js',
    'echo `which node` /gone/gsd-b.js /gone/c.js',
    '/gone/a\\ b/gsd-x',
    '"/gone/a\\"b/gsd-x"',
    '"/gone/a\\qb/gsd-x"',
    "'/gone/a\\b/gsd-x'",
    '/gone/gsd-x /gone/gsd-x /gone/./gsd-x',
    "node '/gone/gsd-x\n' ok",
    "'' /gone/gsd-x",
    `node ${real}`,
    `node ${d}/real dir/gsd-real.js`,
    `node "${real}" /gone/more/gsd-x`,
    `node ${d}/broken-gsd-link`,
    `node ${d}/e`,
    'node /gone/gsd-x.js; node /gone/gsd-y.js',
    '/gone/gsd-é/x gsd-y',
    '/gone/ünï/gsdt-rules',
    'gsd-worktree-guard /gone/x',
    'node /a/b/gsd-/x',
    'node /gone/gsd-x/',
    'node /gone/GSD-x',
    'node /gone/gsdw-x',
    'node /gone/gsdtt-x',
    'node /gone/gsd-',
    'env X=1 /gone/gsd-x --opt=/gone/y',
    '',
    ' ',
  ];
  const files: string[] = [];
  cmds.forEach((c, i) => {
    write(`${d}/c${i}.json`, hook(c));
    files.push(`user:${d}/c${i}.json`);
    same(`cmd ${JSON.stringify(c)}`, [`user:${d}/c${i}.json`]);
    same(`cmd as project ${JSON.stringify(c)}`, ['--project', `${d}/proj`, `project:${d}/c${i}.json`]);
  });
  write(`${d}/all.json`, JSON.stringify({ hooks: { PreToolUse: cmds.map((c) => ({ hooks: [{ command: c }] })), SessionStart: [{ hooks: cmds.slice(0, 5).map((c) => ({ command: c })) }] }, statusLine: { command: cmds[0] } }));
  const out = same('every command in one file', [`user:${d}/all.json`]);
  assert.ok(out.split('\n').length > 10);
  same('all files in one call', files);
});

test('HOME and --project handling', () => {
  const d = tmp();
  write(`${d}/h.json`, hook('node ~/a/gsd-x ${HOME}/b/gsd-y $HOME/c/gsd-z ~'));
  write(`${d}/p.json`, hook('node $CLAUDE_PROJECT_DIR/a/gsd-x ${CLAUDE_PROJECT_DIR}/b/gsd-y'));
  for (const home of [`${d}/home`, `${d}/home/`, `${d}/home///`, '', '/', undefined]) {
    same(`HOME=${home}`, [`user:${d}/h.json`], { HOME: home });
  }
  same('project expands CLAUDE_PROJECT_DIR', ['--project', `${d}/proj`, `project:${d}/p.json`]);
  same('project path with $ in it is skipped', ['--project', '/x/$y', `project:${d}/p.json`]);
  same('empty --project', ['--project', '', `project:${d}/p.json`]);
  same('--project applies to later files only', [`project:${d}/p.json`, '--project', `${d}/proj`, `project:${d}/p.json`, `user:${d}/p.json`]);
  same('user scope never expands the project', ['--project', `${d}/proj`, `user:${d}/p.json`]);
  same('--project without a value', [`project:${d}/p.json`, '--project']);
  same('--project twice', ['--project', '/one', '--project', '/two', `project:${d}/p.json`]);
  same('file name with a colon', [`user:${d}/a:b.json`]);
  write(`${d}/a:b.json`, hook('node /gone/gsd-x'));
  same('file name with a colon (exists)', [`user:${d}/a:b.json`]);
});

test('staleHooks equals bash gsd_stale_hooks (user files, repo files, locations)', () => {
  const d = tmp();
  const r = path.join(d, 'repo');
  const stale = (name: string): string => hook(`node /gone/${name}/gsd-x.js`);
  write(`${d}/claude/settings.json`, stale('user-claude'));
  write(`${d}/codex/hooks.json`, hook('bash /gone/codex/gsdt-rules --hook', 'SessionStart'));
  write(`${r}/.claude/settings.json`, hook('node $CLAUDE_PROJECT_DIR/.claude/hooks/gsd-guard.js'));
  write(`${r}/.claude/settings.local.json`, JSON.stringify({ hooks: { A: [{ hooks: [{ command: 'node /gone/local/gsd-y' }, { command: 'node /gone/local/gsd-z' }] }] } }));
  const envs: Array<Record<string, string | undefined>> = [
    { HOME: `${d}/home` },
    { HOME: `${d}/home`, CLAUDE_CONFIG_DIR: `${d}/claude`, CODEX_HOME: `${d}/codex` },
    { HOME: `${d}/home`, GSD_CLAUDE_SETTINGS: `${d}/claude/settings.json`, GSD_CODEX_HOOKS: `${d}/codex/hooks.json` },
    { HOME: `${d}/home`, GSD_CLAUDE_SETTINGS: `${d}/nope.json`, CODEX_HOME: `${d}/codex` },
    { HOME: `${d}/home`, GSD_CODEX_HOOKS: `${d}/codex/hooks.json`, CLAUDE_CONFIG_DIR: `${d}/claude` },
  ];
  write(`${d}/home/.claude/settings.json`, stale('home-claude'));
  write(`${d}/home/.codex/hooks.json`, stale('home-codex'));
  for (const env of envs) {
    for (const repoArg of ['', r, `${d}/norepo`]) {
      const want = bash('gsd_stale_hooks "$1"', [repoArg], Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>).out;
      const got = withEnv({ GSD_CLAUDE_SETTINGS: undefined, GSD_CODEX_HOOKS: undefined, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, ...env }, () => staleHooks(repoArg));
      assert.equal(got, want, `${JSON.stringify(env)} repo=${repoArg}`);
      if (repoArg === r) assert.ok(got.includes('/gone/local/gsd-y'));
    }
  }
});
