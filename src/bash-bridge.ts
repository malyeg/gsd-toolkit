// src/bash-bridge.ts — call a function of lib/*.sh from TypeScript while its
// port is still pending.
// TODO(P4): lib/ui.sh is ported in P4; the callers (src/guard.ts, flow-next.ts) then call the
// TS functions directly. TODO(P9): lib/ticket.sh (gsd_tracker_which, gsd_ticket_extract) likewise; this file goes after P9 (finishGates in common.ts has its
// own copy of the same call).
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export type BridgeResult = { rc: number; stdout: string; stderr: string };

/** Run `fn args…` in bash with lib/common.sh, lib/ui.sh and lib/ticket.sh sourced. */
export function bashLib(fn: string, args: string[], env: NodeJS.ProcessEnv = process.env): BridgeResult {
  const pkg = path.resolve(import.meta.dirname, '..');
  const r = spawnSync('bash', ['-c', `. "$GSD_PKG/lib/common.sh"; . "$GSD_PKG/lib/ui.sh"; . "$GSD_PKG/lib/ticket.sh"; ${fn} "$@"`, '_', ...args], {
    env: { ...env, GSD_PKG: pkg },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { rc: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
