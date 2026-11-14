// gsdt-wt-new — create the worktree for a GSD phase (or a gsdt-batch batch) in
// ONE step. Port of the bash bin/gsdt-wt-new (kept as the parity oracle in
// tests/fixtures/p6-old-bins/). Output, exit codes and the files it writes are the
// same; the background install is a detached child, as the subshell was.
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  acquireLock,
  base,
  baserefEnsure,
  chomp,
  findMain,
  git,
  GsdExit,
  installCmd,
  isDir,
  isFile,
  phaseBranch,
  wtdir,
} from '../common.ts';
import { err, inherit, out } from '../stdio.ts';

const HELP = `gsdt-wt-new — create the worktree for a GSD phase in ONE step.

Naming convention: branch + worktree dir = phase-<N>-<slug>, where <N> is the
phase number. This binds a phase to exactly one worktree, which the guard
(gsdt-worktree-guard) uses to keep per-phase commands in the right place.

Usage (from inside the target repo, typically its main checkout):
  gsdt-wt-new [slug] [--phase <N>] [--no-install|--install]
  gsdt-wt-new --batch batch-<date>-<slug> [--no-install|--install]

  --batch makes the worktree of a quick-task batch instead (gsdt-batch runs
  it): branch + dir = the name given, off the base branch. No phase, no
  ROADMAP.md. Reused when the branch exists, like a phase's.

  - <N>  is auto-detected: the phase added by the latest claim commit, else
         the highest-numbered phase in .planning/ROADMAP.md. Pass --phase <N>
         to target an already-claimed phase explicitly (what gsdt-start does);
         it must exist in ROADMAP.md.
  - <slug> defaults to a slugified phase title; pass one to override.
  - The dependency install (from .gsd.conf \`install\`, else lockfile
    detection) runs in the BACKGROUND by default (log:
    <worktree>/.gsd-install.log, status: .gsd-install.status). --install
    runs it in the foreground; --no-install skips it.
  - Idempotent per phase: if a phase-<N>-* branch already exists, its
    worktree is reused (re-attached if it was removed) instead of failing.
    PR branches (*-pr) are never treated as the feature branch.

Repo settings (base branch, worktree dir, install cmd): .gsd.conf, see
gsdt-bootstrap-repo. The old per-repo copy of this logic
(scripts/gsdt-new-worktree-feature.sh) is now a shim that delegates here.
`;

/** bash `exit N` after the output so far */
class Stop extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}
const fail = (msg: string): never => {
  err(`${msg}\n`);
  throw new Stop(1);
};

/** grep -E on a string that came through printf '%s': true when any line matches */
export const grepq = (re: RegExp, s: string): boolean => s.split('\n').some((l) => re.test(l));

/** `sed 's/\./\\./g'` on a phase number — the rest stays an ERE, like in bash; null when grep would reject it */
export function phaseHeadingRe(n: string, suffix = ''): RegExp | null {
  try {
    return new RegExp(`^### Phase ${n.replace(/\./g, '\\.')}:${suffix}`);
  } catch {
    return null;
  }
}

/** `sort -t. -k1,1n -k2,2n | tail -1` over bare phase numbers (11, 11.2, 02.1) */
export function highestPhase(nums: string[]): string {
  const key = (s: string): [bigint, bigint] => {
    const [a, b] = s.split('.');
    return [BigInt(a || '0'), BigInt(b || '0')];
  };
  const sorted = [...nums].sort((x, y) => {
    const [x1, x2] = key(x);
    const [y1, y2] = key(y);
    if (x1 !== y1) return x1 < y1 ? -1 : 1;
    if (x2 !== y2) return x2 < y2 ? -1 : 1;
    return x < y ? -1 : x > y ? 1 : 0; // sort's last-resort whole-line comparison
  });
  return sorted[sorted.length - 1] ?? '';
}

/** The worktree git lists for a branch ('' when none) — the awk over `worktree list --porcelain`. */
export function worktreeOf(main: string, branch: string): string {
  const want = `branch refs/heads/${branch}`;
  let w = '';
  for (const l of git(main, ['worktree', 'list', '--porcelain']).stdout.split('\n')) {
    if (l.startsWith('worktree ')) w = l.slice(9);
    if (l === want) return w;
  }
  return '';
}

export function main(argv: string[]): number {
  try {
    return run(argv);
  } catch (e) {
    if (e instanceof Stop) return e.code;
    if (e instanceof GsdExit) {
      err(e.message);
      return e.code;
    }
    throw e;
  }
}

function run(argv: string[]): number {
  let installMode: 'background' | 'foreground' | 'none' = 'background';
  let slug = '';
  let phase = '';
  let batch = '';
  for (let i = 0; i < argv.length; ) {
    const a = argv[i] as string;
    if (a === '-h' || a === '--help') {
      // bash had no --help: "-h" was an unknown flag. The header comment is the help; print it for these.
      out(HELP);
      return 0;
    }
    if (a === '--no-install') {
      installMode = 'none';
      i++;
    } else if (a === '--install') {
      installMode = 'foreground';
      i++;
    } else if (a === '--background') {
      installMode = 'background';
      i++;
    } else if (a === '--phase') {
      if (argv.length - i < 2) fail('error: --phase needs a value');
      phase = argv[i + 1] as string;
      i += 2;
    } else if (a === '--batch') {
      if (argv.length - i < 2) fail('error: --batch needs a name');
      const v = argv[i + 1] as string;
      if (!grepq(/^batch-[a-z0-9][a-z0-9.-]*$/, v)) fail(`error: --batch needs a batch-<date>-<slug> name (a-z, 0-9, ., -), got '${v}'`);
      batch = v;
      i += 2;
    } else if (a.startsWith('-')) {
      fail(`unknown flag: ${a}`);
    } else {
      slug = a;
      i++;
    }
  }

  const MAIN = findMain('.');
  if (MAIN === '') fail('error: not inside a git repository');
  // The existing-branch check below and `git worktree add` must not interleave
  // with another run for the same phase. Re-entrant: gsdt-start already holds it.
  if (!acquireLock(MAIN)) return 1;
  const BASE = base(MAIN);
  const WTDIR = wtdir(MAIN);
  const INSTALL_CMD = installCmd(MAIN);
  if (INSTALL_CMD === '') installMode = 'none';

  let N = '';
  let NAME: string;
  let WHAT: string;
  let EXISTING = '';
  if (batch !== '') {
    // A batch: no phase, no ROADMAP. The rest (reuse, local config, baseRef, install) is the same as for a phase.
    NAME = batch;
    WHAT = 'batch';
    if (git(MAIN, ['show-ref', '--verify', '--quiet', `refs/heads/${NAME}`]).status === 0) EXISTING = NAME;
  } else {
    const ROADMAP = `${MAIN}/.planning/ROADMAP.md`;
    if (!isFile(ROADMAP)) fail(`error: ${ROADMAP} not found (is GSD initialized?)`);
    const lines = (): string[] => readFileSync(ROADMAP, 'utf8').split('\n');
    // Phase number: --phase wins; else the one added in the latest commit (the claim), else the highest in ROADMAP.md.
    if (phase !== '') {
      N = phase;
      const re = phaseHeadingRe(N);
      if (re === null || !lines().some((l) => re.test(l))) fail(`error: phase ${N} not found in ${ROADMAP}`);
    } else {
      const shown = git(MAIN, ['show', 'HEAD', '--', '.planning/ROADMAP.md']);
      const added = (shown.status === 0 ? shown.stdout : '').split('\n').filter((l) => /^\+### Phase [0-9]+(\.[0-9]+)?:/.test(l));
      const last = added[added.length - 1];
      if (last !== undefined) N = (/^\+### Phase ([0-9]+(?:\.[0-9]+)?):/.exec(last) as RegExpExecArray)[1] as string;
      if (N === '') {
        const nums = lines()
          .filter((l) => /^### Phase [0-9]+(\.[0-9]+)?:/.test(l))
          .map((l) => (/^### Phase ([0-9]+(?:\.[0-9]+)?):/.exec(l) as RegExpExecArray)[1] as string);
        N = highestPhase(nums);
      }
      if (N === '') fail('error: no phase found in ROADMAP.md — claim one first (gsdt-start)');
    }
    // Slug: from arg, else slugify the phase title.
    if (slug === '') {
      const re = phaseHeadingRe(N);
      const line = re === null ? undefined : lines().find((l) => re.test(l));
      const title = line === undefined || re === null ? '' : line.replace(new RegExp(`${re.source}[ \\t\\n\\r\\f\\v]*`), '');
      slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');
      if (slug === '') slug = 'feature';
    }
    NAME = `phase-${N}-${slug}`;
    WHAT = `phase ${N}`;
    // Idempotent per phase: reuse any existing phase-<N>-* branch (whatever its slug), and its worktree if still
    // attached. PR branches (*-pr, from /gsd-pr-branch) are NOT the feature branch.
    EXISTING = phaseBranch(MAIN, N);
  }

  if (EXISTING !== '') {
    NAME = EXISTING;
    let WT = worktreeOf(MAIN, NAME);
    if (WT !== '' && !isDir(WT)) {
      // Its folder was deleted by hand: git still lists it. Drop the dead entry and re-attach below.
      out(`• the worktree for '${NAME}' is gone from disk (${WT}) — re-creating it.\n`);
      inherit('git', ['-C', MAIN, 'worktree', 'prune']);
      WT = '';
    }
    if (WT !== '') {
      out(`• branch '${NAME}' already has a worktree — reusing it.\n`);
      // A worktree made before the toolkit set it (or by hand) lacks it.
      const line = baserefEnsure(WT);
      if (line !== '') out(`${line}\n`);
      out('\n');
      out(`✅ worktree ready: ${WT}   (${WHAT})\n`);
      return 0;
    }
  }
  const DEST = `${path.dirname(MAIN)}/${WTDIR}/${NAME}`;
  if (existsSync(DEST)) fail(`error: ${DEST} already exists but is not a registered worktree — remove it or run 'git worktree prune'`);

  if (EXISTING !== '') {
    out(`▶ re-attaching worktree for existing branch '${NAME}': ${DEST}\n`);
    const rc = inherit('git', ['-C', MAIN, 'worktree', 'add', DEST, NAME]);
    if (rc !== 0) return rc;
  } else {
    out(`▶ creating worktree: ${DEST}   (branch '${NAME}' off ${BASE})\n`);
    const rc = inherit('git', ['-C', MAIN, 'worktree', 'add', DEST, '-b', NAME, BASE]);
    if (rc !== 0) return rc;
  }

  out('▶ copying gitignored local config…\n');
  // .claude/settings.local.json carries the user's permission allowlist; without it every worktree re-prompts for
  // everything. Only gitignored files are copied. `git ls-files --others --ignored` collapses an ignored directory
  // to one 'path/' entry: skip anything that is not a regular file.
  const ls = git(MAIN, ['ls-files', '--others', '--ignored', '--exclude-standard', '--', ':(glob)**/.env.local', '.env.local', '.mcp.json', '.claude/settings.local.json']);
  for (const rel of ls.stdout.split('\n')) {
    if (rel === '') continue;
    if (!isFile(`${MAIN}/${rel}`)) continue;
    try {
      mkdirSync(`${DEST}/${path.dirname(rel)}`, { recursive: true });
      copyFileSync(`${MAIN}/${rel}`, `${DEST}/${rel}`);
      out(`  copied ${rel}\n`);
    } catch {
      // `cp … && echo`: a failed copy is skipped silently
    }
  }

  // The status/log files and the local settings must never read as uncommitted work. Bootstrap ignores them in
  // .gitignore; the repo-local exclude list covers a repo whose .gitignore lost the lines.
  const ex = git(MAIN, ['rev-parse', '--git-path', 'info/exclude']);
  let excl = ex.status === 0 ? chomp(ex.stdout) : '';
  if (excl !== '' && !excl.startsWith('/')) excl = `${MAIN}/${excl}`;
  let canMk = false;
  if (excl !== '') {
    try {
      mkdirSync(path.dirname(excl), { recursive: true });
      canMk = true;
    } catch {
      canMk = false;
    }
  }
  if (excl !== '' && canMk) {
    for (const pat of ['.gsd-install.status', '.gsd-install.log', '.claude/settings.local.json']) {
      let cur: Buffer | null = null;
      try {
        cur = readFileSync(excl);
      } catch {
        cur = null;
      }
      if (cur !== null && cur.toString('utf8').split('\n').includes(pat)) continue;
      try {
        if (cur !== null && cur.length > 0 && cur[cur.length - 1] !== 0x0a) appendFileSync(excl, '\n');
        appendFileSync(excl, `${pat}\n`);
      } catch {
        // like `printf … >> file 2>/dev/null`'s failure under `[ … ] && …`: not fatal in practice
      }
    }
  }

  const line = baserefEnsure(DEST);
  if (line !== '') out(`${line}\n`);

  const status = `${DEST}/.gsd-install.status`;
  switch (installMode) {
    case 'background': {
      writeFileSync(status, 'running\n');
      // Fully detached, no stdio: an open stdout would make gsdt-start's capture of ours wait for the install to end.
      const child = spawn(
        'bash',
        ['-c', 'if bash -c "$INSTALL_CMD" >.gsd-install.log 2>&1; then echo ok >.gsd-install.status; else echo fail >.gsd-install.status; fi'],
        { cwd: DEST, env: { ...process.env, INSTALL_CMD }, detached: true, stdio: 'ignore' },
      );
      child.on('error', () => {});
      child.unref();
      out(`▶ ${INSTALL_CMD} running in background → ${DEST}/.gsd-install.log (status: .gsd-install.status)\n`);
      break;
    }
    case 'foreground': {
      out(`▶ installing dependencies (${INSTALL_CMD})…\n`);
      writeFileSync(status, 'running\n');
      const rc = inherit('bash', ['-c', INSTALL_CMD], { cwd: DEST });
      if (rc === 0) writeFileSync(status, 'ok\n');
      else {
        writeFileSync(status, 'fail\n');
        return 1;
      }
      break;
    }
    case 'none':
      // Record the skip: without this the guard cannot tell "skipped" from "still installing" (both look like a missing status file).
      writeFileSync(status, 'skipped\n');
      out('▶ skipped dependency install\n');
      break;
  }

  out('\n');
  out(`✅ worktree ready: ${DEST}   (${WHAT})\n`);
  const suppress = (process.env.GSD_WT_NEW_SUPPRESS_NEXT ?? '') !== '';
  if (!suppress && batch !== '') {
    out(`Open an agent session there and run /gsdt-batch. Finish:  gsdt-finish ${NAME}\n`);
  } else if (!suppress) {
    out('Open an agent session there, then:\n');
    out(`    /gsd-discuss-phase ${N} → /gsd-plan-phase ${N} → /gsd-execute-phase ${N}\n`);
    out(`Finish:  gsdt-finish ${N}\n`);
  }
  return 0;
}

