// install.test.ts — the install script (npm way) and the bridge from 0.10.x
// (was tests/test-install.sh).
//
//  1. install.sh against a fake GitHub release whose .tgz is a real `npm pack`
//     of this checkout, into a throwaway npm prefix and HOME (offline).
//  2. the bridge: a real v0.10.0 is installed by the REAL 0.10.0 install.sh;
//     then that same install.sh, and separately the installed 0.10.0 gsdt-update,
//     install a "new" release built from this checkout. lib/install.sh (in the
//     new .tar.gz) hands over to the new install.sh, which npm-installs the
//     .tgz and runs gsdt-setup, which removes the 0.10.x install.
// GitHub is a curl stub; npm is real but offline, with a throwaway prefix.
// Needs node >= 24, npm and the dev dependencies (npm ci) for `npm pack`.
import { copyFileSync, existsSync, lstatSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  CI, HAVE_NPM, HAVE_TSC, PKG, SKIP_WIN_LINKS, WIN, baseEnv, copyTracked, findNames, fwd, git, has, hasnt, is, isLink, lexists, mkTmp, mkdirp, npm,
  ok, readLF, run, sha256, stub, stubSh, sums, sysPath, tarCz, tryRead, untar, walk, whichHost, withHome, write,
} from './g5-helpers.ts';

const SKIP = !HAVE_NPM && 'needs node and npm';
const WORK = mkTmp('gsdt-inst-');
const REL = mkdirp(path.join(WORK, 'served'));
const STUB = mkdirp(path.join(WORK, 'stub'));
const CURL_LOG = path.join(WORK, 'curl.log');
const VER = readLF(path.join(PKG, 'VERSION')).split('\n')[0]!;
const NEWV = '77.0.0';   // the release's label (the packed package keeps this checkout's own version)
const binOf = (pfx: string): string => (WIN ? pfx : path.join(pfx, 'bin'));
const curlLog = (): string => tryRead(CURL_LOG);

// the fake GitHub
stub(STUB, 'curl', `
import { appendFileSync, copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
const a = process.argv.slice(2);
let out = '', url = '';
for (let i = 0; i < a.length; i++) {
  if (a[i] === '-o') out = a[++i];
  else if (['-H', '--max-time', '--retry', '--retry-delay'].includes(a[i])) i++;
  else if (a[i].startsWith('http')) url = a[i];
}
appendFileSync(${JSON.stringify(CURL_LOG)}, url + '\\n');
const base = 'https://github.com/acme/gsd-toolkit/releases/download/';
if (url === 'https://api.github.com/repos/acme/gsd-toolkit/releases/latest') {
  let v = '';
  try { v = readFileSync(${JSON.stringify(path.join(WORK, 'latest'))}, 'utf8'); } catch { /* none */ }
  if (v.trim() === '') process.exit(22);
  process.stdout.write('{"url":"x","tag_name": "v' + v.replace(/\\n$/, '') + '","name":"n"}');
} else if (url.startsWith(base)) {
  const f = ${JSON.stringify(REL)} + '/' + url.slice(base.length);
  if (!existsSync(f) || !statSync(f).isFile()) process.exit(22);
  if (out) copyFileSync(f, out); else process.stdout.write(readFileSync(f));
} else process.exit(6);
`);
const setLatest = (v: string): void => { writeFileSync(path.join(WORK, 'latest'), `${v}\n`); };

const SYS_NONODE = (): string => sysPath([STUB], undefined, false);
const NONODE = WIN ? false : whichHost('node', SYS_NONODE()) === null;

// a throwaway machine: HOME + npm prefix; PATH has the stubs, system tools and node only
type Machine = { H: string; PFX: string };
function newMachine(name: string): Machine {
  const H = mkdirp(path.join(WORK, `m-${name}`, 'home')), PFX = mkdirp(path.join(WORK, `m-${name}`, 'pfx'));
  return { H, PFX };
}
const baseGsdEnv = (): Record<string, string | undefined> => ({
  GSD_NO_UPDATE_CHECK: '1', GSD_NO_CORE: '1', GSD_UPDATE_REPO: 'acme/gsd-toolkit',
  npm_config_cache: path.join(WORK, 'npm-cache'), npm_config_offline: 'true', npm_config_update_notifier: 'false',
});
/** run a command in the machine: HOME, npm prefix, PATH without npm's bin; `pathStr` replaces the PATH */
function runIn(m: Machine, file: string, args: string[], pathStr: string = sysPath([STUB])) {
  const env = withHome(baseEnv({ ...baseGsdEnv(), XDG_CONFIG_HOME: path.join(m.H, '.config'), XDG_CACHE_HOME: path.join(m.H, '.cache'), npm_config_prefix: m.PFX, PATH: pathStr }), m.H);
  return run(file, args, { env });
}
const inst = (m: Machine, args: string[], pathStr?: string) => runIn(m, 'bash', [fwd(path.join(PKG, 'install.sh')), ...args], pathStr);
const sk = (m: Machine, n: string): string => path.join(m.H, '.claude', 'skills', n, 'SKILL.md');
const hasPkg = (m: Machine): boolean => existsSync(path.join(WIN ? m.PFX : path.join(m.PFX, 'lib'), 'node_modules', 'gsd-toolkit'));

// ── pack ─────────────────────────────────────────────────────────────────────
let TGZ = '';
function packOnce(): string {
  if (TGZ !== '') return TGZ;
  ok('dev dependencies installed (run: npm ci)', HAVE_TSC);
  const r = npm(['pack', '--silent', '--pack-destination', WORK], { cwd: PKG, env: baseEnv({ ...baseGsdEnv(), PATH: sysPath() }) });
  const name = r.stdout.trim().split('\n').pop() ?? '';
  ok(`npm pack built ${name}`, name !== '' && existsSync(path.join(WORK, name)), r.out);
  TGZ = path.join(WORK, name);
  return TGZ;
}

// release v: the .tgz of this checkout + SHA256SUMS; the .tar.gz (what a 0.10.x installer
// downloads) holds install.sh, lib/install.sh and the tracked files of this checkout
function release(v: string): void {
  const d = mkdirp(path.join(REL, `v${v}`));
  copyFileSync(packOnce(), path.join(d, `gsd-toolkit-${v}.tgz`));
  const buildRoot = mkdirp(path.join(WORK, 'build'));
  const b = path.join(buildRoot, `gsd-toolkit-${v}`);
  copyTracked(b);
  copyFileSync(path.join(PKG, 'install.sh'), path.join(b, 'install.sh'));
  copyFileSync(path.join(PKG, 'lib', 'install.sh'), path.join(b, 'lib', 'install.sh'));
  writeFileSync(path.join(b, 'VERSION'), `${v}\n`);
  tarCz(buildRoot, path.join('..', 'served', `v${v}`, `gsd-toolkit-${v}.tar.gz`), `gsd-toolkit-${v}`);
  sums(d, [`gsd-toolkit-${v}.tar.gz`, `gsd-toolkit-${v}.tgz`]);
}
let released = false;
function releases(): void {
  if (released) return;
  release(NEWV); release('76.0.0');
  setLatest(NEWV);
  released = true;
}

test('pack this checkout (the release\'s .tgz)', { skip: SKIP }, () => {
  const tgz = packOnce();
  ok(`npm pack built ${path.basename(tgz)}`, existsSync(tgz));
  releases();
});

test('install.sh — latest release, from GitHub', { skip: SKIP }, async (t) => {
  releases();
  const m = newMachine('a');
  let o = inst(m, ['--no-core']);
  is('installs (rc)', o.status, 0);
  has('…says what it installed', o.out, `✔ gsd-toolkit ${NEWV} installed`);
  const pkgDir = path.join(WIN ? m.PFX : path.join(m.PFX, 'lib'), 'node_modules', 'gsd-toolkit');
  ok('the package is in the npm prefix', existsSync(path.join(pkgDir, 'package.json')), o.out);
  is("…it is this checkout's package", readLF(path.join(pkgDir, 'VERSION')).split('\n')[0], VER);
  ok('npm linked gsdt-start into the prefix bin', existsSync(path.join(binOf(m.PFX), WIN ? 'gsdt-start.cmd' : 'gsdt-start')));
  const log = curlLog();
  ok('latest came from the GitHub API', log.includes('releases/latest'));
  ok('SHA256SUMS and the .tgz were downloaded', log.includes(`v${NEWV}/SHA256SUMS`) && log.includes(`v${NEWV}/gsd-toolkit-${NEWV}.tgz`));
  hasnt('…the .tar.gz was not', log, `${NEWV}.tar.gz`);
  ok('setup ran: the Claude skills are in HOME', existsSync(sk(m, 'gsdt-flow')), o.out);
  const S = tryRead(path.join(m.H, '.claude', 'settings.json'));
  has('…user hook: guard from the npm bin dir', S, `exec '${fwd(binOf(m.PFX))}/gsdt-worktree-guard' --global`);
  has('…user hook: rules from the npm bin dir', S, `exec '${fwd(binOf(m.PFX))}/gsdt-rules' --hook`);
  await t.test("npm's bin dir is not on PATH: the line to add is printed", { skip: WIN && 'install.sh runs under Git Bash on Windows, where npm\'s prefix layout differs; the npm bin dir is covered by tests/os' }, () => {
    has("npm's bin dir is not on PATH: the line to add is printed", o.out, `export PATH="${m.PFX}/bin:$PATH"`);
  });
  o = inst(m, ['--no-core'], sysPath([binOf(m.PFX), STUB]));
  is("a second run (npm's bin dir on PATH) succeeds", o.status, 0);
  hasnt('…and prints no PATH line', o.out, 'is not on your PATH');
});

test('install.sh — --version, agents, options', { skip: SKIP }, () => {
  releases();
  let m = newMachine('b');
  writeFileSync(CURL_LOG, '');
  let o = inst(m, ['--version', 'v76.0.0', '--agent', 'codex', '--no-core', '--reuse-install-config']);
  is('--version 76.0.0 --agent codex (rc)', o.status, 0);
  hasnt('--version: no latest lookup', curlLog(), 'releases/latest');
  ok('--agent codex: skills in the Codex dir', existsSync(path.join(m.H, '.agents', 'skills', 'gsdt-flow', 'SKILL.md')), o.out);
  ok("…and not in Claude's", !existsSync(sk(m, 'gsdt-flow')));
  has('says 76.0.0', o.out, '✔ gsd-toolkit 76.0.0 installed');
  m = newMachine('c');
  o = inst(m, ['--no-core', '--no-user-hook']);
  is('--no-user-hook (rc)', o.status, 0);
  hasnt('…no hooks written', tryRead(path.join(m.H, '.claude', 'settings.json')), 'gsdt-worktree-guard');
  m = newMachine('d');
  o = inst(m, ['--agent', 'gemini']);
  is('gemini is refused (rc)', o.status, 1); has('…with its reason', o.out, 'no longer supported');
  o = inst(m, ['--bogus']);
  is('an unknown option is refused', o.status, 1);
  o = inst(m, ['--version', 'latest']);
  is('a non-version is refused', o.status, 1);
  const nm = path.join(WIN ? m.PFX : path.join(m.PFX, 'lib'), 'node_modules');
  let n = 0; try { n = readdirSync(nm).length; } catch { /* no dir: nothing installed */ }
  is('…nothing was installed', n, 0);
  o = inst(m, ['--help']); has('--help prints the usage header', o.out, 'curl -fsSL');
});

test('install.sh — refusals leave nothing behind', { skip: SKIP }, () => {
  releases();
  release('75.0.0');
  write(path.join(REL, 'v75.0.0', 'SHA256SUMS'), `${'0'.repeat(64)}  gsd-toolkit-75.0.0.tgz\n`);
  const m = newMachine('e');
  let o = inst(m, ['--version', '75.0.0', '--no-core']);
  is('a checksum mismatch is refused', o.status, 1); has('…saying so', o.out, 'checksum mismatch');
  ok('…nothing installed', !hasPkg(m));
  ok('…no skills or hooks written', !lexists(path.join(m.H, '.claude')));
  // a release before 0.11.0: its SHA256SUMS lists only the .tar.gz
  const d10 = mkdirp(path.join(REL, 'v0.10.0'));
  write(path.join(d10, 'gsd-toolkit-0.10.0.tar.gz'), 'old\n');
  sums(d10, ['gsd-toolkit-0.10.0.tar.gz']);
  o = inst(m, ['--version', '0.10.0', '--no-core']);
  is('a release with no npm package is refused', o.status, 1);
  has("…with its own installer's line", o.out, '0.10.0 has no npm package; install it with its own installer: curl -fsSL https://raw.githubusercontent.com/acme/gsd-toolkit/v0.10.0/install.sh | bash');
  o = inst(m, ['--version', '5.5.5', '--no-core']);
  is('a missing release is refused', o.status, 1); has('…as a failed download', o.out, 'download failed');
  // node
  const oldnode = path.join(WORK, 'oldnode');
  stubSh(oldnode, 'node', '#!/bin/sh\ncase "$*" in -v) echo v20.1.0 ;; *) echo 20 ;; esac\n', '@echo v20.1.0\r\n');
  o = inst(m, ['--no-core'], sysPath([oldnode, STUB]));
  is('node 20 is refused', o.status, 1); has('…saying node 24 is needed', o.out, 'Node.js 24 or newer is required (found v20.1.0)');
  ok('…nothing installed', !hasPkg(m));
  if (NONODE) {
    o = inst(m, ['--no-core'], SYS_NONODE());
    is('no node: refused', o.status, 1); has('…saying what to install', o.out, 'Node.js 24 or newer is required');
  } else {
    t_skipNote('no node', 'a node sits in a system dir here');
  }
});
function t_skipNote(name: string, why: string): void { process.stdout.write(`  • skipped "${name}": ${why}\n`); }

// ── the bridge ───────────────────────────────────────────────────────────────
const HAVE_TAG = git(PKG, ['rev-parse', '-q', '--verify', 'v0.10.0^{commit}']).status === 0;
const SKIP_BRIDGE: string | false = SKIP || SKIP_WIN_LINKS || (!HAVE_TAG && !CI && 'no v0.10.0 tag here (git fetch --tags)');
const INSTALL_0100 = path.join(WORK, 'install-0.10.0.sh');
let oldSetUp = false;
function oldSetup(): void {
  if (oldSetUp) return;
  releases();
  const b0 = mkdirp(path.join(WORK, 'b0'));
  const arch = path.join(WORK, 'v0.10.0.tar');
  const r = run('git', ['archive', '-o', arch, 'v0.10.0'], { cwd: PKG, env: baseEnv() });
  ok('git archive v0.10.0', r.status === 0, r.out);
  untar(arch, path.join(b0, 'gsd-toolkit-0.10.0'));
  const sh = run('git', ['show', 'v0.10.0:install.sh'], { cwd: PKG, env: baseEnv() });
  writeFileSync(INSTALL_0100, sh.stdout);
  const d = mkdirp(path.join(REL, 'v0.10.0'));
  tarCz(b0, path.join('..', 'served', 'v0.10.0', 'gsd-toolkit-0.10.0.tar.gz'), 'gsd-toolkit-0.10.0');
  sums(d, ['gsd-toolkit-0.10.0.tar.gz']);   // a 0.10.0 release: no .tgz
  setLatest('0.10.0');
  oldSetUp = true;
}
/** a machine with the real 0.10.0 installed */
function oldMachine(name: string): Machine {
  const m = newMachine(name);
  const r = runIn(m, 'bash', [fwd(INSTALL_0100), '--version', '0.10.0', '--agent', 'claude']);
  writeFileSync(path.join(WORK, `old-${name}.out`), r.out);
  ok('0.10.0 is installed by its own install.sh (links + runtime)',
    isLink(path.join(m.H, '.local', 'bin', 'gsdt-list')) && existsSync(path.join(m.H, '.local', 'share', 'gsd-toolkit', 'releases', '0.10.0', 'VERSION')),
    r.out.split('\n').slice(-8).join('\n'));
  return m;
}

function checkMoved(m: Machine, l: string, out: string): void {
  const pkgDir = path.join(m.PFX, 'lib', 'node_modules', 'gsd-toolkit');
  ok(`${l}: gsd-toolkit is in the npm prefix`, existsSync(path.join(pkgDir, 'package.json')), out.split('\n').slice(-15).join('\n'));
  is(`${l}: it is this checkout's package`, tryRead(path.join(pkgDir, 'VERSION')).split('\n')[0], VER);
  is(`${l}: no 0.10.x gsdt-* link is left in ~/.local/bin`, findNames(path.join(m.H, '.local', 'bin'), /^gsdt-/).length, 0);
  ok(`${l}: ~/.local/share/gsd-toolkit is gone`, !lexists(path.join(m.H, '.local', 'share', 'gsd-toolkit')), walk(path.join(m.H, '.local', 'share')).slice(0, 5).join('\n'));
  const s = tryRead(path.join(m.H, '.claude', 'settings.json'));
  has(`${l}: Claude hooks point at the npm bin dir (guard)`, s, `exec '${m.PFX}/bin/gsdt-worktree-guard' --global`);
  has(`${l}: Claude hooks point at the npm bin dir (rules)`, s, `exec '${m.PFX}/bin/gsdt-rules' --hook`);
  hasnt(`${l}: no hook still points at ~/.local/bin`, s, `${m.H}/.local/bin`);
  ok(`${l}: skills present`, existsSync(sk(m, 'gsdt-flow')));
  // gsdt-worktrees changed since 0.10.0 (an unchanged skill keeps its old mark: "already current")
  const lines = tryRead(sk(m, 'gsdt-worktrees')).split('\n'); if (lines[lines.length - 1] === '') lines.pop();
  has(`${l}: …a changed skill is marked with the new package's version`, lines[lines.length - 1] ?? '', VER);
}

test("the bridge — a real 0.10.0 install, then 0.10.0's own installer / gsdt-update get the new release", { skip: SKIP_BRIDGE }, async (t) => {
  if (!HAVE_TAG) ok('the bridge needs the v0.10.0 tag (checkout with fetch-depth: 0)', false);
  oldSetup();
  await t.test("a: the 0.10.0 install.sh", () => {
    const m = oldMachine('f');
    has('…with its Claude user hooks in ~/.local/bin', tryRead(path.join(m.H, '.claude', 'settings.json')), `${m.H}/.local/bin/gsdt-worktree-guard`);
    setLatest(NEWV);
    const r = runIn(m, 'bash', [fwd(INSTALL_0100), '--agent', 'claude']);
    writeFileSync(path.join(WORK, 'bridge-a.out'), r.out);
    is(`0.10.0's install.sh gets ${NEWV} (rc)`, r.status, 0);
    has('…its own closing line', r.out, `✔ gsd-toolkit ${NEWV} installed`);
    checkMoved(m, 'install.sh', r.out);
    is('…the 0.10.x download was the .tar.gz, then the .tgz', curlLog().split('\n').filter((l) => l.includes(`v${NEWV}/gsd-toolkit-${NEWV}.tar.gz`)).length, 1);
    ok('…and the bridge downloaded the .tgz', curlLog().includes(`v${NEWV}/gsd-toolkit-${NEWV}.tgz`));
  });
  await t.test("b: the installed 0.10.0 gsdt-update", () => {
    const m = oldMachine('g');
    setLatest(NEWV);
    const r = runIn(m, path.join(m.H, '.local', 'bin', 'gsdt-update'), []);
    is(`0.10.0's gsdt-update gets ${NEWV} (rc, GSD_NO_CORE=1)`, r.status, 0);
    checkMoved(m, 'gsdt-update', r.out);
    // without GSD_NO_CORE gsdt-update would go on to sync gsd-core with its already-sourced functions: not run here (npx)
  });
});

/** the 0.10.x install's files and links with what they hold, as one string */
function snap(m: Machine): string {
  const lines: string[] = [];
  const visit = (dir: string, rel: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n), r = `${rel}/${n}`;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) lines.push(`${r} -> ${readlinkSync(p)}`);
      else if (st.isDirectory()) visit(p, r);
      else lines.push(`${r} ${sha256(p)}`);
    }
  };
  visit(path.join(m.H, '.local'), '.local'); visit(path.join(m.H, '.claude'), '.claude');
  return lines.sort().join('\n');
}

test('the bridge — a failure removes nothing', { skip: SKIP_BRIDGE }, () => {
  if (!HAVE_TAG) ok('the bridge needs the v0.10.0 tag (checkout with fetch-depth: 0)', false);
  oldSetup();
  const m = oldMachine('h');
  const before = snap(m);
  const oldnode = path.join(WORK, 'oldnode');
  stubSh(oldnode, 'node', '#!/bin/sh\ncase "$*" in -v) echo v20.1.0 ;; *) echo 20 ;; esac\n', '@echo v20.1.0\r\n');
  let o = runIn(m, 'bash', [fwd(INSTALL_0100), '--agent', 'claude'], sysPath([oldnode, STUB]));
  is('node 20: the bridge exits non-zero', o.status, 1);
  has('…saying node 24 is needed', o.out, 'Node.js 24 or newer is required');
  is('…the 0.10.0 install is untouched', snap(m), before);
  ok('…no npm package', !hasPkg(m));
  if (NONODE) {
    o = runIn(m, 'bash', [fwd(INSTALL_0100), '--agent', 'claude'], SYS_NONODE());
    is('no node: the bridge exits non-zero', o.status, 1);
    is('…the 0.10.0 install is untouched', snap(m), before);
    o = runIn(m, path.join(m.H, '.local', 'bin', 'gsdt-update'), [], SYS_NONODE());
    is('no node: the 0.10.0 gsdt-update exits non-zero', o.status, 1);
    is('…and leaves its install untouched', snap(m), before);
  }
  setLatest('76.0.0');
  const sumsF = path.join(REL, 'v76.0.0', 'SHA256SUMS');
  const keep = readLF(sumsF).split('\n').filter((l) => l.includes('tar.gz'));
  writeFileSync(sumsF, `${[...keep, `${'0'.repeat(64)}  gsd-toolkit-76.0.0.tgz`].join('\n')}\n`);
  o = runIn(m, 'bash', [fwd(INSTALL_0100), '--agent', 'claude']);
  is('a bad .tgz checksum: the bridge exits non-zero', o.status, 1);
  is('…the 0.10.0 install is untouched', snap(m), before);
});
