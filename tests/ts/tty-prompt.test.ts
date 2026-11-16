// The y/N prompts read the answer from a real terminal (a pty here).
//
// Regression (0.11.0): `gsdt-doctor --fix` printed "Run these? [y/N] Nothing
// changed." without waiting. Touching process.stdin (doctor checks
// process.stdin.isTTY) makes Node put the terminal's fd 0 in non-blocking mode;
// readSync then threw EAGAIN, which the old reader took as "no answer".
// readStdinLine (src/common.ts) waits and retries instead. No pty on Windows.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const W = realpathSync(mkdtempSync(path.join(tmpdir(), 'gsd-tty-')));
after(() => rmSync(W, { recursive: true, force: true }));
const skip = process.platform === 'win32' || spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8' }).status !== 0;

// Runs a command in a pty; types `answer` + Enter once "[y/N] " shows.
const PTY = path.join(W, 'pty.py');
writeFileSync(
  PTY,
  `import os, pty, sys, select
answer, cwd, *cmd = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(cmd[0], cmd)
buf = b''
sent = False
while True:
    r, _, _ = select.select([fd], [], [], 8 if sent else 30)
    if not r:
        os.kill(pid, 9)  # waiting on a second prompt (one answer only): stop it
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
const ptyRun = (answer: string, cwd: string, cmd: string[], env: NodeJS.ProcessEnv = process.env): { out: string; rc: number } => {
  const r = spawnSync('python3', ['-I', PTY, answer, cwd, ...cmd], { env, encoding: 'utf8', timeout: 60000 });
  return { out: r.stdout ?? '', rc: r.status ?? -1 };
};

test('readStdinLine waits for the answer even after process.stdin made fd 0 non-blocking', { skip }, () => {
  const probe = path.join(W, 'probe.mjs');
  writeFileSync(
    probe,
    `import { readStdinLine } from ${JSON.stringify(pathToFileURL(path.join(PKG, 'src', 'common.ts')).href)};
const tty = process.stdin.isTTY; // creates the tty stream: fd 0 goes non-blocking
process.stdout.write('tty=' + tty + ' Run these? [y/N] ');
const a = readStdinLine();
process.stdout.write('\\ngot=' + JSON.stringify(a) + '\\n');
`,
  );
  const { out, rc } = ptyRun('yes', W, [process.execPath, probe]);
  assert.equal(rc, 0, out);
  assert.match(out, /tty=true Run these\? \[y\/N\] /);
  assert.match(out, /^got="yes"$/m, out);
});

test('gsdt-doctor --fix: "y" at the prompt runs the fix', { skip }, () => {
  const R = path.join(W, 'repo');
  const HOME = path.join(W, 'home');
  mkdirSync(R, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME,
    XDG_CONFIG_HOME: path.join(HOME, '.config'),
    XDG_CACHE_HOME: path.join(HOME, '.cache'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    GSD_NO_UPDATE_CHECK: '1',
  };
  delete env.CLAUDE_CONFIG_DIR;
  const git = (...a: string[]): void => {
    const r = spawnSync('git', a, { cwd: R, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(R, '.gsd.conf'), 'providers = claude\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  // a lock left by a crashed run: its fix (rm -rf .git/gsd-cmd.lock) comes first in the --fix order
  mkdirSync(path.join(R, '.git', 'gsd-cmd.lock'));
  writeFileSync(path.join(R, '.git', 'gsd-cmd.lock', 'pid'), '999999\n');
  // the pty answers once; a later fix in this half-set-up repo (gsdt-init) may ask again: the pty then stops it
  const { out } = ptyRun('y', R, [path.join(PKG, 'bin', 'gsdt-doctor'), '--fix'], env);
  assert.match(out, /Run these\? \[y\/N\] y\n/, out);
  assert.doesNotMatch(out, /Nothing changed\./, out);
  assert.match(out, /▶ rm -rf \.git\/gsd-cmd\.lock/, out);
  assert.equal(existsSync(path.join(R, '.git', 'gsd-cmd.lock')), false, 'the lock was removed');
});
