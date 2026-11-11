#!/usr/bin/env node
// lib/ui-check.mjs — the runner behind `gsdt-ui check` (docs/plan-ui-check.md).
//
//   node ui-check.mjs <job file>
//
// Opens every page of a phase at three widths in the PROJECT's Playwright,
// measures it (C1–C8), takes the pictures, and writes into the job's `out`
// folder: the PNGs, index.html (the sheet) and UI-CHECK.md. bin/gsdt-ui
// publishes that folder only when this script finished.
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

const SIZES = [[375, 812], [768, 1024], [1440, 900]];
const BUDGET_MS = 30000;   // per page and width: load, fonts, images, expect
const CUT = 200;           // longest message in the committed report
const MAX_PER_CHECK = 50;  // findings of one check in one picture
const WAIVABLE = ['C1', 'C3', 'C4', 'C5', 'C6', 'C7'];

class CannotRun extends Error {}
const cannot = (msg) => { throw new CannotRun(msg); };
const cut = (s, n = CUT) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// ` | ` separates the fields of a report line; a newline would end it
const cell = (s, n = CUT) => cut(s, n).replace(/\s\|\s/g, ' / ');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gitHash = (s) => createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0${s}`).digest('hex');

function readJob(file) {
  const job = { page: [], main_button: [], expect: [], waive: [] };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const i = line.indexOf('\t');
    if (i < 1) continue;
    const k = line.slice(0, i), v = line.slice(i + 1).trim();
    if (Array.isArray(job[k])) job[k].push(v); else job[k] = v;
  }
  for (const k of ['repo', 'out', 'url', 'phase', 'prefix']) if (!job[k]) cannot(`the job file has no ${k}`);
  if (!job.page.length) cannot('the job file lists no page');
  job.pages = job.page.map((p) => (p.startsWith('/') ? p : '/' + p));
  job.minfont = Number(job.minfont || 12);
  job.budget = Number(job.budget) >= 1000 ? Number(job.budget) : BUDGET_MS;
  job.strict = job.strict === '1';
  return job;
}

// `/page = value` lines → { page: value }; a line without `/page =` holds for every page
function perPage(lines, pages, key) {
  const map = {}; let all = null;
  for (const line of lines) {
    const m = /^(\/\S*)\s+=\s+(.+)$/.exec(line);
    if (!m) { if (all !== null) cannot(`${key}: has two lines for every page`); all = line; continue; }
    if (!pages.includes(m[1])) cannot(`${key}: names ${m[1]}, which is not in pages:`);
    if (m[1] in map) cannot(`${key}: has two lines for ${m[1]}`);
    map[m[1]] = m[2].trim();
  }
  if (all !== null) for (const p of pages) if (!(p in map)) map[p] = all;
  return map;
}

function readWaivers(lines, pages) {
  return lines.map((line) => {
    const f = line.split('|').map((x) => x.trim());
    if (f.length < 5) cannot(`waive: needs 5 fields (<check> | <page> | <width> | <target> | <reason>): ${line}`);
    const [check, page, size, target] = f, reason = f.slice(4).join(' | ');
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
function resolveAt(root) {
  if (!fs.existsSync(root)) return null;
  const req = createRequire(path.join(root, 'package.json'));
  for (const name of ['playwright', '@playwright/test']) {
    let entry;
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

function findPlaywright(job) {
  const rel = (d) => path.relative(job.repo, d) || '.';
  if (job.approot) {
    const root = path.resolve(job.repo, job.approot);
    return resolveAt(root) || cannot(`no Playwright in ${rel(root)} (${job.approot_from || 'app:'}). Install it there: npm i -D playwright && npx playwright install chromium`);
  }
  const atRoot = resolveAt(job.repo);
  if (atRoot) return atRoot;
  const found = new Map();
  for (const group of ['apps', 'packages']) {
    let names = [];
    try { names = fs.readdirSync(path.join(job.repo, group)).sort(); } catch { continue; }
    for (const n of names) {
      const hit = resolveAt(path.join(job.repo, group, n));
      if (hit && !found.has(hit.dir)) found.set(hit.dir, hit);
    }
  }
  if (found.size === 1) return [...found.values()][0];
  if (found.size > 1) cannot(`several Playwright installs (${[...found.values()].map((h) => rel(h.root)).join(', ')}) — say which app this phase uses, in ${job.layout || 'LAYOUT.md'}:  app: <folder>`);
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

async function settle(page, left) {
  // one pass down the page wakes lazy images; then fonts and images
  await page.evaluate(async (ms) => {
    const sleep = (t) => new Promise((r) => setTimeout(r, t));
    const step = Math.max(200, window.innerHeight);
    for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 60; y += step, i++) { window.scrollTo(0, y); await sleep(40); }
    window.scrollTo(0, 0);
    const until = Date.now() + ms;
    try { await Promise.race([document.fonts.ready, sleep(ms)]); } catch { /* no font API */ }
    while (Date.now() < until && [...document.images].some((im) => !im.complete)) await sleep(100);
    await sleep(50);
  }, Math.max(500, Math.min(left(), 10000)));
}

// Runs in the browser. Returns plain data only.
function measure({ minfont, okImages }) {
  const out = { c1: null, c2: [], c4: [], c5: [] };
  const de = document.documentElement;
  const name = (el) => {
    const one = (e) => {
      if (e.id) return '#' + CSS.escape(e.id);
      const cls = [...e.classList].slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
      return e.tagName.toLowerCase() + cls;
    };
    const parts = [one(el)];
    for (let e = el.parentElement, i = 0; e && e !== document.body && i < 2 && !parts[0].startsWith('#'); e = e.parentElement, i++) parts.unshift(one(e));
    return parts.join(' > ');
  };
  const ownText = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/\s+/g, ' ').trim();
  };
  // Hidden = not painted for a sighted user. Measured on the rendered box:
  // an `aria-hidden` or `sr-only` label says nothing about what is painted.
  const hiddenBox = new WeakMap();
  const boxHidden = (el) => {
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
  const painted = (el) => {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (cs.visibility !== 'visible' || r.width < 1 || r.height < 1) return false;
    if (r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0) return false;
    return !boxHidden(el);
  };

  // C1 — the page scrolls sideways
  const over = de.scrollWidth - de.clientWidth;
  if (over > 1) {
    let widest = null, right = de.clientWidth;
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > right + 0.5 && painted(el)) { right = r.right; widest = el; }
    }
    out.c1 = { over: Math.round(over), target: widest ? name(widest) : 'html', right: Math.round(right) };
  }

  const smallSeen = new Map();
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
    if (okImages.includes(im.currentSrc || im.src)) continue;   // loaded, but has no size of its own (some SVGs)
    out.c5.push({ target: name(im), src: src.slice(0, 120) });
  }
  return out;
}

async function contrast(page, axeSource) {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] }, resultTypes: ['violations', 'incomplete'] });
    const nodes = (list) => list.flatMap((rule) => rule.nodes.map((n) => {
      const d = (n.any.find((c) => c.data && c.data.contrastRatio) || {}).data || {};
      return { target: n.target.flat().join(' '), ratio: d.contrastRatio, need: d.expectedContrastRatio, fg: d.fgColor, bg: d.bgColor };
    }));
    return { violations: nodes(r.violations), incomplete: nodes(r.incomplete) };
  });
}

async function mainButton(page, want, width, height) {
  const loc = want.startsWith('css=')
    ? page.locator(want.slice(4))
    : page.getByRole('button', { name: want, exact: true }).or(page.getByRole('link', { name: want, exact: true }));
  const seen = [];
  for (const h of await loc.all()) if (await h.isVisible()) seen.push(h);
  if (seen.length === 0) return 'not found on the page';
  if (seen.length > 1) return `${seen.length} matches — name exactly one (css=<selector>)`;
  const box = await seen[0].boundingBox();
  if (!box) return 'has no box';
  if (box.y < 0 || box.x < 0 || box.y + box.height > height + 0.5 || box.x + box.width > width + 0.5) {
    return `not on the first screen (top ${Math.round(box.y)}px, screen ${height}px)`;
  }
  const covered = await seen[0].evaluate((node) => {
    const r = node.getBoundingClientRect();
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
      if (!hit || (hit !== node && !node.contains(hit))) {
        if (!hit) return 'nothing';
        const cls = [...hit.classList].slice(0, 2).map((c) => '.' + c).join('');
        return hit.id ? '#' + hit.id : hit.tagName.toLowerCase() + cls;
      }
    }
    return '';
  });
  return covered ? `covered by ${covered}` : '';
}

// ── one picture ─────────────────────────────────────────────────────────────
async function shoot(browser, job, conf, pagePath, [width, height], file) {
  const found = [];   // { check, target, msg }
  const asked = [];   // { check, msg }
  const listed = [];  // { check, msg }
  const unchecked = [];
  const add = (check, target, msg) => { if (found.filter((f) => f.check === check).length < MAX_PER_CHECK) found.push({ check, target: cell(target), msg: cell(msg) }); };

  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, bypassCSP: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const okImages = [];
  page.on('pageerror', (e) => add('C6', 'page error', e && e.message ? e.message : String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && listed.length < 20) listed.push({ check: 'C6', msg: cell('console error: ' + m.text()) }); });
  page.on('response', (r) => { if (r.request().resourceType() === 'image' && r.status() < 400) okImages.push(r.url()); });

  const started = Date.now();
  const left = () => Math.max(1000, job.budget - (Date.now() - started));
  const target = new URL(job.url.replace(/\/$/, '') + pagePath);
  let loaded = false;
  try {
    const res = await page.goto(target.href, { waitUntil: 'load', timeout: job.budget });
    const same = (a, b) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
    const now = new URL(page.url());
    if (res && res.status() >= 400) add('C8', 'load', `HTTP ${res.status()}`);
    else if (now.origin !== target.origin || !same(now.pathname, target.pathname)) add('C8', 'load', `landed on ${now.pathname} (another page — a login or a redirect?)`);
    else loaded = true;
  } catch (e) {
    add('C8', 'load', `could not open the page: ${String(e.message || e).split('\n')[0]}`);
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
    const m = await page.evaluate(measure, { minfont: job.minfont, okImages });
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
        unchecked.push({ check: 'C3', msg: cell(`the contrast check failed to run: ${String(e.message || e).split('\n')[0]}`) });
      }
    } else unchecked.push({ check: 'C3', msg: 'axe-core is missing from the toolkit (lib/vendor/axe-core)' });

    const want = conf.button[pagePath];
    if (want && want !== 'none') {
      const wrong = await mainButton(page, want, width, height).catch((e) => `could not be tested: ${String(e.message || e).split('\n')[0]}`);
      if (wrong) add('C7', want, `the main button is ${wrong}`);
    }
  }

  let shot = false;
  try {
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.screenshot({ path: path.join(job.out, file), fullPage: true, animations: 'disabled' });
    shot = true;
  } catch (e) {
    add('C8', 'picture', `no picture: ${String(e.message || e).split('\n')[0]}`);
  }
  await context.close();
  return { page: pagePath, width, file: shot ? file : '', found, asked, listed, unchecked };
}

// ── the report ──────────────────────────────────────────────────────────────
function report(job, conf, pw, shots) {
  const failures = [], waived = [], questions = [], unchecked = [], listed = [], lines = [];
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
  const section = (title, list, empty) => `## ${title}\n\n${list.length ? list.map((l) => '- ' + l).join('\n') : empty}\n`;

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

  const group = (p) => shots.filter((s) => s.page === p);
  const sketch = job.sketch && !/^skip/.test(job.sketch)
    ? `<p>Chosen sketch: <a href="${esc(path.relative(job.publish || job.out, path.resolve(job.repo, job.sketch)))}/">${esc(job.sketch)}</a></p>` : '';
  const ul = (title, list) => (list.length ? `<h3>${esc(title)} (${list.length})</h3><ul>${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '');
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

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const jobFile = process.argv[2];
  if (!jobFile) { process.stderr.write('usage: ui-check.mjs <job file>\n'); process.exit(64); }
  let job = { out: path.dirname(jobFile) };
  try {
    job = readJob(jobFile);
    const conf = {
      button: perPage(job.main_button, job.pages, 'main_button'),
      expect: perPage(job.expect, job.pages, 'expect'),
      waivers: readWaivers(job.waive, job.pages),
    };
    if (job.axe && fs.existsSync(job.axe)) job.axeSource = fs.readFileSync(job.axe, 'utf8');
    const pw = findPlaywright(job);
    const { chromium } = pw.load();
    if (!chromium) cannot(`${pw.name} in ${pw.root} has no chromium export`);
    let browser;
    try { browser = await chromium.launch(); } catch (e) {
      const first = String(e.message || e).split('\n')[0];
      cannot(/Executable doesn't exist|playwright install/i.test(String(e.message))
        ? `Playwright ${pw.version} has no browser yet. Run in ${pw.root}:  npx playwright install chromium`
        : `the browser did not start: ${first}`);
    }
    const shots = [];
    try {
      for (const p of job.pages) {
        const slug = p.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/-$/, '') || 'home';
        for (const size of SIZES) shots.push(await shoot(browser, job, conf, p, size, `${slug}-${size[0]}-${gitHash(p).slice(0, 6)}.png`));
      }
    } finally { await browser.close(); }
    if (!shots.some((s) => s.file)) cannot('no picture could be taken');
    const r = report(job, conf, pw, shots);
    process.stdout.write(`status=${r.status}\ncapture=${r.capture}\nfailures=${r.failures.length}\nwaived=${r.waived.length}\nquestions=${r.questions.length}\nunchecked=${r.unchecked.length}\n`);
    process.exit(r.status === 'passed' ? 0 : 1);
  } catch (e) {
    const msg = e instanceof CannotRun ? e.message : `the runner crashed: ${String((e && e.stack) || e).split('\n').slice(0, 3).join(' ')}`;
    try { fs.writeFileSync(path.join(job.out, 'error.txt'), cut(msg, 400) + '\n'); } catch { /* the folder is gone */ }
    process.stderr.write(msg + '\n');
    process.exit(2);
  }
}

main();
