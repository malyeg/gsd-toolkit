// src/bash-bridge.ts — call a function of lib/*.sh from TypeScript while its
// port is still pending.
// TODO(P9): lib/ticket.sh (gsd_tracker_which, gsd_ticket_extract) is ported in P9; flow-next
// then calls the TS functions directly and this file goes.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export type BridgeResult = { rc: number; stdout: string; stderr: string };

/** Run `fn args…` in bash with lib/common.sh and lib/ticket.sh sourced. */
export function bashLib(fn: string, args: string[], env: NodeJS.ProcessEnv = process.env): BridgeResult {
  const pkg = path.resolve(import.meta.dirname, '..');
  const r = spawnSync('bash', ['-c', `. "$GSD_PKG/lib/common.sh"; . "$GSD_PKG/lib/ticket.sh"; ${fn} "$@"`, '_', ...args], {
    env: { ...env, GSD_PKG: pkg },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { rc: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
