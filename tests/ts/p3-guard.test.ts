// P3a parity (worktree guard): src/guard.ts behind the launcher bin/gsdt-worktree-guard
// against the pre-P3 bash guard (tests/fixtures/p3-old-bins/gsdt-worktree-guard,
// run next to a copy of lib/). Same inputs side by side: stdout, stderr and the
// exit status must match byte for byte.
// Run: node --test 'tests/ts/*.test.ts'
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { guard, guardArgv, parseArgs } from '../../src/guard.ts';
import { main as guardMain } from '../../src/commands/worktree-guard.ts';
import { PKG, repo, sh, tmp, write } from './helpers.ts';

const NEW = path.join(PKG, 'bin', 'gsdt-worktree-guard');
const OLD_SRC = path.join(PKG, 'tests', 'fixtures', 'p3-old-bins', 'gsdt-worktree-guard');

/** a package dir with the OLD guard next to a copy of lib/ (it sources lib/common.sh, lib/ui.sh and runs lib/gsd_hook_payload.py) */
function oldPackage(): string {
  const d = path.join(tmp(), 'old-pkg');
  mkdirSync(path.join(d, 'bin'), { recursive: true });
  cpSync(path.join(PKG, 'lib'), path.join(d, 'lib'), { recursive: true });
  copyFileSync(OLD_SRC, path.join(d, 'bin', 'gsdt-worktree-guard'));
  chmodSync(path.join(d, 'bin', 'gsdt-worktree-guard'), 0o755);
  return path.join(d, 'bin', 'gsdt-worktree-guard');
}
const OLD = oldPackage();

type R = { out: string; err: string; rc: number };
type Case = { label: string; argv: string[]; stdin: string; cwd: string; env: Record<string, string | undefined>; pathDirs?: string; rcOnly?: boolean };

function runAsync(bin: string, c: Case): Promise<R> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, ...c.env };
    if (c.pathDirs !== undefined) env.PATH = c.pathDirs;
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const p = spawn(bin, c.argv, { cwd: c.cwd, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    p.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    p.stdin.on('error', () => {}); // the guard may exit before reading
    p.on('close', (rc) => resolve({ out, err, rc: rc ?? 1 }));
    p.stdin.end(c.stdin);
  });
}

/** run every case on both guards (8 at a time) and report all mismatches together */
async function runAll(cases: Case[]): Promise<void> {
  const bad: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < cases.length) {
        const c = cases[next++] as Case;
        const [o, n] = await Promise.all([runAsync(OLD, c), runAsync(NEW, c)]);
        if (c.rcOnly ? o.rc !== n.rc : o.out !== n.out || o.err !== n.err || o.rc !== n.rc) {
          bad.push(`${c.label}\n  old: rc=${o.rc} out=${JSON.stringify(o.out)} err=${JSON.stringify(o.err)}\n  new: rc=${n.rc} out=${JSON.stringify(n.out)} err=${JSON.stringify(n.err)}`);
        }
      }
    }),
  );
  assert.equal(bad.length, 0, `${bad.length} of ${cases.length} cases differ:\n${bad.join('\n')}`);
}

type Add = (label: string, argv: string[], opts?: { stdin?: string; cwd?: string; env?: Record<string, string | undefined>; pathDirs?: string; rcOnly?: boolean }) => void;
function group(name: string, build: (add: Add, cases: Case[]) => void): void {
  test(name, async () => {
    const cases: Case[] = [];
    const add: Add = (label, argv, o = {}) =>
      cases.push({ label, argv, stdin: o.stdin ?? '', cwd: o.cwd ?? tmp(), env: o.env ?? {}, pathDirs: o.pathDirs, rcOnly: o.rcOnly });
    build(add, cases);
    await runAll(cases);
  });
}

// ── payloads ────────────────────────────────────────────────────────────────
const skill = (name: unknown, args: unknown, cwd?: unknown): string => JSON.stringify({ tool_name: 'Skill', tool_input: { skill: name, args }, ...(cwd === undefined ? {} : { cwd }) });
const upe = (name: unknown, args: unknown, cwd?: unknown): string =>
  JSON.stringify({ hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command', command_name: name, command_args: args, ...(cwd === undefined ? {} : { cwd }) });

// ── fixtures ────────────────────────────────────────────────────────────────
const git = (cwd: string, ...a: string[]): string => sh(cwd, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a]);

/** A set-up repo (develop + .gsd.conf) on `branch`, with files (relative path → content). */
function mk(opts: { conf?: string | null; branch?: string; files?: Record<string, string>; dir?: string } = {}): string {
  const conf = opts.conf === undefined ? 'base = develop\ninstall = none\n' : opts.conf;
  const d = repo(opts.dir, conf ?? undefined);
  if (opts.branch) git(d, 'checkout', '-q', '-b', opts.branch);
  for (const [f, c] of Object.entries(opts.files ?? {})) write(path.join(d, f), c);
  return d;
}

const FEATURE = ['gsd-flow', 'gsd-review', 'gsd-discuss-phase', 'gsd-plan-phase', 'gsd-execute-phase', 'gsd-ui-phase', 'gsd-mvp-phase', 'gsd-spec-phase', 'gsd-ai-integration-phase', 'gsd-verify-work', 'gsd-secure-phase', 'gsd-validate-phase', 'gsd-code-review', 'gsd-add-tests', 'gsd-extract-learnings', 'gsd-ui-review', 'gsd-eval-review'];
const OTHER = ['gsd-progress', 'gsd-map-codebase', 'review', 'gsd-'];
const VALID = '---\nnyquist_compliant: true\nwave_0_complete: true\n---\n';

// ── usage, escape hatch, argv ───────────────────────────────────────────────
group('usage errors, --help and the escape hatch', (add) => {
  const r = mk({ branch: 'phase-7-x' });
  for (const argv of [
    ['--command'], ['--command', ''], ['--args'], ['--args', ''], ['--repo'], ['--phase'], ['--phase', ''], ['--phase', 'abc'], ['--phase', '7.1.2'], ['--phase', '-7'], ['--phase', '7a'],
    ['--phase', '7\nx'], ['--phase', 'x\n7'], ['--bogus'], ['-x'], ['positional'], ['--help'], ['-h'], ['--bogus', '--help'], ['--help', '--bogus'], ['--global', '--help'],
    ['--command', 'gsd-plan-phase', '--phase', 'x'], ['--command', 'gsd-plan-phase', '--bogus'], ['--GLOBAL'], ['--command=gsd-plan-phase'],
  ]) {
    add(`argv ${JSON.stringify(argv)}`, argv, { stdin: skill('gsd-plan-phase', '7', r), env: { CLAUDE_PROJECT_DIR: r } });
  }
  for (const env of [{ GSD_SKIP_GUARD: '1' }, { GSD_SKIP_GUARD: '0' }, { GSD_SKIP_GUARD: '' }, { GSD_SKIP_GUARD: 'yes' }]) {
    add(`skip=${env.GSD_SKIP_GUARD} bogus`, ['--bogus'], { env });
    add(`skip=${env.GSD_SKIP_GUARD} base feature work`, ['--command', 'gsd-plan-phase', '--repo', mk({ conf: 'base = develop\ninstall = none\n' })], { env });
  }
  add('skip=1 with a bad payload', [], { stdin: 'not json', env: { GSD_SKIP_GUARD: '1' } });
});

group('explicit --command / --args / --phase / --repo', (add) => {
  const r7 = mk({ branch: 'phase-7-thing', files: { '.planning/phases/07-thing/.keep': '' } });
  const base = mk();
  for (const [lab, argv] of [
    ['--phase 7 matching', ['--command', 'gsd-plan-phase', '--phase', '7', '--repo', r7]],
    ['--phase 8 other', ['--command', 'gsd-plan-phase', '--phase', '8', '--repo', r7]],
    ['--phase 07 padded', ['--command', 'gsd-plan-phase', '--phase', '07', '--repo', r7]],
    ['--phase 7.0', ['--command', 'gsd-plan-phase', '--phase', '7.0', '--repo', r7]],
    ['--phase twice', ['--command', 'gsd-plan-phase', '--phase', '7', '--phase', '8', '--repo', r7]],
    ['--args then --phase', ['--command', 'gsd-plan-phase', '--args', '--prd x', '--phase', '7', '--repo', r7]],
    ['--phase then --args overwrites', ['--command', 'gsd-plan-phase', '--phase', '9', '--args', '7', '--repo', r7]],
    ['--phase=7 in args', ['--command', 'gsd-plan-phase', '--args', '--phase=7', '--repo', r7]],
    ['--phase=8 in args', ['--command', 'gsd-plan-phase', '--args', '--phase=8', '--repo', r7]],
    ['leading slash', ['--command', '/gsd-plan-phase', '--phase', '7', '--repo', r7]],
    ['double slash', ['--command', '//gsd-plan-phase', '--phase', '7', '--repo', r7]],
    ['namespaced', ['--command', 'gsd:plan-phase', '--phase', '8', '--repo', r7]],
    ['plugin', ['--command', 'gsd-core:gsd-plan-phase', '--phase', '8', '--repo', r7]],
    ['plugin namespaced', ['--command', 'gsd-core:gsd:plan-phase', '--phase', '8', '--repo', r7]],
    ['a:b:gsd-x', ['--command', 'a:b:gsd-plan-phase', '--phase', '8', '--repo', r7]],
    ['gsdt-flow', ['--command', 'gsdt-flow', '--phase', '8', '--repo', r7]],
    ['gsdw-flow', ['--command', 'gsdw-flow', '--phase', '8', '--repo', r7]],
    ['gsdt-flow base', ['--command', 'gsdt-flow', '--phase', '8', '--repo', base]],
    ['gsd-flow base no N', ['--command', 'gsd-flow', '--repo', base]],
    ['plan-phase base no N', ['--command', 'gsd-plan-phase', '--repo', base]],
    ['not gsd', ['--command', 'plan-phase', '--phase', '8', '--repo', r7]],
    ['global + explicit', ['--global', '--command', 'gsd-plan-phase', '--phase', '8', '--repo', r7]],
  ] as [string, string[]][]) add(lab, argv);
  // the explicit command ignores stdin and CLAUDE_PROJECT_DIR is beaten by --repo
  add('--command ignores stdin', ['--command', 'gsd-progress'], { stdin: 'not json' });
  add('--repo beats CLAUDE_PROJECT_DIR', ['--command', 'gsd-plan-phase', '--phase', '8', '--repo', r7], { env: { CLAUDE_PROJECT_DIR: base } });
  add('CLAUDE_PROJECT_DIR beats cwd', ['--command', 'gsd-plan-phase', '--phase', '8'], { env: { CLAUDE_PROJECT_DIR: r7 }, cwd: base });
  add('cwd is the repo', ['--command', 'gsd-plan-phase', '--phase', '8'], { cwd: r7 });
  add('cwd is a subdir of the repo', ['--command', 'gsd-plan-phase', '--phase', '8'], { cwd: path.join(r7, '.planning') });
  add('empty CLAUDE_PROJECT_DIR falls to cwd', ['--command', 'gsd-plan-phase', '--phase', '8'], { env: { CLAUDE_PROJECT_DIR: '' }, cwd: r7 });
  add('repo is not a directory', ['--command', 'gsd-plan-phase', '--phase', '8', '--repo', path.join(tmp(), 'nope')]);
  add('repo is not a directory, no N', ['--command', 'gsd-plan-phase', '--repo', path.join(tmp(), 'nope')]);
  add('relative --repo', ['--command', 'gsd-plan-phase', '--phase', '8', '--repo', '.'], { cwd: r7 });
  add('plain dir no repo, new-project', ['--command', 'gsd-new-project', '--repo', tmp()]);
  add('plain dir no repo, global feature', ['--global', '--command', 'gsd-plan-phase', '--phase', '7', '--repo', tmp()]);
});

// ── payloads ────────────────────────────────────────────────────────────────
group('hook payloads: shapes, cwd, invalid ones (jq reader)', (add) => {
  const r7 = mk({ branch: 'phase-7-thing', files: { '.planning/phases/07-thing/.keep': '' } });
  const bare = mk({ conf: null });
  const setup = mk();
  for (const glob of [false, true]) {
    const g = glob ? ['--global'] : [];
    const tag = glob ? 'global ' : '';
    const env = { CLAUDE_PROJECT_DIR: r7 };
    add(`${tag}skill payload, wrong phase`, g, { stdin: skill('gsd-plan-phase', '8'), env });
    add(`${tag}upe payload, wrong phase`, g, { stdin: upe('gsd-plan-phase', '8'), env });
    add(`${tag}skill payload, matching`, g, { stdin: skill('gsd-plan-phase', '7'), env });
    add(`${tag}upe leading slash`, g, { stdin: upe('/gsd-plan-phase', '8'), env });
    add(`${tag}upe double slash`, g, { stdin: upe('//gsd-plan-phase', '8'), env });
    add(`${tag}gsd: namespace`, g, { stdin: upe('gsd:plan-phase', '8'), env });
    add(`${tag}/gsd: namespace`, g, { stdin: upe('/gsd:plan-phase', '8'), env });
    add(`${tag}plugin form`, g, { stdin: skill('gsd-core:gsd-plan-phase', '8'), env });
    add(`${tag}plugin form in upe`, g, { stdin: upe('gsd-core:gsd-plan-phase', '8'), env });
    add(`${tag}plugin, not gsd`, g, { stdin: skill('other:plan-phase', '8'), env });
    add(`${tag}gsdt-flow`, g, { stdin: skill('gsdt-flow', '8'), env });
    add(`${tag}gsdw-flow`, g, { stdin: skill('gsdw-flow', '8'), env });
    add(`${tag}non-gsd`, g, { stdin: skill('review', '8'), env });
    add(`${tag}empty command`, g, { stdin: skill('', '8'), env });
    add(`${tag}no command`, g, { stdin: '{}', env });
    add(`${tag}cwd of the payload`, g, { stdin: skill('gsd-plan-phase', '8', r7) });
    add(`${tag}cwd = bare repo, new-project`, g, { stdin: skill('gsd-new-project', '', bare) });
    add(`${tag}cwd = set-up repo, new-project`, g, { stdin: skill('gsd-new-project', '', setup) });
    add(`${tag}cwd beats nothing, env beats cwd`, g, { stdin: skill('gsd-plan-phase', '8', setup), env });
    add(`${tag}empty cwd`, g, { stdin: skill('gsd-new-project', '', ''), cwd: bare });
    add(`${tag}non-string cwd`, g, { stdin: skill('gsd-new-project', '', 5), cwd: bare });
    add(`${tag}array cwd`, g, { stdin: skill('gsd-new-project', '', [bare]), cwd: bare });
    add(`${tag}null cwd`, g, { stdin: skill('gsd-new-project', '', null), cwd: bare });
    add(`${tag}false cwd`, g, { stdin: skill('gsd-new-project', '', false), cwd: bare });
    add(`${tag}cwd with trailing newline`, g, { stdin: skill('gsd-new-project', '', `${bare}\n`), cwd: setup });
    add(`${tag}cwd missing dir`, g, { stdin: skill('gsd-new-project', '', path.join(tmp(), 'nope')), cwd: setup });
    // invalid payloads
    for (const [lab, stdin] of [
      ['empty', ''], ['spaces', '  \n'], ['bad json', 'not json'], ['truncated', '{"tool_input":'], ['array', '[]'], ['array of objects', '[{"command_name":"gsd-plan-phase"}]'], ['string', '"gsd-plan-phase"'],
      ['number', '5'], ['null', 'null'], ['true', 'true'],
      ['non-string command', '{"command_name":5}'], ['object command', '{"command_name":{}}'], ['array command', '{"command_name":["gsd-plan-phase"]}'],
      ['non-string args', '{"command_name":"gsd-plan-phase","command_args":5}'], ['array args', '{"command_name":"gsd-plan-phase","command_args":["7"]}'],
      ['non-string skill', '{"tool_input":{"skill":5}}'], ['non-string skill args', '{"tool_input":{"skill":"gsd-plan-phase","args":{}}}'],
      ['null tool_input', '{"tool_input":null}'], ['string tool_input', '{"tool_input":"gsd-plan-phase"}'], ['array tool_input', '{"tool_input":["x"]}'], ['number tool_input', '{"tool_input":7}'],
      ['false command falls through', '{"command_name":false,"tool_input":{"skill":"gsd-plan-phase","args":"8"}}'],
      ['null command falls through', '{"command_name":null,"tool_input":{"skill":"gsd-plan-phase","args":"8"}}'],
      ['empty command wins', '{"command_name":"","tool_input":{"skill":"gsd-plan-phase","args":"8"}}'],
      ['command_name beats skill', '{"command_name":"gsd-progress","tool_input":{"skill":"gsd-plan-phase","args":"8"}}'],
      ['command_args beats args', '{"command_name":"gsd-plan-phase","command_args":"7","tool_input":{"args":"8"}}'],
      ['null command_args falls through', '{"command_name":"gsd-plan-phase","command_args":null,"tool_input":{"args":"8"}}'],
      ['false args', '{"command_name":"gsd-plan-phase","command_args":false}'],
      ['trailing newline in command', '{"command_name":"gsd-plan-phase\\n","command_args":"8"}'],
      ['trailing newlines in args', '{"command_name":"gsd-plan-phase","command_args":"8\\n\\n"}'],
      ['leading newline in args', '{"command_name":"gsd-plan-phase","command_args":"\\n8"}'],
      ['whitespace around the json', ` \n${skill('gsd-plan-phase', '8')}\n\n`],
      ['command_name wins over a bad tool_input', '{"command_name":"gsd-plan-phase","command_args":"8","tool_input":"s"}'],
      ['only the command is set, bad tool_input', '{"command_name":"gsd-plan-phase","tool_input":"s"}'],
      ['false tool_input', '{"tool_input":false}'],
      ['false tool_input, command set', '{"command_name":"gsd-plan-phase","command_args":"8","tool_input":false}'],
      ['unicode args', '{"command_name":"gsd-plan-phase","command_args":"8 — é"}'],
      ['duplicate keys', '{"command_name":"gsd-progress","command_name":"gsd-plan-phase","command_args":"8"}'],
      ['old Gemini payload', '{"tool_name":"activate_skill","tool_input":{"name":"gsd-new-project"}}'],
      ['Bash payload', '{"tool_name":"Bash","tool_input":{"command":"ls"}}'],
    ] as [string, string][]) {
      add(`${tag}payload: ${lab}`, g, { stdin, env });
      add(`${tag}payload (bare cwd): ${lab}`, g, { stdin, cwd: bare, env: { CLAUDE_PROJECT_DIR: bare } });
    }
  }
});

// ── rule 0 / 0b ─────────────────────────────────────────────────────────────
group('rule 0 and 0b', (add) => {
  const bare = mk({ conf: null });
  const setup = mk();
  const phase = mk({ branch: 'phase-7-thing' });
  for (const cmd of ['gsd-new-project', 'gsd-ingest-docs']) {
    for (const [lab, repoDir] of [['bare', bare], ['set-up', setup], ['phase', phase]] as const) {
      for (const g of [[], ['--global']]) {
        add(`${cmd} ${lab} ${g.join('')}`, [...g, '--command', cmd, '--repo', repoDir]);
        add(`${cmd} ${lab} ${g.join('')} typed`, g, { stdin: upe(`/${cmd}`, '', repoDir) });
      }
    }
  }
  const clash: [string, string][] = [
    ['gsd-autonomous', ''], ['gsd-autonomous', '--from 3'], ['gsd-manager', ''], ['gsd-workspace', '--new x'], ['gsd-workstreams', 'create x'],
    ['gsd-phase', 'checkout flow'], ['gsd-phase', ''], ['gsd-phase', '--insert 7 hotfix'], ['gsd-phase', '--remove 9'], ['gsd-phase', '--edit 7'],
    ['gsd-phase', '--edit'], ['gsd-phase', '--remove 3 --edit'], ['gsd-phase', '--edit --insert 3 x'], ['gsd-phase', '--edit --remove'], ['gsd-phase', '--insert'], ['gsd-phase', 'x --remove'],
    ['gsd-phase', '--removed 3'], ['gsd-phase', '--edit-all'], ['gsd-phase', '--insert=3'], ['gsd-phase', '--EDIT 7'], ['gsd-phase', 'say --edit please'],
  ];
  for (const [cmd, args] of clash) {
    for (const [lab, repoDir] of [['bare', bare], ['set-up', setup], ['phase', phase]] as const) {
      for (const g of [[], ['--global']]) add(`0b ${cmd} [${args}] ${lab} ${g.join('')}`, [...g, '--command', cmd, '--args', args === '' ? 'x' : args, '--repo', repoDir]);
    }
  }
  // a conf with another base; the message names it
  const main = mk({ conf: 'base = main\ninstall = none\n', branch: 'main' });
  git(main, 'checkout', '-q', 'develop');
  add('base=main, phase --remove', ['--command', 'gsd-phase', '--args', '--remove 3', '--repo', main]);
  add('base=main, phase --edit on develop', ['--command', 'gsd-phase', '--args', '--edit 3', '--repo', main]);
  git(main, 'checkout', '-q', 'main');
  add('base=main, phase --edit on main', ['--command', 'gsd-phase', '--args', '--edit 3', '--repo', main]);
});

// ── rule 1, 2 ───────────────────────────────────────────────────────────────
group('rule 1: /gsd-phase only on the base', (add) => {
  const noConf = mk({ conf: null });
  const noConfMain = mk({ conf: null });
  git(noConfMain, 'branch', '-m', 'main');
  const noConfOther = mk({ conf: null, branch: 'feature/x' });
  git(noConfOther, 'branch', '-D', 'develop');
  const detached = mk();
  git(detached, 'checkout', '-q', '--detach');
  const unborn = path.join(tmp(), 'unborn');
  mkdirSync(unborn);
  sh(unborn, 'git', ['init', '-q', '-b', 'develop']);
  writeFileSync(path.join(unborn, '.gsd.conf'), 'install = none\n');
  const confBase = mk({ conf: 'base   =   release/1  # the base\ninstall = none\n' });
  git(confBase, 'checkout', '-q', '-b', 'release/1');
  for (const [lab, r] of [['no conf develop', noConf], ['no conf main', noConfMain], ['no conf, no develop/main', noConfOther], ['detached', detached], ['unborn', unborn], ['conf base with comment', confBase], ['set-up on a phase', mk({ branch: 'phase-3-x' })], ['set-up on base', mk()], ['agent branch', mk({ branch: 'agent-abc' })], ['worktree-agent branch', mk({ branch: 'worktree-agent-abc' })]] as const) {
    for (const g of [[], ['--global']]) {
      add(`rule1 ${lab} ${g.join('')}`, [...g, '--command', 'gsd-phase', '--args', '--edit 3', '--repo', r]);
      add(`rule2 ${lab} ${g.join('')}`, [...g, '--command', 'gsd-plan-phase', '--phase', '3', '--repo', r]);
      add(`rule2 ${lab} no N ${g.join('')}`, [...g, '--command', 'gsd-plan-phase', '--repo', r]);
      add(`rule0 ${lab} ${g.join('')}`, [...g, '--command', 'gsd-new-project', '--repo', r]);
    }
  }
});

group('rule 2: per-phase commands vs the worktree', (add) => {
  const branches = ['phase-7-thing', 'phase-07-thing', 'phase-2.1-thing', 'phase-02.1-thing', 'phase-foo', 'phase-7.x', 'feature/phase-7-x', 'main', 'phase-99999999999999999999-x'];
  const argsList = ['7', '8', '07', '007', '2.1', '02.1', '2.10', '0', '', '--phase=7', '--files src/v7/a.ts', '2 --files src/v7/a.ts', '99999999999999999999', '18446744073709551623', '--phase=--phase=7', '٧'];
  for (const b of branches) {
    const r = mk({ branch: b === 'develop' ? undefined : b });
    if (b === 'main') {
      git(r, 'branch', '-m', 'main');
    }
    for (const args of argsList) {
      add(`branch ${b} args [${JSON.stringify(args)}]`, ['--command', 'gsd-plan-phase', '--args', args === '' ? ' ' : args, '--repo', r]);
    }
  }
  const r7 = mk({ branch: 'phase-7-thing' });
  const onBase = mk();
  const onOther = mk({ branch: 'feature/x' });
  const onBare = mk({ conf: null, branch: 'phase-8-x' });
  for (const cmd of [...FEATURE, ...OTHER]) {
    add(`${cmd} in phase-7 for 7`, ['--command', cmd, '--args', '7', '--repo', r7]);
    add(`${cmd} in phase-7 for 8`, ['--command', cmd, '--args', '8', '--repo', r7]);
    add(`${cmd} in phase-7 no N`, ['--command', cmd, '--args', 'x', '--repo', r7]);
    add(`${cmd} on base`, ['--command', cmd, '--args', '7', '--repo', onBase]);
    add(`${cmd} on other`, ['--command', cmd, '--args', '7', '--repo', onOther]);
    add(`${cmd} on bare`, ['--command', cmd, '--args', '7', '--repo', onBare]);
    add(`${cmd} global in phase-7 for 8`, ['--global', '--command', cmd, '--args', '8', '--repo', r7]);
    if (FEATURE.indexOf(cmd) % 3 === 0) add(`${cmd} global bare`, ['--global', '--command', cmd, '--args', '7', '--repo', onBare]);
  }
});

// ── nested workers ──────────────────────────────────────────────────────────
group('nested agent-* workers', (add) => {
  const mkNested = (parentBranch: string, workerBranch: string): { top: string; worker: string } => {
    const top = mk({ conf: 'base = develop\ninstall = none\n' });
    const wt = path.join(tmp(), 'wt');
    git(top, 'worktree', 'add', '-q', '-b', parentBranch, wt);
    const worker = path.join(wt, '.claude', 'worktrees', 'agent-1');
    git(wt, 'worktree', 'add', '-q', '-b', workerBranch, worker);
    return { top, worker };
  };
  for (const wb of ['agent-1', 'worktree-agent-1']) {
    for (const pb of ['phase-7-thing', 'phase-07-x', 'phase-2.1-x', 'feature/x', 'phase-foo']) {
      const { worker } = mkNested(pb, wb);
      for (const args of ['7', '8', '2.1', '02.1', '']) {
        add(`worker ${wb} under ${pb} args [${args}]`, ['--command', 'gsd-plan-phase', '--args', args === '' ? 'x' : args, '--repo', worker]);
      }
      add(`worker ${wb} under ${pb} rule 1`, ['--command', 'gsd-phase', '--args', '--edit 7', '--repo', worker]);
      add(`worker ${wb} under ${pb} via cwd`, ['--command', 'gsd-plan-phase', '--args', '7'], { cwd: worker });
      add(`worker ${wb} under ${pb} via payload cwd`, [], { stdin: skill('gsd-plan-phase', '7', worker) });
      add(`worker ${wb} under ${pb} via a subdir`, ['--command', 'gsd-plan-phase', '--args', '7', '--repo', path.join(worker, '.planning')]);
    }
  }
  // a worker whose parent checkout is a different repository never inherits
  const other = mk({ branch: 'phase-7-thing' });
  const alien = path.join(other, '.claude', 'worktrees', 'agent-9');
  const foreign = mk({ dir: alien, branch: 'agent-9' });
  add('agent branch in a foreign repo inside a phase checkout', ['--command', 'gsd-plan-phase', '--args', '7', '--repo', foreign]);
  add('agent branch in a plain repo', ['--command', 'gsd-plan-phase', '--args', '7', '--repo', mk({ branch: 'agent-1' })]);
  add('worktree-agent branch in a plain repo, base conf', ['--command', 'gsd-phase', '--args', '--edit 7', '--repo', mk({ branch: 'worktree-agent-1' })]);
  // a worker of the main checkout (base branch parent): not inherited
  const { worker } = mkNested('develop-2', 'agent-3');
  add('worker under a non-phase worktree', ['--command', 'gsd-review', '--args', '3', '--repo', worker]);
});

// ── rule 3 ──────────────────────────────────────────────────────────────────
group('rule 3: dependencies installed', (add) => {
  const cases: [string, string | null, string | null, boolean][] = [
    ['no status', 'install = npm install\n', null, false],
    ['ok', 'install = npm install\n', 'ok', false],
    ['ok newline', 'install = npm install\n', 'ok\n', false],
    ['fail', 'install = npm install\n', 'fail', false],
    ['running', 'install = npm install\n', 'running\n', false],
    ['empty', 'install = npm install\n', '', false],
    ['weird', 'install = npm install\n', 'what\nis this', false],
    ['unknown + node_modules', 'install = npm install\n', 'unknown', true],
    ['no status + node_modules', 'install = npm install\n', null, true],
    ['fail + node_modules', 'install = npm install\n', 'fail', true],
    ['running + node_modules', 'install = npm install\n', 'running', true],
    ['none', 'install = none\n', 'fail', false],
    ['unset conf, package.json', '', null, false],
    ['unset conf, pnpm lock', '', 'running', false],
    ['unset conf, nothing', '', 'fail', false],
    ['spaces in command', 'install = pnpm  install --frozen-lockfile   # c\n', null, false],
  ];
  for (const [lab, conf, status, nm] of cases) {
    const files: Record<string, string> = {};
    if (lab.includes('package.json')) files['package.json'] = '{}';
    if (lab.includes('pnpm lock')) files['pnpm-lock.yaml'] = '';
    if (status !== null) files['.gsd-install.status'] = status;
    if (nm) files['node_modules/.keep'] = '';
    const r = mk({ conf: `base = develop\n${conf}`, branch: 'phase-7-thing', files });
    for (const cmd of ['gsd-execute-phase', 'gsd-plan-phase']) add(`${lab} ${cmd}`, ['--command', cmd, '--args', '7', '--repo', r]);
    add(`${lab} wrong phase`, ['--command', 'gsd-execute-phase', '--args', '8', '--repo', r]);
    add(`${lab} global`, ['--global', '--command', 'gsd-execute-phase', '--args', '7', '--repo', r]);
  }
  // the status of a directory, an install in a subdirectory of the repo
  const r = mk({ conf: 'base = develop\ninstall = make\n', branch: 'phase-7-thing', files: { '.gsd-install.status/x': '' } });
  add('status is a directory', ['--command', 'gsd-execute-phase', '--args', '7', '--repo', r]);
  add('subdir of the repo', ['--command', 'gsd-execute-phase', '--args', '7'], { cwd: path.join(r, '.gsd-install.status') });
});

// ── rule 4 ──────────────────────────────────────────────────────────────────
group('rule 4: flow = strict', (add) => {
  const conf = (extra = ''): string => `base = develop\ninstall = none\nflow = strict\n${extra}`;
  const reviews = (body: string): string => body;
  const variants: Record<string, Record<string, string>> = {
    empty: {},
    context: { '.planning/phases/07-thing/07-CONTEXT.md': '' },
    reviews_codex_ok: { '.planning/phases/07-thing/07-REVIEWS.md': '# Reviews\n\n## Codex Review\n\nLooks fine, a real review with several lines.\nMore text here.\nAnd more text.\n' },
    reviews_empty: { '.planning/phases/07-thing/07-REVIEWS.md': '' },
    reviews_limit: { '.planning/phases/07-thing/07-REVIEWS.md': '# Reviews\n\n## Codex Review\n\nERROR: You\'ve hit your usage limit. try again at Oct 11th, 2026 1:22 AM\n' },
    reviews_claude: { '.planning/phases/07-thing/07-REVIEWS.md': reviews('# Reviews\n\n## Claude Review\n\nA full review of the plan.\nLine\nLine\nLine\n') },
    reviews_unlabeled: { '.planning/phases/07-thing/07-REVIEWS.md': 'just text\n' },
    code_review: { '.planning/phases/07-thing/07-REVIEW.md': '' },
    code_review_ui_spec: { '.planning/phases/07-thing/07-REVIEW.md': '', '.planning/phases/07-thing/07-UI-SPEC.md': '' },
    code_review_ui_all: { '.planning/phases/07-thing/07-REVIEW.md': '', '.planning/phases/07-thing/07-UI-SPEC.md': '', '.planning/phases/07-thing/07-UI-REVIEW.md': '' },
    validation_ok: { '.planning/phases/07-thing/07-REVIEW.md': '', '.planning/phases/07-thing/07-VALIDATION.md': VALID },
    validation_bad: { '.planning/phases/07-thing/07-REVIEW.md': '', '.planning/phases/07-thing/07-VALIDATION.md': '---\nnyquist_compliant: false\n---\n' },
    validation_nofm: { '.planning/phases/07-thing/07-REVIEW.md': '', '.planning/phases/07-thing/07-VALIDATION.md': 'text\n' },
    padded_only_unpadded_dir: { '.planning/phases/7-thing/7-CONTEXT.md': '', '.planning/phases/7-thing/7-REVIEW.md': '' },
    other_dir_only: { '.planning/phases/08-other/08-CONTEXT.md': '' },
    file_not_dir: { '.planning/phases/07-thing': '' },
    two_dirs: { '.planning/phases/07-a/07-CONTEXT.md': '', '.planning/phases/07-b/07-REVIEW.md': '' },
  };
  const confs: Record<string, string> = { strict: conf(), claude: conf('review_provider = claude\n'), custom: conf('review_provider = custom\n'), codex: conf('review_provider = codex\n'), bogus: conf('review_provider = nope\n'), 'no nyquist': conf(), };
  for (const [vn, files] of Object.entries(variants)) {
    for (const [cn, c] of Object.entries(confs)) {
      const r = mk({ conf: c, branch: 'phase-7-thing', files });
      for (const [cmd, args] of [['gsd-plan-phase', '7'], ['gsd-plan-phase', '7 --prd docs/x.md'], ['gsd-plan-phase', '--prd=docs/x.md 7'], ['gsd-execute-phase', '7'], ['gsd-execute-phase', '7 --gaps-only'], ['gsd-execute-phase', '7 --gaps-only-x'], ['gsd-secure-phase', '7'], ['gsd-flow', '7'], ['gsd-plan-phase', '8']] as [string, string][]) {
        if (cn !== 'strict' && !(cmd === 'gsd-execute-phase' && args === '7' && vn.startsWith('reviews'))) continue;
        add(`${vn}/${cn} ${cmd} [${args}]`, ['--command', cmd, '--args', args === '' ? 'x' : args, '--repo', r]);
      }
    }
  }
  // policy is read from the main checkout, the artifacts from the worktree
  const top = mk({ conf: 'base = develop\ninstall = none\n' });
  const wt = path.join(tmp(), 'wt-7');
  git(top, 'worktree', 'add', '-q', '-b', 'phase-7-thing', wt);
  mkdirSync(path.join(wt, '.planning/phases/07-thing'), { recursive: true });
  add('worktree, policy off in main', ['--command', 'gsd-plan-phase', '--args', '7', '--repo', wt]);
  writeFileSync(path.join(top, '.gsd.conf'), conf());
  add('worktree, policy on in main only (own conf is the old one)', ['--command', 'gsd-plan-phase', '--args', '7', '--repo', wt]);
  add('worktree via cwd', ['--command', 'gsd-plan-phase', '--args', '7'], { cwd: wt });
  writeFileSync(path.join(wt, '.gsd.conf'), 'base = develop\ninstall = none\n');
  add('worktree, own conf says nothing', ['--command', 'gsd-plan-phase', '--args', '7', '--repo', wt]);
  // padded and decimal phases
  for (const [branch, dirName, args] of [['phase-8-x', '08-x', '8'], ['phase-8-x', '08-x', '08'], ['phase-08-x', '08-x', '8'], ['phase-08-x', '8-x', '8'], ['phase-8-x', '8-x', '08'], ['phase-2.1-x', '02.1-x', '2.1'], ['phase-2.1-x', '02.1-x', '02.1'], ['phase-02.1-x', '2.1-x', '2.1'], ['phase-7.1-x', '7.1-x', '7.1'], ['phase-7.1-x', '07.1-x', '7.1'], ['phase-12-x', '12-x', '12'], ['phase-100-x', '100-x', '100'], ['phase-0-x', '00-x', '0'], ['phase-1-x', '01-x', '1']] as const) {
    const n = (dirName.split('-')[0] as string);
    for (const [cmd, art] of [['gsd-plan-phase', 'CONTEXT'], ['gsd-secure-phase', 'REVIEW']] as const) {
      const r0 = mk({ conf: conf(), branch, files: { [`.planning/phases/${dirName}/.keep`]: '' } });
      add(`${branch} ${dirName} ${cmd} ${args} (no artifact)`, ['--command', cmd, '--args', args, '--repo', r0]);
      const r1 = mk({ conf: conf(), branch, files: { [`.planning/phases/${dirName}/${n}-${art}.md`]: '', [`.planning/phases/${dirName}/.keep`]: '' } });
      add(`${branch} ${dirName} ${cmd} ${args} (artifact)`, ['--command', cmd, '--args', args, '--repo', r1]);
    }
  }
});

// ── rule 5 ──────────────────────────────────────────────────────────────────
group('rule 5: ui_gates = strict', (add) => {
  const mkUi = (files: Record<string, string>, extra = '', branch = 'phase-5-thing'): string =>
    mk({ conf: `base = develop\ninstall = none\nui_gates = strict\n${extra}`, branch, files });
  const STUB = readStub();
  const sketchReadme = '---\nwinner: a\n---\n';
  const layoutOk = 'sketch: .planning/sketches/s1\npages: /home\nurl: http://localhost:3000\n';
  const sets: Record<string, Record<string, string>> = {
    none: {},
    stub_design: { '.planning/design/DESIGN.md': `${STUB}\n` },
    design_ok: { '.planning/design/DESIGN.md': '# Design\n\nReal.\n' },
    design_ok_layout_missing_sketch: { '.planning/design/DESIGN.md': 'x\n', '.planning/phases/05-thing/05-LAYOUT.md': 'sketch: .planning/sketches/none\npages: /x\n' },
    design_ok_layout_nowinner: { '.planning/design/DESIGN.md': 'x\n', '.planning/sketches/s1/README.md': '---\nname: s\n---\n', '.planning/phases/05-thing/05-LAYOUT.md': layoutOk },
    design_ok_layout_nopages: { '.planning/design/DESIGN.md': 'x\n', '.planning/sketches/s1/README.md': sketchReadme, '.planning/phases/05-thing/05-LAYOUT.md': 'sketch: .planning/sketches/s1\n' },
    design_ok_layout_ok: { '.planning/design/DESIGN.md': 'x\n', '.planning/sketches/s1/README.md': sketchReadme, '.planning/phases/05-thing/05-LAYOUT.md': layoutOk },
    design_ok_layout_skip: { '.planning/design/DESIGN.md': 'x\n', '.planning/phases/05-thing/05-LAYOUT.md': 'sketch: skip not needed\n' },
    layout_nodesign: { '.planning/phases/05-thing/05-LAYOUT.md': 'sketch: skip\n' },
    phasedir_only: { '.planning/phases/05-thing/.keep': '' },
    layout_ok_no_check: { '.planning/design/DESIGN.md': 'x\n', '.planning/sketches/s1/README.md': sketchReadme, '.planning/phases/05-thing/05-LAYOUT.md': layoutOk, '.planning/phases/05-thing/05-UI-SPEC.md': '' },
    skipped_check: { '.planning/phases/05-thing/05-LAYOUT.md': 'sketch: skip\nwaive: all\n', '.planning/phases/05-thing/05-UI-CHECK.md': 'skipped: no ui\n' },
    check_only: { '.planning/phases/05-thing/05-LAYOUT.md': 'sketch: skip\n', '.planning/phases/05-thing/05-UI-CHECK.md': 'result: pass\ncode: abc\ncapture: x\n' },
    look_no_approval: { '.planning/phases/05-thing/05-LAYOUT.md': 'sketch: skip\n', '.planning/phases/05-thing/05-UI-CHECK.md': 'result: pass\ncode: abc\n', '.planning/phases/05-thing/05-UI-LOOK.md': 'x\n' },
    exempt_review_on_base: { '.planning/phases/05-thing/05-LAYOUT.md': 'sketch: skip\n' },
  };
  for (const [sn, files] of Object.entries(sets)) {
    const r = mkUi(files);
    for (const g of [[], ['--global']]) {
      for (const [cmd, args] of [['gsd-ui-phase', '5'], ['gsd-ui-review', '5'], ['gsd-ui-review', '6'], ['gsd-plan-phase', '5'], ['gsd-secure-phase', '5'], ['gsd-ui-review', '05']] as const) {
        add(`${sn} ${cmd} ${args} ${g.join('')}`, [...g, '--command', cmd, '--args', args, '--repo', r]);
      }
    }
  }
  // the exempt case: the phase's UI review is already on the base branch
  const ex = mkUi({ '.planning/phases/05-thing/05-LAYOUT.md': 'sketch: skip\n' }, '', 'develop');
  write(path.join(ex, '.planning/phases/05-thing/05-UI-REVIEW.md'), 'done\n');
  git(ex, 'add', '-A');
  git(ex, 'commit', '-q', '-m', 'ui review');
  git(ex, 'checkout', '-q', '-b', 'phase-5-thing');
  add('exempt: UI-REVIEW on base', ['--command', 'gsd-ui-review', '--args', '5', '--repo', ex]);
  add('exempt: ui-phase', ['--command', 'gsd-ui-phase', '--args', '5', '--repo', ex]);
  // ui_gates values and combined with flow = strict
  for (const v of ['warn', 'off', 'strict', 'bogus', '']) {
    const r = mk({ conf: `base = develop\ninstall = none\nui_gates = ${v}\n`, branch: 'phase-5-thing' });
    add(`ui_gates=${v} ui-phase`, ['--command', 'gsd-ui-phase', '--args', '5', '--repo', r]);
    add(`ui_gates=${v} ui-review`, ['--command', 'gsd-ui-review', '--args', '5', '--repo', r]);
  }
  const both = mk({ conf: 'base = develop\ninstall = none\nflow = strict\nui_gates = strict\n', branch: 'phase-5-thing', files: { '.planning/phases/05-thing/05-LAYOUT.md': 'sketch: skip\n' } });
  for (const cmd of ['gsd-plan-phase', 'gsd-execute-phase', 'gsd-secure-phase', 'gsd-ui-phase', 'gsd-ui-review']) add(`flow+ui ${cmd}`, ['--command', cmd, '--args', '5', '--repo', both]);
  // ui_gates read from the worktree's own conf, and from main
  const top = mk({ conf: 'base = develop\ninstall = none\n' });
  const wt = path.join(tmp(), 'wt-5');
  git(top, 'worktree', 'add', '-q', '-b', 'phase-5-thing', wt);
  add('ui main off', ['--command', 'gsd-ui-phase', '--args', '5', '--repo', wt]);
  writeFileSync(path.join(wt, '.gsd.conf'), 'base = develop\ninstall = none\nui_gates = strict\n');
  add('ui worktree-only strict', ['--command', 'gsd-ui-phase', '--args', '5', '--repo', wt]);
  writeFileSync(path.join(top, '.gsd.conf'), 'base = develop\ninstall = none\nui_gates = strict\n');
  add('ui main strict', ['--command', 'gsd-ui-phase', '--args', '5', '--repo', wt]);
  writeFileSync(path.join(top, '.gsd.conf'), 'base = develop\ninstall = none\nui_gates = off\n');
  add('ui main off, worktree strict', ['--command', 'gsd-ui-phase', '--args', '5', '--repo', wt]);
});

function readStub(): string {
  const r = spawnSync('bash', ['-c', '. "$GSD_PKG/lib/common.sh"; . "$GSD_PKG/lib/ui.sh"; printf %s "$GSD_UI_STUB"'], { encoding: 'utf8', env: { ...process.env, GSD_PKG: PKG } });
  return r.stdout;
}

// ── a PATH without jq (the old guard then used lib/gsd_hook_payload.py) ──────
group('a PATH without jq: the old Python reader against the new guard', (add) => {
  const stubs = tmp();
  for (const t of ['bash', 'env', 'cat', 'dirname', 'sed', 'head', 'grep', 'git', 'tr', 'awk', 'readlink', 'python3', 'node', 'ls', 'sort', 'uniq', 'cut', 'wc', 'basename', 'mkdir', 'rm', 'tail', 'sleep', 'date', 'find', 'mktemp', 'cmp', 'diff', 'xargs', 'od', 'tee', 'printf', 'expr']) {
    const p = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
    if (p.startsWith('/')) symlinkSync(p, path.join(stubs, t));
  }
  assert.equal(spawnSync('/bin/sh', ['-c', 'command -v jq'], { env: { PATH: stubs }, encoding: 'utf8' }).stdout.trim(), '');
  const r7 = mk({ branch: 'phase-7-thing', files: { '.planning/phases/07-thing/.keep': '' } });
  const bare = mk({ conf: null });
  const setup = mk();
  // the Python reader names why it blocked ("payload is not an object"); only the exit status is compared for those
  const go = (label: string, argv: string[], stdin: string, env: Record<string, string | undefined> = {}, cwd?: string, rcOnly = false): void =>
    add(`nojq ${label}`, argv, { stdin, env, cwd, pathDirs: stubs, rcOnly });
  for (const g of [[], ['--global']]) {
    const t = g.join('');
    go(`${t} skill wrong phase`, g, skill('gsd-plan-phase', '8'), { CLAUDE_PROJECT_DIR: r7 });
    go(`${t} skill matching`, g, skill('gsd-plan-phase', '7'), { CLAUDE_PROJECT_DIR: r7 });
    go(`${t} upe`, g, upe('gsd-plan-phase', '8'), { CLAUDE_PROJECT_DIR: r7 });
    go(`${t} gsd: ns`, g, upe('/gsd:plan-phase', '8'), { CLAUDE_PROJECT_DIR: r7 });
    go(`${t} plugin`, g, skill('gsd-core:gsd-plan-phase', '8'), { CLAUDE_PROJECT_DIR: r7 });
    go(`${t} gsdt-flow`, g, skill('gsdt-flow', '8'), { CLAUDE_PROJECT_DIR: r7 });
    go(`${t} gsdw-flow`, g, skill('gsdw-flow', '8'), { CLAUDE_PROJECT_DIR: r7 });
    go(`${t} non-gsd`, g, skill('review', '8'), { CLAUDE_PROJECT_DIR: r7 });
    go(`${t} cwd bare new-project`, g, skill('gsd-new-project', '', bare));
    go(`${t} cwd set-up new-project`, g, upe('gsd-new-project', '', setup));
    go(`${t} cwd phase`, g, skill('gsd-plan-phase', '8', r7));
    for (const [lab, p] of [['bad json', 'not json'], ['empty', ''], ['array', '[]'], ['string', '"x"'], ['number command', '{"command_name":5}'], ['number args', '{"command_name":"gsd-plan-phase","command_args":5}'], ['null tool_input', '{"tool_input":null}'], ['empty object', '{}']] as const) {
      go(`${t} ${lab}`, g, p, { CLAUDE_PROJECT_DIR: r7 }, undefined, true);
    }
    go(`${t} explicit command`, [...g, '--command', 'gsd-plan-phase', '--phase', '8', '--repo', r7], '');
    go(`${t} skip guard`, g, 'x', { GSD_SKIP_GUARD: '1' });
  }
});

// ── the launcher ────────────────────────────────────────────────────────────
function linkTools(tools: string[]): string {
  const d = tmp();
  for (const t of tools) {
    const p = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
    if (p.startsWith('/')) symlinkSync(p, path.join(d, t));
  }
  return d;
}
const runSync = (bin: string, argv: string[], env: Record<string, string>, input = ''): R => {
  const r = spawnSync(bin, argv, { encoding: 'utf8', env: { ...process.env, ...env }, input });
  return { out: r.stdout ?? '', err: r.stderr ?? '', rc: r.status ?? 1 };
};

test('launcher: no node blocks, --global lets it through, GSD_SKIP_GUARD escapes', () => {
  const stubs = linkTools(['bash', 'env', 'dirname', 'readlink', 'git']);
  const r7 = mk({ branch: 'phase-7-thing' });
  const a = runSync(NEW, ['--command', 'gsd-plan-phase', '--phase', '8', '--repo', r7], { PATH: stubs });
  assert.deepEqual(a, { out: '', err: 'BLOCKED: gsdt-worktree-guard needs Node.js >= 24 (node not found on PATH)\n', rc: 2 });
  const b = runSync(NEW, ['--global', '--command', 'gsd-plan-phase', '--phase', '8', '--repo', r7], { PATH: stubs });
  assert.deepEqual(b, { out: '', err: '', rc: 0 });
  const c = runSync(NEW, ['--command', 'gsd-plan-phase', '--phase', '8', '--repo', r7], { PATH: stubs, GSD_SKIP_GUARD: '1' });
  assert.deepEqual(c, { out: '', err: '', rc: 0 });
  // even a usage error is a block without node (the guard cannot tell what it was asked)
  assert.equal(runSync(NEW, ['--bogus'], { PATH: stubs }).rc, 2);
});

test('launcher: an old node blocks (global: through), a crash never exits 1', () => {
  const stubs = linkTools(['bash', 'env', 'dirname', 'readlink', 'git']);
  const fake = tmp();
  write(path.join(fake, 'node'), '#!/bin/sh\necho "boom: cannot run" >&2\nexit 1\n', 0o755);
  const r7 = mk({ branch: 'phase-7-thing' });
  const env = { PATH: `${fake}:${stubs}` };
  // the launcher exec's a node that fails with 1: that is what a broken node install looks like, and it is the one thing the bash launcher cannot turn into a block
  const r = runSync(NEW, ['--command', 'gsd-plan-phase', '--phase', '8', '--repo', r7], env);
  assert.equal(r.rc, 1, 'documented: a node that cannot even start exits with its own status');
  // an import error inside launch.mjs is a block / pass-through
  const pkg = path.join(tmp(), 'pkg');
  mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  mkdirSync(path.join(pkg, 'src', 'commands'), { recursive: true });
  copyFileSync(NEW, path.join(pkg, 'bin', 'gsdt-worktree-guard'));
  chmodSync(path.join(pkg, 'bin', 'gsdt-worktree-guard'), 0o755);
  copyFileSync(path.join(PKG, 'src', 'launch.mjs'), path.join(pkg, 'src', 'launch.mjs'));
  write(path.join(pkg, 'src', 'commands', 'worktree-guard.ts'), "import './missing.ts';\nexport function main(): number { return 0; }\n");
  const crash = runSync(path.join(pkg, 'bin', 'gsdt-worktree-guard'), ['--command', 'gsd-plan-phase'], {});
  assert.equal(crash.rc, 2);
  assert.match(crash.err, /^BLOCKED: gsdt-worktree-guard: .+\n$/);
  assert.deepEqual(runSync(path.join(pkg, 'bin', 'gsdt-worktree-guard'), ['--global', '--command', 'gsd-plan-phase'], {}), { out: '', err: '', rc: 0 });
  write(path.join(pkg, 'src', 'commands', 'worktree-guard.ts'), "export function main(): number { throw new Error('kaboom\\nsecond line'); }\n");
  const thrown = runSync(path.join(pkg, 'bin', 'gsdt-worktree-guard'), ['--command', 'gsd-plan-phase'], {});
  assert.deepEqual(thrown, { out: '', err: 'BLOCKED: gsdt-worktree-guard: kaboom\n', rc: 2 });
});

test('launcher: stdin is read only when there is no --command', () => {
  const r7 = mk({ branch: 'phase-7-thing' });
  // an unreadable stdin (closed) is an empty payload
  const r = spawnSync('bash', ['-c', `exec <&-; "$0" --repo "$1"`, NEW, r7], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'BLOCKED: invalid Claude hook payload.\n');
  const g = spawnSync('bash', ['-c', `exec <&-; "$0" --global --repo "$1"`, NEW, r7], { encoding: 'utf8' });
  assert.equal(g.status, 0);
});

// ── the module API ──────────────────────────────────────────────────────────
test('guard() / guardArgv() / main are importable and do no work at import time', () => {
  assert.equal(typeof guardMain, 'function');
  const r7 = mk({ branch: 'phase-7-thing' });
  assert.deepEqual(guard({ command: 'gsd-plan-phase', args: '8', repo: r7 }), {
    rc: 2,
    stdout: '',
    stderr: "BLOCKED: you're in 'phase-7-thing', but /gsd-plan-phase targets phase 8. Switch to the phase-8-* worktree.\n",
  });
  assert.equal(guard({ command: 'gsd-plan-phase', args: '7', repo: r7 }).rc, 0);
  assert.equal(guard({ stdin: skill('gsd-plan-phase', '8'), repo: r7 }).rc, 2);
  assert.equal(guard({ stdin: 'junk', repo: r7 }).rc, 2);
  assert.equal(guard({ stdin: 'junk', repo: r7, global: true }).rc, 0);
  let reads = 0;
  guardArgv(['--bogus'], { stdin: () => (reads++, '') });
  guardArgv(['--command', 'gsd-progress'], { stdin: () => (reads++, '') });
  guardArgv(['--help'], { stdin: () => (reads++, '') });
  assert.equal(reads, 0, 'stdin is not read for usage errors or an explicit command');
  guardArgv([], { stdin: () => (reads++, '{}') });
  assert.equal(reads, 1);
  assert.deepEqual(guardArgv(['--bogus'], { env: { GSD_SKIP_GUARD: '1' } }), { rc: 0, stdout: '', stderr: '' });
  assert.equal(guardArgv(['--bogus'], { env: {} }).rc, 64);
  assert.deepEqual(parseArgs(['--phase', '7', '--phase', '8']), { kind: 'ok', command: '', args: '7 8', repo: '', global: false });
  assert.deepEqual(parseArgs(['--args', 'a', '--phase', '7']), { kind: 'ok', command: '', args: 'a 7', repo: '', global: false });
  assert.deepEqual(parseArgs(['--phase', '7', '--args', 'a']), { kind: 'ok', command: '', args: 'a', repo: '', global: false });
});
