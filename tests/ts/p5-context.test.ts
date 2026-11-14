// P5 parity (lib/context.sh → src/context.ts): every function against the bash
// original, same inputs side by side.
// Run: node --test tests/ts/p5-context.test.ts
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  agentHome,
  coreClusters,
  coreGroupsFor,
  coreHideable,
  coreMissingSkills,
  coreRequiredSkills,
  coreSkillDir,
  listingSize,
  tokensFmt,
} from '../../src/context.ts';
import { bash, chomp, repo, tmp, withEnv, write } from './helpers.ts';

const ctx = (script: string, args: string[] = [], env: Record<string, string> = {}) => bash(`. "$GSD_PKG/lib/context.sh"; ${script}`, args, env);

test('gsd_core_required_skills: ui_gates on and off', () => {
  for (const conf of ['base = develop\n', 'base = develop\nui_gates = off\n', 'ui_gates = strict\n']) {
    const r = repo(undefined, conf);
    const b = ctx('gsd_core_required_skills "$1"', [r]);
    assert.equal(coreRequiredSkills(r).join('\n') + '\n', b.out, conf);
  }
});

test('gsd_agent_home / gsd_core_skill_dir', () => {
  const h = tmp();
  const cases: Array<Record<string, string | undefined>> = [
    { HOME: h },
    { HOME: h, CLAUDE_CONFIG_DIR: `${h}/cc`, CODEX_HOME: `${h}/cx` },
    { HOME: h, GSD_CLAUDE_SKILL_DIR: `${h}/sk` },
  ];
  mkdirSync(`${h}/.claude/skills/gsd-x`, { recursive: true });
  mkdirSync(`${h}/cc/skills/gsd-y`, { recursive: true });
  mkdirSync(`${h}/sk/other`, { recursive: true });
  mkdirSync(`${h}/.agents/skills/nogsd`, { recursive: true });
  for (const env of cases) {
    for (const a of ['claude', 'codex', 'other']) {
      const e = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
      const bh = ctx('gsd_agent_home "$1"', [a], e);
      withEnv(env, () => {
        const t = agentHome(a);
        assert.equal(t === null ? '' : `${t}\n`, bh.out, `home ${a} ${JSON.stringify(env)}`);
        const bd = ctx('gsd_core_skill_dir "$1"', [a], e);
        const td = coreSkillDir(a);
        assert.equal(td === null ? '' : `${td}\n`, bd.out, `skill dir ${a} ${JSON.stringify(env)}`);
        assert.equal(td === null ? 1 : 0, bd.rc);
      });
    }
  }
});

test('gsd_listing_size + gsd_tokens_fmt', () => {
  const d = tmp();
  const f = (n: string, c: string): string => write(path.join(d, n), c);
  const files = [
    f('a.md', '---\nname: gsd-a\ndescription: "a ünïcode — dash"\nwhen_to_use: x\n  continued\n\tmore\nother: y\n  not counted\n---\nbody\ndescription: not counted\n'),
    f('b.md', 'no front matter\nname: x\n'),
    f('c.md', '----\nname: four dashes\n---\n'),
    f('d.toml', 'name = "x"\ndescription = "d"\nother = 1\n  name = "indented not counted"\n'),
    f('e.md', ''),
    f('f.md', '---\nname: no end marker\ndescription: still counted\n'),
    f('g.md', '---\nname: crlf\r\ndescription: x\r\n---\r\n'),
    f('h.md', '---\nname: nonl\n---'),
    f('i.md', '---\n---\nname: after\n'),
  ];
  for (const set of [[], files, files.slice(0, 1), files.slice(3, 5)]) {
    const b = ctx('gsd_listing_size "$@"', set);
    const [n, c] = listingSize(set);
    // a file awk cannot open is a warning on stderr; the totals still match
    assert.equal(`${n} ${c}\n`, b.out, JSON.stringify(set.map((x) => path.basename(x))));
  }
  for (const n of [0, 1, 3, 4, 3999, 4000, 4099, 12345, 123456, 99999999]) {
    assert.equal(tokensFmt(n), chomp(ctx('gsd_tokens_fmt "$1"', [String(n)]).out), `tokens ${n}`);
  }
});

function makeCore(h: string): void {
  const sk = `${h}/.claude/skills`;
  const names = 'new-project ingest-docs discuss-phase plan-phase review execute-phase code-review verify-work validate-phase secure-phase ui-phase ui-review sketch new-milestone thread stats docs-update audit-uat health'.split(' ');
  for (const s of names) write(`${sk}/gsd-${s}/SKILL.md`, `---\nname: gsd-${s}\ndescription: "the ${s} step"\n---\nbody\n`);
  write(
    `${h}/.claude/gsd-core/bin/lib/clusters.cjs`,
    `exports.CLUSTERS = Object.freeze({\n  core_loop: ['plan-phase', 'execute-phase', 'help'],\n  audit_review: ['validate-phase', 'audit-uat'],\n  milestone: ['new-milestone', 'health'],\n  workspace_state: ['thread'],\n  docs: ['ingest-docs', 'docs-update'],\n  empty_one: ['not-installed'],\n  stats_group: ['stats'],\n});\n`,
  );
}

test('clusters, hideable, missing skills, groups for', () => {
  const h = tmp();
  makeCore(h);
  const r = repo(undefined, 'base = develop\n');
  const env = { HOME: h };
  for (const surface of [null, '{"baseProfile":"full","disabledClusters":["stats_group","audit_review"]}', 'not json']) {
    if (surface !== null) write(`${h}/.claude/.gsd-surface.json`, `${surface}\n`);
    const home = `${h}/.claude`;
    const bc = ctx('gsd_core_clusters "$1"', [home], env);
    const tc = coreClusters(home).map((c) => `${c.group} ${c.on ? 'on' : 'off'} ${c.skills.join(' ')}\n`).join('');
    assert.equal(tc, bc.out, `clusters ${surface}`);
    const bh = ctx('gsd_core_hideable "$1" "$2"', [r, 'claude'], env);
    withEnv(env, () => {
      const th = coreHideable(r, 'claude').map(([g, n, c]) => `${g} ${n} ${c}\n`).join('');
      assert.equal(th, bh.out, `hideable ${surface}`);
      const bm = ctx('gsd_core_missing_skills "$1" "$2"', [r, `${h}/.claude/skills`], env);
      assert.equal(coreMissingSkills(r, `${h}/.claude/skills`).join('\n') + (coreMissingSkills(r, `${h}/.claude/skills`).length ? '\n' : ''), bm.out);
      for (const missing of ['gsd-validate-phase', 'gsd-validate-phase gsd-stats', 'gsd-nothing', 'gsd-validate-phase gsd-nothing', '']) {
        const bg = ctx('gsd_core_groups_for "$1" "$2"', [home, missing], env);
        assert.equal(coreGroupsFor(home, missing), chomp(bg.out), `groups for ${missing} ${surface}`);
      }
    });
  }
  // no clusters file, no node group list
  const h2 = tmp();
  const bn = ctx('gsd_core_clusters "$1"', [`${h2}/.claude`], { HOME: h2 });
  assert.equal(bn.out, '');
  withEnv({ HOME: h2 }, () => assert.deepEqual(coreClusters(`${h2}/.claude`), []));
});

test('gsd_core_missing_skills with some skills gone, ui_gates off', () => {
  const h = tmp();
  makeCore(h);
  const r = repo(undefined, 'base = develop\nui_gates = off\n');
  const dir = `${h}/.claude/skills`;
  const b = ctx('gsd_core_missing_skills "$1" "$2"; echo ---; gsd_core_missing_skills "$1" /nonexistent', [r, dir], { HOME: h });
  const t = `${coreMissingSkills(r, dir).map((s) => `${s}\n`).join('')}---\n${coreMissingSkills(r, '/nonexistent').map((s) => `${s}\n`).join('')}`;
  assert.equal(t, b.out);
});
