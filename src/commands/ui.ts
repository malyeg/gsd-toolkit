// gsdt-ui — the UI quality steps gsdt-flow-next asks for in a phase with screens
// (port of the bash bin/gsdt-ui; the help text is the header comment of
// bin/gsdt-ui, read at run time like the bash `usage` did).
//
// Subcommands: design, layout, check, look, approve, sheet, shots, status.
// `check` runs the browser runner as a child process (GSD_UI_RUNNER, else
// `node src/launch.mjs ui-check job.tsv`) and publishes its run folder only
// when the run finished — see the invariant in CLAUDE.md: a check that could
// not run records status: error and never leaves an older pass behind.
//
// Bash quirks kept on purpose:
//  - a phase folder is the first `<cand>-*` directory in byte order;
//  - `pages:` entries are split on commas and blanks (no globbing);
//  - the stub runner is run as a command: a missing/non-executable file gives
//    rc 127/126 and a bash-style line in the run's err.txt.
import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { commandOnPath, confGet, git, gsdPkg, isDir, isFile } from '../common.ts';
import {
  UI_WIDTHS,
  uiApprovalState,
  uiCheckList,
  uiCheckState,
  uiDesignState,
  uiExempt,
  uiFields,
  uiFm,
  uiField,
  uiGate,
  uiGates,
  uiGlobalRoot,
  uiInputsState,
  uiLayoutState,
  uiLayoutTemplate,
  uiLookAnswers,
  uiLookKeys,
  uiLookState,
  uiMinFont,
  uiPageHash,
  uiPlaywright,
  uiRules,
  uiScaffoldDesign,
  uiShotsState,
} from '../ui.ts';

class Quit extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

const SUBS = 'design, layout, check, look, approve, sheet, shots, status';
const out = (s: string): void => void process.stdout.write(s);
const err = (s: string): void => void process.stderr.write(s);
const echo = (s: string): void => out(`${s}\n`);

function die(msg: string): never {
  err(`✖ ${msg}\n`);
  throw new Quit(1);
}

/** the header comment of bin/gsdt-ui up to its `set -euo` line, `# ` stripped (bash `usage`) */
export function usageText(pkg: string = gsdPkg()): string {
  let t = '';
  try {
    t = readFileSync(path.join(pkg, 'bin', 'gsdt-ui'), 'utf8');
  } catch {
    return '';
  }
  const ls = t.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  let o = '';
  for (let i = 1; i < ls.length; i++) {
    const l = ls[i] as string;
    if (/^set -euo/.test(l)) break;
    o += `${l.replace(/^# ?/, '')}\n`;
  }
  return o;
}

/** now() — `date -u +%Y-%m-%dT%H:%M:%SZ` */
export function now(): string {
  return `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`;
}

/** one_line — newlines, returns and tabs → blanks, first 300 characters */
export function oneLine(s: string): string {
  return Array.from(s.replace(/[\n\r\t]/g, ' ')).slice(0, 300).join('');
}

/** `cmd | sort -u` over base ports found in package.json dev scripts (depth ≤ 3, not in node_modules) */
export function derivePortBases(repoDir: string): string[] {
  const found = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (depth < 3 && e.name !== 'node_modules') walk(full, depth + 1);
      } else if (e.name === 'package.json' && e.isFile()) {
        let t = '';
        try {
          t = readFileSync(full, 'latin1');
        } catch {
          continue;
        }
        for (const l of t.split('\n')) {
          for (const m of l.matchAll(/gsdt-derive-port(?:\.sh)?[ \t\v\f\r]+[0-9]+/g)) {
            const d = /[0-9]+$/.exec(m[0]);
            if (d) found.add(d[0]);
          }
        }
      }
    }
  };
  walk(repoDir, 1);
  return [...found].sort();
}

type UrlResult = { ok: true; url: string } | { ok: false; error: string };

/** resolve_url — the app address of this phase (`int` = the phase's integer part); checks that it answers */
export function resolveUrl(repoDir: string, layout: string, int: number, probe = true): UrlResult {
  let url = uiField(layout, 'url');
  let from = `url: in ${path.basename(layout)}`;
  if (url === '') {
    url = confGet(repoDir, 'ui_url');
    from = 'ui_url in .gsd.conf';
  }
  if (url === '') {
    url = 'http://localhost:{port}';
    from = 'default';
  }
  if (/\{port:.*\}/.test(url)) {
    const m = /.*\{port:([0-9]+)\}.*/.exec(url);
    if (!m) return { ok: false, error: `${from} has a bad {port:<number>} slot: ${url}` };
    url = url.replace(/\{port:[0-9]+\}/, String(Number(m[1]) + int));
  } else if (url.includes('{port}')) {
    const bases = derivePortBases(repoDir);
    if (bases.length === 0) {
      return {
        ok: false,
        error: `can't tell the app's port: no 'gsdt-derive-port.sh <base>' in a package.json dev script.
  Set it in ${path.basename(layout)}, e.g.:  url: http://localhost:{port:3000}
  (or for every phase, in .gsd.conf:  ui_url = http://localhost:{port:3000})`,
      };
    }
    if (bases.length !== 1) {
      return { ok: false, error: `several base ports in package.json files (${bases.join(' ')}) — say which app this phase uses, in ${path.basename(layout)}:  url: http://localhost:{port:<base>}` };
    }
    url = url.replace('{port}', String(Number(bases[0]) + int));
  }
  const u = url.endsWith('/') ? url.slice(0, -1) : url;
  if (probe) {
    const r = spawnSync('curl', ['-s', '-o', '/dev/null', '--max-time', '5', `${u}/`], { stdio: 'ignore' });
    if (r.status !== 0) return { ok: false, error: `nothing answers at ${u} — start the app (e.g. npm run dev in this worktree), then re-run` };
  }
  return { ok: true, url: u };
}

/** the LAYOUT pages, each with a leading / */
export function layoutPages(layout: string): string[] {
  return uiField(layout, 'pages')
    .replace(/,/g, ' ')
    .split(/[ \t\n]+/)
    .filter((p) => p !== '')
    .map((p) => (p.startsWith('/') ? p : `/${p}`));
}

/** the job file the runner reads (tab-separated key/value lines) */
export function jobText(o: {
  repo: string; run: string; shotsDir: string; n: string; p: string; url: string; layout: string;
  minFont: number; strict: boolean; code: string; sketch: string; budget: string; globalRoot: string;
  approot: string; approotFrom: string; axe: string; axeVer: string; pages: string[];
  mainButton: string[]; expect: string[]; waive: string[];
}): string {
  let t = `repo\t${o.repo}\nout\t${o.run}\npublish\t${o.shotsDir}\nphase\t${o.n}\nprefix\t${o.p}\nurl\t${o.url}\n`;
  t += `layout\t${path.basename(o.layout)}\nshots\t${path.basename(o.shotsDir)}\nminfont\t${o.minFont}\nstrict\t${o.strict ? 1 : 0}\n`;
  t += `code\t${o.code}\nsketch\t${o.sketch}\n`;
  if (o.budget !== '') t += `budget\t${o.budget}\n`;
  t += `globalroot\t${o.globalRoot}\n`;
  if (o.approot !== '') t += `approot\t${o.approot}\napproot_from\t${o.approotFrom}\n`;
  if (o.axe !== '') t += `axe\t${o.axe}\naxever\t${o.axeVer}\n`;
  for (const k of ['page', 'main_button', 'expect', 'waive'] as const) {
    const v = k === 'page' ? o.pages : k === 'main_button' ? o.mainButton : k === 'expect' ? o.expect : o.waive;
    for (const x of v) t += `${k}\t${x}\n`;
  }
  return t;
}

function removePictures(dir: string): void {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) if (e.isFile() && (e.name.endsWith('.png') || e.name === 'index.html')) rmSync(`${dir}/${e.name}`, { force: true });
}

function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}

const readTrim = (f: string): string | null => {
  try {
    return readFileSync(f, 'utf8').replace(/\n+$/, '');
  } catch {
    return null;
  }
};

/** the last three lines of a file, like `tail -3` (newlines at the end dropped) */
function tail3(f: string): string {
  const t = readTrim(f);
  if (t === null) return '';
  return t.split('\n').slice(-3).join('\n');
}

export async function main(argv: string[]): Promise<number> {
  try {
    return run(argv);
  } catch (e) {
    if (e instanceof Quit) return e.code;
    throw e;
  }
}

function run(argv: string[]): number {
  const pkg = gsdPkg();
  const usage = (): string => usageText(pkg);
  const sub = argv[0] ?? '';
  const args = argv.slice(1);
  switch (sub) {
    case '-h':
    case '--help':
    case 'help':
      out(usage());
      return 0;
    case 'design':
    case 'layout':
    case 'check':
    case 'look':
    case 'approve':
    case 'sheet':
    case 'shots':
    case 'status':
      break;
    case '':
      err(usage());
      return 64;
    default:
      die(`unknown subcommand: ${sub} (${SUBS})`);
  }
  let N = '';
  let REPO = '';
  let SKIP = '';
  let skipping = false;
  let WAIVE = '';
  let waiving = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    switch (a) {
      case '--repo':
        if (args.length - i < 2) die('--repo needs a path');
        REPO = args[++i] as string;
        break;
      case '--skip':
        if (args.length - i < 2 || args[i + 1] === '') die('--skip needs a reason');
        SKIP = args[++i] as string;
        skipping = true;
        break;
      case '--waive':
        if (args.length - i < 2 || args[i + 1] === '') die('--waive needs a reason');
        WAIVE = args[++i] as string;
        waiving = true;
        break;
      case '-h':
      case '--help':
        out(usage());
        return 0;
      default:
        if (a.startsWith('-')) die(`unknown option: ${a}`);
        N = a;
    }
  }
  if (sub !== 'check' && sub !== 'shots' && skipping) die('--skip goes with check or shots');
  if (waiving && sub !== 'approve') die('--waive goes with approve');
  const top = git(REPO !== '' ? REPO : process.cwd(), ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) die('not inside a git repo');
  const repoDir = top.stdout.replace(/\n+$/, '');

  if (sub === 'design') {
    const had = uiDesignState(repoDir);
    uiScaffoldDesign(repoDir);
    if (had === 'missing') {
      echo('✔ .planning/design/DESIGN.md (stub) and .planning/design/refs/ created');
      echo('  Next: agree the design system with the user, fill each section, then delete the stub line.');
    } else if (had === 'stub') {
      echo('• .planning/design/DESIGN.md is still the stub — fill it with the user, then delete the stub line');
    } else {
      echo('✔ .planning/design/DESIGN.md is filled');
    }
    return 0;
  }

  // ── per-phase subcommands ─────────────────────────────────────────────────
  if (N === '') {
    const br = git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.replace(/\n+$/, '');
    const m = /^phase-([0-9]+(\.[0-9]+)?).*/.exec(br.split('\n')[0] as string);
    N = m ? (m[1] as string) : '';
    if (N === '') die(`no phase number given and '${br}' is not a phase-<N>-* branch`);
  }
  if (!/^[0-9]+(\.[0-9]+)?$/.test(N)) die(`invalid phase number: ${N}`);
  const int = Number(N.split('.')[0]);
  const pad = (v: number): string => String(v).padStart(2, '0');
  const cands = N.includes('.') ? [N, `${pad(int)}.${N.slice(N.indexOf('.') + 1)}`] : [pad(int), String(int)];
  let PD = '';
  let P = '';
  find: for (const c of cands) {
    let names: string[] = [];
    try {
      names = readdirSync(`${repoDir}/.planning/phases`).filter((n) => n.startsWith(`${c}-`)).sort();
    } catch {
      names = [];
    }
    for (const n of names) {
      const d = `${repoDir}/.planning/phases/${n}`;
      if (isDir(d)) {
        PD = d;
        P = c;
        break find;
      }
    }
  }
  if (PD === '') die(`no .planning/phases/<${N}>-* folder in ${repoDir}`);
  const LAYOUT = `${PD}/${P}-LAYOUT.md`;
  const SHOTS_MD = `${PD}/${P}-SHOTS.md`;
  const SHOTS_DIR = `${PD}/${P}-SHOTS`;
  const CHECK_MD = `${PD}/${P}-UI-CHECK.md`;
  const LOOK_MD = `${PD}/${P}-UI-LOOK.md`;
  const APPROVAL_MD = `${PD}/${P}-UI-APPROVAL.md`;
  const rel = (f: string): string => (f.startsWith(`${repoDir}/`) ? f.slice(repoDir.length + 1) : f);

  const clearPictures = (): void => {
    if (!isDir(SHOTS_DIR)) return;
    removePictures(SHOTS_DIR);
    rmSync(`${SHOTS_DIR}/.run`, { recursive: true, force: true });
  };
  const checkRecord = (status: string, key: string, text: string): void => {
    let t = `---\nstatus: ${status}\ntaken: ${now()}\n${key}: ${oneLine(text)}\n---\n\n# Phase ${N} UI check\n\n`;
    t +=
      status === 'skipped'
        ? `The rendered pages were not checked. The user accepted that:\n\`gsdt-ui approve ${N} --waive "<reason>"\` records it.\n`
        : `The check could not run, so nothing is known about the pages.\nFix the cause, then run \`gsdt-ui check ${N}\` again.\n`;
    writeFileSync(CHECK_MD, t);
  };
  const cannotRun = (msg: string): never => {
    clearPictures();
    checkRecord('error', 'error', msg);
    err(`✖ ${msg}\n`);
    err(`  recorded in ${rel(CHECK_MD)} (status: error)\n  if the pages cannot be checked at all, ask the user, then: gsdt-ui check ${N} --skip "<reason>"\n`);
    throw new Quit(2);
  };

  switch (sub) {
    case 'layout':
      if (isFile(LAYOUT)) {
        echo(`• ${rel(LAYOUT)} already exists — state: ${uiLayoutState(repoDir, PD, P)}`);
        return 0;
      }
      uiLayoutTemplate(LAYOUT, N);
      echo(`✔ ${rel(LAYOUT)} created`);
      echo('  Next: /gsd-sketch the main screen, let the user pick the winner, then fill');
      echo('        sketch: .planning/sketches/<NNN-name>   and   pages: /path, /other/path');
      echo('        main_button: /path = <button text>      (one line per page; or none)');
      return 0;

    case 'status': {
      out(`ui_gates    ${uiGates(repoDir)}\n`);
      out(`design      ${uiDesignState(repoDir)}  (.planning/design/DESIGN.md)\n`);
      out(`layout      ${uiLayoutState(repoDir, PD, P)}  (${rel(LAYOUT)})\n`);
      out(`check       ${uiCheckState(repoDir, PD, P)}  (${rel(CHECK_MD)})\n`);
      out(`look        ${uiLookState(repoDir, PD, P)}  (${rel(LOOK_MD)})\n`);
      out(`approval    ${uiApprovalState(PD, P)}  (${rel(APPROVAL_MD)})\n`);
      if (isFile(SHOTS_MD)) out(`screenshots ${uiShotsState(PD, P)}  (${rel(SHOTS_MD)}, gsdt-ui shots)\n`);
      if (uiExempt(repoDir, PD, P)) out('open        nothing — the UI review of this phase is already on the base branch\n');
      else {
        const gate = uiGate(repoDir, PD, P);
        if (gate !== '') out(`open        ${gate.slice(0, gate.indexOf('|') < 0 ? gate.length : gate.indexOf('|'))}: ${gate.slice(gate.lastIndexOf('|') + 1)}\n`);
        else out('open        nothing\n');
      }
      return 0;
    }

    case 'check':
      return doCheck();
    case 'look':
      return doLook();
    case 'approve':
      return doApprove();

    case 'sheet': {
      if (!isFile(`${SHOTS_DIR}/index.html`)) die(`no sheet yet — run: gsdt-ui check ${N}`);
      echo(`${SHOTS_DIR}/index.html`);
      if (process.stdout.isTTY) {
        const opener = commandOnPath('open') ? 'open' : commandOnPath('xdg-open') ? 'xdg-open' : '';
        if (opener !== '') spawnSync(opener, [`${SHOTS_DIR}/index.html`], { stdio: 'ignore' });
      }
      return 0;
    }

    default:
      return doShots();
  }

  function doCheck(): number {
    if (skipping) {
      clearPictures();
      checkRecord('skipped', 'skipped', SKIP);
      echo(`✔ ${rel(CHECK_MD)} records the skip: ${SKIP}`);
      echo(`  Next, with the user's yes: gsdt-ui approve ${N} --waive "<reason>"`);
      return 0;
    }
    const pages = layoutPages(LAYOUT);
    if (pages.length === 0) die(`no pages: in ${rel(LAYOUT)} — list the URL paths to check (run: gsdt-ui layout ${N})`);
    mkdirSync(SHOTS_DIR, { recursive: true });
    // The pictures stay local (large, change every run); UI-CHECK.md is the record.
    if (!isFile(`${SHOTS_DIR}/.gitignore`)) writeFileSync(`${SHOTS_DIR}/.gitignore`, '*\n');
    const tracked = git(repoDir, ['ls-files', '--', SHOTS_DIR]).stdout.split('\n').find((l) => /\.(png|html)$/.test(l));
    if (tracked) err(`⚠ pictures in ${rel(SHOTS_DIR)}/ are committed — they should stay local: git rm -r --cached "${rel(SHOTS_DIR)}"\n`);

    const RUNNER = process.env.GSD_UI_RUNNER ?? '';
    if (RUNNER === '') {
      if (commandOnPath('node') === null) cannotRun("node is not installed — gsdt-ui check runs the project's Playwright with Node");
      if (!isFile(`${pkg}/src/commands/ui-check.ts`)) cannotRun('src/commands/ui-check.ts is missing from the toolkit — reinstall it (gsdt-update)');
    }
    const u = resolveUrl(repoDir, LAYOUT, int);
    if (!u.ok) cannotRun(u.error);
    const URL = (u as { ok: true; url: string }).url;

    const RUN = `${SHOTS_DIR}/.run`;
    rmSync(RUN, { recursive: true, force: true });
    mkdirSync(RUN, { recursive: true });
    let approot = process.env.GSD_PLAYWRIGHT_ROOT ?? '';
    let approotFrom = 'GSD_PLAYWRIGHT_ROOT';
    if (approot === '') {
      approot = uiField(LAYOUT, 'app');
      approotFrom = `app: in ${path.basename(LAYOUT)}`;
    }
    const strict = uiGates(repoDir) === 'strict';
    const axe = `${pkg}/lib/vendor/axe-core/axe.min.js`;
    const axeOn = isFile(axe);
    writeFileSync(
      `${RUN}/job.tsv`,
      jobText({
        repo: repoDir, run: RUN, shotsDir: SHOTS_DIR, n: N, p: P, url: URL, layout: LAYOUT,
        minFont: uiMinFont(repoDir), strict, code: uiInputsState(repoDir, PD, P), sketch: uiField(LAYOUT, 'sketch'),
        budget: process.env.GSD_UI_BUDGET_MS ?? '', globalRoot: uiGlobalRoot(), approot, approotFrom,
        axe: axeOn ? axe : '',
        axeVer: axeOn ? (readTrim(`${pkg}/lib/vendor/axe-core/VERSION`) ?? '').replace(/[ \t\n\r\f\v]/g, '') : '',
        pages, mainButton: uiFields(LAYOUT, 'main_button'), expect: uiFields(LAYOUT, 'expect'), waive: uiFields(LAYOUT, 'waive'),
      }),
    );

    echo(`▶ checking ${pages.length} page(s) at ${URL} (3 widths each)…`);
    const rc0 = runRunner(RUNNER, RUN, pkg);
    let rc = rc0;
    if ((rc === 0 || rc === 1) && !isFile(`${RUN}/UI-CHECK.md`)) rc = 2;
    if (rc !== 0 && rc !== 1) {
      let why = readTrim(`${RUN}/error.txt`) ?? '';
      if (why === '') why = tail3(`${RUN}/err.txt`);
      cannotRun(why !== '' ? why : `the runner stopped (exit ${rc}) and wrote no report`);
    }
    // Publish: only a complete run replaces the last pictures and report.
    removePictures(SHOTS_DIR);
    for (const e of readdirSync(RUN, { withFileTypes: true })) {
      if (e.isFile() && (e.name.endsWith('.png') || e.name === 'index.html')) move(`${RUN}/${e.name}`, `${SHOTS_DIR}/${e.name}`);
    }
    move(`${RUN}/UI-CHECK.md`, CHECK_MD);
    rmSync(RUN, { recursive: true, force: true });
    const fm = (k: string): string => uiFm(CHECK_MD, k);
    if (rc === 0) {
      echo(`✔ passed — capture ${fm('capture')}: ${fm('waived')} waived, ${fm('questions')} question(s), ${fm('unchecked')} not checked`);
      echo(`  report: ${rel(CHECK_MD)}    sheet: ${rel(SHOTS_DIR)}/index.html`);
      echo(`  Next: gsdt-ui look ${N}`);
    } else {
      echo(`✖ failed — ${fm('failures')} problem(s), ${fm('unchecked')} not checked:`);
      for (const l of uiCheckList(CHECK_MD, 'Failures').slice(0, 20)) echo(`  - ${l}`);
      if (strict) for (const l of uiCheckList(CHECK_MD, 'Not checked').slice(0, 10)) echo(`  - not checked: ${l}`);
      echo(`  report: ${rel(CHECK_MD)}    sheet: ${rel(SHOTS_DIR)}/index.html`);
      echo(`  Fix the page and run gsdt-ui check ${N} again. A finding the user accepts: a waive: line in ${rel(LAYOUT)}.`);
    }
    return rc;
  }

  function doLook(): number {
    const cs = uiCheckState(repoDir, PD, P);
    switch (cs) {
      case 'passed':
        break;
      case 'stale':
        die(`the code or ${path.basename(LAYOUT)} changed after the last check — run: gsdt-ui check ${N}`);
      // falls through (die throws)
      case 'skipped':
        die(`the check was skipped, so there are no pictures to look at — next: gsdt-ui approve ${N} --waive "<reason>"`);
      case 'failed':
        die(`the check failed — fix the page first (see ${rel(CHECK_MD)}), then: gsdt-ui check ${N}`);
      default:
        die(`no passed check yet — run: gsdt-ui check ${N}`);
    }
    const cap = uiFm(CHECK_MD, 'capture');
    if (isFile(LOOK_MD) && uiFm(LOOK_MD, 'capture') === cap) {
      echo(`• ${rel(LOOK_MD)} is for this capture (${cap}) — state: ${uiLookState(repoDir, PD, P)}`);
      return 0;
    }
    const old = uiLookAnswers(LOOK_MD);
    const was = (k: string): string => {
      for (const l of old) {
        const f = l.split('|');
        if (`${f[0]}|${f[1]}|${f[2]}` === k) {
          const t = f.slice(4).join('|');
          return `${f[3]} — ${t}`;
        }
      }
      return '';
    };
    const shotsBase = path.basename(SHOTS_DIR);
    const rules = uiRules(repoDir);
    let t = `---\ncapture: ${cap}\n---\n\n# Phase ${N} UI look\n\n`;
    t += 'Open each picture below and answer every line after its colon with one of:\n\n';
    t += '    ok — <what you saw>          fixed — <what was wrong, what changed>\n';
    t += '    bad — <what is wrong>        n/a — <why the rule does not apply>\n\n';
    t += `An answer needs its text. \`bad\` keeps the step open: fix the page, run\n\`gsdt-ui check ${N}\` again, then \`gsdt-ui look ${N}\`. Keep the \`## \` and \`- R1:\` parts as they are.\n\n`;
    t += '## Rules\n\n';
    for (const r of rules) t += `${r.replace(/^(R[0-9]+)\|/, '$1 — ')}\n`;
    const questions = uiCheckList(CHECK_MD, 'Questions').map((l) => l.split(' | '));
    for (const line of uiCheckList(CHECK_MD, 'Shots')) {
      const f = line.split(' | ');
      const page = f[0] ?? '';
      const w = f[1] ?? '';
      const file = f[2] ?? '';
      t += `\n## ${page} at ${w}px\n\npicture: ${shotsBase}/${file}\n\n`;
      for (const r of rules.map((x) => x.split('|')[0] as string)) {
        t += `- ${r}: \n`;
        const w0 = was(`${page}|${w}|${r}`);
        if (w0 !== '') t += `  was: ${w0}\n`;
      }
      for (const q of questions) {
        if (q[1] !== page || q[2] !== w) continue;
        const tx = q.slice(4).join(' | ');
        // `IFS=$'\t' read -r q qc qt`: tabs collapse, the last name keeps the rest
        let rest = `${q[0] ?? ''}\t${q[3] ?? ''}\t${tx}`.replace(/^\t+/, '');
        const take = (): string => {
          const i = rest.indexOf('\t');
          const v = i < 0 ? rest : rest.slice(0, i);
          rest = i < 0 ? '' : rest.slice(i).replace(/^\t+/, '');
          return v;
        };
        const qid = take();
        const qc = take();
        const qt = rest.replace(/\t+$/, '');
        t += `- ${qid}: \n`;
        const w0 = was(`${page}|${w}|${qid}`);
        if (w0 !== '') t += `  was: ${w0}\n`;
        t += `  asks (${qc}): ${qt}\n`;
      }
    }
    writeFileSync(LOOK_MD, t);
    echo(`✔ ${rel(LOOK_MD)} created for capture ${cap}: ${uiLookKeys(repoDir, PD, P).length} line(s) to answer`);
    echo(`  Open each picture in ${rel(SHOTS_DIR)}/ and answer every line; then commit the file.`);
    return 0;
  }

  function doApprove(): number {
    const who = git(repoDir, ['config', 'user.name']).stdout.replace(/\n+$/, '') || 'unknown';
    if (waiving) {
      writeFileSync(
        APPROVAL_MD,
        `---\nstatus: waived\nreason: ${oneLine(WAIVE)}\nby: ${who}\napproved: ${now()}\ncapture: ${uiFm(CHECK_MD, 'capture')}\n---\n\n# Phase ${N} UI approval\n\nThe user chose not to look at the pages of this phase.\n`,
      );
      echo(`✔ ${rel(APPROVAL_MD)} records the waiver: ${WAIVE}`);
      return 0;
    }
    const gate = uiGate(repoDir, PD, P);
    const step = gate.includes('|') ? gate.slice(0, gate.indexOf('|')) : gate;
    if (step === 'ui-check' || step === 'ui-look') {
      die(`not ready for approval — ${gate.slice(gate.lastIndexOf('|') + 1)}
  (if the user does not want to look: gsdt-ui approve ${N} --waive "<reason>")`);
    }
    if (uiCheckState(repoDir, PD, P) !== 'passed') die(`the check was skipped, so there are no pictures to approve — gsdt-ui approve ${N} --waive "<reason>"`);
    const cap = uiFm(CHECK_MD, 'capture');
    writeFileSync(
      APPROVAL_MD,
      `---\nstatus: approved\ncapture: ${cap}\nby: ${who}\napproved: ${now()}\n---\n\n# Phase ${N} UI approval\n\nThe user looked at the sheet of capture ${cap} and said yes.\n`,
    );
    echo(`✔ ${rel(APPROVAL_MD)} records the approval of capture ${cap}`);
    return 0;
  }

  function doShots(): number {
    if (skipping) {
      writeFileSync(SHOTS_MD, `# Phase ${N} screenshots\n\nskipped: ${SKIP}\n`);
      echo(`✔ ${rel(SHOTS_MD)} records the skip: ${SKIP}`);
      return 0;
    }
    const pages = layoutPages(LAYOUT);
    if (pages.length === 0) die(`no pages: in ${rel(LAYOUT)} — list the URL paths to shoot (run: gsdt-ui layout ${N})`);
    const PW = uiPlaywright(repoDir, uiField(LAYOUT, 'app'));
    if (PW === '') {
      die(`Playwright CLI not found. Install it in the app: npm i -D playwright && npx playwright install chromium
  (or: gsdt-ui shots ${N} --skip "<reason>")`);
    }
    const u = resolveUrl(repoDir, LAYOUT, int);
    if (!u.ok) die(`${u.error}\n  (or: gsdt-ui shots ${N} --skip "<reason>")`);
    const URL = (u as { ok: true; url: string }).url;
    mkdirSync(SHOTS_DIR, { recursive: true });
    if (!isFile(`${SHOTS_DIR}/.gitignore`)) writeFileSync(`${SHOTS_DIR}/.gitignore`, '*\n');
    let list = '';
    let n = 0;
    for (const page of pages) {
      const slug = page.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/-$/, '') || 'home';
      for (const w of UI_WIDTHS.split(' ')) {
        const h = w === '375' ? 812 : w === '768' ? 1024 : 900;
        const name = `${slug}-${w}-${uiPageHash(page)}.png`;
        const r = spawnSync(PW, ['screenshot', `--viewport-size=${w},${h}`, '--full-page', `${URL}${page}`, `${SHOTS_DIR}/${name}`], { stdio: 'ignore' });
        if (r.status !== 0) die(`screenshot failed: ${URL}${page} at ${w}px (try: ${PW} screenshot ${URL}${page} /tmp/x.png)`);
        list += `- ${path.basename(SHOTS_DIR)}/${name} — ${page} at ${w}px\n`;
        n++;
      }
    }
    let t = `# Phase ${N} screenshots\n\n`;
    t += `taken: ${now()}\nurl: ${URL}\nsketch: ${uiField(LAYOUT, 'sketch')}\n\n`;
    t += `The PNGs are local (not committed). Pictures only: \`gsdt-ui check ${N}\`\nmeasures the pages and is the step gsdt-flow-next asks for.\n\n`;
    t += list;
    writeFileSync(SHOTS_MD, t);
    echo(`✔ ${n} screenshot(s) in ${rel(SHOTS_DIR)}/, recorded in ${rel(SHOTS_MD)}`);
    return 0;
  }
}

/** run the runner with stdout/stderr in the run folder; returns its exit code (bash `$?`) */
function runRunner(runner: string, runDir: string, pkg: string): number {
  const outFd = openSync(`${runDir}/out.txt`, 'w');
  const errFd = openSync(`${runDir}/err.txt`, 'w');
  try {
    const job = `${runDir}/job.tsv`;
    const stdio: ['inherit', number, number] = ['inherit', outFd, errFd];
    let r = runner !== ''
      ? spawnSync(runner, [job], { stdio })
      : spawnSync(process.execPath, [`${pkg}/src/launch.mjs`, 'ui-check', job], { stdio });
    if (runner !== '' && r.error && (r.error as NodeJS.ErrnoException).code === 'ENOEXEC') r = spawnSync('bash', [runner, job], { stdio });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR' || code === 'ELOOP') {
        const why = code === 'EACCES' ? 'Permission denied' : 'No such file or directory';
        const msg = `${pkg}/bin/gsdt-ui: line 242: ${runner}: ${why}\n`;
        writeFileSync(`${runDir}/err.txt`, msg);
        return code === 'EACCES' ? 126 : 127;
      }
      return 1;
    }
    if (r.status !== null) return r.status;
    const sig = r.signal ? ((osConstants.signals as Record<string, number>)[r.signal] ?? 0) : 0;
    return 128 + sig;
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}


