// gsdt-init — take a repo with NO GSD to "ready for gsdt-start" in one command: installs the
// worktree workflow (gsdt-bootstrap-repo, called in-process), then opens the agent session that
// makes the plan (/gsd-new-project or /gsd-ingest-docs) and, when it closes, says whether the
// ROADMAP is there. --no-launch, or no terminal, prints the command instead. Provider adapters
// choose the actual CLI argv. Port of the bash bin/gsdt-init (parity oracle:
// tests/fixtures/p8-old-bins/gsdt-init).
import { existsSync, lstatSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { isatty } from 'node:tty';
import path from 'node:path';
import { chomp, commandOnPath, confGet, findMain, git, isExec, migrateRefuse, planningHook } from '../common.ts';
import {
  compactResolve,
  GSD_GEMINI_GONE,
  modelResolve,
  providerArgv,
  providerGone,
  providerKnown,
  providerListValidate,
  providerPrompt,
  providerRender,
  providerResolve,
  providerUiTip,
  providerValidate,
} from '../provider.ts';
import { err, out, runSession } from '../stdio.ts';
import { uiGates } from '../ui.ts';
import { updateNotice } from '../update-check.ts';
import { die, guarded, main as bootstrap, Stop, stopOn } from './bootstrap-repo.ts';

const HELP = `gsdt-init — set up GSD in a repo that doesn't have it yet

Runs gsdt-bootstrap-repo (shared scripts/config/instructions plus the selected
provider adapter), then opens the agent session that makes the plan:

  /gsd-new-project    when the repo has no planning docs (fresh interview)
  /gsd-ingest-docs    when ADRs/PRDs/SPECs are detected (bootstrap from them)

The plan is a conversation with the agent (its questions are where the
project context comes from), so gsdt-init opens that session for you and,
when you close it, checks that .planning/ROADMAP.md was written. With no
terminal (a script, an agent's shell) or --no-launch it prints the command.

Safe to re-run: if the repo is already initialized (.planning/ROADMAP.md
exists), the workflow files are still repaired/synced from the source, but the
planning state is never touched — you're just pointed back to gsdt-start.

USAGE
  gsdt-init [options]          # run from INSIDE the target repo

OPTIONS
  --new            force /gsd-new-project (skip docs detection)
  --ingest         force /gsd-ingest-docs
  --src <path>     deprecated compatibility flag; bootstrap ignores it
  --base <branch>  base branch override (passed to gsdt-bootstrap-repo)
  --no-commit      don't commit the bootstrap files (default: commit)
  --no-ui          the project has no screens (backend, CLI): ui_gates = off
  --tracker <t>    where the tickets live: none, clickup or custom. Without it,
                   gsdt-init asks (in a terminal) when .gsd.conf sets no tracker
  --tracker-command <path>  with --tracker custom: the repo's tracker script
  --providers <list> comma-separated integrations to install, in default order
  --provider <p>   provider for the initialization session; when --providers
                   is omitted, also selects the single integration to install
  --provider-command <p=path> executable override for one provider; repeatable
  --agent-command <path> executable override (add --no-launch to print)
  --model <id>     session model override; 'default' uses the CLI's own default
  --agent <value>  compatibility alias: provider or custom executable
  --launch         open the planning session (the default, in a terminal);
                   an explicit --launch fails (127) when the agent CLI is missing
  --no-launch      print the 'cd … && <agent> …' command instead of opening it
  -h, --help       show this help

EXAMPLES
  cd ~/projects/acme/webshop && gsdt-init
      Bootstrap + commit, then open the planning session; when it closes,
      gsdt-init says whether the ROADMAP is ready.

  cd ~/projects/acme/webshop && gsdt-init --no-launch
      Same, but print the session command to run later.

  gsdt-init --ingest --agent codex
      Force ingest mode and open the session with the codex CLI.

  gsdt-init --providers claude,codex --provider codex --no-launch
      Install both integrations and print the Codex planning command.

  gsdt-init --providers claude,codex --provider-command codex=/opt/bin/codex
      Install Claude and Codex integrations with an explicit Codex executable.

  gsdt-init --base main --no-launch
      Bootstrap against 'main', print the planning command to run later.

AFTER INITIALIZATION
  gsdt-start -n "<description>"   begin each feature (claim + worktree + session).
                              The first claim also turns on GSD's TDD mode
                              (workflow.tdd_mode) unless the project set it.
  gsdt-finish                  land it (merge back, push, clean up)

RELATED
  gsdt-bootstrap-repo   just the file installation (what gsdt-init wraps)
  gsdt-start, gsdt-finish
`;

export function main(argv: string[]): number | Promise<number> {
  return guarded(() => run(argv));
}

const say = (s = ''): void => out(`${s}\n`);

/** `IFS= read -r`: one raw line from stdin; null at end of input (bash returns 1 then, even with a partial line) */
function readLine(): string | null {
  const buf = Buffer.alloc(1);
  const bytes: number[] = [];
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, 1, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') continue;
      if (code === 'EOF') return null;
      return null;
    }
    if (n === 0) return null;
    if (buf[0] === 10) return Buffer.from(bytes).toString('utf8');
    bytes.push(buf[0] as number);
  }
}

const DOC_NAME = [/^.*adr.*\.md$/i, /^.*prd.*\.md$/i, /^.*rfc.*\.md$/i, /^spec.*\.md$/i, /^requirements.*\.md$/i, /^architecture.*\.md$/i, /^design.*\.md$/i];

/**
 * find DEST -maxdepth 3 (prune node_modules, .git, .planning) -type f -iname … | head -8.
 * Entries of a folder are visited in name order (find used the filesystem's own order).
 */
export function findDocs(dest: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (found.length >= 8) return;
      const p = path.join(dir, n);
      if (n === 'node_modules' || n === '.git' || n === '.planning') continue;
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 3) walk(p, depth + 1);
      } else if (st.isFile() && DOC_NAME.some((re) => re.test(n))) found.push(p);
    }
  };
  walk(dest, 1);
  return found;
}

function run(argv: string[]): number | Promise<number> {
  let MODE = ''; // '' = auto-detect | new | ingest
  let TRACKER_CLI = '';
  let TRACKER_COMMAND_CLI = '';
  const BOOT_ARGS: string[] = [];
  let COMMIT = true;
  let PROVIDER_CLI = '';
  let PROVIDERS_CLI = '';
  const PROVIDER_COMMAND_ARGS: string[] = [];
  let AGENT_COMMAND_CLI = '';
  let MODEL_CLI = '';
  let LAUNCH = true; // open the planning session (in a terminal); --no-launch prints it
  let LAUNCH_ASKED = false; // --launch/--agent named: a missing executable is an error
  let FORCE_NOLAUNCH = false;
  for (let i = 0; i < argv.length; ) {
    const a = argv[i] as string;
    const has2 = argv.length - i >= 2;
    const v = argv[i + 1] as string;
    switch (a) {
      case '-h':
      case '--help':
        out(HELP);
        return 0;
      case '--new':
        MODE = 'new';
        i += 1;
        break;
      case '--ingest':
        MODE = 'ingest';
        i += 1;
        break;
      case '--src':
        if (!has2) die('--src needs a value');
        BOOT_ARGS.push('--src', v);
        i += 2;
        break;
      case '--base':
        if (!has2) die('--base needs a value');
        BOOT_ARGS.push('--base', v);
        i += 2;
        break;
      case '--no-commit':
        COMMIT = false;
        i += 1;
        break;
      case '--no-ui':
        BOOT_ARGS.push('--no-ui');
        i += 1;
        break;
      case '--tracker':
        if (!has2) die('--tracker needs none, clickup or custom');
        TRACKER_CLI = v;
        i += 2;
        break;
      case '--tracker-command':
        if (!has2 || v === '') die("--tracker-command needs the script's path");
        TRACKER_COMMAND_CLI = v;
        i += 2;
        break;
      case '--providers':
        if (!has2) die('--providers needs a comma-separated list');
        PROVIDERS_CLI = v;
        i += 2;
        break;
      case '--provider':
        if (!has2) die('--provider needs claude, codex, or custom');
        PROVIDER_CLI = v;
        i += 2;
        break;
      case '--model':
        if (!has2 || v === '') die('--model needs a model ID or default');
        MODEL_CLI = v;
        i += 2;
        break;
      case '--provider-command':
        if (!has2) die('--provider-command needs provider=executable');
        PROVIDER_COMMAND_ARGS.push(v);
        i += 2;
        break;
      case '--agent-command':
        if (!has2) die('--agent-command needs one executable path/name');
        AGENT_COMMAND_CLI = v;
        LAUNCH_ASKED = true;
        i += 2;
        break;
      case '--agent':
        // gemini is taken as the provider name so it is refused with the reason, not run as a command
        if (!has2) die('--agent needs a provider or executable');
        if (['claude', 'codex', 'gemini', 'custom'].includes(v)) PROVIDER_CLI = v;
        else {
          PROVIDER_CLI = 'custom';
          AGENT_COMMAND_CLI = v;
        }
        LAUNCH_ASKED = true;
        i += 2;
        break;
      case '--launch':
        LAUNCH_ASKED = true;
        i += 1;
        break;
      case '--no-launch':
        FORCE_NOLAUNCH = true;
        i += 1;
        break;
      default:
        die(`unknown arg: ${a} (see gsdt-init --help)`);
    }
  }
  // --no-launch always wins, whatever order it appeared in.
  if (FORCE_NOLAUNCH) LAUNCH = false;
  const top = git('.', ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) die('run this from inside the target git repo');
  const DEST = chomp(top.stdout);
  migrateRefuse(findMain(DEST));

  // Build bootstrap arguments only after validating the complete selection. This prevents a typo
  // or a launch provider outside the configured set from writing a partially initialized repository.
  if (PROVIDERS_CLI !== '') {
    const bad = providerListValidate(PROVIDERS_CLI);
    if (bad) stopOn(bad);
    if (PROVIDER_CLI === '') PROVIDER_CLI = PROVIDERS_CLI.split(',')[0] as string;
    if (!`,${PROVIDERS_CLI},`.includes(`,${PROVIDER_CLI},`)) die(`launch provider '${PROVIDER_CLI}' is not listed in --providers ${PROVIDERS_CLI}`);
    BOOT_ARGS.push('--agents', PROVIDERS_CLI);
  } else if (PROVIDER_CLI !== '') {
    if (providerGone(PROVIDER_CLI)) die(`${GSD_GEMINI_GONE}; use claude, codex, or custom`);
    if (!providerKnown(PROVIDER_CLI)) die(`unknown provider '${PROVIDER_CLI}'`);
    BOOT_ARGS.push('--agent', PROVIDER_CLI);
  }
  for (const pc of PROVIDER_COMMAND_ARGS) {
    if (!pc.includes('=')) die('--provider-command needs provider=executable');
    const cp = pc.slice(0, pc.indexOf('='));
    const cv = pc.slice(pc.indexOf('=') + 1);
    if (cp === '' || cv === '') die(`malformed --provider-command: ${pc}`);
    const bad = providerValidate(cp, cv);
    if (bad) stopOn(bad);
    if (PROVIDERS_CLI !== '' && !`,${PROVIDERS_CLI},`.includes(`,${cp},`)) die(`provider command '${cp}' is not listed in --providers ${PROVIDERS_CLI}`);
    BOOT_ARGS.push('--provider-command', pc);
  }
  if (AGENT_COMMAND_CLI !== '') {
    const bad = providerValidate(PROVIDER_CLI || 'claude', AGENT_COMMAND_CLI);
    if (bad) stopOn(bad);
    if (PROVIDERS_CLI !== '') BOOT_ARGS.push('--provider-command', `${PROVIDER_CLI}=${AGENT_COMMAND_CLI}`);
    else BOOT_ARGS.push('--agent-command', AGENT_COMMAND_CLI);
  }

  updateNotice(); // a newer gsd-toolkit / GSD? one stderr line each, terminal only

  // ── already initialized? (still repair/sync the workflow files below) ──────
  // Validate the prospective session model before bootstrap writes files.
  let MODEL_PROVIDER = PROVIDER_CLI || process.env.GSD_PROVIDER || '';
  if (MODEL_PROVIDER === '') {
    MODEL_PROVIDER = confGet(DEST, 'providers').split(',')[0] as string;
    if (MODEL_PROVIDER === '') MODEL_PROVIDER = confGet(DEST, 'provider');
    if (MODEL_PROVIDER === '' && PROVIDER_COMMAND_ARGS.length > 0) MODEL_PROVIDER = (PROVIDER_COMMAND_ARGS[0] as string).split('=')[0] as string;
    MODEL_PROVIDER = MODEL_PROVIDER || process.env.GSD_PROVIDER || process.env.GSD_AGENT || 'claude';
  }
  {
    const r = modelResolve(DEST, MODEL_PROVIDER, MODEL_CLI);
    if (!r.ok) stopOn(r);
  }
  const ALREADY = existsSync(`${DEST}/.planning/ROADMAP.md`);

  // ── the ticket tracker ─────────────────────────────────────────────────────
  // With a tracker set, gsdt-start claims a phase only with its ticket, so pick it now. Asked only
  // in a terminal and only while .gsd.conf names none; a script passes --tracker, and without
  // either the default (none) stays.
  const askTracker = (): void => {
    say("Where do this project's tickets live?");
    say('  1) none     no tracker — phases are not linked to tickets');
    say('  2) clickup  ClickUp (token in ~/.config/gsd/clickup.env)');
    say('  3) custom   your own script in this repo');
    for (;;) {
      out('Tracker [1]: ');
      const a = readLine() ?? '1';
      if (a === '' || a === '1' || a === 'none') TRACKER_CLI = 'none';
      else if (a === '2' || a === 'clickup') TRACKER_CLI = 'clickup';
      else if (a === '3' || a === 'custom') TRACKER_CLI = 'custom';
      else {
        say('  type 1, 2 or 3');
        continue;
      }
      break;
    }
    if (TRACKER_CLI === 'custom' && TRACKER_COMMAND_CLI === '') {
      out('Script, relative to the repo [scripts/tracker.sh]: ');
      const c = readLine() ?? '';
      TRACKER_COMMAND_CLI = c || 'scripts/tracker.sh';
    }
    say();
  };
  if (TRACKER_CLI === '' && confGet(DEST, 'tracker') === '' && (process.env.GSD_TRACKER_ASK === 'always' || (isatty(0) && isatty(1)))) askTracker(); // tests: GSD_TRACKER_ASK=always
  if (TRACKER_CLI !== '') {
    if (!['none', 'clickup', 'custom'].includes(TRACKER_CLI)) die(`unknown tracker '${TRACKER_CLI}' (expected none, clickup or custom)`);
    BOOT_ARGS.push('--tracker', TRACKER_CLI);
    if (TRACKER_COMMAND_CLI !== '') BOOT_ARGS.push('--tracker-command', TRACKER_COMMAND_CLI);
  }

  // ── step 1: install the workflow files (idempotent — also repairs/syncs) ───
  if (COMMIT) BOOT_ARGS.push('--commit');
  say('▶ installing the GSD worktree workflow (gsdt-bootstrap-repo)…');
  say();
  {
    const rc = bootstrap(BOOT_ARGS);
    if (rc !== 0) throw new Stop(rc);
  }
  say();

  const trackerNotice = (): void => {
    const t = confGet(DEST, 'tracker');
    switch (t || 'none') {
      case 'none':
        if (t === '') say('• no ticket tracker set — to link phases to tickets: gsdt-init --tracker clickup|custom');
        break;
      case 'clickup':
        say('• tracker = clickup — check the login: gsdt-tracker check   (gsdt-start then needs --ticket <id>)');
        break;
      case 'custom': {
        const c = confGet(DEST, 'tracker_command');
        if (!isExec(`${DEST}/${c}`) && !isExec(c)) say(`• tracker = custom — write ${c} (see docs/trackers.md) before the first gsdt-start`);
        say('• gsdt-start now needs --ticket <id> (or --no-ticket for a chore)');
        break;
      }
    }
  };
  // Everything installed above is a TRACKED file except two, so `git diff` is the review. Name the
  // two git cannot show you.
  const uiNotice = (): void => {
    // optional UI tools per configured provider (lib/provider.sh)
    if (uiGates(DEST) === 'off') return;
    let printed = false;
    for (const p of confGet(DEST, 'providers').split(',')) {
      if (p === '') continue;
      const tip = providerUiTip(p);
      if (tip === null) continue;
      if (!printed) {
        say();
        say('Optional, for better screens (the UI gates work without them):');
        printed = true;
      }
      say(`  • ${p}: ${tip}`);
    }
  };
  const reviewNotice = (): void => {
    say(`Review the tracked changes with:  git -C ${DEST} diff`);
    say('Also set, and NOT visible to git diff (per clone, not versioned):');
    say('  • git config merge.gsd-planning.driver');
    // Where the hook lands, and whether it is versioned, is planningHook's call — asking it here
    // keeps this message from drifting out of step with what the bootstrap actually did.
    const h = planningHook(DEST);
    say(h.versioned ? `  • ${h.label}   (versioned — this one IS in the diff)` : `  • ${h.label}`);
  };

  if (ALREADY) {
    say(`• ${DEST} already has GSD planning state (.planning/ROADMAP.md) —`);
    say('  workflow files were repaired/synced, planning state left untouched.');
    say();
    reviewNotice();
    uiNotice();
    trackerNotice();
    say();
    say('  Health check:  gsdt-doctor');
    say('  Start features with:  gsdt-start -n "<description>"');
    return 0;
  }

  // ── step 2: pick the initialization skill ──────────────────────────────────
  if (MODE === '') {
    const docs = findDocs(DEST);
    if (docs.length > 0) {
      MODE = 'ingest';
      say('▶ found existing planning docs — will initialize by ingesting them:');
      for (const d of docs) say(d.startsWith(`${DEST}/`) ? `    ${d.slice(DEST.length + 1)}` : d);
      say("  (use 'gsdt-init --new' instead if these shouldn't seed the plan)");
    } else {
      MODE = 'new';
      say('▶ no planning docs found — will initialize with the project interview');
    }
  }
  const pr = providerResolve(DEST, PROVIDER_CLI, AGENT_COMMAND_CLI);
  if (!pr.ok) stopOn(pr);
  const { provider: PROVIDER, command: AGENT_COMMAND } = (pr as { ok: true; value: { provider: string; command: string } }).value;
  const mr = modelResolve(DEST, PROVIDER, MODEL_CLI);
  if (!mr.ok) stopOn(mr);
  const MODEL = (mr as { ok: true; value: string }).value;
  const cr = compactResolve(DEST);
  if (!cr.ok) stopOn(cr);
  const COMPACT = (cr as { ok: true; value: string }).value;
  const CMD = providerPrompt(PROVIDER, MODE);
  const av = providerArgv(PROVIDER, AGENT_COMMAND, CMD, MODEL, COMPACT);
  if (!av.ok) stopOn(av);
  const ARGV = (av as { ok: true; value: string[] }).value;
  const NEXT = providerRender(DEST, ...ARGV);

  // ── step 3: the planning session (the plan itself is a conversation) ───────
  // The adapter builds an argv array; no shell template expansion is used. Run as a child: when the
  // session closes, say whether the plan is there.
  const haveAgent = commandOnPath(AGENT_COMMAND) !== null;
  if (LAUNCH && isatty(0) && isatty(1) && haveAgent) {
    say();
    say(`▶ opening ${PROVIDER} in ${DEST} to make the plan (/gsd-${MODE === 'ingest' ? 'ingest-docs' : 'new-project'})…`);
    say('  Answer its questions; close the session when it has written the roadmap.');
    say();
    return runSession(ARGV[0] as string, ARGV.slice(1), DEST).then((rc) => {
    say();
    const roadmap = `${DEST}/.planning/ROADMAP.md`;
    if (existsSync(roadmap)) {
      const ls = readFileSync(roadmap, 'latin1').split('\n');
      const phases = ls.filter((l) => /^#{2,4} Phase [0-9]/.test(l)).length;
      let first = '';
      for (const l of ls) {
        const m = /^#{2,4} Phase ([0-9]+(?:\.[0-9]+)?):/.exec(l);
        if (m) {
          first = m[1] as string;
          break;
        }
      }
      say(`✔ plan ready: ${phases} phase(s) in .planning/ROADMAP.md`);
      uiNotice();
      trackerNotice();
      if (first !== '') say(`Next:  gsdt-start -p ${first}   (one per phase; each gets its own worktree and session)`);
      else say('Next:  gsdt-start -n "<description>"   (one per feature)');
      say('TDD mode (tests first) turns on at the first gsdt-start; turn it off with /gsd-settings.');
      return 0;
    }
    err('✖ the session closed before the plan was written (no .planning/ROADMAP.md).\n');
    err('  Run gsdt-init again to pick it up where it stopped.\n');
    return rc === 0 ? 1 : rc;
    });
  }
  say();
  // Only an explicit --launch/--agent turns a missing executable into an error; by default the
  // command is just printed.
  if (LAUNCH && LAUNCH_ASKED && !haveAgent) {
    err(`✖ provider executable '${AGENT_COMMAND}' not found — launch cancelled.\n`);
    say(`Next (after installing it or changing agent_command):  ${NEXT}`);
    return 127;
  }
  uiNotice();
  trackerNotice();
  say(`Next:  ${NEXT}`);
  say('Then per feature:  gsdt-start -n "<description>"  →  work  →  gsdt-finish');
  say('TDD mode (tests first) turns on at the first gsdt-start; turn it off with /gsd-settings.');
  return 0;
}
