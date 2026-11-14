// src/version.ts — the toolkit's version. Only gsdVersion() so far; the rest of
// lib/version.sh (update notice, latest-release cache) is ported with P11.
import { readFileSync } from 'node:fs';
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
