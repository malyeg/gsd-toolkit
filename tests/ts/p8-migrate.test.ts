// P8 parity (gsdt-migrate): the TypeScript command behind bin/gsdt-migrate against the
// pre-P8 bash command (tests/fixtures/p8-old-bins/gsdt-migrate), each on its own copy of
// the same fixture repo (a 0.9.0-style repo made by this release's bootstrap, then aged).
// Compared per step: stdout, stderr, exit code, and every file under the repo (content +
// mode), .git/config, the post-merge hook and the user's Claude settings. Only the two
// side roots are normalized.
// New-side-only (old bash needed python or crashed): see the last tests.
// Run: node --test tests/ts/p8-migrate.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { PKG } from './helpers.ts';

const W = realpathSync(mkdtempSync(path.join(tmpdir(), 'gsd-p8m-')));
process.on('exit', () => rmSync(W, { recursive: true, force: true }));

const OLD_BIN = path.join(PKG, 'tests', 'fixtures', 'p8-old-bins', 'gsdt-migrate');
const NEW_BIN = path.join(PKG, 'bin', 'gsdt-migrate');
const SHIMS = [
  'scripts/gsdt-new-worktree-feature.sh',
  'scripts/gsdt-finish-worktree-feature.sh',
  'scripts/gsdt-derive-port.sh',
  'scripts/gsdt-planning-repair.sh',
  'scripts/hooks/gsdt-worktree-guard.sh',
];
const oldOf = (s: string): string => s.replace('gsdt-', 'gsd-');

// An old-package directory: the old bin beside symlinks to this checkout's lib/ and shims/.
const OLDPKG = path.join(W, 'oldpkg');
mkdirSync(path.join(OLDPKG, 'bin'), { recursive: true });
writeFileSync(path.join(OLDPKG, 'bin', 'gsdt-migrate'), readFileSync(OLD_BIN));
chmodSync(path.join(OLDPKG, 'bin', 'gsdt-migrate'), 0o755);
symlinkSync(path.join(PKG, 'lib'), path.join(OLDPKG, 'lib'));
symlinkSync(path.join(PKG, 'shims'), path.join(OLDPKG, 'shims'));

type Side = { name: 'old' | 'new'; root: string; repo: string; home: string; settings: string };
const mkSide = (name: 'old' | 'new', tag: string): Side => {
  const root = path.join(W, `${tag}-${name}`);
  mkdirSync(root, { recursive: true });
  return { name, root, repo: path.join(root, 'proj'), home: path.join(root, 'home'), settings: path.join(root, 'user-settings.json') };
};

const baseEnv = (s: Side, extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return {
    ...env,
    HOME: s.home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    GSD_NO_UPDATE_CHECK: '1',
    GSD_NO_CORE: '1',
    GSD_CLAUDE_SKILL_DIR: path.join(s.root, 'skills'),
    GSD_CLAUDE_SETTINGS: s.settings,
    ...extra,
  };
};

const sh = (cwd: string, cmd: string, args: string[], env?: NodeJS.ProcessEnv): string => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: env ?? process.env });
  return r.stdout ?? '';
};
const gitEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: W,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};
const git = (cwd: string, ...a: string[]): string => sh(cwd, 'git', a, gitEnv);

// ── fixture: the 0.9.0-style repo (built once, copied per scenario) ─────────
const TPL = mkSide('new', 'tpl');
const BOOT = path.join(W, 'headpkg');

const age = (...files: string[]): void => {
  for (const f of files) {
    spawnSync(
      'perl',
      [
        '-pi',
        '-e',
        's/(?<![\\w\\/-])gsdt-(rules|flow-next|worktree-guard|wt-new|wt-finish|derive-port|planning-repair|bootstrap-repo|init|start|finish)(?![\\w-])/gsd-$1/g; s#scripts/(hooks/)?gsdt-#scripts/$1gsd-#g; s/gsd-toolkit shim/gsd-worktrees shim/',
        f,
      ],
    );
  }
};

before(() => {
  // The bootstrap comes from HEAD (bash), not the working tree: P8's other half edits it.
  mkdirSync(BOOT, { recursive: true });
  const ar = spawnSync('bash', ['-c', `git -C '${PKG}' archive HEAD | tar -x -C '${BOOT}'`]);
  assert.equal(ar.status, 0);
  symlinkSync(path.join(PKG, 'node_modules'), path.join(BOOT, 'node_modules'));
  const R = TPL.repo;
  mkdirSync(path.join(R, '.planning'), { recursive: true });
  git(path.dirname(R), 'init', '-q', '-b', 'main', R);
  writeFileSync(path.join(R, '.planning/ROADMAP.md'), '# Roadmap\n\n### Phase 1: One\n');
  writeFileSync(path.join(R, '.planning/STATE.md'), '# State\n');
  writeFileSync(path.join(R, '.planning/notes.md'), 'Run gsd-start -p 1, then gsd-finish.\n');
  writeFileSync(path.join(R, 'CLAUDE.md'), '# My project\n\nOur own text: run gsd-start for a phase.\n');
  git(R, 'add', '-A');
  git(R, 'commit', '-qm', 'init');
  const env = { ...baseEnv(TPL), PATH: `${BOOT}/bin:${process.env.PATH}` };
  const b = spawnSync(`${BOOT}/bin/gsdt-bootstrap-repo`, ['--agents', 'claude,codex'], { cwd: R, env, encoding: 'utf8' });
  assert.equal(b.status, 0, b.stdout + b.stderr);
  for (const rel of SHIMS) {
    age(path.join(R, rel));
    mkdirSync(path.dirname(path.join(R, oldOf(rel))), { recursive: true });
    spawnSync('mv', [path.join(R, rel), path.join(R, oldOf(rel))]);
  }
  age(path.join(R, '.claude/settings.json'), path.join(R, '.gsd/INSTRUCTIONS.md'), path.join(R, 'CLAUDE.md'), path.join(R, 'AGENTS.md'), path.join(R, '.git/hooks/post-merge'));
  git(R, 'config', 'merge.gsd-planning.driver', 'gsd-planning-merge %O %A %B %P');
  git(R, 'config', 'gsd-tracker.profile', 'acme');
  git(R, 'config', 'gsd-tracker.statusStart', 'in progress');
  git(R, 'config', 'gsd-tracker.emptyval', '');
  writeFileSync(path.join(R, 'scripts/gsd-premerge-check.sh'), "#!/bin/sh\n# the team's own checks\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    path.join(R, 'package.json'),
    '{"scripts":{"dev":"PORT=$(bash ../../scripts/gsd-derive-port.sh 3000) next dev","repair":"scripts/gsd-planning-repair.sh","é":"scripts/gsd-premerge-check.sh ü"}}\n',
  );
  writeFileSync(path.join(R, 'Makefile'), 'a:\n\t@scripts/gsd-premerge-check.sh\n\tscripts/hooks/gsd-worktree-guard.sh x\nb: # xscripts/gsd-derive-port.sh\n');
  git(R, 'add', '-A');
  git(R, 'commit', '-qm', 'gsd setup (0.9.0)');
});

const USER_HOOKS = `{
  "model": "opus",
  "hooks": {
    "PreToolUse": [{"matcher": "Skill", "hooks": [{"type": "command", "command": "[ ! -x '/u/bin/gsd-worktree-guard' ] || exec '/u/bin/gsd-worktree-guard' --global"}]}],
    "SessionStart": [{"hooks": [{"type": "command", "command": "[ ! -x '/u/bin/gsd-rules' ] || exec '/u/bin/gsd-rules' --hook"}, {"type": "command", "command": "echo mine"}]}]
  }
}
`;

// ── side-by-side machinery ──────────────────────────────────────────────────
type Opts = { cwd?: (s: Side) => string; env?: Record<string, string>; path?: string };
type Step = { args: string[] } & Opts;
const st = (args: string[], o: Opts = {}): Step => ({ args, ...o });

function snap(s: Side): string {
  const norm = (t: string): string => t.split(s.root).join('<S>');
  const lines: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.name === '.git' && rel === '') {
        lines.push(`.git/config: ${norm(readFileSync(path.join(p, 'config'), 'latin1'))}`);
        const hk = path.join(p, 'hooks/post-merge');
        if (existsSync(hk)) lines.push(`.git/hooks/post-merge: ${(lstatSync(hk).mode & 0o7777).toString(8)} ${norm(readFileSync(hk, 'latin1'))}`);
        lines.push(`lock: ${existsSync(path.join(p, 'gsd-cmd.lock'))}`);
        continue;
      }
      if (e.isDirectory()) walk(p, r);
      else if (e.isSymbolicLink()) lines.push(`${r}: -> ${norm(path.join(dir, e.name))}`);
      else lines.push(`${r}: ${(lstatSync(p).mode & 0o7777).toString(8)} ${norm(readFileSync(p, 'latin1'))}`);
    }
  };
  if (existsSync(s.repo)) walk(s.repo, '');
  for (const f of [s.settings, `${s.settings}.gsd-tmp`]) {
    if (existsSync(f)) lines.push(`USER ${path.basename(f)}: ${(lstatSync(f).mode & 0o7777).toString(8)} ${readFileSync(f, 'latin1')}`);
  }
  return lines.join('\n');
}

type Ran = { out: string; err: string; rc: number; files: string };
function runStep(s: Side, step: Step): Ran {
  const cwd = step.cwd ? step.cwd(s) : s.repo;
  const env = baseEnv(s, step.env);
  if (step.path !== undefined) env.PATH = step.path;
  const cmd = s.name === 'old' ? 'bash' : NEW_BIN;
  const args = s.name === 'old' ? [path.join(OLDPKG, 'bin', 'gsdt-migrate'), ...step.args] : step.args;
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: 60000 });
  const norm = (t: string): string => t.split(s.root).join('<S>');
  return { out: norm(r.stdout ?? ''), err: norm(r.stderr ?? ''), rc: r.status ?? -1, files: snap(s) };
}

type Setup = (s: Side) => void;
/** A fresh copy of the template repo (or whatever `repo` makes) on both sides, then the steps on both. */
function scenario(setup: Setup | null, steps: Step[], opts: { template?: boolean } = {}): Ran[] {
  const tag = `s${Math.random().toString(36).slice(2, 8)}`;
  const sides = [mkSide('old', tag), mkSide('new', tag)];
  for (const s of sides) {
    mkdirSync(s.home, { recursive: true });
    if (opts.template !== false) cpSync(TPL.repo, s.repo, { recursive: true, verbatimSymlinks: true });
    else {
      mkdirSync(s.repo, { recursive: true });
      git(s.repo, 'init', '-q', '-b', 'main');
      git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    }
    writeFileSync(s.settings, USER_HOOKS);
    setup?.(s);
  }
  const results: Ran[] = [];
  steps.forEach((step, i) => {
    const [a, b] = sides.map((s) => runStep(s, step)) as [Ran, Ran];
    const label = `step ${i} (${step.args.join(' ')})`;
    assert.equal(b.out, a.out, `${label}: stdout`);
    assert.equal(b.err, a.err, `${label}: stderr`);
    assert.equal(b.rc, a.rc, `${label}: rc`);
    assert.equal(b.files, a.files, `${label}: files`);
    results.push(b);
  });
  for (const s of sides) rmSync(s.root, { recursive: true, force: true });
  return results;
}

const addWt = (s: Side): void => {
  git(s.repo, 'worktree', 'add', '-q', path.join(s.root, 'proj-wt'), '-b', 'phase-1-one');
};

// ── tests ───────────────────────────────────────────────────────────────────
test('--help, usage errors, argument order', () => {
  const r = scenario(null, [
    st(['--help']),
    st(['-h']),
    st(['--apply', '-h']),
    st(['--bogus', '-h']),
    st(['-h', '--bogus']),
    st(['--bogus']),
    st(['--repo']),
    st(['--apply', '--repo']),
    st(['x']),
    st(['--repo', '/nonexistent/dir']),
    st(['--repo', '']),
  ]);
  assert.match(r[0]?.out ?? '', /^\ngsdt-migrate — move a repo to the gsdt-\* command names/);
  assert.equal(r[5]?.rc, 2);
  assert.match(r[6]?.err ?? '', /✖ --repo needs a directory/);
  assert.match(r[9]?.err ?? '', /✖ not a git repo: \/nonexistent\/dir/);
});

test('not a git repo (cwd outside, and --repo to a plain dir)', () => {
  const r = scenario(
    (s) => mkdirSync(path.join(s.root, 'plain')),
    [
      st([], { cwd: (s) => path.join(s.root, 'plain') }),
      st(['--check'], { cwd: (s) => path.join(s.root, 'plain') }),
      st(['--apply', '--repo', '.'], { cwd: (s) => path.join(s.root, 'plain') }),
      st(['--repo', 'plain'], { cwd: (s) => s.root }),
    ],
  );
  assert.equal(r[0]?.rc, 2);
});

test('the aged repo: dry run, --check, --apply, --check, second --apply, dry run', () => {
  const r = scenario(addWt, [
    st([]),
    st(['--check']),
    st(['--apply']),
    st(['--check']),
    st(['--apply']),
    st([]),
    st(['--apply', '--check']), // last mode wins
  ]);
  assert.equal(r[0]?.rc, 1);
  assert.match(r[0]?.out ?? '', /17 change\(s\)\. Nothing changed yet/);
  assert.equal(r[1]?.out, '');
  assert.equal(r[2]?.rc, 0);
  assert.match(r[2]?.out ?? '', /migrated to gsdt-\* \(17 change\(s\), not committed\)/);
  assert.match(r[0]?.out ?? '', /open worktree phase-1-one still has the old files/);
  assert.equal(r[3]?.rc, 0);
  assert.match(r[4]?.out ?? '', /nothing to migrate/);
  assert.match(r[0]?.out ?? '', /Makefile:2: /);
});

test('run from a subdirectory, from the open worktree, and with --repo', () => {
  scenario(addWt, [
    st([], { cwd: (s) => path.join(s.repo, '.planning') }),
    st([], { cwd: (s) => path.join(s.root, 'proj-wt') }),
    st(['--repo', 'proj-wt'], { cwd: (s) => s.root }),
    st(['--check', '--repo', 'proj'], { cwd: (s) => s.root }),
    st(['--apply', '--repo', 'proj-wt'], { cwd: (s) => s.root }),
    st(['--apply'], { cwd: (s) => path.join(s.root, 'proj-wt') }),
  ]);
});

test('an edited shim and two pre-merge scripts', () => {
  scenario(
    (s) => {
      const f = path.join(s.repo, 'scripts/gsd-derive-port.sh');
      writeFileSync(f, readFileSync(f, 'utf8').replace(/^(.*\n)(.*)\n/, '$1# our derive-port, changed\n'));
      writeFileSync(path.join(s.repo, 'scripts/gsdt-premerge-check.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    },
    [st([]), st(['--apply']), st(['--check']), st(['--apply'])],
  );
});

test('a shim with one line, an empty shim, an old-name worktree-less repo with the 0.9.0 header', () => {
  scenario(
    (s) => {
      writeFileSync(path.join(s.repo, 'scripts/gsd-derive-port.sh'), '#!/bin/sh\n');
      writeFileSync(path.join(s.repo, 'scripts/gsd-planning-repair.sh'), '');
    },
    [st([]), st(['--apply'])],
  );
});

test('refused apply paths: lock held by a dead pid (reclaimed), live pid does not matter for dry/check', () => {
  const lock = (pid: string) => (s: Side): void => {
    mkdirSync(path.join(s.repo, '.git/gsd-cmd.lock'));
    writeFileSync(path.join(s.repo, '.git/gsd-cmd.lock/pid'), `${pid}\n`);
  };
  const r = scenario(lock('999999'), [st(['--apply']), st(['--check'])]);
  assert.match(r[0]?.out ?? '', /reclaimed stale gsd lock \(owner PID 999999 no longer running\)/);
  // a live owner: dry run and --check never take the lock
  scenario(lock(String(process.pid)), [st([]), st(['--check'])]);
  // GSD_LOCK_HELD=1: apply does not look at the lock
  scenario(lock(String(process.pid)), [st(['--apply'], { env: { GSD_LOCK_HELD: '1' } })]);
});

test('providers in .gsd.conf: codex only, gemini mixed in, base and wtdir set', () => {
  for (const conf of [
    'providers = codex\n',
    'providers = gemini, codex, claude\n',
    'providers = claude,gemini\nbase = trunk\nwtdir = my-wts\n',
    'provider = codex\n',
    'providers = gemini\n',
  ]) {
    scenario((s) => writeFileSync(path.join(s.repo, '.gsd.conf'), conf), [st([]), st(['--apply']), st(['--check'])]);
  }
});

test('instruction blocks: broken markers, no block, old header, a CRLF file', () => {
  scenario(
    (s) => {
      const f = path.join(s.repo, 'CLAUDE.md');
      writeFileSync(f, readFileSync(f, 'utf8').replace(/<!-- gsd-toolkit:provider:end -->/, ''));
    },
    [st([]), st(['--apply']), st(['--check'])],
  );
  scenario(
    (s) => {
      const f = path.join(s.repo, 'AGENTS.md');
      writeFileSync(f, readFileSync(f, 'utf8').replace(/^## GSD worktrees \(.*$/m, '## GSD worktrees'));
    },
    [st([]), st(['--apply'])],
  );
  scenario(
    (s) => {
      const f = path.join(s.repo, 'CLAUDE.md');
      writeFileSync(f, readFileSync(f, 'utf8').replace(/\n/g, '\r\n'));
    },
    [st([]), st(['--apply'])],
  );
  scenario((s) => rmSync(path.join(s.repo, '.gsd/INSTRUCTIONS.md')), [st([]), st(['--apply'])]);
});

test('free text: more than eight lines, non-ASCII, marked block excluded', () => {
  scenario(
    (s) => {
      let t = '';
      for (let i = 0; i < 12; i++) t += `line ${i}: run gsd-start and /gsd-update then scripts/gsd-premerge-check.sh ä\n`;
      writeFileSync(path.join(s.repo, 'docs.md'), t);
      writeFileSync(path.join(s.repo, 'notes.txt'), 'a gsd-doctor b\nkeep/gsd-doctor\n--gsd-doctor\nx.gsd-doctor\nhooks/gsd-doctor\n');
      git(s.repo, 'add', '-A');
    },
    [st([]), st(['--apply'])],
  );
});

test('references: a binary file, CRLF lines, a file with no final newline, a tracked .md/.txt skipped', () => {
  scenario(
    (s) => {
      writeFileSync(path.join(s.repo, 'ci.yml'), 'run: scripts/gsd-derive-port.sh\r\nrun: scripts/hooks/gsd-worktree-guard.sh\r\nno-nl: a/scripts/gsd-planning-repair.sh x scripts/gsd-premerge-check.sh');
      writeFileSync(path.join(s.repo, 'bin.dat'), Buffer.from([0, 1, 2, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x73, 0x2f]));
      writeFileSync(path.join(s.repo, 'docs/readme.md'.replace('docs/', '')), 'scripts/gsd-derive-port.sh\n');
      writeFileSync(path.join(s.repo, 'x.sh'), '#!/bin/sh\nscripts/gsd-derive-port.sh-extra and -scripts/gsd-derive-port.sh\n', { mode: 0o750 });
      git(s.repo, 'add', '-A');
      git(s.repo, 'commit', '-qm', 'more');
    },
    [st([]), st(['--apply']), st(['--check'])],
  );
});

test('the post-merge hook: husky, a hook with bootstrap-repo, no hook', () => {
  scenario(
    (s) => {
      mkdirSync(path.join(s.repo, '.husky'));
      writeFileSync(path.join(s.repo, '.husky/post-merge'), '#!/bin/sh\ngsd-planning-repair\ngsd-bootstrap-repo x\nxgsd-planning-repair\ngsd-planning-repair-x\n', { mode: 0o755 });
    },
    [st([]), st(['--apply'])],
  );
  scenario((s) => rmSync(path.join(s.repo, '.git/hooks/post-merge')), [st([]), st(['--apply']), st(['--check'])]);
});

test('tracker keys: odd values, an existing new key wins', () => {
  scenario(
    (s) => {
      git(s.repo, 'config', 'gsdt-tracker.profile', 'already');
      git(s.repo, 'config', 'gsd-tracker.withspace', ' padded value ');
      git(s.repo, 'config', 'gsd-tracker.ünï', 'x');
    },
    [st([]), st(['--apply']), st(['--check'])],
  );
});

// ── settings JSON: the user's file and the repo hook ────────────────────────
const GUARD = "[ ! -x '/u/bin/gsd-worktree-guard' ] || exec '/u/bin/gsd-worktree-guard' --global";
const RULES = "[ ! -x '/u/bin/gsd-rules' ] || exec '/u/bin/gsd-rules' --hook";
const userVariants: Record<string, string> = {
  typical: USER_HOOKS,
  compact: `{"hooks":{"PreToolUse":[{"matcher":"Skill","hooks":[{"type":"command","command":${JSON.stringify(GUARD)}}]}]}}`,
  tabs: `{\n\t"a": 1,\n\t"hooks": {\n\t\t"SessionStart": [{"hooks": [{"command": ${JSON.stringify(RULES)}}]}]\n\t}\n}\n`,
  numbers: `{"n":[1,-0,1.0,1.50,1e5,1E-3,2.5e+22,123456789012345678901234567890,0.1,1e16,1e15,123456789.123456789,-1.5e-7,0.0001,0.00001,1e400,NaN,Infinity,-Infinity],"hooks":{"S":[{"hooks":[{"command":${JSON.stringify(RULES)}}]}]}}`,
  strings: `{"s":["é","\\u00e9","\\ud83d\\ude00","😀","\\u0001\\u007f\\u001f","a\\/b","\\b\\f\\n\\r\\t\\"\\\\","\\u2028"],"hooks":{"S":[{"hooks":[{"command":${JSON.stringify(RULES)}}]}]}}`,
  intkeys: `{"2":"b","1":"a","10":{"x":1},"hooks":{"S":[{"hooks":[{"command":${JSON.stringify(RULES)}}]}]},"b":[],"c":{},"d":[[],{}]}`,
  dupes: `{"hooks":{"S":[{"matcher":"m","hooks":[{"command":${JSON.stringify(RULES)}},{"command":${JSON.stringify(RULES.replace('gsd-', 'gsdt-'))}}]},{"matcher":"m","hooks":[{"command":${JSON.stringify(RULES)}}]},{"hooks":[{"command":${JSON.stringify(RULES)}}]},{"hooks":[{"command":${JSON.stringify(RULES.replace('gsd-', 'gsdt-'))}}]}]}}`,
  dupesNoMatcher: `{"hooks":{"S":[{"hooks":[{"command":"echo"},{"command":"echo"},{"command":${JSON.stringify(RULES)}},{"command":${JSON.stringify(RULES.replace('gsd-', 'gsdt-'))}}]}]}}`,
  emptyGroups: `{"hooks":{"S":[{"hooks":[]},{"hooks":[{"command":${JSON.stringify(RULES)}}]},{"matcher":"x"}],"T":[{"hooks":[]}],"U":"str","V":[3,null,{"hooks":"x"}]}}`,
  emptyGroupsNoChange: `{"hooks":{"S":[{"hooks":[]},{"hooks":[{"command":"echo"}]}]}}`,
  notOurs: `{"hooks":{"S":[{"hooks":[{"command":"gsd-rules run"},{"command":"gsd-worktree-guard check"},{"command":"gsd-rules --hook-x gsd-rules"},{"command":5},{"nocommand":1},"x"]}]}}`,
  multi: `{"hooks":{"S":[{"hooks":[{"command":"a gsd-rules --hook b gsd-rules c xgsd-rules d gsd-rules-x e é-gsd-rules f ügsd-rules g gsd-worktree-guard --global"}]}]}}`,
  matcherNum: `{"hooks":{"S":[{"matcher":1,"hooks":[{"command":${JSON.stringify(RULES)}}]},{"matcher":1.0,"hooks":[{"command":${JSON.stringify(RULES.replace('gsd-', 'gsdt-'))}}]}]}}`,
  invalid: '{"hooks": {',
  trailingComma: `{"hooks":{"S":[{"hooks":[{"command":${JSON.stringify(RULES)}}]}],}}`,
  topArray: '[1,2]',
  noHooks: '{"a":1}',
  hooksList: '{"hooks":[]}',
  empty: '',
  bom: `\uFEFF{"hooks":{"S":[{"hooks":[{"command":${JSON.stringify(RULES)}}]}]}}`,
  crlf: USER_HOOKS.replace(/\n/g, '\r\n'),
  rawControl: `{"hooks":{"S":[{"hooks":[{"command":"${RULES}\t"}]}]}}`,
  dupKeys: `{"a":1,"hooks":{"S":[{"hooks":[{"command":${JSON.stringify(RULES)}}]}]},"a":2}`,
  alreadyNew: USER_HOOKS.replace(/gsd-/g, 'gsdt-'),
};

test('user settings JSON variants (dry, apply, check; bytes compared)', () => {
  for (const [name, body] of Object.entries(userVariants)) {
    try {
      const r = scenario(
        (s) => writeFileSync(s.settings, body),
        [st([]), st(['--apply']), st(['--check']), st(['--apply'])],
        { template: false },
      );
      assert.ok(r.length === 4);
    } catch (e) {
      console.error(`# failing variant: ${name}`);
      throw e;
    }
  }
});

test('user settings: mode kept, symlinked file keeps its link, missing file, GSD_CLAUDE_SETTINGS unset (CLAUDE_CONFIG_DIR/HOME)', () => {
  scenario((s) => chmodSync(s.settings, 0o640), [st(['--apply'])], { template: false });
  scenario(
    (s) => {
      mkdirSync(path.join(s.root, 'dot'));
      writeFileSync(path.join(s.root, 'dot/real.json'), USER_HOOKS);
      rmSync(s.settings);
      symlinkSync(path.join(s.root, 'dot/real.json'), s.settings);
    },
    [st(['--apply']), st(['--apply'])],
    { template: false },
  );
  scenario((s) => rmSync(s.settings), [st([]), st(['--apply'])], { template: false });
  scenario(
    (s) => {
      mkdirSync(path.join(s.home, '.claude'), { recursive: true });
      writeFileSync(path.join(s.home, '.claude/settings.json'), USER_HOOKS);
    },
    [st([], { env: { GSD_CLAUDE_SETTINGS: '', GSD_CLAUDE_SKILL_DIR: '' } }), st(['--apply'], { env: { GSD_CLAUDE_SETTINGS: '', GSD_CLAUDE_SKILL_DIR: '' } })],
    { template: false },
  );
});

test('repo hook JSON variants (.claude/settings.json)', () => {
  const repoHook = (c: string): string => JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Skill', hooks: [{ type: 'command', command: c }] }] }, other: { é: 1.5 } }, null, 2);
  const variants = [
    repoHook('bash scripts/hooks/gsd-worktree-guard.sh'),
    repoHook('bash scripts/hooks/gsd-worktree-guard.sh; bash scripts/hooks/gsd-worktree-guard.sh'),
    repoHook('bash scripts/hooks/gsdt-worktree-guard.sh'),
    `{"hooks":{"PreToolUse":[{"matcher":"Skill","hooks":[{"command":"bash scripts/hooks/gsd-worktree-guard.sh"}]},{"matcher":"Skill","hooks":[{"command":"bash scripts/hooks/gsdt-worktree-guard.sh"}]}]}}`,
    '{broken',
  ];
  for (const v of variants) {
    scenario((s) => writeFileSync(path.join(s.repo, '.claude/settings.json'), v), [st([]), st(['--apply']), st(['--check'])]);
  }
});

test('an already migrated repo (the template, applied once, then copied): nothing to do', () => {
  scenario(
    (s) => {
      const r = spawnSync('bash', [path.join(OLDPKG, 'bin/gsdt-migrate'), '--apply'], { cwd: s.repo, env: baseEnv(s) });
      assert.equal(r.status, 0);
    },
    [st([]), st(['--check']), st(['--apply'])],
  );
  scenario(null, [st([]), st(['--check']), st(['--apply'])], { template: false });
});

// ── new side only ───────────────────────────────────────────────────────────
function noPythonPath(): string {
  const dir = path.join(W, 'nopy-bin');
  if (!existsSync(dir)) {
    mkdirSync(dir);
    const tools = ['git', 'perl', 'bash', 'sh', 'sed', 'grep', 'awk', 'tr', 'wc', 'head', 'tail', 'mktemp', 'cp', 'chmod', 'rm', 'mv', 'mkdir', 'dirname', 'basename', 'readlink', 'cat', 'ls', 'uname', 'env', 'sort', 'cut', 'find', 'node', 'date', 'id', 'stat', 'sleep', 'tee', 'xargs', 'ln', 'touch', 'diff', 'cmp', 'printf', 'test', 'expr', 'od', 'tar', 'gzip', 'shasum', 'sha256sum'];
    for (const t of tools) {
      const p = spawnSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
      if (p.startsWith('/')) symlinkSync(p, path.join(dir, t));
    }
  }
  return dir;
}

test('NEW ONLY: works with no python on PATH, same result as the old command with python', () => {
  const tag = `np${Math.random().toString(36).slice(2, 6)}`;
  const [o, n] = [mkSide('old', tag), mkSide('new', tag)];
  for (const s of [o, n]) {
    mkdirSync(s.home, { recursive: true });
    cpSync(TPL.repo, s.repo, { recursive: true, verbatimSymlinks: true });
    writeFileSync(s.settings, USER_HOOKS);
  }
  const np = noPythonPath();
  assert.equal(spawnSync('bash', ['-c', 'command -v python3 python'], { env: { PATH: np }, encoding: 'utf8' }).stdout, '');
  for (const args of [[], ['--check'], ['--apply'], ['--check']]) {
    const a = runStep(o, st(args));
    const b = runStep(n, st(args, { path: np }));
    assert.equal(b.out, a.out, `${args.join(' ')} stdout`);
    assert.equal(b.err, a.err, `${args.join(' ')} stderr`);
    assert.equal(b.rc, a.rc, `${args.join(' ')} rc`);
    assert.equal(b.files, a.files, `${args.join(' ')} files`);
  }
  // and the old command with no python refuses
  const old = spawnSync('bash', [path.join(OLDPKG, 'bin/gsdt-migrate'), '--check'], { cwd: o.repo, env: { ...baseEnv(o), PATH: np }, encoding: 'utf8' });
  assert.equal(old.status, 2);
  assert.match(old.stderr, /needs python 3\.7\+/);
  for (const s of [o, n]) rmSync(s.root, { recursive: true, force: true });
});

test('NEW ONLY: a matcher that is a list: same stdout/rc/files as old; old also printed a python traceback on stderr', () => {
  // old: python raises TypeError (unhashable key) → rc 1 → "nothing to change" for that file
  const body = `{"hooks":{"S":[{"matcher":["a"],"hooks":[{"command":${JSON.stringify(RULES)}}]}]}}`;
  const tag = `ml${Math.random().toString(36).slice(2, 6)}`;
  const [o, n] = [mkSide('old', tag), mkSide('new', tag)];
  for (const s of [o, n]) {
    mkdirSync(s.home, { recursive: true });
    mkdirSync(s.repo, { recursive: true });
    git(s.repo, 'init', '-q', '-b', 'main');
    git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    writeFileSync(s.settings, body);
  }
  for (const args of [[], ['--apply']]) {
    const a = runStep(o, st(args));
    const b = runStep(n, st(args));
    assert.equal(b.out, a.out);
    assert.equal(b.rc, a.rc);
    assert.equal(b.files, a.files);
    assert.match(a.err, /Traceback/);
    assert.equal(b.err, '');
    assert.match(b.out, /nothing to migrate/);
  }
  for (const s of [o, n]) rmSync(s.root, { recursive: true, force: true });
});

test('NEW ONLY: the package directory is read from the launcher path, even through a symlink', () => {
  const link = path.join(W, 'linked-migrate');
  symlinkSync(NEW_BIN, link);
  const s = mkSide('new', 'lnk');
  mkdirSync(s.home, { recursive: true });
  cpSync(TPL.repo, s.repo, { recursive: true, verbatimSymlinks: true });
  writeFileSync(s.settings, USER_HOOKS);
  const r = spawnSync(link, ['--apply'], { cwd: s.repo, env: baseEnv(s), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(path.join(s.repo, 'scripts/gsdt-derive-port.sh')));
  assert.equal(readFileSync(path.join(s.repo, 'scripts/gsdt-derive-port.sh'), 'utf8'), readFileSync(path.join(PKG, 'shims/scripts/gsdt-derive-port.sh'), 'utf8'));
  rmSync(s.root, { recursive: true, force: true });
});
