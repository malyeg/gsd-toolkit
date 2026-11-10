// src/ui.ts — the UI quality gates (lib/ui.sh). P1 holds only uiGates(), which
// gsdt-rules needs; P4 ports the rest of ui.sh into this file.
import { confGet, findMain } from './common.ts';

/** gsd_ui_gates — any checkout → warn | strict | off */
export function uiGates(checkout: string): 'warn' | 'strict' | 'off' {
  let v = confGet(findMain(checkout), 'ui_gates');
  if (v === '') v = confGet(checkout, 'ui_gates');
  return v === 'strict' || v === 'off' ? v : 'warn';
}
