// gsdt-repos — health overview of every GSD repo: the same as `gsdt-doctor --all`.
import { out } from '../stdio.ts';
import { main as doctorMain } from './doctor.ts';

const HELP = `gsdt-repos — one line per GSD repo: ok, or its doctor finding codes.

Usage:
  gsdt-repos [<folder>...] [--json]

Same as: gsdt-doctor --all [<folder>...] [--json]
Repos come from ~/.config/gsd/repos (gsdt-init, gsdt-bootstrap-repo, gsdt-start and
gsdt-finish add the repo they run in) plus each <folder> scanned for repos with a
.gsd.conf. Read-only. Exit 1 if any repo has findings.
`;

export function main(argv: string[]): number {
  if (argv.includes('-h') || argv.includes('--help')) {
    out(HELP);
    return 0;
  }
  return doctorMain(['--all', ...argv]);
}
