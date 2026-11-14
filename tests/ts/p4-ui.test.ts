// P4 parity (lib/ui.sh → src/ui.ts): every gsd_ui_* function in bash and its
// TypeScript twin on the same fixture repos; outputs (and rc where it means
// something) must match byte for byte. Run: node --test tests/ts/p4-ui.test.ts
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as U from '../../src/ui.ts';
import { finishGates } from '../../src/common.ts';
import { bash, chomp, repo, sh, tmp, withEnv, write } from './helpers.ts';

type Env = Record<string, string | undefined>;

/** bash side: the function's stdout (as `$( )` sees it), rc, stderr */
function b(fn: string, args: string[], env: Env = {}): { out: string; rc: number; err: string } {
  const e: Record<string, string> = {};
  const unset: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) unset.push(k);
    else e[k] = v;
  }
  const r = bash(`${unset.map((k) => `unset ${k};`).join(' ')} ${fn} "$@"`, args, e);
  return { out: chomp(r.out), rc: r.rc, err: r.err };
}
/** Same function in bash and TS: stdout equal. */
function same(label: string, fn: string, args: string[], ts: () => string, env: Env = {}): void {
  const bo = b(fn, args, env);
  const to = withEnv(env, ts);
  assert.equal(to, bo.out, `${label}: ${fn} ${JSON.stringify(args)}`);
}
/** Predicate: rc 0 = true. */
function sameRc(label: string, fn: string, args: string[], ts: () => boolean, env: Env = {}): void {
  const bo = b(fn, args, env);
  const to = withEnv(env, ts);
  assert.equal(to, bo.rc === 0, `${label}: ${fn} ${JSON.stringify(args)}`);
}

const git = (cwd: string, ...a: string[]): string => sh(cwd, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
const commitAll = (r: string, msg = 'c'): void => {
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', msg);
};

/** a project with phase 05-x; `conf` goes to .gsd.conf */
function proj(conf = ''): { r: string; pd: string } {
  const r = repo(path.join(tmp(), 'proj'), conf);
  const pd = path.join(r, '.planning/phases/05-x');
  mkdirSync(pd, { recursive: true });
  return { r, pd };
}

// the fixture files (tests/ui-fixture.sh, same text)
function fixCheck(pd: string, p: string, status = 'passed', capture = 'cap1', code = ''): void {
  write(
    `${pd}/${p}-UI-CHECK.md`,
    `---\nstatus: ${status}\ncapture: ${capture}\ntaken: 2026-01-01T00:00:00Z\ncode: ${code}\n` +
      `url: http://localhost:3005\nfailures: ${status === 'failed' ? 2 : 0}\nwaived: 0\nquestions: 1\nunchecked: 0\n---\n\n` +
      '## Failures\n\nNone.\n\n## Questions\n\n- Q1 | /cart | 375 | C2 | possible clipped text in 1 element(s): div.box "long"\n\n' +
      '## Shots\n\n- / | 375 | home-375-aaaaaa.png\n- /cart | 375 | cart-375-bbbbbb.png\n',
  );
}
function fixLook(pd: string, p: string, capture = 'cap1', verdict = 'ok', rules = 'R1 R2 R3 R4 R5 R6 R7 R8 R9 R10'): void {
  let t = `---\ncapture: ${capture}\n---\n\n# look\n\n## / at 375px\n\n`;
  for (const r of rules.split(' ')) t += `- ${r}: ${verdict} — seen in the picture\n`;
  t += '\n## /cart at 375px\n\n';
  for (const r of rules.split(' ')) t += `- ${r}: ok — seen in the picture\n`;
  t += '- Q1: n/a — the box scrolls\n';
  write(`${pd}/${p}-UI-LOOK.md`, t);
}
function fixApproval(pd: string, p: string, capture = 'cap1'): void {
  write(`${pd}/${p}-UI-APPROVAL.md`, `---\nstatus: approved\ncapture: ${capture}\nby: t\napproved: 2026-01-01T00:00:00Z\n---\n`);
}

// ── design, fields, layout, shots, screens ──────────────────────────────────

test('uiGates / design file + state', () => {
  for (const conf of ['', 'ui_gates = strict\n', 'ui_gates = off\n', 'ui_gates = warn\n', 'ui_gates = bogus\n']) {
    const { r } = proj(conf);
    same(`gates ${conf}`, 'gsd_ui_gates', [r], () => U.uiGates(r));
    same('design_file', 'gsd_ui_design_file', [r], () => U.uiDesignFile(r));
  }
  // a worktree sees the main checkout's conf
  const { r } = proj('ui_gates = strict\n');
  write(`${r}/f`, '1');
  commitAll(r);
  const wt = path.join(tmp(), 'wt');
  git(r, 'worktree', 'add', '-q', '-b', 'phase-5-x', wt);
  same('gates from a linked worktree', 'gsd_ui_gates', [wt], () => U.uiGates(wt));
  // states
  const { r: r2 } = proj();
  same('design missing', 'gsd_ui_design_state', [r2], () => U.uiDesignState(r2));
  assert.equal(U.uiDesignState(r2), 'missing');
  U.uiScaffoldDesign(r2);
  same('design stub', 'gsd_ui_design_state', [r2], () => U.uiDesignState(r2));
  assert.equal(U.uiDesignState(r2), 'stub');
  writeFileSync(`${r2}/.planning/design/DESIGN.md`, '# Design\n\nfilled\n');
  same('design ok', 'gsd_ui_design_state', [r2], () => U.uiDesignState(r2));
  assert.equal(U.uiDesignState(r2), 'ok');
  writeFileSync(`${r2}/.planning/design/DESIGN.md`, 'x\n<!-- gsd:design-stub more -->\n');
  assert.equal(U.uiDesignState(r2), 'stub');
  same('design stub inline', 'gsd_ui_design_state', [r2], () => U.uiDesignState(r2));
});

test('uiField / uiFields / uiFm', () => {
  const d = tmp();
  const cases: string[] = [
    'sketch: a\npages: /\n',
    'sketch:\nsketch: second\n',
    'sketch:   \t \nsketch: later\n',
    'sketch:   value with   spaces   \r\n',
    '  sketch: indented\n',
    'sketch:x\nsketchy: no\n',
    'sketch: no final newline',
    '',
    '---\nstatus: passed\ncode: abc+def\n---\nstatus: body\n',
    'status: before\n---\nstatus: inside\n---\nstatus: after\n---\nstatus: second range\n---\n',
    '---\nstatus: unterminated\n',
    '---\nstatus:   \n---\n',
    'a: 1\na: 2\na:   \na: 3  \n',
  ];
  cases.forEach((c, i) => {
    const f = write(`${d}/f${i}.md`, c);
    for (const key of ['sketch', 'status', 'code', 'a']) {
      same(`field ${i} ${key}`, 'gsd_ui_field', [f, key], () => U.uiField(f, key));
      same(`fm ${i} ${key}`, 'gsd_ui_fm', [f, key], () => U.uiFm(f, key));
      same(`fields ${i} ${key}`, 'gsd_ui_fields', [f, key], () => U.uiFields(f, key).join('\n'));
    }
  });
  same('field missing file', 'gsd_ui_field', [`${d}/none`, 'a'], () => U.uiField(`${d}/none`, 'a'));
  same('fm missing file', 'gsd_ui_fm', [`${d}/none`, 'a'], () => U.uiFm(`${d}/none`, 'a'));
  same('fields missing file', 'gsd_ui_fields', [`${d}/none`, 'a'], () => U.uiFields(`${d}/none`, 'a').join('\n'));
});

test('uiWinner / uiLayoutState — every state', () => {
  const { r, pd } = proj();
  const lay = `${pd}/05-LAYOUT.md`;
  const st = (label: string): string => {
    same(label, 'gsd_ui_layout_state', [r, pd, '05'], () => U.uiLayoutState(r, pd, '05'));
    return U.uiLayoutState(r, pd, '05');
  };
  assert.equal(st('missing'), 'missing');
  write(lay, 'sketch:\npages: /\n');
  assert.equal(st('nosketch'), 'nosketch');
  write(lay, 'sketch: skip\n');
  assert.equal(st('skip'), 'skip');
  write(lay, 'sketch: skip because small\n');
  assert.equal(st('skip reason'), 'skip');
  write(lay, 'sketch: skipper\n');
  assert.equal(st('skipper is a path'), 'badsketch');
  write(lay, 'sketch: .planning/sketches/001-a\npages: /\n');
  assert.equal(st('badsketch'), 'badsketch');
  const sk = `${r}/.planning/sketches/001-a`;
  mkdirSync(sk, { recursive: true });
  assert.equal(st('no README → nowinner'), 'nowinner');
  const winners: Array<[string, string]> = [
    ['---\nwinner: v2\n---\n', 'ok'],
    ['---\nwinner: "v2"\n---\n', 'ok'],
    ['---\nwinner: null\n---\n', 'nowinner'],
    ['---\nwinner: ~\n---\n', 'nowinner'],
    ['---\nwinner: none\n---\n', 'nowinner'],
    ['---\nwinner:\n---\n', 'nowinner'],
    ['winner: v2\n', 'nowinner'],
    ['---\ntitle: x\n---\nwinner: v2\n', 'nowinner'],
    ["---\nwinner: 'a b'\n---\n", 'ok'],
  ];
  for (const [readme, want] of winners) {
    write(`${sk}/README.md`, readme);
    same(`winner ${JSON.stringify(readme)}`, 'gsd_ui_winner', [sk], () => U.uiWinner(sk));
    assert.equal(st(`readme ${JSON.stringify(readme)}`), want === 'ok' ? 'ok' : want);
  }
  write(`${sk}/README.md`, '---\nwinner: v2\n---\n');
  write(lay, 'sketch: .planning/sketches/001-a\npages:\n');
  assert.equal(st('nopages'), 'nopages');
  write(lay, 'sketch: .planning/sketches/001-a\npages: /, /cart\n');
  assert.equal(st('ok'), 'ok');
  assert.equal(U.uiWinner(`${r}/nodir`), '');
  // shots
  const sh1 = (): void => same('shots', 'gsd_ui_shots_state', [pd, '05'], () => U.uiShotsState(pd, '05'));
  sh1();
  write(`${pd}/05-SHOTS.md`, 'taken: x\n');
  sh1();
  assert.equal(U.uiShotsState(pd, '05'), 'ok');
  write(`${pd}/05-SHOTS.md`, 'skipped: no app\n');
  sh1();
  assert.equal(U.uiShotsState(pd, '05'), 'skip');
  write(`${pd}/05-SHOTS.md`, 'skipped:\n');
  sh1();
});

test('uiHasScreens / uiPhaseScreens', () => {
  const { r, pd } = proj();
  sameRc('none', 'gsd_ui_has_screens', [r], () => U.uiHasScreens(r));
  sameRc('phase none', 'gsd_ui_phase_screens', [pd, '05'], () => U.uiPhaseScreens(pd, '05'));
  write(`${pd}/05-LAYOUT.md`, 'x');
  sameRc('layout', 'gsd_ui_has_screens', [r], () => U.uiHasScreens(r));
  sameRc('phase layout', 'gsd_ui_phase_screens', [pd, '05'], () => U.uiPhaseScreens(pd, '05'));
  assert.equal(U.uiHasScreens(r), true);
  const { r: r2, pd: pd2 } = proj();
  write(`${pd2}/05-UI-SPEC.md`, 'x');
  sameRc('spec', 'gsd_ui_has_screens', [r2], () => U.uiHasScreens(r2));
  sameRc('phase spec', 'gsd_ui_phase_screens', [pd2, '05'], () => U.uiPhaseScreens(pd2, '05'));
  const { r: r3, pd: pd3 } = proj();
  write(`${pd3}/05-REVIEW.md`, 'x');
  sameRc('other files', 'gsd_ui_has_screens', [r3], () => U.uiHasScreens(r3));
  assert.equal(U.uiHasScreens(r3), false);
  const { r: r4 } = proj();
  write(`${r4}/.planning/phases/.hidden/x-LAYOUT.md`, 'x');
  sameRc('hidden dir ignored', 'gsd_ui_has_screens', [r4], () => U.uiHasScreens(r4));
  assert.equal(U.uiHasScreens(r4), false);
});

// ── playwright ──────────────────────────────────────────────────────────────

test('uiPlaywright / uiGlobalRoot / uiPlaywrightInstalled', () => {
  const emptyPath = tmp();
  const pin: Env = { PATH: `${emptyPath}:/usr/bin:/bin`, GSD_NPM_GLOBAL_ROOT: '' };
  const { r } = proj();
  // none
  same('playwright none', 'gsd_ui_playwright', [r, ''], () => U.uiPlaywright(r, ''), pin);
  assert.equal(withEnv(pin, () => U.uiPlaywright(r, '')), '');
  // env override
  same('playwright GSD_PLAYWRIGHT', 'gsd_ui_playwright', [r, ''], () => U.uiPlaywright(r, ''), { ...pin, GSD_PLAYWRIGHT: '/x/pw' });
  // project, app, apps/*, packages/*
  const bin = (d: string, mode = 0o755): void => {
    write(`${d}/node_modules/.bin/playwright`, '#!/bin/sh\n', mode);
  };
  bin(`${r}/packages/ui`);
  same('playwright packages/ui', 'gsd_ui_playwright', [r, ''], () => U.uiPlaywright(r, ''), pin);
  assert.equal(withEnv(pin, () => U.uiPlaywright(r, '')), `${r}/packages/ui/node_modules/.bin/playwright`);
  bin(`${r}/apps/b`);
  bin(`${r}/apps/a`, 0o644); // not executable: skipped
  same('playwright apps/b before packages', 'gsd_ui_playwright', [r, ''], () => U.uiPlaywright(r, ''), pin);
  bin(`${r}/web`);
  same('playwright app: web first', 'gsd_ui_playwright', [r, 'web'], () => U.uiPlaywright(r, 'web'), pin);
  same('playwright app: missing → rest', 'gsd_ui_playwright', [r, 'nope'], () => U.uiPlaywright(r, 'nope'), pin);
  bin(r);
  same('playwright root wins over apps', 'gsd_ui_playwright', [r, ''], () => U.uiPlaywright(r, ''), pin);
  // on PATH
  const { r: r2 } = proj();
  const pbin = tmp();
  write(`${pbin}/playwright`, '#!/bin/sh\n', 0o755);
  const onPath: Env = { PATH: `${pbin}:/usr/bin:/bin`, GSD_NPM_GLOBAL_ROOT: '' };
  same('playwright on PATH', 'gsd_ui_playwright', [r2, ''], () => U.uiPlaywright(r2, ''), onPath);
  assert.equal(withEnv(onPath, () => U.uiPlaywright(r2, '')), `${pbin}/playwright`);

  // global root
  for (const root of [undefined, '', '/some/where', tmp()]) {
    same(`global_root ${root}`, 'gsd_ui_global_root', [], () => U.uiGlobalRoot(), { GSD_NPM_GLOBAL_ROOT: root, PATH: pin.PATH });
  }
  // npm root -g through a stub npm
  const nbin = tmp();
  const groot = tmp();
  write(`${nbin}/npm`, `#!/bin/sh\necho ${groot}\n`, 0o755);
  const npmEnv: Env = { PATH: `${nbin}:/usr/bin:/bin`, GSD_NPM_GLOBAL_ROOT: undefined };
  same('global_root via npm', 'gsd_ui_global_root', [], () => U.uiGlobalRoot(), npmEnv);
  assert.equal(withEnv(npmEnv, () => U.uiGlobalRoot()), groot);
  write(`${nbin}/npm`, '#!/bin/sh\necho /no/such/dir\n', 0o755);
  same('global_root via npm, no dir', 'gsd_ui_global_root', [], () => U.uiGlobalRoot(), npmEnv);
  write(`${nbin}/npm`, '#!/bin/sh\nexit 1\n', 0o755);
  same('global_root via failing npm', 'gsd_ui_global_root', [], () => U.uiGlobalRoot(), npmEnv);

  // installed: none / project (root, apps, packages, @playwright/test, GSD_PLAYWRIGHT_ROOT) / global
  const { r: r3 } = proj();
  const inst = (label: string, env: Env, want: string): void => {
    const bo = b('gsd_ui_playwright_installed', [r3], env);
    const to = withEnv(env, () => U.uiPlaywrightInstalled(r3));
    assert.equal(to === null ? '' : to, bo.out, label);
    assert.equal(to === null, bo.rc !== 0, `${label} rc`);
    assert.equal(to ?? 'none', want, `${label} value`);
  };
  const noGlobal: Env = { GSD_NPM_GLOBAL_ROOT: '', GSD_PLAYWRIGHT_ROOT: undefined };
  inst('none', noGlobal, 'none');
  const g2 = tmp();
  write(`${g2}/playwright/package.json`, '{}');
  inst('global', { ...noGlobal, GSD_NPM_GLOBAL_ROOT: g2 }, 'global');
  const g3 = tmp();
  write(`${g3}/@playwright/test/package.json`, '{}');
  inst('global @playwright/test', { ...noGlobal, GSD_NPM_GLOBAL_ROOT: g3 }, 'global');
  inst('global folder empty', { ...noGlobal, GSD_NPM_GLOBAL_ROOT: tmp() }, 'none');
  const pr = tmp();
  write(`${pr}/node_modules/playwright/package.json`, '{}');
  inst('GSD_PLAYWRIGHT_ROOT', { ...noGlobal, GSD_PLAYWRIGHT_ROOT: pr }, 'project');
  inst('GSD_PLAYWRIGHT_ROOT beats global', { GSD_NPM_GLOBAL_ROOT: g2, GSD_PLAYWRIGHT_ROOT: pr }, 'project');
  write(`${r3}/apps/web/node_modules/@playwright/test/package.json`, '{}');
  inst('apps/web', { ...noGlobal, GSD_NPM_GLOBAL_ROOT: g2 }, 'project');
  const { r: r4 } = proj();
  write(`${r4}/packages/p/node_modules/playwright/package.json`, '{}');
  const bo = b('gsd_ui_playwright_installed', [r4], noGlobal);
  assert.equal(bo.out, 'project');
  assert.equal(withEnv(noGlobal, () => U.uiPlaywrightInstalled(r4)), 'project');
  const { r: r5 } = proj();
  write(`${r5}/node_modules/playwright/package.json`, '{}');
  assert.equal(withEnv(noGlobal, () => U.uiPlaywrightInstalled(r5)), 'project');
  assert.equal(b('gsd_ui_playwright_installed', [r5], noGlobal).out, 'project');
});

// ── rules, page hash, min font ──────────────────────────────────────────────

test('uiRules default / DESIGN.md R-lines', () => {
  const { r } = proj();
  same('no DESIGN.md', 'gsd_ui_rules', [r], () => U.uiRules(r).join('\n'));
  assert.equal(U.uiRules(r).length, 10);
  U.uiScaffoldDesign(r);
  same('scaffolded', 'gsd_ui_rules', [r], () => U.uiRules(r).join('\n'));
  const designs = [
    '# D\n- R1: Only one thing\n- R2:   spaced   \n',
    '- R1: a\n- R3:\n- R4:   \n- R5: x\r\n- R6 : no\n  - R7: indented\n-R8: no\n- R9: tail  \t\n',
    '- R10: ünï\n- R2: a | b\n',
    'no rules here\n',
    '',
    '- r1: lower\n- R1x: bad\n',
  ];
  for (const d of designs) {
    writeFileSync(`${r}/.planning/design/DESIGN.md`, d);
    same(`design ${JSON.stringify(d)}`, 'gsd_ui_rules', [r], () => U.uiRules(r).join('\n'));
  }
  assert.deepEqual(U.uiRules(`${r}/nowhere`), U.UI_RULES.split('\n'));
});

test('uiPageHash', () => {
  for (const p of ['/', '/cart', '/a/b', '/a-b', '', '/ü/ñ', '/x y', '/q?a=1&b=2', 'a\nb']) {
    same(`page_hash ${JSON.stringify(p)}`, 'gsd_ui_page_hash', [p], () => U.uiPageHash(p));
  }
  assert.notEqual(U.uiPageHash('/a/b'), U.uiPageHash('/a-b'));
});

test('uiMinFont — clamping, main conf first', () => {
  for (const v of ['', 'ui_min_font = 14', 'ui_min_font = 8', 'ui_min_font = 32', 'ui_min_font = 7', 'ui_min_font = 33', 'ui_min_font = 014', 'ui_min_font = 08', 'ui_min_font = 0', 'ui_min_font = abc', 'ui_min_font = 1.5', 'ui_min_font = -9', 'ui_min_font = 99999999999999999999', 'ui_min_font = 12px', 'ui_min_font = 18  # big']) {
    const { r } = proj(v === '' ? '' : `${v}\n`);
    same(`min_font ${v}`, 'gsd_ui_min_font', [r], () => String(U.uiMinFont(r)));
  }
  const { r } = proj('ui_min_font = 20\n');
  write(`${r}/f`, '1');
  commitAll(r);
  const wt = path.join(tmp(), 'wt');
  git(r, 'worktree', 'add', '-q', '-b', 'phase-5-x', wt);
  write(`${wt}/.gsd.conf`, 'ui_min_font = 9\n');
  same('min_font worktree → main wins', 'gsd_ui_min_font', [wt], () => String(U.uiMinFont(wt)));
  assert.equal(U.uiMinFont(wt), 20);
  same('min_font non-repo', 'gsd_ui_min_font', [tmp()], () => String(U.uiMinFont(tmp())));
});

// ── code state, inputs state ────────────────────────────────────────────────

test('uiCodeState / uiInputsState — new file, edit, .planning-only, worktree, non-repo', () => {
  const { r, pd } = proj();
  write(`${pd}/05-LAYOUT.md`, 'sketch: skip\n');
  write(`${r}/app.js`, 'one\n');
  const cs = (label: string, dir = r): string => {
    same(label, 'gsd_ui_code_state', [dir], () => U.uiCodeState(dir));
    return U.uiCodeState(dir);
  };
  const is = (label: string, dir = r): string => {
    same(label, 'gsd_ui_inputs_state', [dir, pd, '05'], () => U.uiInputsState(dir, pd, '05'));
    return U.uiInputsState(dir, pd, '05');
  };
  const h0 = cs('initial');
  assert.match(h0, /^[0-9a-f]{40}$/);
  const i0 = is('inputs initial');
  assert.match(i0, /^[0-9a-f]{40}\+[0-9a-f]{40}$/);
  commitAll(r);
  assert.equal(cs('after commit'), h0, 'a commit of the same content keeps the hash');
  assert.equal(is('inputs after commit'), i0);
  write(`${r}/.planning/phases/05-x/05-PLAN.md`, 'planning only');
  assert.equal(cs('.planning change'), h0);
  write(`${r}/app.js`, 'two\n');
  const h1 = cs('edit');
  assert.notEqual(h1, h0);
  // "Racy git": a same-size edit in the second of the last index write, hashed
  // a second later. A copied index with a fresh mtime made git trust the old
  // stat data and hash the old content (both sides, before the fix).
  commitAll(r);
  write(`${r}/app.js`, 'six\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
  assert.notEqual(cs('same-size edit, a second later'), h1, 'a same-size edit right after a commit changes the hash');
  write(`${r}/app.js`, 'two\n');
  assert.equal(cs('edit back'), h1);
  write(`${r}/new.js`, 'x\n');
  const h2 = cs('new file');
  assert.notEqual(h2, h1);
  rmFile(`${r}/new.js`);
  assert.equal(cs('new file removed'), h1);
  write(`${r}/.gitignore`, 'ign.txt\n');
  const h3 = cs('gitignore');
  write(`${r}/ign.txt`, 'x');
  assert.equal(cs('ignored file'), h3);
  // LAYOUT edit changes the inputs hash, not the code hash
  const i1 = is('inputs before layout edit');
  write(`${pd}/05-LAYOUT.md`, 'sketch: skip\npages: /\n');
  assert.equal(cs('code unchanged by layout edit'), h3);
  assert.notEqual(is('inputs after layout edit'), i1);
  // missing LAYOUT → +none
  rmFile(`${pd}/05-LAYOUT.md`);
  assert.match(is('inputs without layout'), /\+none$/);
  // a staged change, a deletion
  write(`${r}/app.js`, 'three\n');
  git(r, 'add', 'app.js');
  const h4 = cs('staged');
  rmFile(`${r}/app.js`);
  assert.notEqual(cs('deleted'), h4);
  // subdir checkout argument
  mkdirSync(`${r}/sub`, { recursive: true });
  assert.equal(cs('from a subdir', `${r}/sub`), U.uiCodeState(r));
  // linked worktree
  commitAll(r);
  const wt = path.join(tmp(), 'wt');
  git(r, 'worktree', 'add', '-q', '-b', 'phase-5-x', wt);
  cs('linked worktree', wt);
  write(`${wt}/w.js`, 'w');
  cs('linked worktree dirty', wt);
  // not a repo
  const nr = tmp();
  same('non-repo', 'gsd_ui_code_state', [nr], () => U.uiCodeState(nr));
  assert.equal(U.uiCodeState(nr), '');
  same('inputs non-repo', 'gsd_ui_inputs_state', [nr, pd, '05'], () => U.uiInputsState(nr, pd, '05'));
  // the checkout's own index and objects are untouched
  const before = sh(r, 'git', ['status', '--porcelain']);
  U.uiCodeState(r);
  assert.equal(sh(r, 'git', ['status', '--porcelain']), before);
});
function rmFile(p: string): void {
  sh(path.dirname(p), 'rm', ['-f', p]);
}

// ── exempt ──────────────────────────────────────────────────────────────────

test('uiExempt — review on the base branch vs only on the phase branch', () => {
  const { r, pd } = proj();
  write(`${pd}/05-PLAN.md`, 'p');
  commitAll(r);
  const wt = path.join(tmp(), 'wt');
  git(r, 'worktree', 'add', '-q', '-b', 'phase-5-x', wt);
  const wpd = `${wt}/.planning/phases/05-x`;
  const ex = (label: string, dir: string, d: string): boolean => {
    sameRc(label, 'gsd_ui_exempt', [dir, d, '05'], () => U.uiExempt(dir, d, '05'));
    return U.uiExempt(dir, d, '05');
  };
  assert.equal(ex('no review anywhere', r, pd), false);
  assert.equal(ex('no review, worktree', wt, wpd), false);
  write(`${wpd}/05-UI-REVIEW.md`, 'r');
  commitAll(wt, 'review in the worktree');
  assert.equal(ex('review only on the phase branch', wt, wpd), false);
  assert.equal(ex('…main checkout', r, pd), false);
  // merge it to develop
  git(r, 'merge', '-q', '--no-edit', 'phase-5-x');
  assert.equal(ex('review on the base branch (worktree)', wt, wpd), true);
  assert.equal(ex('review on the base branch (main)', r, pd), true);
  // via origin/<base> only
  const { r: r2, pd: pd2 } = proj();
  write(`${pd2}/05-UI-REVIEW.md`, 'r');
  commitAll(r2);
  const bare = path.join(tmp(), 'bare.git');
  sh(tmp(), 'git', ['init', '-q', '--bare', bare]);
  git(r2, 'remote', 'add', 'origin', bare);
  git(r2, 'push', '-q', 'origin', 'develop');
  git(r2, 'fetch', '-q', 'origin');
  git(r2, 'checkout', '-q', '-b', 'other');
  git(r2, 'branch', '-q', '-f', 'develop', 'HEAD~1');
  assert.equal(ex('review only on origin/develop', r2, pd2), true);
  // another base from .gsd.conf
  const { r: r3, pd: pd3 } = proj('base = trunk\n');
  commitAll(r3); // .gsd.conf stays when we come back to develop
  git(r3, 'checkout', '-q', '-b', 'trunk');
  write(`${pd3}/05-UI-REVIEW.md`, 'r');
  commitAll(r3);
  git(r3, 'checkout', '-q', 'develop');
  assert.equal(ex('base from conf', r3, pd3), true);
  // phase dir outside the checkout
  sameRc('pdir not under the checkout', 'gsd_ui_exempt', [r, '/elsewhere/05-x', '05'], () => U.uiExempt(r, '/elsewhere/05-x', '05'));
  // non-repo
  const nr = tmp();
  sameRc('non-repo', 'gsd_ui_exempt', [nr, `${nr}/p`, '05'], () => U.uiExempt(nr, `${nr}/p`, '05'));
});

// ── check / look / approval / gate ──────────────────────────────────────────

test('uiCheckState — missing/error/failed/skipped/stale/passed', () => {
  const { r, pd } = proj();
  write(`${pd}/05-LAYOUT.md`, 'sketch: skip\npages: /\n');
  const cs = (label: string, nostale = ''): string => {
    const bo = b('gsd_ui_check_state', [r, pd, '05', nostale]);
    const to = U.uiCheckState(r, pd, '05', nostale);
    assert.equal(to, bo.out, label);
    return to;
  };
  assert.equal(cs('missing'), 'missing');
  write(`${pd}/05-UI-CHECK.md`, '---\nstatus: error\nerror: nothing answers\n---\n');
  assert.equal(cs('error'), 'error');
  write(`${pd}/05-UI-CHECK.md`, 'no frontmatter\n');
  assert.equal(cs('no frontmatter'), 'error');
  write(`${pd}/05-UI-CHECK.md`, '---\nstatus: skipped\nskipped: vpn\n---\n');
  assert.equal(cs('skipped'), 'skipped');
  fixCheck(pd, '05', 'failed', 'cap1', '');
  assert.equal(cs('failed'), 'failed');
  fixCheck(pd, '05', 'passed', 'cap1', '');
  assert.equal(cs('passed, no code'), 'passed');
  fixCheck(pd, '05', 'passed', 'cap1', '0000000000000000000000000000000000000000');
  assert.equal(cs('stale (code hash only)'), 'stale');
  assert.equal(cs('stale but nostale', 'nostale'), 'passed');
  fixCheck(pd, '05', 'passed', 'cap1', U.uiCodeState(r));
  assert.equal(cs('passed, code hash only'), 'passed');
  fixCheck(pd, '05', 'passed', 'cap1', U.uiInputsState(r, pd, '05'));
  assert.equal(cs('passed, code+layout'), 'passed');
  write(`${pd}/05-LAYOUT.md`, 'sketch: skip\npages: /, /cart\n');
  assert.equal(cs('layout edited → stale'), 'stale');
  fixCheck(pd, '05', 'passed', 'cap1', U.uiInputsState(r, pd, '05'));
  write(`${r}/app.js`, 'x');
  assert.equal(cs('code changed → stale'), 'stale');
  // a repo-less dir: now = '' → not stale
  const nr = tmp();
  const npd = `${nr}/p`;
  fixCheck(mkdirp(npd), '05', 'passed', 'cap1', 'abc+def');
  const bo = b('gsd_ui_check_state', [nr, npd, '05', '']);
  assert.equal(U.uiCheckState(nr, npd, '05', ''), bo.out);
  assert.equal(bo.out, 'passed');
});
function mkdirp(d: string): string {
  mkdirSync(d, { recursive: true });
  return d;
}

test('uiCheckList / uiLookKeys / uiLookAnswers', () => {
  const { r, pd } = proj();
  fixCheck(pd, '05');
  const chk = `${pd}/05-UI-CHECK.md`;
  for (const sec of ['Shots', 'Questions', 'Failures', 'Nope']) {
    same(`check_list ${sec}`, 'gsd_ui_check_list', [chk, sec], () => U.uiCheckList(chk, sec).join('\n'));
  }
  same('check_list missing file', 'gsd_ui_check_list', [`${pd}/none`, 'Shots'], () => U.uiCheckList(`${pd}/none`, 'Shots').join('\n'));
  same('look_keys', 'gsd_ui_look_keys', [r, pd, '05'], () => U.uiLookKeys(r, pd, '05').join('\n'));
  assert.equal(U.uiLookKeys(r, pd, '05').length, 21);
  // widths that compare numerically, several questions, extra shots, pipes in text
  write(
    chk,
    '---\nstatus: passed\ncapture: c\n---\n\n## Questions\n\n- Q1 | /a | 0375 | C2 | x\n- Q2 | /a | 375 | C3 | y | z\n- Q3 | /b | 768 | C1 | q\n- Q4 | /a\n\n## Shots\n\n- /a | 375 | a.png\n- /b | 768 | b.png\n- /c\n-\n- /a | 375 | dup.png\n\n## Other\n\n- not | a | shot\n',
  );
  same('look_keys messy', 'gsd_ui_look_keys', [r, pd, '05'], () => U.uiLookKeys(r, pd, '05').join('\n'));
  // custom rules
  U.uiScaffoldDesign(r);
  writeFileSync(`${r}/.planning/design/DESIGN.md`, '- R1: a\n- R12: b\n');
  same('look_keys custom rules', 'gsd_ui_look_keys', [r, pd, '05'], () => U.uiLookKeys(r, pd, '05').join('\n'));
  // answers
  const look = `${pd}/05-UI-LOOK.md`;
  const looks = [
    '## / at 375px\n- R1: ok — seen\n- R2: fixed - did it\n- R3: bad: broken\n- R4: n/a\n- R5: maybe — x\n- Q1: ok -- double dash\n- R6:ok no space\n- R7: ok   \t trailing   \n- R8: ok : colon\n- R9: ok | pipe | in text\n- R10: ok — ünï\n',
    '## /cart at 375px\n- R1: ok — a\n## /cart at 375px extra\n- R2: ok — b\n## /x at 12px\n- R3: ok — c\n## /y at 800PX\n- R4: ok — d\n## /z at 800px\n- Q3: ok — e\n',
    '- R1: ok — before any heading\n## a  at   9px\n- R1: ok — spaces\n',
    '## / at 375px\r\n- R1: ok — crlf\r\n- R2: ok\r\n',
    '## / at 375px\n- R1:\tok\tTAB\n-   R2: ok — x\n- R3 : ok — x\n- RR1: ok — x\n',
    '',
  ];
  for (const t of looks) {
    write(look, t);
    same(`look_answers ${JSON.stringify(t.slice(0, 40))}`, 'gsd_ui_look_answers', [look], () => U.uiLookAnswers(look).join('\n'));
  }
  same('look_answers missing', 'gsd_ui_look_answers', [`${pd}/none`], () => U.uiLookAnswers(`${pd}/none`).join('\n'));
});

test('uiLookState — missing/stale/open/bad/complete', () => {
  const { r, pd } = proj();
  const ls = (label: string): string => {
    same(label, 'gsd_ui_look_state', [r, pd, '05'], () => U.uiLookState(r, pd, '05'));
    return U.uiLookState(r, pd, '05');
  };
  assert.equal(ls('missing'), 'missing');
  fixLook(pd, '05');
  assert.equal(ls('no check → stale'), 'stale');
  fixCheck(pd, '05', 'passed', 'cap1');
  assert.equal(ls('complete'), 'complete');
  fixLook(pd, '05', 'cap0');
  assert.equal(ls('older capture → stale'), 'stale');
  fixLook(pd, '05', 'cap1', 'bad');
  assert.equal(ls('bad'), 'bad');
  fixLook(pd, '05', 'cap1', 'ok', 'R1 R2 R3');
  assert.equal(ls('rules deleted → open'), 'open');
  fixLook(pd, '05');
  const t = readFileSync(`${pd}/05-UI-LOOK.md`, 'utf8');
  write(`${pd}/05-UI-LOOK.md`, t.replace('- R4: ok — seen in the picture', '- R4: ok'));
  assert.equal(ls('answer without text → open'), 'open');
  write(`${pd}/05-UI-LOOK.md`, t.replace('- R4: ok — seen in the picture', '- R4: ok ab'));
  assert.equal(ls('2-byte text → open'), 'open');
  write(`${pd}/05-UI-LOOK.md`, t.replace('- R4: ok — seen in the picture', '- R4: ok abc'));
  assert.equal(ls('3-byte text → complete'), 'complete');
  write(`${pd}/05-UI-LOOK.md`, t.replace('- R4: ok — seen in the picture', '- R4: ok —'));
  assert.equal(ls('"—" alone is 3 bytes after stripping? (kept as bash)'), ls('same'));
  write(`${pd}/05-UI-LOOK.md`, t.replace('- R4: ok — seen in the picture', '- R4: ok é'));
  ls('2-char 3-byte text');
  write(`${pd}/05-UI-LOOK.md`, t.replace('- Q1: n/a — the box scrolls\n', ''));
  assert.equal(ls('question unanswered → open'), 'open');
  write(`${pd}/05-UI-LOOK.md`, t + '- R4: bad — later duplicate wins\n');
  ls('duplicate answer');
  // no shots → n == 0 → open
  write(`${pd}/05-UI-CHECK.md`, '---\nstatus: passed\ncapture: cap1\n---\n\n## Shots\n');
  assert.equal(ls('no shots → open'), 'open');
  // a page with a | in it shifts the awk fields (kept)
  write(`${pd}/05-UI-CHECK.md`, '---\nstatus: passed\ncapture: cap1\n---\n\n## Shots\n\n- /a|b | 375 | x.png\n');
  write(`${pd}/05-UI-LOOK.md`, '---\ncapture: cap1\n---\n\n## /a|b at 375px\n\n' + [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => `- R${i}: ok — fine here\n`).join(''));
  ls('pipe in page');
});

test('uiApprovalState — missing/stale/ok/waived', () => {
  const { pd } = proj();
  const as = (label: string): string => {
    same(label, 'gsd_ui_approval_state', [pd, '05'], () => U.uiApprovalState(pd, '05'));
    return U.uiApprovalState(pd, '05');
  };
  assert.equal(as('missing'), 'missing');
  fixCheck(pd, '05', 'passed', 'cap1');
  fixApproval(pd, '05', 'cap1');
  assert.equal(as('ok'), 'ok');
  fixApproval(pd, '05', 'cap0');
  assert.equal(as('stale'), 'stale');
  write(`${pd}/05-UI-APPROVAL.md`, '---\nstatus: approved\n---\n');
  assert.equal(as('approved, no capture → stale'), 'stale');
  write(`${pd}/05-UI-APPROVAL.md`, '---\nstatus: waived\nreason: the app needs a VPN\n---\n');
  assert.equal(as('waived'), 'waived');
  write(`${pd}/05-UI-APPROVAL.md`, '---\nstatus: waived\nreason:\n---\n');
  assert.equal(as('waived, no reason → missing'), 'missing');
  write(`${pd}/05-UI-APPROVAL.md`, '---\nstatus: pending\n---\n');
  assert.equal(as('other status'), 'missing');
  write(`${pd}/05-UI-APPROVAL.md`, 'status: approved\ncapture: cap1\n');
  assert.equal(as('no frontmatter'), 'missing');
  rmFile(`${pd}/05-UI-CHECK.md`);
  write(`${pd}/05-UI-APPROVAL.md`, '---\nstatus: approved\ncapture: cap1\n---\n');
  assert.equal(as('approved, no check'), 'stale');
});

test('uiGate — every branch, and uiStepCmd', () => {
  const { r, pd } = proj();
  const g = (label: string, nostale = ''): string => {
    same(label, 'gsd_ui_gate', [r, pd, '05', nostale], () => U.uiGate(r, pd, '05', nostale));
    return U.uiGate(r, pd, '05', nostale);
  };
  assert.match(g('check missing'), /^ui-check\|missing\|/);
  write(`${pd}/05-UI-CHECK.md`, '---\nstatus: error\nerror: nothing answers on :3000\n---\n');
  assert.match(g('error'), /^ui-check\|error\|.*nothing answers on :3000$/);
  write(`${pd}/05-UI-CHECK.md`, 'garbage');
  g('error, no message');
  fixCheck(pd, '05', 'failed');
  assert.match(g('failed'), /^ui-check\|failed\|the check found 2 problem\(s\)/);
  fixCheck(pd, '05', 'passed', 'cap1', '0000000000000000000000000000000000000000');
  assert.match(g('stale'), /^ui-check\|stale\|/);
  assert.match(g('stale, nostale → look missing', 'nostale'), /^ui-look\|missing\|/);
  fixCheck(pd, '05', 'passed', 'cap1', '');
  assert.match(g('look missing'), /^ui-look\|missing\|/);
  fixLook(pd, '05', 'cap0');
  assert.match(g('look stale'), /^ui-look\|stale\|/);
  fixLook(pd, '05', 'cap1', 'bad');
  assert.match(g('look bad'), /^ui-look\|bad\|/);
  fixLook(pd, '05', 'cap1', 'ok', 'R1');
  assert.match(g('look open'), /^ui-look\|open\|/);
  fixLook(pd, '05');
  assert.match(g('approval missing'), /^ui-approve\|missing\|/);
  fixApproval(pd, '05', 'cap0');
  assert.match(g('approval stale'), /^ui-approve\|stale\|/);
  fixApproval(pd, '05', 'cap1');
  assert.equal(g('all done'), '');
  write(`${pd}/05-UI-APPROVAL.md`, '---\nstatus: waived\nreason: no app\n---\n');
  assert.equal(g('waived'), '');
  // skipped check goes straight to approval
  write(`${pd}/05-UI-CHECK.md`, '---\nstatus: skipped\nskipped: vpn\n---\n');
  rmFile(`${pd}/05-UI-APPROVAL.md`);
  assert.match(g('skipped check, no approval'), /^ui-approve\|missing\|/);
  fixApproval(pd, '05', 'cap1');
  assert.match(g('skipped check, approval of pictures (no capture in check) → stale'), /^ui-approve\|stale\|/);
  // step_cmd
  for (const step of ['ui-check', 'ui-look', 'ui-approve', 'bogus', '']) {
    same(`step_cmd ${step}`, 'gsd_ui_step_cmd', [step, '5'], () => U.uiStepCmd(step, '5'));
  }
});

// ── finish gate ─────────────────────────────────────────────────────────────

test('uiFinishGate — warn / strict / off, skip guard, exempt, no screens', () => {
  const cases: Array<{ label: string; conf: string; setup?: (pd: string, r: string) => void; env?: Env }> = [
    { label: 'no screens', conf: '', setup: () => {} },
    { label: 'screens, nothing done (warn)', conf: '', setup: (pd) => write(`${pd}/05-LAYOUT.md`, 'sketch: skip\n') },
    { label: 'screens, nothing done (strict)', conf: 'ui_gates = strict\n', setup: (pd) => write(`${pd}/05-LAYOUT.md`, 'sketch: skip\n') },
    { label: 'screens, nothing done (off)', conf: 'ui_gates = off\n', setup: (pd) => write(`${pd}/05-LAYOUT.md`, 'sketch: skip\n') },
    { label: 'strict + GSD_SKIP_GUARD', conf: 'ui_gates = strict\n', setup: (pd) => write(`${pd}/05-LAYOUT.md`, 'sketch: skip\n'), env: { GSD_SKIP_GUARD: '1' } },
    { label: 'strict + GSD_SKIP_GUARD=0', conf: 'ui_gates = strict\n', setup: (pd) => write(`${pd}/05-UI-SPEC.md`, 'x'), env: { GSD_SKIP_GUARD: '0' } },
    {
      label: 'strict, all done',
      conf: 'ui_gates = strict\n',
      setup: (pd) => {
        write(`${pd}/05-LAYOUT.md`, 'sketch: skip\n');
        fixCheck(pd, '05');
        fixLook(pd, '05');
        fixApproval(pd, '05');
      },
    },
    {
      label: 'strict, check failed',
      conf: 'ui_gates = strict\n',
      setup: (pd) => {
        write(`${pd}/05-LAYOUT.md`, 'sketch: skip\n');
        fixCheck(pd, '05', 'failed');
      },
    },
    {
      label: 'warn, look open',
      conf: '',
      setup: (pd) => {
        write(`${pd}/05-LAYOUT.md`, 'sketch: skip\n');
        fixCheck(pd, '05');
      },
    },
    {
      label: 'strict, approval open',
      conf: 'ui_gates = strict\n',
      setup: (pd) => {
        write(`${pd}/05-LAYOUT.md`, 'sketch: skip\n');
        fixCheck(pd, '05');
        fixLook(pd, '05');
      },
    },
    {
      label: 'strict, exempt (review on base)',
      conf: 'ui_gates = strict\n',
      setup: (pd, r) => {
        write(`${pd}/05-LAYOUT.md`, 'sketch: skip\n');
        write(`${pd}/05-UI-REVIEW.md`, 'r');
        commitAll(r);
      },
    },
  ];
  for (const c of cases) {
    const { r, pd } = proj(c.conf);
    c.setup?.(pd, r);
    const env = c.env ?? {};
    const bo = b('gsd_ui_finish_gate', [r, 'phase-5-x', r], env);
    const to = withEnv(env, () => U.uiFinishGate(r, 'phase-5-x', r));
    assert.equal(to.stderr, bo.err, `${c.label}: stderr`);
    assert.equal(to.ok, bo.rc === 0, `${c.label}: rc`);
  }
  // a branch that is not a phase branch, a missing phase dir
  const { r } = proj('ui_gates = strict\n');
  for (const br of ['develop', 'phase-9-nothing', 'phase-5']) {
    const bo = b('gsd_ui_finish_gate', [r, br, r]);
    const to = U.uiFinishGate(r, br, r);
    assert.equal(to.stderr, bo.err, br);
    assert.equal(to.ok, bo.rc === 0, br);
  }
});

test('finishGates (common.ts) runs the TS UI gate: strict + open step refuses; warn passes with a note', () => {
  for (const conf of ['ui_gates = strict\n', '']) {
    const { r, pd } = proj(conf);
    write(`${pd}/05-LAYOUT.md`, 'sketch: skip\n');
    write(`${r}/f`, '1');
    commitAll(r);
    git(r, 'branch', 'phase-5-x');
    const g = finishGates(r, 'phase-5-x', r);
    if (conf) {
      assert.equal(g.ok, false);
      assert.match(g.stderr, /ui_gates = strict/);
    } else {
      assert.equal(g.ok, true);
      assert.match(g.stderr, /⚠ phase 5 has screens and its UI steps are open/);
    }
    const bo = bash('gsd_finish_gates "$1" phase-5-x "$1"', [r]);
    assert.equal(g.ok, bo.rc === 0);
    assert.equal(g.stderr, bo.err);
  }
});

// ── stack, add-ons, scaffolding ─────────────────────────────────────────────

test('uiStack', () => {
  const { r } = proj();
  same('empty', 'gsd_ui_stack', [r], () => U.uiStack(r));
  write(`${r}/package.json`, '{"dependencies":{"react":"1"}}');
  same('react', 'gsd_ui_stack', [r], () => U.uiStack(r));
  write(`${r}/apps/web/package.json`, '{"devDependencies":{"tailwindcss":"3"}}');
  same('+tailwind in apps', 'gsd_ui_stack', [r], () => U.uiStack(r));
  write(`${r}/packages/ui/components.json`, '{}');
  same('+shadcn in packages', 'gsd_ui_stack', [r], () => U.uiStack(r));
  assert.equal(U.uiStack(r), 'react shadcn tailwind');
  write(`${r}/package.json`, '{"dependencies":{"react-dom":"1","tailwindcss-animate":"1"}}');
  write(`${r}/apps/web/package.json`, '{}');
  same('substring words do not count', 'gsd_ui_stack', [r], () => U.uiStack(r));
  write(`${r}/components.json`, '{}');
  same('root components.json', 'gsd_ui_stack', [r], () => U.uiStack(r));
});

test('uiAddonPresent', () => {
  const { r } = proj();
  const home = tmp();
  const env: Env = { HOME: home };
  for (const addon of ['impeccable', 'shadcn-mcp', 'other']) {
    sameRc(`none ${addon}`, 'gsd_ui_addon_present', [r, addon], () => U.uiAddonPresent(r, addon), env);
  }
  mkdirSync(`${home}/.agents/skills/impeccable`, { recursive: true });
  sameRc('impeccable in ~/.agents', 'gsd_ui_addon_present', [r, 'impeccable'], () => U.uiAddonPresent(r, 'impeccable'), env);
  assert.equal(withEnv(env, () => U.uiAddonPresent(r, 'impeccable')), true);
  const { r: r2 } = proj();
  mkdirSync(`${r2}/.claude/skills`, { recursive: true });
  symlinkSync('/nonexistent', `${r2}/.claude/skills/impeccable`);
  sameRc('broken symlink', 'gsd_ui_addon_present', [r2, 'impeccable'], () => U.uiAddonPresent(r2, 'impeccable'), { HOME: tmp() });
  write(`${r2}/.mcp.json`, '{"mcpServers":{"shadcn":{}}}');
  sameRc('shadcn in .mcp.json', 'gsd_ui_addon_present', [r2, 'shadcn-mcp'], () => U.uiAddonPresent(r2, 'shadcn-mcp'), { HOME: tmp() });
  assert.equal(withEnv({ HOME: tmp() }, () => U.uiAddonPresent(r2, 'shadcn-mcp')), true);
  const { r: r3 } = proj();
  const h3 = tmp();
  write(`${h3}/.codex/config.toml`, '[mcp_servers.shadcn]\n');
  sameRc('shadcn in codex config', 'gsd_ui_addon_present', [r3, 'shadcn-mcp'], () => U.uiAddonPresent(r3, 'shadcn-mcp'), { HOME: h3 });
  write(`${h3}/.codex/config.toml`, 'nothing\n');
  sameRc('no shadcn', 'gsd_ui_addon_present', [r3, 'shadcn-mcp'], () => U.uiAddonPresent(r3, 'shadcn-mcp'), { HOME: h3 });
});

test('uiScaffoldDesign / uiLayoutTemplate — same files as bash, never overwrite', () => {
  // design
  const a = proj().r;
  const c = proj().r;
  U.uiScaffoldDesign(a);
  b('gsd_ui_scaffold_design', [c]);
  assert.equal(readFileSync(`${a}/.planning/design/DESIGN.md`, 'utf8'), readFileSync(`${c}/.planning/design/DESIGN.md`, 'utf8'));
  assert.equal(existsSync(`${a}/.planning/design/refs/.gitkeep`), true);
  assert.equal(readFileSync(`${a}/.planning/design/refs/.gitkeep`, 'utf8'), '');
  // never overwrites (a filled file, a kept .gitkeep)
  writeFileSync(`${a}/.planning/design/DESIGN.md`, 'mine\n');
  writeFileSync(`${a}/.planning/design/refs/.gitkeep`, 'keep\n');
  U.uiScaffoldDesign(a);
  assert.equal(readFileSync(`${a}/.planning/design/DESIGN.md`, 'utf8'), 'mine\n');
  assert.equal(readFileSync(`${a}/.planning/design/refs/.gitkeep`, 'utf8'), 'keep\n');
  writeFileSync(`${c}/.planning/design/DESIGN.md`, 'mine\n');
  b('gsd_ui_scaffold_design', [c]);
  assert.equal(readFileSync(`${c}/.planning/design/DESIGN.md`, 'utf8'), 'mine\n');
  // the scaffolded file is a stub and its R-lines are the defaults
  const d = proj().r;
  U.uiScaffoldDesign(d);
  assert.equal(U.uiDesignState(d), 'stub');
  assert.deepEqual(U.uiRules(d), U.UI_RULES.split('\n'));
  // layout template
  const t = tmp();
  for (const n of ['5', '07', '7.1']) {
    const fa = `${t}/a-${n}.md`;
    const fb = `${t}/b-${n}.md`;
    U.uiLayoutTemplate(fa, n);
    b('gsd_ui_layout_template', [fb, n]);
    assert.equal(readFileSync(fa, 'utf8'), readFileSync(fb, 'utf8'), `template ${n}`);
  }
  writeFileSync(`${t}/mine.md`, 'mine\n');
  U.uiLayoutTemplate(`${t}/mine.md`, '5');
  assert.equal(readFileSync(`${t}/mine.md`, 'utf8'), 'mine\n');
  b('gsd_ui_layout_template', [`${t}/mine2.md`, '5']);
  // a scaffolded template is read as nosketch by the state machine
  const { r, pd } = proj();
  U.uiLayoutTemplate(`${pd}/05-LAYOUT.md`, '5');
  same('template state', 'gsd_ui_layout_state', [r, pd, '05'], () => U.uiLayoutState(r, pd, '05'));
  assert.equal(U.uiLayoutState(r, pd, '05'), 'nosketch');
  chmodSync(`${pd}/05-LAYOUT.md`, 0o644);
});

test('constants match bash', () => {
  const o = bash('printf "%s\\n%s\\n%s" "$GSD_UI_STUB" "$GSD_UI_WIDTHS" "$GSD_UI_RULES"').out;
  assert.equal(o, `${U.UI_STUB}\n${U.UI_WIDTHS}\n${U.UI_RULES}`);
});
