// The OS suite: the real npm package, installed with `npm install -g` into a
// throwaway prefix and driven black-box through its commands. Runs on
// Linux, macOS and Windows (CI: job os-suite). The bash suites stay the
// Mac+Linux parity oracle; this is what finds the Windows bugs.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import path from 'node:path';
import {
  BIN, GSD_RUN, HOME, PKG, ROOT, SKIP_CLAIM, WIN, addPlanning, cleanup, git, gitOk, gsdt, gsdtStdin,
  installPackage, lf, makeProject, norm, read, worktreeOf, write,
} from './helpers.ts';
import type { Project } from './helpers.ts';

const COMMANDS = Object.keys(JSON.parse(read(path.join(PKG, 'package.json'))).bin as Record<string, string>).sort();

before(() => installPackage());
after(() => cleanup());

describe('the installed package', () => {
  it('ships 22 commands, each a shim in the prefix', () => {
    assert.equal(COMMANDS.length, 22);
    for (const c of COMMANDS) assert.ok(existsSync(path.join(BIN, WIN ? `${c}.cmd` : c)), c);
  });
  for (const c of COMMANDS) {
    it(`${c} --help`, () => {
      const r = gsdt(c, ['--help']);
      assert.doesNotMatch(r.out, /Cannot find module|ERR_/, r.out);
      // the four internal commands may print their usage on any exit code but must not crash
      if (['gsdt-planning-merge', 'gsdt-wt-finish', 'gsdt-derive-port', 'gsdt-worktree-guard'].includes(c)) {
        assert.ok(r.out.trim().length > 0 || r.status === 0, `${c}: ${r.out}`);
      } else {
        assert.equal(r.status, 0, r.out);
        assert.match(r.out, new RegExp(c));
      }
    });
  }
  it('gsdt-derive-port gives a number', () => {
    const r = gsdt('gsdt-derive-port', ['300']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout.trim(), /^\d+$/);
  });
  it('gsdt-rules --hook outside a repo prints nothing', () => {
    const r = gsdt('gsdt-rules', ['--hook']);
    assert.equal(r.status, 0);
    assert.equal(r.out, '');
  });
});

describe('gsdt-setup (temp HOME)', () => {
  it('writes skills and user hooks (forward slashes), and a second run changes nothing', () => {
    write(path.join(HOME, '.claude', 'settings.json'), '{\n  "model": "opus",\n  "n": 1.0\n}\n');
    const r = gsdt('gsdt-setup', ['--agent', 'claude']);
    assert.equal(r.status, 0, r.out);
    assert.ok(existsSync(path.join(HOME, '.claude', 'skills', 'gsdt-flow', 'SKILL.md')), r.out);
    const s = read(path.join(HOME, '.claude', 'settings.json'));
    assert.match(s, /gsdt-worktree-guard/);
    assert.match(s, /gsdt-rules/);
    assert.match(s, /"n": 1\.0/, 'other settings kept');
    const hooks = JSON.stringify(JSON.parse(s).hooks);
    assert.ok(!/\\\\/.test(hooks.replace(/\\\\n|\\\\"/g, '')), `hook commands use forward slashes: ${hooks}`);
    const again = gsdt('gsdt-setup', ['--agent', 'claude']);
    assert.equal(again.status, 0, again.out);
    assert.equal(read(path.join(HOME, '.claude', 'settings.json')), s, 'no duplicate hooks');
  });
});

function journey(label: string, autocrlf: boolean): void {
  describe(`a project, start to finish (${label})`, () => {
    let p: Project;
    let wt: string | null = null;
    let phase = '1';
    const D = (...a: string[]) => path.join(p.main, ...a);
    const phaseDir = (w: string) => path.join(w, '.planning', 'phases');

    before(() => { p = makeProject(`proj-${label.toLowerCase()}`, { autocrlf }); });

    it('gsdt-init --no-launch / gsdt-bootstrap-repo write the repo setup, and re-running is idempotent', () => {
      const r = gsdt('gsdt-init', ['--providers', 'claude', '--provider', 'claude', '--no-launch', '--no-commit'], { cwd: p.main });
      assert.equal(r.status, 0, r.out);
      assert.ok(existsSync(D('.gsd.conf')), r.out);
      assert.ok(existsSync(D('scripts', 'gsdt-finish-worktree-feature.sh')), 'shims');
      assert.match(read(D('.gitattributes')), /merge=gsd-planning/);
      assert.match(read(D('CLAUDE.md')), /gsd-toolkit:provider:start/);
      assert.match(gitOk(p.main, ['config', 'merge.gsd-planning.driver']), /gsdt-planning-merge/);
      gitOk(p.main, ['add', '-A']); gitOk(p.main, ['commit', '-qm', 'gsdt-init']);
      const before = lf(read(D('CLAUDE.md'))) + lf(read(D('.gsd.conf'))) + lf(read(D('.gitattributes')));
      const r2 = gsdt('gsdt-bootstrap-repo', ['--agent', 'claude'], { cwd: p.main });
      assert.equal(r2.status, 0, r2.out);
      const after = lf(read(D('CLAUDE.md'))) + lf(read(D('.gsd.conf'))) + lf(read(D('.gitattributes')));
      assert.equal(after, before, 're-run changes nothing');
      assert.equal(git(p.main, ['status', '--porcelain']).stdout.trim(), '', 'tree still clean after the re-run');
      addPlanning(p);
      gitOk(p.main, ['push', '-q', 'origin', 'main']);
    });

    it('gsdt-doctor (text and --json): no failures on a fresh setup', () => {
      const t = gsdt('gsdt-doctor', [], { cwd: p.main });
      assert.doesNotMatch(t.out, /Cannot find module|Error:/, t.out);
      const j = gsdt('gsdt-doctor', ['--json'], { cwd: p.main });
      const doc = JSON.parse(j.stdout) as unknown;
      const items: Array<Record<string, unknown>> = Array.isArray(doc) ? doc : ((doc as Record<string, unknown>).findings as Array<Record<string, unknown>> ?? []);
      const sev = (i: Record<string, unknown>) => String(i.severity ?? i.level ?? i.status ?? '');
      const code = (i: Record<string, unknown>) => String(i.code ?? '');
      // codes that depend on the machine, not on the toolkit: gsd-core / agent CLIs / update notice
      const machine = new Set(['T001', 'T002', 'T003', 'T009', 'T011', 'T012', 'T024', 'T053', 'T062', 'T064', 'T008']);
      const bad = items.filter((i) => /err|fail|crit/i.test(sev(i)) && !machine.has(code(i)));
      assert.deepEqual(bad.map(code), [], JSON.stringify(bad));
    });

    it('gsdt-rules --hook in the repo prints the rules', () => {
      const r = gsdt('gsdt-rules', ['--hook'], { cwd: p.main });
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /gsdt-start/);
    });

    it('gsdt-list, gsdt-planning-repair --check, gsdt-tracker config, gsdt-migrate --check', () => {
      const l = gsdt('gsdt-list', [], { cwd: p.main });
      assert.equal(l.status, 0, l.out);
      assert.match(l.out, /Product catalog/);
      const rp = gsdt('gsdt-planning-repair', ['--check'], { cwd: p.main });
      assert.equal(rp.status, 0, rp.out);
      const t = gsdt('gsdt-tracker', ['config'], { cwd: p.main });
      assert.equal(t.status, 0, t.out);
      assert.match(t.out, /^tracker=none$/m);
      const m = gsdt('gsdt-migrate', ['--check'], { cwd: p.main });
      assert.equal(m.status, 0, m.out);
    });

    it('gsdt-ui: gates off / warn need no browser', () => {
      const r = gsdt('gsdt-ui', ['--help'], { cwd: p.main });
      assert.equal(r.status, 0, r.out);
      for (const mode of ['off', 'warn']) {
        const conf = lf(read(D('.gsd.conf'))).split('\n').filter((l) => !/^ui_gates\b/.test(l)).join('\n');
        write(D('.gsd.conf'), `${conf.replace(/\n*$/, '\n')}ui_gates = ${mode}\n`);
        const f = gsdt('gsdt-flow-next', ['1', '--repo', p.main], { cwd: p.main });
        assert.doesNotMatch(f.out, /Cannot find module/, f.out);
      }
      gitOk(p.main, ['checkout', '--', '.gsd.conf']);
    });

    it('gsdt-start -p 1 --no-launch makes the worktree phase-1-<slug>', { skip: SKIP_CLAIM }, () => {
      const r = gsdt('gsdt-start', ['-p', phase, '--no-launch'], { cwd: p.main });
      assert.equal(r.status, 0, r.out);
      const list = gitOk(p.main, ['branch', '--list', 'phase-1-*']);
      assert.match(list, /phase-1-product-catalog/);
      wt = worktreeOf(p.main, 'phase-1-product-catalog');
      assert.ok(wt && existsSync(wt), `worktree: ${wt}\n${r.out}`);
    });

    it('gsdt-start -n claims a new phase on origin', { skip: SKIP_CLAIM }, () => {
      const r = gsdt('gsdt-start', ['-n', 'shopping cart', '--no-launch'], { cwd: p.main });
      assert.equal(r.status, 0, r.out);
      const road = gitOk(p.main, ['--git-dir', p.origin, 'show', 'main:.planning/ROADMAP.md']);
      assert.match(road, /^### Phase 2: shopping cart/m);
      assert.ok(worktreeOf(p.main, 'phase-2-shopping-cart'), 'second worktree');
    });

    const hook = (skill: string, args: string) => JSON.stringify({ tool_name: 'Skill', tool_input: { skill, args } });
    it('guard: a planning command in the main checkout is blocked (exit 2), in the worktree allowed', { skip: SKIP_CLAIM }, () => {
      const a = gsdtStdin('gsdt-worktree-guard', [], hook('gsd-discuss-phase', phase), { cwd: p.main, env: { CLAUDE_PROJECT_DIR: p.main } });
      assert.equal(a.status, 2, a.out);
      const b = gsdtStdin('gsdt-worktree-guard', [], hook('gsd-discuss-phase', phase), { cwd: wt!, env: { CLAUDE_PROJECT_DIR: wt! } });
      assert.equal(b.status, 0, b.out);
      const c = gsdtStdin('gsdt-worktree-guard', [], hook('gsd-discuss-phase', '2'), { cwd: wt!, env: { CLAUDE_PROJECT_DIR: wt! } });
      assert.equal(c.status, 2, `another phase's command in phase 1's worktree: ${c.out}`);
    });

    it('gsdt-list shows the phases with their worktrees', { skip: SKIP_CLAIM }, () => {
      const l = gsdt('gsdt-list', [], { cwd: p.main, env: { COLUMNS: '120' } });
      assert.equal(l.status, 0, l.out);
      assert.match(l.out, /Product catalog/);
      assert.match(l.out, /shopping cart/);
    });

    it('gsdt-flow-next in the worktree returns a step', { skip: SKIP_CLAIM }, () => {
      if (autocrlf) assert.match(read(path.join(wt!, 'README.md')), /\r\n/, 'autocrlf: the worktree checkout has CRLF');
      write(path.join(phaseDir(wt!), '01-product-catalog', '.keep'), '');   // what /gsd-discuss-phase creates
      const r = gsdt('gsdt-flow-next', [phase, '--repo', wt!, '--no-ui'], { cwd: wt! });
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /^step=discuss$/m, 'nothing done yet: discuss');
    });

    it('doctor --json still parses after the claims', { skip: SKIP_CLAIM }, () => {
      const j = gsdt('gsdt-doctor', ['--json'], { cwd: p.main });
      assert.doesNotThrow(() => JSON.parse(j.stdout), j.out);
    });

    it('gsdt-finish merges, pushes to origin main, removes the worktree and branch', { skip: SKIP_CLAIM }, () => {
      write(path.join(wt!, 'cart.txt'), 'cart\n');
      write(path.join(phaseDir(wt!), '01-product-catalog', '01-01-SUMMARY.md'), '# summary\n');
      gitOk(wt!, ['add', '-A']); gitOk(wt!, ['commit', '-qm', 'phase work']);
      const r = gsdt('gsdt-finish', [phase], { cwd: p.main });
      assert.equal(r.status, 0, r.out);
      assert.ok(gitOk(p.main, ['--git-dir', p.origin, 'cat-file', '-e', 'main:cart.txt'] ) === '', 'cart.txt on origin');
      assert.ok(!existsSync(wt!), 'worktree removed');
      assert.equal(git(p.main, ['rev-parse', '--verify', '-q', 'refs/heads/phase-1-product-catalog']).status, 1, 'branch removed');
      assert.equal(norm(p.main), norm(gitOk(p.main, ['rev-parse', '--show-toplevel']).trim()));
      assert.equal(gitOk(p.main, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main');
    });

    it('planning files are coherent after finish', { skip: SKIP_CLAIM }, () => {
      gitOk(p.main, ['pull', '-q', '--ff-only']);
      const r = gsdt('gsdt-planning-repair', ['--check'], { cwd: p.main });
      assert.equal(r.status, 0, r.out);
    });

    it('the merge driver: two branches editing ROADMAP.md and STATE.md merge cleanly (git runs gsdt-planning-merge)', () => {
      const m = makeProject(`merge-${label.toLowerCase()}`, { autocrlf });
      gsdt('gsdt-init', ['--providers', 'claude', '--provider', 'claude', '--no-launch', '--no-commit'], { cwd: m.main });
      gitOk(m.main, ['add', '-A']); gitOk(m.main, ['commit', '-qm', 'init']);
      addPlanning(m);
      assert.match(gitOk(m.main, ['config', 'merge.gsd-planning.driver']), /gsdt-planning-merge/);
      const state = path.join(m.main, '.planning', 'STATE.md'), road = path.join(m.main, '.planning', 'ROADMAP.md');
      const sub = (f: string, from: string, to: string) => write(f, lf(read(f)).replace(from, to));
      gitOk(m.main, ['checkout', '-qb', 'side']);
      sub(state, 'Status: Ready to plan', 'Status: Executing');
      write(road, `${lf(read(road))}\n- [ ] **Phase 3: side**\n`);
      gitOk(m.main, ['commit', '-qam', 'side']);
      gitOk(m.main, ['checkout', '-q', 'main']);
      sub(state, 'Status: Ready to plan', 'Status: Verifying');
      write(road, `${lf(read(road))}\n- [ ] **Phase 2: main**\n`);
      gitOk(m.main, ['commit', '-qam', 'main']);
      const r = git(m.main, ['merge', '--no-edit', 'side']);
      assert.equal(r.status, 0, `merge: ${r.out}`);
      const s = lf(read(state));
      assert.equal(s.split('\n').filter((l) => /^Status:/.test(l)).length, 1, 'one Status line');
      assert.match(s, /Status: Executing/, "takes the incoming branch's single value");
      assert.match(s, /## Session Continuity\n\nLast session: 2026-09-25\nStopped at: Project initialized\nResume file: None\n/);
      const rd = lf(read(road));
      assert.match(rd, /Phase 2: main/);
      assert.match(rd, /Phase 3: side/);
      assert.ok(!/^<{7}|^>{7}/m.test(rd + s), 'no conflict markers');
    });
  });
}

journey('LF', false);
journey('CRLF', true);

describe('environment', () => {
  it('real gsd-core is available when required', () => {
    if (process.env.GSD_TEST_REQUIRE_GSD === '1') assert.ok(GSD_RUN, 'gsd_run');
  });
  it('the suite does not touch the real HOME', () => {
    assert.ok(readdirSync(HOME).length >= 0 && norm(HOME).startsWith(norm(ROOT)));
  });
});
