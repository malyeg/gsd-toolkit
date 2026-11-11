// src/common.ts — port of lib/common.sh (shared helpers for the gsdt-* commands).
// The bash file stays while unported commands still source it; this one must
// behave the same (tests/ts/p1-parity.test.ts runs both side by side).
//
// Conventions (P1, used by every later port — keep them):
//  - camelCase, no `gsd_` prefix; the bash name is in the doc comment above
//    each function, so `grep gsd_conf_get src/` finds it.
//  - Bash functions that set globals (GSD_PD/GSD_P/GSD_N, GSD_PLANNING_MISSING,
//    GSD_HOOK_PATH, GSD_GATE_WT, …) RETURN an object instead.
//  - Exit-status predicates return boolean (true = status 0).
//  - A function that prints a reason and returns 0/1 (reviewsProblem,
//    validationProblem) returns the reason string, or null for "fine".
//  - Functions never print what the bash function printed on stderr as a
//    side effect of failing: they return the text (`message`) and the caller
//    writes it. Exceptions are the ones whose job is a running commentary
//    (acquireLock's "waiting…" lines go to stdout/stderr like bash).
//  - A bash function that `exit`s the process (gsd_migrate_refuse) throws
//    GsdExit(code, message). A command's main() catches it, writes the
//    message to stderr and returns the code.
//  - Single-line results are returned WITHOUT the trailing newline bash's
//    `$( … )` would strip; multi-line text blocks (rules, instruction blocks,
//    owned blocks) are returned byte for byte, trailing newline included.
//  - Everything that runs a program uses argv arrays (spawnSync), never a
//    shell string.
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BASEREF_PY } from './baseref-py.ts';
import { uiFinishGate } from './ui.ts'; // import cycle: ui.ts uses common.ts too; both only call at run time

/** A bash `exit N` inside a library function. */
export class GsdExit extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'GsdExit';
    this.code = code;
  }
}

/** `{ok:false}` carries the exit status and the text bash printed to stderr. */
export type Failure = { ok: false; code: number; message: string };
export type Result<T> = { ok: true; value: T } | Failure;

// ── small process / file helpers (not in bash: the shell did this) ──────────

export type RunResult = { status: number; stdout: string; stderr: string };

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv; inheritStderr?: boolean } = {},
): RunResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', opts.inheritStderr ? 'inherit' : 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { status: 127, stdout: '', stderr: '' };
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `git -C <dir> …` */
export function git(dir: string, args: string[], opts: { inheritStderr?: boolean; env?: NodeJS.ProcessEnv } = {}): RunResult {
  return run('git', ['-C', dir, ...args], opts);
}

/** What `$( … )` does: drop every trailing newline. */
export function chomp(s: string): string {
  return s.replace(/\n+$/, '');
}

function gitOut(dir: string, args: string[]): string | null {
  const r = git(dir, args);
  return r.status === 0 ? chomp(r.stdout) : null;
}

/** bash `[ -f p ]` */
export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
/** bash `[ -d p ]` */
export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
/** bash `[ -x p ]` */
export function isExec(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readLatin1(p: string): string | null {
  try {
    return readFileSync(p, 'latin1');
  } catch {
    return null;
  }
}
function readUtf8(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** The lines awk/sed/grep would see: split on \n, no phantom last record. */
function fileLines(text: string): string[] {
  const l = text.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
}

const SP = '[ \\t\\n\\r\\f\\v]'; // [[:space:]]
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** bash `basename` */
function basenameOf(p: string): string {
  const t = p.replace(/\/+$/, '');
  if (t === '') return p.startsWith('/') ? '/' : '';
  return t.slice(t.lastIndexOf('/') + 1);
}

/** bash `command -v name` for an external program. */
export function commandOnPath(name: string): string | null {
  if (name.includes('/')) return isFile(name) && isExec(name) ? name : null;
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(d === '' ? '.' : d, name);
    if (isFile(p) && isExec(p)) return p;
  }
  return null;
}

/** The toolkit package dir (the folder holding src/, lib/, bin/, VERSION). */
export function gsdPkg(): string {
  return path.resolve(import.meta.dirname, '..');
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v !== '' ? v : fallback;
}

// ── configuration (.gsd.conf) ───────────────────────────────────────────────

/** gsd_main — $1 any path inside the repo → the MAIN checkout ('' when none). */
export function findMain(p?: string, env?: NodeJS.ProcessEnv): string {
  const r = git(p || '.', ['worktree', 'list', '--porcelain'], { env });
  if (r.status !== 0 && r.stdout === '') return '';
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) return line.slice(9);
  }
  return '';
}

/** gsd_conf_get — value of `key = value` in <repo>/.gsd.conf ('' when unset). */
export function confGet(repo: string, key: string): string {
  const f = `${repo}/.gsd.conf`;
  if (!isFile(f)) return '';
  const text = readUtf8(f);
  if (text === null) return '';
  const re = new RegExp(`^${SP}*${escapeRe(key)}${SP}*=${SP}*`);
  for (const line of text.split('\n')) {
    if (!re.test(line)) continue;
    let v = line.replace(re, '');
    v = v.replace(new RegExp(`${SP}*$`), '');
    v = v.replace(new RegExp(`${SP}*#.*$`), '');
    return v;
  }
  return '';
}

/** gsd_base — the base branch (conf, else develop, else main, else current). */
export function base(repo: string, env?: NodeJS.ProcessEnv): string {
  const v = confGet(repo, 'base');
  if (v !== '') return v;
  const has = (b: string): boolean => git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`], { env }).status === 0;
  if (has('develop')) return 'develop';
  if (has('main')) return 'main';
  return chomp(git(repo, ['branch', '--show-current'], { inheritStderr: true, env }).stdout);
}

/** gsd_flow_mode — strict | off (`flow` in .gsd.conf) */
export function flowMode(mainCheckout: string): 'strict' | 'off' {
  return confGet(mainCheckout, 'flow') === 'strict' ? 'strict' : 'off';
}

/** gsd_conf_providers — the configured list (legacy `provider`, else claude) */
export function confProviders(mainCheckout: string): string {
  let v = confGet(mainCheckout, 'providers');
  if (v === '') v = confGet(mainCheckout, 'provider');
  return v || 'claude';
}

/** gsd_wtdir — NAME of the sibling worktrees dir */
export function wtdir(mainCheckout: string): string {
  return confGet(mainCheckout, 'wtdir') || `${basenameOf(mainCheckout)}-worktrees`;
}

// ── merge driver ────────────────────────────────────────────────────────────

/** gsd_register_merge_driver — register the .planning merge driver; false = a git config call failed. */
export function registerMergeDriver(repo: string): boolean {
  if (commandOnPath('gsdt-planning-merge') === null) return true;
  const want = 'gsdt-planning-merge %O %A %B %P';
  if (chomp(git(repo, ['config', '--get', 'merge.gsd-planning.driver']).stdout) === want) return true;
  git(repo, ['config', 'merge.gsd-planning.driver', want]); // bash carries on; the status is the last call's
  return (
    git(repo, ['config', 'merge.gsd-planning.name', 'GSD planning files: union, then reconcile single-value lines'])
      .status === 0
  );
}

// ── review / validation artifacts ───────────────────────────────────────────

/**
 * gsd_reviews_problem — why <P>-REVIEWS.md is no usable review (the reason),
 * or null when it is fine (bash: prints + returns 0 when unusable, 1 when fine).
 * See the long comment in lib/common.sh for what counts.
 */
export function reviewsProblem(file: string, reviewProvider = ''): string | null {
  if (!isFile(file)) return null;
  const text = readUtf8(file);
  if (text === null) return null;
  const want = asciiLower(`${reviewProvider} review`);
  let sec = '';
  let base_ = '';
  let lines = 0;
  let mark = '';
  let total = 0;
  let failed = 0;
  let first = '';
  let own = '';
  let fm = false;
  let rule = false;
  const doneSec = (): void => {
    if (sec === '') return;
    total++;
    const bad = lines === 0 || (mark !== '' && lines <= 5);
    if (bad) {
      failed++;
      const what = sec + (lines === 0 ? ' is empty' : ` — ${mark}`);
      if (first === '') first = what;
      if (asciiLower(base_) === want) own = what;
    }
    sec = '';
  };
  const recs = fileLines(text);
  for (let i = 0; i < recs.length; i++) {
    const line = recs[i] as string;
    const dashes = new RegExp(`^---${SP}*$`).test(line);
    if (i === 0 && dashes) {
      fm = true;
      continue;
    }
    if (fm) {
      if (dashes) fm = false;
      continue;
    }
    if (dashes) {
      rule = true;
      continue;
    }
    if (line.startsWith('## ')) {
      const h = line.slice(3).replace(new RegExp(`${SP}+$`), '');
      const lh = asciiLower(h);
      const plan = /^(plan )?[0-9]/.test(lh);
      if (!plan && /review( \([^)]*\))?$/.test(lh)) {
        doneSec();
        sec = h;
        base_ = h.replace(/ \([^)]*\)$/, '');
        lines = 0;
        mark = '';
      } else if (/^consensus/.test(lh) || (rule && !plan)) {
        doneSec();
      }
      rule = false;
      continue;
    }
    const nonBlank = new RegExp(`[^ \\t\\n\\r\\f\\v]`).test(line);
    if (nonBlank) rule = false;
    if (/^#+ /.test(line)) continue;
    if (sec !== '' && nonBlank) {
      lines++;
      const l = asciiLower(line);
      if (/hit your usage limit/.test(l)) mark = 'usage limit hit';
      else if (mark === '' && /failed or returned empty|returned empty content/.test(l)) mark = 'reviewer failed';
    }
  }
  doneSec();
  if (own !== '') return own;
  if (total > 0 && failed === total && first !== '') return first;
  return null;
}

/** gsd_workflow_flag — "true" | "false" | "" for workflow.<key> in .planning/config.json */
export function workflowFlag(checkout: string, key: string): string {
  // bash asks python (and answers '' without one); parsing in-process gives the same answer.
  const text = readUtf8(`${checkout}/.planning/config.json`);
  if (text === null) return '';
  try {
    const d: unknown = JSON.parse(text);
    if (d === null || typeof d !== 'object' || Array.isArray(d)) return '';
    const w = (d as Record<string, unknown>).workflow;
    if (w === undefined) return '';
    if (w === null || typeof w !== 'object' || Array.isArray(w)) return '';
    const v = (w as Record<string, unknown>)[key];
    return v === true ? 'true' : v === false ? 'false' : '';
  } catch {
    return '';
  }
}

/**
 * gsd_validation_problem — why the test audit is still open (the reason), or
 * null when it is done (bash: prints + 0 when open, 1 when done).
 */
export function validationProblem(phaseDirPath: string, p: string, checkout: string): string | null {
  if (workflowFlag(checkout, 'nyquist_validation') === 'false') return null;
  const f = `${phaseDirPath}/${p}-VALIDATION.md`;
  if (!isFile(f)) return `no ${p}-VALIDATION.md`;
  const raw = readLatin1(f) ?? '';
  const lines = fileLines(raw.replace(/\r/g, ''));
  // sed -n '/^---$/,/^---$/p'
  let inRange = false;
  let c: string | null = null;
  for (const line of lines) {
    let print = false;
    if (!inRange) {
      if (line === '---') {
        inRange = true;
        print = true;
      }
    } else {
      print = true;
      if (line === '---') inRange = false;
    }
    if (print) {
      const m = new RegExp(`^nyquist_compliant:${SP}*`).exec(line);
      if (m) {
        c = line.slice(m[0].length);
        break;
      }
    }
  }
  if (c !== null) {
    c = c.replace(new RegExp(`${SP}+#.*$`), '').replace(/["'\s]/g, '');
    c = asciiLower(c);
    if (c === 'true') return null;
  }
  if (fileLines(raw).some((l) => l.startsWith('## Validation Audit'))) return null;
  return `${p}-VALIDATION.md is the plan's draft (nyquist_compliant: false, no audit)`;
}

// ── phases ──────────────────────────────────────────────────────────────────

export type PhaseDir = { pd: string; p: string; n: string };

/**
 * gsd_phase_dir — the phase dir for a phase-<N>-* branch (GSD_PD, GSD_P,
 * GSD_N), or null (bash status 1). Dirs come padded (07-, 02.1-) or not (7.1-).
 */
export function phaseDir(checkout: string, branch: string): PhaseDir | null {
  const m = /^phase-([0-9]+(?:\.[0-9]+)?)-/.exec(branch);
  const n = m ? (m[1] as string) : '';
  if (n === '' || !isDir(checkout)) return null;
  const ni = parseInt(n.split('.')[0] as string, 10);
  const nd = n.includes('.') ? `.${n.slice(n.indexOf('.') + 1)}` : '';
  for (const c of [`${String(ni).padStart(2, '0')}${nd}`, `${ni}${nd}`]) {
    const dir = `${checkout}/.planning/phases`;
    let names: string[] = [];
    try {
      names = readdirSync(dir)
        .filter((x) => !x.startsWith('.') && x.startsWith(`${c}-`))
        .sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      if (isDir(`${dir}/${name}`)) return { pd: `${dir}/${name}`, p: c, n };
    }
  }
  return null;
}

/** gsd_origin_lacks — true when origin answers but has no such branch */
export function originLacks(checkout: string, branch: string): boolean {
  return git(checkout, ['ls-remote', '--exit-code', '--heads', 'origin', branch]).status === 2;
}

/** gsd_phase_branch — the phase's feature branch ('' = none) */
export function phaseBranch(mainCheckout: string, n: string): string {
  const r = git(mainCheckout, ['for-each-ref', '--format=%(refname:short)', `refs/heads/phase-${n}-*`]);
  if (r.status !== 0) return '';
  const all = chomp(r.stdout).split('\n');
  for (const b of all) {
    if (b === '') continue;
    if (b.endsWith('-pr') && all.includes(b.slice(0, -3))) continue;
    return b;
  }
  return '';
}

/** gsd_is_pr_helper — true when it is the -pr helper of another branch */
export function isPrHelper(mainCheckout: string, branch: string): boolean {
  if (!branch.endsWith('-pr')) return false;
  return git(mainCheckout, ['show-ref', '--verify', '--quiet', `refs/heads/${branch.slice(0, -3)}`]).status === 0;
}

// ── finish gates ────────────────────────────────────────────────────────────

export type GateTree = { ok: boolean; wt: string; tmp: string };

/**
 * gsd_gate_tree — the branch's files for the finish gates: the worktree when
 * it exists, else a throwaway detached worktree (call gateTreeDone after).
 * ok = false when that checkout failed (wt is then the given path).
 */
export function gateTree(mainCheckout: string, branch: string, worktree: string): GateTree {
  if (worktree !== '' && isDir(worktree)) return { ok: true, wt: worktree, tmp: '' };
  let tmp = '';
  try {
    tmp = mkdtempSync(path.join(tmpdir(), 'tmp.'));
  } catch {
    return { ok: false, wt: worktree, tmp: '' };
  }
  const wt = `${tmp}/tree`;
  if (git(mainCheckout, ['worktree', 'add', '-q', '--detach', wt, branch]).status === 0) {
    return { ok: true, wt, tmp };
  }
  rmSync(tmp, { recursive: true, force: true });
  return { ok: false, wt: worktree, tmp: '' };
}

/** gsd_gate_tree_done — remove the throwaway worktree gateTree made */
export function gateTreeDone(mainCheckout: string, g: GateTree): void {
  if (g.tmp === '') return;
  git(mainCheckout, ['worktree', 'remove', '--force', g.wt]);
  rmSync(g.tmp, { recursive: true, force: true });
  git(mainCheckout, ['worktree', 'prune']);
}

export type Gate = { ok: boolean; stderr: string };

/** gsd_flow_finish_gate — ok = false: refuse the finish (flow = strict, no test audit); `stderr` is what bash printed. */
export function flowFinishGate(mainCheckout: string, branch: string, worktree: string): Gate {
  if (confGet(mainCheckout, 'flow') !== 'strict') return { ok: true, stderr: '' };
  if (process.env.GSD_SKIP_GUARD === '1') return { ok: true, stderr: '' };
  const pd = phaseDir(worktree, branch);
  if (pd === null) return { ok: true, stderr: '' };
  const why = validationProblem(pd.pd, pd.p, worktree);
  if (why === null) return { ok: true, stderr: '' };
  return {
    ok: false,
    stderr:
      `✗ phase ${pd.n} has no test audit (flow = strict): ${why}.\n` +
      `  In the phase worktree: /gsd-validate-phase ${pd.n}   (or GSD_SKIP_GUARD=1 if the user asked to skip it)\n`,
  };
}

/**
 * gsd_finish_gates — the UI steps, then the test audit. ok = false: refuse.
 * `stderr` is everything bash wrote to stderr, in order.
 */
export function finishGates(mainCheckout: string, branch: string, worktree: string): Gate {
  let stderr = '';
  const g = gateTree(mainCheckout, branch, worktree);
  if (!g.ok) {
    stderr += `⚠ could not check out '${branch}' to check its files — the finish gates see only what is on disk\n`;
  }
  let ok = false;
  const ui = uiFinishGate(mainCheckout, branch, g.wt);
  stderr += ui.stderr;
  if (ui.ok) {
    const f = flowFinishGate(mainCheckout, branch, g.wt);
    stderr += f.stderr;
    ok = f.ok;
  }
  gateTreeDone(mainCheckout, g);
  return { ok, stderr };
}

// ── gsd-core's CLI ──────────────────────────────────────────────────────────

export const GSD_CORE_INSTALL = 'npx @opengsd/gsd-core@latest';

/** gsd_cli — gsd-core's gsd_run (null when none) */
export function cli(): string | null {
  const home = process.env.HOME ?? '';
  const cands = [
    process.env.GSD_CLI ?? '',
    commandOnPath('gsd_run') ?? '',
    `${envOr('CLAUDE_CONFIG_DIR', `${home}/.claude`)}/gsd-core/bin/gsd_run`,
    `${envOr('CODEX_HOME', `${home}/.codex`)}/gsd-core/bin/gsd_run`,
  ];
  for (const c of cands) {
    if (c === '' || !isExec(c)) continue;
    const r = run(c, ['runtime-identity', '--raw']);
    if (r.status !== 0) continue;
    if (r.stdout.includes('"packageName":"@opengsd/gsd-core"') || r.stdout.includes('"packageName": "@opengsd/gsd-core"')) {
      return c;
    }
  }
  return null;
}

/** gsd_cli_missing — why there is no cli(), and the fix */
export function cliMissing(): string {
  return `GSD (gsd-core) not found — install it:  ${GSD_CORE_INSTALL} --claude --global --profile=full`;
}

// ── skill copies this toolkit installed ─────────────────────────────────────

export const GSD_SKILL_MARK = '<!-- gsd-toolkit-skill';
export const GSD_SKILL_MARK_OLD = '<!-- gsd-worktrees-skill';

/** gsd_skill_owned — true when dir is a copy this toolkit placed */
export function skillOwned(dir: string): boolean {
  if (isFile(`${dir}/.gsd-worktrees-skill`)) return true;
  const t = readLatin1(`${dir}/SKILL.md`);
  return t !== null && (t.includes(GSD_SKILL_MARK) || t.includes(GSD_SKILL_MARK_OLD));
}

// `diff -qr -x SKILL.md`: true when the two trees differ (names, types, bytes).
function treesDiffer(a: string, b: string): boolean {
  const list = (d: string): string[] | null => {
    try {
      return readdirSync(d).filter((x) => x !== 'SKILL.md').sort();
    } catch {
      return null;
    }
  };
  const la = list(a);
  const lb = list(b);
  if (la === null || lb === null) return true;
  if (la.join('\0') !== lb.join('\0')) return true;
  for (const name of la) {
    const pa = `${a}/${name}`;
    const pb = `${b}/${name}`;
    let sa;
    let sb;
    try {
      sa = statSync(pa);
      sb = statSync(pb);
    } catch {
      return true;
    }
    if (sa.isDirectory() !== sb.isDirectory()) return true;
    if (sa.isDirectory()) {
      if (treesDiffer(pa, pb)) return true;
    } else {
      try {
        if (!readFileSync(pa).equals(readFileSync(pb))) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

/** gsd_skill_differs — true when dest is not the current copy of src */
export function skillDiffers(src0: string, dest0: string): boolean {
  const src = src0.replace(/\/$/, '');
  const dest = dest0.replace(/\/$/, '');
  if (!(isDir(dest) && !isFile(`${dest}/.gsd-worktrees-skill`))) return true;
  if (treesDiffer(src, dest)) return true;
  const d = readLatin1(`${dest}/SKILL.md`) ?? '';
  const kept = fileLines(d)
    .filter((l) => !l.includes(GSD_SKILL_MARK) && !l.includes(GSD_SKILL_MARK_OLD))
    .map((l) => `${l}\n`)
    .join('');
  let s: Buffer;
  try {
    s = readFileSync(`${src}/SKILL.md`);
  } catch {
    return true;
  }
  return !Buffer.from(kept, 'latin1').equals(s);
}

// ── python (still needed by a few helpers until they are ported) ────────────

let pythonCache: string | null = null;

/** gsd_python — the interpreter for the python helpers (null when none) */
export function python(): string | null {
  if (process.env.GSD_PYTHON) return process.env.GSD_PYTHON;
  if (pythonCache !== null) return pythonCache;
  for (const py of ['python3', 'python']) {
    if (commandOnPath(py) === null) continue;
    const r = run(py, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)']);
    if (r.status !== 0) continue;
    pythonCache = py;
    return py;
  }
  return null;
}

// ── worktree.baseRef in Claude's local settings ─────────────────────────────

function baserefPy(py: string, mode: string, dir: string): string {
  const claudeDir = envOr('CLAUDE_CONFIG_DIR', `${process.env.HOME ?? ''}/.claude`);
  // TODO(P8): the python is run verbatim; port with the Claude env helper.
  const r = run(py, ['-', mode, `${dir}/.claude/settings.local.json`, `${dir}/.claude/settings.json`, `${claudeDir}/settings.json`], {
    input: BASEREF_PY,
  });
  // bash: python's stdout, then "invalid" when python failed
  return chomp(r.status === 0 ? r.stdout : `${r.stdout}invalid\n`);
}

/**
 * gsd_baseref — check|ensure <dir> →
 * head | missing | set | other:<value> | invalid | tracked | unignored | nopython
 */
export function baseref(mode: 'check' | 'ensure', dir: string): string {
  const py = python();
  if (py === null) return 'nopython';
  const st = baserefPy(py, 'check', dir);
  if (mode !== 'ensure' || st !== 'missing') return st;
  const f = '.claude/settings.local.json';
  if (git(dir, ['ls-files', '--error-unmatch', '--', f]).status === 0) return 'tracked';
  if (git(dir, ['check-ignore', '-q', '--', f]).status !== 0) return 'unignored';
  return baserefPy(py, 'ensure', dir);
}

/** gsd_baseref_ensure — one line saying what happened ('' for head); never fails */
export function baserefEnsure(dir: string, label: string = dir): string {
  const st = baseref('ensure', dir);
  if (st === 'set') return `✔ ${label}/.claude/settings.local.json: worktree.baseRef = "head" (plans in a wave can run in parallel)`;
  if (st === 'head') return '';
  if (st.startsWith('other:')) {
    return `• ${label}/.claude/settings.local.json keeps worktree.baseRef = "${st.slice(6)}" (yours; "head" lets a wave's plans run in parallel)`;
  }
  if (st === 'tracked') {
    return `⚠ ${label}/.claude/settings.local.json is tracked by git — not changed; add worktree.baseRef = "head" yourself so a wave's plans run in parallel`;
  }
  if (st === 'unignored') {
    return `⚠ .claude/settings.local.json is not gitignored in ${label} — not written; run gsdt-init, then add worktree.baseRef = "head" so a wave's plans run in parallel`;
  }
  if (st === 'nopython') return `⚠ no python 3.7+ — could not set worktree.baseRef = "head" in ${label}/.claude/settings.local.json`;
  return `⚠ ${label}/.claude/settings.local.json is not plain JSON — not changed; add worktree.baseRef = "head" yourself so a wave's plans run in parallel`;
}

// ── the planning merge safety: hook, attributes, driver ─────────────────────

export type PlanningHook = { path: string; label: string; versioned: boolean };

/** gsd_planning_hook — where the post-merge hook goes (GSD_HOOK_PATH/LABEL/VERSIONED) */
export function planningHook(repo: string): PlanningHook {
  if (isDir(`${repo}/.husky`)) {
    return { path: `${repo}/.husky/post-merge`, label: '.husky/post-merge', versioned: true };
  }
  const dir = gitOut(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']) ?? '';
  const gitdir = gitOut(repo, ['rev-parse', '--path-format=absolute', '--git-dir']) ?? '';
  let root = gitOut(repo, ['rev-parse', '--path-format=absolute', '--show-toplevel']) ?? repo;
  if (root === '') root = repo;
  const hookPath = `${dir}/post-merge`;
  let versioned = false;
  if (`${dir}/`.startsWith(`${gitdir}/`)) versioned = false;
  else if (`${dir}/`.startsWith(`${root}/`)) versioned = true;
  let label: string;
  if (versioned) {
    label = hookPath.startsWith(`${root}/`) ? hookPath.slice(root.length + 1) : hookPath;
  } else {
    label = `${chomp(git(repo, ['rev-parse', '--git-path', 'hooks']).stdout)}/post-merge (not versioned)`;
  }
  return { path: hookPath, label, versioned };
}

export type PlanningStatus = { missing: string[]; attrsState: 'union' | 'ok' | 'absent'; hook: PlanningHook };

/** gsd_planning_status — GSD_PLANNING_MISSING (as a list) + GSD_ATTRS_STATE (+ the hook info) */
export function planningStatus(repo: string): PlanningStatus {
  const missing: string[] = [];
  const attrs = fileLines(readLatin1(`${repo}/.gitattributes`) ?? '');
  let attrsState: PlanningStatus['attrsState'];
  if (attrs.some((l) => new RegExp(`^\\.planning/(ROADMAP|STATE)\\.md${SP}+merge=union${SP}*$`).test(l))) {
    attrsState = 'union';
  } else if (
    attrs.filter((l) => new RegExp(`^\\.planning/(ROADMAP|STATE)\\.md${SP}+merge=gsd-planning${SP}*$`).test(l)).length === 2
  ) {
    attrsState = 'ok';
  } else {
    attrsState = 'absent';
  }
  if (attrsState !== 'ok') missing.push('attributes');
  if (chomp(git(repo, ['config', '--get', 'merge.gsd-planning.driver']).stdout) !== 'gsdt-planning-merge %O %A %B %P') {
    missing.push('driver');
  }
  const hook = planningHook(repo);
  const hookText = readLatin1(hook.path);
  if (!(isExec(hook.path) && hookText !== null && hookText.includes('gsdt-planning-repair'))) missing.push('hook');
  return { missing, attrsState, hook };
}

const HOOK_BODY = `#!/usr/bin/env sh
# Installed by gsdt-bootstrap-repo (gsd-toolkit).
# .planning/ROADMAP.md and STATE.md merge with a union-then-reconcile driver.
# A pull whose driver was missing, or a merge done by another tool, can still
# leave both sides of a single-value line behind — reconcile them here.
command -v gsdt-planning-repair >/dev/null 2>&1 || exit 0
[ -d .planning ] || exit 0
gsdt-planning-repair || true
`;

/** chmod +x (all three bits, minus the umask) */
function chmodPlusX(p: string): void {
  const um = process.umask();
  const mode = statSync(p).mode & 0o7777;
  chmodSync(p, mode | (0o111 & ~um));
}

/** `perl -pi -e s///` on bytes: line by line, the line's own "\n" included. */
function perlSubLines(file: string, fn: (line: string) => string): void {
  const t = readLatin1(file);
  if (t === null) return;
  const parts = t.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  writeFileSync(file, parts.map(fn).join(''), 'latin1');
}

/** gsd_planning_apply — install whatever planningStatus reports missing; returns the ✔/⚠ lines bash echoed */
export function planningApply(repo: string): string[] {
  const attrs = `${repo}/.gitattributes`;
  const out: string[] = [];
  const st = planningStatus(repo);
  const has = (k: string): boolean => st.missing.includes(k);

  if (has('attributes')) {
    if (st.attrsState === 'union') {
      perlSubLines(attrs, (l) => l.replace(/^(\.planning\/(?:ROADMAP|STATE)\.md\s+merge=)union\s*$/, '$1gsd-planning\n'));
      out.push('✔ .gitattributes (migrated .planning merge=union → merge=gsd-planning)');
    }
    for (const line of ['.planning/ROADMAP.md merge=gsd-planning', '.planning/STATE.md merge=gsd-planning']) {
      if (!fileLines(readLatin1(attrs) ?? '').includes(line)) appendFileSync(attrs, `${line}\n`);
    }
    out.push('✔ .gitattributes (merge=gsd-planning for .planning/ROADMAP.md + STATE.md)');
  }

  if (has('driver')) {
    if (registerMergeDriver(repo) && chomp(git(repo, ['config', '--get', 'merge.gsd-planning.driver']).stdout) !== '') {
      out.push('✔ merge driver registered (merge.gsd-planning → gsdt-planning-merge)');
    } else {
      out.push('⚠ could not register the merge driver — gsdt-finish re-asserts it on every run');
    }
  }

  if (has('hook')) {
    const hp = st.hook.path;
    mkdirSync(path.dirname(hp), { recursive: true });
    const existing = readLatin1(hp);
    if (existing !== null && existing.includes('gsd-planning-repair')) {
      // our block from before 0.10.0: its `command -v gsd-planning-repair || exit 0` would end the hook
      perlSubLines(hp, (l) => l.replace(/(?<![\w-])gsd-(planning-repair|bootstrap-repo)(?![\w-])/g, 'gsdt-$1'));
      out.push(`✔ ${st.hook.label} (renamed to gsdt-planning-repair)`);
    } else if (existing !== null || existsSync(hp)) {
      if (!(existing ?? '').includes('gsdt-planning-repair')) {
        // bash: printf '\n%s\n' "$body" | sed '1d' — the leading blank line is dropped
        appendFileSync(hp, `${HOOK_BODY}\n`);
      }
      out.push(`✔ ${st.hook.label} (existing hook repaired)`);
    } else {
      writeFileSync(hp, HOOK_BODY, { mode: 0o666 });
      chmodPlusX(hp);
      out.push(`✔ ${st.hook.label} (created)`);
    }
    try {
      chmodPlusX(hp);
    } catch {
      // bash: chmod failure is ignored here too (no set -e in the lib)
    }
  }
  return out;
}

// ── the 0.10.0 rename (gsd-* → gsdt-*) ──────────────────────────────────────

export const GSD_OLD_SHIMS =
  'scripts/gsd-new-worktree-feature.sh scripts/gsd-finish-worktree-feature.sh scripts/gsd-derive-port.sh scripts/gsd-planning-repair.sh scripts/hooks/gsd-worktree-guard.sh';
export const GSD_OLD_PREMERGE = 'scripts/gsd-premerge-check.sh';

/** gsd_migrate_needed — true when the MAIN checkout still uses the old gsd-* names */
export function migrateNeeded(m: string): boolean {
  for (const rel of [...GSD_OLD_SHIMS.split(' '), GSD_OLD_PREMERGE]) {
    if (isFile(`${m}/${rel}`)) return true;
  }
  if ((readLatin1(`${m}/.claude/settings.json`) ?? '').includes('hooks/gsd-worktree-guard.sh')) return true;
  if (chomp(git(m, ['config', '--get', 'merge.gsd-planning.driver']).stdout) === 'gsd-planning-merge %O %A %B %P') return true;
  if (git(m, ['config', '--local', '--get-regexp', '^gsd-tracker\\.']).status === 0) return true;
  return false;
}

/** gsd_migrate_refuse — throws GsdExit(1) when the MAIN checkout still uses the old names */
export function migrateRefuse(m: string): void {
  if (m === '') return;
  if (!migrateNeeded(m)) return;
  throw new GsdExit(
    1,
    `✖ this repo uses the old gsd-* names (before 0.10.0) — run: gsdt-migrate --apply\n  (in ${m}; plain gsdt-migrate first shows what it changes)\n`,
  );
}

// ── the checkout lock (.git/gsd-cmd.lock — same on-disk format as bash) ─────

let lockDir = '';
let lockHandlersSet = false;

/** gsd_release_lock */
export function releaseLock(): void {
  if (lockDir === '') return;
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // like `rm -rf … || true`
  }
}

/** gsd__mkdir_excl — true only for the one caller that made the dir */
export function mkdirExcl(dir: string): boolean {
  try {
    mkdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // like `kill -0`: any failure counts as gone
  }
}

/**
 * gsd_acquire_lock — serialize gsdt commands on this checkout. Sync (waits with
 * Atomics.wait). Re-entrant when GSD_LOCK_HELD=1. Registers an exit hook that
 * releases it; INT/TERM exit 130/143. Prints the same commentary as bash;
 * returns false when it gave up after 300 waits (message on stderr).
 */
export function acquireLock(mainCheckout: string): boolean {
  if (process.env.GSD_LOCK_HELD === '1') return true;
  const dir = `${mainCheckout}/.git/gsd-cmd.lock`;
  lockDir = dir;
  let waited = 0;
  while (!mkdirExcl(dir)) {
    const pidText = readUtf8(`${dir}/pid`);
    const lockpid = pidText === null ? '' : chomp(pidText);
    if (lockpid !== '' && !(/^[0-9]+$/.test(lockpid) && pidAlive(Number(lockpid)))) {
      try {
        renameSync(dir, `${dir}.stale.${process.pid}`);
        rmSync(`${dir}.stale.${process.pid}`, { recursive: true, force: true });
        process.stdout.write(`▶ reclaimed stale gsd lock (owner PID ${lockpid} no longer running)\n`);
      } catch {
        // another waiter won the reclaim
      }
      continue;
    }
    if (waited === 0) {
      process.stdout.write(`▶ another gsd command is using this checkout — waiting (lock: ${dir})…\n`);
    }
    waited++;
    if (waited >= 300) {
      process.stderr.write(`✖ gave up waiting after 300s — if no gsd command is running, remove the stale lock: rm -rf ${dir}\n`);
      return false;
    }
    sleepMs(1000);
  }
  writeFileSync(`${dir}/pid`, `${process.pid}\n`);
  if (!lockHandlersSet) {
    lockHandlersSet = true;
    process.on('exit', releaseLock);
    process.on('SIGINT', () => process.exit(130));
    process.on('SIGTERM', () => process.exit(143));
  }
  return true;
}

// ── test / install commands ─────────────────────────────────────────────────

/** gsd__npm_has_test — true when package.json "scripts" defines "test" */
export function npmHasTest(pkgJson: string): boolean {
  const t = readLatin1(pkgJson);
  if (t === null) return false;
  return /"scripts"[ \t\n\r\f\v]*:[ \t\n\r\f\v]*\{[^}]*"test"[ \t\n\r\f\v]*:/.test(t);
}

/** gsd_test_cmd — pre-merge test command ('' = skip) */
export function testCmd(repo: string): string {
  const v = confGet(repo, 'test');
  if (v !== '') return v === 'none' ? '' : v;
  try {
    for (const x of readdirSync(repo)) {
      if (!x.startsWith('.') && x.endsWith('.xcodeproj') && existsSync(`${repo}/${x}`)) return 'xcodebuild test';
    }
  } catch {
    // unreadable dir: no xcodeproj
  }
  const makefile = readLatin1(`${repo}/Makefile`);
  if (isFile(`${repo}/Makefile`) && makefile !== null && fileLines(makefile).some((l) => l.startsWith('test:'))) return 'make test';
  if (isFile(`${repo}/Justfile`) || isFile(`${repo}/justfile`)) return 'just test';
  if (isFile(`${repo}/Cargo.toml`)) return 'cargo test';
  if (isFile(`${repo}/go.mod`)) return 'go test ./...';
  if (isFile(`${repo}/package.json`) && npmHasTest(`${repo}/package.json`)) return 'npm test';
  if (isFile(`${repo}/pyproject.toml`) || isFile(`${repo}/pytest.ini`)) return 'python -m pytest';
  return '';
}

/** gsd_install_cmd — worktree bootstrap command ('' = skip) */
export function installCmd(repo: string): string {
  const v = confGet(repo, 'install');
  if (v !== '') return v === 'none' ? '' : v;
  if (isFile(`${repo}/pnpm-lock.yaml`)) return 'pnpm install';
  if (isFile(`${repo}/yarn.lock`)) return 'yarn install';
  if (isFile(`${repo}/package-lock.json`) || isFile(`${repo}/package.json`)) return 'npm install';
  return '';
}
