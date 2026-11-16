// Tickets: id parsing, gsdt-tracker with none / custom / clickup, --tracker clickup, and the ticket paths
// through gsdt-start, gsdt-finish and gsdt-doctor.
// CI-safe: the ClickUp API is a curl stub, gsd_run (GSD) and gh are stubbed, and remotes are local bare repos.
// Port of tests/test-tracker.sh. Run: node --test tests/node/tracker.test.ts
import { after, describe, it } from 'node:test';
import { closeSync, cpSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  GH_JS, GSD_RUN_JS, HOME, LAUNCH, PKG, W, WIN, assertionCount, commit, countLines, envOf, exists, fails, fwd, git, gitOk, gitOut, gsdt, has, hasnt, is, linesOf,
  ok, project, read, readLf, run, setBaseEnv, setStubDirs, stubNode, worktreeOf, write,
} from './g3-helpers.ts';
import type { Run } from './g3-helpers.ts';
import { ticketExtract, ticketNorm, ticketTagged, trackerWhich } from '../../src/ticket.ts';
import { trkIdExtract, trkIdNorm } from '../../src/tracker/ids.ts';

after(() => console.log(`# tracker: ${assertionCount()} assertions`));

// ── stubs ────────────────────────────────────────────────────────────────────
const STUB = path.join(W, 'stub');
const CURL_LOG = path.join(W, 'curl.log');
const AUTH_LOG = path.join(W, 'auth.log');
const TRACKER_LOG = path.join(W, 'tracker.log');
const EMPTY_ENV = path.join(W, 'empty.env');
writeFileSync(EMPTY_ENV, '');

const GSD_RUN = stubNode(STUB, 'gsd_run', GSD_RUN_JS);
stubNode(STUB, 'gh', GH_JS);
// curl: a fake ClickUp API. Logs "METHOD PATH BODY"; prints body + http code (the adapter passes -w '\n%{http_code}').
stubNode(
  STUB,
  'curl',
  `const fs = require('fs');
const a = process.argv.slice(2);
let m = 'GET', body = '', url = '', auth = '';
for (let i = 0; i < a.length; i++) {
  const x = a[i];
  if (x === '-X') m = a[++i];
  else if (x === '-d') body = a[++i];
  else if (x === '-w' || x === '--max-time') i++;
  else if (x.startsWith('http')) url = x;
  else if (x === '-H') {
    const h = a[++i];
    if (h.startsWith('Authorization:')) {
      auth = h;
      if (process.env.CURL_AUTH_LOG) fs.appendFileSync(process.env.CURL_AUTH_LOG, h + '\\n');
    }
  }
}
const p = url.replace('https://api.clickup.com/api/v2', '');
fs.appendFileSync(process.env.CURL_LOG, m + ' ' + p + ' ' + body + '\\n');
// pk_bad: a token ClickUp refuses
if (auth === 'Authorization: pk_bad') { process.stdout.write('{"err":"Token invalid"}\\n401'); process.exit(0); }
let code = 200, out;
const k = m + ' ' + p;
if (k === 'GET /task/abc123?include_subtasks=true') out = '{"status":{"status":"to do"},"list":{"id":"L1","name":"Backlog"},"subtasks":[{"id":"sub1","status":{"status":"to do","type":"open"},"date_closed":null},{"id":"sub2","status":{"status":"complete","type":"closed"},"date_closed":"1"}]}';
else if (k === 'GET /task/done123?include_subtasks=true') out = '{"status":{"status":"In-Progress"},"list":{"id":"L1","name":"Backlog"},"subtasks":[]}';
else if (k === 'GET /list/L1') out = '{"statuses":[{"status":"to do"},{"status":"In-Progress"},{"status":"In-Testing"}]}';
else if (k === 'GET /task/abc123?include_markdown_description=true') out = '{"name":"Cart","url":"https://app.clickup.com/t/abc123","status":{"status":"to do"},"markdown_description":"As a buyer I keep a cart."}';
else if (k === 'GET /task/abc123/comment') out = '{"comments":[{"comment_text":"looks good"}]}';
else if (k === 'GET /user') out = '{"user":{"id":7}}';
else if (k === 'GET /team') out = '{"teams":[{"id":"T1","name":"Acme","members":[{"user":{"id":42,"username":"Sara","email":"sara@x.io"}}]}]}';
else if (k.startsWith('GET /team/T1/task?page=0')) out = '{"tasks":[{"id":"t1","name":"Fix login","status":{"status":"to do"},"list":{"name":"Sprint"}},{"id":"t2","name":"Cart totals","status":{"status":"in progress"},"list":{"name":"Sprint"}}]}';
else if (k.startsWith('GET /team/T1/task?page=')) out = '{"tasks":[]}';
else if (k === 'GET /team/T1/space') out = '{"spaces":[{"id":"S1","name":"Eng"}]}';
else if (k === 'GET /space/S1/folder') out = '{"folders":[{"id":"F1","name":"Web","lists":[{"id":"901","name":"Sprint"}]}]}';
else if (k === 'GET /space/S1/list') out = '{"lists":[{"id":"902","name":"Inbox"}]}';
else if (k === 'POST /list/901/task') out = '{"id":"new1","url":"https://app.clickup.com/t/new1"}';
else if (/^(PUT|POST|DELETE)/.test(k)) out = '{}';
else { out = '{"err":"not found"}'; code = 404; }
process.stdout.write(out + '\\n' + code);
`,
);
// a custom tracker: logs its argv and GSD_TRACKER_STATUS; FAIL-* ids fail
const TRACKER_SH = `#!/usr/bin/env bash
printf '%s|%s|status=%s\\n' "$1" "$*" "\${GSD_TRACKER_STATUS:-}" >> "$TRACKER_LOG"
case "\${2:-}" in FAIL-*) exit 1 ;; esac
[ "$1" != snapshot ] || printf '# Ticket %s\\n\\nproduct words\\n' "$2"
`;

setStubDirs(STUB);
setBaseEnv({ GSD_CLI: GSD_RUN, CURL_LOG, TRACKER_LOG: fwd(TRACKER_LOG), CLICKUP_API_TOKEN: 'pk_test', GSD_CLICKUP_CONFIG: EMPTY_ENV });
writeFileSync(CURL_LOG, '');
writeFileSync(TRACKER_LOG, '');

const clear = (f: string): void => writeFileSync(f, '');
const chomp = (s: string): string => s.replace(/\n+$/, '');
const tk = (cwd: string, args: string[], o: { env?: Record<string, string | undefined>; input?: string } = {}): Run => gsdt('gsdt-tracker', args, { cwd, ...o });
const gitRepo = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  gitOk(dir, ['init', '-qb', 'main']);
  return dir;
};
const X_UNLESS_WIN = (reason: string): string | false => (WIN ? reason : false);
/** the log lines a custom tracker wrote: BRE `|` is a plain character there, so these are regexes with \| */
const logHas = (name: string, re: RegExp): void => has(name, read(TRACKER_LOG), re);

describe('ticket ids — parse, extract, match', () => {
  it('ids are normalized', () => {
    is('bare id', ticketNorm('869e33cv4'), '869e33cv4');
    is('tk- prefix', ticketNorm('tk-PROJ-42'), 'PROJ-42');
    is('legacy cu_ prefix', ticketNorm('cu_869e33cv4'), '869e33cv4');
    is('CU- kept outside clickup (a Jira key)', ticketNorm('CU-12'), 'CU-12');
    is('CU- stripped for clickup', ticketNorm('CU-869e33cv4', 'clickup'), '869e33cv4');
    is('ClickUp URL', ticketNorm('https://app.clickup.com/t/869e33cv4'), '869e33cv4');
    is('Jira URL with a query', ticketNorm('https://x.atlassian.net/browse/PROJ-42?focus=1'), 'PROJ-42');
    is('#42', ticketNorm('#42'), '42');
    is('a space is refused', ticketNorm('a b'), null);
    is('shell text is refused', ticketNorm('x;rm'), null);
  });
  it('ids are extracted from titles and branches, and matched', () => {
    is('extract from a title', ticketExtract('### Phase 7: cart tk-PROJ-42'), 'PROJ-42');
    is('extract before (INSERTED)', ticketExtract('Phase 2.1: bug tk-abc123 (INSERTED)'), 'abc123');
    is('extract from a branch', ticketExtract('phase-7-cart-tk-proj-42'), 'proj-42');
    is('extract legacy cu_', ticketExtract('cart cu_869e33cv4'), '869e33cv4');
    is('extract legacy ClickUp <id>', ticketExtract('cart ClickUp 869e33cv4'), '869e33cv4');
    is('no tag → nothing', ticketExtract('plain stuck title'), '');
    is('PROJ-4 is not PROJ-42', ticketTagged('cart tk-PROJ-42', 'PROJ-4'), false);
    is('tag match ignores case', ticketTagged('cart tk-PROJ-42', 'proj-42'), true);
  });
});

const NOCONF = path.join(W, 'noconf');
const NONE = path.join(W, 'none');
const CUSTOM = path.join(W, 'custom');
const CU = path.join(W, 'cu');

describe('gsdt-tracker — no .gsd.conf → clickup', () => {
  it('which, GSD_TRACKER and --tracker', () => {
    gitRepo(NOCONF);
    is('which → clickup', chomp(tk(NOCONF, ['which']).stdout), 'clickup');
    is('GSD_TRACKER=none still wins', chomp(tk(NOCONF, ['which'], { env: { GSD_TRACKER: 'none' } }).stdout), 'none');
    is('--tracker still wins', chomp(tk(NOCONF, ['--tracker', 'custom', 'which']).stdout), 'custom');
  });
});

describe('gsdt-tracker — tracker = none (the default in a GSD repo)', () => {
  it('which, start, snapshot, unknown tracker, bad id, extract, update, create, tasks, unknown command', () => {
    gitRepo(NONE);
    write(path.join(NONE, '.gsd.conf'), 'base = main\n');
    is('which → none', chomp(tk(NONE, ['which']).stdout), 'none');
    let r = tk(NONE, ['start', 'PROJ-1', 'hi']);
    is('start is a no-op that succeeds', r.status, 0);
    has('…and says so', r.out, 'tracker = none');
    fails('snapshot is refused', tk(NONE, ['snapshot', 'PROJ-1']));
    fails('an unknown tracker is refused', tk(W, ['--tracker', 'jira', 'start', 'PROJ-1', 'hi']));
    fails('a bad id is refused', tk(W, ['--tracker', 'custom', 'start', 'a b', 'hi']));
    is('extract works without a tracker', chomp(tk(W, ['extract', 'x tk-Z9']).stdout), 'Z9');
    r = tk(NONE, ['update', 'PROJ-1', '--name', 'x']);
    is('update with no tracker fails (exit 1)', r.status, 1);
    has('…saying none is connected', r.out, 'no tracker connected');
    fails('create with no tracker fails', tk(NONE, ['create', '901', 'x']));
    fails('tasks with no tracker fails', tk(NONE, ['tasks']));
    r = fails('an unknown command fails', tk(NONE, ['lists']));
    has('…saying the tracker here is none', r.out, 'the tracker here is none');
  });
});

describe('gsdt-tracker — tracker = custom', () => {
  const R = CUSTOM;
  const conf = (extra = ''): void => {
    write(path.join(R, '.gsd.conf'), `tracker = custom\ntracker_command = scripts/tracker.sh\n${extra}`);
  };
  it('start runs the script with a relative command, a normalized id, the text and the status', () => {
    gitRepo(R);
    write(path.join(R, 'scripts', 'tracker.sh'), TRACKER_SH, 0o755);
    conf('tracker_status_start = Doing\n');
    clear(TRACKER_LOG);
    is('start runs the script', tk(R, ['start', 'https://x/browse/PROJ-42', 'phase 7 started']).status, 0);
    logHas('…relative command, normalized id, text', /^start\|start PROJ-42 phase 7 started\|status=Doing$/);
    tk(R, ['start', 'PROJ-42', 'x'], { env: { GSD_TRACKER_STATUS_START: 'Build' } });
    logHas('env status beats .gsd.conf', /status=Build$/);
    tk(R, ['comment', 'PROJ-42', 'note']);
    logHas('comment gets no status', /^comment\|comment PROJ-42 note\|status=$/);
  });
  it('the script gets GSD_TRACKER_PROFILE', () => {
    write(path.join(R, 'scripts', 'prof.sh'), '#!/usr/bin/env bash\necho "profile=${GSD_TRACKER_PROFILE:-}"\n', 0o755);
    write(path.join(R, '.gsd.conf'), 'tracker = custom\ntracker_command = scripts/prof.sh\ntracker_profile = acme\n');
    is('the script gets GSD_TRACKER_PROFILE', chomp(tk(R, ['check']).out), 'profile=acme');
  });
  it('a failing script → nonzero (exit 2); snapshot --out; a failed snapshot leaves no file', () => {
    conf('tracker_status_start = Doing\n');
    fails('a failing script → nonzero', tk(R, ['finish', 'FAIL-1', 'x']));
    is('…exit 2 (tracker call failed)', tk(R, ['finish', 'FAIL-1', 'x']).status, 2);
    tk(R, ['snapshot', 'PROJ-42', '--out', path.join(W, 't.md')]);
    has('snapshot --out writes the file', read(path.join(W, 't.md')), 'product words');
    fails('a failed snapshot → nonzero', tk(R, ['snapshot', 'FAIL-2', '--out', path.join(W, 'f.md')]));
    ok('…and leaves no file', !exists(path.join(W, 'f.md')));
  });
  it('create, update and tasks reach the script as written', () => {
    clear(TRACKER_LOG);
    tk(R, ['create', 'PROJ', 'New thing', '--label', 'x']);
    logHas('create goes to the script as written', /^create\|create PROJ New thing --label x\|status=$/);
    tk(R, ['update', 'https://x/browse/PROJ-42', '--title', 'y']);
    logHas('update gets the normalized id', /^update\|update PROJ-42 --title y\|status=$/);
    tk(R, ['tasks', '--mine']);
    logHas('tasks passes its options', /^tasks\|tasks --mine\|status=$/);
  });
  it('a script that hangs is stopped (exit 2), saying so', () => {
    write(path.join(R, 'scripts', 'hang.sh'), '#!/usr/bin/env bash\nsleep 30\n', 0o755);
    write(path.join(R, '.gsd.conf'), 'tracker = custom\ntracker_command = scripts/hang.sh\n');
    // stdout to nowhere and stderr to a file (as the bash suite did): a pipe would stay open until the
    // orphaned `sleep` ends
    const errFile = path.join(W, 'hang.err');
    const fd = openSync(errFile, 'w');
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [LAUNCH, 'tracker', 'start', 'PROJ-42', 'x'], {
      cwd: R,
      env: envOf({ GSD_TRACKER_TIMEOUT: '2' }),
      stdio: ['ignore', 'ignore', fd],
    });
    const took = (Date.now() - t0) / 1000;
    closeSync(fd);
    is('a script that hangs is stopped (exit 2)', `${r.status}:${took < 10 ? 'fast' : ''}`, '2:fast');
    has('…saying so', read(errFile), 'gave no answer in 2s');
  });
  it('stdin still reaches the script', () => {
    conf('tracker_status_start = Doing\n');
    write(path.join(R, 'scripts', 'echo.sh'), '#!/usr/bin/env bash\ncat\n', 0o755);
    write(path.join(R, '.gsd.conf'), 'tracker = custom\ntracker_command = scripts/echo.sh\n');
    is('…and stdin still reaches the script', tk(R, ['check'], { input: 'desc' }).stdout, 'desc');
  });
  it("ClickUp's own commands are not custom's", () => {
    conf('tracker_status_start = Doing\n');
    fails("ClickUp's own commands are not custom's", tk(R, ['lists']));
  });
  it('a non-executable command is refused, naming it', { skip: X_UNLESS_WIN('POSIX file modes: chmod -x is not visible on Windows') }, () => {
    run('chmod', ['-x', path.join(R, 'scripts', 'tracker.sh')]);
    const r = fails('a non-executable command is refused', tk(R, ['start', 'PROJ-42', 'x']));
    has('…naming it', r.out, 'not an executable');
  });
});

describe('gsdt-tracker — tracker = clickup (fake API)', () => {
  // Port note: the bash suite skipped these without jq; the TypeScript tracker needs no jq, so they always run.
  const R = CU;
  it('start resolves the status in the list\'s spelling, comments, cascades to open subtasks', () => {
    gitRepo(R);
    write(path.join(R, '.gsd.conf'), 'tracker = clickup\n');
    clear(CURL_LOG);
    is('start succeeds', tk(R, ['start', 'abc123', 'phase started']).status, 0);
    const log = read(CURL_LOG);
    has("status resolved in the list's spelling", log, 'PUT /task/abc123 {"status": "In-Progress"}');
    has('comment posted', log, 'POST /task/abc123/comment {"comment_text": "phase started"}');
    has('open subtask cascades', log, 'PUT /task/sub1 ');
    hasnt('closed subtask left alone', log, 'PUT /task/sub2 ');
  });
  it('already there → no status write (idempotent), no second comment', () => {
    clear(CURL_LOG);
    tk(R, ['start', 'done123', 'again']);
    hasnt('already there → no status write (idempotent)', read(CURL_LOG), 'PUT /task/done123');
    hasnt('…and no second comment', read(CURL_LOG), 'POST /task/done123');
  });
  it('finish → In-Testing; tracker_status_finish from .gsd.conf wins', () => {
    clear(CURL_LOG);
    tk(R, ['finish', 'abc123', 'merged']);
    has('finish → In-Testing', read(CURL_LOG), 'PUT /task/abc123 {"status": "In-Testing"}');
    write(path.join(R, '.gsd.conf'), 'tracker = clickup\ntracker_status_finish = to do\n');
    clear(CURL_LOG);
    tk(R, ['finish', 'done123', 'back']);
    has('tracker_status_finish from .gsd.conf wins', read(CURL_LOG), 'PUT /task/done123 {"status": "to do"}');
  });
  it('snapshot: title, description, comments', () => {
    const snap = tk(R, ['snapshot', 'abc123']).out;
    has('snapshot: title', snap, /^# Cart/);
    has('snapshot: description', snap, 'As a buyer I keep a cart.');
    has('snapshot: comments', snap, /^- looks good/);
  });
  it('an API error → exit 2; --tracker clickup forces clickup; no gsd-clickup command', () => {
    is('an API error → exit 2', tk(R, ['start', 'nope404', 'x']).status, 2);
    clear(CURL_LOG);
    tk(NONE, ['--tracker', 'clickup', 'start', 'abc123', 'hi']);
    has('--tracker clickup forces clickup (repo says none)', read(CURL_LOG), 'PUT /task/abc123');
    is('no gsd-clickup command (gsdt-tracker only)', exists(path.join(PKG, 'bin', 'gsd-clickup')) ? 'there' : 'gone', 'gone');
  });
});

describe('gsdt-tracker — ClickUp-only commands (fake API)', () => {
  const R = CU;
  const cu = (args: string[], input = ''): Run => tk(R, args, { env: { CLICKUP_TEAM_ID: undefined }, input });
  it('create: the new id and url, JSON-escaped body, assignees, priority, tag, parent; --desc - reads stdin', () => {
    write(path.join(R, '.gsd.conf'), 'tracker = clickup\n');
    clear(CURL_LOG);
    const r = cu(['create', '901', 'Fix "login"', '--desc', '# Steps', '--assign', 'me', '--assign', 'sara@x.io', '--priority', '2', '--tag', 'bug', '--parent', 'tk-abc123']);
    has('create prints the new id + url', r.out, '✔ ClickUp new1 created · https://app.clickup.com/t/new1');
    const log = read(CURL_LOG);
    has('create posts to the list, JSON-escaped', log, 'POST /list/901/task {"name":"Fix \\"login\\"","markdown_content":"# Steps"');
    has('…me and an email become user ids', log, '"assignees":[7,42]');
    has('…priority, tag and parent', log, '"priority":2,"tags":["bug"],"parent":"abc123"');
    cu(['create', '901', 'piped', '--desc', '-'], 'line one\nline two\n');
    has('--desc - reads stdin', read(CURL_LOG), '"markdown_content":"line one\\nline two"');
    fails('create refuses a non-numeric list', cu(['create', 'Sprint', 'x']));
    fails('create refuses priority 5', cu(['create', '901', 'x', '--priority', '5']));
    fails('an unknown member fails', cu(['create', '901', 'x', '--assign', 'nobody']));
  });
  it('update takes a URL and sends add/rem; with no change it fails', () => {
    clear(CURL_LOG);
    const r = cu(['update', 'https://app.clickup.com/t/abc123', '--name', 'New', '--assign', 'Sara', '--unassign', '9']);
    has('update takes a URL and sends add/rem', read(CURL_LOG), 'PUT /task/abc123 {"name":"New","assignees":{"add":[42],"rem":[9]}}');
    has('…and names what changed', r.out, 'updated: assignees, name');
    fails('update with no change fails', cu(['update', 'abc123']));
  });
  it('tasks: one line per task, encoded filters, --match', () => {
    clear(CURL_LOG);
    let r = cu(['tasks', '--list', '901', '--status', 'in progress', '--assign', 'me']);
    has('tasks lists one line per task', r.out, /^t1  \[to do\]  Fix login · Sprint/);
    has('…filters are encoded', read(CURL_LOG), 'list_ids%5B%5D=901&statuses%5B%5D=in%20progress&assignees%5B%5D=7');
    r = cu(['tasks', '--match', 'CART']);
    has('--match finds by name, any case', r.out, /^t2 /);
    hasnt('…and drops the rest', r.out, /^t1 /);
  });
  it('lists, members, api', () => {
    const r = cu(['lists']);
    has('lists: folder lists', r.out, /^ {4}list {2}901 {2}Sprint/);
    has('lists: lists with no folder', r.out, /^ {2}list {2}902 {2}Inbox/);
    is('members', chomp(cu(['members']).out), '42  Sara  sara@x.io');
    clear(CURL_LOG);
    cu(['api', 'DELETE', '/task/abc123/tag/bug']);
    has('api passes any call through', read(CURL_LOG), 'DELETE /task/abc123/tag/bug');
    fails('api refuses a path without /', cu(['api', 'GET', 'task/abc123']));
    fails('api refuses a body that is not JSON', cu(['api', 'POST', '/task/abc123/comment', 'hi']));
    clear(CURL_LOG);
    tk(R, ['tasks'], { env: { CLICKUP_TEAM_ID: 'T1' } });
    hasnt('CLICKUP_TEAM_ID skips the workspace lookup', read(CURL_LOG), 'GET /team ');
  });

  describe('gsdt-tracker — create / update / tasks and ClickUp\'s own commands (tracker = clickup)', () => {
    it('update, create, tasks, lists and an unknown command go through gsdt-tracker', () => {
      clear(CURL_LOG);
      tk(R, ['update', 'tk-abc123', '--priority', '1']);
      has('update through gsdt-tracker', read(CURL_LOG), 'PUT /task/abc123 {"priority":1}');
      has('create through gsdt-tracker', tk(R, ['create', '901', 'hi']).out, 'created · https://app.clickup.com/t/new1');
      has('tasks through gsdt-tracker', tk(R, ['tasks', '--match', 'login']).out, /^t1 /);
      is("lists (ClickUp's own) through gsdt-tracker", linesOf(tk(R, ['lists']).out)[0], 'space  S1  Eng');
      has("an unknown command names the tracker's own", tk(R, ['nope']).out, 'also has: lists members api');
    });
  });
});

// A clean token environment: no exported token, no GSD_CLICKUP_CONFIG, a fake HOME.
const H = HOME;
const cuEnv = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  CLICKUP_API_TOKEN: undefined,
  GSD_CLICKUP_CONFIG: undefined,
  GSD_TRACKER_PROFILE: undefined,
  HOME: H,
  USERPROFILE: H,
  CURL_AUTH_LOG: AUTH_LOG,
  ...extra,
});
const cuat = (dir: string, args: string[], o: { env?: Record<string, string | undefined>; input?: string } = {}): Run =>
  tk(dir, args, { env: cuEnv(o.env), input: o.input });
const authLog = (): string => read(AUTH_LOG);

describe('gsdt-tracker — tracker_profile picks the ClickUp token file', () => {
  const R = path.join(W, 'prof');
  it('no profile → the shared clickup.env; a profile → clickup-<profile>.env, named by check', () => {
    mkdirSync(path.join(H, '.config', 'gsd'), { recursive: true });
    write(path.join(H, '.config', 'gsd', 'clickup.env'), 'CLICKUP_API_TOKEN=pk_shared\n');
    write(path.join(H, '.config', 'gsd', 'clickup-acme.env'), 'CLICKUP_API_TOKEN=pk_acme\n');
    gitRepo(R);
    write(path.join(R, '.gsd.conf'), 'tracker = clickup\n');
    clear(AUTH_LOG);
    cuat(R, ['check']);
    has('no profile → the shared clickup.env', authLog(), 'Authorization: pk_shared');
    write(path.join(R, '.gsd.conf'), 'tracker = clickup\ntracker_profile = acme\n');
    clear(AUTH_LOG);
    const r = cuat(R, ['check']);
    has('profile → clickup-acme.env', authLog(), 'Authorization: pk_acme');
    has('check names the profile', r.out, 'token OK (profile acme)');
  });
  it('a profile with no file fails (exit 1) and never falls back to the shared token', () => {
    clear(AUTH_LOG);
    const r = cuat(R, ['check'], { env: { GSD_TRACKER_PROFILE: 'other' } });
    is('a profile with no file fails (exit 1)', r.status, 1);
    has("…naming the profile's file", r.out, 'clickup-other.env');
    hasnt('…and never falls back to the shared token', authLog(), 'pk_shared');
  });
  it('$CLICKUP_API_TOKEN still wins; a profile with a slash is refused before any API call', () => {
    clear(AUTH_LOG);
    cuat(R, ['check'], { env: { CLICKUP_API_TOKEN: 'pk_env' } });
    has('$CLICKUP_API_TOKEN still wins', authLog(), 'Authorization: pk_env');
    write(path.join(R, '.gsd.conf'), 'tracker = clickup\ntracker_profile = ../acme\n');
    clear(AUTH_LOG);
    is('a profile with a slash is refused', cuat(R, ['check']).status, 1);
    is('…before any API call', countLines(authLog(), /./), 0);
  });
});

describe('gsdt-tracker — settings: env > git config > .gsd.conf > default', () => {
  const R = path.join(W, 'prof');
  it('git config beats .gsd.conf; GSD_TRACKER_PROFILE beats git config; the old gsd-tracker section is read', () => {
    write(path.join(R, '.gsd.conf'), 'tracker = clickup\ntracker_profile = other\n');
    gitOk(R, ['config', 'gsdt-tracker.profile', 'acme']);
    clear(AUTH_LOG);
    cuat(R, ['check']);
    has('git config profile beats .gsd.conf', authLog(), 'Authorization: pk_acme');
    has('GSD_TRACKER_PROFILE beats git config', cuat(R, ['check'], { env: { GSD_TRACKER_PROFILE: 'other' } }).out, 'clickup-other.env');
    gitOk(R, ['config', '--rename-section', 'gsdt-tracker', 'gsd-tracker']); // a clone not yet migrated (before 0.10.0)
    clear(AUTH_LOG);
    cuat(R, ['check']);
    has('the old gsd-tracker git section is still read', authLog(), 'Authorization: pk_acme');
    gitOk(R, ['config', '--rename-section', 'gsd-tracker', 'gsdt-tracker']);
  });
  it('config prints the settings and where they come from, never a token, and is offline', () => {
    const conf = cuat(R, ['config']).out;
    has('config: tracker and its source', conf, /^tracker=clickup$/);
    has('…from .gsd.conf', conf, /^tracker_from=gsd\.conf$/);
    has('config: profile from git', conf, /^profile_from=git$/);
    is('config: the token file', fwd(/^token_file=(.*)$/m.exec(conf)?.[1] ?? ''), fwd(path.join(H, '.config', 'gsd', 'clickup-acme.env')));
    has('config: a token is found', conf, /^token=file$/);
    hasnt('config never prints a token', conf, 'pk_');
    clear(AUTH_LOG);
    cuat(R, ['config']);
    is('config is offline', countLines(authLog(), /./), 0);
    gitOk(R, ['config', '--unset', 'gsdt-tracker.profile']);
  });
  it('git config tracker beats .gsd.conf; GSD_TRACKER beats git config', () => {
    gitOk(NONE, ['config', 'gsdt-tracker.tracker', 'custom']);
    is('git config tracker beats .gsd.conf', chomp(tk(NONE, ['which']).stdout), 'custom');
    is('…GSD_TRACKER beats git config', chomp(tk(NONE, ['which'], { env: { GSD_TRACKER: 'none' } }).stdout), 'none');
    gitOk(NONE, ['config', '--unset', 'gsdt-tracker.tracker']);
  });
  it('custom: command and status from git config', () => {
    write(path.join(CUSTOM, '.gsd.conf'), 'tracker = custom\n');
    write(path.join(CUSTOM, 'scripts', 'tracker.sh'), TRACKER_SH, 0o755);
    gitOk(CUSTOM, ['config', 'gsdt-tracker.command', 'scripts/tracker.sh']);
    gitOk(CUSTOM, ['config', 'gsdt-tracker.statusStart', 'Building']);
    clear(TRACKER_LOG);
    tk(CUSTOM, ['start', 'PROJ-5', 'go']);
    logHas('custom: command and status from git config', /^start\|start PROJ-5 go\|status=Building$/);
    gitOk(CUSTOM, ['config', '--remove-section', 'gsdt-tracker']);
  });
});

describe('gsdt-tracker login — in a GSD repo: the profile goes in git config', () => {
  const R = path.join(W, 'MyShop');
  const F = path.join(H, '.config', 'gsd', 'clickup-myshop.env');
  let confBefore = '';
  const login = (args: string[], input: string): Run => cuat(R, ['login', ...args], { input });
  it('login saves the folder\'s profile, only you can read it, git config gets it, .gsd.conf is never edited', () => {
    gitRepo(R);
    write(path.join(R, '.gsd.conf'), 'tracker = clickup'); // no final newline
    confBefore = read(path.join(R, '.gsd.conf'));
    const r = login([], 'pk_new\n');
    is('login exits 0', r.status, 0);
    is('the profile is the folder\'s name', exists(F) ? read(F).trim() : '', 'CLICKUP_API_TOKEN=pk_new');
    is('…and only you can read the file', WIN ? 0o600 : statSync(F).mode & 0o777, 0o600);
    is('git config gets gsdt-tracker.profile', gitOut(R, ['config', '--get', 'gsdt-tracker.profile']), 'myshop');
    is('.gsd.conf is never edited', read(path.join(R, '.gsd.conf')), confBefore);
    clear(AUTH_LOG);
    cuat(R, ['check']);
    has('check now uses the saved token', authLog(), 'Authorization: pk_new');
  });
  it('a piped token replaces the saved one, keeping other lines', () => {
    writeFileSync(F, read(F) + 'CLICKUP_TEAM_ID=T9\n');
    const r = login([], 'pk_new2\n');
    has('a piped token replaces the saved one', r.out, 'replaced →');
    is('…once, keeping other lines', `${linesOf(read(F)).sort().join(' ')} `, 'CLICKUP_API_TOKEN=pk_new2 CLICKUP_TEAM_ID=T9 ');
    has('…and the repo already uses it', r.out, 'already uses profile myshop');
  });
  it('a named profile switches the repo, in its own file', () => {
    login(['acme2'], 'pk_other\n');
    is('a named profile switches the repo', gitOut(R, ['config', '--get', 'gsdt-tracker.profile']), 'acme2');
    is('…in its own file', read(path.join(H, '.config', 'gsd', 'clickup-acme2.env')).trim(), 'CLICKUP_API_TOKEN=pk_other');
    write(path.join(R, '.gsd.conf'), 'tracker = clickup\ntracker_profile = team\n');
    has('a different tracker_profile in .gsd.conf is named', login(['acme2'], 'pk_other\n').out, 'tracker_profile = team; in this clone git config wins');
  });
  it('a refused token fails (exit 2), is never saved, nor picked for the repo', () => {
    is('a refused token fails (exit 2)', login(['bad1'], 'pk_bad\n').status, 2);
    ok('…and is never saved', !exists(path.join(H, '.config', 'gsd', 'clickup-bad1.env')));
    is('…nor picked for the repo', gitOut(R, ['config', '--get', 'gsdt-tracker.profile']), 'acme2');
  });
  it('a token with shell characters is refused before any API call; no token → exit 1; a slash profile is refused', () => {
    clear(AUTH_LOG);
    is('a token with shell characters is refused', login([], 'pk_x$(touch pwned)\n').status, 1);
    is('…before any API call', countLines(authLog(), /./), 0);
    is('no token → exit 1', login(['fresh'], '').status, 1);
    is('a profile with a slash is refused', login(['../x'], 'pk_new\n').status, 1);
  });
  it('tracker = none here → says how to set it', () => {
    write(path.join(R, '.gsd.conf'), 'base = main\n');
    has('tracker = none here → says how to set it', login([], 'pk_new\n').out, 'git config gsdt-tracker.tracker clickup');
  });
});

describe('gsdt-tracker login — a plain repo, a worktree, no repo', () => {
  const R = path.join(W, 'plainrepo');
  it('a plain repo: login works, the profile goes in git config, no file appears in the repo, check uses it', () => {
    gitRepo(R);
    write(path.join(R, 'a'), 'a\n');
    commit(R, 'init');
    const r = cuat(R, ['login', 'plain'], { input: 'pk_plain\n' });
    is('a plain repo: login works', r.status, 0);
    is('…the profile goes in git config', gitOut(R, ['config', '--get', 'gsdt-tracker.profile']), 'plain');
    is('…and no file appears in the repo', gitOut(R, ['status', '--short']), '');
    clear(AUTH_LOG);
    cuat(R, ['check']);
    has('…and check uses that profile', authLog(), 'Authorization: pk_plain');
  });
  it('from a worktree: login works, the whole clone uses it, the main checkout too', () => {
    const wt = path.join(W, 'plainrepo-wt');
    gitOk(R, ['worktree', 'add', '-q', '-b', 'phase-1-x', wt]);
    mkdirSync(path.join(wt, 'deep'), { recursive: true });
    const r = cuat(path.join(wt, 'deep'), ['login', 'wtp'], { input: 'pk_wt\n' });
    is('from a worktree: login works', r.status, 0);
    is('…and the whole clone uses it', gitOut(R, ['config', '--get', 'gsdt-tracker.profile']), 'wtp');
    clear(AUTH_LOG);
    cuat(R, ['check']);
    has('…the main checkout too', authLog(), 'Authorization: pk_wt');
  });
  it('no repo, no name → exit 1, asking for the name; no repo, a name → the token is saved', () => {
    const N = path.join(W, 'norepo');
    mkdirSync(N, { recursive: true });
    clear(AUTH_LOG);
    let r = cuat(N, ['login'], { input: 'pk_solo\n' });
    is('no repo, no name → exit 1', r.status, 1);
    has('…asking for the name', r.out, 'name the profile');
    is('…before the token is read or sent', countLines(authLog(), /./), 0);
    r = cuat(N, ['login', 'solo'], { input: 'pk_solo\n' });
    is('no repo, a name → the token is saved', `${r.status}:${read(path.join(H, '.config', 'gsd', 'clickup-solo.env')).trim()}`, '0:CLICKUP_API_TOKEN=pk_solo');
    has('…and says how to use it in a repo', r.out, 'in the repo, run: gsdt-tracker login solo');
  });
});

describe('gsdt-tracker login — a saved profile: use it or replace it', () => {
  const hasExpect = !WIN && spawnSync('expect', ['-v'], { stdio: 'ignore' }).status === 0;
  const R = path.join(W, 'plainrepo');
  const exp = path.join(W, 'login.exp');
  // Answers $ANS at the [U/r] question and types $TOK at the hidden prompt.
  const typed = (prof: string, ans: string, tok: string): string => {
    write(
      exp,
      `spawn gsdt-tracker login $env(PROF)
expect {
  -ex {[U/r] }   { send "$env(ANS)\\r"; exp_continue }
  -ex {hidden): } { send "$env(TOK)\\r"; exp_continue }
  eof
}
`,
    );
    const r = spawnSync('expect', [exp], { cwd: R, env: envOf(cuEnv({ PROF: prof, ANS: ans, TOK: tok })), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return (r.stdout ?? '') + (r.stderr ?? '');
  };
  const file = (n: string): string => read(path.join(H, '.config', 'gsd', `clickup-${n}.env`)).trim();
  it('Enter uses the saved token; r replaces it', { skip: !hasExpect && (WIN ? 'needs a pty (expect); there is none on Windows' : 'expect not installed') }, () => {
    let out = typed('solo', '', 'pk_unused');
    has('Enter uses the saved token', out, 'kept →');
    hasnt('…without asking for one', out, 'hidden): ');
    is('…the file is unchanged', file('solo'), 'CLICKUP_API_TOKEN=pk_solo');
    is('…and the repo now uses it', gitOut(R, ['config', '--get', 'gsdt-tracker.profile']), 'solo');
    out = typed('solo', 'r', 'pk_typed');
    is('r replaces it', file('solo'), 'CLICKUP_API_TOKEN=pk_typed');
    hasnt('…and the typed token is never shown', out, 'pk_typed');
  });
  it('a saved token ClickUp refuses → asks for a new one; no saved token → just the token prompt', { skip: !hasExpect && (WIN ? 'needs a pty (expect); there is none on Windows' : 'expect not installed') }, () => {
    write(path.join(H, '.config', 'gsd', 'clickup-stale.env'), 'CLICKUP_API_TOKEN=pk_bad\n');
    let out = typed('stale', 'u', 'pk_fresh');
    has('a saved token ClickUp refuses → asks for a new one', out, 'did not accept the saved token');
    is('…and saves the new one', file('stale'), 'CLICKUP_API_TOKEN=pk_fresh');
    out = typed('brandnew', '', 'pk_brand');
    hasnt('no saved token → no question', out, '[U/r]');
    is('…just the token prompt', file('brandnew'), 'CLICKUP_API_TOKEN=pk_brand');
  });
});

describe('gsdt-tracker is standalone', () => {
  const S = path.join(W, 'solo-pkg');
  const lineHits = (files: string[], re: RegExp, skipLine: (l: string) => boolean): string[] => {
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(path.join(PKG, f), 'utf8')
        .split('\n')
        .forEach((l, i) => {
          if (re.test(l) && !skipLine(l)) hits.push(`${f}:${i + 1}:${l}`);
        });
    }
    return hits;
  };
  const ls = (dir: string, re: RegExp): string[] => readdirSync(path.join(PKG, dir)).filter((n) => re.test(n)).map((n) => `${dir}/${n}`);
  it('runs with only its own files, talks to ClickUp and logs in', () => {
    mkdirSync(path.join(S, 'bin'), { recursive: true });
    mkdirSync(path.join(S, 'src', 'commands'), { recursive: true });
    cpSync(path.join(PKG, 'bin', 'gsdt-tracker'), path.join(S, 'bin', 'gsdt-tracker'));
    cpSync(LAUNCH, path.join(S, 'src', 'launch.mjs'));
    cpSync(path.join(PKG, 'src', 'commands', 'tracker.ts'), path.join(S, 'src', 'commands', 'tracker.ts'));
    cpSync(path.join(PKG, 'src', 'tracker'), path.join(S, 'src', 'tracker'), { recursive: true });
    const solo = (cwd: string, args: string[], env: Record<string, string | undefined> = {}, input = ''): Run =>
      run(process.execPath, [path.join(S, 'src', 'launch.mjs'), 'tracker', ...args], { cwd, env, input });
    is('runs with only its own files', chomp(solo(NOCONF, ['which']).stdout), 'clickup');
    clear(CURL_LOG);
    solo(NOCONF, ['--tracker', 'clickup', 'check']);
    has('…and talks to ClickUp', read(CURL_LOG), 'GET /user');
    is('…and logs in', solo(NOCONF, ['login', 'standalone'], cuEnv(), 'pk_s\n').status, 0);
  });
  it('the tracker files use no GSD code, and GSD never sources or imports them', () => {
    const noComment = (l: string): boolean => /^\s*#/.test(l);
    is('tracker files use no GSD code', lineHits(['bin/gsdt-tracker', ...ls('lib/tracker', /\.sh$/)], /(^|[^A-Za-z0-9_])gsd_[a-z]|lib\/(common|ticket|provider)\.sh/, noComment).join('\n'), '');
    // the TypeScript: every import is node:… or a path inside src/tracker (and no GSD name is called)
    const tsFiles = [...ls('src/tracker', /\.ts$/), 'src/commands/tracker.ts'];
    is('tracker TypeScript uses no GSD names', lineHits(tsFiles, /(^|[^A-Za-z0-9_])gsd_[a-z]|lib\/(common|ticket|provider)\.sh/, (l) => /^\s*(\/\/|\*)/.test(l)).join('\n'), '');
    const foreign: string[] = [];
    for (const f of tsFiles) {
      const text = readFileSync(path.join(PKG, f), 'utf8');
      for (const m of text.matchAll(/(from|import\(|require\()\s*['"]([^'"]*)['"]/g)) {
        const spec = m[2] as string;
        if (spec.startsWith('node:') || spec.startsWith('./')) continue;
        if (spec.startsWith('../tracker/') && f === 'src/commands/tracker.ts') continue;
        foreign.push(`${f}: ${spec}`);
      }
    }
    is('tracker TypeScript imports only node:* and src/tracker', foreign.join('\n'), '');
    const sourcers = lineHits([...ls('bin', /.*/), ...ls('lib', /\.sh$/)].filter((f) => statSync(path.join(PKG, f)).isFile()), /^\s*\. .*lib\/tracker\//, () => false).filter((h) => !h.startsWith('bin/gsdt-tracker:'));
    is('GSD never sources tracker files', sourcers.join('\n'), '');
    const srcFiles: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(path.join(PKG, d))) {
        const rel = `${d}/${e}`;
        if (statSync(path.join(PKG, rel)).isDirectory()) walk(rel);
        else if (rel.endsWith('.ts')) srcFiles.push(rel);
      }
    };
    walk('src');
    const refs = lineHits(
      srcFiles.filter((f) => !f.startsWith('src/tracker/') && f !== 'src/commands/tracker.ts'),
      /from\s+['"][^'"]*tracker\//,
      () => false,
    );
    is('GSD (src/) never imports from src/tracker', refs.join('\n'), '');
  });
  it("GSD's id helpers and the tracker's copies agree", () => {
    is('GSD: a tracker nobody set counts as none', trackerWhich(NOCONF), 'none');
    is('…a set one counts', trackerWhich(CUSTOM), 'custom');
    for (const s of ['869e33cv4', 'tk-PROJ-42', 'cu_869e33cv4', 'CU-12', 'https://x.atlassian.net/browse/PROJ-42?focus=1', '#42', 'a b', 'x;rm']) {
      for (const as of ['', 'clickup']) is(`id twins agree on '${s}' (${as})`, ticketNorm(s, as) ?? 'FAIL', trkIdNorm(s, as) ?? 'FAIL');
    }
    for (const s of ['### Phase 7: cart tk-PROJ-42', 'Phase 2.1: bug tk-abc123 (INSERTED)', 'phase-7-cart-tk-proj-42', 'cart cu_869e33cv4', 'cart ClickUp 869e33cv4', 'plain stuck title']) {
      is(`extract twins agree on '${s}'`, ticketExtract(s), trkIdExtract(s));
    }
    ok("GSD's id helpers and the tracker's copies agree", true);
  });
});

// ── through gsdt-start / gsdt-finish ───────────────────────────────────────────
const trackerProject = (dir: string, extra = ''): string => project(dir, extra, { 'scripts/tracker.sh': [TRACKER_SH, 0o755] });
const CUSTOM_CONF = 'tracker = custom\ntracker_command = scripts/tracker.sh\n';
const start = (R: string, args: string[]): Run => gsdt('gsdt-start', args, { cwd: R });
const originOf = (R: string): string => `${R}.git`;
const roadmap = (R: string): string => readLf(path.join(R, '.planning', 'ROADMAP.md'));

describe('gsdt-start --ticket / gsdt-finish — tracker = custom', () => {
  const R = path.join(W, 'shop');
  it('a claim with --ticket tags the title and the branch and moves the ticket to started', () => {
    trackerProject(R, CUSTOM_CONF);
    clear(TRACKER_LOG);
    is('claim with --ticket succeeds', start(R, ['-n', 'shopping cart', '--ticket', 'PROJ-42', '--no-launch']).status, 0);
    is('title ends with tk-<id>', countLines(roadmap(R), /^### Phase 2: shopping cart tk-PROJ-42$/), 1);
    ok('branch/slug ends with tk-<id>', git(R, ['show-ref', '-q', '--verify', 'refs/heads/phase-2-shopping-cart-tk-proj-42']).status === 0, gitOut(R, ['branch']));
    logHas('ticket moved to started', /^start\|start PROJ-42 🚧 GSD phase 2 started/);
  });
  it('the same ticket under other words, and a malformed --ticket, are refused', () => {
    const r = fails('same ticket, other words → refused', start(R, ['-n', 'cart again', '--ticket', 'https://x/browse/PROJ-42', '--no-launch']));
    has('…naming the phase to attach to', r.out, 'phase 2 already tracks ticket PROJ-42');
    fails('a malformed --ticket is refused', start(R, ['-n', 'x', '--ticket', 'a b', '--no-launch']));
  });
  it('--cu still works; a tracker failure does not block the claim', () => {
    start(R, ['-n', 'legacy flag', '--cu', 'CU-abc123', '--no-launch']);
    is('--cu still works, CU- stripped', countLines(roadmap(R), /^### Phase 3: legacy flag tk-abc123$/), 1);
    const r = start(R, ['-n', 'flaky tracker', '--ticket', 'FAIL-9', '--no-launch']);
    is("a tracker failure doesn't block the claim", r.status, 0);
    has('…it is only a note', r.out, 'ticket FAIL-9 not updated (non-fatal)');
  });
  it('-p re-attach reads the id from the title; finish --pr and finish tell the tracker', () => {
    clear(TRACKER_LOG);
    start(R, ['-p', '2', '--no-launch']);
    logHas('-p re-attach reads the id from the title (case kept)', /^start\|start PROJ-42 /);
    const wt = worktreeOf(R, 'phase-2-');
    write(path.join(wt, 'cart.txt'), 'cart\n');
    commit(wt, 'cart');
    clear(TRACKER_LOG);
    gsdt('gsdt-finish', ['2', '--pr'], { cwd: R });
    logHas('finish --pr → finish, PR opened', /^finish\|finish PROJ-42 🔀 GSD phase 2: PR opened/);
    is('finish succeeds', gsdt('gsdt-finish', ['2'], { cwd: R }).status, 0);
    logHas('finish → finish, merged', /^finish\|finish PROJ-42 ✅ GSD phase 2 merged to main/);
  });
});

describe('gsdt-start — with a tracker set, a new phase needs its ticket', () => {
  const R = path.join(W, 'needs');
  it('a claim with no ticket is refused, nothing is claimed; --insert too', () => {
    trackerProject(R, CUSTOM_CONF);
    const before = git(W, ['--git-dir', originOf(R), 'rev-parse', 'main']).stdout.trim();
    const r = fails('a claim with no ticket is refused', start(R, ['-n', 'search', '--no-launch']));
    has('…saying how to give one', r.out, 'add --ticket <id>');
    has('…or to go without', r.out, 'add --no-ticket');
    is('…and nothing was claimed', `${countLines(roadmap(R), /^### Phase/)}:${git(W, ['--git-dir', originOf(R), 'rev-parse', 'main']).stdout.trim()}`, `1:${before}`);
    fails('--insert is refused too', start(R, ['--insert', '1', 'hotfix', '--no-launch']));
  });
  it('a tk-<id> tag counts; --no-ticket claims anyway; -p on an old phase still attaches, with a note', () => {
    is('a tk-<id> tag in the description counts', start(R, ['-n', 'search tk-PROJ-7', '--no-launch']).status, 0);
    const r = start(R, ['-n', 'bump deps', '--no-ticket', '--no-launch']);
    is('--no-ticket claims anyway', `${r.status}:${countLines(roadmap(R), /^### Phase 3: bump deps$/)}`, '0:1');
    const p = start(R, ['-p', '1', '--no-launch']);
    is('-p on an old phase with no ticket still attaches', p.status, 0);
    has('…with a note', p.out, 'phase 1 has no ticket');
  });
});

describe('gsdt-start --ticket — tracker = none tags only', () => {
  it('the title is tagged, a note says nothing is updated, no tracker call is made', () => {
    const R = path.join(W, 'plain');
    trackerProject(R);
    clear(TRACKER_LOG);
    const r = start(R, ['-n', 'search', '--ticket', '77', '--no-launch']);
    is('claim succeeds', r.status, 0);
    is('title tagged', countLines(roadmap(R), /^### Phase 2: search tk-77$/), 1);
    has('…with a note that nothing is updated', r.out, 'phase tagged tk-77 only');
    is('no tracker call', countLines(read(TRACKER_LOG), /./), 0);
  });
});

describe('gsdt-doctor — tracker config', () => {
  const doc = (R: string): string => gsdt('gsdt-doctor', ['--repo', R, '--json']).stdout;
  const code = (R: string, c: string): boolean => doc(R).includes(`"code":"${c}`);
  it('T070 (cu_ tags with tracker = none), T071 (unknown tracker), T072 (custom command missing)', () => {
    const R = path.join(W, 'doc');
    trackerProject(R);
    write(path.join(R, '.planning', 'ROADMAP.md'), roadmap(R) + '\n### Phase 2: old cart cu_869e33cv4\n');
    ok('T070: cu_ tags with tracker = none', code(R, 'T070'));
    write(path.join(R, '.gsd.conf'), read(path.join(R, '.gsd.conf')) + 'tracker = clickup\n');
    ok('…gone once tracker = clickup', !code(R, 'T07'));
    write(path.join(R, '.gsd.conf'), 'install = none\ntracker = jira\n');
    ok('T071: unknown tracker', code(R, 'T071'));
    write(path.join(R, '.gsd.conf'), 'install = none\n');
    gitOk(R, ['config', 'gsdt-tracker.tracker', 'jira']);
    const dj = doc(R);
    ok('T071 from git config names git config', dj.includes('"code":"T071') && dj.includes('git config gsdt-tracker.tracker'), dj);
    gitOk(R, ['config', '--unset', 'gsdt-tracker.tracker']);
    write(path.join(R, '.gsd.conf'), 'install = none\ntracker = custom\ntracker_command = scripts/missing.sh\n');
    ok('T072: custom command missing', code(R, 'T072'));
  });
  it('T040 counts a missing ticket snapshot, only with a tracker set', () => {
    const R = path.join(W, 'debt');
    trackerProject(R, `flow = strict\n${CUSTOM_CONF}`);
    write(path.join(R, '.planning', 'ROADMAP.md'), '# Roadmap\n\n- [x] **Phase 1: catalog tk-PROJ-7**\n\n### Phase 1: catalog tk-PROJ-7\n');
    mkdirSync(path.join(R, '.planning', 'phases', '01-catalog-tk-proj-7'), { recursive: true });
    let out = doc(R);
    has('T040 counts a missing ticket snapshot', out, 'Phase 1 merged without: ticket');
    has('…fix names the snapshot command', out, 'gsdt-tracker snapshot proj-7 --out .planning/phases/01-catalog-tk-proj-7/01-TICKET.md');
    write(path.join(R, '.gsd.conf'), 'install = none\nflow = strict\n');
    out = doc(R);
    hasnt('tracker = none → no ticket debt', out, 'without: ticket');
  });
});
