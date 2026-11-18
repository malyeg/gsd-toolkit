// gsdt-notify (src/commands/notify.ts) and the session name (sessionResolve, providerArgv in src/provider.ts).
// Run: node --test tests/ts/p13-notify.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { noteFor, notifyArgv } from '../../src/commands/notify.ts';
import { providerArgv, sessionResolve } from '../../src/provider.ts';
import { tmp, withEnv } from './helpers.ts';

const PKG = path.resolve(import.meta.dirname, '../..');
const WIN = process.platform === 'win32';
const CLEAN = { GSD_SESSION_NAME: undefined, GSD_REMOTE_CONTROL: undefined };

/** a git repo; `conf` = its .gsd.conf ('' = none: not a set-up repo) */
function repo(name: string, conf: string): string {
  const R = `${tmp()}/${name}`;
  mkdirSync(R, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', R]);
  if (conf !== '') writeFileSync(`${R}/.gsd.conf`, conf);
  return R;
}

test('session name: prefix + phase, no ticket tag, cut short', () => {
  withEnv(CLEAN, () => {
    const R = repo('shop', 'base = main\n');
    const of = (what: string) => {
      const r = sessionResolve(R, what);
      assert.ok(r.ok);
      return r.value;
    };
    assert.deepEqual(of('phase-4-more-tk-abc123'), { name: 'shop-4-more', remote: true });
    assert.deepEqual(of('phase-01.1-hotfix'), { name: 'shop-01.1-hotfix', remote: true });
    assert.deepEqual(of('planning'), { name: 'shop-planning', remote: true });
    assert.equal(of('batch-2026-11-10-fix round 9').name, 'shop-batch-2026-11-10-fix-round-9');
    const long = of(`phase-19.2-${'open-network-approvals-'.repeat(5)}tk-869fpbf6m`).name;
    assert.ok(long.length <= 48 && !/[-.]$/.test(long), long);
    assert.ok(long.startsWith('shop-19.2-open-network-approvals'));
  });
});

test('session name: session_prefix, session_name = off, remote_control = off, env wins, bad values', () => {
  withEnv(CLEAN, () => {
    const val = (conf: string, n: string) => sessionResolve(repo(n, conf), 'phase-7-x');
    assert.deepEqual(val('session_prefix = ca\n', 'a'), { ok: true, value: { name: 'ca-7-x', remote: true } });
    assert.deepEqual(val('remote_control = off\n', 'b'), { ok: true, value: { name: 'b-7-x', remote: false } });
    assert.deepEqual(val('session_name = off\n', 'c'), { ok: true, value: { name: '', remote: false } });
    assert.equal(val('remote_control = maybe\n', 'd').ok, false);
    assert.equal(val('session_name = 1\n', 'e').ok, false);
    withEnv({ GSD_REMOTE_CONTROL: 'off' }, () => assert.deepEqual(val('remote_control = on\n', 'f'), { ok: true, value: { name: 'f-7-x', remote: false } }));
    withEnv({ GSD_SESSION_NAME: 'off' }, () => assert.deepEqual(val('base = main\n', 'g'), { ok: true, value: { name: '', remote: false } }));
  });
});

test('argv: Claude gets --name and --remote-control <name> before the prompt; others nothing', () => {
  withEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: undefined }, () => {
    const av = (p: string, s: { name: string; remote: boolean }) => {
      const r = providerArgv(p, 'x', '/gsdt-flow 7', '', '', s);
      assert.ok(r.ok);
      return r.value;
    };
    // the optional value of --remote-control is always given: a bare flag would take the prompt as the name
    assert.deepEqual(av('claude', { name: 'ca-7', remote: true }), ['x', '--name', 'ca-7', '--remote-control', 'ca-7', '/gsdt-flow 7']);
    assert.deepEqual(av('claude', { name: 'ca-7', remote: false }), ['x', '--name', 'ca-7', '/gsdt-flow 7']);
    assert.deepEqual(av('claude', { name: '', remote: true }), ['x', '/gsdt-flow 7']);
    assert.deepEqual(av('codex', { name: 'ca-7', remote: true }), ['x', '/gsdt-flow 7']);
    assert.deepEqual(av('custom', { name: 'ca-7', remote: true }), ['x', '/gsdt-flow 7']);
  });
});

test('notifyArgv: the text is an argument, never script', () => {
  const mac = notifyArgv('darwin', 'T "x"', 'b\'; do shell script "rm"') as string[];
  assert.equal(mac[0], 'osascript');
  assert.deepEqual(mac.slice(-2), ['T "x"', 'b\'; do shell script "rm"']);
  assert.ok(!mac.slice(0, -2).join(' ').includes('rm'));
  assert.deepEqual(notifyArgv('linux', 't', '-b'), ['notify-send', '--', 't', '-b']);
  assert.equal(notifyArgv('win32', 't', 'b'), null);
});

test('noteFor: only a wait, only in a set-up repo', () => {
  const R = repo('proj', 'base = main\n');
  const plain = repo('plain', '');
  const trackerOnly = repo('tonly', 'tracker = clickup\n');
  const n = (o: Record<string, unknown>) => noteFor(o, '/');
  assert.deepEqual(n({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs\n your permission', cwd: R, session_id: 's1' }), {
    title: 'GSD · proj',
    body: 'Claude needs your permission',
    session: 's1',
  });
  assert.equal(n({ hook_event_name: 'Notification', notification_type: 'idle_prompt', cwd: R })?.body, 'is waiting for you');
  assert.equal(n({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', cwd: R })?.body, 'has a question for you');
  assert.equal(n({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: R }), null);
  for (const t of ['auth_success', 'agent_completed', 'elicitation_response', 'quota_auto_resume_fired']) {
    assert.equal(n({ hook_event_name: 'Notification', notification_type: t, cwd: R }), null, t);
  }
  assert.equal(n({ hook_event_name: 'Notification', message: 'x', cwd: plain }), null);
  assert.equal(n({ hook_event_name: 'Notification', message: 'x', cwd: trackerOnly }), null);
  assert.equal(noteFor('nonsense', plain), null);
  assert.equal(noteFor(null, plain), null);
});

test('gsdt-notify --hook: silent, exit 0, runs the notifier once per session; GSD_NOTIFY=off; bad input', { skip: WIN || !['darwin', 'linux'].includes(process.platform) }, () => {
  const R = repo('hooked', 'base = main\n');
  const T = tmp();
  const stub = `${T}/stubbin`;
  const log = `${T}/notified.log`;
  mkdirSync(stub, { recursive: true });
  for (const c of ['osascript', 'notify-send']) {
    writeFileSync(`${stub}/${c}`, `#!/bin/sh\nfor a in "$@"; do last2=$last; last=$a; done\nprintf '%s|%s\\n' "$last2" "$last" >> '${log}'\n`);
    chmodSync(`${stub}/${c}`, 0o755);
  }
  const run = (input: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [`${PKG}/src/launch.mjs`, 'notify', '--hook'], {
      input,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${stub}${path.delimiter}${process.env.PATH}`, TMPDIR: T, GSD_NOTIFY: '', ...env },
    });
  const pay = (session: string) => JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs you', cwd: R, session_id: session });
  const quiet = (r: ReturnType<typeof run>) => assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', '']);
  quiet(run(pay('one')));
  quiet(run(pay('one'))); // the second hook of the same stop
  quiet(run(pay('two')));
  quiet(run(pay('three'), { GSD_NOTIFY: 'off' }));
  quiet(run('not json'));
  quiet(run(''));
  assert.equal(readFileSync(log, 'utf8'), 'GSD · hooked|needs you\nGSD · hooked|needs you\n');
  assert.ok(existsSync(log));
});
