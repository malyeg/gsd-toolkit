// tests/test-ui.sh → node:test. The UI quality gates outside the flow engine: the gsdt-ui command (design, layout,
// shots with a stub Playwright and a local web server, the port slot, --skip, status; check / look / approve / sheet
// with a stub runner), the finish gate, gsdt-doctor's UI checks (T080, T081, T018, the UI debt of merged phases) and
// gsdt-bootstrap-repo --no-ui / the instruction text. Same sections, same names as the bash suite.
// Run: node --test tests/node/ui.test.ts
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { uiCodeState } from '../../src/ui.ts';
import {
  PKG, WIN, add, baseEnv, fileHas, fileHasnt, files, fmv, freePort, gitHashObject, gitHashText, gitOk, gitOut, gsdt,
  has, hasnt, initRepo, is, linkProgram, lf, mkWork, mkexec, ok, pathWith, read, run, startServer, w,
} from './g4-env.ts';
import type { Env, Run, Server } from './g4-env.ts';
import { uiFixAll, uiFixApproval, uiFixCheck } from './ui-fixture.ts';

const W = mkWork('g4ui-');
const ENV: Env = baseEnv(W, { GSD_CLAUDE_SKILL_DIR: path.join(W, 'skills'), GSD_NPM_GLOBAL_ROOT: path.join(W, 'global', 'node_modules') });
const git = (cwd: string, ...args: string[]): void => { gitOk(ENV, cwd, args); };
const g = (cmd: string, args: string[], cwd: string, env: Env = {}) => gsdt(ENV, cmd, args, { cwd, env });

// …nor a playwright command on PATH (an nvm/npm global bin): drop those dirs, keeping node itself,
// which gsdt-ui check asks for.
const KEEP = path.join(W, 'keep-bin');
for (const c of ['node', 'npm', 'npx']) {
  const target = c === 'node' ? process.execPath : (process.env.PATH ?? '').split(path.delimiter).map((d) => [c, `${c}.cmd`].map((n) => path.join(d, n)).find((f) => existsSync(f))).find((f) => f !== undefined);
  if (target) linkProgram(KEEP, c, target);
}
const clean = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d !== '' && !['playwright', 'playwright.cmd', 'playwright.exe'].some((n) => existsSync(path.join(d, n))));
ENV.PATH = pathWith(...clean, KEEP);

const OUT = { v: '' };

// A stub Playwright CLI: `screenshot --viewport-size=W,H --full-page URL FILE` writes FILE and logs the call.
const STUB = path.join(W, 'stub');
mkdirSync(STUB, { recursive: true });
mkexec(path.join(STUB, 'playwright'), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.log'), a.join(' ') + '\\n');
if (a[0] !== 'screenshot') process.exit(1);
fs.writeFileSync(a[a.length - 1], 'png\\n');
`);

// A GSD repo on a phase-5 worktree branch. The app's dev script derives its port from a base, the way projects wire gsdt-derive-port.
const R = path.join(W, 'app');
initRepo(ENV, R);
const BASEPORT = (await freePort()) - 5, PORT = BASEPORT + 5;
w(path.join(R, 'package.json'), `{ "scripts": { "dev": "PORT=$(bash ../../scripts/gsdt-derive-port.sh ${BASEPORT}) next dev" } }\n`);
mkdirSync(path.join(R, '.planning', 'phases', '05-shop'), { recursive: true });
w(path.join(R, '.planning', 'ROADMAP.md'), '# Roadmap\n\n### Phase 5: Shop\n');
const conf = (repo: string, text = ''): void => w(path.join(repo, '.gsd.conf'), `base = develop\ninstall = none\n${text}`);
conf(R);
git(R, 'add', '-A'); git(R, 'commit', '-qm', 'init');
git(R, 'checkout', '-q', '-b', 'phase-5-shop');
const PD = path.join(R, '.planning', 'phases', '05-shop');
const LAYOUT = path.join(PD, '05-LAYOUT.md');
const CHECK = path.join(PD, '05-UI-CHECK.md');
const status = (f: string): string => fmv(f, 'status');
const statusR = (): void => { OUT.v = g('gsdt-ui', ['status', '5'], R).out; };
let server: Server | undefined;

test('gsdt-ui design', () => {
  OUT.v = g('gsdt-ui', ['design'], R).out;
  has('creates the stub', OUT.v, 'stub) and .planning/design/refs/ created');
  ok('refs/ is kept in git', existsSync(path.join(R, '.planning/design/refs/.gitkeep')));
  const design = path.join(R, '.planning/design/DESIGN.md');
  fileHas('stub carries the marker', design, 'gsd:design-stub');
  fileHas('stub: start from a real design system', design, 'styles.refero.design');
  fileHas('stub: pick fonts on purpose', design, 'fontshare.com');
  fileHas('stub: take tested parts', design, '21st.dev');
  fileHas('stub: the layout rules R1–R10', design, /^- R10: Matches the chosen sketch/m);
  w(design, '## Tokens: ours\n');
  OUT.v = g('gsdt-ui', ['design'], R).out;
  has('a filled DESIGN.md is left alone', OUT.v, 'is filled');
  is('…and not overwritten', lf(read(design)).replace(/\n+$/, ''), '## Tokens: ours');
});

test('gsdt-ui layout', () => {
  OUT.v = g('gsdt-ui', ['layout'], R).out;
  has('phase from the branch; creates LAYOUT', OUT.v, '05-LAYOUT.md created');
  const t = read(LAYOUT);
  ok('template has sketch:, pages: and url:', /^sketch:/m.test(t) && /^pages:/m.test(t) && /^url:/m.test(t));
  w(LAYOUT, 'pages: /, /cart\n');
  OUT.v = g('gsdt-ui', ['layout', '5'], R).out;
  has('an existing LAYOUT is not overwritten', OUT.v, 'already exists');
  is('…content kept', lf(read(LAYOUT)).replace(/\n+$/, ''), 'pages: /, /cart');
  is('no phase folder → exit 1', g('gsdt-ui', ['layout', '9'], R).status, 1);
});

test('gsdt-ui shots — refusals', () => {
  let r = g('gsdt-ui', ['shots', '5'], R);
  is('no Playwright → exit 1', r.status, 1);
  has('…says how to install it', r.out, 'npm i -D playwright');
  ENV.GSD_PLAYWRIGHT = path.join(STUB, 'playwright');
  r = g('gsdt-ui', ['shots', '5'], R);
  is('nothing listening → exit 1', r.status, 1);
  has('…names the derived address', r.out, `nothing answers at http://localhost:${PORT}`);
  ok('…and records nothing', !existsSync(path.join(PD, '05-SHOTS.md')));
});

test('gsdt-ui shots — against a running app', async () => {
  mkdirSync(path.join(W, 'site', 'cart'), { recursive: true });
  w(path.join(W, 'site', 'index.html'), 'home\n');
  w(path.join(W, 'site', 'cart', 'index.html'), 'cart\n');
  server = await startServer(path.join(W, 'site'), PORT);
  let r = g('gsdt-ui', ['shots', '5'], R);
  is('shots succeed', r.status, 0);
  has('2 pages × 3 sizes', r.out, '6 screenshot(s)');
  const shots = readdirSync(path.join(PD, '05-SHOTS'));
  for (const f of ['home-375', 'home-768', 'home-1440', 'cart-375', 'cart-768', 'cart-1440']) {
    ok(`file ${f}-<hash>.png exists`, shots.some((n) => new RegExp(`^${f}-[0-9a-f]{6}\\.png$`).test(n)));
  }
  is('files named <page>-<width>-<hash>.png', shots.filter((n) => n.startsWith('cart-1440-')).join('\n'), `cart-1440-${gitHashText(ENV, '/cart').slice(0, 6)}.png`);
  const calls = read(path.join(STUB, 'calls.log'));
  ok('calls the CLI with size, full page, url', calls.includes(`--viewport-size=375,812 --full-page http://localhost:${PORT}/cart `), calls.split('\n').slice(0, 2).join('\n'));
  fileHas('SHOTS.md records the url', path.join(PD, '05-SHOTS.md'), `url: http://localhost:${PORT}`);
  is('PNGs are ignored by git', read(path.join(PD, '05-SHOTS', '.gitignore')).replace(/\n+$/, ''), '*');
  git(R, 'add', '-A');
  is('…only SHOTS.md is staged, no PNG', gitOut(ENV, R, ['diff', '--cached', '--name-only']).split('\n').filter((l) => /\.png$/.test(l)).length, 0);
  git(R, 'reset', '-q');

  add(path.join(R, '.gsd.conf'), `ui_url = http://127.0.0.1:{port:${BASEPORT}}\n`);
  g('gsdt-ui', ['shots', '5'], R);
  fileHas('{port:<base>} in ui_url', path.join(PD, '05-SHOTS.md'), `url: http://127.0.0.1:${PORT}`);
  conf(R, `ui_url = http://localhost:${PORT}\n`);
  g('gsdt-ui', ['shots', '5'], R);
  fileHas('a fixed ui_url works too', path.join(PD, '05-SHOTS.md'), `url: http://localhost:${PORT}`);
  conf(R);
  void r;
});

test('gsdt-ui shots — a project with several apps', () => {
  mkdirSync(path.join(R, 'apps', 'admin'), { recursive: true });
  w(path.join(R, 'apps/admin/package.json'), '{ "scripts": { "dev": "PORT=$(bash ../../scripts/gsdt-derive-port.sh 3100) next dev" } }\n');
  let r = g('gsdt-ui', ['shots', '5'], R);
  is('two base ports, no url → exit 1', r.status, 1);
  has('…asks for url: in the phase LAYOUT', r.out, 'in 05-LAYOUT.md:  url: http://localhost:{port:<base>}');
  w(LAYOUT, `pages: /, /cart\nurl: http://localhost:{port:${BASEPORT}}\n`);
  r = g('gsdt-ui', ['shots', '5'], R);
  is('url: in LAYOUT picks the app', r.status, 0);
  fileHas('…with this phase\'s port', path.join(PD, '05-SHOTS.md'), `url: http://localhost:${PORT}`);
  conf(R, 'ui_url = http://localhost:1\n');
  r = g('gsdt-ui', ['shots', '5'], R);
  is('url: in LAYOUT wins over ui_url', r.status, 0);
  w(LAYOUT, 'pages: /\nurl: http://localhost:{port:x}\n');
  r = g('gsdt-ui', ['shots', '5'], R);
  has('a bad slot names where it came from', r.out, 'url: in 05-LAYOUT.md has a bad');
  conf(R);
  rmSync(path.join(R, 'apps'), { recursive: true, force: true });
  w(LAYOUT, 'pages: /, /cart\n');
});

test('gsdt-ui shots --skip and status', () => {
  OUT.v = g('gsdt-ui', ['shots', '5', '--skip', 'no browser on this box'], R).out;
  fileHas('--skip records the reason', path.join(PD, '05-SHOTS.md'), 'skipped: no browser on this box');
  statusR();
  has('status: gates', OUT.v, 'ui_gates    warn');
  has('status: design', OUT.v, 'design      ok');
  has('status: layout', OUT.v, 'layout      nosketch');
  has('status: screenshots', OUT.v, 'screenshots skip');
  is('--skip needs a reason', g('gsdt-ui', ['shots', '5', '--skip'], R).status, 1);
});

// The stub stands in for src/ui-check.ts: it reads the job file and writes what a run writes
// (ui-browser.test.ts runs the real one in a browser).
const RUNNER = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const job = process.argv[2];
const rows = fs.readFileSync(job, 'utf8').split('\\n').map((l) => l.split('\\t'));
const val = (k) => (rows.find((r) => r[0] === k) || [])[1];
const out = val('out');
fs.copyFileSync(job, path.join(__dirname, 'job.last'));
const mode = process.env.STUB_MODE || 'pass', cap = process.env.STUB_CAP || 'capA';
if (mode === 'crash') { process.stderr.write('boom\\n'); process.exit(3); }
if (mode === 'cannot') { fs.writeFileSync(path.join(out, 'error.txt'), 'Playwright not found in this project\\n'); process.exit(2); }
if (mode === 'noreport') { fs.writeFileSync(path.join(out, 'home-375-aaaaaa.png'), 'png\\n'); process.exit(0); }
let st = 'passed', rc = 0, n = 0;
if (mode === 'fail') { st = 'failed'; rc = 1; n = 1; }
fs.writeFileSync(path.join(out, 'home-375-aaaaaa.png'), 'png ' + cap + '\\n');
fs.writeFileSync(path.join(out, 'index.html'), 'html\\n');
let t = '---\\nstatus: ' + st + '\\ncapture: ' + cap + '\\ncode: ' + val('code') + '\\n';
t += 'failures: ' + n + '\\nwaived: 0\\nquestions: 1\\nunchecked: 0\\n---\\n\\n## Failures\\n\\n';
t += n === 0 ? 'None.\\n' : '- C4 | / | 375 | span.x | text at 10px\\n';
t += '\\n## Questions\\n\\n- Q1 | / | 375 | C2 | possible clipped text in 1 element(s): div.box "long | text"\\n';
t += '\\n## Shots\\n\\n- / | 375 | home-375-aaaaaa.png\\n';
fs.writeFileSync(path.join(out, 'UI-CHECK.md'), t);
process.exit(rc);
`;
const jobv = (k: string): string[] => lf(read(path.join(STUB, 'job.last'))).split('\n').map((l) => l.split('\t')).filter((r) => r[0] === k).map((r) => r[1] ?? '');
const job = (k: string): string => jobv(k).join('\n');
const checkWith = (env: Env = {}): Run => g('gsdt-ui', ['check', '5'], R, env);
const sha = (f: string): string => gitHashObject(ENV, R, f);

test('gsdt-ui check — with a stub runner', () => {
  mkexec(path.join(STUB, 'runner'), RUNNER);
  ENV.GSD_UI_RUNNER = path.join(STUB, 'runner');
  rmSync(path.join(PD, '05-SHOTS'), { recursive: true, force: true });
  rmSync(path.join(PD, '05-SHOTS.md'), { force: true });
  w(LAYOUT, 'sketch: skip a test\npages: /, cart\napp: apps/web\nmain_button: / = Start now\nmain_button: /cart = none\nexpect: /cart = cart\nwaive: C3 | * | * | .brand | agreed with the user\n');
  git(R, 'add', '-A'); git(R, 'commit', '-qm', 'layout');
  let r = checkWith();
  is('a passed run → exit 0', r.status, 0);
  has('…says passed and names the capture', r.out, 'passed — capture capA');
  has('…and the next step', r.out, 'Next: gsdt-ui look 5');
  is('the report is published', status(CHECK), 'passed');
  ok('pictures and sheet are published', existsSync(path.join(PD, '05-SHOTS/home-375-aaaaaa.png')) && existsSync(path.join(PD, '05-SHOTS/index.html')), files(path.join(PD, '05-SHOTS')).join(' '));
  ok('the run folder is gone', !existsSync(path.join(PD, '05-SHOTS/.run')));
  is('pictures are ignored by git', gitOut(ENV, R, ['status', '--porcelain']).split('\n').filter((l) => l.includes('SHOTS')).length, 0);
  is('job: the phase\'s address', job('url'), `http://localhost:${PORT}`);
  is('job: pages, each with a leading /', jobv('page').join(' ') + ' ', '/ /cart ');
  is('job: main_button lines', jobv('main_button').join(';') + ';', '/ = Start now;/cart = none;');
  is('job: expect and waive lines', `${job('expect')}|${job('waive')}`, '/cart = cart|C3 | * | * | .brand | agreed with the user');
  is('job: app: from LAYOUT', `${job('approot')}/${job('approot_from')}`, 'apps/web/app: in 05-LAYOUT.md');
  is('job: default minimum font', job('minfont'), 12);
  is('job: the global npm folder', job('globalroot').replace(/\\/g, '/'), path.join(W, 'global', 'node_modules').replace(/\\/g, '/'));
  is('job: warn → not strict', job('strict'), 0);
  is('job: the pinned axe-core', `${path.basename(job('axe'))}/${job('axever')}`, `axe.min.js/${lf(read(path.join(PKG, 'lib/vendor/axe-core/VERSION'))).replace(/\n+$/, '')}`);
  is('job: the code + LAYOUT state is recorded', job('code'), `${uiCodeState(R, ENV as NodeJS.ProcessEnv)}+${sha(LAYOUT)}`);
  conf(R, 'ui_min_font = 14\nui_gates = strict\n');
  checkWith({ GSD_PLAYWRIGHT_ROOT: '/somewhere' });
  is('ui_min_font, ui_gates = strict and GSD_PLAYWRIGHT_ROOT reach the job', `${job('minfont')}/${job('strict')}/${job('approot')}`, '14/1//somewhere');
  conf(R, 'ui_min_font = 99\n');
  checkWith();
  is('an out-of-range ui_min_font falls back to 12', job('minfont'), 12);
  conf(R);
  r = checkWith({ STUB_MODE: 'fail' });
  is('failed checks → exit 1', r.status, 1);
  has('…lists the finding', r.out, 'C4 | / | 375 | span.x | text at 10px');
  has('…names the waive: way out', r.out, 'a waive: line in');
  is('…the report says failed', status(CHECK), 'failed');
});

test('gsdt-ui check — a run that could not finish leaves no old pass', () => {
  checkWith();
  let r = checkWith({ STUB_MODE: 'cannot' });
  is('the runner cannot run → exit 2', r.status, 2);
  is('…status: error replaces the old pass', status(CHECK), 'error');
  fileHas('…with the reason', CHECK, 'error: Playwright not found in this project');
  is('…the old pictures and sheet are gone', files(path.join(PD, '05-SHOTS'), ['.gitignore']).length, 0);
  checkWith();
  r = checkWith({ STUB_MODE: 'crash' });
  is('the runner crashes → exit 2, status error', `${r.status}/${status(CHECK)}`, '2/error');
  fileHas('…with what it printed', CHECK, 'error: boom');
  r = checkWith({ STUB_MODE: 'noreport' });
  is('exit 0 without a report is not a pass', `${r.status}/${status(CHECK)}`, '2/error');
  checkWith();
  w(LAYOUT, read(LAYOUT).replace(/^app:.*$/m, 'url: http://localhost:1'));
  r = checkWith();
  is('the app is down → exit 2, status error', `${r.status}/${status(CHECK)}`, '2/error');
  has('…says to start the app', r.out, 'nothing answers at http://localhost:1');
  w(LAYOUT, lf(read(LAYOUT)).split('\n').filter((l) => !l.startsWith('url:')).join('\n'));
  statusR();
  has('status names the open step', OUT.v, 'open        ui-check: the last check could not run');
  r = g('gsdt-ui', ['check', '5', '--skip', 'the app needs a VPN'], R);
  is('--skip records status: skipped', `${status(CHECK)}/${fmv(CHECK, 'skipped')}`, 'skipped/the app needs a VPN');
  has('…and points at the waiver the user must give', r.out, 'gsdt-ui approve 5 --waive');
  is('look after a skip → exit 1 (no pictures)', g('gsdt-ui', ['look', '5'], R).status, 1);
  r = g('gsdt-ui', ['approve', '5'], R);
  is('approve after a skip → exit 1', r.status, 1);
  has('…asks for --waive', r.out, '--waive');
  g('gsdt-ui', ['approve', '5', '--waive', 'the app needs a VPN'], R);
  const appr = path.join(PD, '05-UI-APPROVAL.md');
  is('approve --waive records the reason', `${status(appr)}/${fmv(appr, 'reason')}`, 'waived/the app needs a VPN');
  statusR();
  has('skip + waiver → nothing open', OUT.v, 'open        nothing');
  rmSync(appr);
});

test('gsdt-ui look and approve', () => {
  const LOOK = path.join(PD, '05-UI-LOOK.md');
  const APPR = path.join(PD, '05-UI-APPROVAL.md');
  checkWith({ STUB_MODE: 'fail' });
  is('look after a failed check → exit 1', g('gsdt-ui', ['look', '5'], R).status, 1);
  OUT.v = g('gsdt-ui', ['sheet', '5'], R).out;
  is('sheet prints the path', lf(OUT.v).replace(/\n+$/, ''), path.join(PD, '05-SHOTS', 'index.html'));
  checkWith();
  let r = g('gsdt-ui', ['look', '5'], R);
  is('look after a passed check → exit 0', r.status, 0);
  has('…10 rules + 1 question for the one picture', r.out, '11 line(s) to answer');
  is('the look names the capture', fmv(LOOK, 'capture'), 'capA');
  fileHas('…a section per picture', LOOK, /^## \/ at 375px$/m);
  fileHas('…with its file', LOOK, /^picture: 05-SHOTS\/home-375-aaaaaa\.png$/m);
  fileHas('…the question, with its text', LOOK, 'asks (C2): possible clipped text in 1 element(s): div.box "long | text"');
  statusR();
  has('an empty template is open', OUT.v, 'look        open');
  r = g('gsdt-ui', ['approve', '5'], R);
  is('approve with an open look → exit 1', r.status, 1);
  has('…says what is open', r.out, 'lines without an answer');
  w(LOOK, read(LOOK).replace(/^- (R[0-9]+): $/gm, '- $1: ok — looks right in the picture'));
  statusR();
  has('rules answered, the question not → still open', OUT.v, 'look        open');
  w(LOOK, read(LOOK).replace(/^- Q1: $/gm, '- Q1: bad — the title is cut off'));
  statusR();
  has('a bad answer keeps it open', OUT.v, 'look        bad');
  OUT.v = g('gsdt-ui', ['look', '5'], R).out;
  has('look on the same capture keeps the answers', OUT.v, 'is for this capture (capA)');
  fileHas('…the file is untouched', LOOK, /^- Q1: bad — the title is cut off$/m);
  checkWith({ STUB_CAP: 'capB' });
  statusR();
  has('new pictures → the look is stale', OUT.v, 'look        stale');
  g('gsdt-ui', ['look', '5'], R);
  is('look on a new capture writes a new template', fmv(LOOK, 'capture'), 'capB');
  fileHas('…with the old answer beside the line', LOOK, /^ {2}was: bad — the title is cut off$/m);
  fileHas('…and the line itself open again', LOOK, /^- Q1: $/m);
  w(LOOK, read(LOOK).replace(/^- (R[0-9]+): $/gm, '- $1: ok — looks right in the picture').replace(/^- Q1: $/gm, '- Q1: fixed — the title wraps now'));
  statusR();
  has('every line answered → complete', OUT.v, 'look        complete');
  has('…the approval is the open step', OUT.v, 'open        ui-approve: the user has not approved the pages');
  r = g('gsdt-ui', ['approve', '5'], R);
  is('approve → exit 0', r.status, 0);
  is('the approval names the capture', `${status(APPR)}/${fmv(APPR, 'capture')}`, 'approved/capB');
  git(R, 'add', '-A'); git(R, 'commit', '-qm', 'ui check, look, approval');
  statusR();
  has('after the commit nothing is open', OUT.v, 'open        nothing');
  checkWith({ STUB_CAP: 'capB' });
  statusR();
  has('a new check with the same pictures keeps look and approval', OUT.v, 'open        nothing');
  const saved = read(LAYOUT);
  add(LAYOUT, 'expect: /cart = basket\n');
  statusR();
  has('a LAYOUT edit after the check → stale', OUT.v, 'check       stale');
  w(LAYOUT, saved);
  statusR();
  has('…and putting it back undoes that', OUT.v, 'open        nothing');
  const c = fmv(CHECK, 'code');
  w(CHECK, read(CHECK).replace(/^code: .*$/m, `code: ${c.split('+')[0]}`));
  statusR();
  has('a check from before (code hash only) still counts', OUT.v, 'check       passed');
  w(path.join(R, 'page.js'), 'change\n');
  statusR();
  has('a code change after the check → stale', OUT.v, 'check       stale');
  is('look on a stale check → exit 1', g('gsdt-ui', ['look', '5'], R).status, 1);
  is('approve on a stale check → exit 1', g('gsdt-ui', ['approve', '5'], R).status, 1);
  checkWith({ STUB_CAP: 'capC' });
  statusR();
  has('the page changed → look and approval open again', OUT.v, 'open        ui-look');
  rmSync(path.join(R, 'page.js'));
  gitOut(ENV, R, ['add', '-f', path.join(PD, '05-SHOTS/home-375-aaaaaa.png')]);
  r = checkWith();
  has('committed pictures → a warning', r.out, 'are committed');
  git(R, 'reset', '-q');
  is('--skip does not go with look', g('gsdt-ui', ['look', '5', '--skip', 'x'], R).status, 1);
  is('--waive does not go with check', g('gsdt-ui', ['check', '5', '--waive', 'x'], R).status, 1);
  delete ENV.GSD_UI_RUNNER;
});

test('gsdt-finish — the UI steps must be current', () => {
  const F = path.join(W, 'fin');
  initRepo(ENV, F);
  conf(F, 'test = none\nui_gates = strict\n');
  git(F, 'add', '-A'); git(F, 'commit', '-qm', 'init');
  let FW = '', FPD = '', N = '';
  const newphase = (n: number, slug: string): void => {
    FW = path.join(W, 'fin-worktrees', `phase-${n}-${slug}`);
    git(F, 'worktree', 'add', '-q', '-b', `phase-${n}-${slug}`, FW, 'develop');
    FPD = path.join(FW, '.planning', 'phases', `0${n}-${slug}`);
    mkdirSync(FPD, { recursive: true });
    w(path.join(FPD, `0${n}-UI-SPEC.md`), '');
    w(path.join(FW, `page-${n}.js`), `code ${n}\n`);
    git(FW, 'add', '-A'); git(FW, 'commit', '-qm', `phase ${n}`);
  };
  const finish = (env: Env = {}): Run => g('gsdt-wt-finish', [N], F, env);
  newphase(6, 'page'); N = '6';
  const before = gitOut(ENV, F, ['rev-parse', 'develop']);
  let r = finish();
  is('strict, no check → finish refuses', r.status, 1);
  has('…names the open step', r.out, 'UI steps are open (ui_gates = strict): the rendered pages were never checked');
  has('…and the command', r.out, 'gsdt-ui check 6');
  is('…nothing was merged', gitOut(ENV, F, ['rev-parse', 'develop']), before);
  ok('…the worktree is kept', existsSync(FW));
  uiFixAll(FPD, '06'); git(FW, 'add', '-A'); git(FW, 'commit', '-qm', 'ui');
  const c6 = path.join(FPD, '06-UI-CHECK.md');
  w(c6, read(c6).replace(/^code: $/m, 'code: 0000000000000000000000000000000000000000'));
  git(FW, 'commit', '-qam', 'stale check');
  r = finish();
  is('strict, code changed after the check → finish refuses', r.status, 1);
  has('…says the check is stale', r.out, 'changed after the last check');
  r = finish({ GSD_SKIP_GUARD: '1' });
  is('GSD_SKIP_GUARD=1 → finishes', r.status, 0);
  has('…and says it skipped the gate', r.out, 'finishing anyway');
  ok('…the phase is merged', existsSync(path.join(F, 'page-6.js')), r.out.split('\n').slice(-5).join('\n'));
  conf(F, 'test = none\n'); git(F, 'commit', '-qam', 'warn');
  newphase(7, 'cart'); N = '7';
  r = finish();
  is('warn (default), no check → finishes', r.status, 0);
  has('…with a warning', r.out, '⚠ phase 7 has screens and its UI steps are open');
  conf(F, 'test = none\nui_gates = strict\n'); git(F, 'commit', '-qam', 'strict');
  newphase(8, 'list'); N = '8';
  uiFixAll(FPD, '08'); git(FW, 'add', '-A'); git(FW, 'commit', '-qm', 'ui');
  r = finish();
  is('strict, check + look + approval → finishes', r.status, 0);
  hasnt('…without a UI message', r.out, 'UI steps are open');
  const P9 = path.join(W, 'fin-worktrees', 'phase-9-api');
  git(F, 'worktree', 'add', '-q', '-b', 'phase-9-api', P9, 'develop');
  w(path.join(P9, '.planning/phases/09-api/09-CONTEXT.md'), '');
  git(P9, 'add', '-A'); git(P9, 'commit', '-qm', 'phase 9');
  N = '9';
  r = finish();
  is('strict, a phase without screens → finishes', r.status, 0);
});

test('gsdt-doctor UI checks', () => {
  const D = path.join(W, 'doc');
  initRepo(ENV, D);
  mkdirSync(path.join(D, '.planning/phases/03-web'), { recursive: true });
  mkdirSync(path.join(D, '.planning/phases/04-api'), { recursive: true });
  w(path.join(D, '.planning/phases/03-web/03-UI-SPEC.md'), '');
  w(path.join(D, '.planning/ROADMAP.md'), '# Roadmap\n\n### Phase 3: Web\n\n### Phase 4: Api\n');
  conf(D);
  git(D, 'add', '-A'); git(D, 'commit', '-qm', 'init');
  const doc = (...a: string[]): string => g('gsdt-doctor', [...a, '--repo', D], W).out;
  OUT.v = doc();
  has('warn: a stub/missing DESIGN.md is a note', OUT.v, 'DESIGN.md is missing');
  OUT.v = doc('--json');
  hasnt('…not a finding', OUT.v, '"T080"');
  add(path.join(D, '.gsd.conf'), 'ui_gates = strict\nui_url = http://localhost:{port}\n');
  OUT.v = doc('--json');
  has('strict: T080', OUT.v, '"T080"');
  hasnt('ui_gates and ui_url are known keys', OUT.v, '"T017"');
  w(path.join(D, '.planning/design/DESIGN.md'), '# filled\n');
  OUT.v = doc('--json');
  hasnt('a filled DESIGN.md → no T080', OUT.v, '"T080"');
  conf(D, 'ui_gates = maybe\n');
  OUT.v = doc('--json');
  has('a bad ui_gates value → T018', OUT.v, "ui_gates = 'maybe' is not a value");
  conf(D, 'ui_gates = off\n'); rmSync(path.join(D, '.planning/design'), { recursive: true, force: true });
  OUT.v = doc();
  hasnt('ui_gates = off → no UI section', OUT.v, 'DESIGN.md');
  conf(D, 'ui_min_font = big\n');
  has('a bad ui_min_font → T018', doc('--json'), "ui_min_font = 'big' is not a number");
  conf(D, 'ui_min_font = 4\n');
  has('an out-of-range ui_min_font → T018', doc('--json'), "ui_min_font = '4' is out of range");
  conf(D, 'ui_min_font = 14\n');
  OUT.v = doc('--json');
  hasnt('ui_min_font = 14 is fine', OUT.v, /"T01[78]"/);
  has('--json lists the notes', OUT.v, /"notes":\[".*DESIGN.md is missing/);
  has('…the missing Playwright among them', OUT.v, 'no Playwright for gsdt-ui check');
  has('…it says install it once per machine', OUT.v, 'npm i -g playwright');
  w(path.join(W, 'global/node_modules/playwright/package.json'), '{}\n');
  hasnt('a global Playwright → no note', doc('--json'), 'no Playwright for');
  rmSync(path.join(W, 'global'), { recursive: true, force: true });
  w(path.join(D, 'node_modules/@playwright/test/package.json'), '{}\n');
  hasnt('a Playwright package on disk → no note (files only, nothing is run)', doc('--json'), 'no Playwright for');
  rmSync(path.join(D, 'node_modules'), { recursive: true, force: true });
  w(path.join(D, 'apps/web/node_modules/playwright/package.json'), '{}\n');
  hasnt('…also found in apps/*', doc('--json'), 'no Playwright for');
  rmSync(path.join(D, 'apps'), { recursive: true, force: true });
  w(path.join(D, '.planning/phases/03-web/03-SHOTS/home-375-aaaaaa.png'), 'png\n');
  git(D, 'add', '-A'); git(D, 'commit', '-qm', 'pictures committed');
  OUT.v = doc('--json');
  hasnt('warn: committed pictures are a note…', OUT.v, '"T081"');
  has('…that names the folder', OUT.v, 'pictures are committed in: .planning/phases/03-web/03-SHOTS');
  conf(D, 'ui_gates = strict\n');
  w(path.join(D, '.planning/design/DESIGN.md'), '# filled\n');
  has('strict: committed pictures → T081', doc('--json'), '"T081"');
  git(D, 'rm', '-r', '-q', '--cached', '.planning/phases/03-web/03-SHOTS');
  rmSync(path.join(D, '.planning/phases/03-web/03-SHOTS'), { recursive: true, force: true });
  git(D, 'commit', '-qm', 'pictures out');

  // UI debt of merged phases (ui_gates = strict, no flow = strict)
  const DP = path.join(D, '.planning/phases/03-web');
  w(path.join(D, '.planning/ROADMAP.md'), '# Roadmap\n\n- [x] **Phase 3: Web**\n- [x] **Phase 4: Api**\n\n### Phase 3: Web\n\n### Phase 4: Api\n');
  OUT.v = doc('--json');
  has('a merged phase with screens and no check → T040 ui-check', OUT.v, 'Phase 3 merged without: ui-check');
  hasnt('…the flow steps are not judged (flow is not strict)', OUT.v, 'code-review');
  hasnt('…a phase without screens is left alone', OUT.v, 'Phase 4 merged');
  w(path.join(DP, '03-SHOTS.md'), 'taken: x\n');
  hasnt('merged with 0.3.x screenshots → no debt', doc('--json'), '"T040"');
  rmSync(path.join(DP, '03-SHOTS.md')); uiFixCheck(DP, '03', 'failed');
  has('a failed check → ui-check', doc('--json'), 'Phase 3 merged without: ui-check');
  uiFixCheck(DP, '03', 'passed', 'cap1', '0000000000000000000000000000000000000000');
  OUT.v = doc('--json');
  has('a passed check, no approval → ui-approve', OUT.v, 'Phase 3 merged without: ui-approve');
  hasnt('…later code changes are not held against a merged phase', OUT.v, 'ui-check');
  uiFixApproval(DP, '03');
  hasnt('check + approval → no debt', doc('--json'), '"T040"');
  rmSync(path.join(DP, '03-UI-CHECK.md')); rmSync(path.join(DP, '03-UI-APPROVAL.md'));
  conf(D, 'ui_gates = strict\nflow_skip = 3\n');
  hasnt('flow_skip leaves the phase out', doc('--json'), '"T040"');
  conf(D);
  hasnt('warn: no UI debt is reported', doc('--json'), '"T040"');
  conf(D, 'flow = strict\n');
  OUT.v = doc('--json');
  has('flow = strict alone: the flow steps…', OUT.v, /Phase 3 merged without:.* ui-review/);
  hasnt('…but not the UI checks', OUT.v, 'ui-check');

  // optional add-ons (notes only)
  conf(D);
  OUT.v = doc('--json');
  has('screens → Impeccable is suggested', OUT.v, 'optional for claude — Impeccable design skill');
  hasnt('no Tailwind / shadcn → no shadcn MCP', OUT.v, 'shadcn MCP');
  hasnt('…suggestions are never findings', OUT.v, /"T0[0-9]*","message":"[^"]*optional/);
  w(path.join(D, 'package.json'), '{ "devDependencies": { "tailwindcss": "^4" } }\n');
  has('Tailwind → the shadcn MCP too', doc('--json'), 'shadcn MCP (the agent picks real components): npx shadcn@latest mcp init --client claude');
  rmSync(path.join(D, 'package.json'));
  w(path.join(D, 'apps/web/components.json'), '{}\n');
  has('a components.json in apps/* → the shadcn MCP', doc('--json'), 'shadcn MCP');
  mkdirSync(path.join(D, '.claude/skills/impeccable'), { recursive: true });
  w(path.join(D, '.mcp.json'), '{"mcpServers":{"shadcn":{}}}\n');
  hasnt('installed add-ons are not suggested again', doc('--json'), 'optional for');
  conf(D, 'providers = codex\n');
  rmSync(path.join(D, '.claude'), { recursive: true, force: true }); rmSync(path.join(D, '.mcp.json'));
  has('the text follows the provider', doc('--json'), /optional for codex — shadcn MCP: add \[mcp_servers\.shadcn\]/);
  rmSync(path.join(D, 'apps'), { recursive: true, force: true }); conf(D);
  const B = path.join(W, 'backend');
  initRepo(ENV, B);
  mkdirSync(path.join(B, '.planning/phases/01-api'), { recursive: true });
  w(path.join(B, '.planning/ROADMAP.md'), '# Roadmap\n');
  git(B, 'add', '-A'); git(B, 'commit', '-qm', 'init');
  hasnt('a project without screens gets no UI notes', g('gsdt-doctor', ['--repo', B], W).out, 'DESIGN.md');
});

test('gsdt-bootstrap-repo: --no-ui and the instructions', () => {
  for (const name of ['plain', 'noui']) {
    const T = path.join(W, name);
    initRepo(ENV, T);
    git(T, 'commit', '-q', '--allow-empty', '-m', 'init');
  }
  const plain = path.join(W, 'plain'), noui = path.join(W, 'noui');
  let r = g('gsdt-bootstrap-repo', [], plain);
  is('bootstrap runs', r.status, 0);
  let rules = g('gsdt-rules', ['--repo', plain], W).out;
  has('the rules (gsdt-rules) carry the screens rule', rules, 'Screens: every screen uses the design system');
  has('the flow order names the UI steps', rules, 'design');
  has('…the checks of the built pages', rules, 'UI check, UI look, UI approval, UI review');
  has('…and the commands', rules, 'gsdt-ui check <N>');
  fileHasnt('.gsd.conf leaves ui_gates at the default', path.join(plain, '.gsd.conf'), /^ui_gates/m);
  ok('no .planning/ is created (ingest-docs would switch to merge mode)', !existsSync(path.join(plain, '.planning')));
  r = g('gsdt-bootstrap-repo', ['--no-ui'], noui);
  is('bootstrap --no-ui runs', r.status, 0);
  fileHas('--no-ui writes ui_gates = off', path.join(noui, '.gsd.conf'), /^ui_gates = off/m);
  rules = g('gsdt-rules', ['--repo', noui], W).out;
  hasnt('…and no screens rule', rules, 'Screens:');
  g('gsdt-bootstrap-repo', ['--no-ui'], plain);
  fileHas('--no-ui on an existing .gsd.conf sets the key', path.join(plain, '.gsd.conf'), /^ui_gates = off/m);
  rules = g('gsdt-rules', ['--repo', plain], W).out;
  hasnt('…and drops the screens rule', rules, 'Screens:');
});

test.after(() => { server?.stop(); });
