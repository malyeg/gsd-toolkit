// src/guard.ts — the worktree guard (port of bin/gsdt-worktree-guard; the old
// script is kept as the parity oracle in tests/fixtures/p3-old-bins/).
// Rules 0, 0b, 1, 2, 3, 4 and 5; see src/commands/worktree-guard.ts for the help.
// Exit codes: 0 allow, 2 block, 64 usage. Messages are byte-for-byte the bash ones.
//
// The Claude hook payload is read the way the bash guard read it with jq
// (the fallback Python reader is gone): `.command_name // .tool_input.skill`,
// `.command_args // .tool_input.args`, `.cwd`.
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { chomp, confGet, findMain, git, installCmd, isDir, isFile, reviewsProblem, validationProblem } from './common.ts';
import { uiDesignState, uiExempt, uiGate, uiGates, uiLayoutState, uiStepCmd } from './ui.ts';

export type GuardResult = { rc: number; stdout: string; stderr: string };
export type GuardOpts = {
  command?: string;
  args?: string;
  repo?: string;
  global?: boolean;
  /** the hook payload (read only when `command` is empty); a function is called lazily */
  stdin?: string | (() => string);
  env?: NodeJS.ProcessEnv;
  /** bash's $PWD */
  cwd?: string;
};

export const USAGE = 'usage: gsdt-worktree-guard [--global] [--command gsd-… --args "…" --repo <dir>]';

export type Parsed =
  | { kind: 'ok'; command: string; args: string; repo: string; global: boolean }
  | { kind: 'help' }
  | { kind: 'usage'; message: string };

/** The bash `while [ $# -gt 0 ]` loop, left to right (an early --help or error wins). */
export function parseArgs(argv: string[]): Parsed {
  let command = '';
  let args = '';
  let repo = '';
  let global = false;
  for (let i = 0; i < argv.length; ) {
    const a = argv[i] as string;
    switch (a) {
      case '--command':
      case '--args':
      case '--phase':
      case '--repo': {
        const v = argv[i + 1];
        if (v === undefined || v === '') return { kind: 'usage', message: `${a} needs a value` };
        if (a === '--command') command = v;
        else if (a === '--args') args = v;
        else if (a === '--phase') {
          // grep -q is line-based: any line that is a number passes
          if (!v.split('\n').some((l) => /^[0-9]+(\.[0-9]+)?$/.test(l))) return { kind: 'usage', message: '--phase needs a numeric phase' };
          args = args !== '' ? `${args} ${v}` : v;
        } else repo = v;
        i += 2;
        break;
      }
      case '--global':
        global = true;
        i += 1;
        break;
      case '-h':
      case '--help':
        return { kind: 'help' };
      default:
        return { kind: 'usage', message: `unknown option: ${a}` };
    }
  }
  return { kind: 'ok', command, args, repo, global };
}

/** bash `$(( 10#$int ))` — 64-bit wraparound included */
const toInt = (s: string): bigint => BigInt.asIntN(64, BigInt(s));

/** pnorm: strip leading zeros of the integer part, keep the ".fraction" */
function pnorm(s: string): string {
  const dot = s.indexOf('.');
  const int = dot < 0 ? s : s.slice(0, dot);
  return `${toInt(int)}${s.slice(int.length)}`;
}

const NUM = /^[0-9]+(\.[0-9]+)?$/;
const PHASE_BRANCH = /^phase-([0-9]+(?:\.[0-9]+)?)(?:-.*)?$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** jq's `a // b`: b unless a is a truthy value */
const truthy = (v: unknown): boolean => v !== undefined && v !== null && v !== false;
/** not missing and not null (jq can index `null`, but not `false`) */
const truthy2 = (v: unknown): boolean => v !== undefined && v !== null;

type Payload = { ok: true; cmd: string; args: string; cwd: string } | { ok: false };

/** jq semantics of the bash guard: type checks, `//` fallbacks, `$( )` drops trailing newlines. */
function readPayload(input: string): Payload {
  let p: unknown;
  try {
    p = JSON.parse(input);
  } catch {
    return { ok: false };
  }
  if (!isObject(p)) return { ok: false };
  const ti = p.tool_input;
  // jq: the `.tool_input.skill` / `.tool_input.args` alternative is evaluated only when the
  // first one is null/false, and indexing a tool_input that is neither null nor an object is an error
  if ((!truthy(p.command_name) || !truthy(p.command_args)) && truthy2(ti) && !isObject(ti)) return { ok: false };
  const skill = isObject(ti) ? ti.skill : undefined; // jq: indexing a non-object errors, `//` swallows it
  const targs = isObject(ti) ? ti.args : undefined;
  const cmd = truthy(p.command_name) ? p.command_name : truthy(skill) ? skill : '';
  const args = truthy(p.command_args) ? p.command_args : truthy(targs) ? targs : '';
  if (typeof cmd !== 'string' || typeof args !== 'string') return { ok: false };
  const cwd = truthy(p.cwd) && typeof p.cwd === 'string' ? p.cwd : '';
  return { ok: true, cmd: chomp(cmd), args: chomp(args), cwd: chomp(cwd) };
}

function branchOf(dir: string, env: NodeJS.ProcessEnv): string {
  const r = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { env });
  // `$(git … || echo unknown)`: an unborn HEAD prints "HEAD" and fails
  return chomp(r.status === 0 ? r.stdout : `${r.stdout}unknown\n`);
}

/** `cd "$dir" && cd "$sub" && pwd -P`, '' when a cd fails ("cd ''" stays) */
function physical(dir: string, sub: string): string {
  try {
    return realpathSync(path.resolve(dir, sub));
  } catch {
    return '';
  }
}

/** `gsd_base "$dir" 2>/dev/null || echo develop` */
function baseOrDevelop(dir: string, env: NodeJS.ProcessEnv): string {
  if (confGet(dir, 'base') !== '') return confGet(dir, 'base');
  const has = (b: string): boolean => git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`], { env }).status === 0;
  if (has('develop')) return 'develop';
  if (has('main')) return 'main';
  const r = git(dir, ['branch', '--show-current'], { env });
  return chomp(r.status === 0 ? r.stdout : `${r.stdout}develop\n`);
}

/** bash glob `"$dir/.planning/phases/$prefix"-*`, sorted */
function phaseGlob(phases: string, prefix: string): string[] {
  let names: string[];
  try {
    names = readdirSync(phases);
  } catch {
    return [];
  }
  return names.filter((n) => n.startsWith(`${prefix}-`)).sort().map((n) => `${phases}/${n}`);
}

/** `cat file 2>/dev/null || echo unknown` inside `$( )` */
function installStatus(file: string): string {
  try {
    return chomp(readFileSync(file, 'utf8'));
  } catch {
    return 'unknown';
  }
}

/** The guard for already-parsed input (no GSD_SKIP_GUARD check: see guardArgv). */
export function guard(opts: GuardOpts): GuardResult {
  const env = opts.env ?? process.env;
  const GLOBAL = opts.global === true;
  const out: string[] = [];
  const done = (rc: number): GuardResult => ({ rc, stdout: '', stderr: out.join('') });
  const block = (...lines: string[]): GuardResult => {
    for (const l of lines) out.push(`${l}\n`);
    return done(2);
  };
  const unreadable = (why: string): GuardResult => (GLOBAL ? done(0) : block(`BLOCKED: ${why}`));

  let cmd: string;
  let args: string;
  let payloadCwd = '';
  if ((opts.command ?? '') !== '') {
    cmd = (opts.command as string).replace(/^\//, '');
    args = opts.args ?? '';
  } else {
    const input = typeof opts.stdin === 'function' ? opts.stdin() : (opts.stdin ?? '');
    const p = readPayload(input);
    if (!p.ok) return unreadable('invalid Claude hook payload.');
    cmd = p.cmd.replace(/^\//, '');
    args = p.args;
    payloadCwd = p.cwd;
  }
  if (cmd.startsWith('gsd:')) cmd = `gsd-${cmd.slice(4)}`; // namespaced form of a GSD skill
  if (cmd.includes(':gsd-')) cmd = cmd.slice(cmd.indexOf(':') + 1); // a plugin's form: gsd-core:gsd-plan-phase
  if (cmd === 'gsdt-flow' || cmd === 'gsdw-flow') cmd = 'gsd-flow'; // this toolkit's flow skill (gsdw-: before 0.8.0)
  if (!cmd.startsWith('gsd-')) return done(0); // not a GSD command → allow

  // The phase is the first word that is only a number: a number inside a path
  // or a name (--files src/v2/a.ts, --prd docs/r3.md) is not a phase.
  let N = '';
  for (const w of args.split(/[ \t\n\v\f\r]+/)) {
    const t = w.replace(/^--phase=/, '');
    if (NUM.test(t)) {
      N = t;
      break;
    }
  }

  const pick = (v: string | undefined): string => (v !== undefined && v !== '' ? v : '');
  let dir = pick(opts.repo) || pick(env.CLAUDE_PROJECT_DIR) || payloadCwd || opts.cwd || process.cwd();
  const top = git(dir, ['rev-parse', '--show-toplevel'], { env });
  if (top.status === 0) dir = chomp(top.stdout);
  let branch = branchOf(dir, env);
  // Nested workers inherit phase identity only from a containing checkout in
  // the same Git repository. A branch name alone never bypasses the guard.
  if (branch.startsWith('agent-') || branch.startsWith('worktree-agent-')) {
    const wc = git(dir, ['rev-parse', '--git-common-dir'], { env });
    const workerCommon = physical(dir, wc.status === 0 ? chomp(wc.stdout) : '');
    const tl = git(dir, ['rev-parse', '--show-toplevel'], { env });
    let parent = path.dirname(tl.status === 0 ? chomp(tl.stdout) : dir);
    while (parent !== '/') {
      const pb = git(parent, ['branch', '--show-current'], { env });
      const parentBranch = pb.status === 0 ? chomp(pb.stdout) : '';
      if (parentBranch.startsWith('phase-')) {
        const pc = git(parent, ['rev-parse', '--git-common-dir'], { env });
        const parentCommon = physical(parent, chomp(pc.stdout));
        if (workerCommon === parentCommon) branch = parentBranch;
        break;
      }
      parent = path.dirname(parent);
    }
  }
  const BASE = baseOrDevelop(dir, env);
  const hasConf = isFile(`${dir}/.gsd.conf`);

  // Rule 0 — the plan is started by gsdt-init, never by the bare skill
  if ((cmd === 'gsd-new-project' || cmd === 'gsd-ingest-docs') && !hasConf) {
    return block(
      `BLOCKED: /${cmd} needs the gsd-toolkit setup first — this repo has no .gsd.conf.`,
      `Run gsdt-init in a terminal in this repo instead: it installs the toolkit's files, then opens a session that runs /${cmd}. (Or GSD_SKIP_GUARD=1 if the user asked to skip it.)`,
    );
  }
  if (GLOBAL && !hasConf) return done(0);

  // Rule 0b — GSD skills that clash with one-phase-per-worktree (set-up repos)
  if (hasConf) {
    const clash = (why: string, instead: string): GuardResult =>
      block(`BLOCKED: /${cmd} does not work with gsd-toolkit — ${why}.`, `Instead: ${instead}   (or GSD_SKIP_GUARD=1 if the user asked for it anyway)`);
    const sp = ` ${args} `;
    const addClaim = (): GuardResult =>
      clash('its claim is not pushed, so two sessions can take the same number, and it leaves out the ROADMAP rows', 'gsdt-start -n "<desc>"');
    switch (cmd) {
      case 'gsd-autonomous':
        return clash('it runs every phase in this one checkout and skips the review, validate and secure gates', 'gsdt-start -n "<desc>" (or -p <N>) per phase, then /gsdt-flow in that phase\'s worktree');
      case 'gsd-manager':
        return clash('it runs several phases as background agents in one checkout, and two writers in one checkout are not safe', 'gsdt-list to see every phase, gsdt-start per phase (each gets its own worktree and session)');
      case 'gsd-workspace':
      case 'gsd-workstreams':
        return clash("it is GSD's own isolation (its own worktrees and .planning/), which fights the toolkit's", 'gsdt-start -n "<desc>" — one worktree per phase, phases run in parallel');
      case 'gsd-phase':
        // --remove/--insert win over --edit: "--remove 3 --edit" still removes
        if (sp.includes(' --remove '))
          return clash('--remove renumbers every later phase, and a phase already started keeps a worktree and branch with its old number', `check gsdt-list first; only when no later phase is in flight, run it on ${BASE} with GSD_SKIP_GUARD=1`);
        if (sp.includes(' --insert ')) return clash('its claim is not pushed, so two sessions can take the same number, and it leaves out the ROADMAP rows', 'gsdt-start --insert <N> "<desc>"');
        if (!sp.includes(' --edit ')) return addClaim();
        break;
    }
  }

  // Rule 1 — /gsd-phase only on the base branch
  if (cmd === 'gsd-phase') {
    if (branch === BASE) return done(0);
    return block(`BLOCKED: /gsd-phase must run on '${BASE}' (main checkout), not '${branch}'.`, `ROADMAP.md changes go through ${BASE}. See .gsd/INSTRUCTIONS.md.`);
  }

  // Per-phase ("feature work") commands
  const FEATURE = ' gsd-flow gsd-review gsd-discuss-phase gsd-plan-phase gsd-execute-phase gsd-ui-phase gsd-mvp-phase gsd-spec-phase gsd-ai-integration-phase gsd-verify-work gsd-secure-phase gsd-validate-phase gsd-code-review gsd-add-tests gsd-extract-learnings gsd-ui-review gsd-eval-review ';
  if (!FEATURE.includes(` ${cmd} `)) return done(0); // progress, help, map-codebase, resume-work, … allowed anywhere

  if (branch === BASE) {
    return block(
      `BLOCKED: /${cmd} is feature work — run it in the phase worktree, not on ${BASE}.`,
      `Create/open it with: gsdt-start -p ${N || '<N>'}  (then open a session in phase-${N || '<N>'}-*). See .gsd/INSTRUCTIONS.md.`,
    );
  }

  const bn = PHASE_BRANCH.exec(branch)?.[1] ?? '';
  if (N === '') {
    N = bn;
    if (N === '') return block(`BLOCKED: /${cmd} requires a phase number and matching phase worktree.`);
  }
  if (branch.startsWith('phase-')) {
    if (bn === '' || pnorm(bn) !== pnorm(N)) return block(`BLOCKED: you're in '${branch}', but /${cmd} targets phase ${N}. Switch to the phase-${N}-* worktree.`);
  } else {
    return block(`BLOCKED: /${cmd} targets phase ${N} but '${branch}' isn't a phase-${N}-* worktree. See .gsd/INSTRUCTIONS.md.`);
  }

  // Rule 3 — execute-phase needs deps installed (only for repos with an install step)
  if (cmd === 'gsd-execute-phase' && installCmd(dir) !== '') {
    const s = installStatus(`${dir}/.gsd-install.status`);
    if (s === 'fail') return block(`BLOCKED: dependency install FAILED — see ${dir}/.gsd-install.log, then install manually.`);
    if (s === 'running') return block(`BLOCKED: dependencies still installing. Log: ${dir}/.gsd-install.log`);
    if (s !== 'ok' && !isDir(`${dir}/node_modules`)) {
      return block(`BLOCKED: dependency installation is not complete (status: ${s}). Run '${chomp(installCmd(dir))}' successfully and record ok in .gsd-install.status.`);
    }
  }

  // Rules 4 and 5 — opt-in artifact gates. Policy is read from the MAIN
  // checkout's .gsd.conf, not the worktree's copy, so turning it on takes
  // effect for worktrees branched before the key existed.
  const main = findMain(dir, env);
  const FLOW_STRICT = confGet(main, 'flow') === 'strict';
  const UI_STRICT = uiGates(dir, env) === 'strict';
  if (!FLOW_STRICT && !UI_STRICT) return done(0);
  // The phase dir may be padded (08-, 02.1-) or not (7.1-); artifacts inside it
  // carry the dir's own prefix, so P is taken from the dir that exists.
  const nn = pnorm(N);
  const dot = nn.indexOf('.');
  const int = dot < 0 ? nn : nn.slice(0, dot);
  let P = `${int.padStart(2, '0')}${nn.slice(int.length)}`;
  let pdir = '';
  const phases = `${dir}/.planning/phases`;
  for (const d of [...phaseGlob(phases, P), ...phaseGlob(phases, nn)]) {
    if (isDir(d)) {
      pdir = d;
      P = path.basename(d);
      P = P.slice(0, P.indexOf('-'));
      break;
    }
  }
  const need = (suffix: string, step: string, run: string): GuardResult | null => {
    if (pdir !== '' && isFile(`${pdir}/${P}-${suffix}`)) return null;
    return block(`BLOCKED (flow = strict): /${cmd} ${N} needs ${P}-${suffix} — ${step} has not been done.`, `Run: ${run}   (or GSD_SKIP_GUARD=1 if the user asked to skip it)`);
  };
  const uiBlock = (what: string, fix: string): GuardResult =>
    block(`BLOCKED (ui_gates = strict): /${cmd} ${N} needs ${what}.`, `Run: ${fix}   (or GSD_SKIP_GUARD=1 if the user asked to skip it)`);
  if (UI_STRICT) {
    if (cmd === 'gsd-ui-phase') {
      if (uiDesignState(dir) !== 'ok') return uiBlock('a filled .planning/design/DESIGN.md (the design system)', 'gsdt-ui design, then fill it with the user');
      const ls = pdir !== '' ? uiLayoutState(dir, pdir, P) : '';
      if (ls !== 'ok' && ls !== 'skip') return uiBlock(`${P}-LAYOUT.md with a chosen sketch and pages`, `gsdt-ui layout ${N}, /gsd-sketch, then fill sketch: and pages:`);
    } else if (cmd === 'gsd-ui-review') {
      // check → look → approval, each for the pages as they are now. A phase
      // whose UI review is already on the base branch predates these steps.
      if (pdir === '') return uiBlock('a phase folder with the UI check of the built pages', `gsdt-ui check ${N}`);
      if (!uiExempt(dir, pdir, P, env)) {
        const gate = uiGate(dir, pdir, P, '', env);
        if (gate !== '') {
          const step = gate.slice(0, gate.includes('|') ? gate.indexOf('|') : undefined);
          return uiBlock(`the UI steps before it — ${gate.slice(gate.lastIndexOf('|') + 1)}`, uiStepCmd(step, N));
        }
      }
    }
  }
  if (!FLOW_STRICT) return done(0);
  let r: GuardResult | null;
  switch (cmd) {
    case 'gsd-plan-phase': {
      const sp = ` ${args} `;
      if (!sp.includes(' --prd ') && !sp.includes(' --prd=') && (r = need('CONTEXT.md', 'discuss-phase', `/gsd-discuss-phase ${N}`))) return r;
      break;
    }
    case 'gsd-execute-phase': {
      if (` ${args} `.includes(' --gaps-only ')) break;
      if ((r = need('REVIEWS.md', 'the cross-AI plan review', `/gsd-review --phase ${N}  then  /gsd-plan-phase ${N} --reviews`))) return r;
      const rp = confGet(main, 'review_provider');
      const why = reviewsProblem(`${pdir}/${P}-REVIEWS.md`, rp || 'codex');
      if (why !== null) {
        return block(
          `BLOCKED (flow = strict): /${cmd} ${N} needs a usable ${P}-REVIEWS.md — ${why}.`,
          `Open it first: a rerun costs a full review. If the reviewer really failed, delete it and run: /gsd-review --phase ${N}  then  /gsd-plan-phase ${N} --reviews   (Codex usage limit: gsdt-codex-wait --wait-only first, as a background job; or GSD_SKIP_GUARD=1 if the user asked to skip it)`,
        );
      }
      break;
    }
    case 'gsd-secure-phase': {
      if ((r = need('REVIEW.md', 'the code review', `/gsd-code-review ${N}`))) return r;
      if (isFile(`${pdir}/${P}-UI-SPEC.md`) && (r = need('UI-REVIEW.md', 'ui-review (this phase has screens)', `/gsd-ui-review ${N}`))) return r;
      const why = validationProblem(pdir, P, dir);
      if (why !== null) return block(`BLOCKED (flow = strict): /${cmd} ${N} needs the test audit — ${why}.`, `Run: /gsd-validate-phase ${N}   (or GSD_SKIP_GUARD=1 if the user asked to skip it)`);
      break;
    }
  }
  return done(0);
}

/** The whole command: GSD_SKIP_GUARD, argv, then the guard. */
export function guardArgv(argv: string[], io: { stdin?: string | (() => string); env?: NodeJS.ProcessEnv; cwd?: string } = {}): GuardResult {
  const env = io.env ?? process.env;
  if (env.GSD_SKIP_GUARD === '1') return { rc: 0, stdout: '', stderr: '' };
  const p = parseArgs(argv);
  if (p.kind === 'help') return { rc: 0, stdout: `${USAGE}\n`, stderr: '' };
  if (p.kind === 'usage') return { rc: 64, stdout: '', stderr: `${p.message}\n` };
  return guard({ command: p.command, args: p.args, repo: p.repo, global: p.global, stdin: io.stdin, env, cwd: io.cwd });
}
