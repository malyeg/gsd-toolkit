// The runner behind `gsdt-ui check` (docs/plan-ui-check.md; was lib/ui-check.mjs).
//
//   node src/launch.mjs ui-check <job file>
//
// Opens every page of a phase at three widths in the PROJECT's Playwright,
// measures it (C1–C8), takes the pictures, and writes into the job's `out`
// folder: the PNGs, index.html (the sheet) and UI-CHECK.md. bin/gsdt-ui
// publishes that folder only when this finished.
//
// Exit: 0 passed, 1 failed checks, 2 could not run (the reason is in
// <out>/error.txt and on stderr).
//
// Trust: this launches the project's own Playwright package, so it runs
// project code with the user's rights — like the project's test suite. It
// uses the library API only and never loads a Playwright config file.
//
// The job file is `key<TAB>value` lines; page, main_button, expect and waive
// may repeat (bin/gsdt-ui writes it from <P>-LAYOUT.md and .gsd.conf).
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The browser-side functions below run in the page, not in Node; there is no
// DOM lib in this project, so name the few globals they touch.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const document: any;
declare const window: any;
declare const getComputedStyle: any;
declare const CSS: any;
declare const axe: any;

export const SIZES: ReadonlyArray<readonly [number, number]> = [[375, 812], [768, 1024], [1440, 900]];
const BUDGET_MS = 30000; // per page and width: load, fonts, images, expect
const CUT = 200; // longest message in the committed report
const MAX_PER_CHECK = 50; // findings of one check in one picture
const WAIVABLE = ['C1', 'C3', 'C4', 'C5', 'C6', 'C7'];

// The few Playwright members used (no playwright dependency).
interface PwLocator {
  or(o: PwLocator): PwLocator;
  all(): Promise<PwHandle[]>;
  first(): PwLocator;
  waitFor(o: { state: string; timeout: number }): Promise<void>;
}
interface PwHandle {
  isVisible(): Promise<boolean>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  evaluate(fn: (node: any) => unknown): Promise<unknown>;
}
interface PwRequest { resourceType(): string }
interface PwResponse { request(): PwRequest; status(): number; url(): string }
interface PwPage {
  on(ev: string, fn: (a: any) => void): void;
  goto(url: string, o: { waitUntil: string; timeout: number }): Promise<PwResponse | null>;
  url(): string;
  addStyleTag(o: { content: string }): Promise<unknown>;
  evaluate(fn: any, arg?: any): Promise<any>;
  getByText(t: string): PwLocator;
  getByRole(role: string, o: { name: string; exact: boolean }): PwLocator;
  locator(sel: string): PwLocator;
  screenshot(o: { path: string; fullPage: boolean; animations: string }): Promise<unknown>;
}
interface PwContext { newPage(): Promise<PwPage>; close(): Promise<void> }
interface PwBrowser {
  newContext(o: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwChromium { launch(): Promise<PwBrowser> }

export class CannotRun extends Error {}
const cannot = (msg: string): never => { throw new CannotRun(msg); };
const errMsg = (e: unknown): string => String((e instanceof Error ? e.message : e) || e);
const firstLine = (e: unknown): string => errMsg(e).split('\n')[0] ?? '';
export const cut = (s: unknown, n: number = CUT): string => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
// ` | ` separates the fields of a report line; a newline would end it
export const cell = (s: unknown, n: number = CUT): string => cut(s, n).replace(/\s\|\s/g, ' / ');
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ESC[c] ?? c);
export const gitHash = (s: string): string =>
  createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0${s}`).digest('hex');

export interface Job {
  repo: string; out: string; url: string; phase: string; prefix: string;
  page: string[]; main_button: string[]; expect: string[]; waive: string[];
  pages: string[]; minfont: number; budget: number; strict: boolean;
  publish?: string; layout?: string; shots?: string; code?: string; sketch?: string;
  globalroot?: string; approot?: string; approot_from?: string;
  axe?: string; axever?: string; axeSource?: string;
}
export interface Waiver { check: string; page: string; size: string; target: string; reason: string; used?: boolean }
export interface Conf { button: Record<string, string>; expect: Record<string, string>; waivers: Waiver[] }
interface Finding { check: string; target: string; msg: string }
interface Note { check: string; msg: string }
export interface Shot { page: string; width: number; file: string; found: Finding[]; asked: Note[]; listed: Note[]; unchecked: Note[] }
export interface Playwright {
  name: string; version: string; dir: string; root: string; global?: boolean;
  load: () => { chromium?: PwChromium };
}

export function readJob(file: string): Job {
  const j: Record<string, any> = { page: [], main_button: [], expect: [], waive: [] };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const i = line.indexOf('\t');
    if (i < 1) continue;
    const k = line.slice(0, i), v = line.slice(i + 1).trim();
    if (Array.isArray(j[k])) j[k].push(v); else j[k] = v;
  }
  for (const k of ['repo', 'out', 'url', 'phase', 'prefix']) if (!j[k]) cannot(`the job file has no ${k}`);
  if (!j.page.length) cannot('the job file lists no page');
  j.pages = j.page.map((p: string) => (p.startsWith('/') ? p : '/' + p));
  j.minfont = Number(j.minfont || 12);
  j.budget = Number(j.budget) >= 1000 ? Number(j.budget) : BUDGET_MS;
  j.strict = j.strict === '1';
  return j as Job;
}

// `/page = value` lines → { page: value }; a line without `/page =` holds for every page
export function perPage(lines: string[], pages: string[], key: string): Record<string, string> {
  const map: Record<string, string> = {};
  let all: string | null = null;
  for (const line of lines) {
    const m = /^(\/\S*)\s+=\s+(.+)$/.exec(line);
    if (!m) { if (all !== null) cannot(`${key}: has two lines for every page`); all = line; continue; }
    const pg = m[1] as string;
    if (!pages.includes(pg)) cannot(`${key}: names ${pg}, which is not in pages:`);
    if (pg in map) cannot(`${key}: has two lines for ${pg}`);
    map[pg] = (m[2] as string).trim();
  }
  if (all !== null) for (const p of pages) if (!(p in map)) map[p] = all;
  return map;
}

export function readWaivers(lines: string[], pages: string[]): Waiver[] {
  return lines.map((line) => {
    const f = line.split('|').map((x) => x.trim());
    if (f.length < 5) cannot(`waive: needs 5 fields (<check> | <page> | <width> | <target> | <reason>): ${line}`);
    const [check = '', page = '', size = '', target = ''] = f;
    const reason = f.slice(4).join(' | ');
    if (!WAIVABLE.includes(check)) cannot(`waive: ${check} is not a check that can be waived (${WAIVABLE.join(', ')})`);
    if (page !== '*' && !pages.includes(page)) cannot(`waive: names ${page}, which is not in pages:`);
    if (size !== '*' && !SIZES.some(([w]) => String(w) === size)) cannot(`waive: ${size} is not a width (${SIZES.map(([w]) => w).join(', ')} or *)`);
    if (!target) cannot(`waive: has no target (a selector from the report, or *): ${line}`);
    if (!reason) cannot(`waive: has no reason: ${line}`);
    return { check, page, size, target, reason };
  });
}

// ── the project's Playwright ────────────────────────────────────────────────
// A script outside the project cannot `import` the project's packages, so
// resolve from a package root inside it.
function resolveAt(root: string): Playwright | null {
  if (!fs.existsSync(root)) return null;
  const req = createRequire(path.join(root, 'package.json'));
  for (const name of ['playwright', '@playwright/test']) {
    let entry: string;
    try { entry = req.resolve(name); } catch { continue; }
    let dir = path.dirname(entry), version = '?';
    for (let i = 0; i < 6; i++) {
      try {
        const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (pj.name === name) { version = pj.version; break; }
      } catch { /* keep walking up */ }
      dir = path.dirname(dir);
    }
    return { name, version, dir: fs.realpathSync(dir), root, load: () => req(name) };
  }
  return null;
}

export function findPlaywright(job: Job): Playwright {
  const rel = (d: string) => path.relative(job.repo, d) || '.';
  if (job.approot) {
    const root = path.resolve(job.repo, job.approot);
    return resolveAt(root) || cannot(`no Playwright in ${rel(root)} (${job.approot_from || 'app:'}). Install it there: npm i -D playwright && npx playwright install chromium`);
  }
  const atRoot = resolveAt(job.repo);
  if (atRoot) return atRoot;
  const found = new Map<string, Playwright>();
  for (const group of ['apps', 'packages']) {
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(job.repo, group)).sort(); } catch { continue; }
    for (const n of names) {
      const hit = resolveAt(path.join(job.repo, group, n));
      if (hit && !found.has(hit.dir)) found.set(hit.dir, hit);
    }
  }
  const hits = [...found.values()];
  if (hits.length === 1) return hits[0] as Playwright;
  if (hits.length > 1) cannot(`several Playwright installs (${hits.map((h) => rel(h.root)).join(', ')}) — say which app this phase uses, in ${job.layout || 'LAYOUT.md'}:  app: <folder>`);
  // Last: the machine's global install (npm i -g playwright), shared by every
  // project that has none of its own. Resolving from the folder above the
  // global node_modules finds the packages inside it.
  if (job.globalroot && path.basename(job.globalroot) === 'node_modules') {
    const hit = resolveAt(path.dirname(job.globalroot));
    if (hit) return { ...hit, global: true };
  }
  return cannot('Playwright not found in this project or globally. Once per machine: npm i -g playwright && npx playwright install chromium  (or in the app: npm i -D playwright)');
}

// ── in the page ─────────────────────────────────────────────────────────────
const NO_MOTION = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}';

async function settle(page: PwPage, left: () => number): Promise<void> {
  // one pass down the page wakes lazy images; then fonts and images
  await page.evaluate(async (ms: number) => {
    const sleep = (t: number) => new Promise((r) => setTimeout(r, t));
    const step = Math.max(200, window.innerHeight);
    for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 60; y += step, i++) { window.scrollTo(0, y); await sleep(40); }
    window.scrollTo(0, 0);
    const until = Date.now() + ms;
    try { await Promise.race([document.fonts.ready, sleep(ms)]); } catch { /* no font API */ }
    while (Date.now() < until && [...document.images].some((im: any) => !im.complete)) await sleep(100);
    await sleep(50);
  }, Math.max(500, Math.min(left(), 10000)));
}

interface Measured {
  c1: { over: number; target: string; right: number } | null;
  c2: Array<{ target: string; text: string }>;
  c4: Array<{ target: string; px: number; text: string; count: number }>;
  c5: Array<{ target: string; src: string }>;
}

// Runs in the browser (serialized by page.evaluate: keep it self-contained).
// Returns plain data only.
function measure({ minfont, okImages }: { minfont: number; okImages: string[] }): Measured {
  const out: Measured = { c1: null, c2: [], c4: [], c5: [] };
  const de = document.documentElement;
  const name = (el: any): string => {
    const one = (e: any): string => {
      if (e.id) return '#' + CSS.escape(e.id);
      const cls = [...e.classList].slice(0, 2).map((c: any) => '.' + CSS.escape(c)).join('');
      return e.tagName.toLowerCase() + cls;
    };
    const parts = [one(el)];
    for (let e = el.parentElement, i = 0; e && e !== document.body && i < 2 && !(parts[0] as string).startsWith('#'); e = e.parentElement, i++) parts.unshift(one(e));
    return parts.join(' > ');
  };
  const ownText = (el: any): string => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/\s+/g, ' ').trim();
  };
  // Hidden = not painted for a sighted user. Measured on the rendered box:
  // an `aria-hidden` or `sr-only` label says nothing about what is painted.
  const hiddenBox = new WeakMap();
  const boxHidden = (el: any): boolean => {
    if (hiddenBox.has(el)) return hiddenBox.get(el);
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    let h = cs.display === 'none' || parseFloat(cs.opacity) < 0.05
      || (cs.overflow !== 'visible' && (r.width <= 1 || r.height <= 1))
      || /inset\(\s*(50|100)%/.test(cs.clipPath || '')
      || /rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(cs.clip || '');
    if (!h && el.parentElement) h = boxHidden(el.parentElement);
    hiddenBox.set(el, h);
    return h;
  };
  const painted = (el: any): boolean => {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (cs.visibility !== 'visible' || r.width < 1 || r.height < 1) return false;
    if (r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0) return false;
    return !boxHidden(el);
  };

  // C1 — the page scrolls sideways
  const over = de.scrollWidth - de.clientWidth;
  if (over > 1) {
    let widest: any = null, right = de.clientWidth;
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > right + 0.5 && painted(el)) { right = r.right; widest = el; }
    }
    out.c1 = { over: Math.round(over), target: widest ? name(widest) : 'html', right: Math.round(right) };
  }

  const smallSeen = new Map<string, { target: string; px: number; text: string; count: number }>();
  for (const el of document.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION'].includes(el.tagName)) continue;
    const text = ownText(el);
    if (text.length < 2 || !painted(el)) continue;
    const cs = getComputedStyle(el);
    // C4 — small text; a transform that shrinks the box shrinks the text too.
    // offsetWidth is rounded to whole pixels, so a gap of 1px or less is rounding, not a shrink
    const boxW = el.getBoundingClientRect().width;
    const scale = el.offsetWidth > 0 && el.offsetWidth - boxW > 1 ? boxW / el.offsetWidth : 1;
    const px = parseFloat(cs.fontSize) * (scale > 0 && scale < 1 ? scale : 1);
    if (px < minfont - 0.01) {
      const key = name(el) + '|' + px.toFixed(1);
      const seen = smallSeen.get(key);
      if (seen) seen.count++; else smallSeen.set(key, { target: name(el), px: Math.round(px * 10) / 10, text: text.slice(0, 40), count: 1 });
    }
    // C2 — text that may be cut off by its own box
    const cutX = cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1;
    const cutY = cs.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1;
    const meant = cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none')
      || ['auto', 'scroll'].includes(cs.overflowX) || ['auto', 'scroll'].includes(cs.overflowY);
    if ((cutX || cutY) && !meant) out.c2.push({ target: name(el), text: text.slice(0, 40) });
  }
  out.c4 = [...smallSeen.values()];

  // C5 — broken <img> (CSS backgrounds are out of scope)
  for (const im of document.images) {
    const src = im.currentSrc || im.getAttribute('src') || '';
    if (!src || !im.complete || im.naturalWidth > 0) continue;
    if (okImages.includes(im.currentSrc || im.src)) continue; // loaded, but has no size of its own (some SVGs)
    out.c5.push({ target: name(im), src: src.slice(0, 120) });
  }
  return out;
}

interface AxeNode { target: string; ratio?: number; need?: string | number; fg?: string; bg?: string }

async function contrast(page: PwPage, axeSource: string): Promise<{ violations: AxeNode[]; incomplete: AxeNode[] }> {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const r = await axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] }, resultTypes: ['violations', 'incomplete'] });
    const nodes = (list: any[]) => list.flatMap((rule: any) => rule.nodes.map((n: any) => {
      const d = (n.any.find((c: any) => c.data && c.data.contrastRatio) || {}).data || {};
      return { target: n.target.flat().join(' '), ratio: d.contrastRatio, need: d.expectedContrastRatio, fg: d.fgColor, bg: d.bgColor };
    }));
    return { violations: nodes(r.violations), incomplete: nodes(r.incomplete) };
  });
}

async function mainButton(page: PwPage, want: string, width: number, height: number): Promise<string> {
  const loc = want.startsWith('css=')
    ? page.locator(want.slice(4))
    : page.getByRole('button', { name: want, exact: true }).or(page.getByRole('link', { name: want, exact: true }));
  const seen: PwHandle[] = [];
  for (const h of await loc.all()) if (await h.isVisible()) seen.push(h);
  const one = seen[0];
  if (!one) return 'not found on the page';
  if (seen.length > 1) return `${seen.length} matches — name exactly one (css=<selector>)`;
  const box = await one.boundingBox();
  if (!box) return 'has no box';
  if (box.y < 0 || box.x < 0 || box.y + box.height > height + 0.5 || box.x + box.width > width + 0.5) {
    return `not on the first screen (top ${Math.round(box.y)}px, screen ${height}px)`;
  }
  const covered = await one.evaluate((node: any) => {
    const r = node.getBoundingClientRect();
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as number[][]) {
      const hit = document.elementFromPoint(r.left + r.width * (fx as number), r.top + r.height * (fy as number));
      if (!hit || (hit !== node && !node.contains(hit))) {
        if (!hit) return 'nothing';
        const cls = [...hit.classList].slice(0, 2).map((c: any) => '.' + c).join('');
        return hit.id ? '#' + hit.id : hit.tagName.toLowerCase() + cls;
      }
    }
    return '';
  });
  return covered ? `covered by ${covered}` : '';
}

// ── one picture ─────────────────────────────────────────────────────────────
async function shoot(browser: PwBrowser, job: Job, conf: Conf, pagePath: string, [width, height]: readonly [number, number], file: string): Promise<Shot> {
  const found: Finding[] = [];
  const asked: Note[] = [];
  const listed: Note[] = [];
  const unchecked: Note[] = [];
  const add = (check: string, target: string, msg: string) => {
    if (found.filter((f) => f.check === check).length < MAX_PER_CHECK) found.push({ check, target: cell(target), msg: cell(msg) });
  };

  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, bypassCSP: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const okImages: string[] = [];
  page.on('pageerror', (e) => add('C6', 'page error', e && e.message ? e.message : String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && listed.length < 20) listed.push({ check: 'C6', msg: cell('console error: ' + m.text()) }); });
  page.on('response', (r: PwResponse) => { if (r.request().resourceType() === 'image' && r.status() < 400) okImages.push(r.url()); });

  const started = Date.now();
  const left = () => Math.max(1000, job.budget - (Date.now() - started));
  const target = new URL(job.url.replace(/\/$/, '') + pagePath);
  let loaded = false;
  try {
    const res = await page.goto(target.href, { waitUntil: 'load', timeout: job.budget });
    const same = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
    const now = new URL(page.url());
    if (res && res.status() >= 400) add('C8', 'load', `HTTP ${res.status()}`);
    else if (now.origin !== target.origin || !same(now.pathname, target.pathname)) add('C8', 'load', `landed on ${now.pathname} (another page — a login or a redirect?)`);
    else loaded = true;
  } catch (e) {
    add('C8', 'load', `could not open the page: ${firstLine(e)}`);
  }

  if (loaded) {
    await page.addStyleTag({ content: NO_MOTION }).catch(() => {});
    await settle(page, left).catch(() => {});
    const expect = conf.expect[pagePath];
    if (expect) {
      try { await page.getByText(expect).first().waitFor({ state: 'visible', timeout: left() }); }
      catch { add('C8', 'expect', `the text "${expect}" is not visible`); loaded = false; }
    }
  }

  if (loaded) {
    const m: Measured = await page.evaluate(measure, { minfont: job.minfont, okImages });
    if (m.c1) add('C1', m.c1.target, `the page scrolls sideways by ${m.c1.over}px; the widest element ends at ${m.c1.right}px`);
    for (const s of m.c4) add('C4', s.target, `text at ${s.px}px (minimum ${job.minfont}px): "${s.text}"${s.count > 1 ? ` — ${s.count} elements` : ''}`);
    for (const b of m.c5) add('C5', b.target, `image did not load: ${b.src}`);
    if (m.c2.length) {
      asked.push({ check: 'C2', msg: cell(`possible clipped text in ${m.c2.length} element(s): ${m.c2.slice(0, 5).map((c) => `${c.target} "${c.text}"`).join('; ')}`, 400) });
    }
    if (job.axeSource) {
      try {
        const c = await contrast(page, job.axeSource);
        for (const v of c.violations) add('C3', v.target, `contrast ${v.ratio ?? '?'}:1 (needs ${String(v.need ?? '4.5').replace(/:1$/, '')}:1), ${v.fg ?? '?'} on ${v.bg ?? '?'}`);
        if (c.incomplete.length) {
          asked.push({ check: 'C3', msg: cell(`contrast could not be measured for ${c.incomplete.length} element(s) (text over a picture or a gradient?): ${c.incomplete.slice(0, 5).map((n) => n.target).join('; ')}`) });
        }
      } catch (e) {
        unchecked.push({ check: 'C3', msg: cell(`the contrast check failed to run: ${firstLine(e)}`) });
      }
    } else unchecked.push({ check: 'C3', msg: 'axe-core is missing from the toolkit (lib/vendor/axe-core)' });

    const want = conf.button[pagePath];
    if (want && want !== 'none') {
      const wrong = await mainButton(page, want, width, height).catch((e) => `could not be tested: ${firstLine(e)}`);
      if (wrong) add('C7', want, `the main button is ${wrong}`);
    }
  }

  let shot = false;
  try {
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.screenshot({ path: path.join(job.out, file), fullPage: true, animations: 'disabled' });
    shot = true;
  } catch (e) {
    add('C8', 'picture', `no picture: ${firstLine(e)}`);
  }
  await context.close();
  return { page: pagePath, width, file: shot ? file : '', found, asked, listed, unchecked };
}

// ── the report ──────────────────────────────────────────────────────────────
export interface Report { status: string; capture: string; failures: string[]; waived: string[]; questions: string[]; unchecked: string[] }

export function report(job: Job, conf: Conf, pw: Playwright, shots: Shot[]): Report {
  const failures: string[] = [], waived: string[] = [], questions: string[] = [], unchecked: string[] = [], listed: string[] = [], lines: string[] = [];
  for (const s of shots) {
    for (const f of s.found) {
      const w = conf.waivers.find((x) => x.check === f.check && (x.page === '*' || x.page === s.page)
        && (x.size === '*' || x.size === String(s.width)) && (x.target === '*' || f.target.includes(x.target)));
      const line = `${f.check} | ${s.page} | ${s.width} | ${f.target} | ${f.msg}`;
      if (w) { w.used = true; waived.push(`${line} — waived: ${cell(w.reason)}`); } else failures.push(line);
    }
    for (const q of s.asked) questions.push(`Q${questions.length + 1} | ${s.page} | ${s.width} | ${q.check} | ${q.msg}`);
    for (const u of s.unchecked) unchecked.push(`${u.check} | ${s.page} | ${s.width} | ${u.msg}`);
    for (const l of s.listed) listed.push(`${l.check} | ${s.page} | ${s.width} | ${l.msg}`);
    if (s.file) lines.push(`${s.page} | ${s.width} | ${s.file}`);
  }
  for (const p of job.pages) if (!conf.button[p]) unchecked.push(`C7 | ${p} | * | main_button: is not set for this page in ${job.layout || 'LAYOUT.md'} (a text, css=<selector>, or none)`);
  for (const w of conf.waivers) if (!w.used) listed.push(`waive | ${w.page} | ${w.size} | matched nothing: ${w.check} ${cell(w.target)}`);

  const h = createHash('sha256');
  for (const s of [...shots].filter((x) => x.file).sort((a, b) => (a.file < b.file ? -1 : 1))) {
    h.update(s.file + '\0' + createHash('sha256').update(fs.readFileSync(path.join(job.out, s.file))).digest('hex') + '\n');
  }
  const capture = h.digest('hex').slice(0, 12);
  const failed = failures.length > 0 || (job.strict && unchecked.length > 0);
  const status = failed ? 'failed' : 'passed';
  const taken = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const runner = `${pw.name} ${pw.version} (${pw.global ? 'global' : path.relative(job.repo, pw.root) || '.'})`;
  const section = (title: string, list: string[], empty: string) => `## ${title}\n\n${list.length ? list.map((l) => '- ' + l).join('\n') : empty}\n`;

  const md = [
    '---',
    `status: ${status}`, `capture: ${capture}`, `taken: ${taken}`, `code: ${job.code || ''}`,
    `url: ${job.url}`, `runner: ${runner}`, `axe: ${job.axever || 'none'}`,
    `failures: ${failures.length}`, `waived: ${waived.length}`, `questions: ${questions.length}`, `unchecked: ${unchecked.length}`,
    '---', '',
    `# Phase ${job.phase} UI check`, '',
    `Written by \`gsdt-ui check ${job.phase}\` — do not edit. The pictures and the sheet are in`,
    `\`${job.shots || 'SHOTS'}/\` (local, not committed). Fields: check | page | width | target | what.`, '',
    section('Failures', failures, 'None.'),
    section('Waived', waived, 'None.'),
    section('Questions', questions, 'None.'),
    section('Not checked', unchecked, 'None.'),
    section('Listed', listed, 'None.'),
    section('Shots', lines, 'None.'),
  ].join('\n');
  fs.writeFileSync(path.join(job.out, 'UI-CHECK.md'), md);

  const group = (p: string) => shots.filter((s) => s.page === p);
  const sketch = job.sketch && !/^skip/.test(job.sketch)
    ? `<p>Chosen sketch: <a href="${esc(path.relative(job.publish || job.out, path.resolve(job.repo, job.sketch)))}/">${esc(job.sketch)}</a></p>` : '';
  const ul = (title: string, list: string[]) => (list.length ? `<h3>${esc(title)} (${list.length})</h3><ul>${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Phase ${esc(job.phase)} — pictures</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#f4f4f5;color:#18181b}
h1{margin:0 0 4px}h2{margin:40px 0 12px;padding-top:16px;border-top:1px solid #d4d4d8}h3{margin:16px 0 4px;font-size:15px}
.status{display:inline-block;padding:2px 10px;border-radius:999px;color:#fff;background:${failed ? '#b91c1c' : '#15803d'}}
.meta{color:#52525b}.row{display:flex;gap:16px;align-items:flex-start;overflow-x:auto;padding-bottom:12px}
figure{margin:0;flex:none}figcaption{font-weight:600;margin-bottom:4px}
img{display:block;border:1px solid #d4d4d8;background:#fff;max-height:1400px;width:auto}
.w375 img{max-width:280px}.w768 img{max-width:420px}.w1440 img{max-width:760px}
ul{margin:0;padding-left:20px}li{word-break:break-word}
</style></head><body>
<h1>Phase ${esc(job.phase)} — pictures</h1>
<p><span class="status">${esc(status)}</span> <span class="meta">capture ${esc(capture)} · ${esc(taken)} · ${esc(job.url)}</span></p>
${sketch}
${ul('Failures', failures)}${ul('Questions for the look', questions)}${ul('Not checked', unchecked)}${ul('Waived', waived)}
${job.pages.map((p) => `<h2>${esc(p)}</h2><div class="row">${group(p).map((s) => (s.file
    ? `<figure class="w${s.width}"><figcaption>${s.width}px</figcaption><a href="${encodeURIComponent(s.file)}"><img loading="lazy" src="${encodeURIComponent(s.file)}" alt="${esc(p)} at ${s.width}px"></a></figure>`
    : `<figure><figcaption>${s.width}px</figcaption><p>no picture</p></figure>`)).join('')}</div>`).join('\n')}
</body></html>
`;
  fs.writeFileSync(path.join(job.out, 'index.html'), html);
  return { status, capture, failures, waived, questions, unchecked };
}

// ── run ─────────────────────────────────────────────────────────────────────
// Exit code: 0 passed, 1 failed checks, 2 could not run.
export async function runJob(jobFile: string): Promise<number> {
  let job: Partial<Job> & { out: string } = { out: path.dirname(jobFile) };
  try {
    const j = readJob(jobFile);
    job = j;
    const conf: Conf = {
      button: perPage(j.main_button, j.pages, 'main_button'),
      expect: perPage(j.expect, j.pages, 'expect'),
      waivers: readWaivers(j.waive, j.pages),
    };
    if (j.axe && fs.existsSync(j.axe)) j.axeSource = fs.readFileSync(j.axe, 'utf8');
    const pw = findPlaywright(j);
    const { chromium } = pw.load();
    if (!chromium) return cannot(`${pw.name} in ${pw.root} has no chromium export`);
    let browser: PwBrowser;
    try { browser = await chromium.launch(); } catch (e) {
      cannot(/Executable doesn't exist|playwright install/i.test(errMsg(e))
        ? `Playwright ${pw.version} has no browser yet. Run in ${pw.root}:  npx playwright install chromium`
        : `the browser did not start: ${firstLine(e)}`);
      return 2;
    }
    const shots: Shot[] = [];
    try {
      for (const p of j.pages) {
        const slug = p.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/-$/, '') || 'home';
        for (const size of SIZES) shots.push(await shoot(browser, j, conf, p, size, `${slug}-${size[0]}-${gitHash(p).slice(0, 6)}.png`));
      }
    } finally { await browser.close(); }
    if (!shots.some((s) => s.file)) cannot('no picture could be taken');
    const r = report(j, conf, pw, shots);
    process.stdout.write(`status=${r.status}\ncapture=${r.capture}\nfailures=${r.failures.length}\nwaived=${r.waived.length}\nquestions=${r.questions.length}\nunchecked=${r.unchecked.length}\n`);
    return r.status === 'passed' ? 0 : 1;
  } catch (e) {
    const msg = e instanceof CannotRun ? e.message : `the runner crashed: ${String((e instanceof Error && e.stack) || e).split('\n').slice(0, 3).join(' ')}`;
    try { fs.writeFileSync(path.join(job.out, 'error.txt'), cut(msg, 400) + '\n'); } catch { /* the folder is gone */ }
    process.stderr.write(msg + '\n');
    return 2;
  }
}
