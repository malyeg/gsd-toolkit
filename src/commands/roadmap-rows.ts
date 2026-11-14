// roadmap-rows FILE N — port of lib/roadmap-rows.pl (adds the checklist and
// Progress rows for a freshly claimed phase; idempotent).
import { roadmapRows } from '../roadmap.ts';

export function main(argv: string[]): number {
  const r = roadmapRows(argv[0] ?? '', argv[1]);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.rc;
}
