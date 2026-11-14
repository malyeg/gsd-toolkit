// gsdt-rules — print the GSD toolkit's rules for the INSTALLED release (port of
// bin/gsdt-rules). Launcher: bin/gsdt-rules → src/launch.mjs rules.
//
// `--hook` is the Claude SessionStart hook and must never break a session:
// stdin is read and dropped, nothing goes to stderr, and it always returns 0.
import { readSync } from 'node:fs';
import { chomp, findMain, flowMode, base, wtdir, confProviders, isDir, isFile } from '../common.ts';
import { repoValues, rulesText } from '../provider.ts';
import { uiGates } from '../ui.ts';
import { gsdVersion } from '../version.ts';

// What `gsdt-rules --help` prints: the comment block at the top of the bash
// script (lines 2.. up to `set -uo`, "# " stripped). Kept verbatim.
export const HELP = `
gsdt-rules — print the GSD toolkit's rules for the INSTALLED release.

A set-up repo's .gsd/INSTRUCTIONS.md holds only its values and a short
core; the rules themselves come from here, so a release changes them in
every repo through gsdt-update, with no step in each repo.

  Claude Code: a user-level SessionStart hook (lib/install.sh) runs
               \`gsdt-rules --hook\`, which loads the output into the session.
  Codex, custom: the AGENTS.md entry says to run \`gsdt-rules\` first.

Usage:
  gsdt-rules [--repo DIR]   the rules; in a repo with .gsd.conf also its
                           values, and the screens paragraph only when
                           ui_gates is not off. Outside one: all the rules.
  gsdt-rules --hook         for the Claude hook: reads (and ignores) the
                           hook's stdin, prints the rules with a header in
                           a repo with .gsd.conf, nothing elsewhere; always
                           exits 0.
  -h, --help               show this help
`;

/** `cat >/dev/null` on a pipe: read stdin to its end, ignoring every error. */
function drainStdin(): void {
  if (process.stdin.isTTY) return;
  const buf = Buffer.alloc(65536);
  for (let tries = 0; tries < 100000; ) {
    try {
      if (readSync(0, buf, 0, buf.length, null) === 0) return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') {
        tries++;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        continue;
      }
      return; // EOF-like errors (EBADF, closed pipe, …)
    }
  }
}

const out = (s: string): void => {
  process.stdout.write(s);
};
const err = (s: string): void => {
  process.stderr.write(s);
};

export type Rules = { text: string; exit: number; stderr: string };

/**
 * The output for a repo (or '' = no --repo): everything gsdt-rules prints
 * before the optional hook header, or why it prints nothing. `null` text =
 * "no set-up repo" for --hook.
 */
export function rulesFor(repo: string, hook: boolean): Rules {
  let m = findMain(repo || '.');
  if (m === '' || !isFile(`${m}/.gsd.conf`)) m = '';
  if (m === '') {
    if (hook) return { text: '', exit: 0, stderr: '' };
    if (repo !== '' && !isDir(repo)) return { text: '', exit: 2, stderr: `gsdt-rules: no such directory: ${repo}\n` };
    return { text: rulesText('on'), exit: 0, stderr: '' };
  }
  const ui = uiGates(m);
  const providers = confProviders(m);
  const text = chomp(
    rulesText(ui === 'off' ? 'off' : 'on') +
      repoValues(providers, providers.split(',')[0] as string, base(m), wtdir(m), ui, flowMode(m)),
  );
  return { text: `${hook ? `GSD toolkit rules (gsdt-rules, gsd-toolkit ${gsdVersion()}) — follow them in this repo; .gsd/INSTRUCTIONS.md has its settings.\n\n` : ''}${text}\n`, exit: 0, stderr: '' };
}

export function main(argv: string[]): number {
  let repo = '';
  let hook = false;
  for (let i = 0; i < argv.length; ) {
    const a = argv[i] as string;
    if (a === '--repo') {
      if (argv.length - i < 2) {
        err('gsdt-rules: --repo needs a directory\n');
        return 2;
      }
      repo = argv[i + 1] as string;
      i += 2;
    } else if (a === '--hook') {
      hook = true;
      i++;
    } else if (a === '-h' || a === '--help') {
      out(HELP);
      return 0;
    } else {
      err(`gsdt-rules: unknown argument: ${a} (see --help)\n`);
      return 2;
    }
  }
  if (!hook) {
    const r = rulesFor(repo, false);
    out(r.text);
    err(r.stderr);
    return r.exit;
  }
  // Never let the hook break a session: no stdin wait, no error output, exit 0.
  try {
    drainStdin();
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const r = rulesFor(repo || process.env.CLAUDE_PROJECT_DIR || process.cwd(), true);
    out(r.text);
  } catch {
    // nothing to say
  }
  return 0;
}
