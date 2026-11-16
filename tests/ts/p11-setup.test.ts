// P11: gsdt-setup. The user hook (settings.json bytes + the hook output lines) is checked
// against saved goldens in tests/golden/p11-setup/ (regenerate with UPDATE_GOLDEN=1; review
// the diff); skills, the 0.10.x clean-up, the manifest and the bin dir are checked directly.
// Always a temp HOME / CLAUDE / CODEX / XDG.
// Run: node --test tests/ts/p11-setup.test.ts
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { test, golden, skipFileOnWindows } from './golden.ts';

skipFileOnWindows('POSIX installer parity (symlinked skills and settings, 0.10.x links, colon-separated PATH, exec bits); Windows is covered by tests/node/npm.test.ts and tests/os');
import assert from 'node:assert/strict';
import { PKG, tmp, write, subst } from './helpers.ts';

const NODE_DIR = path.dirname(process.execPath);
const BASE_PATH = `${NODE_DIR}:/usr/bin:/bin`;

type World = { root: string; home: string; bin: string; env: Record<string, string> };

/** a throwaway machine: HOME, a bin dir that holds this package's guard, and clean env */
function world(): World {
  const root = tmp();
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const env: Record<string, string> = {
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GSD_NO_CORE: '1',
    GSD_NO_UPDATE_CHECK: '1',
    PATH: BASE_PATH,
  };
  return { root, home, bin, env };
}
const linkGuard = (bin: string): void => {
  for (const n of ['gsdt-worktree-guard', 'gsdt-rules']) symlinkSync(path.join(PKG, 'bin', n), path.join(bin, n));
};

function setup(w: World, args: string[] = [], extra: Record<string, string> = {}): { out: string; err: string; rc: number } {
  const r = spawnSync('node', [path.join(PKG, 'src', 'launch.mjs'), 'setup', ...args], {
    encoding: 'utf8',
    // the tests run from a checkout, but they test the npm install's behaviour
    env: { GSD_SETUP_MODE: 'npm', ...w.env, ...extra },
  });
  return { out: r.stdout ?? '', err: r.stderr ?? '', rc: r.status ?? -1 };
}
const settingsOf = (w: World): string => path.join(w.home, '.claude', 'settings.json');
const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const norm = (s: string, w: World): string => subst(subst(s, w.home, '<H>'), w.bin, '<B>');
const unPrivate = (s: string): string => s.replace(/\/private(?=\/var\/)/g, '');
const hookLines = (s: string): string =>
  s
    .split('\n')
    .filter((l) => /user hook|valid JSON|unexpected shape|not a list|turned off/.test(l))
    .join('\n');

const OLD_HOOKS = JSON.stringify({
  hooks: {
    PreToolUse: [
      { matcher: 'Skill', hooks: [{ type: 'command', command: "[ ! -x '/home/x/.local/bin/gsd-worktree-guard' ] || exec '/home/x/.local/bin/gsd-worktree-guard' --global" }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] },
    ],
    SessionStart: [{ hooks: [{ type: 'command', command: "'/home/x/.local/bin/gsd-rules' --hook" }, { type: 'command', command: 'echo keep' }] }],
  },
});

const CASES: Array<[string, string | null]> = [
  ['missing', null],
  ['empty', ''],
  ['blank', ' \n\t\n'],
  ['object', '{}'],
  ['other settings and hooks', '{"model": "opus", "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo hi"}]}], "Stop": []}}'],
  ['old hooks in ~/.local/bin', OLD_HOOKS],
  ['disableAllHooks', '{"disableAllHooks": true, "x": 1}'],
  ['hooksConfig off', '{"hooksConfig": {"enabled": false}}'],
  ['invalid json', '{"a": '],
  ['array', '[1, 2]'],
  ['hooks null', '{"hooks": null}'],
  ['event not a list', '{"hooks": {"SessionStart": {"x": 1}}}'],
  ['numbers', '{"a": 1.0, "b": 1e5, "c": 12345678901234567890, "d": -0, "e": 0.1, "f": [1.50, 2E-3]}'],
  ['unicode', '{"name": "é ü 日本", "esc": "\\u00e9\\n", "hooks": {}}'],
  ['crlf', '{\r\n  "a": 1\r\n}\r\n'],
  ['bom', '﻿{"a": 1}'],
  ['empty hooks group', '{"hooks": {"PreToolUse": [{"hooks": []}, {"matcher": "x"}]}}'],
];

for (const modeArgs of [[], ['--no-user-hook']]) {
  for (const [name, content] of CASES) {
    test(`user hook: ${name} ${modeArgs.join(' ')}`, () => {
      const a = world();
      const b = world();
      // the same bin path on both sides: it goes into the hook command
      b.bin = a.bin;
      b.home = path.join(b.root, 'home');
      b.env = { ...b.env, HOME: b.home, CODEX_HOME: path.join(b.home, '.codex'), XDG_CONFIG_HOME: path.join(b.home, '.config') };
      for (const w of [a, b]) {
        if (content !== null) write(settingsOf(w), content);
      }
      // new side: the guard must be found in the bin dir (GSD_BIN_DIR names it)
      const r = setup(b, modeArgs, { GSD_BIN_DIR: a.bin });
      assert.equal(r.rc, 0, r.err + r.out);
      golden(unPrivate(`${read(settingsOf(b)) ?? '<missing>'}\n--\n${norm(hookLines(r.out), b)}`));
    });
  }
}

test('user hook: a symlinked settings file keeps its link and mode', () => {
  const ws = [world(), world()];
  const bins = ws[0] as World;
  const results: Array<{ link: string; dot: string | null; mode: number }> = [];
  for (const w of ws) {
    w.bin = bins.bin;
    w.home = path.join(w.root, 'home');
    w.env = { ...w.env, HOME: w.home, CODEX_HOME: path.join(w.home, '.codex'), XDG_CONFIG_HOME: path.join(w.home, '.config') };
    const dot = path.join(w.root, 'dotfiles', 's.json');
    write(dot, '{"keep": 1.0}', 0o640);
    mkdirSync(path.join(w.home, '.claude'), { recursive: true });
    symlinkSync(dot, settingsOf(w));
  }
  const r = setup(ws[1] as World, [], { GSD_BIN_DIR: bins.bin });
  assert.equal(r.rc, 0, r.err);
  for (const w of ws) {
    const dot = path.join(w.root, 'dotfiles', 's.json');
    results.push({
      link: lstatSync(settingsOf(w)).isSymbolicLink() ? 'link' : 'file',
      dot: read(dot),
      mode: statSync(dot).mode & 0o777,
    });
  }
  golden(unPrivate(JSON.stringify(results[1])));
  assert.equal(results[1]?.link, 'link');
  assert.equal(results[1]?.mode, 0o640);
  assert.match(results[1]?.dot ?? '', /"keep": 1.0/);
});

test('user hook: the bin path with a quote is skipped', () => {
  const w = world();
  const bin = path.join(w.root, "it's");
  mkdirSync(bin);
  const r = setup(w, [], { GSD_BIN_DIR: bin });
  assert.equal(r.rc, 0);
  assert.match(r.out, /user hook skipped: the bin path holds a quote/);
  assert.equal(existsSync(settingsOf(w)), false);
});

// ── bin dir ──────────────────────────────────────────────────────────────────

test('bin dir: the first PATH folder holding this package\'s guard', () => {
  const w = world();
  const foreign = path.join(w.root, 'foreign');
  mkdirSync(foreign);
  write(path.join(foreign, 'gsdt-worktree-guard'), '#!/bin/sh\n', 0o755); // not ours
  linkGuard(w.bin);
  const r = setup(w, [], { PATH: `${foreign}:${w.bin}:${BASE_PATH}` });
  assert.equal(r.rc, 0, r.err + r.out);
  const s = read(settingsOf(w)) ?? '';
  assert.ok(s.includes(`'${w.bin}/gsdt-worktree-guard' --global`), s);
  assert.ok(!s.includes(foreign));
  assert.doesNotMatch(r.out, /not on your PATH/);
  assert.match(read(path.join(w.home, '.config', 'gsd', 'setup-manifest')) ?? '', new RegExp(`\nbin\t${w.bin}\n`));
});

test('bin dir: refused when this package\'s guard is not on PATH', () => {
  const w = world();
  const r = setup(w);
  assert.equal(r.rc, 1);
  assert.match(r.err, /gsdt-worktree-guard from this package is not on PATH/);
  assert.equal(existsSync(path.join(w.home, '.claude')), false);
  assert.equal(existsSync(path.join(w.home, '.config')), false);
});

test('bin dir: GSD_BIN_DIR off PATH warns', () => {
  const w = world();
  const r = setup(w, [], { GSD_BIN_DIR: w.bin });
  assert.equal(r.rc, 0, r.err);
  assert.match(r.out, new RegExp(`⚠ ${w.bin} is not on your PATH`));
  assert.match(r.out, /Done\. Try:  gsdt-list --help/);
});

// ── arguments ────────────────────────────────────────────────────────────────

test('arguments: gemini and unknown things are refused', () => {
  const w = world();
  const g = setup(w, ['--agent', 'gemini']);
  assert.equal(g.rc, 1);
  assert.equal(g.err, 'Gemini is no longer supported (gsd-core, the new GSD, dropped it); use --agent claude or codex\n');
  assert.match(setup(w, ['--agent', 'x']).err, /^unknown provider: x$/m);
  assert.match(setup(w, ['--agent']).err, /--agent needs a provider/);
  assert.match(setup(w, ['--bogus']).err, /^unknown option: --bogus$/m);
  assert.equal(setup(w, ['--help']).rc, 0);
  assert.match(setup(w, ['-h']).out, /^gsdt-setup/);
});

// ── skills ───────────────────────────────────────────────────────────────────

const shipped = readdirSync(path.join(PKG, 'skills')).filter((n) => existsSync(path.join(PKG, 'skills', n)));
const ver = readFileSync(path.join(PKG, 'VERSION'), 'utf8').split('\n')[0];

test('skills: installed, marked, current the second time', () => {
  const w = world();
  linkGuard(w.bin);
  const r = setup(w, [], { PATH: `${w.bin}:${BASE_PATH}` });
  assert.equal(r.rc, 0, r.err);
  const dir = path.join(w.home, '.claude', 'skills');
  assert.deepEqual(readdirSync(dir).sort(), [...shipped].sort());
  for (const n of shipped) {
    const t = readFileSync(path.join(dir, n, 'SKILL.md'), 'utf8');
    const src = readFileSync(path.join(PKG, 'skills', n, 'SKILL.md'), 'utf8');
    assert.equal(t, `${src}<!-- gsd-toolkit-skill ${ver} -->\n`);
    assert.match(r.out, new RegExp(`✔ claude skill ${n} → ${dir}/${n}`));
  }
  const again = setup(w, [], { PATH: `${w.bin}:${BASE_PATH}` });
  for (const n of shipped) assert.match(again.out, new RegExp(`• claude skill ${n} already current`));
});

test('skills: our old copy is replaced in place, a foreign one is moved to .bak, a retired one goes', () => {
  const w = world();
  const dir = path.join(w.home, '.claude', 'skills');
  const [a, b] = shipped as [string, string];
  // ours, stale
  write(path.join(dir, a, 'SKILL.md'), `old\n<!-- gsd-toolkit-skill 0.0.1 -->\n`);
  // foreign dir at a shipped name
  write(path.join(dir, b, 'SKILL.md'), 'mine\n');
  // ours but no longer shipped; a foreign one stays
  write(path.join(dir, 'gsdt-gone', 'SKILL.md'), `x\n<!-- gsd-toolkit-skill 0.0.1 -->\n`);
  write(path.join(dir, 'other-skill', 'SKILL.md'), 'not ours\n');
  // a dangling link of ours (into a release runtime) is retired too
  mkdirSync(dir, { recursive: true });
  symlinkSync('/nowhere/share/gsd-toolkit/releases/0.9.0/skills/gsdt-dead', path.join(dir, 'gsdt-dead'));
  const r = setup(w, [], { GSD_BIN_DIR: w.bin });
  assert.equal(r.rc, 0, r.err);
  assert.equal(readFileSync(path.join(dir, a, 'SKILL.md'), 'utf8').includes('old\n'), false);
  assert.match(r.out, new RegExp(`✔ claude skill ${a} →`));
  assert.equal(readFileSync(path.join(dir, `${b}.bak`, 'SKILL.md'), 'utf8'), 'mine\n');
  assert.match(r.out, new RegExp(`• existing claude skill ${b} preserved at ${dir}/${b}.bak`));
  assert.equal(existsSync(path.join(dir, 'gsdt-gone')), false);
  assert.match(r.out, /✔ claude skill gsdt-gone retired/);
  assert.equal(existsSync(path.join(dir, 'other-skill', 'SKILL.md')), true);
  assert.equal(existsSync(path.join(dir, 'gsdt-dead')) || lstatSync(path.join(dir, 'gsdt-dead'), { throwIfNoEntry: false }) !== undefined, false);
  // a second foreign copy goes to .bak.1
  rmSyncQuiet(path.join(dir, b));
  write(path.join(dir, b, 'SKILL.md'), 'mine again\n');
  setup(w, [], { GSD_BIN_DIR: w.bin });
  assert.equal(readFileSync(path.join(dir, `${b}.bak.1`, 'SKILL.md'), 'utf8'), 'mine again\n');
});
function rmSyncQuiet(p: string): void {
  spawnSync('rm', ['-rf', p]);
}

test('skills: a link into a release runtime is replaced in place (no .bak)', () => {
  const w = world();
  const dir = path.join(w.home, '.claude', 'skills');
  const rt = path.join(w.root, 'share', 'gsd-toolkit', 'releases', '0.10.0');
  const n = shipped[0] as string;
  write(path.join(rt, 'install.sh'), '');
  write(path.join(rt, 'lib', 'common.sh'), '');
  write(path.join(rt, 'skills', n, 'SKILL.md'), 'x\n');
  mkdirSync(dir, { recursive: true });
  symlinkSync(path.join(rt, 'skills', n), path.join(dir, n));
  const r = setup(w, [], { GSD_BIN_DIR: w.bin });
  assert.equal(r.rc, 0, r.err);
  assert.equal(lstatSync(path.join(dir, n)).isDirectory(), true);
  assert.equal(existsSync(path.join(dir, `${n}.bak`)), false);
});

test('skills: codex goes to ~/.agents/skills; ours in the old ~/.codex/skills are removed', () => {
  const w = world();
  write(path.join(w.home, '.codex', 'skills', 'gsdt-flow', 'SKILL.md'), 'x\n<!-- gsd-toolkit-skill 0.9.0 -->\n');
  write(path.join(w.home, '.codex', 'skills', 'mine', 'SKILL.md'), 'mine\n');
  const r = setup(w, ['--agent', 'codex'], { GSD_BIN_DIR: w.bin });
  assert.equal(r.rc, 0, r.err);
  assert.ok(existsSync(path.join(w.home, '.agents', 'skills', 'gsdt-flow', 'SKILL.md')));
  assert.equal(existsSync(path.join(w.home, '.codex', 'skills', 'gsdt-flow')), false);
  assert.ok(existsSync(path.join(w.home, '.codex', 'skills', 'mine', 'SKILL.md')));
  // codex has no user hooks
  assert.equal(existsSync(settingsOf(w)), false);
  assert.equal(existsSync(path.join(w.home, '.claude')), false);
});

test('skills: a skill dir inside the package is refused', () => {
  const w = world();
  const r = setup(w, [], { GSD_BIN_DIR: w.bin, GSD_CLAUDE_SKILL_DIR: path.join(PKG, 'skills') });
  assert.equal(r.rc, 1);
  assert.match(r.err, /unsafe skill destination/);
});

// ── the 0.10.x clean-up ──────────────────────────────────────────────────────

test('0.10.x clean-up: only owned links, the runtime and the manifest go', () => {
  const w = world();
  const oldBin = path.join(w.home, '.local', 'bin');
  const share = path.join(w.home, '.local', 'share', 'gsd-toolkit');
  const rt = path.join(share, 'releases', '0.10.0');
  write(path.join(rt, 'install.sh'), '');
  write(path.join(rt, 'lib', 'common.sh'), '');
  write(path.join(rt, 'bin', 'gsdt-list'), '#!/bin/sh\n', 0o755);
  mkdirSync(oldBin, { recursive: true });
  symlinkSync(path.join(rt, 'bin', 'gsdt-list'), path.join(oldBin, 'gsdt-list'));
  symlinkSync(path.join(rt, 'bin', 'gsdt-list'), path.join(oldBin, 'gsd-start')); // an older name
  // foreign: a link elsewhere, a plain file, a non-toolkit name
  write(path.join(w.root, 'elsewhere', 'gsdt-other'), '#!/bin/sh\n', 0o755);
  symlinkSync(path.join(w.root, 'elsewhere', 'gsdt-other'), path.join(oldBin, 'gsdt-other'));
  write(path.join(oldBin, 'gsdt-file'), 'mine\n');
  symlinkSync(path.join(rt, 'bin', 'gsdt-list'), path.join(oldBin, 'tool')); // not gsd*-named
  write(path.join(oldBin, '.gsd-install-manifest'), 'providers\tclaude,codex\n');
  const r = setup(w, [], { GSD_BIN_DIR: w.bin });
  assert.equal(r.rc, 0, r.err);
  assert.equal(lstatSync(path.join(oldBin, 'gsdt-list'), { throwIfNoEntry: false }), undefined);
  assert.equal(lstatSync(path.join(oldBin, 'gsd-start'), { throwIfNoEntry: false }), undefined);
  assert.ok(lstatSync(path.join(oldBin, 'gsdt-other')).isSymbolicLink());
  assert.ok(existsSync(path.join(oldBin, 'gsdt-file')));
  assert.ok(lstatSync(path.join(oldBin, 'tool')).isSymbolicLink()); // still points into the runtime...
  // ...so the runtime stays while a link points into it
  assert.ok(existsSync(share));
  assert.equal(existsSync(path.join(oldBin, '.gsd-install-manifest')), false);
  assert.match(r.out, /✂ gsdt-list removed from /);
  assert.match(r.out, /✂ gsd-start removed from /);
  // the agents came from the old manifest
  assert.match(read(path.join(w.home, '.config', 'gsd', 'setup-manifest')) ?? '', /^providers\tclaude,codex\n/);
  // without the stray link the runtime goes
  rmSyncQuiet(path.join(oldBin, 'tool'));
  const r2 = setup(w, [], { GSD_BIN_DIR: w.bin });
  assert.equal(r2.rc, 0, r2.err);
  assert.equal(existsSync(share), false);
  assert.match(r2.out, /✂ old release runtime .* removed/);
  assert.ok(lstatSync(path.join(oldBin, 'gsdt-other')).isSymbolicLink());
  assert.ok(existsSync(path.join(oldBin, 'gsdt-file')));
});

test('0.10.x clean-up: a checkout run leaves the install alone and says so', () => {
  const w = world();
  const oldBin = path.join(w.home, '.local', 'bin');
  const share = path.join(w.home, '.local', 'share', 'gsd-toolkit');
  const rt = path.join(share, 'releases', '0.10.0');
  write(path.join(rt, 'install.sh'), '');
  write(path.join(rt, 'lib', 'common.sh'), '');
  write(path.join(rt, 'bin', 'gsdt-list'), '#!/bin/sh\n', 0o755);
  mkdirSync(oldBin, { recursive: true });
  symlinkSync(path.join(rt, 'bin', 'gsdt-list'), path.join(oldBin, 'gsdt-list'));
  write(path.join(oldBin, '.gsd-install-manifest'), 'providers\tclaude\n');
  const r = setup(w, [], { GSD_BIN_DIR: w.bin, GSD_SETUP_MODE: 'checkout' });
  assert.equal(r.rc, 0, r.err);
  assert.ok(lstatSync(path.join(oldBin, 'gsdt-list')).isSymbolicLink());
  assert.ok(existsSync(share));
  assert.ok(existsSync(path.join(oldBin, '.gsd-install-manifest')));
  assert.equal((r.out.match(/a 0\.10\.x install is in .*left in place because this is a checkout run/g) ?? []).length, 1);
  assert.doesNotMatch(r.out, /✂/);
  // no old install: no note
  const w2 = world();
  const r2 = setup(w2, [], { GSD_BIN_DIR: w2.bin, GSD_SETUP_MODE: 'checkout' });
  assert.equal(r2.rc, 0, r2.err);
  assert.doesNotMatch(r2.out, /0\.10\.x install/);
});

test('0.10.x clean-up: a link into this package stays', () => {
  const w = world();
  const oldBin = path.join(w.home, '.local', 'bin');
  mkdirSync(oldBin, { recursive: true });
  symlinkSync(path.join(PKG, 'bin', 'gsdt-list'), path.join(oldBin, 'gsdt-list'));
  const r = setup(w, [], { GSD_BIN_DIR: w.bin });
  assert.equal(r.rc, 0, r.err);
  assert.ok(lstatSync(path.join(oldBin, 'gsdt-list')).isSymbolicLink());
});

test('0.10.x clean-up: GSD_OLD_BIN_DIR names the old folder', () => {
  const w = world();
  const oldBin = path.join(w.root, 'oldbin');
  const rt = path.join(w.root, 'share', 'gsd-toolkit', 'releases', '0.10.0');
  write(path.join(rt, 'install.sh'), '');
  write(path.join(rt, 'lib', 'install.sh'), '');
  write(path.join(rt, 'bin', 'gsdt-list'), '', 0o755);
  mkdirSync(oldBin);
  symlinkSync(path.join(rt, 'bin', 'gsdt-list'), path.join(oldBin, 'gsdt-list'));
  const r = setup(w, [], { GSD_BIN_DIR: w.bin, GSD_OLD_BIN_DIR: oldBin });
  assert.equal(r.rc, 0, r.err);
  assert.equal(lstatSync(path.join(oldBin, 'gsdt-list'), { throwIfNoEntry: false }), undefined);
  assert.equal(existsSync(path.join(w.root, 'share', 'gsd-toolkit')), false);
});

// ── the manifest ─────────────────────────────────────────────────────────────

test('manifest: written, reused (agents kept), --no-user-hook removes the hooks and is remembered', () => {
  const w = world();
  const mf = path.join(w.home, '.config', 'gsd', 'setup-manifest');
  const env = { GSD_BIN_DIR: w.bin };
  const r1 = setup(w, ['--agent', 'codex'], env);
  assert.equal(r1.rc, 0, r1.err);
  assert.equal(
    read(mf),
    `providers\tcodex\ncodex_skills\t${path.join(w.home, '.agents', 'skills')}\nbin\t${w.bin}\n`,
  );
  // a second run: codex is kept; --agent claude is added (the given agents come first, as in install.sh)
  const r2 = setup(w, ['--agent', 'claude'], env);
  assert.equal(r2.rc, 0, r2.err);
  assert.equal(
    read(mf),
    `providers\tclaude,codex\nclaude_skills\t${path.join(w.home, '.claude', 'skills')}\ncodex_skills\t${path.join(w.home, '.agents', 'skills')}\nbin\t${w.bin}\n`,
  );
  assert.match(read(settingsOf(w)) ?? '', /gsdt-worktree-guard/);
  // third: no args keeps both; then --no-user-hook
  const r3 = setup(w, [], env);
  assert.match(r3.out, /• claude skill .* already current/);
  assert.match(r3.out, /• codex skill .* already current/);
  const r4 = setup(w, ['--no-user-hook'], env);
  assert.equal(r4.rc, 0, r4.err);
  assert.match(r4.out, /✂ claude user hook removed from /);
  assert.equal((read(settingsOf(w)) ?? '').includes('gsdt-'), false);
  assert.match(read(mf) ?? '', /^providers\tclaude,codex\nuser_hook\toff\n/);
  // remembered: a plain run does not put the hooks back
  setup(w, [], env);
  assert.equal((read(settingsOf(w)) ?? '').includes('gsdt-'), false);
});

test('manifest: a recorded skill dir is reused', () => {
  const w = world();
  const dir = path.join(w.root, 'myskills');
  const env = { GSD_BIN_DIR: w.bin };
  setup(w, [], { ...env, GSD_CLAUDE_SKILL_DIR: dir });
  assert.ok(existsSync(path.join(dir, shipped[0] as string, 'SKILL.md')));
  const r = setup(w, [], env);
  assert.match(r.out, new RegExp(`already current`));
  assert.equal(existsSync(path.join(w.home, '.claude', 'skills')), false);
});

test('manifest: a 0.10.x manifest gives the agents only, gemini dropped', () => {
  const w = world();
  const oldBin = path.join(w.home, '.local', 'bin');
  write(path.join(oldBin, '.gsd-install-manifest'), 'providers\tgemini,codex\ngemini_skills\t/x\ncodex_skills\t/y\n');
  const r = setup(w, [], { GSD_BIN_DIR: w.bin });
  assert.equal(r.rc, 0, r.err);
  assert.match(read(path.join(w.home, '.config', 'gsd', 'setup-manifest')) ?? '', /^providers\tcodex\n/);
  assert.ok(existsSync(path.join(w.home, '.agents', 'skills')));
});

// ── gsd-core ─────────────────────────────────────────────────────────────────

test('gsd-core: --no-core and GSD_NO_CORE skip it; otherwise npx is asked (stub)', () => {
  const w = world();
  const stub = path.join(w.root, 'stubs');
  write(path.join(stub, 'npx'), `#!/bin/sh\necho "npx $*" >> "${w.root}/npx.log"\nexit 1\n`, 0o755);
  const env = { GSD_BIN_DIR: w.bin, PATH: `${stub}:${BASE_PATH}` };
  const noEnv = { ...w, env: { ...w.env } };
  delete noEnv.env.GSD_NO_CORE;
  const skipped = setup(noEnv, ['--no-core'], env);
  assert.equal(skipped.rc, 0, skipped.err);
  assert.equal(existsSync(path.join(w.root, 'npx.log')), false);
  const viaEnv = setup(w, [], env);
  assert.equal(viaEnv.rc, 0);
  assert.equal(existsSync(path.join(w.root, 'npx.log')), false);
  const ran = setup(noEnv, [], env);
  assert.equal(ran.rc, 0, ran.err);
  assert.match(read(path.join(w.root, 'npx.log')) ?? '', /gsd-core --claude --global --profile=full/);
  assert.match(ran.out, /gsd-core for claude not installed/);
});

test('help text lists the options', () => {
  const w = world();
  const r = setup(w, ['--help']);
  for (const o of ['--agent', '--all-agents', '--no-user-hook', '--no-core']) assert.ok(r.out.includes(o), o);
});
