// P8 parity: src/claude-settings.ts against the python it replaced (the oracles are in
// tests/fixtures/p8-old-bins/: gsd_claude_env.py, baseref.py, drop_gemini_hook.py). Same inputs,
// each on its own copy: exit status, stdout, the bytes left in the file, its mode, and the folder.
// Run: node --test tests/ts/p8-claude-settings.test.ts
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baserefState, claudeEnv, removeGuardHook } from '../../src/claude-settings.ts';
import { PKG, tmp } from './helpers.ts';

const FIX = path.join(PKG, 'tests', 'fixtures', 'p8-old-bins');
const root = tmp();
let n = 0;
const fresh = (): string => {
  const d = path.join(root, `c${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const py = (args: string[], stdin?: string): { rc: number; out: string } => {
  const r = spawnSync('python3', args, { encoding: 'utf8', input: stdin, stdio: ['pipe', 'pipe', 'ignore'] });
  return { rc: r.status ?? -1, out: r.stdout };
};
const snap = (dir: string): string =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .sort()
    .map((f) => {
      const p = path.join(dir, f);
      const st = statSync(p);
      return st.isDirectory() ? `${f}/` : `${f} [${(st.mode & 0o777).toString(8)}]\n${readFileSync(p, 'latin1')}`;
    })
    .join('\n--\n');

type Content = string | Buffer | null; // null = no file
function setup(dir: string, content: Content, mode?: number): string {
  const f = path.join(dir, '.claude', 'settings.local.json');
  if (content !== null) {
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
    if (mode !== undefined) chmodSync(f, mode);
  }
  return f;
}

const INPUTS: Array<[string, Content]> = [
  ['missing', null],
  ['empty', ''],
  ['blank', ' \n\t\n'],
  ['unicode space only', ' '],
  ['object', '{}'],
  ['other keys', '{"permissions": {"allow": ["Bash(ls)"]}, "model": "x"}\n'],
  ['has env', '{"env": {"A": "1"}, "z": 1}'],
  ['same value', '{"env": {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "300000"}}'],
  ['other value', '{"env": {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1", "B": "2"}, "x": []}'],
  ['only ours', '{"env": {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1"}}'],
  ['env non-string value', '{"env": {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": 5}}'],
  ['numbers', '{"a": 1.0, "b": 1e5, "c": 123456789012345678901234567890, "d": -0, "e": 0.1, "f": 1E+2, "g": 1e-7, "h": 1.5e300, "i": 1e999, "j": -0.0, "k": 12345678901234567.0, "l": 0.0001, "m": 0.00001, "n": 1e16, "o": 123456789.123456789}'],
  ['nan', '{"a": NaN, "b": [Infinity, -Infinity]}'],
  ['nested', '{"a": {"b": {"c": []}, "d": {}}, "e": [[], {}, [1, [2]]], "f": null, "g": true, "h": false}'],
  ['duplicate keys', '{"a": 1, "b": 2, "a": 3}'],
  ['unicode', '{"n": "caf\\u00e9 é \\ud83d\\ude00 😀 \\u2028   \\/ \\u0000 \\u007f \\b\\f\\n\\r\\t \\" \\\\"}'],
  ['crlf', '{\r\n  "a": 1\r\n}\r\n'],
  ['array', '[]'],
  ['string', '"x"'],
  ['number', '1'],
  ['null', 'null'],
  ['env array', '{"env": []}'],
  ['env null', '{"env": null}'],
  ['env string', '{"env": "x"}'],
  ['invalid', '{"a": '],
  ['trailing comma', '{"a": 1,}'],
  ['trailing data', '{} {}'],
  ['single quotes', "{'a': 1}"],
  ['bom', '﻿{}'],
  ['control char', '{"a": "x\ty"}'],
  ['bad escape', '{"a": "\\x"}'],
  ['bad unicode escape', '{"a": "\\u12"}'],
  ['leading zero', '{"a": 01}'],
  ['plus', '{"a": +1}'],
  ['dot', '{"a": 1.}'],
  ['invalid utf8', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])],
];

test('claudeEnv = gsd_claude_env.py (set and remove, every input)', () => {
  for (const [label, content] of INPUTS) {
    for (const mode of [undefined, 0o600, 0o755]) {
      if (mode !== undefined && content === null) continue;
      for (const value of ['300000', undefined, 'café "q"']) {
        const a = fresh();
        const b = fresh();
        const fa = setup(a, content, mode);
        const fb = setup(b, content, mode);
        const ra = py([path.join(FIX, 'gsd_claude_env.py'), fa, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', ...(value === undefined ? [] : [value])]);
        const rb = claudeEnv(fb, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', value);
        const what = `${label} mode=${mode?.toString(8)} value=${value}`;
        assert.equal(rb, ra.rc, `${what}: exit status`);
        assert.equal(snap(b), snap(a), `${what}: what is left`);
      }
    }
  }
});

test('claudeEnv: a settings file that is a symlink is replaced by a file (python did too)', () => {
  const a = fresh();
  const b = fresh();
  for (const d of [a, b]) {
    mkdirSync(path.join(d, '.claude'), { recursive: true });
    writeFileSync(path.join(d, 'real.json'), '{"x": 1}');
    symlinkSync(path.join(d, 'real.json'), path.join(d, '.claude', 'settings.local.json'));
  }
  const ra = py([path.join(FIX, 'gsd_claude_env.py'), path.join(a, '.claude', 'settings.local.json'), 'N', 'v']);
  const rb = claudeEnv(path.join(b, '.claude', 'settings.local.json'), 'N', 'v');
  assert.equal(rb, ra.rc);
  assert.equal(existsSync(path.join(b, '.claude', 'settings.local.json')) && statSync(path.join(b, '.claude', 'settings.local.json')).isFile(), true);
  assert.equal(readFileSync(path.join(b, 'real.json'), 'utf8'), readFileSync(path.join(a, 'real.json'), 'utf8'));
  assert.equal(readFileSync(path.join(b, '.claude', 'settings.local.json'), 'utf8'), readFileSync(path.join(a, '.claude', 'settings.local.json'), 'utf8'));
});

test('claudeEnv: a directory where the file should be → 3 (python: not readable)', () => {
  const a = fresh();
  const b = fresh();
  for (const d of [a, b]) mkdirSync(path.join(d, '.claude', 'settings.local.json'), { recursive: true });
  const ra = py([path.join(FIX, 'gsd_claude_env.py'), path.join(a, '.claude', 'settings.local.json'), 'N', 'v']);
  assert.equal(claudeEnv(path.join(b, '.claude', 'settings.local.json'), 'N', 'v'), ra.rc);
});

// ── baseref ────────────────────────────────────────────────────────────────

type Layers = { local: Content; proj: Content; user: Content };
function baserefBoth(mode: 'check' | 'ensure', l: Layers, label: string): void {
  const run = (kind: 'py' | 'ts'): { out: string; tree: string } => {
    const d = fresh();
    const local = setup(d, l.local);
    const proj = path.join(d, '.claude', 'settings.json');
    if (l.proj !== null) {
      mkdirSync(path.dirname(proj), { recursive: true });
      writeFileSync(proj, l.proj);
    }
    const user = path.join(d, 'home', '.claude', 'settings.json');
    if (l.user !== null) {
      mkdirSync(path.dirname(user), { recursive: true });
      writeFileSync(user, l.user);
    }
    let out: string;
    if (kind === 'py') {
      const r2 = spawnSync('python3', ['-', mode, local, proj, user], { input: readFileSync(path.join(FIX, 'baseref.py'), 'utf8'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      out = r2.status === 0 ? r2.stdout : `${r2.stdout}invalid\n`;
    } else {
      out = `${baserefState(mode, [local, proj, user])}\n`;
    }
    return { out, tree: snap(d).replaceAll(d, '<D>') };
  };
  const a = run('py');
  const b = run('ts');
  assert.equal(b.out, a.out, `${label} ${mode}: answer`);
  assert.equal(b.tree, a.tree, `${label} ${mode}: files`);
}

test('baserefState = the baseref python (every layer combination)', () => {
  const heads = ['{"worktree": {"baseRef": "head"}}', '{"worktree": {"baseRef": "main"}}', '{"worktree": {"baseRef": 5}}', '{"worktree": {}}', '{"worktree": null}', '{"worktree": []}', '{}', '[]', 'not json', '', '{"a": 1.0, "worktree": {"x": 1e5}}\n'];
  for (const mode of ['check', 'ensure'] as const) {
    for (const l of heads) baserefBoth(mode, { local: l, proj: null, user: null }, `local ${l}`);
    baserefBoth(mode, { local: null, proj: null, user: null }, 'nothing');
    for (const l of heads) {
      baserefBoth(mode, { local: null, proj: l, user: null }, `proj ${l}`);
      baserefBoth(mode, { local: null, proj: null, user: l }, `user ${l}`);
      baserefBoth(mode, { local: '{}', proj: l, user: heads[1] as string }, `proj-over-user ${l}`);
      baserefBoth(mode, { local: l, proj: heads[1] as string, user: heads[0] as string }, `local-over-all ${l}`);
    }
    baserefBoth(mode, { local: Buffer.from([0xff, 0xfe]), proj: null, user: null }, 'bad bytes');
    baserefBoth(mode, { local: '﻿{}', proj: null, user: null }, 'bom');
  }
});

test('baserefState: a symlinked local file is written through its target path', () => {
  const run = (kind: 'py' | 'ts'): string => {
    const d = fresh();
    mkdirSync(path.join(d, '.claude'), { recursive: true });
    writeFileSync(path.join(d, 'real.json'), '{"k": 1}');
    const local = path.join(d, '.claude', 'settings.local.json');
    symlinkSync(path.join(d, 'real.json'), local);
    const user = path.join(d, 'nohome', 'settings.json');
    if (kind === 'py') spawnSync('python3', ['-', 'ensure', local, path.join(d, '.claude', 'settings.json'), user], { input: readFileSync(path.join(FIX, 'baseref.py'), 'utf8') });
    else baserefState('ensure', [local, path.join(d, '.claude', 'settings.json'), user]);
    return `${readFileSync(path.join(d, 'real.json'), 'utf8')}|${statSync(local).isFile()}|${existsSync(local)}`;
  };
  assert.equal(run('ts'), run('py'));
});

// ── removing the guard hook (drop_gemini) ──────────────────────────────────

const GUARD = 'x/scripts/hooks/gsdt-worktree-guard.sh';
const hook = (cmd: unknown): unknown => ({ type: 'command', command: cmd });
const HOOKS: Array<[string, string | Buffer]> = [
  ['only ours', JSON.stringify({ hooks: { BeforeTool: [{ matcher: 'x', hooks: [hook(GUARD)] }] } })],
  ['ours and the user\'s in one group', JSON.stringify({ model: 'm', hooks: { BeforeTool: [{ matcher: 'x', hooks: [hook(GUARD), hook('echo hi')] }] } }, null, 2)],
  ['old name', JSON.stringify({ hooks: { BeforeTool: [{ hooks: [hook('x/gsd-worktree-guard.sh')] }] } })],
  ['two events', JSON.stringify({ hooks: { A: [{ hooks: [hook(GUARD)] }], B: [{ hooks: [hook('echo')] }, { hooks: [hook(GUARD)] }] } })],
  ['not ours', JSON.stringify({ hooks: { A: [{ hooks: [hook('echo hi')] }] } })],
  ['no hooks', '{"a": 1}'],
  ['hooks array', '{"hooks": []}'],
  ['groups not a list', JSON.stringify({ hooks: { A: 'x', B: [{ hooks: [hook(GUARD)] }] } })],
  ['group without hooks list', JSON.stringify({ hooks: { A: [{ matcher: 'x' }, 'str', { hooks: [hook(GUARD)] }] } })],
  ['command not a string', JSON.stringify({ hooks: { A: [{ hooks: [hook(['x']), hook(GUARD), hook(null), 'junk'] }] } })],
  ['invalid json', '{"hooks": '],
  ['numbers kept', '{"n": 1.0, "big": 123456789012345678901234567890, "hooks": {"A": [{"hooks": [{"command": "gsdt-worktree-guard"}, {"command": "keep"}]}]}}'],
  ['bad bytes', Buffer.from([0xff])],
];

test('removeGuardHook = the drop_gemini python', () => {
  for (const [label, content] of HOOKS) {
    const run = (kind: 'py' | 'ts'): { rc: number; tree: string } => {
      const d = fresh();
      const f = path.join(d, '.gemini', 'settings.json');
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, content);
      let rc: number;
      if (kind === 'py') rc = py([path.join(FIX, 'drop_gemini_hook.py'), f]).rc === 0 ? 0 : 1;
      else rc = removeGuardHook(f) ? 0 : 1;
      return { rc, tree: snap(d) };
    };
    const a = run('py');
    const b = run('ts');
    assert.equal(b.rc, a.rc, `${label}: result`);
    assert.equal(b.tree, a.tree, `${label}: file`);
  }
});
