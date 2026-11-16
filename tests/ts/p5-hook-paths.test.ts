// P5: src/hook-paths.ts (and staleHooks in src/provider.ts) against saved goldens in
// tests/golden/p5-hook-paths/. Regenerate with UPDATE_GOLDEN=1 (from the new code only);
// review a regenerated golden by diff.
// Run: node --test tests/ts/p5-hook-paths.test.ts
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { golden, goldenSkip, test } from './golden.ts';
import { hookPaths, shlexSplit } from '../../src/hook-paths.ts';
import { staleHooks } from '../../src/provider.ts';
import { tmp, withEnv, write } from './helpers.ts';

// A fixed fake HOME (a default HOME would leak the real user name into the goldens), and the
// temp dir spelled one way (macOS: /var/folders vs /private/var/folders).
const ACCOUNT_HOME = (() => {
  delete process.env.HOME;
  return homedir();
})();
process.env.HOME = `${tmp()}/fakehome`;
// (HOME unset falls back to the account's home: that one is named <HOME>)
const fix = (t: string): string => t.split(realpathSync(tmpdir())).join(tmpdir()).split(ACCOUNT_HOME).join('<HOME>');
const same = (label: string, argv: string[], env: Record<string, string | undefined> = {}): string => {
  const got = withEnv(env, () => hookPaths(argv));
  golden(fix(`# ${label}\n${got}`));
  return got;
};

const hook = (command: string, event = 'PreToolUse'): string => JSON.stringify({ hooks: { [event]: [{ matcher: '', hooks: [{ type: 'command', command }] }] } });

test('shlexSplit splits like a POSIX shell', () => {
  const inputs = [
    '', ' ', 'a b', "a 'b c' d", 'a "b c" d', 'a\\ b', '"a\\"b"', '"a\\qb"', "'a\\b'", "''", '""', "a''b", 'x"" y', '"unclosed', "'unclosed",
    'trailing\\', '"a\\', 'tab\tsep\nnl', 'a\\\\b', '"a\\\\b"', '\\\\', "a'b'c\"d\"e", '$(x y) `z`', 'é "ü ö"', "'a\nb'", '#not a comment', 'a b', 'a\fb',
  ];
  const nw: string[] = [];
  for (const s of inputs) {
    nw.push(`${JSON.stringify(s)} => ${JSON.stringify(shlexSplit(s))}`);
  }
  golden(nw.join('\n'));
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
  // on Windows a hook command's backslashes are path separators (hookPaths turns them into `/`), not POSIX shell escapes
  const winSkip = (c: string): boolean => process.platform === 'win32' && c.includes('\\');
  cmds.forEach((c, i) => {
    write(`${d}/c${i}.json`, hook(c));
    files.push(`user:${d}/c${i}.json`);
    if (winSkip(c)) {
      goldenSkip();
      goldenSkip();
      return;
    }
    same(`cmd ${JSON.stringify(c)}`, [`user:${d}/c${i}.json`]);
    same(`cmd as project ${JSON.stringify(c)}`, ['--project', `${d}/proj`, `project:${d}/c${i}.json`]);
  });
  write(`${d}/all.json`, JSON.stringify({ hooks: { PreToolUse: cmds.map((c) => ({ hooks: [{ command: c }] })), SessionStart: [{ hooks: cmds.slice(0, 5).map((c) => ({ command: c })) }] }, statusLine: { command: cmds[0] } }));
  if (cmds.some(winSkip)) {
    goldenSkip();
    goldenSkip();
  } else {
    const out = same('every command in one file', [`user:${d}/all.json`]);
    assert.ok(out.split('\n').length > 10);
    same('all files in one call', files);
  }
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

test('staleHooks (user files, repo files, locations)', () => {
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
      const got = withEnv({ GSD_CLAUDE_SETTINGS: undefined, GSD_CODEX_HOOKS: undefined, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, ...env }, () => staleHooks(repoArg));
      golden(fix(`# repo=${repoArg === r ? '<repo>' : repoArg === '' ? '' : '<norepo>'}\n${got}`));
      if (repoArg === r) assert.ok(got.includes('/gone/local/gsd-y'));
    }
  }
});
