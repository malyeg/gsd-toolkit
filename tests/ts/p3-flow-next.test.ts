// P3b parity (gsdt-flow-next): the TypeScript command behind bin/gsdt-flow-next
// against the pre-P3 bash script (tests/fixtures/p3-old-bins/, run in a package
// dir with a copy of lib/, the OLD guard and gsdt-tracker). Same repo, same argv,
// same env: stdout, stderr and the exit status must match byte for byte.
// Run: node --test 'tests/ts/*.test.ts'
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PKG, repo, sh, tmp, write } from './helpers.ts';

const NEW = path.join(PKG, 'bin', 'gsdt-flow-next');
const FIX = path.join(PKG, 'tests', 'fixtures', 'p3-old-bins');

/** a package dir: the OLD flow-next + the OLD guard + the tracker, next to a copy of lib/ */
function oldPackage(): string {
  const d = path.join(tmp(), 'old-pkg');
  mkdirSync(path.join(d, 'bin'), { recursive: true });
  cpSync(path.join(PKG, 'lib'), path.join(d, 'lib'), { recursive: true });
  cpSync(path.join(PKG, 'src'), path.join(d, 'src'), { recursive: true }); // bin/gsdt-tracker is a launcher since P9
  for (const [src, name] of [[path.join(FIX, 'gsdt-flow-next'), 'gsdt-flow-next'], [path.join(FIX, 'gsdt-worktree-guard'), 'gsdt-worktree-guard'], [path.join(PKG, 'bin', 'gsdt-tracker'), 'gsdt-tracker']] as const) {
    copyFileSync(src, path.join(d, 'bin', name));
    chmodSync(path.join(d, 'bin', name), 0o755);
  }
  return path.join(d, 'bin', 'gsdt-flow-next');
}
const OLD = oldPackage();

type R = { out: string; err: string; rc: number };
type Case = { label: string; argv: string[]; cwd: string; env: Record<string, string | undefined>; rcOnly?: boolean };

function runAsync(bin: string, c: Case): Promise<R> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, ...c.env };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const p = spawn(bin, c.argv, { cwd: c.cwd, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    p.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    p.on('close', (rc) => resolve({ out, err, rc: rc ?? 1 }));
  });
}

async function runAll(cases: Case[]): Promise<void> {
  const bad: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 12 }, async () => {
      while (next < cases.length) {
        const c = cases[next++] as Case;
        const [o, n] = await Promise.all([runAsync(OLD, c), runAsync(NEW, c)]);
        if (c.rcOnly ? o.rc !== n.rc : o.out !== n.out || o.err !== n.err || o.rc !== n.rc) {
          bad.push(`${c.label}\n  old: rc=${o.rc} out=${JSON.stringify(o.out)} err=${JSON.stringify(o.err)}\n  new: rc=${n.rc} out=${JSON.stringify(n.out)} err=${JSON.stringify(n.err)}`);
        }
      }
    }),
  );
  assert.equal(bad.length, 0, `${bad.length} of ${cases.length} cases differ:\n${bad.join('\n')}`);
}

type Add = (label: string, repoDir: string, argv: string[], o?: { env?: Record<string, string | undefined>; cwd?: string; rcOnly?: boolean }) => void;
function group(name: string, build: (add: Add) => void): void {
  test(name, async () => {
    const cases: Case[] = [];
    const add: Add = (label, repoDir, argv, o = {}) => cases.push({ label, argv: ['--repo', repoDir, ...argv], cwd: o.cwd ?? tmp(), env: o.env ?? {}, rcOnly: o.rcOnly });
    build(add);
    await runAll(cases);
  });
}
/** one state, run as plain / --all / --all --json / --json */
function states(add: Add, label: string, r: string, n: string, extra: string[] = [], env?: Record<string, string | undefined>): void {
  for (const v of [[], ['--all', '--json']]) add(`${label} ${v.join(' ')}`, r, [n, ...extra, ...v], { env });
}

// ── fixtures ────────────────────────────────────────────────────────────────
const gitc = (cwd: string, ...a: string[]): string => sh(cwd, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a]);
const commitAt = (d: string, date: string, msg = 'c'): void => {
  sh(d, 'git', ['add', '-A']);
  sh(d, 'env', [`GIT_AUTHOR_DATE=${date}`, `GIT_COMMITTER_DATE=${date}`, 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg, '--allow-empty']);
};

type Mk = { conf?: string | null; branch?: string; dir?: string; files?: Record<string, string>; commit?: boolean };
/** a set-up repo on a phase branch; files are relative to the phase dir `.planning/phases/<dir>/` unless they start with `/` (repo-relative) */
function mk(o: Mk = {}): { r: string; pd: string } {
  const conf = o.conf === undefined ? 'base = develop\ninstall = none\n' : o.conf;
  const r = repo(undefined, conf ?? undefined);
  gitc(r, 'checkout', '-q', '-b', o.branch ?? 'phase-7-thing');
  const dir = o.dir ?? '07-thing';
  const pd = path.join(r, '.planning', 'phases', dir);
  mkdirSync(pd, { recursive: true });
  for (const [f, c] of Object.entries(o.files ?? {})) write(f.startsWith('/') ? path.join(r, f) : path.join(pd, f), c);
  if (o.commit !== false) commitAt(r, '2026-01-01T10:00:00');
  return { r, pd };
}
const P7 = (names: string[]): Record<string, string> => Object.fromEntries(names.map((n) => [`07-${n}`, '']));
const fmf = (status: string, extra = ''): string => `---\nstatus: ${status}\n${extra}---\n`;
const uiCheck = (status = 'passed', capture = 'cap1', code = '', err = ''): string =>
  `---\nstatus: ${status}\ncapture: ${capture}\ntaken: 2026-01-01T00:00:00Z\ncode: ${code}\nurl: http://localhost:3005\nfailures: ${status === 'failed' ? 2 : 0}\nwaived: 0\nquestions: 1\nunchecked: 0\n${err}---\n\n## Failures\n\nNone.\n\n## Questions\n\n- Q1 | /cart | 375 | C2 | possible clipped text\n\n## Shots\n\n- / | 375 | home-375-aaaaaa.png\n- /cart | 375 | cart-375-bbbbbb.png\n`;
const uiLook = (capture = 'cap1', verdict = 'ok', rules = 'R1 R2 R3 R4 R5 R6 R7 R8 R9 R10'): string => {
  const rs = (v: string): string => rules.split(' ').map((r) => `- ${r}: ${v} — seen in the picture\n`).join('');
  return `---\ncapture: ${capture}\n---\n\n# look\n\n## / at 375px\n\n${rs(verdict)}\n## /cart at 375px\n\n${rs('ok')}- Q1: n/a — the box scrolls\n`;
};
const uiApproval = (capture = 'cap1'): string => `---\nstatus: approved\ncapture: ${capture}\nby: t\napproved: 2026-01-01T00:00:00Z\n---\n`;

// cumulative artifacts, in flow order (no tracker, no UI)
const ORDER: [string, Record<string, string>][] = [
  ['empty', {}],
  ['context', { '07-CONTEXT.md': '' }],
  ['plans, no reviews', { '07-01-PLAN.md': '', '07-02-PLAN.md': '' }],
  ['reviews empty', { '07-REVIEWS.md': '' }],
  ['summary 1', { '07-01-SUMMARY.md': '' }],
  ['summaries', { '07-02-SUMMARY.md': '' }],
  ['verification gaps', { '07-VERIFICATION.md': fmf('gaps_found') }],
  ['verification passed', { '07-VERIFICATION.md': fmf('passed') }],
  ['uat partial', { '07-HUMAN-UAT.md': fmf('partial') }],
  ['uat complete', { '07-HUMAN-UAT.md': fmf('complete') }],
  ['review issues', { '07-REVIEW.md': fmf('issues_found') }],
  ['review fix', { '07-REVIEW-FIX.md': '' }],
  ['validation draft', { '07-VALIDATION.md': '---\nphase: 7\nnyquist_compliant: false\n---\n\n# V\n\n---\n' }],
  ['validation ok', { '07-VALIDATION.md': '---\nnyquist_compliant: true\n---\n' }],
  ['security open', { '07-SECURITY.md': fmf('verified', 'threats_open: 2\n') }],
  ['security closed', { '07-SECURITY.md': fmf('verified', 'threats_open: 0\n') }],
];

group('each step in order (tracker none, no screens)', (add) => {
  let acc: Record<string, string> = {};
  for (const [label, files] of ORDER) {
    acc = { ...acc, ...files };
    const { r } = mk({ files: acc });
    states(add, `order ${label}`, r, '7', ['--no-ui']);
    add(`order ${label} (N from the branch)`, r, []);
  }
});

group('discuss, ui-decision, --ui / --no-ui', (add) => {
  const a = mk({ files: P7(['CONTEXT.md']) });
  for (const f of [[], ['--ui'], ['--no-ui'], ['--ui', '--no-ui'], ['--no-ui', '--ui']]) states(add, `ui-decision ${f.join(' ')}`, a.r, '7', f);
  const b = mk({ files: P7(['UI-SPEC.md']) });
  states(add, 'ui-spec settles UI', b.r, '7', []);
  const c = mk({ files: { ...P7(['CONTEXT.md', '01-PLAN.md']) } });
  states(add, 'plan present, no flag', c.r, '7', []);
  states(add, 'plan present --ui', c.r, '7', ['--ui']);
  // the note of discuss with a tracker set
  states(add, 'discuss with tracker', mk({ files: P7(['TICKET.md']) }).r, '7', [], { GSD_TRACKER: 'clickup' });
});

group('plan: RESEARCH.md and workflow.research', (add) => {
  const cfg = (c: string): Record<string, string> => ({ '/.planning/config.json': c, ...P7(['CONTEXT.md']) });
  for (const [label, files] of [
    ['none', P7(['CONTEXT.md'])],
    ['research false', cfg('{"workflow":{"research":false}}')],
    ['research true', cfg('{"workflow":{"research":true}}')],
    ['broken json', cfg('not json')],
    ['workflow null', cfg('{"workflow":null}')],
    ['research string', cfg('{"workflow":{"research":"false"}}')],
    ['RESEARCH.md', { ...P7(['CONTEXT.md', 'RESEARCH.md']), '/.planning/config.json': '{"workflow":{"research":false}}' }],
  ] as [string, Record<string, string>][]) states(add, `plan ${label}`, mk({ files }).r, '7', ['--no-ui']);
});

group('tickets', (add) => {
  const env = { GSD_TRACKER: 'clickup' };
  const road = (t: string): Record<string, string> => ({ '/.planning/ROADMAP.md': `# Roadmap\n\n${t}\n` });
  const cases: [string, Mk, string][] = [
    ['untagged', { files: {} }, '7'],
    ['TICKET.md', { files: P7(['TICKET.md']) }, '7'],
    ['STORY.md', { files: P7(['STORY.md']) }, '7'],
    ['heading tk tag', { dir: '07-thing', files: road('### Phase 7: cart tk-PROJ-42') }, '7'],
    ['heading tk tag h2', { files: road('## Phase 7: cart tk-abc123') }, '7'],
    ['heading tk tag h5 (no match)', { files: road('##### Phase 7: cart tk-abc123') }, '7'],
    ['heading padded', { files: road('### Phase 07: cart tk-pad9') }, '7'],
    ['heading other phase', { files: road('### Phase 8: cart tk-other') }, '7'],
    ['heading legacy cu_', { files: road('### Phase 7: cart cu_abc123def') }, '7'],
    ['heading ClickUp', { files: road('### Phase 7: cart ClickUp 869abc12') }, '7'],
    ['dir tag', { dir: '07-thing-tk-dir77', files: {} }, '7'],
    ['dir cu_ tag', { dir: '07-x-cu_abc123', files: {} }, '7'],
    ['dir cu- tag', { dir: '07-x-cu-abc123', files: {} }, '7'],
    ['heading beats dir', { dir: '07-thing-tk-dir77', files: road('### Phase 7: a tk-head1') }, '7'],
    ['heading CRLF', { files: { '/.planning/ROADMAP.md': '### Phase 7: cart tk-crlf1\r\n' } }, '7'],
    ['heading with quote', { files: road('### Phase 7: say "hi" \\ tk-q1') }, '7'],
  ];
  for (const [label, o, n] of cases) {
    const m = mk(o);
    states(add, `ticket ${label}`, m.r, n, [], env);
    if (/^(untagged|heading tk tag|dir tag)$/.test(label)) states(add, `ticket ${label} (custom)`, m.r, n, [], { GSD_TRACKER: 'custom' });
  }
  // padded / decimal / dotted numbers
  const d = mk({ branch: 'phase-8-x', dir: '08-x', files: { '/.planning/ROADMAP.md': '### Phase 8: z tk-eight8\n' } });
  for (const n of ['8', '08', '008']) states(add, `ticket phase ${n}`, d.r, n, [], env);
  const e = mk({ branch: 'phase-2.1-x', dir: '02.1-x', files: { '/.planning/ROADMAP.md': '### Phase 02.1: z tk-dot21\n' } });
  for (const n of ['02.1', '2.1']) states(add, `ticket phase ${n}`, e.r, n, [], env);
  // tracker via .gsd.conf, tracker invalid, tracker none
  states(add, 'tracker conf custom', mk({ conf: 'base = develop\ninstall = none\ntracker = custom\n' }).r, '7', [], {});
  states(add, 'tracker conf none', mk({ conf: 'base = develop\ninstall = none\ntracker = none\n' }).r, '7', [], {});
  states(add, 'tracker conf bogus', mk({ conf: 'base = develop\ninstall = none\ntracker = bogus\n' }).r, '7', [], {});
  states(add, 'tracker env bogus', mk().r, '7', [], { GSD_TRACKER: 'bogus' });
  states(add, 'tracker default (no conf)', mk({ conf: null }).r, '7', [], {});
  // a cu_ in the REPO path counts too (bash tests the whole phase dir path)
  const cu = mk({ files: {} });
  states(add, 'ticket none-tracker', cu.r, '7', [], {});
});

group('UI: design system, layout, gates', (add) => {
  const design = (extra: Record<string, string> = {}): Record<string, string> => ({ '/.planning/design/DESIGN.md': '# Design\n', ...extra });
  const sketch = (w: string): Record<string, string> => ({ '/.planning/sketches/001-shop/README.md': `---\nwinner: ${w}\n---\n` });
  const lay = (s: string, pages = '/, /cart'): string => `---\nsketch: ${s}\npages: ${pages}\n---\n`;
  const ctx = P7(['CONTEXT.md']);
  const c: [string, Record<string, string>][] = [
    ['no design', ctx],
    ['design stub', { ...ctx, '/.planning/design/DESIGN.md': '<!-- gsd:design-stub -->\n' }],
    ['design ok, layout missing', { ...ctx, ...design() }],
    ['layout empty sketch', { ...ctx, ...design(), '07-LAYOUT.md': '---\nsketch:\n---\n' }],
    ['layout badsketch', { ...ctx, ...design(), '07-LAYOUT.md': lay('.planning/sketches/nope') }],
    ['layout nowinner', { ...ctx, ...design(), ...sketch('null'), '07-LAYOUT.md': lay('.planning/sketches/001-shop') }],
    ['layout winner none', { ...ctx, ...design(), ...sketch('none'), '07-LAYOUT.md': lay('.planning/sketches/001-shop') }],
    ['layout nopages', { ...ctx, ...design(), ...sketch('"B"'), '07-LAYOUT.md': '---\nsketch: .planning/sketches/001-shop\n---\n' }],
    ['layout ok', { ...ctx, ...design(), ...sketch('"B"'), '07-LAYOUT.md': lay('.planning/sketches/001-shop') }],
    ['layout skip', { ...ctx, ...design(), '07-LAYOUT.md': lay('skip tiny change') }],
    ['layout skip, no design', { ...ctx, '07-LAYOUT.md': lay('skip') }],
    ['ui-spec present', { ...ctx, '07-UI-SPEC.md': '' }],
  ];
  for (const g of ['', 'ui_gates = off\n', 'ui_gates = strict\n']) {
    for (const [label, files] of c.slice(0, g === 'ui_gates = strict\n' ? 6 : c.length)) {
      const m = mk({ conf: `base = develop\ninstall = none\n${g}`, files });
      states(add, `ui [${g.trim()}] ${label}`, m.r, '7', ['--ui']);
    }
  }
});

group('UI: check, look, approve, ui-review', (add) => {
  const base: Record<string, string> = { ...P7(['CONTEXT.md', 'UI-SPEC.md', '01-PLAN.md', '01-SUMMARY.md', 'REVIEWS.md', 'VERIFICATION.md', 'REVIEW.md']), '07-UAT.md': fmf('complete') };
  const c: [string, Record<string, string>][] = [
    ['no check', {}],
    ['check error', { '07-UI-CHECK.md': fmf('error', 'error: nothing answers at http://localhost:3005\n') }],
    ['check failed', { '07-UI-CHECK.md': uiCheck('failed') }],
    ['check bogus status', { '07-UI-CHECK.md': fmf('weird') }],
    ['check passed, stale code', { '07-UI-CHECK.md': uiCheck('passed', 'cap1', '0000000000000000000000000000000000000000') }],
    ['check passed, stale inputs', { '07-UI-CHECK.md': uiCheck('passed', 'cap1', '0000000000000000000000000000000000000000+abc') }],
    ['check passed', { '07-UI-CHECK.md': uiCheck() }],
    ['check skipped', { '07-UI-CHECK.md': fmf('skipped', 'skipped: needs a VPN\n') }],
    ['look missing', { '07-UI-CHECK.md': uiCheck() }],
    ['look stale', { '07-UI-CHECK.md': uiCheck(), '07-UI-LOOK.md': uiLook('cap0') }],
    ['look bad', { '07-UI-CHECK.md': uiCheck(), '07-UI-LOOK.md': uiLook('cap1', 'bad') }],
    ['look open', { '07-UI-CHECK.md': uiCheck(), '07-UI-LOOK.md': uiLook('cap1', 'ok', 'R1 R2 R3') }],
    ['look complete', { '07-UI-CHECK.md': uiCheck(), '07-UI-LOOK.md': uiLook() }],
    ['approval stale', { '07-UI-CHECK.md': uiCheck(), '07-UI-LOOK.md': uiLook(), '07-UI-APPROVAL.md': uiApproval('cap0') }],
    ['approval ok', { '07-UI-CHECK.md': uiCheck(), '07-UI-LOOK.md': uiLook(), '07-UI-APPROVAL.md': uiApproval() }],
    ['approval waived', { '07-UI-CHECK.md': fmf('skipped', 'skipped: x\n'), '07-UI-APPROVAL.md': fmf('waived', 'reason: needs a VPN\n') }],
    ['approval waived, no reason', { '07-UI-CHECK.md': fmf('skipped', 'skipped: x\n'), '07-UI-APPROVAL.md': fmf('waived') }],
    ['ui-review present', { '07-UI-CHECK.md': uiCheck(), '07-UI-LOOK.md': uiLook(), '07-UI-APPROVAL.md': uiApproval(), '07-UI-REVIEW.md': '' }],
    ['ui-review only here', { '07-UI-REVIEW.md': '' }],
  ];
  for (const g of ['', 'ui_gates = strict\n']) {
    for (const [label, files] of c.slice(0, g === '' ? c.length : 9)) {
      const m = mk({ conf: `base = develop\ninstall = none\n${g}`, files: { ...base, ...files } });
      states(add, `ui-gates [${g.trim()}] ${label}`, m.r, '7', []);
    }
  }
  states(add, 'ui-gates off', mk({ conf: 'base = develop\ninstall = none\nui_gates = off\n', files: base }).r, '7', []);
  // UI-REVIEW.md already on the base branch exempts the phase
  const m = mk({ files: { ...base, '07-UI-REVIEW.md': '' } });
  gitc(m.r, 'branch', '-f', 'develop', 'phase-7-thing');
  states(add, 'ui-review on the base branch', m.r, '7', []);
  const n = mk({ files: { ...base, '07-UI-CHECK.md': uiCheck(), '07-UI-LOOK.md': uiLook(), '07-UI-APPROVAL.md': uiApproval() } });
  states(add, 'ui-review note when check passed', n.r, '7', []);
  // a code file changes the check's code state
  const k = mk({ files: { ...base, '07-UI-CHECK.md': uiCheck('passed', 'cap1', 'deadbeef') } });
  write(path.join(k.r, 'app.js'), 'x');
  states(add, 'new code file', k.r, '7', []);
});

group('review providers and unusable REVIEWS.md', (add) => {
  const plans = P7(['CONTEXT.md', '01-PLAN.md']);
  const limit = '## Codex Review\n\nYou’ve hit your usage limit. Try again at Oct 11th, 2026 1:22 AM.\n';
  const long = `## Codex Review\n\n## Consensus Summary\n\n${Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join('')}`;
  const long41 = `${long}extra\n`;
  void long41;
  const sections = '## Codex Review\n\n## 07-01\nfinding\n\n---\n\n## 07-02\nfinding\n\n---\n\n## Consensus Summary\n\nok\n';
  const claudeLimit = '## Claude Review\n\nYou have hit your usage limit.\n';
  for (const rp of ['', 'claude', 'custom', 'gemini']) {
    const conf = `base = develop\ninstall = none\n${rp === '' ? '' : `review_provider = ${rp}\n`}`;
    for (const [label, rev] of [['none', null], ['empty', ''], ['limit', limit], ['long', long], ['sections', sections], ['real', '## Codex Review\n\nfindings\n\n## Consensus Summary\nok\n']] as [string, string | null][]) {
      const m = mk({ conf, files: rev === null ? plans : { ...plans, '07-REVIEWS.md': rev } });
      states(add, `review [${rp}] ${label}`, m.r, '7', ['--no-ui']);
    }
  }
});

group('replan (git timestamps)', (add) => {
  const mkr = (steps: (d: string, pd: string) => void): string => {
    const m = mk({ files: P7(['CONTEXT.md', '01-PLAN.md']), commit: false });
    commitAt(m.r, '2026-01-01T09:00:00', 'plans');
    steps(m.r, m.pd);
    return m.r;
  };
  const rev = (pd: string, t = 'x'): void => write(path.join(pd, '07-REVIEWS.md'), `## Codex Review\n\nok ${t}\n\n## Consensus Summary\nok\n`);
  states(add, 'reviews uncommitted', mkr((_, pd) => rev(pd)), '7', ['--no-ui']);
  states(add, 'reviews + plan same commit', mkr((r, pd) => { rev(pd); write(path.join(pd, '07-01-PLAN.md'), 'y'); commitAt(r, '2026-01-01T10:00:00'); }), '7', ['--no-ui']);
  states(add, 'reviews committed after plan', mkr((r, pd) => { rev(pd); commitAt(r, '2026-01-02T10:00:00'); }), '7', ['--no-ui']);
  states(add, 'plan committed after reviews', mkr((r, pd) => { rev(pd); commitAt(r, '2026-01-02T10:00:00'); write(path.join(pd, '07-01-PLAN.md'), 'z'); commitAt(r, '2026-01-03T10:00:00'); }), '7', ['--no-ui']);
  states(add, 'two plans, one old', mkr((r, pd) => { rev(pd); write(path.join(pd, '07-02-PLAN.md'), ''); commitAt(r, '2026-01-02T10:00:00'); write(path.join(pd, '07-02-PLAN.md'), 'q'); commitAt(r, '2026-01-04T10:00:00'); }), '7', ['--no-ui']);
  states(add, 'plan untracked (no commit)', mkr((_, pd) => { rev(pd); write(path.join(pd, '07-03-PLAN.md'), ''); }), '7', ['--no-ui']);
});

group('execute, verifier, gaps, UAT, code review', (add) => {
  const b = { ...P7(['CONTEXT.md', '01-PLAN.md', '02-PLAN.md', 'REVIEWS.md']) };
  const ok = '## Codex Review\n\nfine\n\n## Consensus Summary\nok\n';
  const base = { ...b, '07-REVIEWS.md': ok };
  const sum = { ...base, '07-01-SUMMARY.md': '', '07-02-SUMMARY.md': '' };
  const fmv = (v: string): string => `---\nphase: 7\nstatus: ${v}\n---\n\nbody\n\n---\n\nmore\n\nstatus: other\n`;
  const c: [string, Record<string, string>][] = [
    ['two plans, no summaries', base],
    ['one summary', { ...base, '07-01-SUMMARY.md': '' }],
    ['all summaries', sum],
    ['verification gaps', { ...sum, '07-VERIFICATION.md': fmv('gaps_found') }],
    ['verification gaps quoted spaces', { ...sum, '07-VERIFICATION.md': '---\nstatus:   gaps_found  \t \n---\n' }],
    ['verification second range', { ...sum, '07-VERIFICATION.md': '---\nx: 1\n---\n\n---\nstatus: gaps_found\n---\n' }],
    ['verification unterminated', { ...sum, '07-VERIFICATION.md': '---\nx: 1\nstatus: gaps_found\n' }],
    ['verification status outside fm', { ...sum, '07-VERIFICATION.md': 'status: gaps_found\n' }],
    ['verification CRLF', { ...sum, '07-VERIFICATION.md': '---\r\nstatus: gaps_found\r\n---\r\n' }],
    ['verification passed', { ...sum, '07-VERIFICATION.md': fmv('passed') }],
    ['no UAT', { ...sum, '07-VERIFICATION.md': fmv('passed') }],
    ['UAT pending', { ...sum, '07-VERIFICATION.md': fmv('passed'), '07-UAT.md': fmf('pending') }],
    ['UATs mixed', { ...sum, '07-VERIFICATION.md': fmv('passed'), '07-A-UAT.md': fmf('partial'), '07-HUMAN-UAT.md': fmf('pending'), '07-Z-UAT.md': fmf('complete') }],
    ['UAT nofm', { ...sum, '07-VERIFICATION.md': fmv('passed'), '07-UAT.md': 'status: pending\n' }],
    ['UAT dir named UAT.md', { ...sum, '07-VERIFICATION.md': fmv('passed'), '07-x-UAT.md/keep': '' }],
    ['no REVIEW', { ...sum, '07-VERIFICATION.md': fmv('passed'), '07-UAT.md': fmf('complete') }],
    ['REVIEW clean', { ...sum, '07-VERIFICATION.md': fmv('passed'), '07-UAT.md': fmf('complete'), '07-REVIEW.md': fmf('clean') }],
    ['REVIEW skipped', { ...sum, '07-VERIFICATION.md': fmv('passed'), '07-UAT.md': fmf('complete'), '07-REVIEW.md': fmf('skipped') }],
    ['REVIEW issues', { ...sum, '07-VERIFICATION.md': fmv('passed'), '07-UAT.md': fmf('complete'), '07-REVIEW.md': fmf('issues_found') }],
    ['REVIEW issues + FIX', { ...sum, '07-VERIFICATION.md': fmv('passed'), '07-UAT.md': fmf('complete'), '07-REVIEW.md': fmf('issues_found'), '07-REVIEW-FIX.md': '' }],
    ['REVIEW no status', { ...sum, '07-VERIFICATION.md': fmv('passed'), '07-UAT.md': fmf('complete'), '07-REVIEW.md': 'plain\n' }],
  ];
  for (const [label, files] of c) states(add, label, mk({ files }).r, '7', ['--no-ui']);
  // plans without summaries but no plan files at all + verifier
  states(add, 'summary without plan', mk({ files: { ...P7(['CONTEXT.md', '01-SUMMARY.md', 'REVIEWS.md']), '07-REVIEWS.md': ok } }).r, '7', ['--no-ui']);
  states(add, 'plan name 07-1-PLAN.md', mk({ files: { ...P7(['CONTEXT.md', '1-PLAN.md']), '07-REVIEWS.md': ok } }).r, '7', ['--no-ui']);
  states(add, 'plan name 07-1PLAN.md (not a plan)', mk({ files: P7(['CONTEXT.md', '1PLAN.md']) }).r, '7', ['--no-ui']);
});

group('validate and secure', (add) => {
  const ok = '## Codex Review\n\nfine\n\n## Consensus Summary\nok\n';
  const done = { ...P7(['CONTEXT.md', '01-PLAN.md', '01-SUMMARY.md', 'VERIFICATION.md']), '07-REVIEWS.md': ok, '07-UAT.md': fmf('complete'), '07-REVIEW.md': fmf('clean') };
  const v = (x: string): string => `---\nnyquist_compliant: ${x}\n---\n`;
  const c: [string, Record<string, string>, string?][] = [
    ['no VALIDATION', done],
    ['draft', { ...done, '07-VALIDATION.md': v('false') }],
    ['"false"', { ...done, '07-VALIDATION.md': v('"false"') }],
    ['true', { ...done, '07-VALIDATION.md': v('true') }],
    ['"true"', { ...done, '07-VALIDATION.md': v('"true"') }],
    ["'true'", { ...done, '07-VALIDATION.md': v("'true'") }],
    ['True', { ...done, '07-VALIDATION.md': v('True') }],
    ['true # c', { ...done, '07-VALIDATION.md': v('true   # all automated') }],
    ['CRLF', { ...done, '07-VALIDATION.md': '---\r\nnyquist_compliant: true\r\n---\r\n' }],
    ['audit', { ...done, '07-VALIDATION.md': `${v('false')}\n## Validation Audit 2026\n` }],
    ['nyquist off', done, '{"workflow":{"nyquist_validation":false}}'],
    ['SECURITY missing', { ...done, '07-VALIDATION.md': v('true') }],
    ['SECURITY 2', { ...done, '07-VALIDATION.md': v('true'), '07-SECURITY.md': fmf('v', 'threats_open: 2\n') }],
    ['SECURITY 0', { ...done, '07-VALIDATION.md': v('true'), '07-SECURITY.md': fmf('v', 'threats_open: 0\n') }],
    ['SECURITY no key', { ...done, '07-VALIDATION.md': v('true'), '07-SECURITY.md': fmf('v') }],
    ['SECURITY empty', { ...done, '07-VALIDATION.md': v('true'), '07-SECURITY.md': fmf('v', 'threats_open:\n') }],
    ['SECURITY 00', { ...done, '07-VALIDATION.md': v('true'), '07-SECURITY.md': fmf('v', 'threats_open: 00\n') }],
    ['SECURITY text', { ...done, '07-VALIDATION.md': v('true'), '07-SECURITY.md': fmf('v', 'threats_open: some "x" \\ y\n') }],
  ];
  for (const [label, files, cfg] of c) states(add, label, mk({ files: cfg ? { ...files, '/.planning/config.json': cfg } : files }).r, '7', ['--no-ui']);
});

group('phase numbers, branches and errors', (add) => {
  const m = mk({ branch: 'phase-8-thing', dir: '08-thing', files: { '08-CONTEXT.md': '' } });
  for (const n of ['8', '08', '008', '0008', '8.0']) states(add, `phase ${n} on 08-`, m.r, n, ['--no-ui']);
  const d = mk({ branch: 'phase-2.1-fix', dir: '02.1-fix', files: { '02.1-CONTEXT.md': '' } });
  for (const n of ['2.1', '02.1', '2']) states(add, `phase ${n} on 02.1-`, d.r, n, ['--no-ui']);
  const u = mk({ branch: 'phase-7.1-fix', dir: '7.1-fix', files: { '7.1-CONTEXT.md': '' } });
  for (const n of ['7.1', '07.1']) states(add, `phase ${n} on 7.1-`, u.r, n, ['--no-ui']);
  const nopad = mk({ branch: 'phase-7-x', dir: '7-x', files: { '7-CONTEXT.md': '' } });
  states(add, 'unpadded dir 7-x (pad lookup fails)', nopad.r, '7', ['--no-ui']);
  const multi = mk({ files: { '07-CONTEXT.md': '' } });
  mkdirSync(path.join(multi.r, '.planning/phases/07-aaa'), { recursive: true });
  mkdirSync(path.join(multi.r, '.planning/phases/07-zzz'), { recursive: true });
  states(add, 'several 07-* dirs', multi.r, '7', ['--no-ui']);
  write(path.join(multi.r, '.planning/phases/07-0file'), 'a file');
  states(add, 'a file sorts first', multi.r, '7', ['--no-ui']);
  // branch-derived numbers
  for (const br of ['phase-7-thing', 'phase-7', 'phase-7.1-x', 'phase-12.5.3-x', 'phase-foo', 'phase-', 'feature-x', 'develop', 'phase-07-x']) {
    const b = mk({ branch: br, files: {} });
    add(`branch ${br}`, b.r, ['--no-ui']);
    add(`branch ${br} --all`, b.r, ['--no-ui', '--all']);
  }
  const x = mk({ files: {} });
  // invalid / odd args
  for (const argv of [['abc'], ['7a'], ['-5'], ['7.'], ['.5'], ['7.1.2'], ['1e3'], ['--bogus'], ['-x'], ['-'], ['--'], ['7', '8'], ['', '7'], ['7', ''], ['--help'], ['-h'], ['--bogus', '--help'], ['--help', '--bogus'], ['7', '--ui', '--no-ui'], ['99'], ['9'], ['99999999999999999999']]) {
    add(`argv ${JSON.stringify(argv)}`, x.r, argv);
  }
  add('missing repo value (rc only)', x.r, ['7', '--repo'], { rcOnly: true });
  // --repo as the next arg even when it looks like an option
  add('--repo takes the next arg', x.r, ['7', '--repo', '--all']);
  add('--repo empty falls back to PWD', x.r, ['7', '--repo', ''], { cwd: x.r });
  // no --repo at all: PWD
  test('PWD default', async () => {
    const cases: Case[] = [{ label: 'pwd', argv: ['7', '--no-ui'], cwd: x.r, env: {} }, { label: 'pwd branch', argv: ['--all'], cwd: x.r, env: {} }, { label: 'pwd subdir', argv: ['--all', '7'], cwd: x.pd, env: {} }];
    await runAll(cases);
  });
  // not a repo, missing phase dir
  const nr = tmp();
  add('not a git repo', nr, ['7']);
  add('not a git repo, no number', nr, []);
  const nd = mk({ branch: 'phase-9-missing', files: {} });
  add('missing phase dir', nd.r, ['9']);
  add('missing phase dir --json', nd.r, ['9', '--json']);
  // old names still in the repo → refusal
  const old = mk({ files: {} });
  write(path.join(old.r, 'scripts/gsd-premerge-check.sh'), '#!/bin/sh\n');
  add('migrate refusal', old.r, ['7']);
  add('migrate refusal with --help (help wins)', old.r, ['--help']);
});

group('the guard: wrong worktree, flow = strict', (add) => {
  const m = mk({ branch: 'phase-7-thing', files: P7(['CONTEXT.md']) });
  for (const n of ['7', '8', '7.1']) states(add, `wrong phase ${n}`, m.r, n, ['--no-ui']);
  const b = mk({ branch: 'develop', files: {} });
  states(add, 'on the base branch', b.r, '7', []);
  const o = mk({ branch: 'other-branch', files: {} });
  states(add, 'on a non-phase branch', o.r, '7', []);
  const skip = { GSD_SKIP_GUARD: '1' };
  states(add, 'skip guard on base', b.r, '7', [], skip);
  // a nested agent worktree name
  const strict = (files: Record<string, string>, extra = ''): string => mk({ conf: `base = develop\ninstall = none\nflow = strict\n${extra}`, files }).r;
  const ok = '## Codex Review\n\nfine\n\n## Consensus Summary\nok\n';
  const plans = P7(['01-PLAN.md']);
  states(add, 'strict: plan-phase needs CONTEXT (discuss step has none)', strict({}), '7', ['--no-ui']);
  states(add, 'strict: context only', strict(P7(['CONTEXT.md'])), '7', ['--no-ui']);
  states(add, 'strict: plan then review', strict({ ...P7(['CONTEXT.md']), ...plans }), '7', ['--no-ui']);
  states(add, 'strict: execute needs REVIEWS', strict({ ...P7(['CONTEXT.md']), ...plans, '07-REVIEWS.md': ok }), '7', ['--no-ui']);
  states(add, 'strict: execute with a bad REVIEWS', strict({ ...P7(['CONTEXT.md']), ...plans, '07-REVIEWS.md': '## Codex Review\n\nYou’ve hit your usage limit.\n' }), '7', ['--no-ui']);
  const s2 = { ...P7(['CONTEXT.md', '01-PLAN.md', '01-SUMMARY.md', 'VERIFICATION.md']), '07-REVIEWS.md': ok, '07-UAT.md': fmf('complete') };
  states(add, 'strict: secure without REVIEW', strict({ ...s2, '07-REVIEW.md': fmf('clean') }), '7', ['--no-ui']);
  states(add, 'strict: secure, no validation', strict({ ...s2, '07-REVIEW.md': fmf('clean'), '07-VALIDATION.md': '---\nnyquist_compliant: false\n---\n' }), '7', ['--no-ui']);
  states(add, 'strict: secure, all fine', strict({ ...s2, '07-REVIEW.md': fmf('clean'), '07-VALIDATION.md': '---\nnyquist_compliant: true\n---\n' }), '7', ['--no-ui']);
  states(add, 'strict: ui-review step', strict({ ...s2, '07-REVIEW.md': fmf('clean'), '07-UI-SPEC.md': '' }), '7', []);
  states(add, 'ui strict: ui-phase without design', strict(P7(['CONTEXT.md']), 'ui_gates = strict\n'), '7', ['--ui']);
  states(add, 'ui strict: ui-review without check', strict({ ...s2, '07-REVIEW.md': fmf('clean'), '07-UI-SPEC.md': '', '07-UI-REVIEW.md': '' }, 'ui_gates = strict\n'), '7', []);
  states(add, 'ui strict: ui-review step', strict({ ...s2, '07-REVIEW.md': fmf('clean'), '07-UI-SPEC.md': '' }, 'ui_gates = strict\n'), '7', []);
  states(add, 'flow=strict with the step skip', strict({ ...P7(['CONTEXT.md']), ...plans }), '7', ['--no-ui'], skip);
});
