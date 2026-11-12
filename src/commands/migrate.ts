// gsdt-migrate — move a repo to the gsdt-* command names (gsd-toolkit 0.10.0).
// Port of the bash bin/gsdt-migrate (kept as the parity oracle in
// tests/fixtures/p8-old-bins/). No python, no perl: the settings JSON is edited
// with src/pyjson.ts (python's json bytes), the text rewrites are regexes over
// latin1 text (perl's byte semantics).
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  acquireLock,
  base,
  chomp,
  confProviders,
  findMain,
  git,
  GSD_OLD_PREMERGE,
  GSD_OLD_SHIMS,
  gsdPkg,
  isFile,
  planningHook,
  wtdir,
} from '../common.ts';
import {
  canonicalBlock,
  ownedBlockGet,
  ownedMarkersValid,
  providerEntryBlock,
  providerInstructionFile,
  providerInstructionMembers,
  providerUserHookFile,
  replaceOwnedBlock,
} from '../provider.ts';
import { PyJsonError, pyDumps, pyLoads, type PyJson } from '../pyjson.ts';
import { err, out } from '../stdio.ts';

export const HELP = `
gsdt-migrate — move a repo to the gsdt-* command names (gsd-toolkit 0.10.0).

Before 0.10.0 the toolkit's commands were gsd-*, the same start as every
gsd-core skill. They are gsdt-* now, with no old-name aliases, so a repo set
up before keeps files and settings that name the old commands. This moves
them. Run it in the repo (any checkout; it works on the main one).

Usage:
  gsdt-migrate             dry run: list every change, change nothing
                           (exit 1 when there is anything to do)
  gsdt-migrate --apply     make the changes (never commits, pushes or
                           checks out)
  gsdt-migrate --check     quiet; exit 1 when the repo or this clone still
                           uses an old name (not step 7: install replaces
                           those hooks, and doctor's T008 sees a stale one)
  --repo DIR               the repo (default: the current directory)
  -h, --help               show this help

What it changes (each only when it is there):
  1. the five shims: scripts/gsd-*.sh → scripts/gsdt-*.sh (a shim you
     edited is reported and left alone)
  2. your pre-merge script: scripts/gsd-premerge-check.sh → gsdt-…
  3. those paths where other tracked files name them (package.json, CI,
     Makefile, .husky/…): exact paths only; never .planning/ or *.md
  4. the repo hook in .claude/settings.json
  5. the toolkit's marked blocks in .gsd/INSTRUCTIONS.md, CLAUDE.md,
     AGENTS.md (text outside the markers is never touched)
  6. this clone's git config: the merge driver's command, the
     gsd-tracker section (→ gsdt-tracker), the post-merge hook
  7. your Claude user settings: the toolkit's --global guard and
     gsdt-rules hooks (only when an old one is there)
What it only reports: open phase worktrees, old names in free text
(.planning/, docs), files you edited by hand.

Steps 6–7 are per clone: each teammate runs gsdt-migrate --apply in their
own clone after the commit with steps 1–5 reaches them.
`;

// The old command names, for the text checks. A name counts when it stands
// alone, or as a scripts/ path; a slash command (/gsd-update is also a
// gsd-core skill) does not. Perl read bytes: \w is ASCII here.
const OLD_NAMES =
  'init|start|list|finish|doctor|update|bootstrap-repo|planning-repair|tracker|ui|codex-wait|batch|batch-report|wt-new|wt-finish|worktree-guard|flow-next|planning-merge|derive-port|rules|new-worktree-feature|finish-worktree-feature|premerge-check';
const OLD_RE = new RegExp(`(?:(?<![A-Za-z0-9_./-])|(?<=scripts/)|(?<=hooks/))gsd-(?:${OLD_NAMES})(?![A-Za-z0-9_-])`);
const PATH_RE_SRC = '(?<![A-Za-z0-9_-])scripts/(?:gsd-(?:new-worktree-feature|finish-worktree-feature|derive-port|planning-repair|premerge-check)\\.sh|hooks/gsd-worktree-guard\\.sh)';

const newName = (p: string): string => p.replace(/(^|\/)gsd-/, '$1gsdt-');
const latin1 = (f: string): string => readFileSync(f, 'latin1');
const modeOf = (f: string): number => statSync(f).mode & 0o7777;

// ── settings JSON (steps 4 and 7) ───────────────────────────────────────────

class PyCrash extends Error {}
const pyW = '[\\p{L}\\p{N}_]'; // python's \w on str

/**
 * The python settings_fix: rename our hooks in place; a hook that then twins
 * one already there is dropped. Returns true when the file changes (and, with
 * apply, it has been rewritten). Anything unreadable or not shaped like
 * settings: false.
 */
export function settingsFix(kind: 'repo' | 'user', file: string, apply: boolean): boolean {
  try {
    return settingsFixInner(kind, file, apply);
  } catch (e) {
    if (e instanceof PyJsonError || e instanceof PyCrash) return false; // python: ValueError → exit 0; traceback → rc 1 (never 3)
    if ((e as NodeJS.ErrnoException).code !== undefined) return false;
    throw e;
  }
}

function settingsFixInner(kind: 'repo' | 'user', file: string, apply: boolean): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
  } catch {
    return false;
  }
  const data = pyLoads(text.replace(/\r\n?/g, '\n'));
  if (!(data instanceof Map)) return false;
  const hooks = data.get('hooks');
  if (!(hooks instanceof Map)) return false;
  const repoRx = /scripts\/hooks\/gsd-worktree-guard\.sh/g;
  const userRx = new RegExp(`(?<!${pyW}|-)gsd-(worktree-guard|rules)(?!${pyW}|-)`, 'gu');
  const sub = (c: string): string => {
    if (kind === 'repo') return c.replace(repoRx, 'scripts/hooks/gsdt-worktree-guard.sh');
    const ours = (c.includes('worktree-guard') && c.includes('--global')) || (c.includes('rules') && c.includes('--hook'));
    return ours ? c.replace(userRx, 'gsdt-$1') : c;
  };
  let changed = false;
  for (const [event, groups] of hooks) {
    if (!Array.isArray(groups)) continue;
    const seen = new Set<string>();
    for (const g of groups) {
      if (!(g instanceof Map) || !Array.isArray(g.get('hooks'))) continue;
      const kept: PyJson[] = [];
      for (const h of g.get('hooks') as PyJson[]) {
        if (h instanceof Map && typeof h.get('command') === 'string') {
          const c = sub(h.get('command') as string);
          if (c !== h.get('command')) {
            h.set('command', c);
            changed = true;
          }
          const matcher = g.get('matcher') ?? null;
          if (Array.isArray(matcher) || matcher instanceof Map) throw new PyCrash(); // python: unhashable key
          // python equality: 1 == 1.0 == True; NaN equals nothing (not even itself)
          const mk =
            matcher === null ? 'null' : typeof matcher === 'string' ? `s:${matcher}` : typeof matcher === 'boolean' ? `n:${matcher ? 1 : 0}` : `n:${Number((matcher as { text: string }).text)}`;
          const key = JSON.stringify([mk === 'n:NaN' ? `nan:${seen.size}:${Math.random()}` : mk, c]);
          if (seen.has(key) && c.includes('gsdt-')) {
            changed = true;
            continue;
          }
          seen.add(key);
        }
        kept.push(h);
      }
      g.set('hooks', kept);
    }
    hooks.set(
      event,
      groups.filter((g) => !(g instanceof Map && Array.isArray(g.get('hooks')) && (g.get('hooks') as PyJson[]).length === 0)),
    );
  }
  if (!changed) return false;
  if (!apply) return true;
  const real = realpathSync(file);
  const tmp = `${real}.gsd-tmp`;
  writeFileSync(tmp, `${pyDumps(data)}\n`, 'utf8');
  try {
    chmodSync(tmp, modeOf(real));
  } catch {
    // python ignored it too
  }
  renameSync(tmp, real);
  return true;
}

// ── main ────────────────────────────────────────────────────────────────────

function logicalPwd(): string {
  const cwd = process.cwd();
  const p = process.env.PWD;
  try {
    if (p && realpathSync(p) === realpathSync(cwd)) return p;
  } catch {
    // fall through
  }
  return cwd;
}

export function main(argv: string[]): number {
  let mode: 'dry' | 'apply' | 'check' = 'dry';
  let repo = '';
  const die = (msg: string): number => {
    err(`✖ ${msg}\n`);
    return 2;
  };
  for (let i = 0; i < argv.length; ) {
    const a = argv[i] as string;
    if (a === '--apply') {
      mode = 'apply';
      i++;
    } else if (a === '--check') {
      mode = 'check';
      i++;
    } else if (a === '--repo') {
      if (argv.length - i < 2) return die('--repo needs a directory');
      repo = argv[i + 1] as string;
      i += 2;
    } else if (a === '-h' || a === '--help') {
      out(HELP);
      return 0;
    } else {
      return die(`unknown argument: ${a} (see gsdt-migrate --help)`);
    }
  }

  const pkg = gsdPkg();
  const arg = repo || '.';
  if (git(arg, ['rev-parse', '--show-toplevel']).status !== 0) return die(`not a git repo: ${repo || logicalPwd()}`);
  const MAIN = findMain(arg);
  if (MAIN === '') return die(`could not find the main checkout of ${repo || logicalPwd()}`);

  if (mode === 'apply' && !acquireLock(MAIN)) return 1;

  let CHANGES = 0;
  let PROBLEMS = 0;
  let NOTES = '';
  const say = (s: string): void => {
    if (mode !== 'check') out(`${s}\n`);
  };
  const change = (s: string): void => {
    CHANGES++;
    say(`  ${s}`);
  };
  const problem = (s: string): void => {
    PROBLEMS++;
    say(`  ✖ ${s}`);
  };
  const note = (s: string): void => {
    NOTES += `  • ${s}\n`;
  };
  const doing = mode === 'apply';

  if (mode !== 'check') out(`gsdt-migrate${mode === 'apply' ? '' : ' (dry run)'} — ${MAIN}\n`);

  // ── 1. shims ──
  say('shims:');
  const oldShims = GSD_OLD_SHIMS.split(' ');
  for (const old of oldShims) {
    if (!isFile(`${MAIN}/${old}`)) continue;
    const nw = newName(old);
    const line2 = latin1(`${MAIN}/${old}`).split('\n')[1] ?? '';
    if (!/^# gsd-(worktrees|toolkit) shim/.test(line2)) {
      problem(`${old}: not the toolkit's shim (edited by hand?) — left alone; rename it to ${nw} and point it at gsdt-* yourself`);
      continue;
    }
    change(`${old} → ${nw}`);
    if (doing) {
      try {
        mkdirSync(path.dirname(`${MAIN}/${nw}`), { recursive: true });
        const dest = `${MAIN}/${nw}`;
        const existed = existsSync(dest);
        const um = process.umask();
        copyFileSync(`${pkg}/shims/${nw}`, dest);
        const cur = existed ? modeOf(dest) : modeOf(`${pkg}/shims/${nw}`) & ~um;
        chmodSync(dest, cur | (0o111 & ~um));
        rmSync(`${MAIN}/${old}`, { force: true });
      } catch {
        // `cp && chmod && rm`: a failure stops the chain
      }
    }
  }

  // ── 2. the pre-merge script ──
  const pmNew = newName(GSD_OLD_PREMERGE);
  if (isFile(`${MAIN}/${GSD_OLD_PREMERGE}`)) {
    if (existsSync(`${MAIN}/${pmNew}`)) {
      problem(`both ${GSD_OLD_PREMERGE} and ${pmNew} exist — keep one (gsdt-finish runs ${pmNew})`);
    } else {
      change(`${GSD_OLD_PREMERGE} → ${pmNew} (your pre-merge script, renamed as it is)`);
      if (doing) {
        try {
          renameSync(`${MAIN}/${GSD_OLD_PREMERGE}`, `${MAIN}/${pmNew}`);
        } catch {
          // mv failed: ignored, as before
        }
      }
    }
  }

  // ── 3. references to those paths in other tracked files ──
  say('references:');
  const grep = git(MAIN, ['grep', '-lIE', 'scripts/(hooks/)?gsd-[a-z-]+\\.sh']);
  for (let f of grep.status === 0 || grep.stdout !== '' ? grep.stdout.split('\n') : []) {
    if (f === '') continue;
    if (!isFile(`${MAIN}/${f}`) && f === GSD_OLD_PREMERGE) f = pmNew;
    if (!isFile(`${MAIN}/${f}`)) continue;
    if (f.startsWith('.planning/') || /\.(md|markdown|txt)$/.test(f) || f === '.claude/settings.json') continue;
    if (oldShims.includes(f)) continue;
    const text = latin1(`${MAIN}/${f}`);
    const pathRe = new RegExp(PATH_RE_SRC);
    const ls = text.split('\n');
    if (ls[ls.length - 1] === '') ls.pop();
    const hits: string[] = [];
    ls.forEach((l, n) => {
      if (pathRe.test(l)) hits.push(`${n + 1}: ${l}`);
    });
    if (hits.length === 0) continue;
    for (const h of hits) change(`${f}:${Buffer.from(h, 'latin1').toString('utf8')}`);
    if (doing) {
      const re = new RegExp(PATH_RE_SRC, 'g');
      writeFileSync(`${MAIN}/${f}`, text.replace(re, (m) => m.replace(/(^|\/)gsd-/, '$1gsdt-')), 'latin1');
    }
  }

  // ── 4. the repo hook ──
  say('repo hook:');
  const settingsStep = (kind: 'repo' | 'user', file: string, label: string): void => {
    if (!isFile(file)) return;
    if (!settingsFix(kind, file, false)) return;
    change(label);
    if (doing) settingsFix(kind, file, true);
  };
  settingsStep('repo', `${MAIN}/.claude/settings.json`, '.claude/settings.json: hook scripts/hooks/gsd-worktree-guard.sh → gsdt-worktree-guard.sh');

  // ── 5. the marked blocks ──
  say('instruction blocks:');
  let providers = confProviders(MAIN).replace(/\s/g, '').replace(/,gemini,/g, ',').replace(/^gemini,/, '').replace(/,gemini$/, '').replace(/^gemini$/, '');
  if (providers === '') providers = 'claude';
  const blockStep = (rel: string, kind: string, members: string): void => {
    const f = `${MAIN}/${rel}`;
    if (!OLD_RE.test(ownedBlockGet(f, kind))) return;
    if (!ownedMarkersValid(f, kind)) {
      problem(`${rel}: its gsd-toolkit:${kind} markers are broken — repair the start/end pair, then run gsdt-migrate again`);
      return;
    }
    change(`${rel}: the gsd-toolkit:${kind} block, rewritten with the gsdt-* names`);
    if (!doing) return;
    const dir = mkdtempSync(path.join(tmpdir(), 'gsd-migrate.'));
    try {
      const tmp = `${dir}/block`;
      const text =
        kind === 'canonical'
          ? canonicalBlock(providers, providers.split(',')[0] as string, base(MAIN), wtdir(MAIN))
          : providerEntryBlock(members);
      writeFileSync(tmp, text, 'utf8');
      replaceOwnedBlock(f, kind, tmp);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  blockStep('.gsd/INSTRUCTIONS.md', 'canonical', '');
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    let members = providerInstructionMembers(`${MAIN}/${f}`)[0] ?? '';
    if (members === '') {
      const ps = providers.split(',');
      if (ps[ps.length - 1] === '') ps.pop();
      for (const p of ps) if (providerInstructionFile(p) === f) members = members !== '' ? `${members},${p}` : p;
    }
    blockStep(f, 'provider', members || 'claude');
  }

  // ── 6. this clone's git config + post-merge hook ──
  say('this clone (.git/config):');
  if (chomp(git(MAIN, ['config', '--get', 'merge.gsd-planning.driver']).stdout) === 'gsd-planning-merge %O %A %B %P') {
    change('merge.gsd-planning.driver: gsd-planning-merge → gsdt-planning-merge (the driver key stays gsd-planning)');
    if (doing) git(MAIN, ['config', 'merge.gsd-planning.driver', 'gsdt-planning-merge %O %A %B %P']);
  }
  const oldKeys = chomp(git(MAIN, ['config', '--local', '--get-regexp', '^gsd-tracker\\.']).stdout);
  if (oldKeys !== '') {
    change(`git config section gsd-tracker → gsdt-tracker (${oldKeys.split('\n').length} key(s))`);
    if (doing) {
      for (const kv of oldKeys.split('\n')) {
        const sp = kv.indexOf(' ');
        const k = sp < 0 ? kv : kv.slice(0, sp);
        const v = sp < 0 ? '' : kv.slice(sp + 1);
        const nk = `gsdt-tracker.${k.slice('gsd-tracker.'.length)}`;
        if (git(MAIN, ['config', '--local', '--get', nk]).status !== 0) git(MAIN, ['config', '--local', nk, v]);
      }
      git(MAIN, ['config', '--local', '--remove-section', 'gsd-tracker']);
    }
  }
  const hook = planningHook(MAIN);
  if (isFile(hook.path) && latin1(hook.path).includes('gsd-planning-repair')) {
    change(`${hook.label}: gsd-planning-repair → gsdt-planning-repair`);
    if (doing) {
      writeFileSync(
        hook.path,
        latin1(hook.path).replace(/(?<![A-Za-z0-9_-])gsd-(planning-repair|bootstrap-repo)(?![A-Za-z0-9_-])/g, 'gsdt-$1'),
        'latin1',
      );
    }
  }

  // ── 7. the user's Claude settings ──
  say('your Claude settings:');
  const userSettings = providerUserHookFile('claude') ?? '';
  if (mode !== 'check' && userSettings !== '') {
    settingsStep('user', userSettings, `${userSettings}: the toolkit's hooks gsd-worktree-guard / gsd-rules → gsdt-*`);
  }

  // ── only reported ──
  let wt = '';
  for (const line of git(MAIN, ['worktree', 'list', '--porcelain']).stdout.split('\n')) {
    if (line.startsWith('worktree ')) wt = line.slice(9);
    else if (line.startsWith('branch refs/heads/')) {
      const br = line.slice('branch refs/heads/'.length);
      if (wt === MAIN) continue;
      if (!/^(phase|batch)-/.test(br)) continue;
      if (oldShims.some((o) => isFile(`${wt}/${o}`))) {
        note(`open worktree ${br} still has the old files: commit this migration on the base branch, then merge it into ${br} (or finish ${br} first)`);
      }
    }
  }

  const free: string[] = [];
  const ls = git(MAIN, ['ls-files', '--', '.planning', '*.md', '*.markdown', '*.txt']);
  for (const f of ls.status === 0 ? ls.stdout.split('\n') : []) {
    if (f === '' || !isFile(`${MAIN}/${f}`)) continue;
    let inBlock = false;
    const lines = latin1(`${MAIN}/${f}`).split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    lines.forEach((l, n) => {
      if (/^<!-- gsd-(?:toolkit|worktrees):\w+:start -->$/.test(l)) inBlock = true;
      if (!inBlock && OLD_RE.test(l)) free.push(`${f}:${n + 1}`);
      if (/^<!-- gsd-(?:toolkit|worktrees):\w+:end -->$/.test(l)) inBlock = false;
    });
  }
  if (free.length > 0) {
    note(
      `${free.length} line(s) of free text still name old gsd-* commands (not changed; fix them if you like): ${free
        .slice(0, 8)
        .map((x) => `${x} `)
        .join('')}${free.length <= 8 ? '' : '…'}`,
    );
  }

  // ── result ──
  if (mode === 'check') return CHANGES === 0 && PROBLEMS === 0 ? 0 : 1;
  if (NOTES !== '') out(`\nnotes:\n${NOTES}`);
  out('\n');
  const none = CHANGES === 0 && PROBLEMS === 0;
  if (mode === 'dry') {
    if (none) {
      out('✔ nothing to migrate: this repo uses the gsdt-* names\n');
      return 0;
    }
    if (CHANGES !== 0) out(`${CHANGES} change(s). Nothing changed yet — run: gsdt-migrate --apply\n`);
    if (PROBLEMS !== 0) out(`${PROBLEMS} item(s) need a hand fix (✖ above).\n`);
    return 1;
  }
  if (none) {
    out('✔ nothing to migrate: this repo uses the gsdt-* names\n');
    return 0;
  }
  if (CHANGES !== 0) {
    out(`✔ migrated to gsdt-* (${CHANGES} change(s), not committed)\n`);
    out(`next:  git -C '${MAIN}' add -A && git -C '${MAIN}' commit -m 'Switch to gsdt-* toolkit commands'\n`);
    out('       then each teammate: gsdt-update, then gsdt-migrate --apply in their clone\n');
  }
  if (PROBLEMS !== 0) {
    out(`${PROBLEMS} item(s) still need a hand fix (✖ above); then run gsdt-migrate again.\n`);
    return 1;
  }
  return 0;
}
