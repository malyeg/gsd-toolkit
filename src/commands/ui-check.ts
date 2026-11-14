// gsdt-ui check's runner: node src/launch.mjs ui-check <job file>
// (see src/ui-check.ts). Exit: 0 passed, 1 failed checks, 2 could not run.
import { runJob } from '../ui-check.ts';

export async function main(argv: string[]): Promise<number> {
  const jobFile = argv[0];
  if (!jobFile) {
    process.stderr.write('usage: ui-check <job file>\n');
    return 64;
  }
  return runJob(jobFile);
}
