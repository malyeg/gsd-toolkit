// src/tracker/clickup.ts — ClickUp adapter for gsdt-tracker (lib/tracker/clickup.sh).
//
// Auth: a personal API token (pk_…), first match wins:
//   1. $CLICKUP_API_TOKEN in the environment
//   2. the token file (must set CLICKUP_API_TOKEN=…), from trkClickupEnv: $GSD_CLICKUP_CONFIG,
//      else ~/.config/gsd/clickup-<profile>.env when a profile is set, else
//      ~/.config/gsd/clickup.env
// The bash sourced that file; here its plain assignments (KEY=value, export KEY=value, quotes)
// are read and applied to the environment — nothing else in it is run.
// The API is reached by running `curl` from PATH (tests stub it); the JSON work jq and Python
// did in bash is done natively (see json.ts).
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isatty } from 'node:tty';
import { profileFromRepo, trkClickupEnv, trkConfGet, trkGet, trkGitGet, trkHasToken, trkProfileOk } from './config.ts';
import { trkIdNorm } from './ids.ts';
import { alt, get, iter, jqStr, jqUri, parse, pyJsonString, ser } from './json.ts';
import { chomp, die, echo, err, grepQ, lower, out, readAllStdin, readLineSync, SP, TrkExit } from './io.ts';

/** This tracker's own commands, beyond the shared verbs. */
export const TRACKER_EXTRA = 'lists members api login';

type J = unknown;
const BASE = 'https://api.clickup.com/api/v2';

/** The profile and token file in use (set once by initClickup, like the bash's top-level code). */
let PROFILE = '';
let CONFIG = '';
let REPO = '';

export function initClickup(repo: string): void {
  REPO = repo;
  PROFILE = trkGet(repo, 'profile').val;
  CONFIG = trkClickupEnv(repo);
}

/** Plain `KEY=value` assignments of a shell file (what sourcing it would set), in order. */
export function parseEnvFile(text: string): Array<[string, string]> {
  const res: Array<[string, string]> = [];
  for (const line of text.split('\n')) {
    const m = new RegExp(`^${SP}*(?:export${SP}+)?([A-Za-z_][A-Za-z0-9_]*)=([^\n]*)$`).exec(line);
    if (!m) continue;
    const rest = m[2]!;
    let val = '';
    let i = 0;
    while (i < rest.length) {
      const c = rest[i]!;
      if (c === "'") {
        const j = rest.indexOf("'", i + 1);
        if (j < 0) {
          val += rest.slice(i + 1);
          i = rest.length;
        } else {
          val += rest.slice(i + 1, j);
          i = j + 1;
        }
      } else if (c === '"') {
        i++;
        while (i < rest.length && rest[i]! !== '"') {
          if (rest[i]! === '\\' && i + 1 < rest.length && '"\\$`'.includes(rest[i + 1]!)) {
            val += rest[i + 1]!;
            i += 2;
          } else val += rest[i++]!;
        }
        i++;
      } else if (c === '\\' && i + 1 < rest.length) {
        val += rest[i + 1]!;
        i += 2;
      } else if (c === ' ' || c === '\t' || c === ';') {
        break;
      } else if (c === '#' && i > 0 && (rest[i - 1] === ' ' || rest[i - 1] === '\t')) {
        break;
      } else val += rest[i++]!;
    }
    res.push([m[1]!, val]);
  }
  return res;
}

function loadToken(): void {
  if (PROFILE && !trkProfileOk(PROFILE)) die(`profile '${PROFILE}' is not a name (letters, digits, . _ -)`);
  if (!process.env.CLICKUP_API_TOKEN && existsFile(CONFIG)) {
    for (const [k, v] of parseEnvFile(readFileSync(CONFIG, 'utf8'))) process.env[k] = v;
  }
  if (!process.env.CLICKUP_API_TOKEN) {
    die(`no CLICKUP_API_TOKEN${PROFILE ? ` for profile '${PROFILE}'` : ''} — run gsdt-tracker login${PROFILE ? ` ${PROFILE}` : ''}, or put CLICKUP_API_TOKEN=pk_… in ${CONFIG}`);
  }
}

function existsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** api: prints nothing itself on success; returns the body, or null on a curl failure / HTTP >= 400 (after saying so on stderr). */
function api(method: string, path: string, body = '', token = process.env.CLICKUP_API_TOKEN ?? ''): string | null {
  const args = ['-sSg', '--max-time', '15', '-X', method, '-H', `Authorization: ${token}`, '-H', 'Content-Type: application/json'];
  if (body) args.push('-d', body);
  args.push('-w', '\\n%{http_code}', `${BASE}${path}`);
  const r = spawnSync('curl', args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 1 << 30 });
  if (r.error || r.status !== 0) {
    err('gsdt-tracker: curl failed (network?)\n');
    return null;
  }
  const all = chomp(r.stdout ?? '');
  const nl = all.lastIndexOf('\n');
  const http = nl < 0 ? all : all.slice(nl + 1);
  const outp = nl < 0 ? all : all.slice(0, nl);
  if (/^\s*[+-]?\d+\s*$/.test(http) && Number(http) >= 400) {
    err(`gsdt-tracker: ClickUp API ${method} ${path} → HTTP ${http}: ${outp}\n`);
    return null;
  }
  return outp;
}

/** api … || exit 2 */
function apiOrExit(method: string, path: string, body = ''): string {
  const r = api(method, path, body);
  if (r === null) throw new TrkExit(2);
  return r;
}

/** norm: lower case, a-z0-9 only (for comparing status names). */
const norm = (s: string): string => lower(s).replace(/[^a-z0-9]/g, '');

/** resolve_status: the exact spelling of the first candidate among the list's statuses. */
function resolveStatus(listId: string, cands: string[]): string {
  const listJson = api('GET', `/list/${listId}`);
  if (listJson === null) {
    err(`gsdt-tracker: cannot fetch list ${listId} statuses — trying "${cands[0]!}" verbatim\n`);
    return cands[0]!;
  }
  let names: string[] = [];
  try {
    names = iter(get(parse(listJson), 'statuses')).map((s) => jqStr(get(s, 'status')));
  } catch {
    /* jq failed: names stay empty (a command substitution in a function does not stop the script) */
  }
  const lines = names.length ? names : [''];
  for (const cand of cands) {
    for (const name of lines) if (norm(name) === norm(cand)) return name;
  }
  err(`gsdt-tracker: no candidate (${cands.join(' ')}) matches list ${listId} statuses [${names.join(',')}] — trying "${cands[0]!}" verbatim\n`);
  return cands[0]!;
}

/** tracker_status: the configured status for start/finish ('' = adapter default). */
const trackerStatus = (which: 'start' | 'finish'): string => trkGet(REPO, which === 'start' ? 'status_start' : 'status_finish').val;

function clickupMove(cmd: 'start' | 'finish', id: string, text: string): number {
  let rc = 0;
  loadToken();
  const cands: string[] = [];
  const conf = trackerStatus(cmd);
  if (conf) cands.push(conf);
  if (cmd === 'start') cands.push('in progress', 'in development');
  else cands.push('in testing', 'in review');
  const curJson = parse(apiOrExit('GET', `/task/${id}?include_subtasks=true`));
  const cur = jqStr(get(curJson, 'status', 'status'));
  const st = resolveStatus(jqStr(get(curJson, 'list', 'id')), cands);
  if (norm(cur) === norm(st)) {
    echo(`• ClickUp ${id} already '${st}' — status and comment skipped (idempotent)`);
  } else {
    // both attempted independently — a bad status name must not swallow the comment
    if (api('PUT', `/task/${id}`, `{"status": ${pyJsonString(st)}}`) !== null) echo(`✔ ClickUp ${id} → status '${st}'`);
    else rc = 2;
    if (api('POST', `/task/${id}/comment`, `{"comment_text": ${pyJsonString(text)}}`) !== null) echo(`✔ ClickUp ${id} → comment posted`);
    else rc = 2;
  }
  // Open subtasks ride along; closed/complete ones are never touched.
  const sids: string[] = [];
  const subs = get(curJson, 'subtasks');
  if (Array.isArray(subs)) {
    for (const s of subs) {
      const sname = get(s, 'status', 'status');
      if (typeof sname !== 'string') break; // jq's ascii_downcase fails on null: the rest is not listed
      if (get(s, 'date_closed') === null && norm(sname) !== norm(st) && get(s, 'status', 'type') !== 'closed' && !/^complete/i.test(sname)) sids.push(jqStr(get(s, 'id')));
    }
  }
  for (const sid of sids.flatMap((x) => x.split(/[ \t\n]+/).filter(Boolean))) {
    if (api('PUT', `/task/${sid}`, `{"status": ${pyJsonString(st)}}`) !== null) echo(`✔ ClickUp ${sid} (subtask) → status '${st}'`);
    else rc = 2;
  }
  const eng = process.env.GSD_CLICKUP_ENG_LIST;
  if (cmd === 'start' && eng) {
    const home = jqStr(get(curJson, 'list', 'id'));
    if (home !== eng) echo(`• task lives in list '${jqStr(get(curJson, 'list', 'name'))}' — move it to list ${eng} by hand (the API can't)`);
  }
  return rc;
}

function clickupSnapshot(id: string): number {
  loadToken();
  const task = parse(apiOrExit('GET', `/task/${id}?include_markdown_description=true`));
  let comments: J;
  const c = api('GET', `/task/${id}/comment`);
  comments = c === null ? { comments: [] } : parse(c);
  const desc = alt(get(task, 'markdown_description'), alt(get(task, 'description'), ''));
  out(`# ${jqStr(get(task, 'name'))}\n\nTicket: ClickUp ${id} · ${jqStr(alt(get(task, 'url'), ''))} · status: ${jqStr(alt(get(task, 'status', 'status'), '?'))}\n\n${desc === '' ? '_(no description)_' : jqStr(desc)}\n`);
  const arr = get(comments, 'comments');
  const cs: string[] = [];
  if (Array.isArray(arr)) {
    for (const x of arr) {
      const t = jqStr(alt(get(x, 'comment_text'), ''));
      if (t !== '') cs.push(t);
    }
  }
  if (cs.length > 0) out(`\n## Comments\n\n${cs.map((t) => `- ${t.replace(/\n/g, '\n  ')}`).join('\n')}\n`);
  return 0;
}

// ── create / update / tasks, and the ClickUp-only commands ────────────────────

const prioOk = (p: string): void => {
  if (!/^[1-4]$/.test(p)) die(`priority is 1 (urgent), 2 (high), 3 (normal) or 4 (low), not '${p}'`);
};

/** desc_arg + `$( … )`: the markdown, or stdin for -, without trailing newlines. */
const descArg = (a: string): string => chomp(a === '-' ? readAllStdin() : a);

/** `--argjson v "$text"`: a number (kept exact), null, or other JSON. */
function argjson(text: string): J {
  if (/^-?\d+$/.test(text)) return BigInt(text);
  try {
    return JSON.parse(text);
  } catch {
    err('jq: Invalid JSON text passed to --argjson\nUse jq --help for help with command-line options,\nor see the jq manpage, or online docs  at https://jqlang.github.io/jq\n');
    throw new TrkExit(2);
  }
}

function clickupTeam(): string {
  if (process.env.CLICKUP_TEAM_ID) return process.env.CLICKUP_TEAM_ID;
  const teams = parse(apiOrExit('GET', '/team'));
  const list = get(teams, 'teams');
  const n = Array.isArray(list) ? list.length : 0;
  if (n === 1) return jqStr(get((list as J[])[0], 'id'));
  if (n === 0) die('the token sees no workspace');
  die(`the token sees ${n} workspaces — set CLICKUP_TEAM_ID in ${CONFIG} to one of: ${(list as J[]).map((t) => `${jqStr(get(t, 'id'))} (${jqStr(get(t, 'name'))})`).join(', ')}`);
}

interface Member {
  id: J;
  username: J;
  email: J;
}
/**
 * clickup_members_json. `lenient` = called from clickup_user, which runs in a command
 * substitution where bash's `set -e` is off: a failing clickup_team (several workspaces, none)
 * leaves the team empty and goes on, so the lookup ends in "no workspace member".
 */
function clickupMembers(lenient = false): Member[] {
  let team = '';
  try {
    team = clickupTeam();
  } catch (e) {
    if (!lenient || !(e instanceof TrkExit)) throw e;
  }
  const teams = parse(apiOrExit('GET', '/team'));
  const res: Member[] = [];
  for (const t of iter(get(teams, 'teams'))) {
    if (get(t, 'id') !== team) continue;
    for (const m of iter(get(t, 'members'))) {
      const u = get(m, 'user');
      res.push({ id: get(u, 'id'), username: get(u, 'username'), email: get(u, 'email') });
    }
  }
  return res;
}

/** clickup_user: me | user id | email | username → the numeric user id (as text). */
function clickupUser(who: string): string {
  if (who === 'me') return jqStr(get(parse(apiOrExit('GET', '/user')), 'user', 'id'));
  if (who === '' || /[^0-9]/.test(who)) {
    let members: Member[] = [];
    try {
      members = clickupMembers(true);
    } catch (e) {
      if (!(e instanceof TrkExit)) throw e; // the failed lookup's own message was printed
    }
    const u = lower(who);
    let id = '';
    for (const m of members) {
      if (lower(typeof m.email === 'string' ? m.email : '') === u || lower(typeof m.username === 'string' ? m.username : '') === u) {
        const v = alt(m.id, undefined);
        if (v !== undefined) id = jqStr(v);
        break;
      }
    }
    if (!id) die(`no workspace member '${who}' (see gsdt-tracker members)`);
    return id;
  }
  return who;
}

function clickupCreate(a: string[]): number {
  if (a.length < 2) die('usage: gsdt-tracker create <list-id> <name> [--desc <md>|-] [--assign <who>]… [--status <s>] [--priority 1-4] [--tag <t>]… [--parent <id>]');
  const list = a[0]!;
  if (!grepQ(/^[0-9]+$/, list)) die(`not a list id: ${list} (see gsdt-tracker lists)`);
  const body: Record<string, J> = { name: a[1] };
  const rest = a.slice(2);
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]!;
    if (rest.length - i < 2) die(`${k} needs a value`);
    const val = rest[i + 1]!;
    switch (k) {
      case '--desc':
        body.markdown_content = descArg(val);
        break;
      case '--assign': {
        const v = argjson(clickupUser(val));
        body.assignees = [...((body.assignees as J[] | undefined) ?? []), v];
        break;
      }
      case '--status':
        body.status = val;
        break;
      case '--priority':
        prioOk(val);
        body.priority = BigInt(val);
        break;
      case '--tag':
        body.tags = [...((body.tags as J[] | undefined) ?? []), val];
        break;
      case '--parent': {
        const v = trkIdNorm(val, 'clickup');
        if (v === null) die(`not a ticket id: ${val}`);
        body.parent = v;
        break;
      }
      default:
        die(`unknown option for create: ${k}`);
    }
  }
  const o = parse(apiOrExit('POST', `/list/${list}/task`, ser(body)));
  echo(`✔ ClickUp ${jqStr(get(o, 'id'))} created · ${jqStr(alt(get(o, 'url'), ''))}`);
  return 0;
}

function clickupUpdate(a: string[]): number {
  if (a.length < 3) die('usage: gsdt-tracker update <id> [--name <n>] [--desc <md>|-] [--assign <who>]… [--unassign <who>]… [--status <s>] [--priority 1-4] [--parent <id>]');
  const id = trkIdNorm(a[0]!, 'clickup');
  if (id === null) die(`not a ticket id: ${a[0]}`);
  const body: Record<string, J> = {};
  const rest = a.slice(1);
  const asg = (): Record<string, J> => (body.assignees ??= {}) as Record<string, J>;
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]!;
    if (rest.length - i < 2) die(`${k} needs a value`);
    const val = rest[i + 1]!;
    switch (k) {
      case '--name':
        body.name = val;
        break;
      case '--desc':
        body.markdown_content = descArg(val);
        break;
      case '--assign': {
        const v = argjson(clickupUser(val));
        const o = asg();
        o.add = [...((o.add as J[] | undefined) ?? []), v];
        break;
      }
      case '--unassign': {
        const v = argjson(clickupUser(val));
        const o = asg();
        o.rem = [...((o.rem as J[] | undefined) ?? []), v];
        break;
      }
      case '--status':
        body.status = val;
        break;
      case '--priority':
        prioOk(val);
        body.priority = BigInt(val);
        break;
      case '--parent': {
        const v = trkIdNorm(val, 'clickup');
        if (v === null) die(`not a ticket id: ${val}`);
        body.parent = v;
        break;
      }
      default:
        die(`unknown option for update: ${k}`);
    }
  }
  apiOrExit('PUT', `/task/${id}`, ser(body));
  echo(`✔ ClickUp ${id} updated: ${Object.keys(body).sort().map((k) => k.replace('markdown_content', 'description')).join(', ')}`);
  return 0;
}

/** bash `$(( n ))` on a digits-only string: a leading 0 is octal (and 8/9 then an error). */
function bashInt(s: string): number {
  if (/^0[0-9]+$/.test(s)) {
    if (/[89]/.test(s)) {
      err(`gsdt-tracker: ${s}: value too great for base (error token is "${s}")\n`);
      throw new TrkExit(1);
    }
    return parseInt(s, 8);
  }
  return Number(s);
}

function clickupTasks(a: string[]): number {
  let q = '';
  let page = '0';
  let match = '';
  let pages = 1;
  for (let i = 0; i < a.length; ) {
    const k = a[i]!;
    if (k === '--closed') {
      q += '&include_closed=true';
      i++;
      continue;
    }
    if (a.length - i < 2) die(`${k} needs a value`);
    const v = a[i + 1]!;
    switch (k) {
      case '--list':
        if (!grepQ(/^[0-9]+$/, v)) die(`not a list id: ${v}`);
        q += `&list_ids%5B%5D=${v}`;
        break;
      case '--status':
        q += `&statuses%5B%5D=${jqUri(v)}`;
        break;
      case '--assign':
        q += `&assignees%5B%5D=${clickupUser(v)}`;
        break;
      case '--tag':
        q += `&tags%5B%5D=${jqUri(v)}`;
        break;
      case '--match':
        match = v;
        pages = 10;
        break;
      case '--page':
        if (!grepQ(/^[0-9]+$/, v)) die('--page needs a number');
        page = v;
        break;
      default:
        die(`unknown option for tasks: ${k}`);
    }
    i += 2;
  }
  const team = clickupTeam();
  let i = 0;
  let n = 0;
  while (i < pages) {
    const res = parse(apiOrExit('GET', `/team/${team}/task?page=${bashInt(page) + i}&subtasks=true${q}`));
    const tasks = get(res, 'tasks');
    n = Array.isArray(tasks) ? tasks.length : 0;
    const m = lower(match);
    for (const t of iter(tasks)) {
      const name = get(t, 'name');
      if (match === '' || (typeof name === 'string' ? lower(name) : jqStr(name)).includes(m)) {
        echo(`${jqStr(get(t, 'id'))}  [${jqStr(get(t, 'status', 'status'))}]  ${jqStr(get(t, 'name'))} · ${jqStr(alt(get(t, 'list', 'name'), ''))}`);
      }
    }
    i++;
    if (n < 100) break;
  }
  if (n >= 100) err(`• more tasks: add --page ${bashInt(page) + i}\n`);
  return 0;
}

function clickupLists(): number {
  const team = clickupTeam();
  const spaces = parse(apiOrExit('GET', `/team/${team}/space`));
  for (const sid of iter(get(spaces, 'spaces')).map((s) => jqStr(get(s, 'id')))) {
    for (const s of iter(get(spaces, 'spaces'))) {
      if (get(s, 'id') === sid) echo(`space  ${jqStr(get(s, 'id'))}  ${jqStr(get(s, 'name'))}`);
    }
    const folders = parse(apiOrExit('GET', `/space/${sid}/folder`));
    for (const f of iter(get(folders, 'folders'))) {
      echo(`  folder  ${jqStr(get(f, 'id'))}  ${jqStr(get(f, 'name'))}`);
      const ls = get(f, 'lists');
      if (Array.isArray(ls)) for (const l of ls) echo(`    list  ${jqStr(get(l, 'id'))}  ${jqStr(get(l, 'name'))}`);
    }
    const lists = parse(apiOrExit('GET', `/space/${sid}/list`));
    for (const l of iter(get(lists, 'lists'))) echo(`  list  ${jqStr(get(l, 'id'))}  ${jqStr(get(l, 'name'))}`);
  }
  return 0;
}

function clickupRaw(a: string[]): number {
  if (a.length < 2) die('usage: gsdt-tracker api <GET|POST|PUT|DELETE> </path> [json]');
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(a[0]!)) die(`method must be GET, POST, PUT or DELETE, not '${a[0]}'`);
  if (new RegExp(SP).test(a[1]!)) die('the path has spaces — encode them');
  if (!a[1]!.startsWith('/')) die('the path starts with / (it is under /api/v2, e.g. /task/abc123)');
  const body = a[2] ?? '';
  if (body !== '') {
    let ok = false;
    try {
      const v = JSON.parse(body);
      ok = v !== null && v !== false; // jq -e: null and false are "no"
    } catch {
      /* not JSON */
    }
    if (!ok) die('the body is not JSON');
  }
  return out_(apiOrExit(a[0]!, a[1]!, body));
}
const out_ = (body: string): number => {
  out(`${body}\n`);
  return 0;
};

// ── login ─────────────────────────────────────────────────────────────────────

let ttyBuf = '';
let ttyStarted = false;
/** One line from the terminal, asynchronously (so Ctrl-C can still reach the SIGINT handler). */
function ttyLine(): Promise<string | null> {
  return new Promise((resolve) => {
    const take = (): boolean => {
      const i = ttyBuf.indexOf('\n');
      if (i < 0) return false;
      const line = ttyBuf.slice(0, i);
      ttyBuf = ttyBuf.slice(i + 1);
      resolve(line);
      return true;
    };
    if (take()) return;
    const onData = (d: Buffer | string): void => {
      ttyBuf += d.toString();
      if (take()) cleanup();
    };
    const onEnd = (): void => {
      cleanup();
      ttyBuf = '';
      resolve(null); // end of input
    };
    const cleanup = (): void => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
    };
    ttyStarted = true;
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.resume();
  });
}

const stty = (args: string[]): string | null => {
  const r = spawnSync('stty', args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'ignore'] });
  return r.status === 0 ? chomp(r.stdout ?? '') : null;
};

/**
 * login [<name>]: one step for a token, in any folder. The profile: the argument, else the
 * profile in use, else the repo folder's name. When ~/.config/gsd/clickup-<name>.env already
 * holds a token it asks first (on a terminal): use it, or replace it. A new token is read
 * hidden on a terminal, else as one line of stdin, and tested: a token ClickUp refuses is
 * never saved. The file is mode 600 and keeps its other lines. In a git repo,
 * git config gsdt-tracker.profile <name> then picks it for this clone. .gsd.conf is never edited.
 */
async function clickupLogin(a: string[]): Promise<number> {
  let p = a[0] ?? '';
  let token = '';
  let verb = 'saved';
  let reuse = false;
  if (a.length > 1) die('usage: gsdt-tracker login [<profile>]');
  const inRepo = spawnSync('git', ['-C', REPO, 'rev-parse', '--git-dir'], { stdio: 'ignore' }).status === 0;
  if (!p) p = PROFILE;
  if (!p) {
    if (!inRepo) die('not in a git repo — name the profile: gsdt-tracker login <name>');
    p = profileFromRepo(REPO);
  }
  if (!trkProfileOk(p)) die(`'${p}' is not a profile name (letters, digits, . _ -) — use gsdt-tracker login <name>`);
  const home = process.env.HOME ?? '';
  const file = `${home}/.config/gsd/clickup-${p}.env`;
  const tty = isatty(0);

  // A token already saved for this profile: offer it before anything is typed.
  // With no terminal (a piped token) there is no one to ask: the new one wins.
  if (trkHasToken(file) && tty) {
    for (;;) {
      err(`A token for profile ${p} is already saved. Use it, or replace it? [U/r] `);
      const ans = (await ttyLine()) ?? 'u'; // read fails at end of input: use it
      if (ans === '' || /^[Uu]/.test(ans)) {
        reuse = true;
        break;
      }
      if (/^[Rr]/.test(ans)) break;
      err('  type u (use it) or r (replace it)\n');
    }
  }
  if (reuse) {
    const saved = parseEnvFile(readFileSync(file, 'utf8')).filter(([k]) => k === 'CLICKUP_API_TOKEN').pop();
    token = saved ? saved[1] : '';
    if (api('GET', '/user', '', token) !== null) verb = 'kept';
    else {
      err('• ClickUp did not accept the saved token — type a new one\n');
      reuse = false;
    }
  }

  if (!reuse) {
    if (tty) {
      // Echo goes off BEFORE the prompt shows, so a fast paste is never echoed.
      const was = stty(['-g']);
      stty(['-echo']);
      const onSig = (): void => {
        if (was) stty([was]);
        err('\n');
        process.exit(130);
      };
      process.on('SIGINT', onSig);
      process.on('SIGTERM', onSig);
      err(`ClickUp API token for profile ${p} (ClickUp → Settings → Apps; typing is hidden): `);
      token = (await ttyLine()) ?? '';
      if (was) stty([was]);
      process.off('SIGINT', onSig);
      process.off('SIGTERM', onSig);
      err('\n');
    } else {
      token = readLineSync().line;
    }
    token = token.replace(new RegExp(`^${SP}*`), '').replace(new RegExp(`${SP}*$`), '');
    if (!token) die('no token given — nothing saved');
    // The file is sourced: only token characters may go in it.
    if (!grepQ(/^[A-Za-z0-9_-]+$/, token)) die('that does not look like a ClickUp token (pk_…) — nothing saved');
    if (api('GET', '/user', '', token) === null) {
      err('gsdt-tracker: ClickUp did not accept that token — nothing saved\n');
      throw new TrkExit(2);
    }
    if (existsFile(file)) verb = 'replaced';
    const tmp = `${file}.tmp.${process.pid}`;
    const dir = file.slice(0, file.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let keep = '';
    if (existsFile(file)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      keep = lines.filter((l) => !new RegExp(`^${SP}*(export${SP}+)?CLICKUP_API_TOKEN=`).test(l)).map((l) => `${l}\n`).join('');
    }
    writeFileSync(tmp, `${keep}CLICKUP_API_TOKEN=${token}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }
  echo(`✔ ClickUp token OK — ${verb} → ${file} (only you can read it)`);

  if (inRepo) {
    const cur = trkGitGet(REPO, 'profile');
    if (cur === p) {
      echo(`✔ this repo already uses profile ${p} (git config gsdt-tracker.profile)`);
    } else if (spawnSync('git', ['-C', REPO, 'config', '--local', 'gsdt-tracker.profile', p], { stdio: ['inherit', 'inherit', 'inherit'] }).status === 0) {
      echo(`✔ this repo now uses profile ${p} (git config gsdt-tracker.profile: this clone and its worktrees, never committed)`);
    } else {
      echo(`• could not write git config — set it by hand: git -C ${REPO} config gsdt-tracker.profile ${p}`);
    }
    const conf = trkConfGet(REPO, 'tracker_profile');
    if (conf && conf !== p) echo(`• .gsd.conf says tracker_profile = ${conf}; in this clone git config wins, so ${p} is used`);
    const t = trkGet(REPO, 'tracker').val;
    if (t !== 'clickup') echo(`• the tracker here is ${t}, so start/finish/comment don't use ClickUp yet — set it: git config gsdt-tracker.tracker clickup (this clone), or tracker = clickup in .gsd.conf (the team)`);
  } else {
    echo(`• not in a git repo, so no repo uses it yet — in the repo, run: gsdt-tracker login ${p} (it offers this saved token)`);
  }
  const gp = process.env.GSD_TRACKER_PROFILE;
  if (gp && gp !== p) echo(`• GSD_TRACKER_PROFILE=${gp} is set in this shell and picks another profile`);
  if (process.env.GSD_CLICKUP_CONFIG) echo(`• GSD_CLICKUP_CONFIG is set in this shell, so ${process.env.GSD_CLICKUP_CONFIG} is read instead — unset GSD_CLICKUP_CONFIG`);
  if (process.env.CLICKUP_API_TOKEN) echo('• CLICKUP_API_TOKEN is set in this shell and wins over the file — unset CLICKUP_API_TOKEN');
  if (ttyStarted) process.stdin.pause();
  return 0;
}

/** tracker_run: $1 = the command, rest = its args (for start/finish/comment/status/snapshot: <id> <text>). */
export async function clickupRun(args: string[]): Promise<number> {
  const [cmd, ...a] = args;
  switch (cmd) {
    case 'start':
    case 'finish':
      return clickupMove(cmd, a[0]!, a[1]!);
    case 'comment':
      loadToken();
      if (api('POST', `/task/${a[0]}/comment`, `{"comment_text": ${pyJsonString(a[1]!)}}`) === null) throw new TrkExit(2);
      echo(`✔ ClickUp ${a[0]} → comment posted`);
      return 0;
    case 'status':
      loadToken();
      if (api('PUT', `/task/${a[0]}`, `{"status": ${pyJsonString(a[1]!)}}`) === null) throw new TrkExit(2);
      echo(`✔ ClickUp ${a[0]} → status '${a[1]}'`);
      return 0;
    case 'snapshot':
      return clickupSnapshot(a[0]!);
    case 'create':
    case 'update':
    case 'tasks':
    case 'lists':
    case 'members':
    case 'api':
      loadToken();
      switch (cmd) {
        case 'create':
          return clickupCreate(a);
        case 'update':
          return clickupUpdate(a);
        case 'tasks':
          return clickupTasks(a);
        case 'lists':
          return clickupLists();
        case 'members':
          for (const m of clickupMembers()) echo(`${jqStr(m.id)}  ${jqStr(alt(m.username, '-'))}  ${jqStr(alt(m.email, '-'))}`);
          return 0;
        default:
          return clickupRaw(a);
      }
    case 'check':
      loadToken();
      if (api('GET', '/user') === null) throw new TrkExit(2);
      echo(`✔ ClickUp token OK${PROFILE ? ` (profile ${PROFILE})` : ''}`);
      return 0;
    case 'login':
      return clickupLogin(a);
    default:
      return 0;
  }
}
