// Not a user command: the detached child that updateNotice (src/version.ts) starts
// to refresh a stale latest-version cache, so no command waits on the network.
//   launch.mjs update-refresh latest gsd
import { refreshCaches } from '../version.ts';

export function main(argv: string[]): number {
  try {
    refreshCaches(argv);
  } catch {
    // nobody is waiting for it
  }
  return 0;
}
