// planning — internal engine CLI, a drop-in for `python3 lib/gsd_planning.py`:
//
//   node src/launch.mjs planning reconcile FILE [--path P]
//   node src/launch.mjs planning repair DIR [--check]
//
// Same argv, usage text, error messages and exit codes as the Python's
// argparse (a small hand-rolled parser for exactly this grammar). Known
// differences: --help text is the one argparse prints at width 80 (it does not
// follow $COLUMNS); a non-UTF-8 or unreadable file gives a one-line error and
// exit 1 instead of a Python traceback.
import { reconcileFile, repairDir } from '../planning.ts';

const USAGE_TOP = 'usage: gsd_planning [-h] {reconcile,repair} ...\n';
const USAGE_RECONCILE = 'usage: gsd_planning reconcile [-h] [--path PATH] file\n';
const USAGE_REPAIR = 'usage: gsd_planning repair [-h] [--check] planning\n';

export const HELP_TOP = `${USAGE_TOP}
gsd_planning.py — reconcile GSD planning files after a union-style merge.
\`.planning/ROADMAP.md\` and \`.planning/STATE.md\` carry a union merge strategy
so parallel phase sessions can each append their own entries without
conflicting. Union is right for append-only content and WRONG for every line
that is a single source of truth: when a phase branch flips a line that the
base branch also changed, union keeps BOTH sides and the file starts
contradicting itself. This module reconciles the both-sides result back to one
coherent file. reconcile Fix ONE file in place. Structural only — no counter
is recomputed, because a merge driver runs mid-merge when the rest of the tree
is not yet consistent. Conflicting counters resolve to the most-advanced
candidate; \`repair\` fixes them properly. repair Fix .planning/ROADMAP.md +
STATE.md AND recompute every derived counter from ground truth: phases from
the roadmap, plans and summaries from disk. Idempotent. With --check it writes
nothing and exits 1 if either file needs repair. Two rules the reconciliation
is built on, both learned from real corruption: * Keyed content (checklist
entries, table rows, phase detail sections) keeps the position of the key's
FIRST occurrence and the content of its BEST occurrence — "[x]" beats "[ ]", a
real status beats "Not started", and among equals the longer text wins because
it carries the "(completed <date>)" suffix. Keeping the later line instead
would reorder phases out of sequence. * Single-value fields resolve to their
LAST occurrence, because \`git merge-file --union\` emits ours-then-theirs
inside a conflict hunk, so the last copy is the incoming branch's value. This
is verified against real merges — see tests/fixtures. Deduplication of single-
value fields is always SCOPED to the block that owns the field. STATE.md's "##
Session Continuity" section is never touched: its \`Last session:\` / \`Stopped
at:\` / \`Resume file:\` lines are one entry per past session and legitimately
repeat. A global "keep the last occurrence" pass would silently delete real
history.

positional arguments:
  {reconcile,repair}
    reconcile         structural pass over one file, in place
    repair            reconcile + recompute counters

options:
  -h, --help          show this help message and exit
`;
export const HELP_RECONCILE = `${USAGE_RECONCILE}
positional arguments:
  file

options:
  -h, --help   show this help message and exit
  --path PATH  the file's repo-relative path (git's %P)
`;
export const HELP_REPAIR = `${USAGE_REPAIR}
positional arguments:
  planning    path to the .planning directory

options:
  -h, --help  show this help message and exit
  --check     report only; exit 1 if repair is needed
`;

// ── difflib.get_close_matches(word, choices, 1) (what argparse suggests with) ─

function matchedChars(a: string[], b: string[]): number {
  const rec = (alo: number, ahi: number, blo: number, bhi: number): number => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (let j = blo; j < bhi; j++) {
        if (a[i] !== b[j]) continue;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = next;
    }
    if (bestsize === 0) return 0;
    return bestsize + rec(alo, besti, blo, bestj) + rec(besti + bestsize, ahi, bestj + bestsize, bhi);
  };
  return rec(0, a.length, 0, b.length);
}

function closeMatch(word: string, choices: string[]): string | null {
  const w = Array.from(word);
  let best: { score: number; choice: string } | null = null;
  for (const c of choices) {
    const a = Array.from(c);
    const total = a.length + w.length;
    const score = total === 0 ? 1 : (2 * matchedChars(a, w)) / total;
    if (score >= 0.6 && (best === null || score > best.score)) best = { score, choice: c };
  }
  return best?.choice ?? null;
}

/** Python repr() of a str, for the common cases */
function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += `\\${q}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return q + out + q;
}

// ── argparse, for this grammar only ─────────────────────────────────────────

class ArgError extends Error {
  usage: string;
  prog: string;
  constructor(usage: string, prog: string, message: string) {
    super(message);
    this.usage = usage;
    this.prog = prog;
  }
}
class HelpShown extends Error {
  text: string;
  constructor(text: string) {
    super('help');
    this.text = text;
  }
}

type OptSpec = { names: string[]; dest: string; value: boolean };
type ParserSpec = { prog: string; usage: string; help: string; opts: OptSpec[]; positional: string };

const NEG_NUM = /^-(?:\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?|\.\d+(?:_\d+)*)$/;

type Classified =
  | { t: 'pos' }
  | { t: 'opt'; spec: OptSpec; shown: string; explicit: string | null }
  | { t: 'unknown' };

function classify(spec: ParserSpec, arg: string): Classified {
  if (arg === '' || arg[0] !== '-') return { t: 'pos' };
  const find = (name: string): OptSpec | undefined => spec.opts.find((o) => o.names.includes(name));
  const exact = find(arg);
  if (exact) return { t: 'opt', spec: exact, shown: arg, explicit: null };
  if (arg.length === 1) return { t: 'pos' };
  if (arg.includes('=')) {
    const i = arg.indexOf('=');
    const o = find(arg.slice(0, i));
    if (o) return { t: 'opt', spec: o, shown: arg.slice(0, i), explicit: arg.slice(i + 1) };
  }
  // abbreviations
  const cands: { spec: OptSpec; name: string; explicit: string | null }[] = [];
  if (arg.startsWith('--')) {
    const i = arg.indexOf('=');
    const prefix = i < 0 ? arg : arg.slice(0, i);
    const explicit = i < 0 ? null : arg.slice(i + 1);
    for (const o of spec.opts) for (const n of o.names) if (n.startsWith(prefix)) cands.push({ spec: o, name: n, explicit });
  } else {
    const short = arg.slice(0, 2);
    for (const o of spec.opts)
      for (const n of o.names) {
        if (n === short) cands.push({ spec: o, name: n, explicit: arg.slice(2) });
        else if (n.startsWith(arg)) cands.push({ spec: o, name: n, explicit: null });
      }
  }
  if (cands.length > 1)
    throw new ArgError(spec.usage, spec.prog, `ambiguous option: ${arg} could match ${cands.map((c) => c.name).join(', ')}`);
  if (cands.length === 1) {
    const c = cands[0] as (typeof cands)[number];
    return { t: 'opt', spec: c.spec, shown: c.name, explicit: c.explicit };
  }
  if (NEG_NUM.test(arg)) return { t: 'pos' };
  if (arg.includes(' ')) return { t: 'pos' };
  return { t: 'unknown' };
}

const displayName = (o: OptSpec): string => o.names.join('/');

/** Parse the args after the subcommand: {values, extras} or throw ArgError/HelpShown. */
function parseSub(spec: ParserSpec, args: string[]): { values: Map<string, string | true>; extras: string[] } {
  const values = new Map<string, string | true>();
  const extras: string[] = [];
  let positional: string | null = null;
  let rest = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!rest && arg === '--') {
      rest = true;
      continue;
    }
    const c: Classified = rest ? { t: 'pos' } : classify(spec, arg);
    if (c.t === 'pos') {
      if (positional === null) positional = arg;
      else extras.push(arg);
      continue;
    }
    if (c.t === 'unknown') {
      extras.push(arg);
      continue;
    }
    const o = c.spec;
    if (o.dest === 'help') {
      if (c.explicit !== null && c.shown.startsWith('--')) {
        throw new ArgError(spec.usage, spec.prog, `argument ${displayName(o)}: ignored explicit argument ${pyRepr(c.explicit)}`);
      }
      throw new HelpShown(spec.help);
    }
    if (!o.value) {
      if (c.explicit !== null) {
        throw new ArgError(spec.usage, spec.prog, `argument ${displayName(o)}: ignored explicit argument ${pyRepr(c.explicit)}`);
      }
      values.set(o.dest, true);
      continue;
    }
    if (c.explicit !== null) {
      values.set(o.dest, c.explicit);
      continue;
    }
    const nextArg = args[i + 1];
    if (nextArg === undefined || nextArg === '--' || classify(spec, nextArg).t !== 'pos') {
      throw new ArgError(spec.usage, spec.prog, `argument ${displayName(o)}: expected one argument`);
    }
    values.set(o.dest, nextArg);
    i++;
  }
  if (positional === null) {
    throw new ArgError(spec.usage, spec.prog, `the following arguments are required: ${spec.positional}`);
  }
  values.set(spec.positional, positional);
  return { values, extras };
}

const HELP_OPT: OptSpec = { names: ['-h', '--help'], dest: 'help', value: false };
const RECONCILE: ParserSpec = {
  prog: 'gsd_planning reconcile',
  usage: USAGE_RECONCILE,
  help: HELP_RECONCILE,
  opts: [HELP_OPT, { names: ['--path'], dest: 'path', value: true }],
  positional: 'file',
};
const REPAIR: ParserSpec = {
  prog: 'gsd_planning repair',
  usage: USAGE_REPAIR,
  help: HELP_REPAIR,
  opts: [HELP_OPT, { names: ['--check'], dest: 'check', value: false }],
  positional: 'planning',
};
const TOP: ParserSpec = { prog: 'gsd_planning', usage: USAGE_TOP, help: HELP_TOP, opts: [HELP_OPT], positional: 'cmd' };
const CHOICES = ['reconcile', 'repair'];

export type Parsed =
  | { cmd: 'reconcile'; file: string; path: string | null }
  | { cmd: 'repair'; planning: string; check: boolean };

/** parser.parse_args(argv) */
export function parseArgs(argv: string[]): Parsed {
  const topExtras: string[] = [];
  let cmdAt = -1;
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!rest && arg === '--') {
      rest = true;
      continue;
    }
    const c: Classified = rest ? { t: 'pos' } : classify(TOP, arg);
    if (c.t === 'pos') {
      cmdAt = i;
      break;
    }
    if (c.t === 'unknown') {
      topExtras.push(arg);
      continue;
    }
    if (c.explicit !== null && c.shown.startsWith('--')) {
      throw new ArgError(USAGE_TOP, TOP.prog, `argument -h/--help: ignored explicit argument ${pyRepr(c.explicit)}`);
    }
    throw new HelpShown(HELP_TOP);
  }
  if (cmdAt < 0) throw new ArgError(USAGE_TOP, TOP.prog, 'the following arguments are required: cmd');
  const cmd = argv[cmdAt] as string;
  if (!CHOICES.includes(cmd)) {
    const near = closeMatch(cmd, CHOICES);
    const choices = CHOICES.map(pyRepr).join(', ');
    throw new ArgError(
      USAGE_TOP,
      TOP.prog,
      `argument cmd: invalid choice: ${pyRepr(cmd)}${near ? `, maybe you meant ${pyRepr(near)}?` : ''} (choose from ${choices})`,
    );
  }
  const sub = cmd === 'reconcile' ? RECONCILE : REPAIR;
  const { values, extras } = parseSub(sub, argv.slice(cmdAt + 1));
  const all = [...topExtras, ...extras];
  if (all.length) throw new ArgError(USAGE_TOP, TOP.prog, `unrecognized arguments: ${all.join(' ')}`);
  if (cmd === 'reconcile') {
    return { cmd, file: values.get('file') as string, path: (values.get('path') as string | undefined) ?? null };
  }
  return { cmd: 'repair', planning: values.get('planning') as string, check: values.get('check') === true };
}

export function main(argv: string[]): number {
  let args: Parsed;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof HelpShown) {
      process.stdout.write(e.text);
      return 0;
    }
    if (e instanceof ArgError) {
      process.stderr.write(`${e.usage}${e.prog}: error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  try {
    const r = args.cmd === 'reconcile' ? reconcileFile(args.file, args.path) : repairDir(args.planning, args.check);
    process.stdout.write(r.out);
    process.stderr.write(r.err);
    return r.rc;
  } catch (e) {
    process.stderr.write(`gsd_planning: ${(e as Error).message}\n`);
    return 1;
  }
}
