// gsdt-batch-report — how many tokens a quick-task batch used, per role and per item
// (port of bin/gsdt-batch-report + the python engine; engine: ../batch-report.ts).
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { findMain } from '../common.ts';
import { GSD_GEMINI_GONE, providerGone, providerKnown } from '../provider.ts';
import { err, out } from '../stdio.ts';
import { projdir, report, type ReportOpts } from '../batch-report.ts';

/** the --help text: the old bin's header comment, as its usage() printed it */
export const HELP = `
gsdt-batch-report — how many tokens a quick-task batch used, per role and
per item. Reads Claude Code's transcripts; read-only, costs no tokens.

A batch is one /gsd-quick-batch or /gsdt-batch run. It is counted from its
start to its end, not as the whole session (a session may hold other work
or several batches): the main session's turns inside it (the coordinator),
every helper it spawned (planners, executors, scouts, gsd-quick fallbacks),
and the helpers those spawned.

Usage:
  gsdt-batch-report [options]

Options:
  --last <N>        the last N batches (default: the last one)
  --days <N>        every batch started in the last N days
  --session <id>    the batches in one session (a prefix of its id is enough)
  --items <N>       item count for the per-item numbers (default: read from
                    the run — the gsdt-batch done line, else the quick-task
                    ids its planners/executors name, else the planner count)
  --baseline <file> compare with a report saved earlier with --json
                    (default: the built-in numbers from the week before
                    2026-11-09, see docs/plan-gsdt-batch.md)
  --json            machine-readable output
  --repo <path>     the repo whose batches to read (default: the main
                    checkout of the current directory)
  --dir <path>      read this Claude Code project folder instead
                    (~/.claude/projects/<the repo path, / → ->)
  --provider <name> claude (default). Codex keeps no such transcripts:
                    "not supported yet", exit 0

Columns: AGENTS · TURNS (API calls) · BASH/AG (Bash calls per helper) ·
FRESH IN / CACHE WR / CACHE RD (input split by kind — a cache read costs
about a tenth of fresh input) · OUTPUT · WEIGHTED (input cost in fresh-token
units: cache write ×1.25, or ×2 for the 1-hour cache, cache read ×0.1).

Transcripts are read as data: counted, never printed. CLAUDE_CONFIG_DIR is
honored (default ~/.claude).

Exit: 0 = report printed (also when no batch was found); 64 = bad usage.
`;


class Die extends Error {
  code: number;
  constructor(msg: string, code = 64) {
    super(msg);
    this.code = code;
  }
}

/** bash $PWD: the logical cwd when the environment's PWD still names this directory */
function bashPwd(): string {
  const cwd = process.cwd();
  const p = process.env.PWD;
  if (p !== undefined && p.startsWith('/')) {
    try {
      if (realpathSync(p) === realpathSync(cwd)) return p;
    } catch {
      /* fall through */
    }
  }
  return cwd;
}
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const phys = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return '';
  }
};

export function main(argv: string[]): number {
  try {
    return run(argv);
  } catch (e) {
    if (e instanceof Die) {
      err(`gsdt-batch-report: ${e.message}\n`);
      return e.code;
    }
    throw e;
  }
}

function run(argv: string[]): number {
  const o: ReportOpts = { dir: '' };
  let repo = '';
  let dir = '';
  let provider = 'claude';
  let pick = '';
  const num = (opt: string, v: string): void => {
    if (!/^[0-9]+$/.test(v)) throw new Die(`${opt} needs a whole number, got: ${v}`);
  };
  const a = [...argv];
  while (a.length) {
    const k = a[0] as string;
    const v = a[1];
    switch (k) {
      case '--last':
      case '--days':
      case '--items': {
        if (v === undefined) throw new Die(`${k} needs a value`);
        num(k, v);
        if (k !== '--items') {
          if (pick) throw new Die('use one of --last, --days, --session');
          pick = k;
        }
        if (k === '--last') o.last = Number(v);
        else if (k === '--days') o.days = Number(v);
        else o.items = Number(v);
        a.shift();
        break;
      }
      case '--session':
        if (v === undefined) throw new Die('--session needs a value');
        if (!/^[A-Za-z0-9-]+$/.test(v)) throw new Die(`--session: not a session id: ${v}`);
        if (pick) throw new Die('use one of --last, --days, --session');
        pick = k;
        o.session = v;
        a.shift();
        break;
      case '--baseline':
        if (v === undefined) throw new Die('--baseline needs a file');
        if (!isFile(v)) throw new Die(`--baseline: no such file: ${v}`);
        o.baseline = v;
        a.shift();
        break;
      case '--json':
        o.json = true;
        break;
      case '--repo':
        if (v === undefined) throw new Die('--repo needs a path');
        repo = v;
        a.shift();
        break;
      case '--dir':
        if (v === undefined) throw new Die('--dir needs a path');
        dir = v;
        a.shift();
        break;
      case '--provider':
        if (v === undefined) throw new Die('--provider needs a name');
        provider = v;
        a.shift();
        break;
      case '-h':
      case '--help':
        out(HELP);
        return 0;
      default:
        throw new Die(`unknown option: ${k} (see --help)`);
    }
    a.shift();
  }

  if (providerGone(provider)) throw new Die(GSD_GEMINI_GONE);
  if (!providerKnown(provider)) throw new Die(`unknown provider: ${provider} (claude, codex, custom)`);
  if (provider !== 'claude') {
    out(`gsdt-batch-report: not supported yet for ${provider} — it reads Claude Code transcripts only.\n`);
    return 0;
  }

  if (dir === '') {
    const pwd = bashPwd();
    if (repo === '') repo = findMain(pwd) || pwd;
    if (!isDir(repo)) throw new Die(`--repo: no such folder: ${repo}`);
    repo = path.resolve(pwd, repo);
    // Claude Code names the folder after the path it was started in: try the
    // current directory's own spelling too when it is the same folder.
    const repos = [repo];
    if (phys(process.cwd()) === phys(repo) && pwd !== repo) repos.push(pwd);
    dir = projdir(process.env.CLAUDE_CONFIG_DIR || `${process.env.HOME ?? ''}/.claude`, repos);
  }
  if (!isDir(dir)) {
    out(`gsdt-batch-report: no Claude Code transcripts for this repo (looked in ${dir}).\n`);
    return 0;
  }
  o.dir = dir;
  const r = report(o);
  out(r.stdout);
  err(r.stderr);
  return r.rc;
}
