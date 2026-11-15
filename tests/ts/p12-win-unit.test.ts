// P12 (Windows, process + path layer): the pure parts of src/spawn.ts (and its standalone copy
// src/tracker/winexec.ts), with the platform and PATH injected so this runs on any machine.
// Run: node --test tests/ts/p12-win-unit.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cmdEscapeArg, cmdLine, normalizePath, planSpawn, resolveWin, selfArgv, shellPath } from '../../src/spawn.ts';
import * as trk from '../../src/tracker/winexec.ts';

const files = new Set([
  'C:\\nodejs\\npm.cmd',
  'C:\\nodejs\\npm',
  'C:\\nodejs\\node.exe',
  'C:\\git\\usr\\bin\\sh.exe',
  'C:\\bin\\gsd_run.cmd',
  'C:\\stubs\\mytool',
  'C:\\stubs\\hook.sh',
]);
const env = { PATH: 'C:\\nodejs;C:\\bin\;C:\\stubs', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
const exists = (p: string): boolean => files.has(p);
const o = { platform: 'win32', env, exists };

test('normalizePath: win32 slashes, drive letter, trailing slash; POSIX identity', () => {
  assert.equal(normalizePath('c:\\Users\\me\\repo\\', 'win32'), 'C:/Users/me/repo');
  assert.equal(normalizePath('C:/x/y/', 'win32'), 'C:/x/y');
  assert.equal(normalizePath('c:\\', 'win32'), 'C:/');
  assert.equal(normalizePath('/', 'win32'), '/');
  assert.equal(normalizePath('/a/b/', 'linux'), '/a/b/');
  assert.equal(normalizePath('c:\\a', 'darwin'), 'c:\\a');
  assert.equal(shellPath('C:\\a\\b', 'win32'), 'C:/a/b');
  assert.equal(shellPath('/a\\b', 'linux'), '/a\\b');
});

test('resolveWin: PATH x PATHEXT, extensionless last', () => {
  assert.equal(resolveWin('npm', o), 'C:\\nodejs\\npm.cmd');
  assert.equal(resolveWin('node', o), 'C:\\nodejs\\node.exe');
  assert.equal(resolveWin('gsd_run', o), 'C:\\bin\\gsd_run.cmd');
  assert.equal(resolveWin('mytool', o), 'C:\\stubs\\mytool');
  assert.equal(resolveWin('hook.sh', o), 'C:\\stubs\\hook.sh');
  assert.equal(resolveWin('nope', o), null);
  assert.equal(resolveWin('C:\\nodejs\\npm', o), 'C:\\nodejs\\npm.cmd');
});

test('planSpawn: POSIX is untouched', () => {
  assert.deepEqual(planSpawn('npm', ['a b'], { platform: 'linux', env, exists }), { file: 'npm', args: ['a b'] });
});

test('planSpawn: .exe direct, .cmd via cmd.exe verbatim, scripts via sh', () => {
  assert.deepEqual(planSpawn('node', ['-v'], o), { file: 'C:\\nodejs\\node.exe', args: ['-v'] });
  const c = planSpawn('npm', ['view', 'x y'], { ...o, env: { ...env, ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
  assert.equal(c.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(c.windowsVerbatimArguments, true);
  assert.deepEqual(c.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(c.args[3], cmdLine('C:\\nodejs\\npm.cmd', ['view', 'x y']));
  assert.deepEqual(planSpawn('mytool', ['1'], o), { file: 'sh', args: ['C:/stubs/mytool', '1'] });
  assert.deepEqual(planSpawn('hook.sh', [], o), { file: 'sh', args: ['C:/stubs/hook.sh'] });
  assert.deepEqual(planSpawn('unknown', ['x'], o), { file: 'unknown', args: ['x'] });
});

test('cmd quoting: every metacharacter is escaped, no injection', () => {
  assert.equal(cmdEscapeArg('plain'), '^"plain^"');
  const bad = 'a" & calc.exe & "';
  const q = cmdEscapeArg(bad);
  // no unescaped & or " survives outside ^-escapes
  assert.doesNotMatch(q.replace(/\^./g, ''), /[&|<>"%!() ]/);
  assert.equal(cmdEscapeArg('50%'), '^"50^%^"');
  assert.equal(cmdEscapeArg('a|b<c>d(e)f^g!h'), '^"a^|b^<c^>d^(e^)f^^g^!h^"');
  assert.equal(cmdEscapeArg('C:\\dir with space\\'), '^"C:\\dir^ with^ space\\\\^"');
  assert.equal(cmdEscapeArg('say "hi"'), '^"say^ \\^"hi\\^"^"');
  assert.throws(() => cmdEscapeArg('a\nb'));
  assert.throws(() => cmdEscapeArg('a\0b'));
  assert.equal(cmdLine('C:\\x\\a b.cmd', ['1']), '"^"C:\\x\\a^ b.cmd^" ^"1^""');
});

test('the tracker copy behaves the same', () => {
  for (const a of ['plain', 'a" & b', '50%', 'x y\\']) assert.equal(trk.cmdEscapeArg(a), cmdEscapeArg(a));
  assert.deepEqual(trk.planSpawn('npm', ['v'], o), planSpawn('npm', ['v'], o));
  assert.deepEqual(trk.planSpawn('mytool', ['v'], o), planSpawn('mytool', ['v'], o));
  assert.deepEqual(trk.planSpawn('x', ['v'], { platform: 'linux' }), { file: 'x', args: ['v'] });
});

test('selfArgv: node + launch.mjs', () => {
  const [cmd, args] = selfArgv('tracker', ['--repo', 'r'], '/pkg');
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args, ['/pkg/src/launch.mjs', 'tracker', '--repo', 'r']);
});
