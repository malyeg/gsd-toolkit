// src/tracker/custom.ts — any tracker, through the repo's own script (lib/tracker/custom.sh).
//
// .gsd.conf:  tracker = custom
//             tracker_command = scripts/tracker.sh   (relative to the repo root)
// (or git config gsdt-tracker.tracker custom / gsdt-tracker.command <script>)
// Called as:  <cmd> start|finish|comment|status <id> <text-or-status>
//             <cmd> snapshot <id>     → prints the ticket as markdown
//             <cmd> check             → exit 0 when set up
//             <cmd> create <where> <title> [option…] · update <id> <option>…
//             <cmd> tasks [option…]
// GSD_TRACKER_STATUS holds the configured status name for start/finish (else empty);
// GSD_TRACKER_PROFILE holds the profile (or is empty). A call that runs past
// GSD_TRACKER_TIMEOUT (60s) is stopped: TERM, one second later KILL, exit 2.
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { trkCommand, trkGet } from './config.ts';
import { die, err, io } from './io.ts';

/** custom_cmd: the script, or `die` (exit 1). */
export function customCmd(repo: string): string {
  const c = trkCommand(repo);
  if (!c) die('tracker = custom needs its script: tracker_command = <script> in .gsd.conf, or git config gsdt-tracker.command <script>');
  try {
    accessSync(c, constants.X_OK);
  } catch {
    die(`tracker_command '${c}' is not an executable file`);
  }
  return c;
}

/** Perl's numification of the timeout string (`alarm $t`): the leading number, else 0. */
function perlNum(s: string): number {
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(s);
  return m ? Math.trunc(Number(m[1])) : 0;
}

/** custom_timed: run the script, stopped after GSD_TRACKER_TIMEOUT seconds (0 or less = never). Exit status like the perl wrapper's. */
function customTimed(c: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const raw = process.env.GSD_TRACKER_TIMEOUT || '60';
  const t = perlNum(raw);
  return new Promise((resolve) => {
    const child = spawn(c, args, { env, stdio: [0, io.outFd, 2] });
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    child.on('error', () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(127); // exec failed
    });
    child.on('close', (code, signal) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(signal ? 128 + (signal === 'SIGTERM' ? 15 : signal === 'SIGKILL' ? 9 : 1) : (code ?? 1));
    });
    if (t > 0) {
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          child.kill('SIGKILL');
          err(`tracker_command gave no answer in ${raw}s — stopped it\n`);
          resolve(124);
        }, 1000);
      }, t * 1000);
    }
  });
}

/** tracker_run for custom: any failure of the script is exit 2. */
export async function customRun(repo: string, cmd: string, args: string[]): Promise<number> {
  const c = customCmd(repo);
  const env: NodeJS.ProcessEnv = { ...process.env, GSD_TRACKER_PROFILE: trkGet(repo, 'profile').val };
  process.env.GSD_TRACKER_PROFILE = env.GSD_TRACKER_PROFILE;
  env.GSD_TRACKER_STATUS = cmd === 'start' || cmd === 'finish' ? trkGet(repo, cmd === 'start' ? 'status_start' : 'status_finish').val : '';
  const rc = await customTimed(c, [cmd, ...args], env);
  return rc === 0 ? 0 : 2;
}
