// The fixture files for the checks of the rendered pages (ported from the old ui-fixture.sh): written as gsdt-ui would write them, no browser.
//   uiFixCheck(dir, P, status, capture, code)   <P>-UI-CHECK.md for / and /cart at 375px. An empty code = "not compared".
//   uiFixLook(dir, P, capture, verdict, rules)  <P>-UI-LOOK.md answering every rule for both pictures
//   uiFixApproval(dir, P, capture)
//   uiFixAll(dir, P)                            a passed check, a complete look, an approval
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const RULES = 'R1 R2 R3 R4 R5 R6 R7 R8 R9 R10';

export function uiFixCheck(dir: string, P: string, status = '', capture = '', code = ''): void {
  const st = status || 'passed';
  const t =
    `---\nstatus: ${st}\ncapture: ${capture || 'cap1'}\ntaken: 2026-01-01T00:00:00Z\ncode: ${code}\n` +
    `url: http://localhost:3005\nfailures: ${st === 'failed' ? 2 : 0}\nwaived: 0\nquestions: 1\nunchecked: 0\n---\n\n` +
    '## Failures\n\nNone.\n\n## Questions\n\n- Q1 | /cart | 375 | C2 | possible clipped text in 1 element(s): div.box "long"\n\n' +
    '## Shots\n\n- / | 375 | home-375-aaaaaa.png\n- /cart | 375 | cart-375-bbbbbb.png\n';
  writeFileSync(path.join(dir, `${P}-UI-CHECK.md`), t);
}

export function uiFixLook(dir: string, P: string, capture = '', verdict = '', rules = ''): void {
  const rs = (rules || RULES).split(/\s+/).filter((x) => x !== '');
  let t = `---\ncapture: ${capture || 'cap1'}\n---\n\n# look\n\n## / at 375px\n\n`;
  for (const r of rs) t += `- ${r}: ${verdict || 'ok'} — seen in the picture\n`;
  t += '\n## /cart at 375px\n\n';
  for (const r of rs) t += `- ${r}: ok — seen in the picture\n`;
  t += '- Q1: n/a — the box scrolls\n';
  writeFileSync(path.join(dir, `${P}-UI-LOOK.md`), t);
}

export function uiFixApproval(dir: string, P: string, capture = ''): void {
  writeFileSync(path.join(dir, `${P}-UI-APPROVAL.md`), `---\nstatus: approved\ncapture: ${capture || 'cap1'}\nby: t\napproved: 2026-01-01T00:00:00Z\n---\n`);
}

export function uiFixAll(dir: string, P: string): void {
  uiFixCheck(dir, P);
  uiFixLook(dir, P);
  uiFixApproval(dir, P);
}
