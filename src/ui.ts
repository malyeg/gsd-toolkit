// src/ui.ts — the UI quality gates (port of lib/ui.sh; see docs/ui-quality-plan.md
// and docs/plan-ui-check.md). One definition for gsdt-flow-next, the guard,
// finishGates, gsdt-doctor and gsdt-ui; `uiGate` is the ONE answer to "which UI
// step is open". The bash file stays while unported commands source it
// (tests/ts/p4-ui.test.ts runs both side by side).
//
// Conventions: see the top of src/common.ts. Functions return the strings the
// bash functions printed, WITHOUT the newline `$( )` would strip. A bash
// function that printed lines of a list returns string[] (one entry per line).
// `uiFinishGate` returns the stderr text instead of printing it.
//
// Bash quirks kept on purpose:
//  - uiField/uiFm read the FIRST `key:` line, even when its value is empty;
//    only trailing whitespace is dropped (flow-next's fm() drops all of it);
//  - uiLookState compares answer text by BYTE length (`LC_ALL=C awk length`);
//  - awk's `==` on two numeric-looking strings is numeric (lookKeys widths).
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { base, commandOnPath, confGet, findMain, git, isDir, isExec, isFile, phaseDir, run } from './common.ts';

export const UI_STUB = '<!-- gsd:design-stub';
/** GSD_UI_WIDTHS (read by bin/gsdt-ui) */
export const UI_WIDTHS = '375 768 1440';
/** GSD_UI_RULES — `R<n>|<rule>` lines, no trailing newline */
export const UI_RULES = `R1|One main focus per screen
R2|The main button is on the first screen, never covered
R3|More than ~12 items → search, filters or tabs
R4|One alignment system per page
R5|Consistent title casing
R6|Header and footer are lighter than the content
R7|No large empty areas; cards in a row have equal structure
R8|Images: same shape and treatment; no blank or near-empty images
R9|Nothing wraps alone onto its own row at any size
R10|Matches the chosen sketch: same sections, same order`;

// ── small helpers ───────────────────────────────────────────────────────────

const SP = '[ \\t\\n\\r\\f\\v]'; // [[:space:]]
const TRAIL_SP = new RegExp(`${SP}+$`);

function readText(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
/** The lines sed/awk would see: split on \n, no phantom last record. */
function lines(text: string): string[] {
  const l = text.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
}
/** `sed -n '/^---$/,/^---$/p'` — the lines inside every --- … --- range (a later pair starts a new range) */
function dashRanges(ls: string[]): string[] {
  const out: string[] = [];
  let inRange = false;
  for (const line of ls) {
    if (!inRange) {
      if (line === '---') {
        inRange = true;
        out.push(line);
      }
    } else {
      out.push(line);
      if (line === '---') inRange = false;
    }
  }
  return out;
}
/** `sed -n -E "s/^KEY:[[:space:]]*//p"` over lines — every match, value after the prefix */
function keyMatches(ls: string[], key: string): string[] {
  const re = new RegExp(`^${key}:${SP}*`);
  const out: string[] = [];
  for (const l of ls) {
    const m = re.exec(l);
    if (m) out.push(l.slice(m[0].length));
  }
  return out;
}
/** `sort` of directory entries for `dir/*` (dotfiles skipped), byte order */
function globDir(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => !n.startsWith('.'))
      .sort();
  } catch {
    return [];
  }
}
/** awk's `a == b`: numeric when both look like numbers, else string */
function awkEq(a: string, b: string): boolean {
  const num = /^[ \t]*[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?[ \t]*$/;
  if (num.test(a) && num.test(b)) return Number(a) === Number(b);
  return a === b;
}
/** awk -F' [|] ' split */
function splitPipe(s: string): string[] {
  return s.split(' | ');
}

// ── gates, design, layout ───────────────────────────────────────────────────

/** gsd_ui_gates — any checkout → warn | strict | off */
export function uiGates(checkout: string): 'warn' | 'strict' | 'off' {
  let v = confGet(findMain(checkout), 'ui_gates');
  if (v === '') v = confGet(checkout, 'ui_gates');
  return v === 'strict' || v === 'off' ? v : 'warn';
}

/** gsd_ui_design_file */
export function uiDesignFile(checkout: string): string {
  return `${checkout}/.planning/design/DESIGN.md`;
}

/** gsd_ui_design_state — missing | stub | ok */
export function uiDesignState(checkout: string): 'missing' | 'stub' | 'ok' {
  const t = readText(uiDesignFile(checkout));
  if (t === null) return isFile(uiDesignFile(checkout)) ? 'ok' : 'missing'; // unreadable file: grep fails → ok in bash
  return t.includes(UI_STUB) ? 'stub' : 'ok';
}

/** gsd_ui_field — the value of the first `key: value` line ('' = none) */
export function uiField(file: string, key: string): string {
  const t = readText(file);
  if (t === null || !isFile(file)) return '';
  const m = keyMatches(lines(t), key);
  return m.length > 0 ? (m[0] as string).replace(TRAIL_SP, '') : '';
}

/** gsd_ui_winner — the winner from a sketch dir's README frontmatter ('' = none) */
export function uiWinner(sketchDir: string): string {
  const t = readText(`${sketchDir}/README.md`);
  if (t === null) return '';
  const m = keyMatches(dashRanges(lines(t)), 'winner');
  const w = (m[0] ?? '').replace(/["'\s]/g, '');
  return w === '' || w === 'null' || w === '~' || w === 'none' ? '' : w;
}

export type LayoutState = 'missing' | 'nosketch' | 'badsketch' | 'nowinner' | 'nopages' | 'skip' | 'ok';

/** gsd_ui_layout_state */
export function uiLayoutState(checkout: string, pdir: string, p: string): LayoutState {
  const f = `${pdir}/${p}-LAYOUT.md`;
  if (!isFile(f)) return 'missing';
  const s = uiField(f, 'sketch');
  if (s === '') return 'nosketch';
  if (s === 'skip' || new RegExp(`^skip${SP}`).test(s)) return 'skip';
  if (!isDir(`${checkout}/${s}`)) return 'badsketch';
  if (uiWinner(`${checkout}/${s}`) === '') return 'nowinner';
  if (uiField(f, 'pages') === '') return 'nopages';
  return 'ok';
}

/** gsd_ui_shots_state — missing | skip | ok */
export function uiShotsState(pdir: string, p: string): 'missing' | 'skip' | 'ok' {
  const f = `${pdir}/${p}-SHOTS.md`;
  if (!isFile(f)) return 'missing';
  return uiField(f, 'skipped') !== '' ? 'skip' : 'ok';
}

/** gsd_ui_has_screens — true when any phase has a UI-SPEC or LAYOUT */
export function uiHasScreens(checkout: string): boolean {
  const phases = `${checkout}/.planning/phases`;
  for (const d of globDir(phases)) {
    for (const f of globDir(`${phases}/${d}`)) {
      if ((f.endsWith('-UI-SPEC.md') || f.endsWith('-LAYOUT.md')) && isFile(`${phases}/${d}/${f}`)) return true;
    }
  }
  return false;
}

/** gsd_ui_phase_screens — true when this phase has screens */
export function uiPhaseScreens(pdir: string, p: string): boolean {
  return isFile(`${pdir}/${p}-UI-SPEC.md`) || isFile(`${pdir}/${p}-LAYOUT.md`);
}

// ── Playwright (files only; nothing is run) ─────────────────────────────────

/** gsd_ui_playwright — the playwright CLI ('' = none); `app` is `app:` from LAYOUT ('' = none) */
export function uiPlaywright(checkout: string, app: string): string {
  const env = process.env.GSD_PLAYWRIGHT ?? '';
  if (env !== '') return env;
  const dirs: string[] = [];
  if (app !== '') dirs.push(`${checkout}/${app}`);
  dirs.push(checkout);
  for (const n of globDir(`${checkout}/apps`)) dirs.push(`${checkout}/apps/${n}`);
  for (const n of globDir(`${checkout}/packages`)) dirs.push(`${checkout}/packages/${n}`);
  for (const d of dirs) {
    const f = `${d}/node_modules/.bin/playwright`;
    if (isFile(f) && isExec(f)) return f;
  }
  return commandOnPath('playwright') ?? '';
}

/** gsd_ui_global_root — the global npm node_modules folder ('' = none); GSD_NPM_GLOBAL_ROOT overrides */
export function uiGlobalRoot(): string {
  const o = process.env.GSD_NPM_GLOBAL_ROOT;
  if (o !== undefined) return o;
  if (commandOnPath('npm') === null) return '';
  const r = run('npm', ['root', '-g']);
  if (r.status !== 0) return '';
  const root = r.stdout.replace(/\n+$/, '');
  return isDir(root) ? root : '';
}

/** gsd_ui_playwright_installed — where a Playwright package is: project | global | null (none) */
export function uiPlaywrightInstalled(checkout: string): 'project' | 'global' | null {
  const dirs: string[] = [];
  const root = process.env.GSD_PLAYWRIGHT_ROOT ?? '';
  if (root !== '') dirs.push(root);
  dirs.push(checkout);
  for (const n of globDir(`${checkout}/apps`)) dirs.push(`${checkout}/apps/${n}`);
  for (const n of globDir(`${checkout}/packages`)) dirs.push(`${checkout}/packages/${n}`);
  for (const d of dirs) {
    if (existsSync(`${d}/node_modules/playwright/package.json`) || existsSync(`${d}/node_modules/@playwright/test/package.json`)) return 'project';
  }
  const g = uiGlobalRoot();
  if (g !== '' && (existsSync(`${g}/playwright/package.json`) || existsSync(`${g}/@playwright/test/package.json`))) return 'global';
  return null;
}

// ── the rendered-page check (gsdt-ui check / look / approve) ────────────────

/** gsd_ui_rules — `R<n>|<rule>` lines: the project's (DESIGN.md `- R<n>: …`), else the defaults */
export function uiRules(checkout: string): string[] {
  const t = readText(uiDesignFile(checkout));
  const out: string[] = [];
  if (t !== null) {
    const re = new RegExp(`^- (R[0-9]+):${SP}*([^\\n]*[^ \\t\\n\\r\\f\\v])${SP}*$`);
    for (const l of lines(t)) {
      const m = re.exec(l);
      if (m) out.push(`${m[1]}|${m[2]}`);
    }
  }
  return out.length > 0 ? out : UI_RULES.split('\n');
}

/** gsd_ui_fm — the value of `key` in the file's frontmatter */
export function uiFm(file: string, key: string): string {
  const t = readText(file);
  if (t === null) return '';
  const m = keyMatches(dashRanges(lines(t)), key);
  return m.length > 0 ? (m[0] as string).replace(TRAIL_SP, '') : '';
}

/** gsd_ui_fields — the value of EVERY `key: value` line (trailing blanks dropped, empty ones skipped) */
export function uiFields(file: string, key: string): string[] {
  const t = readText(file);
  if (t === null || !isFile(file)) return [];
  return keyMatches(lines(t), key)
    .map((v) => v.replace(TRAIL_SP, ''))
    .filter((v) => v !== '');
}

/** gsd_ui_page_hash — 6 hex (git's blob hash of the page path); picture names carry it */
export function uiPageHash(page: string): string {
  const data = Buffer.from(page, 'utf8');
  return createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex').slice(0, 6);
}

/** gsd_ui_min_font — ui_min_font (8–32), default 12 */
export function uiMinFont(checkout: string): number {
  let v = confGet(findMain(checkout), 'ui_min_font');
  if (v === '') v = confGet(checkout, 'ui_min_font');
  if (v === '' || /[^0-9]/.test(v)) return 12;
  const n = BigInt.asIntN(64, BigInt(v)); // bash `$((10#$v))` wraps at 64 bits
  return n >= 8n && n <= 32n ? Number(n) : 12;
}

/** gsd_ui_code_state — a hash of the working tree outside .planning/ ('' = unknown) */
export function uiCodeState(checkout: string): string {
  // The tree git would write for the files as they are on disk now. Built in a
  // throwaway index and object directory: the checkout, its index and its
  // object store are not touched.
  const topR = git(checkout, ['rev-parse', '--show-toplevel']);
  if (topR.status !== 0) return '';
  const top = topR.stdout.replace(/\n+$/, '');
  const idxR = git(top, ['rev-parse', '--git-path', 'index']);
  if (idxR.status !== 0) return '';
  const objR = git(top, ['rev-parse', '--git-path', 'objects']);
  if (objR.status !== 0) return '';
  let idx = idxR.stdout.replace(/\n+$/, '');
  let objs = objR.stdout.replace(/\n+$/, '');
  if (!idx.startsWith('/')) idx = `${top}/${idx}`;
  if (!objs.startsWith('/')) objs = `${top}/${objs}`;
  let tmp: string;
  try {
    tmp = mkdtempSync(path.join(tmpdir(), 'gsd-ui-'));
    mkdirSync(`${tmp}/objects`, { recursive: true });
  } catch {
    return '';
  }
  let h = '';
  try {
    if (isFile(idx)) copyFileSync(idx, `${tmp}/index`);
    const env = { ...process.env, GIT_INDEX_FILE: `${tmp}/index`, GIT_OBJECT_DIRECTORY: `${tmp}/objects`, GIT_ALTERNATE_OBJECT_DIRECTORIES: objs };
    const steps: string[][] = [
      ['add', '-A', '--', '.', ':(exclude).planning'],
      ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.planning'],
    ];
    let ok = true;
    for (const a of steps) {
      if (run('git', a, { cwd: top, env }).status !== 0) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const w = run('git', ['write-tree'], { cwd: top, env });
      if (w.status === 0) h = w.stdout.replace(/\n+$/, '');
    }
  } catch {
    h = '';
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return h;
}

/** gsd_ui_inputs_state — what a UI check is valid for: <code hash>+<LAYOUT hash> ('' = unknown) */
export function uiInputsState(checkout: string, pdir: string, p: string): string {
  // The LAYOUT says what is checked, and it lives in .planning/, outside the
  // code hash: an edit to it must make an older check stale too.
  const code = uiCodeState(checkout);
  if (code === '') return '';
  const r = run('git', ['hash-object', `${pdir}/${p}-LAYOUT.md`]); // cwd = the caller's, like bash
  const lay = r.status === 0 ? r.stdout.replace(/\n+$/, '') : '';
  return `${code}+${lay !== '' ? lay : 'none'}`;
}

/** gsd_ui_exempt — true when the phase's UI review is already on the base branch */
export function uiExempt(checkout: string, pdir: string, p: string): boolean {
  // Only a review that was MERGED exempts a phase from the newer steps; one
  // written in the phase's own worktree exempts nothing.
  const main = findMain(checkout);
  const b = base(main !== '' ? main : checkout);
  const rel = `${pdir.startsWith(`${checkout}/`) ? pdir.slice(checkout.length + 1) : pdir}/${p}-UI-REVIEW.md`;
  for (const ref of [`refs/remotes/origin/${b}`, `refs/heads/${b}`]) {
    if (git(checkout, ['cat-file', '-e', `${ref}:${rel}`]).status === 0) return true;
  }
  return false;
}

export type CheckState = 'missing' | 'error' | 'failed' | 'skipped' | 'stale' | 'passed';

/** gsd_ui_check_state — `noStale` true (bash: $4 non-empty) skips the code comparison */
export function uiCheckState(checkout: string, pdir: string, p: string, noStale: string | boolean = ''): CheckState {
  const f = `${pdir}/${p}-UI-CHECK.md`;
  if (!isFile(f)) return 'missing';
  const st = uiFm(f, 'status');
  if (st === 'skipped') return 'skipped';
  if (st !== 'passed' && st !== 'failed') return 'error';
  const code = uiFm(f, 'code');
  if ((noStale === '' || noStale === false) && code !== '') {
    // a check written before the LAYOUT was part of it holds the code hash only
    const now = code.includes('+') ? uiInputsState(checkout, pdir, p) : uiCodeState(checkout);
    if (now !== '' && now !== code) return 'stale';
  }
  return st;
}

/** gsd_ui_check_list — the `- a | b | c` lines of a section (Shots, Questions, …), without the `- ` */
export function uiCheckList(file: string, section: string): string[] {
  const t = readText(file);
  if (t === null || !isFile(file)) return [];
  const out: string[] = [];
  let on = false;
  for (const l of lines(t)) {
    if (l.startsWith('## ')) {
      on = l === `## ${section}`;
      continue;
    }
    if (on && l.startsWith('- ')) out.push(l.slice(2));
  }
  return out;
}

/** gsd_ui_look_keys — the answers a complete look file holds: `page|width|id` lines */
export function uiLookKeys(checkout: string, pdir: string, p: string): string[] {
  const f = `${pdir}/${p}-UI-CHECK.md`;
  const rules = uiRules(checkout).map((r) => r.split('|')[0] as string);
  const out: string[] = [];
  const questions = uiCheckList(f, 'Questions');
  for (const line of uiCheckList(f, 'Shots')) {
    const parts = splitPipe(line);
    const page = parts[0] ?? '';
    const w = parts[1] ?? '';
    for (const r of rules) if (r !== '') out.push(`${page}|${w}|${r}`);
    for (const q of questions) {
      const qp = splitPipe(q);
      if (awkEq(qp[1] ?? '', page) && awkEq(qp[2] ?? '', w)) out.push(`${page}|${w}|${qp[0] ?? ''}`);
    }
  }
  return out;
}

/** gsd_ui_look_answers — `page|width|id|verdict|text` for every answered line */
export function uiLookAnswers(file: string): string[] {
  const t = readText(file);
  if (t === null || !isFile(file)) return [];
  const out: string[] = [];
  let page = '';
  let w = '';
  for (const l of lines(t)) {
    if (l.startsWith('## ')) {
      page = '';
      w = '';
      const a = l.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '').split(/[ \t\n]+/);
      if (a.length === 4 && a[2] === 'at' && /^[0-9]+px$/.test(a[3] as string)) {
        page = a[1] as string;
        w = (a[3] as string).replace(/px$/, '');
      }
      continue;
    }
    if (page !== '' && /^- [RQ][0-9]+:/.test(l)) {
      const f = l.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '').split(/[ \t\n]+/);
      const id = (f[1] ?? '').replace(/:$/, '');
      const rest = l.replace(/^- [RQ][0-9]+:[ \t]*/, '');
      const verdict = rest.replace(/[ \t].*$/, '');
      let text = rest.replace(/^[^ \t]+[ \t]*/, '');
      text = text.replace(/^(—|--|-|:)[ \t]*/, '').replace(/[ \t]+$/, '');
      if (verdict === 'ok' || verdict === 'fixed' || verdict === 'bad' || verdict === 'n/a') out.push(`${page}|${w}|${id}|${verdict}|${text}`);
    }
  }
  return out;
}

export type LookState = 'missing' | 'stale' | 'open' | 'bad' | 'complete';

/** gsd_ui_look_state */
export function uiLookState(checkout: string, pdir: string, p: string): LookState {
  const f = `${pdir}/${p}-UI-LOOK.md`;
  if (!isFile(f)) return 'missing';
  const cap = uiFm(`${pdir}/${p}-UI-CHECK.md`, 'capture');
  if (cap === '' || uiFm(f, 'capture') !== cap) return 'stale';
  const want = new Set<string>();
  let n = 0;
  for (const k of uiLookKeys(checkout, pdir, p)) {
    const fl = `K|${k}`.split('|'); // awk -F'|': a `|` inside a page shifts the fields, as in bash
    want.add(`${fl[1]}|${fl[2]}|${fl[3]}`);
    n++;
  }
  const got = new Map<string, string>();
  for (const a of uiLookAnswers(f)) {
    const fl = `A|${a}`.split('|');
    const text = fl.slice(5).join('|');
    if (Buffer.byteLength(text, 'utf8') >= 3) got.set(`${fl[1]}|${fl[2]}|${fl[3]}`, fl[4] ?? '');
  }
  if (n === 0) return 'open';
  let open = false;
  let bad = false;
  for (const k of want) {
    if (!got.has(k)) open = true;
    else if (got.get(k) === 'bad') bad = true;
  }
  return open ? 'open' : bad ? 'bad' : 'complete';
}

export type ApprovalState = 'missing' | 'stale' | 'ok' | 'waived';

/** gsd_ui_approval_state */
export function uiApprovalState(pdir: string, p: string): ApprovalState {
  const f = `${pdir}/${p}-UI-APPROVAL.md`;
  if (!isFile(f)) return 'missing';
  switch (uiFm(f, 'status')) {
    case 'waived':
      return uiFm(f, 'reason') !== '' ? 'waived' : 'missing';
    case 'approved': {
      const cap = uiFm(f, 'capture');
      return cap !== '' && cap === uiFm(`${pdir}/${p}-UI-CHECK.md`, 'capture') ? 'ok' : 'stale';
    }
    default:
      return 'missing';
  }
}

/** gsd_ui_gate — `step|state|what is open` for the first open UI step ('' = none) */
export function uiGate(checkout: string, pdir: string, p: string, noStale: string | boolean = ''): string {
  const cs = uiCheckState(checkout, pdir, p, noStale);
  const chk = `${pdir}/${p}-UI-CHECK.md`;
  switch (cs) {
    case 'missing':
      return `ui-check|missing|the rendered pages were never checked (no ${p}-UI-CHECK.md)`;
    case 'error':
      return `ui-check|error|the last check could not run: ${uiFm(chk, 'error')}`;
    case 'failed':
      return `ui-check|failed|the check found ${uiFm(chk, 'failures')} problem(s) — see ${p}-UI-CHECK.md`;
    case 'stale':
      return `ui-check|stale|the code or ${p}-LAYOUT.md changed after the last check`;
  }
  if (cs === 'passed') {
    switch (uiLookState(checkout, pdir, p)) {
      case 'complete':
        break;
      case 'missing':
        return `ui-look|missing|nobody wrote down what the pictures show (no ${p}-UI-LOOK.md)`;
      case 'stale':
        return `ui-look|stale|${p}-UI-LOOK.md describes older pictures`;
      case 'bad':
        return `ui-look|bad|${p}-UI-LOOK.md has a line marked bad — fix the page, then check again`;
      default:
        return `ui-look|open|${p}-UI-LOOK.md has lines without an answer`;
    }
  }
  switch (uiApprovalState(pdir, p)) {
    case 'ok':
    case 'waived':
      return '';
    case 'stale':
      return 'ui-approve|stale|the user approved older pictures';
    default:
      return 'ui-approve|missing|the user has not approved the pages';
  }
}

/** gsd_ui_step_cmd — the command that closes a step ('' for an unknown step) */
export function uiStepCmd(step: string, n: string): string {
  switch (step) {
    case 'ui-check':
      return `gsdt-ui check ${n}`;
    case 'ui-look':
      return `gsdt-ui look ${n}, then answer every line`;
    case 'ui-approve':
      return `show the user the sheet (gsdt-ui sheet ${n}); on a yes: gsdt-ui approve ${n}`;
    default:
      return '';
  }
}

/** gsd_ui_finish_gate — ok = false: refuse the finish (ui_gates = strict); `stderr` is what bash printed */
export function uiFinishGate(mainCheckout: string, branch: string, worktree: string): { ok: boolean; stderr: string } {
  const gates = uiGates(mainCheckout);
  if (gates === 'off') return { ok: true, stderr: '' };
  const ph = phaseDir(worktree, branch);
  if (ph === null) return { ok: true, stderr: '' };
  const { pd, p, n } = ph;
  if (!uiPhaseScreens(pd, p)) return { ok: true, stderr: '' };
  if (uiExempt(worktree, pd, p)) return { ok: true, stderr: '' };
  const gate = uiGate(worktree, pd, p);
  if (gate === '') return { ok: true, stderr: '' };
  const why = gate.slice(gate.lastIndexOf('|') + 1);
  const cmd = uiStepCmd(gate.slice(0, gate.includes('|') ? gate.indexOf('|') : undefined), n);
  if (gates === 'strict' && process.env.GSD_SKIP_GUARD !== '1') {
    return {
      ok: false,
      stderr:
        `✗ phase ${n} has screens and its UI steps are open (ui_gates = strict): ${why}.\n` +
        `  In the phase worktree: ${cmd}   (or GSD_SKIP_GUARD=1 if the user asked to skip it)\n`,
    };
  }
  let err = `⚠ phase ${n} has screens and its UI steps are open: ${why} — next: ${cmd}\n`;
  if (gates === 'strict') err += '  (GSD_SKIP_GUARD=1 — finishing anyway)\n';
  return { ok: true, stderr: err };
}

// ── the app's stack, add-ons, scaffolding ───────────────────────────────────

/** gsd_ui_stack — words for what the app uses: tailwind shadcn react (files only) */
export function uiStack(checkout: string): string {
  const words = new Set<string>();
  const dirs = [checkout];
  for (const n of globDir(`${checkout}/apps`)) dirs.push(`${checkout}/apps/${n}`);
  for (const n of globDir(`${checkout}/packages`)) dirs.push(`${checkout}/packages/${n}`);
  for (const d of dirs) {
    const t = isFile(`${d}/package.json`) ? readText(`${d}/package.json`) : null;
    if (t === null) continue;
    if (t.includes('"tailwindcss"')) words.add('tailwind');
    if (t.includes('"react"')) words.add('react');
  }
  for (const d of dirs) if (isFile(`${d}/components.json`)) words.add('shadcn');
  return [...words].sort().join(' ');
}

/** gsd_ui_addon_present — true when impeccable | shadcn-mcp looks installed (files only) */
export function uiAddonPresent(checkout: string, addon: string): boolean {
  const home = process.env.HOME ?? '';
  switch (addon) {
    case 'impeccable':
      for (const d of [`${checkout}/.claude/skills`, `${checkout}/.agents/skills`, `${home}/.claude/skills`, `${home}/.agents/skills`]) {
        if (existsSync(`${d}/impeccable`)) return true;
      }
      return false;
    case 'shadcn-mcp':
      for (const f of [`${checkout}/.mcp.json`, `${home}/.claude.json`, `${home}/.codex/config.toml`]) {
        const t = readText(f);
        if (t !== null && t.includes('shadcn')) return true;
      }
      return false;
    default:
      return false;
  }
}

const DESIGN_STUB_TEXT = `# Design system

<!-- gsd:design-stub — delete this line once the sections below are filled -->

Every screen in this project uses what is listed here. Don't invent new
styles: add to this file first, then use it.

## References

3–5 screenshots of real apps whose look you want, in \`.planning/design/refs/\`
(Mobbin, Refero, or apps you use). One line each: what to take from it.

Start from a real design system, not a blank page: ask the agent to browse
https://styles.refero.design (real systems written for AI: colors, type,
spacing) and pick the 3 closest to this product; the user chooses one, or
which parts of each to mix. Name it here.

## Tokens

Color, type scale, spacing, radius, shadow — and the file they live in.

Fonts: pick them on purpose — the default font is the first sign of an
AI-made page. Free: https://www.fontshare.com; pairs for headings and body:
https://fontjoy.com.

## Components

Name → file (seed from shadcn/Radix or the project's UI kit). Take a tested
part before drawing one: https://ui.shadcn.com, https://21st.dev,
https://reactbits.dev (React). Icons from one set only.

## Page templates

List, detail, form, dashboard, … → file. Each phase names the template its
screens use in \`<P>-LAYOUT.md\`.

## Layout rules

Every picture of a built page is held against these (\`gsdt-ui look\`). Edit
them for this project; keep the \`- R<n>: \` form.

`;

/** gsd_ui_scaffold_design — create the DESIGN.md stub + refs/ when missing; never overwrites */
export function uiScaffoldDesign(checkout: string): void {
  const d = `${checkout}/.planning/design`;
  try {
    mkdirSync(`${d}/refs`, { recursive: true });
    if (!existsSync(`${d}/refs/.gitkeep`)) writeFileSync(`${d}/refs/.gitkeep`, '');
    if (isFile(`${d}/DESIGN.md`)) return;
    const rules = UI_RULES.split('\n')
      .map((l) => l.replace(/^(R[0-9]+)\|/, '- $1: '))
      .join('\n');
    writeFileSync(`${d}/DESIGN.md`, `${DESIGN_STUB_TEXT}${rules}\n`);
  } catch {
    // bash: mkdir/cat errors go to stderr and the function carries on
  }
}

/** gsd_ui_layout_template — write the LAYOUT template for phase `n`; never overwrites */
export function uiLayoutTemplate(file: string, n: string): void {
  if (isFile(file)) return;
  try {
    writeFileSync(
      file,
      `# Phase ${n} layout

<!-- gsd:layout — the layout contract for this phase's screens. gsdt-flow-next
     reads sketch: and pages:; gsdt-ui check reads the rest.
     - url (optional): the app to open when the project has several, e.g.
       http://localhost:{port:3100} ({port:<base>} = this phase's port).
     - app (optional): the folder where Playwright is installed, e.g. apps/web.
     - main_button: one line per page — "/path = Button text", or
       "/path = css=<selector>", or "/path = none". Without "/path =" the
       line holds for every page.
     - expect (optional): "/path = text that must be visible on that page".
     - waive (only with the user's yes), one line per accepted finding:
       "<check> | <page> | <width> | <target> | <reason>"  (* = any). -->

sketch:
pages:
url:
app:
template:
reference:
main_button:
expect:

## Sections, top to bottom

1.

## Main focus

## Main button

## Notes
`,
    );
  } catch {
    // bash: the redirect error goes to stderr
  }
}
