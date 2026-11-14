// src/core.ts — install or update GSD itself (gsd-core) for one agent, with
// its own installer (npx). The twin of lib/core.sh. gsdt-setup installs it
// where it is missing; gsdt-update also brings it to the latest version.
// Always the full skill profile: the phase flow runs skills only it has
// (doctor T009).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { GSD_CORE_INSTALL, commandOnPath, isExec } from './common.ts';
import { out } from './stdio.ts';
import { versionGt } from './update-check.ts';

const nz = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);

/** gsd_core_dir — the agent's config dir (null for an agent without one) */
export function coreDir(provider: string): string | null {
  const home = process.env.HOME ?? '';
  if (provider === 'claude') return nz(process.env.CLAUDE_CONFIG_DIR) ?? `${home}/.claude`;
  if (provider === 'codex') return nz(process.env.CODEX_HOME) ?? `${home}/.codex`;
  return null;
}

/** gsd_core_version — the agent's gsd-core X.Y.Z ('' when none) */
export function coreVersion(provider: string): string {
  const d = coreDir(provider);
  if (d === null || !isExec(`${d}/gsd-core/bin/gsd_run`)) return '';
  try {
    const first = readFileSync(`${d}/gsd-core/VERSION`, 'utf8').split('\n')[0] ?? '';
    return /^[0-9]+\.[0-9]+\.[0-9]+/.exec(first)?.[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * gsd_core_sync — install: only where there is none. update: also where it is
 * older than `latest` ('' = unknown). Never fails: a failed or impossible run
 * prints the command to run.
 */
export function coreSync(provider: string, mode: 'install' | 'update', latest = ''): void {
  const d = coreDir(provider);
  if (d === null) return;
  // --config-dir only when the agent's dir is moved
  const moved = provider === 'claude' ? nz(process.env.CLAUDE_CONFIG_DIR) : nz(process.env.CODEX_HOME);
  const args = [`--${provider}`, '--global', '--profile=full', ...(moved !== undefined ? ['--config-dir', d] : [])];
  const cmd = `${GSD_CORE_INSTALL} ${args.join(' ')}`;
  const have = coreVersion(provider);
  let did = 'installed';
  let act = 'installing';
  if (have !== '') {
    did = 'updated';
    act = 'updating';
    if (mode === 'install') return out(`• ${provider} already has gsd-core ${have}\n`);
    if (latest === '') return out(`• ${provider} gsd-core ${have} — the latest is unknown (offline?); later: ${cmd}\n`);
    if (!versionGt(latest, have)) return out(`✔ ${provider} gsd-core ${have} is the latest\n`);
  }
  if (commandOnPath('npx') === null) return out(`⚠ gsd-core not ${did} for ${provider}: no npx (install Node.js), then run:  ${cmd}\n`);
  out(`▶ ${act} gsd-core for ${provider}${have !== '' ? ` (${have} → ${latest})` : ''}…\n`);
  const r = spawnSync('npx', ['-y', '--package=@opengsd/gsd-core@latest', '--', 'gsd-core', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  for (const line of text.split('\n').slice(0, text.endsWith('\n') ? -1 : undefined)) out(`  ${line}\n`);
  if (r.status === 0 && isExec(`${d}/gsd-core/bin/gsd_run`)) out(`✔ ${provider} gsd-core ${coreVersion(provider)} → ${d}\n`);
  else out(`⚠ gsd-core for ${provider} not ${did} (see above); run:  ${cmd}\n`);
}
