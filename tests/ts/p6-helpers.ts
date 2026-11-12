// Shared by the P6 parity suites (gsdt-start, gsdt-wt-new): the pre-P6 bash commands
// (tests/fixtures/p6-old-bins/, run inside a package dir that holds lib/ + the
// current launchers) against the TypeScript commands, each on its OWN copy of the
// same fixture project, so what they WRITE can be compared too. Only temp paths
// (each side's root), the package dirs and commit ids are normalized.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PKG, sh, tmp, write } from './helpers.ts';

export { PKG, sh, tmp, write };

// fixed commit dates: the two sides make the same commits, so the same ids
process.env.GIT_AUTHOR_NAME = 't';
process.env.GIT_AUTHOR_EMAIL = 't@t';
process.env.GIT_COMMITTER_NAME = 't';
process.env.GIT_COMMITTER_EMAIL = 't@t';
process.env.GIT_AUTHOR_DATE = '2026-01-01T00:00:00Z';
process.env.GIT_COMMITTER_DATE = '2026-01-01T00:00:00Z';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
// (the user's ~/.config/git/ignore may ignore .claude/settings.local.json: look nowhere)
process.env.XDG_CONFIG_HOME = '/nonexistent-xdg';

const root = tmp();
const OLD_FIX = path.join(PKG, 'tests', 'fixtures', 'p6-old-bins');
const OLD_FIX7 = path.join(PKG, 'tests', 'fixtures', 'p7-old-bins');
const OLD_FIX8 = path.join(PKG, 'tests', 'fixtures', 'p8-old-bins');

/** the old package: lib/ and src/ copied, the current launchers, and the two old bins on top */
export const oldPkg = path.join(root, 'oldpkg');
mkdirSync(path.join(oldPkg, 'bin'), { recursive: true });
for (const d of ['lib', 'src', 'shims']) cpSync(path.join(PKG, d), path.join(oldPkg, d), { recursive: true });
cpSync(path.join(PKG, 'bin'), path.join(oldPkg, 'bin'), { recursive: true });
for (const f of ['VERSION', 'package.json']) copyFileSync(path.join(PKG, f), path.join(oldPkg, f));
for (const [dir, n] of [[OLD_FIX, 'gsdt-start'], [OLD_FIX, 'gsdt-wt-new'], [OLD_FIX7, 'gsdt-finish'], [OLD_FIX7, 'gsdt-wt-finish'], [OLD_FIX8, 'gsdt-init'], [OLD_FIX8, 'gsdt-bootstrap-repo']] as const) {
  copyFileSync(path.join(dir, n), path.join(oldPkg, 'bin', n));
  chmodSync(path.join(oldPkg, 'bin', n), 0o755);
}
writeFileSync(path.join(oldPkg, '.git'), '');

// gsd_run: phase.add appends the next integer phase; phase.insert adds a
// zero-padded decimal after phase $3 and prints JSON; RACE_CLONE makes a
// competing session push to origin first (once), to hit the push-retry paths.
const GSD_RUN = `#!/usr/bin/env bash
case "$1 $2" in
  "runtime-identity --raw") echo '{"packageName":"@opengsd/gsd-core","version":"1.18.0"}' ;;
  "query phase.add")
    rm="$5/.planning/ROADMAP.md"
    n=$(grep -oE '^### Phase [0-9]+:' "$rm" | grep -oE '[0-9]+' | sort -n | tail -1)
    if [ -n "\${RACE_CLONE:-}" ] && [ ! -e "$RACE_CLONE.done" ]; then
      : > "$RACE_CLONE.done"
      git -C "$RACE_CLONE" pull -q origin main
      if [ "$RACE" = heading ]; then
        printf '\\n### Phase %s: other session\\n' "$((n + 1))" >> "$RACE_CLONE/.planning/ROADMAP.md"
      else
        echo x > "$RACE_CLONE/other.txt"
      fi
      git -C "$RACE_CLONE" add -A; git -C "$RACE_CLONE" commit -qm "other session"; git -C "$RACE_CLONE" push -q origin main
    fi
    printf '\\n### Phase %s: %s\\n' "$((n + 1))" "$3" >> "$rm" ;;
  "query phase.insert")
    rm="$6/.planning/ROADMAP.md"; num="$(printf '%02d' "$3").1"
    printf '\\n### Phase %s: %s (INSERTED)\\n' "$num" "$4" >> "$rm"
    slug=$(printf '%s' "$4" | tr ' ' '-')
    printf '{\\n  "phase_number": "%s",\\n  "slug": "%s"\\n}\\n' "$num" "$slug" ;;
  "query config-set")
    python3 - "$6/.planning/config.json" "$3" "$4" <<'PY'
import json, sys
f, key, val = sys.argv[1:]
c = json.load(open(f)); d = c; parts = key.split(".")
for k in parts[:-1]: d = d.setdefault(k, {})
d[parts[-1]] = {"true": True, "false": False}.get(val, val)
json.dump(c, open(f, "w"), indent=2)
PY
    ;;
  *) echo "stub gsd_run: unsupported $*" >&2; exit 1 ;;
esac
`;
const AGENT = `#!/bin/sh
{ printf 'argv:'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\ncwd: %s\\nlock: ' "$(pwd -P)"; if [ -e "$GSD_TEST_MAIN/.git/gsd-cmd.lock" ]; then echo held; else echo free; fi; } > "$GSD_TEST_AGENT_LOG"
exit 5
`;

export const ROADMAP_PLAIN = '# Roadmap\n\n### Phase 1: catalog\n';
export const ROADMAP_RICH = [
  '# Roadmap',
  '',
  '- [x] **Phase 1: Catalog**',
  '',
  '### Phase 1: Catalog',
  '',
  '## Progress',
  '',
  '| Phase | Plans | Status |',
  '|---|---|---|',
  '| 1. Catalog | 1/1 | Complete |',
  '',
].join('\n');

export type Side = {
  kind: 'old' | 'new';
  root: string;
  R: string;
  origin: string;
  wtdir: string;
  home: string;
  stub: string;
  pkg: string;
};

export type Project = {
  roadmap?: string;
  conf?: string | null;
  state?: string;
  config?: string;
  noOrigin?: boolean;
  /** no .planning/ at all (a repo before gsdt-init); commit holds `files` only */
  noPlanning?: boolean;
  files?: Record<string, string>;
  /** dirs under .planning/phases (committed, with a .gitkeep) */
  phaseDirs?: string[];
};

/** A project on main with a bare origin, like tests/test-commands.sh's `project`. */
export function makeSide(kind: 'old' | 'new', p: Project = {}): Side {
  const rootDir = path.join(tmp(), kind);
  const R = path.join(rootDir, 'shop');
  const origin = path.join(rootDir, 'shop.git');
  const home = path.join(rootDir, 'home');
  const stub = path.join(rootDir, 'stub');
  mkdirSync(home, { recursive: true });
  write(path.join(stub, 'gsd_run'), GSD_RUN, 0o755);
  write(path.join(stub, 'agent'), AGENT, 0o755);
  if (!p.noOrigin) sh(rootDir, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  mkdirSync(R, { recursive: true });
  sh(R, 'git', ['init', '-qb', 'main']);
  if (!p.noPlanning) {
    write(path.join(R, '.planning/ROADMAP.md'), p.roadmap ?? ROADMAP_PLAIN);
    mkdirSync(path.join(R, '.planning/phases'), { recursive: true });
  }
  if (p.conf !== null) write(path.join(R, '.gsd.conf'), p.conf ?? 'install = none\ntest = none\n');
  if (p.state !== undefined) write(path.join(R, '.planning/STATE.md'), p.state);
  if (p.config !== undefined) write(path.join(R, '.planning/config.json'), p.config);
  for (const d of p.phaseDirs ?? []) write(path.join(R, `.planning/phases/${d}/.gitkeep`), '');
  for (const [f, c] of Object.entries(p.files ?? {})) write(path.join(R, f), c);
  sh(R, 'git', ['add', '-A']);
  sh(R, 'git', ['commit', '-qm', 'init', '--allow-empty']);
  if (!p.noOrigin) {
    sh(R, 'git', ['remote', 'add', 'origin', origin]);
    sh(R, 'git', ['push', '-qu', 'origin', 'main']);
  }
  return { kind, root: rootDir, R, origin, wtdir: path.join(rootDir, 'shop-worktrees'), home, stub, pkg: kind === 'old' ? oldPkg : PKG };
}

// The test PATH: this machine's, minus every agent CLI and gsd-core's gsd_run (a launch
// test must never start a real claude/codex, and "no gsd-core" must be true). A directory
// that holds one of them is replaced by a farm of links to everything else in it.
const BLOCKED = ['claude', 'codex', 'gsd_run'];
const farmRoot = path.join(root, 'pathfarm');
export const cleanPath = (process.env.PATH ?? '')
  .split(path.delimiter)
  .map((d, i) => {
    if (!d || !existsSync(d) || !BLOCKED.some((b) => existsSync(path.join(d, b)))) return d;
    const farm = path.join(farmRoot, String(i));
    mkdirSync(farm, { recursive: true });
    for (const n of readdirSync(d)) {
      if (BLOCKED.includes(n)) continue;
      try {
        symlinkSync(path.join(d, n), path.join(farm, n));
      } catch {
        // a name that cannot be linked is not needed
      }
    }
    return farm;
  })
  .join(path.delimiter);

export function envFor(s: Side, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${s.stub}${path.delimiter}${cleanPath}`,
    HOME: s.home,
    CLAUDE_CONFIG_DIR: path.join(s.home, '.claude'),
    CODEX_HOME: path.join(s.home, '.codex'),
    GSD_CLI: path.join(s.stub, 'gsd_run'),
    GSD_NO_UPDATE_CHECK: '1',
    GSD_TEST_MAIN: s.R,
    GSD_TEST_AGENT_LOG: path.join(s.root, 'agent.log'),
    LC_ALL: 'en_US.UTF-8',
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete e[k];
    else e[k] = v;
  }
  return e;
}

export type R = { out: string; err: string; rc: number };

const PTY = `
import os, pty, sys
cwd = sys.argv[1]; argv = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(argv[0], argv)
buf = b''
while True:
    try:
        d = os.read(fd, 4096)
    except OSError:
        break
    if not d:
        break
    buf += d
_, st = os.waitpid(pid, 0)
sys.stdout.buffer.write(buf)
sys.exit(os.waitstatus_to_exitcode(st))
`;

export type Step = {
  cmd: 'start' | 'wt-new' | 'finish' | 'wt-finish' | 'init' | 'bootstrap-repo';
  args: string[] | ((s: Side) => string[]);
  cwd?: (s: Side) => string;
  env?: Record<string, string | undefined> | ((s: Side) => Record<string, string | undefined>);
  /** text for the command's stdin (default: nothing) */
  input?: string;
  /** run under a pseudo terminal (stdout and stderr come back merged) */
  tty?: boolean;
  /** the exit code both must give (a guard against two identical failures that are not the one meant) */
  rc?: number;
  /** both must exit nonzero (the exact code is only compared old vs new) */
  fail?: boolean;
  out?: RegExp;
  err?: RegExp;
  /** a regexp that must NOT match the merged output */
  not?: RegExp;
};

export function runStep(s: Side, st: Step): R {
  const args = typeof st.args === 'function' ? st.args(s) : st.args;
  const cwd = st.cwd ? st.cwd(s) : s.R;
  const ex = typeof st.env === 'function' ? st.env(s) : (st.env ?? {});
  const env = envFor(s, ex);
  const bin = path.join(s.pkg, 'bin', `gsdt-${st.cmd}`);
  if (st.tty) {
    const r = spawnSync('python3', ['-c', PTY, cwd, bin, ...args], { env, encoding: 'utf8' });
    return { out: (r.stdout ?? '').replace(/\r\n/g, '\n'), err: '', rc: r.status ?? -1 };
  }
  const r = spawnSync(bin, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(st.input !== undefined ? { input: st.input, stdio: ['pipe', 'pipe', 'pipe'] } : {}) });
  return { out: r.stdout ?? '', err: r.stderr ?? '', rc: r.status ?? -1 };
}

/** wait for every background install to write its final status */
export function settle(s: Side): void {
  if (!existsSync(s.wtdir)) return;
  for (const d of readdirSync(s.wtdir)) {
    const f = path.join(s.wtdir, d, '.gsd-install.status');
    for (let i = 0; i < 100; i++) {
      const v = existsSync(f) ? readFileSync(f, 'utf8').trim() : '';
      if (v !== 'running') break;
      spawnSync('sleep', ['0.1']);
    }
  }
}

export const norm = (s: Side, text: string): string =>
  text
    .split(s.root)
    .join('<T>')
    .split(s.pkg)
    .join('<PKG>')
    .replace(/HEAD is now at [0-9a-f]+/g, 'HEAD is now at <sha>')
    .replace(/\b[0-9a-f]{40}\b/g, '<sha40>');

const g = (cwd: string, args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return (r.stdout ?? '') + (r.stderr ?? '');
};

function tree(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const n of readdirSync(path.join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${n}` : n;
    if (n === '.git') continue;
    const st = statSync(path.join(dir, r));
    if (st.isDirectory()) {
      out.push(`${r}/`);
      out.push(...tree(dir, r));
    } else out.push(r);
  }
  return out;
}

/** what the commands leave behind (everything is compared after normalizing the side's root) */
export function snapshot(s: Side): string {
  const parts: string[] = [];
  const P = (k: string, v: string): void => void parts.push(`── ${k}\n${v}`);
  P('log', g(s.R, ['log', '--all', '--format=%s']));
  P('branches', g(s.R, ['branch', '--format=%(refname:short)']));
  P('worktrees', g(s.R, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => !l.startsWith('HEAD ')).join('\n'));
  P('status', g(s.R, ['status', '--porcelain']));
  for (const f of ['.planning/ROADMAP.md', '.planning/STATE.md', '.planning/config.json', '.git/info/exclude']) {
    P(f, existsSync(path.join(s.R, f)) ? readFileSync(path.join(s.R, f), 'latin1') : '(none)');
  }
  P('lock', existsSync(path.join(s.R, '.git/gsd-cmd.lock')) ? 'present' : 'none');
  if (existsSync(s.origin)) P('origin', g(s.origin, ['log', 'main', '--format=%s']));
  if (existsSync(s.wtdir)) {
    for (const d of readdirSync(s.wtdir).sort()) {
      const w = path.join(s.wtdir, d);
      P(`wt ${d}`, tree(w).join('\n'));
      for (const f of ['.gsd-install.status', '.claude/settings.local.json', '.env.local', '.mcp.json']) {
        if (existsSync(path.join(w, f))) P(`wt ${d}/${f}`, readFileSync(path.join(w, f), 'latin1'));
      }
      if (existsSync(path.join(w, '.gsd-install.log'))) P(`wt ${d}/.gsd-install.log`, readFileSync(path.join(w, '.gsd-install.log'), 'latin1'));
    }
  }
  for (const f of ['agent.log', 'tracker.log', 'gh.log', 'doctor.log']) {
    const log = path.join(s.root, f);
    if (existsSync(log)) P(f, readFileSync(log, 'utf8'));
  }
  P('merge driver', g(s.R, ['config', '--get', 'merge.gsd-planning.driver']));
  return norm(s, parts.join('\n'));
}

const eq = (got: string, want: string, label: string): void => {
  if (got === want) return;
  const a = got.split('\n');
  const b = want.split('\n');
  const i = a.findIndex((l, k) => l !== b[k]);
  assert.fail(`${label}: line ${i + 1}\n  new: ${JSON.stringify(a[i])}\n  old: ${JSON.stringify(b[i])}`);
};

/** Both sides, each on its own fixture; every step's stdout, stderr and exit code, then the files left behind. */
export function scenario(
  project: Project | ((kind: 'old' | 'new') => Project),
  prep: ((s: Side) => void) | null,
  steps: Step[],
  extraSnapshot?: (s: Side) => string,
): void {
  const mk = (k: 'old' | 'new'): Side => makeSide(k, typeof project === 'function' ? project(k) : project);
  const o = mk('old');
  const n = mk('new');
  if (prep) {
    prep(o);
    prep(n);
  }
  steps.forEach((st, i) => {
    const label = `step ${i + 1} (gsdt-${st.cmd} ${(typeof st.args === 'function' ? st.args(n) : st.args).map((a) => norm(n, a)).join(' ')})`;
    const ro = runStep(o, st);
    const rn = runStep(n, st);
    settle(o);
    settle(n);
    eq(norm(n, rn.out), norm(o, ro.out), `${label}: stdout`);
    eq(norm(n, rn.err), norm(o, ro.err), `${label}: stderr`);
    assert.equal(rn.rc, ro.rc, `${label}: exit code (old ${ro.rc})`);
    if (st.rc !== undefined) assert.equal(rn.rc, st.rc, `${label}: expected rc\n${rn.out}${rn.err}`);
    if (st.fail) assert.notEqual(rn.rc, 0, `${label}: expected a failure\n${rn.out}${rn.err}`);
    if (st.out) assert.match(rn.out, st.out, label);
    if (st.err) assert.match(rn.err, st.err, label);
    if (st.not) assert.doesNotMatch(rn.out + rn.err, st.not, label);
    eq(snapshot(n), snapshot(o), `${label}: files left behind`);
    if (extraSnapshot) eq(norm(n, extraSnapshot(n)), norm(o, extraSnapshot(o)), `${label}: files left behind (full tree)`);
  });
}

export const sub = (s: Side, ...a: string[]): string => path.join(s.R, ...a);
export const git = (cwd: string, ...a: string[]): string => sh(cwd, 'git', a);
export const commitAll = (cwd: string, msg = 'x'): void => {
  sh(cwd, 'git', ['add', '-A']);
  sh(cwd, 'git', ['commit', '-qm', msg, '--allow-empty']);
};
