// gsdt-list — list the GSD phases of a repo: number, description, plan
// progress, and worktree/branch state. Read-only; safe from anywhere.
// Port of the bash bin/gsdt-list (kept as the parity oracle in
// tests/fixtures/p5-old-bins/); the table was a Perl program there.
//
// Lengths and padding count characters (code points), like the Perl did with
// the roadmap decoded as UTF-8. Branch names and paths came into the Perl
// through %ENV, undecoded, so a non-ASCII branch name was printed as latin1
// mojibake; `bytes()` keeps that (never reached by ASCII names).
import { WIN, spawnSyncX as spawnSync } from '../spawn.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { git, isDir, isFile, lf, pendingTodos } from '../common.ts';
import { staleHooksNotice } from '../provider.ts';
import { updateNotice } from '../version.ts';

const HELP = `gsdt-list — list GSD phases: number, description, plan progress, worktree

USAGE
  gsdt-list [--repo <path>] [--compact]
  gsdt-list --milestones [--repo <path>]
  gsdt-list --milestone <version> [--repo <path>] [--compact]

  By default long PHASE/WORKTREE cells wrap across lines to fit the screen
  (nothing truncated). Use --compact for the one-line-per-phase view.

OPTIONS
  --repo <path>   main checkout of the target repo
                  (default: derived from the current directory)
  --compact, -c   one line per phase, clipping each cell to fit (old default)
  --milestones    list the archived milestones (/gsd-complete-milestone moved
                  them to .planning/milestones/): version, name, phases, shipped
  --milestone <v> the phase table of one archived milestone (v1.0 or 1.0),
                  read from .planning/milestones/<v>-ROADMAP.md and <v>-phases/
  -h, --help      show this help

COLUMNS
  N         phase number — what gsdt-start -p <N> attaches to
  PHASE     description from the '### Phase N:' heading in ROADMAP.md
  PLANS     plans executed/total (a plan is done once it has a SUMMARY),
            e.g. 5/6 · ✔ = all executed · — = none yet
  STAGE     furthest lifecycle step reached, from the phase's artifact files:
            spec → discuss → ui → plan → execute → verify → done
            verify = all plans executed but ROADMAP's checklist row is not
            ticked yet (gsd-core ticks it when /gsd-verify-work passes);
            done = ticked.
            A phase with no plan files is done when ROADMAP ticks it
            (- [x] **Phase N): work done outside GSD, like a baseline.
  WORKTREE  the phase's phase-<N>-* branch; ● = worktree attached

  Under the table: the batch-* branches of gsdt-batch runs not landed yet
  (● = worktree attached). Land one with gsdt-finish <branch>.
  Then how many gsd-core todos wait in .planning/todos/pending, if any.

RELATED
  gsdt-start -n "<desc>"     claim a NEW phase and open its session
  gsdt-start -p <N>       attach to an existing phase (no duplicate claim)
  gsdt-finish             finish the phase from inside its worktree
`;

class Die extends Error {}
const die = (msg: string): never => {
  throw new Die(msg);
};

/** What Perl sees for a string that came through %ENV / argv: its UTF-8 bytes as latin1 characters. */
const bytes = (s: string): string => Buffer.from(s, 'utf8').toString('latin1');
/** Perl `length`: characters. */
const len = (s: string): number => Array.from(s).length;
const substr = (s: string, from: number, n?: number): string => {
  const a = Array.from(s);
  return (n === undefined ? a.slice(from) : a.slice(from, from + n)).join('');
};
/** sprintf `%*s` / `%-*s` */
const padL = (s: string, w: number): string => ' '.repeat(Math.max(0, w - len(s))) + s;
const padR = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - len(s)));
/** Perl numification of a string ("70abc" is 70, "abc" is 0) */
const num = (s: string): number => {
  const m = /^\s*[-+]?(?:\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)/.exec(s);
  return m ? parseFloat(m[0]) : 0;
};

type Phase = { n: string; title: string; plans: string; stage: string; wt: string; wtmark: string };
type Scan = { fp: number; fs: number; planning: boolean; ui: boolean; discuss: boolean; spec: boolean };

// phase number → its .planning/phases/<NN>-* directory. Dir prefixes are
// zero-padded ('01', '10', '01.1'); ROADMAP numbers aren't ('1', '10', '01.1'),
// so normalize both by stripping one leading zero before matching.
const norm = (k: string): string => k.replace(/^0(?=\d)/, '');

function dirIn(cache: Map<string, Map<string, string>>, proot: string, n: string): string | undefined {
  if (!proot) return undefined;
  let m = cache.get(proot);
  if (!m) {
    m = new Map();
    let names: string[] = [];
    try {
      names = readdirSync(proot);
    } catch {
      // no phases dir
    }
    for (const d of names) {
      if (d.startsWith('.') || !isDir(`${proot}/${d}`)) continue;
      m.set(norm(d.replace(/-[^\n]*$/, '')), `${proot}/${d}`);
    }
    cache.set(proot, m);
  }
  return m.get(norm(n));
}

// Scan a phase's artifact files: how many plans exist / were executed (a plan
// is executed once it has a matching SUMMARY), plus which earlier steps ran.
// In-flight artifacts live on the phase BRANCH, so prefer the phase's attached
// worktree when there is one — the main checkout only sees merged state.
function scan(cache: Map<string, Map<string, string>>, phasesRoot: string, n: string, wtroot: string | undefined): Scan {
  const r: Scan = { fp: 0, fs: 0, planning: false, ui: false, discuss: false, spec: false };
  const dir = (wtroot ? dirIn(cache, `${wtroot}/.planning/phases`, n) : undefined) || dirIn(cache, phasesRoot, n);
  if (!dir) return r;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return r;
  }
  for (const f of names) {
    if (/-PLAN\.md$/i.test(f)) {
      r.fp++;
      continue;
    }
    if (/-SUMMARY\.md$/i.test(f)) {
      r.fs++;
      continue;
    }
    if (/RESEARCH\.md$/i.test(f) || /PATTERNS\.md$/i.test(f) || /PLAN-OUTLINE\.md$/i.test(f)) r.planning = true;
    if (/UI-SPEC\.md$/i.test(f)) r.ui = true;
    if (/CONTEXT\.md$/i.test(f) || /DISCUSSION-LOG\.md$/i.test(f) || /(TICKET|STORY)\.md$/i.test(f) || /DISCUSS-CHECKPOINT\.json$/i.test(f)) r.discuss = true;
    if (/SPEC\.md$/i.test(f) && !/UI-SPEC\.md$/i.test(f)) r.spec = true;
  }
  return r;
}

/** `split /\s+/, $s` in Perl: a leading empty field stays, trailing ones go. */
function splitWords(s: string): string[] {
  const a = s.split(/\s+/);
  while (a.length > 0 && a[a.length - 1] === '') a.pop();
  return a;
}

// word-wrap a description to width w, hard-breaking any word longer than w
function wrapWords(s: string, w: number): string[] {
  const out: string[] = [];
  let line = '';
  for (let word of splitWords(s)) {
    while (len(word) > w) {
      if (len(line) > 0) {
        out.push(line);
        line = '';
      }
      out.push(substr(word, 0, w));
      word = substr(word, w);
    }
    if (len(line) === 0) line = word;
    else if (len(line) + 1 + len(word) <= w) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (len(line) > 0) out.push(line);
  return out.length > 0 ? out : [''];
}

// hard-wrap a branch name to width w, keeping the ● marker on the last line
function wrapWt(p: Phase, w: number): string[] {
  if (p.wt === '—') return ['—'];
  let s = p.wt;
  const out: string[] = [];
  while (len(s) > 0) {
    out.push(substr(s, 0, w));
    s = substr(s, w);
  }
  const mark = p.wtmark;
  if (len(mark) > 0) {
    if (len(out[out.length - 1] as string) + len(mark) <= w) out[out.length - 1] += mark;
    else out.push(substr(mark, 1));
  }
  return out;
}

export type ListInput = {
  roadmap: string; // path, printed in the "no phases" line
  text: string; // ROADMAP.md, decoded
  wt: Map<string, string>; // branch → worktree path
  branches: string[];
  batches: string[];
  /** gsd-core todos waiting in .planning/todos/pending (none: no line) */
  todos?: { files: number; boxes: number };
  phasesRoot: string;
  termcols: number;
  full: boolean;
  /** an archived milestone's version (v1.0): only its phases, and its own footer */
  milestone?: string;
  /** how a branch/path is shown (Perl's byte strings) */
  show?: (s: string) => string;
};

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The `### Phase N: title` headings of a ROADMAP. With a milestone version,
 * an archived ROADMAP that has `## v<version>` sections (gsd-core copies the
 * whole ROADMAP, later milestones too) gives only the phases under them. */
export function phaseHeadings(text: string, milestone?: string): { n: string; title: string }[] {
  const lines = text.split('\n');
  const sec = milestone === undefined ? null : new RegExp(`^## v?${escRe(milestone.replace(/^v/, ''))}(?:\\s|$)`);
  const scoped = sec !== null && lines.some((l) => sec.test(l));
  const out: { n: string; title: string }[] = [];
  let inSec = !scoped;
  for (const line of lines) {
    if (scoped && line.startsWith('## ')) inSec = (sec as RegExp).test(line);
    const m = /^### Phase ([0-9]+(?:\.[0-9]+)?):\s*([^\n]+?)\s*$/.exec(line);
    if (m && inSec) out.push({ n: m[1] as string, title: m[2] as string });
  }
  return out;
}

export type Milestone = { version: string; roadmap: string; phasesRoot: string };

/** `v1.10` after `v1.9`: numbers compared part by part, base 10. */
const cmpVersion = (a: string, b: string): number => {
  const pa = a.replace(/^v/, '').split(/[^0-9]+/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[^0-9]+/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return a < b ? -1 : a > b ? 1 : 0;
};

/** The milestones /gsd-complete-milestone archived: `.planning/milestones/<v>-ROADMAP.md`, oldest first. */
export function archivedMilestones(planning: string): Milestone[] {
  const dir = `${planning}/milestones`;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((f) => /^(v?[0-9][^/]*?)-ROADMAP\.md$/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined && isFile(`${dir}/${v}-ROADMAP.md`))
    .sort(cmpVersion)
    .map((v) => ({ version: v, roadmap: `${dir}/${v}-ROADMAP.md`, phasesRoot: `${dir}/${v}-phases` }));
}

/** `gsdt-list --milestones`: one line per archived milestone. Name and date come
 * from MILESTONES.md (`## v1.0 <name> (Shipped: <date>)`), when it has them. */
export function renderMilestones(planning: string, ms: Milestone[], read: (f: string) => string | null): string {
  if (ms.length === 0) return `no archived milestones in ${planning}/milestones (/gsd-complete-milestone makes them)\n`;
  const index = read(`${planning}/MILESTONES.md`) ?? '';
  const rows = ms.map((m) => {
    const head = new RegExp(`^## v?${escRe(m.version.replace(/^v/, ''))}(?:\\s+(.*?))?\\s*$`, 'm').exec(index);
    let name = (head?.[1] ?? '').trim();
    let shipped = '';
    const d = /\(\s*shipped:?\s*([^)]*?)\s*\)\s*$/i.exec(name);
    if (d) {
      shipped = d[1] as string;
      name = name.slice(0, d.index).trim();
    }
    const text = read(m.roadmap);
    const phases = text === null ? '?' : String(phaseHeadings(lf(text), m.version).length);
    return [m.version, name || '—', phases, shipped || '—'];
  });
  const head = ['MILESTONE', 'NAME', 'PHASES', 'SHIPPED'];
  const w = head.map((h, i) => Math.max(len(h), ...rows.map((r) => len(r[i] as string))));
  const line = (r: string[]): string => `  ${padR(r[0] as string, w[0] as number)}  ${padR(r[1] as string, w[1] as number)}  ${padL(r[2] as string, w[2] as number)}  ${r[3]}\n`;
  let out = line(head);
  for (const r of rows) out += line(r);
  out += '\n  one milestone\'s phases: gsdt-list --milestone <version> · current: gsdt-list\n';
  return out;
}

/** The table and the lines under it, as the Perl printed them. */
export function renderList(inp: ListInput): string {
  const show = inp.show ?? ((s: string): string => s);
  const phases: Phase[] = phaseHeadings(inp.text, inp.milestone).map((h) => ({ ...h, plans: '', stage: '', wt: '', wtmark: '' }));
  if (phases.length === 0) return `no phases found in ${show(inp.roadmap)}\n`;
  // phases ticked "- [x] **Phase N" in the checklist: one done outside GSD has no plan files to count
  const ticked = new Set<string>();
  for (const line of inp.text.split('\n')) {
    const m = /^- \[[xX]\] \*\*Phase ([0-9]+(?:\.[0-9]+)?)(?![0-9.])/.exec(line);
    if (m) ticked.add(norm(m[1] as string));
  }

  const cache = new Map<string, Map<string, string>>();
  for (const p of phases) {
    // match the phase's feature branch; PR branches (/gsd-pr-branch, *-pr) don't count
    const prefix = `phase-${p.n}-`;
    const br = inp.branches.find((b) => b.startsWith(prefix) && !b.endsWith('-pr'));
    const wtroot = br !== undefined ? inp.wt.get(br) : undefined;
    const s = scan(cache, inp.phasesRoot, p.n, wtroot ? wtroot : undefined);
    // PLANS: executed/total from the files · ✔ all executed · — no plans yet
    p.plans = s.fp === 0 ? '—' : s.fs >= s.fp ? '✔' : `${s.fs}/${s.fp}`;
    // STAGE: furthest lifecycle step reached; 'verify' once every plan is executed, 'done' once ROADMAP ticks it
    p.stage =
      s.fp > 0 ? (s.fs >= s.fp ? (ticked.has(norm(p.n)) ? 'done' : 'verify') : s.fs > 0 ? 'execute' : 'plan') : ticked.has(norm(p.n)) ? 'done' : s.planning ? 'plan' : s.ui ? 'ui' : s.discuss ? 'discuss' : s.spec ? 'spec' : '—';
    // keep the branch name and the ● attached-marker apart so clipping a long
    // branch never eats the marker (it lives at the end of the cell)
    p.wt = br !== undefined ? show(br) : '—';
    p.wtmark = br !== undefined && inp.wt.has(br) ? ' ●' : '';
  }

  const max = (...xs: string[]): number => xs.reduce((w, x) => Math.max(w, len(x)), 0);
  const termcols = inp.termcols;
  const wN = max('N', ...phases.map((p) => p.n));
  const wP = max('PLANS', ...phases.map((p) => p.plans));
  const wS = max('STAGE', ...phases.map((p) => p.stage));
  const wWnat = max('WORKTREE', ...phases.map((p) => p.wt + p.wtmark));
  const wTnat = max('PHASE', ...phases.map((p) => p.title));
  let wW = wWnat;
  let wT = wTnat;
  const frame = 16; // '│ ' + ' │ '×4 + ' │'
  const avail = termcols - frame - wN - wP - wS;

  if (inp.full) {
    // wrap mode: fit the real screen and wrap long cells instead of truncating.
    // Branch names have no spaces (they wrap poorly), so cap WORKTREE to a
    // third of the row and give the rest to PHASE — but never stretch either
    // column past the text it actually holds.
    let cap = Math.trunc(avail / 3);
    if (cap > 40) cap = 40;
    if (cap < 12) cap = 12;
    if (wW > cap) wW = cap;
    wT = avail - wW;
    if (wT > wTnat) wT = wTnat;
    if (wT < 20) wT = 20;
  } else if (wT + wW > avail) {
    // clip mode: PHASE is the description humans read; the WORKTREE branch name
    // just repeats N + a slug of it, so surrender space from WORKTREE first.
    wW = avail - wT;
    if (wW < 12) {
      wW = 12;
      wT = avail - wW;
      if (wT < 20) wT = 20;
    }
  }
  const clip = (s: string, w: number): string => (len(s) <= w ? s : `${perlSubstr(s, w - 1)}…`);
  // clip the branch name but always keep the trailing ● marker visible
  const wtcell = (p: Phase): string => (p.wtmark === '' ? clip(p.wt, wW) : clip(p.wt, wW - len(p.wtmark)) + p.wtmark);

  const rowMulti = (p: Phase): string => {
    const tl = wrapWords(p.title, wT);
    const wl = wrapWt(p, wW);
    const lines = Math.max(tl.length, wl.length);
    let out = '';
    for (let i = 0; i < lines; i++) {
      out += `│ ${padL(i ? '' : p.n, wN)} │ ${padR(tl[i] ?? '', wT)} │ ${padL(i ? '' : p.plans, wP)} │ ${padR(i ? '' : p.stage, wS)} │ ${padR(wl[i] ?? '', wW)} │\n`;
    }
    return out;
  };
  const rule = (l: string, m: string, r: string, fill = '─'): string =>
    `${l}${fill.repeat(wN + 2)}${m}${fill.repeat(wT + 2)}${m}${fill.repeat(wP + 2)}${m}${fill.repeat(wS + 2)}${m}${fill.repeat(wW + 2)}${r}\n`;
  const row = (n: string, t: string, pl: string, st: string, w: string): string =>
    `│ ${padL(n, wN)} │ ${padR(clip(t, wT), wT)} │ ${padL(pl, wP)} │ ${padR(st, wS)} │ ${padR(w, wW)} │\n`;

  let out = rule('┌', '┬', '┐');
  out += row('N', 'PHASE', 'PLANS', 'STAGE', 'WORKTREE');
  out += rule('├', '┼', '┤');
  phases.forEach((p, i) => {
    out += inp.full ? rowMulti(p) : row(p.n, p.title, p.plans, p.stage, wtcell(p));
    if (i < phases.length - 1) out += rule('├', '┼', '┤', '┈');
  });
  out += rule('└', '┴', '┘');
  if (inp.milestone !== undefined) {
    out += `  milestone ${inp.milestone} (archived) · all milestones: gsdt-list --milestones · current: gsdt-list\n`;
    return out;
  }
  out += '  new phase: gsdt-start -n "<desc>" · attach: gsdt-start -p <N> · ● worktree attached\n';
  if (inp.batches.length > 0) {
    out += '\n  batches (gsdt-batch; land with gsdt-finish <branch>):\n';
    for (const b of inp.batches) out += `    ${inp.wt.has(b) ? '● ' : '  '}${show(b)}\n`;
  }
  const t = inp.todos;
  if (t && t.files > 0) {
    const boxes = t.boxes > 0 ? ` (${t.boxes} open checkbox${t.boxes === 1 ? '' : 'es'})` : '';
    out += `\n  todos waiting: ${t.files} in .planning/todos/pending${boxes} — /gsd-capture --list;\n  a phase-sized one → /gsd-capture --backlog, then /gsd-review-backlog\n`;
  }
  return out;
}

/** Perl `substr($s, 0, $n)` with a negative $n (drop that many from the end) */
function perlSubstr(s: string, n: number): string {
  const a = Array.from(s);
  return (n >= 0 ? a.slice(0, n) : a.slice(0, Math.max(0, a.length + n))).join('');
}

const lineList = (s: string): string[] => s.split('\n').filter((l) => l !== '');

export function main(argv: string[]): number {
  const err = (s: string): void => void process.stderr.write(s);
  try {
    let repo = '';
    let full = true; // wrap-to-screen is the default; --compact opts out
    let listMilestones = false;
    let milestone: string | undefined;
    for (let i = 0; i < argv.length; ) {
      const a = argv[i] as string;
      if (a === '-h' || a === '--help') {
        process.stdout.write(HELP);
        return 0;
      }
      if (a === '--repo') {
        if (argv.length - i < 2) die('--repo needs a value');
        repo = argv[i + 1] as string;
        i += 2;
      } else if (a === '-c' || a === '--compact') {
        full = false;
        i++;
      } else if (a === '--milestones') {
        listMilestones = true;
        i++;
      } else if (a === '--milestone') {
        if (argv.length - i < 2 || (argv[i + 1] as string) === '') die('--milestone needs a version (e.g. v1.0; see gsdt-list --milestones)');
        milestone = argv[i + 1] as string;
        i += 2;
      } else if (a === '--full') {
        full = true; // accepted for back-compat (now the default)
        i++;
      } else die(`unknown argument: ${a} (see gsdt-list --help)`);
    }
    if (listMilestones && milestone !== undefined) die('use --milestones or --milestone <version>, not both');

    updateNotice();
    for (const l of staleHooksNotice()) err(`${l}\n`);

    // ── locate the main checkout (same detection as gsdt-start) ──
    let main: string;
    if (repo !== '') {
      const r = git(repo, ['rev-parse', '--show-toplevel']);
      if (r.status !== 0) die(`--repo is not a git checkout: ${repo}`);
      main = r.stdout.replace(/\n+$/, '');
    } else {
      if (git('.', ['rev-parse', '--show-toplevel']).status !== 0) die('not inside a git repo — cd into the target repo or pass --repo <path>');
      const w = git('.', ['worktree', 'list', '--porcelain']);
      main = (w.stdout.split('\n').find((l) => l.startsWith('worktree ')) ?? '').slice(9);
    }
    const planning = `${main}/.planning`;
    const readOrNull = (f: string): string | null => {
      try {
        return readFileSync(f, 'utf8');
      } catch {
        return null;
      }
    };
    if (listMilestones) {
      if (!isDir(planning)) die(`${planning} not found — is GSD initialized here?`);
      process.stdout.write(renderMilestones(planning, archivedMilestones(planning), readOrNull));
      return 0;
    }
    let ms: Milestone | undefined;
    if (milestone !== undefined) {
      const all = archivedMilestones(planning);
      const want = milestone.replace(/^v/, '');
      ms = all.find((m) => m.version.replace(/^v/, '') === want);
      if (!ms) die(`no archived milestone ${milestone} in ${planning}/milestones (${all.length > 0 ? `there: ${all.map((m) => m.version).join(', ')}` : 'none archived yet'})`);
    }
    const roadmap = ms ? ms.roadmap : `${planning}/ROADMAP.md`;
    if (!isFile(roadmap)) die(`${roadmap} not found — is GSD initialized here?`);

    // phase-* branches and which of them are attached as worktrees
    const refs = (pat: string): string[] => lineList(git(main, ['for-each-ref', '--format=%(refname:short)', pat]).stdout);
    // an archived milestone's phases have landed: no branches, no batches
    const branches = ms ? [] : refs('refs/heads/phase-*');
    // gsdt-batch runs: batch-* branches, listed under the table
    const batches = ms ? [] : refs('refs/heads/batch-*');
    const wt = new Map<string, string>();
    let cur = '';
    for (const l of git(main, ['worktree', 'list', '--porcelain']).stdout.split('\n')) {
      if (l.startsWith('worktree ')) cur = l.slice(9);
      if (l.startsWith('branch ')) wt.set(l.slice(7).replace('refs/heads/', ''), cur);
    }
    // COLUMNS first: without a terminal (pipes, CI) tput cannot know the width.
    let cols = process.env.COLUMNS ?? '';
    if (cols === '' && WIN) {
      cols = String(process.stdout.columns || 80); // no tput on Windows; 80 is what tput answers on a pipe with TERM set
    } else if (cols === '') {
      const t = spawnSync('tput', ['cols'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'ignore'] });
      cols = t.error || t.status !== 0 ? '120' : t.stdout.replace(/\n+$/, '');
    }

    let text: string;
    try {
      text = lf(readFileSync(roadmap, 'utf8'));
    } catch (e) {
      err(`cannot read ${roadmap}\n`);
      return (e as NodeJS.ErrnoException).code === 'EACCES' ? 13 : 255;
    }
    process.stdout.write(
      renderList({
        roadmap,
        text,
        wt,
        branches,
        batches,
        todos: ms ? undefined : pendingTodos(main),
        phasesRoot: ms ? ms.phasesRoot : `${planning}/phases`,
        termcols: cols === '' || cols === '0' ? 120 : num(cols), // Perl: `$ENV{TERMCOLS} || 120` (the string's truthiness)
        full,
        show: bytes,
        ...(ms ? { milestone: ms.version } : {}),
      }),
    );
    return 0;
  } catch (e) {
    if (e instanceof Die) {
      err(`✖ ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
