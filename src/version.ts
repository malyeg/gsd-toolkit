// src/version.ts — the toolkit's version, how this copy was installed, and
// what gsdt-setup recorded. (P11: the update check moves here from
// src/update-check.ts.)
import { existsSync, readFileSync } from 'node:fs';
import { gsdPkg } from './common.ts';

/** gsd_version — X.Y.Z of this package ('unknown' without a VERSION file) */
export function gsdVersion(): string {
  try {
    const first = readFileSync(`${gsdPkg()}/VERSION`, 'utf8').split('\n')[0] ?? '';
    return first.replace(/\s/g, '') || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * How this package got here:
 *   checkout — a git checkout (.git): updated with git, never by gsdt-update
 *   release  — a 0.10.x-style release runtime (has install.sh: GitHub tarball)
 *   npm      — the npm package (npm i -g gsd-toolkit; no install.sh shipped)
 */
export type InstallMode = 'checkout' | 'release' | 'npm';
export function installMode(pkg: string = gsdPkg()): InstallMode {
  if (existsSync(`${pkg}/.git`)) return 'checkout';
  if (existsSync(`${pkg}/install.sh`)) return 'release';
  return 'npm';
}

const nz = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);

/**
 * gsdt-setup's record of the machine setup: ${XDG_CONFIG_HOME:-~/.config}/gsd/setup-manifest.
 * Same tab-separated lines as the release install's ~/.local/bin/.gsd-install-manifest
 * (providers, user_hook, <provider>_skills) plus `bin` (the dir the user hooks run
 * the commands from).
 */
export function setupManifestPath(): string {
  return `${nz(process.env.XDG_CONFIG_HOME) ?? `${process.env.HOME ?? ''}/.config`}/gsd/setup-manifest`;
}

/** key → value of a manifest file ({} when missing/unreadable; the first line of a key wins) */
export function readManifest(file: string): Record<string, string> {
  const m: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return m;
  }
  for (const line of text.split('\n')) {
    const i = line.indexOf('\t');
    if (i <= 0) continue;
    const k = line.slice(0, i);
    if (!(k in m)) m[k] = line.slice(i + 1);
  }
  return m;
}
