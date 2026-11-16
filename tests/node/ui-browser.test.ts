// tests/test-ui-browser.sh → node:test. The REAL runner behind `gsdt-ui check` (src/ui-check.ts) in a real browser,
// against the pages in tests/fixtures/ui/: one page per check (C1–C8), the questions, waivers, the capture id, the sheet,
// and how the runner finds the project's Playwright.
//
// Needs a folder with Playwright and its Chromium installed:
//   mkdir pw && cd pw && npm init -y && npm i -D playwright && npx playwright install chromium
//   GSD_PLAYWRIGHT_ROOT=$PWD node --test tests/node/ui-browser.test.ts
// Without GSD_PLAYWRIGHT_ROOT it SKIPS, exit 0. CI sets it. GSD_TEST_REQUIRE_BROWSER=1 turns the skip into a failure.
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  HOST_PLAYWRIGHT_ROOT, PKG, WIN, add, baseEnv, fileHas, fileHasnt, files, gitOk, gitOut, gsdt, has, initRepo, is, lf, mkWork, ok, pathWith, read, startServer, w,
} from './g4-env.ts';
import type { Env, Server } from './g4-env.ts';

// ── the bash suite's skip rules ──
const PWROOT = HOST_PLAYWRIGHT_ROOT;
const NO_BROWSER: string | false =
  PWROOT === '' ? 'GSD_PLAYWRIGHT_ROOT is not set (a folder with playwright installed)'
    : !existsSync(path.join(PWROOT, 'node_modules/playwright/package.json')) && !existsSync(path.join(PWROOT, 'node_modules/@playwright/test/package.json')) ? `no playwright in ${PWROOT}/node_modules`
      : false;
if (NO_BROWSER !== false && process.env.GSD_TEST_REQUIRE_BROWSER === '1') throw new Error(`SKIP is a failure (GSD_TEST_REQUIRE_BROWSER=1): ${NO_BROWSER}`);
if (NO_BROWSER !== false) process.stdout.write(`SKIP: ${NO_BROWSER}\n`);

// Chromium is found where the host's own Playwright keeps it, although HOME here is a throwaway.
const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH
  ?? (process.platform === 'darwin' ? path.join(homedir(), 'Library', 'Caches', 'ms-playwright')
    : WIN ? path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'), 'ms-playwright')
      : path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'ms-playwright'));

const W = mkWork('g4uib-');
const ENV: Env = baseEnv(W, { GSD_UI_BUDGET_MS: '4000', GSD_NPM_GLOBAL_ROOT: path.join(W, 'global', 'node_modules'), PLAYWRIGHT_BROWSERS_PATH: BROWSERS });
ENV.PATH = pathWith(...(process.env.PATH ?? '').split(path.delimiter).filter((d) => d !== ''));
const git = (cwd: string, ...args: string[]): void => { gitOk(ENV, cwd, args); };
const g = (args: string[], env: Env = {}) => gsdt(ENV, 'gsdt-ui', args, { cwd: R, env });

const R = path.join(W, 'app');
const PD = path.join(R, '.planning/phases/07-blog');
const CHECK = path.join(PD, '07-UI-CHECK.md');
const conf = (text = ''): void => w(path.join(R, '.gsd.conf'), `base = develop\ninstall = none\n${text}`);
let PORT = 0;
let OUT = '';
const servers: Server[] = [];

// layout <line>… — write the phase LAYOUT: the address, then the lines given
const layout = (...ls: string[]): void => w(path.join(PD, '07-LAYOUT.md'), `sketch: skip a test\nurl: http://127.0.0.1:${PORT}\n${ls.map((l) => `${l}\n`).join('')}`);
const check = (): number => { const r = g(['check', '7'], { GSD_PLAYWRIGHT_ROOT: PWROOT }); OUT = r.out; return r.status; };
const nocheck = (): number => { const r = g(['check', '7'], { GSD_PLAYWRIGHT_ROOT: undefined }); OUT = r.out; return r.status; };
/** the value of key in the report's front matter (sed -n '/^---$/,/^---$/p' | sed -n "s/^key: //p") */
function fmv(key: string): string {
  const out: string[] = [];
  let on = false;
  for (const l of lf(read(CHECK)).split('\n')) {
    if (!on && l === '---') on = true;
    else if (on) {
      if (l === '---') on = false;
      else if (l.startsWith(`${key}: `)) out.push(l.slice(key.length + 2));
    }
  }
  return out.join('\n');
}
/** grep BRE → JS: | ( ) { } + ? are plain characters in a basic regex */
const bre = (p: string): RegExp => new RegExp(p.replace(/[|(){}+?]/g, '\\$&'));
/** finds <section> <start of a line> — how many lines of that report section start so (grep -c "^- <start>") */
function finds(section: string, start: string): number {
  const re = bre(`^- ${start}`);
  let on = false, n = 0;
  for (const l of lf(read(CHECK)).split('\n')) {
    if (l.startsWith('## ')) on = l === `## ${section}`;
    else if (on && re.test(l)) n++;
  }
  return n;
}
let cap1 = '';

test('setup: the pages are served, the repo is on phase-7-blog', { skip: NO_BROWSER }, async () => {
  const s = await startServer(path.join(PKG, 'tests/fixtures/ui'));
  servers.push(s); PORT = s.port;
  initRepo(ENV, R);
  mkdirSync(PD, { recursive: true });
  conf();
  git(R, 'add', '-A'); git(R, 'commit', '-qm', 'init');
  git(R, 'checkout', '-q', '-b', 'phase-7-blog');
});

test('a clean page passes', { skip: NO_BROWSER }, () => {
  layout('pages: /good.html', 'main_button: Get started', 'expect: /good.html = Welcome home');
  const rc = check();
  is('exit 0', rc, 0);
  is('status: passed, nothing open', `${fmv('status')}/${fmv('failures')}/${fmv('unchecked')}/${fmv('questions')}`, 'passed/0/0/0');
  is('three pictures are listed', finds('Shots', '/good.html | '), 3);
  is('…and are on disk, with the sheet', `${files(path.join(PD, '07-SHOTS')).filter((f) => /^good-html-.*\.png$/.test(f)).length}/${existsSync(path.join(PD, '07-SHOTS/index.html')) ? 'sheet' : ''}`, '3/sheet');
  fileHas('the report names the runner and its version', CHECK, /^runner: [@a-z/]* [0-9]/m);
  fileHas('…and the pinned axe-core', CHECK, new RegExp(`^axe: ${read(path.join(PKG, 'lib/vendor/axe-core/VERSION')).trim().replace(/\./g, '\\.')}$`, 'm'));
  is('pictures are not staged by git add -A', gitOut(ENV, R, ['add', '-A', '-n']).split('\n').filter((l) => l.includes('SHOTS')).length, 0);
  cap1 = fmv('capture');
  check();
  is('the same pages give the same capture id', fmv('capture'), cap1);
});

test('one page per check', { skip: NO_BROWSER }, () => {
  layout('pages: /wide.html, /contrast.html, /small.html, /image.html, /error.html, /covered.html, /low.html, /twice.html, /clip.html, /redirect.html, /nope.html, /good.html',
    'main_button: /covered.html = Buy now', 'main_button: /low.html = Buy now', 'main_button: /twice.html = Buy now',
    'main_button: /good.html = css=button', 'main_button: /wide.html = none',
    'expect: /error.html = Text that is not on the page');
  const rc = check();
  is('exit 1', rc, 1);
  is('status: failed', fmv('status'), 'failed');
  ok('other pages give another capture id', fmv('capture') !== cap1);
  is('C1 the page scrolls sideways, at each width', finds('Failures', 'C1 | /wide.html | [0-9]* | div.too-wide | '), 3);
  is('C3 low contrast', finds('Failures', 'C3 | /contrast.html | 375 | .faint | contrast 2.32:1 (needs 4.5:1)'), 1);
  is('C3 text over a picture is a question, not a pass', finds('Questions', 'Q[0-9]* | /contrast.html | 375 | C3 | contrast could not be measured for 1 element'), 1);
  is('C4 small text', finds('Failures', 'C4 | /small.html | 375 | span.tiny | text at 10px (minimum 12px)'), 1);
  is('C4 text hidden from screen readers only is still seen', finds('Failures', 'C4 | /small.html | 375 | span.decor | '), 1);
  is('C4 text shrunk by a transform', finds('Failures', 'C4 | /small.html | 375 | div.shrunk | text at 8px'), 1);
  is('C4 a fractional box width (49.6px, offsetWidth 50) is rounding, not a shrink', finds('Failures', 'C4 | /small.html | 375 | span.frac'), 0);
  is('C4 text for screen readers (a 1px box) is not counted', finds('Failures', 'C4 | /small.html | 375 | span.reader-only'), 0);
  is('C5 a lazy image far down the page', finds('Failures', 'C5 | /image.html | 375 | img.late | image did not load'), 1);
  is('C6 an uncaught error fails', finds('Failures', 'C6 | /error.html | 375 | page error | boom in the page'), 1);
  is('C6 a console error is only listed', `${finds('Listed', 'C6 | /error.html | 375 | console error: listed only')}/${finds('Failures', 'C6 | /error.html | 375 | .*listed only')}`, '1/0');
  is('C7 the button is covered', finds('Failures', 'C7 | /covered.html | 375 | Buy now | the main button is covered by div.banner'), 1);
  is('C7 the button is below the first screen', finds('Failures', 'C7 | /low.html | 375 | Buy now | the main button is not on the first screen'), 1);
  is('C7 two matches', finds('Failures', 'C7 | /twice.html | 375 | Buy now | the main button is 2 matches'), 1);
  is('C7 css=<selector> finds the button', finds('Failures', 'C7 | /good.html'), 0);
  is('C7 a page without main_button: is not checked', finds('Not checked', 'C7 | /clip.html | [*] | main_button: is not set'), 1);
  is('C7 main_button: none is not reported', finds('Not checked', 'C7 | /wide.html'), 0);
  is('C8 the expected text is missing', finds('Failures', 'C8 | /error.html | 375 | expect | the text "Text that is not on the page" is not visible'), 1);
  is('C8 the page is another page (a redirect)', finds('Failures', 'C8 | /redirect.html | 375 | load | '), 1);
  is('C8 HTTP 404', finds('Failures', 'C8 | /nope.html | 375 | load | HTTP 404'), 1);
  is('C2 clipped text is a question', finds('Questions', 'Q[0-9]* | /clip.html | 375 | C2 | possible clipped text in 1 element(s): div.box'), 1);
  is('C2 text cut with dots on purpose is not asked about', finds('Questions', '.*div.dots'), 0);
  is('the clean page has no failure', finds('Failures', '[A-Z0-9]* | /good.html'), 0);
  has('the output lists the findings', OUT, 'C1 | /wide.html | 375');
  fileHas('the sheet shows a page path', path.join(PD, '07-SHOTS/index.html'), '<h2>/wide.html</h2>');
});

test('waivers, strict, the minimum font', { skip: NO_BROWSER }, () => {
  layout('pages: /contrast.html, /small.html', 'main_button: none',
    'waive: C3 | /contrast.html | * | .faint | the brand grey, agreed with the user',
    'waive: C4 | * | 375 | span.tiny | legal line',
    'waive: C1 | * | * | * | matches nothing');
  check();
  is('a waived finding is listed, not counted', `${finds('Waived', 'C3 | /contrast.html | 375 | .faint | .* — waived: the brand grey')}/${finds('Failures', 'C3 | ')}`, '1/0');
  is('a waiver for one width leaves the others', `${finds('Waived', 'C4 | /small.html | 375 | span.tiny')}/${finds('Failures', 'C4 | /small.html | 768 | span.tiny')}`, '1/1');
  is('a waiver that matched nothing is listed', finds('Listed', 'waive | [*] | [*] | matched nothing: C1'), 1);
  is('waived: counts them', fmv('waived'), 4);
  layout('pages: /good.html');
  let rc = check();
  is('warn: a page without main_button: passes, counted as not checked', `${rc}/${fmv('status')}/${fmv('unchecked')}`, '0/passed/1');
  conf('ui_gates = strict\nui_min_font = 20\n');
  rc = check();
  is('strict: not checked is a failure', `${rc}/${fmv('status')}`, '1/failed');
  is('ui_min_font = 20 → the 16px text fails', finds('Failures', 'C4 | /good.html | 375 | .* | text at 16px (minimum 20px)'), 2);
  conf();
});

test('bad LAYOUT lines stop the run', { skip: NO_BROWSER }, () => {
  const refuses = (label: string, reason: string): void => {
    const rc = check();
    ok(label, rc === 2 && OUT.includes(reason) && fmv('status') === 'error', `exit ${rc}: ${OUT.split('\n').slice(-4).join('\n')}`);
  };
  layout('pages: /good.html', 'waive: C3 | /good.html | 375 | .x');
  refuses('a waiver without a reason', 'waive: needs 5 fields');
  layout('pages: /good.html', 'waive: C8 | * | * | * | we like 404');
  refuses('a waiver for a check that cannot be waived', 'C8 is not a check that can be waived');
  layout('pages: /good.html', 'waive: C3 | /other.html | * | * | reason');
  refuses('a waiver for a page that is not in pages:', 'which is not in pages:');
  layout('pages: /good.html', 'main_button: /other.html = Go');
  refuses('main_button: for a page that is not in pages:', 'main_button: names /other.html');
  layout('pages: /good.html', 'main_button: /good.html = Go', 'main_button: /good.html = Stop');
  refuses('two main_button: lines for one page', 'main_button: has two lines for /good.html');
  is('no pictures stay after a run that could not finish', files(path.join(PD, '07-SHOTS'), ['.gitignore']).length, 0);
});

test("finding the project's Playwright", { skip: NO_BROWSER }, () => {
  layout('pages: /good.html', 'main_button: Get started');
  // a folder that resolves `playwright` but is not the real one (never loaded: the runner stops at "several installs" before it loads anything)
  const fake = (d: string): void => {
    w(path.join(R, d, 'node_modules/playwright/package.json'), '{"name":"playwright","version":"0.0.1","main":"index.js"}\n');
    w(path.join(R, d, 'node_modules/playwright/index.js'), 'module.exports = {};\n');
    w(path.join(R, d, 'package.json'), '{"name":"x"}\n');
  };
  w(path.join(R, '.gitignore'), 'node_modules/\n');
  let rc = nocheck();
  is('no Playwright anywhere → exit 2', rc, 2);
  has('…says how to install it once per machine', OUT, 'npm i -g playwright');
  mkdirSync(path.join(W, 'global'), { recursive: true });
  symlinkSync(path.join(PWROOT, 'node_modules'), path.join(W, 'global', 'node_modules'), 'junction');
  rc = nocheck();
  is('no Playwright in the project → the global one', `${rc}/${fmv('status')}`, '0/passed');
  fileHas('…and the report says so', CHECK, /^runner: .* \(global\)$/m);
  fake('apps/web'); fake('apps/admin');
  rc = nocheck();
  // (the global install is still there: a project with its own installs never falls back to it)
  is('two installs, no app: → exit 2', rc, 2);
  has('…asks for app: and names both', OUT, 'several Playwright installs (apps/admin, apps/web)');
  rmSync(path.join(R, 'apps/admin'), { recursive: true, force: true });
  rmSync(path.join(R, 'apps/web'), { recursive: true, force: true });
  rmSync(path.join(W, 'global'), { recursive: true, force: true });
  w(path.join(R, 'apps/web/package.json'), '{"name":"web"}\n');
  symlinkSync(path.join(PWROOT, 'node_modules'), path.join(R, 'apps/web/node_modules'), 'junction');
  rc = nocheck();
  is('one install in apps/* is found', `${rc}/${fmv('status')}`, '0/passed');
  fileHas('…and recorded with its folder', CHECK, /^runner: .* \(apps\/web\)$/m);
  fake('apps/admin');
  add(path.join(PD, '07-LAYOUT.md'), 'app: apps/web\n');
  rc = nocheck();
  is('app: picks one of several', `${rc}/${fmv('status')}`, '0/passed');
  const L = path.join(PD, '07-LAYOUT.md');
  w(L, read(L).replace(/^app:.*$/m, 'app: apps/none'));
  rc = nocheck();
  is('app: without Playwright → exit 2', rc, 2);
  has('…names the folder', OUT, 'no Playwright in apps/none (app: in 07-LAYOUT.md)');
  rmSync(path.join(R, 'apps'), { recursive: true, force: true });
});

test('the sheet escapes what it shows', { skip: NO_BROWSER }, async () => {
  mkdirSync(path.join(W, 'site2'), { recursive: true });
  w(path.join(W, 'site2/x.html'),
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>x</title></head><body style="font:16px sans-serif">\n' +
    '<h1>Inject</h1><span class="a&quot;><script>alert(1)</script>" style="font-size:9px">tiny &lt;img src=x onerror=alert(2)&gt; text</span>\n' +
    '</body></html>\n');
  const s2 = await startServer(path.join(W, 'site2'));
  servers.push(s2);
  w(path.join(PD, '07-LAYOUT.md'), `sketch: skip a test\nurl: http://127.0.0.1:${s2.port}\npages: /x.html\nmain_button: none\n`);
  check();
  is('the finding is reported', finds('Failures', 'C4 | /x.html | 375 | '), 1);
  const sheet = path.join(PD, '07-SHOTS/index.html');
  fileHasnt('no tag from the page reaches the sheet', sheet, /<script>alert|<img src=x/);
  fileHas('…it is shown as text', sheet, '&lt;img src=x onerror=alert(2)&gt;');
});

test.after(() => { for (const s of servers) s.stop(); });
