// gsdt-derive-port <base> — print <base> plus this worktree's phase number, so
// a per-app `dev` script can pick a per-worktree port automatically (via the
// per-repo shim scripts/gsdt-derive-port.sh):
//
//   "dev": "PORT=$(bash ../../scripts/gsdt-derive-port.sh 3000) next dev"
//
// GSD names worktrees `phase-<N>-<slug>` and N is unique across concurrent
// worktrees, so N is a collision-free offset (phase-8 -> base+8). Non-phase
// branches (a base branch, ad-hoc) and non-git contexts (a CI build tarball)
// resolve to N=0 -> the bare base, so nothing outside a worktree changes.
// Fractional/insert phases (phase-11.1) use the integer part; padded ones
// (phase-08.1) are read as decimal.
import { execFileSync } from 'node:child_process';

function currentBranch(): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function derivePort(base: number, branch: string): number {
  const m = /^phase-(\d+)/.exec(branch);
  return base + (m?.[1] ? parseInt(m[1], 10) : 0);
}

export function main(argv: string[]): number {
  const base = argv[0];
  if (!base) {
    process.stderr.write('gsdt-derive-port: usage: gsdt-derive-port <base-port>\n');
    return 1;
  }
  if (!/^[0-9]+$/.test(base)) {
    process.stderr.write(`gsdt-derive-port: base must be an integer: ${base}\n`);
    return 1;
  }
  process.stdout.write(`${derivePort(parseInt(base, 10), currentBranch())}\n`);
  return 0;
}
