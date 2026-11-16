// Regression tests for the .planning merge fix (the reconciler, the merge driver,
// gsdt-planning-repair, gsdt-wt-finish's repair, gsdt-doctor's planning checks).
// Port of tests/test-planning-reconcile.sh. Run: node --test tests/node/planning-reconcile.test.ts
//
// Fixtures are the two real corruptions from medyour-platform, checked in under
// tests/fixtures/:
//   phase-11-merge/  the raw `git merge` result that produced the damage (ROADMAP: phases 10 + 11
//                    listed twice with contradictory marks; STATE: two frontmatter blocks,
//                    duplicate focus / position / velocity lines). Ground truth for its counters:
//                    30 phases / 13 complete / 111 plans / 111 summaries / 43%.
//   2026-08-02/      the earlier corruption, which also carries a table row /gsd-fast appended past EOF.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { planningApply, planningHook, planningStatus } from '../../src/common.ts';
import {
  FIX, LAUNCH, PKG, WIN, count, env, fwd, git, gsdt, lines, plain, read, run, tmp, touch, write,
} from './g1-helpers.ts';
import type { Opts, Run } from './g1-helpers.ts';

// Doctor reports a missing gsd-core (T005). CI may have none, and these checks are about the repo
// under inspection, so give them a stand-in. It also reads the user's agent settings for broken
// GSD hooks (T008): point it at files that don't exist.
const STUBS = tmp('stub-bin');
const GSD_RUN = path.join(STUBS, 'gsd_run');
write(GSD_RUN, '#!/bin/sh\necho \'{"packageName":"@opengsd/gsd-core","version":"1.0.0"}\'\n');
chmodSync(GSD_RUN, 0o755); // an explicit path: the toolkit runs an extensionless file with sh on Windows (src/spawn.ts)
const NONE = path.join(tmp('none'), 'nothing');
const DENV = { GSD_CLI: GSD_RUN, GSD_CLAUDE_SETTINGS: NONE, GSD_CODEX_HOOKS: NONE };
/** A gsdt command with the stand-ins above. */
const g = (name: string, args: string[], o: Opts = {}): Run => gsdt(name, args, { ...o, env: { ...DENV, ...(o.env ?? {}) } });
const engine = (...args: string[]): Run => g('planning', args);

/** Run fn with process.env = the clean test env (the in-process functions read process.env). */
function withTestEnv<T>(fn: () => T): T {
  const saved = { ...process.env };
  const clean = env(DENV);
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, clean);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/** `awk '/start/,/end/'` — end omitted = to the end of the text. */
function range(text: string, start: RegExp, end?: RegExp): string[] {
  const out: string[] = [];
  let on = false;
  for (const l of lines(text)) {
    if (!on) {
      if (!start.test(l)) continue;
      on = true;
      out.push(l);
      if (end?.test(l)) on = false;
    } else {
      out.push(l);
      if (end?.test(l)) on = false;
    }
  }
  return out;
}
/** `sed -n '/^---$/,/^---$/p'` */
function frontmatter(text: string): string {
  const out: string[] = [];
  let on = false;
  for (const l of lines(text)) {
    if (!on) {
      if (l === '---') {
        on = true;
        out.push(l);
      }
    } else {
      out.push(l);
      if (l === '---') on = false;
    }
  }
  return out.join('\n');
}
/** Version-sort order (sort -V) of dotted phase numbers: every adjacent pair non-decreasing. */
function versionSorted(vs: string[]): boolean {
  const cmp = (a: string, b: string): number => {
    const x = a.split('.').map(Number);
    const y = b.split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] ?? -1) - (y[i] ?? -1);
      if (d !== 0) return d;
    }
    return 0;
  };
  return vs.every((v, i) => i === 0 || cmp(vs[i - 1] as string, v) <= 0);
}

/** A .planning tree from a fixture: the two markdown files plus empty PLAN/SUMMARY files, which is all compute_truth() counts. */
function stage(fixture: string, dest: string): void {
  const src = path.join(FIX, fixture);
  mkdirSync(path.join(dest, '.planning', 'phases'), { recursive: true });
  cpSync(path.join(src, 'ROADMAP.md'), path.join(dest, '.planning', 'ROADMAP.md'));
  cpSync(path.join(src, 'STATE.md'), path.join(dest, '.planning', 'STATE.md'));
  const rels = lines(read(path.join(src, 'plans.txt'))).filter((l) => l !== '');
  for (const rel of rels) touch(path.join(dest, '.planning', 'phases', rel));
}
const ROADMAP = (d: string): string => read(path.join(d, '.planning', 'ROADMAP.md'));
const STATE = (d: string): string => read(path.join(d, '.planning', 'STATE.md'));
const gitInit = (d: string, branch?: string): void => {
  mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', ...(branch ? ['-b', branch] : []));
  git(d, 'config', 'user.email', 't@example.com');
  git(d, 'config', 'user.name', 'test');
};
const chomp = (s: string): string => s.replace(/\n+$/, '');

// ── 1. the phase-11 merge: counters must be RECOMPUTED, not picked ───────────
test('phase-11 merge — counters recomputed from ground truth', () => {
  const a = tmp('a');
  stage('phase-11-merge', a);
  engine('repair', path.join(a, '.planning'));
  const FM = frontmatter(STATE(a));
  assert.equal(count(FM, /total_phases: 30/), 1, 'total_phases is 30');
  assert.equal(count(FM, /completed_phases: 13/), 1, 'completed_phases is 13');
  assert.equal(count(FM, /total_plans: 111/), 1, 'total_plans is 111');
  assert.equal(count(FM, /completed_plans: 111/), 1, 'completed_plans is 111');
  assert.equal(count(FM, /percent: 43/), 1, 'percent is 43');
  assert.equal(count(STATE(a), /^---$/), 2, 'exactly one frontmatter block');
  for (const key of ['status', 'stopped_at', 'last_updated', 'last_activity']) {
    assert.equal(count(FM, new RegExp(`^${key}:`)), 1, `one '${key}:' in frontmatter`);
  }

  // single-value lines take the incoming branch's value. Verified against the real merge parents:
  // develop said 'planning' / Phase 11, the phase-11 branch said 'ready_to_plan' / Phase 12, and the
  // hand repair kept the branch's. union writes ours-then-theirs, so last-occurrence == theirs.
  assert.equal(count(FM, /^status: ready_to_plan/), 1, "status is the branch's");
  assert.equal(count(STATE(a), /^\*\*Current focus:\*\* Phase 12/), 1, 'focus is Phase 12');
  assert.equal(count(range(STATE(a), /^## Current Position/, /^## [^C]/).join('\n'), /^Phase: 12/), 1, 'Current Position Phase 12');

  // checklist and tables keep first position, best content
  const R = ROADMAP(a);
  assert.equal(count(R, /^- \[.\] \*\*Phase 10:/), 1, 'one Phase 10 checklist entry');
  assert.equal(count(R, /^- \[.\] \*\*Phase 11:/), 1, 'one Phase 11 checklist entry');
  assert.equal(count(R, /^- \[x\] \*\*Phase 11:/), 1, 'Phase 11 survives as [x]');
  assert.equal(count(R, /^- \[x\] \*\*Phase 11:.*\(completed 2026-08-05\)$/), 1, "Phase 11 keeps '(completed 2026-08-05)'");
  // Trap 3: the stale '- [ ] Phase 11' sat ABOVE the correct '- [x] Phase 11', so keeping the later
  // line would have pushed phase 11 below phase 10's duplicate.
  const nums = lines(R).flatMap((l) => {
    const m = /^- \[.\] \*\*Phase ([0-9.]*)/.exec(l);
    return m ? [m[1] as string] : [];
  });
  assert.ok(versionSorted(nums), `phases stay in numeric order: ${nums.join(' ')}`);
  assert.equal(count(R, /^\| 11\. /), 1, 'one Phase 11 progress row');
  assert.equal(count(R, /^\| 11\..*\| 15\/15 \| Complete/), 1, 'Phase 11 row says Complete');
});

// ── 2. trap 1: history must survive ──────────────────────────────────────────
test('history is never damaged (trap 1)', () => {
  for (const fixture of ['phase-11-merge', '2026-08-02']) {
    const d = tmp(`h-${fixture}`);
    stage(fixture, d);
    const before = range(read(path.join(FIX, fixture, 'STATE.md')), /^## Session Continuity/).join('\n');
    engine('repair', path.join(d, '.planning'));
    const after = range(STATE(d), /^## Session Continuity/).join('\n');
    assert.equal(after, before, `${fixture}: ## Session Continuity is byte-identical`);
    assert.equal(count(after, /^Resume file:/), count(before, /^Resume file:/), `${fixture}: every 'Resume file:' entry kept`);
  }
});

// ── 3. idempotence + the check gate ──────────────────────────────────────────
test('idempotence and --check', () => {
  const d = tmp('i');
  stage('phase-11-merge', d);
  const P = path.join(d, '.planning');
  assert.equal(engine('repair', '--check', P).status, 1, '--check on a corrupt tree exits 1');
  engine('repair', P);
  const road = readFileSync(path.join(P, 'ROADMAP.md'));
  const state = readFileSync(path.join(P, 'STATE.md'));
  engine('repair', P);
  assert.ok(road.equals(readFileSync(path.join(P, 'ROADMAP.md'))) && state.equals(readFileSync(path.join(P, 'STATE.md'))), 'a second repair changes nothing');
  assert.equal(engine('repair', '--check', P).status, 0, '--check on a repaired tree exits 0');
});

// ── 4. the 2026-08-02 corruption, including the row past EOF ─────────────────
test('2026-08-02 corruption', () => {
  const b = tmp('b');
  stage('2026-08-02', b);
  const out = engine('repair', '--check', path.join(b, '.planning')).out;
  for (const n of [5, 6, 7, 8]) {
    assert.equal(count(out, new RegExp(`duplicate checklist entry for Phase ${n}$`)), 1, `Phase ${n} duplicate checklist entry found`);
  }
  assert.equal(count(out, /table row outside any table/), 1, 'the row /gsd-fast left past EOF is reported');
  engine('repair', path.join(b, '.planning'));
  assert.equal(count(STATE(b), /gitignore apps\/mobile\/design\/verification/), 1, 'the stray row is preserved, not silently re-homed');
  for (const n of [5, 6, 7, 8]) {
    assert.equal(count(ROADMAP(b), new RegExp(`^- \\[.\\] \\*\\*Phase ${n}:`)), 1, `one Phase ${n} checklist entry after repair`);
  }
});

// ── 5–7 share fixtures ───────────────────────────────────────────────────────
// roadmap($1/$2 = phase 1/2 checklist box + tail, $3/$4 = their progress cells)
function roadmap(dir: string, box1: string, tail1: string, box2: string, tail2: string, row1: string, row2: string): void {
  write(
    path.join(dir, '.planning', 'ROADMAP.md'),
    `# Roadmap

## Phases

- [${box1}] **Phase 1: Alpha** - first phase${tail1}
- [${box2}] **Phase 2: Beta** - second phase${tail2}

## Phase Details

### Phase 1: Alpha

Goal: alpha.

### Phase 2: Beta

Goal: beta.

## Progress

| Phase | Plans | Status | Completed |
|-------|-------|--------|-----------|
| 1. Alpha | ${row1} |
| 2. Beta | ${row2} |
`,
  );
}
function state(dir: string, status: string, focus: string, completed: string, ts: string): void {
  write(
    path.join(dir, '.planning', 'STATE.md'),
    `---
milestone: v1.0
status: ${status}
stopped_at: Phase ${focus} pending
last_updated: "${ts}"
progress:
  total_phases: 9
  completed_phases: ${completed}
  total_plans: 9
  completed_plans: 9
  percent: 11
---

# Project State

**Current focus:** Phase ${focus}

## Current Position

Phase: ${focus}
Status: ${status}

Progress: [░░░░░░░░░░] 0%

## Session Continuity

Last session: 2026-01-01T00:00:00.000Z
Stopped at: one
Resume file: a.md
Last session: 2026-01-02T00:00:00.000Z
Stopped at: two
Resume file: b.md
`,
  );
}
const NOT_STARTED = '0/TBD | Not started | - ';
const ATTRS = '.planning/ROADMAP.md merge=gsd-planning\n.planning/STATE.md merge=gsd-planning\n';

/** The driver, the way git runs it: through the launcher (the bin/ one where bash is native). */
const driverCmd = (): string =>
  WIN
    ? `"${fwd(process.execPath)}" "${fwd(LAUNCH)}" planning-merge %O %A %B %P`
    : `'${PKG}/bin/gsdt-planning-merge' %O %A %B %P`;

// ── 5. end-to-end: a real git merge through the driver ───────────────────────
// Reproduces the exact shape of the real corruption: two sessions each flip a DIFFERENT phase's
// line, and the lines are adjacent, so the two edits land in one overlapping hunk. That is what
// makes union keep all four lines. Section 6 continues on the same repository.
const E2E = tmp('e2e');
test('end-to-end: git merge through the gsd-planning driver', () => {
  gitInit(E2E);
  mkdirSync(path.join(E2E, '.planning', 'phases', '01-a'), { recursive: true });
  mkdirSync(path.join(E2E, '.planning', 'phases', '02-b'), { recursive: true });
  git(E2E, 'config', 'merge.gsd-planning.driver', driverCmd());
  touch(path.join(E2E, '.planning/phases/01-a/01-01-PLAN.md'));
  touch(path.join(E2E, '.planning/phases/01-a/01-01-SUMMARY.md'));
  touch(path.join(E2E, '.planning/phases/02-b/02-01-PLAN.md'));
  write(path.join(E2E, '.gitattributes'), ATTRS);

  roadmap(E2E, ' ', '', ' ', '', NOT_STARTED, NOT_STARTED);
  state(E2E, 'planning', '1', '0', '2026-01-01T00:00:00.000Z');
  git(E2E, 'add', '-A');
  git(E2E, 'commit', '-qm', 'base');
  const BASE = chomp(git(E2E, 'branch', '--show-current').stdout);

  // The phase-1 session finishes phase 1.
  git(E2E, 'checkout', '-qb', 'phase-1');
  roadmap(E2E, 'x', ' (completed 2026-03-01)', ' ', '', '1/1 | Complete | 2026-03-01 ', NOT_STARTED);
  state(E2E, 'ready_to_plan', '2', '1', '2026-03-01T00:00:00.000Z');
  git(E2E, 'commit', '-qam', 'phase 1 done');

  // In parallel, another session finishes phase 2 on the base branch.
  git(E2E, 'checkout', '-q', BASE);
  roadmap(E2E, ' ', '', 'x', ' (completed 2026-03-02)', NOT_STARTED, '2/2 | Complete | 2026-03-02 ');
  state(E2E, 'executing', '2', '1', '2026-03-02T00:00:00.000Z');
  git(E2E, 'commit', '-qam', 'phase 2 done in a parallel session');
  git(E2E, 'tag', 'diverged');

  const m = git(E2E, 'merge', '-q', '--no-ff', 'phase-1', '-m', 'Merge phase-1');
  assert.equal(m.status, 0, `the merge completes without conflicts: ${m.out}`);

  const R = ROADMAP(E2E);
  const S = STATE(E2E);
  assert.equal(count(R, /^- \[.\] \*\*Phase 1:/), 1, 'driver left one Phase 1 checklist entry');
  assert.equal(count(R, /^- \[.\] \*\*Phase 2:/), 1, 'driver left one Phase 2 checklist entry');
  assert.equal(count(R, /^- \[x\] \*\*Phase/), 2, 'both phases survive as [x]');
  assert.equal(count(R, /\(completed 2026-03-0[12]\)$/), 2, "each side's completion date survives");
  assert.equal(count(R, /^\| 1\. Alpha/), 1, 'driver left one Phase 1 progress row');
  assert.equal(count(R, /^\| 2\. Beta/), 1, 'driver left one Phase 2 progress row');
  assert.equal(count(R, /^### Phase 1:/), 1, "driver left one '### Phase 1' section");
  assert.equal(count(S, /^---$/), 2, 'driver left one frontmatter block');
  assert.equal(count(S, /^status:/), 1, "driver left one 'status:'");
  assert.equal(count(S, /^stopped_at:/), 1, "driver left one 'stopped_at:'");
  assert.equal(count(S, /^\*\*Current focus:\*\*/), 1, "driver left one '**Current focus:**'");
  assert.equal(count(range(S, /^## Current Position/, /^## S/).join('\n'), /^Phase:/), 1, "driver left one 'Phase:' in position");
  assert.equal(count(S, /^Resume file:/), 2, 'driver kept both history entries');

  engine('repair', path.join(E2E, '.planning'));
  const S2 = STATE(E2E);
  assert.equal(count(S2, /  total_phases: 2/), 1, 'repair recomputes total_phases from the roadmap');
  assert.equal(count(S2, /  completed_phases: 2/), 1, 'repair recomputes completed_phases');
  assert.equal(count(S2, /  total_plans: 2/), 1, 'repair recomputes total_plans from disk');
  assert.equal(count(S2, /  completed_plans: 1/), 1, 'repair recomputes completed_plans from disk');
  assert.equal(count(S2, /  percent: 100/), 1, 'repair recomputes percent');
  assert.equal(engine('repair', '--check', path.join(E2E, '.planning')).status, 0, 'the merged tree passes --check');
});

// ── 6. the same merge WITHOUT the driver — repair still fixes it ─────────────
// The driver lives in git config, which is not versioned, so a clone that never ran
// gsdt-bootstrap-repo still gets plain union. gsdt-finish's post-merge repair has to be able to
// clean that up on its own.
test('no driver registered — plain union, repaired afterwards', () => {
  git(E2E, 'config', 'merge.gsd-planning.driver', 'git merge-file -q --union %A %O %B');
  git(E2E, 'reset', '-q', '--hard', 'diverged');
  git(E2E, 'merge', '-q', '--no-ff', 'phase-1', '-m', 'Merge phase-1 (plain union)');
  assert.equal(count(ROADMAP(E2E), /^- \[.\] \*\*Phase 1:/), 2, 'plain union DOES duplicate the checklist entry');
  assert.equal(count(STATE(E2E), /^status:/), 2, 'plain union DOES duplicate the frontmatter');
  engine('repair', path.join(E2E, '.planning'));
  const R = ROADMAP(E2E);
  const S = STATE(E2E);
  assert.equal(count(R, /^- \[.\] \*\*Phase 1:/), 1, 'repair alone fixes the checklist');
  assert.equal(count(R, /^- \[x\] \*\*Phase/), 2, 'repair alone keeps both [x] marks');
  assert.equal(count(S, /^status:/), 1, 'repair alone collapses frontmatter');
  assert.equal(count(S, /^Resume file:/), 2, 'repair alone keeps history intact');
  assert.equal(engine('repair', '--check', path.join(E2E, '.planning')).status, 0, 'the repaired tree passes --check');
});

// ── 7. the real gsdt-finish path ──────────────────────────────────────────────
// The guarantee the whole change exists for: a normal finish must never leave .planning
// self-contradictory on the base branch.
test('gsdt-finish leaves the base branch coherent', () => {
  const WT = tmp('wt');
  const repo = path.join(WT, 'repo');
  const wt = path.join(WT, 'wt', 'phase-1-alpha');
  mkdirSync(path.join(repo, '.planning', 'phases', '01-a'), { recursive: true });
  gitInit(repo, 'develop');
  touch(path.join(repo, '.planning/phases/01-a/01-01-PLAN.md'));
  write(path.join(repo, '.gsd.conf'), 'base = develop\nwtdir = wt\ninstall = none\n');
  write(path.join(repo, '.gitattributes'), ATTRS);
  roadmap(repo, ' ', '', ' ', '', NOT_STARTED, NOT_STARTED);
  state(repo, 'planning', '1', '0', '2026-01-01T00:00:00.000Z');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');

  git(repo, 'worktree', 'add', '-q', '-b', 'phase-1-alpha', wt, 'develop');
  touch(path.join(wt, '.planning/phases/01-a/01-01-SUMMARY.md'));
  roadmap(wt, 'x', ' (completed 2026-03-01)', ' ', '', '1/1 | Complete | 2026-03-01 ', NOT_STARTED);
  state(wt, 'ready_to_plan', '2', '1', '2026-03-01T00:00:00.000Z');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'phase 1 done');

  roadmap(repo, ' ', '', 'x', ' (completed 2026-03-02)', NOT_STARTED, '2/2 | Complete | 2026-03-02 ');
  state(repo, 'executing', '2', '1', '2026-03-02T00:00:00.000Z');
  git(repo, 'commit', '-qam', 'parallel session finished phase 2');

  const fin = g('wt-finish', ['1'], { cwd: wt });
  assert.equal(fin.status, 0, `gsdt-wt-finish succeeds: ${fin.out}`);
  assert.equal(count(fin.out, /reconciling .planning after the phase merge/), 1, 'it reports reconciling .planning');

  const R = ROADMAP(repo);
  const S = STATE(repo);
  assert.equal(count(R, /^- \[.\] \*\*Phase 1:/), 1, 'develop has one Phase 1 checklist entry');
  assert.equal(count(R, /^- \[x\] \*\*Phase/), 2, 'develop has both phases complete');
  assert.equal(count(S, /^status:/), 1, "develop has one 'status:'");
  assert.equal(count(S, /  completed_phases: 2/), 1, "develop's counters were recomputed");
  assert.equal(count(S, /^Resume file:/), 2, "develop's history is intact");
  assert.equal(g('planning-repair', ['--check'], { cwd: repo }).status, 0, 'develop passes --check after the finish');
  assert.equal(lines(git(repo, 'status', '--porcelain', '--', '.planning').stdout).length, 0, 'the repair left no uncommitted changes');
});

// ── 8. content the reconciler must never touch ───────────────────────────────
// Three defects found reviewing the committed fix. All three are the same class of failure the tool
// exists to prevent: silently deleting real content.
test('no collateral deletion', () => {
  // A: ROADMAP.md puts every '### Phase N:' detail AFTER '## Progress'. When the Progress section was
  // bounded only at '##' it ran to EOF, so the progress-row dedupe reached into the phase details and
  // deleted a numbered table row in one phase because another phase's detail used the same number.
  const COLL = tmp('collateral');
  const table = (row: string): string => `\n| Step | What |\n|------|------|\n| ${row} | who |\n`;
  let doc = read(path.join(FIX, 'phase-11-merge', 'ROADMAP.md'));
  doc = doc.replaceAll('### Phase 20: Verify and dispense\n', () => `### Phase 20: Verify and dispense\n${table('1. Scan the QR code')}`);
  doc = doc.replaceAll('### Phase 21: Branch self-service and admin queue\n', () => `### Phase 21: Branch self-service and admin queue\n${table('1. Open the queue')}`);
  write(path.join(COLL, '.planning', 'ROADMAP.md'), doc);
  cpSync(path.join(FIX, 'phase-11-merge', 'STATE.md'), path.join(COLL, '.planning', 'STATE.md'));
  mkdirSync(path.join(COLL, '.planning', 'phases'), { recursive: true });
  engine('repair', path.join(COLL, '.planning'));
  assert.equal(count(ROADMAP(COLL), /^\| 1\. Scan the QR code/), 1, "a phase detail's numbered row survives");
  assert.equal(count(ROADMAP(COLL), /^\| 1\. Open the queue/), 1, 'the same number in another phase survives too');
  assert.equal(count(ROADMAP(COLL), /^\| 11\. Catalogs/), 1, 'the real progress table is still deduped');

  // B: the frontmatter emitter used to rebuild from parsed keys, so any line it had no model for —
  // YAML lists, comments — was dropped on the floor.
  const FMD = tmp('frontmatter');
  touch(path.join(FMD, '.planning/phases/01-a/01-01-PLAN.md'));
  write(path.join(FMD, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Phases\n\n- [x] **Phase 1: A** - a\n');
  write(
    path.join(FMD, '.planning', 'STATE.md'),
    `---
milestone: v1.0
status: planning
tags:
  - alpha
  - beta
# a comment the parser has no model for
progress:
  total_phases: 9
  completed_phases: 9
status: executing
---

# Project State

## Current Position

Phase: 1
`,
  );
  engine('repair', path.join(FMD, '.planning'));
  const S = STATE(FMD);
  assert.equal(count(S, /^  - alpha/), 1, 'a YAML list item survives');
  assert.equal(count(S, /^  - beta/), 1, 'every list item survives');
  assert.equal(count(S, /^# a comment/), 1, 'a comment survives');
  assert.equal(count(S, /^tags:/), 1, "the list's parent key survives");
  assert.equal(count(S, /^status:/), 1, 'the duplicate key still collapses');
  assert.equal(count(S, /^status: executing/), 1, 'and takes the incoming value');
  assert.equal(count(S, /  total_phases: 1/), 1, 'counters still recomputed');

  // C: --commit ran `git add` on both planning files unconditionally, which is fatal when one is
  // absent. Called from gsdt-finish that aborted the repair with the merge already committed.
  const NOSTATE = tmp('nostate');
  mkdirSync(path.join(NOSTATE, '.planning', 'phases'), { recursive: true });
  gitInit(NOSTATE);
  write(path.join(NOSTATE, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Phases\n\n- [x] **Phase 1: A** - a\n');
  git(NOSTATE, 'add', '-A');
  git(NOSTATE, 'commit', '-qm', 'init');
  write(
    path.join(NOSTATE, '.planning', 'ROADMAP.md'),
    '# Roadmap\n\n## Phases\n\n- [ ] **Phase 1: A** - a\n- [x] **Phase 1: A** - a (completed 2026-01-01)\n',
  );
  assert.equal(g('planning-repair', ['--repo', NOSTATE, '--commit']).status, 0, '--commit succeeds with no STATE.md');
  assert.equal(lines(git(NOSTATE, 'status', '--porcelain', '--', '.planning').stdout).length, 0, 'the repair was committed');
  assert.equal(count(ROADMAP(NOSTATE), /^- \[.\] \*\*Phase 1:/), 1, 'the duplicate was collapsed');
  writeFileSync(path.join(NOSTATE, '.planning', 'ROADMAP.md'), `${ROADMAP(NOSTATE)}- [ ] **Phase 2: B** - b\n- [ ] **Phase 2: B** - b\n`);
  write(path.join(NOSTATE, 'src.txt'), 'mine\n');
  git(NOSTATE, 'add', 'src.txt');
  g('planning-repair', ['--repo', NOSTATE, '--commit']);
  assert.equal(`${lines(git(NOSTATE, 'show', '--name-only', '--format=', 'HEAD').stdout).join(' ')} `, '.planning/ROADMAP.md ', '--commit leaves out a file the user staged');
  assert.equal(chomp(git(NOSTATE, 'diff', '--cached', '--name-only').stdout), 'src.txt', '…which stays staged');
});

// ── 9. gsdt-doctor ────────────────────────────────────────────────────────────
// It diagnoses and never fixes. The read-only guarantee is the whole reason it is safe to run on a
// repo you are mid-feature in, so it is asserted, not assumed. (Toolkit-level findings are ignored
// here: they reflect the state of the checkout the tests run from, not the repo under inspection.)
const DOC = tmp('doctor');
const walk = (d: string, rel = ''): string[] =>
  readdirSync(path.join(d, rel), { withFileTypes: true }).flatMap((e) => {
    if (e.name === '.git' && rel === '') return [];
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    return e.isDirectory() ? walk(d, r) : [r];
  });
const digest = (d: string): string =>
  walk(d)
    .sort()
    .map((f) => `${f} ${createHash('sha256').update(readFileSync(path.join(d, f))).digest('hex')}`)
    .join('\n');
const cfgList = (d: string): string => lines(git(d, 'config', '--local', '--list').stdout).sort().join('\n');

test('gsdt-doctor', () => {
  mkdirSync(path.join(DOC, '.planning', 'phases', '01-a'), { recursive: true });
  mkdirSync(path.join(DOC, 'scripts'), { recursive: true });
  gitInit(DOC, 'develop');
  write(path.join(DOC, '.gitattributes'), '.planning/ROADMAP.md merge=union\n.planning/STATE.md merge=union\n');
  cpSync(path.join(FIX, 'phase-11-merge', 'ROADMAP.md'), path.join(DOC, '.planning', 'ROADMAP.md'));
  cpSync(path.join(FIX, 'phase-11-merge', 'STATE.md'), path.join(DOC, '.planning', 'STATE.md'));
  git(DOC, 'add', '-A');
  git(DOC, 'commit', '-qm', 'init');

  let out = g('doctor', ['--repo', DOC]).out;
  assert.equal(count(out, /still on merge=union/), 1, 'reports merge=union');
  assert.equal(count(out, /merge driver not registered/), 1, 'reports the missing driver');
  assert.equal(count(out, /no post-merge hook/), 1, 'reports the missing hook');
  assert.equal(count(out, /shims: .* missing/), 1, 'reports missing shims');
  assert.equal(count(out, /contradicts itself/), 1, 'reports the planning damage');
  assert.ok(count(out, /gsdt-init/) >= 4, 'names gsdt-init as the fix');
  assert.ok(count(out, /gsdt-planning-repair/) >= 1, 'names the repair as the fix');

  // THE guarantee: a diagnosis must not change the thing it diagnoses.
  const beforeTree = git(DOC, 'status', '--porcelain').stdout;
  const beforeCfg = cfgList(DOC);
  const beforeFiles = digest(DOC);
  g('doctor', ['--repo', DOC]);
  assert.equal(git(DOC, 'status', '--porcelain').stdout, beforeTree, 'working tree untouched');
  assert.equal(cfgList(DOC), beforeCfg, 'git config untouched');
  assert.equal(digest(DOC), beforeFiles, 'no file contents changed');
  // --fix is opt-in AND asks: with no terminal and no --yes it changes nothing.
  g('doctor', ['--fix', '--repo', DOC], { input: '' });
  assert.equal(git(DOC, 'status', '--porcelain').stdout, beforeTree, '--fix unanswered: working tree untouched');
  assert.equal(cfgList(DOC), beforeCfg, '--fix unanswered: git config untouched');

  // --fix --yes runs the scoped writers (gsdt-init, gsdt-planning-repair) itself; the repo-setup and
  // planning findings clear, and nothing is committed.
  const headBefore = chomp(git(DOC, 'rev-parse', 'HEAD').stdout);
  out = g('doctor', ['--fix', '--yes', '--repo', DOC]).out;
  assert.equal(count(out, /^▶ gsdt-init|^▶ gsdt-planning-repair/), 2, '--fix ran gsdt-init and the repair');
  assert.equal(chomp(git(DOC, 'rev-parse', 'HEAD').stdout), headBefore, '--fix committed nothing');
  out = g('doctor', ['--repo', DOC]).out;
  assert.equal(count(out, /still on merge=union/), 0, 'merge=union finding clears');
  assert.equal(count(out, /merge driver not registered/), 0, 'driver finding clears');
  assert.equal(count(out, /no post-merge hook/), 0, 'hook finding clears');
  assert.equal(count(out, /\.planning is coherent/), 1, 'planning reports coherent');
});

// ── 10. one predicate for "installed" ────────────────────────────────────────
// gsdt-bootstrap-repo writes the merge safety and gsdt-doctor reports on it. When those were two
// implementations they could disagree — doctor calling a repo clean that bootstrap would still
// change. Both now go through planningStatus (gsd_planning_status), asserted directly.
test('gsd_planning_status is the single source of truth', () => {
  const PRED = tmp('predicate');
  gitInit(PRED, 'main');
  write(path.join(PRED, '.gitattributes'), '.planning/ROADMAP.md merge=union\n.planning/STATE.md merge=union\n');

  let st = withTestEnv(() => planningStatus(PRED));
  assert.deepEqual([...st.missing].sort(), ['attributes', 'driver', 'hook'], 'a legacy repo reports all three missing');
  assert.equal(st.attrsState, 'union', 'and flags the attributes as merge=union');

  withTestEnv(() => planningApply(PRED));
  st = withTestEnv(() => planningStatus(PRED));
  assert.deepEqual(st.missing, [], 'after apply, nothing is missing');
  assert.equal(st.attrsState, 'ok', 'attributes now read as ok');

  // Applying twice must be a no-op, or the hook body would be appended repeatedly.
  withTestEnv(() => planningApply(PRED));
  assert.equal(count(read(path.join(PRED, '.git', 'hooks', 'post-merge')), /gsdt-planning-repair \|\| true/), 1, 'apply is idempotent (hook not duplicated)');
  assert.equal(count(read(path.join(PRED, '.gitattributes')), /merge=gsd-planning/), 2, 'apply is idempotent (attributes not duplicated)');
});

// ── 11. gsdt-doctor knows what it is looking at ───────────────────────────────
// It used to run the setup checks on anything, so a repo with no interest in GSD — including the
// toolkit itself, which is the SOURCE of the scripts and is deliberately not a GSD project — got four
// red lines telling it to run gsdt-init.
test('gsdt-doctor does not demand GSD from repos that do not use it', () => {
  const PLAIN = tmp('plain');
  gitInit(PLAIN, 'main');
  write(path.join(PLAIN, 'f'), 'hi\n');
  git(PLAIN, 'add', '-A');
  git(PLAIN, 'commit', '-qm', 'init');

  let r = g('doctor', ['--repo', PLAIN]);
  assert.equal(r.status, 0, 'a plain repo has no findings');
  assert.equal(count(r.out, /does not use GSD/), 1, 'it says the repo does not use GSD');
  assert.equal(count(r.out, /gitattributes/), 0, 'no red line about .gitattributes');
  assert.equal(count(r.out, /merge driver not registered/), 0, 'no red line about the driver');
  assert.equal(count(r.out, /no post-merge hook/), 0, 'no red line about the hook');
  assert.equal(count(r.out, /shims:/), 0, 'no red line about shims');

  r = g('doctor', ['--repo', PKG]);
  assert.equal(count(r.out, /toolkit itself, not a GSD project/), 1, 'the toolkit is recognised as itself');
  assert.equal(count(r.out, /merge driver not registered/), 0, 'and its setup checks are skipped');

  // Exercise linked toolkit execution even when CI runs from a normal checkout. All copied commands,
  // Git config, and worktree metadata stay in the fixture.
  const base = tmp('toolkit');
  const FIXTURE = path.join(base, 'toolkit fixture');
  const LINKED = path.join(base, 'toolkit linked');
  mkdirSync(FIXTURE, { recursive: true });
  for (const e of ['bin', 'lib', 'src', 'shims', 'install.sh']) cpSync(path.join(PKG, e), path.join(FIXTURE, e), { recursive: true });
  git(FIXTURE, 'init', '-q', '-b', 'main');
  git(FIXTURE, 'add', '.');
  git(FIXTURE, 'commit', '-qm', 'toolkit');
  git(FIXTURE, 'worktree', 'add', '-q', '-b', 'test-linked', LINKED);
  const linkedDoctor = (target: string): Run =>
    run(process.execPath, [path.join(LINKED, 'src', 'launch.mjs'), 'doctor', '--repo', target], {
      env: { ...DENV, PATH: [path.join(LINKED, 'bin'), process.env.PATH ?? ''].join(path.delimiter) },
    });
  for (const target of [FIXTURE, LINKED]) {
    const lr = linkedDoctor(target);
    assert.equal(count(lr.out, /toolkit itself, not a GSD project/), 1, `linked toolkit recognises ${path.basename(target)}: ${lr.out}`);
    assert.equal(lr.status, 0, 'linked toolkit setup checks produce no findings');
  }
  assert.equal(count(linkedDoctor(DOC).out, /merge=gsd-planning on ROADMAP/), 1, 'linked toolkit still checks an unrelated GSD repo');

  // Toolkit housekeeping is a note, not a finding: it is about the toolkit checkout, not the repo
  // you asked about.
  assert.equal(count(g('doctor', ['--repo', PLAIN]).out, /✖.*toolkit has/), 0, "a dirty toolkit does not fail another repo's check");

  // A real GSD repo must still get the full treatment.
  assert.equal(count(g('doctor', ['--repo', DOC]).out, /merge=gsd-planning on ROADMAP/), 1, 'a real GSD repo is still checked in full');
});

test('gsdt-doctor tells you what to run', () => {
  // Every finding used to carry its own 'cd <absolute path> && <cmd>', repeated verbatim on each
  // line, which pushed the actual command off the right edge and read as noise. The commands are now
  // collected once, at the end, in order. A repo with findings — the earlier fixtures have all been
  // fitted by now.
  const SUMM = path.join(tmp('sum'), 'summary');
  mkdirSync(path.join(SUMM, '.planning'), { recursive: true });
  gitInit(SUMM, 'main');
  write(path.join(SUMM, '.gitattributes'), '.planning/ROADMAP.md merge=union\n.planning/STATE.md merge=union\n');
  write(path.join(SUMM, '.planning', 'ROADMAP.md'), '# Roadmap\n');
  git(SUMM, 'add', '-A');
  git(SUMM, 'commit', '-qm', 'init');

  // colour codes sit between words and break plain matches
  const out = plain(g('doctor', ['--repo', SUMM]).out);
  assert.equal(count(out, /finding\(s\)\./), 1, 'the summary says what to run');
  assert.equal(count(out, /→ cd /), 0, "no repeated 'cd … &&' on findings");
  assert.equal(count(out, /^ {2}cd .*[\\/]summary$/), 1, 'the cd is given once');
  assert.equal(count(out, /^ {2}gsdt-init$/), 1, 'gsdt-init listed once, not 3×');
  assert.equal(count(out, /re-run gsdt-doctor to confirm/), 1, 'and it says how to confirm');
});

test('post-merge hook: versioned when it lands in the working tree', () => {
  // A repo may point core.hooksPath at a TRACKED directory (scripts/git-hooks is a common
  // convention). The hook there belongs in the commit like any other file. Assuming .git/hooks left
  // it untracked in exactly such a repo — it protected the clone that ran the bootstrap and nobody
  // else.
  const HK = tmp('hookrepo');
  mkdirSync(path.join(HK, 'scripts', 'git-hooks'), { recursive: true });
  gitInit(HK, 'develop');
  git(HK, 'config', 'core.hooksPath', fwd(path.join(HK, 'scripts', 'git-hooks')));
  write(path.join(HK, 'f.txt'), 'x\n');
  git(HK, 'add', '-A');
  git(HK, 'commit', '-qm', 'init');
  let h = withTestEnv(() => planningHook(HK));
  assert.equal(h.versioned, true, 'custom hooks path is treated as versioned');
  assert.equal(h.label, 'scripts/git-hooks/post-merge', 'and its label is repo-relative');

  // The default .git/hooks case must still be reported as per-clone.
  const PLAIN = tmp('plainrepo');
  gitInit(PLAIN, 'develop');
  write(path.join(PLAIN, 'f.txt'), 'x\n');
  git(PLAIN, 'add', '-A');
  git(PLAIN, 'commit', '-qm', 'init');
  h = withTestEnv(() => planningHook(PLAIN));
  assert.equal(h.versioned, false, 'default .git/hooks stays unversioned');

  // End to end: the bootstrap must COMMIT the hook in the custom-path repo.
  g('bootstrap-repo', ['--commit'], { cwd: HK });
  assert.equal(lines(git(HK, 'ls-files', 'scripts/git-hooks/post-merge').stdout).length, 1, 'the hook is tracked after bootstrap');
  assert.equal(count(git(HK, 'status', '--porcelain').stdout, /^\?\?/), 0, 'and nothing is left untracked');
});

// Not every system names it python3 — minimal images use `python`. The name alone is not enough to
// trust: `python` is still Python 2 in places, and Python 2 cannot run the reconciler at all.
// gsd_python is the bash probe in lib/common.sh (used by lib/install-copy.sh), so this stays bash.
const REALPY = WIN ? null : run('sh', ['-c', 'command -v python3']).stdout.trim() || null;
const PYSKIP = WIN
  ? 'gsd_python is the POSIX-shell interpreter probe of lib/common.sh; its fake-PATH cases need /bin/bash and POSIX stubs'
  : REALPY === null
    ? 'no python3 on PATH'
    : false;
test('python interpreter fallback', { skip: PYSKIP }, () => {
  const common = path.join(PKG, 'lib', 'common.sh');
  const bash = (script: string, pathVar?: string): Run =>
    run('/bin/bash', ['-c', script], { env: { GSD_PYTHON: undefined, ...(pathVar !== undefined ? { PATH: pathVar } : {}) } });

  const resolved = chomp(bash(`. '${common}'; gsd_python || true`).stdout);
  assert.ok(resolved !== '', 'resolves an interpreter here');
  assert.equal(chomp(run(resolved, ['-c', 'import sys; print(sys.version_info[0])']).stdout), '3', 'and it really is python 3');

  // A PATH holding ONLY a fake `python` — no python3 to fall back on, which is what a minimal image
  // looks like. PATH must exclude /usr/bin or the real python3 is found first and the fallback is
  // never exercised.
  const FAKEBIN = tmp('fakebin');
  const stub = path.join(FAKEBIN, 'python');
  // Case 1: `python` is Python 2 — must be REJECTED, not handed back to break mid-merge. The probe asks
  // the interpreter, so a stub that fails it is enough.
  write(
    stub,
    '#!/bin/bash\ncase "$*" in\n  *version_info*) exit 1 ;;              # fails the >= 3.7 probe, as py2 does\n  --version) echo "Python 2.7.18"; exit 0 ;;\nesac\nexit 1\n',
  );
  chmodSync(stub, 0o755);
  let out = bash(`. '${common}'; gsd_python && echo PICKED || echo REJECTED`, FAKEBIN).out;
  assert.equal(count(out, /REJECTED/), 1, "rejects a python 2 named 'python'");

  // Case 2: `python` IS Python 3 — must be ACCEPTED. That is the whole point.
  write(stub, `#!/bin/bash\nexec ${REALPY} "$@"\n`);
  chmodSync(stub, 0o755);
  out = bash(`. '${common}'; gsd_python`, FAKEBIN).out;
  assert.equal(chomp(out), 'python', "accepts a python 3 named 'python'");

  // And the reconciler genuinely runs under that name, not just the name check.
  out = bash(`"$(. '${common}'; gsd_python)" '${path.join(PKG, 'lib', 'gsd_planning.py')}' --help`, FAKEBIN).out;
  assert.equal(count(lines(out).slice(0, 1).join('\n'), /usage/), 1, "the engine runs under 'python'");
});

test("GSD's own STATE.md form is not drift", () => {
  const G = path.join(tmp('gsdform'), '.planning');
  mkdirSync(path.join(G, 'phases'), { recursive: true });
  write(path.join(G, 'ROADMAP.md'), '# Roadmap\n\n- [ ] **Phase 1: A**\n- [ ] **Phase 2: B**\n\n### Phase 1: A\n\n### Phase 2: B\n');
  const gstate = (l: string): string => write(path.join(G, 'STATE.md'), `# Project State\n\n## Current Position\n\nPhase: 1 of 2 (A)\n${l}\n`);
  const progress = (): string => lines(read(path.join(G, 'STATE.md'))).find((l) => l.startsWith('Progress:')) ?? '';

  gstate('Progress: [░░░░░░░░░░] 0%');
  let out = chomp(engine('repair', '--check', G).stdout);
  assert.equal(out, '✔ .planning/ is consistent', "a new project's STATE.md (no frontmatter, bar without a count) → consistent");
  gstate('Progress: [█████░░░░░] 50%');
  out = chomp(engine('repair', '--check', G).stdout);
  assert.equal(count(out, /progress bar recomputed to 0%/), 1, '…a stale percent is still caught');
  assert.equal(count(out, /^• a repair would update: STATE.md/), 1, '…and offered as an update');
  engine('repair', G);
  assert.equal(progress(), 'Progress: [░░░░░░░░░░] 0%', "…the repair keeps GSD's form (no count added)");
  gstate('Progress: [█████░░░░░] 50% (1 of 2 phases complete)');
  engine('repair', G);
  assert.equal(progress(), 'Progress: [░░░░░░░░░░] 0% (0 of 2 phases complete)', 'a line with a count keeps it, recomputed');
  write(path.join(G, 'STATE.md'), '# Project State\n\ntext\n| stray | row |\ntext\n');
  out = chomp(engine('repair', '--check', G).stdout);
  assert.equal(count(out, /table row outside any table/), 1, 'a hand-edit advisory is still reported');
  assert.equal(count(out, /a repair would update/), 0, '…but offers no repair');
});
