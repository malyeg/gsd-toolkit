// gsdt-finish — finish a GSD phase from anywhere: merge the phase worktree back
// into the base branch, push, and remove the worktree + branch. Port of the bash
// bin/gsdt-finish (kept as the parity oracle in tests/fixtures/p7-old-bins/).
//
// Takes the lock, then runs gsdt-wt-finish as a CHILD with GSD_LOCK_HELD=1 (as
// gsdt-start does gsdt-wt-new), and afterwards the ticket write-back, the roadmap
// bookkeeping note and the "cd" line. Outside this file until P9: lib/ticket.sh
// (through src/bash-bridge.ts); children: gsdt-wt-finish, gsdt-tracker, gsdt-doctor
// (from PATH, as bash did), gh.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bashLib } from '../bash-bridge.ts';
import {
  acquireLock,
  base,
  chomp,
  commandOnPath,
  findMain,
  finishGates,
  git,
  GsdExit,
  gsdPkg,
  isPrHelper,
  migrateRefuse,
  phaseBranch,
} from '../common.ts';
import { err, inherit, out } from '../stdio.ts';
import { grepq, phaseHeadingRe, worktreeOf } from './wt-new.ts';

const HELP = `gsdt-finish — finish a GSD phase: merge back, push, clean up

Merges the phase worktree's branch into the base branch, pushes, and removes
the worktree + branch. Companion to gsdt-start; delegates the merge/cleanup to
the repo's scripts/gsdt-finish-worktree-feature.sh.

USAGE
  gsdt-finish [<N> | phase-<N>-<slug> | batch-<date>-<slug>] [options]

  With no argument, run it from INSIDE the phase (or batch) worktree — it is
  inferred from the current branch.

  A batch worktree (made by gsdt-batch) lands the same way as a phase: tests →
  merge → .planning repair → push → remove worktree + branch. The per-phase
  gates (UI steps, test audit) and the ticket update are skipped for it.

OPTIONS
  --repo <path>   any checkout of the target repo (default: derived from the
                  current directory)
  --pr            do NOT merge: push the phase branch and open a GitHub PR
                  against the base branch (needs gh). Uses the *-pr branch
                  from /gsd-pr-branch when one exists (planning commits
                  stripped), else the phase branch itself. Worktree stays;
                  run gsdt-finish again (without --pr) once the PR is merged.
  --draft         with --pr: open it as a draft
  -h, --help      show this help

EXAMPLES
  gsdt-finish
      From inside ../<repo>-worktrees/phase-7-invoice-fix: merges phase 7,
      pushes, removes the worktree and branch.

  gsdt-finish 7
      Same, from anywhere inside the repo or its worktrees.

  gsdt-finish phase-7-invoice-fix
      Same, naming the branch explicitly.

  gsdt-finish batch-2026-11-09-fix-labels
      Land a gsdt-batch run: merge its branch, push, remove its worktree.

  gsdt-finish 7 --repo ~/projects/acme/webshop
      Finish a phase of another repo without cd-ing into it first.

BEHAVIOR
  - If the main checkout was left on another branch, it is switched back to
    the base branch automatically (only when it has no uncommitted changes).
  - Safe to run from inside the worktree being removed; afterwards cd to the
    main checkout (the command prints the path).
  - Refuses if the worktree has uncommitted changes — commit them first.
  - Validates the phase and combined base tree, including remote push retries.
    Failed sync/validation prevents push and cleanup; any merge remains local.
  - ROADMAP.md/STATE.md use the reconciling gsd-planning merge driver.
  - Ticket: when the ROADMAP phase title (or the branch name) carries a
    tk-<id> tag and .gsd.conf sets \`tracker = clickup|custom\`, the ticket is
    moved to its testing/review status with a merge comment (best-effort, via
    gsdt-tracker). --pr does the same when the PR opens.

RELATED
  gsdt-start             start a phase (claim + worktree + session) in one step
  gsdt-init              set up GSD in a repo that doesn't have it yet
  gsdt-bootstrap-repo    just the file installation (what gsdt-init wraps)
`;

/** bash `die`: each message is one `✖ ` line */
class Die extends Error {
  lines: string[];
  constructor(lines: string[]) {
    super(lines.join('\n'));
    this.lines = lines;
  }
}
const die = (...lines: string[]): never => {
  throw new Die(lines);
};
/** bash `exit N` after the output so far */
class Stop extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

/** a lib/ticket.sh function (bash until P9): its stderr goes through, stdout is `$( )`-captured */
function ticket(fn: string, args: string[]): string {
  const r = bashLib(fn, args);
  if (r.stderr !== '') err(r.stderr);
  return chomp(r.stdout);
}

/** `sed -E 's/^phase-([0-9]+(\.[0-9]+)?)-.*\/\1/'` (per line, like sed) */
const phaseNumberOf = (s: string): string =>
  s
    .split('\n')
    .map((l) => l.replace(/^phase-([0-9]+(?:\.[0-9]+)?)-.*/, '$1'))
    .join('\n');

/** `grep -E "^### Phase $N:" ROADMAP | head -1` ('' when none, or no file) */
function roadmapTitle(main: string, n: string): string {
  const f = `${main}/.planning/ROADMAP.md`;
  const re = phaseHeadingRe(n);
  if (re === null || !existsSync(f)) return '';
  let text: string;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    return '';
  }
  return text.split('\n').find((l) => re.test(l)) ?? '';
}

export function main(argv: string[]): number {
  try {
    return run(argv);
  } catch (e) {
    if (e instanceof Die) {
      for (const l of e.lines) err(`✖ ${l}\n`);
      return 1;
    }
    if (e instanceof Stop) return e.code;
    if (e instanceof GsdExit) {
      err(e.message);
      return e.code;
    }
    throw e;
  }
}

function run(argv: string[]): number {
  let ID = '';
  let REPO = '';
  let PR = false;
  let DRAFT = false;
  for (let i = 0; i < argv.length; ) {
    const a = argv[i] as string;
    if (a === '-h' || a === '--help') {
      out(HELP);
      return 0;
    }
    if (a === '--repo') {
      if (argv.length - i < 2) die('--repo needs a value');
      REPO = argv[i + 1] as string;
      i += 2;
    } else if (a === '--pr') {
      PR = true;
      i++;
    } else if (a === '--draft') {
      DRAFT = true;
      i++;
    } else if (a.startsWith('-')) {
      die(`unknown flag: ${a} (see gsdt-finish --help)`);
    } else {
      if (ID !== '') die(`unexpected argument: ${a} (see gsdt-finish --help)`);
      ID = a;
      i++;
    }
  }

  // ── locate the main checkout ─────────────────────────────────────────────
  if (REPO !== '') {
    try {
      process.chdir(REPO);
    } catch {
      die(`--repo path not found: ${REPO}`);
    }
  }
  if (git('.', ['rev-parse', '--show-toplevel']).status !== 0) die('not inside a git repo — cd into the repo/worktree or pass --repo <path>');
  const PKG = gsdPkg();

  const MAIN = findMain('.');
  migrateRefuse(MAIN);
  const BASE = base(MAIN);
  if (BASE === '') die(`could not determine the base branch — set 'base = <branch>' in ${MAIN}/.gsd.conf`);

  // ── local lock: serialize gsd commands touching this checkout ────────────
  // Same lock as gsdt-start. The env tells the delegated worker (gsdt-wt-finish) the lock is already held — deliberate that
  // only gsdt-finish sets it, because everything it runs afterwards stays inside this one finish.
  if (!acquireLock(MAIN)) return 1;
  process.env.GSD_LOCK_HELD = '1';

  // ── infer the phase from the current worktree when no argument given ─────
  if (ID === '') {
    const br = chomp(git('.', ['branch', '--show-current']).stdout);
    if (br.startsWith('phase-') || br.startsWith('batch-')) ID = br;
    else die(`no phase given and current branch '${br}' is not a phase-* or batch-* worktree`, 'usage: gsdt-finish [N | phase-N-slug | batch-…] [--repo <path>]');
  }

  // ── main checkout must be on the base branch (auto-switch when clean) ────
  if (!grepq(/^([0-9]+(\.[0-9]+)?|phase-[0-9]+(\.[0-9]+)?-.+|batch-.+)$/, ID)) die('finish requires a phase number, a phase-N-slug branch or a batch-* branch');
  const KIND = ID.startsWith('batch-') ? 'batch' : 'phase';
  if (ID.startsWith('phase-') && isPrHelper(MAIN, ID)) die('finish the phase branch, not a PR-helper branch');
  const cur = chomp(git(MAIN, ['branch', '--show-current'], { inheritStderr: true }).stdout);
  if (cur !== BASE) {
    if (chomp(git(MAIN, ['status', '--porcelain'], { inheritStderr: true }).stdout) !== '') {
      die(`main checkout is on '${cur}' with uncommitted changes — clean it up, then re-run`);
    }
    out(`▶ main checkout was on '${cur}' — switching to '${BASE}'…\n`);
    const rc = inherit('git', ['-C', MAIN, 'checkout', '-q', BASE]);
    if (rc !== 0) return rc;
  }

  // ── resolve the ticket BEFORE the branch is deleted ──────────────────────
  // The id rides in the phase's ROADMAP title (tk-<id>, exact case) or, failing that, the branch name (lowercased by the
  // slug). Captured here, acted on after the merge succeeds. Best-effort throughout — never blocks the finish.
  let TICKET_ID = '';
  let PHASE_N = '';
  let BR: string;
  if (ID.startsWith('batch-')) BR = ID;
  else if (ID.startsWith('phase-')) {
    BR = ID;
    PHASE_N = chomp(phaseNumberOf(ID));
  } else {
    PHASE_N = ID;
    BR = phaseBranch(MAIN, ID);
  }
  // A batch has no ROADMAP phase, so no ticket.
  if (KIND === 'phase' && ticket('gsd_tracker_which', [MAIN]) !== 'none') {
    if (PHASE_N !== '' && existsSync(`${MAIN}/.planning/ROADMAP.md`)) {
      TICKET_ID = ticket('gsd_ticket_extract', [roadmapTitle(MAIN, PHASE_N)]);
    }
    if (TICKET_ID === '') TICKET_ID = ticket('gsd_ticket_extract', [BR]);
  }

  // ── --pr: push + open a PR instead of merging ────────────────────────────
  // For repos with branch protection. Nothing is merged or removed; the normal finish runs later, after the PR lands.
  if (PR) {
    if (commandOnPath('gh') === null) die('--pr needs the GitHub CLI (gh) on PATH');
    if (ID.startsWith('phase-') || ID.startsWith('batch-')) BR = ID;
    else {
      BR = phaseBranch(MAIN, ID);
      if (BR === '') die(`no phase-${ID}-* branch found`);
    }
    if (git(MAIN, ['show-ref', '--verify', '--quiet', `refs/heads/${BR}`]).status !== 0) die(`branch '${BR}' not found`);
    PHASE_N = '';
    if (KIND !== 'batch') PHASE_N = chomp(phaseNumberOf(BR));
    let HEAD_BR = BR;
    if (git(MAIN, ['show-ref', '--verify', '--quiet', `refs/heads/${BR}-pr`]).status === 0) HEAD_BR = `${BR}-pr`;
    // The same UI gate as the merge path (the PR is how this phase reaches the base).
    const PR_WT = worktreeOf(MAIN, BR);
    if (KIND !== 'batch') {
      const g = finishGates(MAIN, BR, PR_WT);
      if (g.stderr !== '') err(g.stderr);
      if (!g.ok) die('no PR was opened');
    }
    out(`▶ pushing '${HEAD_BR}'…\n`);
    // No retry loop here: a rejected push means origin has commits this branch lacks, and only the user can say how to integrate them.
    if (inherit('git', ['-C', MAIN, 'push', '-u', 'origin', HEAD_BR, '--quiet']) !== 0) {
      die(`push of '${HEAD_BR}' failed — if origin has newer commits, run 'git pull --rebase origin ${HEAD_BR}' where that branch is checked out, then rerun gsdt-finish --pr`);
    }
    let TITLE = '';
    if (KIND !== 'batch') TITLE = roadmapTitle(MAIN, PHASE_N === '' ? 'x' : PHASE_N).replace(/^### /, '');
    out(`▶ opening PR ${HEAD_BR} → ${BASE}…\n`);
    const title = TITLE !== '' ? TITLE : HEAD_BR;
    const draft = DRAFT ? ['--draft'] : [];
    const remote = chomp(git(MAIN, ['remote', 'get-url', 'origin'], { inheritStderr: true }).stdout);
    const first = inherit('gh', ['pr', 'create', '--repo', remote, '--base', BASE, '--head', HEAD_BR, '--title', title, '--fill-verbose', ...draft], {
      stdio: ['inherit', 'inherit', 'ignore'],
    });
    if (first !== 0) {
      if (inherit('gh', ['pr', 'create', '--base', BASE, '--head', HEAD_BR, '--title', title, '--body', '', ...draft]) !== 0) {
        die('gh pr create failed (is origin a GitHub repo and gh authenticated?)');
      }
    }
    if (TICKET_ID !== '') {
      const rc = inherit(`${PKG}/bin/gsdt-tracker`, ['--repo', MAIN, 'finish', TICKET_ID, `🔀 GSD phase ${PHASE_N || '?'}: PR opened ${HEAD_BR} → ${BASE}`]);
      if (rc !== 0) out(`• ticket ${TICKET_ID} not updated (non-fatal) — check: gsdt-tracker check\n`);
    }
    out('\n');
    out(`Worktree kept. After the PR merges:  gsdt-finish ${BR}\n`);
    return 0;
  }

  // Run from the main checkout so removing the worktree we may be standing in is safe; the toolkit worker does the merge →
  // push → cleanup.
  process.chdir(MAIN);
  const wrc = inherit(`${PKG}/bin/gsdt-wt-finish`, [ID, BASE]);
  if (wrc !== 0) return wrc;

  // ── ticket write-back (best-effort): ticket → "in testing" + merge comment ──
  if (TICKET_ID !== '') {
    const r = git(MAIN, ['rev-parse', '--short', BASE]);
    const SHA = r.status === 0 ? chomp(r.stdout) : '?';
    const rc = inherit(`${PKG}/bin/gsdt-tracker`, [
      '--repo',
      MAIN,
      'finish',
      TICKET_ID,
      `✅ GSD phase ${PHASE_N || '?'} merged to ${BASE} — commit ${SHA} in ${path.basename(MAIN)}. Ready for testing.`,
    ]);
    if (rc !== 0) out(`• ticket ${TICKET_ID} not updated (non-fatal) — check: gsdt-tracker check\n`);
  }

  // ── roadmap bookkeeping (best-effort, never blocks) ──────────────────────
  // The merge is the moment the phase's tracking rows land on the base branch, so it is the last cheap chance to notice that
  // upstream's phase.insert / phase.complete quietly failed to write or tick them. Warn only.
  if (commandOnPath('gsdt-doctor') !== null) {
    const d = spawnSync('gsdt-doctor', ['--repo', MAIN, '--quiet'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    const bookkeeping = chomp(
      (d.stdout ?? '')
        .split('\n')
        .filter((l) => /checklist row|Progress table|tick/.test(l))
        .join('\n'),
    );
    if (bookkeeping !== '') {
      out('\n');
      out('⚠ roadmap bookkeeping needs a hand (the merge itself is fine):\n');
      out(`${bookkeeping}\n`);
      out('  full report: gsdt-doctor\n');
    }
  }

  out('\n');
  out(`If your shell was inside the removed worktree:  cd ${MAIN}\n`);
  return 0;
}
