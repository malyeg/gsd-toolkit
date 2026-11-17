// repos.ts — the list of GSD repos on this machine, for `gsdt-doctor --all`.
// Registry: ${XDG_CONFIG_HOME:-~/.config}/gsd/repos, one absolute path (a main checkout) per line;
// `#` lines and blanks are ignored. Written only by gsdt-init, gsdt-bootstrap-repo, gsdt-start and
// gsdt-finish (addRepo, best-effort); doctor only reads it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { findMain } from './common.ts';
import { normalizePath } from './spawn.ts';

const nz = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);

export function reposPath(): string {
  return `${nz(process.env.XDG_CONFIG_HOME) ?? `${process.env.HOME ?? process.env.USERPROFILE ?? ''}/.config`}/gsd/repos`;
}

/** The registered paths, normalized, deduped, in file order ([] when missing/unreadable). */
export function readRepos(): string[] {
  let text: string;
  try {
    text = readFileSync(reposPath(), 'utf8');
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const res: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (l === '' || l.startsWith('#')) continue;
    const n = normalizePath(l);
    if (seen.has(n)) continue;
    seen.add(n);
    res.push(n);
  }
  return res;
}

/** Add the main checkout of the repo at `p` to the registry. Best-effort: never throws, prints nothing. */
export function addRepo(p: string): void {
  try {
    const main = findMain(p);
    if (main === '') return;
    const n = normalizePath(main);
    if (readRepos().includes(n)) return;
    const file = reposPath();
    mkdirSync(path.dirname(file), { recursive: true });
    let prefix = '';
    try {
      const t = readFileSync(file, 'utf8');
      if (t !== '' && !t.endsWith('\n')) prefix = '\n';
    } catch {
      /* no file yet */
    }
    appendFileSync(file, `${prefix}${n}\n`);
  } catch {
    /* a registry that cannot be written never fails the command */
  }
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Main checkouts holding `.gsd.conf` under `root` (depth <= 5; no node_modules, .git, *-worktrees; a phase worktree has a .git FILE). */
export function scanFolder(root: string, maxDepth = 5): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (isDir(path.join(dir, '.git'))) {
      if (existsSync(path.join(dir, '.gsd.conf'))) found.push(normalizePath(dir));
      return; // a repo: its subfolders are its own business
    }
    if (depth >= maxDepth) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (n === 'node_modules' || n === '.git' || n.endsWith('-worktrees')) continue;
      const sub = path.join(dir, n);
      if (isDir(sub)) walk(sub, depth + 1);
    }
  };
  walk(path.resolve(root), 0);
  return found;
}
