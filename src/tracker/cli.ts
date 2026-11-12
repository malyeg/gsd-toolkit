// src/tracker/cli.ts — gsdt-tracker's command line (port of bin/gsdt-tracker): arguments, the
// settings, the shared verbs, and the hand-off to a tracker. Standalone: imports only node:*
// and src/tracker/*.
import { closeSync, fstatSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { clickupRun, initClickup, TRACKER_EXTRA } from './clickup.ts';
import { trkGet, trkKnown, trkMain, trkPrintConfig } from './config.ts';
import { customRun } from './custom.ts';
import { trkIdExtract, trkIdNorm } from './ids.ts';
import { die, echo, err, io, lower, out, TrkExit } from './io.ts';

// What `gsdt-tracker --help` prints: the comment block at the top of the old bash script
// (lines 2.. up to `set -euo`, "# " stripped). Kept verbatim.
export const HELP = `
gsdt-tracker — read and write tickets (issues/tasks) from the shell.

Works in any folder: a plain git repo, a GSD repo, or none. It is standalone
(it uses only lib/tracker/), and the GSD toolkit runs it as a command:
gsdt-start calls \`start\` when a phase tagged tk-<id> is claimed or attached;
gsdt-finish calls \`finish\` after the merge (or when --pr opens the PR); the
/gsdt-flow ticket step calls \`snapshot\` to save the ticket as <P>-TICKET.md.

Usage:
  gsdt-tracker [--repo <dir>] [--tracker <name>] <command> …
    start    <id> <text>     ticket → "in progress" + comment
    finish   <id> <text>     ticket → "in testing" + comment
    comment  <id> <text>     post a comment
    status   <id> <status>   set the status
    snapshot <id> [--out <file>]
                             print the ticket as markdown (description +
                             comments); --out writes <file> only on success
    create   <where> <title> [option…]   new ticket; prints its id + url
    update   <id> <option>…              change fields of a ticket
    tasks    [option…]                   find tickets, one per line
    extract  <string>        print the id tagged in a title/branch (tk-<id>;
                             legacy cu_<id>, CU-<id>, "ClickUp <id>"), or nothing
    check                    verify the tracker is set up
    which                    print the tracker in use
    config                   print the settings in use and where each came
                             from (offline; never prints a token)
  <id> may be the bare id, tk-<id>, #<id>, or the ticket's URL.
  create/update/tasks options go to the tracker as written; what <where> is
  and which options work depend on it (ClickUp: see below).
  A tracker may add its own commands (ClickUp: lists, members, api, login).
  --tracker clickup forces ClickUp, whatever the repo sets.

Settings, first match wins: the environment, then the repo's git config
(section gsdt-tracker, in .git/config: never committed, shared by every
worktree of the clone), then .gsd.conf (a GSD repo's team settings):
  setting        env                          git config                  .gsd.conf
  tracker        GSD_TRACKER (--tracker wins) gsdt-tracker.tracker         tracker
  profile        GSD_TRACKER_PROFILE          gsdt-tracker.profile         tracker_profile
  command        -                            gsdt-tracker.command         tracker_command
  start status   GSD_TRACKER_STATUS_START     gsdt-tracker.statusStart     tracker_status_start
  finish status  GSD_TRACKER_STATUS_FINISH    gsdt-tracker.statusFinish    tracker_status_finish
With none of them the tracker is none in a repo with a .gsd.conf, else clickup.
(Legacy GSD_CLICKUP_STATUS_START / _FINISH still work.)
  none     start/finish/comment/status do nothing and succeed;
           snapshot/create/update/tasks fail (no tracker connected)
  clickup  the ClickUp API (see lib/tracker/clickup.sh for the token)
  custom   runs the command setting (relative to the repo root):
             <cmd> start|finish|comment|status <id> <text>
             <cmd> snapshot <id>  ·  <cmd> check
             <cmd> create <where> <title> [option…] · update <id> <option>…
             <cmd> tasks [option…]
           GSD_TRACKER_STATUS carries the configured status for start/finish.

ClickUp's options for create/update/tasks, and its own commands:
  create  <list-id> <name> [--desc <md>|-] [--assign <who>]… [--status <s>]
          [--priority 1-4] [--tag <t>]… [--parent <id>]   prints the new id + url
  update  <id> [--name <n>] [--desc <md>|-] [--assign <who>]… [--unassign <who>]…
          [--status <s>] [--priority 1-4] [--parent <id>]
  tasks   [--list <id>]… [--status <s>]… [--assign <who>]… [--tag <t>]…
          [--closed] [--match <text>] [--page <n>]        "<id>  [<status>]  <name> · <list>"
  lists                    spaces, folders and lists, with ids
  members                  workspace members: id, username, email
  api     <GET|POST|PUT|DELETE> </path> [json]   any API v2 call; prints the body
  login   [<profile>]      see below
<who> is me, a user id, an email or a username. --desc - reads stdin.
Priority: 1 urgent · 2 high · 3 normal · 4 low. --match filters task names
(the API has no text search) over up to 10 pages of 100.
The workspace: $CLICKUP_TEAM_ID (env or the token file), else the only one
the token sees.

A profile names the login: ClickUp then reads ~/.config/gsd/clickup-<name>.env
instead of the shared ~/.config/gsd/clickup.env (no fallback); custom gets
GSD_TRACKER_PROFILE. \`gsdt-tracker login [<name>]\` (ClickUp) asks for the token
(or offers the one already saved for <name>), tests it, saves that file, and
in a git repo sets gsdt-tracker.profile — one step.

Exit codes: 0 ok · 1 usage/config error · 2 tracker call failed.
gsdt-start / gsdt-finish report any failure as a note: a tracker outage never
blocks a claim or a merge.
`;

const SET_HINT = 'set it: git config gsdt-tracker.tracker clickup|custom (this clone), or tracker = in .gsd.conf';

/** The logical working directory like bash's $PWD: $PWD when it is this directory, else the real one. */
function pwd(): string {
  const cwd = process.cwd();
  const p = process.env.PWD;
  if (p && p.startsWith('/')) {
    try {
      const a = statSync(p);
      const b = statSync(cwd);
      if (a.ino === b.ino && a.dev === b.dev) return p;
    } catch {
      /* fall through */
    }
  }
  return cwd;
}

async function run(argv: string[]): Promise<number> {
  let a = [...argv];
  let repo = '';
  let tracker = '';
  while (a.length > 0) {
    const k = a[0]!;
    if (k === '--repo') {
      if (a.length < 2) die('--repo needs a directory');
      repo = a[1]!;
      a = a.slice(2);
    } else if (k === '--tracker') {
      if (a.length < 2) die('--tracker needs none, clickup, or custom');
      tracker = a[1]!;
      a = a.slice(2);
    } else if (k === '-h' || k === '--help') {
      out(HELP);
      return 0;
    } else break;
  }
  if (!repo) {
    const here = pwd();
    repo = trkMain(here) || here;
  }
  if (!tracker) tracker = trkGet(repo, 'tracker').val;
  tracker = lower(tracker);

  const cmd = a[0] ?? '';
  switch (cmd) {
    case '':
      err(HELP);
      return 1;
    case 'extract': {
      if (a.length < 2) die('usage: gsdt-tracker extract <string>');
      const id = trkIdExtract(a[1]!);
      if (id) echo(id);
      return 0;
    }
    case 'which':
      echo(tracker);
      return 0;
    case 'config':
      for (const l of trkPrintConfig(repo)) echo(l);
      return 0;
  }
  if (!trkKnown(tracker)) die(`unknown tracker '${tracker}' — use none, clickup, or custom`);

  let id = '';
  let outFile = '';
  switch (cmd) {
    case 'start':
    case 'finish':
    case 'comment':
    case 'status':
    case 'snapshot':
    case 'update': {
      if (cmd === 'snapshot') {
        if (a.length < 2) die('usage: gsdt-tracker snapshot <id>');
      } else if (cmd === 'update') {
        if (a.length < 3) die('usage: gsdt-tracker update <id> <option>…');
      } else if (a.length < 3) die(`usage: gsdt-tracker ${cmd} <id> <text>`);
      const n = trkIdNorm(a[1]!, tracker);
      if (n === null) die(`not a ticket id: ${a[1]}`);
      id = n;
      a = a.slice(2);
      if (cmd === 'snapshot' && a[0] === '--out') {
        if (a.length < 2) die('--out needs a file');
        outFile = a[1]!;
        a = a.slice(2);
      }
      a = [cmd, id, ...a];
      break;
    }
    case 'create':
      if (a.length < 3) die('usage: gsdt-tracker create <where> <title> [option…]');
      break;
    case 'tasks':
    case 'check':
      break;
    default: {
      // Not a shared verb: maybe one of the tracker's own.
      if (tracker === 'clickup') {
        initClickup(repo);
        if (` ${TRACKER_EXTRA} `.includes(` ${cmd} `)) {
          await clickupRun(a);
          return 0;
        }
      }
      const extra = tracker === 'clickup' ? ` (tracker ${tracker} also has: ${TRACKER_EXTRA})` : tracker === 'none' ? ` (the tracker here is none — ${SET_HINT})` : '';
      die(`unknown command: ${cmd}${extra} — see gsdt-tracker --help`);
    }
  }

  if (tracker === 'none') {
    switch (cmd) {
      case 'check':
        echo(`• tracker = none — no ticket updates (${SET_HINT})`);
        break;
      case 'snapshot':
      case 'create':
      case 'update':
      case 'tasks':
        die(`tracker = none — no tracker connected, nothing to ${cmd} (${SET_HINT})`);
      // eslint-disable-next-line no-fallthrough
      default:
        echo(`• tracker = none — ticket ${id} not updated`);
    }
    return 0;
  }

  if (tracker === 'clickup') initClickup(repo);
  const dispatch = (): Promise<number> => (tracker === 'clickup' ? clickupRun(a) : customRun(repo, a[0]!, a.slice(1)));
  if (cmd === 'snapshot' && outFile) {
    // A failed fetch must not leave an empty file: the file is what marks the
    // /gsdt-flow ticket step done.
    const tmp = `${outFile}.tmp.${process.pid}`;
    let rc = 1;
    let fd = -1;
    try {
      fd = openSync(tmp, 'w');
    } catch (e) {
      err(`gsdt-tracker: ${tmp}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'No such file or directory' : String(e)}\n`);
    }
    if (fd >= 0) {
      io.outFd = fd;
      try {
        rc = await dispatch();
      } catch (e) {
        if (!(e instanceof TrkExit)) throw e;
        rc = e.code;
      } finally {
        io.outFd = 1;
      }
      const size = fstatSync(fd).size;
      closeSync(fd);
      if (rc === 0 && size > 0) {
        renameSync(tmp, outFile);
        echo(`✔ ticket ${id} → ${outFile}`);
        return 0;
      }
      rmSync(tmp, { force: true });
    }
    die(`snapshot of ticket ${id} failed — ${outFile} not written`);
  }
  return dispatch();
}

/** gsdt-tracker — main(argv) → the exit code (0 ok · 1 usage/config error · 2 tracker call failed). */
export async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (e) {
    if (e instanceof TrkExit) return e.code;
    throw e;
  }
}
