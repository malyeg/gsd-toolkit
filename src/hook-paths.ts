// src/hook-paths.ts — port of lib/gsd_hook_paths.py: find GSD hooks that point
// at files that are gone. (The python file stays as the parity oracle and for
// the bash `gsd_stale_hooks` that unported commands still use.)
//
// An agent runs a hook whose program is missing as a failed command, and most
// events show nothing. Only GSD hooks count: a command is checked when one of
// its words names a gsd-* / gsdt-* program or script. Only absolute paths are
// checked; a word holding any other $VARIABLE is skipped. Reads files only.
//
// Output: one line per missing file, tab-separated:
//   <settings file> <scope> <owner> <hook number> <event> <missing path>
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

// python `re.match(r"^gsdt?-[A-Za-z0-9_.-]+$")`: `$` also matches before a final newline
const GSD_WORD = /^gsdt?-[A-Za-z0-9_.-]+\n?$/;

type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** (event, command) for every hook and the status line. */
export function hookCommands(data: Record<string, Json>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const hooks = data.hooks;
  if (isObj(hooks)) {
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!isObj(group)) continue;
        const inner = group.hooks;
        // Claude and Codex nest {matcher, hooks: [...]}; tolerate a flat entry too.
        for (const h of Array.isArray(inner) ? inner : [group]) {
          if (isObj(h) && typeof h.command === 'string') out.push([event, h.command]);
        }
      }
    }
  }
  const status = data.statusLine;
  if (isObj(status) && typeof status.command === 'string') out.push(['statusLine', status.command]);
  return out;
}

/** python `os.path.expanduser("~")` */
function pyHome(): string {
  const h = process.env.HOME;
  if (h === undefined) {
    try {
      return homedir();
    } catch {
      return '~';
    }
  }
  return h.replace(/\/+$/, '') || '/';
}

/** python's json also accepts the bare tokens NaN, Infinity and -Infinity; JSON.parse does not. */
function parseJson(text: string): Json {
  try {
    return JSON.parse(text);
  } catch (e) {
    const fixed = text.replace(/"(?:[^"\\]|\\[\s\S])*"|-?Infinity|NaN/g, (m) => (m.startsWith('"') ? m : '0'));
    if (fixed === text) throw e;
    return JSON.parse(fixed);
  }
}

const replaceAll = (s: string, from: string, to: string): string => s.split(from).join(to);

function expand(word0: string, project: string | null): string | null {
  const home = pyHome();
  let word = word0;
  if (word === '~' || word.startsWith('~/')) word = home + word.slice(1);
  word = replaceAll(replaceAll(word, '${HOME}', home), '$HOME', home);
  if (project) word = replaceAll(replaceAll(word, '${CLAUDE_PROJECT_DIR}', project), '$CLAUDE_PROJECT_DIR', project);
  return word.includes('$') ? null : word;
}

/**
 * python `shlex.split(s)` (POSIX mode, no comments); null where python raises
 * ValueError (an open quote, a trailing backslash).
 */
export function shlexSplit(s: string): string[] | null {
  const WS = ' \t\r\n';
  const chars = Array.from(s);
  const words: string[] = [];
  let token = '';
  let state: string | null = ' '; // ' ' between words, 'a' in a word, a quote char, or '\\' after a backslash
  let escaped = 'a';
  for (let i = 0; ; i++) {
    const c = i < chars.length ? (chars[i] as string) : '';
    if (state === ' ') {
      if (c === '') break;
      if (WS.includes(c)) continue;
      if (c === '\\') {
        escaped = 'a';
        state = '\\';
      } else if (c === "'" || c === '"') {
        state = c;
      } else {
        token = c;
        state = 'a';
      }
    } else if (state === "'" || state === '"') {
      if (c === '') return null;
      if (c === state) state = 'a';
      else if (c === '\\' && state === '"') {
        escaped = state;
        state = c;
      } else token += c;
    } else if (state === '\\') {
      if (c === '') return null;
      if ((escaped === "'" || escaped === '"') && c !== '\\' && c !== escaped) token += '\\';
      token += c;
      state = escaped;
    } else {
      // state 'a'
      if (c === '' || WS.includes(c)) {
        words.push(token);
        token = '';
        state = ' ';
        if (c === '') break;
      } else if (c === "'" || c === '"') state = c;
      else if (c === '\\') {
        escaped = 'a';
        state = '\\';
      } else token += c;
    }
  }
  return words;
}

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

function missing(command: string, project: string | null): { owner: string | null; gone: string[] } {
  let words = shlexSplit(command);
  if (words === null) return { owner: null, gone: [] };
  const names = words.map(baseName);
  if (!names.some((n) => GSD_WORD.test(n))) return { owner: null, gone: [] };
  const owner = names.some((n) => n === 'gsdt-worktree-guard' || n === 'gsdt-rules' || n === 'gsd-worktree-guard' || n === 'gsd-rules') ? 'toolkit' : 'gsd';
  // A runner picked at run time falls back on its own: only its gsd-* scripts can be judged.
  if (command.includes('$(') || command.includes('`')) words = words.filter((_, i) => GSD_WORD.test(names[i] as string));
  const gone: string[] = [];
  for (const w of words) {
    const p = expand(w, project);
    if (p && p.startsWith('/') && !existsSync(p) && !gone.includes(p)) gone.push(p);
  }
  return { owner, gone };
}

/** Same argv and output as `gsd_hook_paths.py` (`<scope>:<file>` and `--project <dir>`). */
export function hookPaths(argv: string[]): string {
  let project: string | null = null;
  let out = '';
  for (let i = 0; i < argv.length; ) {
    const arg = argv[i++] as string;
    if (arg === '--project') {
      project = i < argv.length ? (argv[i] as string) : null;
      i++;
      continue;
    }
    const colon = arg.indexOf(':');
    const scope = colon < 0 ? arg : arg.slice(0, colon);
    const file = colon < 0 ? '' : arg.slice(colon + 1);
    let data: Json;
    try {
      // a BOM is an error (python: "Unexpected UTF-8 BOM"), invalid UTF-8 too
      data = parseJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file)));
    } catch {
      continue;
    }
    if (!isObj(data)) continue;
    let n = 0;
    for (const [event, command] of hookCommands(data)) {
      n++;
      const { owner, gone } = missing(command, scope === 'project' ? project : null);
      for (const p of gone) out += `${[file, scope, owner, String(n), event, p].join('\t')}\n`;
    }
  }
  return out;
}
