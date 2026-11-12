// gsdt-start — start a GSD feature in ONE step: claim the phase, sync the claim,
// create the worktree, and open the session there (--no-launch prints it instead).
// Port of the bash bin/gsdt-start (kept as the parity oracle in
// tests/fixtures/p6-old-bins/).
//
// Still outside this file: the update notice (lib/version.sh, P11),
// `gsd_run query phase.add|insert` (gsd-core), gsdt-wt-new (a child, like the bash:
// its output is captured and printed once it is done), gsdt-planning-repair,
// gsdt-flow-next and gsdt-tracker (children). The ROADMAP rows and STATE.md note
// are edited in-process (no perl).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { isatty } from 'node:tty';
import path from 'node:path';
import { ticketExtract, ticketNorm, ticketTagged, trackerWhich } from '../ticket.ts';
import {
  acquireLock,
  base,
  chomp,
  cli,
  cliMissing,
  commandOnPath,
  findMain,
  git,
  GsdExit,
  gsdPkg,
  isDir,
  isFile,
  migrateRefuse,
  originLacks,
  phaseBranch,
  python,
  releaseLock,
  workflowFlag,
} from '../common.ts';
import { guardArgv } from '../guard.ts';
import {
  compactResolve,
  compactSettings,
  modelResolve,
  providerArgv,
  providerGone,
  providerKnown,
  providerPrompt,
  providerRender,
  providerResolve,
  staleHooksNotice,
  startModeResolve,
} from '../provider.ts';
import { roadmapRows } from '../roadmap.ts';
import { err, inherit, out, signalNumber } from '../stdio.ts';
import { updateNotice } from '../update-check.ts';
import { grepq, phaseHeadingRe, worktreeOf } from './wt-new.ts';

const HELP = `gsdt-start — start a GSD feature in ONE step

Claims the next phase, publishes the claim, creates the phase worktree, and
opens a provider-valid phase-flow session there (--no-launch prints it).
Replaces the manual sequence:
  /gsd-phase "<desc>" → git push → scripts/gsdt-new-worktree-feature.sh
  → cd <worktree> → <agent> "/gsd-discuss-phase N"

Provider identity and executable are configured separately. Print-only is the
default and works even when the selected CLI is unavailable.

USAGE
  gsdt-start -n "<phase description>" [options]  claim a NEW phase
  gsdt-start --insert <N> "<desc>" [options]     claim a FRACTIONAL phase after N
  gsdt-start -p <N> [options]                    attach to an EXISTING phase

Claiming a new phase is never the default: -n (or --insert) says so explicitly,
so a bare description can't silently open a second phase for work the roadmap
already tracks.

OPTIONS
  -n, --new       claim a NEW phase for the given description. Required for
                  the claim path — without it (and without -p/--insert) a bare
                  description is refused, listing the three choices.
  -p, --phase <N> attach to already-claimed phase N: skip the claim/push,
                  create (or reuse) its worktree, open the session there.
                  Use after a failed run, or when the phase was claimed
                  separately (/gsd-phase) — avoids duplicate ROADMAP entries.
                  The description is taken from ROADMAP.md and may be omitted.
  --insert <N>    claim a decimal phase inserted after phase N instead of the
  --after <N>     next integer: 11 → 11.1, a second insert → 11.2, and so on
                  (delegates to gsd-core's phase.insert). Needs a description;
                  cannot be combined with -p. (alias: --after)
  --ticket <id>   the ticket driving this phase: an issue/task in your
                  tracker (accepts 869e33cv4, PROJ-42, tk-<id>, or its URL).
                  The phase title and slug get the tag tk-<id> at the end.
                  With \`tracker = clickup|custom\` in .gsd.conf the ticket is
                  moved to "in progress" with a comment (best-effort, via
                  gsdt-tracker); with the default \`tracker = none\` it is only
                  tagged. A tag already in the description (… tk-<id>) is
                  picked up the same way. --cu <id> is the old name.
                  With a tracker set, a new claim (-n, --insert) needs one.
  --no-ticket     claim without a ticket although a tracker is set
                  (a chore no ticket covers)
  --slug <slug>   worktree/branch slug → phase-<N>-<slug>
                  (default: slugified phase description)
  --repo <path>   main checkout of the target repo
                  (default: derived from the current directory)
  --provider <p>  claude, codex, or custom (config default otherwise)
  --model <id>    session model override; 'default' uses the CLI's own default
  --agent-command <path> executable override (add --no-launch to print)
  --agent <value> compatibility alias: known provider or custom executable
  --flow          start/resume the complete gsdt-flow workflow (the default).
                  The flow reads existing phase artifacts and continues at
                  the next step. Overrides start_mode = discuss.
  --no-flow       start with discuss-phase only, for this run (for every run:
                  start_mode = discuss in .gsd.conf).
  --launch        open the session with the configured provider. The default:
                  in a terminal the session opens in the worktree. With no
                  terminal (a script, an agent's shell) the command is printed.
  --no-launch     print the 'cd … && <agent> …' command instead of opening it
  --no-push       skip pull/push (no-remote or offline workflows)
  -h, --help      show this help

EXAMPLES
  gsdt-start -n "customer terms rework"
      Claim the phase, push, create ../<repo>-worktrees/phase-<N>-customer-
      terms-rework, and print the configured provider command.

  gsdt-start --insert 11 "hotfix reset-email copy"
      Claim phase 11.1 (the next free decimal after phase 11), push, create
      ../<repo>-worktrees/phase-11.1-hotfix-reset-email-copy.

  gsdt-start --after 11 "second hotfix"
      Run after the previous example: phase 11.1 already exists, so this
      claims phase 11.2 (the decimal auto-increments). --after == --insert.

  gsdt-start --insert 11 "urgent db backfill" --slug db-backfill
      Insert phase 11.x after phase 11 but force the branch/worktree slug →
      phase-11.x-db-backfill (default would be slugified from the description).

  gsdt-start -p 11.1
      Re-attach to the already-inserted phase 11.1 (e.g. after a failed run):
      no new claim, reuse/re-create its phase-11.1-* worktree. Idempotent.

  gsdt-start -p 7
      Phase 7 is already in ROADMAP.md: don't claim anything — create or
      reuse its phase-7-* worktree and resume the flow at the first
      unfinished step reported by gsdt-flow-next. Idempotent.

  gsdt-start -p 7 --no-flow
      Reuse phase 7's worktree and open discuss-phase only.

  gsdt-start -n "fix invoice rounding" --slug invoice-fix
      Same, but the branch/worktree is phase-<N>-invoice-fix.

  gsdt-start -n "reporting exports"
      Prepare everything and open the configured session in the worktree.

  gsdt-start -n "reporting exports" --no-launch
      Same, but print the command to run later instead.

  gsdt-start -n "reporting exports" --agent codex
      Compatibility form: select Codex and launch it.

  gsdt-start -n "hotfix parsing" --repo ~/projects/acme/webshop
      Start a phase in another repo without cd-ing into it first.

PARALLEL SESSIONS
  Safe to run from several terminals at once:
  - a local lock (.git/gsd-cmd.lock) serializes gsd commands that touch the
    same checkout on this machine (concurrent runs wait, max 300s; stale
    locks left by crashed runs are reclaimed automatically);
  - the claim is pulled first and pushed with rebase-and-retry; if another
    session claimed the same phase number simultaneously, this one
    automatically renumbers and continues.

NOTES
  - The claim is deterministic — gsd-core's query phase.add (next integer) or,
    with --insert/--after, query phase.insert (next decimal after N),
    the same CLIs the /gsd-phase skill uses; no LLM call is made.
  - A claim is refused when the roadmap already has a phase with this exact
    description, or (with --ticket) a phase already tagged with the same ticket
    however it was worded — the error names the phase to attach to instead.
  - --insert needs a description and cannot be combined with -p/--phase. The
    anchor phase N must already exist in ROADMAP.md (else it errors, claiming
    nothing). You don't pick the exact decimal — it auto-assigns the next free
    N.x. Everything downstream (worktree, guard, discuss/plan/execute) accepts
    decimal phase numbers.
  - Requires a GSD-fitted repo (gsdt-bootstrap-repo) with initialized
    .planning/ (/gsd-new-project or /gsd-ingest-docs).
  - The main checkout must be on the base branch with no uncommitted
    .planning/ changes.

RELATED
  gsdt-finish            finish the phase (merge back, push, clean up)
  gsdt-init              set up GSD in a repo that doesn't have it yet
  gsdt-bootstrap-repo    just the file installation (what gsdt-init wraps)
`;

/** bash `die`: each message is one `✖ ` line (a message holding a newline prints the rest as is) */
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

const NUMBER_RE = /^[0-9]+(\.[0-9]+)?$/;
const SP = '[ \\t\\n\\r\\f\\v]';
const HEADING_RE = /^### Phase [0-9]+(\.[0-9]+)?:/;
/** sed -E 's/^### Phase ([0-9]+(\.[0-9]+)?):.*\/\1/' */
const headingNumber = (l: string): string => (/^### Phase ([0-9]+(?:\.[0-9]+)?):/.exec(l)?.[1] as string | undefined) ?? l;
/** a Failure from a resolver: its text (if any) to stderr, its code out */
function stopOn(r: { ok: false; code: number; message: string }): never {
  if (r.message !== '') err(`${r.message}\n`);
  throw new Stop(r.code);
}

/** `git … >/dev/null 2>&1`-style helpers and the plain "runs, output passes through" kind */
const gitQuiet = (dir: string, args: string[]): number => inherit('git', ['-C', dir, ...args], { stdio: ['inherit', 'ignore', 'ignore'] });
const gitShow = (dir: string, args: string[]): number => inherit('git', ['-C', dir, ...args]);
/** set -e after a command that is not tested */
const must = (rc: number): void => {
  if (rc !== 0) throw new Stop(rc);
};

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
  const PKG = gsdPkg();
  let DESC = '';
  let REPO = '';
  let SLUG = '';
  let TICKET = '';
  let TICKET_CU = false;
  let NO_TICKET = false;
  let ATTACH = '';
  let INSERT = '';
  let NEW = false;
  let PROVIDER_CLI = '';
  let AGENT_COMMAND_CLI = '';
  let MODEL_CLI = '';
  let LAUNCH = true; // open the session (in a terminal); --no-launch prints it
  let LAUNCH_ASKED = false; // --launch/--agent named: a missing executable is an error
  let FORCE_NOLAUNCH = false;
  let START_MODE_CLI = '';
  let PUSH = true;
  const need = (i: number, msg: string): string => {
    if (argv.length - i < 2) die(msg);
    return argv[i + 1] as string;
  };
  for (let i = 0; i < argv.length; ) {
    const a = argv[i] as string;
    switch (a) {
      case '-h':
      case '--help':
        out(HELP);
        return 0;
      case '-p':
      case '--phase':
        ATTACH = need(i, '--phase needs a value');
        i += 2;
        break;
      case '-n':
      case '--new':
        NEW = true;
        i++;
        break;
      case '--insert':
      case '--after':
        INSERT = need(i, `${a} needs a value`);
        i += 2;
        break;
      case '--repo':
        REPO = need(i, '--repo needs a value');
        i += 2;
        break;
      case '--slug':
        SLUG = need(i, '--slug needs a value');
        i += 2;
        break;
      case '--ticket':
        TICKET = need(i, '--ticket needs a ticket id');
        i += 2;
        break;
      case '--cu':
        TICKET = need(i, '--cu needs a value (ClickUp task id)');
        TICKET_CU = true;
        i += 2;
        break;
      case '--no-ticket':
        NO_TICKET = true;
        i++;
        break;
      case '--provider':
        PROVIDER_CLI = need(i, '--provider needs claude, codex, or custom');
        i += 2;
        break;
      case '--model': {
        if (argv.length - i < 2 || argv[i + 1] === '') die('--model needs a model ID or default');
        MODEL_CLI = argv[i + 1] as string;
        i += 2;
        break;
      }
      case '--agent-command':
        AGENT_COMMAND_CLI = need(i, '--agent-command needs one executable path/name');
        LAUNCH_ASKED = true;
        i += 2;
        break;
      case '--agent': {
        const v = need(i, '--agent needs a provider or executable');
        if (providerKnown(v) || providerGone(v)) PROVIDER_CLI = v;
        else {
          PROVIDER_CLI = 'custom';
          AGENT_COMMAND_CLI = v;
        }
        LAUNCH_ASKED = true;
        i += 2;
        break;
      }
      case '--flow':
        START_MODE_CLI = 'flow';
        i++;
        break;
      case '--no-flow':
        START_MODE_CLI = 'discuss';
        i++;
        break;
      case '--launch':
        LAUNCH_ASKED = true;
        i++;
        break;
      case '--no-launch':
        FORCE_NOLAUNCH = true;
        i++;
        break;
      case '--no-push':
        PUSH = false;
        i++;
        break;
      default:
        if (a.startsWith('-')) die(`unknown flag: ${a} (see gsdt-start --help)`);
        DESC = DESC !== '' ? `${DESC} ${a}` : a;
        i++;
    }
  }
  // --no-launch always wins, whatever order it appeared in.
  if (FORCE_NOLAUNCH) LAUNCH = false;
  if (ATTACH !== '' && DESC !== '') err(`⚠ ignoring "${DESC}" — -p/--phase attaches to phase ${ATTACH} as titled in ROADMAP.md\n`);
  if (ATTACH !== '' && INSERT !== '') {
    die('--insert and -p/--phase are mutually exclusive (insert claims a NEW phase; -p attaches to an existing one)');
  }
  if (ATTACH !== '' && NEW) {
    die('-n/--new and -p/--phase are mutually exclusive (-n claims a NEW phase; -p attaches to an existing one)');
  }
  if (DESC === '' && ATTACH === '') {
    if (INSERT !== '') die('--insert needs a phase description (e.g. gsdt-start --insert 11 "hotfix …")');
    if (NEW) die('-n/--new needs a phase description (e.g. gsdt-start -n "customer terms rework")');
    err(HELP);
    return 1;
  }
  // Claiming a NEW phase must be explicit: a bare description is refused.
  if (DESC !== '' && ATTACH === '' && INSERT === '' && !NEW) {
    die(`refusing to guess whether this is a new phase — say which:
  gsdt-start -n "${DESC}"
      claim a NEW phase
  gsdt-start -p <N>
      attach to the EXISTING phase N (check gsdt-list first)
  gsdt-start --insert <N> "${DESC}"
      insert a decimal hotfix phase after phase N`);
  }
  if (ATTACH !== '' && !grepq(NUMBER_RE, ATTACH)) die(`--phase must be a phase number (e.g. 7 or 7.1), got: ${ATTACH}`);
  if (INSERT !== '' && !grepq(NUMBER_RE, INSERT)) die(`--insert must be the phase number to insert after (e.g. 11), got: ${INSERT}`);

  updateNotice(); // a newer release? one stderr line, terminal only
  for (const l of staleHooksNotice()) err(`${l}\n`); // GSD hooks that run a missing file (they fail silently)

  // ── locate the main checkout ───────────────────────────────────────────────
  let MAIN: string;
  if (REPO !== '') {
    const r = git(REPO, ['rev-parse', '--show-toplevel']);
    if (r.status !== 0) die(`--repo is not a git checkout: ${REPO}`);
    MAIN = chomp(r.stdout);
  } else {
    if (git('.', ['rev-parse', '--show-toplevel']).status !== 0) die('not inside a git repo — cd into the target repo or pass --repo <path>');
    MAIN = findMain('.');
  }
  migrateRefuse(MAIN);
  const ROADMAP = `${MAIN}/.planning/ROADMAP.md`;
  if (!isFile(ROADMAP)) die(`${MAIN} has no .planning/ROADMAP.md — initialize GSD first (/gsd-new-project)`);
  let GSD_RUN = '';
  if (ATTACH === '') {
    const c = cli();
    if (c === null) {
      err(`✖ ${cliMissing()}\n`);
      return 1;
    }
    GSD_RUN = c;
  }

  // Base branch: .gsd.conf override, else detection.
  const BASE = base(MAIN);
  if (BASE === '') die(`could not determine the base branch — set 'base = <branch>' in ${MAIN}/.gsd.conf`);
  const pr = providerResolve(MAIN, PROVIDER_CLI, AGENT_COMMAND_CLI);
  if (!pr.ok) stopOn(pr);
  const PROVIDER = (pr as { ok: true; value: { provider: string; command: string } }).value.provider;
  const AGENT_COMMAND = (pr as { ok: true; value: { provider: string; command: string } }).value.command;
  const mr = modelResolve(MAIN, PROVIDER, MODEL_CLI);
  if (!mr.ok) stopOn(mr);
  const MODEL = (mr as { ok: true; value: string }).value;
  const sr = startModeResolve(MAIN, START_MODE_CLI);
  if (!sr.ok) stopOn(sr);
  const START_MODE = (sr as { ok: true; value: string }).value;
  const cr = compactResolve(MAIN);
  if (!cr.ok) stopOn(cr);
  const COMPACT = (cr as { ok: true; value: string }).value;

  // ── --ticket: normalize the id and tag the phase title/slug with tk-<id> ───
  // The ROADMAP title is what gsdt-finish and /gsdt-flow read the id back from.
  const TRACKER = trackerWhich(MAIN);
  if (TICKET !== '') {
    const normAs = TICKET_CU ? 'clickup' : TRACKER;
    const t = ticketNorm(TICKET, normAs);
    TICKET = t === null ? '' : chomp(t);
    if (t === null) die(`--ticket doesn't look like a ticket id (letters/digits, '-' between): ${TICKET}`); // bash assigned first: a failed norm leaves it empty
    if (DESC !== '' && !ticketTagged(DESC, TICKET)) DESC = `${DESC} tk-${TICKET}`;
    if (SLUG !== '' && !ticketTagged(SLUG, TICKET)) SLUG = `${SLUG}-tk-${TICKET}`;
  }
  // With a tracker set, every new phase is a ticket's work. Attaching (-p) only notes it below.
  if (ATTACH === '' && TRACKER !== 'none' && !NO_TICKET && TICKET === '' && ticketExtract(DESC) === '') {
    die(
      `tracker = ${TRACKER} is set, but this phase has no ticket.`,
      '  Claim it with its ticket:  add --ticket <id>   (an id, tk-<id> or the ticket\'s URL)',
      '  Work no ticket covers:     add --no-ticket',
    );
  }

  // ── local lock: serialize gsd commands touching this checkout ──────────────
  if (!acquireLock(MAIN)) return 1;

  // ── preconditions (claim mode only — attach mode never commits on $BASE) ───
  let HAS_ORIGIN = false;
  if (ATTACH === '') {
    const cur = chomp(git(MAIN, ['branch', '--show-current'], { inheritStderr: true }).stdout);
    if (cur !== BASE) die(`main checkout is on '${cur}', not '${BASE}' — checkout ${BASE} first (claims serialize through ${BASE})`);
    if (chomp(git(MAIN, ['status', '--porcelain', '--', '.planning'], { inheritStderr: true }).stdout) !== '') {
      die(
        'main checkout has uncommitted .planning/ changes — commit or stash them first (the claim commit must be clean)',
        'if they are only recomputed counters (from the post-merge hook): gsdt-planning-repair --commit',
      );
    }
    HAS_ORIGIN = git(MAIN, ['remote', 'get-url', 'origin']).status === 0;
    if (PUSH && HAS_ORIGIN) {
      out(`▶ syncing '${BASE}' with origin (picking up other sessions' claims)…\n`);
      if (git(MAIN, ['fetch', 'origin', BASE, '--quiet'], { inheritStderr: true }).status !== 0) {
        if (originLacks(MAIN, BASE)) {
          die(`origin has no '${BASE}' branch — push it first: git -C "${MAIN}" push -u origin ${BASE}`, '(or set base = <branch> in .gsd.conf)');
        }
        die(`could not fetch '${BASE}' from origin — check the network/remote, then re-run`);
      }
      if (git(MAIN, ['merge', '--ff-only', `origin/${BASE}`, '--quiet'], { inheritStderr: true }).status !== 0) {
        die(`local '${BASE}' has diverged from origin — reconcile it first`);
      }
    }
  }

  let N = '';
  let TITLE = '';

  // ── claim the phase (deterministic, no LLM) ────────────────────────────────
  const addRoadmapRows = (): void => {
    // GSD writes no checklist/Progress row for phase $N — add them
    const r = roadmapRows(ROADMAP, N);
    if (r.stderr !== '') err(r.stderr);
    if (r.rc !== 0) err(`⚠ could not add the ROADMAP rows for phase ${N} — gsdt-doctor will list them (T022/T023)\n`);
    // Recompute STATE.md's progress counters (total_phases, …) in the claim commit itself. Best effort.
    inherit(`${PKG}/bin/gsdt-planning-repair`, ['--repo', MAIN], { stdio: ['inherit', 'ignore', 'ignore'] });
  };

  const tddDefault = (): void => {
    // TDD is the toolkit's default — turn GSD's tdd_mode on in the claim commit. Only an UNSET key is filled.
    if (!isFile(`${MAIN}/.planning/config.json`)) return;
    if (python() === null) return; // (the bash could not tell unset from false without it)
    if (workflowFlag(MAIN, 'tdd_mode') !== '') return;
    const rc = inherit(GSD_RUN, ['query', 'config-set', 'workflow.tdd_mode', 'true', '--project-dir', MAIN], { stdio: ['inherit', 'ignore', 'ignore'] });
    if (rc === 0) out('▶ TDD mode on for this project (workflow.tdd_mode; turn it off with /gsd-settings)\n');
    else err('⚠ could not turn on TDD mode — set it with /gsd-settings\n');
  };

  /** the STATE.md "Roadmap Evolution" note (the same one the /gsd-phase skill writes) */
  const stateNote = (text: string): void => {
    const state = `${MAIN}/.planning/STATE.md`;
    if (!isFile(state)) return;
    // The perl worked on bytes: keep them (latin1 in, latin1 out).
    const raw = readFileSync(state, 'latin1');
    if (raw.split('\n').some((l) => l.includes('### Roadmap Evolution'))) {
      const note = Buffer.from(text, 'utf8').toString('latin1');
      const next = raw.replace(/(### Roadmap Evolution\n\n(?:- [^\n]*\n)*)/, (m) => `${m}- ${note}\n`);
      if (next !== raw) writeFileSync(state, Buffer.from(next, 'latin1'));
    } else {
      appendFileSync(state, `\n### Roadmap Evolution\n\n- ${text}\n`);
    }
  };

  const claim = (): void => {
    // claims the next phase number and commits; sets N
    const rc = inherit(GSD_RUN, ['query', 'phase.add', DESC, '--project-dir', MAIN], { stdio: ['inherit', 'ignore', 'inherit'] });
    if (rc !== 0) die('gsd_run query phase.add failed');
    // Source of truth for what was claimed: the heading just added to ROADMAP.md.
    const added = git(MAIN, ['diff', '--', '.planning/ROADMAP.md'], { inheritStderr: true })
      .stdout.split('\n')
      .filter((l) => /^\+### Phase [0-9]+(\.[0-9]+)?:/.test(l));
    const last = added[added.length - 1];
    N = last === undefined ? '' : ((/^\+### Phase ([0-9]+(?:\.[0-9]+)?):/.exec(last) as RegExpExecArray)[1] as string);
    if (N === '') die(`claim did not add a '### Phase N:' heading to ROADMAP.md — inspect ${MAIN}/.planning/ROADMAP.md`);
    addRoadmapRows();
    stateNote(`Phase ${N} added: ${DESC}`);
    tddDefault();
    must(gitShow(MAIN, ['add', '.planning']));
    must(gitShow(MAIN, ['commit', '-q', '-m', `docs(gsd): claim phase ${N} — ${DESC}`]));
  };

  const insertPhase = (): void => {
    // inserts a decimal phase after INSERT and commits; sets N (and SLUG if unset)
    const r = spawnSync(GSD_RUN, ['query', 'phase.insert', INSERT, DESC, '--project-dir', MAIN], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.status !== 0) die(`gsd_run query phase.insert failed — does phase ${INSERT} exist in ROADMAP.md?`);
    const o = r.stdout.split('\n');
    const pick = (key: string): string => {
      const re = new RegExp(`^${SP}*"${key}"${SP}*:${SP}*"([^"]+)"`);
      for (const l of o) {
        const m = re.exec(l);
        if (m) return m[1] as string;
      }
      return '';
    };
    // Source of truth for what was claimed: the phase_number from the JSON result.
    N = pick('phase_number');
    if (N === '') die(`phase.insert did not return a phase_number — inspect ${MAIN}/.planning/ROADMAP.md`);
    addRoadmapRows();
    // Reuse the slug the SDK derived (avoids the '(INSERTED)' suffix leaking into the worktree name).
    if (SLUG === '') SLUG = pick('slug');
    stateNote(`Phase ${N} inserted after Phase ${INSERT}: ${DESC}`);
    tddDefault();
    must(gitShow(MAIN, ['add', '.planning']));
    must(gitShow(MAIN, ['commit', '-q', '-m', `docs(gsd): insert phase ${N} (after ${INSERT}) — ${DESC}`]));
  };

  const doClaim = (): void => {
    if (INSERT !== '') insertPhase();
    else claim();
  };

  const unclaim = (): void => {
    // undo the local claim/insert commit after losing a same-number race
    const subj = chomp(git(MAIN, ['log', '-1', '--format=%s'], { inheritStderr: true }).stdout);
    if (subj !== `docs(gsd): claim phase ${N} — ${DESC}` && subj !== `docs(gsd): insert phase ${N} (after ${INSERT}) — ${DESC}`) {
      die(`expected the claim commit at HEAD but found: ${subj} — resolve manually in ${MAIN}`);
    }
    must(gitShow(MAIN, ['reset', '-q', '--hard', 'HEAD~1']));
    // phase.add/phase.insert also made a phase dir — drop the stale one (empty after the reset). Integer claims pad
    // the dir (07-slug); decimal inserts do not (11.1-slug) — cover both patterns.
    const major = N.split('.')[0] as string;
    const padded = /^[0-9]+$/.test(major) ? String(BigInt(major)).padStart(2, '0') : N;
    const root = `${MAIN}/.planning/phases`;
    try {
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        if (!d.name.startsWith(`${padded}-`) && !d.name.startsWith(`${N}-`)) continue;
        try {
          rmdirSync(`${root}/${d.name}`); // only an empty one goes
        } catch {
          // not empty: keep it
        }
      }
    } catch {
      // no phases dir
    }
  };

  const headings = (): string[] => readFileSync(ROADMAP, 'utf8').split('\n').filter((l) => HEADING_RE.test(l));

  if (ATTACH !== '') {
    // ── attach mode: the phase is already claimed — just verify it exists ────
    // Best-effort catch-up first: the phase may have been claimed on another machine.
    if (PUSH && git(MAIN, ['remote', 'get-url', 'origin']).status === 0 && chomp(git(MAIN, ['branch', '--show-current']).stdout) === BASE) {
      if (gitQuiet(MAIN, ['fetch', 'origin', BASE, '--quiet']) !== 0 || gitQuiet(MAIN, ['merge', '--ff-only', `origin/${BASE}`, '--quiet']) !== 0) {
        err(`⚠ could not update '${BASE}' from origin — using the local copy\n`);
      }
    }
    N = ATTACH;
    const re = phaseHeadingRe(N);
    const line = re === null ? undefined : readFileSync(ROADMAP, 'utf8').split('\n').find((l) => re.test(l));
    TITLE = line === undefined || re === null ? '' : line.replace(new RegExp(`${re.source}${SP}*`), '');
    if (TITLE === '') die(`phase ${N} not found in .planning/ROADMAP.md — omit -p/--phase to claim a new phase`);
    out(`▶ attaching to existing phase ${N}: ${TITLE}\n`);
  } else {
    // Refuse to claim a duplicate (skipped for --insert: inserting beside a same-named phase is intentional).
    if (INSERT === '') {
      // Same ticket, reworded: a phase already tagged with it IS this phase however the description was phrased.
      if (TICKET !== '') {
        const hs = headings();
        let tkN = '';
        if (hs.length > 0) {
          const first = hs.find((h) => ticketTagged(h, TICKET)) ?? '';
          if (first !== '') tkN = headingNumber(first);
        }
        if (tkN !== '') {
          die(`phase ${tkN} already tracks ticket ${TICKET} — attach to it instead: gsdt-start -p ${tkN}
  (to add a hotfix under it anyway: gsdt-start --insert ${tkN} "<desc>")`);
        }
      }
      const descLc = DESC.toLowerCase();
      let dupN = '';
      for (const line of headings()) {
        const i = line.indexOf(': ');
        const t = (i >= 0 ? line.slice(i + 2) : line).toLowerCase().replace(new RegExp(`^${SP}+`), '').replace(new RegExp(`${SP}+$`), '');
        if (t === descLc) {
          dupN = headingNumber(line);
          break;
        }
      }
      if (dupN !== '') die(`phase ${dupN} already has this exact description — attach to it instead: gsdt-start -p ${dupN}`);
    }

    if (INSERT !== '') {
      out(`▶ inserting phase after ${INSERT}: ${DESC}\n`);
      doClaim();
      out(`✔ phase ${N} inserted after phase ${INSERT} (committed on ${BASE})\n`);
    } else {
      out(`▶ claiming phase: ${DESC}\n`);
      doClaim();
      out(`✔ phase ${N} claimed (committed on ${BASE})\n`);
    }

    // ── publish the claim (auto-renumber on races with parallel sessions) ────
    if (PUSH && HAS_ORIGIN) {
      let ok = false;
      for (let attempt = 1; attempt <= 4; attempt++) {
        if (inherit('git', ['-C', MAIN, 'push', 'origin', BASE, '--quiet'], { stdio: ['inherit', 'inherit', 'ignore'] }) === 0) {
          ok = true;
          break;
        }
        out('  push rejected (parallel session got there first) — syncing…\n');
        if (git(MAIN, ['fetch', '--quiet', 'origin', BASE], { inheritStderr: true }).status !== 0) {
          die(`could not fetch origin/${BASE} to resolve the claim race — push '${BASE}' manually`);
        }
        // Decide the race on origin's roadmap BEFORE merging: the planning merge driver collapses duplicate
        // '### Phase N' sections into one, so counting headings after a rebase never sees the collision.
        const re = phaseHeadingRe(N);
        const theirs = git(MAIN, ['show', `origin/${BASE}:.planning/ROADMAP.md`]);
        if (re !== null && theirs.status === 0 && theirs.stdout.split('\n').some((l) => re.test(l))) {
          out(`  phase ${N} was claimed by the other session too — renumbering…\n`);
          unclaim();
          if (git(MAIN, ['merge', '--ff-only', '--quiet', `origin/${BASE}`], { inheritStderr: true }).status !== 0) {
            die(`could not fast-forward ${BASE} to origin/${BASE} — resolve in ${MAIN}, then rerun`);
          }
          doClaim();
          out(`✔ re-claimed as phase ${N}\n`);
        } else if (git(MAIN, ['pull', '--rebase', 'origin', BASE, '--quiet'], { inheritStderr: true }).status !== 0) {
          gitQuiet(MAIN, ['rebase', '--abort']);
          die(`rebase conflict while syncing the claim — resolve in ${MAIN}, then push manually`);
        }
      }
      if (!ok) die(`could not push the claim after 4 attempts — push '${BASE}' manually`);
      out(`✔ claim pushed to origin/${BASE}\n`);
    } else if (!HAS_ORIGIN) {
      out("• no 'origin' remote — claim stays local\n");
    } else {
      out(`• --no-push: remember to push '${BASE}' so other sessions see the claim\n`);
    }
  }

  // ── create the worktree ────────────────────────────────────────────────────
  // Always pin the worktree to the exact phase we claimed/attached — never let wt-new re-detect it from HEAD.
  const wtArgs = ['--phase', N];
  if (SLUG !== '') wtArgs.push(SLUG);
  const wt = spawnSync(`${PKG}/bin/gsdt-wt-new`, wtArgs, {
    cwd: MAIN,
    env: { ...process.env, GSD_LOCK_HELD: '1', GSD_WT_NEW_SUPPRESS_NEXT: '1' },
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  // `WT_OUT=$( … )` under set -e: a failure stops here and the captured text is not shown.
  if (wt.error) return 127;
  if (wt.status !== 0) return wt.status ?? 1;
  const WT_OUT = chomp(wt.stdout);
  out(`${WT_OUT}\n`);
  const found: string[] = [];
  for (const l of WT_OUT.split('\n')) {
    const m = /^✅ worktree ready: (.*)   \(phase.*/.exec(l);
    if (m) found.push(m[1] as string);
  }
  let DEST = found.join('\n');
  if (DEST === '' || !isDir(DEST)) {
    const BRANCH = phaseBranch(MAIN, N);
    DEST = worktreeOf(MAIN, BRANCH);
  }
  if (DEST === '' || !isDir(DEST)) die(`could not locate the new worktree for phase ${N}`);
  out(compactSettings(MAIN, DEST, COMPACT));

  const g = guardArgv(['--command', `gsd-${START_MODE === 'discuss' ? 'discuss-phase' : START_MODE}`, '--phase', N, '--repo', DEST], { env: process.env, cwd: process.cwd() });
  if (g.stdout !== '') out(g.stdout);
  if (g.stderr !== '') err(g.stderr);
  if (g.rc !== 0) return g.rc;
  if (START_MODE === 'flow') {
    // Fresh claims may not have a phase directory yet. Existing phases must pass the current step's checks before
    // a session is printed or opened.
    const prefix = N.includes('.') ? N : String(BigInt(N)).padStart(2, '0');
    let dirs: string[] = [];
    try {
      dirs = readdirSync(`${DEST}/.planning/phases`).filter((d) => d.startsWith(`${prefix}-`) && isDir(`${DEST}/.planning/phases/${d}`));
    } catch {
      dirs = [];
    }
    if (dirs.length > 0) {
      const rc = inherit(`${PKG}/bin/gsdt-flow-next`, [N, '--repo', DEST], { stdio: ['inherit', 'ignore', 'inherit'] });
      if (rc !== 0) return rc;
    }
  }

  // ── ticket write-back (best-effort — never blocks the phase) ───────────────
  // The ticket comes from --ticket or a tag in the description / ROADMAP title / worktree name (title first: the
  // slug is lowercased). With a tracker set, it moves to "in progress" with a trace comment.
  let TICKET_ID = TICKET;
  if (TICKET_ID === '') {
    for (const src of [DESC, TITLE, path.basename(DEST)]) {
      if (src === '') continue;
      TICKET_ID = ticketExtract(src);
      if (TICKET_ID !== '') break;
    }
  }
  if (TICKET_ID === '' && ATTACH !== '' && TRACKER !== 'none') {
    out(`• phase ${N} has no ticket (no tk-<id> in its ROADMAP title) — ${TRACKER} is not updated\n`);
  }
  if (TICKET_ID !== '') {
    if (TRACKER === 'none') {
      if (TICKET !== '') {
        out(`• tracker = none — phase tagged tk-${TICKET_ID} only (set tracker = clickup|custom in .gsd.conf to update the ticket)\n`);
      }
    } else {
      const rc = inherit(`${PKG}/bin/gsdt-tracker`, [
        '--repo',
        MAIN,
        'start',
        TICKET_ID,
        `🚧 GSD phase ${N} started — branch \`${path.basename(DEST)}\` in ${path.basename(MAIN)}.`,
      ]);
      if (rc !== 0) out(`• ticket ${TICKET_ID} not updated (non-fatal) — check: gsdt-tracker check\n`);
    }
  }

  // ── open the session ───────────────────────────────────────────────────────
  // The adapter builds an argv array; no shell template expansion is used.
  const PROMPT = providerPrompt(PROVIDER, START_MODE, N);
  const av = providerArgv(PROVIDER, AGENT_COMMAND, PROMPT, MODEL, COMPACT);
  if (!av.ok) stopOn(av);
  const ARGV = (av as { ok: true; value: string[] }).value;
  const NEXT = providerRender(DEST, ...ARGV);
  const haveAgent = commandOnPath(AGENT_COMMAND) !== null;
  if (LAUNCH && isatty(0) && isatty(1) && haveAgent) {
    out('\n');
    out(`▶ opening ${PROVIDER} session in ${DEST}…\n`);
    // bash `exec`'d the agent: release the lock first (a session can last hours), then hand the terminal over.
    releaseLock();
    const r = spawnSync(ARGV[0] as string, ARGV.slice(1), { stdio: 'inherit', cwd: DEST });
    if (r.error) return 127;
    return r.status ?? 128 + (r.signal ? signalNumber(r.signal) : 0);
  }
  out('\n');
  // Only an explicit --launch/--agent turns a missing executable into an error; by default the command is just printed.
  if (LAUNCH && LAUNCH_ASKED && !haveAgent) {
    err(`✖ provider executable '${AGENT_COMMAND}' not found — launch cancelled.\n`);
    out(`Next (after installing it or changing agent_command):  ${NEXT}\n`);
    return 127;
  }
  out(`Next:  ${NEXT}\n`);
  return 0;
}
