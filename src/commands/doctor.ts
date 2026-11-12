// gsdt-doctor — read-only health check of a repo's GSD setup (port of the bash
// bin/gsdt-doctor; the help text is the header comment of bin/gsdt-doctor, read
// at run time like the bash `usage` did).
//
// Diagnoses; every finding names the command that fixes it. `--fix` is opt-in
// and narrow: it runs only the named safe actions (dispatched by name in
// runSafe, never by evaluating fix text), shows them first, asks, and never
// commits. See bin/gsdt-doctor's header for the finding codes.
//
// Quirks kept on purpose (parity with the bash):
//  - a failing T020 prints its "      · …" lines to stdout even with --json;
//  - flow_skip / flow_since compare numbers the awk way (leading number, else 0);
//  - globs (`<P>-*` dirs, `skills/*`) sort in byte order, bash sorts by locale.
// Differences (improvements): T062 reads the settings file natively (no python).
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, readlinkSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  GSD_CORE_INSTALL,
  base as confBase,
  baseref,
  baserefEnsure,
  chomp,
  cli,
  commandOnPath,
  confGet,
  findMain,
  git,
  gsdPkg,
  isDir,
  isExec,
  isFile,
  planningStatus,
  python,
  run,
  skillDiffers,
  validationProblem,
  wtdir as confWtdir,
} from '../common.ts';
import {
  CONTEXT_BIG_KIB,
  agentHome,
  coreGroupsFor,
  coreHideable,
  coreMissingSkills,
  coreSkillDir,
  listingSize,
  tokensFmt,
} from '../context.ts';
import {
  GSD_GEMINI_GONE,
  canonicalBlock,
  commandGuardsActive,
  modelResolve,
  ownedBlockGet,
  ownedMarkersValid,
  providerEntryBlock,
  providerGone,
  providerHookState,
  providerInstructionFile,
  providerInstructionIntegrated,
  providerInstructionMembers,
  providerKnown,
  providerResolve,
  providerSkillRoot,
  providerUiAddon,
  providerUserHookFile,
  staleHooks,
} from '../provider.ts';
import { roadmapAudit } from '../roadmap.ts';
import {
  coreUpdateHow,
  gsdCached,
  gsdInstalled,
  gsdRefresh,
  gsdStale,
  latestCached,
  latestRefresh,
  latestStale,
  updateHow,
  updateRepo,
  versionGt,
} from '../update-check.ts';
import {
  uiAddonPresent,
  uiApprovalState,
  uiCheckState,
  uiDesignState,
  uiGates,
  uiHasScreens,
  uiPhaseScreens,
  uiPlaywrightInstalled,
  uiStack,
} from '../ui.ts';
import { gsdVersion } from '../version.ts';
import { ticketExtract } from '../ticket.ts';

class Quit extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

// ── output (synchronous, so it interleaves with child processes like bash) ──

function writeAll(fd: number, s: string): void {
  const b = Buffer.from(s, 'utf8');
  let off = 0;
  while (off < b.length) {
    try {
      off += writeSync(fd, b, off, b.length - off);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      if ((e as NodeJS.ErrnoException).code === 'EPIPE') return;
      throw e;
    }
  }
}
const out = (s: string): void => writeAll(1, s);
const err = (s: string): void => writeAll(2, s);

/** the header comment of bin/gsdt-doctor up to its `set -uo` line, `# ` stripped (bash `usage`) */
export function usageText(pkg: string = gsdPkg()): string {
  let t = '';
  try {
    t = readFileSync(path.join(pkg, 'bin', 'gsdt-doctor'), 'utf8');
  } catch {
    return '';
  }
  const ls = t.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  let o = '';
  for (let i = 1; i < ls.length; i++) {
    const l = ls[i] as string;
    if (/^set -uo/.test(l)) break;
    o += `${l.replace(/^# ?/, '')}\n`;
  }
  return o;
}

// ── small helpers ───────────────────────────────────────────────────────────

const SP = '[ \\t\\n\\r\\f\\v]';

/** jstr — escape for the JSON the bash built by hand: \ and ", no ESC; nothing else */
export function jstr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\x1b/g, '');
}

/** `for x in $list` with IFS=, : split on commas, one trailing delimiter makes no empty field */
export function splitComma(s: string): string[] {
  if (s === '') return [];
  const p = s.split(',');
  if (p[p.length - 1] === '') p.pop();
  return p;
}

/** default-IFS word splitting */
const words = (s: string): string[] => s.split(/[ \t\n]+/).filter((x) => x !== '');

const lineList = (text: string): string[] => {
  const l = text.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
};

function readFileText(f: string): string | null {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return null;
  }
}

const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** bash `[ -e p ]` */
const exists = (p: string): boolean => existsSync(p);

/** kill -0 <pid> succeeded */
function alive(pid: string): boolean {
  if (!/^[0-9]+$/.test(pid)) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

/** stdout+stderr of one command, merged in order (`2>&1`), and its status */
function runMerged(cmd: string, args: string[]): { out: string; rc: number } {
  const d = mkdtempSync(path.join(tmpdir(), 'gsd-doctor-'));
  const f = path.join(d, 'out');
  const fd = openSync(f, 'w');
  try {
    const r = spawnSync(cmd, args, { stdio: ['ignore', fd, fd] });
    closeSync(fd);
    return { out: readFileSync(f, 'utf8'), rc: r.error ? 127 : (r.status ?? 1) };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

/** child with the doctor's own stdio (output order is kept: ours is synchronous) */
function runInherit(cmd: string, args: string[], cwd?: string): number {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd });
  return r.error ? 127 : (r.status ?? 1);
}

/** awk's `x + 0`: the leading number of a string, else 0 */
function awkNum(s: string): number {
  const m = /^[ \t\n\r\f\v]*([+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)/.exec(s);
  return m ? Number(m[1]) : 0;
}

const asInt64 = (s: string): bigint => BigInt.asIntN(64, BigInt(s));

/** pn — normalize a phase number for comparing (07 = 7, 02.1 = 2.1); null when it is none */
function pn(v: string): string | null {
  if (v === '' || /[^0-9.]/.test(v)) return null;
  if (v.includes('.')) {
    const head = v.slice(0, v.indexOf('.'));
    if (head === '') return null; // $((10#)) is an arithmetic error
    return `${asInt64(head)}.${v.slice(v.indexOf('.') + 1)}`;
  }
  return `${asInt64(v)}`;
}

// ── the doctor ──────────────────────────────────────────────────────────────

type Opts = { repo: string; quiet: boolean; json: boolean; fix: boolean; yes: boolean };

class Doctor {
  readonly pkg = gsdPkg();
  readonly o: Opts;
  main = '';
  findings = 0;
  fixes: string[] = [];
  safeList: string[] = [];
  notesJson: string[] = [];
  updatesJson: string[] = [];
  jsonItems: string[] = [];
  pmAbs = '';
  basereFix: string[] = [];
  base = '';

  constructor(o: Opts) {
    this.o = o;
  }

  pass(m: string): void {
    if (!this.o.quiet) out(`  \x1b[32m✔\x1b[0m ${m}\n`);
  }
  note(m: string): void {
    if (this.o.json) this.notesJson.push(`"${jstr(m)}"`);
    if (!this.o.quiet) out(`  • ${m}\n`);
  }
  update(name: string, installed: string, latest: string, cmd: string): void {
    if (!this.o.json) out(`  \x1b[33m↑\x1b[0m ${name} ${installed} installed, ${latest} available — update: ${cmd}\n`);
    this.updatesJson.push(`{"name":"${jstr(name)}","installed":"${jstr(installed)}","latest":"${jstr(latest)}","fix":"${jstr(cmd)}"}`);
  }
  safe(a: string): void {
    if (!this.safeList.includes(a)) this.safeList.push(a);
  }
  fail(msg: string, fix: string, code = 'T000'): void {
    this.findings++;
    switch (code) {
      case 'T010': case 'T011': case 'T012': case 'T013': case 'T014': case 'T016': case 'T052': case 'T058': case 'T061':
        this.safe('init');
        break;
      case 'T020':
        this.safe('repair');
        break;
      case 'T090':
        this.safe('migrate');
        break;
      case 'T030':
        this.safe('unlock');
        break;
    }
    if (this.o.json) {
      this.jsonItems.push(`{"code":"${code}","message":"${jstr(msg)}","fix":"${jstr(fix)}"}`);
      return;
    }
    out(`  \x1b[31m✖\x1b[0m ${msg} \x1b[2m→ ${fix} [${code}]\x1b[0m\n`);
    if (!this.fixes.includes(fix)) this.fixes.push(fix);
  }
  section(t: string): void {
    if (!this.o.quiet) out(`\n\x1b[1m${t}\x1b[0m\n`);
  }

  // ── the run ───────────────────────────────────────────────────────────────

  run(): number {
    const o = this.o;
    const die = (m: string): never => {
      err(`✖ ${m}\n`);
      throw new Quit(1);
    };
    if (o.fix && o.json) die("--fix and --json don't mix");
    if (o.yes && !o.fix) die('--yes only goes with --fix');
    let repoArg = o.repo;
    if (repoArg === '') {
      const r = git('.', ['rev-parse', '--show-toplevel']);
      repoArg = r.status === 0 ? chomp(r.stdout) : '';
      if (repoArg === '') die('not inside a git repository — pass --repo <path>');
    }
    const REPO = repoArg;
    const MAIN = findMain(REPO);
    if (MAIN === '') die(`not a git repository: ${REPO}`);
    this.main = MAIN;
    const pkg = this.pkg;
    const note = this.note.bind(this);
    const pass = this.pass.bind(this);
    const fail = this.fail.bind(this);
    const section = this.section.bind(this);
    const safe = this.safe.bind(this);

    // How to (re)install THIS toolkit.
    let REINSTALL: string;
    if (exists(`${pkg}/.git`)) REINSTALL = `${pkg}/install.sh --reuse-install-config`;
    else if (isFile(`${pkg}/install.sh`)) REINSTALL = `bash ${pkg}/install.sh --version ${gsdVersion()} --reuse-install-config`;
    else REINSTALL = `curl -fsSL https://raw.githubusercontent.com/${updateRepo()}/main/install.sh | bash -s --`;

    const RAW_PROVIDERS = confGet(MAIN, 'providers');
    const RAW_LEGACY_PROVIDER = confGet(MAIN, 'provider');
    const RAW_PROVIDER = RAW_PROVIDERS !== '' ? (RAW_PROVIDERS.split(',')[0] as string) : RAW_LEGACY_PROVIDER || 'claude';
    const RAW_COMMAND = confGet(MAIN, 'agent_command');
    let PROVIDER_VALID = true;
    let DOCTOR_PROVIDER: string;
    let DOCTOR_COMMAND: string;
    const pr = providerResolve(MAIN, RAW_PROVIDER, '');
    if (pr.ok) {
      DOCTOR_PROVIDER = pr.value.provider;
      DOCTOR_COMMAND = pr.value.command;
    } else {
      PROVIDER_VALID = false;
      DOCTOR_PROVIDER = RAW_PROVIDER;
      DOCTOR_COMMAND = RAW_COMMAND || 'unknown';
    }
    const PROVIDER_AVAILABLE = commandOnPath(DOCTOR_COMMAND) !== null;
    let DOCTOR_MODEL = '';
    let MODEL_VALID = true;
    const mr = modelResolve(MAIN, DOCTOR_PROVIDER, '');
    if (mr.ok) DOCTOR_MODEL = mr.value;
    else MODEL_VALID = false;

    if (!o.json) out(`\x1b[1mgsd-doctor\x1b[0m — ${path.basename(MAIN)}\n${MAIN}\n`);

    // ── toolkit ─────────────────────────────────────────────────────────────
    section('toolkit');
    let resolved = '';
    let live = commandOnPath('gsdt-finish');
    if (live !== null) {
      for (;;) {
        let t: string;
        try {
          t = readlinkSync(live);
        } catch {
          break;
        }
        live = t.startsWith('/') ? t : `${path.dirname(live)}/${t}`;
      }
      const cand = path.resolve(path.dirname(live), '..');
      if (isDir(path.dirname(live))) resolved = cand;
    }
    if (resolved === '') fail('gsd commands are not on PATH', REINSTALL, 'T001');
    else if (realOrSelf(resolved) !== realOrSelf(pkg)) fail(`PATH commands come from ${resolved}, not this package`, REINSTALL, 'T002');
    else pass(`PATH commands resolve to ${pkg}`);

    const PY = python();
    if (PY !== null) {
      const vr = run(PY, ['--version']);
      const ver = chomp(`${vr.stdout}${vr.stderr}`.split('\n').map((l) => l.trim().split(/\s+/)[1] ?? '').join('\n'));
      pass(`${PY} ${ver} (the planning repair needs it)`);
    } else {
      fail('no python 3.7+ (tried python3, then python) — planning merges fall back to plain union', 'install python3', 'T003');
    }
    if (commandOnPath('perl') !== null) pass('perl (the bash commands not yet ported need it)');
    else fail('perl not found — gsdt-finish, gsdt-init and gsdt-migrate need it', 'install perl', 'T006');

    const gsdAgent = DOCTOR_PROVIDER === 'codex' ? 'codex' : 'claude';
    const gsdRun = cli();
    if (gsdRun !== null) pass(`gsd-core ${gsdInstalled()} (${gsdRun})`);
    else fail('GSD (gsd-core) not found — gsdt-start cannot claim phases', `${GSD_CORE_INSTALL} --${gsdAgent} --global --profile=full`, 'T005');

    // T009 — gsd-core skills the toolkit runs are missing.
    for (const p of ['claude', 'codex']) {
      if (!`,${RAW_PROVIDERS || DOCTOR_PROVIDER},`.includes(`,${p},`)) continue;
      const d = agentHome(p) as string;
      const profText = readFileText(`${d}/.gsd-profile`);
      const prof = (profText === null ? '' : (profText.split('\n')[0] ?? '')).replace(/[ \t\n\r\f\v]/g, '');
      const sd = coreSkillDir(p);
      if (sd !== null) {
        const missing = coreMissingSkills(MAIN, sd).join(' ');
        if (missing === '') continue;
        const groups = coreGroupsFor(d, missing);
        const fix = groups !== '' ? `/gsd-surface enable ${groups}   (in a ${p} session; one group per call)` : `${GSD_CORE_INSTALL} --${p} --global --profile=full`;
        fail(`gsd-core for ${p} is missing skills the phase flow runs: ${missing}`, fix, 'T009');
      } else {
        if (prof === '' || `,${prof},`.includes(',full,')) continue;
        fail(`gsd-core for ${p} has the '${prof}' skill profile — the phase flow needs skills only 'full' has`, `${GSD_CORE_INSTALL} --${p} --global --profile=full`, 'T009');
      }
    }

    // GSD hooks that run a file that is gone.
    const staleOut = chomp(staleHooks(MAIN));
    if (staleOut === '') {
      pass('no GSD hook runs a missing file');
    } else {
      const all = staleOut.split('\n').map((l) => l.split('\t'));
      const files: string[] = [];
      for (const r of all) if (!files.includes(r[0] ?? '')) files.push(r[0] ?? '');
      for (const f of files) {
        const rows = all.filter((r) => (r[0] ?? '') === f);
        const n = new Set(rows.map((r) => r[3] ?? '')).size;
        const f6: string[] = [];
        for (const r of rows) if (!f6.includes(r[5] ?? '')) f6.push(r[5] ?? '');
        const gone = f6.slice(0, 2).join(',').replace(/,/g, ', ');
        const why = rows.some((r) => /\/node$/.test(r[5] ?? '')) ? ' (a Node upgrade moved it; the old GSD saved the exact node path)' : '';
        let fix: string;
        if (rows.some((r) => r[2] === 'toolkit')) {
          fix = REINSTALL;
        } else {
          let agent = 'claude';
          if (f === providerUserHookFile('codex')) agent = 'codex';
          if (f.startsWith(`${MAIN}/.codex/`)) agent = 'codex';
          const scope = rows.some((r) => r[1] === 'project') ? 'local' : 'global';
          fix = `${GSD_CORE_INSTALL} --${agent} --${scope}`;
          if (rows.some((r) => r[4] === 'statusLine')) fix += ' --force-statusline';
        }
        fail(`${n} GSD hook(s) in ${f} run a missing file: ${gone}${why} — they fail silently`, fix, 'T008');
      }
    }

    // A newer toolkit release on GitHub? A note, never a finding.
    const noUpdateCheck = (process.env.GSD_NO_UPDATE_CHECK ?? '') !== '';
    if (!noUpdateCheck) {
      if (latestStale()) latestRefresh();
      const tkNew = latestCached();
      const tkCur = gsdVersion();
      if (tkNew !== '' && versionGt(tkNew, tkCur)) this.update('gsd-toolkit', tkCur, tkNew, updateHow());
      else if (tkNew !== '') pass(`gsd-toolkit ${tkCur} (latest release: ${tkNew})`);
      else note(`gsd-toolkit ${tkCur} (latest release unknown — GitHub not reachable)`);
    }

    // GSD itself: a newer release on npm?
    const have = gsdInstalled();
    if (!noUpdateCheck && have !== '' && commandOnPath('npm') !== null) {
      if (gsdStale()) gsdRefresh();
      const want = gsdCached();
      if (want === '') note(`gsd-core ${have} installed (npm not reachable — latest unknown)`);
      else if (have === want) pass(`gsd-core ${have} is the latest on npm`);
      else if (versionGt(want, have)) this.update('gsd-core', have, want, `${coreUpdateHow(gsdAgent)} (then re-check gsdt-list/gsdt-planning-repair)`);
      else note(`gsd-core ${have} installed, ahead of npm latest (${want})`);
    }

    // Notes about the toolkit checkout.
    if (exists(`${pkg}/.git`)) {
      note(`toolkit runs from a git checkout (${pkg}), not a release — install the release: ${pkg}/install.sh --reuse-install-config`);
    }
    if (chomp(git(pkg, ['status', '--porcelain']).stdout) !== '') note(`toolkit has uncommitted changes (${pkg})`);
    if (git(pkg, ['rev-parse', '--abbrev-ref', '@{u}']).status === 0) {
      const r = git(pkg, ['rev-list', '--count', '@{u}..HEAD']);
      const ahead = r.status === 0 ? chomp(r.stdout) : '0';
      if (/^[0-9]+$/.test(ahead) && Number(ahead) > 0) note(`toolkit has ${ahead} unpushed commit(s) — git push them`);
    }

    // ── is this even a GSD repo? ────────────────────────────────────────────
    const TOOLKIT_MAIN = findMain(pkg);
    let IS_GSD_REPO: boolean;
    if (isFile(`${pkg}/install.sh`) && isDir(`${pkg}/shims`) && MAIN === TOOLKIT_MAIN) {
      section('repo setup');
      note('this is the gsd-toolkit toolkit itself, not a GSD project — setup checks skipped');
      IS_GSD_REPO = false;
    } else if (
      isDir(`${MAIN}/.planning`) ||
      isFile(`${MAIN}/.gsd.conf`) ||
      isFile(`${MAIN}/scripts/gsdt-finish-worktree-feature.sh`) ||
      isFile(`${MAIN}/scripts/gsd-finish-worktree-feature.sh`)
    ) {
      IS_GSD_REPO = true;
    } else {
      section('repo setup');
      note('no .planning/, no .gsd.conf, no gsd shims — this repo does not use GSD');
      note(`set it up with:  cd ${MAIN} && gsdt-init`);
      IS_GSD_REPO = false;
    }

    let configuredList = '';
    let UI_GATES: string = 'warn';
    let HERE = MAIN;

    // ── repo setup (fixed by re-running gsdt-init) ──────────────────────────
    if (IS_GSD_REPO) {
      section('repo setup');
      const reviewProvider = confGet(MAIN, 'review_provider');
      if (providerGone(reviewProvider)) {
        fail(`review_provider = gemini: ${GSD_GEMINI_GONE}`, 'set review_provider to claude, codex, or custom in .gsd.conf', 'T060');
      } else if (reviewProvider !== '' && !providerKnown(reviewProvider)) {
        fail(`invalid review_provider '${reviewProvider}'`, 'set review_provider to claude, codex, or custom in .gsd.conf', 'T060');
      }

      // T061 — Gemini setup an older release wrote.
      let geminiLeft = '';
      if (`,${RAW_PROVIDERS},${RAW_LEGACY_PROVIDER},`.includes(',gemini,')) geminiLeft += ' providers';
      if (confGet(MAIN, 'gemini_command') + confGet(MAIN, 'gemini_model') !== '') geminiLeft += ' gemini_*-keys';
      let isLink = false;
      try {
        isLink = lstatSync(`${MAIN}/GEMINI.md`).isSymbolicLink();
      } catch {
        isLink = false;
      }
      if (!isLink && chomp(ownedBlockGet(`${MAIN}/GEMINI.md`, 'provider')) !== '') geminiLeft += ' GEMINI.md';
      const gset = readFileText(`${MAIN}/.gemini/settings.json`);
      if (gset !== null && lineList(gset).some((l) => new RegExp(`"command"${SP}*:${SP}*"[^"]*gsdt?-worktree-guard`).test(l))) {
        geminiLeft += ' .gemini/settings.json';
      }
      if (geminiLeft !== '') fail(`Gemini setup from an older gsd-toolkit:${geminiLeft} — ${GSD_GEMINI_GONE}`, 'gsdt-init --no-launch', 'T061');

      if (!MODEL_VALID) {
        fail(`invalid model configuration for ${DOCTOR_PROVIDER}`, `check ${DOCTOR_PROVIDER}_model in .gsd.conf and GSD model environment overrides`, 'T059');
      } else {
        pass(`session model: ${DOCTOR_MODEL || 'CLI default'} (model availability is checked by the provider CLI)`);
      }
      if (!PROVIDER_VALID) {
        if (!`,${RAW_PROVIDERS},${RAW_LEGACY_PROVIDER},`.includes(',gemini,')) {
          fail(`invalid provider configuration: '${RAW_PROVIDER}'`, 'edit .gsd.conf: providers = claude|codex|custom', 'T050');
        }
      } else {
        pass(`provider: ${DOCTOR_PROVIDER} (command: ${DOCTOR_COMMAND})`);
        if (PROVIDER_AVAILABLE) pass('provider executable is available');
        else fail(`provider executable '${DOCTOR_COMMAND}' is unavailable (print-only still works)`, `install ${DOCTOR_COMMAND} or set ${DOCTOR_PROVIDER}_command in .gsd.conf`, 'T051');
        const instruction = providerInstructionFile(DOCTOR_PROVIDER);
        if (providerInstructionIntegrated(MAIN, DOCTOR_PROVIDER)) pass(`${instruction} points to canonical .gsd/INSTRUCTIONS.md`);
        else fail(`${instruction} integration is missing, malformed or legacy`, 'gsdt-init --no-launch', 'T052');
        const hookstate = providerHookState(MAIN, DOCTOR_PROVIDER);
        if (hookstate === 'unsupported') note(`${DOCTOR_PROVIDER} native hook unsupported; command-level guard is the enforcement path`);
        else if (hookstate === 'present') pass(`${DOCTOR_PROVIDER} native guard hook present (defense in depth)`);
        else note(`${DOCTOR_PROVIDER} native hook ${hookstate} — inspect provider settings, then gsdt-init --no-launch`);
        if (commandGuardsActive(pkg)) pass('mandatory command-level guards are active');
        else fail('mandatory command-level guard route is incomplete', REINSTALL, 'T053');
      }

      const configured = `,${RAW_PROVIDERS || RAW_LEGACY_PROVIDER || DOCTOR_PROVIDER},`;
      configuredList = configured.replace(/^,/, '').replace(/,$/, '');
      if (RAW_LEGACY_PROVIDER !== '') {
        if (RAW_PROVIDERS !== '' && RAW_LEGACY_PROVIDER !== (RAW_PROVIDERS.split(',')[0] as string)) {
          fail(
            `legacy provider '${RAW_LEGACY_PROVIDER}' conflicts with providers default '${RAW_PROVIDERS.split(',')[0]}' and is ignored`,
            `gsdt-init --providers ${configuredList} --no-launch`,
            'T056',
          );
        } else {
          note(`legacy 'provider' key is supported but redundant — gsdt-init --providers ${configuredList} --no-launch migrates it`);
        }
      }
      for (const cp of splitComma(configuredList)) {
        if (providerGone(cp)) continue; // T061
        if (!providerKnown(cp)) {
          fail(`unknown configured provider '${cp}'`, 'edit .gsd.conf providers', 'T050');
          continue;
        }
        const res = providerResolve(MAIN, cp, '');
        if (res.ok) {
          if (commandOnPath(res.value.command) !== null) pass(`configured provider ${cp} is available as ${res.value.command}`);
          else fail(`configured provider ${cp} executable '${res.value.command}' is unavailable`, `install it, set ${cp}_command, or use print-only`, 'T057');
        } else if (!`,${configuredList},`.includes(',gemini,')) {
          fail(`configured provider ${cp} command is invalid`, `check ${cp}_command in .gsd.conf`, 'T050');
        }
        // Skills: installed, and the same as this toolkit's.
        const skillroot = providerSkillRoot(cp) ?? '';
        if (skillroot === '') {
          note(`${cp} has no installable native skill format; it runs gsdt-rules, follows .gsd/INSTRUCTIONS.md and gsdt-flow-next`);
        } else if (!isFile(`${skillroot}/gsdt-flow/SKILL.md`)) {
          note(`${cp} skills not installed — ${REINSTALL} --agent ${cp}`);
        } else {
          let staleSkills = '';
          let names: string[] = [];
          try {
            names = readdirSync(`${pkg}/skills`).filter((n) => !n.startsWith('.') && isDir(`${pkg}/skills/${n}`)).sort();
          } catch {
            names = [];
          }
          for (const sn of names) if (skillDiffers(`${pkg}/skills/${sn}/`, `${skillroot}/${sn}`)) staleSkills += ` ${sn}`;
          if (staleSkills !== '') fail(`${cp} skills differ from this toolkit (${gsdVersion()}):${staleSkills}`, `${REINSTALL} --agent ${cp}`, 'T007');
          else pass(`${cp} skills installed and current (${skillroot})`);
        }
        const configuredFile = providerInstructionFile(cp);
        if (!providerInstructionIntegrated(MAIN, cp)) fail(`${cp} instruction adapter is missing or malformed in ${configuredFile}`, 'gsdt-init --no-launch', 'T058');
      }
      for (const f of ['CLAUDE.md', 'AGENTS.md']) {
        if (!ownedMarkersValid(`${MAIN}/${f}`, 'provider')) fail(`mixed/malformed GSD instruction blocks in ${f}`, 'repair the owned marker pair, then gsdt-init --no-launch', 'T055');
        for (const p of providerInstructionMembers(`${MAIN}/${f}`)) {
          if (!configured.includes(`,${p},`)) {
            fail(`stale ${p} provider block in ${f}`, 'remove only the stale provider\'s owned entrypoint, preserving shared providers and user content', 'T054');
          }
        }
      }

      // T016 — the generated instruction text is older than this toolkit.
      let staleDocs = '';
      const canonNow = chomp(ownedBlockGet(`${MAIN}/.gsd/INSTRUCTIONS.md`, 'canonical'));
      const defProv = configuredList.split(',')[0] as string;
      if (canonNow !== '' && ownedMarkersValid(`${MAIN}/.gsd/INSTRUCTIONS.md`, 'canonical')) {
        if (canonNow !== chomp(canonicalBlock(configuredList, defProv, confBase(MAIN), confWtdir(MAIN)))) staleDocs = ' .gsd/INSTRUCTIONS.md';
      }
      const seenFiles: string[] = [];
      for (const p of splitComma(configuredList)) {
        if (!providerKnown(p)) continue;
        const f = providerInstructionFile(p);
        if (seenFiles.includes(f)) continue;
        seenFiles.push(f);
        let members = '';
        for (const m of splitComma(configuredList)) if (providerInstructionFile(m) === f) members = members === '' ? m : `${members},${m}`;
        const blockNow = chomp(ownedBlockGet(`${MAIN}/${f}`, 'provider'));
        if (blockNow === '' || !ownedMarkersValid(`${MAIN}/${f}`, 'provider')) continue;
        if (blockNow !== chomp(providerEntryBlock(members))) staleDocs += ` ${f}`;
      }
      // T062 — Claude sessions get the toolkit's rules from `gsdt-rules`.
      if (configured.includes(',claude,') && canonNow !== '') {
        const rulesBin = commandOnPath('gsdt-rules');
        const rulesHook = providerUserHookFile('claude') as string;
        if (rulesBin === null) {
          fail('gsdt-rules is not on PATH — Claude sessions get no toolkit rules', REINSTALL, 'T062');
        } else if (!rulesHookPresent(rulesHook)) {
          const man = readFileText(`${path.dirname(rulesBin)}/.gsd-install-manifest`);
          if (man !== null && lineList(man).includes('user_hook\toff')) {
            note('Claude sessions do not load gsdt-rules (installed with --no-user-hook); they follow the entry line in CLAUDE.md');
          } else {
            fail(`no Claude SessionStart hook runs gsdt-rules in ${rulesHook} — sessions miss the toolkit rules`, REINSTALL, 'T062');
          }
        } else {
          pass('Claude sessions load the toolkit rules (gsdt-rules SessionStart hook)');
        }
      }
      if (staleDocs !== '') {
        fail(`GSD instructions are older than this toolkit (${gsdVersion()}):${staleDocs} — agents follow the old rules`, 'gsdt-init --no-launch', 'T016');
      } else if (canonNow !== '') {
        pass(`GSD instructions match this toolkit (${gsdVersion()})`);
      }

      if (isFile(`${MAIN}/.gsd.conf`)) pass(`.gsd.conf (base ${confBase(MAIN)}, worktrees ${confWtdir(MAIN)})`);
      else note(`no .gsd.conf — settings are auto-detected (base ${confBase(MAIN)})`);

      // .gsd.conf: a misspelled key is silently ignored, so name it.
      if (isFile(`${MAIN}/.gsd.conf`)) this.checkConf(MAIN);

      // The base branch every claim and finish works against.
      const BASE = confBase(MAIN);
      this.base = BASE;
      if (git(MAIN, ['show-ref', '--verify', '--quiet', `refs/heads/${BASE}`]).status === 0) {
        // fine
      } else if (git(MAIN, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${BASE}`]).status === 0) {
        fail(`base branch '${BASE}' exists only on origin`, `git branch --track ${BASE} origin/${BASE}`, 'T015');
        safe('track');
      } else {
        fail(`base branch '${BASE}' does not exist — claims and finishes have nothing to work on`, 'create it, or set base = <branch> in .gsd.conf', 'T015');
      }
      if (git(MAIN, ['remote', 'get-url', 'origin']).status !== 0) {
        note("no 'origin' remote — claims and finishes stay local (fine on one machine; parallel sessions elsewhere won't see them)");
      }

      // The pre-merge gate.
      const pm = confGet(MAIN, 'premerge');
      if (pm !== 'none') {
        const pmRel = pm || 'scripts/gsdt-premerge-check.sh';
        const pmAbs = pmRel.startsWith('/') ? pmRel : `${MAIN}/${pmRel}`;
        if (exists(pmAbs) && !isExec(pmAbs)) {
          fail(`pre-merge script ${pmRel} is not executable — gsdt-finish will refuse`, `chmod +x ${pmRel} (and commit it)`, 'T019');
          safe('chmod');
          this.pmAbs = pmAbs;
        } else if (pm !== '' && !exists(pmAbs)) {
          fail(`premerge = ${pm}, but that file does not exist — gsdt-finish falls back to the tests`, 'fix premerge in .gsd.conf (or premerge = none)', 'T019');
        } else if (isExec(pmAbs)) {
          pass(`pre-merge gate: ${pmRel}`);
        }
      }

      // ── ticket tracker ────────────────────────────────────────────────────
      const trk = run(`${pkg}/bin/gsdt-tracker`, ['--repo', MAIN, 'config']);
      const TRK_CONF = trk.status === 127 ? '' : trk.stdout;
      const tkConf = (k: string): string => {
        for (const l of TRK_CONF.split('\n')) if (l.startsWith(`${k}=`)) return l.slice(k.length + 1);
        return '';
      };
      const tkWhere = (from: string, gitKey: string, confKey: string): string => (from === 'env' ? 'your environment' : from === 'git' ? `git config gsdt-tracker.${gitKey}` : `${confKey} = in .gsd.conf`);
      let TRACKER = tkConf('tracker') || 'none';
      if (tkConf('tracker_from') === 'default') TRACKER = 'none';
      if (tkConf('tracker_ok') === 'no') {
        fail(`unknown tracker '${TRACKER}'`, `set none, clickup, or custom: ${tkWhere(tkConf('tracker_from'), 'tracker', 'tracker')}`, 'T071');
      } else if (TRACKER === 'custom') {
        const tc = tkConf('command');
        if (tc !== '' && isExec(tc) && !isDir(tc)) pass(`tracker: custom (${tc})`);
        else fail(`tracker = custom but its command '${tc || '<unset>'}' is not an executable file`, `set ${tkWhere(tkConf('command_from'), 'command', 'tracker_command')} to the script and chmod +x it (see docs/trackers.md)`, 'T072');
      } else if (TRACKER === 'clickup') {
        const cuProf = tkConf('profile');
        const cuCfg = tkConf('token_file');
        if (tkConf('profile_ok') === 'no') {
          fail(`tracker profile '${cuProf}' is not a name (letters, digits, . _ -)`, `fix ${tkWhere(tkConf('profile_from'), 'profile', 'tracker_profile')} (e.g. acme)`, 'T018');
        } else if (tkConf('token') === 'env') {
          pass('tracker: clickup, token from $CLICKUP_API_TOKEN (test it: gsdt-tracker check)');
          if (cuProf !== '') note(`CLICKUP_API_TOKEN is set in your environment, so profile '${cuProf}' (${cuCfg}) is not used`);
        } else if (tkConf('token') === 'file') {
          pass(`tracker: clickup${cuProf !== '' ? ` (profile ${cuProf})` : ''}, token found (test it: gsdt-tracker check)`);
        } else {
          fail(
            `tracker = clickup but no ClickUp token${cuProf !== '' ? ` for profile '${cuProf}'` : ''} on this machine — tickets will not move`,
            `gsdt-tracker login${cuProf !== '' ? ` ${cuProf}` : ''} (or put CLICKUP_API_TOKEN=pk_… in ${cuCfg}; ClickUp → Settings → Apps)`,
            'T073',
          );
        }
        if (commandOnPath('jq') === null) note('tracker = clickup needs jq for start/finish/snapshot — brew install jq');
      } else {
        const rm = readFileText(`${MAIN}/.planning/ROADMAP.md`);
        if (rm !== null && lineList(rm).some((l) => /^#{2,4} Phase [0-9.]+:.*(^|[^a-zA-Z0-9])[cC][uU][-_][a-zA-Z0-9]{6,}/.test(l))) {
          fail('ROADMAP has ClickUp-tagged phases (cu_<id>) but tracker = none — their tickets are not updated', "add 'tracker = clickup' to .gsd.conf", 'T070');
        }
      }
      this.tracker = TRACKER;

      // The 0.10.0 rename.
      const mig = spawnSync(`${pkg}/bin/gsdt-migrate`, ['--check', '--repo', MAIN], { stdio: 'ignore' });
      if (!mig.error && mig.status === 0) pass('uses the gsdt-* command names');
      else fail('this repo still uses the old gsd-* command names (before 0.10.0) — gsdt-start and gsdt-finish refuse', 'gsdt-migrate --apply', 'T090');

      // shims
      let drift = 0;
      let missing = 0;
      for (const rel of shimFiles(`${pkg}/shims`)) {
        const dest = `${MAIN}/${rel}`;
        if (!isFile(dest)) missing++;
        else {
          let same = false;
          try {
            same = readFileSync(`${pkg}/shims/${rel}`).equals(readFileSync(dest));
          } catch {
            same = false;
          }
          if (!same) drift++;
        }
      }
      if (missing > 0 || drift > 0) fail(`shims: ${missing} missing, ${drift} out of date`, 'gsdt-init', 'T010');
      else pass('shims present and current');

      // merge-safety items
      const ps = planningStatus(MAIN);
      if (ps.missing.includes('attributes')) {
        if (ps.attrsState === 'union') fail('.gitattributes still on merge=union (keeps BOTH sides)', 'gsdt-init', 'T011');
        else fail('.gitattributes missing the .planning merge rules', 'gsdt-init', 'T012');
      } else {
        pass('.gitattributes: merge=gsd-planning on ROADMAP.md + STATE.md');
      }
      if (ps.missing.includes('driver')) fail('merge driver not registered (per-clone; git config is not versioned)', 'gsdt-init', 'T013');
      else pass('merge driver registered in git config');
      if (ps.missing.includes('hook')) fail("no post-merge hook — a plain 'git pull' is unguarded", 'gsdt-init', 'T014');
      else pass('post-merge hook reconciles .planning after a plain git pull');
      if (isDir(`${MAIN}/.husky`)) {
        const hp = chomp(git(MAIN, ['config', '--get', 'core.hooksPath']).stdout);
        if (!hp.includes('.husky')) {
          note('.husky/ exists but core.hooksPath does not point into it — git will not run .husky/post-merge until husky is installed (npm install)');
        }
      }
    }

    // ── planning state (fixed by gsdt-planning-repair) ───────────────────────
    if (IS_GSD_REPO) {
      section('planning state');
      let wsNonEmpty = false;
      try {
        wsNonEmpty = readdirSync(`${MAIN}/.planning/workstreams`).length > 0;
      } catch {
        wsNonEmpty = false;
      }
      if (!isDir(`${MAIN}/.planning`)) {
        note('no .planning/ — this repo has no GSD planning state yet');
      } else if (isDir(`${MAIN}/.planning/workstreams`) && wsNonEmpty) {
        fail(
          'gsd-core workstreams in use (.planning/workstreams/) — this toolkit only reads the top-level .planning/ and is not workstream-aware',
          '/gsd-workstreams complete <name>, or drive those phases without gsdt-start',
          'T024',
        );
      } else if (commandOnPath('gsdt-planning-repair') === null) {
        fail('gsdt-planning-repair not on PATH — cannot check .planning', REINSTALL, 'T004');
      } else {
        const rr = runMerged('gsdt-planning-repair', ['--repo', MAIN, '--check']);
        const text = chomp(rr.out);
        const ls = text.split('\n');
        switch (rr.rc) {
          case 0:
            pass('.planning is coherent');
            // the bash made these notes in a pipeline subshell: shown in the text report, never in --json
            for (const l of ls) if (l.startsWith('  - ') && !o.quiet) out(`  • ${l.slice(4)}\n`);
            if (ls.some((l) => l.startsWith('• a repair would update:'))) safe('repair');
            break;
          case 1:
            fail('.planning contradicts itself (union-merge damage)', 'gsdt-planning-repair', 'T020');
            for (const l of ls) if (l.startsWith('  • ')) out(`      ·${l.slice(3)}\n`);
            break;
          default:
            note('.planning has no ROADMAP.md — nothing to check');
        }
      }

      // Phase-checkbox bookkeeping — scoped to the checkout you are standing in.
      const topR = git(REPO, ['rev-parse', '--show-toplevel']);
      HERE = topR.status === 0 && chomp(topR.stdout) !== '' ? chomp(topR.stdout) : MAIN;
      if (!isFile(`${HERE}/.planning/ROADMAP.md`)) HERE = MAIN;
      const ROADMAP = `${HERE}/.planning/ROADMAP.md`;
      let BR = '';
      let EDIT = 'edit .planning/ROADMAP.md';
      if (HERE !== MAIN) {
        const b = git(HERE, ['branch', '--show-current']);
        BR = b.status === 0 ? chomp(b.stdout) : '';
        if (BR === '') BR = path.basename(HERE);
        EDIT = `edit .planning/ROADMAP.md in ${path.basename(HERE)}`;
      }

      // Two headings with one phase number.
      if (isFile(ROADMAP)) {
        const seen = new Map<string, number>();
        for (const l of lineList(readFileText(ROADMAP) ?? '')) {
          const m = /^#{2,4} Phase ([0-9]+(\.[0-9]+)?):.*/.exec(l);
          if (!m) continue;
          const parts = (m[1] as string).split('.');
          let n = `${asInt64(parts[0] as string)}`;
          if (parts.length > 1) n += `.${asInt64(parts[1] as string)}`;
          seen.set(n, (seen.get(n) ?? 0) + 1);
        }
        const dups = [...seen].filter(([, c]) => c > 1).map(([n]) => n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        if (dups.length > 0) fail(`ROADMAP has more than one heading for phase(s): ${dups.join(' ')}`, `${EDIT} (one '### Phase N:' heading per number)`, 'T025');
      }
      // T026 — gsd-core's opt-in bracket phase ids.
      const cj = readFileText(`${HERE}/.planning/config.json`);
      if (cj !== null && lineList(cj).some((l) => new RegExp(`"phase_id_convention"${SP}*:${SP}*"bracket"`).test(l))) {
        fail('phase_id_convention is "bracket" in .planning/config.json — gsd-toolkit reads numbered phases only', 'set phase_id_convention to null in .planning/config.json', 'T026');
      }

      if (isFile(ROADMAP)) {
        const audit = chomp(roadmapAudit(ROADMAP));
        if (BR !== '') note(`roadmap checked on '${BR}' (this worktree's own copy, not ${confBase(MAIN)}'s)`);
        if (audit === '') {
          pass('roadmap: every phase has its rows and ticks its own checkbox');
        } else {
          for (const line of audit.split('\n')) {
            const i = line.indexOf('|');
            const kind = i < 0 ? line : line.slice(0, i);
            const rest = i < 0 ? '' : line.slice(i + 1);
            const j = rest.indexOf('|');
            const a = j < 0 ? rest : rest.slice(0, j);
            const b = j < 0 ? '' : rest.slice(j + 1);
            if (kind === '') continue;
            if (kind === 'TICK') fail(`completing Phase ${a} would tick the wrong row: ${b}`, EDIT, 'T021');
            else if (kind === 'NOROW') fail(`Phase ${a} has no checklist row — completing it ticks nothing, silently`, EDIT, 'T022');
            else if (kind === 'NOPROG') fail(`Phase ${a} is missing from the Progress table`, EDIT, 'T023');
          }
          note("cross-references in a checklist row must read 'phase-13', never 'Phase 13'");
          if (BR !== '') note(`these may all clear with:  git merge ${confBase(MAIN)}`);
        }
      }

      // ── UI gates ──────────────────────────────────────────────────────────
      UI_GATES = uiGates(HERE);
      if (UI_GATES !== 'off' && uiHasScreens(HERE)) {
        section(`UI (ui_gates = ${UI_GATES})`);
        const ds = uiDesignState(HERE);
        if (ds === 'ok') pass('design system: .planning/design/DESIGN.md');
        else if (UI_GATES === 'strict') {
          fail(`phases have screens but .planning/design/DESIGN.md is ${ds} — each phase invents its own styles`, 'gsdt-ui design, then fill it with the user (in the next phase with screens)', 'T080');
        } else {
          note(`phases have screens but .planning/design/DESIGN.md is ${ds} — gsdt-ui design, then fill it (ui_gates = strict makes this a finding)`);
        }
        if (uiPlaywrightInstalled(HERE) === null) {
          note('no Playwright for gsdt-ui check (looked in the project and the global npm folder) — once per machine: npm i -g playwright && npx playwright install chromium');
        }
        if (commandOnPath('node') === null) note('no node on PATH — gsdt-ui check needs it');
        const uiStackWords = ` ${uiStack(HERE)} `;
        const addons = ['impeccable'];
        if (uiStackWords.includes(' tailwind ') || uiStackWords.includes(' shadcn ')) addons.push('shadcn-mcp');
        for (const addon of addons) {
          if (uiAddonPresent(HERE, addon)) continue;
          for (const p of splitComma(configuredList || 'claude')) {
            const tip = providerUiAddon(p, addon);
            if (tip !== null) note(`optional for ${p} — ${tip}`);
          }
        }
        // The pictures are large and change on every run: they stay local.
        const ls = git(HERE, ['ls-files', '--', '.planning/phases']);
        const dirsSet = new Set<string>();
        if (ls.status === 0) {
          for (const l of lineList(ls.stdout)) {
            if (/\/[0-9.]+-SHOTS\/[^/]*[.](png|html)$/.test(l)) dirsSet.add(l.replace(/\/[^/]*$/, ''));
          }
        }
        if (dirsSet.size > 0) {
          const shotsDirs = [...dirsSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(' ');
          if (UI_GATES === 'strict') fail(`pictures are committed in: ${shotsDirs} — they belong on disk only`, `git rm -r --cached ${shotsDirs}, then commit`, 'T081');
          else note(`pictures are committed in: ${shotsDirs} — git rm -r --cached them (ui_gates = strict makes this a finding)`);
        }
      }

      // ── phase flow (opt-in: flow = strict, ui_gates = strict) ─────────────
      this.phaseFlow(MAIN, UI_GATES);
    }

    // ── context ─────────────────────────────────────────────────────────────
    section('context');
    let ctxAgentsJson = '';
    let ctxFilesJson = '';
    for (const p of ['claude', 'codex']) {
      if (!`,${RAW_PROVIDERS || DOCTOR_PROVIDER},`.includes(`,${p},`)) continue;
      const sd = coreSkillDir(p);
      if (sd === null) continue;
      const home = agentHome(p) as string;
      const skills = sortedNames(sd)
        .filter((n) => n.startsWith('gsd-') && isDir(`${sd}/${n}`))
        .map((n) => `${sd}/${n}/SKILL.md`)
        .filter(isFile);
      const [nSk, cSk] = listingSize(skills);
      const agents = sortedNames(`${home}/agents`)
        .filter((n) => n.startsWith('gsd-') && (n.endsWith('.md') || n.endsWith('.toml')))
        .map((n) => `${home}/agents/${n}`)
        .filter(isFile);
      const [nAg, cAg] = listingSize(agents);
      pass(`${p}: ${nSk} gsd-core skills + ${nAg} agents, ${tokensFmt(cSk + cAg)} of descriptions in every session (a skill's full text loads only when it runs)`);
      const hide = coreHideable(MAIN, p)
        .filter(([g]) => g !== '')
        .map(([g, hn, hc]) => `{"group":"${jstr(g)}","skills":${hn},"tokens":${Math.floor(hc / 4)}}`)
        .join(',');
      ctxAgentsJson += `${ctxAgentsJson !== '' ? ',' : ''}{"name":"${p}","skills":${nSk},"skill_tokens":${Math.floor(cSk / 4)},"agents":${nAg},"agent_tokens":${Math.floor(cAg / 4)},"hideable":[${hide}]}`;
    }
    const bigFile = (rel: string, why: string): void => {
      let b = 0;
      try {
        b = statSync(`${MAIN}/${rel}`).size;
      } catch {
        return;
      }
      if (!(b > CONTEXT_BIG_KIB * 1024)) return;
      note(`${rel} is ${Math.floor(b / 1024)} KiB (${tokensFmt(b)}) — ${why}`);
      ctxFilesJson += `${ctxFilesJson !== '' ? ',' : ''}{"path":"${jstr(rel)}","kib":${Math.floor(b / 1024)},"tokens":${Math.floor(b / 4)},"fix":"${jstr(why)}"}`;
    };
    if (IS_GSD_REPO) {
      for (const f of ['ROADMAP.md', 'REQUIREMENTS.md', 'STATE.md', 'PROJECT.md']) {
        bigFile(`.planning/${f}`, 'GSD reads it at nearly every step; once the milestone has shipped, /gsd-complete-milestone archives it and keeps ROADMAP.md short');
      }
    }
    const provSet = `,${RAW_PROVIDERS || DOCTOR_PROVIDER},`;
    if (provSet.includes(',codex,')) {
      bigFile('AGENTS.md', 'Codex reads only the first 32 KiB by default (project_doc_max_bytes); move rarely needed parts into docs it can open');
    }
    if (provSet.includes(',claude,')) {
      note('claude: for CLAUDE.md, memory, MCP servers and plugins, run /doctor and /skill-doctor in a Claude session; /context shows the real numbers');
    }

    // ── worktree hygiene ────────────────────────────────────────────────────
    section('worktrees');
    const LOCK = `${MAIN}/.git/gsd-cmd.lock`;
    if (isDir(LOCK)) {
      const pidText = readFileText(`${LOCK}/pid`);
      const pid = pidText === null ? '' : chomp(pidText);
      if (pid !== '' && alive(pid)) note(`a gsd command is running right now (pid ${pid})`);
      else if (pid === '') {
        fail('command lock with no owner pid (a command starting now, or one that died at once)', 'rm -rf .git/gsd-cmd.lock   (only if no gsd command is running)', 'T033');
      } else {
        fail(`stale command lock from a crashed run (pid ${pid})`, 'rm -rf .git/gsd-cmd.lock', 'T030');
      }
    }

    let gone = 0;
    const liveBranches: string[] = [];
    const wtl = git(MAIN, ['worktree', 'list', '--porcelain']);
    const wtLines = wtl.status === 0 ? lineList(wtl.stdout) : [];
    for (const line of wtLines) {
      if (line.startsWith('worktree ')) {
        if (!isDir(line.slice(9))) gone++;
      } else if (line.startsWith('branch ')) liveBranches.push(line.replace(/^branch refs\/heads\//, ''));
    }
    for (const line of wtLines) {
      if (!line.startsWith('worktree ')) continue;
      const wt = line.slice(9);
      if (!(wt !== MAIN && isFile(`${wt}/.gsd-install.status`))) continue;
      const st = (readFileText(`${wt}/.gsd-install.status`) ?? '').replace(/[ \t\n\r\f\v]/g, '');
      if (st === 'fail') fail(`dependency install failed in ${path.basename(wt)} — execute-phase is blocked there`, `read ${wt}/.gsd-install.log, fix, then re-run the install in that worktree`, 'T032');
      else if (st === 'running') note(`dependency install still running in ${path.basename(wt)}`);
    }

    // T034 — worktree.baseRef = "head".
    if (IS_GSD_REPO) {
      const bad: string[] = [];
      let odd = false;
      let wt = '';
      for (const line of wtLines) {
        if (line.startsWith('worktree ')) {
          wt = line.slice(9);
          if (wt !== MAIN) continue;
        } else if (line.startsWith('branch refs/heads/phase-') || line.startsWith('branch refs/heads/batch-')) {
          if (wt === MAIN) continue;
        } else continue;
        if (!isDir(wt)) continue;
        const label = wt === MAIN ? 'main checkout' : path.basename(wt);
        const st = baseref('check', wt);
        if (st === 'missing') {
          bad.push(label);
          this.basereFix.push(wt);
        } else if (st === 'invalid') {
          odd = true;
          fail(`${wt}/.claude/settings.local.json is not plain JSON — cannot check worktree.baseRef`, 'fix the JSON in that file, then gsdt-doctor --fix', 'T034');
        } else if (st.startsWith('other:')) {
          odd = true;
          note(`worktree.baseRef = "${st.slice(6)}" in ${label} — /gsd-execute-phase runs a wave's plans one at a time unless it is "head"`);
        }
      }
      if (bad.length > 0) {
        safe('baseref');
        fail(
          `worktree.baseRef is not set (in:${bad.map((b) => ` ${b}`).join('')}) — /gsd-execute-phase runs a wave's plans one at a time there`,
          'gsdt-doctor --fix   (adds worktree.baseRef = "head" to .claude/settings.local.json; other keys kept)',
          'T034',
        );
      } else if (!odd) {
        pass('worktree.baseRef = "head" (a wave\'s plans can run in parallel)');
      }
    }

    if (gone > 0) fail(`${gone} worktree(s) recorded but missing on disk`, 'git worktree prune', 'W027');
    else pass('no stale worktree records');

    const orphans: string[] = [];
    const fe = git(MAIN, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/phase-*', 'refs/heads/batch-*']);
    for (const br of fe.status === 0 ? lineList(fe.stdout) : []) {
      if (br === '' || liveBranches.includes(br)) continue;
      orphans.push(br);
    }
    if (orphans.length > 0) fail(`phase or batch branch(es) with no worktree:${orphans.map((b) => ` ${b}`).join('')}`, 'gsdt-finish <N | branch>, or git branch -d', 'W017');
    else pass('every phase and batch branch has its worktree');

    const gu = git(MAIN, ['for-each-ref', '--format=%(refname:short) %(upstream:track)', 'refs/heads']);
    let goneUp = '';
    for (const l of gu.status === 0 ? lineList(gu.stdout) : []) {
      const f = l.replace(/^[ \t]+/, '').split(/[ \t]+/);
      if (f[1] === '[gone]') goneUp += `${f[0]} `;
    }
    if (goneUp !== '') note(`branch(es) whose upstream is gone: ${goneUp}— git fetch --prune && git branch -d <name>`);

    const BASE = confBase(MAIN);
    this.base = BASE;
    const curR = git(MAIN, ['branch', '--show-current']);
    const cur = curR.status === 0 ? chomp(curR.stdout) : '';
    if (cur === BASE) pass(`main checkout is on '${BASE}'`);
    else fail(`main checkout is on '${cur}', not '${BASE}' (gsdt-finish will refuse)`, `git checkout ${BASE}`, 'T031');

    if (git(MAIN, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${BASE}`]).status === 0) {
      const r = git(MAIN, ['rev-list', '--count', `${BASE}..origin/${BASE}`]);
      const behind = r.status === 0 ? chomp(r.stdout) : '0';
      if (/^[0-9]+$/.test(behind) && Number(behind) > 0) note(`'${BASE}' is ${behind} commit(s) behind origin as of your last fetch (no fetch is done here)`);
    }

    // ── verdict ─────────────────────────────────────────────────────────────
    if (o.json) {
      const instructionFile = providerInstructionFile(DOCTOR_PROVIDER);
      const instructionIntegrated = providerInstructionIntegrated(MAIN, DOCTOR_PROVIDER);
      const dsr = providerSkillRoot(DOCTOR_PROVIDER) ?? '';
      const skillInstalled = dsr !== '' && isFile(`${dsr}/gsdt-flow/SKILL.md`);
      const nativeHook = providerHookState(MAIN, DOCTOR_PROVIDER);
      const commandGuard = commandGuardsActive(pkg);
      const doctorConfigured = confGet(MAIN, 'providers') || DOCTOR_PROVIDER;
      const configuredJson = splitComma(doctorConfigured).map((p) => `"${jstr(p)}"`).join(',');
      let s = `{"session_model":"${jstr(DOCTOR_MODEL)}",`;
      s += `"gsd_repo":${IS_GSD_REPO ? 'true' : 'false'},`;
      s += `"context":{"agents":[${ctxAgentsJson}],"big_files":[${ctxFilesJson}]},`;
      s += `"safe":[${this.safeList.map((a) => `"${a}"`).join(',')}],`;
      s += `"repo":"${jstr(MAIN)}","configured":[${configuredJson}],"provider":{"name":"${jstr(DOCTOR_PROVIDER)}","command":"${jstr(DOCTOR_COMMAND)}","available":${PROVIDER_AVAILABLE},"instruction_file":"${jstr(instructionFile)}","instruction_integrated":${instructionIntegrated},"skill_installed":${skillInstalled},"command_guard":${commandGuard},"native_hook":"${jstr(nativeHook)}"},"count":${this.findings},"findings":[${this.jsonItems.join(',')}],"updates":[${this.updatesJson.join(',')}],"notes":[${this.notesJson.join(',')}]}\n`;
      out(s);
      return this.findings === 0 ? 0 : 1;
    }
    out('\n');
    // ── --fix: run the safe actions, then check again ───────────────────────
    if (o.fix) {
      if (this.safeList.length === 0) {
        if (this.findings !== 0) out('--fix: none of these findings has a safe automatic fix — run the commands below.\n');
      } else {
        const ordered = ['unlock', 'track', 'migrate', 'chmod', 'init', 'repair', 'baseref'].filter((a) => this.safeList.includes(a));
        out(`\x1b[1m--fix will run (in ${MAIN}):\x1b[0m\n`);
        for (const a of ordered) out(`  ${this.safeLabel(a)}\n`);
        let answer = 'n';
        if (o.yes) answer = 'y';
        else if (process.stdin.isTTY) {
          out('Run these? [y/N] ');
          answer = readLine() ?? 'n';
        } else out('(not a terminal — add --yes to run them)\n');
        if (['y', 'Y', 'yes', 'YES'].includes(answer)) {
          for (const a of ordered) {
            out(`\n▶ ${this.safeLabel(a).replace(/ +\(.*/, '')}\n`);
            if (!this.runSafe(a)) {
              out('\x1b[31m✖ that fix failed — stopping; nothing after it ran\x1b[0m\n');
              return 1;
            }
          }
          out('\n');
          out('Checking again:\n');
          const rc = runInherit(`${pkg}/bin/gsdt-doctor`, ['--quiet', '--repo', REPO]);
          out('\n');
          out('Changed files (not committed — review with git diff, then commit):\n');
          const st = git(MAIN, ['status', '--short']);
          for (const l of lineList(st.stdout)) out(`  ${l}\n`);
          return rc;
        }
        out('Nothing changed.\n');
      }
      out('\n');
    }
    if (this.findings === 0) {
      out('\x1b[32m✔ no findings\x1b[0m\n');
      if (!o.fix && this.safeList.length > 0) {
        if (o.quiet) out('(there are notes — gsdt-doctor shows them; gsdt-doctor --fix can tidy them)\n');
        else out('(gsdt-doctor --fix can tidy the notes above)\n');
      }
      return 0;
    }
    out(`\x1b[31m${this.findings} finding(s).\x1b[0m Run:\n\n`);
    const top = git('.', ['rev-parse', '--show-toplevel']);
    if ((top.status === 0 ? chomp(top.stdout) : '') !== MAIN) out(`  cd ${MAIN}\n`);
    for (const f of this.fixes) out(`  ${f}\n`);
    out('\n');
    out('(then re-run gsdt-doctor to confirm)\n');
    if (!o.fix && this.safeList.length > 0) out('Some of these are safe to run for you:  gsdt-doctor --fix\n');
    return 1;
  }

  tracker = 'none';

  /** .gsd.conf: unknown keys and bad values */
  checkConf(MAIN: string): void {
    const fail = this.fail.bind(this);
    let badKeys = '';
    let badLines = 0;
    const text = readFileText(`${MAIN}/.gsd.conf`) ?? '';
    const known = new Set([
      ...'base wtdir install test premerge flow flow_since flow_skip providers provider agent_command review_provider start_mode'.split(' '),
      ...'tracker tracker_command tracker_profile tracker_status_start tracker_status_finish'.split(' '),
      ...'ui_gates ui_url ui_min_font'.split(' '),
      ...'claude_command codex_command gemini_command custom_command claude_model codex_model gemini_model custom_model'.split(' '),
    ]);
    const trim = (s: string): string => s.replace(new RegExp(`^${SP}+`), '').replace(new RegExp(`${SP}+$`), '');
    for (const raw of lineList(text)) {
      const noComment = raw.includes('#') ? raw.slice(0, raw.indexOf('#')) : raw;
      const line = trim(noComment);
      if (line === '') continue;
      if (!line.includes('=')) {
        badLines++;
        continue;
      }
      const key = line.slice(0, line.indexOf('=')).replace(new RegExp(`${SP}+$`), '');
      if (!known.has(key)) badKeys += ` ${key}`;
    }
    if (badKeys !== '') fail(`unknown .gsd.conf key(s):${badKeys} — ignored (typo?)`, 'edit .gsd.conf (valid keys: docs/providers.md)', 'T017');
    if (badLines !== 0) fail(`.gsd.conf has ${badLines} line(s) that are not 'key = value' — ignored`, 'edit .gsd.conf', 'T017');
    let v = confGet(MAIN, 'flow');
    if (!['', 'strict', 'off', 'none'].includes(v)) fail(`flow = '${v}' is not a value (use strict, or remove it)`, 'edit .gsd.conf', 'T018');
    const phaseNum = /^[0-9]+(\.[0-9]+)?$/;
    v = confGet(MAIN, 'flow_since');
    if (v !== '' && !phaseNum.test(v)) fail(`flow_since = '${v}' is not a phase number`, 'edit .gsd.conf', 'T018');
    for (const s of words(confGet(MAIN, 'flow_skip').replace(/,/g, ' '))) {
      if (!phaseNum.test(s)) fail(`flow_skip has '${s}', which is not a phase number`, 'edit .gsd.conf (e.g. flow_skip = 13.1, 14)', 'T018');
    }
    v = confGet(MAIN, 'start_mode');
    if (!['', 'discuss', 'flow'].includes(v)) fail(`start_mode = '${v}' is not a value (use discuss or flow)`, 'edit .gsd.conf', 'T018');
    v = confGet(MAIN, 'ui_gates');
    if (!['', 'warn', 'strict', 'off'].includes(v)) fail(`ui_gates = '${v}' is not a value (use warn, strict or off)`, 'edit .gsd.conf', 'T018');
    v = confGet(MAIN, 'ui_min_font');
    if (v === '') return;
    if (/[^0-9]/.test(v)) {
      fail(`ui_min_font = '${v}' is not a number of pixels (8 to 32)`, 'edit .gsd.conf (e.g. ui_min_font = 12)', 'T018');
      return;
    }
    const n = asInt64(v);
    if (!(n >= 8n && n <= 32n)) fail(`ui_min_font = '${v}' is out of range (8 to 32) — 12 is used`, 'edit .gsd.conf (e.g. ui_min_font = 12)', 'T018');
  }

  /** the phase flow section: which MERGED phases skipped a mandatory step */
  phaseFlow(MAIN: string, UI_GATES: string): void {
    const FLOW_ON = confGet(MAIN, 'flow') === 'strict';
    const UI_ON = UI_GATES === 'strict';
    if (!((FLOW_ON || UI_ON) && isFile(`${MAIN}/.planning/ROADMAP.md`))) return;
    let flowModes = '';
    if (FLOW_ON) flowModes = 'flow = strict';
    if (UI_ON) flowModes = `${flowModes !== '' ? `${flowModes}, ` : ''}ui_gates = strict`;
    this.section(`phase flow (${flowModes})`);
    const SINCE = confGet(MAIN, 'flow_since') || '0';
    const SKIP = new Set<string>();
    for (const s of words(confGet(MAIN, 'flow_skip').replace(/,/g, ' '))) {
      const v = pn(s);
      if (v !== null) SKIP.add(v);
    }
    let debt = 0;
    let checked = 0;
    let skipped = '';
    const rm = readFileText(`${MAIN}/.planning/ROADMAP.md`) ?? '';
    for (const l of lineList(rm)) {
      const mm = /^- \[x\] \*\*Phase ([0-9]+(\.[0-9]+)?):.*/.exec(l);
      if (!mm) continue;
      const n = mm[1] as string;
      if (!(awkNum(n) >= awkNum(SINCE))) continue;
      if (SKIP.has(pn(n) ?? '\0')) {
        skipped += ` ${n}`;
        continue;
      }
      const ni = asInt64(n.split('.')[0] as string);
      const nd = n.includes('.') ? `.${n.slice(n.indexOf('.') + 1)}` : '';
      let pd = '';
      let p = '';
      outer: for (const c of [`${ni.toString().padStart(2, '0')}${nd}`, `${ni}${nd}`]) {
        for (const name of sortedNames(`${MAIN}/.planning/phases`)) {
          if (name.startsWith('.') || !name.startsWith(`${c}-`)) continue;
          if (isDir(`${MAIN}/.planning/phases/${name}`)) {
            pd = `${MAIN}/.planning/phases/${name}`;
            p = c;
            break outer;
          }
        }
      }
      if (pd === '') p = `${ni.toString().padStart(2, '0')}${nd}`;
      if (pd === '') {
        this.note(`Phase ${n}: no .planning/phases/${p}-* directory (archived?) — skipped`);
        continue;
      }
      checked++;
      const flowHas = (name: string): boolean => isFile(`${pd}/${p}-${name}`);
      let miss = '';
      let fix = '';
      if (FLOW_ON) {
        if (this.tracker !== 'none' && !flowHas('TICKET.md') && !flowHas('STORY.md')) {
          if (!pd.includes('cu_')) {
            const tk = ticketExtract(path.basename(pd));
            miss += ' ticket';
            fix += ` gsdt-tracker snapshot ${tk || '<id>'} --out ${pd.startsWith(`${MAIN}/`) ? pd.slice(MAIN.length + 1) : pd}/${p}-TICKET.md;`;
          }
        }
        if (!flowHas('REVIEW.md')) {
          miss += ' code-review';
          fix += ` /gsd-code-review ${n};`;
        }
        if (flowHas('SECURITY.md')) {
          const open = securityOpen(`${pd}/${p}-SECURITY.md`);
          if (!((open || '0') === '0')) {
            miss += ` security(${open}-open)`;
            fix += ` /gsd-secure-phase ${n};`;
          }
        } else {
          miss += ' secure-phase';
          fix += ` /gsd-secure-phase ${n};`;
        }
        if (validationProblem(pd, p, MAIN) !== null) {
          miss += ' validate';
          fix += ` /gsd-validate-phase ${n};`;
        }
        if (!flowHas('VERIFICATION.md')) {
          miss += ' verifier';
          fix += ` /gsd-execute-phase ${n} (runs the verifier);`;
        }
        if (!uatExists(pd, p)) {
          miss += ' verify-work';
          fix += ` /gsd-verify-work ${n};`;
        }
        if (uiPhaseScreens(pd, p) && !flowHas('UI-REVIEW.md')) {
          miss += ' ui-review';
          fix += ` /gsd-ui-review ${n};`;
        }
      }
      if (UI_ON && uiPhaseScreens(pd, p)) {
        if (flowHas('UI-CHECK.md')) {
          const cs = uiCheckState(MAIN, pd, p, 'nostale');
          if (cs === 'passed' || cs === 'skipped') {
            const as = uiApprovalState(pd, p);
            if (!(as === 'ok' || as === 'waived')) {
              miss += ' ui-approve';
              fix += ` gsdt-ui sheet ${n}, then with the user's yes gsdt-ui approve ${n};`;
            }
          } else {
            miss += ' ui-check';
            fix += ` gsdt-ui check ${n};`;
          }
        } else if (!flowHas('SHOTS.md')) {
          miss += ' ui-check';
          fix += ` gsdt-ui check ${n};`;
        }
      }
      if (miss !== '') {
        debt++;
        this.fail(`Phase ${n} merged without:${miss}`, `in a phase-${n} worktree:${fix.replace(/;$/, '')}`, 'T040');
      }
    }
    if (skipped !== '') this.note(`not checked (flow_skip in .gsd.conf):${skipped}`);
    if (debt === 0) this.pass(`every merged phase since ${SINCE} carries its mandatory artifacts (${checked} checked)`);
  }

  safeLabel(a: string): string {
    const MAIN = this.main;
    switch (a) {
      case 'unlock':
        return "rm -rf .git/gsd-cmd.lock          (the lock's process is gone)";
      case 'migrate':
        return 'gsdt-migrate --apply              (old gsd-* names → gsdt-*)';
      case 'track':
        return `git branch --track ${this.base} origin/${this.base}`;
      case 'chmod':
        return `chmod +x ${this.pmAbs.startsWith(`${MAIN}/`) ? this.pmAbs.slice(MAIN.length + 1) : this.pmAbs}`;
      case 'init':
        return 'gsdt-init --no-launch --no-commit  (shims, merge rules, driver, hook, instructions)';
      case 'repair':
        return 'gsdt-planning-repair               (.planning/ROADMAP.md + STATE.md)';
      case 'baseref':
        return 'worktree.baseRef = "head"         (.claude/settings.local.json, other keys kept)';
    }
    return '';
  }

  /** run one named safe action; false = it failed */
  runSafe(a: string): boolean {
    const MAIN = this.main;
    const pkg = this.pkg;
    switch (a) {
      case 'unlock': {
        // check again: the lock may have changed hands since the report
        const t = readFileText(`${MAIN}/.git/gsd-cmd.lock/pid`);
        const pid = t === null ? '' : chomp(t);
        if (pid !== '' && !alive(pid)) rmSync(`${MAIN}/.git/gsd-cmd.lock`, { recursive: true, force: true });
        return true;
      }
      case 'track':
        return git(MAIN, ['branch', '-q', '--track', this.base, `origin/${this.base}`], { inheritStderr: true }).status === 0;
      case 'chmod':
        return runInherit('chmod', ['+x', this.pmAbs]) === 0;
      case 'migrate':
        return runInherit(`${pkg}/bin/gsdt-migrate`, ['--apply', '--repo', MAIN]) === 0;
      case 'init':
        return runInherit(`${pkg}/bin/gsdt-init`, ['--no-launch', '--no-commit'], MAIN) === 0;
      case 'repair':
        return runInherit(`${pkg}/bin/gsdt-planning-repair`, ['--repo', MAIN]) === 0;
      case 'baseref':
        // each dir T034 found; gsdt-init above may have done the main one
        for (const wt of this.basereFix) {
          if (wt === '') continue;
          const line = baserefEnsure(wt);
          if (line !== '') out(`${line}\n`);
        }
        return true;
    }
    return true;
  }
}

/** the T062 test: a SessionStart hook in the user's settings runs `gsdt-rules … --hook` */
function rulesHookPresent(file: string): boolean {
  try {
    const d = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const hooks = (d as { hooks: { SessionStart: Array<{ hooks: Array<Record<string, unknown>> }> } }).hooks.SessionStart;
    for (const g of hooks) {
      for (const h of g.hooks) {
        if (h === null || typeof h !== 'object' || Array.isArray(h)) throw new Error('not an object'); // h.get(...)
        const c = 'command' in h ? (h as { command?: unknown }).command : '';
        if (typeof c !== 'string') throw new Error('not a string');
        if (c.includes('gsdt-rules') && c.includes('--hook')) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** shim files: scripts/**\/gsdt-* (regular files, not *.example), as paths under shims/ */
function shimFiles(root: string): string[] {
  const res: string[] = [];
  const walk = (rel: string): void => {
    let ents;
    try {
      ents = readdirSync(`${root}/${rel}`, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && e.name.startsWith('gsdt-') && !e.name.endsWith('.example')) res.push(r);
    }
  };
  walk('scripts');
  return res;
}

function sortedNames(dir: string): string[] {
  try {
    return readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return [];
  }
}

/** `ls "$pd/$p"-*UAT.md` finds something */
function uatExists(pd: string, p: string): boolean {
  const pre = `${p}-`;
  return sortedNames(pd).some((n) => !n.startsWith('.') && n.length >= pre.length + 6 && n.startsWith(pre) && n.endsWith('UAT.md'));
}

/** threats_open: of a SECURITY.md's front matter ('' when none) */
function securityOpen(file: string): string {
  const ls = lineList(readFileText(file) ?? '');
  let on = false;
  for (const l of ls) {
    let print = false;
    if (!on && l === '---') {
      on = true;
      print = true;
    } else if (on) {
      print = true;
      if (l === '---') on = false;
    }
    if (print) {
      const m = /^threats_open:[ \t\n\r\f\v]*(.*)$/.exec(l);
      if (m) return (m[1] as string).replace(/[ \t\n\r\f\v]/g, '');
    }
  }
  return '';
}

/** one line from stdin (null at EOF without a newline: bash's `read` then fails) */
function readLine(): string | null {
  const b = Buffer.alloc(1);
  let s = '';
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, b, 0, 1, null);
    } catch {
      return null;
    }
    if (n === 0) return null;
    if (b[0] === 10) return s;
    s += String.fromCharCode(b[0] as number);
  }
}

export function main(argv: string[]): number {
  const o: Opts = { repo: '', quiet: false, json: false, fix: false, yes: false };
  const die = (m: string): number => {
    err(`✖ ${m}\n`);
    return 1;
  };
  for (let i = 0; i < argv.length; ) {
    const a = argv[i] as string;
    switch (a) {
      case '-h':
      case '--help':
        out(usageText());
        return 0;
      case '--repo':
        if (argv.length - i < 2) return die('--repo needs a value');
        o.repo = argv[i + 1] as string;
        i += 2;
        break;
      case '--quiet':
      case '-q':
        o.quiet = true;
        i++;
        break;
      case '--json':
        o.json = true;
        o.quiet = true;
        i++;
        break;
      case '--fix':
      case '-f':
        o.fix = true;
        i++;
        break;
      case '--yes':
      case '-y':
        o.yes = true;
        i++;
        break;
      default:
        return die(`unknown argument: ${a} (see gsdt-doctor --help)`);
    }
  }
  try {
    return new Doctor(o).run();
  } catch (e) {
    if (e instanceof Quit) return e.code;
    throw e;
  }
}
