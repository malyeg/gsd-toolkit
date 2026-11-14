// P8 parity (gsdt-init, gsdt-bootstrap-repo): the TypeScript commands behind the launchers against
// the pre-P8 bash commands (tests/fixtures/p8-old-bins/), each on its own copy of the same fixture
// repo. Compared: stdout, stderr, exit code of every step, and every file the commands leave
// (contents + the executable bit; the full tree, backups included), the commits, the hook and the
// merge driver. Normalized: each side's temp root and package dir.
// Run: node --test tests/ts/p8-init.test.ts   (P8_ONLY=<regex> runs the tests whose name matches)
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPath, git, norm, runStep, scenario, sh, write, makeSide, type Project, type Side, type Step } from './p6-helpers.ts';

const only = process.env.P8_ONLY ? new RegExp(process.env.P8_ONLY) : null;
const t = (name: string, fn: () => void): void => void test(name, { skip: only !== null && !only.test(name) }, fn);

const D = path.delimiter;
const FRESH: Project = { conf: null, noPlanning: true, files: { 'README.md': 'hello\n' } };
const withFiles = (files: Record<string, string>, extra: Project = {}): Project => ({ ...FRESH, ...extra, files: { ...FRESH.files, ...files } });

/** a gsdt-init / gsdt-bootstrap-repo step; PATH has the side's own bin first, as an installed toolkit would */
const run = (cmd: 'init' | 'bootstrap-repo', args: string[] | ((s: Side) => string[]), o: Partial<Step> = {}): Step => ({
  cmd,
  args,
  ...o,
  env: (s: Side) => ({
    PATH: `${s.pkg}/bin${D}${s.stub}${D}${cleanPath}`,
    ...(typeof o.env === 'function' ? o.env(s) : (o.env ?? {})),
  }),
});
const init = (args: string[] | ((s: Side) => string[]), o: Partial<Step> = {}): Step => run('init', args, o);
const boot = (args: string[] | ((s: Side) => string[]), o: Partial<Step> = {}): Step => run('bootstrap-repo', args, o);
const NL = ['--no-launch'];

/** every file of the repo (not .git): bytes + exec bit; plus what git and the clone's config hold */
function tree(s: Side): string {
  const parts: string[] = [];
  const walk = (rel: string): void => {
    for (const n of readdirSync(path.join(s.R, rel)).sort()) {
      if (n === '.git' && rel === '') continue;
      const r = rel ? `${rel}/${n}` : n;
      const p = path.join(s.R, r);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(r);
      else parts.push(`── ${r} [${st.mode & 0o111 ? 'x' : '-'}]\n${readFileSync(p, 'latin1')}`);
    }
  };
  walk('');
  const hook = path.join(s.R, '.git/hooks/post-merge');
  const hs = statSync(hook, { throwIfNoEntry: false });
  parts.push(`── post-merge hook [${hs ? (hs.mode & 0o111 ? 'x' : '-') : 'none'}]\n${hs ? readFileSync(hook, 'latin1') : ''}`);
  const g = (a: string[]): string => {
    const r = spawnSync('git', a, { cwd: s.R, encoding: 'utf8' });
    return (r.stdout ?? '') + (r.stderr ?? '');
  };
  parts.push(`── git log\n${g(['log', '--format=%s%n%an', '--stat', '--all'])}`);
  parts.push(`── git ls-files\n${g(['ls-files'])}`);
  parts.push(`── git config\n${g(['config', '--local', '--list'])}`.replace(/^(core\.|remote\.|branch\.).*\n/gm, ''));
  return parts.join('\n');
}
const sc = (project: Project | ((k: 'old' | 'new') => Project), prep: ((s: Side) => void) | null, steps: Step[]): void => scenario(project, prep, steps, tree);

const commit = (s: Side, msg = 'x'): void => {
  sh(s.R, 'git', ['add', '-A']);
  sh(s.R, 'git', ['commit', '-qm', msg, '--allow-empty']);
};
const outside = (): string => mkdtempSync(path.join(tmpdir(), 'gsd-p8-'));

// ── help, usage, refusals ───────────────────────────────────────────────────

t('--help is the same text', () => {
  sc(FRESH, null, [
    init(['--help'], { rc: 0, out: /^gsdt-init — set up GSD in a repo that doesn't have it yet\n/ }),
    init(['-h'], { rc: 0 }),
    init(['--bogus', '--help'], { fail: true }),
    init(['--help', '--bogus'], { rc: 0 }),
    boot(['--help'], { rc: 0, out: /^gsdt-bootstrap-repo — install GSD worktree integration/ }),
    boot(['-h'], { rc: 0 }),
    boot(['--bogus', '--help'], { fail: true }),
    init(['--help'], { rc: 0, cwd: () => outside() }),
    boot(['--help'], { rc: 0, cwd: () => outside() }),
  ]);
});

t('init usage errors', () => {
  const bad = (args: string[], err?: RegExp): Step => init(args, { fail: true, ...(err ? { err } : {}) });
  sc(FRESH, null, [
    bad(['--bogus'], /✖ unknown arg: --bogus \(see gsdt-init --help\)\n/),
    bad(['stray']),
    bad(['--src'], /--src needs a value/),
    bad(['--base'], /--base needs a value/),
    bad(['--tracker'], /--tracker needs none, clickup or custom/),
    bad(['--tracker-command'], /--tracker-command needs the script's path/),
    bad(['--tracker-command', ''], /--tracker-command needs the script's path/),
    bad(['--providers'], /--providers needs a comma-separated list/),
    bad(['--provider'], /--provider needs claude, codex, or custom/),
    bad(['--model'], /--model needs a model ID or default/),
    bad(['--model', ''], /--model needs a model ID or default/),
    bad(['--provider-command'], /--provider-command needs provider=executable/),
    bad(['--agent-command'], /--agent-command needs one executable path\/name/),
    bad(['--agent'], /--agent needs a provider or executable/),
    bad(['--provider', 'foo', ...NL], /unknown provider 'foo'/),
    bad(['--provider', 'gemini', ...NL], /Gemini is no longer supported/),
    bad(['--agent', 'gemini', ...NL], /Gemini is no longer supported/),
    bad(['--providers', 'claude,,codex', ...NL], /malformed providers list/),
    bad(['--providers', ',claude', ...NL]),
    bad(['--providers', 'claude,claude', ...NL], /duplicate provider/),
    bad(['--providers', 'claude,gemini', ...NL], /Gemini is no longer supported/),
    bad(['--providers', 'claude,foo', ...NL], /unknown provider 'foo'/),
    bad(['--providers', 'claude', '--provider', 'codex', ...NL], /launch provider 'codex' is not listed in --providers claude/),
    bad(['--provider-command', 'nope', ...NL], /--provider-command needs provider=executable/),
    bad(['--provider-command', '=x', ...NL], /malformed --provider-command: =x/),
    bad(['--provider-command', 'claude=', ...NL], /malformed --provider-command: claude=/),
    bad(['--provider-command', 'foo=x', ...NL], /unknown provider 'foo'/),
    bad(['--provider-command', 'claude=a b', ...NL], /one executable path\/name/),
    bad(['--provider-command', 'custom=', ...NL]),
    bad(['--providers', 'claude', '--provider-command', 'codex=/x', ...NL], /provider command 'codex' is not listed in --providers claude/),
    bad(['--agent-command', 'a b', ...NL], /one executable path\/name/),
    bad(['--provider', 'custom', ...NL], /requires an explicit agent command/),
    bad(['--model', 'a b', ...NL], /model must be one model ID/),
    bad(['--model', '-x', ...NL], /model must be one model ID/),
    bad(['--provider', 'custom', '--agent-command', '/bin/true', '--model', 'x', ...NL], /custom provider has no model-flag adapter/),
    bad(['--tracker', 'bogus', ...NL], /unknown tracker 'bogus' \(expected none, clickup or custom\)/),
    bad(['--tracker', 'custom', ...NL], /--tracker custom needs --tracker-command/),
    init(['--tracker-command', 'x.sh', ...NL], { rc: 0 }), // (init passes it on only with --tracker)
    bad(['--tracker', 'custom', '--tracker-command', 'a b', ...NL], /--tracker-command must be one path/),
    bad(['--base', 'nope', ...NL], /branch 'nope' does not exist/),
    init(['--base', 'main', '--tracker', 'none', ...NL], { rc: 0 }),
  ]);
  sc(FRESH, null, [init(NL, { fail: true, cwd: outside, err: /✖ run this from inside the target git repo\n/ })]);
  sc(FRESH, null, [boot([], { fail: true, cwd: outside, err: /✖ run this from inside the target git repo\n/ })]);
});

t('bootstrap usage errors', () => {
  const bad = (args: string[], err?: RegExp): Step => boot(args, { fail: true, ...(err ? { err } : {}) });
  sc(FRESH, null, [
    bad(['--bogus'], /✖ unknown arg: --bogus \(see gsdt-bootstrap-repo --help\)\n/),
    bad(['--base'], /--base needs a value/),
    bad(['--agent'], /--agent needs a provider/),
    bad(['--agents'], /--agents needs a comma-separated list/),
    bad(['--agents', ',a'], /malformed --agents list: ,a/),
    bad(['--agents', 'a,'], /malformed --agents list/),
    bad(['--agents', 'a,,b'], /malformed --agents list/),
    bad(['--agent', 'gemini'], /Gemini is no longer supported \(gsd-core, the new GSD, dropped it\); use claude, codex, or custom/),
    bad(['--agent', 'foo'], /unknown provider 'foo' \(expected claude, codex, or custom\)/),
    bad(['--agents', 'claude,foo'], /unknown provider 'foo'/),
    bad(['--agent-command'], /--agent-command needs one executable path\/name/),
    bad(['--agent-command', 'a b']),
    bad(['--agent-command', 'a b', '--agent', 'claude'], /provider command must be one executable path\/name/),
    bad(['--provider-command'], /needs provider=executable/),
    bad(['--provider-command', 'x'], /needs provider=executable/),
    bad(['--provider-command', 'claude=a b'], /one executable path\/name/),
    bad(['--provider-command', 'gemini=x'], /unknown provider 'gemini'/),
    bad(['--provider-command', 'codex=/x', '--agent', 'claude'], /command override for 'codex' is outside providers 'claude'/),
    bad(['--tracker'], /--tracker needs none, clickup or custom/),
    bad(['--tracker-command'], /--tracker-command needs the script's path/),
    bad(['--src'], /--src needs a value/),
    bad(['--tracker', 'x']),
    bad(['--tracker-command', 'a.sh']),
    bad(['--tracker', 'custom']),
    bad(['--tracker', 'custom', '--tracker-command', 'a b']),
    bad(['--base', 'nope'], /branch 'nope' does not exist/),
    bad(['--agent', 'custom'], /requires an explicit agent command/),
    bad(['--agent', 'codex', '--agent-command', '/x y']),
    boot(['--src', 'whatever', '--agent', 'codex'], { rc: 0, out: /• --src is deprecated and ignored\n/ }),
  ]);
});

// ── a fresh repo, then again ────────────────────────────────────────────────

t('fresh repo: default, rerun, committed', () => {
  sc(FRESH, null, [init(NL, { rc: 0, out: /✅ provider-neutral GSD workflow installed \(default: claude\)/ }), init(NL, { rc: 0 }), init(NL, { rc: 0 })]);
  sc(FRESH, null, [init([...NL, '--no-commit'], { rc: 0 }), init(NL, { rc: 0 })]);
  sc(FRESH, null, [init([...NL, '--no-ui'], { rc: 0 }), init(NL, { rc: 0 }), init([...NL, '--no-ui'], { rc: 0 })]);
  sc(FRESH, null, [boot([], { rc: 0 }), boot([], { rc: 0 }), boot(['--commit'], { rc: 0 })]);
});

t('providers and the commands they bring', () => {
  const only1 = (args: string[]): Step[] => [init([...args, ...NL], { rc: 0 }), init(NL, { rc: 0 })];
  sc(FRESH, null, only1(['--provider', 'codex']));
  sc(FRESH, null, only1(['--provider', 'claude']));
  sc(FRESH, null, only1(['--providers', 'claude,codex']));
  sc(FRESH, null, only1(['--providers', 'codex,claude', '--provider', 'claude']));
  sc(FRESH, null, only1(['--providers', 'claude,codex', '--provider', 'codex', '--model', 'gpt-5']));
  sc(FRESH, null, only1(['--providers', 'claude,codex,custom', '--provider-command', 'custom=/opt/x/run', '--provider', 'custom']));
  sc(FRESH, null, only1(['--providers', 'claude,codex', '--provider-command', 'codex=/opt/bin/codex']));
  sc(FRESH, null, only1(['--provider', 'custom', '--agent-command', '/opt/x/run']));
  sc(FRESH, null, only1(['--agent', '/opt/x/mycli']));
  sc(FRESH, null, only1(['--agent', 'codex']));
  sc(FRESH, null, only1(['--agent-command', '/opt/x/claude']));
  sc(FRESH, null, only1(['--provider', 'codex', '--agent-command', '/opt/x/codex']));
  sc(FRESH, null, only1(['--providers', 'claude,codex', '--agent-command', '/opt/x/claude2']));
  sc(FRESH, null, only1(['--model', 'opus']));
  sc(FRESH, null, only1(['--model', 'default']));
  sc(FRESH, null, only1(['--ingest']));
  sc(FRESH, null, only1(['--new', '--base', 'main']));
  // the selection sticks, and a later run can change it
  sc(FRESH, null, [init(['--providers', 'claude,codex', ...NL], { rc: 0 }), init(NL, { rc: 0 }), init(['--providers', 'codex', ...NL], { rc: 0 }), boot(['--agents', 'claude'], { rc: 0 })]);
  sc(FRESH, null, [boot(['--agent', 'codex', '--agent', 'claude', '--agent', 'codex'], { rc: 0 }), boot(['--agents', 'codex,claude,custom', '--provider-command', 'custom=/x'], { rc: 0 })]);
  sc(FRESH, null, [boot(['--provider-command', 'claude=/a/claude', '--provider-command', 'codex=/a/codex', '--agents', 'claude,codex'], { rc: 0 }), boot(['--agent-command', '/z/codex', '--agents', 'codex,claude'], { rc: 0 })]);
  // the environment picks the provider when nothing else does
  sc(FRESH, null, [boot([], { rc: 0, env: { GSD_PROVIDER: 'codex' } })]);
  sc(FRESH, null, [boot([], { rc: 0, env: { GSD_AGENT: 'codex' } })]);
  sc(FRESH, null, [boot([], { fail: true, env: { GSD_AGENT: 'weird' } })]);
  sc(FRESH, null, [boot([], { fail: true, env: { GSD_PROVIDER: 'nope' } })]);
  sc(FRESH, null, [init(NL, { rc: 0, env: { GSD_PROVIDER: 'codex' } })]);
  sc(FRESH, null, [init(NL, { fail: true, env: { GSD_PROVIDER: 'nope' } })]);
  sc(FRESH, null, [init(NL, { fail: true, env: { GSD_MODEL: 'a b' } })]);
  sc(FRESH, null, [init(NL, { rc: 0, env: { GSD_CLAUDE_COMMAND: '/opt/x/claude' } })]);
});

t('what init prints: planning docs, trackers, existing roadmap, notices', () => {
  sc(withFiles({ 'docs/adr-1.md': '# adr\n' }), null, [init(NL, { rc: 0, out: /found existing planning docs/ })]);
  sc(withFiles({ 'docs/adr-1.md': '# adr\n' }), null, [init(['--new', ...NL], { rc: 0 }), init(['--new', ...NL], { rc: 0 })]);
  sc(withFiles({ 'PRD.MD': 'x', 'a/b/c/spec-deep.md': 'x' }), null, [init(NL, { rc: 0, out: /ingest/ })]);
  sc(withFiles({ 'a/b/c/d/spec-too-deep.md': 'x', 'node_modules/x/adr.md': 'x', 'notes.md': 'x' }), null, [init(NL, { rc: 0, out: /interview/ })]);
  sc(withFiles({ 'docs/Requirements-v2.md': 'x' }), null, [init(['--ingest', ...NL], { rc: 0 })]);
  for (const [tr, extra] of [['none', []], ['clickup', []], ['custom', ['--tracker-command', 'scripts/tracker.sh']]] as const) {
    sc(FRESH, null, [init(['--tracker', tr, ...extra, ...NL], { rc: 0 }), init(NL, { rc: 0 })]);
  }
  sc(
    FRESH,
    (s) => {
      mkdirSync(path.join(s.R, 'scripts'), { recursive: true });
      write(path.join(s.R, 'scripts/tracker.sh'), '#!/bin/sh\n', 0o755);
      commit(s);
    },
    [init(['--tracker', 'custom', '--tracker-command', 'scripts/tracker.sh', ...NL], { rc: 0 })],
  );
  // the tracker question (stdin is read when a terminal is there, or GSD_TRACKER_ASK=always)
  const ask = (input: string): Step => init(['--provider', 'claude', ...NL], { rc: 0, env: { GSD_TRACKER_ASK: 'always' }, input });
  for (const input of ['3\nscripts/t.sh\n', '3\n\n', '2\n', '1\n', 'none\n', 'clickup\n', 'custom\nx.sh\n', '\n', 'x\n9\n2\n', '', '3', '2', '3\n']) sc(FRESH, null, [ask(input)]);
  sc(FRESH, null, [init(['--tracker', 'none', ...NL], { rc: 0, env: { GSD_TRACKER_ASK: 'always' }, input: '3\n' })]);
  sc({ ...FRESH, conf: 'tracker = clickup\n' }, null, [init(NL, { rc: 0, env: { GSD_TRACKER_ASK: 'always' }, input: '3\n' })]);
  // an already initialized repo
  sc({ conf: null }, null, [init(NL, { rc: 0, out: /already has GSD planning state/ }), init(NL, { rc: 0 })]);
  sc({ conf: null }, null, [init(['--providers', 'claude,codex', '--tracker', 'clickup', ...NL], { rc: 0 })]);
  sc({ conf: null }, null, [init(['--no-ui', ...NL], { rc: 0 })]);
  sc({ conf: 'ui_gates = off\nproviders = claude,codex\n' }, null, [init(NL, { rc: 0 })]);
  // husky owns post-merge: a versioned hook
  sc(withFiles({ '.husky/pre-commit': '#!/bin/sh\n' }), null, [init(NL, { rc: 0 }), init(NL, { rc: 0 })]);
  sc({ ...withFiles({ '.husky/pre-commit': '#!/bin/sh\n' }), noPlanning: false }, null, [init(NL, { rc: 0, out: /\.husky\/post-merge   \(versioned — this one IS in the diff\)/ })]);
  sc(FRESH, (s) => void sh(s.R, 'git', ['config', 'core.hooksPath', 'tracked-hooks']), [init(NL, { rc: 0 }), init(NL, { rc: 0 })]);
});

t('launching: missing executable, explicit launch, update notice', () => {
  sc(FRESH, null, [init(['--launch', '--tracker', 'none'], { rc: 127, err: /provider executable 'claude' not found — launch cancelled/ })]);
  sc(FRESH, null, [init(['--agent', 'codex', '--tracker', 'none'], { rc: 127 })]);
  sc(FRESH, null, [init(['--agent-command', '/nonexistent/claude', '--tracker', 'none'], { rc: 127 })]);
  sc(FRESH, null, [init(['--tracker', 'none'], { rc: 0 })]); // no terminal: the command is printed
  sc(FRESH, null, [init(['--launch', '--no-launch', '--tracker', 'none'], { rc: 0 })]);
  sc(FRESH, null, [init(['--no-launch', '--launch', '--tracker', 'none'], { rc: 0 })]);
  sc(FRESH, null, [init(['--no-launch', '--agent', 'codex', '--tracker', 'none'], { rc: 0 })]);
  sc(FRESH, null, [init(NL, { rc: 0, env: { GSD_UPDATE_NOTICE: 'always', GSD_NO_UPDATE_CHECK: undefined, GSD_UPDATE_REPO: 'nobody/none' } })]);
  sc(FRESH, null, [init(NL, { rc: 0, env: { GSD_COMPACT_AT: '200000' } })]);
  sc(FRESH, null, [init(NL, { fail: true, env: { GSD_COMPACT_AT: '5' } })]);
  sc(FRESH, null, [init(NL, { rc: 0, env: { GSD_COMPACT_AT: 'default' } })]);
});

// a terminal: the session runs as a child; its exit code, then the roadmap check
const AGENT_PLAN = `#!/bin/sh
{ printf 'argv:'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\ncwd: %s\\n' "$(pwd -P)"; } > "$GSD_TEST_AGENT_LOG"
mkdir -p .planning
printf '# Roadmap\\n\\n## Phase 3: first\\n\\n### Phase 4: second\\n\\n#### Phase 5.1: third\\n' > .planning/ROADMAP.md
exit "\${AGENT_RC:-0}"
`;
t('launching in a terminal: plan ready / not written / the agent fails', () => {
  const withAgent = (s: Side): void => write(path.join(s.stub, 'agentplan'), AGENT_PLAN, 0o755);
  const mk = (rc: string, extra: string[] = []): Step =>
    init((s) => ['--tracker', 'none', '--agent', path.join(s.stub, 'agentplan'), ...extra], { tty: true, env: { AGENT_RC: rc } });
  sc(FRESH, withAgent, [mk('0')]);
  sc(FRESH, withAgent, [mk('0', ['--ingest'])]);
  sc(FRESH, withAgent, [mk('3'), mk('0')]);
  sc(FRESH, (s) => write(path.join(s.stub, 'agentplan'), '#!/bin/sh\nexit "${AGENT_RC:-0}"\n', 0o755), [mk('0'), mk('7')]);
  sc(FRESH, (s) => write(path.join(s.stub, 'agentplan'), '#!/bin/sh\nmkdir -p .planning; printf "# Roadmap\\n" > .planning/ROADMAP.md\\n', 0o755), [mk('0')]);
  sc(withFiles({ 'adr-0.md': 'x' }), withAgent, [mk('0')]);
  sc(FRESH, withAgent, [init(['--tracker', 'none', '--no-launch', '--agent', '/bin/true'], { tty: true })]);
  sc({ conf: null }, withAgent, [mk('0')]); // already initialized: no session
});

// ── existing text in the repo ───────────────────────────────────────────────

const MARK = (kind: string, body = 'old text\n', pre = 'gsd-toolkit'): string => `<!-- ${pre}:${kind}:start -->\n${body}<!-- ${pre}:${kind}:end -->\n`;

t('instruction files: text outside the markers stays, bad markers are refused', () => {
  const both = (extra: Record<string, string>): Project => withFiles(extra);
  sc(both({ 'CLAUDE.md': '# Mine\n\nkeep this\n', 'AGENTS.md': 'agents text no newline' }), null, [init(['--providers', 'claude,codex', ...NL], { rc: 0 }), init(NL, { rc: 0 })]);
  sc(both({ 'CLAUDE.md': `intro\n${MARK('provider')}outro\n` }), null, [init(NL, { rc: 0 })]);
  sc(both({ 'CLAUDE.md': `intro\n${MARK('provider', 'old\n', 'gsd-worktrees')}outro\n`, '.gsd/INSTRUCTIONS.md': MARK('canonical', 'old\n', 'gsd-worktrees') }), null, [init(NL, { rc: 0 }), init(NL, { rc: 0 })]);
  sc(both({ 'CLAUDE.md': '<!-- gsd-toolkit:provider:start -->\nno end\n' }), null, [init(NL, { fail: true, err: /ambiguous GSD markers in .*CLAUDE\.md; repair the start\/end pair manually \(all files preserved\)/ })]);
  sc(both({ 'CLAUDE.md': `${MARK('provider')}${MARK('provider')}` }), null, [init(NL, { fail: true, err: /ambiguous GSD markers/ })]);
  sc(both({ 'CLAUDE.md': '<!-- gsd-toolkit:provider:end -->\n<!-- gsd-toolkit:provider:start -->\n' }), null, [init(NL, { fail: true })]);
  sc(both({ 'CLAUDE.md': 'x <!-- gsd-toolkit:provider:start --> inline\n<!-- gsd-toolkit:provider:end -->\n' }), null, [init(NL, { fail: true })]);
  sc(both({ 'AGENTS.md': '<!-- gsd-toolkit:provider:start -->\n' }), null, [init(['--providers', 'claude,codex', ...NL], { fail: true, err: /AGENTS\.md/ }), init(['--provider', 'claude', ...NL], { rc: 0 })]);
  sc(both({ '.gsd/INSTRUCTIONS.md': '<!-- gsd-toolkit:canonical:start -->\n' }), null, [init(NL, { fail: true, err: /ambiguous canonical GSD markers; repair the start\/end pair \(all files preserved\)/ })]);
  sc(both({ '.gsd/INSTRUCTIONS.md': 'my notes\n' }), null, [init(NL, { rc: 0 }), init(NL, { rc: 0 })]);
  // the legacy canonical file is backed up (twice: the first backup name is taken)
  const legacy = '<!-- gsd-worktrees:canonical -->\nlegacy line\nworktrees `../x-worktrees/`.\nmy addition\n';
  sc(both({ '.gsd/INSTRUCTIONS.md': legacy }), null, [init(NL, { rc: 0, out: /legacy canonical content backed up to .*INSTRUCTIONS\.md\.bak\n/ })]);
  sc(both({ '.gsd/INSTRUCTIONS.md': legacy, '.gsd/INSTRUCTIONS.md.bak': 'taken' }), null, [init(NL, { rc: 0, out: /\.bak\.1/ })]);
  // unmarked legacy GSD text in CLAUDE.md is kept, with a note
  sc(both({ 'CLAUDE.md': '## GSD planning system\n\nuse scripts/hooks/gsd-worktree-guard.sh\n' }), null, [init(NL, { rc: 0, out: /preserved unmarked legacy GSD instructions in CLAUDE\.md/ }), init(NL, { rc: 0, not: /preserved unmarked/ })]);
  sc(both({ 'CLAUDE.md': '## GSD planning system\nno hook name here\n' }), null, [init(NL, { rc: 0, not: /preserved unmarked/ })]);
  // CRLF text, a file that is a link
  sc(both({ 'CLAUDE.md': 'a\r\nb\r\n' }), null, [init(NL, { rc: 0 })]);
  sc(both({ 'CLAUDE.md': 'é ünï\n' }), null, [init(NL, { rc: 0 })]);
  sc(both({ 'REAL.md': 'real\n' }), (s) => symlinkSync('REAL.md', path.join(s.R, 'AGENTS.md')), [init(['--provider', 'codex', ...NL], { rc: 0 })]);
});

t('.gitignore', () => {
  sc(withFiles({ '.gitignore': 'node_modules\n' }), null, [init(NL, { rc: 0 }), init(NL, { rc: 0 })]);
  sc(withFiles({ '.gitignore': 'node_modules' }), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ '.gitignore': '.gsd-install.log\n.claude/settings.local.json\n' }), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ '.gitignore': '' }), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ '.gitignore': '.gsd-install.status\r\n' }), null, [init(NL, { rc: 0 })]);
});

// ── .gsd.conf ───────────────────────────────────────────────────────────────

t('.gsd.conf: created, or updated with the other keys kept', () => {
  const conf = (c: string, extra: Record<string, string> = {}): Project => withFiles({ '.gsd.conf': c, ...extra });
  sc(conf('install = pnpm i\ntest = none\nbase = main\n'), null, [init(NL, { rc: 0 }), init(NL, { rc: 0 })]);
  sc(conf('# comment\nprovider = claude\nagent_command = /opt/x/claude\nwtdir = wts\n'), null, [init(NL, { rc: 0 })]);
  sc(conf('provider = codex\nagent_command = /opt/x/codex\n'), null, [init(NL, { rc: 0 }), init(NL, { rc: 0 })]);
  sc(conf('providers = claude,codex\nclaude_command = /a\n  codex_command   =   /b  # c\n'), null, [init(['--provider-command', 'claude=/new/claude', ...NL], { rc: 0 })]);
  sc(conf('providers = claude\nui_gates = strict\n'), null, [init(['--no-ui', ...NL], { rc: 0 })]);
  sc(conf('  providers   =   claude,codex  \r\ntracker = none\r\n'), null, [init(['--providers', 'claude', ...NL], { rc: 0 })]);
  sc(conf('providers = claude\n'), null, [init(['--tracker', 'custom', '--tracker-command', 'scripts/t.sh', ...NL], { rc: 0 }), init(['--tracker', 'none', ...NL], { rc: 0 })]);
  sc(conf('providers = claude\ntracker = custom\ntracker_command = scripts/mine.sh\n'), null, [init(['--tracker', 'custom', ...NL], { rc: 0 })]);
  sc(conf('base = develop\nproviders = claude\n'), (s) => void sh(s.R, 'git', ['branch', 'develop']), [init(['--base', 'develop', ...NL], { rc: 0 }), init(['--base', 'main', ...NL], { rc: 0 })]);
  sc(conf('wtdir = my-trees\ngemini_command = /x\ngemini_model = y\nproviders = claude\n'), null, [init(NL, { rc: 0 })]);
  sc(conf('providers = \n'), null, [init(NL, { fail: true })]);
  sc(conf('providers = claude,\n'), null, [init(NL, { fail: true, err: /malformed providers list/ })]);
  sc(conf('providers = claude,claude\n'), null, [init(NL, { fail: true, err: /duplicate provider/ })]);
  sc(conf('providers = nope\n'), null, [init(NL, { fail: true }), init(['--provider', 'codex', ...NL], { rc: 0 })]);
  sc(conf('providers = claude\ncodex_command = a b\n'), null, [init(['--providers', 'claude,codex', ...NL], { fail: true })]);
  sc(conf('providers = custom\n'), null, [init(NL, { fail: true, err: /requires an explicit agent command/ }), init(['--agent-command', '/x/y', ...NL], { rc: 0 })]);
  sc(conf('providers = custom\ncustom_command = /x/y\n'), null, [init(NL, { rc: 0 })]);
  // a legacy singular key and agent_command stay bound to the provider that ran them
  sc(conf('provider = codex\nagent_command = /opt/codex\n'), null, [init(['--providers', 'claude,codex', ...NL], { rc: 0 })]);
  sc(conf('provider = codex\nagent_command = a b\n'), null, [init(NL, { fail: true })]);
  sc(conf('providers = claude\nagent_command = /legacy/claude\n'), null, [init(NL, { rc: 0 })]);
  sc(conf('providers = claude\nagent_command = /legacy/claude\nclaude_command = /mine\n'), null, [init(NL, { rc: 0 })]);
  sc(withFiles({}, { conf: 'providers = claude\n' }), null, [init(['--agent-command', '/x/claude', ...NL], { rc: 0 }), init(NL, { rc: 0 })]);
  // package manager guess, wtdir
  sc(withFiles({ 'pnpm-lock.yaml': '' }), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ 'yarn.lock': '' }), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ 'package-lock.json': '{}' }), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ 'package.json': '{}' }), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ 'package.json': '{}', 'yarn.lock': '' }), null, [init(NL, { rc: 0 })]);
});

// ── Gemini of an older release ──────────────────────────────────────────────

t('an older release\'s Gemini setup is removed', () => {
  const GH = (cmd = 'x/scripts/hooks/gsdt-worktree-guard.sh'): string => JSON.stringify({ hooks: { BeforeTool: [{ matcher: 'x', hooks: [{ type: 'command', command: cmd }] }] } }, null, 2);
  sc(withFiles({ '.gsd.conf': 'providers = claude,gemini\n' }), null, [init(NL, { rc: 0, out: /gemini removed from providers/ }), init(NL, { rc: 0, not: /gemini removed/ })]);
  sc(withFiles({ '.gsd.conf': 'provider = gemini\nagent_command = /opt/gemini\n' }), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ '.gsd.conf': 'providers = gemini\n' }), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ '.gsd.conf': 'providers = gemini,codex\ngemini_command = /x\n' }), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ '.gsd.conf': 'providers = codex,gemini,claude\n' }), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ '.gsd.conf': 'providers = claude,gemini\n', 'GEMINI.md': MARK('provider') }), null, [init(NL, { rc: 0, out: /GEMINI\.md removed/ })]);
  sc(withFiles({ '.gsd.conf': 'providers = claude\n', 'GEMINI.md': `# my gemini\n\n${MARK('provider')}\ntail\n` }), null, [init(NL, { rc: 0, out: /GEMINI\.md: the gsd-toolkit block removed/ })]);
  sc(withFiles({ '.gsd.conf': 'providers = claude\n', 'GEMINI.md': `${MARK('provider', 'x\n', 'gsd-worktrees')}\n\n\n` }), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ 'GEMINI.md': '<!-- gsd-toolkit:provider:start -->\nunclosed\n' }), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ 'GEMINI.md': 'only mine\n' }), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ 'AGENTS.md': MARK('provider') }), (s) => symlinkSync('AGENTS.md', path.join(s.R, 'GEMINI.md')), [init(['--provider', 'codex', ...NL], { rc: 0 })]);
  sc(withFiles({ '.gemini/settings.json': GH() }), null, [init(NL, { rc: 0, out: /\.gemini\/settings\.json: the gsd-toolkit hook removed/ })]);
  sc(withFiles({ '.gemini/settings.json': GH('x/gsd-worktree-guard.sh') }), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ '.gemini/settings.json': JSON.stringify({ theme: 'dark', hooks: { BeforeTool: [{ hooks: [{ command: 'mine' }, { command: 'a/gsdt-worktree-guard' }] }] } }, null, 2) }), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ '.gemini/settings.json': '{"hooks": [] , "x": "gsdt-worktree-guard"}' }), null, [init(NL, { rc: 0, out: /still names the worktree guard — remove that hook by hand/ })]);
  sc(withFiles({ '.gemini/settings.json': 'not json gsdt-worktree-guard' }), null, [init(NL, { rc: 0, out: /remove that hook by hand/ })]);
  sc(withFiles({ '.gemini/settings.json': '{"theme": "dark"}' }), null, [init(NL, { rc: 0 })]);
  sc(
    withFiles({ '.gsd.conf': 'providers = claude,gemini\n', 'GEMINI.md': MARK('provider'), '.gemini/settings.json': GH() }),
    null,
    [init(NL, { rc: 0 }), init(NL, { rc: 0 })],
  );
  // tracked Gemini files are staged when removed
  sc(withFiles({ '.gsd.conf': 'providers = claude,gemini\n', 'GEMINI.md': MARK('provider'), '.gemini/settings.json': GH() }), (s) => commit(s, 'gemini'), [init(NL, { rc: 0 })]);
  // gemini is refused where it is chosen
  sc(withFiles({ '.gsd.conf': 'providers = claude,gemini\n' }), null, [boot(['--providers', 'claude,gemini'], { fail: true }), boot(['--agents', 'gemini'], { fail: true }), boot([], { rc: 0 })]);
});

// ── Claude's settings: the guard hook and worktree.baseRef ──────────────────

t('.claude/settings.json: the native guard hook', () => {
  const HOOK = { matcher: 'Skill', hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/scripts/hooks/gsdt-worktree-guard.sh' }] };
  const S = (o: unknown): Project => withFiles({ '.claude/settings.json': typeof o === 'string' ? o : JSON.stringify(o, null, 2) });
  sc(FRESH, null, [init(NL, { rc: 0, out: /\.claude\/settings\.json \(claude native guard hook\)/ }), init(NL, { rc: 0, out: /already registers the guard/ })]);
  sc(S({ model: 'x', hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo' }] }] } }), null, [init(NL, { rc: 0 })]);
  sc(S({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] }] } }), null, [init(NL, { rc: 0 })]);
  sc(S({ hooks: { PreToolUse: [HOOK] } }), null, [init(NL, { rc: 0, out: /already registers the guard/ })]);
  sc(S({ disableAllHooks: true }), null, [init(NL, { rc: 0, out: /native hooks disabled in .*settings\.json; preserved unchanged/ })]);
  sc(S({ hooksConfig: { enabled: false } }), null, [init(NL, { rc: 0, out: /native hooks disabled/ })]);
  sc(S({ hooks: [] }), null, [init(NL, { rc: 0, out: /incompatible hook structure/ })]);
  sc(S({ hooks: { PreToolUse: 'x' } }), null, [init(NL, { rc: 0, out: /incompatible hook structure/ })]);
  sc(S('{ not json'), null, [init(NL, { rc: 0, out: /is not mergeable JSON; preserved unchanged \(native hook absent\)/ })]);
  sc(S('[]'), null, [init(NL, { rc: 0 })]);
  sc(S(''), null, [init(NL, { rc: 0 })]);
  sc(S({ hooks: { PreToolUse: [{ ...HOOK, disabled: true }] } }), null, [init(NL, { rc: 0 })]);
  sc(S({ n: 1.0, big: 123456789012345678901234567890, s: 'é' }), null, [init(NL, { rc: 0 })]);
  sc(FRESH, null, [init(['--provider', 'codex', ...NL], { rc: 0, out: /codex native guard hook: unsupported/ })]);
  sc(FRESH, null, [init(['--providers', 'codex,claude', ...NL], { rc: 0 })]);
  // no jq: the hook is left absent, the same words
  sc(S({ model: 'x' }), null, [init(NL, { rc: 0, env: (s: Side) => ({ PATH: `${s.pkg}/bin${D}${nojqPath()}` }) })]);
});

let noJq: string | null = null;
function nojqPath(): string {
  if (noJq) return noJq;
  const d = mkdtempSync(path.join(tmpdir(), 'gsd-p8-nojq-'));
  for (const bin of ['bash', 'git', 'node', 'sh', 'sed', 'grep', 'tr', 'cat', 'mktemp', 'dirname', 'readlink', 'perl', 'env', 'head', 'cp', 'chmod', 'mkdir', 'rm', 'tail', 'touch', 'mv', 'find', 'awk', 'sort', 'uname', 'ls', 'basename', 'date', 'python3']) {
    for (const dir of (process.env.PATH ?? '').split(D)) {
      const p = path.join(dir, bin);
      if (statSync(p, { throwIfNoEntry: false })?.isFile()) {
        symlinkSync(p, path.join(d, bin));
        break;
      }
    }
  }
  return (noJq = d);
}

t('worktree.baseRef in .claude/settings.local.json', () => {
  const L = (c: string): Project => withFiles({ '.claude/settings.local.json': c });
  const U = (home: string) => (s: Side): void => {
    write(path.join(s.home, '.claude', 'settings.json'), home);
  };
  sc(FRESH, null, [init(NL, { rc: 0, out: /worktree\.baseRef = "head" \(plans in a wave can run in parallel\)/ }), init(NL, { rc: 0, not: /baseRef/ })]);
  sc(L('{"worktree": {"baseRef": "head"}}'), null, [init(NL, { rc: 0, not: /baseRef/ })]);
  sc(L('{"worktree": {"baseRef": "origin/main"}}'), null, [init(NL, { rc: 0, out: /keeps worktree\.baseRef = "origin\/main" \(yours/ })]);
  sc(L('{"model": "x", "permissions": {"allow": ["a"]}}'), null, [init(NL, { rc: 0 })]);
  sc(L('{ broken'), null, [init(NL, { rc: 0, out: /is not plain JSON — not changed/ })]);
  sc(L('{"worktree": []}'), null, [init(NL, { rc: 0, out: /not plain JSON/ })]);
  sc(L('[]'), null, [init(NL, { rc: 0, out: /not plain JSON/ })]);
  sc(L(''), null, [init(NL, { rc: 0, out: /not plain JSON/ })]);
  sc(L('{"worktree": {"baseRef": 5}}'), null, [init(NL, { rc: 0 })]);
  sc(withFiles({ '.claude/settings.json': '{"worktree": {"baseRef": "head"}}' }), null, [init(NL, { rc: 0, not: /baseRef = "head" \(plans/ })]);
  sc(withFiles({ '.claude/settings.json': '{"worktree": {"baseRef": "x"}}' }), null, [init(NL, { rc: 0, out: /keeps worktree\.baseRef = "x"/ })]);
  sc(FRESH, U('{"worktree": {"baseRef": "head"}}'), [init(NL, { rc: 0, not: /baseRef/ })]);
  sc(FRESH, U('{"worktree": {"baseRef": "fork"}}'), [init(NL, { rc: 0, out: /keeps worktree\.baseRef = "fork"/ })]);
  sc(FRESH, U('{ nope'), [init(NL, { rc: 0 })]);
  // tracked: not touched, a warning
  sc(L('{"model": "x"}'), (s) => void s, [init(NL, { rc: 0 })]);
  // the file git tracks before init: the pattern in .gitignore does not un-track it
  sc(withFiles({ '.claude/settings.local.json': '{"model": "tracked"}' }), null, [init(['--no-commit', ...NL], { rc: 0, out: /is tracked by git — not changed/ })]);
  // gemini-only / codex-only repos still get the local file written (as the bash did)
  sc(FRESH, null, [init(['--provider', 'codex', ...NL], { rc: 0 })]);
  // CLAUDE_CONFIG_DIR
  sc(FRESH, null, [init(NL, { rc: 0, env: (s: Side) => ({ CLAUDE_CONFIG_DIR: path.join(s.root, 'cfg') }) })]);
});

t('--commit: clean tree commits, a dirty one does not', () => {
  sc(withFiles({}), (s) => write(path.join(s.R, 'dirty.txt'), 'x'), [init(NL, { rc: 0, out: /target repo had existing changes — skipped --commit/ }), init(NL, { rc: 0 })]);
  sc(withFiles({}), (s) => write(path.join(s.R, 'dirty.txt'), 'x'), [boot(['--commit'], { rc: 0, out: /skipped --commit/ })]);
  sc(FRESH, null, [boot(['--commit'], { rc: 0, out: /bootstrap changes committed/ }), boot(['--commit'], { rc: 0 })]);
  sc(withFiles({ '.husky/pre-commit': 'x' }), null, [boot(['--commit'], { rc: 0 })]);
  sc(FRESH, (s) => {
    sh(s.R, 'git', ['config', 'user.useConfigOnly', 'true']);
    sh(s.R, 'git', ['config', 'user.name', '']);
  }, [boot(['--commit'], {})]);
});

t('scripts: shims are copied and executable, a hand-edited shim is overwritten', () => {
  sc(withFiles({ 'scripts/gsdt-derive-port.sh': '#!/bin/sh\necho mine\n', 'scripts/gsdt-other.sh': '#!/bin/sh\nexit 0\n' }), (s) => chmodSync(path.join(s.R, 'scripts/gsdt-derive-port.sh'), 0o644), [init(NL, { rc: 0 })]);
  sc(withFiles({ 'scripts/gsdt-bad.sh': 'if then\n' }), null, [init(NL, { fail: true }), boot([], { fail: true })]);
  sc(withFiles({ 'scripts/gsd-old.sh': 'if then\n' }), null, [init(NL, { rc: 0 })]);
});

t('an old-name repo is refused by init (gsdt-migrate first)', () => {
  sc(withFiles({ 'scripts/gsd-new-worktree-feature.sh': '#!/bin/sh\n' }), null, [init(NL, { fail: true, err: /old gsd-\* names \(before 0\.10\.0\) — run: gsdt-migrate --apply/ }), boot([], { rc: 0 })]);
});

t('init inside a linked worktree and from a subfolder', () => {
  sc(withFiles({ 'sub/x.txt': 'x' }), null, [init(NL, { rc: 0, cwd: (s: Side) => path.join(s.R, 'sub') })]);
  sc(withFiles({}), (s) => void sh(s.R, 'git', ['worktree', 'add', '-q', path.join(s.root, 'wt'), '-b', 'feat']), [init(NL, { rc: 0, cwd: (s: Side) => path.join(s.root, 'wt') })]);
});

// ── new side only: old bugs not reproduced ────────────────────────────────

t('new only: a .gsd.conf with no final newline keeps its last line (bash glued the new key onto it)', () => {
  const n = makeSide('new', withFiles({ '.gsd.conf': 'providers = claude' }));
  const r = runStep(n, init(['--tracker', 'clickup', ...NL]));
  assert.equal(r.rc, 0, r.out + r.err);
  assert.equal(readFileSync(path.join(n.R, '.gsd.conf'), 'utf8'), 'providers = claude\ntracker = clickup\n');
  const o = makeSide('old', withFiles({ '.gsd.conf': 'providers = claude' }));
  const ro = runStep(o, init(['--tracker', 'clickup', ...NL]));
  assert.notEqual(ro.rc, 0); // the old one wrote `providers = claudetracker = clickup` and could not read it back
});

t('new only: the settings.json the hook is merged into keeps its mode (bash left a 0600 mktemp file)', () => {
  const n = makeSide('new', withFiles({ '.claude/settings.json': '{}\n' }));
  chmodSync(path.join(n.R, '.claude/settings.json'), 0o644);
  assert.equal(runStep(n, init(NL)).rc, 0);
  assert.equal(statSync(path.join(n.R, '.claude/settings.json')).mode & 0o777, 0o644);
});

t('new only: init does not need gsdt-bootstrap-repo on PATH (it runs it in-process)', () => {
  const n = makeSide('new', FRESH);
  const r = runStep(n, { cmd: 'init', args: NL, env: { PATH: `${path.dirname(process.execPath)}${D}/usr/bin${D}/bin${D}/opt/homebrew/bin` } });
  assert.equal(r.rc, 0, r.out + r.err);
});

t('new only: the toolkit repo itself is refused (old package has no .git folder to be one)', () => {
  const n = makeSide('new', FRESH);
  const r = runStep(n, boot([], { cwd: () => n.pkg }));
  assert.equal(r.rc, 1);
  assert.equal(r.err, "✖ you're inside the toolkit repo itself — cd into the target repo first\n");
  assert.equal(readdirSync(n.pkg).includes('.gsd.conf'), false);
});
