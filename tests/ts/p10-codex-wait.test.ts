// gsdt-codex-wait (src/codex-wait.ts, behind bin/gsdt-codex-wait) against saved goldens in
// tests/golden/p10-codex-wait/. Each scenario runs on its own fixture dir (a CODEX_HOME, a fake
// clock file, a stub command); golden = stdout, stderr, exit code, the clock after, the stub's run
// count. Everything runs under a fake clock (GSD_CODEX_WAIT_CLOCK), in two zones (UTC,
// America/New_York), since the parser reads local time. The parser is also pinned message by
// message (`parse`, `when`, `scan`).
// Behaviour the old bash command did differently (new side only, see the last tests): "--help"
// has no "69 = no Python" words; a command that cannot start prints
// `gsdt-codex-wait: <cmd>: command not found`; no Python exit 69.
// Run: node --test tests/ts/p10-codex-wait.test.ts
// Regenerate: UPDATE_GOLDEN=1 node --test tests/ts/p10-codex-wait.test.ts; review the diff of
// tests/golden/p10-codex-wait/ by hand before committing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, golden } from './golden.ts';
import { parse, parseDuration, human, scan, when } from '../../src/codex-wait.ts';
import { PKG, subst } from './helpers.ts';

const W = realpathSync(mkdtempSync(path.join(tmpdir(), 'gsd-p10-')));
process.on('exit', () => rmSync(W, { recursive: true, force: true }));

const BINS = { neu: path.join(PKG, 'bin', 'gsdt-codex-wait') };
type Side = 'neu';

const T0 = 1760011200; // 2025-10-09 12:00:00 UTC
const RSQ = '’';
const ZONES = ['UTC', 'America/New_York'];
let seq = 0;

type Res = { out: string; err: string; rc: number; clock: number; runs: number };
type Scn = {
  args: string[]; // `$D` = the side's folder
  stub?: { limited: number; msg: string; stream?: 'err' | 'out' };
  logs?: Array<{ name: string; msg?: string; mtime?: number; raw?: string }>;
  clock?: number;
  stdin?: string;
  env?: Record<string, string>;
};

function exec(side: Side, tz: string, s: Scn): Res {
  const D = path.join(W, `${side}-${seq}`);
  mkdirSync(path.join(D, 'codex', 'sessions', '2025', '10'), { recursive: true });
  const clockF = path.join(D, 'clock');
  writeFileSync(clockF, `${s.clock ?? T0}\n`);
  if (s.stub) {
    const redir = s.stub.stream === 'out' ? '' : ' >&2';
    writeFileSync(
      path.join(D, 'stub'),
      `#!/usr/bin/env bash\necho x >> "${D}/runs"\nif [ "$(wc -l < "${D}/runs")" -le ${s.stub.limited} ]; then echo "$STUB_MSG"${redir}; exit 2; fi\necho "review: looks fine"; echo "note on stderr" >&2\n`,
      { mode: 0o755 },
    );
  }
  for (const l of s.logs ?? []) {
    const f = path.join(D, 'codex', 'sessions', '2025', '10', l.name);
    mkdirSync(path.dirname(f), { recursive: true });
    const body = l.raw ?? `${JSON.stringify({ type: 'event_msg', payload: { error: { message: l.msg } } })}\n`;
    writeFileSync(f, body);
    if (l.mtime !== undefined) utimesSync(f, l.mtime, l.mtime);
  }
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: path.join(D, 'home'),
    TZ: tz,
    CODEX_HOME: path.join(D, 'codex'),
    GSD_CODEX_WAIT_CLOCK: clockF,
    GSD_NO_UPDATE_CHECK: '1',
    STUB_MSG: s.stub?.msg ?? '',
    ...(s.env ?? {}),
  };
  const args = s.args.map((a) => a.split('$D').join(D));
  const r = spawnSync(BINS[side], args, { encoding: 'utf8', env, input: s.stdin ?? '' });
  const norm = (t: string): string => subst(subst(t, D, '<D>'), PKG, '<PKG>');
  return {
    out: norm(r.stdout ?? ''),
    err: norm(r.stderr ?? ''),
    rc: r.status ?? -1,
    clock: parseInt(readFileSync(clockF, 'utf8').trim(), 10),
    runs: existsSync(path.join(D, 'runs')) ? readFileSync(path.join(D, 'runs'), 'utf8').split('\n').filter(Boolean).length : 0,
  };
}

const resText = (r: Res): string => `rc=${r.rc} clock=${r.clock} runs=${r.runs}\n--- stdout\n${r.out}\n--- stderr\n${r.err}`;
function parity(name: string, s: Scn, check?: (r: Res) => void): void {
  for (const tz of ZONES) {
    test(`${name} [${tz}]`, () => {
      seq++;
      const n = exec('neu', tz, s);
      golden(resText(n));
      check?.(n);
    });
  }
}

const AT = (when_: string): string => `You${RSQ}ve hit your usage limit. Upgrade to Pro or try again at ${when_}.`;
const MSG_FUT = AT('Oct 9th, 2025 8:00 PM');
const MSG_PAST = AT('Oct 9th, 2025 1:00 AM');
const MSG_FAR = AT('Oct 12th, 2025 8:00 PM');
const MSG_TIME = AT('11:30 PM');
const MSG_IN = "You've hit your usage limit. Try again in 2 hours 5 minutes.";
const MSG_NOTIME = "You've hit your usage limit. Try again later.";

// ---- help and usage
parity('--help', { args: ['--help'] }, (r) => assert.match(r.out, /--wait-only/));
parity('-h', { args: ['-h'] });
parity('no args', { args: [] });
parity('--message needs a value', { args: ['--message'] });
parity('--max-wait needs a value', { args: ['--max-wait'] });
parity('bad duration', { args: ['--max-wait', 'soon', '--', 'true'] });
parity('bad duration 5ss', { args: ['--margin', '5ss', '--', 'true'] });
parity('empty duration s', { args: ['--interval', 's', '--', 'true'] });
parity('unknown option', { args: ['--nope'] });
parity('--wait-only with a command', { args: ['--wait-only', '--', 'true'] });
parity('--wait-only with --message but nothing else', { args: ['--wait-only', '--message', 'fine'] });
parity('--interval 0', { args: ['--interval', '0', '--', 'true'] });
parity('--interval 0s wait-only', { args: ['--wait-only', '--interval', '0s'] });
parity('only options, no --', { args: ['--max-wait', '1h'] });
parity('-- then nothing', { args: ['--'] });
parity('help after a bad option comes second', { args: ['--max-wait', 'x', '--help'] });
parity('help first', { args: ['--help', '--max-wait', 'x'] });

// ---- wrap mode, no limit
parity('success, streams both', { args: ['--', 'sh', '-c', 'echo to-stdout; echo to-stderr >&2'] }, (r) => {
  assert.equal(r.out, 'to-stdout\n');
  assert.equal(r.err, 'to-stderr\n');
});
parity('plain failure passes the code', { args: ['--', 'sh', '-c', 'echo nope >&2; exit 3'] }, (r) => assert.equal(r.rc, 3));
parity('plain failure, no output', { args: ['--', 'sh', '-c', 'exit 7'] }, (r) => assert.equal(r.rc, 7));
parity('limit text but exit 0 (a review quoting it)', { args: ['--', 'sh', '-c', 'echo "a review quoting: You have hit your usage limit"; exit 0'] });
// bash adds its own "line N: PID Killed" job note on stderr (not reproducible): only the code is compared
test('killed by a signal → 128+n (new side only: the old bash added a job note on stderr)', () => {
  seq++;
  const n = exec('neu', 'UTC', { args: ['--', 'sh', '-c', 'kill -9 $$'] });
  assert.equal(n.rc, 137);
  assert.equal(n.err, '');
});
parity('binary-ish output passes', { args: ['--', 'sh', '-c', 'printf "a\\tb\\n\\303\\251\\n"; printf "x\\n" >&2; exit 4'] });
parity('child arguments with spaces', { args: ['--', 'sh', '-c', 'echo "$1|$2"', '_', 'a b', 'c  d'] });
parity('a failing command with limit text on stdout but no time', { args: ['--max-wait', '1h', '--interval', '10m', '--', 'sh', '-c', 'echo "hit your usage limit"; exit 2'] });

// ---- wrap mode, limited
parity('limited once (stderr), reset today, then ok', { args: ['--', '$D/stub'], stub: { limited: 1, msg: MSG_FUT } }, (r) => {
  assert.equal(r.rc, 0);
  assert.equal(r.runs, 2);
});
parity('limited once (stdout)', { args: ['--', '$D/stub'], stub: { limited: 1, msg: MSG_FUT, stream: 'out' } });
parity('--margin 10m', { args: ['--margin', '10m', '--', '$D/stub'], stub: { limited: 1, msg: MSG_FUT } });
parity('reset in the past → short wait', { args: ['--', '$D/stub'], stub: { limited: 1, msg: MSG_PAST } });
parity('time only, "11:30 PM"', { args: ['--', '$D/stub'], stub: { limited: 1, msg: MSG_TIME } });
parity('"try again in 2 hours 5 minutes"', { args: ['--', '$D/stub'], stub: { limited: 1, msg: MSG_IN } });
parity('no time → --interval', { args: ['--interval', '45m', '--', '$D/stub'], stub: { limited: 1, msg: MSG_NOTIME } });
parity('no time → default interval', { args: ['--', '$D/stub'], stub: { limited: 1, msg: MSG_NOTIME } });
parity('limited three times', { args: ['--interval', '5m', '--', '$D/stub'], stub: { limited: 3, msg: MSG_NOTIME } });
parity('reset beyond --max-wait → 75 at once', { args: ['--', '$D/stub'], stub: { limited: 9, msg: MSG_FAR } }, (r) => assert.equal(r.rc, 75));
parity('give up after repeated waits', { args: ['--interval', '1h', '--max-wait', '3h', '--', '$D/stub'], stub: { limited: 99, msg: MSG_NOTIME } }, (r) => {
  assert.equal(r.rc, 75);
  assert.equal(r.runs, 4);
});
parity('--max-wait 1d exact', { args: ['--max-wait', '1d', '--', '$D/stub'], stub: { limited: 1, msg: AT('Oct 10th, 2025 11:30 AM') } });
parity('tiny max-wait', { args: ['--max-wait', '30s', '--', '$D/stub'], stub: { limited: 1, msg: MSG_FUT } });
parity('long wait → 60 s naps', { args: ['--', '$D/stub'], stub: { limited: 1, msg: AT('Oct 9th, 2025 11:00 PM') } });

// ---- session logs
const LOGMSG = AT('Oct 9th, 2025 9:00 PM');
parity(
  'limit hidden, found in a session log written during the run',
  { args: ['--', 'sh', '-c', 'f="$1/codex/sessions/2025/10/rollout-n.jsonl"; if [ -f "$1/ran" ]; then echo ok; else touch "$1/ran"; printf \'{"payload":{"error":{"message":"%s"}}}\\n\' "$2" > "$f"; exit 2; fi', '_', '$D', LOGMSG] },
  (r) => assert.equal(r.rc, 0),
);
parity('a failure with an old limited log → not a limit', {
  args: ['--', 'sh', '-c', 'exit 5'],
  logs: [{ name: 'rollout-old.jsonl', msg: LOGMSG, mtime: T0 - 3600 }],
}, (r) => assert.equal(r.rc, 5));
parity('--wait-only reads the newest limited log', {
  args: ['--wait-only'],
  logs: [
    { name: 'rollout-a.jsonl', msg: MSG_PAST, mtime: T0 - 7200 },
    { name: 'rollout-b.jsonl', msg: LOGMSG, mtime: T0 - 3600 },
    { name: 'rollout-c.jsonl', raw: '{"payload":{"x":"fine"}}\n', mtime: T0 - 60 },
  ],
});
parity('--wait-only, newest log is limited without a time', {
  args: ['--wait-only', '--interval', '20m'],
  logs: [{ name: 'rollout-a.jsonl', msg: LOGMSG, mtime: T0 - 7200 }, { name: 'rollout-b.jsonl', msg: MSG_NOTIME, mtime: T0 - 60 }],
});
parity('--wait-only, no logs → interval', { args: ['--wait-only', '--interval', '20m'] });
parity('--wait-only, a log older than 8 days is ignored', {
  args: ['--wait-only', '--interval', '20m'],
  logs: [{ name: 'rollout-a.jsonl', msg: LOGMSG, mtime: T0 - 9 * 86400 }],
});
parity('--wait-only, a log whose message sits in a list and nested keys', {
  args: ['--wait-only'],
  logs: [{ name: 'rollout-a.jsonl', raw: `{"a":[1,{"b":"x"}],"10":"hit your usage limit. try again at Oct 9th, 2025 6:00 PM","c":{"d":["${'y'}","hit your usage limit try again at Oct 9th, 2025 7:15 PM"]}}\n`, mtime: T0 - 100 }],
});
parity('--wait-only, a log with bad JSON lines and a good one', {
  args: ['--wait-only'],
  logs: [{ name: 'rollout-a.jsonl', raw: `not json usage limit\n{"m":"hit your usage limit try again at Oct 9th, 2025 7:15 PM"}\n{"truncated usage limit\n`, mtime: T0 - 100 }],
});
parity('--wait-only, whitespace in the logged message', {
  args: ['--wait-only'],
  logs: [{ name: 'rollout-a.jsonl', raw: `{"m":"hit   your\\n usage limit.\\t try again   at Oct 9th, 2025 7:15 PM"}\n`, mtime: T0 - 100 }],
});

// ---- --wait-only --message
parity('--message future', { args: ['--wait-only', '--message', MSG_FUT] });
parity('--message future, --margin 0', { args: ['--wait-only', '--margin', '0', '--message', MSG_FUT] });
parity('--message past', { args: ['--wait-only', '--message', MSG_PAST] }, (r) => assert.equal(r.clock, T0));
parity('--message with no limit text', { args: ['--wait-only', '--message', 'all fine'] });
parity('--message beyond --max-wait', { args: ['--wait-only', '--message', MSG_FAR] }, (r) => assert.equal(r.rc, 75));
parity('--message limit without a time', { args: ['--wait-only', '--interval', '10m', '--message', MSG_NOTIME] });
parity('--message "try again in 1 day 2 hours" capped', { args: ['--wait-only', '--max-wait', '12h', '--message', 'You have hit your usage limit. try again in 1 day 2 hours'] });
parity('--message empty', { args: ['--wait-only', '--message', ''] });
parity('--message time only, passed → tomorrow', { args: ['--wait-only', '--message', AT('1:00 AM')] });
parity('--message with a clock file that has no newline', { args: ['--wait-only', '--message', MSG_FUT] });
parity('long chain of options', { args: ['--max-wait', '2d', '--interval', '1h', '--margin', '1m', '--wait-only', '--message', MSG_FAR] });
parity('--message exactly at deadline', { args: ['--wait-only', '--max-wait', '8h', '--margin', '0', '--message', MSG_FUT] });

// ---- parser: over a table of messages
const MESSAGES = [
  MSG_FUT,
  MSG_PAST,
  MSG_TIME,
  MSG_IN,
  MSG_NOTIME,
  'nothing here',
  '',
  'hit your usage limit',
  'hit your usage limit. try again at 12:00 AM',
  'hit your usage limit. try again at 12:30 PM',
  'hit your usage limit. try again at 12:30 pm.',
  'hit your usage limit. try again at 12:30 p.m.',
  'hit your usage limit. try again at 9:05 a.m.',
  'hit your usage limit. try again at 23:15',
  'hit your usage limit. try again at 00:00',
  'hit your usage limit. try again at 1:22:33 PM',
  'hit your usage limit. try again at 14:00 AM',
  'hit your usage limit. try again at 25:00',
  'Hit Your Usage Limit. Try Again At 3:07 PM',
  'hit your usage limit. try again at Oct 11th, 2026 1:22 AM.',
  'hit your usage limit. try again at October 1st, 2026 12:00 AM',
  'hit your usage limit. try again at Sept 2nd, 2026 12:00 PM',
  'hit your usage limit. try again at Nov. 3rd, 2026 at 4:00 PM',
  'hit your usage limit. try again at Dec 22nd, 2026, 4:00 PM',
  'hit your usage limit. try again at Jan 5, 2027 9:15',
  'hit your usage limit. try again at Feb 30th, 2026 1:00 PM',
  'hit your usage limit. try again at Foo 3rd, 2026 1:00 PM',
  'hit your usage limit. try again at Dec 31st, 2025 11:59 PM',
  'hit your usage limit. try again at Mar 29th, 2026 2:30 AM',
  'hit your usage limit. try again at Nov 1st, 2026 1:30 AM',
  'hit your usage limit. try again at Jan 1st, 2000 0:00 AM',
  'hit your usage limit. try again at Oct 9th, 2025 12:00 PM',
  'hit your usage limit. try again at Oct 9th, 2025 11:59 AM',
  'hit your usage limit. try again at Oct 9th, 2025 12:00 AM',
  'hit your usage limit. try again at 12:00 PM',
  'hit your usage limit. try again at 11:59 AM',
  'hit your usage limit. try again in 3 days',
  'hit your usage limit. try again in 90 minutes',
  'hit your usage limit. try again in 1 hour 30 min',
  'hit your usage limit. try again in 4h 5m 6s',
  'hit your usage limit. try again in 2 days, 3 hours and 5 minutes',
  'hit your usage limit. try again in 0 minutes',
  'hit your usage limit. try again in 3 months',
  'hit your usage limit. try again in 45 secs.',
  'hit your usage limit. try again in 1d',
  'hit your usage limit. Try again at 5:00 PM. Later: try again in 10 minutes',
  'hit your usage limit. try again in 10 minutes. Later: try again at 5:00 PM',
  'hit your usage limit. try again at Oct 9th, 2025 6:00 PM. try again at Oct 9th, 2025 4:00 PM',
  'hit your usage limit.\ntry again at\nOct 9th,\n2025 6:00\nPM',
  'try again at 5:00 PM',
  'try again in 5 minutes',
  'hit your usage limit try again at 5:00PM',
  'hit your usage limit try again at 5:00 P M',
  'hit your usage limit try again at 5:00\tam',
  'hit your usage limit try again at 5:00 amazing',
  'hit your usage limit try again at Oct 9 2025 5:00 PM',
  'hit your usage limit try again at Oct 9th 2025, 5:00 PM',
  `You${RSQ}ve hit your usage limit. ${'x'.repeat(5000)} try again at 4:00 PM`,
];
const BASES = [T0, T0 + 3 * 3600 + 1234, 1767225540, 1774755000, 1793000000, 0, 86400 * 365];
for (const tz of ZONES) {
  test(`parser: every message × base [${tz}]`, () => {
    // TS reads TZ from the process: run it in a child so the zone is fixed for that run
    const script = `
      import { parse } from ${JSON.stringify(path.join(PKG, 'src/codex-wait.ts'))};
      const [msgs, bases] = JSON.parse(process.argv[1]);
      const res = [];
      for (const m of msgs) for (const b of bases) { const r = parse(m, b); res.push(r.rc === 0 ? [0, r.epoch] : [r.rc]); }
      process.stdout.write(JSON.stringify(res));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([MESSAGES, BASES])], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TZ: tz } });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout) as number[][];
    const lines: string[] = [];
    let i = 0;
    for (const m of MESSAGES) {
      for (const b of BASES) {
        const key = `${JSON.stringify(m.slice(0, 120))} base ${b}`;
        lines.push(`${key} => ${JSON.stringify(got[i])}`);
        i++;
      }
    }
    golden(lines.join('\n'));
  });
  test(`when() formats the local time [${tz}]`, () => {
    const epochs = [0, T0, T0 + 3600 * 5, 1774755000, 1793000000, 1772000000, 1782000000, 1700000000];
    const script = `
      import { when } from ${JSON.stringify(path.join(PKG, 'src/codex-wait.ts'))};
      process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).map(when)));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(epochs)], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TZ: tz } });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout) as string[];
    golden(epochs.map((e, i) => `${e} => ${got[i]}`).join('\n'));
  });
}

test('scan() over a folder of logs', () => {
  const home = path.join(W, 'scanhome');
  const put = (name: string, body: string, mtime: number): void => {
    const f = path.join(home, 'sessions', name);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, body);
    utimesSync(f, mtime, mtime);
  };
  const lim = (m: string): string => `${JSON.stringify({ a: { b: [m] } })}\n`;
  put('2026/a.jsonl', lim(MSG_FUT), 1760000000);
  put('2026/b.jsonl', lim(MSG_PAST) + 'broken usage limit\n', 1760005000);
  put('2026/c.jsonl', '{"x":"all fine"}\n', 1760009000);
  put('2026/d.txt', lim(MSG_FUT), 1760009500);
  put('2026/e.jsonl', '{"x":"usage limit but not the phrase"}\n', 1760009600);
  put('f.jsonl', `{"m":"hit  your\\nusage limit. try again at 5:00 PM"}\r\n`, 1760004000);
  const sinces = [0, 1759999999, 1760000000, 1760004001, 1760005000, 1760005001, 1760009999];
  const gl: string[] = [];
  for (const since of sinces) {
    const t = scan(home, since);
    gl.push(`since ${since} => ${JSON.stringify(t ? `${t.mtime}\t${t.message}` : null)}`);
  }
  golden(gl.join('\n'));
  assert.equal(scan(path.join(W, 'nowhere'), 0), null);
});

test('durations and human()', () => {
  const cases: Array<[string, number | null]> = [['90s', 90], ['30m', 1800], ['4h', 14400], ['1d', 86400], ['45', 45], ['007', 7], ['08m', 480], ['x', null], ['', null], ['s', null], ['5ss', null], ['-5', null], ['1.5h', null], ['1 h', null]];
  for (const [s, want] of cases) assert.equal(parseDuration(s), want, s);
  assert.equal(human(59), '1m');
  assert.equal(human(60), '1m');
  assert.equal(human(61), '2m');
  assert.equal(human(3599), '60m');
  assert.equal(human(3600), '1h 00m');
  assert.equal(human(7500), '2h 05m');
  assert.equal(human(90000), '25h 00m');
  assert.equal(human(0), '0m');
});

// ---- new side only
test('--help has no "69 = no Python 3.7+" words (new side only)', () => {
  const n = exec('neu', 'UTC', { args: ['--help'] });
  assert.equal(n.rc, 0);
  assert.match(n.out, /64 = bad usage\.\n/);
  assert.doesNotMatch(n.out, /Python/);
});

test('new side: a command that does not exist → 127 and a note (bash printed `line N:` text)', () => {
  const n = exec('neu', 'UTC', { args: ['--', 'no-such-command-p10'] });
  assert.equal(n.rc, 127);
  assert.equal(n.err, 'gsdt-codex-wait: no-such-command-p10: command not found\n');
  const m = exec('neu', 'UTC', { args: ['--', '/no/such/file-p10'] });
  assert.equal(m.rc, 127);
  assert.match(m.err, /No such file or directory/);
});

test('new side: without node the launcher says so and exits 1', () => {
  const r = spawnSync('/bin/bash', [BINS.neu, '--help'], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'gsdt-codex-wait: needs Node.js >= 24 (node not found on PATH)\n');
});

test('new side: no python needed (python absent from PATH)', () => {
  const bin = path.join(W, 'nopy');
  mkdirSync(bin, { recursive: true });
  for (const t of ['node', 'bash', 'date', 'sh', 'cat', 'uname', 'dirname', 'readlink']) {
    const w = spawnSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
    if (w) spawnSync('ln', ['-sf', w, path.join(bin, t)]);
  }
  const clock = path.join(W, 'nopy-clock');
  writeFileSync(clock, `${T0}\n`);
  const r = spawnSync(BINS.neu, ['--wait-only', '--message', MSG_FUT], { encoding: 'utf8', env: { PATH: bin, TZ: 'UTC', GSD_CODEX_WAIT_CLOCK: clock } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /done waiting/);
});
