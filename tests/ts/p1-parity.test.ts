// P1 parity: src/common.ts and src/provider.ts against lib/common.sh and
// lib/provider.sh, on the same inputs. Run: node --test tests/ts/
// A failing case means the TS differs from bash — fix the TS (or, if bash is
// wrong, keep parity and say so in docs/ts-port-progress.md).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import * as C from '../../src/common.ts';
import * as P from '../../src/provider.ts';
import { main as rulesMain, rulesFor } from '../../src/commands/rules.ts';
import { PKG, bash, chomp, repo, sh, tmp, withEnv, write } from './helpers.ts';

const same = (label: string, bashScript: string, args: string[], ts: string, opts: { raw?: boolean } = {}): void => {
  const r = bash(bashScript, args);
  assert.equal(opts.raw ? ts : chomp(ts), opts.raw ? r.out : chomp(r.out), label);
};

// ── conf, base, wtdir, flow, providers, main ────────────────────────────────

test('confGet / providers / base / wtdir / flowMode', () => {
  const confs: string[] = [
    '',
    'base = develop\n',
    '  base   =   main   # the base\nwtdir=wt-x\nflow = strict\n',
    'providers = codex,claude # two\nprovider = claude\n',
    'provider = codex\n',
    'base=\nbase = second\n',
    'base = a#b\r\nflow = strict  \r\n',
    'basement = nope\nbase\t=\tfoo\tbar\n',
    '# base = commented\n',
    'flow = strict',
    'test = make check\ninstall = none\ncompact_at = 200000\n',
    'flow = off\nwtdir =\n',
  ];
  for (const conf of confs) {
    const r = repo(path.join(tmp(), 'my repo'), conf);
    for (const key of ['base', 'wtdir', 'flow', 'providers', 'provider', 'test', 'install', 'compact_at', 'nothere']) {
      same(`confGet ${key} for ${JSON.stringify(conf)}`, 'gsd_conf_get "$1" "$2"', [r, key], C.confGet(r, key));
    }
    same('base', 'gsd_base "$1"', [r], C.base(r));
    same('flowMode', 'gsd_flow_mode "$1"', [r], C.flowMode(r));
    same('confProviders', 'gsd_conf_providers "$1"', [r], C.confProviders(r));
    same('wtdir', 'gsd_wtdir "$1"', [r], C.wtdir(r));
  }
  assert.equal(C.confGet('/nonexistent-dir', 'base'), '');
  same('wtdir of a trailing slash', 'gsd_wtdir "$1"', ['/a/b/'], C.wtdir('/a/b/'));
});

test('base: develop / main / current branch', () => {
  const r = repo(path.join(tmp(), 'b'));
  sh(r, 'git', ['branch', '-m', 'trunk']);
  same('current branch', 'gsd_base "$1"', [r], C.base(r));
  sh(r, 'git', ['branch', 'main']);
  same('main', 'gsd_base "$1"', [r], C.base(r));
  sh(r, 'git', ['branch', 'develop']);
  same('develop', 'gsd_base "$1"', [r], C.base(r));
});

test('findMain from the main checkout, a worktree and outside git', () => {
  const r = repo(path.join(tmp(), 'main repo'));
  const wt = path.join(path.dirname(r), 'wt dir');
  sh(r, 'git', ['worktree', 'add', '-q', wt, '-b', 'phase-1-a']);
  for (const p of [r, wt, path.join(r, '.git'), tmp(), '/nonexistent']) {
    same(`main ${p}`, 'gsd_main "$1"', [p], C.findMain(p));
  }
  same('main of no arg', 'cd "$1" && gsd_main', [wt], withCwd(wt, () => C.findMain()));
});

function withCwd<T>(d: string, fn: () => T): T {
  const old = process.cwd();
  process.chdir(d);
  try {
    return fn();
  } finally {
    process.chdir(old);
  }
}

// ── reviews / validation ────────────────────────────────────────────────────

test('reviewsProblem', () => {
  const dir = tmp();
  const fixtures: Record<string, string> = {
    empty: '## Codex Review\n\n---\n## Consensus\nok\n',
    limit: '## Codex Review\nYou hit your usage limit, try later\n',
    longQuote: '## Codex Review\nhit your usage limit\n1\n2\n3\n4\n5\n6\n',
    allFailed: '## Codex Review\n\n## Claude Review\nfailed or returned empty\n',
    oneOk: '## Codex Review\nfine review\nmore\n\n## Claude Review\n\n',
    codexOkClaudeBad: '## Codex Review\nlooks fine\n\n## Claude Review\nhit your usage limit\n',
    frontmatter: '---\nreviewers: x\n---\n## Codex Review\nstuff here\n',
    handwritten: '# Reviews\nSome notes with no sections.\n',
    planHeadings: '## Codex Review\n### Summary\n## 07-01\ntext\n## Plan 2\nmore\n---\n## Consensus\n',
    instance: '## Codex Review (gpt-5)\n\nreturned empty content\n',
    crlf: '## Codex Review\r\n\r\nhit your usage limit\r\n',
    ruleThenVerification: '## Codex Review\nok one\n---\n\n## Verification\nnotes\n## Claude Review\n\n',
    onlyHeadings: '## Codex Review\n### a\n---\n## Claude Review\n#### b\n',
    nested: '## Gemini Review\n\n## Codex Review\nreal\n',
    noNewline: '## Codex Review\nlimit hit your usage limit',
    two: '## Codex Review\nok\n## Codex Review\n\n',
    emptyFile: '',
    spaces: '##  Review\nfailed or returned empty\n',
  };
  for (const [name, body] of Object.entries(fixtures)) {
    const f = write(path.join(dir, `${name}-REVIEWS.md`), body);
    for (const prov of ['codex', 'claude', '', 'Codex', 'other']) {
      const r = bash('gsd_reviews_problem "$1" "$2"; echo "rc=$?"', [f, prov]);
      const ts = C.reviewsProblem(f, prov);
      const want = r.out.replace(/\nrc=\d+\n$|^rc=\d+\n$/, '');
      const rc = /rc=(\d+)\n$/.exec(r.out)?.[1];
      assert.equal(rc, ts === null ? '1' : '0', `${name}/${prov} status`);
      assert.equal(ts ?? '', chomp(want), `${name}/${prov} text`);
    }
  }
  assert.equal(C.reviewsProblem(path.join(dir, 'missing.md'), 'codex'), null);
  assert.equal(bash('gsd_reviews_problem "$1" codex; echo $?', [path.join(dir, 'missing.md')]).out, '1\n');
});

test('workflowFlag and validationProblem', () => {
  const co = tmp();
  const pd = path.join(co, '.planning', 'phases', '03-x');
  mkdirSync(pd, { recursive: true });
  const cfgs: (string | null)[] = [
    null,
    '{"workflow":{"nyquist_validation":false}}',
    '{"workflow":{"nyquist_validation":true}}',
    '{"workflow":{"nyquist_validation":"false"}}',
    '{"workflow":[1]}',
    '{"workflow":null}',
    '[1,2]',
    'not json',
    '{}',
  ];
  const vals: (string | null)[] = [
    null,
    '---\nnyquist_compliant: true\n---\nbody\n',
    '---\nnyquist_compliant: false\n---\nbody\n',
    "---\nnyquist_compliant: 'True'  # yes\n---\n",
    '---\r\nnyquist_compliant: true\r\n---\r\n',
    '---\nnyquist_compliant: false\n---\n## Validation Audit\n| a |\n',
    '---\nstatus: x\n---\nnyquist_compliant: true\n',
    'nyquist_compliant: true\n',
    '---\nfoo: 1\n---\n\n---\nnyquist_compliant: "true"\n---\n',
    '---\nnyquist_compliant:true\n',
    '---\nnyquist_compliant:   TRUE\n---\n',
    'no front matter\n## Validation Audit\n',
    '---\nnyquist_compliant: false\n---\n ## Validation Audit\n',
  ];
  for (const cfg of cfgs) {
    const cf = path.join(co, '.planning', 'config.json');
    if (cfg === null) {
      try {
        spawnSync('rm', ['-f', cf]);
      } catch { /* none */ }
    } else write(cf, cfg);
    for (const key of ['nyquist_validation', 'other']) {
      same(`workflowFlag ${key} ${cfg}`, 'gsd_workflow_flag "$1" "$2"', [co, key], C.workflowFlag(co, key));
    }
    for (const v of vals) {
      const f = path.join(pd, '03-VALIDATION.md');
      if (v === null) spawnSync('rm', ['-f', f]);
      else write(f, v);
      const r = bash('gsd_validation_problem "$1" "$2" "$3"; echo "rc=$?"', [pd, '03', co]);
      const ts = C.validationProblem(pd, '03', co);
      assert.equal(/rc=(\d+)\n$/.exec(r.out)?.[1], ts === null ? '1' : '0', `status ${cfg} ${JSON.stringify(v)}`);
      assert.equal(ts ?? '', chomp(r.out.replace(/rc=\d+\n$/, '')), `text ${cfg} ${JSON.stringify(v)}`);
    }
  }
});

// ── phases and branches ─────────────────────────────────────────────────────

test('phaseDir', () => {
  const co = tmp();
  for (const d of ['07-foo', '02.1-bar', '8-baz', '10-ten', '3.2-x']) mkdirSync(path.join(co, '.planning', 'phases', d), { recursive: true });
  const branches = ['phase-7-x', 'phase-07-x', 'phase-2.1-y', 'phase-8-z', 'phase-08-z', 'phase-9-q', 'phase-10-t', 'phase-3.2-a', 'phase-x-y', 'main', '', 'phase-7', 'phase-007-q'];
  for (const b of branches) {
    const r = bash('gsd_phase_dir "$1" "$2"; echo "rc=$? PD=$GSD_PD P=$GSD_P N=$GSD_N"', [co, b]);
    const ts = C.phaseDir(co, b);
    const m = /rc=(\d+) PD=(.*) P=(.*) N=(.*)\n$/.exec(r.out);
    assert.ok(m, `parse ${b}`);
    assert.equal(m[1], ts === null ? '1' : '0', `rc ${b}`);
    if (ts) assert.deepEqual([m[2], m[3], m[4]], [ts.pd, ts.p, ts.n], `values ${b}`);
    else assert.equal(m[2], '', `PD empty ${b}`);
  }
  const r = bash('gsd_phase_dir "$1" phase-7-x; echo $?', [path.join(co, 'nope')]);
  assert.equal(r.out, '1\n');
  assert.equal(C.phaseDir(path.join(co, 'nope'), 'phase-7-x'), null);
});

test('phaseBranch / isPrHelper / originLacks', () => {
  const r = repo(path.join(tmp(), 'pb'));
  for (const b of ['phase-7-a', 'phase-7-a-pr', 'phase-7-b-pr', 'phase-8-improve-pr', 'phase-8-improve-pr-pr', 'phase-70-z', 'phase-7.1-q', 'other']) {
    sh(r, 'git', ['branch', b]);
  }
  for (const n of ['7', '8', '70', '7.1', '9', '']) {
    same(`phaseBranch ${n}`, 'gsd_phase_branch "$1" "$2"', [r, n], C.phaseBranch(r, n));
  }
  for (const b of ['phase-7-a-pr', 'phase-7-a', 'phase-7-b-pr', 'phase-8-improve-pr', 'phase-8-improve-pr-pr', 'x-pr', 'develop']) {
    const bs = bash('gsd_is_pr_helper "$1" "$2"; echo $?', [r, b]).out.trim();
    assert.equal(C.isPrHelper(r, b) ? '0' : '1', bs, `isPrHelper ${b}`);
  }
  // originLacks: an origin that answers (bare repo) with and without the branch, and a dead origin
  const bare = path.join(tmp(), 'origin.git');
  sh(tmp(), 'git', ['init', '-q', '--bare', bare]);
  sh(r, 'git', ['remote', 'add', 'origin', bare]);
  sh(r, 'git', ['push', '-q', 'origin', 'develop']);
  for (const b of ['develop', 'nope']) {
    assert.equal(C.originLacks(r, b) ? '0' : '1', bash('gsd_origin_lacks "$1" "$2"; echo $?', [r, b]).out.trim(), `originLacks ${b}`);
  }
  sh(r, 'git', ['remote', 'set-url', 'origin', '/nonexistent/origin']);
  assert.equal(C.originLacks(r, 'develop') ? '0' : '1', bash('gsd_origin_lacks "$1" develop; echo $?', [r]).out.trim(), 'dead origin');
});

// ── finish gates ────────────────────────────────────────────────────────────

test('flowFinishGate / finishGates / gateTree', () => {
  for (const flow of ['strict', 'off']) {
    for (const wtExists of [true, false]) {
      for (const skip of [undefined, '1']) {
        const r = repo(path.join(tmp(), 'g'), `flow = ${flow}\nui_gates = off\n`);
        const wt = path.join(path.dirname(r), 'g-wt');
        sh(r, 'git', ['worktree', 'add', '-q', wt, '-b', 'phase-3-x']);
        const pd = path.join(wt, '.planning', 'phases', '03-x');
        mkdirSync(pd, { recursive: true });
        writeFileSync(path.join(pd, '03-CONTEXT.md'), 'x\n');
        sh(wt, 'git', ['add', '-A']);
        sh(wt, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'ctx']);
        if (!wtExists) sh(r, 'git', ['worktree', 'remove', '--force', wt]);
        const arg = wtExists ? wt : path.join(path.dirname(r), 'gone');
        withEnv({ GSD_SKIP_GUARD: skip }, () => {
          const b1 = bash('gsd_flow_finish_gate "$1" "$2" "$3"; echo "rc=$?"', [r, 'phase-3-x', arg]);
          const t1 = C.flowFinishGate(r, 'phase-3-x', arg);
          assert.equal(t1.ok ? '0' : '1', /rc=(\d+)/.exec(b1.err + b1.out)?.[1], `flow gate rc ${flow} ${wtExists} ${skip}`);
          assert.equal(t1.stderr, b1.err, 'flow gate stderr');
          const b2 = bash('gsd_finish_gates "$1" "$2" "$3"; echo "rc=$?"', [r, 'phase-3-x', arg]);
          const t2 = C.finishGates(r, 'phase-3-x', arg);
          assert.equal(t2.ok ? '0' : '1', /rc=(\d+)/.exec(b2.out)?.[1], `finishGates rc ${flow} ${wtExists} ${skip}`);
          assert.equal(t2.stderr, b2.err.replace(/rc=\d+\n$/, ''), 'finishGates stderr');
        });
      }
    }
  }
  // gateTree: existing dir → itself; missing → throwaway checkout; bad branch → not ok
  const r = repo(path.join(tmp(), 'gt'));
  const g1 = C.gateTree(r, 'develop', r);
  assert.deepEqual(g1, { ok: true, wt: r, tmp: '' });
  const g2 = C.gateTree(r, 'develop', '/nonexistent/wt');
  assert.ok(g2.ok && g2.tmp !== '' && existsSync(path.join(g2.wt, '.git')));
  C.gateTreeDone(r, g2);
  assert.ok(!existsSync(g2.tmp));
  const g3 = C.gateTree(r, 'no-such-branch', '/nonexistent/wt');
  assert.equal(g3.ok, false);
  assert.equal(g3.wt, '/nonexistent/wt');
});

// ── gsd_cli, python, skills ─────────────────────────────────────────────────

test('cli / cliMissing / python', () => {
  const d = tmp();
  const good = write(path.join(d, 'good'), '#!/bin/sh\necho \'{"packageName":"@opengsd/gsd-core"}\'\n', 0o755);
  const spaced = write(path.join(d, 'spaced'), '#!/bin/sh\necho \'{"packageName": "@opengsd/gsd-core"}\'\n', 0o755);
  const other = write(path.join(d, 'other'), '#!/bin/sh\necho \'{"packageName":"gsd-tools"}\'\n', 0o755);
  const failing = write(path.join(d, 'failing'), '#!/bin/sh\nexit 3\n', 0o755);
  const notexec = write(path.join(d, 'notexec'), '#!/bin/sh\necho x\n', 0o644);
  for (const c of [good, spaced, other, failing, notexec, path.join(d, 'missing'), '']) {
    withEnv({ GSD_CLI: c, CLAUDE_CONFIG_DIR: path.join(d, 'cc'), CODEX_HOME: path.join(d, 'cx') }, () => {
      const r = bash('gsd_cli; echo "rc=$?"');
      assert.equal(C.cli() ?? '', chomp(r.out.replace(/rc=\d+\n$/, '')), `cli ${c}`);
      assert.equal(C.cli() === null ? '1' : '0', /rc=(\d+)/.exec(r.out)?.[1]);
    });
  }
  mkdirSync(path.join(d, 'cc', 'gsd-core', 'bin'), { recursive: true });
  write(path.join(d, 'cc', 'gsd-core', 'bin', 'gsd_run'), '#!/bin/sh\necho \'{"packageName":"@opengsd/gsd-core"}\'\n', 0o755);
  withEnv({ GSD_CLI: undefined, CLAUDE_CONFIG_DIR: path.join(d, 'cc'), PATH: '/usr/bin:/bin' }, () => {
    assert.equal(C.cli(), bash('gsd_cli').out.trim());
    assert.ok(C.cli()?.endsWith('cc/gsd-core/bin/gsd_run'));
  });
  same('cliMissing', 'gsd_cli_missing', [], C.cliMissing());
  withEnv({ GSD_PYTHON: undefined }, () => assert.equal(C.python(), bash('gsd_python').out.trim()));
  withEnv({ GSD_PYTHON: 'my-python' }, () => assert.equal(C.python(), 'my-python'));
});

test('skillOwned / skillDiffers', () => {
  const root = tmp();
  const mk = (name: string, files: Record<string, string>): string => {
    const d = path.join(root, name);
    mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) write(path.join(d, f), c);
    return d;
  };
  const src = mk('src', { 'SKILL.md': '# S\nbody\n', 'a.txt': 'A', 'sub/b.txt': 'B' });
  const dests = [
    mk('same', { 'SKILL.md': '# S\nbody\n<!-- gsd-toolkit-skill 1.0 -->\n', 'a.txt': 'A', 'sub/b.txt': 'B' }),
    mk('oldmark', { 'SKILL.md': '# S\nbody\n<!-- gsd-worktrees-skill 0.7 -->\n', 'a.txt': 'A', 'sub/b.txt': 'B' }),
    mk('nomark', { 'SKILL.md': '# S\nbody\n', 'a.txt': 'A', 'sub/b.txt': 'B' }),
    mk('changedfile', { 'SKILL.md': '# S\nbody\n<!-- gsd-toolkit-skill 1.0 -->\n', 'a.txt': 'CHANGED', 'sub/b.txt': 'B' }),
    mk('extrafile', { 'SKILL.md': '# S\nbody\n<!-- gsd-toolkit-skill 1.0 -->\n', 'a.txt': 'A', 'sub/b.txt': 'B', 'c.txt': 'C' }),
    mk('missingfile', { 'SKILL.md': '# S\nbody\n<!-- gsd-toolkit-skill 1.0 -->\n', 'a.txt': 'A' }),
    mk('changedskill', { 'SKILL.md': '# S\nOTHER\n<!-- gsd-toolkit-skill 1.0 -->\n', 'a.txt': 'A', 'sub/b.txt': 'B' }),
    mk('oldfile', { 'SKILL.md': '# S\nbody\n', 'a.txt': 'A', 'sub/b.txt': 'B', '.gsd-worktrees-skill': '' }),
    mk('nomd', { 'a.txt': 'A', 'sub/b.txt': 'B' }),
    mk('nonl', { 'SKILL.md': '# S\nbody', 'a.txt': 'A', 'sub/b.txt': 'B' }),
    path.join(root, 'absent'),
  ];
  for (const d of dests) {
    assert.equal(C.skillOwned(d), bash('gsd_skill_owned "$1"; echo $?', [d]).out.trim() === '0', `owned ${path.basename(d)}`);
    for (const s of [src, `${src}/`]) {
      assert.equal(C.skillDiffers(s, d), bash('gsd_skill_differs "$1" "$2"; echo $?', [s, d]).out.trim() === '0', `differs ${path.basename(d)}`);
    }
  }
});

// ── baseRef ─────────────────────────────────────────────────────────────────

test('baseref / baserefEnsure', () => {
  const settings: (string | null)[] = [
    null,
    '{}',
    '{"worktree":{"baseRef":"head"}}',
    '{"worktree":{"baseRef":"origin"}}',
    '{"worktree":"x"}',
    'not json',
    '[1]',
    '{"a":1,"worktree":{"other":true}}',
  ];
  for (const s of settings) {
    for (const ignored of [true, false]) {
      const mkRepo = (): string => {
        const r = repo(path.join(tmp(), 'br'));
        if (ignored) write(path.join(r, '.gitignore'), '.claude/settings.local.json\n');
        if (s !== null) write(path.join(r, '.claude', 'settings.local.json'), s);
        return r;
      };
      const a = mkRepo();
      const b = mkRepo();
      const cc = tmp();
      withEnv({ CLAUDE_CONFIG_DIR: cc }, () => {
        for (const mode of ['check', 'ensure'] as const) {
          const x = chomp(bash('gsd_baseref "$1" "$2"', [mode, a]).out);
          const y = C.baseref(mode, b);
          assert.equal(y, x, `baseref ${mode} ${s} ignored=${ignored}`);
          const fa = existsSync(path.join(a, '.claude', 'settings.local.json')) ? readFileSync(path.join(a, '.claude', 'settings.local.json'), 'utf8') : null;
          const fb = existsSync(path.join(b, '.claude', 'settings.local.json')) ? readFileSync(path.join(b, '.claude', 'settings.local.json'), 'utf8') : null;
          assert.equal(fb, fa, `file after ${mode}`);
        }
        const a2 = mkRepo();
        const b2 = mkRepo();
        const x = chomp(bash('gsd_baseref_ensure "$1" lbl', [a2]).out);
        assert.equal(C.baserefEnsure(b2, 'lbl'), x, 'baserefEnsure');
        assert.equal(C.baserefEnsure(b2), chomp(bash('gsd_baseref_ensure "$1"', [b2]).out).replace(a2, b2), 'default label');
      });
    }
  }
  // a tracked local file
  const t = repo(path.join(tmp(), 'tr'));
  write(path.join(t, '.claude', 'settings.local.json'), '{}');
  sh(t, 'git', ['add', '-f', '-A']);
  sh(t, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x']);
  assert.equal(C.baseref('ensure', t), chomp(bash('gsd_baseref ensure "$1"', [t]).out));
  assert.equal(C.baseref('ensure', t), 'tracked');
  // the user layer decides
  const u = repo(path.join(tmp(), 'ul'));
  const cc = tmp();
  write(path.join(cc, 'settings.json'), '{"worktree":{"baseRef":"main"}}');
  withEnv({ CLAUDE_CONFIG_DIR: cc }, () => {
    assert.equal(C.baseref('check', u), chomp(bash('gsd_baseref check "$1"', [u]).out));
    assert.equal(C.baseref('check', u), 'other:main');
  });
});

// ── planning hook / status / apply ──────────────────────────────────────────

function stubBin(): string {
  const d = tmp();
  write(path.join(d, 'gsdt-planning-merge'), '#!/bin/sh\nexit 0\n', 0o755);
  return d;
}

test('planningHook / planningStatus', () => {
  const variants: Array<(r: string) => void> = [
    () => {},
    (r) => mkdirSync(path.join(r, '.husky'), { recursive: true }),
    (r) => sh(r, 'git', ['config', 'core.hooksPath', 'scripts/git-hooks']),
    (r) => sh(r, 'git', ['config', 'core.hooksPath', '/tmp/outside-hooks']),
    (r) => write(path.join(r, '.gitattributes'), '.planning/ROADMAP.md merge=union\n.planning/STATE.md merge=union\n'),
    (r) => write(path.join(r, '.gitattributes'), '.planning/ROADMAP.md merge=gsd-planning\n.planning/STATE.md merge=gsd-planning  \n'),
    (r) => write(path.join(r, '.gitattributes'), '.planning/ROADMAP.md merge=gsd-planning\n'),
    (r) => {
      write(path.join(r, '.git', 'hooks', 'post-merge'), '#!/bin/sh\ngsdt-planning-repair\n', 0o755);
      sh(r, 'git', ['config', 'merge.gsd-planning.driver', 'gsdt-planning-merge %O %A %B %P']);
    },
    (r) => write(path.join(r, '.git', 'hooks', 'post-merge'), '#!/bin/sh\ngsdt-planning-repair\n', 0o644),
  ];
  for (const [i, v] of variants.entries()) {
    const r = repo(path.join(tmp(), 'pl'));
    v(r);
    const b = bash(
      'gsd_planning_status "$1"; gsd_planning_hook "$1"; echo "$GSD_PLANNING_MISSING|$GSD_ATTRS_STATE|$GSD_HOOK_PATH|$GSD_HOOK_LABEL|$GSD_HOOK_VERSIONED"',
      [r],
    );
    const s = C.planningStatus(r);
    assert.equal(`${s.missing.join(' ')}|${s.attrsState}|${s.hook.path}|${s.hook.label}|${s.hook.versioned ? 1 : 0}`, chomp(b.out), `variant ${i}`);
  }
  // fresh vs set up
  const f = repo(path.join(tmp(), 'fresh'));
  assert.deepEqual(C.planningStatus(f).missing, ['attributes', 'driver', 'hook']);
});

test('planningApply writes the same files and lines', () => {
  const stub = stubBin();
  const hookV: Array<string | null> = [
    null,
    '#!/bin/sh\necho mine\n',
    '#!/bin/sh\ncommand -v gsd-planning-repair >/dev/null 2>&1 || exit 0\ngsd-planning-repair || true\n# gsd-bootstrap-repo x\n',
    '#!/bin/sh\ngsdt-planning-repair\n',
    '#!/bin/sh\necho no trailing newline',
  ];
  const attrV: Array<string | null> = [
    null,
    '.planning/ROADMAP.md merge=union\n.planning/STATE.md merge=union\n',
    '*.png binary',
    '.planning/ROADMAP.md merge=union   \n.planning/STATE.md\tmerge=union\n*.x y\n',
    '.planning/ROADMAP.md merge=gsd-planning\n',
  ];
  for (const hv of hookV) {
    for (const av of attrV) {
      for (const husky of [false, true]) {
        const mk = (): string => {
          const r = repo(path.join(tmp(), 'ap'));
          if (husky) mkdirSync(path.join(r, '.husky'), { recursive: true });
          if (av !== null) write(path.join(r, '.gitattributes'), av);
          if (hv !== null) write(path.join(husky ? path.join(r, '.husky') : path.join(r, '.git', 'hooks'), 'post-merge'), hv, 0o644);
          return r;
        };
        const a = mk();
        const b = mk();
        const bo = bash('gsd_planning_apply "$1"', [a], { PATH: `${stub}:${process.env.PATH}` });
        const lines = withEnv({ PATH: `${stub}:${process.env.PATH}` }, () => C.planningApply(b));
        const tag = `hook=${JSON.stringify(hv)} attr=${JSON.stringify(av)} husky=${husky}`;
        assert.equal(lines.map((l) => `${l}\n`).join(''), bo.out, `lines ${tag}`);
        const rd = (r: string, rel: string): string | null => (existsSync(path.join(r, rel)) ? readFileSync(path.join(r, rel), 'latin1') : null);
        for (const rel of ['.gitattributes', '.git/hooks/post-merge', '.husky/post-merge']) assert.equal(rd(b, rel), rd(a, rel), `${rel} ${tag}`);
        for (const rel of ['.git/hooks/post-merge', '.husky/post-merge']) {
          if (existsSync(path.join(a, rel))) assert.equal(statSync(path.join(b, rel)).mode & 0o777, statSync(path.join(a, rel)).mode & 0o777, `mode ${rel} ${tag}`);
        }
        for (const k of ['merge.gsd-planning.driver', 'merge.gsd-planning.name']) {
          assert.equal(sh(b, 'git', ['config', '--get', k]), sh(a, 'git', ['config', '--get', k]), `${k} ${tag}`);
        }
        // (bash bugs, kept: `echo >>` glues its line onto a .gitattributes with no final newline; a TAB-separated STATE line is not recognised after the rename, so a third line is appended)
        if (av === null || (av.endsWith('\n') && !av.includes('\t'))) assert.deepEqual(C.planningStatus(b).missing, [], `all installed ${tag}`);
      }
    }
  }
  // no gsdt-planning-merge on PATH: the same warning
  const a = repo(path.join(tmp(), 'nodrv'));
  const b = repo(path.join(tmp(), 'nodrv'));
  const emptyBin = tmp();
  const bo = bash('gsd_planning_apply "$1"', [a], { PATH: `${emptyBin}:/usr/bin:/bin` });
  const lines = withEnv({ PATH: `${emptyBin}:/usr/bin:/bin` }, () => C.planningApply(b));
  assert.equal(lines.map((l) => `${l}\n`).join(''), bo.out);
  assert.ok(lines.some((l) => l.startsWith('⚠ could not register the merge driver')));
});

test('registerMergeDriver', () => {
  const stub = stubBin();
  for (const withStub of [true, false]) {
    const a = repo(path.join(tmp(), 'rm'));
    const b = repo(path.join(tmp(), 'rm'));
    const PATHV = withStub ? `${stub}:${process.env.PATH}` : `${tmp()}:/usr/bin:/bin`;
    const rc = bash('gsd_register_merge_driver "$1"; echo $?', [a], { PATH: PATHV }).out.trim();
    const ok = withEnv({ PATH: PATHV }, () => C.registerMergeDriver(b));
    assert.equal(ok ? '0' : '1', rc);
    assert.equal(sh(b, 'git', ['config', '--get', 'merge.gsd-planning.driver']), sh(a, 'git', ['config', '--get', 'merge.gsd-planning.driver']));
    withEnv({ PATH: PATHV }, () => assert.equal(C.registerMergeDriver(b), true)); // idempotent
  }
});

// ── migration ───────────────────────────────────────────────────────────────

test('migrateNeeded / migrateRefuse', () => {
  const variants: Array<(r: string) => void> = [
    () => {},
    (r) => write(path.join(r, 'scripts/gsd-derive-port.sh'), 'x'),
    (r) => write(path.join(r, 'scripts/gsd-premerge-check.sh'), 'x'),
    (r) => write(path.join(r, 'scripts/hooks/gsd-worktree-guard.sh'), 'x'),
    (r) => write(path.join(r, '.claude/settings.json'), '{"command":"$CLAUDE_PROJECT_DIR/scripts/hooks/gsd-worktree-guard.sh"}'),
    (r) => write(path.join(r, '.claude/settings.json'), '{"command":"scripts/hooks/gsdt-worktree-guard.sh"}'),
    (r) => sh(r, 'git', ['config', 'merge.gsd-planning.driver', 'gsd-planning-merge %O %A %B %P']),
    (r) => sh(r, 'git', ['config', 'merge.gsd-planning.driver', 'gsdt-planning-merge %O %A %B %P']),
    (r) => sh(r, 'git', ['config', 'gsd-tracker.profile', 'x']),
    (r) => sh(r, 'git', ['config', 'gsdt-tracker.profile', 'x']),
  ];
  for (const [i, v] of variants.entries()) {
    const r = repo(path.join(tmp(), 'mg'));
    v(r);
    assert.equal(C.migrateNeeded(r) ? '0' : '1', bash('gsd_migrate_needed "$1"; echo $?', [r]).out.trim(), `needed ${i}`);
    const b = bash('( gsd_migrate_refuse "$1" ); echo "rc=$?"', [r]);
    let rc = 0;
    let msg = '';
    try {
      C.migrateRefuse(r);
    } catch (e) {
      assert.ok(e instanceof C.GsdExit);
      rc = e.code;
      msg = e.message;
    }
    assert.equal(`rc=${rc}\n`, b.out, `refuse rc ${i}`);
    assert.equal(msg, b.err, `refuse message ${i}`);
  }
  C.migrateRefuse(''); // no-op
});

// ── the lock ────────────────────────────────────────────────────────────────

test('lock: same on-disk format as bash (TS holds → bash sees it; stale reclaim both ways)', () => {
  const r = repo(path.join(tmp(), 'lk'));
  const lock = path.join(r, '.git', 'gsd-cmd.lock');
  // TS acquires in a child process (the exit hook must release it)
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import * as C from ${JSON.stringify(path.join(PKG, 'src/common.ts'))};
       import { existsSync, readFileSync } from 'node:fs';
       const ok = C.acquireLock(${JSON.stringify(r)});
       const pid = readFileSync(${JSON.stringify(path.join(lock, 'pid'))}, 'utf8');
       // while held, bash cannot take it
       const { spawnSync } = await import('node:child_process');
       const b = spawnSync('bash', ['-c', '. "$GSD_PKG/lib/common.sh"; gsd__mkdir_excl "$1" && echo free || echo held', '_', ${JSON.stringify(lock)}], { encoding: 'utf8', env: { ...process.env, GSD_PKG: ${JSON.stringify(PKG)} } });
       console.log(JSON.stringify({ ok, pidOk: pid === String(process.pid) + '\\n', bash: b.stdout.trim(), exists: existsSync(${JSON.stringify(lock)}) }));`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').pop() as string), { ok: true, pidOk: true, bash: 'held', exists: true });
  assert.ok(!existsSync(lock), 'released at exit');

  // a lock left by a dead PID is reclaimed by TS
  const dead = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim();
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'pid'), `${dead}\n`);
  const msgs: string[] = [];
  const old = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => (msgs.push(String(s)), true)) as typeof process.stdout.write;
  let ok = false;
  try {
    ok = C.acquireLock(r);
  } finally {
    process.stdout.write = old;
  }
  assert.ok(ok);
  assert.deepEqual(msgs, [`▶ reclaimed stale gsd lock (owner PID ${dead} no longer running)\n`]);
  assert.equal(readFileSync(path.join(lock, 'pid'), 'utf8'), `${process.pid}\n`);
  C.releaseLock();
  assert.ok(!existsSync(lock));

  // and a lock TS left (dead pid) is reclaimed by bash
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'pid'), `${dead}\n`);
  const b = bash('gsd_acquire_lock "$1"; echo "held=$(cat "$GSD_LOCKDIR/pid" | grep -c .)"', [r]);
  assert.match(b.out, /reclaimed stale gsd lock/);
  assert.ok(!existsSync(lock), 'bash released at exit');
  // re-entrant
  withEnvLockHeld(() => assert.equal(C.acquireLock(r), true));
  assert.ok(!existsSync(lock), 'GSD_LOCK_HELD=1 takes nothing');
});
function withEnvLockHeld(fn: () => void): void {
  withEnv({ GSD_LOCK_HELD: '1' }, fn);
}

// ── test / install commands ─────────────────────────────────────────────────

test('testCmd / installCmd', () => {
  const layouts: Array<[string, Record<string, string>, string]> = [
    ['empty', {}, ''],
    ['make', { Makefile: 'all:\n\ttrue\ntest:\n\ttrue\n' }, ''],
    ['make-no-test', { Makefile: 'all:\n\ttrue\n  test:\n' }, ''],
    ['just', { justfile: 'x' }, ''],
    ['Just', { Justfile: 'x' }, ''],
    ['cargo', { 'Cargo.toml': '' }, ''],
    ['go', { 'go.mod': '' }, ''],
    ['npm', { 'package.json': '{"scripts":{"test":"jest"}}' }, ''],
    ['npm-dep', { 'package.json': '{"scripts":{"build":"x"},"dependencies":{"test":"1"}}' }, ''],
    ['npm-multi', { 'package.json': '{\n "name":"x",\n "scripts" : {\n  "a":"b",\n  "test" : "t"\n }\n}' }, ''],
    ['py', { 'pyproject.toml': '' }, ''],
    ['pytest', { 'pytest.ini': '' }, ''],
    ['pnpm', { 'pnpm-lock.yaml': '', 'package.json': '{}' }, ''],
    ['yarn', { 'yarn.lock': '' }, ''],
    ['pkglock', { 'package-lock.json': '' }, ''],
    ['conf-test', { Makefile: 'test:\n' }, 'test = pytest -x\ninstall = uv sync\n'],
    ['conf-none', { Makefile: 'test:\n', 'pnpm-lock.yaml': '' }, 'test = none\ninstall = none\n'],
    ['xcode', { 'App.xcodeproj/project.pbxproj': '' , Makefile: 'test:\n'}, ''],
    ['dot-xcode', { '.xcodeproj/x': '', 'go.mod': '' }, ''],
  ];
  for (const [name, files, conf] of layouts) {
    const r = repo(path.join(tmp(), 'tc'), conf === '' ? undefined : conf);
    for (const [f, c] of Object.entries(files)) write(path.join(r, f), c);
    same(`testCmd ${name}`, 'gsd_test_cmd "$1"', [r], C.testCmd(r));
    same(`installCmd ${name}`, 'gsd_install_cmd "$1"', [r], C.installCmd(r));
    if (files['package.json']) {
      assert.equal(C.npmHasTest(path.join(r, 'package.json')) ? '0' : '1', bash('gsd__npm_has_test "$1"; echo $?', [path.join(r, 'package.json')]).out.trim(), `npmHasTest ${name}`);
    }
  }
  assert.equal(C.npmHasTest('/nonexistent/package.json'), false);
});

// ── provider facts ──────────────────────────────────────────────────────────

test('provider known / gone / default command / instruction file / skill root / review flag / hooks', () => {
  const names = ['claude', 'codex', 'custom', 'gemini', 'nope', ''];
  for (const p of names) {
    assert.equal(P.providerKnown(p) ? '0' : '1', bash('gsd_provider_known "$1"; echo $?', [p]).out.trim(), `known ${p}`);
    assert.equal(P.providerGone(p) ? '0' : '1', bash('gsd_provider_gone "$1"; echo $?', [p]).out.trim(), `gone ${p}`);
    const dc = bash('gsd_provider_default_command "$1"; echo "rc=$?"', [p]);
    const dflt = P.providerDefaultCommand(p);
    assert.equal(dc.out, dflt === null ? 'rc=1\n' : `${dflt === '' ? '' : `${dflt}\n`}rc=0\n`, `default command ${p}`);
    same(`instruction file ${p}`, 'gsd_provider_instruction_file "$1"', [p], P.providerInstructionFile(p));
    same(`native hook ${p}`, 'gsd_provider_native_hook "$1"', [p], P.providerNativeHook(p));
    const rf = bash('gsd_provider_review_flag "$1"; echo "rc=$?"', [p]);
    assert.equal(P.providerReviewFlag(p) === null ? rf.out === 'rc=1\n' : rf.out === `${P.providerReviewFlag(p)}\nrc=0\n`, true, `review flag ${p}: ${rf.out}`);
    const tip = bash('gsd_provider_ui_tip "$1"; echo "rc=$?"', [p]);
    assert.equal(tip.out, P.providerUiTip(p) === null ? 'rc=1\n' : `${P.providerUiTip(p)}\nrc=0\n`, `ui tip ${p}`);
    for (const addon of ['impeccable', 'shadcn-mcp', 'other']) {
      const a = bash('gsd_provider_ui_addon "$1" "$2"; echo "rc=$?"', [p, addon]);
      assert.equal(a.out, P.providerUiAddon(p, addon) === null ? 'rc=1\n' : `${P.providerUiAddon(p, addon)}\nrc=0\n`, `addon ${p} ${addon}`);
    }
    const hm = bash('gsd_provider_hook_metadata "$1"; echo "rc=$? $GSD_HOOK_SETTINGS|$GSD_HOOK_EVENT|$GSD_HOOK_MATCHER|$GSD_HOOK_COMMAND"', [p]);
    const m = P.providerHookMetadata(p);
    assert.equal(hm.out, m === null ? 'rc=1 |||\n' : `rc=0 ${m.settings}|${m.event}|${m.matcher}|${m.command}\n`, `hook metadata ${p}`);
  }
  // skill root / user hook file under env combinations
  const envs: Array<Record<string, string | undefined>> = [
    {},
    { GSD_SKILL_DIR: '/x/skills' },
    { GSD_CLAUDE_SKILL_DIR: '/c/skills', GSD_SKILL_DIR: '/x/skills' },
    { GSD_CODEX_SKILL_DIR: '/cx/skills' },
    { GSD_CLAUDE_SETTINGS: '/s/settings.json', GSD_CODEX_HOOKS: '/h/hooks.json' },
    { CODEX_HOME: '/codex-home' },
    { GSD_CLAUDE_SKILL_DIR: '' },
  ];
  for (const env of envs) {
    withEnv(env, () => {
      for (const p of ['claude', 'codex', 'custom']) {
        for (const home of [undefined, '/h/ome']) {
          const args = home ? [p, home] : [p];
          const b = bash(home ? 'gsd_provider_skill_root "$1" "$2"; echo "rc=$?"' : 'gsd_provider_skill_root "$1"; echo "rc=$?"', args);
          const t = P.providerSkillRoot(p, home);
          assert.equal(b.out, t === null ? 'rc=1\n' : `${t}\nrc=0\n`, `skill root ${p} ${home} ${JSON.stringify(env)}`);
        }
        const u = bash('gsd_provider_user_hook_file "$1"; echo "rc=$?"', [p]);
        const t = P.providerUserHookFile(p);
        assert.equal(u.out, t === null ? 'rc=1\n' : `${t}\nrc=0\n`, `user hook file ${p} ${JSON.stringify(env)}`);
      }
    });
  }
});

test('providerHookState', () => {
  const settings = (hooks: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({ hooks, ...extra });
  const good = { PreToolUse: [{ matcher: 'Skill', hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/scripts/hooks/gsdt-worktree-guard.sh' }] }] };
  const files: Array<string | null> = [
    null,
    settings(good),
    settings(good, { disableAllHooks: true }),
    settings(good, { hooksConfig: { enabled: false } }),
    settings({ PreToolUse: [] }),
    settings({ PreToolUse: 'x' }),
    '[]',
    'garbage',
    settings({ PreToolUse: [{ matcher: 'Skill', disabled: true, hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/scripts/hooks/gsdt-worktree-guard.sh' }] }] }),
    settings({ PreToolUse: [{ matcher: 'Bash', hooks: [] }] }),
    settings({}),
  ];
  for (const f of files) {
    const r = repo(path.join(tmp(), 'hs'));
    if (f !== null) write(path.join(r, '.claude', 'settings.json'), f);
    for (const p of ['claude', 'codex', 'custom']) {
      assert.equal(P.providerHookState(r, p), chomp(bash('gsd_provider_hook_state "$1" "$2"', [r, p]).out), `${p} ${f}`);
    }
  }
  // without jq
  const noJq = tmp();
  const r = repo(path.join(tmp(), 'hs2'));
  write(path.join(r, '.claude', 'settings.json'), settings(good));
  for (const x of ['bash', 'git', 'sed', 'awk', 'cat', 'dirname', 'rm']) {
    const w = spawnSync('sh', ['-c', `command -v ${x}`], { encoding: 'utf8' }).stdout.trim();
    if (w) symlinkSync(w, path.join(noJq, x));
  }
  const b = bash('gsd_provider_hook_state "$1" claude', [r], { PATH: noJq });
  const t = withEnv({ PATH: noJq }, () => P.providerHookState(r, 'claude'));
  assert.equal(t, chomp(b.out));
  assert.equal(t, 'unverified');
});

test('staleHooks / staleHooksNotice', () => {
  const d = tmp();
  const gone = path.join(d, 'gone', 'gsd-hook.js');
  const settingsFile = write(
    path.join(d, 'claude', 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node ${gone}` }, { type: 'command', command: `node ${gone}` }] }] } }),
  );
  const r = repo(path.join(tmp(), 'sh'));
  withEnv({ GSD_CLAUDE_SETTINGS: settingsFile, GSD_CODEX_HOOKS: path.join(d, 'none.json'), GSD_UPDATE_NOTICE: 'always' }, () => {
    for (const arg of ['', r]) {
      const b = bash(arg ? 'gsd_stale_hooks "$1"' : 'gsd_stale_hooks', arg ? [arg] : []);
      assert.equal(P.staleHooks(arg), b.out, `staleHooks ${arg}`);
    }
    const n = bash('gsd_stale_hooks_notice 2>&1 >/dev/null').out;
    assert.equal(P.staleHooksNotice().map((l) => `${l}\n`).join(''), n);
    assert.ok(n.includes('run a file that is gone'));
  });
  withEnv({ GSD_CLAUDE_SETTINGS: settingsFile, GSD_UPDATE_NOTICE: undefined }, () => {
    assert.deepEqual(P.staleHooksNotice(), process.stderr.isTTY ? P.staleHooksNotice() : []);
  });
});

// ── markers and blocks ──────────────────────────────────────────────────────

const MARK_FILES: Record<string, string> = {
  none: 'hello\n',
  ok: 'a\n<!-- gsd-toolkit:provider:start -->\nx\n<!-- gsd-toolkit:provider:end -->\nb\n',
  old: '<!-- gsd-worktrees:provider:start -->\nx\n<!-- gsd-worktrees:provider:end -->\n',
  mixed: '<!-- gsd-worktrees:provider:start -->\nx\n<!-- gsd-toolkit:provider:end -->\n',
  twoStarts: '<!-- gsd-toolkit:provider:start -->\n<!-- gsd-toolkit:provider:start -->\n<!-- gsd-toolkit:provider:end -->\n',
  twoBlocks: '<!-- gsd-toolkit:provider:start -->\na\n<!-- gsd-toolkit:provider:end -->\n<!-- gsd-toolkit:provider:start -->\nb\n<!-- gsd-toolkit:provider:end -->\n',
  noEnd: '<!-- gsd-toolkit:provider:start -->\nx\n',
  endFirst: '<!-- gsd-toolkit:provider:end -->\n<!-- gsd-toolkit:provider:start -->\n',
  indented: '  <!-- gsd-toolkit:provider:start -->\nx\n<!-- gsd-toolkit:provider:end -->\n',
  trailing: '<!-- gsd-toolkit:provider:start --> \nx\n<!-- gsd-toolkit:provider:end -->\n',
  crlf: '<!-- gsd-toolkit:provider:start -->\r\nx\r\n<!-- gsd-toolkit:provider:end -->\r\n',
  otherKind: '<!-- gsd-toolkit:canonical:start -->\nc\n<!-- gsd-toolkit:canonical:end -->\n<!-- gsd-toolkit:provider:start -->\nx\n<!-- gsd-toolkit:provider:end -->\n',
  unicode: '<!-- gsd-toolkit:provider:start -->\n— é ü 日本\n<!-- gsd-toolkit:provider:end -->',
  empty: '',
};

test('ownedMarkersValid / ownedBlockGet', () => {
  const d = tmp();
  for (const [name, body] of Object.entries(MARK_FILES)) {
    const f = write(path.join(d, name), body);
    for (const kind of ['provider', 'canonical']) {
      assert.equal(
        P.ownedMarkersValid(f, kind) ? '0' : '1',
        bash('gsd_owned_markers_valid "$1" "$2"; echo $?', [f, kind]).out.trim(),
        `valid ${name}/${kind}`,
      );
      assert.equal(P.ownedBlockGet(f, kind), bash('gsd_owned_block_get "$1" "$2"', [f, kind]).out, `block ${name}/${kind}`);
    }
  }
  const missing = path.join(d, 'missing');
  assert.equal(P.ownedMarkersValid(missing, 'provider'), true);
  assert.equal(P.ownedBlockGet(missing, 'provider'), '');
});

test('replaceOwnedBlock', () => {
  const d = tmp();
  const blockFile = write(path.join(d, 'block'), '<!-- gsd-toolkit:provider:start -->\nNEW\n<!-- gsd-toolkit:provider:end -->\n');
  for (const [name, body] of Object.entries(MARK_FILES)) {
    for (const mode of [0o644, 0o600, 0o755]) {
      const a = write(path.join(d, `a-${name}-${mode}`), body, mode);
      const b = write(path.join(d, `b-${name}-${mode}`), body, mode);
      const ra = bash('gsd_replace_owned_block "$1" provider "$2"; echo $?', [a, blockFile]).out.trim();
      const rb = P.replaceOwnedBlock(b, 'provider', blockFile);
      assert.equal(rb ? '0' : '1', ra, `rc ${name}`);
      assert.equal(readFileSync(b, 'latin1'), readFileSync(a, 'latin1'), `content ${name}`);
      assert.equal(statSync(b).mode & 0o777, statSync(a).mode & 0o777, `mode ${name} ${mode.toString(8)}`);
    }
  }
  // a file that does not exist: bash creates it empty with mode 0600 (kept for parity)
  const a = path.join(d, 'new-a');
  const b = path.join(d, 'new-b');
  bash('gsd_replace_owned_block "$1" provider "$2"', [a, blockFile]);
  assert.equal(P.replaceOwnedBlock(b, 'provider', blockFile), true);
  assert.equal(readFileSync(b, 'utf8'), readFileSync(a, 'utf8'));
  assert.equal(statSync(b).mode & 0o777, statSync(a).mode & 0o777);
  // a symlinked file is written through
  const real1 = write(path.join(d, 'real1'), MARK_FILES.ok as string);
  const real2 = write(path.join(d, 'real2'), MARK_FILES.ok as string);
  symlinkSync(real1, path.join(d, 'l1'));
  symlinkSync(real2, path.join(d, 'l2'));
  bash('gsd_replace_owned_block "$1" provider "$2"', [path.join(d, 'l1'), blockFile]);
  P.replaceOwnedBlock(path.join(d, 'l2'), 'provider', blockFile);
  assert.equal(readlinkSync(path.join(d, 'l2')), real2);
  assert.equal(readFileSync(real2, 'utf8'), readFileSync(real1, 'utf8'));
  // blocks produced by the real generators, appended to a file with and without a trailing newline
  const entry = write(path.join(d, 'entry'), P.providerEntryBlock('claude,codex'));
  for (const body of ['# Title\ntext', '# Title\ntext\n']) {
    const x = write(path.join(d, 'x'), body);
    const y = write(path.join(d, 'y'), body);
    bash('gsd_replace_owned_block "$1" provider "$2"', [x, entry]);
    P.replaceOwnedBlock(y, 'provider', entry);
    assert.equal(readFileSync(y, 'utf8'), readFileSync(x, 'utf8'));
  }
});

test('instruction members / integrated / commandGuardsActive', () => {
  const mkRepo = (variant: string): string => {
    const r = repo(path.join(tmp(), 'ii'));
    const entry = (m: string): string => P.providerEntryBlock(m);
    const canon = P.canonicalBlock('claude,codex', 'claude', 'develop', 'ii-worktrees');
    if (variant !== 'noinstr') write(path.join(r, '.gsd', 'INSTRUCTIONS.md'), variant === 'badcanon' ? canon.replace('canonical:end', 'canonical:oops') : canon);
    if (variant === 'ok') {
      write(path.join(r, 'CLAUDE.md'), `# x\n${entry('claude')}`);
      write(path.join(r, 'AGENTS.md'), `${entry('claude,codex')}`);
    } else if (variant === 'wrong-member') {
      write(path.join(r, 'CLAUDE.md'), entry('codex'));
      write(path.join(r, 'AGENTS.md'), entry('codex'));
    } else if (variant === 'old-header') {
      write(path.join(r, 'CLAUDE.md'), '<!-- gsd-worktrees:provider:start -->\n## GSD worktrees (claude adapter)\nRead and follow `.gsd/INSTRUCTIONS.md` now\n<!-- gsd-worktrees:provider:end -->\n');
    } else if (variant === 'no-pointer') {
      write(path.join(r, 'CLAUDE.md'), entry('claude').replace('Read and follow `.gsd/INSTRUCTIONS.md`', 'Read the docs'));
    } else if (variant === 'two-lines') {
      write(path.join(r, 'CLAUDE.md'), '<!-- gsd-toolkit:provider:start -->\n## GSD worktrees (claude adapter)\n## GSD worktrees (codex adapter)\nRead and follow `.gsd/INSTRUCTIONS.md`\n<!-- gsd-toolkit:provider:end -->\n');
    } else if (variant === 'bad-markers') {
      write(path.join(r, 'CLAUDE.md'), `${entry('claude')}${entry('claude')}`);
    }
    return r;
  };
  for (const v of ['ok', 'wrong-member', 'old-header', 'no-pointer', 'two-lines', 'bad-markers', 'noinstr', 'badcanon', 'nofile']) {
    const r = mkRepo(v);
    for (const p of ['claude', 'codex', 'custom', 'nope']) {
      assert.equal(
        P.providerInstructionIntegrated(r, p) ? '0' : '1',
        bash('gsd_provider_instruction_integrated "$1" "$2"; echo $?', [r, p]).out.trim(),
        `integrated ${v}/${p}`,
      );
    }
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      const file = path.join(r, f);
      assert.equal(P.providerInstructionMembers(file).map((m) => `${m}\n`).join(''), bash('gsd_provider_instruction_members "$1"', [file]).out, `members ${v}/${f}`);
    }
  }
  // commandGuardsActive
  const pkg = tmp();
  for (const [name, exec, body] of [
    ['gsdt-worktree-guard', true, 'x'],
    ['gsdt-start', true, 'gsdt-worktree-guard --command start\n'],
    ['gsdt-flow-next', true, 'x gsdt-worktree-guard foo --command bar\n'],
  ] as const) write(path.join(pkg, 'bin', name), body, exec ? 0o755 : 0o644);
  assert.equal(P.commandGuardsActive(pkg) ? '0' : '1', bash('gsd_command_guards_active "$1"; echo $?', [pkg]).out.trim());
  chmodSync(path.join(pkg, 'bin', 'gsdt-flow-next'), 0o644);
  assert.equal(P.commandGuardsActive(pkg) ? '0' : '1', bash('gsd_command_guards_active "$1"; echo $?', [pkg]).out.trim());
  chmodSync(path.join(pkg, 'bin', 'gsdt-flow-next'), 0o755);
  write(path.join(pkg, 'bin', 'gsdt-start'), 'no guard here\n', 0o755);
  assert.equal(P.commandGuardsActive(pkg) ? '0' : '1', bash('gsd_command_guards_active "$1"; echo $?', [pkg]).out.trim());
  assert.equal(P.commandGuardsActive(PKG) ? '0' : '1', bash('gsd_command_guards_active "$1"; echo $?', [PKG]).out.trim());
});

// ── the generated text: byte for byte ───────────────────────────────────────

test('rules text, repo values, canonical block, entry block', () => {
  for (const ui of ['on', 'off', '', 'x']) {
    same(`rulesText ${ui}`, ui === '' ? 'gsd_rules_text' : 'gsd_rules_text "$1"', ui === '' ? [] : [ui], ui === '' ? P.rulesText() : P.rulesText(ui), { raw: true });
  }
  const vals: string[][] = [
    ['claude', 'claude', 'develop', 'r-worktrees'],
    ['codex,claude', 'codex', 'main', 'my wt'],
    ['claude', 'claude', 'develop', 'r', 'strict', 'strict'],
    ['claude', 'claude', 'develop', 'r', 'off', ''],
    ['claude', 'claude', 'develop', 'r', 'warn'],
    ['a`b', "c'd", '$x', '日本', 'warn', 'off'],
  ];
  for (const v of vals) {
    const script = `gsd_repo_values ${v.map((_, i) => `"$${i + 1}"`).join(' ')}`;
    same(`repoValues ${v}`, script, v, P.repoValues(v[0] as string, v[1] as string, v[2] as string, v[3] as string, v[4], v[5]), { raw: true });
    same(`canonical ${v}`, 'gsd_canonical_block "$1" "$2" "$3" "$4"', v.slice(0, 4), P.canonicalBlock(v[0] as string, v[1] as string, v[2] as string, v[3] as string), { raw: true });
  }
  for (const m of ['claude', 'codex', 'custom', 'claude,codex', 'codex,custom', 'custom,claude', 'claudex', '']) {
    same(`entry ${m}`, 'gsd_provider_entry_block "$1"', [m], P.providerEntryBlock(m), { raw: true });
  }
});

// ── resolving ───────────────────────────────────────────────────────────────

const resultText = (r: C.Result<unknown>): string => (r.ok ? '' : r.message);

test('providerListValidate / providerValidate', () => {
  for (const l of ['claude', 'claude,codex', 'codex,claude,custom', '', ',claude', 'claude,', 'claude,,codex', 'claude,claude', 'gemini', 'claude,gemini', 'nope', 'claude,nope', 'Claude']) {
    const b = bash('gsd_provider_list_validate "$1"; echo "rc=$?"', [l]);
    const t = P.providerListValidate(l);
    assert.equal(`${t ? `${t.message}\n` : ''}rc=${t ? t.code : 0}\n`, b.err + b.out, `list ${l}`);
  }
  for (const p of ['claude', 'codex', 'custom', 'gemini', 'nope', '']) {
    for (const c of ['', 'my-agent', 'bad cmd', 'tab\tcmd', '/p/a th']) {
      const b = bash('gsd_provider_validate "$1" "$2"; echo "rc=$?"', [p, c]);
      const t = P.providerValidate(p, c);
      assert.equal(`${t ? `${t.message}\n` : ''}rc=${t ? t.code : 0}\n`, b.err + b.out, `validate ${p}/${c}`);
    }
  }
});

test('providerResolve', () => {
  const confs: string[] = [
    '',
    'provider = codex\nagent_command = codex-x\n',
    'provider = claude\nproviders = codex,claude\nagent_command = codex-x\n',
    'providers = claude,codex\nclaude_command = c1\ncodex_command = c2\nagent_command = dflt\n',
    'providers =\n',
    'providers = claude,claude\n',
    'providers = gemini\n',
    'providers = custom\n',
    'providers = custom\ncustom_command = my-agent\n',
    'provider = custom\nagent_command = wrapper\n',
    'providers = nope\n',
  ];
  const envs: Array<{ env: Record<string, string | undefined>; p: string; c: string }> = [
    { env: {}, p: '', c: '' },
    { env: { GSD_PROVIDER: 'codex' }, p: '', c: '' },
    { env: { GSD_PROVIDER: 'codex', GSD_AGENT_COMMAND: 'codex-x' }, p: '', c: '' },
    { env: { GSD_PROVIDER: 'codex', GSD_AGENT_COMMAND: 'codex-x' }, p: 'claude', c: '/tmp/claude-x' },
    { env: {}, p: 'nope', c: '' },
    { env: {}, p: 'custom', c: 'bad command' },
    { env: {}, p: 'custom', c: 'ok-cmd' },
    { env: {}, p: 'gemini', c: '' },
    { env: { GSD_AGENT: 'codex' }, p: '', c: '' },
    { env: { GSD_AGENT: 'my-legacy-agent' }, p: '', c: '' },
    { env: { GSD_AGENT: 'my-legacy-agent', GSD_CUSTOM_COMMAND: 'envc' }, p: '', c: '' },
    { env: { GSD_AGENT: 'gemini' }, p: '', c: '' },
    { env: { GSD_CLAUDE_COMMAND: 'cc', GSD_CODEX_COMMAND: 'cx' }, p: '', c: '' },
    { env: { GSD_CLAUDE_COMMAND: 'cc', GSD_CODEX_COMMAND: 'cx' }, p: 'codex', c: '' },
    { env: { GSD_AGENT_COMMAND: 'generic' }, p: 'claude', c: '' },
  ];
  for (const conf of confs) {
    const r = repo(path.join(tmp(), 'pr'), conf);
    for (const e of envs) {
      withEnv(e.env, () => {
        const b = bash('gsd_provider_resolve "$1" "$2" "$3"; echo "rc=$?|$GSD_PROVIDER_RESOLVED|$GSD_AGENT_COMMAND_RESOLVED"', [r, e.p, e.c]);
        const t = P.providerResolve(r, e.p, e.c);
        const want = t.ok ? `rc=0|${t.value.provider}|${t.value.command}\n` : `rc=${t.code}|`;
        const tag = `${JSON.stringify(conf)} ${JSON.stringify(e)}`;
        if (t.ok) assert.equal(b.out, want, tag);
        else {
          assert.ok(b.out.startsWith(want), `${tag}: ${b.out}`);
          assert.equal(t.message === '' ? b.err : `${t.message}\n`, b.err, `${tag} message`);
        }
      });
    }
  }
});

test('modelValidate / modelResolve / startModeResolve / compactResolve', () => {
  for (const p of ['claude', 'codex', 'custom']) {
    for (const m of ['', 'default', 'opus', 'claude-sonnet-5', '-x', 'a b', 'a\tb', 'a\u0001b', 'x/y:z', 'é']) {
      const b = bash('gsd_model_validate "$1" "$2"; echo "rc=$?"', [p, m]);
      const t = P.modelValidate(p, m);
      assert.equal(`${t ? `${t.message}\n` : ''}rc=${t ? t.code : 0}\n`, b.err + b.out, `model ${p}/${JSON.stringify(m)}`);
    }
  }
  const confs = ['', 'claude_model = opus\ncodex_model = gpt\n', 'claude_model = default\n', 'claude_model = bad model\n', 'custom_model = x\n', 'start_mode = discuss\n', 'start_mode = flow\n', 'start_mode = nope\n', 'compact_at = 200000\n', 'compact_at = default\n', 'compact_at = 99999\n', 'compact_at = 0300000\n', 'compact_at = 1000001\n', 'compact_at = abc\n', 'compact_at = 1000000\n', 'compact_at = 100000\n'];
  const envs: Array<Record<string, string | undefined>> = [{}, { GSD_MODEL: 'sonnet' }, { GSD_CLAUDE_MODEL: 'envopus', GSD_CODEX_MODEL: 'envgpt' }, { GSD_MODEL: 'default' }, { GSD_COMPACT_AT: '150000' }, { GSD_COMPACT_AT: 'default' }, { GSD_COMPACT_AT: 'x' }, { GSD_COMPACT_AT: '' }];
  for (const conf of confs) {
    const r = repo(path.join(tmp(), 'mr'), conf);
    for (const env of envs) {
      withEnv(env, () => {
        const tag = `${JSON.stringify(conf)} ${JSON.stringify(env)}`;
        for (const p of ['claude', 'codex', 'custom']) {
          for (const cli of ['', 'haiku', 'default']) {
            const b = bash('gsd_model_resolve "$1" "$2" "$3"; echo "rc=$?|$GSD_MODEL_RESOLVED"', [r, p, cli]);
            const t = P.modelResolve(r, p, cli);
            assert.equal(b.out, t.ok ? `rc=0|${t.value}\n` : `rc=${t.code}|${b.out.split('|')[1]}`, `model ${p} ${cli} ${tag}`);
            if (!t.ok) assert.equal(`${t.message}\n`, b.err);
          }
        }
        for (const cli of ['', 'discuss', 'flow', 'bad']) {
          const b = bash('gsd_start_mode_resolve "$1" "$2"; echo "rc=$?|$GSD_START_MODE_RESOLVED"', [r, cli]);
          const t = P.startModeResolve(r, cli);
          assert.equal(b.out, t.ok ? `rc=0|${t.value}\n` : `rc=${t.code}|${b.out.split('|')[1]}`, `start ${cli} ${tag}`);
          if (!t.ok) assert.equal(`${t.message}\n`, b.err);
        }
        const b = bash('gsd_compact_resolve "$1"; echo "rc=$?|$GSD_COMPACT_RESOLVED"', [r]);
        const t = P.compactResolve(r);
        assert.equal(b.out, t.ok ? `rc=0|${t.value}\n` : `rc=${t.code}|\n`, `compact ${tag}`);
        if (!t.ok) assert.equal(`${t.message}\n`, b.err);
        assert.equal(resultText(t) === '' || !t.ok, true);
      });
    }
  }
});

test('compactSettings', () => {
  for (const [conf, existing, tokens, envWin] of [
    ['', null, '300000', undefined],
    ['', '{"keep":1,"env":{"A":"b"}}', '250000', undefined],
    ['', '{"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"1"}}', '', undefined],
    ['', '{"env":{"CLAUDE_CODE_AUTO_COMPACT_WINDOW":"1"}}', '300000', '500000'],
    ['', null, '', undefined],
    ['', 'not json', '300000', undefined],
    ['', '[1]', '300000', undefined],
    ['providers = codex\n', null, '300000', undefined],
    ['providers = codex,claude\n', null, '300000', undefined],
  ] as Array<[string, string | null, string, string | undefined]>) {
    for (const ignored of [true, false]) {
      const mk = (): { r: string; wt: string } => {
        const r = repo(path.join(tmp(), 'cs'), conf === '' ? undefined : conf);
        if (ignored) write(path.join(r, '.gitignore'), '.claude/settings.local.json\n');
        if (existing !== null) write(path.join(r, '.claude', 'settings.local.json'), existing);
        return { r, wt: r };
      };
      const a = mk();
      const b = mk();
      withEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: envWin }, () => {
        const bo = bash('gsd_compact_settings "$1" "$2" "$3"', [a.r, a.wt, tokens]);
        const t = P.compactSettings(b.r, b.wt, tokens);
        const tag = `${JSON.stringify([conf, existing, tokens, envWin, ignored])}`;
        assert.equal(t, bo.out.replaceAll(a.r, b.r), `output ${tag}`);
        const f = (x: string): string | null => (existsSync(path.join(x, '.claude', 'settings.local.json')) ? readFileSync(path.join(x, '.claude', 'settings.local.json'), 'utf8') : null);
        assert.equal(f(b.r), f(a.r), `file ${tag}`);
      });
    }
  }
});

// ── prompts, argv, quoting ──────────────────────────────────────────────────

test('providerPrompt', () => {
  for (const p of ['claude', 'codex', 'custom', 'nope']) {
    for (const kind of ['discuss', 'flow', 'batch', 'new', 'ingest', 'nope']) {
      for (const n of ['', '7', '2.1', "fix 'a' \"b\" $x `y` — é"]) {
        same(`prompt ${p}/${kind}/${n}`, 'gsd_provider_prompt "$1" "$2" "$3"', [p, kind, n], P.providerPrompt(p, kind, n));
      }
    }
  }
});

const BASH3 = /version 3\./.test(spawnSync('bash', ['--version'], { encoding: 'utf8' }).stdout);
const AWKWARD = ['', 'plain', 'with space', 'it\'s', 'quote " and $ safe', 'back\\slash', 'new\nline', 'tab\there', '日本語 é ü — dash', '#hash', 'a#b', '~tilde', 'a=b', '*?[]{}', '`$()&;|<>!^,', 'x\u0001y', '/tmp/a b/c', 'trailing\\', '  lead', 'emoji 🎉 ok', '-lead', '\u007fdel'];

test('shellQuote / providerRender / providerArgv', () => {
  for (const s of AWKWARD) {
    // bash >= 4.4 escapes a leading ~ and not `,`; compare under the bash in use
    const b = bash('gsd_shell_quote "$1"', [s]).out;
    // bash 3.2 (macOS) escapes the bytes of characters beyond Latin-1 as octal; bash >= 4 keeps them
    if (BASH3 && /[^\u0000-\u00ff]/.test(s)) {
      assert.ok(!P.shellQuote(s).includes('\\3'), `quote keeps ${JSON.stringify(s)}`);
      continue;
    }
    assert.equal(P.shellQuote(s), b, `quote ${JSON.stringify(s)}`);
  }
  for (const cwd of ['/tmp/a b', '/x', 'rel dir/ü']) {
    for (const argv of [['fake', 'quote " and $ safe'], ['env', 'A=b', 'claude', '/gsdt-flow 7'], ['x']]) {
      same(`render ${cwd} ${argv}`, 'gsd_provider_render "$@"', [cwd, ...argv], P.providerRender(cwd, ...argv));
    }
  }
  for (const p of ['claude', 'codex', 'custom']) {
    for (const model of ['', 'default', 'opus', 'bad model', '-x']) {
      for (const compact of ['', '300000']) {
        for (const envWin of [undefined, '123456']) {
          for (const prompt of AWKWARD) {
            withEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: envWin }, () => {
              const b = bash('gsd_provider_argv "$1" "$2" "$3" "$4" "$5"; rc=$?; printf "%s\\n" "$rc"; printf "%s\\0" "${GSD_LAUNCH_ARGV[@]}"', [p, 'agent-cmd', prompt, model, compact]);
              const t = P.providerArgv(p, 'agent-cmd', prompt, model, compact);
              const rc = b.out.split('\n')[0];
              assert.equal(rc, t.ok ? '0' : String(t.code), `rc ${p} ${model} ${compact}`);
              if (t.ok) {
                const rest = b.out.slice(b.out.indexOf('\n') + 1);
                assert.equal(rest, t.value.map((a) => `${a}\0`).join(''), `argv ${p}/${model}/${compact}/${envWin}/${JSON.stringify(prompt)}`);
              } else {
                assert.equal(`${t.message}\n`, b.err);
              }
            });
          }
        }
      }
    }
  }
});

// ── gsdt-rules (the command) ────────────────────────────────────────────────

test('rules: the command function and the hook', () => {
  const r = repo(path.join(tmp(), 'cmd'), 'providers = codex,claude\nui_gates = strict\nflow = strict\n');
  const out = rulesFor(r, false);
  assert.equal(out.exit, 0);
  assert.ok(out.text.includes('providers = ') === false);
  assert.ok(out.text.includes('Providers: `codex,claude` (default: first, `codex`)'));
  assert.ok(out.text.includes('flow `strict`; ui_gates `strict`.'));
  assert.equal(rulesFor('/nonexistent/dir', false).exit, 2);
  assert.equal(rulesFor('/nonexistent/dir', true).text, '');
  assert.equal(rulesFor(tmp(), true).text, '');
  assert.ok(rulesFor(r, true).text.startsWith('GSD toolkit rules (gsdt-rules, gsd-toolkit '));
  // main(): bad args, help
  const cap = (fn: () => number): { rc: number; out: string; err: string } => {
    const wo = process.stdout.write.bind(process.stdout);
    const we = process.stderr.write.bind(process.stderr);
    let o = '';
    let e = '';
    process.stdout.write = ((s: string) => ((o += s), true)) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => ((e += s), true)) as typeof process.stderr.write;
    try {
      return { rc: fn(), out: o, err: e };
    } finally {
      process.stdout.write = wo;
      process.stderr.write = we;
    }
  };
  assert.equal(cap(() => rulesMain(['--nope'])).rc, 2);
  assert.equal(cap(() => rulesMain(['--repo'])).err, 'gsdt-rules: --repo needs a directory\n');
  assert.equal(cap(() => rulesMain(['--repo', '/nonexistent/x'])).err, 'gsdt-rules: no such directory: /nonexistent/x\n');
  assert.ok(cap(() => rulesMain(['--help'])).out.startsWith('\ngsdt-rules — print the GSD toolkit'));
  // the real launcher, hook mode with piped stdin and a closed stderr
  const h = spawnSync(path.join(PKG, 'bin', 'gsdt-rules'), ['--hook'], { input: 'x'.repeat(200000), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: r } });
  assert.equal(h.status, 0);
  assert.equal(h.stderr, '');
  assert.ok(h.stdout.startsWith('GSD toolkit rules'));
  const h2 = spawnSync(path.join(PKG, 'bin', 'gsdt-rules'), ['--hook'], { input: '{}', encoding: 'utf8', cwd: tmp(), env: { ...process.env, CLAUDE_PROJECT_DIR: undefined as unknown as string } });
  assert.equal(h2.status, 0);
  assert.equal(h2.stdout, '');
  assert.equal(h2.stderr, '');
  // without node on PATH the hook still exits 0, silently
  const noNode = tmp();
  for (const x of ['bash', 'dirname', 'readlink']) {
    const w = spawnSync('sh', ['-c', `command -v ${x}`], { encoding: 'utf8' }).stdout.trim();
    if (w) symlinkSync(w, path.join(noNode, x));
  }
  const h3 = spawnSync('/bin/bash', [path.join(PKG, 'bin', 'gsdt-rules'), '--hook'], { encoding: 'utf8', env: { PATH: noNode } });
  assert.deepEqual([h3.status, h3.stdout, h3.stderr], [0, '', '']);
  const h4 = spawnSync('/bin/bash', [path.join(PKG, 'bin', 'gsdt-rules')], { encoding: 'utf8', env: { PATH: noNode } });
  assert.equal(h4.status, 1);
});
