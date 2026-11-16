// P9: src/ticket.ts against saved goldens in tests/golden/p9-ticket/ (one text per test).
// Regenerate with UPDATE_GOLDEN=1; review a regenerated golden by diff.
import assert from 'node:assert/strict';
import path from 'node:path';
import { golden, test } from './golden.ts';
import { ticketExtract, ticketNorm, ticketTagged, trackerWhich } from '../../src/ticket.ts';
import { repo, sh, tmp, withEnv } from './helpers.ts';

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
  const nw: string[] = [];
  const one = (t: string | null): string => `rc=${t === null ? 1 : 0}${t === null ? '' : ' out=' + JSON.stringify(chomp(t))}`;
  for (const s of NORM) {
    for (const as of ['', 'clickup', 'custom']) {
      nw.push(`${JSON.stringify(s)} as=${as}: ${one(ticketNorm(s, as))}`);
    }
    // one-arg call, like start's other callers
    nw.push(`${JSON.stringify(s)} one-arg: rc=${ticketNorm(s) === null ? 1 : 0}`);
  }
  golden(nw.join('\n'));
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
  const nw: string[] = [];
  for (const s of EXTRACT) {
    nw.push(`${JSON.stringify(s)} => ${JSON.stringify(ticketExtract(s))}`);
  }
  golden(nw.join('\n'));
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
  const nw: string[] = [];
  for (const [s, id] of TAGGED) {
    nw.push(`${JSON.stringify(s)} ${JSON.stringify(id)} => ${ticketTagged(s, id)}`);
  }
  golden(nw.join('\n'));
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
  const nw: string[] = [];
  for (const [label, r, e] of cases) {
    nw.push(`${label} => ${JSON.stringify(withEnv({ GSD_TRACKER: undefined, ...e }, () => trackerWhich(r)))}`);
  }
  golden(nw.join('\n'));
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
