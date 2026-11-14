// roadmap-audit FILE — port of lib/roadmap-audit.pl (read-only ROADMAP audit).
// Prints TICK|/NOROW|/NOPROG| findings, one per line; always exits 0.
import { roadmapAuditBytes } from '../roadmap.ts';

export function main(argv: string[]): number {
  process.stdout.write(Buffer.from(roadmapAuditBytes(argv[0] ?? ''), 'latin1'));
  return 0;
}
