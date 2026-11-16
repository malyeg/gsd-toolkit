// P1: src/common.ts and src/provider.ts against saved goldens in tests/golden/p1-parity/.
// Run: node --test tests/ts/p1-parity.test.ts
// Regenerate with UPDATE_GOLDEN=1 (from the new code only); review a regenerated golden by diff.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { golden, test } from './golden.ts';
import * as C from '../../src/common.ts';
import * as P from '../../src/provider.ts';
import { main as rulesMain, rulesFor } from '../../src/commands/rules.ts';
import { PKG, chomp, repo, sh, tmp, withEnv, write } from './helpers.ts';

// the temp dir spelled one way (macOS: /var/folders vs /private/var/folders), so goldenNorm sees it
const fix = (t: string): string => t.split(realpathSync(tmpdir())).join(tmpdir());
const gold = (text: string, old?: () => string): void => golden(fix(text), old && (() => fix(old())));
const same = (label: string, ts: string, opts: { raw?: boolean } = {}): void => {
  const v = (x: string): string => (opts.raw ? x : chomp(x));
  gold(`# ${label}\n${v(ts)}`);
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
      same(`confGet ${key} for ${JSON.stringify(conf)}`, C.confGet(r, key));
    }
    same('base', C.base(r));
    same('flowMode', C.flowMode(r));
    same('confProviders', C.confProviders(r));
    same('wtdir', C.wtdir(r));
  }
  assert.equal(C.confGet('/nonexistent-dir', 'base'), '');
  same('wtdir of a trailing slash', C.wtdir('/a/b/'));
});

test('base: develop / main / current branch', () => {
  const r = repo(path.join(tmp(), 'b'));
  sh(r, 'git', ['branch', '-m', 'trunk']);
  same('current branch', C.base(r));
  sh(r, 'git', ['branch', 'main']);
  same('main', C.base(r));
  sh(r, 'git', ['branch', 'develop']);
  same('develop', C.base(r));
});

test('findMain from the main checkout, a worktree and outside git', () => {
  const r = repo(path.join(tmp(), 'main repo'));
  const wt = path.join(path.dirname(r), 'wt dir');
  sh(r, 'git', ['worktree', 'add', '-q', wt, '-b', 'phase-1-a']);
  for (const p of [r, wt, path.join(r, '.git'), tmp(), '/nonexistent']) {
    same(`main ${p}`, C.findMain(p));
  }
  same('main of no arg', withCwd(wt, () => C.findMain()));
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
      const ts = C.reviewsProblem(f, prov);
      gold(`# ${name}/${prov}\nrc=${ts === null ? 1 : 0}\n${ts ?? ''}`);
    }
  }
  assert.equal(C.reviewsProblem(path.join(dir, 'missing.md'), 'codex'), null);
  gold('# missing file\n1');
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
      same(`workflowFlag ${key} ${cfg}`, C.workflowFlag(co, key));
    }
    for (const v of vals) {
      const f = path.join(pd, '03-VALIDATION.md');
      if (v === null) spawnSync('rm', ['-f', f]);
      else write(f, v);
      const ts = C.validationProblem(pd, '03', co);
      gold(`# validation ${cfg} ${JSON.stringify(v)}\nrc=${ts === null ? 1 : 0}\n${ts ?? ''}`);
    }
  }
});

// ── phases and branches ─────────────────────────────────────────────────────

test('phaseDir', () => {
  const co = tmp();
  for (const d of ['07-foo', '02.1-bar', '8-baz', '10-ten', '3.2-x']) mkdirSync(path.join(co, '.planning', 'phases', d), { recursive: true });
  const branches = ['phase-7-x', 'phase-07-x', 'phase-2.1-y', 'phase-8-z', 'phase-08-z', 'phase-9-q', 'phase-10-t', 'phase-3.2-a', 'phase-x-y', 'main', '', 'phase-7', 'phase-007-q'];
  for (const b of branches) {
    const ts = C.phaseDir(co, b);
    gold(`# phaseDir ${JSON.stringify(b)}\n${ts ? `rc=0 PD=${ts.pd} P=${ts.p} N=${ts.n}` : 'rc=1'}`);
  }
  gold('# phaseDir no checkout\nrc=1');
  assert.equal(C.phaseDir(path.join(co, 'nope'), 'phase-7-x'), null);
});

test('phaseBranch / isPrHelper / originLacks', () => {
  const r = repo(path.join(tmp(), 'pb'));
  for (const b of ['phase-7-a', 'phase-7-a-pr', 'phase-7-b-pr', 'phase-8-improve-pr', 'phase-8-improve-pr-pr', 'phase-70-z', 'phase-7.1-q', 'other']) {
    sh(r, 'git', ['branch', b]);
  }
  for (const n of ['7', '8', '70', '7.1', '9', '']) {
    same(`phaseBranch ${n}`, C.phaseBranch(r, n));
  }
  for (const b of ['phase-7-a-pr', 'phase-7-a', 'phase-7-b-pr', 'phase-8-improve-pr', 'phase-8-improve-pr-pr', 'x-pr', 'develop']) {
    gold(`# isPrHelper ${b}\n${C.isPrHelper(r, b) ? '0' : '1'}`);
  }
  // originLacks: an origin that answers (bare repo) with and without the branch, and a dead origin
  const bare = path.join(tmp(), 'origin.git');
  sh(tmp(), 'git', ['init', '-q', '--bare', bare]);
  sh(r, 'git', ['remote', 'add', 'origin', bare]);
  sh(r, 'git', ['push', '-q', 'origin', 'develop']);
  for (const b of ['develop', 'nope']) {
    gold(`# originLacks ${b}\n${C.originLacks(r, b) ? '0' : '1'}`);
  }
  sh(r, 'git', ['remote', 'set-url', 'origin', '/nonexistent/origin']);
  gold(`# originLacks dead origin\n${C.originLacks(r, 'develop') ? '0' : '1'}`);
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
          const lbl = `${flow} wtExists=${wtExists} skip=${skip}`;
          const t1 = C.flowFinishGate(r, 'phase-3-x', arg);
          gold(`# flowFinishGate ${lbl}\nrc=${t1.ok ? 0 : 1}\nstderr:\n${t1.stderr}`);
          const t2 = C.finishGates(r, 'phase-3-x', arg);
          gold(`# finishGates ${lbl}\nrc=${t2.ok ? 0 : 1}\nstderr:\n${t2.stderr}`);
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

test('cli / cliMissing', () => {
  const d = tmp();
  const good = write(path.join(d, 'good'), '#!/bin/sh\necho \'{"packageName":"@opengsd/gsd-core"}\'\n', 0o755);
  const spaced = write(path.join(d, 'spaced'), '#!/bin/sh\necho \'{"packageName": "@opengsd/gsd-core"}\'\n', 0o755);
  const other = write(path.join(d, 'other'), '#!/bin/sh\necho \'{"packageName":"gsd-tools"}\'\n', 0o755);
  const failing = write(path.join(d, 'failing'), '#!/bin/sh\nexit 3\n', 0o755);
  const notexec = write(path.join(d, 'notexec'), '#!/bin/sh\necho x\n', 0o644);
  for (const c of [good, spaced, other, failing, notexec, path.join(d, 'missing'), '']) {
    // PATH and HOME pinned: a gsd_run of the machine's own must not be found
    withEnv({ GSD_CLI: c, CLAUDE_CONFIG_DIR: path.join(d, 'cc'), CODEX_HOME: path.join(d, 'cx'), PATH: '/usr/bin:/bin', HOME: d }, () => {
      const t = C.cli();
      gold(`# cli ${c}\nrc=${t === null ? 1 : 0}\n${t ?? ''}`);
    });
  }
  mkdirSync(path.join(d, 'cc', 'gsd-core', 'bin'), { recursive: true });
  write(path.join(d, 'cc', 'gsd-core', 'bin', 'gsd_run'), '#!/bin/sh\necho \'{"packageName":"@opengsd/gsd-core"}\'\n', 0o755);
  withEnv({ GSD_CLI: undefined, CLAUDE_CONFIG_DIR: path.join(d, 'cc'), PATH: '/usr/bin:/bin' }, () => {
    gold(`# cli from CLAUDE_CONFIG_DIR\n${C.cli()}`);
    assert.ok(C.cli()?.endsWith('cc/gsd-core/bin/gsd_run'));
  });
  same('cliMissing', C.cliMissing());
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
    gold(`# owned ${path.basename(d)}\n${C.skillOwned(d)}`);
    for (const s of [src, `${src}/`]) {
      gold(`# differs ${path.basename(d)}\n${C.skillDiffers(s, d)}`);
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
          const y = C.baseref(mode, b);
          const rd = (x: string): string | null => (existsSync(path.join(x, '.claude', 'settings.local.json')) ? readFileSync(path.join(x, '.claude', 'settings.local.json'), 'utf8') : null);
          const lbl = `# baseref ${mode} ${s} ignored=${ignored}`;
          gold(`${lbl}\n${y}\nfile after: ${JSON.stringify(rd(b))}`);
        }
        const a2 = mkRepo();
        const b2 = mkRepo();
        const lbl2 = `# baserefEnsure ${s} ignored=${ignored}`;
        gold(`${lbl2} lbl\n${C.baserefEnsure(b2, 'lbl')}`);
        gold(`${lbl2} default label\n${C.baserefEnsure(b2)}`);
      });
    }
  }
  // a tracked local file
  const t = repo(path.join(tmp(), 'tr'));
  write(path.join(t, '.claude', 'settings.local.json'), '{}');
  sh(t, 'git', ['add', '-f', '-A']);
  sh(t, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x']);
  gold(`# baseref tracked\n${C.baseref('ensure', t)}`);
  assert.equal(C.baseref('ensure', t), 'tracked');
  // the user layer decides
  const u = repo(path.join(tmp(), 'ul'));
  const cc = tmp();
  write(path.join(cc, 'settings.json'), '{"worktree":{"baseRef":"main"}}');
  withEnv({ CLAUDE_CONFIG_DIR: cc }, () => {
    gold(`# baseref user layer\n${C.baseref('check', u)}`);
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
    (r) => sh(r, 'git', ['config', 'core.hooksPath', path.join(tmp(), 'outside-hooks')]),
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
    const s = C.planningStatus(r);
    gold(`# variant ${i}\n${s.missing.join(' ')}|${s.attrsState}|${s.hook.path}|${s.hook.label}|${s.hook.versioned ? 1 : 0}`);
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
        const lines = withEnv({ PATH: `${stub}:${process.env.PATH}` }, () => C.planningApply(b));
        const tag = `hook=${JSON.stringify(hv)} attr=${JSON.stringify(av)} husky=${husky}`;
        const rd = (r: string, rel: string): string | null => (existsSync(path.join(r, rel)) ? readFileSync(path.join(r, rel), 'latin1') : null);
        const snap = (r: string, out: string): string => [
          `# planningApply ${tag}`,
          `output:\n${out}`,
          ...['.gitattributes', '.git/hooks/post-merge', '.husky/post-merge'].map((rel) => `${rel}: ${JSON.stringify(rd(r, rel))}${rel !== '.gitattributes' && existsSync(path.join(r, rel)) ? ` mode ${(statSync(path.join(r, rel)).mode & 0o777).toString(8)}` : ''}`),
          ...['merge.gsd-planning.driver', 'merge.gsd-planning.name'].map((k) => `${k}: ${JSON.stringify(sh(r, 'git', ['config', '--get', k]))}`),
        ].join('\n');
        gold(snap(b, lines.map((l) => `${l}\n`).join('')));
        // (bash bugs, kept: `echo >>` glues its line onto a .gitattributes with no final newline; a TAB-separated STATE line is not recognised after the rename, so a third line is appended)
        if (av === null || (av.endsWith('\n') && !av.includes('\t'))) assert.deepEqual(C.planningStatus(b).missing, [], `all installed ${tag}`);
      }
    }
  }
  // no gsdt-planning-merge on PATH: the same warning
  const a = repo(path.join(tmp(), 'nodrv'));
  const b = repo(path.join(tmp(), 'nodrv'));
  const emptyBin = tmp();
  const lines = withEnv({ PATH: `${emptyBin}:/usr/bin:/bin` }, () => C.planningApply(b));
  gold(`# planningApply without gsdt-planning-merge on PATH\n${lines.map((l) => `${l}\n`).join('')}`);
  assert.ok(lines.some((l) => l.startsWith('⚠ could not register the merge driver')));
});

test('registerMergeDriver', () => {
  const stub = stubBin();
  for (const withStub of [true, false]) {
    const a = repo(path.join(tmp(), 'rm'));
    const b = repo(path.join(tmp(), 'rm'));
    const PATHV = withStub ? `${stub}:${process.env.PATH}` : `${tmp()}:/usr/bin:/bin`;
    const ok = withEnv({ PATH: PATHV }, () => C.registerMergeDriver(b));
    const drv = (r: string): string => JSON.stringify(sh(r, 'git', ['config', '--get', 'merge.gsd-planning.driver']));
    gold(`# registerMergeDriver stub=${withStub}\nrc=${ok ? 0 : 1}\ndriver=${drv(b)}`);
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
    let rc = 0;
    let msg = '';
    try {
      C.migrateRefuse(r);
    } catch (e) {
      assert.ok(e instanceof C.GsdExit);
      rc = e.code;
      msg = e.message;
    }
    gold(`# migrate ${i}\nneeded=${C.migrateNeeded(r) ? '0' : '1'}\nrefuse rc=${rc}\nmessage:\n${msg}`);
  }
  C.migrateRefuse(''); // no-op
});

// ── the lock ────────────────────────────────────────────────────────────────

test('lock: acquire in a child, stale reclaim, re-entrant', () => {
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
       console.log(JSON.stringify({ ok, pidOk: pid === String(process.pid) + '\\n', exists: existsSync(${JSON.stringify(lock)}) }));`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim().split('\n').pop() as string), { ok: true, pidOk: true, exists: true });
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
    same(`testCmd ${name}`, C.testCmd(r));
    same(`installCmd ${name}`, C.installCmd(r));
    if (files['package.json']) {
      gold(`# npmHasTest ${name}\n${C.npmHasTest(path.join(r, 'package.json')) ? '0' : '1'}`);
    }
  }
  assert.equal(C.npmHasTest('/nonexistent/package.json'), false);
});

// ── provider facts ──────────────────────────────────────────────────────────

// a provider fact: its text (for the exit code facts: `value\nrc=N`)
const fact = (label: string, ts: string): void => gold(`# ${label}\n${ts}`);
const rcv = (v: string | null): string => (v === null ? 'rc=1\n' : `${v}\nrc=0\n`);

test('provider known / gone / default command / instruction file / skill root / review flag / hooks', () => {
  const names = ['claude', 'codex', 'custom', 'gemini', 'nope', ''];
  for (const p of names) {
    fact(`known ${p}`, `${P.providerKnown(p) ? '0' : '1'}\n`);
    fact(`gone ${p}`, `${P.providerGone(p) ? '0' : '1'}\n`);
    const dflt = P.providerDefaultCommand(p);
    fact(`default command ${p}`, dflt === null ? 'rc=1\n' : `${dflt === '' ? '' : `${dflt}\n`}rc=0\n`);
    same(`instruction file ${p}`, P.providerInstructionFile(p));
    same(`native hook ${p}`, P.providerNativeHook(p));
    fact(`review flag ${p}`, rcv(P.providerReviewFlag(p)));
    fact(`ui tip ${p}`, rcv(P.providerUiTip(p)));
    for (const addon of ['impeccable', 'shadcn-mcp', 'other']) {
      fact(`addon ${p} ${addon}`, rcv(P.providerUiAddon(p, addon)));
    }
    const m = P.providerHookMetadata(p);
    fact(`hook metadata ${p}`, m === null ? 'rc=1 |||\n' : `rc=0 ${m.settings}|${m.event}|${m.matcher}|${m.command}\n`);
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
    withEnv({ HOME: '/home/fake', ...env }, () => {
      for (const p of ['claude', 'codex', 'custom']) {
        for (const home of [undefined, '/h/ome']) {
          const args = home ? [p, home] : [p];
          const t = P.providerSkillRoot(p, home);
          fact(`skill root ${p} ${home} ${JSON.stringify(env)}`, rcv(t));
        }
        fact(`user hook file ${p} ${JSON.stringify(env)}`, rcv(P.providerUserHookFile(p)));
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
      gold(`# hookState ${p} ${f}\n${P.providerHookState(r, p)}`);
    }
  }
  // P13: without jq the TS check still works (the old bash answered `unverified`, the TS never does)
  const noJq = tmp();
  const r = repo(path.join(tmp(), 'hs2'));
  write(path.join(r, '.claude', 'settings.json'), settings(good));
  for (const x of ['bash', 'git', 'sed', 'awk', 'cat', 'dirname', 'rm']) {
    const w = spawnSync('sh', ['-c', `command -v ${x}`], { encoding: 'utf8' }).stdout.trim();
    if (w) symlinkSync(w, path.join(noJq, x));
  }
  const t = withEnv({ PATH: noJq }, () => P.providerHookState(r, 'claude'));
  assert.equal(t, 'present');
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
      gold(`# staleHooks ${arg === '' ? '(no repo)' : 'repo'}\n${P.staleHooks(arg)}`);
    }
    const n = P.staleHooksNotice().map((l) => `${l}\n`).join('');
    gold(`# staleHooksNotice\n${n}`);
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
      gold(`# valid ${name}/${kind}\n${P.ownedMarkersValid(f, kind) ? '0' : '1'}`);
      gold(`# block ${name}/${kind}\n${JSON.stringify(P.ownedBlockGet(f, kind))}`);
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
      // P12: CRLF file = the oracle runs on its LF version; ours must give the same file, in CRLF
      const crlfCase = name === 'crlf';
      const a = write(path.join(d, `a-${name}-${mode}`), crlfCase ? body.replace(/\r\n/g, '\n') : body, mode);
      const b = write(path.join(d, `b-${name}-${mode}`), body, mode);
      const rb = P.replaceOwnedBlock(b, 'provider', blockFile);
      const lbl = `# replaceOwnedBlock ${name} ${mode.toString(8)}`;
      gold(`${lbl}\nrc=${rb ? 0 : 1}\ncontent=${JSON.stringify(readFileSync(b, 'latin1'))}\nmode=${(statSync(b).mode & 0o777).toString(8)}`);
    }
  }
  // a file that does not exist is created (mode 0600 as before)
  const b = path.join(d, 'new-b');
  assert.equal(P.replaceOwnedBlock(b, 'provider', blockFile), true);
  const nf = (f: string): string => `content=${JSON.stringify(readFileSync(f, 'utf8'))}\nmode=${(statSync(f).mode & 0o777).toString(8)}`;
  gold(`# replaceOwnedBlock new file\n${nf(b)}`);
  // a symlinked file is written through
  const real1 = write(path.join(d, 'real1'), MARK_FILES.ok as string);
  const real2 = write(path.join(d, 'real2'), MARK_FILES.ok as string);
  symlinkSync(real1, path.join(d, 'l1'));
  symlinkSync(real2, path.join(d, 'l2'));
  P.replaceOwnedBlock(path.join(d, 'l2'), 'provider', blockFile);
  assert.equal(readlinkSync(path.join(d, 'l2')), real2);
  gold(`# replaceOwnedBlock through a symlink\n${JSON.stringify(readFileSync(real2, 'utf8'))}`);
  // blocks produced by the real generators, appended to a file with and without a trailing newline
  const entry = write(path.join(d, 'entry'), P.providerEntryBlock('claude,codex'));
  for (const body of ['# Title\ntext', '# Title\ntext\n']) {
    const x = write(path.join(d, 'x'), body);
    const y = write(path.join(d, 'y'), body);
    P.replaceOwnedBlock(y, 'provider', entry);
    gold(`# replaceOwnedBlock generated entry ${JSON.stringify(body)}\n${JSON.stringify(readFileSync(y, 'utf8'))}`);
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
      gold(`# integrated ${v}/${p}\n${P.providerInstructionIntegrated(r, p) ? '0' : '1'}`);
    }
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      const file = path.join(r, f);
      gold(`# members ${v}/${f}\n${P.providerInstructionMembers(file).map((m) => `${m}\n`).join('')}`);
    }
  }
  // commandGuardsActive
  let guardStep = 0;
  const pkg = tmp();
  for (const [name, exec, body] of [
    ['gsdt-worktree-guard', true, 'x'],
    ['gsdt-start', true, 'gsdt-worktree-guard --command start\n'],
    ['gsdt-flow-next', true, 'x gsdt-worktree-guard foo --command bar\n'],
  ] as const) write(path.join(pkg, 'bin', name), body, exec ? 0o755 : 0o644);
  gold(`# commandGuardsActive step ${++guardStep}\n${P.commandGuardsActive(pkg) ? '0' : '1'}`);
  chmodSync(path.join(pkg, 'bin', 'gsdt-flow-next'), 0o644);
  gold(`# commandGuardsActive step ${++guardStep}\n${P.commandGuardsActive(pkg) ? '0' : '1'}`);
  chmodSync(path.join(pkg, 'bin', 'gsdt-flow-next'), 0o755);
  write(path.join(pkg, 'bin', 'gsdt-start'), 'no guard here\n', 0o755);
  gold(`# commandGuardsActive step ${++guardStep}\n${P.commandGuardsActive(pkg) ? '0' : '1'}`);
  gold(`# commandGuardsActive this package\n${P.commandGuardsActive(PKG) ? '0' : '1'}`);
});

// ── the generated text: byte for byte ───────────────────────────────────────

test('rules text, repo values, canonical block, entry block', () => {
  for (const ui of ['on', 'off', '', 'x']) {
    same(`rulesText ${ui}`, ui === '' ? P.rulesText() : P.rulesText(ui), { raw: true });
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
    same(`repoValues ${v}`, P.repoValues(v[0] as string, v[1] as string, v[2] as string, v[3] as string, v[4], v[5]), { raw: true });
    same(`canonical ${v}`, P.canonicalBlock(v[0] as string, v[1] as string, v[2] as string, v[3] as string), { raw: true });
  }
  for (const m of ['claude', 'codex', 'custom', 'claude,codex', 'codex,custom', 'custom,claude', 'claudex', '']) {
    same(`entry ${m}`, P.providerEntryBlock(m), { raw: true });
  }
});

// ── resolving ───────────────────────────────────────────────────────────────

const resultText = (r: C.Result<unknown>): string => (r.ok ? '' : r.message);

test('providerListValidate / providerValidate', () => {
  for (const l of ['claude', 'claude,codex', 'codex,claude,custom', '', ',claude', 'claude,', 'claude,,codex', 'claude,claude', 'gemini', 'claude,gemini', 'nope', 'claude,nope', 'Claude']) {
    const t = P.providerListValidate(l);
    gold(`# list ${l}\n${t ? `${t.message}\n` : ''}rc=${t ? t.code : 0}\n`);
  }
  for (const p of ['claude', 'codex', 'custom', 'gemini', 'nope', '']) {
    for (const c of ['', 'my-agent', 'bad cmd', 'tab\tcmd', '/p/a th']) {
      const t = P.providerValidate(p, c);
      gold(`# validate ${p}/${JSON.stringify(c)}\n${t ? `${t.message}\n` : ''}rc=${t ? t.code : 0}\n`);
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
        const t = P.providerResolve(r, e.p, e.c);
        const tag = `# resolve ${JSON.stringify(conf)} ${JSON.stringify(e)}`;
        gold(t.ok ? `${tag}\nrc=0|${t.value.provider}|${t.value.command}` : `${tag}\nrc=${t.code}|\n${t.message}`);
      });
    }
  }
});

test('modelValidate / modelResolve / startModeResolve / compactResolve', () => {
  for (const p of ['claude', 'codex', 'custom']) {
    for (const m of ['', 'default', 'opus', 'claude-sonnet-5', '-x', 'a b', 'a\tb', 'a\u0001b', 'x/y:z', 'é']) {
      const t = P.modelValidate(p, m);
      gold(`# modelValidate ${p}/${JSON.stringify(m)}\n${t ? `${t.message}\n` : ''}rc=${t ? t.code : 0}\n`);
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
            const t = P.modelResolve(r, p, cli);
            const lbl = `# modelResolve ${p} ${cli} ${tag}`;
            gold(t.ok ? `${lbl}\nrc=0|${t.value}` : `${lbl}\nrc=${t.code}\n${t.message}`);
          }
        }
        for (const cli of ['', 'discuss', 'flow', 'bad']) {
          const t = P.startModeResolve(r, cli);
          const lbl = `# startModeResolve ${cli} ${tag}`;
          gold(t.ok ? `${lbl}\nrc=0|${t.value}` : `${lbl}\nrc=${t.code}\n${t.message}`);
        }
        const t = P.compactResolve(r);
        const lbl = `# compactResolve ${tag}`;
        gold(t.ok ? `${lbl}\nrc=0|${t.value}` : `${lbl}\nrc=${t.code}\n${t.message}`);
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
        const t = P.compactSettings(b.r, b.wt, tokens);
        const tag = `# compactSettings ${JSON.stringify([conf, existing, tokens, envWin, ignored])}`;
        const f = (x: string): string | null => (existsSync(path.join(x, '.claude', 'settings.local.json')) ? readFileSync(path.join(x, '.claude', 'settings.local.json'), 'utf8') : null);
        gold(`${tag}\noutput:\n${t}\nfile: ${JSON.stringify(f(b.r))}`);
      });
    }
  }
});

// ── prompts, argv, quoting ──────────────────────────────────────────────────

test('providerPrompt', () => {
  for (const p of ['claude', 'codex', 'custom', 'nope']) {
    for (const kind of ['discuss', 'flow', 'batch', 'new', 'ingest', 'nope']) {
      for (const n of ['', '7', '2.1', "fix 'a' \"b\" $x `y` — é"]) {
        same(`prompt ${p}/${kind}/${n}`, P.providerPrompt(p, kind, n));
      }
    }
  }
});

const AWKWARD = ['', 'plain', 'with space', 'it\'s', 'quote " and $ safe', 'back\\slash', 'new\nline', 'tab\there', '日本語 é ü — dash', '#hash', 'a#b', '~tilde', 'a=b', '*?[]{}', '`$()&;|<>!^,', 'x\u0001y', '/tmp/a b/c', 'trailing\\', '  lead', 'emoji 🎉 ok', '-lead', '\u007fdel'];

test('shellQuote / providerRender / providerArgv', () => {
  for (const s of AWKWARD) {
    const lbl = `# quote ${JSON.stringify(s)}`;
    // characters beyond Latin-1 stay as they are (old bash 3.2 escaped their bytes as octal)
    if (/[^\u0000-\u00ff]/.test(s)) assert.ok(!P.shellQuote(s).includes('\\3'), `quote keeps ${JSON.stringify(s)}`);
    gold(`${lbl}\n${P.shellQuote(s)}`);
  }
  for (const cwd of ['/tmp/a b', '/x', 'rel dir/ü']) {
    for (const argv of [['fake', 'quote " and $ safe'], ['env', 'A=b', 'claude', '/gsdt-flow 7'], ['x']]) {
      same(`render ${cwd} ${argv}`, P.providerRender(cwd, ...argv));
    }
  }
  for (const p of ['claude', 'codex', 'custom']) {
    for (const model of ['', 'default', 'opus', 'bad model', '-x']) {
      for (const compact of ['', '300000']) {
        for (const envWin of [undefined, '123456']) {
          for (const prompt of AWKWARD) {
            withEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: envWin }, () => {
              const t = P.providerArgv(p, 'agent-cmd', prompt, model, compact);
              const lbl = `# argv ${p}/${JSON.stringify(model)}/${JSON.stringify(compact)}/${envWin}/${JSON.stringify(prompt)}`;
              gold(t.ok ? `${lbl}\nrc=0\n${JSON.stringify(t.value)}` : `${lbl}\nrc=${t.code}\n${t.message}`);
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
