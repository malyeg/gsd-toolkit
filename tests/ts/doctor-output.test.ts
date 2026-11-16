// gsdt-doctor output modes: the default prints findings, updates, actionable notes and one summary line
// for the passed checks; --verbose prints today's full report; --quiet is an accepted no-op; --json is
// unchanged by all of it. Also: --fix runs `git worktree prune` for W027.
// Run: node --test tests/ts/doctor-output.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PKG, tmp, write } from './helpers.ts';

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd: string, ...a: string[]): string {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

function world(): { W: string; repo: string; run: (argv: string[]) => { out: string; err: string; rc: number } } {
  const W = tmp();
  const home = path.join(W, 'home');
  mkdirSync(home, { recursive: true });
  const stub = path.join(W, 'stub');
  write(path.join(stub, 'gsd_run'), `#!/bin/sh\necho '{"packageName":"@opengsd/gsd-core","version":"1.18.0"}'\n`, 0o755);
  const repo = path.join(W, 'repo');
  mkdirSync(path.join(repo, '.planning'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'develop');
  writeFileSync(path.join(repo, '.planning/ROADMAP.md'), '# Roadmap\n\n### Phase 1: One\n\n### Phase 2: Two\n');
  writeFileSync(path.join(repo, '.gsd.conf'), 'base = develop\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  git(W, 'init', '-q', '--bare', `${repo}.origin.git`);
  git(repo, 'remote', 'add', 'origin', `${repo}.origin.git`);
  git(repo, 'push', '-q', '-u', 'origin', 'develop');
  const env = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    GSD_NO_UPDATE_CHECK: '1',
    GSD_NO_CORE: '1',
    PATH: `${path.join(PKG, 'bin')}:${stub}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  const run = (argv: string[]) => {
    const r = spawnSync(path.join(PKG, 'bin', 'gsdt-doctor'), ['--repo', repo, ...argv], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { out: r.stdout ?? '', err: r.stderr ?? '', rc: r.status ?? 1 };
  };
  return { W, repo, run };
}

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
const SUMMARY = /^ {2}✔ \d+ checks? passed \(--verbose to list them\)$/m;

test('default output hides the passed checks and ends them with one summary line', () => {
  const { run } = world();
  const { out } = run([]);
  const t = plain(out);
  assert.match(t, SUMMARY);
  assert.doesNotMatch(t, /✔ (main checkout is on|no stale worktree records|\.planning is coherent)/);
  assert.equal((t.match(/✔/g) ?? []).length, 1, 'only the summary line carries a check mark');
  // the section headings are for --verbose
  assert.doesNotMatch(t, /^(Toolkit|Setup|Planning)\b/m);
});

test('--verbose lists every passed check and is the full report', () => {
  const { run } = world();
  const v = plain(run(['--verbose']).out);
  const d = plain(run([]).out);
  assert.match(v, /✔ no stale worktree records/);
  assert.match(v, /✔ main checkout is on 'develop'/);
  assert.doesNotMatch(v, /--verbose to list them/);
  assert.ok((v.match(/✔/g) ?? []).length > 10);
  assert.ok(v.split('\n').length > d.split('\n').length);
  assert.equal(plain(run(['-v']).out), v);
  // the count in the default summary is the number of ✔ lines of the full report
  const n = Number(/(\d+) checks? passed/.exec(d)?.[1]);
  assert.equal((v.match(/^ {2}✔ /gm) ?? []).length, n);
});

test('--quiet and -q still work and give the default output', () => {
  const { run } = world();
  const d = run([]);
  for (const flag of ['--quiet', '-q']) {
    const q = run([flag]);
    assert.equal(q.out, d.out, flag);
    assert.equal(q.rc, d.rc, flag);
  }
});

test('--json is the same in every mode', () => {
  const { run } = world();
  const j = run(['--json']).out;
  assert.doesNotThrow(() => JSON.parse(j));
  assert.equal(run(['--json', '--verbose']).out, j);
  assert.equal(run(['--json', '--quiet']).out, j);
  assert.doesNotMatch(j, /passed \(--verbose/);
});

test('an optional tip shows only with --verbose; it is in --json notes either way', () => {
  const { run } = world();
  // no ROADMAP-less repo: "no .gsd.conf" style tips — use the toolkit-checkout tip: this package is a git checkout
  const d = plain(run([]).out);
  const v = plain(run(['--verbose']).out);
  const tips = v.split('\n').filter((l) => l.startsWith('  • ') && !d.includes(l));
  const j = JSON.parse(run(['--json']).out) as { notes: string[] };
  for (const l of tips) assert.ok(j.notes.includes(l.slice(4)), `JSON keeps the tip: ${l}`);
});

test('--fix prunes a worktree record whose folder is gone (W027)', () => {
  const { W, repo, run } = world();
  const wt = path.join(W, 'gone-wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'scratch', wt);
  assert.match(git(repo, 'worktree', 'list'), /gone-wt/);
  rmSync(wt, { recursive: true, force: true });
  assert.match(git(repo, 'worktree', 'list'), /gone-wt/, 'git still records it');
  const before = run([]);
  assert.match(plain(before.out), /W027/);
  const j = JSON.parse(run(['--json']).out) as { safe: string[] };
  assert.ok(j.safe.includes('prune'));
  const fix = run(['--fix', '--yes']);
  const t = plain(fix.out);
  assert.match(t, /--fix will run[^\n]*\n\s+git worktree prune/, 'shown first');
  assert.doesNotMatch(git(repo, 'worktree', 'list'), /gone-wt/);
  assert.doesNotMatch(plain(run([]).out), /W027/);
});

test('--fix without --yes and no terminal asks, and prunes nothing', () => {
  const { W, repo, run } = world();
  const wt = path.join(W, 'gone-wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'scratch', wt);
  rmSync(wt, { recursive: true, force: true });
  const fix = run(['--fix']);
  assert.match(plain(fix.out), /not a terminal/);
  assert.match(git(repo, 'worktree', 'list'), /gone-wt/);
});
