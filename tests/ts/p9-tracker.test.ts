// P9 parity (gsdt-tracker): the TypeScript command behind bin/gsdt-tracker against the pre-P9
// bash command (tests/fixtures/p9-old-bins/gsdt-tracker + a copy of lib/tracker/, which stays
// in place as its library), each side on its own copy of the same fixture (a HOME, a plain repo,
// a GSD repo, custom-tracker repos, a folder outside any repo, a curl stub that fakes ClickUp and
// logs every argv). Every step runs on both; compared: stdout, stderr, exit code, then the curl
// log, the custom script's log, the token files (content + mode) and each repo's git config.
// Only the side roots and the package dirs are normalized.
// Known gaps (new side only, see the last tests): a snapshot --out into a missing folder (bash
// prints its own `line N:` redirect error), an octal-looking --page, a malformed JSON reply.
// Run: node --test tests/ts/p9-tracker.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PKG, LOCALE_ENV } from './helpers.ts';

const W = realpathSync(mkdtempSync(path.join(tmpdir(), 'gsd-p9-')));
process.on('exit', () => rmSync(W, { recursive: true, force: true }));

const OLDPKG = path.join(W, 'oldpkg');
mkdirSync(path.join(OLDPKG, 'bin'), { recursive: true });
writeFileSync(path.join(OLDPKG, 'bin', 'gsdt-tracker'), readFileSync(path.join(PKG, 'tests/fixtures/p9-old-bins/gsdt-tracker')));
chmodSync(path.join(OLDPKG, 'bin', 'gsdt-tracker'), 0o755);
cpSync(path.join(PKG, 'lib', 'tracker'), path.join(OLDPKG, 'lib', 'tracker'), { recursive: true });
const BINS = { old: path.join(OLDPKG, 'bin', 'gsdt-tracker'), neu: path.join(PKG, 'bin', 'gsdt-tracker') };

// A fake ClickUp API. Logs every argv (US-separated) and "METHOD PATH BODY"; prints body + http code.
const CURL = `#!/usr/bin/env bash
printf 'ARGV:' >> "$CURL_LOG.argv"; printf '%s\\037' "$@" >> "$CURL_LOG.argv"; printf '\\n' >> "$CURL_LOG.argv"
m=GET; body=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) m=$2; shift ;; -d) body=$2; shift ;; -w|--max-time) shift ;; http*) url=$1 ;;
    -H) case "$2" in Authorization:*) auth=$2; printf '%s\\n' "$2" >> "$CURL_LOG.auth" ;; esac; shift ;;
  esac
  shift
done
path=\${url#https://api.clickup.com/api/v2}
printf '%s %s %s\\n' "$m" "$path" "$body" >> "$CURL_LOG"
[ -z "\${CURL_DEAD:-}" ] || exit 7
[ "\${auth:-}" != "Authorization: pk_bad" ] || { printf '{"err":"Token invalid"}\\n401'; exit 0; }
code=200
case "$m $path" in
  "GET /task/abc123?include_subtasks=true")
    out='{"status":{"status":"to do"},"list":{"id":"L1","name":"Backlog"},"subtasks":[
      {"id":"sub1","status":{"status":"to do","type":"open"},"date_closed":null},
      {"id":"sub2","status":{"status":"complete","type":"closed"},"date_closed":"1"},
      {"id":"sub3","status":{"status":"Completed","type":"open"},"date_closed":null},
      {"id":"sub4","status":{"status":"in progress","type":"open"},"date_closed":null}]}' ;;
  "GET /task/done123?include_subtasks=true")
    out='{"status":{"status":"In-Progress"},"list":{"id":"L1","name":"Backlog"},"subtasks":[]}' ;;
  "GET /task/nolist1?include_subtasks=true")
    out='{"status":{"status":"to do"},"list":{"id":"L9","name":"Other"}}' ;;
  "GET /list/L1") out='{"statuses":[{"status":"to do"},{"status":"In-Progress"},{"status":"In-Testing"}]}' ;;
  "GET /task/abc123?include_markdown_description=true")
    out='{"name":"Cart é","url":"https://app.clickup.com/t/abc123","status":{"status":"to do"},"markdown_description":"As a buyer I keep a cart.\\nSecond line."}' ;;
  "GET /task/abc123/comment") out='{"comments":[{"comment_text":"looks good"},{"comment_text":""},{"comment_text":"two\\nlines"}]}' ;;
  "GET /task/nodesc1?include_markdown_description=true") out='{"name":"Bare","status":{"status":"open"},"description":""}' ;;
  "GET /task/nodesc1/comment") out='{"comments":[]}' ;;
  "GET /task/flat77?include_markdown_description=true") out='{"name":"Flat","url":"u","status":{"status":"open"},"description":"plain desc"}' ;;
  "GET /task/flat77/comment") code=500; out='{"err":"boom"}' ;;
  "GET /user") out='{"user":{"id":7}}' ;;
  "GET /team")
    if [ -n "\${MULTI_TEAM:-}" ]; then out='{"teams":[{"id":"T1","name":"Acme","members":[]},{"id":"T2","name":"Beta","members":[]}]}'
    elif [ -n "\${NO_TEAM:-}" ]; then out='{"teams":[]}'
    else out='{"teams":[{"id":"T1","name":"Acme","members":[{"user":{"id":42,"username":"Sara","email":"sara@x.io"}},{"user":{"id":43,"username":"Bob"}}]}]}'; fi ;;
  "GET /team/T1/task?page=0"*)
    if [ -n "\${MANY:-}" ]; then
      out='{"tasks":['; for i in $(seq 1 100); do out="$out{\\"id\\":\\"m$i\\",\\"name\\":\\"Many $i\\",\\"status\\":{\\"status\\":\\"open\\"},\\"list\\":{\\"name\\":\\"L\\"}},"; done
      out="\${out%,}]}"
    else
      out='{"tasks":[{"id":"t1","name":"Fix login","status":{"status":"to do"},"list":{"name":"Sprint"}},
      {"id":"t2","name":"Cart totals","status":{"status":"in progress"},"list":{"name":"Sprint"}},
      {"id":"t3","name":"Ünï login","status":{"status":"done"}}]}'
    fi ;;
  "GET /team/T1/task?page="*) out='{"tasks":[]}' ;;
  "GET /team/T1/space") out='{"spaces":[{"id":"S1","name":"Eng"},{"id":"S2","name":"Ops"}]}' ;;
  "GET /space/S1/folder") out='{"folders":[{"id":"F1","name":"Web","lists":[{"id":"901","name":"Sprint"}]},{"id":"F2","name":"Empty"}]}' ;;
  "GET /space/S1/list") out='{"lists":[{"id":"902","name":"Inbox"}]}' ;;
  "GET /space/S2/folder") out='{"folders":[]}' ;;
  "GET /space/S2/list") out='{"lists":[]}' ;;
  "POST /list/901/task") out='{"id":"new1","url":"https://app.clickup.com/t/new1"}' ;;
  "PUT /task/failput"*) code=403; out='{"err":"nope"}' ;;
  PUT*|POST*|DELETE*) out='{}' ;;
  *) out='{"err":"not found"}'; code=404 ;;
esac
printf '%s\\n%s' "$out" "$code"
`;

const SCRIPT = `#!/usr/bin/env bash
printf '%s|%s|status=%s|profile=%s\\n' "$1" "$*" "\${GSD_TRACKER_STATUS-UNSET}" "\${GSD_TRACKER_PROFILE-UNSET}" >> "$TRACKER_LOG"
case "\${2:-}" in FAIL-*) exit 1 ;; esac
[ "$1" != snapshot ] || printf '# Ticket %s\\n\\nproduct words\\n' "$2"
[ "$1" != check ] || { printf 'stdin:'; cat; echo; }
[ "\${2:-}" != STDIN ] || cat
`;

type Side = { root: string; home: string; env: Record<string, string> };
const sh = (cwd: string, ...a: string[]): void => void spawnSync('git', a, { cwd, stdio: 'ignore' });
function repo(dir: string, conf?: string): void {
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i');
  if (conf !== undefined) writeFileSync(path.join(dir, '.gsd.conf'), conf);
}

function makeSide(name: string): Side {
  const root = path.join(W, name);
  const home = path.join(root, 'home');
  mkdirSync(path.join(root, 'stub'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(root, 'stub', 'curl'), CURL);
  chmodSync(path.join(root, 'stub', 'curl'), 0o755);
  repo(path.join(root, 'plain'));
  repo(path.join(root, 'gsd'), 'install = none\n');
  repo(path.join(root, 'cust'), 'install = none\ntracker = custom\ntracker_command = scripts/tracker.sh\n');
  writeFileSync(path.join(root, 'cust', 'scripts-placeholder'), '');
  mkdirSync(path.join(root, 'cust', 'scripts'));
  writeFileSync(path.join(root, 'cust', 'scripts', 'tracker.sh'), SCRIPT, { mode: 0o755 });
  repo(path.join(root, 'cu'), 'install = none\ntracker = clickup\ntracker_profile = confprof\n');
  mkdirSync(path.join(root, 'nogit'));
  sh(path.join(root, 'plain'), 'worktree', 'add', '-q', '-b', 'wt', path.join(root, 'wt'));
  mkdirSync(path.join(root, 'wt', 'deep'), { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(GSD_|CLICKUP_|CURL_|TRACKER_|MANY|MULTI_TEAM|NO_TEAM|CLAUDE_|CODEX_)/.test(k)) env[k] = v;
  Object.assign(env, {
    PATH: `${path.join(root, 'stub')}:${process.env.PATH}`,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...LOCALE_ENV,
    CURL_LOG: path.join(root, 'curl.log'),
    TRACKER_LOG: path.join(root, 'tracker.log'),
  });
  return { root, home, env };
}

type Step = { a: string[]; cwd?: string; env?: Record<string, string>; stdin?: string };
type Res = { out: string; err: string; rc: number };
const norm = (s: string, side: Side): string => s.split(side.root).join('<ROOT>').split(OLDPKG).join('<PKG>').split(PKG).join('<PKG>').replace(/\.tmp\.\d+/g, '.tmp.<pid>');

function exec(side: Side, bin: string, st: Step): Res {
  const r = spawnSync(bin, st.a, { cwd: path.join(side.root, st.cwd ?? 'gsd'), env: { ...side.env, ...(st.env ?? {}) }, input: st.stdin ?? '', encoding: 'utf8', timeout: 60000 });
  return { out: norm(r.stdout ?? '', side), err: norm(r.stderr ?? '', side), rc: r.status ?? -1 };
}

function files(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const o: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) o.push(...files(p, base));
    else o.push(`${path.relative(base, p)} ${(statSync(p).mode & 0o777).toString(8)} ${readFileSync(p, 'utf8')}`);
  }
  return o;
}
function state(side: Side): string {
  const parts = [`curl.log:\n${read(path.join(side.root, 'curl.log'), side)}`, `argv:\n${read(path.join(side.root, 'curl.log.argv'), side)}`, `tracker.log:\n${read(path.join(side.root, 'tracker.log'), side)}`];
  parts.push(`home:\n${files(side.home).join('\n---\n')}`);
  for (const r of ['plain', 'gsd', 'cust', 'cu']) parts.push(`${r} git config:\n${spawnSync('git', ['config', '--local', '--list'], { cwd: path.join(side.root, r), encoding: 'utf8' }).stdout.split('\n').filter((l) => /tracker/.test(l)).join('\n')}`);
  return norm(parts.join('\n'), side);
}
const read = (f: string, side: Side): string => (existsSync(f) ? norm(readFileSync(f, 'utf8'), side) : '');

/** Run the steps on both sides (fresh sides per scenario); compare every result and the final state. */
function parity(title: string, steps: Step[], opts: { before?: (s: Side) => void } = {}): void {
  test(title, () => {
    const o = makeSide(`o-${counter}`);
    const n = makeSide(`n-${counter++}`);
    opts.before?.(o);
    opts.before?.(n);
    steps.forEach((st, i) => {
      const ro = exec(o, BINS.old, st);
      const rn = exec(n, BINS.neu, st);
      const why = `step ${i}: ${JSON.stringify(st.a)} ${JSON.stringify(st.env ?? {})}`;
      assert.equal(rn.out, ro.out, `stdout — ${why}`);
      assert.equal(rn.err, ro.err, `stderr — ${why}`);
      assert.equal(rn.rc, ro.rc, `exit code — ${why}`);
    });
    assert.equal(state(n), state(o), 'files / logs / git config');
  });
}
let counter = 0;
const tok = { CLICKUP_API_TOKEN: 'pk_test', GSD_CLICKUP_CONFIG: '/dev/null' };
const ENV = (extra: Record<string, string> = {}): Record<string, string> => ({ ...tok, ...extra });

// ── usage, help, parsing ──────────────────────────────────────────────────────────────
parity('help, usage, bad global options', [
  { a: ['--help'] },
  { a: ['-h'] },
  { a: [] },
  { a: ['--repo'] },
  { a: ['--tracker'] },
  { a: ['--tracker', 'bogus', 'which'] },
  { a: ['--tracker', 'bogus', 'check'] },
  { a: ['--tracker', 'CLICKUP', 'which'] },
  { a: ['--repo', '', 'which'] },
  { a: ['--repo', '/nonexistent', 'which'] },
  { a: ['--repo', '/nonexistent', 'config'] },
  { a: ['--tracker', 'none', '--help'] },
  { a: ['which'], cwd: 'nogit' },
  { a: ['which'], cwd: 'plain' },
  { a: ['which'], cwd: 'wt/deep' },
  { a: ['config'], cwd: 'wt/deep' },
  { a: ['frobnicate'] },
  { a: ['frobnicate'], cwd: 'plain' },
  { a: ['frobnicate'], cwd: 'cust' },
  { a: ['lists'], cwd: 'cust' },
  { a: ['login'], cwd: 'gsd' },
]);

const EXTRACTS = ['### Phase 7: cart tk-PROJ-42', 'Phase 2.1: bug tk-abc123 (INSERTED)', 'phase-7-cart-tk-proj-42', 'cart cu_869e33cv4', 'CU-869e33cv4 x', 'cart ClickUp 869e33cv4', 'ClickUp   abcdef12 and more', 'plain stuck title', '', 'tk-', 'xtk-ab', 'TK-A-b-C d', 'tk-a_b', 'two\nlines tk-second', 'first tk-one\ntk-two', 'cu_short', 'cu-abcdef', 'ClickUp short', '(tk-x1)', 'tk-ab-', 'tk-é'];
parity('extract', [
  ...EXTRACTS.map((s) => ({ a: ['extract', s] })),
  { a: ['extract'] },
  { a: ['extract'], cwd: 'plain' },
]);

// ── ids through every verb, for none ─────────────────────────────────────────────────
const IDS = ['abc123', 'tk-PROJ-42', 'TK-x', 'cu_869e33cv4', 'CU-12', 'CU-869e33cv4', '#42', 'https://app.clickup.com/t/869e33cv4', 'https://x.atlassian.net/browse/PROJ-42?focus=1', 'https://x/y/#frag', 'https://x/y/z/', 'a b', 'x;rm', '', 'a--b', '-a', 'x'.repeat(64), 'x'.repeat(65), 'a\nb c', 'ok\n../etc', '#', 'tk-'];
parity('none: every verb, every id', [
  ...IDS.flatMap((id) => [
    { a: ['start', id, 'text'] },
    { a: ['finish', id, 'text'], cwd: 'plain', env: { GSD_TRACKER: 'none' } },
    { a: ['comment', id, 'text'] },
    { a: ['status', id, 'done'] },
    { a: ['snapshot', id] },
    { a: ['update', id, '--name', 'x'] },
  ]),
  { a: ['start', 'abc'] },
  { a: ['start'] },
  { a: ['comment', 'a'] },
  { a: ['snapshot'] },
  { a: ['update', 'a', 'b'] },
  { a: ['update', 'a'] },
  { a: ['create', 'L'] },
  { a: ['create', 'L', 'T'] },
  { a: ['tasks'] },
  { a: ['check'] },
  { a: ['snapshot', 'abc', '--out'] },
  { a: ['snapshot', 'abc', '--out', 'x.md'] },
  { a: ['start', 'abc', 'text', 'extra', 'args'] },
]);

// ── custom ────────────────────────────────────────────────────────────────────────────
parity('custom: every verb, status, profile, failures', [
  { a: ['start', 'PROJ-42', 'claimed it'], cwd: 'cust' },
  { a: ['finish', 'PROJ-42', 'done it', 'extra'], cwd: 'cust', env: { GSD_TRACKER_STATUS_START: 'Doing', GSD_TRACKER_STATUS_FINISH: 'Shipped', GSD_TRACKER_PROFILE: 'work' } },
  { a: ['start', 'PROJ-42', 'x'], cwd: 'cust', env: { GSD_CLICKUP_STATUS_START: 'Legacy' } },
  { a: ['finish', 'PROJ-42', 'x'], cwd: 'cust', env: { GSD_CLICKUP_STATUS_FINISH: 'LegacyF', GSD_TRACKER_STATUS_FINISH: '' } },
  { a: ['comment', 'https://x/browse/PROJ-42', 'a comment'], cwd: 'cust' },
  { a: ['status', 'tk-PROJ-42', 'In QA'], cwd: 'cust' },
  { a: ['snapshot', 'PROJ-42'], cwd: 'cust' },
  { a: ['snapshot', 'PROJ-42', 'rest'], cwd: 'cust' },
  { a: ['snapshot', 'FAIL-1'], cwd: 'cust' },
  { a: ['start', 'FAIL-1', 'x'], cwd: 'cust' },
  { a: ['check'], cwd: 'cust', stdin: 'typed in' },
  { a: ['create', 'PROJ', 'New thing', '--label', 'x'], cwd: 'cust' },
  { a: ['update', 'https://x/browse/PROJ-42', '--title', 'y'], cwd: 'cust' },
  { a: ['update', 'CU-123', '--title', 'y'], cwd: 'cust' },
  { a: ['tasks', '--mine'], cwd: 'cust' },
  { a: ['tasks'], cwd: 'cust' },
  { a: ['lists'], cwd: 'cust' },
  { a: ['api', 'GET', '/x'], cwd: 'cust' },
  { a: ['--tracker', 'custom', 'which'], cwd: 'gsd' },
  { a: ['--tracker', 'custom', 'check'], cwd: 'gsd' },
  { a: ['--tracker', 'CUSTOM', 'check'], cwd: 'gsd', env: { GSD_TRACKER_STATUS_START: 'x' } },
  { a: ['config'], cwd: 'cust' },
  { a: ['config'], cwd: 'cust', env: { GSD_TRACKER_PROFILE: 'p1' } },
  { a: ['start', 'STDIN', 'x'], cwd: 'cust', stdin: 'piped to script' },
]);
parity('custom: missing, relative, ~, absolute and non-executable commands', [
  { a: ['check'], cwd: 'gsd', env: { GSD_TRACKER: 'custom' } },
  { a: ['config'], cwd: 'gsd', env: { GSD_TRACKER: 'custom' } },
  { a: ['check'], cwd: 'cust', env: { GSD_TRACKER_STATUS_START: 'x' } },
], {
  before: (s) => {
    writeFileSync(path.join(s.root, 'gsd', '.git', 'config'), `${readFileSync(path.join(s.root, 'gsd', '.git', 'config'), 'utf8')}[gsdt-tracker]\n\tcommand = ~/mytrk.sh\n`);
    writeFileSync(path.join(s.home, 'mytrk.sh'), '#!/bin/sh\necho "home script $*"\n', { mode: 0o755 });
  },
});
parity('custom: non-executable, a directory, a bad interpreter', [
  { a: ['check'], cwd: 'cust' },
  { a: ['start', 'A', 'b'], cwd: 'cust' },
  { a: ['config'], cwd: 'cust' },
], { before: (s) => chmodSync(path.join(s.root, 'cust', 'scripts', 'tracker.sh'), 0o644) });
parity('custom: a script that hangs is stopped', [
  { a: ['start', 'PROJ-42', 'x'], cwd: 'cust', env: { GSD_TRACKER_TIMEOUT: '1' } },
  { a: ['check'], cwd: 'cust', env: { GSD_TRACKER_TIMEOUT: '1.9' } },
], { before: (s) => writeFileSync(path.join(s.root, 'cust', 'scripts', 'tracker.sh'), '#!/usr/bin/env bash\nexec sleep 30\n', { mode: 0o755 }) });
parity('custom: a timeout of 0 or text means no timeout', [
  { a: ['check'], cwd: 'cust', env: { GSD_TRACKER_TIMEOUT: '0' } },
  { a: ['check'], cwd: 'cust', env: { GSD_TRACKER_TIMEOUT: 'soon' } },
  { a: ['check'], cwd: 'cust', env: { GSD_TRACKER_TIMEOUT: '5s' } },
]);
parity('custom: snapshot --out', [
  { a: ['snapshot', 'PROJ-42', '--out', 'out.md'], cwd: 'cust' },
  { a: ['snapshot', 'FAIL-1', '--out', 'bad.md'], cwd: 'cust' },
  { a: ['snapshot', 'PROJ-9', '--out'], cwd: 'cust' },
  { a: ['snapshot', 'PROJ-9', '--out', '../cust/abs.md'], cwd: 'cust' },
  { a: ['snapshot', 'PROJ-9', 'extra', '--out', 'x.md'], cwd: 'cust' },
  { a: ['check'], cwd: 'cust' },
]);
parity('custom: snapshot --out of an empty ticket is a failure', [{ a: ['snapshot', 'PROJ-1', '--out', 'e.md'], cwd: 'cust' }], {
  before: (s) => writeFileSync(path.join(s.root, 'cust', 'scripts', 'tracker.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }),
});

// ── clickup ─────────────────────────────────────────────────────────────────────────────
parity('clickup: start and finish (statuses, subtasks, idempotence, list reminder)', [
  { a: ['start', 'abc123', 'starting'], cwd: 'plain', env: ENV() },
  { a: ['finish', 'abc123', 'done with "quotes" é \\ and\nnewline\ttab \u0001 \u007f 😀'], cwd: 'plain', env: ENV() },
  { a: ['start', 'done123', 'again'], cwd: 'plain', env: ENV() },
  { a: ['finish', 'done123', 'x'], cwd: 'plain', env: ENV() },
  { a: ['start', 'nolist1', 'x'], cwd: 'plain', env: ENV({ GSD_CLICKUP_ENG_LIST: 'L1' }) },
  { a: ['start', 'abc123', 'x'], cwd: 'plain', env: ENV({ GSD_CLICKUP_ENG_LIST: 'L1' }) },
  { a: ['start', 'abc123', 'x'], cwd: 'plain', env: ENV({ GSD_TRACKER_STATUS_START: 'Doing' }) },
  { a: ['start', 'abc123', 'x'], cwd: 'plain', env: ENV({ GSD_TRACKER_STATUS_START: 'in-progress' }) },
  { a: ['finish', 'abc123', 'x'], cwd: 'plain', env: ENV({ GSD_CLICKUP_STATUS_FINISH: 'TO DO' }) },
  { a: ['start', 'missing9', 'x'], cwd: 'plain', env: ENV() },
  { a: ['finish', 'CU-abc123', 'x'], cwd: 'plain', env: ENV() },
  { a: ['start', 'https://app.clickup.com/t/abc123', 'x'], cwd: 'plain', env: ENV() },
  { a: ['start', 'abc123', 'x'], cwd: 'plain', env: { GSD_CLICKUP_CONFIG: '/dev/null' } },
  { a: ['start', 'abc123', 'x'], cwd: 'plain', env: { CLICKUP_API_TOKEN: 'pk_bad' } },
  { a: ['start', 'abc123', 'x'], cwd: 'plain', env: ENV({ CURL_DEAD: '1' }) },
  { a: ['start', 'abc123'], cwd: 'plain', env: ENV() },
]);
parity('clickup: comment, status, check', [
  { a: ['comment', 'abc123', 'hello'], cwd: 'plain', env: ENV() },
  { a: ['comment', 'failput1', 'hello'], cwd: 'plain', env: ENV() },
  { a: ['status', 'abc123', 'In QA é'], cwd: 'plain', env: ENV() },
  { a: ['status', 'failput1', 'x'], cwd: 'plain', env: ENV() },
  { a: ['check'], cwd: 'plain', env: ENV() },
  { a: ['check'], cwd: 'plain', env: { CLICKUP_API_TOKEN: 'pk_bad', GSD_CLICKUP_CONFIG: '/dev/null' } },
  { a: ['check'], cwd: 'plain', env: ENV({ CURL_DEAD: '1' }) },
  { a: ['check'], cwd: 'plain', env: { GSD_CLICKUP_CONFIG: '/dev/null' } },
  { a: ['check'], cwd: 'plain', env: { GSD_CLICKUP_CONFIG: '/dev/null', GSD_TRACKER_PROFILE: 'work' } },
  { a: ['check'], cwd: 'plain', env: { GSD_CLICKUP_CONFIG: '/dev/null', GSD_TRACKER_PROFILE: 'bad/name' } },
  { a: ['check'], cwd: 'plain', env: { GSD_TRACKER_PROFILE: 'work' } },
  { a: ['--tracker', 'clickup', 'check'], cwd: 'gsd', env: ENV() },
  { a: ['check'], cwd: 'gsd', env: ENV({ GSD_TRACKER: 'clickup', GSD_TRACKER_PROFILE: 'work' }) },
  { a: ['check'], cwd: 'cu', env: { GSD_TRACKER_PROFILE: '' } },
  { a: ['check'], cwd: 'cu', env: {} },
]);
parity('clickup: the token file (plain assignments, export, quotes, other lines, mode)', [
  { a: ['check'], cwd: 'plain', env: {} },
  { a: ['check'], cwd: 'plain', env: { GSD_TRACKER_PROFILE: 'p1' } },
  { a: ['check'], cwd: 'plain', env: { GSD_TRACKER_PROFILE: 'p2' } },
  { a: ['check'], cwd: 'plain', env: { GSD_TRACKER_PROFILE: 'p3' } },
  { a: ['check'], cwd: 'plain', env: { GSD_TRACKER_PROFILE: 'p4' } },
  { a: ['check'], cwd: 'plain', env: { GSD_TRACKER_PROFILE: 'p5' } },
  { a: ['config'], cwd: 'plain', env: { GSD_TRACKER_PROFILE: 'p5' } },
  { a: ['members'], cwd: 'plain', env: { GSD_TRACKER_PROFILE: 'p6' } },
  { a: ['config'], cwd: 'plain', env: { GSD_TRACKER_PROFILE: 'p7' } },
], {
  before: (s) => {
    const d = path.join(s.home, '.config', 'gsd');
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'clickup.env'), 'CLICKUP_API_TOKEN=pk_shared\n');
    writeFileSync(path.join(d, 'clickup-p1.env'), '# comment\nexport CLICKUP_API_TOKEN="pk_quoted"\nOTHER=1\n');
    writeFileSync(path.join(d, 'clickup-p2.env'), "CLICKUP_API_TOKEN='pk_single'\n");
    writeFileSync(path.join(d, 'clickup-p3.env'), 'CLICKUP_API_TOKEN=pk_trailing # note\n');
    writeFileSync(path.join(d, 'clickup-p4.env'), '  CLICKUP_API_TOKEN=pk_indented\r\n');
    writeFileSync(path.join(d, 'clickup-p5.env'), 'NOPE=1\n');
    writeFileSync(path.join(d, 'clickup-p6.env'), 'CLICKUP_API_TOKEN=pk_team\nCLICKUP_TEAM_ID=T1\n');
    writeFileSync(path.join(d, 'clickup-p7.env'), 'CLICKUP_API_TOKEN=\n');
  },
});

const ALL_TASK_ENV = ENV();
parity('clickup: snapshot, with and without --out', [
  { a: ['snapshot', 'abc123'], cwd: 'plain', env: ALL_TASK_ENV },
  { a: ['snapshot', 'nodesc1'], cwd: 'plain', env: ALL_TASK_ENV },
  { a: ['snapshot', 'flat77'], cwd: 'plain', env: ALL_TASK_ENV },
  { a: ['snapshot', 'missing9'], cwd: 'plain', env: ALL_TASK_ENV },
  { a: ['snapshot', 'abc123', '--out', 'ticket.md'], cwd: 'plain', env: ALL_TASK_ENV },
  { a: ['snapshot', 'missing9', '--out', 'bad.md'], cwd: 'plain', env: ALL_TASK_ENV },
  { a: ['snapshot', 'abc123', '--out', 'ticket2.md'], cwd: 'plain', env: ALL_TASK_ENV },
  { a: ['snapshot', 'abc123', '--out'], cwd: 'plain', env: ALL_TASK_ENV },
  { a: ['snapshot', 'abc123', '--out', 'x.md'], cwd: 'plain', env: { GSD_CLICKUP_CONFIG: '/dev/null' } },
  { a: ['snapshot', 'abc123', '--out', 'dead.md'], cwd: 'plain', env: ENV({ CURL_DEAD: '1' }) },
]);

parity('clickup: create, update (every option, errors)', [
  { a: ['create', '901', 'New thing'], cwd: 'plain', env: ENV() },
  { a: ['create', '901', 'Néw "thing"\n2', '--desc', 'body\n\n', '--assign', 'me', '--assign', '42', '--status', 'open', '--priority', '2', '--tag', 'a', '--tag', 'b c', '--parent', 'CU-abc123'], cwd: 'plain', env: ENV() },
  { a: ['create', '901', 'T', '--assign', 'sara@x.io'], cwd: 'plain', env: ENV() },
  { a: ['create', '901', 'T', '--assign', 'SARA'], cwd: 'plain', env: ENV() },
  { a: ['create', '901', 'T', '--assign', 'nobody'], cwd: 'plain', env: ENV() },
  { a: ['create', '901', 'T', '--assign', 'bob'], cwd: 'plain', env: ENV({ CLICKUP_TEAM_ID: 'T1' }) },
  { a: ['create', '901', 'T', '--desc', '-'], cwd: 'plain', env: ENV(), stdin: 'from stdin\n\n' },
  { a: ['create', '901', 'T', '--priority', '5'], cwd: 'plain', env: ENV() },
  { a: ['create', '901', 'T', '--priority', '12'], cwd: 'plain', env: ENV() },
  { a: ['create', '901', 'T', '--priority'], cwd: 'plain', env: ENV() },
  { a: ['create', '901', 'T', '--bogus', 'x'], cwd: 'plain', env: ENV() },
  { a: ['create', '901', 'T', '--parent', 'a b'], cwd: 'plain', env: ENV() },
  { a: ['create', 'abc', 'T'], cwd: 'plain', env: ENV() },
  { a: ['create', '999', 'T'], cwd: 'plain', env: ENV() },
  { a: ['update', 'abc123', '--name', 'N'], cwd: 'plain', env: ENV() },
  { a: ['update', 'abc123', '--name', 'N', '--desc', 'D', '--assign', 'me', '--assign', 'sara', '--unassign', '42', '--unassign', 'bob', '--status', 's', '--priority', '1', '--parent', 'tk-p1'], cwd: 'plain', env: ENV() },
  { a: ['update', 'abc123', '--desc', '-'], cwd: 'plain', env: ENV(), stdin: 'stdin desc' },
  { a: ['update', 'abc123', '--priority', 'x'], cwd: 'plain', env: ENV() },
  { a: ['update', 'abc123', '--name'], cwd: 'plain', env: ENV() },
  { a: ['update', 'abc123', '--bogus', 'x'], cwd: 'plain', env: ENV() },
  { a: ['update', 'abc123', '--unassign', 'ghost'], cwd: 'plain', env: ENV() },
  { a: ['update', 'failput1', '--name', 'x'], cwd: 'plain', env: ENV() },
  { a: ['update', 'a b', '--name', 'x'], cwd: 'plain', env: ENV() },
  { a: ['update', 'abc123', '--status', 'x', '--assign', 'me'], cwd: 'plain', env: ENV({ MULTI_TEAM: '1' }) },
  { a: ['create', '901', 'T', '--assign', 'sara'], cwd: 'plain', env: ENV({ MULTI_TEAM: '1' }) },
  { a: ['create', '901', 'T', '--assign', 'sara'], cwd: 'plain', env: ENV({ NO_TEAM: '1' }) },
]);

parity('clickup: tasks (filters, paging, --match), lists, members, api', [
  { a: ['tasks'], cwd: 'plain', env: ENV() },
  { a: ['tasks', '--closed', '--list', '901', '--list', '902', '--status', 'in progress', '--status', 'Ünï/x y!', '--tag', "a'b", '--assign', 'sara', '--assign', 'me', '--assign', '9'], cwd: 'plain', env: ENV() },
  { a: ['tasks', '--match', 'LOGIN'], cwd: 'plain', env: ENV() },
  { a: ['tasks', '--match', 'ünï'], cwd: 'plain', env: ENV() },
  { a: ['tasks', '--match', 'zzz'], cwd: 'plain', env: ENV() },
  { a: ['tasks', '--page', '3'], cwd: 'plain', env: ENV() },
  { a: ['tasks', '--page', '010'], cwd: 'plain', env: ENV({ CLICKUP_TEAM_ID: 'T1' }) },
  { a: ['tasks', '--page', 'x'], cwd: 'plain', env: ENV() },
  { a: ['tasks', '--list', 'x'], cwd: 'plain', env: ENV() },
  { a: ['tasks', '--bogus', 'x'], cwd: 'plain', env: ENV() },
  { a: ['tasks', '--bogus'], cwd: 'plain', env: ENV() },
  { a: ['tasks', '--status'], cwd: 'plain', env: ENV() },
  { a: ['tasks'], cwd: 'plain', env: ENV({ MANY: '1' }) },
  { a: ['tasks', '--page', '2'], cwd: 'plain', env: ENV({ MANY: '1' }) },
  { a: ['tasks', '--match', 'many 7'], cwd: 'plain', env: ENV({ MANY: '1' }) },
  { a: ['tasks'], cwd: 'plain', env: ENV({ MULTI_TEAM: '1' }) },
  { a: ['tasks'], cwd: 'plain', env: ENV({ CLICKUP_TEAM_ID: 'T1' }) },
  { a: ['lists'], cwd: 'plain', env: ENV() },
  { a: ['lists'], cwd: 'plain', env: ENV({ NO_TEAM: '1' }) },
  { a: ['lists'], cwd: 'plain', env: ENV({ CURL_DEAD: '1' }) },
  { a: ['members'], cwd: 'plain', env: ENV() },
  { a: ['members'], cwd: 'plain', env: ENV({ MULTI_TEAM: '1' }) },
  { a: ['members'], cwd: 'plain', env: ENV({ CLICKUP_TEAM_ID: 'T2', MULTI_TEAM: '1' }) },
  { a: ['api', 'GET', '/user'], cwd: 'plain', env: ENV() },
  { a: ['api', 'POST', '/task/abc123/comment', '{"comment_text":"hi"}'], cwd: 'plain', env: ENV() },
  { a: ['api', 'PUT', '/x', 'null'], cwd: 'plain', env: ENV() },
  { a: ['api', 'PUT', '/x', 'false'], cwd: 'plain', env: ENV() },
  { a: ['api', 'PUT', '/x', 'true'], cwd: 'plain', env: ENV() },
  { a: ['api', 'PUT', '/x', '0'], cwd: 'plain', env: ENV() },
  { a: ['api', 'PUT', '/x', ' '], cwd: 'plain', env: ENV() },
  { a: ['api', 'PUT', '/x', 'nope'], cwd: 'plain', env: ENV() },
  { a: ['api', 'DELETE', '/x'], cwd: 'plain', env: ENV() },
  { a: ['api', 'GET', '/nothing'], cwd: 'plain', env: ENV() },
  { a: ['api', 'GET', 'user'], cwd: 'plain', env: ENV() },
  { a: ['api', 'GET', '/a b'], cwd: 'plain', env: ENV() },
  { a: ['api', 'PATCH', '/x'], cwd: 'plain', env: ENV() },
  { a: ['api', 'GET'], cwd: 'plain', env: ENV() },
  { a: ['api'], cwd: 'plain', env: ENV() },
  { a: ['lists'], cwd: 'plain', env: { GSD_CLICKUP_CONFIG: '/dev/null' } },
  { a: ['--tracker', 'none', 'lists'], cwd: 'plain', env: ENV() },
  { a: ['lists'], cwd: 'gsd', env: ENV() },
  { a: ['--tracker', 'clickup', 'members'], cwd: 'gsd', env: ENV() },
]);

// ── login, piped ─────────────────────────────────────────────────────────────────────────
const gsdFile = (s: Side, name: string, text: string): void => {
  mkdirSync(path.join(s.home, '.config', 'gsd'), { recursive: true });
  writeFileSync(path.join(s.home, '.config', 'gsd', name), text, { mode: 0o644 });
};
parity('login: piped token, new/replace/keep other lines, repo and no repo', [
  { a: ['login', 'solo'], cwd: 'plain', env: { GSD_CLICKUP_CONFIG: '' }, stdin: 'pk_solo\n' },
  { a: ['login', 'solo'], cwd: 'plain', env: { GSD_CLICKUP_CONFIG: '' }, stdin: 'pk_solo\n' },
  { a: ['login', 'solo'], cwd: 'plain', env: { GSD_CLICKUP_CONFIG: '' }, stdin: '  pk_spaced  \r\nignored\n' },
  { a: ['login', 'withother'], cwd: 'plain', stdin: 'pk_new\n' },
  { a: ['login', 'bad'], cwd: 'plain', stdin: 'pk_bad\n' },
  { a: ['login', 'badchars'], cwd: 'plain', stdin: 'pk;rm -rf\n' },
  { a: ['login', 'empty'], cwd: 'plain', stdin: '\n' },
  { a: ['login', 'noeol'], cwd: 'plain', stdin: 'pk_noeol' },
  { a: ['login', 'nothing'], cwd: 'plain', stdin: '' },
  { a: ['login', '.hidden'], cwd: 'plain', stdin: 'pk_x\n' },
  { a: ['login', 'a/b'], cwd: 'plain', stdin: 'pk_x\n' },
  { a: ['login', 'x', 'y'], cwd: 'plain', stdin: 'pk_x\n' },
  { a: ['login', 'dead'], cwd: 'plain', stdin: 'pk_x\n', env: { CURL_DEAD: '1' } },
  { a: ['login'], cwd: 'nogit', stdin: 'pk_x\n' },
  { a: ['login', 'solo2'], cwd: 'nogit', stdin: 'pk_x\n' },
  { a: ['login'], cwd: 'plain', stdin: 'pk_auto\n' },
  { a: ['login'], cwd: 'wt/deep', stdin: 'pk_wt\n' },
  { a: ['login'], cwd: 'gsd', stdin: 'pk_gsd\n' },
  { a: ['login'], cwd: 'cu', stdin: 'pk_cu\n' },
  { a: ['login', 'confprof'], cwd: 'cu', stdin: 'pk_cu2\n' },
  { a: ['login', 'other'], cwd: 'cu', stdin: 'pk_cu3\n', env: { GSD_TRACKER_PROFILE: 'zzz', GSD_CLICKUP_CONFIG: '/x/y.env', CLICKUP_API_TOKEN: 'pk_env' } },
  { a: ['--repo', '/nonexistent', 'login', 'viarepo'], cwd: 'plain', stdin: 'pk_x\n', env: { GSD_TRACKER: 'clickup' } },
  { a: ['--repo', 'cu', 'login'], cwd: 'plain', stdin: 'pk_repoflag\n' },
  { a: ['--tracker', 'clickup', 'login', 'viaflag'], cwd: 'gsd', stdin: 'pk_x\n' },
  { a: ['--tracker', 'none', 'login', 'x'], cwd: 'gsd', stdin: 'pk_x\n' },
  { a: ['check'], cwd: 'plain', env: { GSD_CLICKUP_CONFIG: '' } },
  { a: ['config'], cwd: 'plain', env: { GSD_CLICKUP_CONFIG: '' } },
], {
  before: (s) => {
    gsdFile(s, 'clickup-withother.env', '# mine\nexport CLICKUP_API_TOKEN=old\nTEAM=1\nCLICKUP_API_TOKEN=older\nCLICKUP_TEAM_ID=T1');
    gsdFile(s, 'clickup-solo2.env', 'CLICKUP_API_TOKEN=pk_old\n');
  },
});

// ── precedence: env > git config > .gsd.conf > default, legacy names ──────────────────────
const gitcfg = (s: Side, r: string, ...kv: string[]): void => void spawnSync('git', ['config', '--local', ...kv], { cwd: path.join(s.root, r) });
parity('settings: env > git config > .gsd.conf > default, legacy names', [
  ...['plain', 'gsd', 'cu', 'cust'].flatMap((cwd) => [
    { a: ['config'], cwd },
    { a: ['which'], cwd },
    { a: ['config'], cwd, env: { GSD_TRACKER: 'CustoM', GSD_TRACKER_PROFILE: 'ep', GSD_TRACKER_STATUS_START: 'S1', GSD_TRACKER_STATUS_FINISH: 'F1' } },
    { a: ['config'], cwd, env: { GSD_CLICKUP_STATUS_START: 'LS', GSD_CLICKUP_STATUS_FINISH: 'LF' } },
    { a: ['config'], cwd, env: { GSD_TRACKER: 'clickup', GSD_CLICKUP_CONFIG: '/some/where.env' } },
    { a: ['config'], cwd, env: { GSD_TRACKER: 'clickup', CLICKUP_API_TOKEN: 'x' } },
    { a: ['config'], cwd, env: { GSD_TRACKER: 'bogus', GSD_TRACKER_PROFILE: 'bad name' } },
    { a: ['--tracker', 'NONE', 'which'], cwd, env: { GSD_TRACKER: 'clickup' } },
  ]),
  { a: ['config'], cwd: 'wt/deep' },
  { a: ['--repo', 'cu', 'config'], cwd: 'nogit' },
  { a: ['--repo', '../cu', 'config'], cwd: 'plain', env: { GSD_TRACKER: 'clickup' } },
], {
  before: (s) => {
    gitcfg(s, 'gsd', 'gsdt-tracker.tracker', 'Custom');
    gitcfg(s, 'gsd', 'gsdt-tracker.profile', 'gitprof');
    gitcfg(s, 'gsd', 'gsdt-tracker.command', 'scripts/x.sh');
    gitcfg(s, 'gsd', 'gsdt-tracker.statusStart', 'GitStart');
    gitcfg(s, 'cu', 'gsd-tracker.tracker', 'custom'); // the pre-0.10.0 section
    gitcfg(s, 'cu', 'gsd-tracker.statusFinish', 'OldFin');
    gitcfg(s, 'cust', 'gsdt-tracker.tracker', 'none');
    gitcfg(s, 'plain', 'gsdt-tracker.tracker', 'clickup');
    gitcfg(s, 'plain', 'gsd-tracker.profile', 'legacyprof');
    gitcfg(s, 'plain', 'gsdt-tracker.statusFinish', '');
    writeFileSync(path.join(s.root, 'cu', '.gsd.conf'), 'install = none\n  tracker = clickup   # team\ntracker_profile = confprof\ntracker_command = ~/c.sh\ntracker_status_start = Conf Start #x\ntracker_status_finish = ConfFin\ntracker_profile2 = no\n');
    writeFileSync(path.join(s.root, 'cust', '.gsd.conf'), 'tracker=custom\r\ntracker_command=scripts/tracker.sh\r\ntracker_status_start=\r\n');
  },
});
parity('settings: git config wins over .gsd.conf, a profile from each place reaches the token file name', [
  { a: ['config'], cwd: 'cu' },
  { a: ['check'], cwd: 'cu', env: {} },
], { before: (s) => gitcfg(s, 'cu', 'gsdt-tracker.profile', 'gp') });

// ── a tty: login through expect ────────────────────────────────────────────────────────────
const hasExpect = spawnSync('expect', ['-c', 'exit 0']).status === 0;
function expectCase(title: string, setup: (s: Side) => void, prof: string, ans: string, tokenText: string, cwd = 'plain'): void {
  test(`tty login (expect): ${title}`, { skip: !hasExpect }, () => {
    const exp = path.join(W, `login-${counter}.exp`);
    writeFileSync(exp, 'spawn {*}$env(CMD) login $env(PROF)\nexpect {\n  -ex {[U/r] }    { send "$env(ANS)\\r"; exp_continue }\n  -ex {hidden): } { send "$env(TOK)\\r"; exp_continue }\n  eof\n}\nlassign [wait] a b c rc\nexit $rc\n');
    const o = makeSide(`eo-${counter}`);
    const n = makeSide(`en-${counter++}`);
    setup(o);
    setup(n);
    const go = (s: Side, bin: string): Res => {
      const r = spawnSync('expect', [exp], { cwd: path.join(s.root, cwd), env: { ...s.env, CLICKUP_API_TOKEN: '', GSD_CLICKUP_CONFIG: '', CMD: bin, PROF: prof, ANS: ans, TOK: tokenText }, encoding: 'utf8', timeout: 60000 });
      return { out: norm((r.stdout ?? '').replace(/\r/g, ''), s), err: '', rc: r.status ?? -1 };
    };
    const ro = go(o, BINS.old);
    const rn = go(n, BINS.neu);
    assert.equal(rn.out, ro.out);
    assert.equal(rn.rc, ro.rc);
    assert.equal(state(n), state(o));
  });
}
const saved = (s: Side): void => gsdFile(s, 'clickup-solo.env', 'CLICKUP_API_TOKEN=pk_solo\n');
expectCase('a new token is typed hidden', () => undefined, 'brandnew', '', 'pk_brand');
expectCase('a saved token: Enter keeps it', saved, 'solo', '', 'pk_unused');
expectCase('a saved token: u keeps it', saved, 'solo', 'u', 'pk_unused');
expectCase('a saved token: r replaces it', saved, 'solo', 'r', 'pk_fresh');
expectCase('a saved token: a wrong answer asks again', saved, 'solo', 'x', 'pk_fresh');
expectCase('a saved token ClickUp refuses asks for a new one', (s) => gsdFile(s, 'clickup-stale.env', 'CLICKUP_API_TOKEN=pk_bad\n'), 'stale', 'u', 'pk_fresh');
expectCase('a refused typed token saves nothing', () => undefined, 'refused', '', 'pk_bad');
expectCase('no repo: a name is needed', () => undefined, '', '', 'pk_x', 'nogit');

// ── standalone: the new command needs only its own files ─────────────────────────────────
test('new side: runs from a package holding only bin/gsdt-tracker, launch.mjs, commands/tracker.ts, tracker/', () => {
  const S = path.join(W, 'solo');
  mkdirSync(path.join(S, 'bin'), { recursive: true });
  mkdirSync(path.join(S, 'src', 'commands'), { recursive: true });
  cpSync(path.join(PKG, 'bin', 'gsdt-tracker'), path.join(S, 'bin', 'gsdt-tracker'));
  cpSync(path.join(PKG, 'src', 'launch.mjs'), path.join(S, 'src', 'launch.mjs'));
  cpSync(path.join(PKG, 'src', 'commands', 'tracker.ts'), path.join(S, 'src', 'commands', 'tracker.ts'));
  cpSync(path.join(PKG, 'src', 'tracker'), path.join(S, 'src', 'tracker'), { recursive: true });
  const side = makeSide('solo-side');
  const r = spawnSync(path.join(S, 'bin', 'gsdt-tracker'), ['which'], { cwd: path.join(side.root, 'nogit'), env: side.env, encoding: 'utf8' });
  assert.equal(r.stdout, 'clickup\n');
  const h = spawnSync(path.join(S, 'bin', 'gsdt-tracker'), ['--help'], { env: side.env, encoding: 'utf8' });
  assert.match(h.stdout, /^\ngsdt-tracker — read and write tickets/);
});

// ── known gaps: new side only ────────────────────────────────────────────────────────────
test('new side: snapshot --out into a missing folder fails with the "not written" error (bash adds its own redirect error)', () => {
  const n = makeSide('gap1');
  const r = exec(n, BINS.neu, { a: ['snapshot', 'PROJ-1', '--out', 'nodir/x.md'], cwd: 'cust' });
  assert.equal(r.rc, 1);
  assert.match(r.err, /gsdt-tracker: snapshot of ticket PROJ-1 failed — nodir\/x\.md not written\n$/);
  assert.equal(existsSync(path.join(n.root, 'cust', 'nodir')), false);
});
test('new side: --page 08 (octal, an error in bash) exits 1 without calling the tasks API', () => {
  const n = makeSide('gap2');
  const r = exec(n, BINS.neu, { a: ['tasks', '--page', '08'], cwd: 'plain', env: ENV({ CLICKUP_TEAM_ID: 'T1' }) });
  assert.equal(r.rc, 1);
  assert.match(r.err, /value too great for base/);
});
test('new side: no jq or python is needed (the bash adapter died without them)', () => {
  const n = makeSide('gap3');
  const bare = path.join(W, 'barebin');
  mkdirSync(bare, { recursive: true });
  const link = (name: string): void => {
    const p = spawnSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
    if (p) spawnSync('ln', ['-sf', p, path.join(bare, name)]);
  };
  for (const t of ['node', 'git', 'bash', 'env', 'sh', 'ln', 'dirname', 'readlink', 'cat', 'sed', 'grep', 'tr', 'seq', 'awk', 'head']) link(t);
  const r = exec({ ...n, env: { ...n.env, PATH: `${path.join(n.root, 'stub')}:${bare}` } }, BINS.neu, { a: ['comment', 'abc123', 'hi'], cwd: 'plain', env: ENV() });
  assert.equal(r.rc, 0);
  assert.equal(r.out, "✔ ClickUp abc123 → comment posted\n");
});
