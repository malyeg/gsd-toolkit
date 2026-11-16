// providers.test.ts — node:test port of tests/test-providers.sh: provider adapters (resolution,
// models, argv, start modes, compact_at), bootstrap and init, the Claude user hooks that gsdt-setup
// writes (the old suite drove the 0.10.x copy installer), the Gemini refusal and clean-up, the guard
// and doctor JSON per provider, gsdt-rules and the split instruction blocks.
// Everything runs in throwaway repos with a temp HOME. Run: node --test tests/node/providers.test.ts
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { base as confBase } from '../../src/common.ts';
import {
  canonicalBlock,
  compactResolve,
  compactSettings,
  modelResolve,
  modelValidate,
  providerArgv,
  providerEntryBlock,
  providerInstructionFile,
  providerPrompt,
  providerRender,
  providerResolve,
  rulesText,
  startModeResolve,
} from '../../src/provider.ts';
import { commandOnPath } from '../../src/common.ts';
import { PKG, exec, fwd, git, gitOk, gsdt, hostPath, joinPath, lf, repo, stubExe, tmp, winSkip, withEnv, write } from './g2-helpers.ts';
import type { Env, Run } from './g2-helpers.ts';

const WORK = tmp('gsd-prov-');
const HOME = path.join(WORK, 'home');
mkdirSync(HOME, { recursive: true });
const hasPython = (): boolean => ['python3', 'python'].some((p) => exec(p, ['-c', 'import sys']).status === 0);

const E = (extra: Env = {}): Env => ({
  HOME,
  USERPROFILE: HOME,
  XDG_CONFIG_HOME: path.join(HOME, '.config'),
  GSD_NO_CORE: '1',
  GSD_NO_UPDATE_CHECK: '1',
  // the checkout's own commands first: nested `gsdt-*` calls must never reach an installed copy
  PATH: joinPath([path.join(PKG, 'bin'), ...hostPath()]),
  ...extra,
});
const run = (name: string, args: string[], o: { cwd?: string; env?: Env; input?: string } = {}): Run => gsdt(name, args, { cwd: o.cwd, input: o.input, env: E(o.env) });
const startP = (R: string, args: string[], env: Env = {}): Run => run('start', ['-p', '7', '--repo', R, ...args], { env });
const bootstrap = (R: string, args: string[] = []): Run => run('bootstrap-repo', args, { cwd: R });
const init = (R: string, args: string[]): Run => run('init', args, { cwd: R });
const rd = (f: string): string => readFileSync(f, 'utf8');
const lines = (f: string): string[] => lf(rd(f)).split('\n');
const worktreeCount = (R: string): number => git(R, ['worktree', 'list', '--porcelain']).stdout.split('\n').filter((l) => l.startsWith('worktree ')).length;
const sub = (r: Run, ...needles: string[]): boolean => needles.every((n) => r.out.includes(n));
const resolveOf = (R: string, p = '', c = '', env: Env = {}): { ok: boolean; code?: number; msg?: string; v: string } => {
  const r = withEnv(env, () => providerResolve(R, p, c));
  return r.ok ? { ok: true, v: `${r.value.provider}:${r.value.command}` } : { ok: false, code: r.code, msg: r.message, v: '' };
};
const argvOf = (p: string, c: string, prompt: string, model = '', compact = ''): string[] => {
  const r = providerArgv(p, c, prompt, model, compact);
  assert.ok(r.ok, r.ok ? '' : r.message);
  return r.value;
};
const doctorJson = (R: string): { text: string; json: { findings: Array<{ code: string; message: string; fix?: string }>; session_model?: string } } => {
  const r = run('doctor', ['--repo', R, '--json']);
  let json: { findings: Array<{ code: string; message: string; fix?: string }> } = { findings: [] };
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* the old suite's `|| true`: an unreadable report is just empty */
  }
  return { text: r.stdout, json };
};
const hasCode = (R: string, code: string): boolean => doctorJson(R).json.findings.some((f) => f.code === code);

// ── configuration and rendering ──────────────────────────────────────────────
describe('configuration and rendering', () => {
  const R = path.join(WORK, 'config');
  repo(R);
  const conf = (t: string): void => writeFileSync(path.join(R, '.gsd.conf'), t);
  it('legacy provider still resolves', () => {
    conf('provider = codex\nagent_command = codex-x\n');
    assert.equal(resolveOf(R).v, 'codex:codex-x');
  });
  it('ordered providers overrides legacy provider', () => {
    conf('provider = claude\nproviders = codex,claude\nagent_command = codex-x\n');
    assert.equal(resolveOf(R).v, 'codex:codex-x');
  });
  it('environment overrides repo', () => assert.equal(resolveOf(R, '', '', { GSD_PROVIDER: 'codex', GSD_AGENT_COMMAND: 'codex-x' }).v, 'codex:codex-x'));
  it('CLI overrides environment', () => assert.equal(resolveOf(R, 'claude', '/tmp/claude-x', { GSD_PROVIDER: 'codex', GSD_AGENT_COMMAND: 'codex-x' }).v, 'claude:/tmp/claude-x'));
  it('unknown provider rejected', () => assert.equal(resolveOf(R, 'nope').code, 64));
  it('shell template rejected', () => assert.equal(resolveOf(R, 'custom', 'bad command').code, 64));
  const mode = (cli = ''): string => {
    const r = startModeResolve(R, cli);
    return r.ok ? r.value : `rc${r.code}`;
  };
  it('start mode default is flow', () => assert.equal(mode(), 'flow'));
  it('repository start_mode = discuss selects discuss', () => {
    const saved = rd(path.join(R, '.gsd.conf'));
    conf(`${saved}start_mode = discuss\n`);
    assert.equal(mode(), 'discuss');
    conf(saved);
  });
  it('repository start mode selects flow', () => {
    conf(`${rd(path.join(R, '.gsd.conf'))}start_mode = flow\n`);
    assert.equal(mode(), 'flow');
  });
  it('CLI start mode overrides repository', () => assert.equal(mode('discuss'), 'discuss'));
  it('invalid start mode rejected', () => {
    conf('start_mode = invalid\n');
    assert.equal(mode(), 'rc64');
  });
  // a provider's prompt and argv: the argv's arguments, one per line (what a stub that prints "$@" showed)
  const argLines = (p: string, kind: string): string[] => argvOf(p, p, providerPrompt(p, kind, '7')).slice(1);
  it('Claude discuss prompt remains backward compatible', () => assert.ok(argLines('claude', 'discuss').includes('/gsd-discuss-phase 7')));
  it('Claude flow prompt is explicit', () => assert.ok(argLines('claude', 'flow').includes('/gsdt-flow 7')));
  it('Codex discuss prompt is natural language', () => assert.ok(argLines('codex', 'discuss').some((l) => l.includes('Discuss GSD phase 7'))));
  it('Codex flow prompt is natural language', () => assert.ok(argLines('codex', 'flow').some((l) => l.includes('gsdt-flow skill'))));
  it('rendering shell-quotes cwd and prompt', () => assert.ok(providerRender('/tmp/a b', 'fake', 'quote " and $ safe').includes('/tmp/a\\ b')));
  it('missing executable still renders in print-only mode', () => {
    assert.equal(commandOnPath('provider-does-not-exist'), null);
    assert.notEqual(providerRender('/tmp', 'provider-does-not-exist', 'prompt'), '');
  });
  for (const [p, want] of [['claude', 'custom-claude'], ['codex', 'custom-codex']] as const) {
    it(`${p} uses its own command in one repo`, () => {
      conf('providers = claude,codex\nagent_command = default-claude\nclaude_command = custom-claude\ncodex_command = custom-codex\n');
      assert.equal(resolveOf(R, p).v.split(':')[1], want);
    });
  }
});

describe('complete provider-list validation', () => {
  const R = path.join(WORK, 'invalid-list');
  repo(R);
  for (const invalid of ['claude,unknown-provider', 'claude,,codex', 'claude,', ',codex', 'claude,claude', 'claude, codex', '']) {
    it(`invalid full list rejected: [${invalid}]`, () => {
      writeFileSync(path.join(R, '.gsd.conf'), `providers = ${invalid}\n`);
      assert.equal(resolveOf(R, 'claude', '').code, 64);
    });
  }
  for (const p of ['claude', 'codex']) {
    it(`${p} launch rejects invalid list before worktree creation`, () => {
      writeFileSync(path.join(R, '.gsd.conf'), 'providers = claude,unknown-provider\n');
      write(path.join(R, '.planning', 'ROADMAP.md'), '### Phase 7: Test\n');
      const r = startP(R, ['--provider', p, '--no-launch']);
      assert.ok(r.status === 64 && worktreeCount(R) === 1, `rc ${r.status}: ${r.out}`);
    });
  }
  it('doctor reports invalid secondary provider', () => assert.ok(hasCode(R, 'T050')));
});

describe('generated instructions follow effective repository settings', () => {
  const R = path.join(WORK, 'custom-layout');
  repo(R);
  gitOk(R, ['branch', 'release']);
  writeFileSync(path.join(R, '.gsd.conf'), 'providers = codex\nbase = release\nwtdir = custom-trees\ninstall = none\n');
  const files = (): string => `${rd(path.join(R, '.gsd.conf'))}\0${rd(path.join(R, '.gsd', 'INSTRUCTIONS.md'))}`;
  let before = '';
  it('instructions use configured base', () => {
    init(R, ['--no-commit', '--no-launch']);
    assert.match(rd(path.join(R, '.gsd', 'INSTRUCTIONS.md')), /base .release./);
  });
  it('instructions use configured worktree directory', () => assert.ok(rd(path.join(R, '.gsd', 'INSTRUCTIONS.md')).includes('../custom-trees/')));
  it('custom layout rerun is idempotent', () => {
    before = files();
    init(R, ['--no-commit', '--no-launch']);
    assert.equal(files(), before);
  });
  it('explicit base overrides configuration and instructions together', () => {
    init(R, ['--base', 'develop', '--no-commit', '--no-launch']);
    assert.equal(confBase(R), 'develop');
    assert.match(rd(path.join(R, '.gsd', 'INSTRUCTIONS.md')), /base .develop./);
  });
});

describe('model selection and safe argv', () => {
  const R = path.join(WORK, 'models');
  repo(R);
  writeFileSync(path.join(R, '.gsd.conf'), 'claude_model = claude-test\ncodex_model = codex-test\n');
  const model = (p: string, cli = '', env: Env = {}): { ok: boolean; v: string; code?: number } => {
    const r = withEnv(env, () => modelResolve(R, p, cli));
    return r.ok ? { ok: true, v: r.value } : { ok: false, v: '', code: r.code };
  };
  for (const p of ['claude', 'codex']) {
    it(`${p} resolves its own model`, () => assert.equal(model(p).v, `${p}-test`));
    it(`${p} receives exact model and prompt arguments`, () => assert.deepEqual(argvOf(p, `/fake/${p}`, 'prompt with spaces', model(p).v).slice(1), ['--model', `${p}-test`, 'prompt with spaces']));
  }
  it('provider model environment overrides config', () => assert.equal(model('codex', '', { GSD_CODEX_MODEL: 'env-test' }).v, 'env-test'));
  it('session model environment overrides provider environment', () => assert.equal(model('codex', '', { GSD_MODEL: 'global-test', GSD_CODEX_MODEL: 'env-test' }).v, 'global-test'));
  it('model CLI overrides environment', () => assert.equal(model('codex', 'cli-test', { GSD_MODEL: 'global-test' }).v, 'cli-test'));
  let dflt = '';
  it('explicit default clears model override', () => {
    dflt = model('codex', 'default', { GSD_MODEL: 'global-test' }).v;
    assert.equal(dflt, '');
  });
  it('default emits no model flag', () => assert.equal(argvOf('codex', 'codex', 'prompt', dflt).length, 2));
  it('custom model override is rejected', () => assert.equal(model('custom', 'unsupported').code, 64));
  it('model option injection rejected', () => assert.equal(model('codex', '--bad').code, 64));
  it('model whitespace rejected', () => assert.equal(model('codex', 'two words').code, 64));
  it('model command template with whitespace rejected', () => {
    const r = modelValidate('codex', 'model;$(touch never-created)');
    assert.equal(r?.code, 64);
  });
  it('shell metacharacters remain a literal model argument', () => assert.deepEqual(argvOf('codex', '/fake/codex', 'prompt', 'model;$(id)').slice(1), ['--model', 'model;$(id)', 'prompt']));
  it('invalid init model fails before bootstrap writes', () => {
    const I = path.join(WORK, 'init-model-invalid');
    repo(I);
    const r = init(I, ['--provider', 'codex', '--model', '--bad', '--no-launch', '--no-commit']);
    assert.ok(r.status !== 0 && !existsSync(path.join(I, '.gsd.conf')), r.out);
  });
  it('init prints selected session model', () => {
    const I = path.join(WORK, 'init-model');
    repo(I);
    const r = init(I, ['--new', '--provider', 'codex', '--model', 'model-test', '--no-launch', '--no-commit']);
    assert.ok(r.out.includes('codex -c model_auto_compact_token_limit=300000 --model model-test'), r.out);
  });
});

describe('start mode (gsdt-start discuss/flow selection)', () => {
  const R = path.join(WORK, 'start-mode');
  repo(R);
  write(path.join(R, '.planning', 'ROADMAP.md'), '# Roadmap\n\n### Phase 7: Test phase\n');
  writeFileSync(path.join(R, '.gsd.conf'), 'base = develop\nwtdir = start-worktrees\ninstall = none\nproviders = claude\n');
  gitOk(R, ['add', '.']);
  gitOk(R, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'planning']);
  const fake = ['--provider', 'custom', '--agent-command', 'fake-provider'];
  it('gsdt-start defaults to the flow', () => {
    const r = startP(R, [...fake, '--no-launch']);
    assert.match(r.out, /fake-provider Drive.*GSD.*phase.*7/);
  });
  it('gsdt-start suppresses stale worker next steps', () => assert.ok(!startP(R, [...fake, '--no-launch']).out.includes('Open an agent session there')));
  it('gsdt-start honors start_mode = discuss', () => {
    writeFileSync(path.join(R, '.gsd.conf'), `${rd(path.join(R, '.gsd.conf'))}start_mode = discuss\n`);
    assert.match(startP(R, [...fake, '--no-launch']).out, /fake-provider Discuss.*GSD.*phase.*7/);
  });
  it('--flow overrides start_mode = discuss', () => assert.match(startP(R, [...fake, '--flow', '--no-launch']).out, /fake-provider Drive.*GSD.*phase.*7/));
  it('--no-flow overrides earlier --flow', () => assert.match(startP(R, [...fake, '--flow', '--no-flow', '--no-launch']).out, /fake-provider Discuss.*GSD.*phase.*7/));
  it('--flow overrides earlier --no-flow', () => assert.match(startP(R, [...fake, '--no-flow', '--flow', '--no-launch']).out, /fake-provider Drive.*GSD.*phase.*7/));

  describe('bootstrap adapters and idempotence', () => {
    it('start prints selected session model', () => {
      const r = startP(R, ['--provider', 'codex', '--model', 'model-test', '--no-launch']);
      assert.ok(r.out.includes('codex -c model_auto_compact_token_limit=300000 --model model-test'), r.out);
    });
  });

  describe('compact point (compact_at)', () => {
    it('claude session compacts at 300000 by default', () => assert.ok(startP(R, ['--provider', 'claude', '--no-launch']).out.includes('env CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000 claude')));
    it('a compact window the user exported wins', () => assert.ok(!startP(R, ['--provider', 'claude', '--no-launch'], { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' }).out.includes('AUTO_COMPACT')));
    it('GSD_COMPACT_AT overrides the default', () => assert.ok(startP(R, ['--provider', 'codex', '--no-launch'], { GSD_COMPACT_AT: '300000' }).out.includes('model_auto_compact_token_limit=300000')));
    it('compact_at in .gsd.conf is used', () => {
      writeFileSync(path.join(R, '.gsd.conf'), `${rd(path.join(R, '.gsd.conf'))}compact_at = 250000\n`);
      assert.ok(startP(R, ['--provider', 'claude', '--no-launch']).out.includes('CLAUDE_CODE_AUTO_COMPACT_WINDOW=250000'));
    });
    it('default leaves the CLI setting', () => assert.ok(!startP(R, ['--provider', 'codex', '--no-launch'], { GSD_COMPACT_AT: 'default' }).out.includes('compact')));
    it('custom provider gets no compact flag', () => assert.ok(!startP(R, [...fake, '--no-launch']).out.includes('compact')));
    const compact = (env: Env = {}): { ok: boolean; v: string; code?: number } => {
      const r = withEnv(env, () => compactResolve(R));
      return r.ok ? { ok: true, v: r.value } : { ok: false, v: '', code: r.code };
    };
    it('resolve reads compact_at', () => assert.equal(compact().v, '250000'));
    it('compact_at below 100000 rejected', () => assert.equal(compact({ GSD_COMPACT_AT: '50' }).code, 64));
    it('compact_at not a number rejected', () => assert.equal(compact({ GSD_COMPACT_AT: '1e6' }).code, 64));
    it('a zero-padded value is read as decimal', () => assert.equal(compact({ GSD_COMPACT_AT: '0150000' }).v, '150000'));
    it('gsdt-start refuses a bad compact_at', () => {
      const r = startP(R, ['--provider', 'claude', '--no-launch'], { GSD_COMPACT_AT: '99' });
      assert.ok(r.status === 64 && r.out.includes('invalid compact_at'), `rc ${r.status}: ${r.out}`);
      writeFileSync(path.join(R, '.gsd.conf'), lines(path.join(R, '.gsd.conf')).filter((l) => !l.startsWith('compact_at')).join('\n'));
    });
  });

  describe('compact point saved in the worktree (a plain claude there gets it)', () => {
    const wtOf = (): string => {
      const w = git(R, ['worktree', 'list', '--porcelain']).stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
      return w.find((x) => /[\\/]phase-7-/.test(x)) ?? '';
    };
    const SET = (): string => path.join(wtOf(), '.claude', 'settings.local.json');
    const win = (): string => {
      try {
        const e = (JSON.parse(rd(SET())) as { env?: Record<string, string> }).env ?? {};
        return e.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? '';
      } catch {
        return '';
      }
    };
    it('gsdt-start writes the compact point into the worktree settings', () => {
      startP(R, ['--provider', 'claude', '--no-launch']);
      assert.equal(win(), '300000');
    });
    it('the settings file is ignored, so gsdt-finish can still remove the worktree', () => assert.equal(git(wtOf(), ['status', '--porcelain', '--', '.claude']).stdout.trim(), ''));
    it('a new value replaces the old one', () => {
      writeFileSync(SET(), '{\n  "permissions": {"allow": ["Bash(ls)"]},\n  "env": {"FOO": "1"}\n}\n');
      startP(R, ['--provider', 'claude', '--no-launch'], { GSD_COMPACT_AT: '250000' });
      assert.equal(win(), '250000');
    });
    it('other settings in the file are kept', () => assert.ok(rd(SET()).includes('Bash(ls)') && rd(SET()).includes('"FOO"')));
    it('a window the user exported removes ours (the file would beat it)', () => {
      startP(R, ['--provider', 'claude', '--no-launch'], { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' });
      assert.ok(win() === '' && rd(SET()).includes('"FOO"'));
    });
    it('compact_at = default removes it', () => {
      startP(R, ['--provider', 'claude', '--no-launch']);
      startP(R, [...fake, '--no-launch'], { GSD_COMPACT_AT: 'default' });
      assert.equal(win(), '');
    });
    it('a broken settings file is left alone and does not stop gsdt-start', () => {
      writeFileSync(SET(), 'not json');
      const r = startP(R, ['--provider', 'claude', '--no-launch']);
      assert.ok(r.status === 0 && rd(SET()) === 'not json' && r.out.includes('could not update'), `rc ${r.status}: ${r.out}`);
    });
    it('a repo without Claude gets no compact point in the Claude settings', () => {
      rmSync(SET(), { force: true });
      const c = path.join(R, '.gsd.conf');
      writeFileSync(c, lf(rd(c)).replace(/^providers = claude$/m, 'providers = codex'));
      startP(R, ['--provider', 'codex', '--no-launch']);
      assert.equal(win(), '');
      writeFileSync(c, lf(rd(c)).replace(/^providers = codex$/m, 'providers = claude'));
    });
    it('a file git would show as new work is not written', () => {
      const U = path.join(WORK, 'unignored');
      repo(U);
      writeFileSync(path.join(WORK, 'no-excludes'), '');
      gitOk(U, ['config', 'core.excludesFile', path.join(WORK, 'no-excludes')]); // not the machine's global ignore
      const out = compactSettings(U, U, '200000');
      assert.ok(!existsSync(path.join(U, '.claude', 'settings.local.json')) && out.includes('not gitignored'), out);
    });
  });

  describe('flow launch guard for every provider', () => {
    const wt = (): string => {
      const w = git(R, ['worktree', 'list', '--porcelain']).stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
      return w[w.length - 1] as string;
    };
    it('claude flow launch blocks pending install', () => {
      const WT = wt();
      mkdirSync(path.join(WT, '.planning', 'phases', '07-test'), { recursive: true });
      for (const a of ['TICKET', 'CONTEXT', 'REVIEWS']) writeFileSync(path.join(WT, '.planning', 'phases', '07-test', `07-${a}.md`), '');
      writeFileSync(path.join(WT, '.planning', 'phases', '07-test', '07-01-PLAN.md'), '');
      gitOk(WT, ['add', '.planning']);
      gitOk(WT, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ready']);
      writeFileSync(path.join(WT, '.gsd.conf'), 'base = develop\nflow = strict\ninstall = npm install\n');
      writeFileSync(path.join(WT, '.gsd-install.status'), 'running\n');
      mkdirSync(path.join(WT, 'node_modules'), { recursive: true });
      const r = startP(R, ['--provider', 'claude', '--flow', '--no-launch']);
      assert.ok(r.status === 2 && !r.out.includes('Next:  cd'), `rc ${r.status}: ${r.out}`);
    });
    it('codex flow launch blocks pending install', () => {
      const r = startP(R, ['--provider', 'codex', '--flow', '--no-launch']);
      assert.ok(r.status === 2 && !r.out.includes('Next:  cd'), `rc ${r.status}: ${r.out}`);
    });
    for (const p of ['claude', 'codex']) {
      it(`${p} flow launch permits completed install`, () => {
        writeFileSync(path.join(wt(), '.gsd-install.status'), 'ok\n');
        const r = startP(R, ['--provider', p, '--flow', '--no-launch']);
        assert.ok(r.status === 0 && r.out.includes('Next:  cd'), `rc ${r.status}: ${r.out}`);
      });
    }
  });
});

describe('bootstrap adapters', () => {
  for (const p of ['claude', 'codex']) {
    const R = path.join(WORK, p);
    const file = (): string => path.join(R, providerInstructionFile(p));
    const sums = (): string => `${rd(path.join(R, '.gsd', 'INSTRUCTIONS.md'))}\0${rd(file())}`;
    it(`${p} canonical instructions`, () => {
      repo(R);
      writeFileSync(file(), `user content ${p}\n`);
      bootstrap(R, ['--agent', p]);
      assert.ok(rd(path.join(R, '.gsd', 'INSTRUCTIONS.md')).includes('gsd-toolkit:canonical'));
    });
    it(`${p} preserves unrelated instructions`, () => assert.ok(rd(file()).includes(`user content ${p}`)));
    it(`${p} owns one marked block`, () => assert.equal(lines(file()).filter((l) => l.includes('provider:start')).length, 1));
    it(`${p} repeated bootstrap idempotent`, () => {
      const before = sums();
      bootstrap(R, ['--agent', p]);
      assert.equal(sums(), before);
    });
  }
  it('Codex creates no Claude integration', () => assert.ok(!existsSync(path.join(WORK, 'codex', 'CLAUDE.md')) && !existsSync(path.join(WORK, 'codex', '.claude', 'settings.json'))));
  it('Claude native hook present', () => assert.ok(rd(path.join(WORK, 'claude', '.claude', 'settings.json')).includes('gsdt-worktree-guard')));
  const M = path.join(WORK, 'multi');
  it('multi-provider config', () => {
    repo(M);
    writeFileSync(path.join(M, 'CLAUDE.md'), 'claude user\n');
    writeFileSync(path.join(M, 'AGENTS.md'), 'codex user\n');
    bootstrap(M, ['--agents', 'claude,codex']);
    assert.ok(lines(path.join(M, '.gsd.conf')).includes('providers = claude,codex'));
  });
  it('new config does not duplicate provider default', () => assert.ok(!lines(path.join(M, '.gsd.conf')).some((l) => l.startsWith('provider ='))));
  it('multi-provider files preserved', () => assert.ok(rd(path.join(M, 'CLAUDE.md')).includes('claude user') && rd(path.join(M, 'AGENTS.md')).includes('codex user')));
  const MC = path.join(WORK, 'multi-commands');
  it('bootstrap stores per-provider commands', () => {
    repo(MC);
    bootstrap(MC, ['--agents', 'claude,codex', '--provider-command', 'claude=claude-x', '--provider-command', 'codex=codex-x']);
    const l = lines(path.join(MC, '.gsd.conf'));
    assert.ok(l.includes('claude_command = claude-x') && l.includes('codex_command = codex-x'));
  });
  for (const p of ['claude', 'codex']) {
    it(`same phase renders ${p} adapter`, () => {
      const cmd = resolveOf(MC, p).v.split(':')[1] as string;
      const argv = argvOf(p, cmd, providerPrompt(p, 'discuss', '7'));
      assert.ok(providerRender(path.join(MC, 'phase-7-shared'), ...argv).includes(`${p}-x`));
    });
  }
  const L = path.join(WORK, 'legacy');
  const legacyText = 'before\n## GSD planning system\nlegacy toolkit scripts/hooks/gsdt-worktree-guard.sh\nrepo-specific policy\n## User section\nkeep me\n';
  it('legacy Claude instructions preserved byte-for-byte', () => {
    repo(L);
    writeFileSync(path.join(L, 'CLAUDE.md'), legacyText);
    bootstrap(L, ['--agent', 'claude']);
    assert.ok(rd(path.join(L, 'CLAUDE.md')).startsWith(legacyText));
  });
  it('legacy Claude repository policy remains active', () => assert.ok(rd(path.join(L, 'CLAUDE.md')).includes('repo-specific policy') && rd(path.join(L, 'CLAUDE.md')).includes('keep me')));
  it('legacy Claude gets one marked canonical adapter', () => {
    const t = rd(path.join(L, 'CLAUDE.md'));
    assert.ok(t.split('\n').filter((l) => l.includes('gsd-toolkit:provider:start')).length === 1 && t.includes('supersede older unmarked GSD text'));
  });
  it('legacy Claude migration creates no backup debris', () => assert.ok(!existsSync(path.join(L, 'CLAUDE.md.gsd-legacy.bak'))));
  const LC = path.join(WORK, 'legacy-config');
  it('legacy provider migrates to providers', () => {
    repo(LC);
    writeFileSync(path.join(LC, '.gsd.conf'), 'base = develop\nprovider = codex\ncustom_setting = keep\n');
    bootstrap(LC);
    const l = lines(path.join(LC, '.gsd.conf'));
    assert.ok(l.includes('providers = codex') && !l.some((x) => x.startsWith('provider =')));
  });
  it('legacy provider migration preserves unrelated config', () => assert.ok(lines(path.join(LC, '.gsd.conf')).includes('custom_setting = keep')));
  it('malformed provider settings preserved', () => {
    const B = path.join(WORK, 'bad-json');
    repo(B);
    write(path.join(B, '.claude', 'settings.json'), '{not json\n');
    const sum = rd(path.join(B, '.claude', 'settings.json'));
    bootstrap(B, ['--agent', 'claude']);
    assert.equal(rd(path.join(B, '.claude', 'settings.json')), sum);
  });
});

describe('init launch failure and print-only fallback', () => {
  let r: Run;
  it('print-only succeeds without provider executable', () => {
    const R = path.join(WORK, 'init-print');
    repo(R);
    r = init(R, ['--new', '--provider', 'custom', '--agent-command', 'provider-does-not-exist', '--no-launch', '--no-commit']);
    assert.equal(r.status, 0, r.out);
  });
  it('print-only prints safely rendered command', () => assert.ok(r.out.includes('provider-does-not-exist'), r.out));
  it('launch fails safely when executable is missing', () => {
    const I = path.join(WORK, 'init-launch');
    repo(I);
    const x = init(I, ['--new', '--provider', 'custom', '--agent-command', 'provider-does-not-exist', '--launch', '--no-commit']);
    assert.equal(x.status, 127, x.out);
  });
});

describe('multi-provider init', () => {
  let out = '';
  const R = path.join(WORK, 'init-multi');
  it('init writes explicit provider set', () => {
    repo(R);
    out = init(R, ['--new', '--providers', 'claude,codex', '--provider', 'codex', '--provider-command', 'codex=codex-special', '--no-launch', '--no-commit']).out;
    assert.ok(lines(path.join(R, '.gsd.conf')).includes('providers = claude,codex'));
  });
  it('init installs every selected adapter', () => assert.ok(rd(path.join(R, 'CLAUDE.md')).includes('provider:start') && rd(path.join(R, 'AGENTS.md')).includes('provider:start')));
  it('init renders selected provider command', () => assert.ok(out.includes('codex-special'), out));
  it('init defaults session to first listed provider', () => {
    const D = path.join(WORK, 'init-default-provider');
    repo(D);
    const o = init(D, ['--new', '--providers', 'codex,claude', '--provider-command', 'codex=codex-special', '--no-launch', '--no-commit']).out;
    assert.ok(o.includes('codex-special'), o);
  });
  it('legacy command flag targets selected provider', () => {
    const D = path.join(WORK, 'init-selected-command');
    repo(D);
    init(D, ['--new', '--providers', 'claude,codex', '--provider', 'codex', '--agent-command', 'codex-selected', '--no-launch', '--no-commit']);
    const l = lines(path.join(D, '.gsd.conf'));
    assert.ok(l.includes('codex_command = codex-selected') && !l.some((x) => x.startsWith('agent_command =')));
  });
  it('init rejects launch provider outside set', () => {
    const D = path.join(WORK, 'init-invalid-selection');
    repo(D);
    const r = init(D, ['--new', '--providers', 'claude', '--provider', 'codex', '--no-launch', '--no-commit']);
    assert.ok(r.status !== 0 && !existsSync(path.join(D, '.gsd.conf')), r.out);
  });
  it('init rejects command override outside set', () => {
    const D = path.join(WORK, 'init-invalid-command');
    repo(D);
    const r = init(D, ['--new', '--providers', 'claude', '--provider-command', 'codex=codex-x', '--no-launch', '--no-commit']);
    assert.ok(r.status !== 0 && !existsSync(path.join(D, '.gsd.conf')), r.out);
  });
});

describe('installer isolation, migration and malformed instruction regressions', () => {
  const SW = path.join(WORK, 'switch-executable');
  it('provider switch does not reuse previous executable', () => {
    repo(SW);
    writeFileSync(path.join(SW, '.gsd.conf'), 'providers = claude\nagent_command = claude-special\n');
    bootstrap(SW, ['--agent', 'codex']);
    assert.equal(resolveOf(SW).v, 'codex:codex');
  });
  it('migration preserves previous provider executable', () => assert.equal(resolveOf(SW, 'claude').v.split(':')[1], 'claude-special'));
  it('executable migration is idempotent', () => {
    const before = rd(path.join(SW, '.gsd.conf'));
    bootstrap(SW);
    assert.equal(rd(path.join(SW, '.gsd.conf')), before);
  });
  const OS = path.join(WORK, 'override-set');
  it('command override preserves configured provider set', () => {
    repo(OS);
    writeFileSync(path.join(OS, '.gsd.conf'), 'providers = claude,codex\nclaude_command = old-claude\n');
    init(OS, ['--provider-command', 'codex=codex-special', '--no-commit', '--no-launch']);
    assert.ok(lines(path.join(OS, '.gsd.conf')).includes('providers = claude,codex'));
  });
  it('explicit command overrides old provider-specific setting', () => {
    bootstrap(OS, ['--agent-command', 'new-claude']);
    assert.equal(resolveOf(OS, 'claude').v.split(':')[1], 'new-claude');
  });
  it('custom bootstrap can reuse saved executable', () => {
    const C = path.join(WORK, 'custom-repeat');
    repo(C);
    bootstrap(C, ['--agent', 'custom', '--agent-command', 'custom-cli']);
    assert.equal(bootstrap(C).status, 0);
  });
  const START = '<!-- gsd-toolkit:provider:start -->';
  const END = '<!-- gsd-toolkit:provider:end -->';
  const shapes: Record<string, string[]> = {
    unmatched: [START, 'user policy'],
    reversed: [END, 'user policy', START],
    duplicate: [START, END, 'user policy', START, END],
    nested: [START, START, 'user policy', END, END],
    inline: [`user policy ${START}`, END],
  };
  for (const p of ['claude', 'codex']) {
    for (const [shape, body] of Object.entries(shapes)) {
      it(`${p} ${shape} markers fail without changing files`, () => {
        const R = path.join(WORK, `markers-${p}-${shape}`);
        repo(R);
        const f = path.join(R, providerInstructionFile(p));
        writeFileSync(f, `${body.join('\n')}\n`);
        const before = rd(f);
        const r = bootstrap(R, ['--agent', p]);
        assert.ok(r.status !== 0 && rd(f) === before && !existsSync(path.join(R, '.gsd.conf')), `rc ${r.status}: ${r.out}`);
      });
    }
  }
  const OB = path.join(WORK, 'owned-block-bytes');
  it('owned-block update preserves user suffix without newline', () => {
    repo(OB);
    writeFileSync(path.join(OB, 'AGENTS.md'), `user prefix\n${START}\nold owned block\n${END}\nuser tail`);
    bootstrap(OB, ['--agent', 'codex']);
    assert.ok(rd(path.join(OB, 'AGENTS.md')).endsWith('user tail'));
  });
  it('byte-preserving owned update is idempotent', () => {
    const before = rd(path.join(OB, 'AGENTS.md'));
    bootstrap(OB, ['--agent', 'codex']);
    assert.equal(rd(path.join(OB, 'AGENTS.md')), before);
  });
  it('a symlinked AGENTS.md stays a link', { skip: winSkip('symlinks need developer mode on Windows') }, () => {
    renameSync(path.join(OB, 'AGENTS.md'), path.join(OB, 'AGENTS-real.md'));
    symlinkSync('AGENTS-real.md', path.join(OB, 'AGENTS.md'));
    rmSync(path.join(OB, '.gsd'), { recursive: true, force: true });
    bootstrap(OB, ['--agent', 'codex']);
    assert.ok(lstatSync(path.join(OB, 'AGENTS.md')).isSymbolicLink() && rd(path.join(OB, 'AGENTS-real.md')).includes('gsd-toolkit:provider:start'));
    rmSync(path.join(OB, 'AGENTS.md'));
    renameSync(path.join(OB, 'AGENTS-real.md'), path.join(OB, 'AGENTS.md'));
  });
  it('a .gitignore with no final newline keeps its last line', () => {
    const G = path.join(WORK, 'gitignore-nl');
    repo(G);
    writeFileSync(path.join(G, '.gitignore'), 'node_modules');
    bootstrap(G, ['--agent', 'codex']);
    const l = lines(path.join(G, '.gitignore'));
    assert.ok(l.includes('node_modules') && l.includes('.gsd-install.status'));
  });
});

/** A bin dir holding this package's guard and rules commands (what the Claude hooks run); wrappers work on every OS. */
function mkBin(dir: string): string {
  mkdirSync(dir, { recursive: true });
  for (const [n, cmd] of [['gsdt-worktree-guard', 'worktree-guard'], ['gsdt-rules', 'rules']] as const) {
    stubExe(dir, n, `exec '${fwd(process.execPath)}' '${fwd(path.join(PKG, 'src', 'launch.mjs'))}' ${cmd} "$@"`, `"${process.execPath}" "${path.join(PKG, 'src', 'launch.mjs')}" ${cmd} %*`);
  }
  return dir;
}
const setupRun = (args: string[], env: Env): Run => run('setup', args, { env: { GSD_SETUP_MODE: 'npm', ...env } });

describe('skill installs (gsdt-setup)', () => {
  const BIN = mkBin(path.join(WORK, 'bin'));
  const sk = (p: string): string => path.join(WORK, 'skills', p);
  const env = (xdg: string, extra: Env = {}): Env => ({ XDG_CONFIG_HOME: path.join(WORK, xdg), GSD_BIN_DIR: BIN, GSD_CLAUDE_SKILL_DIR: sk('claude'), GSD_CODEX_SKILL_DIR: sk('codex'), ...extra });
  it('claude skills installed', () => {
    write(path.join(sk('claude'), 'gsdt-flow', 'user.txt'), 'mine\n');
    const r = setupRun(['--all-agents'], env('xdg-a'));
    assert.ok(existsSync(path.join(sk('claude'), 'gsdt-flow', 'SKILL.md')), r.out);
  });
  it('codex skills installed', () => assert.ok(existsSync(path.join(sk('codex'), 'gsdt-flow', 'SKILL.md'))));
  it('real skill directory preserved as backup', () => assert.ok(existsSync(path.join(sk('claude'), 'gsdt-flow.bak', 'user.txt'))));
  it('repeated skill install stays usable', () => {
    setupRun(['--agent', 'claude'], env('xdg-a'));
    assert.ok(existsSync(path.join(sk('claude'), 'gsdt-flow', 'SKILL.md')));
  });
  it('unrelated existing symlink preserved as backup', { skip: winSkip('symlinks need developer mode on Windows') }, () => {
    const link = path.join(WORK, 'skills-link', 'codex');
    mkdirSync(link, { recursive: true });
    symlinkSync(path.join(WORK, 'unrelated-skill'), path.join(link, 'gsdt-flow'));
    setupRun(['--agent', 'codex'], env('xdg-b', { GSD_CODEX_SKILL_DIR: link }));
    assert.ok(lstatSync(path.join(link, 'gsdt-flow.bak')).isSymbolicLink());
  });
});

describe('user-level hook (/gsd-new-project only after gsdt-init)', () => {
  const UH = path.join(WORK, 'uh');
  const BIN = mkBin(path.join(UH, 'bin'));
  const SETTINGS = path.join(UH, 'claude', 'settings.json');
  const env = (xdg: string, extra: Env = {}): Env => ({ XDG_CONFIG_HOME: path.join(UH, xdg), GSD_BIN_DIR: BIN, GSD_CLAUDE_SKILL_DIR: path.join(UH, 'claude', 'skills'), GSD_CODEX_SKILL_DIR: path.join(UH, 'codex', 'skills'), ...extra });
  const uinstall = (args: string[], xdg = 'xdg', extra: Env = {}): Run => setupRun(args, env(xdg, extra));
  type Hooks = Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
  const settingsOf = (f: string): { hooks?: Hooks; model?: string } => JSON.parse(rd(f));
  const hookCmds = (f: string, event?: string): string[] => {
    const h = settingsOf(f).hooks ?? {};
    return Object.entries(h).flatMap(([ev, arr]) => (event === undefined || ev === event ? (arr ?? []).flatMap((e) => (e.hooks ?? []).map((x) => x.command ?? '')) : []));
  };
  const ours = (f: string): number => hookCmds(f).filter((c) => /gsdt-worktree-guard.*--global/.test(c)).length;
  const rulesHooks = (f: string): number => hookCmds(f, 'SessionStart').filter((c) => /gsdt-rules.*--hook/.test(c)).length;
  let rcmd = '';
  let cmd = '';
  it('claude settings get the Skill + UserPromptExpansion hooks', () => {
    write(SETTINGS, '{"model":"opus","hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo mine"}]}]}}\n');
    const r = uinstall(['--all-agents']);
    assert.equal(ours(SETTINGS), 2, r.out);
  });
  it("…next to the user's own hook and keys", () => {
    const s = settingsOf(SETTINGS);
    assert.ok(s.model === 'opus' && (s.hooks?.PreToolUse ?? []).some((e) => e.matcher === 'Bash'));
  });
  // the matcher is a regex: a bare word "gsd" is an exact match and never fires for /gsd-new-project
  it('typed slash commands are covered (matcher gsd.*)', () => assert.ok((settingsOf(SETTINGS).hooks?.UserPromptExpansion ?? []).some((e) => e.matcher === 'gsd.*')));
  it('codex gets no settings file', () => assert.ok(!existsSync(path.join(UH, 'codex', 'settings.json'))));
  it('reinstall does not duplicate it', () => {
    uinstall([]);
    assert.equal(ours(SETTINGS), 2);
  });
  it('claude settings get the gsdt-rules SessionStart hook, once', () => assert.equal(rulesHooks(SETTINGS), 1));
  it('…for every session source (no matcher)', () => assert.ok((settingsOf(SETTINGS).hooks?.SessionStart ?? []).every((e) => !('matcher' in e))));
  it('the installed hook loads the rules in a set-up repo', () => {
    rcmd = (settingsOf(SETTINGS).hooks?.SessionStart ?? [])[0]?.hooks?.[0]?.command ?? '';
    const RR = path.join(UH, 'repo');
    repo(RR);
    writeFileSync(path.join(RR, '.gsd.conf'), 'base = develop\n');
    const r = exec('sh', ['-c', rcmd], { cwd: RR, input: '{"source":"startup"}', env: E({ CLAUDE_PROJECT_DIR: undefined }) });
    assert.ok(/^GSD toolkit rules/m.test(r.stdout) && r.stdout.includes('base `develop`'), r.out);
  });
  it('…and prints nothing elsewhere', () => {
    const plain = path.join(WORK, 'uh-plain');
    mkdirSync(plain, { recursive: true });
    const r = exec('sh', ['-c', rcmd], { cwd: plain, input: '{}', env: E({ CLAUDE_PROJECT_DIR: undefined }) });
    assert.ok(r.stdout === '' && r.status === 0, r.out);
  });
  it('a removed toolkit: the rules hook exits 0', () => {
    const gone = rcmd.split(fwd(BIN)).join(fwd(path.join(UH, 'gone')));
    assert.notEqual(gone, rcmd, 'the hook names the bin dir');
    assert.equal(exec('sh', ['-c', gone], { input: '{}', env: E({ CLAUDE_PROJECT_DIR: undefined }) }).status, 0);
  });
  it('the installed command blocks /gsd-new-project in a bare repo', () => {
    cmd = (settingsOf(SETTINGS).hooks?.UserPromptExpansion ?? [])[0]?.hooks?.[0]?.command ?? '';
    const bare = path.join(UH, 'bare');
    mkdirSync(bare, { recursive: true });
    gitOk(bare, ['init', '-q']);
    const r = exec('sh', ['-c', cmd], { cwd: bare, input: JSON.stringify({ command_name: 'gsd-new-project', command_args: '', cwd: bare }), env: E({ CLAUDE_PROJECT_DIR: undefined }) });
    assert.equal(r.status, 2, r.out);
  });
  it('a removed toolkit fails open (exit 0)', () => {
    const gone = cmd.split(fwd(BIN)).join(fwd(path.join(UH, 'gone')));
    assert.notEqual(gone, cmd, 'the hook names the bin dir');
    assert.equal(exec('sh', ['-c', gone], { input: '{}', env: E({ CLAUDE_PROJECT_DIR: undefined }) }).status, 0);
  });
  it('--no-user-hook removes it', () => {
    uinstall(['--no-user-hook']);
    assert.equal(ours(SETTINGS), 0);
  });
  it('--no-user-hook removes the gsdt-rules hook too', () => assert.ok(rulesHooks(SETTINGS) === 0 && !('SessionStart' in (settingsOf(SETTINGS).hooks ?? {}))));
  it("…keeping the user's own hook", () => assert.ok((settingsOf(SETTINGS).hooks?.PreToolUse ?? []).some((e) => e.matcher === 'Bash')));
  it('…and the opt-out is remembered', () => assert.ok(lines(path.join(UH, 'xdg', 'gsd', 'setup-manifest')).includes('user_hook\toff')));
  it('a later reinstall keeps it off', () => {
    uinstall([]);
    assert.equal(ours(SETTINGS), 0);
  });
  it('hooks turned off by the user → left unchanged', () => {
    writeFileSync(SETTINGS, '{"disableAllHooks":true}\n');
    uinstall(['--agent', 'claude'], 'xdg2');
    assert.equal(lf(rd(SETTINGS)).trim(), '{"disableAllHooks":true}');
  });
  const real = path.join(UH, 'real-settings.json');
  it('a symlinked settings.json stays a link…', { skip: winSkip('symlinks need developer mode on Windows') }, () => {
    writeFileSync(real, '{}\n');
    chmodSync(real, 0o600);
    rmSync(SETTINGS, { force: true });
    symlinkSync(real, SETTINGS);
    uinstall(['--agent', 'claude'], 'xdg3');
    assert.ok(lstatSync(SETTINGS).isSymbolicLink());
  });
  it('…and the hook is written to its target', { skip: winSkip('symlinks need developer mode on Windows') }, () => assert.equal(ours(real), 2));
  it('…the gsdt-rules hook too', { skip: winSkip('symlinks need developer mode on Windows') }, () => assert.equal(rulesHooks(real), 1));
  it('…keeping its 0600 mode', { skip: winSkip('POSIX file modes') }, () => assert.equal(statSync(real).mode & 0o777, 0o600));
  it('broken settings JSON → left unchanged', () => {
    rmSync(SETTINGS, { force: true });
    writeFileSync(SETTINGS, 'not json');
    uinstall(['--agent', 'claude'], 'xdg4');
    assert.equal(rd(SETTINGS), 'not json');
  });
});

describe('Gemini: refused, and an older setup is cleaned up', () => {
  const R = path.join(WORK, 'gone');
  repo(R);
  write(path.join(R, '.planning', 'ROADMAP.md'), '### Phase 7: Test\n');
  it('gemini as a provider → refused with the reason', () => {
    const r = resolveOf(R, 'gemini');
    assert.ok(r.code === 64 && (r.msg ?? '').includes('no longer supported'), JSON.stringify(r));
  });
  it('GSD_AGENT=gemini → refused, not run as a custom command', () => assert.equal(resolveOf(R, '', '', { GSD_AGENT: 'gemini' }).code, 64));
  it('gsdt-start --agent gemini → refused with the reason', () => {
    const r = startP(R, ['--agent', 'gemini', '--no-launch']);
    assert.ok(r.out.includes('no longer supported') && worktreeCount(R) === 1, r.out);
  });
  it('gsdt-init --agent gemini → refused, nothing written', () => {
    const r = init(R, ['--new', '--agent', 'gemini', '--no-launch', '--no-commit']);
    assert.ok(r.status !== 0 && !existsSync(path.join(R, '.gsd.conf')), r.out);
  });
  it('bootstrap --agent gemini → refused', () => {
    const r = bootstrap(R, ['--agent', 'gemini']);
    assert.ok(r.status !== 0 && !existsSync(path.join(R, '.gsd.conf')), r.out);
  });
  it('install.sh --agent gemini → refused', () => {
    const r = exec('bash', [path.join(PKG, 'install.sh'), '--agent', 'gemini'], { env: E({ GSD_BIN_DIR: path.join(WORK, 'gone-bin') }) });
    assert.ok(r.status !== 0 && !existsSync(path.join(WORK, 'gone-bin')), r.out);
  });
  it('review_provider = gemini → refused with the reason', () => {
    writeFileSync(path.join(R, '.gsd.conf'), 'review_provider = gemini\n');
    const r = run('flow-next', ['7', '--repo', R]);
    assert.ok(r.out.includes('no longer supported'), r.out);
    rmSync(path.join(R, '.gsd.conf'), { force: true });
  });
  // what an older release set up: gemini in providers, a key, GEMINI.md's block
  // (next to the user's own text), the hook (next to the user's own setting)
  const oldGemini = (dir: string, userText: string, userKey: string): void => {
    repo(dir);
    bootstrap(dir, ['--agent', 'claude']);
    write(path.join(dir, '.planning', 'ROADMAP.md'), '### Phase 7: Test\n');
    const c = path.join(dir, '.gsd.conf');
    writeFileSync(c, `${lf(rd(c)).replace(/^providers = claude$/m, 'providers = claude,gemini')}gemini_command = gem-x\n`);
    writeFileSync(path.join(dir, 'GEMINI.md'), `${userText === '' ? '' : `${userText}\n\n`}<!-- gsd-worktrees:provider:start -->\n## GSD worktrees (gemini adapter)\nold\n<!-- gsd-worktrees:provider:end -->\n`);
    write(
      path.join(dir, '.gemini', 'settings.json'),
      `{${userKey === '' ? '' : `"${userKey}":1,`}"hooks":{"BeforeTool":[{"matcher":"activate_skill|run_shell_command","hooks":[{"type":"command","command":"scripts/hooks/gsdt-worktree-guard.sh"}]}]}}\n`,
    );
    gitOk(dir, ['add', '-A']);
    gitOk(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'old']);
  };
  const OG = path.join(WORK, 'old-gemini');
  it('doctor: T061 names every leftover', () => {
    oldGemini(OG, 'my gemini notes', 'theme');
    const f = doctorJson(OG).json.findings.find((x) => x.code === 'T061');
    assert.ok(f !== undefined && ['providers', 'gemini_*-keys', 'GEMINI.md', '.gemini/settings.json'].every((n) => f.message.includes(n)) && f.fix === 'gsdt-init --no-launch', JSON.stringify(f));
  });
  it('…and no T050 / T054 for the same thing', () => assert.ok(!hasCode(OG, 'T050') && !hasCode(OG, 'T054')));
  it('gsdt-start in that repo → refused, says gsdt-init --no-launch', () => {
    const r = run('start', ['-p', '7', '--repo', OG, '--no-launch']);
    assert.ok(r.status !== 0 && r.out.includes('gsdt-init --no-launch'), `rc ${r.status}: ${r.out}`);
  });
  it('gsdt-init cleans it up', () => {
    const r = init(OG, ['--no-launch', '--no-commit']);
    const l = lines(path.join(OG, '.gsd.conf'));
    assert.ok(r.status === 0 && l.includes('providers = claude') && !l.some((x) => /gemini_|,gemini/.test(x)), `rc ${r.status}: ${r.out}`);
  });
  it('…GEMINI.md keeps the user text, loses our block', () => {
    const t = rd(path.join(OG, 'GEMINI.md'));
    assert.ok(t.includes('my gemini notes') && !/gsd-(toolkit|worktrees)/.test(t));
  });
  it('….gemini/settings.json keeps the user key, loses our hook', () => {
    const j = JSON.parse(rd(path.join(OG, '.gemini', 'settings.json'))) as Record<string, unknown>;
    assert.ok(j.theme === 1 && !('hooks' in j));
  });
  it('…then doctor: no T061', () => assert.ok(!hasCode(OG, 'T061')));
  it('only our block and hook → GEMINI.md and .gemini/ are gone', () => {
    const D = path.join(WORK, 'old-gemini-only');
    oldGemini(D, '', '');
    init(D, ['--no-launch', '--no-commit']);
    assert.ok(!existsSync(path.join(D, 'GEMINI.md')) && !existsSync(path.join(D, '.gemini')));
  });
  it('bootstrap --commit commits the clean-up', () => {
    const D = path.join(WORK, 'old-gemini-commit');
    oldGemini(D, '', '');
    bootstrap(D, ['--commit']);
    assert.ok(git(D, ['status', '--porcelain']).stdout.trim() === '' && git(D, ['ls-files', '--error-unmatch', 'GEMINI.md']).status !== 0);
  });
  // GEMINI.md as a link to AGENTS.md shows the Codex block: never cleaned, never T061
  const GL = path.join(WORK, 'gemini-link');
  it('GEMINI.md → AGENTS.md link: AGENTS.md keeps the codex block, the link stays', { skip: winSkip('symlinks need developer mode on Windows') }, () => {
    repo(GL);
    bootstrap(GL, ['--agent', 'claude', '--agent', 'codex']);
    symlinkSync('AGENTS.md', path.join(GL, 'GEMINI.md'));
    bootstrap(GL, ['--agent', 'claude', '--agent', 'codex']);
    assert.ok(rd(path.join(GL, 'AGENTS.md')).includes('gsd-toolkit:provider:start') && lstatSync(path.join(GL, 'GEMINI.md')).isSymbolicLink());
  });
  it('…and doctor: no T061', { skip: winSkip('needs the symlink above') }, () => assert.ok(!hasCode(GL, 'T061')));
  // legacy provider = gemini with agent_command: that command ran Gemini, so it
  // must not become claude_command
  it('provider = gemini + agent_command → providers = claude, no claude_command', () => {
    const D = path.join(WORK, 'gemini-agent-command');
    repo(D);
    writeFileSync(path.join(D, '.gsd.conf'), `provider = gemini\nagent_command = ${process.execPath}\n`);
    bootstrap(D);
    const l = lines(path.join(D, '.gsd.conf'));
    assert.ok(l.includes('providers = claude') && !l.some((x) => /^(claude_command|agent_command)/.test(x)), l.join('|'));
  });
  // a user's own Gemini setting that only mentions the guard is not ours
  it('a setting that only mentions gsdt-worktree-guard → no T061', () => {
    const D = path.join(WORK, 'gemini-mention');
    repo(D);
    bootstrap(D, ['--agent', 'claude']);
    write(path.join(D, '.gemini', 'settings.json'), '{"note":"see gsdt-worktree-guard docs"}\n');
    assert.ok(!hasCode(D, 'T061'));
  });
  // our GEMINI.md, never tracked: --commit stages only what git knew
  it('untracked GEMINI.md + --commit → removed, no git add error', () => {
    const D = path.join(WORK, 'gemini-untracked');
    repo(D);
    bootstrap(D, ['--agent', 'claude']);
    gitOk(D, ['add', '-A']);
    gitOk(D, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'boot']);
    writeFileSync(path.join(D, 'GEMINI.md'), '<!-- gsd-worktrees:provider:start -->\nold\n<!-- gsd-worktrees:provider:end -->\n');
    writeFileSync(path.join(D, '.git', 'info', 'exclude'), `${rd(path.join(D, '.git', 'info', 'exclude'))}GEMINI.md\n`);
    const r = bootstrap(D, ['--agent', 'claude', '--commit']);
    assert.ok(r.status === 0 && !existsSync(path.join(D, 'GEMINI.md')) && !r.out.includes('pathspec'), `rc ${r.status}: ${r.out}`);
  });
  // our hook under another path spelling: still ours (doctor finds it by name)
  const HP = path.join(WORK, 'gemini-hook-path');
  it('"./scripts/hooks/gsdt-worktree-guard.sh" hook → removed, user key kept', () => {
    repo(HP);
    bootstrap(HP, ['--agent', 'claude']);
    write(path.join(HP, '.gemini', 'settings.json'), '{"theme":1,"hooks":{"BeforeTool":[{"hooks":[{"type":"command","command":"./scripts/hooks/gsdt-worktree-guard.sh"}]}]}}\n');
    bootstrap(HP, ['--agent', 'claude']);
    const j = JSON.parse(rd(path.join(HP, '.gemini', 'settings.json'))) as Record<string, unknown>;
    assert.ok(j.theme === 1 && !('hooks' in j));
  });
  it('…and doctor: no T061', () => assert.ok(!hasCode(HP, 'T061')));
});
function existsSyncLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

describe('provider-neutral guard and doctor', () => {
  it('doctor JSON reports resolved model', () => {
    appendConf(path.join(WORK, 'codex'), 'codex_model = model-test\n');
    assert.equal(doctorJson(path.join(WORK, 'codex')).json.session_model, 'model-test');
  });
  it('doctor reports invalid model configuration', () => {
    const R = path.join(WORK, 'bad-model');
    repo(R);
    bootstrap(R, ['--agent', 'codex']);
    appendConf(R, 'codex_model = --invalid\n');
    assert.ok(hasCode(R, 'T059'));
  });
  for (const p of ['claude', 'codex']) {
    const R = path.join(WORK, `guard-${p}`);
    const guard = (): number => run('worktree-guard', ['--command', 'gsd-plan-phase', '--phase', '7', '--repo', R]).status;
    it(`${p} strict flow blocks missing discuss`, () => {
      repo(R);
      gitOk(R, ['checkout', '-q', '-b', 'phase-7-test']);
      mkdirSync(path.join(R, '.planning', 'phases', '07-test'), { recursive: true });
      writeFileSync(path.join(R, '.gsd.conf'), `providers = ${p}\nflow = strict\ninstall = none\n`);
      assert.equal(guard(), 2);
    });
    it(`${p} strict flow permits completed discuss`, () => {
      writeFileSync(path.join(R, '.planning', 'phases', '07-test', '07-CONTEXT.md'), '');
      assert.equal(guard(), 0);
    });
    it(`${p} base branch remains blocked`, () => {
      gitOk(R, ['checkout', '-q', 'develop']);
      assert.equal(guard(), 2);
    });
  }
  for (const p of ['claude', 'codex']) {
    it(`${p} doctor JSON provider`, () => assert.ok(doctorJson(path.join(WORK, p)).text.includes(`"name":"${p}"`)));
    it(`${p} doctor reports command guard`, () => assert.ok(doctorJson(path.join(WORK, p)).text.includes('"command_guard":true')));
    it(`${p} doctor has no false duplicate-block finding`, () => assert.ok(!doctorJson(path.join(WORK, p)).text.includes('"code":"T055"')));
  }
  it('doctor reports all configured providers', () => assert.ok(doctorJson(path.join(WORK, 'multi')).text.includes('"configured":["claude","codex"]')));
  it('Codex reports unsupported native hook', () => assert.ok(doctorJson(path.join(WORK, 'codex')).text.includes('"native_hook":"unsupported"')));
  it('doctor reports absent supported native hook', () => {
    renameSync(path.join(WORK, 'claude', '.claude', 'settings.json'), path.join(WORK, 'claude', '.claude', 'settings.saved'));
    assert.ok(doctorJson(path.join(WORK, 'claude')).text.includes('"native_hook":"absent"'));
  });
  it('doctor JSON reports invalid provider finding', () => {
    writeFileSync(path.join(WORK, 'codex', '.gsd.conf'), 'providers = invalid\n');
    assert.ok(doctorJson(path.join(WORK, 'codex')).text.includes('"code":"T050"'));
  });
  it('doctor reports contradictory legacy provider', () => {
    writeFileSync(path.join(WORK, 'codex', '.gsd.conf'), 'provider = claude\nproviders = codex,claude\n');
    assert.ok(doctorJson(path.join(WORK, 'codex')).text.includes('"code":"T056"'));
  });
  it('doctor JSON reports stale provider artifact', () => {
    writeFileSync(path.join(WORK, 'codex', '.gsd.conf'), 'providers = codex\n');
    writeFileSync(path.join(WORK, 'codex', 'CLAUDE.md'), rd(path.join(WORK, 'claude', 'CLAUDE.md')));
    assert.ok(doctorJson(path.join(WORK, 'codex')).text.includes('"code":"T054"'));
  });
});
function appendConf(R: string, t: string): void {
  writeFileSync(path.join(R, '.gsd.conf'), rd(path.join(R, '.gsd.conf')) + t);
}

describe('the split instructions: a small local block, the rules from gsdt-rules', () => {
  const canon = lf(canonicalBlock('claude,codex', 'claude', 'main', 'x-worktrees'));
  const cl = canon.replace(/\n$/, '').split('\n');
  const entryClaude = lf(providerEntryBlock('claude'));
  const entryAgents = lf(providerEntryBlock('codex,custom'));
  it('local block keeps the canonical markers', () => assert.ok(cl[0] === '<!-- gsd-toolkit:canonical:start -->' && cl[cl.length - 1] === '<!-- gsd-toolkit:canonical:end -->'));
  it('local block points at gsdt-rules', () => assert.ok(canon.includes('run `gsdt-rules` and follow its output')));
  it('local block says how to get gsdt-rules', () => assert.ok(canon.includes('If `gsdt-rules` is not found, install the toolkit')));
  it('local block keeps the core: one phase = one worktree', () => assert.ok(canon.includes('One phase = one `phase-<N>-<slug>` git worktree')));
  it('…gsdt-flow-next before every phase action', () => assert.ok(canon.includes('Run `gsdt-flow-next <N>` before every phase action')));
  it('…gsdt-finish never automatic', () => assert.ok(canon.includes('`gsdt-finish` is never automatic')));
  it('…never bypass a guard', () => assert.ok(canon.includes('Never bypass a guard')));
  it('local block holds the values gsdt-init writes (providers, base, worktrees)', () => assert.ok(canon.includes('Providers: `claude,codex` (default: first, `claude`); base `main`;') && cl.includes('worktrees `../x-worktrees/`.')));
  it('…not flow / ui_gates (gsdt-rules reads them live)', () => assert.ok(!/flow `|ui_gates `/.test(canon)));
  it('local block leaves out the full rules', () => assert.ok(!canon.includes('The shell commands are the source of truth') && !canon.includes('Screens:')));
  it('local block is small (< 1.2 KB)', () => assert.ok(Buffer.byteLength(canon) < 1200));
  for (const [name, text] of [['entry-claude', entryClaude], ['entry-agents', entryAgents]] as const) {
    it(`${name}: still reads .gsd/INSTRUCTIONS.md`, () => assert.ok(text.includes('Read and follow `.gsd/INSTRUCTIONS.md`')));
    it(`${name}: names gsdt-rules`, () => assert.ok(text.includes('gsdt-rules')));
  }
  it('Claude entry: the hook loads the rules, the line is the fallback', () => assert.ok(entryClaude.includes('session-start hook loads') && entryClaude.includes('when they are not in your context, run `gsdt-rules`')));
  it('Codex/custom entry: run gsdt-rules first', () => assert.ok(entryAgents.includes('Before any GSD or phase work, run `gsdt-rules` and follow its output') && !entryAgents.includes('session-start hook')));
  it('bootstrap writes the small local block', () => {
    const t = rd(path.join(WORK, 'claude', '.gsd', 'INSTRUCTIONS.md'));
    assert.ok(t.includes('run `gsdt-rules`') && !t.includes('The shell commands are the source of truth'));
  });
  it('bootstrap writes the provider entry with gsdt-rules', () => assert.ok(rd(path.join(WORK, 'claude', 'CLAUDE.md')).includes('gsdt-rules')));

  const OUTSIDE = path.join(WORK, 'outside');
  mkdirSync(OUTSIDE, { recursive: true });
  const chomp = (s: string): string => s.replace(/\n+$/, '');
  it('gsdt-rules --help', () => {
    const r = run('rules', ['--help']);
    assert.ok(r.out.includes('print the GSD toolkit') && r.out.includes('--hook'), r.out);
  });
  it('gsdt-rules: unknown argument → exit 2', () => assert.equal(run('rules', ['--nope']).status, 2));
  let out = '';
  it('outside a repo: all the rules, screens included', () => {
    out = chomp(run('rules', [], { cwd: OUTSIDE }).stdout);
    assert.ok(out.includes('The shell commands are the source of truth') && /^Screens:/m.test(out));
  });
  it('outside a repo: no values line', () => assert.ok(!/^Providers:/m.test(out)));
  it('outside a repo: the same text as gsd_rules_text', () => assert.equal(out, chomp(lf(rulesText('on')))));
  it('outside a repo, the hook prints nothing and exits 0', () => {
    const r = run('rules', ['--hook'], { cwd: OUTSIDE, input: '{"source":"startup"}' });
    assert.ok(r.stdout === '' && r.status === 0, r.out);
  });
  it('the hook never fails (no such dir)', () => {
    const r = run('rules', ['--hook'], { cwd: OUTSIDE, env: { CLAUDE_PROJECT_DIR: path.join(WORK, 'nosuch') } });
    assert.ok(r.status === 0 && r.out === '', `rc ${r.status}: ${r.out}`);
  });
  const R = path.join(WORK, 'rules');
  it('in a repo: the rules + screens (ui_gates unset = warn)', () => {
    repo(R);
    writeFileSync(path.join(R, '.gsd.conf'), 'base = develop\nwtdir = rt\nproviders = codex,claude\nflow = strict\n');
    out = chomp(run('rules', ['--repo', R]).stdout);
    assert.ok(out.includes('The shell commands are the source of truth') && /^Screens:/m.test(out));
  });
  it('in a repo: its values', () => assert.ok(out.split('\n').slice(-2).join(' ').includes('Providers: `codex,claude` (default: first, `codex`); base `develop`; worktrees `../rt/`; flow `strict`; ui_gates `warn`.'), out.split('\n').slice(-2).join(' ')));
  it('ui_gates = off: no screens paragraph', () => {
    appendConf(R, 'ui_gates = off\n');
    out = chomp(run('rules', ['--repo', R]).stdout);
    assert.ok(!/^Screens:/m.test(out) && out.includes('ui_gates `off`'));
  });
  it('from a subfolder: the repo is found', () => {
    mkdirSync(path.join(R, 'sub'), { recursive: true });
    assert.ok(run('rules', [], { cwd: path.join(R, 'sub') }).stdout.includes('base `develop`'));
  });
  it('the hook in a phase worktree: header + rules + values', () => {
    gitOk(R, ['add', '-A']);
    gitOk(R, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'conf']);
    gitOk(R, ['worktree', 'add', '-q', path.join(WORK, 'rules-wt'), '-b', 'phase-1-x']);
    const o = run('rules', ['--hook'], { cwd: path.join(WORK, 'rules-wt'), input: '{}\n' }).stdout;
    assert.ok(/^GSD toolkit rules \(gsdt-rules, gsd-toolkit /.test(o.split('\n')[0] ?? '') && o.includes('base `develop`'), o.slice(0, 200));
  });
  let hook = '';
  it('the hook uses CLAUDE_PROJECT_DIR', () => {
    hook = run('rules', ['--hook'], { cwd: OUTSIDE, input: '{}\n', env: { CLAUDE_PROJECT_DIR: R } }).stdout;
    assert.ok(hook.includes('gsd-toolkit '), hook.slice(0, 200));
  });
  it('the hook output stays well under the 10 KB cut', () => assert.ok(Buffer.byteLength(hook) < 6000));
});
