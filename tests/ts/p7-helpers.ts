// Shared by the P7 parity suites (gsdt-finish, gsdt-wt-finish): fixtures on top of
// tests/ts/p6-helpers.ts — a phase worktree with a commit, stub tools on PATH
// (gsdt-planning-repair / -merge wrappers, a gsdt-doctor and a gh stub), a custom
// tracker script, a competing session that pushes to origin, and a PATH without gh.
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { cleanPath, commitAll, git, tmp, write, type Side, type Step } from './p6-helpers.ts';

export { ROADMAP_RICH, scenario, makeSide, runStep, commitAll, git, sub, write, tmp, type Side, type Step } from './p6-helpers.ts';

const REPAIR = (pkg: string): string => `#!/bin/sh
mode="\${REPAIR_MODE:-real}"
case " $* " in
  *" --check "*)
    if [ "$mode" = badcheck ]; then echo "stub: ROADMAP is self-contradictory"; echo "stub check failed" >&2; exit 1; fi ;;
  *" --commit "*)
    if [ "$mode" = failcommit ]; then echo "stub repair broke" >&2; exit 1; fi
    if [ "$mode" = dirty ]; then echo x >> "$2/.planning/NOTES.md"; exit 0; fi ;;
esac
exec "${pkg}/bin/gsdt-planning-repair" "$@"
`;

const GH = `#!/bin/sh
echo "gh $*" >> "$GH_LOG"
n=$(cat "$GH_LOG.n" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "$GH_LOG.n"
case "\${GH_MODE:-ok}" in
  ok) echo "https://github.com/x/y/pull/$n"; exit 0 ;;
  first) if [ "$n" = 1 ]; then echo "first call failed" >&2; exit 1; fi; echo "https://github.com/x/y/pull/$n"; exit 0 ;;
  *) echo "gh: boom" >&2; exit 1 ;;
esac
`;

const DOCTOR = `#!/bin/sh
echo "$*" >> "$DOCTOR_LOG"
printf '%s' "\${DOCTOR_OUT:-}"
`;

const TRACKER = `#!/bin/sh
echo "$*|status=\${GSD_TRACKER_STATUS:-}" >> "$TRACKER_LOG"
[ "\${TRACKER_FAIL:-}" = 1 ] && exit 1
exit 0
`;

const RACE = `#!/bin/sh
# a competing session: pushes one commit to origin the first time it runs
[ -e "$RACE_CLONE.done" ] && exit 0
: > "$RACE_CLONE.done"
git -C "$RACE_CLONE" pull -q origin main
case "$RACE_MODE" in
  conflict) echo other > "$RACE_CLONE/f.txt" ;;
  roadmap) printf '\\n### Phase 9: other session\\n' >> "$RACE_CLONE/.planning/ROADMAP.md" ;;
  *) echo x > "$RACE_CLONE/other.txt" ;;
esac
git -C "$RACE_CLONE" add -A; git -C "$RACE_CLONE" commit -qm "other session"; git -C "$RACE_CLONE" push -q origin main
exit 0
`;

/** the stub tools on the side's PATH (first in line); repair / gh: false leave that tool off PATH */
export function tools(s: Side, o: { repair?: boolean; gh?: boolean } = {}): void {
  write(path.join(s.stub, 'gsdt-planning-merge'), `#!/bin/sh\nexec "${s.pkg}/bin/gsdt-planning-merge" "$@"\n`, 0o755);
  if (o.repair !== false) write(path.join(s.stub, 'gsdt-planning-repair'), REPAIR(s.pkg), 0o755);
  write(path.join(s.stub, 'gsdt-doctor'), DOCTOR, 0o755);
  if (o.gh !== false) write(path.join(s.stub, 'gh'), GH, 0o755);
  write(path.join(s.stub, 'race.sh'), RACE, 0o755);
}

/** a phase worktree (branch phase-<n>-<slug>, in the conventional sibling dir) with one commit */
export function phase(s: Side, n = '1', slug = 'catalog', files: Record<string, string> = { 'f.txt': 'feature\n' }, dir?: string): string {
  const dest = dir ?? path.join(s.wtdir, `phase-${n}-${slug}`);
  git(s.R, 'worktree', 'add', '-q', '-b', `phase-${n}-${slug}`, dest);
  for (const [f, c] of Object.entries(files)) write(path.join(dest, f), c);
  commitAll(dest, 'feature');
  return dest;
}

/** a batch worktree */
export function batch(s: Side, name = 'batch-2026-11-09-fix', files: Record<string, string> = { 'b.txt': 'batch\n' }): string {
  const dest = path.join(s.wtdir, name);
  git(s.R, 'worktree', 'add', '-q', '-b', name, dest);
  for (const [f, c] of Object.entries(files)) write(path.join(dest, f), c);
  commitAll(dest, 'fix: labels');
  return dest;
}

/** commit files on main (and push them) */
export function onMain(s: Side, files: Record<string, string>, opts: { push?: boolean; mode?: number } = {}): void {
  for (const [f, c] of Object.entries(files)) {
    write(path.join(s.R, f), c);
    if (opts.mode !== undefined) chmodSync(path.join(s.R, f), opts.mode);
  }
  commitAll(s.R, 'main change');
  if (opts.push !== false && existsSync(s.origin)) git(s.R, 'push', '-q', 'origin', 'main');
}

/** the custom tracker script of the repo (committed and pushed) */
export function addTracker(s: Side): void {
  onMain(s, { 'scripts/tracker.sh': TRACKER }, { mode: 0o755 });
}

/** a clone of origin that plays the other session */
export function racer(s: Side): void {
  git(s.root, 'clone', '-q', s.origin, path.join(s.root, 'racer'));
}

export const TRACKER_CONF = 'install = none\ntest = none\ntracker = custom\ntracker_command = scripts/tracker.sh\n';
export const RACE_CONF = 'install = none\ntest = bash "$RACE_SH"\n';

/** the env every P7 step gets (the logs live in each side's own root) */
export const E =
  (extra: Record<string, string | undefined> | ((s: Side) => Record<string, string | undefined>) = {}) =>
  (s: Side): Record<string, string | undefined> => ({
    TRACKER_LOG: path.join(s.root, 'tracker.log'),
    GH_LOG: path.join(s.root, 'gh.log'),
    DOCTOR_LOG: path.join(s.root, 'doctor.log'),
    RACE_SH: path.join(s.stub, 'race.sh'),
    RACE_CLONE: path.join(s.root, 'racer'),
    ...(typeof extra === 'function' ? extra(s) : extra),
  });

// A PATH without gh (the machine may have one): a farm of links to everything else.
const farm = path.join(tmp(), 'nogh');
export const noGhPath = cleanPath
  .split(path.delimiter)
  .map((d, i) => {
    if (!d || !existsSync(d) || !existsSync(path.join(d, 'gh'))) return d;
    const f = path.join(farm, String(i));
    mkdirSync(f, { recursive: true });
    for (const n of readdirSync(d)) {
      if (n === 'gh') continue;
      try {
        symlinkSync(path.join(d, n), path.join(f, n));
      } catch {
        // not needed
      }
    }
    return f;
  })
  .join(path.delimiter);

export const wf = (args: Step['args'], extra: Partial<Step> = {}): Step => ({ cmd: 'wt-finish', args, env: E(), ...extra });
export const fin = (args: Step['args'], extra: Partial<Step> = {}): Step => ({ cmd: 'finish', args, env: E(), ...extra });
