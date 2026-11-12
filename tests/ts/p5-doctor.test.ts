// P5 parity (gsdt-doctor): the TypeScript command behind bin/gsdt-doctor against
// the pre-P5 bash command (tests/fixtures/p5-old-bins/gsdt-doctor). Two worlds
// (old, new) are built with the SAME layout: <W>/pkg is a copy of the package
// (bin, lib, src, skills, shims, VERSION, install.sh; only bin/gsdt-doctor
// differs), <W>/home is HOME, <W>/repo the repo under test. Both run the same
// steps; stdout, stderr, the exit code and the files left behind must match.
//
// Normalized before comparing: the world's root dir (→ <W>). Nothing else.
// Run: node --test tests/ts/p5-doctor.test.ts   (P5_ONLY=<regex> picks scenarios)
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PKG, tmp, write } from './helpers.ts';

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
});

const FIX = path.join(PKG, 'tests', 'fixtures', 'p5-old-bins');

type Ctx = { name: 'old' | 'new'; W: string; pkg: string; home: string; repo: string; stub: string };
type EnvVal = string | null | ((c: Ctx) => string);
type Sc = {
  name: string;
  setup?: (c: Ctx) => void;
  runs?: string[][]; // argv per run, {R} = repo, {W} = world
  env?: Record<string, EnvVal>;
  farm?: string[]; // PATH = every command except these
  nostub?: boolean; // no gsd-core on PATH
  noplain?: boolean; // json only
  cwd?: (c: Ctx) => string;
  pkgGit?: boolean; // make the package copy a git checkout
  expect?: RegExp; // sanity: the NEW stdout+stderr of some run must match
  // Not comparable with the old bin on purpose (P6): without perl the old bin skipped the roadmap
  // check, the TypeScript always runs it. Only the new side runs; it must still show `expect` and a
  // roadmap finding (T022), and never the old "roadmap row check skipped" note.
  newOnly?: boolean;
  tty?: never;
};

const DEF_RUNS = [['--json', '--repo', '{R}'], ['--repo', '{R}']];

function g(cwd: string, ...a: string[]): string {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  return r.stdout ?? '';
}

function makeWorld(name: 'old' | 'new'): Ctx {
  const W = tmp();
  const pkg = path.join(W, 'pkg');
  mkdirSync(pkg, { recursive: true });
  for (const d of ['bin', 'lib', 'src', 'skills', 'shims']) cpSync(path.join(PKG, d), path.join(pkg, d), { recursive: true });
  for (const f of ['VERSION', 'install.sh']) copyFileSync(path.join(PKG, f), path.join(pkg, f));
  if (name === 'old') {
    copyFileSync(path.join(FIX, 'gsdt-doctor'), path.join(pkg, 'bin', 'gsdt-doctor'));
    chmodSync(path.join(pkg, 'bin', 'gsdt-doctor'), 0o755);
  }
  const home = path.join(W, 'home');
  mkdirSync(home, { recursive: true });
  const stub = path.join(W, 'stub');
  write(path.join(stub, 'gsd_run'), `#!/bin/sh\necho '{"packageName":"@opengsd/gsd-core","version":"1.18.0"}'\n`, 0o755);
  return { name, W, pkg, home, repo: path.join(W, 'repo'), stub };
}

/** a small GSD repo on develop with an origin (test-doctor.sh's mkrepo) */
function mkrepo(dir: string, conf = 'base = develop\n'): void {
  mkdirSync(dir, { recursive: true });
  g(dir, 'init', '-q', '-b', 'develop');
  mkdirSync(path.join(dir, '.planning'), { recursive: true });
  writeFileSync(path.join(dir, '.planning/ROADMAP.md'), '# Roadmap\n\n### Phase 1: One\n\n### Phase 2: Two\n');
  writeFileSync(path.join(dir, '.gsd.conf'), conf);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  g(path.dirname(dir), 'init', '-q', '--bare', `${dir}.origin.git`);
  g(dir, 'remote', 'add', 'origin', `${dir}.origin.git`);
  g(dir, 'push', '-q', '-u', 'origin', 'develop');
}
const repoSc = (c: Ctx): void => mkrepo(c.repo);

function runBin(c: Ctx, sc: Sc, argv: string[], cwd: string): Promise<{ out: string; err: string; rc: number }> {
  const dirs = [path.join(c.pkg, 'bin')];
  if (!sc.nostub) dirs.push(c.stub);
  const node = path.dirname(process.execPath);
  dirs.push(node);
  const jq = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
  if (jq) dirs.push(path.dirname(jq));
  dirs.push('/usr/bin', '/bin', '/usr/sbin', '/sbin');
  let PATH = dirs.filter((d, i) => existsSync(d) && dirs.indexOf(d) === i).join(':');
  if (sc.farm) {
    const fd = path.join(c.W, 'farm');
    mkdirSync(fd, { recursive: true });
    const skip = new Set(sc.farm);
    for (const d of PATH.split(':')) {
      for (const n of readdirSync(d)) {
        if (skip.has(n) || existsSync(path.join(fd, n)) || lstatSyncSafe(path.join(fd, n))) continue;
        try {
          symlinkSync(path.join(d, n), path.join(fd, n));
        } catch {
          // ignore
        }
      }
    }
    PATH = fd;
  }
  const env: Record<string, string> = {
    HOME: c.home,
    PATH,
    LC_ALL: 'en_US.UTF-8',
    GSD_NO_UPDATE_CHECK: '1',
    GSD_NO_CORE: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  for (const [k, v] of Object.entries(sc.env ?? {})) {
    if (v === null) delete env[k];
    else env[k] = typeof v === 'function' ? v(c) : v;
  }
  const args = argv.map((a) => a.replaceAll('{R}', c.repo).replaceAll('{W}', c.W));
  return new Promise((resolve) => {
    const p = spawn(path.join(c.pkg, 'bin', 'gsdt-doctor'), args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (rc) => resolve({ out, err, rc: rc ?? 1 }));
  });
}

function lstatSyncSafe(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** every file under dir (skipping .git except its config and the post-merge hook) → relative path → content */
function snapshot(dir: string, root = dir, out: Record<string, string> = {}): Record<string, string> {
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const n of names) {
    const p = path.join(dir, n);
    const rel = path.relative(root, p);
    if (rel === 'pkg' || rel === 'farm' || rel === 'stub' || rel === 'home/Library' || rel.startsWith('home/.npm')) continue;
    if (rel.includes('.git/') && !/\.git\/(config|hooks\/post-merge)$/.test(rel)) continue;
    if (n === '.git' || (rel.startsWith('repo') && rel.endsWith('.git') && false)) {
      snapshot(p, root, out);
      continue;
    }
    const st = lstatSync(p);
    if (st.isSymbolicLink()) out[rel] = `-> ${readlinkSync(p)}`;
    else if (st.isDirectory()) {
      if (rel.endsWith('.origin.git')) continue;
      snapshot(p, root, out);
    } else out[rel] = `${(st.mode & 0o111) !== 0 ? 'x ' : ''}${readFileSync(p, 'latin1')}`;
  }
  return out;
}

const norm = (s: string, W: string): string => s.replaceAll(W, '<W>');
// P6 changed the T006 (perl) wording: the old bin's text is mapped to the new one, nothing else.
const T006_OLD: Array<[string, string]> = [
  ['perl (claims add roadmap rows; the roadmap check needs it)', 'perl (the bash commands not yet ported need it)'],
  ['perl not found — claims cannot add roadmap rows and the roadmap check is skipped', 'perl not found — gsdt-finish, gsdt-init and gsdt-migrate need it'],
];
const t006 = (s: string): string => T006_OLD.reduce((t, [a, b]) => t.replaceAll(a, b), s);

/** assert.equal with a readable message: the chunks that differ, not the whole JSON line */
function same(actual: string, expected: string, lab: string): void {
  if (actual === expected) return;
  const split = (t: string): string[] => t.split(/\n|(?<=\}),(?=\{)|(?<=\]),(?=")/);
  const a = split(actual);
  const e = split(expected);
  const msgs: string[] = [];
  for (let i = 0; i < Math.max(a.length, e.length) && msgs.length < 6; i++) {
    if (a[i] !== e[i]) msgs.push(`  [${i}] new: ${(a[i] ?? '<none>').slice(0, 300)}\n  [${i}] old: ${(e[i] ?? '<none>').slice(0, 300)}`);
  }
  assert.fail(`${lab}\n${msgs.join('\n')}`);
}

const only = process.env.P5_ONLY ? new RegExp(process.env.P5_ONLY) : null;

async function check(sc: Sc): Promise<void> {
  const worlds = [makeWorld('old'), makeWorld('new')];
  for (const c of worlds) {
    if (sc.pkgGit) {
      g(c.pkg, 'init', '-q', '-b', 'main');
      g(c.pkg, 'add', '-A');
      g(c.pkg, 'commit', '-qm', 'pkg');
    }
    (sc.setup ?? repoSc)(c);
  }
  const runs = sc.runs ?? (sc.noplain ? [DEF_RUNS[0] as string[]] : DEF_RUNS);
  let sawExpect = sc.expect === undefined;
  if (sc.newOnly) {
    const c = worlds[1] as Ctx;
    let all = '';
    for (const argv of runs) {
      const n = await runBin(c, sc, argv, sc.cwd ? sc.cwd(c) : c.W);
      all += n.out + n.err;
    }
    assert.match(all, sc.expect as RegExp, `${sc.name}: expect`);
    assert.match(all, /T022/, `${sc.name}: the roadmap check ran`);
    assert.doesNotMatch(all, /roadmap row check skipped/, `${sc.name}: not skipped`);
    return;
  }
  for (const argv of runs) {
    const [o, n] = await Promise.all(worlds.map((c) => runBin(c, sc, argv, sc.cwd ? sc.cwd(c) : c.W)));
    const lab = `${sc.name} [${argv.join(' ')}]`;
    const a = worlds[0] as Ctx;
    const b = worlds[1] as Ctx;
    same(norm((n as { out: string }).out, b.W), norm(t006((o as { out: string }).out), a.W), `${lab}: stdout`);
    // The old bin leaks bash's own "<script>: line N: <file>: No such file or directory" for a
    // missing planning file (a `wc -c < file` redirect error); the port does not (a bug, not a contract).
    const oldErr = (o as { err: string }).err.replace(/^.*gsdt-doctor: line \d+: .*: No such file or directory\n/gm, '');
    same(norm((n as { err: string }).err, b.W), norm(t006(oldErr), a.W), `${lab}: stderr`);
    assert.equal((n as { rc: number }).rc, (o as { rc: number }).rc, `${lab}: exit code`);
    if (sc.expect && sc.expect.test((n as { out: string; err: string }).out + (n as { out: string; err: string }).err)) sawExpect = true;
  }
  const sa = snapshot(worlds[0]!.W);
  const sb = snapshot(worlds[1]!.W);
  const ja = JSON.stringify(sa, null, 1).replaceAll(worlds[0]!.W, '<W>');
  const jb = JSON.stringify(sb, null, 1).replaceAll(worlds[1]!.W, '<W>');
  same(jb, ja, `${sc.name}: files left behind`);
  assert.ok(sawExpect, `${sc.name}: expected output ${sc.expect} never appeared (both sides fail the same way?)`);
}

// ── scenarios ───────────────────────────────────────────────────────────────

const skillsFor = (c: Ctx, names: string[]): void => {
  const sk = path.join(c.home, '.claude/skills');
  for (const s of names) write(path.join(sk, `gsd-${s}/SKILL.md`), `---\nname: gsd-${s}\ndescription: "the ${s} step"\n---\nbody\n`);
};
const FLOW_SKILLS = 'new-project ingest-docs discuss-phase plan-phase review execute-phase code-review verify-work validate-phase secure-phase ui-phase ui-review sketch'.split(' ');
const conf = (c: Ctx, text: string): void => void write(path.join(c.repo, '.gsd.conf'), text);
const git = (c: Ctx, ...a: string[]): string => g(c.repo, ...a);
const init = (c: Ctx, extra: string[] = []): void => {
  spawnSync(path.join(c.pkg, 'bin', 'gsdt-bootstrap-repo'), ['--agents', 'claude,codex', ...extra], {
    cwd: c.repo,
    env: { ...process.env, HOME: c.home, PATH: `${c.pkg}/bin:${process.env.PATH}` },
    stdio: 'ignore',
  });
  git(c, 'add', '-A');
  git(c, 'commit', '-qm', 'bootstrap');
};
const hookJson = (event: string, cmd: string): string => `${JSON.stringify({ hooks: { [event]: [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmd }] }] } })}\n`;

const S: Sc[] = [
  { name: 'clean repo', expect: /findings?/ },
  { name: 'not a git repository', setup: () => undefined, runs: [['--repo', '{W}/nope'], ['--json', '--repo', '{W}/nope']] },
  { name: 'bad arguments', setup: repoSc, runs: [['--help'], ['-h'], ['--bogus'], ['--repo'], ['--fix', '--json', '--repo', '{R}'], ['--yes', '--repo', '{R}']], noplain: true },
  { name: 'cwd is the repo, no --repo', runs: [[], ['--quiet'], ['--json']], cwd: (c) => c.repo },
  { name: 'cwd outside a repo', runs: [[]], cwd: (c) => c.W },
  { name: 'repo with no GSD', setup: (c) => { mkdirSync(c.repo, { recursive: true }); g(c.repo, 'init', '-q', '-b', 'develop'); g(c.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i'); }, expect: /does not use GSD/ },
  { name: 'toolkit checkout as the repo', pkgGit: true, setup: (c) => void c, runs: [['--repo', '{W}/pkg'], ['--json', '--repo', '{W}/pkg']], expect: /toolkit itself/ },
  { name: 'toolkit checkout with changes', pkgGit: true, setup: (c) => { repoSc(c); writeFileSync(path.join(c.pkg, 'x.txt'), 'x'); }, expect: /uncommitted changes/ },
  {
    name: 'symlinked PATH install (like ~/.local/bin)',
    setup: (c) => { repoSc(c); mkdirSync(path.join(c.W, 'ibin')); for (const n of readdirSync(path.join(c.pkg, 'bin'))) symlinkSync(path.join(c.pkg, 'bin', n), path.join(c.W, 'ibin', n)); },
    env: { PATH: (c) => `${c.W}/ibin:${c.stub}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
    runs: [['--repo', '{R}'], ['--quiet', '--repo', '{R}'], ['--json', '--repo', '{R}']],
    expect: /PATH commands resolve to/,
  },
  { name: 'quiet and -q', runs: [['--quiet', '--repo', '{R}'], ['-q', '--repo', '{R}']], expect: /finding/ },
  { name: 'CRLF .gsd.conf', setup: (c) => { repoSc(c); conf(c, 'base = develop\r\nflow = strict\r\nui_gates = warn\r\n'); } },
  { name: 'no gsd-core', nostub: true, expect: /T005/ },
  { name: 'gsd_run that is not gsd-core', nostub: true, setup: (c) => { repoSc(c); write(path.join(c.W, 'fake/gsd_run'), '#!/bin/sh\necho nope\n', 0o755); }, env: { PATH: (c) => `${c.pkg}/bin:${c.W}/fake:${path.dirname(process.execPath)}:/usr/bin:/bin` }, expect: /T005/ },
  { name: 'npx-installed gsd-core', nostub: true, setup: (c) => { repoSc(c); write(path.join(c.home, '.claude/gsd-core/bin/gsd_run'), '#!/bin/sh\necho \'{"packageName":"@opengsd/gsd-core","version":"1.18.0"}\'\n', 0o755); write(path.join(c.home, '.claude/gsd-core/VERSION'), '1.18.0\n'); }, expect: /gsd-core 1\.18\.0/ },
  { name: 'T009 profile core', setup: (c) => { repoSc(c); write(path.join(c.home, '.claude/.gsd-profile'), 'core\n'); write(path.join(c.home, '.codex/.gsd-profile'), 'core,audit\n'); }, expect: /T009/ },
  { name: 'T009 profile full / includes full', setup: (c) => { repoSc(c); write(path.join(c.home, '.claude/.gsd-profile'), 'core,full\n'); } },
  { name: 'T009 codex configured with core profile', setup: (c) => { repoSc(c); conf(c, 'base = develop\nproviders = claude,codex\n'); write(path.join(c.home, '.codex/.gsd-profile'), 'core\n'); }, expect: /codex/ },
  { name: 'T009 skills present, one missing', setup: (c) => { repoSc(c); skillsFor(c, FLOW_SKILLS.filter((s) => s !== 'validate-phase')); }, expect: /gsd-validate-phase/ },
  { name: 'T009 ui_gates off needs no sketch', setup: (c) => { repoSc(c); conf(c, 'base = develop\nui_gates = off\n'); skillsFor(c, FLOW_SKILLS.filter((s) => s !== 'sketch')); } },
  {
    name: 'context: agents, clusters, surface',
    setup: (c) => {
      repoSc(c);
      skillsFor(c, [...FLOW_SKILLS, 'new-milestone', 'thread', 'stats', 'docs-update', 'audit-uat', 'health']);
      write(path.join(c.home, '.claude/agents/gsd-planner.md'), '---\nname: gsd-planner\ndescription: plans — ünï\ntools: Read\n---\nlong body\n');
      write(path.join(c.home, '.claude/agents/gsd-two.toml'), 'name = "two"\ndescription = "x"\nother = 1\n');
      write(path.join(c.home, '.claude/agents/other.md'), '---\nname: other\ndescription: not ours\n---\n');
      write(path.join(c.home, '.claude/agents/gsd-empty.md'), '');
      write(path.join(c.home, '.claude/gsd-core/bin/lib/clusters.cjs'), `exports.CLUSTERS = Object.freeze({\n  core_loop: ['plan-phase', 'execute-phase', 'help'],\n  audit_review: ['validate-phase', 'audit-uat'],\n  milestone: ['new-milestone', 'health'],\n  workspace_state: ['thread'],\n  docs: ['ingest-docs', 'docs-update'],\n  empty_one: ['not-installed'],\n  stats_group: ['stats'],\n});\n`);
      write(path.join(c.home, '.claude/.gsd-surface.json'), '{"baseProfile":"full","disabledClusters":["stats_group"],"explicitAdds":[],"explicitRemoves":[]}\n');
    },
    expect: /"group":"milestone"/,
  },
  {
    name: 'T009 in a disabled group',
    setup: (c) => {
      repoSc(c);
      skillsFor(c, FLOW_SKILLS.filter((s) => s !== 'validate-phase'));
      write(path.join(c.home, '.claude/gsd-core/bin/lib/clusters.cjs'), `exports.CLUSTERS = { audit_review: ['validate-phase', 'audit-uat'], other: ['x'] };\n`);
      write(path.join(c.home, '.claude/.gsd-surface.json'), '{"disabledClusters":["audit_review"]}\n');
    },
    expect: /gsd-surface enable audit_review/,
  },
  {
    name: 'T009 two skills, one group unknown',
    setup: (c) => {
      repoSc(c);
      skillsFor(c, FLOW_SKILLS.filter((s) => s !== 'validate-phase' && s !== 'review'));
      write(path.join(c.home, '.claude/gsd-core/bin/lib/clusters.cjs'), `exports.CLUSTERS = { audit_review: ['validate-phase'] };\n`);
      write(path.join(c.home, '.claude/.gsd-surface.json'), '{"disabledClusters":["audit_review"]}\n');
    },
  },
  { name: 'context: skills in codex dir', setup: (c) => { repoSc(c); conf(c, 'base = develop\nproviders = codex\n'); for (const s of FLOW_SKILLS) write(path.join(c.home, `.agents/skills/gsd-${s}/SKILL.md`), `---\nname: gsd-${s}\ndescription: d\n---\n`); write(path.join(c.home, '.codex/agents/gsd-a.toml'), 'name = "a"\ndescription = "d"\n'); } },
  { name: 'big planning files', setup: (c) => { repoSc(c); const big = Array.from({ length: 900 }, (_, i) => `filler line ${i} that is long enough to fill the roadmap up`).join('\n'); writeFileSync(path.join(c.repo, '.planning/ROADMAP.md'), `# Roadmap\n\n### Phase 1: One\n\n### Phase 2: Two\n${big}\n`); writeFileSync(path.join(c.repo, '.planning/STATE.md'), big.repeat(2)); }, expect: /KiB/ },
  { name: 'big AGENTS.md with codex', setup: (c) => { repoSc(c); conf(c, 'base = develop\nproviders = codex\n'); writeFileSync(path.join(c.repo, 'AGENTS.md'), 'x'.repeat(40000)); }, expect: /Codex reads only/ },
  { name: 'no perl', farm: ['perl'], expect: /T006/, newOnly: true },
  // P8: the baseRef check no longer needs python, so without it the new doctor still reports T034 (the old one skipped it)
  { name: 'no python', farm: ['python3', 'python'], expect: /(?=[\s\S]*T003)(?=[\s\S]*T034)/, newOnly: true },
  { name: 'no gsdt-finish on PATH', farm: ['gsdt-finish'], expect: /T001/ },
  { name: 'no gsdt-planning-repair', farm: ['gsdt-planning-repair'], expect: /T004/ },
  { name: 'PATH commands from another package', setup: (c) => { repoSc(c); write(path.join(c.W, 'other/bin/gsdt-finish'), '#!/bin/sh\n', 0o755); }, env: { PATH: (c) => `${c.W}/other/bin:${c.pkg}/bin:${c.stub}:${path.dirname(process.execPath)}:/usr/bin:/bin` }, expect: /T002/ },
  { name: 'T007 stale skills', setup: (c) => { repoSc(c); const sk = path.join(c.W, 'skills'); cpSync(path.join(c.pkg, 'skills'), sk, { recursive: true }); writeFileSync(path.join(sk, 'gsdt-flow/SKILL.md'), `${readFileSync(path.join(sk, 'gsdt-flow/SKILL.md'), 'utf8')}old step\n`); }, env: { GSD_CLAUDE_SKILL_DIR: (c) => path.join(c.W, 'skills') }, expect: /T007/ },
  { name: 'skills current', setup: (c) => { repoSc(c); cpSync(path.join(c.pkg, 'skills'), path.join(c.W, 'skills'), { recursive: true }); }, env: { GSD_CLAUDE_SKILL_DIR: (c) => path.join(c.W, 'skills') }, expect: /skills installed and current/ },
  { name: 'skills not installed (codex too)', setup: (c) => { repoSc(c); conf(c, 'base = develop\nproviders = claude,codex,custom\n'); }, expect: /skills not installed|no installable/ },
  { name: 'release runtime (no .git)', expect: /--version/ },
  { name: 'T017 unknown keys', setup: (c) => { repoSc(c); conf(c, 'base = develop\ncolour = red\nthis is not a setting\ntracker = none\nclaude_model = opus\n = x\n# c\n  \n'); }, expect: /T017/ },
  { name: 'T018 bad values', setup: (c) => { repoSc(c); conf(c, 'base = develop\nflow = on\nflow_since = soon\nstart_mode = go\nui_gates = loud\nflow_skip = 3, four, 5.x\nui_min_font = big\n'); }, expect: /T018/ },
  { name: 'T018 ui_min_font range', setup: (c) => { repoSc(c); conf(c, 'base = develop\nui_min_font = 40\n'); }, expect: /out of range/ },
  { name: 'T018 ui_min_font ok', setup: (c) => { repoSc(c); conf(c, 'base = develop\nui_min_font = 012\n'); } },
  { name: 'T015 base nowhere', setup: (c) => { repoSc(c); conf(c, 'base = nope\n'); }, expect: /does not exist/ },
  { name: 'T015 base only on origin', setup: (c) => { repoSc(c); git(c, 'branch', '-q', 'release'); git(c, 'push', '-q', 'origin', 'release'); git(c, 'branch', '-q', '-D', 'release'); conf(c, 'base = release\n'); }, expect: /--track release/ },
  { name: 'no origin', setup: (c) => { repoSc(c); git(c, 'remote', 'remove', 'origin'); }, expect: /no 'origin' remote/ },
  { name: 'T019 premerge not executable', setup: (c) => { repoSc(c); write(path.join(c.repo, 'scripts/gsdt-premerge-check.sh'), '#!/bin/sh\nexit 0\n'); }, expect: /not executable/ },
  { name: 'T019 premerge executable', setup: (c) => { repoSc(c); write(path.join(c.repo, 'scripts/gsdt-premerge-check.sh'), '#!/bin/sh\nexit 0\n', 0o755); }, expect: /pre-merge gate/ },
  { name: 'T019 premerge missing / none', setup: (c) => { repoSc(c); conf(c, 'base = develop\npremerge = scripts/nope.sh\n'); }, expect: /does not exist/ },
  { name: 'T019 premerge = none', setup: (c) => { repoSc(c); conf(c, 'base = develop\npremerge = none\n'); } },
  { name: 'T025 duplicate headings', setup: (c) => { repoSc(c); writeFileSync(path.join(c.repo, '.planning/ROADMAP.md'), '# Roadmap\n\n### Phase 1: One\n\n### Phase 02: Two\n\n### Phase 2: Two\n\n### Phase 01: again\n\n#### Phase 3.1: x\n#### Phase 03.01: y\n'); }, expect: /T025/ },
  { name: 'T026 bracket ids', setup: (c) => { repoSc(c); write(path.join(c.repo, '.planning/config.json'), '{\n  "phase_id_convention": "bracket"\n}\n'); }, expect: /T026/ },
  { name: 'T032 install failed / running', setup: (c) => { repoSc(c); const w = path.join(c.W, 'phase-1-one'); git(c, 'worktree', 'add', '-q', '-b', 'phase-1-one', w); write(path.join(w, '.gsd-install.status'), 'fail\n'); const w2 = path.join(c.W, 'phase-2-two'); git(c, 'worktree', 'add', '-q', '-b', 'phase-2-two', w2); write(path.join(w2, '.gsd-install.status'), 'running\n'); }, expect: /T032/ },
  { name: 'tracker clickup no token', setup: (c) => { repoSc(c); conf(c, 'base = develop\ntracker = clickup\n'); }, env: { GSD_CLICKUP_CONFIG: (c) => path.join(c.W, 'clickup.env') }, expect: /T073/ },
  { name: 'tracker clickup token file', setup: (c) => { repoSc(c); conf(c, 'base = develop\ntracker = clickup\n'); write(path.join(c.W, 'clickup.env'), 'CLICKUP_API_TOKEN=pk_test\n'); }, env: { GSD_CLICKUP_CONFIG: (c) => path.join(c.W, 'clickup.env') }, expect: /token found/ },
  { name: 'tracker clickup env token + profile', setup: (c) => { repoSc(c); conf(c, 'base = develop\ntracker = clickup\ntracker_profile = acme\n'); }, env: { CLICKUP_API_TOKEN: 'pk_env' }, expect: /is not used/ },
  { name: 'tracker clickup profile', setup: (c) => { repoSc(c); conf(c, 'base = develop\ntracker = clickup\ntracker_profile = acme\n'); write(path.join(c.home, '.config/gsd/clickup.env'), 'CLICKUP_API_TOKEN=pk_shared\n'); }, expect: /clickup-acme\.env/ },
  { name: 'tracker clickup bad profile', setup: (c) => { repoSc(c); conf(c, 'base = develop\ntracker = clickup\ntracker_profile = ../x\n'); }, expect: /not a name/ },
  { name: 'tracker custom', setup: (c) => { repoSc(c); write(path.join(c.W, 'trk.sh'), '#!/bin/sh\n', 0o755); conf(c, `base = develop\ntracker = custom\ntracker_command = ${c.W}/trk.sh\n`); }, expect: /tracker: custom/ },
  { name: 'tracker custom missing', setup: (c) => { repoSc(c); conf(c, 'base = develop\ntracker = custom\n'); }, expect: /T072/ },
  { name: 'tracker unknown', setup: (c) => { repoSc(c); conf(c, 'base = develop\ntracker = jira\n'); }, expect: /T071/ },
  { name: 'T070 cu_ tags with tracker none', setup: (c) => { repoSc(c); writeFileSync(path.join(c.repo, '.planning/ROADMAP.md'), '# R\n\n### Phase 1: One cu_abc123xyz\n'); }, expect: /T070/ },
  {
    name: 'flow debt (T040) incl. flow_skip',
    setup: (c) => {
      repoSc(c);
      for (const d of ['03-a', '04-b', '04.1-c', '5-e', '06-f']) mkdirSync(path.join(c.repo, '.planning/phases', d), { recursive: true });
      writeFileSync(path.join(c.repo, '.planning/ROADMAP.md'), '# Roadmap\n\n- [x] **Phase 3: A**\n- [x] **Phase 4: B**\n- [x] **Phase 4.1: C**\n- [x] **Phase 5: E**\n- [x] **Phase 6: F**\n- [x] **Phase 9: gone**\n\n### Phase 3: A\n');
      conf(c, 'base = develop\nflow = strict\nflow_skip = 03, 4.1   # shipped before the rules\n');
      write(path.join(c.repo, '.planning/phases/06-f/06-REVIEW.md'), 'x\n');
      write(path.join(c.repo, '.planning/phases/06-f/06-SECURITY.md'), '---\nstatus: open\nthreats_open: 2\n---\n');
      write(path.join(c.repo, '.planning/phases/06-f/06-VERIFICATION.md'), 'x\n');
      write(path.join(c.repo, '.planning/phases/06-f/06-01-UAT.md'), 'x\n');
      write(path.join(c.repo, '.planning/phases/5-e/5-SECURITY.md'), '---\nthreats_open: 0\n---\n');
      write(path.join(c.repo, '.planning/phases/5-e/5-UI-SPEC.md'), 'x\n');
      write(path.join(c.repo, '.planning/phases/04-b/04-VALIDATION.md'), '---\nnyquist_compliant: true\n---\n');
    },
    expect: /T040/,
  },
  { name: 'flow_since', setup: (c) => { repoSc(c); mkdirSync(path.join(c.repo, '.planning/phases/03-a'), { recursive: true }); writeFileSync(path.join(c.repo, '.planning/ROADMAP.md'), '# R\n\n- [x] **Phase 3: A**\n- [x] **Phase 12: B**\n'); conf(c, 'base = develop\nflow = strict\nflow_since = 5\n'); } },
  { name: 'flow strict + tracker ticket', setup: (c) => { repoSc(c); mkdirSync(path.join(c.repo, '.planning/phases/03-a-tk-ab12'), { recursive: true }); writeFileSync(path.join(c.repo, '.planning/ROADMAP.md'), '# R\n\n- [x] **Phase 3: A tk-ab12**\n'); conf(c, 'base = develop\nflow = strict\ntracker = custom\ntracker_command = /bin/true\n'); }, expect: /ticket/ },
  { name: 'T008 stale hooks', setup: (c) => { repoSc(c); mkdirSync(path.join(c.home, '.claude'), { recursive: true }); write(path.join(c.home, '.claude/settings.json'), hookJson('PostToolUse', `"${c.W}/old/node" "${c.W}/gsd-context-monitor.js"`)); write(path.join(c.home, '.codex/hooks.json'), hookJson('SessionStart', `"${c.W}/old/node" "${c.W}/gsd-check-update.js"`)); write(path.join(c.repo, '.claude/settings.json'), hookJson('PreToolUse', 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/gsd-read-guard.js"')); }, expect: /T008/ },
  { name: 'T008 toolkit guard + statusline', setup: (c) => { repoSc(c); write(path.join(c.home, '.claude/settings.json'), hookJson('PreToolUse', `[ ! -x '${c.W}/gone/gsdt-worktree-guard' ] || exec '${c.W}/gone/gsdt-worktree-guard' --global`)); write(path.join(c.home, '.codex/hooks.json'), `${JSON.stringify({ statusLine: { type: 'command', command: `"${c.W}/old/node" "${c.W}/gsd-statusline.js"` } })}\n`); }, expect: /T008/ },
  { name: 'T008 settings not JSON', setup: (c) => { repoSc(c); write(path.join(c.repo, '.claude/settings.json'), 'not json'); } },
  { name: 'T006 skills etc: bootstrapped repo', setup: (c) => { repoSc(c); init(c); }, expect: /instructions match/ },
  { name: 'bootstrapped, providers claude,codex', setup: (c) => { repoSc(c); conf(c, 'base = develop\nproviders = claude,codex\n'); init(c); } },
  { name: 'T016 old canonical + provider blocks', setup: (c) => { repoSc(c); conf(c, 'base = develop\nproviders = claude,codex\n'); init(c); const f = path.join(c.repo, '.gsd/INSTRUCTIONS.md'); writeFileSync(f, readFileSync(f, 'utf8').replace('Providers:', 'Provider list:')); const a = path.join(c.repo, 'AGENTS.md'); writeFileSync(a, readFileSync(a, 'utf8').replace('Read and follow', 'Please read and follow')); }, expect: /T016/ },
  { name: 'T016 pre-0.8.0 markers', setup: (c) => { repoSc(c); conf(c, 'base = develop\nproviders = claude,codex\n'); init(c); for (const f of ['.gsd/INSTRUCTIONS.md', 'CLAUDE.md', 'AGENTS.md']) { const p = path.join(c.repo, f); writeFileSync(p, readFileSync(p, 'utf8').replaceAll('<!-- gsd-toolkit:', '<!-- gsd-worktrees:').replaceAll('gsdt-flow', 'gsdw-flow')); } } },
  { name: 'T016 text outside blocks ignored', setup: (c) => { repoSc(c); init(c); const p = path.join(c.repo, 'CLAUDE.md'); writeFileSync(p, `${readFileSync(p, 'utf8')}\nMy own notes.\n`); } },
  { name: 'T062 hook registered', setup: (c) => { repoSc(c); init(c); write(path.join(c.W, 'hook.json'), `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `[ ! -x x ] || exec ${c.pkg}/bin/gsdt-rules --hook` }] }] } })}\n`); }, env: { GSD_CLAUDE_SETTINGS: (c) => path.join(c.W, 'hook.json') }, expect: /load the toolkit rules/ },
  { name: 'T062 no hook', setup: (c) => { repoSc(c); init(c); write(path.join(c.W, 'hook.json'), '{"hooks":{}}\n'); }, env: { GSD_CLAUDE_SETTINGS: (c) => path.join(c.W, 'hook.json') }, expect: /T062/ },
  { name: 'T062 odd settings shapes', setup: (c) => { repoSc(c); init(c); write(path.join(c.W, 'hook.json'), '{"hooks":{"SessionStart":[{"hooks":[5,{"command":"gsdt-rules --hook"}]}]}}\n'); }, env: { GSD_CLAUDE_SETTINGS: (c) => path.join(c.W, 'hook.json') } },
  { name: 'T062 odd settings 2', setup: (c) => { repoSc(c); init(c); write(path.join(c.W, 'hook.json'), '{"hooks":{"SessionStart":[{"hooks":[{"command":"gsdt-rules --hook"}]}]}}\n'); }, env: { GSD_CLAUDE_SETTINGS: (c) => path.join(c.W, 'hook.json') } },
  { name: 'T062 missing settings file', setup: (c) => { repoSc(c); init(c); }, env: { GSD_CLAUDE_SETTINGS: (c) => path.join(c.W, 'nosuch.json') }, expect: /T062/ },
  { name: 'T062 not on PATH', farm: ['gsdt-rules'], setup: (c) => { repoSc(c); init(c); }, expect: /gsdt-rules is not on PATH/ },
  { name: 'T062 opt-out manifest', farm: ['gsdt-rules'], setup: (c) => { repoSc(c); init(c); mkdirSync(path.join(c.W, 'optout'), { recursive: true }); write(path.join(c.W, 'optout/gsdt-rules'), '#!/bin/sh\n', 0o755); write(path.join(c.W, 'optout/.gsd-install-manifest'), 'providers\tclaude\nuser_hook\toff\n'); }, env: { GSD_CLAUDE_SETTINGS: (c) => path.join(c.W, 'nosuch.json'), PATH: (c) => `${c.W}/optout:${c.W}/farm` }, noplain: false },
  { name: 'T062 claude not configured', setup: (c) => { repoSc(c); init(c); conf(c, 'base = develop\nproviders = codex\n'); } },
  { name: 'T061 gemini leftovers', setup: (c) => { repoSc(c); init(c); conf(c, 'base = develop\nproviders = claude,gemini\ngemini_model = x\n'); write(path.join(c.repo, 'GEMINI.md'), '<!-- gsd-toolkit:provider:start -->\nx\n<!-- gsd-toolkit:provider:end -->\n'); write(path.join(c.repo, '.gemini/settings.json'), '{"hooks":[{"command": "x/gsdt-worktree-guard"}]}\n'); }, expect: /T061/ },
  { name: 'T060 review_provider gemini / invalid', setup: (c) => { repoSc(c); conf(c, 'base = develop\nreview_provider = gemini\n'); }, expect: /T060/ },
  { name: 'T060 invalid review_provider', setup: (c) => { repoSc(c); conf(c, 'base = develop\nreview_provider = bob\n'); }, expect: /invalid review_provider/ },
  { name: 'T050 invalid provider', setup: (c) => { repoSc(c); conf(c, 'base = develop\nproviders = bob\n'); }, expect: /T050/ },
  { name: 'T050/T057 mixed providers', setup: (c) => { repoSc(c); conf(c, 'base = develop\nproviders = claude,custom,bob\ncustom_command = /nonexistent/x\n'); } },
  { name: 'T051 provider executable unavailable', setup: (c) => { repoSc(c); conf(c, 'base = develop\nclaude_command = /nonexistent/claude\n'); }, expect: /T051/ },
  { name: 'T059 bad model', setup: (c) => { repoSc(c); conf(c, 'base = develop\nclaude_model = bad model\n'); }, expect: /T059/ },
  { name: 'session model set', setup: (c) => { repoSc(c); conf(c, 'base = develop\nclaude_model = opus\n'); }, expect: /session model: opus/ },
  { name: 'T056 legacy provider conflict / note', setup: (c) => { repoSc(c); conf(c, 'base = develop\nproviders = codex\nprovider = claude\n'); }, expect: /T056/ },
  { name: 'legacy provider key note', setup: (c) => { repoSc(c); conf(c, 'base = develop\nprovider = codex\n'); }, expect: /legacy 'provider' key/ },
  { name: 'T054/T055 foreign blocks', setup: (c) => { repoSc(c); conf(c, 'base = develop\nproviders = claude\n'); init(c); write(path.join(c.repo, 'AGENTS.md'), '<!-- gsd-toolkit:provider:start -->\n## GSD worktrees (codex adapter)\nRead and follow `.gsd/INSTRUCTIONS.md`\n<!-- gsd-toolkit:provider:end -->\n'); const p = path.join(c.repo, 'CLAUDE.md'); writeFileSync(p, `${readFileSync(p, 'utf8')}<!-- gsd-toolkit:provider:start -->\n`); }, expect: /T05[45]/ },
  { name: 'T010-T014 nothing installed', setup: (c) => { repoSc(c); }, expect: /T01[0-4]/ },
  { name: 'T011 union attributes + shim drift', setup: (c) => { repoSc(c); init(c); writeFileSync(path.join(c.repo, '.gitattributes'), '.planning/ROADMAP.md merge=union\n.planning/STATE.md merge=union\n'); writeFileSync(path.join(c.repo, 'scripts/gsdt-start.sh'), 'changed\n'); git(c, 'config', '--unset', 'merge.gsd-planning.driver'); rmSync(path.join(c.repo, '.git/hooks/post-merge'), { force: true }); }, expect: /T011/ },
  { name: 'husky without hooksPath', setup: (c) => { repoSc(c); init(c); mkdirSync(path.join(c.repo, '.husky')); }, expect: /husky/ },
  { name: 'T090 old gsd-* names', setup: (c) => { repoSc(c); mkdirSync(path.join(c.repo, 'scripts'), { recursive: true }); write(path.join(c.repo, 'scripts/gsd-finish-worktree-feature.sh'), '#!/bin/sh\n', 0o755); write(path.join(c.repo, 'scripts/gsd-premerge-check.sh'), '#!/bin/sh\n', 0o755); }, expect: /T090/ },
  { name: 'T030 stale lock', setup: (c) => { repoSc(c); mkdirSync(path.join(c.repo, '.git/gsd-cmd.lock')); writeFileSync(path.join(c.repo, '.git/gsd-cmd.lock/pid'), '999999\n'); }, expect: /T030/ },
  { name: 'T033 lock without pid', setup: (c) => { repoSc(c); mkdirSync(path.join(c.repo, '.git/gsd-cmd.lock')); }, expect: /T033/ },
  { name: 'live lock', setup: (c) => { repoSc(c); mkdirSync(path.join(c.repo, '.git/gsd-cmd.lock')); writeFileSync(path.join(c.repo, '.git/gsd-cmd.lock/pid'), `${process.pid}\n`); }, expect: /running right now/ },
  { name: 'W017 orphan, W027 stale record, T031 wrong branch', setup: (c) => { repoSc(c); git(c, 'branch', 'phase-9-orphan'); git(c, 'branch', 'batch-2026-x'); const w = path.join(c.W, 'phase-1-one'); git(c, 'worktree', 'add', '-q', '-b', 'phase-1-one', w); rmSync(w, { recursive: true }); git(c, 'checkout', '-q', '-b', 'other'); }, expect: /W017/ },
  { name: 'upstream gone + behind origin', setup: (c) => { repoSc(c); git(c, 'branch', 'feat'); git(c, 'push', '-q', '-u', 'origin', 'feat'); g(c.repo + '.origin.git', 'branch', '-q', '-D', 'feat'); git(c, 'fetch', '-q', '--prune'); const o = path.join(c.W, 'clone'); g(c.W, 'clone', '-q', `${c.repo}.origin.git`, o); g(o, 'commit', '-q', '--allow-empty', '-m', 'more'); g(o, 'push', '-q', 'origin', 'develop'); git(c, 'fetch', '-q'); }, expect: /upstream is gone/ },
  { name: 'T024 workstreams', setup: (c) => { repoSc(c); write(path.join(c.repo, '.planning/workstreams/a/ROADMAP.md'), 'x\n'); }, expect: /T024/ },
  { name: 'no .planning', setup: (c) => { repoSc(c); rmSync(path.join(c.repo, '.planning'), { recursive: true }); git(c, 'add', '-A'); git(c, 'commit', '-qm', 'rm'); }, expect: /no \.planning/ },
  { name: 'T020 planning contradicts itself', setup: (c) => { repoSc(c); writeFileSync(path.join(c.repo, '.planning/ROADMAP.md'), '# Roadmap\n\n- [ ] **Phase 1: One**\n- [x] **Phase 1: One**\n\n### Phase 1: One\n\n**Plans:** 1/1 plans complete\n\n**Plans:** 0/1 plans\n'); }, expect: /T020|coherent/ },
  { name: 'planning repair offers --fix', setup: (c) => { repoSc(c); write(path.join(c.repo, '.planning/STATE.md'), '# Project State\n\n## Current Position\n\nPhase: 1 of 2\nProgress: [█████░░░░░] 50%\n'); }, expect: /recomputed/ },
  { name: 'roadmap audit T021-T023', setup: (c) => { repoSc(c); writeFileSync(path.join(c.repo, '.planning/ROADMAP.md'), '# Roadmap\n\n- [ ] **Phase 1: One** (needs Phase 2)\n- [ ] **Phase 2: Two**\n\n### Phase 1: One\n\n### Phase 2: Two\n\n### Phase 3: Three\n\n## Progress\n\n| Phase | Plans | Status |\n|---|---|---|\n| 1 | 0/1 | x |\n'); }, expect: /T02[123]/ },
  {
    name: 'worktree-scoped roadmap audit',
    setup: (c) => { repoSc(c); const w = path.join(c.W, 'phase-1-one'); git(c, 'worktree', 'add', '-q', '-b', 'phase-1-one', w); writeFileSync(path.join(w, '.planning/ROADMAP.md'), '# Roadmap\n\n- [ ] **Phase 1: One**\n\n### Phase 1: One\n\n### Phase 2: Two\n'); },
    runs: [['--repo', '{W}/phase-1-one'], ['--json', '--repo', '{W}/phase-1-one']],
    expect: /this worktree's own copy/,
  },
  { name: 'cwd inside a worktree', setup: (c) => { repoSc(c); git(c, 'worktree', 'add', '-q', '-b', 'phase-1-one', path.join(c.W, 'phase-1-one')); }, cwd: (c) => path.join(c.W, 'phase-1-one'), runs: [['--repo', '{R}'], ['--json', '--repo', '{R}']] },
  {
    name: 'UI gates: design stub, committed shots, addons',
    setup: (c) => {
      repoSc(c);
      mkdirSync(path.join(c.repo, '.planning/phases/01-a'), { recursive: true });
      writeFileSync(path.join(c.repo, '.planning/phases/01-a/01-UI-SPEC.md'), 'x\n');
      write(path.join(c.repo, '.planning/phases/01-a/01-SHOTS/home.png'), 'png');
      write(path.join(c.repo, '.planning/phases/01-a/01-SHOTS/index.html'), 'h');
      write(path.join(c.repo, 'package.json'), '{"dependencies":{"tailwindcss":"1","react":"1"}}\n');
      write(path.join(c.repo, '.planning/design/DESIGN.md'), '<!-- gsd:design-stub -->\n');
      conf(c, 'base = develop\nproviders = claude,codex\n');
      git(c, 'add', '-A');
      git(c, 'commit', '-qm', 'ui');
    },
    env: { GSD_NPM_GLOBAL_ROOT: (c) => path.join(c.W, 'noglobal') },
    expect: /UI \(ui_gates = warn\)/,
  },
  {
    name: 'UI gates strict',
    setup: (c) => {
      repoSc(c);
      mkdirSync(path.join(c.repo, '.planning/phases/01-a'), { recursive: true });
      writeFileSync(path.join(c.repo, '.planning/phases/01-a/01-UI-SPEC.md'), 'x\n');
      write(path.join(c.repo, '.planning/phases/01-a/01-SHOTS/home.png'), 'png');
      write(path.join(c.repo, '.planning/ROADMAP.md'), '# R\n\n- [x] **Phase 1: A**\n\n### Phase 1: A\n');
      conf(c, 'base = develop\nui_gates = strict\n');
      git(c, 'add', '-A');
      git(c, 'commit', '-qm', 'ui');
    },
    env: { GSD_NPM_GLOBAL_ROOT: (c) => path.join(c.W, 'noglobal') },
    expect: /T080|T081|T040/,
  },
  {
    name: 'UI gates strict, design ok, check passed no approval',
    setup: (c) => {
      repoSc(c);
      mkdirSync(path.join(c.repo, '.planning/phases/01-a'), { recursive: true });
      writeFileSync(path.join(c.repo, '.planning/phases/01-a/01-UI-SPEC.md'), 'x\n');
      writeFileSync(path.join(c.repo, '.planning/phases/01-a/01-UI-CHECK.md'), '---\nstatus: passed\ncapture: abc\ncode: x\n---\n');
      write(path.join(c.repo, '.planning/design/DESIGN.md'), '# Design\n');
      write(path.join(c.repo, '.planning/ROADMAP.md'), '# R\n\n- [x] **Phase 1: A**\n\n### Phase 1: A\n');
      conf(c, 'base = develop\nui_gates = strict\n');
      git(c, 'add', '-A');
      git(c, 'commit', '-qm', 'ui');
    },
    expect: /ui-approve/,
  },
  {
    name: 'T034 baseRef missing / other / invalid',
    setup: (c) => {
      repoSc(c);
      writeFileSync(path.join(c.repo, '.gitignore'), '.claude/settings.local.json\n');
      git(c, 'add', '-A');
      git(c, 'commit', '-qm', 'ignore');
      git(c, 'worktree', 'add', '-q', path.join(c.W, 'wts/phase-1-one'), '-b', 'phase-1-one');
      git(c, 'worktree', 'add', '-q', path.join(c.W, 'wts/phase-2-two'), '-b', 'phase-2-two');
      git(c, 'worktree', 'add', '-q', path.join(c.W, 'wts/phase-3-th'), '-b', 'phase-3-th');
      git(c, 'worktree', 'add', '-q', path.join(c.repo, '.claude/worktrees/agent-a1'), '-b', 'worktree-agent-a1');
      write(path.join(c.repo, '.claude/settings.local.json'), '{"permissions":{"allow":["Bash(ls)"]}}\n');
      write(path.join(c.W, 'wts/phase-2-two/.claude/settings.local.json'), '{"worktree":{"baseRef":"origin"}}\n');
      write(path.join(c.W, 'wts/phase-3-th/.claude/settings.local.json'), '{ "worktree": ');
    },
    expect: /T034/,
  },
  {
    name: 'T034 --fix --yes',
    setup: (c) => {
      repoSc(c);
      writeFileSync(path.join(c.repo, '.gitignore'), '.claude/settings.local.json\n');
      git(c, 'add', '-A');
      git(c, 'commit', '-qm', 'ignore');
      git(c, 'worktree', 'add', '-q', path.join(c.W, 'wts/phase-1-one'), '-b', 'phase-1-one');
      write(path.join(c.repo, '.claude/settings.local.json'), '{"permissions":{"allow":["Bash(ls)"]}}\n');
    },
    runs: [['--fix', '--yes', '--repo', '{R}'], ['--json', '--repo', '{R}']],
    expect: /baseRef/,
  },
  { name: 'T034 head everywhere', setup: (c) => { repoSc(c); write(path.join(c.repo, '.claude/settings.local.json'), '{"worktree":{"baseRef":"head"}}\n'); }, expect: /baseRef = "head"/ },
  {
    name: '--fix --yes (lock, track, chmod, init)',
    setup: (c) => {
      repoSc(c);
      git(c, 'branch', '-q', 'release');
      git(c, 'push', '-q', 'origin', 'release');
      git(c, 'branch', '-q', '-D', 'release');
      conf(c, 'base = release\n');
      write(path.join(c.repo, 'scripts/gsdt-premerge-check.sh'), '#!/bin/sh\nexit 0\n');
      mkdirSync(path.join(c.repo, '.git/gsd-cmd.lock'));
      writeFileSync(path.join(c.repo, '.git/gsd-cmd.lock/pid'), '999999\n');
      git(c, 'add', '-A');
      git(c, 'commit', '-qm', 'fixture');
    },
    runs: [['--fix', '--yes', '--repo', '{R}']],
    expect: /Checking again/,
  },
  {
    name: '--fix without a terminal / nothing safe',
    setup: (c) => { repoSc(c); mkdirSync(path.join(c.repo, '.git/gsd-cmd.lock')); writeFileSync(path.join(c.repo, '.git/gsd-cmd.lock/pid'), '999999\n'); },
    runs: [['--fix', '--repo', '{R}'], ['--fix', '--quiet', '--repo', '{R}']],
    expect: /not a terminal/,
  },
  { name: '--fix: judgment finding only', setup: (c) => { repoSc(c); writeFileSync(path.join(c.repo, '.planning/ROADMAP.md'), '# R\n\n### Phase 2: a\n\n### Phase 02: b\n'); init(c); }, runs: [['--fix', '--yes', '--repo', '{R}']], expect: /none of these findings/ },
  { name: '--fix --yes: refresh instructions (T016)', setup: (c) => { repoSc(c); conf(c, 'base = develop\nproviders = claude,codex\n'); init(c); const f = path.join(c.repo, '.gsd/INSTRUCTIONS.md'); writeFileSync(f, readFileSync(f, 'utf8').replace('Providers:', 'Provider list:')); }, runs: [['--fix', '--yes', '--repo', '{R}']] },
  { name: '--fix --yes: planning repair (T020)', setup: (c) => { repoSc(c); init(c); writeFileSync(path.join(c.repo, '.planning/ROADMAP.md'), '# Roadmap\n\n- [ ] **Phase 1: One**\n- [x] **Phase 1: One**\n\n### Phase 1: One\n\n### Phase 2: Two\n'); }, runs: [['--fix', '--yes', '--repo', '{R}']] },
  { name: '--fix --yes: repair stale counters', setup: (c) => { repoSc(c); init(c); write(path.join(c.repo, '.planning/STATE.md'), '# Project State\n\n## Current Position\n\nPhase: 1 of 2\nProgress: [█████░░░░░] 50%\n'); }, runs: [['--fix', '--yes', '--repo', '{R}']] },
  { name: '--fix --yes: migrate (T090)', setup: (c) => { repoSc(c); mkdirSync(path.join(c.repo, 'scripts'), { recursive: true }); write(path.join(c.repo, 'scripts/gsd-premerge-check.sh'), '#!/bin/sh\nexit 0\n', 0o755); }, runs: [['--fix', '--yes', '--repo', '{R}']] },
  {
    name: 'update check: newer toolkit + gsd-core',
    setup: (c) => {
      repoSc(c);
      write(path.join(c.W, 'VERSION'), '1.18.0\n');
      write(path.join(c.W, 'net/curl'), `#!/bin/sh\necho '{"tag_name": "v99.0.0", "x": 1}'\n`, 0o755);
      write(path.join(c.W, 'net/npm'), '#!/bin/sh\necho 99.1.0\n', 0o755);
    },
    env: { GSD_NO_UPDATE_CHECK: null, XDG_CACHE_HOME: (c) => path.join(c.W, 'cache'), PATH: (c) => `${c.pkg}/bin:${c.W}/net:${c.stub}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
    expect: /99\.0\.0/,
  },
  {
    name: 'update check: current / ahead / unreachable',
    setup: (c) => {
      repoSc(c);
      write(path.join(c.W, 'VERSION'), '1.18.0\n');
      write(path.join(c.W, 'net/curl'), `#!/bin/sh\nprintf '{"tag_name": "v%s"}\\n' "$(cat ${c.pkg}/VERSION)"\n`, 0o755);
      write(path.join(c.W, 'net/npm'), '#!/bin/sh\necho 1.0.0\n', 0o755);
    },
    env: { GSD_NO_UPDATE_CHECK: null, XDG_CACHE_HOME: (c) => path.join(c.W, 'cache'), PATH: (c) => `${c.pkg}/bin:${c.W}/net:${c.stub}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
    expect: /latest release/,
  },
  {
    name: 'update check: nothing reachable',
    setup: (c) => {
      repoSc(c);
      write(path.join(c.W, 'VERSION'), '1.18.0\n');
      write(path.join(c.W, 'net/curl'), '#!/bin/sh\nexit 22\n', 0o755);
      write(path.join(c.W, 'net/npm'), '#!/bin/sh\nexit 1\n', 0o755);
    },
    env: { GSD_NO_UPDATE_CHECK: null, XDG_CACHE_HOME: (c) => path.join(c.W, 'cache'), PATH: (c) => `${c.pkg}/bin:${c.W}/net:${c.stub}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
    expect: /not reachable/,
  },
];

test('P5 doctor parity: old bash bin vs TypeScript command', { concurrency: 4 }, async (t) => {
  const all: Promise<void>[] = [];
  for (const sc of S) {
    if (only && !only.test(sc.name)) continue;
    all.push(t.test(sc.name, async () => {
      await check(sc);
    }));
  }
  await Promise.all(all);
});
