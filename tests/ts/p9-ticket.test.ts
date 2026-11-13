// P9: src/ticket.ts against lib/ticket.sh (the oracle), on the same inputs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { ticketExtract, ticketNorm, ticketTagged, trackerWhich } from '../../src/ticket.ts';
import { PKG, repo, sh, tmp, withEnv, LOCALE_ENV } from './helpers.ts';

const sourced = (script: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync('bash', ['-c', `. "$GSD_PKG/lib/common.sh"; . "$GSD_PKG/lib/ticket.sh"; ${script}`, '_', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GSD_PKG: PKG, ...LOCALE_ENV, ...env },
  });
const chomp = (s: string): string => s.replace(/\n+$/, '');

const long = (n: number): string => 'a'.repeat(n);
const NORM = [
  '869e33cv4', 'tk-PROJ-42', 'TK-proj-42', 'Tk-x', 'cu_869e33cv4', 'CU_abc', 'cU_abc', 'CU-12', 'cu-12', 'CU-869e33cv4',
  'https://app.clickup.com/t/869e33cv4', 'https://x.atlassian.net/browse/PROJ-42?focus=1',
  'https://x.example/t/abc/', 'https://x.example/t/abc/?q=1#frag', 'https://x.example/t/abc#frag', 'https://x.example/t/abc?a=b/c',
  'https://x.example/t/tk-abc', 'https://x.example/t/CU-abc', 'https://x.example/', 'https://x.example', 'ftp://h/a//', 'x://',
  '#42', '##42', '#tk-5', 'tk-#5', 'tk-', 'tk--a', 'tk-a-', 'a--b', 'a-b-c', '-a', 'a-', '', '#', 'tk-tk-a', 'cu_cu_a', 'tk-cu_a',
  'a b', ' a', 'a ', 'x;rm', 'a_b', 'a.b', 'é', 'aé', 'tk-é', long(64), long(65), `tk-${long(64)}`, `tk-${long(65)}`, `${long(32)}-${long(31)}`,
  'é'.repeat(64), 'é'.repeat(65), `${'é'.repeat(65)}\nok`, 'a\nb', 'a b\nc', 'a\n b', '\nabc', 'abc\n', 'bad one\nabc', 'a\n\nb', 'tk-a\nb',
  'https://x/a\nb', 'https://x/a b\nc',
];
test('ticketNorm = gsd_ticket_norm', () => {
  for (const s of NORM) {
    for (const as of ['', 'clickup', 'custom']) {
      const b = sourced('gsd_ticket_norm "$1" "$2"', [s, as]);
      const t = ticketNorm(s, as);
      assert.equal(t === null ? 1 : 0, b.status, `rc for ${JSON.stringify(s)} as=${as}`);
      if (t !== null) assert.equal(chomp(t), chomp(b.stdout), `out for ${JSON.stringify(s)} as=${as}`);
    }
    // one-arg call, like start's other callers
    assert.equal(ticketNorm(s) === null ? 1 : 0, sourced('gsd_ticket_norm "$1"', [s]).status, `one-arg ${JSON.stringify(s)}`);
  }
});

const EXTRACT = [
  '### Phase 7: cart tk-PROJ-42', 'Phase 2.1: bug tk-abc123 (INSERTED)', 'phase-7-cart-tk-proj-42', 'cart cu_869e33cv4', 'cart ClickUp 869e33cv4',
  'plain stuck title', '', 'tk-a', 'xtk-a', 'x-tk-a', 'TK-A-B-c d', '(tk-a)', 'tk-', 'tk--a', 'tk-a--b', 'tk-é', 'étk-abc', 'éTK-abc',
  'cu-abc', 'cu_abcdef', 'cu-abcde', 'cu_abcdef-x', 'CU_ABCDEF', 'xcu_abcdef', 'x-cu-abcdef1', 'cu_é123456', 'cu-12345',
  'a cu_abcdef tk-first', 'cu_abcdef\ntk-second', 'plain\ntk-second\ncu_abcdef', 'x\n\ncu-abcdef', 'tk-a tk-b',
  'ClickUp abcdef', 'clickup\tabcdef', 'CLICKUP   abc123 more', 'ClickUp\vabcdef', 'ClickUp\fabcdef', 'ClickUp\rabcdef', 'ClickUp \vabcdef',
  'ClickUp abcde', 'clickupabcdef', 'ClickUp\nabcdef', 'ClickUp  \t abc123xyz', 'xclickup abcdef', 'a\nClickUp abcdef', 'ClickUp é23456',
  'ClickUp\u00a0abcdef', 'ClickUp\u2003abcdef', '### Phase 12: x tk-869e33cv4\n### Phase 13: y',
];
test('ticketExtract = gsd_ticket_extract', () => {
  for (const s of EXTRACT) {
    const b = sourced('gsd_ticket_extract "$1"', [s]);
    assert.equal(b.status, 0, `bash rc for ${JSON.stringify(s)}`);
    assert.equal(ticketExtract(s), chomp(b.stdout), `extract ${JSON.stringify(s)}`);
  }
});

const TAGGED: Array<[string, string]> = [
  ['cart tk-PROJ-42', 'PROJ-4'], ['cart tk-PROJ-42', 'proj-42'], ['cart tk-PROJ-42', 'PROJ-42'], ['cart tk-PROJ-42', 'PROJ'],
  ['phase-7-cart-tk-proj-42-pr', 'proj-42'], ['phase-7-cart-tk-proj-42-pr', 'proj'], ['tk-a-pr x', 'a'], ['tk-a-prx', 'a'], ['tk-a-pr-pr', 'a'],
  ['tk-a-b', 'a'], ['tk-a_b', 'a'], ['tk-a.', 'a'], ['tk-a', 'a'], ['tk-a\nzzz', 'a'], ['zzz\ntk-a', 'a'], ['zzz\ntk-b', 'a'],
  ['xtk-a', 'a'], ['x tk-a', 'a'], ['TK-A', 'a'], ['Tk-a', 'A'], ['cu_abcdef', 'abcdef'], ['cu-abcdef', 'abcdef'], ['CU_ABCDEF', 'abcdef'],
  ['a cu_abcdef tk-x', 'x'], ['tk-x tk-y', 'y'], ['tk-x tk-y', 'z'], ['tk-x-pr tk-y', 'x'], ['', 'a'], ['tk-a', ''], ['tk-', ''],
  ['tk-é', 'é'], ['étk-a', 'a'], ['tk-a-pr\ntk-a-prx', 'a'], ['cu_abc', 'abc'], ['cu-abc', 'abc'],
  // ids that are regex text: bash inserts them raw (callers validate first)
  ['tk-a', 'a|b'], ['tk-b', 'a|b'], ['tk-ab', 'a.'], ['tk-a', '(a'],
];
test('ticketTagged = gsd_ticket_tagged', () => {
  for (const [s, id] of TAGGED) {
    const b = sourced('gsd_ticket_tagged "$1" "$2"', [s, id]);
    assert.equal(ticketTagged(s, id), b.status === 0, `tagged ${JSON.stringify(s)} ${JSON.stringify(id)}`);
  }
});

test('trackerWhich = gsd_tracker_which', () => {
  const mk = (conf: string | null, gitcfg?: string): string => {
    const r = repo(path.join(tmp(), 'r'), conf ?? undefined);
    if (gitcfg !== undefined) sh(r, 'git', ['config', 'gsdt-tracker.tracker', gitcfg]);
    return r;
  };
  const cases: Array<[string, string, Record<string, string | undefined>]> = [];
  for (const [label, conf, g] of [
    ['no conf', null, undefined], ['conf, none set', 'base = main\n', undefined], ['conf clickup', 'tracker = clickup\n', undefined],
    ['conf custom', 'tracker = custom\n', undefined], ['conf bogus', 'tracker = jira\n', undefined], ['conf none', 'tracker = none\n', undefined],
    ['git custom', 'base = main\n', 'custom'], ['git beats conf', 'tracker = clickup\n', 'custom'], ['git bogus', 'base=main\n', 'zzz'],
    ['git clickup no conf', null, 'clickup'],
  ] as Array<[string, string | null, string | undefined]>) {
    const r = mk(conf, g);
    for (const e of [{}, { GSD_TRACKER: 'custom' }, { GSD_TRACKER: 'none' }, { GSD_TRACKER: 'clickup' }, { GSD_TRACKER: 'weird' }]) cases.push([`${label} ${JSON.stringify(e)}`, r, e]);
  }
  const plain = tmp();
  cases.push(['not a repo', plain, {}], ['missing dir', path.join(plain, 'nope'), {}]);
  for (const [label, r, e] of cases) {
    const b = sourced('gsd_tracker_which "$1"', [r], e as Record<string, string>);
    const t = withEnv({ GSD_TRACKER: undefined, ...e }, () => trackerWhich(r));
    assert.equal(t, chomp(b.stdout), label);
  }
});

// The twins: GSD's helpers (src/ticket.ts) and gsdt-tracker's own standalone
// copies (src/tracker/ids.ts) must agree, as test-tracker.sh checks for bash.
test('src/ticket.ts and src/tracker/ids.ts agree', async () => {
  const { trkIdNorm, trkIdExtract } = await import('../../src/tracker/ids.ts');
  for (const s of NORM) {
    for (const as of ['', 'clickup', 'custom']) {
      const c = (v: string | null): string | null => (v === null ? null : chomp(v));
      assert.equal(c(ticketNorm(s, as)), c(trkIdNorm(s, as)), `norm twins on ${JSON.stringify(s)} as=${as}`);
    }
  }
  for (const s of [...EXTRACT, ...NORM]) {
    assert.equal(ticketExtract(s), trkIdExtract(s), `extract twins on ${JSON.stringify(s)}`);
  }
});
