// gsdt-batch — run several quick tasks as one batch, in a FRESH session with the
// gsdt-batch skill already running (a batch-<date>-<slug> worktree of its own).
// Port of the bash bin/gsdt-batch (kept as the parity oracle in
// tests/fixtures/p10-old-bins/). wt-new runs as a child with its stdout sent to
// stderr, like the bash `( … ) >&2`; the session is a child too (Node has no exec),
// started in the worktree with the terminal passed through.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isatty } from 'node:tty';
import path from 'node:path';
import { base, chomp, commandOnPath, findMain, git, gsdPkg, isDir, isFile, wtdir } from '../common.ts';
import { GSD_GEMINI_GONE, modelResolve, modelValidate, providerArgv, providerGone, providerPrompt, providerRender, providerResolve } from '../provider.ts';
import { err, out, runSession } from '../stdio.ts';

// The header comment of bin/gsdt-batch before the port = the --help text.
const HELP = `
gsdt-batch — run several quick tasks as one batch, in a FRESH session with
the gsdt-batch skill already running. On Claude the session runs on Sonnet:
a small, fresh context makes every coordinator turn cheaper. The planners
keep the model gsd-core gives them (it never follows the session's model
unless GSD's settings say \`inherit\` — the skill checks that first).

Usage (from anywhere inside the repo):
  gsdt-batch [options] [--] <task list | brief | --file <path>> [gsd-quick-batch flags]

  A task list is what /gsd-quick-batch takes: one item per bulleted or
  numbered line ("- fix …"), quoted as one argument, or --file <path>.
  A brief is anything else, in your own words, quoted:
    gsdt-batch "Read plan/FIX-BRIEF-7.md. Validate every item, fix only the
    real ones, recommend the owner calls."
  Everything that is not an option below goes to the skill unchanged.

Options:
  --provider <p>      claude (default: the repo's provider), codex or custom
  --agent-command <c> the provider's executable
  --model <m>         the session's model (Claude default: sonnet; others:
                      their configured model). \`default\` = the CLI's own
  --name <slug>       the batch's name (default: the first words of the
                      list or brief, or the --file name)
  --repo <path>       the repo (default: the main checkout of the cwd)
  --print             print the worktree and command; make nothing

The batch runs in its OWN worktree: gsdt-batch makes a
batch-<YYYY-MM-DD>-<slug> branch + worktree off the base branch (next to the
phase worktrees), then starts the session there. Its commits land on that
branch, never on the base branch; \`gsdt-finish batch-…\` merges it (tests →
merge → push → cleanup, like a phase). Run from inside a batch-* worktree,
it starts the session there instead. A taken name gets -2, -3, … (unless
--name named it: then that worktree is reused). Without a terminal the
worktree is made and the command printed. The Sonnet switch is Claude-only:
other providers launch with their usual model, and gsdt-batch says so.
`;

class Stop extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}
const die = (m: string, code = 64): never => {
  err(`gsdt-batch: ${m}\n`);
  throw new Stop(code);
};
const say = (m: string): void => err(`gsdt-batch: ${m}\n`);

/** slugify — text → a-z0-9 words joined by -, at most 5 words / 40 chars (trailing - stripped) */
export function slugify(text: string): string {
  const lower = text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const words = lower.replace(/[^a-z0-9]/g, ' ').split(' ').filter((w) => w !== '');
  return words.slice(0, 5).join('-').slice(0, 40).replace(/-+$/, '');
}

/** The name a batch gets from its first argument: first non-blank line, one list marker removed. */
export function firstItem(first: string): string {
  const lines = `${first}\n`.split('\n').filter((l) => !/^[ \t\r\f\v]*$/.test(l));
  return (lines[0] ?? '').replace(/^[ \t\r\f\v]*(?:[-*]|[0-9]+[.)])[ \t\r\f\v]+/, '');
}

/** Does an argument belong to the task list (not the flags)? The bash `case` patterns. */
export function isListItem(a: string): boolean {
  return a.includes('\n') || /^-[ \t\n\r\f\v]/.test(a) || /^\*[ \t\n\r\f\v]/.test(a) || /^[0-9][\s\S]*[.)][ \t\n\r\f\v]/.test(a);
}

const pad = (n: number): string => String(n).padStart(2, '0');
/** `date +%Y-%m-%d` */
const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function run(argv: string[]): number | Promise<number> {
  let PROVIDER = '';
  let COMMAND = '';
  let MODEL = '';
  let MODEL_SET = false;
  let REPO = '';
  let PRINT = false;
  let NAME = '';
  let FILE = '';
  let FILE_AT = -1;
  const REST: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const left = argv.length - i;
    switch (a) {
      case '--name':
        if (left < 2) die('--name needs a slug');
        NAME = argv[++i] as string;
        break;
      case '--file':
        if (left < 2) die('--file needs a path');
        FILE = argv[++i] as string;
        FILE_AT = REST.length;
        REST.push('--file', FILE);
        break;
      case '--provider':
        if (left < 2) die('--provider needs a name');
        PROVIDER = argv[++i] as string;
        break;
      case '--agent-command':
        if (left < 2) die('--agent-command needs a command');
        COMMAND = argv[++i] as string;
        break;
      case '--model':
        if (left < 2) die('--model needs a model');
        MODEL = argv[++i] as string;
        MODEL_SET = true;
        break;
      case '--repo':
        if (left < 2) die('--repo needs a path');
        REPO = argv[++i] as string;
        break;
      case '--print':
        PRINT = true;
        break;
      case '-h':
      case '--help':
        out(HELP);
        return 0;
      case '--':
        REST.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      default:
        REST.push(a);
    }
  }
  if (REST.length === 0) die('nothing to run: gsdt-batch "- task one\n- task two", or gsdt-batch --file <path>');

  const MAIN = findMain(REPO || process.cwd());
  if (MAIN === '') die(`not inside a git repository${REPO !== '' ? `: ${REPO}` : ''}`);
  const BASE = base(MAIN);
  if (BASE === '') die(`could not tell the base branch — set 'base = <branch>' in ${MAIN}/.gsd.conf`);

  // gsd-core runs a batch in the checkout it starts in only when that checkout
  // has its own .planning/ (else it uses the main checkout's, and merges there).
  if (chomp(git(MAIN, ['ls-tree', '-d', BASE, '--', '.planning']).stdout) === '') {
    die(`'.planning/' is not committed on '${BASE}': the batch worktree would have none, and gsd-core would then run the batch in the main checkout. Commit .planning/ first (GSD's commit_docs = true).`);
  }

  // Where the session runs: the current batch-* worktree, or a new one.
  const hereDir = REPO || process.cwd();
  const hb = git(hereDir, ['branch', '--show-current']);
  const HERE_BR = hb.status === 0 ? chomp(hb.stdout) : '';
  const ht = git(hereDir, ['rev-parse', '--show-toplevel']);
  const HERE_TOP = ht.status === 0 ? chomp(ht.stdout) : '';
  let DEST = '';
  let MAKE = false;
  let BR = '';
  if (HERE_BR.startsWith('batch-') && REPO === '' && HERE_TOP !== MAIN) {
    DEST = HERE_TOP;
    BR = HERE_BR;
  }
  if (DEST === '') {
    let SLUG: string;
    if (NAME !== '') SLUG = slugify(NAME.startsWith('batch-') ? NAME.slice(6) : NAME);
    else if (FILE !== '') {
      const f = FILE.slice(FILE.lastIndexOf('/') + 1);
      const dot = f.lastIndexOf('.');
      SLUG = slugify(dot >= 0 ? f.slice(0, dot) : f);
    } else {
      let first = '';
      for (const a of REST) {
        if (!a.startsWith('--')) {
          first = a;
          break;
        }
      }
      SLUG = slugify(firstItem(first));
    }
    if (SLUG === '') SLUG = 'batch';
    BR = `batch-${today()}-${SLUG}`;
    if (NAME === '') {
      // a derived name never reuses another batch's worktree
      let n = 1;
      let tryBr = BR;
      while (git(MAIN, ['show-ref', '--verify', '--quiet', `refs/heads/${tryBr}`]).status === 0) {
        n++;
        tryBr = `${BR}-${n}`;
      }
      BR = tryBr;
    }
    let w = '';
    for (const line of git(MAIN, ['worktree', 'list', '--porcelain']).stdout.split('\n')) {
      if (line.startsWith('worktree ')) w = line.slice(9);
      if (line === `branch refs/heads/${BR}`) {
        DEST = w;
        break;
      }
    }
    if (DEST === '') DEST = `${path.dirname(MAIN)}/${wtdir(MAIN)}/${BR}`;
    MAKE = true;
  }

  // --file: the session runs in the worktree, so the path is made absolute, and
  // a file git tracks on the base branch is read from the worktree's own copy.
  if (FILE_AT >= 0) {
    let abs = FILE.startsWith('/') ? FILE : `${process.cwd()}/${FILE}`;
    if (!isFile(abs)) die(`--file: no such file: ${FILE}`);
    abs = `${realpathSync(path.dirname(abs))}/${path.basename(abs)}`;
    const mainp = realpathSync(MAIN);
    if (abs.startsWith(`${mainp}/`)) {
      const rel = abs.slice(mainp.length + 1);
      if (git(MAIN, ['cat-file', '-e', `${BASE}:${rel}`]).status === 0) abs = `${DEST}/${rel}`;
    }
    REST[FILE_AT + 1] = abs;
  }
  if (providerGone(PROVIDER)) die(GSD_GEMINI_GONE);
  const pr = providerResolve(MAIN, PROVIDER, COMMAND);
  if (!pr.ok) {
    if (pr.message !== '') err(`${pr.message}\n`);
    return 64;
  }
  const P = pr.value.provider;
  const AGENT = pr.value.command;
  if (P === 'claude') {
    if (!MODEL_SET) MODEL = 'sonnet';
    const bad = modelValidate(P, MODEL);
    if (bad) {
      if (bad.message !== '') err(`${bad.message}\n`);
      return 64;
    }
    if (MODEL === 'default') MODEL = '';
  } else {
    const mr = modelResolve(MAIN, P, MODEL);
    if (!mr.ok) {
      if (mr.message !== '') err(`${mr.message}\n`);
      return 64;
    }
    MODEL = mr.value;
    say(`the switch to Sonnet is Claude-only; ${P} runs with its usual model.`);
  }

  // Flags first, then the task list on lines of its own: a flag typed after
  // the list must not become part of its last item.
  let FLAGS = '';
  let LIST = '';
  for (const a of REST) {
    if (isListItem(a)) LIST = LIST !== '' ? `${LIST}\n${a}` : a;
    else FLAGS = FLAGS !== '' ? `${FLAGS} ${a}` : a;
  }
  let ARGS = FLAGS;
  if (LIST !== '') ARGS = ARGS !== '' ? `${ARGS}\n${LIST}` : LIST;
  const PROMPT = providerPrompt(P, 'batch', ARGS);
  const av = providerArgv(P, AGENT, PROMPT, MODEL, '');
  if (!av.ok) {
    if (av.message !== '') err(`${av.message}\n`);
    return 64;
  }
  const ARGV = av.value;

  if (PRINT) {
    if (MAKE && !isDir(DEST)) say(`would make worktree ${DEST} (branch '${BR}' off ${BASE})`);
    else say(`would use worktree ${DEST}`);
    out(`${providerRender(DEST, ...ARGV)}\n`);
    return 0;
  }
  if (MAKE) {
    // `( cd "$MAIN" && … gsdt-wt-new --batch "$BR" ) >&2`: its stdout goes to stderr
    const r = spawnSync(`${gsdPkg()}/bin/gsdt-wt-new`, ['--batch', BR], {
      cwd: MAIN,
      env: { ...process.env, GSD_WT_NEW_SUPPRESS_NEXT: '1' },
      stdio: ['inherit', 2, 'inherit'],
    });
    if (r.error || r.status !== 0) die(`could not make the batch worktree ${BR}`, 1);
  }
  if (!isatty(0) || !isatty(1)) {
    out(`${providerRender(DEST, ...ARGV)}\n`);
    return 0;
  }
  if (commandOnPath(AGENT) === null) die(`${AGENT} not found on PATH`, 69);
  out(`▶ opening a ${P} batch session${MODEL !== '' ? ` on ${MODEL}` : ''} in ${DEST}…\n`);
  out(`  land it afterwards: gsdt-finish ${BR}\n`);
  if (!isDir(DEST)) die(`cannot enter ${DEST}`, 1);
  return runSession(ARGV[0] as string, ARGV.slice(1), DEST);
}

export function main(argv: string[]): number | Promise<number> {
  try {
    return run(argv);
  } catch (e) {
    if (e instanceof Stop) return e.code;
    throw e;
  }
}
