// gsdt-notify — a desktop notification when a session waits for you.
// Launcher: bin/gsdt-notify → src/launch.mjs notify.
//
// `--hook` runs as a Claude hook (Notification, and PreToolUse on
// AskUserQuestion) and must never break or slow a session: nothing on stdout or
// stderr, always exit 0, nothing outside a set-up repo.
import { closeSync, openSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commandOnPath, findMain, git, toolkitRepo } from '../common.ts';
import { spawnSyncX as spawnSync } from '../spawn.ts';

export const HELP = `
gsdt-notify — a desktop notification when a session waits for you.

With several phase sessions open, one that stopped on a question or a
permission prompt sits unseen. gsdt-setup registers this as a Claude user
hook; it speaks up only in a repo gsdt-init set up.

Usage:
  gsdt-notify "<text>" [--title "<title>"]   show one now (a test of the setup)
  gsdt-notify --hook       for the Claude hooks: reads the hook's JSON on
                           stdin; notifies when the session asks a question,
                           needs a permission, or has been idle for a minute;
                           prints nothing; always exits 0.
  -h, --help               show this help

macOS: osascript (the first one asks to allow notifications from "Script
Editor"). Linux: notify-send when installed. Windows: nothing yet.
GSD_NOTIFY=off turns it off; gsdt-setup --no-user-hook removes the hook.
`;

const out = (s: string): void => {
  process.stdout.write(s);
};
const err = (s: string): void => {
  process.stderr.write(s);
};

/** Notification types that are news, not a session waiting for the user. */
const NOT_WAITING = new Set([
  'auth_success',
  'auth_storage_failure',
  'elicitation_complete',
  'elicitation_response',
  'agent_completed',
  'quota_auto_resume_fired',
  'quota_auto_resume_stale',
  'quota_auto_resume_disabled',
  'plugin_notification',
]);

/** two hooks can fire for one stop (the question, then its prompt): one notification per session in this many ms */
const QUIET_MS = 5000;

/** The command that shows a notification on this platform, or null. Text is passed as arguments, never as script. */
export function notifyArgv(platform: string, title: string, body: string): string[] | null {
  if (platform === 'darwin') {
    return ['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body];
  }
  if (platform === 'linux') return ['notify-send', '--', title, body];
  return null;
}

/** show it; false when this machine cannot */
export function notify(title: string, body: string): boolean {
  const argv = notifyArgv(process.platform, title, body);
  if (argv === null || commandOnPath(argv[0] as string) === null) return false;
  const r = spawnSync(argv[0] as string, argv.slice(1), { stdio: 'ignore', timeout: 5000 });
  return r.status === 0;
}

export type Note = { title: string; body: string; session: string };

/** A hook payload → what to show, or null (not a wait, or not a set-up repo). */
export function noteFor(payload: unknown, fallbackCwd: string): Note | null {
  const p = (payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '');
  const event = str('hook_event_name');
  let body = '';
  if (event === 'PreToolUse') {
    if (str('tool_name') !== 'AskUserQuestion') return null;
    body = 'has a question for you';
  } else {
    if (NOT_WAITING.has(str('notification_type'))) return null;
    body = str('message') || 'is waiting for you';
  }
  const cwd = str('cwd') || fallbackCwd;
  const main = findMain(cwd);
  if (main === '' || !toolkitRepo(main)) return null;
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  const where = path.basename(top.status === 0 && top.stdout.trim() !== '' ? top.stdout.trim() : cwd);
  // the worktree folder says which phase; in the main checkout that is the repo's own name
  const title = where === path.basename(main) ? `GSD · ${where}` : `GSD · ${path.basename(main)} · ${where}`;
  return { title: title.slice(0, 120), body: body.replace(/\s+/g, ' ').slice(0, 240), session: str('session_id') };
}

/** true when this session was notified less than QUIET_MS ago; marks it otherwise */
function recently(session: string): boolean {
  if (session === '') return false;
  const f = path.join(tmpdir(), `gsd-notify-${session.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}`);
  const now = Date.now();
  try {
    if (now - statSync(f).mtimeMs < QUIET_MS) return true;
  } catch {
    // no mark yet
  }
  try {
    closeSync(openSync(f, 'a'));
    utimesSync(f, new Date(now), new Date(now));
  } catch {
    // no mark: at worst two notifications
  }
  return false;
}

export function main(argv: string[]): number {
  let hook = false;
  let title = 'GSD';
  const text: string[] = [];
  for (let i = 0; i < argv.length; ) {
    const a = argv[i] as string;
    if (a === '--hook') {
      hook = true;
      i++;
    } else if (a === '--title') {
      if (argv.length - i < 2) {
        err('gsdt-notify: --title needs a text\n');
        return 2;
      }
      title = argv[i + 1] as string;
      i += 2;
    } else if (a === '-h' || a === '--help') {
      out(HELP);
      return 0;
    } else if (a.startsWith('-') && a !== '-') {
      err(`gsdt-notify: unknown argument: ${a} (see --help)\n`);
      return 2;
    } else {
      text.push(a);
      i++;
    }
  }
  if (!hook) {
    if (text.length === 0) {
      err('gsdt-notify: nothing to say (see --help)\n');
      return 2;
    }
    if (notify(title, text.join(' '))) return 0;
    err('gsdt-notify: no way to show a notification here (macOS: osascript, Linux: notify-send)\n');
    return 1;
  }
  // Never let the hook break a session: no error output, exit 0.
  try {
    process.stderr.write = (() => true) as typeof process.stderr.write;
    if ((process.env.GSD_NOTIFY ?? '') === 'off' || process.stdin.isTTY) return 0;
    const note = noteFor(JSON.parse(readFileSync(0, 'utf8')), process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (note !== null && !recently(note.session)) notify(note.title, note.body);
  } catch {
    // nothing to say
  }
  return 0;
}
