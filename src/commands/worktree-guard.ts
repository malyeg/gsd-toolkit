// gsdt-worktree-guard — shared validator called by gsdt-start and gsdt-flow-next,
// and by the optional native hooks (port of bin/gsdt-worktree-guard).
// Launcher: bin/gsdt-worktree-guard → src/launch.mjs worktree-guard. The rules
// are in src/guard.ts; the summary is in the header of the bin launcher.
//
// Block = exit 2 (stderr shown). Escape hatch: GSD_SKIP_GUARD=1.
import { readFileSync } from 'node:fs';
import { guardArgv } from '../guard.ts';

/** the hook payload on stdin; an unreadable stdin is an empty one */
function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function main(argv: string[]): number {
  const r = guardArgv(argv, { stdin: readStdin, env: process.env });
  if (r.stdout !== '') process.stdout.write(r.stdout);
  if (r.stderr !== '') process.stderr.write(r.stderr);
  return r.rc;
}
