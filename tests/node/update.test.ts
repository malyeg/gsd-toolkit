// update.test.ts — the "newer release" notice, the doctor note, gsdt-update's
// release-runtime mode (--check, gsd-core) and the release check (was tests/test-update.sh).
// CI-safe: GitHub is a curl stub. The runtime under test is installed with
// a hand-made 0.10.x-style runtime (releases/9.9.7 + links in a bin dir).
// The 0.10.x release line (the old install.sh: fresh install, update, go back,
// prune, checksum refusals, the gsd-worktrees → gsd-toolkit move) is frozen and
// no longer built here; install.test.ts runs the REAL v0.10.0 install.sh
// and gsdt-update against a 0.11.0 release, and the npm mode of gsdt-update is
// in npm.test.ts and tests/ts/p11-update.test.ts.
import { existsSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  PKG, SKIP_WIN_LINKS, baseEnv, bash, copyFromPkg, countLines, git, has, hasnt, is, launch, mkTmp, mkdirp, ok, run, stub, stubSh, tryRead,
  withHome, write,
} from './g5-helpers.ts';
import { versionGt } from '../../src/version.ts';

const WORK = mkTmp('gsdt-upd-');
const BIN = path.join(WORK, 'bin');
const RUN = path.join(WORK, 'share', 'gsd-toolkit', 'releases');
const STUB = mkdirp(path.join(WORK, 'stub'));
const CACHE = path.join(WORK, 'cache');
const HOME_ = mkdirp(path.join(WORK, 'home'));
const REL = mkdirp(path.join(WORK, 'releases-served'));   // no release is downloaded here: only the latest-version lookup
const GH = path.join(WORK, 'gh');
const LATEST = path.join(WORK, 'latest');
const CURL_LOG = path.join(WORK, 'curl.log');
const chomp = (s: string): string => s.replace(/\n+$/, '');
const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// ── version compare ──────────────────────────────────────────────────────────
test('version compare', () => {
  ok('0.10.0 > 0.9.9 (numeric, not text)', versionGt('0.10.0', '0.9.9'));
  ok('equal is not newer', !versionGt('v1.2.3', '1.2.3'));
  ok('older is not newer', !versionGt('1.2.3', '1.3.0'));
  ok('garbage is never newer', !versionGt('garbage', '1.0.0'));
  ok('zero-padded parts are not octal', versionGt('1.0.08', '1.0.7'));
});

// ── release-check ────────────────────────────────────────────────────────────
test('release-check — is this a new version?', () => {
  const RC = mkdirp(path.join(WORK, 'rc'));
  write(path.join(RC, 'CHANGELOG.md'), '# Changelog\n\n## 0.7.0\n\n- new thing\n\n## 0.6.30\n\n- other thing\n\n## 0.6.29\n\n## 0.6.2\n\n- old thing\n');
  const TAGS = 'abc\trefs/tags/v0.6.2\nabc\trefs/tags/v0.6.2^{}\n';
  const rc = (version: string, tags: string) => {
    writeFileSync(path.join(RC, 'VERSION'), `${version}\n`);
    return bash(path.join(PKG, 'tools', 'release-check.sh'), [], { cwd: RC, input: tags, env: baseEnv() });
  };
  let r = rc('0.7.0', TAGS);
  ok('a new version with notes is released', r.status === 0 && chomp(r.out) === '0.7.0', r.out);
  r = rc('0.6.2', TAGS);
  ok('a version with its tag: nothing to do', r.status === 0 && chomp(r.out) === '', r.out);
  r = rc('0.7.0', '');
  ok('no tags at all: released', r.status === 0 && chomp(r.out) === '0.7.0', r.out);
  r = rc('0.6.1', TAGS);
  ok('older than the newest tag is refused', r.status !== 0 && r.out.includes('older than the tag v0.6.2'), r.out);
  r = rc('0.8.0', TAGS);
  ok('no CHANGELOG section is refused', r.status !== 0 && r.out.includes('no notes under'), r.out);
  r = rc('0.6.29', TAGS);
  ok('an empty CHANGELOG section is refused', r.status !== 0 && r.out.includes('no notes under'), r.out);
  r = rc('0.6.3', TAGS);
  ok('0.6.3 does not read the notes of 0.6.30', r.status !== 0 && r.out.includes('no notes under'), r.out);
  r = rc('garbage', TAGS);
  ok('a bad VERSION is refused', r.status !== 0 && r.out.includes('not X.Y.Z'), r.out);
});

// ── fake GitHub ──────────────────────────────────────────────────────────────
writeFileSync(LATEST, '9.9.9\n');
stub(STUB, 'curl', `
import { appendFileSync, copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
let out = '', url = '', retry = '';
for (let i = 0; i < a.length; i++) {
  if (a[i] === '-o') out = a[++i];
  else if (a[i] === '--retry') retry = ' retry=' + a[++i];
  else if (['-H', '--max-time', '--retry-delay'].includes(a[i])) i++;
  else if (a[i].startsWith('http')) url = a[i];
}
appendFileSync(${JSON.stringify(CURL_LOG)}, url + '\\n');
const REL = ${JSON.stringify(REL)}, GH = ${JSON.stringify(GH)}, LATEST = ${JSON.stringify(LATEST)};
const readTrim = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const serve = (f) => {
  if (!existsSync(f) || !statSync(f).isFile()) process.exit(22);
  if (out) copyFileSync(f, out); else process.stdout.write(readFileSync(f));
  process.exit(0);
};
const body = (s) => { if (out) writeFileSync(out, s); else process.stdout.write(s); };
let m;
if (url === 'https://api.github.com/repos/acme/gsd-toolkit/releases/latest') {
  const v = readTrim(LATEST).replace(/\\n$/, '');
  if (v === '') process.exit(22);
  body('{"url":"x","tag_name": "v' + v + '","name":"n"}');
} else if (url.startsWith('https://github.com/acme/gsd-toolkit/releases/download/')) {
  appendFileSync(${JSON.stringify(path.join(WORK, 'curl-retry.log'))}, url + retry + '\\n');
  serve(REL + '/' + url.slice('https://github.com/acme/gsd-toolkit/releases/download/'.length));
} else if ((m = /^https:\\/\\/api\\.github\\.com\\/repos\\/(.*)\\/releases\\/latest$/.exec(url))) {
  const v = readTrim(GH + '/' + m[1] + '/latest').replace(/\\n$/, '');
  if (v === '') process.exit(22);
  body('{"tag_name": "v' + v + '"}');
} else if ((m = /^https:\\/\\/github\\.com\\/(.*?)\\/releases\\/download\\/(.*)$/.exec(url))) {
  serve(GH + '/' + m[1] + '/' + m[2]);
} else process.exit(6);
`);
// npm is a stub from the start: a background refresh must never reach this machine's real npm
stub(STUB, 'npm', `console.log('1.2.0');\n`);

type EnvX = Record<string, string | undefined>;
const state: EnvX = {};   // what the bash suite `export`ed along the way (GSD_CLI)
const hostPATH = process.env.PATH ?? process.env.Path ?? '';
function envFor(extra: EnvX = {}, home = HOME_): NodeJS.ProcessEnv {
  return withHome(baseEnv({
    GSD_NO_CORE: '1', GSD_UPDATE_REPO: 'acme/gsd-toolkit', GSD_BIN_DIR: BIN, GSD_CLAUDE_SKILL_DIR: path.join(WORK, 'skills'),
    XDG_CACHE_HOME: CACHE, PATH: [STUB, hostPATH].join(path.delimiter), ...state, ...extra,
  }), home);
}
const points = (cmd: string): string => {
  const t = readlinkSync(path.join(BIN, cmd));
  const pre = `${RUN}/`;
  return t.startsWith(pre) ? t.slice(pre.length).split('/')[0]! : t;
};
const cacheFile = (n: string): string => path.join(CACHE, 'gsd-toolkit', n);
const nonEmpty = (f: string): boolean => { try { return statSync(f).size > 0; } catch { return false; } };

const SKIP_RT = SKIP_WIN_LINKS;   // a 0.10.x runtime links its commands: POSIX only

test('an installed release runtime (9.9.7, laid out the way 0.10.x did)', { skip: SKIP_RT }, () => {
  const d = path.join(RUN, '9.9.7');
  copyFromPkg(d, ['bin', 'lib', 'src', 'shims', 'skills', 'install.sh']);
  writeFileSync(path.join(d, 'VERSION'), '9.9.7\n');
  mkdirp(BIN);
  for (const n of readdirSync(path.join(d, 'bin'))) symlinkSync(path.join(d, 'bin', n), path.join(BIN, n));
  is('commands link into releases/9.9.7', points('gsdt-list'), '9.9.7');
  is('an installed command runs', run(path.join(BIN, 'gsdt-list'), ['--help'], { env: envFor() }).status, 0);
});

test('gsdt-update --check (release runtime)', { skip: SKIP_RT }, () => {
  let r = run(path.join(BIN, 'gsdt-update'), ['--check'], { env: envFor() });
  has('--check shows the installed version', r.out, 'installed : 9.9.7');
  has('…the latest', r.out, 'latest    : 9.9.9');
  has('…and says an update is there', r.out, 'update available');
  is('--check changes nothing', points('gsdt-list'), '9.9.7');
  r = launch('update', [], { env: envFor() });
  has('a git checkout updates nothing, and names install.sh', r.out, `not a release — pull it with git; install the release with: ${PKG}/install.sh`);
});

test('the newer-release notice', { skip: SKIP_RT }, () => {
  const list = (extra: EnvX = {}) => run(path.join(BIN, 'gsdt-list'), ['--repo', path.join(WORK, 'nope')], { env: envFor({ GSD_UPDATE_NOTICE: 'always', ...extra }) });
  rmSync(CACHE, { recursive: true, force: true });
  list();
  for (let i = 0; i < 10 && !nonEmpty(cacheFile('latest-version')); i++) sleep(500);
  is('a stale cache is refreshed in the background', tryRead(cacheFile('latest-version')).trim(), '9.9.9');
  let r = list();
  has('then one line names the new release', r.stderr, 'gsd-toolkit 9.9.9 is out (you have 9.9.7) — update: gsdt-update');
  r = run(path.join(BIN, 'gsdt-list'), ['--repo', path.join(WORK, 'nope')], { env: envFor() });
  hasnt('not a terminal → no notice', r.stderr, 'is out');
  r = list({ GSD_NO_UPDATE_CHECK: '1' });
  hasnt('GSD_NO_UPDATE_CHECK=1 → no notice', r.stderr, 'is out');
  writeFileSync(CURL_LOG, '');
  list(); sleep(1000);
  is('a fresh cache → no GitHub call', countLines(tryRead(CURL_LOG), /api\.github\.com/), 0);
  // GSD itself (npm): a stub gsd-core 1.0.0 (an agent-dir install: VERSION beside
  // bin/), npm says 1.2.0. GSD_CLI pins it, so this machine's own GSD never counts.
  const gc = path.join(WORK, 'gc', 'gsd-core');
  stubSh(path.join(gc, 'bin'), 'gsd_run', `#!/usr/bin/env bash\necho '{"packageName":"@opengsd/gsd-core","version":"1.0.0"}'\n`);
  write(path.join(gc, 'VERSION'), '1.0.0\n');
  state.GSD_CLI = path.join(gc, 'bin', 'gsd_run');
  rmSync(cacheFile('latest-gsd-core-version'), { force: true });   // a real gsd-core on this machine may have filled it already
  list();
  for (let i = 0; i < 10 && !nonEmpty(cacheFile('latest-gsd-core-version')); i++) sleep(500);
  r = list();
  has('a newer GSD on npm gets its own line', r.stderr, 'GSD 1.2.0 is out (you have 1.0.0) — update: gsdt-update');
  const fresh = path.join(WORK, 'fresh');
  git(WORK, ['init', '-qb', 'main', fresh]);
  // gsdt-init needs gsdt-bootstrap-repo on PATH (the installed one, as a user has it)
  r = run(path.join(BIN, 'gsdt-init'), ['--no-launch', '--no-commit'], {
    cwd: fresh, env: envFor({ GSD_UPDATE_NOTICE: 'always', PATH: [BIN, STUB, hostPATH].join(path.delimiter) }),
  });
  has('gsdt-init tells about a newer gsd-toolkit', r.stderr, 'gsd-toolkit 9.9.9 is out');
  has('…and a newer GSD', r.stderr, 'GSD 1.2.0 is out');
});

test('gsdt-doctor — updates', { skip: SKIP_RT }, () => {
  const R = path.join(WORK, 'proj');
  mkdirp(path.join(R, '.planning')); git(WORK, ['init', '-qb', 'main', R]);
  const doctor = (args: string[], extra: EnvX = {}) => run(path.join(BIN, 'gsdt-doctor'), ['--repo', R, ...args], { env: envFor(extra) });
  let r = doctor([]);
  has('gsdt-doctor shows the newer release', r.out, 'gsd-toolkit 9.9.7 installed, 9.9.9 available — update: gsdt-update');
  r = doctor(['--quiet']);
  has('…even with --quiet (gsd-toolkit)', r.out, 'gsd-toolkit 9.9.7 installed, 9.9.9 available');
  has('…even with --quiet (GSD)', r.out, 'gsd-core 1.0.0 installed, 1.2.0 available — update: gsdt-update');
  r = doctor(['--json']);
  let got: Record<string, string> | null = null;
  try {
    const d = JSON.parse(r.stdout) as { updates: Array<{ name: string; latest: string }> };
    got = Object.fromEntries(d.updates.map((x) => [x.name, x.latest]));
  } catch { /* not JSON */ }
  ok('--json lists both under updates (valid JSON)', got !== null && got['gsd-toolkit'] === '9.9.9' && got['gsd-core'] === '1.2.0' && Object.keys(got).length === 2, r.stdout.slice(0, 300));
  r = doctor(['--quiet'], { GSD_NO_UPDATE_CHECK: '1' });
  hasnt('GSD_NO_UPDATE_CHECK=1 → no update lines', r.out, 'available — update');
});

test('gsdt-update — gsd-core too', { skip: SKIP_RT }, () => {
  writeFileSync(LATEST, '9.9.7\n');   // the toolkit is on the latest: only gsd-core is behind
  // A throwaway HOME with gsd-core 1.0.0 for claude; npm says 1.2.0; a stub
  // npx (the gsd-core installer) records its args and writes 1.2.0.
  const CH = mkdirp(path.join(WORK, 'corehome'));
  const NPX = path.join(WORK, 'npx'), NPX_LOG = path.join(WORK, 'npx.log');
  stubSh(path.join(CH, '.claude', 'gsd-core', 'bin'), 'gsd_run', '#!/bin/sh\n');
  write(path.join(CH, '.claude', 'gsd-core', 'VERSION'), '1.0.0\n');
  stub(NPX, 'npx', `
import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(NPX_LOG)}, process.argv.slice(2).join(' ') + '\\n');
writeFileSync(process.env.HOME + '/.claude/gsd-core/VERSION', '1.2.0\\n');
`);
  const cup = (args: string[]) => run(path.join(BIN, 'gsdt-update'), args, {
    env: envFor({ GSD_NO_CORE: undefined, CLAUDE_CONFIG_DIR: undefined, PATH: [NPX, STUB, hostPATH].join(path.delimiter) }, CH),
  });
  let r = cup(['--check']);
  has('--check shows gsd-core per agent', r.out, 'gsd-core  : claude 1.0.0, latest 1.2.0');
  has('…and that an update is there', r.out, 'update available');
  ok('--check runs no installer', !existsSync(NPX_LOG));
  r = cup(['--no-core']);
  ok('--no-core leaves gsd-core alone', !existsSync(NPX_LOG));
  r = cup([]);
  is('gsdt-update updates gsd-core', tryRead(path.join(CH, '.claude', 'gsd-core', 'VERSION')).trim(), '1.2.0');
  is('…with the full profile', chomp(tryRead(NPX_LOG)), '-y --package=@opengsd/gsd-core@latest -- gsd-core --claude --global --profile=full');
  has('…saying so', r.out, 'updating gsd-core for claude (1.0.0 → 1.2.0)');
  r = cup([]);
  has('on the latest → left alone', r.out, 'claude gsd-core 1.2.0 is the latest');
  is('…no second run', countLines(tryRead(NPX_LOG), /./), 1);
});
