// gsdt-planning-merge — the git merge driver for .planning/ROADMAP.md and
// STATE.md (merge.gsd-planning.driver = gsdt-planning-merge %O %A %B %P).
// The npm entry; bin/gsdt-planning-merge is the bash twin (it also covers "no
// usable node"). Union first, the same result as git's built-in union driver,
// written to %A; then the structural reconcile. Whatever goes wrong after the
// union, the union stays and the exit is 0 (git reads nonzero as a conflict).
import { spawnSync } from 'node:child_process';
import { main as planning } from './planning.ts';

export function main(argv: string[]): number {
  const need = ['%O', '%A', '%B'];
  for (let i = 0; i < 3; i++) {
    if ((argv[i] ?? '') === '') {
      process.stderr.write(`gsdt-planning-merge: ${i + 1}: merge driver needs ${need[i]}\n`);
      return 1;
    }
  }
  const [O, A, B] = argv as [string, string, string];
  const P = argv[3] ?? '';
  spawnSync('git', ['merge-file', '-q', '--union', A, O, B], { stdio: 'inherit' });
  let rc: number;
  try {
    rc = Number(planning(['reconcile', A, ...(P !== '' ? ['--path', P] : [])]));
  } catch {
    rc = 1;
  }
  if (rc !== 0) {
    process.stderr.write(`⚠ gsdt-planning-merge: reconcile failed on ${P || A} — plain union result kept; run gsdt-planning-repair.\n`);
  }
  return 0;
}
