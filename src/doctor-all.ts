// doctor-all.ts — `gsdt-doctor --all [<folder>...]`: one line per GSD repo. Read-only: runs
// `gsdt-doctor --json` in each repo (no update check) and never writes the registry.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readRepos, reposPath, scanFolder } from './repos.ts';
import { selfArgv, spawnSyncX } from './spawn.ts';
import { err, out } from './stdio.ts';

type Row = { repo: string; path: string; findings: string[]; warnings: string[]; error?: string };

function check(p: string): Row {
  const [cmd, args] = selfArgv('doctor', ['--repo', p, '--json']);
  const r = spawnSyncX(cmd, args, { encoding: 'utf8', env: { ...process.env, GSD_NO_UPDATE_CHECK: '1' }, maxBuffer: 64 * 1024 * 1024 });
  const name = path.basename(p);
  const line = (r.stdout ?? '').split('\n').filter((l) => l.startsWith('{')).pop();
  if (line !== undefined) {
    try {
      const j = JSON.parse(line) as { findings?: { code: string }[]; warnings?: { code: string }[] };
      return { repo: name, path: p, findings: (j.findings ?? []).map((f) => f.code), warnings: (j.warnings ?? []).map((f) => f.code) };
    } catch {
      /* fall through */
    }
  }
  const why = ((r.stderr ?? '').trim().split('\n')[0] ?? '').replace(/^✖ /, '');
  return { repo: name, path: p, findings: [], warnings: [], error: why === '' ? 'doctor produced no result' : why };
}

function codes(c: string[]): string {
  const n = new Map<string, number>();
  for (const x of c) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join(', ');
}

export function doctorAll(folders: string[], json: boolean): number {
  const paths: string[] = [];
  const add = (p: string): void => {
    if (!paths.includes(p)) paths.push(p);
  };
  const note = (s: string): void => {
    if (json) err(`${s}\n`);
    else out(`${s}\n`);
  };
  const reg = readRepos();
  if (reg.length === 0 && folders.length === 0) {
    out(`No repos known yet. Pass a folder to look in:  gsdt-doctor --all ~/projects\n(or list repo paths, one per line, in ${reposPath()};\ngsdt-init, gsdt-bootstrap-repo, gsdt-start and gsdt-finish add the repo they run in)\n`);
    return 0;
  }
  for (const p of reg) {
    if (existsSync(p)) add(p);
    else note(`  note: ${p} no longer exists — skipped`);
  }
  for (const f of folders) {
    if (!existsSync(f)) {
      note(`  note: ${f} does not exist — skipped`);
      continue;
    }
    for (const p of scanFolder(f)) add(p);
  }
  const rows = paths.map(check);
  const bad = rows.filter((r) => r.findings.length > 0 || r.error !== undefined).length;
  const warned = rows.filter((r) => r.findings.length === 0 && r.error === undefined && r.warnings.length > 0).length;
  if (json) {
    out(`${JSON.stringify(rows.map((r) => ({ repo: r.repo, path: r.path, findings: r.findings, warnings: r.warnings, ...(r.error !== undefined ? { error: r.error } : {}) })))}\n`);
    return bad === 0 ? 0 : 1;
  }
  const w = Math.max(0, ...rows.map((r) => r.repo.length));
  for (const r of rows) {
    const ok = r.findings.length === 0 && r.error === undefined;
    const mark = !ok ? '\x1b[31m✖\x1b[0m' : r.warnings.length > 0 ? '\x1b[33m⚠\x1b[0m' : '\x1b[32m✔\x1b[0m';
    const parts: string[] = [];
    if (r.findings.length > 0) parts.push(`${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}: ${codes(r.findings)}`);
    if (r.warnings.length > 0) parts.push(`${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}: ${codes(r.warnings)}`);
    const what = r.error !== undefined ? `doctor failed: ${r.error}` : parts.length === 0 ? 'ok' : parts.join(', ');
    out(`${mark} ${r.repo.padEnd(w)}  ${what}  \x1b[2m${r.path}\x1b[0m\n`);
  }
  out(`\n${rows.length} repo${rows.length === 1 ? '' : 's'}, ${bad} with findings${warned > 0 ? `, ${warned} with warnings only` : ''} — run gsdt-doctor in a repo for details\n`);
  if (folders.length > 0) out('(repos are added to the list automatically by gsdt-start / gsdt-init; --all never writes it)\n');
  return bad === 0 ? 0 : 1;
}
