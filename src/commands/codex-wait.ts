// gsdt-codex-wait — port of bin/gsdt-codex-wait (the old bash is the oracle in
// tests/fixtures/p10-old-bins/). Waits out a Codex usage limit instead of failing.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { human, parse, parseDuration, scan, when } from '../codex-wait.ts';

const USAGE = `
gsdt-codex-wait — wait out a Codex usage limit instead of failing.

When its quota runs out, Codex stops with "You've hit your usage limit …
try again at <time>". This waits until that time (plus a margin) and then
runs the command again — or only waits, for callers that cannot be wrapped
(the /gsd-review skill). The review is then done later, never skipped. The
waiting never calls Codex, so it burns no quota.

Usage:
  gsdt-codex-wait [options] -- <command> [args...]
      run the command; on a Codex usage limit wait for the reset and run it
      again; otherwise exit with the command's own code
  gsdt-codex-wait [options] --wait-only
      only wait for the reset, then exit 0 — run the step again after it

Options:
  --message <text>  Codex's limit message (--wait-only). Default: the newest
                    limited run in Codex's session logs ($CODEX_HOME/sessions,
                    default ~/.codex/sessions); without one, wait --interval
  --max-wait <dur>  give up when the total wait would pass this (default 24h)
  --interval <dur>  how long to wait when no reset time is known (default 30m)
  --margin <dur>    wait this long past the reset Codex gave (default 2m;
                    Codex prints minutes only)
  <dur> = seconds, or a number with s / m / h / d (90s, 30m, 4h, 1d)

A limit counts only when the command FAILED and Codex's limit message is in
its output, or in a Codex session log written since it started (scripts
that hide Codex's stderr still work). A review that merely quotes the
message does not count. Output streams through unchanged.

Exit: the command's code (wrap); 0 after the wait (--wait-only); 75 = gave
up, the wait would pass --max-wait — nothing was reviewed, never treat it as
a pass; 64 = bad usage.

Long waits: run it as a BACKGROUND job — agent tool calls in the foreground
are cut off (Claude Code: run_in_background; foreground stops at 10 min).
On macOS it keeps the Mac awake while it waits (caffeinate -i -w).
`;

class Exit extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function writeBuf(fd: number, b: Buffer): void {
  let off = 0;
  while (off < b.length) {
    try {
      off += writeSync(fd, b, off, b.length - off);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') continue;
      if (code === 'EPIPE') return;
      throw e;
    }
  }
}
const say = (s: string): void => writeBuf(2, Buffer.from(`gsdt-codex-wait: ${s}\n`));
const die = (s: string, code = 64): never => {
  say(s);
  throw new Exit(code);
};

const clockFile = (): string => process.env.GSD_CODEX_WAIT_CLOCK ?? '';
// Tests set GSD_CODEX_WAIT_CLOCK=<file holding epoch seconds>: the clock is
// read from it and a wait just moves it forward, so hours pass in no time.
const now = (): number => (clockFile() ? parseInt(readFileSync(clockFile(), 'utf8').trim(), 10) : Math.floor(Date.now() / 1000));
const nap = async (s: number): Promise<void> => {
  if (clockFile()) writeFileSync(clockFile(), `${now() + s}\n`);
  else await new Promise<void>((r) => setTimeout(r, s * 1000));
};

let awake = false;
function keepAwake(): void {
  if (awake) return;
  awake = true;
  if (!clockFile() && process.platform === 'darwin') {
    try {
      const c = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true });
      c.on('error', () => {});
      c.unref();
    } catch {
      /* no caffeinate */
    }
  }
}

type Opts = { msg: string; haveMsg: boolean; waitOnly: boolean; max: number; interval: number; margin: number; cmd: string[] };

function parseArgs(argv: string[]): Opts | 'help' {
  const o: Opts = { msg: '', haveMsg: false, waitOnly: false, max: 86400, interval: 1800, margin: 120, cmd: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] as string;
    if (a === '--message') {
      if (argv.length - i < 2) die('--message needs a value');
      o.msg = argv[i + 1] as string;
      o.haveMsg = true;
      i++;
    } else if (a === '--max-wait' || a === '--interval' || a === '--margin') {
      if (argv.length - i < 2) die(`${a} needs a value`);
      const raw = argv[i + 1] as string;
      const v = parseDuration(raw);
      if (v === null) die(`${a}: not a duration: ${raw} (use 90s, 30m, 4h, 1d)`);
      if (a === '--max-wait') o.max = v as number;
      else if (a === '--interval') o.interval = v as number;
      else o.margin = v as number;
      i++;
    } else if (a === '--wait-only') o.waitOnly = true;
    else if (a === '-h' || a === '--help') return 'help';
    else if (a === '--') {
      i++;
      break;
    } else die(`unknown option: ${a} (put the command after --)`);
    i++;
  }
  o.cmd = argv.slice(i);
  if (o.waitOnly) {
    if (o.cmd.length) die('--wait-only takes no command');
  } else if (!o.cmd.length) die('nothing to run: gsdt-codex-wait -- <command> [args...], or --wait-only');
  if (!(o.interval > 0)) die('--interval must be more than 0');
  return o;
}

async function run(o: Opts): Promise<number> {
  const codexDir = process.env.CODEX_HOME || path.join(process.env.HOME ?? homedir(), '.codex');
  const deadline = now() + o.max;

  // Wait for the reset (epoch, null = unknown; src = where it came from). Short
  // naps, re-reading the clock: one long sleep runs late after the machine sleeps.
  // Gives up with exit 75 when the wait would pass --max-wait.
  const waitReset = async (reset: number | null, src: string): Promise<void> => {
    let target: number;
    if (reset !== null) {
      target = reset + o.margin;
      if (!o.waitOnly && !(target > now() + 60)) target = now() + 60;
      say(`Codex usage limit — it resets ${when(reset)} (${src}).`);
    } else {
      target = now() + o.interval;
      say(`Codex usage limit — no reset time found (${src}); checking again in ${human(o.interval)}.`);
    }
    if (target > deadline) {
      say(`GAVE UP: waiting until ${when(target)} would pass --max-wait (${human(o.max)}).`);
      say('The Codex step did not run: this is NOT a pass. Run it again after the reset.');
      throw new Exit(75);
    }
    let left = target - now();
    if (!(left > 0)) return;
    say(`waiting ${human(left)}, until ${when(target)}…`);
    keepAwake();
    while (left > 0) {
      if (left > 60) left = 60;
      await nap(left);
      left = target - now();
    }
  };

  // The reset time from Codex's session logs changed since `since`.
  // → {reset} (null when the message has none); null when no log has a limit.
  const fromLogs = (since: number): { reset: number | null } | null => {
    const hit = scan(codexDir, since);
    if (!hit) return null;
    const r = parse(hit.message, hit.mtime);
    return { reset: r.rc === 0 ? r.epoch : null };
  };

  if (o.waitOnly) {
    let reset: number | null = null;
    let src: string;
    if (o.haveMsg) {
      const r = parse(o.msg, now());
      if (r.rc === 2) die('--message has no Codex usage-limit text in it');
      reset = r.rc === 0 ? r.epoch : null;
      src = 'from --message';
    } else {
      const l = fromLogs(now() - 8 * 86400);
      if (l) {
        reset = l.reset;
        src = "from Codex's session log";
      } else src = `no limited run in ${codexDir}/sessions`;
    }
    if (reset !== null && reset + o.margin <= now()) {
      say(`Codex's limit already reset (${when(reset)}) — run the step again.`);
      return 0;
    }
    await waitReset(reset, src);
    say('done waiting — Codex should take requests again. Run the step again.');
    return 0;
  }

  const [cmd, ...cargs] = o.cmd as [string, ...string[]];
  for (;;) {
    const start = now();
    // Stream stdout and stderr through as they are, keeping a copy of each.
    const outs: Buffer[] = [];
    const errs: Buffer[] = [];
    const rc = await new Promise<number>((resolve) => {
      const c = spawn(cmd, cargs, { stdio: ['inherit', 'pipe', 'pipe'] });
      c.stdout.on('data', (b: Buffer) => {
        outs.push(b);
        writeBuf(1, b);
      });
      c.stderr.on('data', (b: Buffer) => {
        errs.push(b);
        writeBuf(2, b);
      });
      c.on('error', (e: NodeJS.ErrnoException) => {
        // what bash prints for a command it cannot run
        const why = e.code === 'ENOENT' ? (cmd.includes('/') ? 'No such file or directory' : 'command not found') : e.code === 'EACCES' ? 'Permission denied' : e.message;
        const b = Buffer.from(`gsdt-codex-wait: ${cmd}: ${why}\n`);
        errs.push(b);
        writeBuf(2, b);
        resolve(e.code === 'ENOENT' ? 127 : 126);
      });
      c.on('close', (code, sig) => resolve(code ?? 128 + (sig ? ((constants.signals as Record<string, number>)[sig] ?? 0) : 0)));
    });
    if (rc === 0) return 0;
    const r = parse(Buffer.concat([...outs, ...errs]).toString('utf8'), now());
    let reset: number | null;
    let src: string;
    if (r.rc !== 2) {
      reset = r.rc === 0 ? r.epoch : null;
      src = 'from its output';
    } else {
      const l = fromLogs(start - 5);
      if (!l) return rc;
      reset = l.reset;
      src = "from Codex's session log";
    }
    await waitReset(reset, src);
    say(`running it again: ${o.cmd.join(' ')}`);
  }
}

export async function main(argv: string[]): Promise<number> {
  try {
    const o = parseArgs(argv);
    if (o === 'help') {
      writeBuf(1, Buffer.from(USAGE));
      return 0;
    }
    return await run(o);
  } catch (e) {
    if (e instanceof Exit) return e.code;
    throw e;
  }
}
