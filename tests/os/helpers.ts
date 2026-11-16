// Cross-platform helpers for the OS suite (tests/os/*.test.ts): the REAL npm
// package, installed into a throwaway prefix, driven the way a user's shell
// drives it. Only node:* imports; no bash, perl, python, jq or curl.
import { resolveWin } from '../../src/spawn.ts';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const PKG = path.resolve(import.meta.dirname, '..', '..');
export const WIN = process.platform === 'win32';
export type Run = { status: number; stdout: string; stderr: string; out: string };

const real = (p: string): string => realpathSync.native(p);
/** One spelling for a path, to compare git's output with ours. */
export const norm = (p: string): string => {
  let r = p;
  try { r = real(p); } catch { /* a path that is gone: compare as written */ }
  r = r.replace(/\\/g, '/').replace(/\/+$/, '');
  return WIN ? r.toLowerCase() : r;
};

export const ROOT: string = real(mkdtempSync(path.join(tmpdir(), 'gsdt-os-')));
export const HOME = path.join(ROOT, 'home');
const PREFIX = path.join(ROOT, 'prefix');
const AGENTS = path.join(ROOT, 'agents');
/** Where npm puts the command shims: <prefix>/bin on POSIX, <prefix> itself on Windows. */
export const BIN = WIN ? PREFIX : path.join(PREFIX, 'bin');
export const GITCONFIG = path.join(ROOT, 'gitconfig');

function sh(file: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Run {
  let f = file, a = args, verbatim = false;
  if (WIN && /\.(cmd|bat)$/i.test(file)) {
    // like a user's shell: through cmd.exe, every argument double-quoted
    f = process.env.ComSpec ?? 'cmd.exe';
    a = ['/d', '/s', '/c', `"${[file, ...args].map((x) => `"${x}"`).join(' ')}"`];
    verbatim = true;
  }
  const r = spawnSync(f, a, { cwd: opts.cwd, env: opts.env ?? process.env, encoding: 'utf8', windowsVerbatimArguments: verbatim, maxBuffer: 64 << 20, input: '' });
  const stdout = r.stdout ?? '', stderr = r.stderr ?? '';
  return { status: r.status ?? (r.error ? 127 : 1), stdout, stderr: r.error ? `${stderr}${r.error.message}` : stderr, out: stdout + stderr };
}

/** The host environment minus everything that could leak into a run. */
export function cleanEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(GSD_|CLAUDE_|CODEX_|GIT_|XDG_|NPM_CONFIG_|npm_)/i.test(k)) continue;
    if (/^(path|home|userprofile|appdata|localappdata)$/i.test(k)) continue;
    env[k] = v;
  }
  const hostPath = process.env.PATH ?? process.env.Path ?? '';
  Object.assign(env, {
    PATH: [BIN, AGENTS, hostPath].join(path.delimiter),
    HOME, USERPROFILE: HOME, APPDATA: path.join(HOME, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(HOME, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(HOME, '.config'), XDG_CACHE_HOME: path.join(HOME, '.cache'),
    GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'os-suite', GIT_AUTHOR_EMAIL: 'os@suite.test', GIT_COMMITTER_NAME: 'os-suite', GIT_COMMITTER_EMAIL: 'os@suite.test',
    GSD_NO_UPDATE_CHECK: '1', GSD_NO_CORE: '1', GSD_UPDATE_NOTICE: 'never', GSD_UPDATE_REPO: 'invalid/offline',
    LANG: 'en_US.UTF-8',
  });
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

/** Run an INSTALLED gsdt command, as a user's shell would. */
export function gsdt(name: string, args: string[] = [], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): Run {
  const file = path.join(BIN, WIN ? `${name}.cmd` : name);
  return sh(file, args, { cwd: opts.cwd ?? ROOT, env: cleanEnv(opts.env) });
}

/** Run an INSTALLED gsdt command with `input` on stdin (a hook payload). */
export function gsdtStdin(name: string, args: string[], input: string, opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): Run {
  const file = path.join(BIN, WIN ? `${name}.cmd` : name);
  const env = cleanEnv(opts.env);
  let f = file, a = args, verbatim = false;
  if (WIN) { f = process.env.ComSpec ?? 'cmd.exe'; a = ['/d', '/s', '/c', `"${[file, ...args].map((x) => `"${x}"`).join(' ')}"`]; verbatim = true; }
  const r = spawnSync(f, a, { cwd: opts.cwd ?? ROOT, env, input, encoding: 'utf8', windowsVerbatimArguments: verbatim });
  const stdout = r.stdout ?? '', stderr = r.stderr ?? '';
  return { status: r.status ?? 1, stdout, stderr, out: stdout + stderr };
}

export function git(cwd: string, args: string[]): Run {
  const r = sh('git', args, { cwd, env: cleanEnv() });
  return r;
}
export const gitOk = (cwd: string, args: string[]): string => {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) failed: ${r.out}`);
  return r.stdout;
};

export const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
export const read = (file: string): string => readFileSync(file, 'utf8');
export const lf = (s: string): string => s.replace(/\r\n/g, '\n');

/** The real gsd-core's gsd_run, or null. Needed by the claim tests. */
export const GSD_RUN: string | null = (() => {
  const r = sh(WIN ? 'where' : 'which', ['gsd_run'], { env: cleanEnv() });
  return r.status === 0 && r.stdout.trim() !== '' ? r.stdout.trim().split(/\r?\n/)[0]! : null;
})();
if (process.env.GSD_TEST_REQUIRE_GSD === '1' && GSD_RUN === null) {
  throw new Error('GSD_TEST_REQUIRE_GSD=1 but gsd_run is not on PATH (npm i -g @opengsd/gsd-core)');
}
export const SKIP_CLAIM: string | false = GSD_RUN === null ? 'gsd-core (gsd_run) not on PATH: claim tests need the real one' : false;

/** pack + npm install -g into the throwaway prefix. Call once. */
export function installPackage(): void {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(GITCONFIG, '');
  mkdirSync(AGENTS, { recursive: true });
  for (const a of ['claude', 'codex']) {   // doctor wants the agent CLIs; no test opens a session
    if (WIN) writeFileSync(path.join(AGENTS, `${a}.cmd`), '@exit /b 0\r\n');
    else { writeFileSync(path.join(AGENTS, a), '#!/bin/sh\nexit 0\n'); chmodSync(path.join(AGENTS, a), 0o755); }
  }
  // the FULL path: cmd.exe running a quoted bare `npm.cmd` sets its %~dp0 to the
  // current directory, so npm.cmd then looks for node_modules\npm there
  const npm = WIN ? (resolveWin('npm') ?? 'npm.cmd') : 'npm';
  const cache = path.join(ROOT, 'npm-cache');
  const env = { ...process.env, npm_config_cache: cache };
  const packDir = path.join(ROOT, 'pack'); mkdirSync(packDir);
  const run = (args: string[], cwd: string) => {
    const r = WIN
      ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[npm, ...args].map((x) => `"${x}"`).join(' ')}"`], { cwd, env, encoding: 'utf8', windowsVerbatimArguments: true })
      : spawnSync(npm, args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`npm ${args.join(' ')} failed (${r.status}): ${r.stdout}${r.stderr}`);
    return r.stdout.trim();
  };
  const name = run(['pack', '--silent', '--pack-destination', packDir], PKG).split(/\r?\n/).pop()!;
  run(['install', '-g', '--prefix', PREFIX, '--no-audit', '--no-fund', '--silent', path.join(packDir, name)], ROOT);
  if (!existsSync(path.join(BIN, WIN ? 'gsdt-list.cmd' : 'gsdt-list'))) throw new Error(`install produced no gsdt-list in ${BIN}`);
}

export function cleanup(): void {
  try { rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
}

export type Project = { main: string; origin: string; dir: string };

const ROADMAP = `# Roadmap: Fake Shop

## Phases

- [ ] **Phase 1: Product catalog** - List products

## Phase Details

### Phase 1: Product catalog
**Goal**: Customers can browse products
**Depends on**: Nothing (first phase)
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Product catalog | 0/0 | Not started | - |
`;
const STATE = `---
gsd_state_version: 1.0
milestone: v1.0
status: planning
stopped_at: Project initialized
progress:
  total_phases: 1
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Current Position

Phase: 1 of 1 (Product catalog)
Status: Ready to plan

## Session Continuity

Last session: 2026-09-25
Stopped at: Project initialized
Resume file: None
`;

/** A project: bare origin, `main` base, code, gsdt-init'd, minimal committed .planning/. */
export function makeProject(name: string, opts: { autocrlf?: boolean; conf?: string } = {}): Project {
  const dir = path.join(ROOT, name);
  const origin = path.join(dir, 'origin.git');
  const main = path.join(dir, 'shop');
  mkdirSync(dir, { recursive: true });
  gitOk(dir, ['init', '-q', '--bare', '-b', 'main', origin]);
  gitOk(dir, ['init', '-q', '-b', 'main', main]);
  if (opts.autocrlf) gitOk(main, ['config', 'core.autocrlf', 'true']);
  gitOk(main, ['config', 'core.longpaths', 'true']);
  write(path.join(main, 'README.md'), '# Fake Shop\n');
  write(path.join(main, 'app.js'), 'console.log("shop");\n');
  gitOk(main, ['add', '-A']); gitOk(main, ['commit', '-qm', 'initial code']);
  gitOk(main, ['remote', 'add', 'origin', origin]); gitOk(main, ['push', '-qu', 'origin', 'main']);
  return { main, origin, dir };
}

/** simulated /gsd-new-project: the committed .planning/ gsd-core expects */
export function addPlanning(p: Project): void {
  const pl = path.join(p.main, '.planning');
  write(path.join(pl, 'PROJECT.md'), '# Fake Shop\n\n## Core Value\nCustomers can buy things.\n');
  write(path.join(pl, 'REQUIREMENTS.md'), '# Requirements\n\n- [ ] **CAT-01**: Browse products\n');
  write(path.join(pl, 'ROADMAP.md'), ROADMAP);
  write(path.join(pl, 'STATE.md'), STATE);
  write(path.join(pl, 'config.json'), '{\n  "mode": "yolo",\n  "workflow": {}\n}\n');
  write(path.join(pl, 'phases', '.gitkeep'), '');
  gitOk(p.main, ['add', '-A']); gitOk(p.main, ['commit', '-qm', 'docs: initialize project']); gitOk(p.main, ['push', '-q', 'origin', 'main']);
}

/** the worktree of a phase branch, from git itself */
export function worktreeOf(main: string, branch: string): string | null {
  let w = '';
  for (const line of gitOk(main, ['worktree', 'list', '--porcelain']).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) w = line.slice(9);
    else if (line === `branch refs/heads/${branch}`) return w;
  }
  return null;
}
