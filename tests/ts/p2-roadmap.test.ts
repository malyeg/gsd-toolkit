// P2 parity: src/roadmap.ts (roadmap-audit, roadmap-rows) against
// lib/roadmap-audit.pl and lib/roadmap-rows.pl, same inputs side by side:
// stdout, stderr, exit code and the resulting file bytes must be equal.
// Run: node --test tests/ts/p2-roadmap.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { roadmapAudit, roadmapRows } from '../../src/roadmap.ts';
import { PKG, tmp, write } from './helpers.ts';

type Run = { out: Buffer; err: string; rc: number; file: Buffer | null };

function run(cmd: string, args: string[], file: string): Run {
  const r = spawnSync(cmd, args, { encoding: 'buffer' });
  let bytes: Buffer | null = null;
  try {
    bytes = readFileSync(file);
  } catch {
    /* file absent */
  }
  return { out: r.stdout, err: r.stderr.toString('latin1'), rc: r.status ?? -1, file: bytes };
}

const ts = (name: string, args: string[]): [string, string[]] => [process.execPath, [path.join(PKG, 'src/launch.mjs'), name, ...args]];

// Each side gets its own copy of the input (rows writes in place).
function both(kind: 'audit' | 'rows', content: string | Buffer, extra: string[] = [], opts: { sameErr?: boolean } = {}): { p: Run; t: Run } {
  const d = tmp();
  const pf = write(path.join(d, 'perl', 'ROADMAP.md'), content as string);
  const tf = write(path.join(d, 'ts', 'ROADMAP.md'), content as string);
  const pl = path.join(PKG, 'lib', kind === 'audit' ? 'roadmap-audit.pl' : 'roadmap-rows.pl');
  const p = run('perl', [pl, pf, ...extra], pf);
  const t = run(...ts(kind === 'audit' ? 'roadmap-audit' : 'roadmap-rows', [tf, ...extra]), tf);
  // Error text names the file path; make the two comparable.
  p.err = p.err.split(pf).join('<F>');
  t.err = t.err.split(tf).join('<F>');
  void opts;
  return { p, t };
}

function sameRun(label: string, p: Run, t: Run): void {
  assert.equal(t.out.toString('latin1'), p.out.toString('latin1'), `${label}: stdout`);
  assert.equal(t.err, p.err, `${label}: stderr`);
  assert.equal(t.rc, p.rc, `${label}: exit code`);
  assert.deepEqual(t.file, p.file, `${label}: file bytes`);
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const clean = `# Roadmap

## Phases
- [x] **Phase 1: First** - done
- [ ] **Phase 2: Second** - next

## Phase Details

### Phase 1: First
### Phase 2: Second

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. First | v1 | 1/1 | Complete | 2026-09-01 |
| 2. Second | v1 | 0/2 | In progress | - |
`;

const audits: Record<string, string> = {
  clean,
  'empty file': '',
  'no phases': '# Roadmap\n\nNothing here.\n',
  // T022 / T023: phase.insert wrote the section only
  'insert, no row, no progress': clean.replace('### Phase 2: Second\n', '### Phase 2: Second\n### Phase 2.1: Hot fix (INSERTED)\n'),
  'missing checklist row': clean.replace('- [ ] **Phase 2: Second** - next\n', ''),
  'missing progress row': clean.replace('| 2. Second | v1 | 0/2 | In progress | - |\n', ''),
  'no progress table': clean.split('## Progress')[0] as string,
  // T021: the greedy tick lands on another phase's row
  'row mentions another phase': `- [ ] **Phase 12: Twelve** - blocks Phase 13 (M1)
- [ ] **Phase 13: Thirteen**

### Phase 12: Twelve
### Phase 13: Thirteen

| Phase | Status |
|---|---|
| 12. Twelve | x |
| 13. Thirteen | x |
`,
  'tbd placeholder steals the tick': `- [ ] **Phase 1: One**
### Phase 1: One
### Phase 29: Next
- [ ] TBD (run /gsd:plan-phase 29 to break down)
| Phase | Status |
|---|---|
| 1. One | x |
| 29. Next | x |
`,
  'long non-phase line is cut at 40 bytes': `### Phase 5: Five
- [ ] ${'x'.repeat(30)} see Phase 5: and then a lot more text
| Phase | S |
|---|---|
| 5. Five | x |
`,
  'non-ASCII at the 40-byte cut': `### Phase 5: Five
- [ ] ${'é'.repeat(30)} Phase 5: ok
| Phase | S |
|---|---|
| 5. Five | x |
`,
  'own row ticked, other row mentions it': `- [x] **Phase 3: Three**
- [ ] **Phase 4: Four** after Phase 3: done
### Phase 3: Three
### Phase 4: Four
| Phase | S |
|---|---|
| 3. Three | x |
| 4. Four | x |
`,
  'zero-padded heading': `- [ ] **Phase 02: Two**
### Phase 02: Two
| Phase | S |
|---|---|
| 02. Two | x |
`,
  'padded heading, unpadded row': `- [ ] **Phase 2: Two**
### Phase 02: Two
| Phase | S |
|---|---|
| 2. Two | x |
`,
  'unpadded heading, padded mention (0* in the tick regex)': `- [ ] **Phase 1: One** then Phase 007: sneaky
### Phase 7: Seven
- [ ] **Phase 7: Seven**
| Phase | S |
|---|---|
| 1. One | x |
| 7. Seven | x |
`,
  'decimal phases': `- [ ] **Phase 2: Two**
- [ ] **Phase 2.1: Hot**
### Phase 2: Two
### Phase 2.1: Hot
### Phase 2.10: Ten
| Phase | S |
|---|---|
| 2. Two | x |
| 2.1. Hot | x |
`,
  'dot in phase number is literal in the tick regex': `- [ ] **Phase 1: A** Phase 2x1 here
### Phase 2.1: Z
`,
  'duplicate headings': `- [ ] **Phase 1: A**
### Phase 1: A
### Phase 1: A again
| Phase | S |
|---|---|
| 1. A | x |
`,
  'table ends at a blank line, later table rows ignored': `- [ ] **Phase 1: A**
### Phase 1: A

| Phase | S |
|---|---|

| 1. A | x |
`,
  'table header is case-insensitive, rows with "1 " separator': `- [ ] **Phase 1: A**
### Phase 1: A
| phase | S |
|---|---|
| 1 A | x |
`,
  'indented checkbox lines and h2/h4 headings': `  - [ ] **Phase 1: A**
## Phase 1: A
#### Phase 2: B
##### Phase 3: too deep
# Phase 4: too shallow
`,
  'bolded phase with extra spaces': `- [ ] **Phase   9  : Nine**
### Phase 9: Nine
| Phase | S |
|---|---|
| 9. Nine | x |
`,
  'CRLF file': clean.replace(/\n/g, '\r\n'),
  'CRLF with tick-stealing non-phase line': '- [ ] stub Phase 3: x\r\n### Phase 3: Three\r\n| Phase | S |\r\n|---|---|\r\n| 3. T | x |\r\n',
  'no final newline': clean.replace(/\n$/, ''),
  'no final newline, no progress row': '### Phase 1: A\n- [ ] **Phase 1: A**',
  'uppercase PHASE in a stolen row': '- [ ] foo PHASE 1: bar\n### Phase 1: One\n| Phase | S |\n|---|---|\n| 1. One | x |\n',
  'invalid UTF-8 and a lone CR': Buffer.from('### Phase 1: \xff\xfe\n- [ ] \xc3 Phase 1:\r x\n', 'latin1') as unknown as string,
  'blank only': '\n\n\n',
};

for (const [label, content] of Object.entries(audits)) {
  test(`audit: ${label}`, () => {
    const { p, t } = both('audit', content);
    sameRun(label, p, t);
    // the in-process function agrees with the CLI
    const f = write(path.join(tmp(), 'R.md'), content as string);
    assert.equal(Buffer.from(roadmapAudit(f), 'utf8').toString('latin1'), Buffer.from(p.out.toString('utf8'), 'utf8').toString('latin1'));
  });
}

test('audit: expected findings (sanity on the fixtures)', () => {
  const lines = (c: string): string[] => both('audit', c).p.out.toString().split('\n').filter(Boolean);
  assert.deepEqual(lines(clean), []);
  assert.deepEqual(lines(audits['missing checklist row'] as string), ['NOROW|2']);
  assert.deepEqual(lines(audits['missing progress row'] as string), ['NOPROG|2']);
  assert.ok(lines(audits['row mentions another phase'] as string).some((l) => l.startsWith('TICK|13|Phase 12')));
  assert.ok(lines(audits['tbd placeholder steals the tick'] as string).some((l) => l.startsWith('TICK|29|a non-phase line')));
});

test('audit: missing file, no argument, directory, "0"', () => {
  const d = tmp();
  for (const args of [[path.join(d, 'nope.md')], [], [d], ['0'], ['']]) {
    const p = spawnSync('perl', [path.join(PKG, 'lib/roadmap-audit.pl'), ...args], { encoding: 'buffer' });
    const [c, a] = ts('roadmap-audit', args);
    const t = spawnSync(c, a, { encoding: 'buffer' });
    assert.equal(t.stdout.toString(), p.stdout.toString(), `args ${JSON.stringify(args)}`);
    assert.equal(t.stderr.toString(), p.stderr.toString(), `stderr ${JSON.stringify(args)}`);
    assert.equal(t.status, p.status, `rc ${JSON.stringify(args)}`);
  }
});

// ── rows ─────────────────────────────────────────────────────────────────────

const base = `# Roadmap
- [x] **Phase 1: First** - done
- [ ] **Phase 2: Second** - next

## Phase Details
### Phase 1: First
### Phase 2: Second
### Phase 2.1: Hot fix | urgent (INSERTED)
- [ ] TBD (run /gsd-plan-phase 2.1 to break down)
### Phase 3: Third
- [ ] TBD (run /gsd-plan-phase 3 to break down)
### Phase 10: Tenth
### Phase 0.5: Half
### Phase 02: Padded

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. First | v1 | 1/1 | Complete | 2026-09-01 |
| 2. Second | v1 | 0/2 | In progress | - |
`;

const rowsCases: Array<[string, string, string[]]> = [];
for (const n of ['3', '2.1', '10', '0.5', '02', '2', '1', '4']) {
  rowsCases.push([`base, phase ${n}`, base, [n]]);
}
rowsCases.push(
  ['clean roadmap, phase 2 (nothing to add)', clean, ['2']],
  ['no heading for the phase', clean, ['9']],
  ['no heading, decimal', clean, ['2.1']],
  ['missing phase argument', clean, []],
  ['no checklist rows, no table', '# Roadmap\n### Phase 1: only\n', ['1']],
  ['no final newline, no rows', '# Roadmap\n### Phase 1: only', ['1']],
  ['2.1 row is not phase 2 (both)', '# Roadmap\n- [ ] **Phase 2.1: Fix**\n### Phase 2: Two\n### Phase 2.1: Fix\n\n| Phase | Status |\n|---|---|\n| 2.1. Fix | Not started |\n', ['2']],
  ['padded 02 matches the rows of phase 2', '# Roadmap\n- [ ] **Phase 2: Two**\n### Phase 02: Two\n\n| Phase | Status |\n|---|---|\n| 2. Two | Not started |\n', ['02']],
  ['padded row 02 vs phase 2', '- [ ] **Phase 02: Two**\n### Phase 2: Two\n| Phase | S |\n|---|---|\n| 02. Two | x |\n', ['2']],
  ['insert in the middle, indented rows', '  - [ ] **Phase 1: A**\n    - [ ] **Phase 3: C**\n### Phase 2: B\n| Phase | S |\n|---|---|\n| 1. A | x |\n| 3. C | x |\n', ['2']],
  ['insert at the end, last row has no newline', '- [ ] **Phase 1: A**\n### Phase 2: B\n- [ ] **Phase 1b: A**', ['2']],
  ['last checklist row is the last line (no newline)', '### Phase 2: B\n- [ ] **Phase 1: A**', ['2']],
  ['table is the last thing, no final newline', '- [ ] **Phase 1: A**\n### Phase 2: B\n| Phase | Status |\n|---|---|\n| 1. A | x |', ['2']],
  ['table header only', '- [ ] **Phase 1: A**\n### Phase 1: A\n| Phase | Status |\n', ['1']],
  ['table header + separator only', '- [ ] **Phase 1: A**\n### Phase 1: A\n| Phase | Status |\n|---|---|\n', ['1']],
  ['table header with no trailing pipe', '- [ ] **Phase 1: A**\n### Phase 1: A\n| Phase | Plans | Status\n|---|---|---|\n', ['1']],
  ['header columns: plan/status/other, case-insensitive', '### Phase 1: A\n| Phase | Goal | PLANS done | STATUS | Date | Owner |\n|--|--|--|--|--|--|\n', ['1']],
  ['header is just "| Phase |"', '### Phase 1: A\n| Phase |\n|---|\n', ['1']],
  ['pipe in the title becomes /', '### Phase 1: A | B | C\n| Phase | Status |\n|---|---|\n', ['1']],
  ['title with trailing spaces and tabs', '### Phase 1:   Spaced title \t \n- [ ] **Phase 0: Z**\n| Phase | S |\n|---|---|\n', ['1']],
  ['empty title', '### Phase 1:\n- [ ] **Phase 0: Z**\n| Phase | S |\n|---|---|\n', ['1']],
  ['CRLF roadmap', base.replace(/\n/g, '\r\n'), ['3']],
  ['CRLF roadmap, decimal', base.replace(/\n/g, '\r\n'), ['2.1']],
  ['h2 and h4 headings', '## Phase 1: A\n#### Phase 2: B\n- [ ] **Phase 1: A**\n| Phase | S |\n|---|---|\n| 1. A | x |\n', ['2']],
  ['first heading wins', '### Phase 1: First\n### Phase 1: Second\n- [ ] **Phase 0: Z**\n', ['1']],
  ['body rows non-numeric are ignored for order', '### Phase 3: C\n| Phase | S |\n|---|---|\n| n/a | x |\n| 1. A | x |\n| 5. E | x |\n', ['3']],
  ['second table after the first', '### Phase 2: B\n| Phase | S |\n|---|---|\n| 1. A | x |\n\n| Phase | S |\n|---|---|\n', ['2']],
  ['row exactly at order boundary (10 vs 2)', '- [ ] **Phase 2: B**\n- [ ] **Phase 10: J**\n### Phase 3: C\n| Phase | S |\n|---|---|\n| 2. B | x |\n| 10. J | x |\n', ['3']],
  ['decimals order 2.10 vs 2.9', '- [ ] **Phase 2.9: N**\n- [ ] **Phase 2.11: E**\n### Phase 2.10: T\n| Phase | S |\n|---|---|\n| 2.9. N | x |\n| 2.11. E | x |\n', ['2.10']],
  ['ticked checklist row counts as present', '- [x] **Phase 1: A**\n### Phase 1: A\n| Phase | S |\n|---|---|\n| 1. A | x |\n', ['1']],
  ['non-bold checklist row is not a row', '- [ ] Phase 1: A\n- [ ] **Phase 2: B**\n### Phase 1: A\n| Phase | S |\n|---|---|\n', ['1']],
  ['non-ASCII title', '### Phase 1: Ünïcode – título ✓\n- [ ] **Phase 0: Z**\n| Phase | S |\n|---|---|\n', ['1']],
  ['invalid UTF-8 in the file', Buffer.from('### Phase 1: \xff\xfe t\n- [ ] **Phase 0: Z**\n', 'latin1') as unknown as string, ['1']],
  // Not covered: a non-numeric phase (perl warns "isn't numeric" with its own script path).
  ['empty file', '', ['1']],
  ['extra args are ignored', '### Phase 1: A\n- [ ] **Phase 0: Z**\n', ['1', 'junk']],
);

for (const [label, content, args] of rowsCases) {
  test(`rows: ${label}`, () => {
    const { p, t } = both('rows', content, args);
    // die with $! unset exits 255, but "no heading" leaks errno on some platforms
    // (Linux: ENOTTY after open); the TS port pins 255. Compare all else strictly.
    if (p.rc !== t.rc && p.rc !== 0 && t.rc === 255 && /^no '### Phase /.test(p.err)) {
      t.rc = p.rc;
    }
    sameRun(label, p, t);
  });
}

test('rows: results look right (sanity on the fixtures)', () => {
  const { t } = both('rows', base, ['3']);
  const text = (t.file as Buffer).toString();
  assert.ok(text.includes('- [ ] **Phase 3: Third**\n'));
  assert.ok(text.includes('| 3. Third | - | 0/TBD | Not started | - |\n'));
  const again = both('rows', text, ['3']);
  assert.equal(again.t.file?.toString(), text, 'idempotent');
});

test('rows: idempotent, in sequence, on the real tool and the port alike', () => {
  const d = tmp();
  const pf = write(path.join(d, 'p', 'R.md'), base);
  const tf = write(path.join(d, 't', 'R.md'), base);
  for (const n of ['3', '2.1', '10', '0.5', '02', '3', '2.1']) {
    spawnSync('perl', [path.join(PKG, 'lib/roadmap-rows.pl'), pf, n]);
    const r = roadmapRows(tf, n);
    assert.equal(r.rc, 0);
    assert.deepEqual(readFileSync(tf), readFileSync(pf), `after phase ${n}`);
  }
  // the audit is clean for what was added (the two TBD lines are tick targets, as in bash)
  assert.equal(roadmapAudit(tf), spawnSync('perl', [path.join(PKG, 'lib/roadmap-audit.pl'), pf], { encoding: 'utf8' }).stdout);
});

test('rows: unreadable file exits 2 with the same message', () => {
  const d = tmp();
  const f = path.join(d, 'missing.md');
  const p = spawnSync('perl', [path.join(PKG, 'lib/roadmap-rows.pl'), f, '1'], { encoding: 'utf8' });
  const [c, a] = ts('roadmap-rows', [f, '1']);
  const t = spawnSync(c, a, { encoding: 'utf8' });
  assert.equal(t.stderr, p.stderr);
  assert.equal(t.status, p.status);
  assert.equal(t.status, 2);
  assert.equal(t.stdout, p.stdout);
});
