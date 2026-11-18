// local-files.ts — the gitignored files a new worktree needs from the main checkout (env files, the Claude
// permission allowlist, .mcp.json). Env files are copied by an ALLOW-list of names: a phase worktree runs an agent,
// so a production env never goes there. Used by gsdt-wt-new (copy) and gsdt-doctor (T035, what a worktree lacks).
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { confGet, git, isFile } from './common.ts';

/** the env names a worktree gets: `.env` and `.env.<part>[.<part>…]` whose parts are all in this list */
export const ENV_SAFE_PARTS = ['local', 'dev', 'develop', 'development', 'e2e', 'test'];
/** templates hold no secrets (and are usually committed anyway) */
const ENV_TEMPLATE_PARTS = ['example', 'sample', 'template', 'dist'];

/** `.env`-style file name: `.env` or `.env.<something>` */
export function isEnvName(rel: string): boolean {
  return /^\.env(\..+)?$/i.test(path.posix.basename(rel));
}

/** an env file safe for a worktree: `.env`, `.env.local`, `.env.test`, `.env.development.local`, … — never prod, staging, … */
export function envSafe(rel: string): boolean {
  const b = path.posix.basename(rel);
  if (!isEnvName(b)) return false;
  const parts = b.toLowerCase().split('.').slice(2);
  return parts.every((p) => ENV_SAFE_PARTS.includes(p) || ENV_TEMPLATE_PARTS.includes(p));
}

export type LocalFiles = { copy: string[]; skipped: string[] };

/**
 * The gitignored files of <main> that a worktree gets, and the env files left out on purpose.
 * `.gsd.conf` `copy_files`: `none` = no env files; otherwise a comma list of extra paths/globs (copied as named,
 * no name filter — the user chose them). Only ignored, untracked files: tracked ones are in every worktree already.
 */
export function localFiles(main: string): LocalFiles {
  const conf = confGet(main, 'copy_files').trim();
  const noEnv = conf.toLowerCase() === 'none';
  const extra = noEnv || conf === '' ? [] : conf.split(',').map((s) => s.trim()).filter((s) => s !== '');
  // `:(glob)` everywhere: `*` stays inside one folder and `**/` also matches the top level
  const ignored = (specs: string[]): string[] => {
    if (specs.length === 0) return [];
    // `--others --ignored` collapses an ignored folder to one 'dir/' entry (node_modules/): those are not files
    const ls = git(main, ['ls-files', '--others', '--ignored', '--exclude-standard', '--', ...specs.map((s) => `:(glob)${s}`)]);
    // with a pathspec git lists the files inside ignored folders one by one: a dependency's own env is not ours
    return (ls.status === 0 ? ls.stdout.split('\n') : []).filter((rel) => rel !== '' && !rel.endsWith('/') && !/(^|\/)node_modules\//.test(rel) && isFile(`${main}/${rel}`));
  };
  const chosen = ignored(extra);
  const copy: string[] = [];
  const skipped: string[] = [];
  for (const rel of [...ignored(['.mcp.json', '.claude/settings.local.json', ...(noEnv ? [] : ['**/.env', '**/.env.*'])]), ...chosen]) {
    if (copy.includes(rel) || skipped.includes(rel)) continue;
    if (isEnvName(rel) && !envSafe(rel) && !chosen.includes(rel)) skipped.push(rel);
    else copy.push(rel);
  }
  return { copy, skipped };
}

/** files of `want` that <wt> does not have */
export function missingIn(wt: string, want: string[]): string[] {
  return want.filter((rel) => !isFile(`${wt}/${rel}`));
}

/** Copy what <dest> lacks (never overwrites). Returns the lines to print. */
export function copyLocalFiles(main: string, dest: string): string[] {
  const { copy, skipped } = localFiles(main);
  const lines: string[] = [];
  for (const rel of missingIn(dest, copy)) {
    try {
      mkdirSync(`${dest}/${path.posix.dirname(rel)}`, { recursive: true });
      copyFileSync(`${main}/${rel}`, `${dest}/${rel}`);
      lines.push(`  copied ${rel}`);
    } catch {
      // a file that cannot be copied is skipped, as before
    }
  }
  if (skipped.length > 0) lines.push(`  not copied (not a local/dev/test env; add it to copy_files in .gsd.conf to copy it): ${skipped.join(', ')}`);
  return lines;
}
