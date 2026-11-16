// tests/test-batch.sh → node:test. gsdt-batch-report: token counts per batch from Claude Code transcripts. Fixture
// transcripts are generated into a throwaway folder: a /gsd-quick-batch run with prompts typed mid-run, duplicate
// message ids, a helper with no meta file, a nested helper, an unrelated helper; a second batch in the same session;
// a /gsdt-batch run with its pause for the OK and its done line; a session with no batch. Then the gsdt-batch launcher
// (its batch-* worktree), the guard / gsdt-list / gsdt-doctor on it, the skill and the instructions.
// Run: node --test tests/node/batch.test.ts
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { projdir } from '../../src/batch-report.ts';
import { rulesText, shellQuote } from '../../src/provider.ts';
import {
  PKG, WIN, baseEnv, fileHas, fileHasnt, gitOk, gitOut, gsdt, has, hasnt, initRepo, is, lf, mkWork, ok, pathWith, real, run, w,
} from './g4-env.ts';
import type { Env } from './g4-env.ts';

const WORK = mkWork('g4batch-');
const ENV: Env = baseEnv(WORK, { TZ: 'UTC' });
ENV.PATH = pathWith(...(process.env.PATH ?? '').split(path.delimiter).filter((d) => d !== ''));
const P = path.join(WORK, 'proj');
mkdirSync(P, { recursive: true });
const BR = (args: string[], env: Env = {}, cwd?: string) => gsdt(ENV, 'gsdt-batch-report', args, { env, cwd: cwd ?? WORK });
const GB = (args: string[], o: { cwd?: string; env?: Env } = {}) => gsdt(ENV, 'gsdt-batch', args, { cwd: o.cwd ?? WORK, env: o.env });
const git = (cwd: string, ...args: string[]): void => { gitOk(ENV, cwd, args); };

// ---------------------------------------------------------------- fixtures (the generator of the bash suite, in node)
type J = Record<string, unknown>;
const NOW = Date.now() / 1000;
const SECRET = 'SECRET-TEXT-42';
const iso = (t: number): string => new Date(Math.floor(t) * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');
function u(fresh: number, cw: number, cr: number, out: number, cw1h = 0): J {
  const d: J = { input_tokens: fresh, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out };
  if (cw1h) d.cache_creation = { ephemeral_1h_input_tokens: cw1h, ephemeral_5m_input_tokens: cw - cw1h };
  return d;
}
type Tool = [string, string, J];
class F {
  lines: J[] = [];
  base: number;
  constructor(base: number) { this.base = base; }
  at(m: number): string { return iso(this.base + 60 * m); }
  asst(m: number, mid: string, usage: J, tools: Tool[] = [], text: string | null = null, model: string | null = 'claude-opus-5-5'): void {
    const c: J[] = [];
    if (text) c.push({ type: 'text', text });
    for (const [name, tid, inp] of tools) c.push({ type: 'tool_use', id: tid, name, input: inp });
    const msg: J = { id: mid, role: 'assistant', content: c, usage };
    if (model) msg.model = model;
    this.lines.push({ type: 'assistant', isSidechain: false, timestamp: this.at(m), message: msg });
  }
  human(m: number, text: string): void {
    this.lines.push({ type: 'user', isSidechain: false, timestamp: this.at(m), origin: { kind: 'human' }, message: { role: 'user', content: text } });
  }
  cmd(m: number, name: string, args = ''): void {
    this.lines.push({ type: 'user', isSidechain: false, timestamp: this.at(m), message: { role: 'user', content: `<command-name>/${name}</command-name>\n<command-args>${args}</command-args>` } });
  }
  result(m: number, tid: string, agent: string | null = null, status = 'async_launched'): void {
    const r: J = { status };
    if (agent) r.agentId = agent;
    this.lines.push({ type: 'user', isSidechain: false, timestamp: this.at(m), toolUseResult: r, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: 'x' }] } });
  }
  note(m: number, tid: string): void {
    this.lines.push({ type: 'user', isSidechain: false, timestamp: this.at(m), origin: { kind: 'task-notification' }, message: { role: 'user', content: `<task-notification><tool-use-id>${tid}</tool-use-id></task-notification>` } });
  }
  junk(): void { this.lines.push({ type: 'attachment' }); }
  write(file: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, this.lines.map((o) => `${JSON.stringify(o)}\n`).join('') + '{not json\n');
  }
}
function agent(session: string, aid: string, meta: J | null, f: F): void {
  const d = path.join(P, session, 'subagents');
  f.write(path.join(d, `agent-${aid}.jsonl`));
  if (meta !== null) writeFileSync(path.join(d, `agent-${aid}.meta.json`), JSON.stringify(meta));
}
const spawnT = (tid: string, atype: string, desc: string, model: string | null = null): Tool => {
  const inp: J = { subagent_type: atype, description: desc, prompt: SECRET };
  if (model) inp.model = model;
  return ['Agent', tid, inp];
};

// Session A — two /gsd-quick-batch runs, 2 days ago.
const A = 'aaaa1111-0000-4000-8000-000000000001';
{
  const a = new F(NOW - 2 * 86400);
  a.human(0, `earlier work ${SECRET}`);
  a.asst(1, 'm_pre', u(1, 1, 1, 1));
  a.asst(2, 'm_c1', u(10, 100, 1000, 5), [], 'thinking');               // line before the start …
  a.asst(2, 'm_c1', u(10, 100, 1000, 5), [['Skill', 'tsk1', { skill: 'gsd-core:gsd-quick-batch', args: SECRET }]]);
  a.result(2, 'tsk1', null, 'ok');
  a.asst(3, 'm_c2', u(2, 200, 2000, 10), [spawnT('toolu_p1', 'gsd-planner', 'Plan 261109-aa1: one'), spawnT('toolu_p2', 'gsd-planner', 'Plan 261109-aa2: two')]);
  a.result(3, 'toolu_p1', 'ap1'); a.result(3, 'toolu_p2', 'ap2');
  a.asst(10, 'm_c3', u(3, 300, 3000, 15), [spawnT('toolu_e1', 'gsd-executor', 'Execute 261109-aa1: one'), spawnT('toolu_e2', 'gsd-executor', 'Execute 261109-aa2: two')]);
  a.result(10, 'toolu_e1', 'ae1'); a.result(10, 'toolu_e2', 'ae2');
  a.junk();
  a.human(12, `how is it going? ${SECRET}`);                            // ae2 still working → not the end
  a.asst(13, 'm_c4', u(4, 400, 4000, 20), [['Bash', 'tb_c', { command: 'x' }]]);
  a.human(14, '/compact');
  a.cmd(14, 'compact');
  a.note(20, 'toolu_e2');
  a.asst(21, 'm_c5', u(5, 0, 500, 25));
  a.human(22, 'thanks');                                                // settled → the end
  a.asst(23, 'm_post', u(1000, 1000, 1000, 1000));
  a.cmd(30, 'gsd-quick-batch', SECRET);                                 // batch 2, typed
  a.asst(31, 'm_b2', u(7, 70, 700, 7), [spawnT('toolu_p3', 'gsd-planner', 'Plan 261109-bb1: three')]);
  a.result(40, 'toolu_p3', 'ap3', 'completed');
  a.asst(41, 'm_b2end', u(1, 10, 100, 1));
  a.write(path.join(P, `${A}.jsonl`));

  const p1 = new F(NOW - 2 * 86400);
  p1.asst(4, 'm_p1a', u(1, 10, 100, 1), [['Bash', 'tb1', { command: SECRET }]]);
  p1.asst(4, 'm_p1a', u(1, 10, 100, 1), [['Bash', 'tb2', { command: 'y' }]]);   // same id: usage once
  p1.asst(5, 'm_p1b', u(1, 10, 100, 1), [['Bash', 'tb2', { command: 'y' }],     // same tool id: once
    spawnT('toolu_n1', 'Explore', 'look')]);
  agent(A, 'ap1', { agentType: 'gsd-planner', model: 'opus', toolUseId: 'toolu_p1', description: 'Plan 261109-aa1: one' }, p1);
  const n1 = new F(NOW - 2 * 86400);
  n1.asst(5, 'm_n1', u(1, 1, 1, 1), [['Bash', 'tb3', {}]], null, 'claude-haiku-5-5');
  agent(A, 'an1', { agentType: 'Explore', model: 'haiku', toolUseId: 'toolu_n1' }, n1);
  const p2 = new F(NOW - 2 * 86400);
  p2.asst(6, 'm_p2', u(2, 20, 200, 2), [], null, null);                 // no model → the meta's
  agent(A, 'ap2', { agentType: 'gsd-planner', model: 'opus', toolUseId: 'toolu_p2' }, p2);
  const e1 = new F(NOW - 2 * 86400);
  e1.asst(15, 'm_e1', u(3, 30, 300, 3, 30), [], null, 'claude-sonnet-5-5');
  agent(A, 'ae1', { agentType: 'gsd-executor', model: 'sonnet', toolUseId: 'toolu_e1' }, e1);
  const e2 = new F(NOW - 2 * 86400);
  e2.asst(20, 'm_e2', u(4, 40, 400, 4), [], null, 'claude-sonnet-5-5');
  agent(A, 'ae2', null, e2);                                            // no meta: linked by the result
  const x1 = new F(NOW - 2 * 86400);
  x1.asst(1, 'm_x1', u(999, 999, 999, 999));
  agent(A, 'ax1', { agentType: `general-purpose<b>${SECRET}`, model: 'sonnet', toolUseId: 'toolu_other' }, x1);
  const p3 = new F(NOW - 2 * 86400);
  p3.asst(35, 'm_p3', u(5, 50, 500, 5));
  agent(A, 'ap3', { agentType: 'gsd-planner', model: 'opus', toolUseId: 'toolu_p3' }, p3);
}

// Session C — a /gsdt-batch run, 1 hour ago.
const C = 'cccc3333-0000-4000-8000-000000000003';
{
  const c = new F(NOW - 3600);
  c.cmd(0, 'gsdt-batch', SECRET);
  c.asst(1, 'm_g1', u(1, 10, 100, 1), [spawnT('toolu_s1', 'general-purpose', 'Scout batch items', 'sonnet')], null, 'claude-sonnet-5-5');
  c.result(5, 'toolu_s1', 'as1', 'completed');
  c.asst(6, 'm_g2', u(1, 10, 100, 1), [], 'sorted list', 'claude-sonnet-5-5');
  c.human(10, 'ok');                                                    // the pause for the OK
  c.asst(11, 'm_g3', u(1, 10, 100, 1), [['Skill', 'tsk2', { skill: 'gsd-quick-batch' }]], null, 'claude-sonnet-5-5');
  c.asst(12, 'm_g4', u(1, 10, 100, 1), [spawnT('toolu_g1', 'gsd-planner', 'Plan 261109-cc1: a'), spawnT('toolu_g2', 'gsd-planner', 'Plan 261109-cc2: b')], null, 'claude-sonnet-5-5');
  c.result(13, 'toolu_g1', 'ag1', 'completed'); c.result(13, 'toolu_g2', 'ag2', 'completed');
  c.human(14, 'unrelated question while it runs');                      // a planned item has no executor yet
  c.asst(15, 'm_g5', u(1, 10, 100, 1), [], 'gsdt-batch: done items=3 real=2 tiny=1', 'claude-sonnet-5-5');
  c.human(16, 'next thing');
  c.asst(17, 'm_after', u(500, 500, 500, 500), [], null, 'claude-sonnet-5-5');
  c.write(path.join(P, `${C}.jsonl`));
  const s1 = new F(NOW - 3600);
  s1.asst(2, 'm_s1', u(1, 1, 1, 1), [], null, 'claude-sonnet-5-5');
  agent(C, 'as1', { agentType: 'general-purpose', model: 'sonnet', toolUseId: 'toolu_s1' }, s1);
  for (const [aid, tid] of [['ag1', 'toolu_g1'], ['ag2', 'toolu_g2']] as const) {
    const g = new F(NOW - 3600);
    g.asst(12, `m_${aid}`, u(1, 1, 1, 1));
    agent(C, aid, { agentType: 'gsd-planner', model: 'opus', toolUseId: tid }, g);
  }
}

// Session B — no batch.
{
  const b = new F(NOW - 7200);
  b.human(0, 'hello'); b.asst(1, 'm_b', u(5, 5, 5, 5));
  b.write(path.join(P, 'bbbb2222-0000-4000-8000-000000000002.jsonl'));
}

// ---------------------------------------------------------------- reading the reports
type Role = { role: string; model: string; turns: number; agents: number; bash: number; input: number; fresh_input: number; cache_write: number; cache_write_1h: number; cache_read: number; output: number; weighted_input: number; per_item: { input: number } };
type Batch = { skill: string; ended_by: string; items: number; items_from: string; real: number; tiny: number; roles: Role[] };
type Rep = { batches: Batch[]; combined: { items: number } };
const json = (r: { stdout: string }): Rep => JSON.parse(r.stdout) as Rep;
const roleOf = (d: Rep, i: number, role: string, model: string): Role => {
  const r = d.batches[i]!.roles.find((x) => x.role === role && x.model === model);
  if (!r) throw new Error(`no role ${role}/${model} in batch ${i}`);
  return r;
};
const J = (x: unknown): string => JSON.stringify(x);

test('help and usage', () => {
  const r = BR(['--help']);
  is('--help exits 0', r.status, 0);
  has('--help explains --baseline', r.out, '--baseline');
  is('--last x → 64', BR(['--last', 'x', '--dir', P]).status, 64);
  is('--last with --days → 64', BR(['--last', '1', '--days', '2', '--dir', P]).status, 64);
  is('a bad --session → 64', BR(['--session', 'a;b', '--dir', P]).status, 64);
  is('unknown option → 64', BR(['--bogus']).status, 64);
  is('missing --baseline file → 64', BR(['--baseline', path.join(WORK, 'nope.json'), '--dir', P]).status, 64);
});

test('providers', () => {
  let r = BR(['--provider', 'codex']);
  is('codex → exit 0', r.status, 0);
  has('…says not supported yet', r.out, 'not supported yet for codex');
  r = BR(['--provider', 'gemini']);
  is('gemini → 64', r.status, 64);
  has('…with the reason', r.out, 'no longer supported');
  is('unknown provider → 64', BR(['--provider', 'nope']).status, 64);
});

let all: Rep;
test('finding batches', () => {
  let r = BR(['--dir', P, '--last', '9', '--json']);
  is('--json exits 0', r.status, 0);
  all = json(r);
  is('3 batches (the session without one is skipped)', all.batches.length, 3);
  is('…in time order', J(all.batches.map((b) => b.skill)), J(['gsd-quick-batch', 'gsd-quick-batch', 'gsdt-batch']));
  is('batch 1 ends at the first prompt once settled', all.batches[0]!.ended_by, 'your next prompt');
  is('batch 2 (typed) runs to the end of the session', all.batches[1]!.ended_by, 'end of session');
  is('gsdt-batch ends at its done line', all.batches[2]!.ended_by, 'done line');
  r = BR(['--dir', P]);
  has('default = the last batch', r.out, '1 batch · 3 items');
  const d = json(BR(['--dir', P, '--days', '1', '--json']));
  is('--days 1 → only the recent batch', J(d.batches.map((b) => b.skill)), J(['gsdt-batch']));
  const s = json(BR(['--dir', P, '--session', 'aaaa1111', '--json']));
  is("--session <prefix> → that session's batches", s.batches.length, 2);
});

test('counting — batch 1', () => {
  const F1 = all;
  is('coordinator: turns once per message id, only inside the window', roleOf(F1, 0, 'coordinator', 'opus').turns, 5);
  is('coordinator fresh input', roleOf(F1, 0, 'coordinator', 'opus').fresh_input, 24);
  is('coordinator cache write', roleOf(F1, 0, 'coordinator', 'opus').cache_write, 1000);
  is('coordinator cache read', roleOf(F1, 0, 'coordinator', 'opus').cache_read, 10500);
  is('coordinator output', roleOf(F1, 0, 'coordinator', 'opus').output, 75);
  is('planners: 2 agents (one from its meta model)', roleOf(F1, 0, 'gsd-planner', 'opus').agents, 2);
  is('planners: duplicate message id counted once', roleOf(F1, 0, 'gsd-planner', 'opus').turns, 3);
  is('planners: Bash calls once per tool id', roleOf(F1, 0, 'gsd-planner', 'opus').bash, 2);
  is('planners: input', roleOf(F1, 0, 'gsd-planner', 'opus').input, 444);
  is('nested helper counted (Explore · haiku)', roleOf(F1, 0, 'Explore', 'haiku').agents, 1);
  is('executors: 2 (one with no meta file)', roleOf(F1, 0, 'gsd-executor', 'sonnet').agents, 2);
  is('executors: 1h cache write kept apart', roleOf(F1, 0, 'gsd-executor', 'sonnet').cache_write_1h, 30);
  is('executors: weighted input (7 + 40×1.25 + 30×2 + 700×0.1)', roleOf(F1, 0, 'gsd-executor', 'sonnet').weighted_input, 187);
  is('an unrelated helper is not counted', J(F1.batches[0]!.roles.map((r) => r.role).sort()), J(['Explore', 'coordinator', 'gsd-executor', 'gsd-planner']));
  is('items = the quick ids', F1.batches[0]!.items, 2);
  is('per-item input', roleOf(F1, 0, 'gsd-planner', 'opus').per_item.input, 222);
});

test('counting — batch 2 and gsdt-batch', () => {
  is('batch 2: its coordinator only', roleOf(all, 1, 'coordinator', 'opus').turns, 2);
  is('batch 2: a helper with a sync result', roleOf(all, 1, 'gsd-planner', 'opus').input, 555);
  is('batch 2: 1 item (from the planner\'s quick id)', all.batches[1]!.items, 1);
  is('gsdt-batch: the pause and the nested quick-batch stay in', roleOf(all, 2, 'coordinator', 'sonnet').turns, 5);
  is('gsdt-batch: the scout counted', roleOf(all, 2, 'general-purpose', 'sonnet').agents, 1);
  const b = all.batches[2]!;
  is('gsdt-batch: items from the done line', J([b.items, b.items_from, b.real, b.tiny]), J([3, 'done line', 2, 1]));
  is('combined: items add up', all.combined.items, 6);
});

test('text report', () => {
  let r = BR(['--dir', P, '--last', '9']);
  is('exit 0', r.status, 0);
  has('role table', r.out, 'gsd-planner · opus');
  has('input split', r.out, 'CACHE RD');
  has('per-item table vs the baseline', r.out, 'BASE IN');
  has('baseline named', r.out, 'the week before 2026-11-09');
  has('an unknown role is marked new', r.out, /Explore · haiku .* new/);
  const r4 = BR(['--dir', P, '--last', '9', '--items', '4']);
  has('--items overrides the count', r4.out, '· 4 items');
  const basePath = path.join(WORK, 'base.json');
  const base = BR(['--dir', P, '--last', '9', '--json']);
  writeFileSync(basePath, base.stdout);
  r = BR(['--dir', P, '--baseline', basePath]);
  has('--baseline: a saved report', r.out, 'from a saved report');
  const everything = lf(JSON.stringify(all)) + r.out;
  hasnt('transcript text never printed', everything, 'SECRET-TEXT-42');
  hasnt('an odd agentType is not printed', everything, '<b>');
});

test('nothing to report', () => {
  mkdirSync(path.join(WORK, 'empty'), { recursive: true });
  writeFileSync(path.join(WORK, 'empty', 'bbbb2222-0000-4000-8000-000000000002.jsonl'), readFileSync(path.join(P, 'bbbb2222-0000-4000-8000-000000000002.jsonl')));
  let r = BR(['--dir', path.join(WORK, 'empty')]);
  is('no batch → exit 0', r.status, 0);
  has('…and says so', r.out, 'no /gsd-quick-batch or /gsdt-batch run found');
  r = BR(['--dir', path.join(WORK, 'empty'), '--json']);
  is('--json: an empty list', J(json(r).batches), '[]');
  r = BR(['--dir', path.join(WORK, 'nowhere')]);
  is('missing folder → exit 0', r.status, 0);
  has('…and says where it looked', r.out, `looked in ${path.join(WORK, 'nowhere')}`);
});

test('finding the transcripts of a repo', () => {
  const Rr = path.join(WORK, 'my repo.x');
  initRepo(ENV, Rr);
  const H = path.join(WORK, 'claudehome');
  const RP = real(Rr);
  const name = RP.replace(/[^A-Za-z0-9]/g, '-');
  mkdirSync(path.join(H, 'projects'), { recursive: true });
  symlinkSync(P, path.join(H, 'projects', name), 'junction');
  let r = BR(['--last', '9', '--json'], { CLAUDE_CONFIG_DIR: H }, Rr);
  is('from inside the repo, CLAUDE_CONFIG_DIR honored', json(r).batches.length, 3);
  r = BR(['--repo', Rr, '--last', '9', '--json'], { CLAUDE_CONFIG_DIR: H });
  is('--repo <path>', json(r).batches.length, 3);
  const long = `/${'x'.repeat(230)}`;
  const lname = long.replace(/[^A-Za-z0-9]/g, '-');
  mkdirSync(path.join(H, 'projects', `${lname.slice(0, 200)}-abc123`), { recursive: true });
  const slash = (p: string): string => p.replace(/\\/g, '/');
  is('a long path: cut at 200 + hash suffix', slash(projdir(H, [long])), slash(path.join(H, 'projects', `${lname.slice(0, 200)}-abc123`)));
});

// ---------------------------------------------------------------- the launcher
const D = ((): string => { const n = new Date(); const p = (x: number): string => String(x).padStart(2, '0'); return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`; })();
const L = path.join(WORK, 'launch');
const LP = (): string => real(L);
const LW = (): string => path.join(path.dirname(LP()), 'launch-worktrees');
const BW = (): string => path.join(LW(), `batch-${D}-fix-a`);

test('gsdt-batch — the launcher', () => {
  // never run from inside this repo: a slip would make a batch worktree here
  mkdirSync(path.join(L, '.planning'), { recursive: true });
  git(L, 'init', '-q', '-b', 'main');
  w(path.join(L, '.planning/ROADMAP.md'), '# Roadmap\n\n### Phase 1: catalog\n');
  w(path.join(L, 'brief.md'), 'brief\n');
  w(path.join(L, '.gsd.conf'), 'install = none\ntest = none\n');
  git(L, 'add', '-A'); git(L, 'commit', '-qm', 'init');
  w(path.join(L, 'a.md'), 'notes\n');   // not committed
  let r = GB(['--help']);
  is('--help exits 0', r.status, 0);
  is('no task list → 64', GB(['--repo', L, '--print']).status, 64);
  is('not a repo → 64', GB(['--repo', path.join(WORK, 'nope'), '--print', 'x']).status, 64);
  r = GB(['--repo', L, '--print', '- fix a\n- fix b', '--validate']);
  is('claude: a fresh Sonnet session in the batch worktree, flags before the list', lf(r.stdout).replace(/\n+$/, ''),
    `cd ${shellQuote(path.join(LW(), `batch-${D}-fix-a`))} && claude --model sonnet $'/gsdt-batch --validate\\n- fix a\\n- fix b'`);
  has('--print says which worktree it would make', r.stderr, new RegExp(`would make worktree .*batch-${D}-fix-a \\(branch 'batch-${D}-fix-a' off main\\)`));
  is('--print makes nothing', gitOut(ENV, L, ['branch', '--list', 'batch-*']).split('\n').filter((x) => x !== '').length, 0);
  r = GB(['--print', '--model', 'opus', '--file', 'a.md'], { cwd: L });
  has('claude: --model wins', r.out, /claude --model opus \/gsdt-batch.*--file.*a\.md/);
  has('--file: the name of the file is the slug', r.out, `batch-${D}-a `);
  has('--file not committed: read from the main checkout, by absolute path', r.out, new RegExp(`file.*${LP().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]a\\.md`));
  r = GB(['--print', '--file', 'brief.md'], { cwd: L });
  has("--file committed: the worktree's own copy", r.stdout, new RegExp(`file.*${LW().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*batch-${D}-brief.*brief\\.md`));
  r = GB(['--print', '--file', 'nope.md'], { cwd: L });
  is('--file missing → 64', r.status, 64);
  r = GB(['--print', '--model', 'default', '--file', 'a.md'], { cwd: L });
  hasnt("claude: --model default → the CLI's own", r.out, '--model');
  r = GB(['--print', '--provider', 'codex', '--file', 'a.md'], { cwd: L });
  has('codex: launched with the skill named', r.stdout, /codex Use.*gsdt-batch.*skill/);
  hasnt('codex: no --model sonnet', r.stdout, 'sonnet');
  has('codex: says the switch is Claude-only', r.stderr, 'Claude-only');
  r = GB(['--repo', L, '--print', '--provider', 'custom', '--agent-command', 'myagent', 'x']);
  has('custom: its own executable', r.stdout, 'myagent Run');
  r = GB(['--repo', L, '--print', 'Read plan/FIX-BRIEF-7.md. Fix only the real ones.']);
  has('a brief is passed on as typed', r.out, /\/gsdt-batch.*Read.*FIX-BRIEF-7\.md..*Fix.*only.*the.*real.*ones\./);
  has('…its first words name the batch', r.out, `batch-${D}-read-plan-fix-brief-7`);
  r = GB(['--repo', L, '--print', '--provider', 'gemini', 'x']);
  is('gemini → 64', r.status, 64);
  has('…with the reason', r.out, 'no longer supported');
});

test('gsdt-batch — its own batch-* worktree', () => {
  const bw = BW();
  let r = GB(['--repo', L, '- fix a']);
  is('no terminal → worktree made, command printed, exit 0', r.status, 0);
  is('…the command opens the session in the worktree', r.stdout.split(' ').slice(0, 2).join(' '), `cd ${shellQuote(bw)}`);
  is('…on its own branch, off main', `${gitOut(ENV, bw, ['branch', '--show-current'])}:${gitOut(ENV, L, ['merge-base', 'main', `batch-${D}-fix-a`])}`, `batch-${D}-fix-a:${gitOut(ENV, L, ['rev-parse', 'main'])}`);
  fileHas('…with worktree.baseRef = head (quick-batch runs items in parallel)', path.join(bw, '.claude/settings.local.json'), '"baseRef": "head"');
  is('…a clean worktree', gitOut(ENV, bw, ['status', '--porcelain']).split('\n').filter((x) => x !== '').length, 0);
  is('…the main checkout stays on main', gitOut(ENV, L, ['branch', '--show-current']), 'main');
  r = GB(['--repo', L, '- fix a']);
  has('a taken name gets -2 (a new batch never reuses another\'s worktree)', r.stdout, `batch-${D}-fix-a-2 `);
  r = GB(['--repo', L, '--name', 'fix-a', '- other']);
  has('--name: that worktree is reused', r.stderr, 'already has a worktree');
  is('…no -3', gitOut(ENV, L, ['branch', '--list', `batch-${D}-fix-a-3`]).split('\n').filter((x) => x !== '').length, 0);
  r = GB(['--print', '--resume'], { cwd: bw });
  is('from inside a batch worktree: the session runs there', r.stdout.split(' ').slice(0, 2).join(' '), `cd ${shellQuote(bw)}`);
  has('…and makes nothing', r.stderr, 'would use worktree');
  const U = path.join(WORK, 'unplanned');
  initRepo(ENV, U, 'main');
  git(U, 'commit', '-qm', 'i', '--allow-empty');
  w(path.join(U, '.planning/STATE.md'), 'x\n');
  r = GB(['--repo', U, '--print', '- fix a']);
  is('.planning/ not committed → refused (64)', r.status, 64);
  has('…saying why', r.out, 'gsd-core would then run the batch in the main checkout');
});

test('a batch worktree in the guard, gsdt-list, gsdt-doctor', () => {
  const bw = BW();
  for (const c of ['gsd-quick-batch', 'gsd-quick', 'gsd-fast']) {
    is(`the guard allows ${c} in a batch worktree`, gsdt(ENV, 'gsdt-worktree-guard', ['--command', c, '--repo', bw], { cwd: WORK }).status, 0);
  }
  is('…but not phase work', gsdt(ENV, 'gsdt-worktree-guard', ['--command', 'gsd-plan-phase', '--args', '1', '--repo', bw], { cwd: WORK }).status, 2);
  let r = gsdt(ENV, 'gsdt-list', ['--repo', L], { cwd: WORK });
  has('gsdt-list shows the batch, attached', r.out, `● batch-${D}-fix-a`);
  has('…and how to land it', r.out, 'gsdt-finish <branch>');
  git(L, 'worktree', 'remove', '--force', path.join(LW(), `batch-${D}-fix-a-2`));
  r = gsdt(ENV, 'gsdt-doctor', ['--repo', L], { cwd: WORK });
  has('gsdt-doctor: a batch branch with no worktree is W017', r.out, `branch(es) with no worktree: batch-${D}-fix-a-2`);
  hasnt('…an attached one is not', r.out, new RegExp(`no worktree:.*batch-${D}-fix-a `));
});

test('the skill and the instructions', () => {
  const SK = path.join(PKG, 'skills/gsdt-batch/SKILL.md');
  ok('skills/gsdt-batch/SKILL.md exists', existsSync(SK));
  fileHas('its name', SK, /^name: gsdt-batch$/m);
  fileHas('it says it replaces /gsd-quick-batch', SK, 'INSTEAD of /gsd-quick-batch');
  fileHas('it takes a brief in plain words', SK, 'OR any brief in plain words');
  fileHas('a brief gets an Opus helper (it decides what is real)', SK, 'a brief → `model: opus`');
  fileHas('recommended items are never built', SK, 'never built');
  fileHas('it prints the done line the report and the mod read', SK, 'gsdt-batch: done items=');
  fileHas('in the main checkout it stops and prints the gsdt-batch command', SK, 'MAIN checkout: STOP');
  fileHas('it never lands the batch itself: it prints gsdt-finish', SK, 'gsdt-finish <batch-branch>');
  fileHasnt('provider-neutral: no literal Skill() calls', SK, 'Skill(');
  // lib/install-copy.sh is bash by nature (the old installer, kept as the oracle for gsdt-setup)
  const H2 = path.join(WORK, 'insthome');
  mkdirSync(H2, { recursive: true });
  const fwd = (p: string): string => p.replace(/\\/g, '/');
  const inst = run(ENV, 'bash', [fwd(path.join(PKG, 'lib/install-copy.sh')), '--agent', 'claude', '--no-user-hook', '--no-core'],
    { cwd: WORK, env: { HOME: H2, USERPROFILE: H2, XDG_CONFIG_HOME: undefined, XDG_DATA_HOME: undefined, XDG_CACHE_HOME: undefined, GSD_NO_CORE: '1' } });
  if (inst.status === 0) fileHas('install copies it, with the toolkit mark', path.join(H2, '.claude/skills/gsdt-batch/SKILL.md'), /^<!-- gsd-toolkit-skill /m);
  else ok('lib/install-copy.sh ran', false, inst.out.split('\n').slice(-5).join('\n'));
  const canon = rulesText('off');
  has('the toolkit rules (gsdt-rules) point at the gsdt-batch script', canon, "`gsdt-batch '<task list or brief>'` in a terminal (the script, not the skill)");
});

// gsd-core's own parser, found next to gsd_run; the bash suite skipped without it, and so does this one
function findGsdRun(): string | null {
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const n of WIN ? ['gsd_run.cmd', 'gsd_run.exe', 'gsd_run'] : ['gsd_run']) {
      const f = path.join(d, n);
      if (d !== '' && existsSync(f)) return f;
    }
  }
  return null;
}
const GSD_RUN = findGsdRun();
const QB = GSD_RUN === null ? null : path.join(path.dirname(GSD_RUN), 'lib', 'quick-batch.cjs');
test('an enriched line is ONE quick-batch item', { skip: QB === null || !existsSync(QB) ? 'gsd-core (gsd_run + lib/quick-batch.cjs) not found' : false }, () => {
  const items = [
    '- fix the price label on the card — Likely files: a.ts, b.ts; Tests: a.spec.ts; Done when: label shows EGP',
    '- make the English name required — Likely files: c.ts; Tests: c.spec.ts; Done when: save refuses an empty name',
  ].join('\n') + '\n';
  const q = createRequire(import.meta.url)(QB!) as { parseTaskList: (t: string) => { ok: boolean; value: { description: string }[]; reason?: string } };
  const r = q.parseTaskList(items);
  is("gsd-core's parser: 2 lines → 2 items, original words first", r.ok ? `${r.value.length}:${r.value[0]!.description.slice(0, 13)}` : r.reason, '2:fix the price');
});

test('lint', () => {
  const bash = (f: string): number => spawnSync('bash', ['-n', f.replace(/\\/g, '/')], { encoding: 'utf8' }).status ?? 1;
  const BRB = path.join(PKG, 'bin', 'gsdt-batch-report'), GBB = path.join(PKG, 'bin', 'gsdt-batch');
  is('bash -n gsdt-batch-report', bash(BRB), 0);
  is('bash -n gsdt-batch', bash(GBB), 0);
  const check = (f: string): number => spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }).status ?? 1;
  is('batch-report.ts compiles (node --check)', check(path.join(PKG, 'src/batch-report.ts')), 0);
  is('commands/batch-report.ts compiles (node --check)', check(path.join(PKG, 'src/commands/batch-report.ts')), 0);
  // bash 3.2: no $VAR directly followed by a non-ASCII character
  const risky: string[] = [];
  for (const f of [BRB, GBB]) {
    readFileSync(f, 'latin1').split('\n').forEach((l, i) => { if (/\$[A-Za-z_][A-Za-z0-9_]*[^\x20-\x7e\s]/.test(l)) risky.push(`${f}:${i + 1}:${l}`); });
  }
  is('bash 3.2: no $VAR directly followed by a non-ASCII character', risky.join('\n'), '');
});
