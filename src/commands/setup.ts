// gsdt-setup — machine-level setup for the npm install (npm i -g gsd-toolkit).
// What lib/install-copy.sh (the old copy installer) does for skills, the Claude user hooks and gsd-core, for
// a package that npm placed (no runtime copy, no links into ~/.local/bin).
// Decided in P0: a separate command, no npm postinstall; gsdt-init stays
// repo-only. Machine-level legacy (Gemini, pre-0.8 gsd-worktrees) is dropped;
// a 0.10.x release install is moved off ~/.local/bin (npm mode only; a checkout run leaves it).
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { PY_SPACE, dumpJson, parseJson, readStrict } from '../claude-settings.ts';
import type { JVal } from '../claude-settings.ts';
import {
  GSD_SKILL_MARK,
  gsdPkg,
  isDir,
  isFile,
  skillDiffers,
  skillOwned,
} from '../common.ts';
import { coreSync } from '../core.ts';
import { providerListValidate, providerSkillRoot, providerUserHookFile } from '../provider.ts';
import { WIN, shellPath } from '../spawn.ts';
import { err, out } from '../stdio.ts';
import { installMode, readManifest, setupManifestPath } from '../version.ts';

const HELP = `gsdt-setup — machine-level setup for the npm install (npm i -g gsd-toolkit)

Usage:
  gsdt-setup [--agent claude|codex]... [--all-agents] [--no-user-hook] [--no-core]

What it does:
  - copies the toolkit's skills into each agent's skill dir (Claude: ~/.claude/skills,
    Codex: ~/.agents/skills), marked as the toolkit's so a later run replaces them in place
  - Claude: registers two user-level hooks in ~/.claude/settings.json: the guard
    (refuses /gsd-new-project and /gsd-ingest-docs before gsdt-init) and the
    SessionStart hook that loads gsdt-rules in a set-up repo
  - installs gsd-core (npx) for each agent that has none
  - npm install: moves a 0.10.x release install off ~/.local/bin (its gsd*-links, its runtime);
    from a git checkout it leaves that install alone and says so
  - records the choices in \${XDG_CONFIG_HOME:-~/.config}/gsd/setup-manifest; the next run
    keeps the recorded agents (a given --agent is added to them)

Options:
  --agent <claude|codex>   an agent to set up (repeatable); default: the recorded ones, else claude
  --all-agents             claude and codex
  --no-user-hook           no user hooks (and remove ours)
  --no-core                do not install gsd-core
  -h, --help               this text

The hooks run the commands from the bin dir: GSD_BIN_DIR, else the first PATH folder
holding this package's gsdt-worktree-guard (npm's bin dir after npm i -g).

Env: GSD_BIN_DIR, GSD_CLAUDE_SKILL_DIR, GSD_CODEX_SKILL_DIR, GSD_CLAUDE_SETTINGS,
     GSD_OLD_BIN_DIR (the 0.10.x bin dir, default ~/.local/bin), GSD_NO_CORE=1
`;

const HOME = (): string => process.env.HOME ?? '';
const nz = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);

/** python os.path.realpath: resolves what exists, keeps the rest */
function realpathLoose(p: string): string {
  const abs = path.resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    if (parent === abs) return abs;
    return path.join(realpathLoose(parent), path.basename(abs));
  }
}

const within = (a: string, b: string): boolean => `${a}/`.startsWith(`${b}/`);
const exists = (p: string): boolean => existsSync(p);
const present = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** backup_path — the first free <base>.bak, <base>.bak.1, … */
function backupPath(base: string): string {
  let o = `${base}.bak`;
  let n = 1;
  while (present(o)) o = `${base}.bak.${n++}`;
  return o;
}

/** toolkit_pkg — a folder that holds a toolkit package (release runtime or checkout) */
/** 0.10.x runtimes held lib/common.sh; from 0.11.0 only lib/install.sh (the bridge) is left of lib/ shell */
const toolkitPkg = (d: string): boolean => isFile(`${d}/install.sh`) && (isFile(`${d}/lib/common.sh`) || isFile(`${d}/lib/install.sh`));

/** owned_link — a link this toolkit placed earlier (from any checkout or release runtime) */
function ownedLink(link: string, kind: 'bin' | 'skills'): boolean {
  let t: string;
  try {
    t = readlinkSync(link);
  } catch {
    return false;
  }
  if (!t.startsWith('/')) t = `${path.dirname(link)}/${t}`;
  if (toolkitPkg(path.dirname(path.dirname(t)))) return true;
  return new RegExp(`/gsd-toolkit/releases/[^/]*/${kind}/`).test(t);
}

function readDir(d: string): string[] {
  try {
    return readdirSync(d).sort();
  } catch {
    return [];
  }
}

// ── skills ───────────────────────────────────────────────────────────────────

function skillVersion(pkg: string): string {
  try {
    return (readFileSync(`${pkg}/VERSION`, 'utf8').split('\n')[0] ?? '').trim();
  } catch {
    return '';
  }
}

/** retire_skills — a skill of ours the package no longer ships ("all": every skill of ours in an old location) */
function retireSkills(pkg: string, dir: string, provider: string, all: boolean): void {
  for (const name of readDir(dir).filter((n) => !n.startsWith('.'))) {
    const dest = `${dir}/${name}`;
    if (!all && isDir(`${pkg}/skills/${name}`)) continue;
    if (isLink(dest)) {
      // a dangling link of ours; a live link into another checkout stays (unless the whole dir is an old location)
      if (!all && exists(dest)) continue;
      let t = '';
      try {
        t = readlinkSync(dest);
      } catch {
        continue;
      }
      if (!t.startsWith(`${pkg}/skills/`) && !ownedLink(dest, 'skills')) continue;
      unlinkSync(dest);
    } else if (isDir(dest) && skillOwned(dest)) {
      rmSync(dest, { recursive: true, force: true });
    } else {
      continue;
    }
    out(`✔ ${provider} skill ${name} retired → removed ${dest}\n`);
  }
}

/** is `bin` one of the PATH folders (Windows: `;` between them, same folder in any spelling) */
function binOnPath(bin: string): boolean {
  const p = process.env.PATH ?? (WIN ? process.env.Path : undefined) ?? '';
  if (!WIN) return `:${p}:`.includes(`:${bin}:`);
  const key = (d: string): string => {
    let r = d;
    try {
      r = realpathSync.native(d);
    } catch {
      /* not there: compare as written */
    }
    return r.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  };
  const want = key(bin);
  return p.split(';').some((d) => d !== '' && key(d) === want);
}

function installSkills(pkg: string, provider: string, skillDir: string): void {
  mkdirSync(skillDir, { recursive: true });
  const mark = `${GSD_SKILL_MARK} ${skillVersion(pkg)} -->\n`;
  for (const name of readDir(`${pkg}/skills`)) {
    const src = `${pkg}/skills/${name}`;
    if (!isDir(src)) continue;
    const dest = `${skillDir}/${name}`;
    if (present(dest)) {
      if (isDir(dest) && !isLink(dest) && !skillDiffers(`${src}/`, dest)) {
        out(`• ${provider} skill ${name} already current\n`);
        continue;
      } else if (isLink(dest) && ownedLink(dest, 'skills')) {
        unlinkSync(dest);
      } else if (isDir(dest) && !isLink(dest) && skillOwned(dest)) {
        rmSync(dest, { recursive: true, force: true });
      } else {
        const bak = backupPath(dest);
        renameSync(dest, bak);
        out(`• existing ${provider} skill ${name} preserved at ${bak}\n`);
      }
    }
    cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
    // marks the copy as the toolkit's, so the next run replaces it in place
    writeFileSync(`${dest}/SKILL.md`, mark, { flag: 'a' });
    out(`✔ ${provider} skill ${name} → ${dest}\n`);
  }
  retireSkills(pkg, skillDir, provider, false);
  // Codex reads skills from ~/.agents/skills; ~/.codex/skills is its old place.
  if (provider === 'codex' && nz(process.env.GSD_CODEX_SKILL_DIR) === undefined) {
    const olds = [`${HOME()}/.codex/skills`];
    if (nz(process.env.CODEX_HOME) !== undefined) olds.push(`${process.env.CODEX_HOME}/skills`);
    for (const old of olds) if (isDir(old) && old !== skillDir) retireSkills(pkg, old, 'codex', true);
  }
}

// ── the Claude user hooks ────────────────────────────────────────────────────

/** the python `user_hook()` of lib/install-copy.sh (the old copy installer), same bytes out */
export function userHook(provider: string, mode: 'on' | 'off', binDir: string): void {
  if (provider !== 'claude') return;
  const settings = providerUserHookFile(provider) as string;
  if (mode !== 'on' && !isFile(settings)) return;
  // Windows: Claude Code runs hooks in Git Bash — C:/… paths, the npm bin dir's extensionless sh shims
  binDir = shellPath(binDir);
  const guard = `${binDir}/gsdt-worktree-guard`;
  const rules = `${binDir}/gsdt-rules`;
  if (guard.includes("'")) {
    out(`• ${provider} user hook skipped: the bin path holds a quote\n`);
    return;
  }
  const cmd = `[ ! -x '${guard}' ] || exec '${guard}' --global`;
  const rulesCmd = `[ ! -x '${rules}' ] || exec '${rules}' --hook`;
  mkdirSync(path.dirname(settings), { recursive: true });

  let text: string | null = null;
  let data: JVal;
  try {
    // python's text mode: \r\n and \r read as \n
    text = readStrict(settings).replace(/\r\n?/g, '\n');
    data = text.replace(PY_SPACE, '') === '' ? new Map() : parseJson(text);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      text = null;
      data = new Map();
    } else if ((e as NodeJS.ErrnoException).code !== undefined) {
      throw e;
    } else {
      out(`⚠ ${settings} is not valid JSON; left unchanged (no ${provider} user hook)\n`);
      return;
    }
  }
  if (!(data instanceof Map) || (data.has('hooks') && !(data.get('hooks') instanceof Map))) {
    out(`⚠ ${settings} has an unexpected shape; left unchanged (no ${provider} user hook)\n`);
    return;
  }
  const hc = data.get('hooksConfig');
  const hcOff = hc instanceof Map && hc.get('enabled') === false;
  if (mode === 'on' && (data.get('disableAllHooks') === true || hcOff)) {
    out(`• hooks are turned off in ${settings}; ${provider} user hook not added\n`);
    return;
  }
  if (!data.has('hooks')) data.set('hooks', new Map());
  const hooks = data.get('hooks') as Map<string, JVal>;
  const wanted: Array<[string, string | null, string]> = [
    ['PreToolUse', 'Skill', cmd],
    ['UserPromptExpansion', 'gsd.*', cmd],
    ['SessionStart', null, rulesCmd],
  ];
  const ours = (h: JVal): boolean => {
    const c = h instanceof Map ? h.get('command') : undefined;
    const s = typeof c === 'string' ? c : '';
    // gsd-worktree-guard / gsd-rules: the names before 0.10.0, replaced too
    return (/gsdt?-worktree-guard/.test(s) && s.includes('--global')) || (/gsdt?-rules/.test(s) && s.includes('--hook'));
  };
  for (const event of wanted.map((w) => w[0]).filter((e) => hooks.has(e))) {
    const groups = hooks.get(event) as JVal;
    if (!Array.isArray(groups)) continue;
    const kept: JVal[] = [];
    for (const g of groups) {
      if (g instanceof Map && Array.isArray(g.get('hooks'))) {
        const list = g.get('hooks') as JVal[];
        const rest = list.filter((h) => !ours(h));
        if (rest.length === 0 && list.length > 0) continue;
        g.set('hooks', rest);
      }
      kept.push(g);
    }
    if (kept.length > 0) hooks.set(event, kept);
    else hooks.delete(event);
  }
  if (mode === 'on') {
    for (const [event] of wanted) {
      if (hooks.has(event) && !Array.isArray(hooks.get(event))) {
        out(`⚠ ${settings}: hooks.${event} is not a list; left unchanged (no ${provider} user hook)\n`);
        return;
      }
    }
    for (const [event, matcher, c] of wanted) {
      const e = new Map<string, JVal>();
      if (matcher !== null) e.set('matcher', matcher);
      e.set('hooks', [new Map<string, JVal>([['type', 'command'], ['command', c]])]);
      if (!hooks.has(event)) hooks.set(event, []);
      (hooks.get(event) as JVal[]).push(e);
    }
  }
  if (hooks.size === 0) data.delete('hooks');
  const next = `${dumpJson(data)}\n`;
  if (next !== text) {
    // write through a symlink (dotfile repos link settings.json) and keep the mode
    const real = realpathLoose(settings);
    const tmp = `${real}.gsd-tmp`;
    writeFileSync(tmp, next);
    try {
      chmodSync(tmp, statSync(real).mode & 0o7777);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    renameSync(tmp, real);
  }
  if (mode === 'on') {
    out(`✔ ${provider} user hook: /gsd-new-project only after gsdt-init → ${settings}\n`);
    out(`✔ ${provider} user hook: sessions in a set-up repo load gsdt-rules → ${settings}\n`);
  } else if (next !== text) {
    out(`✂ ${provider} user hook removed from ${settings}\n`);
  }
}

// ── the bin dir ──────────────────────────────────────────────────────────────

/** GSD_BIN_DIR, else the first PATH folder whose gsdt-worktree-guard belongs to this package */
export function findBinDir(pkg: string): string | null {
  const given = nz(process.env.GSD_BIN_DIR);
  if (given !== undefined) return realpathLoose(given);
  const realPkg = realpathLoose(pkg);
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (d === '') continue;
    const guard = path.join(d, 'gsdt-worktree-guard');
    let real: string;
    try {
      real = realpathSync(guard);
    } catch {
      continue;
    }
    if (isFile(real) && within(real, realPkg)) return path.resolve(d);
    // Windows: npm's shim is a script in the prefix, not a link into the package; the package sits next to it
    if (WIN && isFile(real) && isDir(path.join(d, 'node_modules', 'gsd-toolkit')) && realpathLoose(path.join(d, 'node_modules', 'gsd-toolkit')) === realPkg) {
      return path.resolve(d);
    }
  }
  return null;
}

// ── moving a 0.10.x release install off ~/.local/bin ─────────────────────────

/** dry = only look: true when there is a 0.10.x install here (nothing is removed) */
function cleanOldInstall(pkg: string, oldBin: string, dry = false): boolean {
  let found = false;
  if (!isDir(oldBin)) return false;
  const realPkg = realpathLoose(pkg);
  const targetOf = (link: string): string => {
    const t = readlinkSync(link);
    return t.startsWith('/') ? t : path.resolve(path.dirname(link), t);
  };
  const intoPkg = (t: string): boolean => within(t, pkg) || within(t, realPkg) || within(realpathLoose(t), realPkg);
  for (const name of readDir(oldBin)) {
    if (!/^(gsd-|gsdt-)/.test(name)) continue;
    const link = `${oldBin}/${name}`;
    if (!isLink(link)) continue;
    const t = targetOf(link);
    if (intoPkg(t) || !ownedLink(link, 'bin')) continue;
    found = true;
    if (dry) continue;
    unlinkSync(link);
    out(`✂ ${name} removed from ${oldBin} (the toolkit is on npm now)\n`);
  }
  const share = path.resolve(oldBin, '..', 'share', 'gsd-toolkit');
  if (isDir(share) && !isLink(share) && !within(realPkg, realpathLoose(share))) {
    const used = readDir(oldBin).some((n) => {
      const l = `${oldBin}/${n}`;
      return isLink(l) && within(targetOf(l), share);
    });
    if (!used) {
      found = true;
      if (!dry) rmSync(share, { recursive: true, force: true });
      if (!dry) out(`✂ old release runtime ${share} removed\n`);
    }
  }
  const man = `${oldBin}/.gsd-install-manifest`;
  if (present(man)) {
    found = true;
    if (!dry) {
      rmSync(man, { force: true });
      out(`✂ old install settings ${man} removed\n`);
    }
  }
  return found;
}

// ── main ─────────────────────────────────────────────────────────────────────

export function main(argv: string[]): number {
  const pkg = gsdPkg();
  let providers: string[] = [];
  const add = (p: string): void => {
    if (!providers.includes(p)) providers.push(p);
  };
  let hookMode = '';
  let core = true;
  const fail = (msg: string): number => {
    err(`${msg}\n`);
    return 1;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case '--agent': {
        const v = argv[i + 1];
        if (v === undefined) return fail('--agent needs a provider');
        i++;
        if (v === 'claude' || v === 'codex') add(v);
        else if (v === 'gemini') return fail('Gemini is no longer supported (gsd-core, the new GSD, dropped it); use --agent claude or codex');
        else return fail(`unknown provider: ${v}`);
        break;
      }
      case '--all-agents':
        providers = ['claude', 'codex'];
        break;
      case '--no-user-hook':
        hookMode = 'off';
        break;
      case '--no-core':
        core = false;
        break;
      case '-h':
      case '--help':
        out(HELP);
        return 0;
      default:
        return fail(`unknown option: ${a}`);
    }
  }

  // recorded settings: ours, else a 0.10.x release install's (agents only)
  const oldBin = nz(process.env.GSD_OLD_BIN_DIR) ?? `${HOME()}/.local/bin`;
  const manifestFile = setupManifestPath();
  let rec: Record<string, string> = {};
  let ownManifest = false;
  if (isFile(manifestFile)) {
    rec = readManifest(manifestFile);
    ownManifest = true;
  }
  if (ownManifest) {
    // recorded agents are kept; any --agent given now is added to them
    for (const p of (rec.providers ?? '').split(',')) if (p === 'claude' || p === 'codex') add(p);
    if (nz(process.env.GSD_CLAUDE_SKILL_DIR) === undefined && rec.claude_skills) process.env.GSD_CLAUDE_SKILL_DIR = rec.claude_skills;
    if (nz(process.env.GSD_CODEX_SKILL_DIR) === undefined && rec.codex_skills) {
      const olds = [realpathLoose(`${HOME()}/.codex/skills`), realpathLoose(`${nz(process.env.CODEX_HOME) ?? `${HOME()}/.codex`}/skills`)];
      if (!olds.includes(rec.codex_skills)) process.env.GSD_CODEX_SKILL_DIR = rec.codex_skills;
    }
    hookMode = hookMode || rec.user_hook || '';
  } else {
    const old = readManifest(`${oldBin}/.gsd-install-manifest`);
    for (const p of (old.providers ?? '').split(',')) if (p === 'claude' || p === 'codex') add(p);
  }
  if (providers.length === 0) providers = ['claude'];
  hookMode = hookMode || 'on';
  const mode: 'on' | 'off' = hookMode === 'off' ? 'off' : 'on';
  const list = providers.join(',');
  const bad = providerListValidate(list);
  if (bad !== null) return fail(bad.message);

  const skillDirs: Record<string, string> = {};
  for (const p of providers) {
    const root = providerSkillRoot(p);
    if (root === null || root === '') return fail('custom provider has no installable skill format');
    if (/[\t\n]/.test(root)) return fail('skill destination cannot contain tabs or newlines');
    const abs = realpathLoose(root);
    if (within(abs, realpathLoose(pkg)) || within(realpathLoose(pkg), abs)) {
      return fail('unsafe skill destination: skills and source directories must not overlap');
    }
    skillDirs[p] = root;
  }

  const bin = findBinDir(pkg);
  if (bin === null) {
    return fail(
      'gsdt-worktree-guard from this package is not on PATH — the user hooks run the commands from the folder npm links them into.\n' +
        'Install the package globally (npm i -g gsd-toolkit) so its bin folder is on PATH, put this checkout\'s bin/ on PATH, or set GSD_BIN_DIR.',
    );
  }

  for (const p of providers) installSkills(pkg, p, skillDirs[p] as string);
  for (const p of providers) userHook(p, mode, bin);
  // From a git checkout the 0.10.x install is another copy of the toolkit that may still be in use:
  // leave it, say so. (GSD_SETUP_MODE=npm|checkout is for tests.)
  if ((nz(process.env.GSD_SETUP_MODE) ?? installMode(pkg)) === 'checkout') {
    if (cleanOldInstall(pkg, oldBin, true)) {
      out(`• a 0.10.x install is in ${oldBin}; left in place because this is a checkout run — the npm install's gsdt-setup moves it\n`);
    }
  } else cleanOldInstall(pkg, oldBin);

  if (core && nz(process.env.GSD_NO_CORE) === undefined) for (const p of providers) coreSync(p, 'install');

  const lines = [`providers\t${list}`];
  if (mode !== 'on') lines.push(`user_hook\t${mode}`);
  for (const p of providers) lines.push(`${p}_skills\t${realpathLoose(skillDirs[p] as string)}`);
  lines.push(`bin\t${bin}`);
  mkdirSync(path.dirname(manifestFile), { recursive: true });
  const tmp = `${manifestFile}.tmp`;
  writeFileSync(tmp, `${lines.join('\n')}\n`);
  renameSync(tmp, manifestFile);

  if (!binOnPath(bin)) out(`⚠ ${bin} is not on your PATH — add it to your shell profile\n`);
  out('\nDone. Try:  gsdt-list --help\n');
  return 0;
}
