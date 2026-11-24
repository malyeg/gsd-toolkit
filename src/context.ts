// src/context.ts — port of lib/context.sh: what GSD adds to an agent's context,
// for gsdt-doctor. lib/context.sh stays while a bash caller needs it (none left
// after P5: only the old doctor oracle in tests/fixtures/p5-old-bins/).
//
// Every session lists each installed skill's and agent's name and description;
// gsd-core installs ~75 skills and ~35 agents. A skill's full text loads only
// when it runs, so only the listing is counted. Tokens are estimated as
// characters / 4. Reads files only; node runs only to read gsd-core's own
// skill-group list (clusters.cjs), never anything that changes state.
import { spawnSyncX as spawnSync } from './spawn.ts';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { commandOnPath, confGet, isDir, isFile } from './common.ts';
import { providerSkillRoot } from './provider.ts';
import { uiGates } from './ui.ts';

/** GSD_CONTEXT_BIG_KIB — a GSD planning file, or AGENTS.md, over this is noted */
export const CONTEXT_BIG_KIB = 32;

/** planning_max_kib default: a planning file over this is a warning (or, strict, stops gsdt-start) */
export const PLANNING_MAX_KIB = 64;

/** The planning files GSD reads at nearly every step. */
export const PLANNING_READ_FILES = ['ROADMAP.md', 'REQUIREMENTS.md', 'STATE.md', 'PROJECT.md'] as const;

export type PlanningSize = {
  mode: 'warn' | 'strict' | 'off';
  /** the limit in KiB (`planning_max_kib`, else PLANNING_MAX_KIB) */
  limit: number;
  /** files over the limit, biggest first */
  big: { rel: string; bytes: number }[];
};

/** `planning_size` and `planning_max_kib` from .gsd.conf, and the planning files over the limit. */
export function planningSize(main: string): PlanningSize {
  const m = confGet(main, 'planning_size');
  const mode = m === 'strict' || m === 'off' ? m : 'warn';
  const raw = confGet(main, 'planning_max_kib');
  const limit = /^[0-9]+$/.test(raw) && Number.parseInt(raw, 10) > 0 ? Number.parseInt(raw, 10) : PLANNING_MAX_KIB;
  const big: { rel: string; bytes: number }[] = [];
  if (mode !== 'off') {
    for (const f of PLANNING_READ_FILES) {
      const rel = `.planning/${f}`;
      let bytes = 0;
      try {
        bytes = statSync(`${main}/${rel}`).size;
      } catch {
        continue;
      }
      if (bytes > limit * 1024) big.push({ rel, bytes });
    }
    big.sort((a, b) => b.bytes - a.bytes);
  }
  return { mode, limit, big };
}

/** "~32.6k tokens" from a byte count (characters / 4) */
function approxTokens(bytes: number): string {
  const t = bytes / 4;
  return t >= 1000 ? `~${(t / 1000).toFixed(1)}k tokens` : `~${Math.floor(t)} tokens`;
}

/** The lines gsdt-start and gsdt-flow-next print when planning files are over the limit ([] when none). */
export function planningSizeNotice(s: PlanningSize): string[] {
  if (s.big.length === 0) return [];
  const total = s.big.reduce((n, f) => n + f.bytes, 0);
  const files = s.big.map((f) => `${f.rel} ${Math.floor(f.bytes / 1024)} KiB`).join(', ');
  return [
    `⚠ planning files over ${s.limit} KiB: ${files} (${approxTokens(total)}) — GSD reads them at nearly every step, so every session pays for them.`,
    '  Archive what has shipped: /gsd-complete-milestone (a milestone can end at any phase: put a "## vX.Y <name>" heading above its first phase in ROADMAP.md).',
    `  .gsd.conf: planning_max_kib = <KiB> moves the limit; planning_size = strict makes gsdt-start refuse a new phase, off silences this.`,
  ];
}

/** gsd_core_required_skills — names without gsd-: what the flow and gsdt-init run */
export function coreRequiredSkills(repo: string): string[] {
  const s = 'new-project ingest-docs discuss-phase plan-phase review execute-phase code-review verify-work validate-phase secure-phase ui-phase ui-review'.split(
    ' ',
  );
  if (uiGates(repo) !== 'off') s.push('sketch');
  return s;
}

/** gsd_agent_home — claude|codex → the agent's config folder (null for any other name) */
export function agentHome(agent: string): string | null {
  const nz = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);
  if (agent === 'claude') return nz(process.env.CLAUDE_CONFIG_DIR) ?? `${(process.env.HOME ?? process.env.USERPROFILE ?? '')}/.claude`;
  if (agent === 'codex') return nz(process.env.CODEX_HOME) ?? `${(process.env.HOME ?? process.env.USERPROFILE ?? '')}/.codex`;
  return null;
}

/** `ls -d "$d"/gsd-*\/` succeeds: some gsd-* entry that is a folder */
function hasGsdDir(d: string): boolean {
  try {
    return readdirSync(d).some((n) => n.startsWith('gsd-') && isDir(`${d}/${n}`));
  } catch {
    return false;
  }
}

/** gsd_core_skill_dir — the folder holding gsd-core's gsd-* skills for an agent (null when none) */
export function coreSkillDir(agent: string): string | null {
  const home = agentHome(agent);
  const cands = [providerSkillRoot(agent) ?? '', `${home ?? ''}/skills`];
  for (const d of cands) {
    if (d === '/skills' || d === '') continue;
    if (hasGsdDir(d)) return d;
  }
  return null;
}

/** awk's length() as the BSD awk and mawk do it: bytes (the file is read as latin1, one char per byte) */
const chars = (s: string): number => s.length;

/**
 * gsd_listing_size — [files, chars] of what an agent lists every session for
 * these files: name, description and when_to_use in a Markdown front matter
 * (indented continuation lines included), or name/description lines in a
 * .toml agent. A file with no line at all is not counted (awk never sees it).
 */
export function listingSize(files: string[]): [number, number] {
  let n = 0;
  let c = 0;
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, 'latin1');
    } catch {
      continue; // awk: "can't open file", the rest goes on
    }
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) continue;
    n++;
    const toml = /\.toml$/.test(f);
    let fm = 0;
    let k = false;
    lines.forEach((line, i) => {
      if (toml) {
        if (/^(name|description)[ \t]*=/.test(line)) c += chars(line) + 1;
        return;
      }
      if (i === 0 && /^---/.test(line)) {
        fm = 1;
        return;
      }
      if (fm === 1 && /^---/.test(line)) {
        fm = 2;
        return;
      }
      if (fm !== 1) return;
      if (/^(name|description|when_to_use):/.test(line)) {
        k = true;
        c += chars(line) + 1;
        return;
      }
      if (/^[A-Za-z_-]+:/.test(line)) {
        k = false;
        return;
      }
      if (k && /^[ \t]/.test(line)) c += chars(line) + 1;
    });
  }
  return [n, c];
}

/** gsd_tokens_fmt — chars → "~1.2k tokens" / "~300 tokens" */
export function tokensFmt(c: number): string {
  const t = Math.floor(c / 4);
  if (t >= 1000) return `~${Math.floor(t / 1000)}.${Math.floor((t % 1000) / 100)}k tokens`;
  return `~${t} tokens`;
}

export type Cluster = { group: string; on: boolean; skills: string[] };

const CLUSTER_JS = `
    const [f, s] = process.argv.slice(1);
    const C = require(f).CLUSTERS || {};
    let off = [];
    try { off = JSON.parse(require("fs").readFileSync(s, "utf8")).disabledClusters || []; } catch (e) {}
    for (const [k, v] of Object.entries(C)) console.log(k + " " + (off.includes(k) ? "off" : "on") + " " + v.join(" "));
  `;

/**
 * gsd_core_clusters — gsd-core's skill groups; off = disabled in
 * <agent home>/.gsd-surface.json (what /gsd-surface writes). Read from
 * gsd-core's clusters.cjs by a child node (as the bash did); [] without node
 * or that file.
 */
export function coreClusters(home: string): Cluster[] {
  const node = commandOnPath('node');
  if (node === null) return [];
  let f = '';
  const claude = process.env.CLAUDE_CONFIG_DIR || `${(process.env.HOME ?? process.env.USERPROFILE ?? '')}/.claude`;
  for (const c of [`${home}/gsd-core/bin/lib/clusters.cjs`, `${claude}/gsd-core/bin/lib/clusters.cjs`]) {
    if (isFile(c)) {
      f = c;
      break;
    }
  }
  if (f === '') return [];
  const r = spawnSync(node, ['-e', CLUSTER_JS, f, `${home}/.gsd-surface.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const out: Cluster[] = [];
  for (const line of (r.stdout ?? '').split('\n')) {
    // read -r g st rest (default IFS)
    const m = /^[ \t]*(\S+)(?:[ \t]+(\S+)(?:[ \t]+(.*?))?)?[ \t]*$/.exec(line);
    if (!m) continue;
    const [, g, st = '', rest = ''] = m;
    out.push({ group: g as string, on: st === 'on', skills: rest.split(/[ \t]+/).filter((x) => x !== '') });
  }
  return out;
}

/**
 * gsd_core_hideable — groups the toolkit does not need that still have skills
 * installed: [group, skills, chars]. A group is hideable only when none of its
 * skills is required (gsd-core removes every skill of a disabled group).
 */
export function coreHideable(repo: string, agent: string): Array<[string, number, number]> {
  const sd = coreSkillDir(agent);
  if (sd === null) return [];
  const home = agentHome(agent) as string;
  const req = new Set(coreRequiredSkills(repo));
  const out: Array<[string, number, number]> = [];
  for (const cl of coreClusters(home)) {
    if (!cl.on) continue;
    if (cl.skills.some((s) => req.has(s))) continue;
    const files = cl.skills.map((s) => `${sd}/gsd-${s}/SKILL.md`).filter(isFile);
    if (files.length === 0) continue;
    const [n, c] = listingSize(files);
    out.push([cl.group, n, c]);
  }
  return out;
}

/** gsd_core_missing_skills — required skills missing from a skill folder, as gsd-<name> */
export function coreMissingSkills(repo: string, skillDir: string): string[] {
  return coreRequiredSkills(repo)
    .filter((s) => !isFile(`${skillDir}/gsd-${s}/SKILL.md`))
    .map((s) => `gsd-${s}`);
}

/**
 * gsd_core_groups_for — the disabled groups that hold these skills ("gsd-x
 * gsd-y" → "g1 g2"), or '' when one of them is in no disabled group.
 */
export function coreGroupsFor(home: string, missing: string): string {
  const groups: string[] = [];
  const clusters = coreClusters(home);
  for (const s of missing.split(/[ \t\n]+/).filter((x) => x !== '')) {
    const bare = s.startsWith('gsd-') ? s.slice(4) : s;
    const found = clusters.find((cl) => !cl.on && cl.skills.includes(bare));
    if (!found) return '';
    if (!groups.includes(found.group)) groups.push(found.group);
  }
  return groups.join(' ');
}
