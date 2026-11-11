// gsdt-flow-next — which phase-flow step comes next, read from the phase folder
// (port of bin/gsdt-flow-next; the old script is kept as the parity oracle in
// tests/fixtures/p3-old-bins/, see tests/ts/p3-flow-next.test.ts).
// Launcher: bin/gsdt-flow-next -> src/launch.mjs flow-next. The help text is HELP
// below (the header comment of the old script, "# " stripped).
//
// Bash quirks reproduced on purpose:
//  - jstr only escapes `\` and `"` (a newline in a field stays a raw newline);
//  - fm() reads the frontmatter with `sed -n '/^---$/,/^---$/p'`: a SECOND ---
//    pair later in the file starts a new range, and an unterminated one runs to
//    the end; the first `key:` line wins and ALL whitespace is dropped from it;
//  - a phase branch that does not match phase-<N> keeps its whole name as N
//    (sed does not substitute), which then fails the "invalid phase number" check;
//  - globs ($pd/$P-[0-9]*-PLAN.md, $P-*UAT.md, $P-*) list in BYTE order here; bash
//    sorts by the locale's collation (same order for the usual 07-01-PLAN.md names).
// TODO(P9): gsd_tracker_which / gsd_ticket_extract are called through bash.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { bashLib } from '../bash-bridge.ts';
import { chomp, confGet, findMain, git, GsdExit, isDir, isFile, migrateRefuse, reviewsProblem, validationProblem, workflowFlag } from '../common.ts';
import { guardArgv } from '../guard.ts';
import { GSD_GEMINI_GONE, providerGone, providerKnown, providerReviewFlag } from '../provider.ts';
import { uiCheckState, uiDesignState, uiExempt, uiGate, uiGates, uiLayoutState } from '../ui.ts';

export const HELP = `
gsdt-flow-next — which phase-flow step comes next, read from the phase folder.

The step engine behind the /gsdt-flow skill. Looks at .planning/phases/<P>-*/
in the checkout you are standing in (a phase worktree) and prints the FIRST
step whose artifact is missing, in the agreed order. It runs nothing: the
skill (or you) runs the printed command, then calls this again. Because it
reads artifacts, it is resumable — after a crash or a /clear it simply says
where you are. The same artifact list drives the guard's \`flow = strict\`
rule and a repo's pre-merge gate, so what this considers done, they accept.

Order:
  ticket       <P>-TICKET.md (legacy: STORY.md, cu_<id>)   gsdt-tracker snapshot
               only when .gsd.conf sets tracker = clickup|custom
  discuss      <P>-CONTEXT.md                             /gsd-discuss-phase
  ui-decision  no UI-SPEC and no PLAN yet → the skill asks "screens?"
  design-system .planning/design/DESIGN.md filled (screens,   gsdt-ui design
               before the UI-SPEC; one per project)
  layout       <P>-LAYOUT.md: chosen /gsd-sketch + pages    gsdt-ui layout, /gsd-sketch
               (screens, before the UI-SPEC)
  ui-phase     <P>-UI-SPEC.md (screens only)              /gsd-ui-phase
  plan         a <P>-NN-PLAN.md                           /gsd-plan-phase
  review       <P>-REVIEWS.md                             configured independent reviewer
                                                          + /gsd-plan-phase --reviews
  replan       a PLAN committed after REVIEWS.md            /gsd-plan-phase --reviews
  execute      a SUMMARY for every PLAN                   /gsd-execute-phase
  verifier     <P>-VERIFICATION.md exists                  (execute-phase re-run)
  gaps         <P>-VERIFICATION.md status gaps_found      --gaps / --gaps-only
  verify-work  a <P>-*UAT.md not pending/partial          /gsd-verify-work
  code-review  <P>-REVIEW.md; not clean → <P>-REVIEW-FIX  /gsd-code-review [--fix]
  ui-check     <P>-UI-CHECK.md passed, code unchanged     gsdt-ui check
               since (screens only)
  ui-look      <P>-UI-LOOK.md: every picture and rule     gsdt-ui look
               answered, for that capture
  ui-approve   <P>-UI-APPROVAL.md names that capture      gsdt-ui sheet, gsdt-ui approve
  ui-review    <P>-UI-REVIEW.md (screens only)            /gsd-ui-review
  validate     <P>-VALIDATION.md nyquist_compliant: true,  /gsd-validate-phase
               or a "## Validation Audit" (manual-only left)
               — not with workflow.nyquist_validation false
  secure       <P>-SECURITY.md, threats_open: 0           /gsd-secure-phase
  done         → gsdt-finish

Usage:
  gsdt-flow-next [<N>] [--repo <dir>] [--no-ui] [--all] [--json]
    <N>       phase number; default: from the current phase-<N>-* branch
    --no-ui   this phase has no screens (skips ui-decision/ui-phase/ui-review)
    --ui      this phase has screens (settles ui-decision without a UI-SPEC)
    --all     print every remaining step, not just the next one
    --json    one JSON object per step

design-system, layout, ui-check, ui-look and ui-approve are the UI gates
(lib/ui.sh); \`ui_gates = off\` in .gsd.conf drops them. Phases whose UI-SPEC
predates them skip the two pre-spec steps; a phase whose UI-REVIEW.md is
already on the base branch skips the three checks of the rendered pages.

review_provider = claude|codex|custom selects the independent reviewer.
The external gsd-review skill performs delegation, not this shell command.
Missing capabilities require a separate review session, never a skipped gate.
A REVIEWS.md whose reviewer failed (Codex usage limit) does not count; with
Codex the note points at gsdt-codex-wait --wait-only.

Output (text): key=value lines — step, run, then (optional second command),
stop (why the skill must pause for the user after this step), note.
`;

const SPACE = /[ \t\n\v\f\r]/g;

type Out = { rc: number; stdout: string; stderr: string };
/** a bash `exit N` inside emit() / the main body */
class Stop extends Error {
  rc: number;
  constructor(rc: number) {
    super(`exit ${rc}`);
    this.rc = rc;
  }
}

/** bash $PWD: the logical cwd when the environment's PWD still names this directory */
function bashPwd(env: NodeJS.ProcessEnv, cwd: string): string {
  const p = env.PWD;
  if (p !== undefined && p.startsWith('/')) {
    try {
      if (realpathSync(p) === realpathSync(cwd)) return p;
    } catch {
      /* fall through */
    }
  }
  return cwd;
}

/** the lines `sed`/`grep` see: split on \n, no empty last piece for a final newline */
function fileLines(text: string): string[] {
  const l = text.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * the frontmatter range of sed, the first `KEY:` line, whitespace dropped (bash: sed | sed | head -1 | tr -d)
 * (fm() and the UAT loop). '' for a missing file or key.
 */
function frontmatterValue(file: string, key: string): string {
  const text = readText(file);
  if (text === null) return '';
  const re = new RegExp(`^${key}:[ \\t\\n\\v\\f\\r]*`);
  let inRange = false;
  for (const line of fileLines(text)) {
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
    if (!print) continue;
    const m = re.exec(line);
    if (m) return line.slice(m[0].length).replace(SPACE, '');
  }
  return '';
}

/** bash `printf %02d "$((10#$N))"` (64-bit wraparound like the shell) */
function pad2(n: string): string {
  return String(BigInt.asIntN(64, BigInt(n))).padStart(2, '0');
}

/** gsdt-flow-next's jstr: only `\` and `"`; `$( )` drops trailing newlines */
const jstr = (s: string): string => chomp(s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));

/** names in a directory, byte order ('' on error) */
function names(dir: string): string[] {
  try {
    return readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return [];
  }
}

export function flowNext(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Out {
  const so: string[] = [];
  const se: string[] = [];
  try {
    return flowNextRun(argv, env, cwd, so, se);
  } catch (e) {
    if (e instanceof Stop) return { rc: e.rc, stdout: so.join(''), stderr: se.join('') };
    if (e instanceof GsdExit) {
      se.push(e.message);
      return { rc: e.code, stdout: so.join(''), stderr: se.join('') };
    }
    throw e;
  }
}

function flowNextRun(argv: string[], env: NodeJS.ProcessEnv, cwd: string, so: string[], se: string[]): Out {
  const fail = (rc: number, msg: string): never => {
    se.push(`${msg}\n`);
    throw new Stop(rc);
  };
  let N = '';
  let REPO = '';
  let UI = '';
  let ALL = false;
  let JSON_ = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case '--repo': {
        const v = argv[i + 1];
        // set -u: `$2` unbound is a fatal shell error (status 1)
        if (v === undefined) fail(1, 'gsdt-flow-next: line 82: $2: unbound variable');
        REPO = v as string;
        i++;
        break;
      }
      case '--no-ui':
        UI = 'no';
        break;
      case '--ui':
        UI = 'yes';
        break;
      case '--all':
        ALL = true;
        break;
      case '--json':
        JSON_ = true;
        break;
      case '-h':
      case '--help':
        so.push(HELP);
        throw new Stop(0);
      default:
        if (a.startsWith('-')) fail(64, `unknown option: ${a}`);
        N = a;
    }
  }
  if (REPO === '') REPO = bashPwd(env, cwd);
  migrateRefuse(findMain(REPO));
  const RP = confGet(REPO, 'review_provider') || 'codex';
  if (providerGone(RP)) fail(64, `review_provider = gemini: ${GSD_GEMINI_GONE}; set review_provider to claude, codex, or custom in .gsd.conf`);
  if (!providerKnown(RP)) fail(64, `invalid review_provider '${RP}'; use claude, codex, or custom`);
  if (N === '') {
    const r = git(REPO, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const br = chomp(r.stdout);
    if (br.startsWith('phase-')) {
      const m = /^phase-([0-9]+(?:\.[0-9]+)?).*/.exec(br);
      N = m ? (m[1] as string) : br;
    }
    if (N === '') fail(64, `no phase number given and '${br}' is not a phase-<N>-* branch`);
  }
  // grep -qE is line-based: any line that is a number passes
  if (!N.split('\n').some((l) => /^[0-9]+(\.[0-9]+)?$/.test(l))) fail(64, `invalid phase number: ${N}`);
  const P = N.includes('.') ? N : pad2(N);
  const g = guardArgv(['--command', 'gsdt-flow', '--phase', N, '--repo', REPO], { env, cwd });
  so.push(g.stdout);
  se.push(g.stderr);
  if (g.rc !== 0) throw new Stop(g.rc);
  let pd = '';
  const phases = `${REPO}/.planning/phases`;
  for (const name of names(phases)) {
    if (name.startsWith(`${P}-`) && isDir(`${phases}/${name}`)) {
      pd = `${phases}/${name}`;
      break;
    }
  }
  if (pd === '') fail(1, `no .planning/phases/${P}-* directory in ${REPO}`);

  // ── helpers (bash: has, fm, jstr, emit) ───────────────────────────────────
  const has = (suffix: string): boolean => isFile(`${pd}/${P}-${suffix}`);
  const fm = (suffix: string, key: string): string => frontmatterValue(`${pd}/${P}-${suffix}`, key);
  /** ${pd#"$REPO"/} */
  const relPd = pd.startsWith(`${REPO}/`) ? pd.slice(REPO.length + 1) : pd;
  /** a lib/*.sh function through bash; its stderr goes through, its stdout is returned (`$( )`) */
  const lib = (fn: string, a: string[]): { rc: number; out: string } => {
    const r = bashLib(fn, a, env);
    se.push(r.stderr);
    return { rc: r.rc, out: chomp(r.stdout) };
  };
  let emitted = 0;
  const emit = (step: string, run: string, then: string, stop: string, note: string): void => {
    // --all is a preview, not authorization to execute future steps. Location
    // was checked above; the current executable step is checked on normal calls.
    if (!ALL && run.split('\n').some((l) => l.startsWith('/gsd-'))) {
      const sp = run.indexOf(' ');
      const gcmd = (sp >= 0 ? run.slice(0, sp) : run).replace(/^\//, '');
      const gargs = sp >= 0 ? run.slice(sp + 1) : run;
      const r = guardArgv(['--command', gcmd, '--args', gargs, '--repo', REPO], { env, cwd });
      so.push(r.stdout);
      se.push(r.stderr);
      if (r.rc !== 0) throw new Stop(r.rc);
    }
    emitted++;
    if (JSON_) {
      so.push(`{"phase":"${N}","step":"${step}","run":"${jstr(run)}","then":"${jstr(then)}","stop":"${jstr(stop)}","note":"${jstr(note)}"}\n`);
    } else {
      if (emitted > 1) so.push('--\n');
      so.push(`step=${step}\n`);
      if (run !== '') so.push(`run=${run}\n`);
      if (then !== '') so.push(`then=${then}\n`);
      if (stop !== '') so.push(`stop=${stop}\n`);
      if (note !== '') so.push(`note=${note}\n`);
    }
    if (!ALL) throw new Stop(0);
  };

  // screens? A UI-SPEC or LAYOUT on disk settles it; otherwise --ui/--no-ui.
  if (has('UI-SPEC.md') || has('LAYOUT.md')) UI = 'yes';
  const GATES = uiGates(REPO);

  // 1 ticket — the tracker's issue/task, saved in the phase folder. The tag
  // tk-<id> in the ROADMAP title (or dir name) says which one.
  const TRACKER = lib('gsd_tracker_which', [REPO]).out; // TODO(P9)
  if (TRACKER !== 'none' && !has('TICKET.md') && !has('STORY.md') && !pd.includes('cu_')) {
    const rel = `${relPd}/${P}-TICKET.md`;
    const nRe = `${N}|${P}`.replace(/\./g, '\\.');
    const headRe = new RegExp(`^#{2,4} Phase (${nRe}):`);
    const road = readText(`${REPO}/.planning/ROADMAP.md`);
    const heading = road === null ? '' : (fileLines(road).find((l) => headRe.test(l)) ?? '');
    let tk = lib('gsd_ticket_extract', [heading]).out; // TODO(P9)
    if (tk === '') tk = lib('gsd_ticket_extract', [pd.slice(pd.lastIndexOf('/') + 1)]).out;
    if (tk !== '') {
      emit('ticket', `gsdt-tracker snapshot ${tk} --out ${rel}`, `commit ${rel}`, '', `saves ${TRACKER} ticket ${tk} (description + comments) for discuss and planning`);
    } else {
      emit('ticket', '', '', `phase ${N} has no ticket: ask the user for its ${TRACKER} id, then run gsdt-tracker snapshot <id> --out ${rel} and commit it (or write ${rel} by hand)`, 'a ticket holds the product intent, in product words');
    }
  }
  // 2 discuss
  const discussThen = TRACKER === 'none' ? '' : `update the ${TRACKER} ticket to the agreed scope`;
  if (!has('CONTEXT.md')) emit('discuss', `/gsd-discuss-phase ${N}`, discussThen, 'discuss asks the user the open questions', 'run it live — never auto-answer');
  // 3 screens?
  const planFiles = (): string[] => {
    const re = new RegExp(`^${P.replace(/\./g, '\\.')}-[0-9].*-PLAN\\.md$`);
    return names(pd)
      .filter((n) => re.test(n) && isFile(`${pd}/${n}`))
      .map((n) => `${pd}/${n}`);
  };
  const plans = planFiles();
  const PLANS = plans.length > 0 ? 'yes' : '';
  if (UI === '' && PLANS === '') {
    emit('ui-decision', '', '', `does phase ${N} have screens? if the user already said (discuss, ticket, this session), use that; otherwise ask once. Then re-run with --ui or --no-ui`, 'UI is agreed BEFORE planning; plan-phase would otherwise auto-generate an un-agreed UI-SPEC');
  }
  // 3b design system + layout — decided before the UI-SPEC, so the spec (and
  // ui-review, which checks code against it) has a layout to hold the screens to.
  if (UI === 'yes' && GATES !== 'off' && !has('UI-SPEC.md')) {
    if (uiDesignState(REPO) !== 'ok') {
      emit('design-system', 'gsdt-ui design', '', 'agree the design system with the user and fill .planning/design/DESIGN.md (references, tokens, components, page templates), then delete its stub line. Start from real systems: offer the user the 3 closest from styles.refero.design, and chosen fonts, not the default', 'one design system for every phase with screens; it is filled once, usually by the first such phase. ui_gates = off in .gsd.conf turns the UI gates off');
    }
    const lrel = `${relPd}/${P}-LAYOUT.md`;
    switch (uiLayoutState(REPO, pd, P)) {
      case 'missing':
        emit('layout', `gsdt-ui layout ${N}`, "/gsd-sketch <this phase's main screen>", `the user picks the winning sketch variant; then write its folder in sketch:, the pages (URL paths) in pages:, and each page's main button in main_button: of ${lrel}`, 'sketch: skip <reason> only when the user agrees (e.g. a small change on an existing page)');
        break;
      case 'nosketch':
        emit('layout', "/gsd-sketch <this phase's main screen>", '', `the user picks the winning sketch variant; then write its folder in sketch: of ${lrel}`, 'sketch: skip <reason> only when the user agrees');
        break;
      case 'badsketch':
        emit('layout', '', '', `sketch: in ${lrel} does not name a sketch folder — fix it (e.g. .planning/sketches/003-catalog)`, '');
        break;
      case 'nowinner':
        emit('layout', '', '', `the sketch in ${lrel} has no winner yet — ask the user to pick a variant and mark winner: in its README.md`, '');
        break;
      case 'nopages':
        emit('layout', '', '', `list the pages this phase builds (URL paths) in pages: of ${lrel} — gsdt-ui check opens them`, '');
        break;
    }
  }
  // 4 ui-phase
  if (UI === 'yes' && !has('UI-SPEC.md')) {
    const uiNote = GATES === 'off' ? '' : `follow .planning/design/DESIGN.md and ${relPd}/${P}-LAYOUT.md (the chosen sketch); add the layout: sections top to bottom, the one main focus, the main button`;
    emit('ui-phase', `/gsd-ui-phase ${N}`, '', 'run it now, without asking first; when it is done, the user must agree the screens before planning', uiNote);
  }
  // 5 plan — always settle the research question, or plan-phase stops to ask
  // it (it asks whenever RESEARCH.md is missing and no flag was given). Never
  // --auto: that also chains into execute and skips the review gate.
  // workflow.research in .planning/config.json (GSD's own setting) picks the
  // answer; unreadable or unset = research (the plan checker wants its test list).
  if (PLANS === '') {
    let planRun: string;
    if (has('RESEARCH.md')) planRun = `/gsd-plan-phase ${N}`;
    else if (workflowFlag(REPO, 'research') === 'false') planRun = `/gsd-plan-phase ${N} --skip-research`;
    else planRun = `/gsd-plan-phase ${N} --research`;
    emit('plan', planRun, '', '', '');
  }
  // 6 cross-AI review — a REVIEWS.md whose reviewer failed (e.g. hit the Codex
  // usage limit) is no review: same test as the guard (gsd_reviews_problem).
  const reviewsFile = `${pd}/${P}-REVIEWS.md`;
  let revBad = '';
  if (has('REVIEWS.md')) revBad = chomp(reviewsProblem(reviewsFile, RP) ?? '');
  if (!has('REVIEWS.md') || revBad !== '') {
    const flag = providerReviewFlag(RP);
    const reviewRun = flag !== null ? `/gsd-review --phase ${N} ${flag}` : `request an independent custom-provider review of ${pd} and save verified findings to ${P}-REVIEWS.md`;
    let reviewNote = `independent reviewer: ${RP}; external gsd-review capability required for automatic delegation. If unavailable, hand off the plans to a separate reviewer session and record ${P}-REVIEWS.md; never skip the gate.`;
    // A rerun costs a full review, and a large file may be a real one this check
    // misread: have it looked at first.
    if (revBad !== '') {
      const revLines = (readFileSync(reviewsFile, 'latin1').match(/\n/g) ?? []).length; // wc -l
      if (revLines > 40) {
        reviewNote = `${P}-REVIEWS.md is not a usable review (${revBad}), but it has ${revLines} lines: open it and check before you delete it, because a rerun costs a full review. If it holds a real review, show the user and do not rerun. If the reviewer really failed, delete it and run again. ${reviewNote}`;
      } else {
        reviewNote = `${P}-REVIEWS.md is not a usable review (${revBad}): delete it and run the review again. ${reviewNote}`;
      }
    }
    if (RP === 'codex') reviewNote = `${reviewNote} On a Codex usage limit: run gsdt-codex-wait --wait-only as a background job (it waits for the reset Codex gave, without calling Codex), delete ${P}-REVIEWS.md if one was written, then run this step again.`;
    emit('review', reviewRun, `/gsd-plan-phase ${N} --reviews`, 'show the user the independent findings before the replan; verify each against the plans, never accept on trust', reviewNote);
  }
  // 6b replan — the --reviews replan leaves no artifact of its own, so use git:
  // a plan committed after REVIEWS.md means it happened (commit_docs is on in a
  // GSD repo). Same commit counts as done; REVIEWS.md uncommitted = not yet.
  if (has('REVIEWS.md') && revBad === '' && PLANS !== '') {
    const ct = (file: string): string => chomp(git(REPO, ['log', '-1', '--format=%ct', '--', file]).stdout);
    const rt = ct(reviewsFile);
    let pt = 0n;
    for (const f of planFiles()) {
      if (!isFile(f)) continue;
      const t = ct(f);
      const tn = t === '' ? 0n : BigInt(t);
      if (tn > pt) pt = tn;
    }
    if (rt === '' || pt < BigInt(rt)) {
      emit('replan', `/gsd-plan-phase ${N} --reviews`, '', '', 'REVIEWS.md exists but no plan was committed after it — the review was not folded into the plans');
    }
  }
  // 7 execute
  let missing = 0;
  for (const f of planFiles()) {
    if (!isFile(f)) continue;
    if (!isFile(`${f.slice(0, -'-PLAN.md'.length)}-SUMMARY.md`)) missing++;
  }
  if (missing !== 0) emit('execute', `/gsd-execute-phase ${N}`, '', '', `${missing} plan(s) without a SUMMARY; execute-phase runs code review and the verifier itself`);
  // 7b verifier — all plans done but the verifier never wrote its report
  if (PLANS !== '' && missing === 0 && !has('VERIFICATION.md')) {
    emit('verifier', `/gsd-execute-phase ${N}`, '', '', 'every plan has a SUMMARY but there is no VERIFICATION.md; with all plans complete, execute-phase only runs the verifier');
  }
  // 8 gaps
  if (fm('VERIFICATION.md', 'status') === 'gaps_found') {
    emit('gaps', `/gsd-plan-phase ${N} --gaps`, `/gsd-execute-phase ${N} --gaps-only`, '', 'VERIFICATION.md reports gaps');
  }
  // 9 verify-work
  let uats = '';
  let open = '';
  const uatPrefix = `${P}-`;
  for (const n of names(pd)) {
    // "$pd/$P"-*UAT.md: P- then anything (even nothing) then UAT.md
    if (!(n.startsWith(uatPrefix) && n.endsWith('UAT.md') && n.length >= uatPrefix.length + 6)) continue;
    if (!isFile(`${pd}/${n}`)) continue;
    uats = 'yes';
    const st = frontmatterValue(`${pd}/${n}`, 'status');
    if (st === 'pending' || st === 'partial') open += ` ${n}(${st})`;
  }
  if (uats === '') {
    emit('verify-work', `/gsd-verify-work ${N}`, '', '', 'agent-driven UAT walk (Playwright/screenshots), recorded as agent-verified. Use headless Playwright (no window) — never the user\'s own browser (Claude in Chrome, the browser pane, open <url>)');
  } else if (open !== '') {
    emit('verify-work', `/gsd-verify-work ${N}`, '', '', `open UAT items:${open}`);
  }
  // 10 code review
  if (!has('REVIEW.md')) {
    emit('code-review', `/gsd-code-review ${N}`, '', '', 'execute-phase normally produces this; missing means it errored');
  } else {
    const st = fm('REVIEW.md', 'status');
    if (!(st === '' || st === 'clean' || st === 'skipped') && !has('REVIEW-FIX.md')) {
      emit('code-review', `/gsd-code-review ${N} --fix`, '', '', `REVIEW.md status: ${st}`);
    }
  }
  // 11 the rendered pages: check → look → approve, then ui-review. gsd_ui_gate
  // (src/ui.ts uiGate) names the first open one; the guard and gsdt-finish ask it too.
  if (UI === 'yes' && GATES !== 'off') {
    if (!uiExempt(REPO, pd, P)) {
      const gate = uiGate(REPO, pd, P);
      const gstep = gate.includes('|') ? gate.slice(0, gate.indexOf('|')) : gate;
      let gwhy = gate.slice(gate.lastIndexOf('|') + 1);
      let gstate = gate.includes('|') ? gate.slice(gate.indexOf('|') + 1) : gate;
      if (gstate.includes('|')) gstate = gstate.slice(0, gstate.indexOf('|'));
      const crel = `${relPd}/${P}-UI-CHECK.md`;
      if (gstep === 'ui-check') {
        switch (gstate) {
          case 'failed':
            emit('ui-check', `gsdt-ui check ${N}`, '', '', `${gwhy}: fix the pages, then check again. A finding the user accepts becomes a waive: line in ${P}-LAYOUT.md — never waive without asking`);
            break;
          case 'stale':
            emit('ui-check', `gsdt-ui check ${N}`, '', '', `${gwhy}; start the app in this worktree first. Pages that look the same keep their look and approval`);
            break;
          default:
            emit('ui-check', `gsdt-ui check ${N}`, '', '', `${gwhy}; start the app in this worktree first. It opens each page at 3 widths, measures it and writes ${crel} and the pictures. If the pages cannot be checked, ask the user, then: gsdt-ui check ${N} --skip "<reason>"`);
        }
      }
      if (gstep === 'ui-check' || gstep === 'ui-look') {
        if (gstep !== 'ui-look') gwhy = 'after the check';
        emit('ui-look', `gsdt-ui look ${N}`, '', '', `${gwhy}: open every picture in ${P}-SHOTS/ and answer each line of ${P}-UI-LOOK.md (ok / fixed / bad / n/a — what you saw), then commit it. A bad line means: fix the page and check again`);
      }
      if (gstep === 'ui-check' || gstep === 'ui-look' || gstep === 'ui-approve') {
        if (gstep !== 'ui-approve') gwhy = 'after the look';
        emit('ui-approve', `gsdt-ui sheet ${N}`, `gsdt-ui approve ${N}`, `show the user the sheet and ask for a yes BEFORE gsdt-ui approve; if the user does not want to look (or there are no pictures): gsdt-ui approve ${N} --waive "<reason>"`, gwhy);
      }
    }
  }
  if (UI === 'yes' && !has('UI-REVIEW.md')) {
    let rvNote = 'phase has screens';
    if (GATES !== 'off' && uiCheckState(REPO, pd, P, 'nostale') === 'passed') {
      rvNote = `phase has screens: hold the pictures in ${P}-SHOTS/ and ${P}-UI-LOOK.md against the chosen sketch and the layout rules in ${P}-LAYOUT.md / DESIGN.md, not only the code`;
    }
    emit('ui-review', `/gsd-ui-review ${N}`, '', '', rvNote);
  }
  // 11b validate — every requirement gets a test (/gsd-validate-phase), after
  // all code fixes so the tests see the final code; before secure, the last
  // gate. Same test as the guard and doctor (gsd_validation_problem).
  const valBad = validationProblem(pd, P, REPO);
  if (valBad !== null) {
    emit('validate', `/gsd-validate-phase ${N}`, '', '', `${valBad}: find requirements without a test and write the missing tests (implementation files stay read-only). A gap the user leaves to a person is recorded as manual-only`);
  }
  // 12 secure — the last code gate
  if (!has('SECURITY.md')) {
    emit('secure', `/gsd-secure-phase ${N}`, '', '', 'last code gate — after every --fix has landed');
  } else {
    const o = fm('SECURITY.md', 'threats_open');
    if ((o === '' ? '0' : o) !== '0') emit('secure', `/gsd-secure-phase ${N}`, '', '', `${o} open threat(s)`);
  }

  emit('done', 'gsdt-finish', '', 'gsdt-finish deletes the worktree the session is standing in — it must be the LAST action', '');
  return { rc: 0, stdout: so.join(''), stderr: se.join('') };
}

export function main(argv: string[]): number {
  process.stdout.on('error', () => {});
  const r = flowNext(argv);
  if (r.stdout !== '') process.stdout.write(r.stdout);
  if (r.stderr !== '') process.stderr.write(r.stderr);
  return r.rc;
}
