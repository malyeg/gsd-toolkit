// P4 parity (gsdt-ui): the TypeScript command behind bin/gsdt-ui against the
// pre-P4 bash command (tests/fixtures/p4-old-bins/gsdt-ui, run in a package dir
// holding a copy of lib/ and the old runner as lib/ui-check.mjs). Two worlds
// (old, new) get identical fixture repos and the SAME sequence of steps; after
// every step stdout, stderr, the exit code and every file in the repo (minus
// .git) plus the stub's call log and the last job file must match.
//
// Normalized before comparing: the world's root dir (→ <W>), the package dirs
// (→ <PKG>) and ISO timestamps (→ <TS>). Nothing else.
// The runner is always the stub (GSD_UI_RUNNER); the real runner has its own
// suite (tests/test-ui-browser.sh, tests/ts/p4-ui.test.ts for its helpers).
// Run: node --test tests/ts/p4-ui-command.test.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { PKG, repo, sh, tmp, write } from './helpers.ts';

const NEW_BIN = path.join(PKG, 'bin', 'gsdt-ui');
const FIX = path.join(PKG, 'tests', 'fixtures', 'p4-old-bins');

type World = { name: 'old' | 'new'; root: string; app: string; pd: string; stub: string; bin: string; pkg: string };
type EnvVal = string | undefined | ((w: World) => string | undefined);
type Step = {
  label: string;
  argv: string[];
  pre?: (w: World) => void;
  env?: Record<string, EnvVal>;
  cwd?: (w: World) => string;
  expect?: RegExp; // sanity: the NEW stdout+stderr must match (a guard against "both fail the same way")
  rc?: number; // sanity: expected exit code
};

function oldPackage(root: string): { bin: string; pkg: string } {
  const pkg = path.join(root, 'pkg');
  mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  cpSync(path.join(PKG, 'lib'), path.join(pkg, 'lib'), { recursive: true });
  copyFileSync(path.join(FIX, 'ui-check.mjs'), path.join(pkg, 'lib', 'ui-check.mjs'));
  copyFileSync(path.join(FIX, 'gsdt-ui'), path.join(pkg, 'bin', 'gsdt-ui'));
  chmodSync(path.join(pkg, 'bin', 'gsdt-ui'), 0o755);
  return { bin: path.join(pkg, 'bin', 'gsdt-ui'), pkg };
}

const git = (cwd: string, ...a: string[]): string => sh(cwd, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);

// A server answering on PORT (= base + phase 5), like the app of test-ui.sh.
let server: Server;
let PORT = 0;
async function startServer(): Promise<void> {
  server = createServer((_q, s) => void s.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  PORT = (server.address() as AddressInfo).port;
}

const RUNNER = `#!/bin/sh
job=$1; out=$(awk -F'\\t' '$1 == "out" {print $2}' "$job")
cp "$job" "$(dirname "$0")/job.last"
case "\${STUB_MODE:-pass}" in
  crash) echo "boom" >&2; exit 3 ;;
  crash3) printf 'a\\nb\\nc\\nd\\n' >&2; exit 4 ;;
  silent) exit 5 ;;
  cannot) echo "Playwright not found in this project" > "$out/error.txt"; exit 2 ;;
  noreport) echo png > "$out/home-375-aaaaaa.png"; exit 0 ;;
esac
st=passed; rc=0; n=0
case "\${STUB_MODE:-pass}" in fail|failns) st=failed; rc=1; n=1 ;; esac
echo "png \${STUB_CAP:-capA}" > "$out/home-375-aaaaaa.png"; echo html > "$out/index.html"
{ printf -- '---\\nstatus: %s\\ncapture: %s\\ncode: %s\\n' "$st" "\${STUB_CAP:-capA}" "$(awk -F'\\t' '$1 == "code" {print $2}' "$job")"
  printf 'failures: %s\\nwaived: 0\\nquestions: 1\\nunchecked: 0\\n---\\n\\n## Failures\\n\\n' "$n"
  [ "$n" = 0 ] && printf 'None.\\n' || printf -- '- C4 | / | 375 | span.x | text at 10px\\n'
  [ "\${STUB_MODE:-pass}" = failns ] && printf '\\n## Not checked\\n\\n- C3 | / | 768 | axe did not load\\n'
  printf '\\n## Questions\\n\\n- Q1 | / | 375 | C2 | possible clipped text in 1 element(s): div.box "long | text"\\n'
  printf '\\n## Shots\\n\\n- / | 375 | home-375-aaaaaa.png\\n'; } > "$out/UI-CHECK.md"
exit $rc
`;
const PLAYWRIGHT = `#!/bin/sh
echo "$*" >> "$(dirname "$0")/calls.log"
[ -z "\${STUB_PW_FAIL:-}" ] || exit 1
[ "$1" = screenshot ] || exit 1
for a; do last=$a; done
echo png > "$last"
`;

function makeWorld(name: 'old' | 'new', base: number): World {
  const root = path.join(tmp(), name);
  const app = path.join(root, 'app');
  const stub = path.join(root, 'stub');
  mkdirSync(stub, { recursive: true });
  write(path.join(stub, 'runner'), RUNNER, 0o755);
  write(path.join(stub, 'playwright'), PLAYWRIGHT, 0o755);
  const { bin, pkg } = name === 'old' ? oldPackage(root) : { bin: NEW_BIN, pkg: PKG };
  repo(app, 'base = develop\ninstall = none\n');
  git(app, 'config', 'user.name', 'Tester');
  write(path.join(app, 'package.json'), `{ "scripts": { "dev": "PORT=$(bash ../../scripts/gsdt-derive-port.sh ${base}) next dev" } }\n`);
  const pd = path.join(app, '.planning/phases/05-shop');
  mkdirSync(pd, { recursive: true });
  write(path.join(app, '.planning/phases/05.1-patch/.keep'), '');
  write(path.join(app, '.planning/ROADMAP.md'), '# Roadmap\n\n### Phase 5: Shop\n');
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', 'init');
  return { name, root, app, pd, stub, bin, pkg };
}

/** a PATH without a `playwright` command, keeping node */
function cleanPath(): string {
  const keep: string[] = [];
  for (const d of (process.env.PATH ?? '').split(':')) if (d !== '' && !existsSync(path.join(d, 'playwright'))) keep.push(d);
  return keep.join(':');
}
const PATH_CLEAN = cleanPath();

function norm(s: string, w: World): string {
  let t = s.split(w.pkg).join('<PKG>');
  t = t.split(w.root).join('<W>');
  t = t.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g, '<TS>');
  return t;
}

type R = { out: string; err: string; rc: number };
function run(w: World, s: Step): Promise<R> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: PATH_CLEAN,
    GSD_PLAYWRIGHT: path.join(w.stub, 'playwright'),
    GSD_NPM_GLOBAL_ROOT: path.join(w.root, 'global/node_modules'),
  };
  for (const [k, v] of Object.entries(s.env ?? {})) env[k] = typeof v === 'function' ? v(w) : v;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return new Promise((resolve) => {
    const p = spawn(w.bin, s.argv, { cwd: s.cwd ? s.cwd(w) : w.app, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    p.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    p.on('close', (rc) => resolve({ out: norm(out, w), err: norm(err, w), rc: rc ?? 1 }));
  });
}

/** every file under the repo (no .git) + the stub's logs, as path → normalized content */
function snapshot(w: World): Record<string, string> {
  const snap: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (rel === '' && e.name === '.git') continue;
      const p = path.join(dir, e.name);
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        snap[`${r}/`] = '';
        walk(p, r);
      } else snap[r] = norm(readFileSync(p, 'utf8'), w);
    }
  };
  walk(w.app, '');
  for (const f of ['calls.log', 'job.last']) {
    const p = path.join(w.stub, f);
    if (existsSync(p)) snap[`stub:${f}`] = norm(readFileSync(p, 'utf8'), w);
  }
  return snap;
}

const answerAll = (w: World): void => {
  const f = path.join(w.pd, '05-UI-LOOK.md');
  let t = readFileSync(f, 'utf8');
  t = t.replace(/^- (R[0-9]+): $/gm, '- $1: ok — looks right in the picture').replace(/^- Q1: $/m, '- Q1: fixed — the title wraps now');
  writeFileSync(f, t);
};
const layout = (text: string) => (w: World) => write(path.join(w.pd, '05-LAYOUT.md'), text);
const conf = (text: string) => (w: World) => write(path.join(w.app, '.gsd.conf'), `base = develop\ninstall = none\n${text}`);
const RUNNER_ENV = { GSD_UI_RUNNER: (w: World): string => path.join(w.stub, 'runner') };

test('gsdt-ui: old bash command vs src/commands/ui.ts, step by step', async () => {
  await startServer();
  const base = PORT - 5;
  const worlds = [makeWorld('old', base), makeWorld('new', base)] as const;
  const FULL = 'sketch: skip a test\npages: /, cart\napp: apps/web\nmain_button: / = Start now\nmain_button: /cart = none\nexpect: /cart = cart\nwaive: C3 | * | * | .brand | agreed with the user\n';
  const steps: Step[] = [
    // ── usage and argument refusals ──────────────────────────────────────
    { label: 'no args', argv: [], rc: 64, expect: /^gsdt-ui — /m },
    { label: '--help', argv: ['--help'], rc: 0, expect: /Usage:/ },
    { label: 'help', argv: ['help'], rc: 0 },
    { label: '-h', argv: ['-h'], rc: 0 },
    { label: 'unknown subcommand', argv: ['bogus'], rc: 1, expect: /unknown subcommand: bogus/ },
    { label: 'option --help after a subcommand', argv: ['status', '--help'], rc: 0 },
    { label: 'unknown option', argv: ['status', '--bogus'], rc: 1, expect: /unknown option/ },
    { label: '--repo without a path', argv: ['design', '--repo'], rc: 1, expect: /--repo needs a path/ },
    { label: '--skip without a reason', argv: ['check', '--skip'], rc: 1, expect: /--skip needs a reason/ },
    { label: '--skip with an empty reason', argv: ['check', '--skip', ''], rc: 1 },
    { label: '--waive without a reason', argv: ['approve', '--waive'], rc: 1, expect: /--waive needs a reason/ },
    { label: '--skip with look', argv: ['look', '5', '--skip', 'x'], rc: 1, expect: /--skip goes with check or shots/ },
    { label: '--skip with design', argv: ['design', '--skip', 'x'], rc: 1 },
    { label: '--waive with check', argv: ['check', '5', '--waive', 'x'], rc: 1, expect: /--waive goes with approve/ },
    { label: 'outside a git repo', argv: ['design'], cwd: (w) => w.root, rc: 1, expect: /not inside a git repo/ },
    { label: '--repo that is not a repo', argv: ['design', '--repo', '/nonexistent-dir-x'], rc: 1 },
    { label: 'no number on the base branch', argv: ['status'], rc: 1, expect: /is not a phase-<N>-\* branch/ },
    { label: 'invalid number', argv: ['layout', 'abc'], rc: 1, expect: /invalid phase number: abc/ },
    { label: 'invalid number 5.', argv: ['layout', '5.'], rc: 1 },
    { label: 'no phase folder', argv: ['layout', '9'], rc: 1, expect: /no \.planning\/phases\/<9>-\* folder/ },
    // ── design ───────────────────────────────────────────────────────────
    { label: 'design: creates the stub', argv: ['design'], rc: 0, expect: /DESIGN\.md \(stub\)/ },
    { label: 'design: still the stub', argv: ['design'], expect: /still the stub/ },
    { label: 'design --repo from elsewhere', argv: ['design', '--repo', '__APP__'], cwd: (w) => w.root, pre: undefined },
    {
      label: 'design: filled',
      argv: ['design'],
      pre: (w) => write(path.join(w.app, '.planning/design/DESIGN.md'), '# Design\n\nfilled\n'),
      expect: /is filled/,
    },
    // ── layout ───────────────────────────────────────────────────────────
    { label: 'layout 5', argv: ['layout', '5'], expect: /05-LAYOUT\.md created/, rc: 0 },
    { label: 'layout 5 again', argv: ['layout', '5'], expect: /already exists — state: /, rc: 0 },
    { label: 'layout 05', argv: ['layout', '05'], rc: 0 },
    { label: 'layout 5.1 (decimal folder)', argv: ['layout', '5.1'], rc: 0 },
    { label: 'status of the decimal phase', argv: ['status', '5.1'], rc: 0 },
    {
      label: 'status from a phase branch, no number',
      argv: ['status'],
      pre: (w) => void git(w.app, 'checkout', '-q', '-b', 'phase-5-shop'),
      expect: /^ui_gates    warn/m,
    },
    { label: 'layout from a phase branch', argv: ['layout'], rc: 0 },
    { label: 'status', argv: ['status', '5'], rc: 0, expect: /layout      nosketch/ },
    // ── shots ────────────────────────────────────────────────────────────
    { label: 'shots with no pages', argv: ['shots', '5'], rc: 1, expect: /no pages: in/ },
    { label: 'check with no pages', argv: ['check', '5'], rc: 1, expect: /no pages: in/ },
    {
      label: 'shots without Playwright',
      argv: ['shots', '5'],
      pre: layout('pages: /, /cart\n'),
      env: { GSD_PLAYWRIGHT: undefined },
      rc: 1,
      expect: /npm i -D playwright/,
    },
    { label: 'shots, app down (derived port)', argv: ['shots', '5'], pre: () => server.close(), rc: 1, expect: /nothing answers at http:\/\/localhost:/ },
    { label: 'status shows no screenshots yet', argv: ['status', '5'] },
    { label: 'shots with --skip', argv: ['shots', '5', '--skip', 'no browser on this box'], rc: 0, expect: /records the skip/ },
    { label: 'status after a shots skip', argv: ['status', '5'], expect: /screenshots skip/ },
    // ── check: refusals before the runner ────────────────────────────────
    { label: 'check --skip', argv: ['check', '5', '--skip', 'the app needs a VPN'], rc: 0, expect: /records the skip/ },
    { label: 'status after a check skip', argv: ['status', '5'], expect: /check       skipped/ },
    { label: 'look after a skip', argv: ['look', '5'], rc: 1, expect: /check was skipped/ },
    { label: 'approve after a skip', argv: ['approve', '5'], rc: 1 },
    { label: 'approve --waive', argv: ['approve', '5', '--waive', 'the app needs a VPN'], rc: 0, expect: /records the waiver/ },
    { label: 'status: skip + waiver', argv: ['status', '5'], expect: /open        nothing/ },
    { label: 'look with no check yet', argv: ['look', '4'], pre: (w) => mkdirSync(path.join(w.app, '.planning/phases/04-x'), { recursive: true }), rc: 1 },
    { label: 'check, app down (no server)', argv: ['check', '5'], env: RUNNER_ENV, rc: 2, expect: /nothing answers at/ },
    { label: 'status: error state', argv: ['status', '5'], expect: /could not run/ },
    // ── the app comes up ─────────────────────────────────────────────────
    { label: 'wait for the server', argv: ['status', '5'], pre: () => void 0 },
  ];
  // Server restart must happen before the steps that need it: do it in a pre hook.
  const restart = async (): Promise<void> => {
    server = createServer((_q, s) => void s.end('ok'));
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
  };
  const steps2: Step[] = [
    { label: 'shots against the app', argv: ['shots', '5'], rc: 0, expect: /6 screenshot\(s\)/ },
    { label: 'shots: a failing CLI', argv: ['shots', '5'], env: { STUB_PW_FAIL: '1' }, rc: 1, expect: /screenshot failed/ },
    { label: 'shots: ui_url with {port:<base>}', argv: ['shots', '5'], pre: conf(`ui_url = http://127.0.0.1:{port:${base}}\n`), rc: 0 },
    { label: 'shots: fixed ui_url', argv: ['shots', '5'], pre: conf(`ui_url = http://localhost:${PORT}/\n`), rc: 0 },
    {
      label: 'shots: two base ports, no url',
      argv: ['shots', '5'],
      pre: (w) => {
        conf('')(w);
        write(path.join(w.app, 'apps/admin/package.json'), '{ "scripts": { "dev": "PORT=$(bash ../../scripts/gsdt-derive-port.sh 3100) next dev" } }\n');
      },
      rc: 1,
      expect: /several base ports in package\.json files \(3100 \d+\)/,
    },
    { label: 'shots: url: in LAYOUT picks the app', argv: ['shots', '5'], pre: layout(`pages: /, /cart\nurl: http://localhost:{port:${base}}\n`), rc: 0 },
    { label: 'shots: url: wins over ui_url', argv: ['shots', '5'], pre: conf('ui_url = http://localhost:1\n'), rc: 0 },
    { label: 'shots: a bad slot', argv: ['shots', '5'], pre: layout('pages: /\nurl: http://localhost:{port:x}\n'), rc: 1, expect: /bad \{port:<number>\} slot/ },
    {
      label: 'shots: no base port in package.json',
      argv: ['shots', '5'],
      pre: (w) => {
        conf('')(w);
        rmSync(path.join(w.app, 'apps'), { recursive: true, force: true });
        rmSync(path.join(w.app, 'package.json'));
        layout('pages: /\n')(w);
      },
      rc: 1,
      expect: /can't tell the app's port/,
    },
    {
      label: 'shots: a page that slugs to home, spaces and symbols',
      argv: ['shots', '5'],
      pre: (w) => {
        write(path.join(w.app, 'package.json'), `{ "scripts": { "dev": "gsdt-derive-port.sh ${base}" } }\n`);
        layout('pages: /, /a/b-c, d e\n')(w);
      },
      rc: 0,
    },
    // ── check with the stub runner ───────────────────────────────────────
    { label: 'check: passes', argv: ['check', '5'], pre: layout(FULL), env: RUNNER_ENV, rc: 0, expect: /passed — capture capA/ },
    { label: 'status after a pass', argv: ['status', '5'] },
    {
      label: 'check: strict + min font + approot from the env',
      argv: ['check', '5'],
      pre: conf('ui_min_font = 14\nui_gates = strict\n'),
      env: { ...RUNNER_ENV, GSD_PLAYWRIGHT_ROOT: '/somewhere', GSD_UI_BUDGET_MS: '1234' },
      rc: 0,
    },
    { label: 'check: out-of-range min font', argv: ['check', '5'], pre: conf('ui_min_font = 99\n'), env: RUNNER_ENV, rc: 0 },
    { label: 'check: failing, warn', argv: ['check', '5'], pre: conf(''), env: { ...RUNNER_ENV, STUB_MODE: 'fail' }, rc: 1, expect: /a waive: line in/ },
    { label: 'check: failing, strict (not checked lines)', argv: ['check', '5'], pre: conf('ui_gates = strict\n'), env: { ...RUNNER_ENV, STUB_MODE: 'failns' }, rc: 1, expect: /not checked: C3/ },
    { label: 'look after a failed check', argv: ['look', '5'], rc: 1, expect: /the check failed/ },
    { label: 'sheet', argv: ['sheet', '5'], rc: 0 },
    { label: 'check: cannot run (error.txt)', argv: ['check', '5'], env: { ...RUNNER_ENV, STUB_MODE: 'cannot' }, rc: 2, expect: /Playwright not found in this project/ },
    { label: 'sheet after an error (pictures cleared)', argv: ['sheet', '5'], rc: 1, expect: /no sheet yet/ },
    { label: 'check: pass again', argv: ['check', '5'], env: RUNNER_ENV, rc: 0 },
    { label: 'check: crash (stderr tail)', argv: ['check', '5'], env: { ...RUNNER_ENV, STUB_MODE: 'crash' }, rc: 2, expect: /boom/ },
    { label: 'check: pass again 2', argv: ['check', '5'], env: RUNNER_ENV, rc: 0 },
    { label: 'check: crash with 4 lines on stderr', argv: ['check', '5'], env: { ...RUNNER_ENV, STUB_MODE: 'crash3' }, rc: 2 },
    { label: 'check: silent exit 5', argv: ['check', '5'], env: { ...RUNNER_ENV, STUB_MODE: 'silent' }, rc: 2, expect: /the runner stopped \(exit 5\)/ },
    { label: 'check: pass again 3', argv: ['check', '5'], env: RUNNER_ENV, rc: 0 },
    { label: 'check: exit 0 without a report', argv: ['check', '5'], env: { ...RUNNER_ENV, STUB_MODE: 'noreport' }, rc: 2 },
    { label: 'check: runner path does not exist', argv: ['check', '5'], env: { GSD_UI_RUNNER: (w) => path.join(w.stub, 'nope') }, rc: 2 },
    {
      label: 'check: runner not executable',
      argv: ['check', '5'],
      pre: (w) => write(path.join(w.stub, 'noexec'), '#!/bin/sh\nexit 0\n', 0o644),
      env: { GSD_UI_RUNNER: (w) => path.join(w.stub, 'noexec') },
      rc: 2,
    },
    {
      label: 'check: runner without a shebang',
      argv: ['check', '5'],
      pre: (w) => write(path.join(w.stub, 'noshebang'), 'echo hi\nexit 0\n', 0o755),
      env: { GSD_UI_RUNNER: (w) => path.join(w.stub, 'noshebang') },
      rc: 2,
    },
    { label: 'check: pass again 4', argv: ['check', '5'], env: RUNNER_ENV, rc: 0 },
    {
      label: 'check: the app at localhost:1 is down',
      argv: ['check', '5'],
      pre: layout('sketch: skip a test\npages: /, cart\nurl: http://localhost:1\n'),
      env: RUNNER_ENV,
      rc: 2,
      expect: /nothing answers at http:\/\/localhost:1/,
    },
    { label: 'status: open ui-check (error)', argv: ['status', '5'], expect: /open        ui-check: the last check could not run/ },
    { label: 'status: the app is the checked one', argv: ['status', '5'], pre: layout(FULL) },
    // ── look and approve ─────────────────────────────────────────────────
    { label: 'look before a passed check (error state)', argv: ['look', '5'], rc: 1, expect: /no passed check yet/ },
    { label: 'check: pass', argv: ['check', '5'], env: RUNNER_ENV, rc: 0 },
    { label: 'look: creates the template', argv: ['look', '5'], rc: 0, expect: /11 line\(s\) to answer/ },
    { label: 'status: open look', argv: ['status', '5'], expect: /look        open/ },
    { label: 'approve with an open look', argv: ['approve', '5'], rc: 1, expect: /lines without an answer/ },
    {
      label: 'look: answers kept on the same capture',
      argv: ['look', '5'],
      pre: (w) => {
        const f = path.join(w.pd, '05-UI-LOOK.md');
        writeFileSync(f, readFileSync(f, 'utf8').replace(/^- (R[0-9]+): $/gm, '- $1: ok — looks right in the picture').replace(/^- Q1: $/m, '- Q1: bad — the title is cut off'));
      },
      expect: /is for this capture \(capA\)/,
    },
    { label: 'status: bad answer', argv: ['status', '5'], expect: /look        bad/ },
    { label: 'check: new capture', argv: ['check', '5'], env: { ...RUNNER_ENV, STUB_CAP: 'capB' }, rc: 0 },
    { label: 'status: stale look', argv: ['status', '5'], expect: /look        stale/ },
    { label: 'look: new capture carries was: lines', argv: ['look', '5'], rc: 0 },
    { label: 'status: open after was', argv: ['status', '5'] },
    { label: 'look: every line answered', argv: ['status', '5'], pre: answerAll, expect: /look        complete/ },
    { label: 'approve', argv: ['approve', '5'], rc: 0, expect: /records the approval of capture capB/ },
    {
      label: 'status after approval, committed',
      argv: ['status', '5'],
      pre: (w) => {
        git(w.app, 'add', '-A');
        git(w.app, 'commit', '-q', '-m', 'ui');
      },
      expect: /open        nothing/,
    },
    { label: 'check: same capture keeps look and approval', argv: ['check', '5'], env: { ...RUNNER_ENV, STUB_CAP: 'capB' }, rc: 0 },
    { label: 'status: still nothing open', argv: ['status', '5'], expect: /open        nothing/ },
    { label: 'status: LAYOUT edited after the check', argv: ['status', '5'], pre: (w) => writeFileSync(path.join(w.pd, '05-LAYOUT.md'), `${readFileSync(path.join(w.pd, '05-LAYOUT.md'), 'utf8')}expect: /cart = basket\n`), expect: /check       stale/ },
    { label: 'look on a stale check', argv: ['look', '5'], rc: 1, expect: /changed after the last check/ },
    { label: 'approve on a stale check', argv: ['approve', '5'], rc: 1 },
    { label: 'status: LAYOUT put back', argv: ['status', '5'], pre: layout(FULL), expect: /open        nothing/ },
    {
      label: 'status: an older check (code hash only)',
      argv: ['status', '5'],
      pre: (w) => {
        const f = path.join(w.pd, '05-UI-CHECK.md');
        writeFileSync(f, readFileSync(f, 'utf8').replace(/^code: ([0-9a-f]+)\+.*$/m, 'code: $1'));
      },
      expect: /check       passed/,
    },
    { label: 'status: a code change makes it stale', argv: ['status', '5'], pre: (w) => write(path.join(w.app, 'page.js'), 'change\n'), expect: /check       stale/ },
    { label: 'check: capC', argv: ['check', '5'], env: { ...RUNNER_ENV, STUB_CAP: 'capC' }, rc: 0 },
    { label: 'status: look and approval open again', argv: ['status', '5'], expect: /open        ui-look/ },
    { label: 'status: page.js removed again', argv: ['status', '5'], pre: (w) => rmSync(path.join(w.app, 'page.js')) },
    {
      label: 'check: committed pictures warn',
      argv: ['check', '5'],
      pre: (w) => void git(w.app, 'add', '-f', path.join(w.pd, '05-SHOTS/home-375-aaaaaa.png')),
      env: RUNNER_ENV,
      rc: 0,
      expect: /are committed/,
    },
    { label: 'approve --waive after a pass', argv: ['approve', '5', '--waive', 'one\ttwo\nthree'], pre: (w) => void git(w.app, 'reset', '-q'), rc: 0 },
    { label: 'check --skip with a long reason', argv: ['check', '5', '--skip', 'x'.repeat(400)], rc: 0 },
    { label: 'shots --skip with a symbol reason', argv: ['shots', '5', '--skip', 'a & b | c "d"'], rc: 0 },
    { label: 'approve with no user.name', argv: ['approve', '5', '--waive', 'w'], pre: (w) => void git(w.app, 'config', '--unset', 'user.name'), env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, rc: 0 },
    { label: '--repo from elsewhere (status)', argv: ['status', '5', '--repo', '__APP__'], cwd: (w) => w.root, rc: 0 },
  ];

  let ran = 0;
  const all = [...steps.slice(0, -1), { label: 'restart the server', argv: ['status', '5'], pre: undefined as undefined }, ...steps2];
  const bad: string[] = [];
  for (const s of all) {
    if (s.label === 'restart the server') await restart();
    const rs = await Promise.all(
      worlds.map(async (w) => {
        s.pre?.(w);
        const sx: Step = { ...s, argv: s.argv.map((a) => (a === '__APP__' ? w.app : a)) };
        return { w, r: await run(w, sx) };
      }),
    );
    const [o, n] = [rs[0]!, rs[1]!];
    ran++;
    const so = snapshot(o.w);
    const sn = snapshot(n.w);
    const diffs: string[] = [];
    if (o.r.out !== n.r.out) diffs.push(`stdout\n    old: ${JSON.stringify(o.r.out)}\n    new: ${JSON.stringify(n.r.out)}`);
    if (o.r.err !== n.r.err) diffs.push(`stderr\n    old: ${JSON.stringify(o.r.err)}\n    new: ${JSON.stringify(n.r.err)}`);
    if (o.r.rc !== n.r.rc) diffs.push(`rc old=${o.r.rc} new=${n.r.rc}`);
    for (const k of new Set([...Object.keys(so), ...Object.keys(sn)])) {
      if (so[k] !== sn[k]) diffs.push(`file ${k}\n    old: ${JSON.stringify(so[k])}\n    new: ${JSON.stringify(sn[k])}`);
    }
    if (s.rc !== undefined && n.r.rc !== s.rc) diffs.push(`sanity: expected rc ${s.rc}, got ${n.r.rc} (${JSON.stringify(n.r.err + n.r.out)})`);
    if (s.expect && !s.expect.test(n.r.out + n.r.err)) diffs.push(`sanity: output does not match ${s.expect}: ${JSON.stringify(n.r.out + n.r.err)}`);
    if (diffs.length > 0) bad.push(`[${s.label}] ${s.argv.join(' ')}\n  ${diffs.join('\n  ')}`);
  }
  server.close();
  assert.ok(ran > 100, `ran ${ran} steps`);
  assert.equal(bad.length, 0, `${bad.length} of ${ran} steps differ:\n${bad.join('\n')}`);
});
