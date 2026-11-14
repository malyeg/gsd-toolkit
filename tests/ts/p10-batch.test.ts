// P10 parity (gsdt-batch): the TypeScript command behind bin/gsdt-batch against the pre-P10
// bash command (tests/fixtures/p10-old-bins/gsdt-batch, run inside a package copy), each on
// its own copy of the same fixture project. Compared: stdout, stderr, exit code of every step,
// and the worktrees/branches/files/agent log left behind. Only temp roots and the package
// dirs are normalized (both sides name a batch with today's local date, so it needs no
// normalizing).
// Run: node --test tests/ts/p10-batch.test.ts
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, slugify, firstItem, isListItem } from '../../src/commands/batch.ts';
import { PKG, commitAll, envFor, git, makeSide, norm, oldPkg, settle, snapshot, tmp, write, type Project, type R, type Side } from './p6-helpers.ts';

// the old package: p6's copy (old start/wt-new bins) with the old gsdt-batch on top
const old10 = path.join(tmp(), 'oldpkg10');
cpSync(oldPkg, old10, { recursive: true });
copyFileSync(path.join(PKG, 'tests', 'fixtures', 'p10-old-bins', 'gsdt-batch'), path.join(old10, 'bin', 'gsdt-batch'));
chmodSync(path.join(old10, 'bin', 'gsdt-batch'), 0o755);
writeFileSync(path.join(old10, '.git'), '');

const pad = (n: number): string => String(n).padStart(2, '0');
const D = ((d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)(new Date());
const AGENT = `#!/bin/sh
{ printf 'argv:'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\ncwd: %s\\n' "$(pwd -P)"; } > "$GSD_TEST_AGENT_LOG"
exit 5
`;

const PTY = `
import os, pty, sys
cwd = sys.argv[1]; argv = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(argv[0], argv)
buf = b''
while True:
    try:
        d = os.read(fd, 4096)
    except OSError:
        break
    if not d:
        break
    buf += d
_, st = os.waitpid(pid, 0)
sys.stdout.buffer.write(buf)
sys.exit(os.waitstatus_to_exitcode(st))
`;

type Step = {
  args: string[] | ((s: Side) => string[]);
  cwd?: (s: Side) => string;
  env?: Record<string, string | undefined>;
  tty?: boolean;
  rc?: number;
  out?: RegExp;
  err?: RegExp;
};
const B = (s: Side, n: string): string => path.join(s.wtdir, n);

function mk(kind: 'old' | 'new', p: Project, prep?: (s: Side) => void): Side {
  const s = makeSide(kind, p);
  s.pkg = kind === 'old' ? old10 : PKG;
  if (prep) prep(s);
  return s;
}

function runStep(s: Side, st: Step): R {
  const args = typeof st.args === 'function' ? st.args(s) : st.args;
  const cwd = st.cwd ? st.cwd(s) : s.R;
  const env = envFor(s, st.env ?? {});
  const bin = path.join(s.pkg, 'bin', 'gsdt-batch');
  if (st.tty) {
    const r = spawnSync('python3', ['-c', PTY, cwd, bin, ...args], { env, encoding: 'utf8' });
    return { out: (r.stdout ?? '').replace(/\r\n/g, '\n'), err: '', rc: r.status ?? -1 };
  }
  const r = spawnSync(bin, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { out: r.stdout ?? '', err: r.stderr ?? '', rc: r.status ?? -1 };
}

function eq(got: string, want: string, label: string): void {
  if (got === want) return;
  const a = got.split('\n');
  const b = want.split('\n');
  const i = a.findIndex((l, k) => l !== b[k]);
  assert.fail(`${label}: line ${i + 1}\n  new: ${JSON.stringify(a[i])}\n  old: ${JSON.stringify(b[i])}`);
}

function scenario(project: Project, prep: ((s: Side) => void) | null, steps: Step[]): void {
  const o = mk('old', project, prep ?? undefined);
  const n = mk('new', project, prep ?? undefined);
  steps.forEach((st, i) => {
    const label = `step ${i + 1} (gsdt-batch ${(typeof st.args === 'function' ? st.args(n) : st.args).map((a) => norm(n, a)).join(' ')})`;
    const ro = runStep(o, st);
    const rn = runStep(n, st);
    settle(o);
    settle(n);
    eq(norm(n, rn.out), norm(o, ro.out), `${label}: stdout`);
    eq(norm(n, rn.err), norm(o, ro.err), `${label}: stderr`);
    assert.equal(rn.rc, ro.rc, `${label}: exit code (old ${ro.rc})`);
    if (st.rc !== undefined) assert.equal(rn.rc, st.rc, `${label}: expected rc\n${rn.out}${rn.err}`);
    if (st.out) assert.match(rn.out, st.out, label);
    if (st.err) assert.match(rn.err, st.err, label);
    eq(snapshot(n), snapshot(o), `${label}: files left behind`);
  });
}

const P = (...a: string[]): Step => ({ args: ['--print', ...a] });

test('--help is the bin header, wherever it sits', () => {
  scenario({}, null, [
    { args: ['--help'], rc: 0, out: /^\ngsdt-batch — run several quick tasks as one batch/ },
    { args: ['-h'], rc: 0 },
    { args: ['--print', 'x', '--help'], rc: 0 },
    { args: ['--bogus', '--help'], rc: 0 },
    { args: ['--name'], rc: 64 }, // the first problem wins
    { args: ['--', '--help'], rc: 0 }, // after -- it is a task
  ]);
});

test('usage errors', () => {
  scenario({}, null, [
    { args: [], rc: 64, err: /^gsdt-batch: nothing to run: gsdt-batch "- task one\n- task two", or gsdt-batch --file <path>\n$/ },
    { args: ['--print'], rc: 64 },
    { args: ['--name'], rc: 64, err: /--name needs a slug/ },
    { args: ['--file'], rc: 64, err: /--file needs a path/ },
    { args: ['--provider'], rc: 64, err: /--provider needs a name/ },
    { args: ['--agent-command'], rc: 64, err: /--agent-command needs a command/ },
    { args: ['--model'], rc: 64, err: /--model needs a model/ },
    { args: ['--repo'], rc: 64, err: /--repo needs a path/ },
    { args: ['x', '--model'], rc: 64 },
    { args: ['--'], rc: 64 },
    { args: ['--print', '--file', ''], rc: 64, err: /--file: no such file: / },
  ]);
});

test('not a repo, no base branch, .planning not committed', () => {
  const nowhere = (s: Side): string => path.join(s.root, 'elsewhere');
  scenario({}, (s) => mkdirSync(nowhere(s), { recursive: true }), [
    { args: ['--print', 'x'], cwd: nowhere, rc: 64, err: /not inside a git repository\n/ },
    { args: (s) => ['--print', '--repo', nowhere(s), 'x'], rc: 64, err: /not inside a git repository: .*elsewhere/ },
    { args: ['--print', '--repo', '/nonexistent/zz', 'x'], rc: 64 },
  ]);
  scenario({ conf: null }, (s) => {
    git(s.R, 'branch', '-m', 'trunk');
    git(s.R, 'checkout', '-q', '--detach');
  }, [P('x')].map((x) => ({ ...x, rc: 64, err: /could not tell the base branch — set 'base = <branch>' in .*\/\.gsd\.conf/ })));
  scenario({ noPlanning: true, files: { 'a.txt': 'a\n' } }, (s) => write(path.join(s.R, '.planning/ROADMAP.md'), '# r\n'), [
    P('- fix a'),
    { args: ['x'], rc: 64, err: /'\.planning\/' is not committed on 'main'/ },
  ]);
  // base = other branch where .planning is missing
  scenario({ conf: 'install = none\ntest = none\nbase = side\n' }, (s) => git(s.R, 'branch', 'side'), [P('x')]);
  scenario({ conf: 'install = none\ntest = none\nbase = nope\n' }, null, [P('x')]);
});

test('--print per provider, and the model rules', () => {
  scenario({}, null, [
    P('- fix a\n- fix b'),
    P('Read plan/FIX-BRIEF-7.md. Validate every item.'),
    P('--model', 'opus', 'x'),
    P('--model', 'default', 'x'),
    P('--model', 'sonnet', 'x'),
    P('--model', 'bad model', 'x'),
    P('--model', '-x', 'x'),
    P('--model', '', 'x'),
    P('--provider', 'claude', 'x'),
    P('--provider', 'codex', 'x'),
    P('--provider', 'codex', '--model', 'gpt-5', 'x'),
    P('--provider', 'codex', '--model', 'default', 'x'),
    P('--provider', 'codex', '--model', 'a b', 'x'),
    P('--provider', 'custom', '--agent-command', 'myagent', 'x'),
    P('--provider', 'custom', '--agent-command', 'myagent', '--model', 'opus', 'x'),
    P('--provider', 'custom', '--agent-command', 'myagent', '--model', 'default', 'x'),
    P('--provider', 'custom', 'x'),
    P('--provider', 'gemini', 'x'),
    P('--provider', 'nope', 'x'),
    P('--agent-command', '/opt/my bin/claude', 'x'),
    P('--agent-command', 'cl$ude', 'x'),
    P('--agent-command', '', 'x'),
  ]);
  scenario({ conf: 'install = none\ntest = none\nproviders = codex,claude\ncodex_model = gpt-x\n' }, null, [
    P('x'),
    P('--provider', 'claude', 'x'),
    P('--model', 'default', 'x'),
  ]);
  scenario({ conf: 'install = none\ntest = none\nproviders = bogus\n' }, null, [P('x')]);
  scenario({ conf: 'install = none\ntest = none\nclaude_model = opus\n' }, null, [P('x')]);
  scenario({}, null, [
    { ...P('x'), env: { GSD_PROVIDER: 'codex', GSD_CODEX_MODEL: 'zz' } },
    { ...P('x'), env: { GSD_PROVIDER: 'custom', GSD_CUSTOM_COMMAND: 'mine' } },
    { ...P('x'), env: { GSD_AGENT: 'weird-agent' } },
    { ...P('x'), env: { GSD_CLAUDE_MODEL: 'haiku', GSD_MODEL: 'opus' } },
  ]);
});

test('the argument split: flags, then the list', () => {
  scenario({}, null, [
    P('--validate', '- fix a', '- fix b'),
    P('- fix a', '--validate'),
    P('- fix a', '--validate', '2. second', '3) third', '* star'),
    P('1 item', '9. nine', 'plain'),
    P('item 4) x', 'x. y'),
    P('a\nb', 'c'),
    P('--', '--validate', '- x'),
    P('-- x'),
    P('--', 'a b'),
    P('-x', 'y'),
    P('--resume'),
    P('-', 'x'),
    P('1.'),
    P('1. a', '--flag'),
  ]);
});

test('names: derived, list marker, long text, --name, --file', () => {
  const long = 'Fix the INVOICE rounding bug in the totals; and then some more words that go on and on';
  scenario({ files: { 'briefs/Fix Notes v2.md': 'x\n', 'a.md': 'a\n' } }, null, [
    P('- fix the login bug'),
    P('1. First thing', '2. second'),
    P('3) Third'),
    P('* star item'),
    P('  - indented item'),
    P('\n\n- after blank lines\n- two'),
    P(long),
    P('Unicode stuff 123'),
    P('!!!'),
    P('--validate', 'real words here'),
    P('--name', 'My Batch', 'x'),
    P('--name', 'batch-already-prefixed', 'x'),
    P('--name', '###', 'x'),
    P('--name', 'a very long name with many words that is cut', 'x'),
    P('--file', 'a.md'),
    P('--file', 'briefs/Fix Notes v2.md'),
    P('--file', 'a.md', '--file', 'briefs/Fix Notes v2.md', 'more'),
    P('--name', 'given', '--file', 'a.md'),
    P('--file', 'nope.md'),
    { ...P('--file', 'a.md'), cwd: (s) => path.join(s.R, '.planning') },
  ]);
});

test('--file: tracked on the base branch, untracked, absolute, outside, symlinked', () => {
  scenario({ files: { 'briefs/b.md': 'b\n', 'top.md': 't\n' } }, (s) => {
    write(path.join(s.R, 'untracked.md'), 'u\n');
    write(path.join(s.root, 'outside.md'), 'o\n');
    mkdirSync(path.join(s.R, 'briefs/sub'), { recursive: true });
    write(path.join(s.R, 'briefs/sub/ignored-untracked.md'), 'x\n');
    symlinkSync(s.R, path.join(s.root, 'link'));
  }, [
    P('--file', 'top.md'),
    P('--file', 'briefs/b.md'),
    P('--file', './briefs/../top.md'),
    { ...P('--file', 'b.md'), cwd: (s) => path.join(s.R, 'briefs') },
    { ...P('--file', '../top.md'), cwd: (s) => path.join(s.R, 'briefs') },
    P('--file', 'untracked.md'),
    { args: (s) => ['--print', '--file', path.join(s.R, 'briefs/b.md')] },
    { args: (s) => ['--print', '--file', path.join(s.R, 'untracked.md')] },
    { args: (s) => ['--print', '--file', path.join(s.root, 'outside.md')] },
    { args: (s) => ['--print', '--file', path.join(s.root, 'link', 'briefs/b.md')], cwd: (s) => s.root },
    { args: (s) => ['--print', '--repo', s.R, '--file', 'briefs/b.md'], cwd: (s) => s.R },
    { args: (s) => ['--print', '--repo', s.R, '--file', 'outside.md'], cwd: (s) => s.root },
    { args: (s) => ['--print', '--file', path.join(s.R, 'briefs')] }, // a directory
    { args: ['--print', '--file', 'briefs/b.md', '--provider', 'codex'] },
    // not --print: the worktree is made, then the path is given from it
    { args: ['--file', 'briefs/b.md'], rc: 0, out: /batch-[^ ]*b\b.*--file.*briefs\/b\.md/ },
    { args: ['--file', 'briefs/b.md', '--name', 'second'], rc: 0 },
  ]);
});

test('no terminal: the worktree is made and the command printed; -2 numbering; --name reuse', () => {
  scenario({}, null, [
    { args: ['- fix a'], rc: 0, err: /✅ worktree ready/ },
    { args: ['- fix a'], rc: 0 }, // -2
    { args: ['- fix a'], rc: 0 }, // -3
    P('- fix a'), // -4 would be made
    { args: ['--name', 'mine', '- x'], rc: 0 },
    { args: ['--name', 'mine', '- x'], rc: 0 }, // reused
    P('--name', 'mine', '- x'), // would use
    { args: ['--name', 'mine', '--provider', 'codex', 'y'], rc: 0 },
    { args: ['--name', 'batch-mine', 'z'], rc: 0 },
    { args: ['--provider', 'custom', '--agent-command', 'zz', '--name', 'cust', 'y'], rc: 0 },
    { args: ['--provider', 'custom', '--agent-command', 'zz', '--model', 'opus', 'y'], rc: 64 },
    { args: ['--bogus-flag', 'real item'], rc: 0 },
    { args: ['--repo', '/nonexistent', 'x'], rc: 64 },
  ]);
  // a worktree for the name exists but another checkout of the branch is gone
  scenario({}, null, [
    { args: ['--name', 'gone', 'x'], rc: 0 },
    {
      args: ['--name', 'gone', 'x'],
      cwd: (s) => {
        spawnSync('rm', ['-rf', B(s, `batch-${D}-gone`)]);
        return s.R;
      },
    },
    { args: ['--name', 'gone', '--print', 'x'] },
  ]);
  // the branch exists with no worktree
  scenario({}, (s) => git(s.R, 'branch', `batch-${D}-orphan`), [
    P('- orphan'),
    P('--name', 'orphan', 'x'),
    { args: ['--name', 'orphan', 'x'] },
    { args: ['orphan'], rc: 0 },
  ]);
});

test('run from inside a batch worktree, a phase worktree, a subdir, --repo', () => {
  scenario({ files: { 'brief.md': 'b\n' } }, null, [
    { args: ['--name', 'inside', '- one'], rc: 0 },
    { ...P('- two'), cwd: (s) => B(s, `batch-${D}-inside`) },
    { args: ['--file', 'brief.md'], cwd: (s) => B(s, `batch-${D}-inside`), rc: 0 },
    { args: ['--print', '--file', 'brief.md', 'x', '--model', 'opus'], cwd: (s) => B(s, `batch-${D}-inside`) },
    { args: ['--print', '--name', 'ignored', 'x'], cwd: (s) => B(s, `batch-${D}-inside`) },
    { args: ['--print', '--provider', 'codex', 'x'], cwd: (s) => path.join(B(s, `batch-${D}-inside`), '.planning') },
    // --repo makes it ignore the batch worktree it stands in
    { args: (s) => ['--print', '--repo', s.R, 'x'], cwd: (s) => B(s, `batch-${D}-inside`) },
    { args: (s) => ['--print', '--repo', B(s, `batch-${D}-inside`), 'x'], cwd: (s) => s.R },
    { args: (s) => ['--repo', B(s, `batch-${D}-inside`), 'x'], cwd: (s) => s.root, rc: 0 },
  ]);
  scenario({}, (s) => {
    mkdirSync(s.wtdir, { recursive: true });
    git(s.R, 'worktree', 'add', '-q', '-b', 'phase-1-catalog', B(s, 'phase-1-catalog'));
    git(s.R, 'worktree', 'add', '-q', '-b', 'feature-x', B(s, 'feature-x'));
    mkdirSync(path.join(s.R, 'src'), { recursive: true });
  }, [
    { ...P('- from a phase'), cwd: (s) => B(s, 'phase-1-catalog') },
    { args: ['- from a phase'], cwd: (s) => B(s, 'phase-1-catalog'), rc: 0 },
    { ...P('- from feature'), cwd: (s) => B(s, 'feature-x') },
    { ...P('- from a subdir'), cwd: (s) => path.join(s.R, 'src') },
  ]);
  // a conf with a custom wtdir
  scenario({ conf: 'install = none\ntest = none\nwtdir = custom-wts\n' }, null, [P('- x'), { args: ['- x'], rc: 0 }]);
});

function withStubs(s: Side): void {
  write(path.join(s.stub, 'claude'), AGENT, 0o755);
  write(path.join(s.stub, 'myagent'), AGENT, 0o755);
}

test('a terminal: the session opens in the worktree (argv + cwd logged), exit code passes through', () => {
  scenario({ files: { 'brief.md': 'b\n' } }, withStubs, [
    { args: ['- fix a', '- fix b'], tty: true, rc: 5, out: /▶ opening a claude batch session on sonnet in .*batch-.*-fix-a…\r?\n {2}land it afterwards: gsdt-finish batch-/ },
    { args: ['--model', 'default', '- fix a'], tty: true, rc: 5, out: /▶ opening a claude batch session in / },
    { args: ['--model', 'opus', '--file', 'brief.md'], tty: true, rc: 5 },
    { args: ['--name', 'twice', 'x'], tty: true, rc: 5 },
    { args: ['--name', 'twice', 'x'], tty: true, rc: 5 }, // reused
    { args: ['--provider', 'custom', '--agent-command', 'myagent', 'x'], tty: true, rc: 5, out: /▶ opening a custom batch session in / },
    { args: ['--provider', 'custom', '--agent-command', '/nonexistent/agent', 'x'], tty: true, rc: 69, out: /gsdt-batch: \/nonexistent\/agent not found on PATH/ },
    { args: ['--provider', 'codex', 'x'], tty: true, rc: 69, out: /codex not found on PATH/ }, // no codex on the test PATH; the worktree is made first
    { args: ['--print', 'x'], tty: true, rc: 0 },
    { args: ['--help'], tty: true, rc: 0 },
  ]);
  // from inside the worktree
  scenario({}, withStubs, [
    { args: ['--name', 'in', 'x'], rc: 0 },
    { args: ['- here'], tty: true, rc: 5, cwd: (s) => B(s, `batch-${D}-in`) },
  ]);
  // no claude on the PATH at all, the worktree is still made
  scenario({}, null, [{ args: ['- fix a'], tty: true, rc: 69, out: /gsdt-batch: claude not found on PATH/ }]);
});

// ── new side only ──────────────────────────────────────────────────────────

// The old command printed a task with non-Latin-1 text through the system bash 3.2's `printf %q`,
// which mangles it (a known bash quirk, see shellQuote in src/provider.ts); the TS output is
// bash 5's. The name is still the same: each non-ASCII character is a word break.
test('non-ASCII task text: the batch name and the quoted command', () => {
  const n = mk('new', {});
  const r = runStep(n, P('Ünïcode ÀÉ stuff 123'));
  assert.equal(r.rc, 0);
  assert.match(r.out, /batch-\d{4}-\d{2}-\d{2}-n-code-stuff-123 && claude --model sonnet /);
  assert.ok(r.out.includes('Ünïcode'));
});

// bash exec'd the session, so a signal killed gsdt-batch itself; Node has no exec, so the signal
// comes back as 128+n (the P6 convention).
test('a session killed by a signal gives 128+n', () => {
  const n = mk('new', {}, (s) => write(path.join(s.stub, 'claude'), '#!/bin/sh\nkill -TERM $$\n', 0o755));
  assert.equal(runStep(n, { args: ['x'], tty: true }).rc, 143);
});

test('slugify, firstItem and isListItem (pure helpers)', () => {
  assert.equal(slugify('Fix the INVOICE rounding bug in the totals'), 'fix-the-invoice-rounding-bug');
  assert.equal(slugify('  a  b!c '), 'a-b-c');
  assert.equal(slugify('ÀÉ'), '');
  assert.equal(slugify(''), '');
  assert.equal(slugify('abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz'), 'abcdefghijklmnopqrstuvwxyz-abcdefghijklm');
  assert.equal(slugify('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa b'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'.slice(0, 40));
  assert.equal(slugify('x'.repeat(39) + ' y'), 'x'.repeat(39));
  assert.equal(firstItem('\n\n  - fix a\n- b'), 'fix a');
  assert.equal(firstItem('12) twelve'), 'twelve');
  assert.equal(firstItem('-nospace'), '-nospace');
  assert.equal(firstItem(''), '');
  assert.equal(isListItem('- a'), true);
  assert.equal(isListItem('-a'), false);
  assert.equal(isListItem('* a'), true);
  assert.equal(isListItem('2) b'), true);
  assert.equal(isListItem('--flag'), false);
  assert.equal(isListItem('a\nb'), true);
  assert.equal(isListItem('9 lives. ok'), true);
});

test('main() is callable and returns the exit code', () => {
  assert.equal(typeof main, 'function');
  const prev = process.cwd();
  process.chdir(tmp());
  try {
    // no argument: refused before anything is made
    assert.equal(main([]), 64);
  } finally {
    process.chdir(prev);
  }
  assert.ok(existsSync(PKG));
  void commitAll;
});
