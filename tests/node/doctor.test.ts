// doctor.test.ts — node:test port of tests/test-doctor.sh: the gsdt-doctor checks added in 0.2.3
// (missing tools T005, stale skills T007, .gsd.conf typos and bad values T017/T018, a missing base
// branch T015, the pre-merge gate T019, duplicate phase headings T025, failed worktree installs T032,
// a ClickUp tracker with no token T073, worktree.baseRef T034, hooks that run a missing file T008, the
// reinstall command it names), and gsdt-setup keeping recorded agents (the old suite ran the 0.10.x
// copy installer here; gsdt-setup is its replacement).
// Everything runs in throwaway repos; HOME is a temp dir. Run: node --test tests/node/doctor.test.ts
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { rulesText } from '../../src/provider.ts';
import { PKG, WIN, count, exec, farm, fwd, git, gitOk, gitTry, gsdt, hostPath, joinPath, read, slashes, stubExe, tmp, winSkip, write } from './g2-helpers.ts';
import type { Env } from './g2-helpers.ts';

const WORK = tmp('gsd-doc-');
const HOME = path.join(WORK, 'home');
mkdirSync(HOME, { recursive: true });
const SKILLS = path.join(WORK, 'skills');
const CLICKUP = path.join(WORK, 'clickup.env');

// A stand-in gsd-core gsd_run so T005 only fires where a test removes it.
const STUB = path.join(WORK, 'stub');
const IDENT = '{"packageName":"@opengsd/gsd-core","version":"1.18.0"}';
stubExe(STUB, 'gsd_run', `echo '${IDENT}'`, `echo ${IDENT}`);
const BASEDIRS = [path.join(PKG, 'bin'), ...hostPath(), STUB];

// Per-run environment: a mutable layer the sections add to (GSD_CLAUDE_SETTINGS, …).
let DPATH: string | null = null; // a PATH that replaces the base one (the old DPATH)
const layer: Env = {};
const baseEnv = (): Env => ({
  HOME,
  USERPROFILE: HOME,
  XDG_CONFIG_HOME: path.join(HOME, '.config'),
  GSD_NO_CORE: '1',
  GSD_NO_UPDATE_CHECK: '1',
  GSD_CLAUDE_SKILL_DIR: SKILLS,
  GSD_CLICKUP_CONFIG: CLICKUP,
  PATH: DPATH ?? joinPath(BASEDIRS),
  ...layer,
});

let OUT = '';
const doc = (repoDir: string, env: Env = {}): void => {
  OUT = gsdt('doctor', ['--verbose', '--repo', repoDir], { env: { ...baseEnv(), ...env } }).out;
};
const json = (repoDir: string, env: Env = {}): void => {
  OUT = gsdt('doctor', ['--json', '--repo', repoDir], { env: { ...baseEnv(), ...env } }).out;
};
const doctorWith = (args: string[], repoDir: string, input = ''): void => {
  OUT = gsdt('doctor', [...args, '--repo', repoDir], { env: baseEnv(), input }).out;
};

const tail = (t: string, n = 8): string => t.split('\n').slice(-n).join('\n');
const has = (pat: string | RegExp, text: string = OUT): void => {
  const ok = typeof pat === 'string' ? text.includes(pat) : pat.test(text);
  assert.ok(ok, `no ${String(pat)} in:\n${tail(text)}`);
};
const hasnt = (pat: string | RegExp, text: string = OUT): void => {
  const ok = typeof pat === 'string' ? text.includes(pat) : pat.test(text);
  assert.ok(!ok, `unexpected ${String(pat)} in:\n${tail(text)}`);
};
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** has() for text holding paths: backslashes read as / on Windows. */
const hasP = (pat: string): void => has(fwd(pat), slashes(OUT));

const mkrepo = (dir: string): void => {
  gitOk(WORK, ['init', '-q', '-b', 'develop', dir]);
  write(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n### Phase 1: One\n\n### Phase 2: Two\n');
  write(path.join(dir, '.gsd.conf'), 'base = develop\n');
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '-qm', 'init']);
  gitOk(WORK, ['init', '-q', '--bare', `${dir}.origin.git`]);
  gitOk(dir, ['remote', 'add', 'origin', `${dir}.origin.git`]);
  gitOk(dir, ['push', '-q', '-u', 'origin', 'develop']);
};
const R = path.join(WORK, 'repo');
mkrepo(R);
const conf = (r: string, text: string): void => {
  writeFileSync(path.join(r, '.gsd.conf'), text);
};
const appendTo = (f: string, t: string): void => writeFileSync(f, read(f) + t);

describe('missing tools', () => {
  const NOSDK = path.join(WORK, 'nosdk'); // extra stubs first, then the host PATH without gsd_run / gsd-sdk
  it("gsd-core's gsd_run on PATH → no T005", () => {
    json(R);
    hasnt('"T005"');
  });
  it('no T006 (doctor no longer checks perl)', () => hasnt('"T006"'));
  it('no T003 (doctor no longer checks python)', () => hasnt('"T003"'));
  it('no GSD → T005', () => {
    mkdirSync(NOSDK, { recursive: true });
    DPATH = joinPath([NOSDK, farm(BASEDIRS, ['gsd_run', 'gsd-sdk'], path.join(WORK, 'nosdk-farm'))]);
    json(R);
    has('"T005"');
  });
  it('T005 names the gsd-core install', () => has('npx @opengsd/gsd-core@latest --claude --global'));
  it('the old GSD (gsd-sdk) is no GSD → T005', () => {
    stubExe(NOSDK, 'gsd-sdk', 'echo 1.42.3', 'echo 1.42.3');
    json(R);
    has('"T005"');
  });
  it('…and is never named', () => hasnt('get-shit-done'));
  it("a gsd_run that is not gsd-core's does not count", () => {
    stubExe(NOSDK, 'gsd_run', 'echo nope', 'echo nope');
    json(R);
    has('"T005"');
  });
  it('an npx install (~/.claude/gsd-core, nothing on PATH) counts', () => {
    rmSync(path.join(NOSDK, 'gsd_run'));
    rmSync(path.join(NOSDK, 'gsd_run.cmd'), { force: true });
    const d = path.join(HOME, '.claude', 'gsd-core', 'bin');
    mkdirSync(d, { recursive: true });
    cpSync(path.join(STUB, 'gsd_run'), path.join(d, 'gsd_run'));
    if (!WIN) chmodSync(path.join(d, 'gsd_run'), 0o755);
    doc(R);
    has(new RegExp(`gsd-core .*${esc(fwd(HOME))}/.claude/gsd-core/bin/gsd_run`), slashes(OUT));
    rmSync(path.join(HOME, '.claude', 'gsd-core'), { recursive: true, force: true });
    rmSync(path.join(NOSDK, 'gsd-sdk'), { force: true });
    rmSync(path.join(NOSDK, 'gsd-sdk.cmd'), { force: true });
  });
  // T009: gsd-core's skill profile (its installer writes <agent dir>/.gsd-profile)
  it('profile core → T009', () => {
    mkdirSync(path.join(HOME, '.claude'), { recursive: true });
    mkdirSync(path.join(HOME, '.codex'), { recursive: true });
    writeFileSync(path.join(HOME, '.claude', '.gsd-profile'), 'core\n');
    json(R);
    has('"T009"');
  });
  it('…with the reinstall that sets full', () => has('npx @opengsd/gsd-core@latest --claude --global --profile=full'));
  it('…a Codex profile counts only when codex is a provider', () => {
    writeFileSync(path.join(HOME, '.codex', '.gsd-profile'), 'core,audit\n');
    json(R);
    hasnt('gsd-core for codex');
  });
  it('profile full → no T009', () => {
    writeFileSync(path.join(HOME, '.claude', '.gsd-profile'), 'full\n');
    json(R);
    hasnt('"T009"');
  });
  it('a profile that includes full → no T009', () => {
    writeFileSync(path.join(HOME, '.claude', '.gsd-profile'), 'core,full\n');
    json(R);
    hasnt('"T009"');
  });
  it('no profile file (the default is full) → no T009', () => {
    rmSync(path.join(HOME, '.claude', '.gsd-profile'), { force: true });
    rmSync(path.join(HOME, '.codex', '.gsd-profile'), { force: true });
    json(R);
    hasnt('"T009"');
  });
});

describe('T009 by skills + the context section (lib/context.sh)', () => {
  const mkskill = (name: string, desc: string): void => {
    write(path.join(SKILLS, `gsd-${name}`, 'SKILL.md'), `---\nname: gsd-${name}\ndescription: "${desc}"\n---\nbody\n`);
  };
  it('gsd-core skills found: the flow\'s skills decide, not the profile name', () => {
    mkdirSync(SKILLS, { recursive: true });
    for (const s of ['new-project', 'ingest-docs', 'discuss-phase', 'plan-phase', 'review', 'execute-phase', 'code-review', 'verify-work', 'validate-phase', 'secure-phase', 'ui-phase', 'ui-review', 'sketch']) mkskill(s, `the ${s} step`);
    mkskill('new-milestone', 'start a milestone');
    mkskill('thread', 'a thread');
    mkskill('stats', 'numbers');
    writeFileSync(path.join(HOME, '.claude', '.gsd-profile'), 'core\n');
    json(R);
    hasnt('"T009"');
  });
  it('context: the skill count (16 gsd-* skills)', () => has('"name":"claude","skills":16,'));
  it('a flow skill missing → T009 names it', () => {
    rmSync(path.join(SKILLS, 'gsd-validate-phase'), { recursive: true, force: true });
    json(R);
    has('missing skills the phase flow runs: gsd-validate-phase');
  });
  it("…fix without gsd-core's group list: the installer", () => has('profile=full'));
  it('ui_gates = off: sketch is not needed', () => {
    rmSync(path.join(SKILLS, 'gsd-sketch'), { recursive: true, force: true });
    mkskill('validate-phase', 'back');
    conf(R, 'base = develop\nui_gates = off\n');
    json(R);
    hasnt('"T009"');
  });
  it('…with the UI gates on it is', () => {
    gitOk(R, ['checkout', '-q', '--', '.gsd.conf']);
    json(R);
    has('missing skills the phase flow runs: gsd-sketch');
  });
  it('context: gsd-* agents counted, others not', () => {
    mkskill('sketch', 'sketch');
    write(path.join(HOME, '.claude', 'agents', 'gsd-planner.md'), '---\nname: gsd-planner\ndescription: plans\ntools: Read\n---\nlong body\n');
    write(path.join(HOME, '.claude', 'agents', 'other.md'), '---\nname: other\ndescription: not ours\n---\n');
    json(R);
    has('"agents":1,');
  });
  it('hideable: a group with no flow skill', () => {
    write(
      path.join(HOME, '.claude', 'gsd-core', 'bin', 'lib', 'clusters.cjs'),
      `exports.CLUSTERS = Object.freeze({
  core_loop: ['plan-phase', 'execute-phase', 'help'],
  audit_review: ['validate-phase', 'audit-uat'],
  milestone: ['new-milestone', 'health'],
  workspace_state: ['thread'],
  docs: ['ingest-docs', 'docs-update'],
  empty_one: ['not-installed'],
  stats_group: ['stats'],
});
`,
    );
    json(R);
    has('"group":"milestone","skills":1,');
  });
  it('…another one', () => has('"group":"workspace_state","skills":1,'));
  it('…never a group holding a flow skill', () => hasnt('"group":"docs"'));
  it('…never a group with nothing installed', () => hasnt('"group":"empty_one"'));
  it('…a group already disabled is left out', () => {
    writeFileSync(path.join(HOME, '.claude', '.gsd-surface.json'), '{"baseProfile":"full","disabledClusters":["stats_group","audit_review"],"explicitAdds":[],"explicitRemoves":[]}\n');
    rmSync(path.join(SKILLS, 'gsd-validate-phase'), { recursive: true, force: true });
    json(R);
    hasnt('"group":"stats_group"');
  });
  it('T009 in a disabled group → /gsd-surface enable it', () => has('/gsd-surface enable audit_review'));
  it('text: no hint to hide skill groups (JSON only)', () => {
    doc(R);
    hasnt('/gsd-surface disable');
    mkskill('validate-phase', 'back');
    rmSync(path.join(HOME, '.claude', 'gsd-core'), { recursive: true, force: true });
    rmSync(path.join(HOME, '.claude', '.gsd-surface.json'), { force: true });
  });
  it('text: the cost line', () => {
    doc(R);
    has('claude: 16 gsd-core skills + 1 agents, ~');
  });
  it("text: Claude's own checks are named", () => has('run /doctor and /skill-doctor'));
  it('big_files: ROADMAP.md over 32 KiB', () => {
    let filler = '';
    for (let i = 0; i < 900; i++) filler += `filler line ${i} that is long enough to fill the roadmap up\n`;
    appendTo(path.join(R, '.planning', 'ROADMAP.md'), filler);
    json(R);
    has('"big_files":[{"path":".planning/ROADMAP.md"');
  });
  it('…fixed by /gsd-complete-milestone', () => has('gsd-complete-milestone'));
  it('…a note, never a finding', () => hasnt(/"message":"[^"]*KiB/));
  it('no gsd-core skills: no context entry', () => {
    gitOk(R, ['checkout', '-q', '--', '.planning/ROADMAP.md']);
    rmSync(SKILLS, { recursive: true, force: true });
    rmSync(path.join(HOME, '.claude', 'agents'), { recursive: true, force: true });
    rmSync(path.join(HOME, '.claude', '.gsd-profile'), { force: true });
    json(R);
    has('"context":{"agents":[]');
  });
  it('no perl → no T006 finding (intended change: nothing needs perl)', { skip: winSkip('hiding perl needs a PATH without it; Git for Windows ships perl in usr\\bin, next to sh') }, () => {
    DPATH = farm(BASEDIRS, ['perl'], path.join(WORK, 'noperl-farm'));
    json(R);
    hasnt('"T006"');
  });
  it('no perl → the roadmap check still runs (it is TypeScript now): its T022 finding shows', { skip: winSkip('needs the PATH without perl (see above)') }, () => {
    doc(R);
    has('Phase 1 has no checklist row');
  });
  it('…and is not skipped', { skip: winSkip('needs the PATH without perl (see above)') }, () => {
    hasnt('roadmap row check skipped');
    DPATH = null;
  });
});

describe('skills (T007)', () => {
  it('no skills → a note with the reinstall command', () => {
    DPATH = null;
    doc(R);
    has('claude skills not installed');
  });
  it('skills same as the toolkit → no T007', () => {
    cpSync(path.join(PKG, 'skills'), SKILLS, { recursive: true });
    appendTo(path.join(SKILLS, 'gsdt-flow', 'SKILL.md'), '<!-- gsd-toolkit-skill 0.0.0 -->\n');
    json(R);
    hasnt('"T007"');
  });
  it('an edited skill → T007', () => {
    appendTo(path.join(SKILLS, 'gsdt-flow', 'SKILL.md'), 'old step\n');
    json(R);
    has('"T007"');
  });
  it('T007 names the stale skill', () => has(/differ from this toolkit.*gsdt-flow/));
  it('a checkout reinstalls with its install.sh', () => has('install.sh --reuse-install-config --agent claude'));
  it('a release reinstalls with its install.sh and version', () => {
    // A release runtime has no .git: it re-runs its own install.sh for its version.
    const RT = path.join(WORK, 'runtime');
    mkdirSync(RT, { recursive: true });
    for (const n of ['bin', 'lib', 'src', 'shims', 'skills', 'install.sh', 'VERSION']) cpSync(path.join(PKG, n), path.join(RT, n), { recursive: true });
    const r = exec(process.execPath, [path.join(RT, 'src', 'launch.mjs'), 'doctor', '--json', '--repo', R], { env: { ...baseEnv(), PATH: joinPath([path.join(RT, 'bin'), ...hostPath(), STUB]) } });
    OUT = r.out;
    has(`install.sh --version ${read(path.join(PKG, 'VERSION')).trim()} --reuse-install-config`);
    rmSync(SKILLS, { recursive: true, force: true });
  });
});

describe('.gsd.conf (T017, T018)', () => {
  const bak = path.join(WORK, 'conf.bak');
  it('a clean .gsd.conf → no T017', () => {
    json(R);
    hasnt('"T017"');
  });
  it('a clean .gsd.conf → no T018', () => hasnt('"T018"'));
  it('an unknown key → T017', () => {
    writeFileSync(bak, read(path.join(R, '.gsd.conf')));
    appendTo(path.join(R, '.gsd.conf'), 'colour = red\nthis is not a setting\ntracker = none\nclaude_model = opus\n');
    json(R);
    has('unknown .gsd.conf key(s): colour');
  });
  it('a non key=value line → T017', () => has('1 line(s) that are not'));
  it('tracker and <provider>_model are known keys', () => hasnt(/key\(s\):[^"]*(tracker|claude_model)/));
  it('bad flow, flow_since and start_mode → 3× T018', () => {
    writeFileSync(path.join(R, '.gsd.conf'), read(bak));
    appendTo(path.join(R, '.gsd.conf'), 'flow = on\nflow_since = soon\nstart_mode = go\n');
    json(R);
    assert.equal(count(OUT, '"T018"'), 3);
    writeFileSync(path.join(R, '.gsd.conf'), read(bak));
  });
});

describe('base branch and origin (T015)', () => {
  const bak = path.join(WORK, 'conf.bak');
  it('a base branch that is nowhere → T015', () => {
    conf(R, 'base = nope\n');
    json(R);
    has("base branch 'nope' does not exist");
  });
  it('a base only on origin → T015 with the track command', () => {
    gitOk(R, ['branch', '-q', 'release']);
    gitOk(R, ['push', '-q', 'origin', 'release']);
    gitOk(R, ['branch', '-q', '-D', 'release']);
    conf(R, 'base = release\n');
    json(R);
    has('git branch --track release origin/release');
  });
  it('base present → no T015', () => {
    writeFileSync(path.join(R, '.gsd.conf'), read(bak));
    json(R);
    hasnt('"T015"');
  });
  const L = path.join(WORK, 'local');
  it('no origin → a note', () => {
    mkrepo(L);
    gitOk(L, ['remote', 'remove', 'origin']);
    doc(L);
    has("no 'origin' remote");
  });
  it('no origin is not a finding', () => {
    json(L);
    hasnt('origin remote');
  });
});

describe('pre-merge gate (T019)', () => {
  const script = path.join(R, 'scripts', 'gsdt-premerge-check.sh');
  const bak = path.join(WORK, 'conf.bak');
  it('a pre-merge script that is not executable → T019', { skip: winSkip('Windows has no executable bit to read: every file counts as executable') }, () => {
    write(script, '#!/bin/sh\nexit 0\n');
    if (!WIN) chmodSync(script, 0o644);
    json(R);
    has('is not executable');
  });
  it('executable → no T019', () => {
    write(script, '#!/bin/sh\nexit 0\n');
    if (!WIN) chmodSync(script, 0o755);
    json(R);
    hasnt('"T019"');
  });
  it('a premerge path that does not exist → T019', () => {
    appendTo(path.join(R, '.gsd.conf'), 'premerge = scripts/nope.sh\n');
    json(R);
    has('premerge = scripts/nope.sh, but that file does not exist');
  });
  it('premerge = none → no T019', () => {
    conf(R, 'base = develop\npremerge = none\n');
    json(R);
    hasnt('"T019"');
  });
  it('--json stays valid JSON when a finding holds a tab', () => {
    conf(R, 'base = develop\npremerge = scripts/a\tb.sh\n');
    json(R);
    assert.doesNotThrow(() => JSON.parse(OUT), tail(OUT, 3));
    writeFileSync(path.join(R, '.gsd.conf'), read(bak));
    rmSync(path.join(R, 'scripts'), { recursive: true, force: true });
  });
});

describe('duplicate phase headings (T025)', () => {
  const rm = path.join(R, '.planning', 'ROADMAP.md');
  const bak = path.join(WORK, 'roadmap.bak');
  it('Phase 2 and Phase 02 → T025', () => {
    writeFileSync(bak, read(rm));
    appendTo(rm, '\n### Phase 02: Two again\n');
    json(R);
    has('more than one heading for phase(s): 2');
  });
  it('one heading per phase → no T025', () => {
    writeFileSync(rm, read(bak));
    json(R);
    hasnt('"T025"');
  });
});

describe('bracket phase ids (T026)', () => {
  const cfg = path.join(R, '.planning', 'config.json');
  it('phase_id_convention = bracket → T026', () => {
    writeFileSync(cfg, '{\n  "phase_id_convention": "bracket"\n}\n');
    json(R);
    has('"T026"');
  });
  it('null (numbers) → no T026', () => {
    writeFileSync(cfg, '{\n  "phase_id_convention": null\n}\n');
    json(R);
    hasnt('"T026"');
    rmSync(cfg, { force: true });
  });
});

describe('worktree installs (T032)', () => {
  const W1 = path.join(WORK, 'phase-1-one');
  it('a failed install → T032', () => {
    gitOk(R, ['worktree', 'add', '-q', '-b', 'phase-1-one', W1]);
    writeFileSync(path.join(W1, '.gsd-install.status'), 'fail\n');
    json(R);
    has('dependency install failed in phase-1-one');
  });
  it('a running install is not a finding', () => {
    writeFileSync(path.join(W1, '.gsd-install.status'), 'running\n');
    json(R);
    hasnt('"T032"');
  });
  it('a running install is a note', () => {
    doc(R);
    has('install still running in phase-1-one');
    gitOk(R, ['worktree', 'remove', '--force', W1]);
  });
});

describe('ClickUp token (T073)', () => {
  const bak = path.join(WORK, 'conf.bak');
  const profileHome = path.join(HOME, '.config', 'gsd');
  const noCfg: Env = { GSD_CLICKUP_CONFIG: undefined };
  it('clickup with no token → T073', () => {
    appendTo(path.join(R, '.gsd.conf'), 'tracker = clickup\n');
    json(R);
    has('"T073"');
  });
  it('a token in the config file → no T073', () => {
    writeFileSync(CLICKUP, 'CLICKUP_API_TOKEN=pk_test\n');
    json(R);
    hasnt('"T073"');
  });
  it('a token in the env → no T073', () => {
    rmSync(CLICKUP, { force: true });
    json(R, { CLICKUP_API_TOKEN: 'pk_env' });
    hasnt('"T073"');
  });
  // A profile reads ~/.config/gsd/clickup-<profile>.env (GSD_CLICKUP_CONFIG unset, fake HOME).
  it('a profile ignores the shared token → T073', () => {
    appendTo(path.join(R, '.gsd.conf'), 'tracker_profile = acme\n');
    mkdirSync(profileHome, { recursive: true });
    writeFileSync(path.join(profileHome, 'clickup.env'), 'CLICKUP_API_TOKEN=pk_shared\n');
    json(R, noCfg);
    has('"T073"');
  });
  it("…naming the profile's file", () => has('clickup-acme.env'));
  it("the profile's token file → no T073", () => {
    writeFileSync(path.join(profileHome, 'clickup-acme.env'), 'CLICKUP_API_TOKEN=pk_acme\n');
    json(R, noCfg);
    hasnt('"T073"');
  });
  it('an env token notes that it hides the profile', () => {
    doc(R, { ...noCfg, CLICKUP_API_TOKEN: 'pk_env' });
    has(/profile .acme. .* is not used/);
  });
  it('a profile with a slash → T018', () => {
    writeFileSync(path.join(R, '.gsd.conf'), read(bak));
    appendTo(path.join(R, '.gsd.conf'), 'tracker = clickup\ntracker_profile = ../x\n');
    json(R);
    has('"T018"');
  });
  it('…and no unknown-key T017', () => {
    hasnt('"T017"');
    writeFileSync(path.join(R, '.gsd.conf'), read(bak));
  });
});

describe('flow debt: flow_skip leaves out single phases (T040)', () => {
  const S = path.join(WORK, 'skip');
  it('no flow_skip → 3 phases in debt', () => {
    mkrepo(S);
    for (const d of ['03-a', '04-b', '04.1-c']) mkdirSync(path.join(S, '.planning', 'phases', d), { recursive: true });
    writeFileSync(path.join(S, '.planning', 'ROADMAP.md'), '# Roadmap\n\n- [x] **Phase 3: A**\n- [x] **Phase 4: B**\n- [x] **Phase 4.1: C**\n\n### Phase 3: A\n\n### Phase 4: B\n\n### Phase 4.1: C\n');
    conf(S, 'base = develop\nflow = strict\n');
    gitOk(S, ['add', '-A']);
    gitOk(S, ['commit', '-qm', 'phases']);
    json(S);
    assert.equal(count(OUT, '"T040"'), 3);
  });
  it('flow_skip = 03, 4.1 → only phase 4 left', () => {
    conf(S, 'base = develop\nflow = strict\nflow_skip = 03, 4.1   # shipped before the rules\n');
    json(S);
    assert.equal(count(OUT, '"T040"'), 1);
  });
  it('…and it is phase 4', () => has('Phase 4 merged without'));
  it('…the missing test audit is part of the debt', () => has('validate'));
  it('…not once 04-VALIDATION.md is compliant', () => {
    write(path.join(S, '.planning', 'phases', '04-b', '04-VALIDATION.md'), '---\nnyquist_compliant: true\n---\n');
    json(S);
    hasnt(/merged without:[^"]*validate/);
    rmSync(path.join(S, '.planning', 'phases', '04-b', '04-VALIDATION.md'));
  });
  it('flow_skip is a known key', () => hasnt('"T017"'));
  it('skipped phases are listed as a note', () => {
    doc(S);
    has('not checked (flow_skip in .gsd.conf): 3 4.1');
  });
  it('a bad flow_skip entry → T018', () => {
    conf(S, 'base = develop\nflow = strict\nflow_skip = 3, four\n');
    json(S);
    has("flow_skip has 'four'");
  });
});

describe('instructions older than the toolkit (T016)', () => {
  const I = path.join(WORK, 'instr');
  const bootstrap = (): void => {
    gsdt('bootstrap-repo', ['--agents', 'claude,codex'], { cwd: I, env: baseEnv() });
  };
  const edit = (rel: string, fn: (t: string) => string): void => {
    const f = path.join(I, rel);
    writeFileSync(f, fn(read(f)));
  };
  const perLine = (t: string, fn: (l: string) => string): string => t.split('\n').map(fn).join('\n');
  it('fresh instructions pass', () => {
    mkrepo(I);
    bootstrap();
    gitOk(I, ['add', '-A']);
    gitOk(I, ['commit', '-qm', 'bootstrap']);
    doc(I);
    has('GSD instructions match this toolkit');
  });
  it('text outside the marked blocks is ignored', () => {
    appendTo(path.join(I, 'CLAUDE.md'), '\nMy own project notes.\n');
    json(I);
    hasnt('"T016"');
  });
  it('an old canonical block → T016', () => {
    edit('.gsd/INSTRUCTIONS.md', (t) => perLine(t, (l) => l.replace(/^- Run `gsdt-flow-next <N>` before every phase action/, '- Run `gsdt-flow-next <N>` before most phase actions')));
    json(I);
    has(/older than this toolkit.*INSTRUCTIONS.md/);
  });
  it('…an old provider block is named too', () => {
    edit('AGENTS.md', (t) => perLine(t, (l) => l.replace(/^Read and follow/, 'Please read and follow')));
    json(I);
    has('INSTRUCTIONS.md AGENTS.md');
  });
  it('--fix refreshes them', () => {
    doctorWith(['--fix', '--yes'], I);
    json(I);
    hasnt('"T016"');
  });
  it("…and keeps the user's own text", () => has('My own project notes.', read(path.join(I, 'CLAUDE.md'))));
  // A project set up before 0.8.0 (package gsd-worktrees, skill gsdw-flow):
  // its blocks still count as installed, but are out of date; gsdt-init
  // --no-launch rewrites them in place.
  it('pre-0.8.0 marker blocks → T016 for every file', () => {
    for (const f of ['.gsd/INSTRUCTIONS.md', 'CLAUDE.md', 'AGENTS.md']) edit(f, (t) => perLine(t, (l) => l.replace('<!-- gsd-toolkit:', '<!-- gsd-worktrees:').replace('gsdt-flow', 'gsdw-flow')));
    edit('CLAUDE.md', (t) => `Top note of mine.\n\n${t}`);
    json(I);
    has(/older than this toolkit.*INSTRUCTIONS.md CLAUDE.md AGENTS.md/);
  });
  it('…but they still count as installed (no T052)', () => hasnt('"T052"'));
  it('…(no T058)', () => hasnt('"T058"'));
  it('gsdt-init rewrites them → no T016', () => {
    bootstrap();
    json(I);
    hasnt('"T016"');
  });
  for (const f of ['.gsd/INSTRUCTIONS.md', 'CLAUDE.md', 'AGENTS.md']) {
    it(`…no old marker left in ${f}`, () => hasnt(/gsd-worktrees:|gsdw-flow/, read(path.join(I, f))));
  }
  it('…one provider block in CLAUDE.md', () => assert.equal(read(path.join(I, 'CLAUDE.md')).split('\n').filter((l) => l === '<!-- gsd-toolkit:provider:start -->').length, 1));
  it("…in the same place, the user's text around it kept", () => {
    const lines = read(path.join(I, 'CLAUDE.md')).replace(/\n$/, '').split('\n');
    assert.equal(`${lines[0]}:${lines[lines.length - 1]}`, 'Top note of mine.:My own project notes.');
  });
  it('ui_gates changed since the last gsdt-init → no T016 (gsdt-rules reads it live)', () => {
    conf(I, 'base = develop\nproviders = claude,codex\nui_gates = off\n');
    json(I);
    hasnt('"T016"');
  });
  // A repo set up before the split: its .gsd/INSTRUCTIONS.md holds the full
  // rules. It still works (the text is complete); T016 asks for one gsdt-init.
  it('a full block from before the split → T016', () => {
    const rules = rulesText('on');
    writeFileSync(
      path.join(I, '.gsd', 'INSTRUCTIONS.md'),
      `<!-- gsd-toolkit:canonical:start -->\n${rules}${rules.endsWith('\n') ? '' : '\n'}Providers: \`claude,codex\` (default: first, \`claude\`); base \`develop\`;\nworktrees \`../instr-worktrees/\`.\n<!-- gsd-toolkit:canonical:end -->\n`,
    );
    conf(I, 'base = develop\nproviders = claude,codex\n');
    json(I);
    has(/older than this toolkit.*INSTRUCTIONS.md/);
  });
  it('…one gsdt-init converts it (no T016)', () => {
    bootstrap();
    json(I);
    hasnt('"T016"');
  });
  it('…to the small block that points at gsdt-rules', () => has('run `gsdt-rules` and follow its output', read(path.join(I, '.gsd', 'INSTRUCTIONS.md'))));
  it('…without the full rules', () => hasnt('The shell commands are the source of truth', read(path.join(I, '.gsd', 'INSTRUCTIONS.md'))));
  it('flow changed since the last gsdt-init → no T016 (gsdt-rules reads it live)', () => {
    conf(I, 'base = develop\nproviders = claude,codex\nflow = strict\n');
    json(I);
    hasnt('"T016"');
  });
});

describe('Claude sessions load the rules (T062)', () => {
  const I = path.join(WORK, 'instr');
  const HS = path.join(WORK, 'rules-hook.json');
  const NOHOOK = path.join(WORK, 'nohook.json');
  const rulesBin = fwd(path.join(PKG, 'bin', 'gsdt-rules'));
  it('the hook is registered → pass', () => {
    writeFileSync(HS, `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `[ ! -x ${rulesBin} ] || exec ${rulesBin} --hook` }] }] } })}\n`);
    doc(I, { GSD_CLAUDE_SETTINGS: HS });
    has('Claude sessions load the toolkit rules');
  });
  it('…no T062', () => {
    json(I, { GSD_CLAUDE_SETTINGS: HS });
    hasnt('"T062"');
  });
  it('no SessionStart hook runs gsdt-rules → T062', () => {
    writeFileSync(NOHOOK, '{"hooks":{}}\n');
    json(I, { GSD_CLAUDE_SETTINGS: NOHOOK });
    has('"code":"T062","message":"no Claude SessionStart hook');
  });
  it('…a missing settings file too', () => {
    json(I, { GSD_CLAUDE_SETTINGS: path.join(WORK, 'nosuch.json') });
    has('"T062"');
  });
  it('…T062 adds no safe action', () => hasnt(/"safe":\[[^\]]*reinstall/));
  it('gsdt-rules not on PATH → T062', () => {
    const p = farm(BASEDIRS, ['gsdt-rules'], path.join(WORK, 'norules-farm'));
    json(I, { GSD_CLAUDE_SETTINGS: HS, PATH: p });
    has('"code":"T062","message":"gsdt-rules is not on PATH');
  });
  it('installed with --no-user-hook → no T062', () => {
    const od = path.join(WORK, 'optout');
    // a bin dir with gsdt-rules and the install manifest that says the user hook is off
    stubExe(od, 'gsdt-rules', `exec '${fwd(process.execPath)}' '${fwd(path.join(PKG, 'src', 'launch.mjs'))}' rules "$@"`, `"${process.execPath}" "${path.join(PKG, 'src', 'launch.mjs')}" rules %*`);
    writeFileSync(path.join(od, '.gsd-install-manifest'), 'providers\tclaude\nuser_hook\toff\n');
    json(I, { GSD_CLAUDE_SETTINGS: NOHOOK, PATH: joinPath([od, ...BASEDIRS]) });
    hasnt('"T062"');
  });
  it('…a note instead', () => has('installed with --no-user-hook'));
  it('Claude not configured → no T062', () => {
    conf(I, 'base = develop\nproviders = codex\n');
    json(I, { GSD_CLAUDE_SETTINGS: NOHOOK });
    hasnt('"T062"');
    conf(I, 'base = develop\nproviders = claude,codex\n');
  });
});

describe('doctor only reads', () => {
  it('the repo is unchanged', () => {
    const snap = (): string => `${git(R, ['status', '--porcelain']).stdout}${git(R, ['config', '--local', '--list']).stdout.split('\n').sort().join('\n')}`;
    const before = snap();
    DPATH = joinPath([path.join(WORK, 'nosdk'), farm(BASEDIRS, ['gsd_run', 'gsd-sdk'], path.join(WORK, 'nosdk-farm2'))]);
    doc(R);
    DPATH = null;
    assert.equal(snap(), before);
  });
});

describe('--fix runs only the safe fixes, after asking', () => {
  const F = path.join(WORK, 'fixme');
  const lock = path.join(F, '.git', 'gsd-cmd.lock');
  let headBefore = '';
  let originBefore = '';
  it('without --fix it points at --fix', () => {
    mkrepo(F);
    gitOk(F, ['branch', '-q', 'release']);
    gitOk(F, ['push', '-q', 'origin', 'release']);
    gitOk(F, ['branch', '-q', '-D', 'release']);
    conf(F, 'base = release\n');
    write(path.join(F, 'scripts', 'gsdt-premerge-check.sh'), '#!/bin/sh\nexit 0\n');
    if (!WIN) chmodSync(path.join(F, 'scripts', 'gsdt-premerge-check.sh'), 0o644);
    mkdirSync(lock, { recursive: true });
    writeFileSync(path.join(lock, 'pid'), '999999\n');
    gitOk(F, ['add', '-A']);
    gitOk(F, ['commit', '-qm', 'fixture']);
    headBefore = gitOk(F, ['rev-parse', 'HEAD']).trim();
    originBefore = gitOk(`${F}.origin.git`, ['rev-parse', 'develop']).trim();
    doc(F);
    has('gsdt-doctor --fix');
  });
  it('--fix lists what it would run', () => {
    doctorWith(['--fix'], F);
    has('--fix will run');
  });
  it('…no terminal: asks for --yes', () => has('add --yes'));
  it('…and changed nothing', () => assert.ok(existsSync(lock)));
  it('--yes: dead lock removed (T030)', () => {
    doctorWith(['--fix', '--yes'], F);
    assert.ok(!existsSync(lock), tail(OUT, 5));
  });
  it('--yes: base tracked from origin (T015)', () => assert.ok(gitTry(F, ['show-ref', '--verify', '--quiet', 'refs/heads/release'])));
  it('--yes: pre-merge script made executable (T019)', { skip: winSkip('Windows has no executable bit') }, () => {
    assert.ok((statSync(path.join(F, 'scripts', 'gsdt-premerge-check.sh')).mode & 0o111) !== 0);
  });
  it('--yes: gsdt-init ran (shims, T010)', () => assert.ok(existsSync(path.join(F, 'scripts', 'hooks', 'gsdt-worktree-guard.sh'))));
  it('--yes: nothing committed', () => assert.equal(gitOk(F, ['rev-parse', 'HEAD']).trim(), headBefore));
  it('--yes: nothing pushed', () => assert.equal(gitOk(`${F}.origin.git`, ['rev-parse', 'develop']).trim(), originBefore));
  it('…checks again after fixing', () => has('Checking again'));
  it('…and lists the changed files to review', () => has('not committed'));
  it('the safe findings are gone', () => {
    json(F);
    hasnt(/"T0(10|11|12|13|14|15|19|30)"/);
  });
  it('a lock with no pid yet is its own finding (T033)', () => {
    mkdirSync(lock, { recursive: true });
    writeFileSync(path.join(lock, 'pid'), '');
    json(F);
    has('"T033"');
  });
  it('…which --fix never removes (it may be a command starting)', () => {
    doctorWith(['--fix', '--yes'], F);
    assert.ok(existsSync(lock));
    rmSync(lock, { recursive: true, force: true });
  });
});

describe('--fix is offered only when a fix would change something', () => {
  const F = path.join(WORK, 'fixme');
  const state = path.join(F, '.planning', 'STATE.md');
  it("GSD's own STATE.md form → no --fix offer", () => {
    // F's findings left here have no safe fix, so the offer comes from STATE.md alone
    writeFileSync(state, '# Project State\n\n## Current Position\n\nPhase: 1 of 2\nProgress: [░░░░░░░░░░] 0%\n');
    doc(F);
    hasnt('safe to run for you');
  });
  it('…and no note about it', () => hasnt('progress bar recomputed'));
  it('a stale percent → a note', () => {
    writeFileSync(state, '# Project State\n\n## Current Position\n\nPhase: 1 of 2\nProgress: [█████░░░░░] 50%\n');
    doc(F);
    has('progress bar recomputed to 0%');
  });
  it('…and the --fix offer', () => has('safe to run for you'));
  it('a judgment finding (T025) is not auto-fixed', () => {
    rmSync(state);
    appendTo(path.join(F, '.planning', 'ROADMAP.md'), '\n### Phase 02: dup\n');
    doctorWith(['--fix', '--yes'], F);
    has('none of these findings has a safe automatic fix');
  });
  it("--fix and --json don't mix", () => {
    doctorWith(['--fix', '--json'], F);
    has("don't mix");
  });
  it('--yes alone is refused', () => {
    doctorWith(['--yes'], F);
    has('only goes with --fix');
  });
});

describe('worktree.baseRef (T034)', () => {
  const B = path.join(WORK, 'baseref');
  const BW = path.join(WORK, 'baseref-worktrees', 'phase-1-one');
  const local = (r: string): string => path.join(r, '.claude', 'settings.local.json');
  const baseref = (r: string): unknown => {
    try {
      return (JSON.parse(readFileSync(local(r), 'utf8')) as { worktree?: { baseRef?: unknown } }).worktree?.baseRef;
    } catch {
      return undefined;
    }
  };
  it('not set in the main checkout or a worktree → T034', () => {
    mkrepo(B);
    writeFileSync(path.join(B, '.gitignore'), '.claude/settings.local.json\n');
    gitOk(B, ['add', '-A']);
    gitOk(B, ['commit', '-qm', 'ignore']);
    gitOk(B, ['worktree', 'add', '-q', BW, '-b', 'phase-1-one']);
    write(local(B), '{"permissions":{"allow":["Bash(ls)"]}}\n');
    gitOk(B, ['worktree', 'add', '-q', path.join(B, '.claude', 'worktrees', 'agent-a1'), '-b', 'worktree-agent-a1']); // Claude's per-plan copy
    json(B);
    has('"T034"');
  });
  it('…naming both', () => {
    doc(B);
    has('not set (in: main checkout phase-1-one)');
  });
  it('…and the safe fix', () => has('gsdt-doctor --fix'));
  it("…not Claude's agent-* copies", () => hasnt('agent-a1'));
  it('--fix sets it in the main checkout', () => {
    doctorWith(['--fix', '--yes'], B);
    assert.equal(baseref(B), 'head');
  });
  it('…keeping the other keys', () => assert.equal((JSON.parse(readFileSync(local(B), 'utf8')) as { permissions: { allow: string[] } }).permissions.allow[0], 'Bash(ls)'));
  it('…and in the phase worktree', () => assert.equal(baseref(BW), 'head'));
  it('…which stays clean', () => assert.equal(git(BW, ['status', '--porcelain']).stdout.trim(), ''));
  it('…and an agent-* copy is left alone', () => assert.ok(!existsSync(local(path.join(B, '.claude', 'worktrees', 'agent-a1')))));
  it('…and T034 is gone', () => {
    json(B);
    hasnt('"T034"');
  });
  it("another value is the user's choice: no finding", () => {
    writeFileSync(local(BW), '{"worktree":{"baseRef":"origin"}}\n');
    json(B);
    hasnt('"T034"');
  });
  it('…only a note', () => has('baseRef = \\"origin\\" in phase-1-one'));
  it('a file that is not JSON → T034', () => {
    writeFileSync(local(BW), '{ "worktree": ');
    json(B);
    has('"T034"');
  });
  it('set in ~/.claude/settings.json → no finding (gsd-core reads it too)', () => {
    rmSync(local(BW));
    write(path.join(HOME, '.claude', 'settings.json'), '{"worktree":{"baseRef":"head"}}\n');
    json(B);
    hasnt('"T034"');
    rmSync(path.join(HOME, '.claude', 'settings.json'));
  });
});

describe('GSD hooks that run a missing file (T008)', () => {
  const HK = path.join(WORK, 'hk');
  const CLAUDE_SETTINGS = path.join(HK, 'claude.json');
  const CODEX_HOOKS = path.join(HK, 'codex.json');
  const hk = fwd(HK);
  /** one settings object holding a hook for `event` that runs `command` */
  const hook = (event: string, command: string): string => `${JSON.stringify({ hooks: { [event]: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } })}\n`;
  const setClaude = (text: string): void => writeFileSync(CLAUDE_SETTINGS, text);
  it('a GSD hook whose files exist → no T008', () => {
    mkdirSync(path.join(HK, 'bin'), { recursive: true });
    mkdirSync(path.join(R, '.claude'), { recursive: true });
    layer.GSD_CLAUDE_SETTINGS = CLAUDE_SETTINGS;
    layer.GSD_CODEX_HOOKS = CODEX_HOOKS;
    writeFileSync(path.join(HK, 'bin', 'node'), '');
    writeFileSync(path.join(HK, 'gsd-context-monitor.js'), '');
    setClaude(hook('PostToolUse', `"${hk}/bin/node" "${hk}/gsd-context-monitor.js"`));
    json(R);
    hasnt('"T008"');
  });
  it('a GSD hook on a node that is gone → T008', () => {
    setClaude(hook('PostToolUse', `"${hk}/old/node" "${hk}/gsd-context-monitor.js"`));
    json(R);
    has('"T008"');
  });
  it('T008 names the file and the missing path', () => hasP(`1 GSD hook(s) in ${CLAUDE_SETTINGS} run a missing file: ${HK}/old/node`));
  it('a missing node → says why', () => has('a Node upgrade moved it'));
  it("a gone node → gsd-core's installer (it rewrites its hooks)", () => has('npx @opengsd/gsd-core@latest --claude --global'));
  it('a hook that is not GSD\'s is left alone', () => {
    setClaude(hook('PostToolUse', '/Applications/Gone.app/cc-status'));
    json(R);
    hasnt('"T008"');
  });
  it('a path inside another $VARIABLE is not guessed at', () => {
    setClaude(hook('PostToolUse', `"$NODE_HOME/node" "${hk}/gsd-context-monitor.js"`));
    json(R);
    hasnt('"T008"');
  });
  // gsd-core finds node at run time: a stale saved path there is not broken.
  it('a node picked at run time (gsd-core) → no T008', () => {
    setClaude(hook('PostToolUse', `"$(for n in "${hk}/old/node" "$(command -v node)" ${hk}/no/node; do [ -x "$n" ] && printf '%s' "$n" && break; done)" "${hk}/gsd-context-monitor.js"`));
    json(R);
    hasnt('"T008"');
  });
  it('…but its gsd-* script gone → T008', () => {
    setClaude(hook('PostToolUse', `"$(for n in "${hk}/bin/node"; do printf '%s' "$n"; done)" "${hk}/gone/gsd-context-monitor.js"`));
    json(R);
    hasP(`run a missing file: ${HK}/gone/gsd-context-monitor.js`);
  });
  it('our --global guard gone → T008', () => {
    setClaude(hook('PreToolUse', `[ ! -x '${hk}/gone/gsdt-worktree-guard' ] || exec '${hk}/gone/gsdt-worktree-guard' --global`));
    json(R);
    has('"T008"');
  });
  it('…counted once, though named twice', () => has('1 GSD hook(s)'));
  it('…fixed by reinstalling the toolkit, not GSD', () => hasnt('gsd-core@latest --claude'));
  it('…with the reinstall command', () => has('install.sh --reuse-install-config'));
  it('a status line on missing files → T008, --force-statusline (the installer keeps one otherwise)', () => {
    rmSync(CLAUDE_SETTINGS);
    setClaude(`${JSON.stringify({ statusLine: { type: 'command', command: `"${hk}/old/node" "${hk}/gsd-statusline.js"` } })}\n`);
    json(R);
    has('npx @opengsd/gsd-core@latest --claude --global --force-statusline');
  });
  it('…both missing files listed', () => hasP(`${HK}/old/node, ${HK}/gsd-statusline.js`));
  it('a Codex hooks.json → T008 for codex', () => {
    rmSync(CLAUDE_SETTINGS);
    writeFileSync(CODEX_HOOKS, hook('SessionStart', `"${hk}/bin/node" "${hk}/gsd-check-update.js"`));
    json(R);
    has('npx @opengsd/gsd-core@latest --codex --global');
  });
  it('a repo-level GSD hook on a missing file → T008, local fix', () => {
    rmSync(CODEX_HOOKS);
    writeFileSync(path.join(R, '.claude', 'settings.json'), hook('PreToolUse', 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/gsd-read-guard.js"'));
    json(R);
    has('npx @opengsd/gsd-core@latest --claude --local');
  });
  it('…$CLAUDE_PROJECT_DIR read as the repo', () => hasP(`${WIN ? realpathSync.native(R) : R}/.claude/hooks/gsd-read-guard.js`)); // doctor's repo is git's spelling: long names on Windows
  it('settings that are not JSON → skipped, no crash', () => {
    writeFileSync(path.join(R, '.claude', 'settings.json'), 'not json');
    json(R);
    hasnt('"T008"');
    rmSync(path.join(R, '.claude'), { recursive: true, force: true });
  });
  it('gsdt-list warns at a terminal', () => {
    setClaude(hook('PostToolUse', `"${hk}/old/node" "${hk}/gsd-context-monitor.js"`));
    OUT = gsdt('list', ['--repo', R], { env: { ...baseEnv(), GSD_UPDATE_NOTICE: 'always' } }).out;
    hasP(`⚠ 1 GSD hook(s) in ${CLAUDE_SETTINGS} run a file that is gone`);
  });
  it('…and stays quiet when piped', () => {
    OUT = gsdt('list', ['--repo', R], { env: baseEnv() }).out;
    hasnt('⚠');
    rmSync(CLAUDE_SETTINGS, { force: true });
    delete layer.GSD_CLAUDE_SETTINGS;
    delete layer.GSD_CODEX_HOOKS;
  });
});

describe('gsdt-setup keeps recorded agents', () => {
  const IB = path.join(WORK, 'ibin');
  const CODEX_SK = path.join(WORK, 'codex-skills');
  const CLAUDE_SK = path.join(WORK, 'claude-skills');
  const XDG = path.join(WORK, 'xdg-setup');
  let prov = '';
  const setup = (args: string[]): string => {
    const env: Env = { ...baseEnv(), XDG_CONFIG_HOME: XDG, GSD_BIN_DIR: IB, GSD_CODEX_SKILL_DIR: CODEX_SK, GSD_CLAUDE_SKILL_DIR: CLAUDE_SK, GSD_SETUP_MODE: 'npm' };
    const r = gsdt('setup', args, { env });
    return r.out;
  };
  it('claude is kept', () => {
    // the hooks run the commands from the bin dir, so it holds this package's guard
    mkdirSync(IB, { recursive: true });
    for (const n of ['gsdt-worktree-guard', 'gsdt-rules']) {
      const cmd = n === 'gsdt-rules' ? 'rules' : 'worktree-guard';
      stubExe(IB, n, `exec '${fwd(process.execPath)}' '${fwd(path.join(PKG, 'src', 'launch.mjs'))}' ${cmd} "$@"`, `"${process.execPath}" "${path.join(PKG, 'src', 'launch.mjs')}" ${cmd} %*`);
    }
    const first = setup(['--agent', 'claude']);
    const second = setup(['--agent', 'codex']);
    const m = read(path.join(XDG, 'gsd', 'setup-manifest')).split('\n').find((l) => l.startsWith('providers\t')) ?? '';
    prov = m.split('\t')[1] ?? '';
    assert.ok(`,${prov},`.includes(',claude,'), `providers: ${prov}\n${first}\n${second}`);
  });
  it('codex is added', () => assert.ok(`,${prov},`.includes(',codex,'), `providers: ${prov}`));
  it('codex skills installed', () => assert.ok(existsSync(path.join(CODEX_SK, 'gsdt-flow', 'SKILL.md'))));
});
