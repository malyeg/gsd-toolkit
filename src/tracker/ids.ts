// src/tracker/ids.ts — ticket ids, for gsdt-tracker (lib/tracker/ids.sh). Its own copy: the
// GSD toolkit keeps a twin in lib/ticket.sh (and src/ticket.ts); tests/test-tracker.sh runs
// both over the same inputs so they cannot drift.
import { chomp, grepQ } from './io.ts';

const cutAt = (s: string, ch: string): string => {
  const i = s.indexOf(ch);
  return i < 0 ? s : s.slice(0, i);
};

/**
 * trk_id_norm: <id|tag|url> [clickup] → the bare id, or null when it isn't one.
 * Accepts a URL (last path segment), #42, tk-<id>, cu_<id>; with "clickup" also CU-<id>.
 * Bash quirk kept: the shape check is `grep -q`, so a value with several lines passes
 * when any one line has the shape.
 */
export function trkIdNorm(raw: string, tracker = ''): string | null {
  let id = raw;
  if (id.includes('://')) {
    id = cutAt(id, '?');
    id = cutAt(id, '#');
    if (id.endsWith('/')) id = id.slice(0, -1);
    id = id.slice(id.lastIndexOf('/') + 1);
  }
  if (id.startsWith('#')) id = id.slice(1);
  if (/^[Tt][Kk]-/.test(id)) id = id.slice(3);
  else if (/^[Cc][Uu]_/.test(id)) id = id.slice(3);
  if (tracker === 'clickup' && /^[Cc][Uu]-/.test(id)) id = id.slice(3);
  if ([...id].length > 64) return null;
  if (!grepQ(/^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/, id)) return null;
  return chomp(id);
}

/** First match of `re` on the first line (in order) that has one, like `grep -o | head -1`. */
function firstMatch(text: string, re: RegExp): string {
  for (const line of `${text}\n`.split('\n')) {
    const m = re.exec(line);
    if (m) return m[0];
  }
  return '';
}

/** trk_id_extract: the tagged id in a title/branch (tk-<id>; legacy cu_<id>, CU-<id>, "ClickUp <id>"), or ''. */
export function trkIdExtract(text: string): string {
  let id = firstMatch(text, /(?:^|[^A-Za-z0-9])[Tt][Kk]-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/).replace(/^[^A-Za-z0-9]?[Tt][Kk]-/, '');
  if (!id) id = firstMatch(text, /(?:^|[^a-zA-Z0-9])[cC][uU][-_][a-zA-Z0-9]{6,}/).replace(/^[^A-Za-z0-9]?[Cc][Uu][-_]/, '');
  if (!id) {
    const m = firstMatch(text, /[cC][lL][iI][cC][kK][uU][pP][ \t\r\n\v\f]+[a-zA-Z0-9]{6,}/);
    // awk '{print $2}': default fields split on blanks, tabs and newlines only
    id = m ? (m.split(/[ \t\n]+/)[1] ?? '') : '';
  }
  return id;
}
