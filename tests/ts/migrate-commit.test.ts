// gsdt-migrate --apply: the offer to commit the repo files it changed. The
// prompt needs a terminal, so these run the command under a pty (python3
// pty.fork); the rest of the behaviour is in tests/test-migrate.sh.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PKG } from './helpers.ts';

const W = realpathSync(mkdtempSync(path.join(tmpdir(), 'gsd-mc-')));
process.on('exit', () => rmSync(W, { recursive: true, force: true }));
const BIN = path.join(PKG, 'bin', 'gsdt-migrate');
const ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: W,
  TERM: 'dumb',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GSD_NO_UPDATE_CHECK: '1',
  GSD_NO_CORE: '1',
  GSD_CLAUDE_SETTINGS: path.join(W, 'no-user-settings.json'),
};
const git = (cwd: string, ...a: string[]): string => spawnSync('git', a, { cwd, env: ENV, encoding: 'utf8' }).stdout;

// A repo with one old-name shim, committed on main.
let n = 0;
function repo(): string {
  const R = path.join(W, `r${n++}`);
  mkdirSync(path.join(R, 'scripts'), { recursive: true });
  git(R, 'init', '-q', '-b', 'main');
  copyFileSync(path.join(PKG, 'shims/scripts/gsdt-derive-port.sh'), path.join(R, 'scripts/gsd-derive-port.sh'));
  chmodSync(path.join(R, 'scripts/gsd-derive-port.sh'), 0o755);
  git(R, 'add', '-A');
  git(R, 'commit', '-q', '-m', 'old setup');
  return R;
}

const PTY = path.join(W, 'pty.py');
writeFileSync(
  PTY,
  `import os, pty, sys, select
answer, cwd, *cmd = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execv(cmd[0], cmd)
buf = b''
sent = False
while True:
    r, _, _ = select.select([fd], [], [], 30)
    if not r:
        break
    try:
        d = os.read(fd, 4096)
    except OSError:
        break
    if not d:
        break
    buf += d
    if not sent and b'[y/N] ' in buf:
        os.write(fd, answer.encode() + b'\\n')
        sent = True
_, st = os.waitpid(pid, 0)
sys.stdout.write(buf.decode('utf8', 'replace').replace('\\r\\n', '\\n'))
sys.exit(os.waitstatus_to_exitcode(st))
`,
);
const ptyRun = (R: string, answer: string, ...args: string[]): { out: string; rc: number } => {
  const r = spawnSync('python3', ['-I', PTY, answer, R, BIN, ...args], { env: ENV, encoding: 'utf8', timeout: 60000 });
  return { out: r.stdout ?? '', rc: r.status ?? -1 };
};

test('on a terminal: the prompt names the files, y commits only them, with a hash and a push hint', () => {
  const R = repo();
  writeFileSync(path.join(R, 'unrelated.txt'), 'mine\n');
  git(R, 'add', 'unrelated.txt'); // staged, not ours: must stay staged
  const { out, rc } = ptyRun(R, 'y', '--apply');
  assert.equal(rc, 0, out);
  assert.match(out, /Commit these 2 files\? \[y\/N\] /);
  assert.match(out, /files to commit \(2\):\n {2}D scripts\/gsd-derive-port\.sh\n {2}A scripts\/gsdt-derive-port\.sh\n/);
  assert.match(out, /\(1 change\(s\), committed\)/);
  assert.match(out, /^commit [0-9a-f]{7,}: Switch to gsdt-\* toolkit commands/m);
  assert.ok(out.includes(`push when ready: git -C '${R}' push`));
  assert.doesNotMatch(out, /add -A &&/);
  assert.doesNotMatch(out, /then each teammate/); // every commit here is by t@t: no teammates
  assert.equal(git(R, 'show', '--no-renames', '--name-status', '--format=', 'HEAD').trim().split('\n').sort().join('|'), 'A\tscripts/gsdt-derive-port.sh|D\tscripts/gsd-derive-port.sh');
  assert.equal(git(R, 'diff', '--cached', '--name-only').trim(), 'unrelated.txt');
});

test('on a terminal: N, or an empty answer, commits nothing and prints the path-limited command', () => {
  for (const answer of ['n', '']) {
    const R = repo();
    const { out, rc } = ptyRun(R, answer, '--apply');
    assert.equal(rc, 0, out);
    assert.match(out, /Commit these 2 files\? \[y\/N\] /);
    assert.match(out, /\(1 change\(s\), not committed\)/);
    assert.ok(out.includes(`to commit by hand:  git -C '${R}' add -A -- scripts/gsd-derive-port.sh scripts/gsdt-derive-port.sh && git -C '${R}' commit -m 'Switch to gsdt-* toolkit commands' -- scripts/gsd-derive-port.sh scripts/gsdt-derive-port.sh`), out);
    assert.equal(git(R, 'log', '--format=%s').trim(), 'old setup');
    assert.ok(existsSync(path.join(R, 'scripts/gsdt-derive-port.sh')));
  }
});

test('on a terminal: a file that was already modified means no prompt and no commit', () => {
  const R = repo();
  writeFileSync(path.join(R, 'scripts/gsd-derive-port.sh'), `${spawnSync('cat', [path.join(R, 'scripts/gsd-derive-port.sh')], { encoding: 'utf8' }).stdout}\n`);
  const { out, rc } = ptyRun(R, 'y', '--apply');
  assert.equal(rc, 0, out);
  assert.doesNotMatch(out, /\[y\/N\]/);
  assert.match(out, /had uncommitted changes before the migration:\n {2}scripts\/gsd-derive-port\.sh/);
  assert.equal(git(R, 'log', '--format=%s').trim(), 'old setup');
});

test('--help documents --commit and the prompt, and no longer says it never commits', () => {
  const r = spawnSync(BIN, ['--help'], { env: ENV, encoding: 'utf8' });
  assert.match(r.stdout, /--commit +with --apply: commit without asking/);
  assert.match(r.stdout, /Commit these N files\? \[y\/N\]/);
  assert.doesNotMatch(r.stdout, /never commits/);
});
