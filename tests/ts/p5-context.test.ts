// P5 (src/context.ts): every function against saved goldens in tests/golden/p5-context/.
// Regenerate with UPDATE_GOLDEN=1 (from the new code only); review a regenerated golden by diff.
// Run: node --test tests/ts/p5-context.test.ts
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { golden, test } from './golden.ts';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { repo, tmp, withEnv, write } from './helpers.ts';

// the temp dir spelled one way (macOS: /var/folders vs /private/var/folders), so goldenNorm sees it
const fix = (t: string): string => t.split(realpathSync(tmpdir())).join(tmpdir());
const gold = (text: string): void => golden(fix(text));

test('gsd_core_required_skills: ui_gates on and off', () => {
  for (const conf of ['base = develop\n', 'base = develop\nui_gates = off\n', 'ui_gates = strict\n']) {
    const r = repo(undefined, conf);
    gold(`# ${JSON.stringify(conf)}\n${coreRequiredSkills(r).join('\n')}\n`);
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
      const lbl = `# ${a} env=${Object.keys(env).join(',')}`;
      withEnv(env, () => {
        const t = agentHome(a);
        const td = coreSkillDir(a);
        gold(`${lbl}\nhome=${JSON.stringify(t)}\nskilldir=${JSON.stringify(td)}\nrc=${td === null ? 1 : 0}`);
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
    const [n, c] = listingSize(set);
    const lbl = `# ${JSON.stringify(set.map((x) => path.basename(x)))}`;
    gold(`${lbl}\n${n} ${c}\n`);
  }
  const nw: string[] = [];
  for (const n of [0, 1, 3, 4, 3999, 4000, 4099, 12345, 123456, 99999999]) {
    nw.push(`${n} => ${tokensFmt(n)}`);
  }
  gold(nw.join('\n'));
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
    const tc = coreClusters(home).map((c) => `${c.group} ${c.on ? 'on' : 'off'} ${c.skills.join(' ')}\n`).join('');
    gold(`# clusters ${surface}\n${tc}`);
    withEnv(env, () => {
      const th = coreHideable(r, 'claude').map(([g, n, c]) => `${g} ${n} ${c}\n`).join('');
      gold(`# hideable ${surface}\n${th}`);
      const miss = coreMissingSkills(r, `${h}/.claude/skills`);
      gold(`# missing ${surface}\n${miss.join('\n')}${miss.length ? '\n' : ''}`);
      for (const missing of ['gsd-validate-phase', 'gsd-validate-phase gsd-stats', 'gsd-nothing', 'gsd-validate-phase gsd-nothing', '']) {
        gold(`# groups for ${JSON.stringify(missing)} ${surface}\n${coreGroupsFor(home, missing)}`);
      }
    });
  }
  // no clusters file, no node group list
  const h2 = tmp();
  withEnv({ HOME: h2 }, () => assert.deepEqual(coreClusters(`${h2}/.claude`), []));
});

test('gsd_core_missing_skills with some skills gone, ui_gates off', () => {
  const h = tmp();
  makeCore(h);
  const r = repo(undefined, 'base = develop\nui_gates = off\n');
  const dir = `${h}/.claude/skills`;
  const t = `${coreMissingSkills(r, dir).map((s) => `${s}\n`).join('')}---\n${coreMissingSkills(r, '/nonexistent').map((s) => `${s}\n`).join('')}`;
  gold(t);
});
