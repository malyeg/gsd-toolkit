// doctor-all.test.ts — `gsdt-doctor --all`: the registry (~/.config/gsd/repos), the folder scan, the
// one-line-per-repo report, and the commands that add repos to the registry. Throwaway HOME throughout.
// Run: node --test tests/node/doctor-all.test.ts
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PKG, gsdt, gitOk, hostPath, joinPath, stubExe, tmp, write } from './g2-helpers.ts';
import type { Env } from './g2-helpers.ts';

const WORK = tmp('gsd-docall-');
const HOME = path.join(WORK, 'home');
mkdirSync(HOME, { recursive: true });
const REG = path.join(HOME, '.config', 'gsd', 'repos');
const STUB = path.join(WORK, 'stub');
const IDENT = '{"packageName":"@opengsd/gsd-core","version":"1.18.0"}';
stubExe(STUB, 'gsd_run', `echo '${IDENT}'`, `echo ${IDENT}`);
// a machine without Claude Code (CI) would add T051/T057 to every repo
stubExe(STUB, 'claude', 'echo 2.0.0', 'echo 2.0.0');

const SETTINGS = path.join(WORK, 'claude-settings.json');
const rulesBin = path.join(PKG, 'bin', 'gsdt-rules').replace(/\\/g, '/');
writeFileSync(SETTINGS, `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `[ ! -x ${rulesBin} ] || exec ${rulesBin} --hook` }] }] } })}\n`);

const env = (): Env => ({
  GSD_CLAUDE_SETTINGS: SETTINGS,
  HOME,
  USERPROFILE: HOME,
  XDG_CONFIG_HOME: path.join(HOME, '.config'),
  GSD_NO_CORE: '1',
  GSD_NO_UPDATE_CHECK: '1',
  GSD_CLAUDE_SKILL_DIR: path.join(WORK, 'skills'),
  GSD_CLICKUP_CONFIG: path.join(WORK, 'clickup.env'),
  PATH: joinPath([path.join(PKG, 'bin'), ...hostPath(), STUB]),
});

const mkrepo = (dir: string, conf = 'base = develop\n'): void => {
  gitOk(WORK, ['init', '-q', '-b', 'develop', dir]);
  write(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n- [ ] **Phase 1: One**\n\n### Phase 1: One\n\n## Progress\n\n| Phase | Plans | Status | Date |\n|---|---|---|---|\n| 1. One | 0/0 | Not started | - |\n');
  write(path.join(dir, '.gsd.conf'), conf);
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  gitOk(WORK, ['init', '-q', '--bare', `${dir}.origin.git`]);
  gitOk(dir, ['remote', 'add', 'origin', `${dir}.origin.git`]);
  gitOk(dir, ['push', '-q', '-u', 'origin', 'develop']);
};
const all = (args: string[]) => gsdt('doctor', ['--all', ...args], { env: env() });
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

const PROJ = path.join(WORK, 'proj');
const GOOD = path.join(PROJ, 'good');
const BAD = path.join(PROJ, 'bad');
const GONE = path.join(WORK, 'gone');
mkdirSync(PROJ, { recursive: true });
mkrepo(GOOD);
// make GOOD fully set up (gsdt-init --no-launch --no-commit writes the shims and instructions)
const init = gsdt('init', ['--no-launch', '--no-commit'], { env: env(), cwd: GOOD });
rmSync(REG, { force: true }); // the init above registered GOOD; the tests start from no registry
mkrepo(BAD,'base = develop\nbogus_key = 1\n');
// a phase worktree inside the scanned folder must not be listed
gitOk(BAD, ['worktree', 'add', '-q', '-b', 'phase-1-x', path.join(PROJ, 'bad-wt')]);
mkdirSync(path.join(PROJ, 'node_modules', 'dep'), { recursive: true });
mkrepo(path.join(WORK, 'unrelated'));
// a repo whose .gsd.conf only holds gsdt-tracker settings does not use the toolkit
const TICKETS = path.join(PROJ, 'tickets');
gitOk(WORK, ['init', '-q', '-b', 'main', TICKETS]);
write(path.join(TICKETS, '.gsd.conf'), 'tracker = clickup\ntracker_profile = x   # tickets only\n');

describe('doctor --all', () => {
  it('no registry, no folder: usage, exit 0', () => {
    const r = all([]);
    assert.equal(r.status, 0, r.out + r.stderr);
    assert.match(r.out, /gsdt-doctor --all ~\/projects/);
    assert.ok(!existsSync(REG));
  });

  it('registry: clean repo, repo with a finding, a missing path', () => {
    mkdirSync(path.dirname(REG), { recursive: true });
    writeFileSync(REG, `# my repos\n${GOOD}\n${BAD}\n${GONE}\n${GOOD}\n`);
    const before = readFileSync(REG, 'utf8');
    const mtime = statSync(REG).mtimeMs;
    const r = all([]);
    const o = strip(r.out);
    assert.equal(r.status, 1, o);
    assert.match(o, /✔ good\s+ok\s+/);
    assert.match(o, /✖ bad\s+\d+ findings?: T0\d\d/);
    assert.match(o, new RegExp(`${GONE.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} no longer exists`));
    assert.match(o, /2 repos, 1 with findings — run gsdt-doctor in a repo for details/);
    assert.equal(readFileSync(REG, 'utf8'), before, 'the registry is untouched');
    assert.equal(statSync(REG).mtimeMs, mtime);
  });

  it('a clean registry exits 0', () => {
    writeFileSync(REG, `${GOOD}\n`);
    const r = all([]);
    assert.equal(r.status, 0, r.out + r.stderr);
    assert.match(strip(r.out), /1 repo, 0 with findings/);
  });

  it('folder scan: finds main checkouts only, writes nothing', () => {
    writeFileSync(REG, '');
    const r = all([PROJ]);
    const o = strip(r.out);
    assert.match(o, /✔ good/);
    assert.match(o, /✖ bad /);
    assert.doesNotMatch(o, /bad-wt/);
    assert.doesNotMatch(o, /unrelated/);
    assert.doesNotMatch(o, /tickets/);
    assert.match(o, /2 repos, 1 with findings/);
    assert.match(o, /gsdt-start \/ gsdt-init/);
    assert.equal(readFileSync(REG, 'utf8'), '');
  });

  it('--json: [{repo, path, findings:[codes]}]', () => {
    writeFileSync(REG, `${GOOD}\n${GONE}\n`);
    const r = all(['--json', PROJ]);
    const j = JSON.parse(r.stdout) as { repo: string; path: string; findings: string[] }[];
    assert.ok(Array.isArray(j));
    const good = j.find((x) => x.repo === 'good');
    const bad = j.find((x) => x.repo === 'bad');
    assert.deepEqual(good?.findings, []);
    assert.equal(good?.path.replace(/\\/g, '/'), GOOD.replace(/\\/g, '/'));
    assert.ok(bad !== undefined && bad.findings.length > 0 && bad.findings.every((c) => /^[TW]\d{3}$/.test(c)));
    assert.equal(j.length, 2);
  });

  it('--all with --fix is refused', () => {
    const r = all(['--fix']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--all is read-only/);
  });

  it('a folder without --all is an unknown argument', () => {
    const r = gsdt('doctor', [PROJ], { env: env() });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown argument/);
  });
});

describe('the commands add the repo to the registry', () => {
  it('gsdt-init (dedupes on a second run)', () => {
    writeFileSync(REG, '');
    const R = path.join(WORK, 'initme');
    mkrepo(R);
    for (let i = 0; i < 2; i++) gsdt('init', ['--no-launch', '--no-commit'], { env: env(), cwd: R });
    const lines = readFileSync(REG, 'utf8').split('\n').filter((l) => l !== '');
    assert.equal(lines.length, 1, init.out);
    assert.equal(lines[0]?.replace(/\\/g, '/').toLowerCase().endsWith('/initme'), true);
  });

  it('gsdt-bootstrap-repo, from a phase worktree it records the main checkout', () => {
    writeFileSync(REG, '');
    const R = path.join(WORK, 'boot');
    mkrepo(R);
    const wt = path.join(WORK, 'boot-wt');
    gitOk(R, ['worktree', 'add', '-q', '-b', 'phase-1-y', wt]);
    gsdt('bootstrap-repo', ['--agent', 'claude'], { env: env(), cwd: wt });
    const lines = readFileSync(REG, 'utf8').split('\n').filter((l) => l !== '');
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.replace(/\\/g, '/').toLowerCase().endsWith('/boot'), true);
  });

  it('an unwritable registry never fails the command', () => {
    const R = path.join(WORK, 'nowrite');
    mkrepo(R);
    const blocked = path.join(WORK, 'blocked');
    writeFileSync(blocked, 'a file, not a folder');
    const r = gsdt('init', ['--no-launch', '--no-commit'], { env: { ...env(), XDG_CONFIG_HOME: blocked }, cwd: R });
    assert.equal(r.status, 0, r.out + r.stderr);
  });
});

describe('gsdt-repos', () => {
  it('prints what gsdt-doctor --all prints', () => {
    writeFileSync(REG, `${GOOD}\n${BAD}\n${GONE}\n`);
    const a = gsdt('doctor', ['--all'], { env: env() });
    const b = gsdt('repos', [], { env: env() });
    assert.equal(b.status, a.status);
    assert.equal(b.out, a.out);
    const aj = gsdt('doctor', ['--all', '--json', PROJ], { env: env() });
    const bj = gsdt('repos', [PROJ, '--json'], { env: env() });
    assert.equal(bj.stdout, aj.stdout);
  });
  it('--help says it is --all', () => {
    const r = gsdt('repos', ['--help'], { env: env() });
    assert.equal(r.status, 0);
    assert.match(r.out, /gsdt-doctor --all/);
  });

  it('a tracker-only .gsd.conf is not a toolkit repo: no rules hook, guard rule 0 only', () => {
    assert.equal(gsdt('rules', ['--hook'], { env: env(), cwd: TICKETS }).out, '');
    assert.notEqual(gsdt('rules', ['--hook'], { env: env(), cwd: GOOD }).out, '');
    const guard = (skill: string) =>
      gsdt('worktree-guard', ['--global'], { env: env(), cwd: TICKETS, input: JSON.stringify({ tool_name: 'Skill', tool_input: { skill } }) });
    const np = guard('gsd-new-project');
    assert.equal(np.status, 2, np.out + np.stderr);
    assert.match(np.out + np.stderr, /no \.gsd\.conf with GSD settings \(only tracker keys\)/);
    assert.equal(guard('gsd-autonomous').status, 0);
  });

  it('a repo with only warnings (T027): ⚠, counted apart, exit 0', () => {
    write(path.join(GOOD, '.planning', 'phases', '01-one', '01-01-PLAN.md'), 'x\n');
    write(path.join(GOOD, '.planning', 'phases', '01-one', '01-01-SUMMARY.md'), 'x\n');
    writeFileSync(REG, `${GOOD}\n`);
    const r = gsdt('repos', [], { env: env() });
    const o = strip(r.out);
    assert.equal(r.status, 0, o);
    assert.match(o, /⚠ good\s+1 warning: T027/);
    assert.match(o, /1 repo, 0 with findings, 1 with warnings only/);
    const j = JSON.parse(gsdt('repos', ['--json'], { env: env() }).stdout) as { findings: string[]; warnings: string[] }[];
    assert.deepEqual(j[0]?.warnings, ['T027']);
    assert.deepEqual(j[0]?.findings, []);
  });
});
