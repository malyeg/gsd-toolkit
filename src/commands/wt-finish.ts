// gsdt-wt-finish — merge a finished phase worktree back into the base branch,
// push, and clean up the worktree + branch. The worker behind gsdt-finish;
// callable standalone too. Port of the bash bin/gsdt-wt-finish (kept as the
// parity oracle in tests/fixtures/p7-old-bins/).
//
// The order is the finish path from CLAUDE.md and must not change: lock → sync
// origin (abort on failure) → gates → validate before merge → merge (abort on
// conflict) → planning repair → validate the combined tree → push with 3 retries
// (pull, repair, validate after each) → cleanup. A failed merge or validation
// leaves the remote base branch untouched.
//
// Safety: refuses if the worktree has uncommitted changes or if the main checkout
// isn't on the base branch. A conflicting merge is aborted — the base branch is
// left clean and the resolution steps are printed. Parallel runs serialize on
// .git/gsd-cmd.lock (skipped when gsdt-finish holds it: GSD_LOCK_HELD=1).
//
// .planning reconcile: ROADMAP.md and STATE.md merge with the gsd-planning driver
// (registered here on every run: git config is not versioned) and gsdt-planning-repair
// runs after BOTH merge points — the phase merge, and the `pull` on the push-retry
// path (a parallel session moved the base branch). The base branch is never pushed
// while .planning contradicts itself.
//
// Pre-merge check hook: an executable scripts/gsdt-premerge-check.sh (`premerge = <path>`
// in .gsd.conf; 'none' disables) runs from the main checkout AFTER the origin sync and
// BEFORE the merge, as `<script> <branch> <base>`; nonzero aborts with nothing merged.
// Without that script the project's tests run (`test = <cmd>`, 'none' disables, else
// detected) in the checkout being validated. The validator runs again on the combined
// main checkout after the phase merge and every remote retry, before pushing. Failure
// keeps any local merge and the phase worktree.
//
// Gates (`finishGates`, common.ts): the UI steps (ui_gates) then, with flow = strict,
// the test audit. A batch (batch-*) has no phase folder: none applies.
//
// Still outside this file: gsdt-planning-repair (found on PATH, as bash did) and
// the project's own pre-merge script / test command (children).
import { SH, WIN, normalizePath, selfArgv, spawnSyncX as spawnSync } from '../spawn.ts';
import path from 'node:path';
import {
  acquireLock,
  base,
  chomp,
  commandOnPath,
  findMain,
  finishGates,
  git,
  GsdExit,
  isDir,
  isExec,
  isFile,
  isPrHelper,
  originLacks,
  phaseBranch,
  registerMergeDriver,
  testCmd,
  confGet,
  wtdir,
} from '../common.ts';
import { err, inherit, out } from '../stdio.ts';
import { grepq, worktreeOf } from './wt-new.ts';
import { existsSync } from 'node:fs';

/** bash `exit N` after the output so far */
class Stop extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}
const fail = (msg: string): never => {
  err(`${msg}\n`);
  throw new Stop(1);
};

/** a program whose stdout goes to our stderr (`cmd >&2`) */
function toStderr(cmd: string, args: string[], cwd?: string): number {
  const r = spawnSync(cmd, args, { cwd, stdio: ['inherit', 2, 2] });
  if (r.error) return 127;
  return r.status ?? 1;
}

/** `git diff --name-only --diff-filter=U | tr '\n' ' '` */
function conflictList(main: string): string {
  const r = git(main, ['diff', '--name-only', '--diff-filter=U']);
  return r.stdout.split('\n').filter((l) => l !== '').map((l) => `${l} `).join('');
}

export function main(argv: string[]): number {
  try {
    return run(argv);
  } catch (e) {
    if (e instanceof Stop) return e.code;
    if (e instanceof GsdExit) {
      err(e.message);
      return e.code;
    }
    throw e;
  }
}

function run(argv: string[]): number {
  const ID = argv[0] ?? '';
  if (ID === '') {
    err('usage: gsdt-wt-finish <N | phase-N-slug | batch-…> [base]\n');
    return 1;
  }

  const MAIN = findMain('.');
  if (MAIN === '') fail('error: not inside a git repository');
  const BASE = argv[1] !== undefined && argv[1] !== '' ? argv[1] : base(MAIN);

  // ── serialize on the shared main checkout ────────────────────────────────
  // Same lock as gsdt-start/gsdt-finish. Skipped when the caller already holds it (gsdt-finish sets GSD_LOCK_HELD=1).
  if (!acquireLock(MAIN)) return 1;

  // Resolve the branch: a bare number → the phase-<N>-* branch; else use as-is.
  // PR branches (*-pr, from /gsd-pr-branch) are never the feature branch.
  let KIND = 'phase';
  let BRANCH: string;
  if (grepq(/^batch-.+$/, ID)) {
    KIND = 'batch';
    BRANCH = ID;
  } else if (grepq(/^[0-9]+(\.[0-9]+)?$/, ID)) {
    BRANCH = phaseBranch(MAIN, ID);
    if (BRANCH === '') fail(`error: no 'phase-${ID}-*' branch found`);
  } else {
    if (!grepq(/^phase-[0-9]+(\.[0-9]+)?-.+$/, ID)) fail('error: finish requires a phase number, a phase-N-slug branch or a batch-* branch');
    if (isPrHelper(MAIN, ID)) fail('error: finish the phase branch, not a PR-helper branch');
    BRANCH = ID;
  }

  if (git(MAIN, ['show-ref', '--verify', '--quiet', `refs/heads/${BRANCH}`]).status !== 0) fail(`error: branch '${BRANCH}' not found`);
  // The branch's actual worktree path, from git itself (a worktree can live outside the conventional sibling dir).
  let DEST = worktreeOf(MAIN, BRANCH);
  if (DEST === '') DEST = `${path.dirname(MAIN)}/${wtdir(MAIN)}/${BRANCH}`;

  if (isDir(DEST) && chomp(git(DEST, ['status', '--porcelain'], { inheritStderr: true }).stdout) !== '') {
    fail(`error: ${DEST} has uncommitted changes — commit them in the worktree first`);
  }
  const cur = chomp(git(MAIN, ['branch', '--show-current'], { inheritStderr: true }).stdout);
  if (cur !== BASE) fail(`error: main checkout is on '${cur}', not '${BASE}' (git -C "${MAIN}" checkout ${BASE}), then re-run.`);

  // ── .planning merge safety ───────────────────────────────────────────────
  // Register the reconciling merge driver (config is not versioned, so re-assert it every run) and repair after each merge point.
  // (bash ran this under set -e: a failed `git config` ended the command. git's status is not kept; 255 is its lock-failure code.)
  if (!registerMergeDriver(MAIN)) return 255;

  /** repair_planning: false = refuse to go on (bash `return 1`, which set -e turns into exit 1) */
  const repairPlanning = (phrase: string): boolean => {
    const pl = `${MAIN}/.planning`;
    if (!isDir(pl)) return true;
    // No ROADMAP.md → nothing to reconcile (the repair tool exits 2 on this, which would read as "corrupt — not pushing").
    if (!isFile(`${pl}/ROADMAP.md`)) return true;
    // On PATH when installed; else through this package's own launcher (a Node switch can drop the install from PATH).
    // Never skipped: merge damage must not be pushed.
    const onPath = commandOnPath('gsdt-planning-repair') !== null;
    const repairCmd = (args: string[]): [string, string[]] => (onPath ? ['gsdt-planning-repair', args] : selfArgv('planning-repair', args));
    if (!onPath) out('▶ gsdt-planning-repair is not on PATH — running it from the toolkit package\n');
    out(`▶ reconciling .planning after ${phrase}…\n`);
    {
      const [c, a] = repairCmd(['--repo', MAIN, '--commit']);
      if (inherit(c, a) !== 0) err('⚠ .planning reconcile exited nonzero — verifying before we go on\n');
    }
    // Assert the guarantee rather than assume it, even when the repair itself failed: the files must be coherent, and the
    // repair must have been COMMITTED (--check reads the working tree).
    const [cc, ca] = repairCmd(['--repo', MAIN, '--check']);
    if (inherit(cc, ca, { stdio: ['inherit', 'ignore', 'ignore'] }) !== 0) {
      err('✗ .planning is STILL self-contradictory after the repair — not pushing.\n');
      if (!onPath) err('  (gsdt-planning-repair is not on PATH and the package copy did not run it either — re-run gsdt-setup, or check Node >= 24.)\n');
      toStderr(cc, ca);
      err('  The merge is committed locally only. Fix .planning, commit, then re-run finish.\n');
      return false;
    }
    // tracked files only: an untracked note someone keeps in .planning/ is not an uncommitted repair
    if (chomp(git(MAIN, ['status', '--porcelain', '--untracked-files=no', '--', '.planning']).stdout) !== '') {
      err('✗ the .planning repair was not committed — not pushing.\n');
      toStderr('git', ['-C', MAIN, 'status', '--short', '--untracked-files=no', '--', '.planning']);
      err('  Commit it, then re-run finish.\n');
      return false;
    }
    return true;
  };

  const HAS_ORIGIN = git(MAIN, ['remote', 'get-url', 'origin']).status === 0;

  if (HAS_ORIGIN) {
    out(`▶ syncing local '${BASE}' with origin…\n`);
    if (inherit('git', ['-C', MAIN, 'fetch', 'origin', BASE, '--quiet']) !== 0 || inherit('git', ['-C', MAIN, 'merge', '--ff-only', `origin/${BASE}`]) !== 0) {
      if (originLacks(MAIN, BASE)) {
        fail(`error: origin has no '${BASE}' branch — push it first (git -C "${MAIN}" push -u origin ${BASE}), or set base = <branch> in .gsd.conf. The ${KIND} worktree is kept.`);
      }
      fail(`error: could not synchronize '${BASE}'; resolve remote connectivity or divergence, then retry finish. The ${KIND} worktree is kept.`);
    }
  }

  // ── UI steps of a phase with screens (ui_gates), then the test audit (flow = strict) ──
  // After the sync: a phase whose UI review is already on the base branch is left alone. A batch has no phase folder.
  let unverified: string | undefined;
  if (KIND === 'phase') {
    const g = finishGates(MAIN, BRANCH, DEST);
    unverified = g.unverified;
    if (g.stderr !== '') err(g.stderr);
    if (!g.ok) {
      err(`  Nothing was merged. The ${KIND} worktree is kept.\n`);
      return 1;
    }
  }

  // ── pre-merge check hook (repo-specific validations) ─────────────────────
  // Runs after the sync so it sees the freshest base; nonzero exit aborts with nothing merged.
  const PREMERGE = confGet(MAIN, 'premerge') || 'scripts/gsdt-premerge-check.sh';
  const PREMERGE_PATH = PREMERGE.startsWith('/') || (WIN && path.isAbsolute(PREMERGE)) ? PREMERGE : `${MAIN}/${PREMERGE}`;
  /** validate_finish: false = bash `return 1` (set -e: the command ends with exit 1) */
  const validateFinish = (validationDir: string, stage: string): boolean => {
    // Windows has no exec bit: the script is run as `sh <script>` there
    if (!WIN && PREMERGE !== 'none' && existsSync(PREMERGE_PATH) && !isExec(PREMERGE_PATH)) {
      // Present but not runnable: falling through to tests (or to nothing under `test = none`) would merge code the repo meant to gate.
      err(`✗ ${PREMERGE} exists but is not executable — chmod +x it (or set premerge = none).\n`);
      return false;
    }
    if (PREMERGE !== 'none' && isExec(PREMERGE_PATH)) {
      out(`▶ pre-merge check (${PREMERGE})…\n`);
      if ((WIN ? inherit('sh', [PREMERGE_PATH.replace(/\\/g, '/'), BRANCH, BASE], { cwd: MAIN }) : inherit(PREMERGE_PATH, [BRANCH, BASE], { cwd: MAIN })) !== 0) {
        err(`✗ validation failed (${stage}) — not pushing or removing the ${KIND} worktree.\n`);
        return false;
      }
      return true;
    }
    const TEST_CMD = testCmd(MAIN);
    if (TEST_CMD !== '') {
      // No repo-authored check: the project's test suite, run in the checkout being validated.
      out(`▶ tests (${TEST_CMD}, in ${validationDir}; ${stage})…\n`);
      let rc: number;
      if (!isDir(validationDir)) {
        err(`gsdt-wt-finish: cd: ${validationDir}: No such file or directory\n`);
        rc = 1;
      } else rc = inherit(SH, ['-c', TEST_CMD], { cwd: validationDir });
      if (rc !== 0) {
        err(`✗ tests failed (${stage}) — not pushing or removing the ${KIND} worktree. Any merge remains local.\n`);
        err(`  (skip with 'test = none' in .gsd.conf, or provide ${PREMERGE})\n`);
        return false;
      }
    }
    return true;
  };
  if (!validateFinish(DEST, 'before merge')) return 1;

  out(`▶ merging '${BRANCH}' into '${BASE}'…\n`);
  if (inherit('git', ['-C', MAIN, 'merge', '--no-ff', BRANCH, '-m', `Merge ${BRANCH} into ${BASE}`]) !== 0) {
    const conflicts = conflictList(MAIN);
    git(MAIN, ['merge', '--abort']);
    err(`✗ merge conflict with '${BASE}' — aborted, '${BASE}' left clean. Conflicts: ${conflicts || '?'}\n`);
    err(`  Resolve in the worktree: git -C ${DEST} merge ${BASE}, fix conflicts, commit, then re-run finish.\n`);
    return 1;
  }
  if (!repairPlanning('the phase merge')) return 1;
  if (!validateFinish(MAIN, 'combined tree after phase merge')) return 1;

  if (HAS_ORIGIN) {
    out(`▶ pushing '${BASE}'…\n`);
    let pushed = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (inherit('git', ['-C', MAIN, 'push', 'origin', BASE, '--quiet']) === 0) {
        pushed = true;
        break;
      }
      out(`  push rejected (parallel session moved '${BASE}') — merging origin/${BASE} and retrying…\n`);
      if (inherit('git', ['-C', MAIN, 'pull', '--no-rebase', '--no-edit', 'origin', BASE]) !== 0) {
        const conflicts = conflictList(MAIN);
        git(MAIN, ['merge', '--abort']);
        err(`✗ conflict syncing with origin/${BASE} — aborted, '${BASE}' left clean. Conflicts: ${conflicts || '?'}\n`);
        err(`  Resolve manually: git -C ${MAIN} pull --no-rebase origin ${BASE}, fix, commit, push — then re-run finish to clean up.\n`);
        return 1;
      }
      // This pull is the divergence case union handles worst — another session moved the base branch under us.
      if (!repairPlanning(`the origin/${BASE} sync`)) return 1;
      if (!validateFinish(MAIN, 'combined tree after remote retry')) return 1;
    }
    if (!pushed) {
      err(`✗ could not push '${BASE}' after 3 attempts — push manually, then re-run to clean up.\n`);
      return 1;
    }
  } else {
    out("• no 'origin' remote — skipping push\n");
  }

  out('▶ removing worktree + branch…\n');
  if (isDir(DEST)) {
    // The worktree was clean when the finish began, so new files in it now came from the finish's own test run (coverage,
    // caches). Its work is merged and pushed by now: those go. Anything else is kept, with the branch — and the finish still
    // succeeds, since the merge is already on origin.
    const left = chomp(git(DEST, ['status', '--porcelain']).stdout);
    const leftLines = left.split('\n');
    if (left !== '' && leftLines.some((l) => !l.startsWith('?? '))) {
      err(`⚠ ${DEST} has changes made while the finish ran — kept it and '${BRANCH}':\n`);
      toStderr('git', ['-C', DEST, 'status', '--short']);
      if (unverified !== undefined) err(`⚠ phase ${unverified} merged but not marked complete — /gsd-verify-work ${unverified}\n`);
      err('  The phase IS merged and pushed. Once you have looked at them:\n');
      err(`    git worktree remove --force "${DEST}" && git branch -D ${BRANCH}\n`);
      return 0;
    }
    if (left !== '') {
      out('• removing files the tests left in the worktree:\n');
      for (const l of leftLines) out(`${l.replace(/^\?\? /, '    ')}\n`);
    }
    // Windows cannot delete a folder that is some process's working directory, and this one may be run from inside it.
    try {
      process.chdir(MAIN);
    } catch {
      /* the removal then reports what it cannot do */
    }
    const rc = inherit('git', ['-C', MAIN, 'worktree', 'remove', '--force', DEST]);
    if (rc !== 0) return rc;
  } else {
    out('• worktree already removed — cleaning up the branch only\n');
    inherit('git', ['-C', MAIN, 'worktree', 'prune']);
  }
  const rc = inherit('git', ['-C', MAIN, 'branch', '-d', BRANCH]);
  if (rc !== 0) return rc;

  out(`✅ '${BRANCH}' merged into '${BASE}', pushed, and cleaned up.\n`);
  if (unverified !== undefined) err(`⚠ phase ${unverified} merged but not marked complete — /gsd-verify-work ${unverified}\n`);
  return 0;
}
