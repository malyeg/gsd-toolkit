// P11 (gsdt-update + the update notice): the TypeScript command behind bin/gsdt-update against the
// bash one (tests/fixtures/p11-old-bins/gsdt-update, the oracle), for a git checkout and a GitHub
// release runtime, with the stubs tests/test-update.sh uses (curl for GitHub, npm for gsd-core, an
// install.sh that only logs what it was given). Then the new npm mode, on a fake npm package dir
// (an npm stub on PATH; its src/launch.mjs logs `setup`), the update notice from the npm stub and
// from the caches, and that notice against bash's gsd_update_notice.
// Every run has its own HOME/XDG_*; no real npm install is ever run.
// Run: node --test tests/ts/p11-update.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PKG } from './helpers.ts';

const W = realpathSync(mkdtempSync(path.join(tmpdir(), 'gsd-p11u-')));
process.on('exit', () => rmSync(W, { recursive: true, force: true }));
const REAL_PATH = (process.env.PATH ?? '').split(path.delimiter).filter((d) => !d.endsWith('/.local/bin')).join(path.delimiter);

// ── stubs ─────────────────────────────────────────────────────────────────────
const STUBBIN = path.join(W, 'stubbin');
mkdirSync(STUBBIN);
const stub = (name: string, body: string): void => writeFileSync(path.join(STUBBIN, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
stub('curl', 'echo "$*" >> "$STUB/curl.log"\ncase "$*" in\n  *releases/latest*) [ -s "$STUB/latest" ] || exit 22; printf \'{"tag_name": "v%s"}\' "$(cat "$STUB/latest")" ;;\n  *) exit 6 ;;\nesac');
stub(
  'npm',
  `echo "$*" >> "$STUB/npm.log"
case "$1 $2" in
  "view gsd-toolkit") [ -s "$STUB/npm-toolkit" ] || exit 1; cat "$STUB/npm-toolkit" ;;
  "view @opengsd/gsd-core") [ -s "$STUB/npm-core" ] || exit 1; cat "$STUB/npm-core" ;;
  "install -g") echo "npm: installing $3"; [ -z "$NPM_INSTALL_RC" ] || { echo "npm ERR! boom" >&2; exit "$NPM_INSTALL_RC"; } ;;
  *) exit 1 ;;
esac`,
);
stub('npx', 'echo "$*" >> "$STUB/npx.log"\nmkdir -p "$HOME/.claude/gsd-core/bin"\n[ -f "$HOME/.claude/gsd-core/bin/gsd_run" ] || { printf "#!/bin/sh\\n" > "$HOME/.claude/gsd-core/bin/gsd_run"; chmod +x "$HOME/.claude/gsd-core/bin/gsd_run"; }\nprintf "1.2.0\\n" > "$HOME/.claude/gsd-core/VERSION"');

let seq = 0;
type Scn = {
  latest?: string; // GitHub latest
  npmToolkit?: string;
  npmCore?: string;
  core?: boolean; // run the gsd-core part (else GSD_NO_CORE=1)
  haveCore?: string; // gsd-core installed for claude in HOME
  manifest?: string; // body of the manifest file
  env?: Record<string, string>;
  installRc?: number; // the stub install.sh's exit
  npmInstallRc?: number;
};
type Ctx = { stub: string; home: string; env: NodeJS.ProcessEnv };

function ctx(s: Scn): Ctx {
  const d = path.join(W, `run-${seq++}`);
  const st = path.join(d, 'stub');
  const home = path.join(d, 'home');
  mkdirSync(st, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (s.latest) writeFileSync(path.join(st, 'latest'), `${s.latest}\n`);
  if (s.npmToolkit) writeFileSync(path.join(st, 'npm-toolkit'), `${s.npmToolkit}\n`);
  if (s.npmCore) writeFileSync(path.join(st, 'npm-core'), `${s.npmCore}\n`);
  if (s.haveCore) {
    mkdirSync(path.join(home, '.claude/gsd-core/bin'), { recursive: true });
    writeFileSync(path.join(home, '.claude/gsd-core/bin/gsd_run'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(path.join(home, '.claude/gsd-core/VERSION'), `${s.haveCore}\n`);
  }
  const env: NodeJS.ProcessEnv = {
    PATH: `${STUBBIN}:${REAL_PATH}`,
    HOME: home,
    XDG_CACHE_HOME: path.join(d, 'cache'),
    XDG_CONFIG_HOME: path.join(d, 'config'),
    GSD_UPDATE_REPO: 'acme/gsd-toolkit',
    STUB: st,
    LANG: 'en_US.UTF-8',
    ...(s.core ? {} : { GSD_NO_CORE: '1' }),
    ...(s.installRc ? { INSTALL_RC: String(s.installRc) } : {}),
    ...(s.npmInstallRc ? { NPM_INSTALL_RC: String(s.npmInstallRc) } : {}),
    ...s.env,
  };
  if (s.manifest !== undefined) {
    mkdirSync(path.join(d, 'config/gsd'), { recursive: true });
    writeFileSync(path.join(d, 'config/gsd/setup-manifest'), s.manifest);
  }
  return { stub: st, home, env };
}
const readOr = (f: string): string => (existsSync(f) ? readFileSync(f, 'utf8') : '');
type Res = { out: string; err: string; rc: number };
function exec(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Res {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env, cwd });
  return { out: r.stdout ?? '', err: r.stderr ?? '', rc: r.status ?? 1 };
}

// ── parity runtimes: old (bash) and new (TS), as a release (symlinked, in releases/) and as a copy ──
const INSTALL_STUB = '#!/bin/sh\n{ echo "install.sh $*"; echo "GSD_BIN_DIR=$GSD_BIN_DIR"; echo "GSD_RELEASES_DIR=$GSD_RELEASES_DIR"; } >> "$STUB/install.log"\nexit "${INSTALL_RC:-0}"\n';
type Side = 'old' | 'neu';
const SIDES: Side[] = ['old', 'neu'];
const runtimes: Record<string, { pkg: string; bin: string; link: string }> = {};
function build(side: Side, kind: 'release' | 'copy'): void {
  const root = path.join(W, side, kind);
  const pkg = kind === 'release' ? path.join(root, 'share/gsd-toolkit/releases/1.0.0') : path.join(root, 'rt');
  mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  cpSync(path.join(PKG, 'lib'), path.join(pkg, 'lib'), { recursive: true });
  cpSync(path.join(PKG, 'src'), path.join(pkg, 'src'), { recursive: true });
  writeFileSync(path.join(pkg, 'VERSION'), '1.0.0\n');
  writeFileSync(path.join(pkg, 'install.sh'), INSTALL_STUB, { mode: 0o755 });
  const own = path.join(pkg, 'bin/gsdt-update');
  cpSync(side === 'old' ? path.join(PKG, 'tests/fixtures/p11-old-bins/gsdt-update') : path.join(PKG, 'bin/gsdt-update'), own);
  chmodSync(own, 0o755);
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(own, path.join(bin, 'gsdt-update'));
  runtimes[`${side}-${kind}`] = { pkg, bin, link: path.join(bin, 'gsdt-update') };
}
for (const s of SIDES) for (const k of ['release', 'copy'] as const) build(s, k);

const norm = (s: string, side: Side): string => s.split(path.join(W, side)).join('<R>').replace(/\/run-\d+\//g, '/run-N/');
function runSide(side: Side, kind: 'release' | 'copy', how: 'link' | 'direct', args: string[], sc: Scn, git = false): Res & { install: string; npm: string; npx: string; cache: string; manifest: string } {
  const rt = runtimes[`${side}-${kind}`] as { pkg: string; bin: string; link: string };
  const c = ctx(sc);
  const env = { ...c.env, GSD_BIN_DIR: c.env.GSD_BIN_DIR ?? rt.bin, ...(sc.env ?? {}) };
  // The bash exits silently (set -e + pipefail on sed) when the manifest is missing; every real install has one.
  // The TS carries on with claude (its own test below), so both sides get a manifest here.
  const mdir = how === 'link' ? rt.bin : env.GSD_BIN_DIR === '' ? path.join(c.home, '.local/bin') : (env.GSD_BIN_DIR as string);
  mkdirSync(mdir, { recursive: true });
  writeFileSync(path.join(mdir, '.gsd-install-manifest'), sc.manifest ?? 'providers\tclaude\nuser_hook\t1\n');
  if (git) mkdirSync(path.join(rt.pkg, '.git'));
  try {
    const r = exec(how === 'link' ? rt.link : path.join(rt.pkg, 'bin/gsdt-update'), args, env);
    const cacheF = path.join(c.env.XDG_CACHE_HOME as string, 'gsd-toolkit');
    return {
      out: norm(r.out, side),
      err: norm(r.err, side),
      rc: r.rc,
      install: norm(readOr(path.join(c.stub, 'install.log')), side),
      npm: readOr(path.join(c.stub, 'npm.log')),
      npx: readOr(path.join(c.stub, 'npx.log')),
      cache: `${readOr(path.join(cacheF, 'latest-version'))}|${readOr(path.join(cacheF, 'latest-gsd-core-version'))}`,
      manifest: '',
    };
  } finally {
    if (git) rmSync(path.join(rt.pkg, '.git'), { recursive: true, force: true });
    rmSync(path.join(mdir, '.gsd-install-manifest'), { force: true });
  }
}
function same(name: string, kind: 'release' | 'copy', how: 'link' | 'direct', args: string[], sc: Scn, git = false, expectRc?: number): void {
  test(`parity ${kind}${git ? '+git' : ''}/${how}: ${name}`, () => {
    const o = runSide('old', kind, how, args, sc, git);
    const n = runSide('neu', kind, how, args, sc, git);
    assert.equal(n.out, o.out, 'stdout');
    assert.equal(n.err, o.err, 'stderr');
    assert.equal(n.rc, o.rc, 'exit code');
    assert.equal(n.install, o.install, 'install.sh call');
    assert.equal(n.npm, o.npm, 'npm calls');
    assert.equal(n.npx, o.npx, 'npx calls');
    assert.equal(n.cache, o.cache, 'caches');
    if (expectRc !== undefined) assert.equal(n.rc, expectRc);
  });
}

same('--help', 'release', 'link', ['--help'], {}, false, 0);
same('-h', 'release', 'link', ['-h'], {});
same('unknown option', 'release', 'link', ['--nope'], {}, false, 1);
same('--version without value', 'release', 'link', ['--version'], {}, false, 1);
same('--check: newer', 'release', 'link', ['--check'], { latest: '1.1.0' }, false, 0);
same('-n: same version', 'release', 'link', ['-n'], { latest: '1.0.0' }, false, 0);
same('--check: older latest', 'release', 'link', ['--check'], { latest: '0.9.0' });
same('--check: offline', 'release', 'link', ['--check'], {}, false, 0);
same('update: newer → install.sh', 'release', 'link', [], { latest: '1.1.0' }, false, 0);
same('update: newer, GSD_BIN_DIR elsewhere (the link dir wins)', 'release', 'link', [], { latest: '1.1.0', env: { GSD_BIN_DIR: path.join(W, 'elsewhere/bin') } });
same('update: same → up to date', 'release', 'link', [], { latest: '1.0.0' }, false, 0);
same('update: offline, no core → refused', 'release', 'link', [], {}, false, 1);
same('update: offline, with core', 'release', 'link', [], { core: true, haveCore: '1.2.0', npmCore: '1.2.0' });
same('update: install.sh fails (its status)', 'release', 'link', [], { latest: '1.1.0', installRc: 3 }, false, 3);
same('--version X', 'release', 'link', ['--version', '1.0.5'], { latest: '1.0.0' });
same('--version vX (a leading v is dropped)', 'release', 'link', ['--version', 'v0.9.9'], {});
same('--version with --no-core after', 'release', 'link', ['--version', '1.2.3', '--no-core'], { core: true });
same('--no-core', 'release', 'link', ['--no-core'], { latest: '1.1.0', core: true, haveCore: '1.0.0', npmCore: '1.2.0' });
same('manifest agents, core behind', 'release', 'link', ['--check'], { core: true, haveCore: '1.0.0', npmCore: '1.2.0', manifest: 'providers\tclaude,codex\nuser_hook\t1\n' }, false, 0);
same('core update via npx', 'release', 'link', [], { latest: '1.0.0', core: true, haveCore: '1.0.0', npmCore: '1.2.0' });
same('core on the latest', 'release', 'link', [], { latest: '1.0.0', core: true, haveCore: '1.2.0', npmCore: '1.2.0' });
same('core not installed, npm offline', 'release', 'link', ['--check'], { latest: '1.0.0', core: true });
same('empty providers line → claude', 'release', 'link', ['--check'], { core: true, haveCore: '1.2.0', npmCore: '1.2.0', manifest: 'providers\t\n' });
same('a copy runtime (not under releases/): GSD_RELEASES_DIR passes through', 'copy', 'direct', [], { latest: '1.1.0', env: { GSD_RELEASES_DIR: '/my/releases' } });
same('a copy runtime run directly: GSD_BIN_DIR from the env', 'copy', 'direct', [], { latest: '1.1.0', env: { GSD_BIN_DIR: path.join(W, 'mybin') } });
same('a copy runtime run directly, no GSD_BIN_DIR → ~/.local/bin', 'copy', 'direct', ['--check'], { latest: '1.1.0', core: true, haveCore: '1.2.0', npmCore: '1.2.0', env: { GSD_BIN_DIR: '' } });
same('a copy runtime run directly, no GSD_BIN_DIR: install.sh gets ~/.local/bin', 'copy', 'direct', [], { latest: '1.1.0', env: { GSD_BIN_DIR: '' } });
// a checkout updates nothing
same('checkout: default', 'copy', 'direct', [], { latest: '1.1.0' }, true, 0);
same('checkout: --check', 'copy', 'direct', ['--check'], { latest: '1.1.0' }, true, 0);
same('checkout: offline', 'copy', 'direct', [], {}, true, 0);
same('checkout: --version still only says so', 'copy', 'direct', ['--version', '1.0.5'], { latest: '1.1.0' }, true, 0);

// ── npm mode: a package dir without .git and install.sh ────────────────────────
const NPMPKG = path.join(W, 'npmpkg');
mkdirSync(NPMPKG);
cpSync(path.join(PKG, 'src'), path.join(NPMPKG, 'src'), { recursive: true });
cpSync(path.join(PKG, 'lib'), path.join(NPMPKG, 'lib'), { recursive: true });
writeFileSync(path.join(NPMPKG, 'VERSION'), '1.0.0\n');
renameSync(path.join(NPMPKG, 'src/launch.mjs'), path.join(NPMPKG, 'src/launch-real.mjs'));
// `setup` is logged (what an npm update runs after the install); everything else is the real launcher
writeFileSync(
  path.join(NPMPKG, 'src/launch.mjs'),
  `import { appendFileSync } from 'node:fs';
if (process.argv[2] === 'setup') {
  appendFileSync(process.env.STUB + '/setup.log', process.argv.slice(2).join(' ') + '\\n');
  console.log('setup: ran');
  process.exit(Number(process.env.SETUP_RC || 0));
}
await import('./launch-real.mjs');
`,
);
function npmRun(args: string[], sc: Scn): Res & { npm: string; setup: string; npx: string; cache: string; c: Ctx } {
  const c = ctx(sc);
  // run through launch.mjs (the wrapper), as the npm bin entry does
  const r = exec(process.execPath, [path.join(NPMPKG, 'src/launch.mjs'), 'update', ...args], c.env);
  const cacheF = path.join(c.env.XDG_CACHE_HOME as string, 'gsd-toolkit');
  return {
    ...r,
    npm: readOr(path.join(c.stub, 'npm.log')),
    setup: readOr(path.join(c.stub, 'setup.log')),
    npx: readOr(path.join(c.stub, 'npx.log')),
    cache: `${readOr(path.join(cacheF, 'latest-version'))}|${readOr(path.join(cacheF, 'latest-gsd-core-version'))}`,
    c,
  };
}

test('npm: --check with a newer version', () => {
  const r = npmRun(['--check'], { npmToolkit: '1.1.0' });
  assert.equal(r.rc, 0);
  assert.equal(r.out, `installed : 1.0.0  (${NPMPKG})\nlatest    : 1.1.0  (npm gsd-toolkit)\n▶ update available: gsdt-update\n`);
  assert.equal(r.npm, 'view gsd-toolkit version --fetch-retries=0 --fetch-timeout=5000\n');
  assert.equal(r.cache, '1.1.0\n|');
  assert.equal(r.setup, '');
});
test('npm: --check on the latest, and with npm unreachable', () => {
  const a = npmRun(['--check'], { npmToolkit: '1.0.0' });
  assert.match(a.out, /✔ up to date\n$/);
  const b = npmRun(['--check'], {});
  assert.match(b.out, /latest    : unknown \(npm not reachable\)  \(npm gsd-toolkit\)\n✔ up to date\n$/);
});
test('npm: update installs the version, then the new package setup, then reports', () => {
  const r = npmRun([], { npmToolkit: '1.1.0' });
  assert.equal(r.rc, 0, r.err);
  assert.match(r.out, /▶ npm install -g gsd-toolkit@1\.1\.0\nnpm: installing gsd-toolkit@1\.1\.0\n✔ gsd-toolkit@1\.1\.0 installed\nsetup: ran\n$/);
  assert.equal(r.npm, 'view gsd-toolkit version --fetch-retries=0 --fetch-timeout=5000\ninstall -g gsd-toolkit@1.1.0\n');
  assert.equal(r.setup, 'setup --no-core\n');
});
test('npm: already the latest → nothing installed', () => {
  const r = npmRun([], { npmToolkit: '1.0.0' });
  assert.equal(r.rc, 0);
  assert.match(r.out, /✔ gsd-toolkit is up to date\n$/);
  assert.doesNotMatch(r.npm, /install/);
  assert.equal(r.setup, '');
});
test('npm: --version installs that version (also older) and a leading v is dropped', () => {
  const r = npmRun(['--version', 'v0.9.0'], { npmToolkit: '1.0.0' });
  assert.equal(r.rc, 0, r.err);
  assert.match(r.npm, /install -g gsd-toolkit@0\.9\.0\n$/);
  assert.equal(r.setup, 'setup --no-core\n');
});
test('npm: --version that is not X.Y.Z is refused before npm runs', () => {
  const r = npmRun(['--version', 'latest'], { npmToolkit: '1.1.0' });
  assert.equal(r.rc, 1);
  assert.equal(r.err, 'gsdt-update: --version needs X.Y.Z\n');
  assert.doesNotMatch(r.npm, /install/);
});
test('npm: a failed npm install prints the command and exits 1, no setup, gsd-core untouched', () => {
  const r = npmRun([], { npmToolkit: '1.1.0', npmInstallRc: 7, core: true, haveCore: '1.0.0', npmCore: '1.2.0' });
  assert.equal(r.rc, 1);
  assert.match(r.err, /npm ERR! boom\n/);
  assert.match(r.err, /⚠ npm install failed \(exit 7\); run:  npm install -g gsd-toolkit@1\.1\.0\n$/);
  assert.equal(r.setup, '');
  assert.equal(r.npx, '');
});
test('npm: a failed setup is reported, exit 1, gsd-core still synced', () => {
  const r = npmRun([], { npmToolkit: '1.1.0', env: { SETUP_RC: '4' }, core: true, haveCore: '1.0.0', npmCore: '1.2.0' });
  assert.equal(r.rc, 1);
  assert.match(r.err, /⚠ gsdt-setup failed \(exit 4\); run:  gsdt-setup --no-core\n$/);
  assert.match(r.npx, /gsd-core --claude --global --profile=full/);
});
test('npm: offline → refused with --no-core, a note otherwise; --version still installs', () => {
  const a = npmRun([], {});
  assert.equal(a.rc, 1);
  assert.equal(a.err, 'gsdt-update: cannot find the latest version — try again online, or pass --version X.Y.Z\n');
  const b = npmRun([], { core: true, haveCore: '1.2.0', npmCore: '1.2.0' });
  assert.equal(b.rc, 0);
  assert.match(b.out, /• gsd-toolkit not checked \(npm not reachable\)\n/);
  const c = npmRun(['--version', '1.0.1'], {});
  assert.equal(c.rc, 0);
  assert.match(c.npm, /install -g gsd-toolkit@1\.0\.1\n$/);
});
test('npm: gsd-core agents come from the setup manifest, else claude', () => {
  const a = npmRun(['--check'], { npmToolkit: '1.0.0', core: true, haveCore: '1.0.0', npmCore: '1.2.0', manifest: 'providers\tclaude,codex\nbin\t/x\n' });
  assert.match(a.out, /gsd-core  : claude 1\.0\.0, latest 1\.2\.0\ngsd-core  : codex not installed, latest 1\.2\.0\n▶ update available: gsdt-update\n$/);
  assert.equal(a.cache, '1.0.0\n|1.2.0\n');
  const b = npmRun(['--check'], { npmToolkit: '1.0.0', core: true, haveCore: '1.2.0', npmCore: '1.2.0' });
  assert.match(b.out, /gsd-core  : claude 1\.2\.0, latest 1\.2\.0\n✔ up to date\n$/);
  assert.doesNotMatch(b.out, /codex/);
});
test('release without a manifest: carries on with claude (the bash stopped silently there)', () => {
  const rt = runtimes['neu-release'] as { pkg: string; bin: string; link: string };
  const c = ctx({ latest: '1.0.0', core: true, haveCore: '1.2.0', npmCore: '1.2.0' });
  const r = exec(rt.link, ['--check'], { ...c.env, GSD_BIN_DIR: rt.bin });
  assert.equal(r.rc, 0);
  assert.match(r.out, /gsd-core  : claude 1\.2\.0, latest 1\.2\.0\n✔ up to date\n$/);
});
test('npm: --help adds the npm note; the other modes do not', () => {
  const r = npmRun(['--help'], {});
  assert.equal(r.rc, 0);
  assert.match(r.out, /Installed from npm \(npm i -g gsd-toolkit\)/);
  const old = runSide('neu', 'release', 'link', ['--help'], {});
  assert.doesNotMatch(old.out, /Installed from npm/);
});

// ── the notice ─────────────────────────────────────────────────────────────────
function notice(pkg: string, env: NodeJS.ProcessEnv): Res {
  return exec(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(path.join(pkg, 'src/version.ts'))}); m.updateNotice();`], env);
}
function waitFor(f: string, ms = 8000): void {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (existsSync(f) && readFileSync(f, 'utf8').trim() !== '') return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}
const ALWAYS = { GSD_UPDATE_NOTICE: 'always' };

test('notice (npm): a stale cache refreshes in the background from npm, then one line names the version', () => {
  const c = ctx({ npmToolkit: '1.1.0' });
  const cacheF = path.join(c.env.XDG_CACHE_HOME as string, 'gsd-toolkit/latest-version');
  const first = notice(NPMPKG, { ...c.env, ...ALWAYS });
  assert.equal(first.err, '', 'nothing known yet');
  waitFor(cacheF);
  assert.equal(readOr(cacheF), '1.1.0\n');
  const second = notice(NPMPKG, { ...c.env, ...ALWAYS });
  assert.equal(second.err, '• gsd-toolkit 1.1.0 is out (you have 1.0.0) — update: gsdt-update\n');
  const calls = readOr(path.join(c.stub, 'npm.log')).split('\n').filter((l) => l.startsWith('view gsd-toolkit')).length;
  assert.equal(calls, 1, 'a fresh cache → no second npm call');
});
test('notice: not a terminal, or GSD_NO_UPDATE_CHECK → silent and no refresh', () => {
  const c = ctx({ npmToolkit: '1.1.0' });
  assert.equal(notice(NPMPKG, c.env).err, '');
  assert.equal(notice(NPMPKG, { ...c.env, ...ALWAYS, GSD_NO_UPDATE_CHECK: '1' }).err, '');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  assert.equal(readOr(path.join(c.stub, 'npm.log')), '');
});
test('notice (npm): GSD itself gets its own line, from the gsd-core cache', () => {
  const c = ctx({ npmToolkit: '1.0.0', npmCore: '1.2.0' });
  const gc = path.join(W, 'gc-npm');
  mkdirSync(path.join(gc, 'gsd-core/bin'), { recursive: true });
  writeFileSync(path.join(gc, 'gsd-core/bin/gsd_run'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(path.join(gc, 'gsd-core/VERSION'), '1.0.0\n');
  const env = { ...c.env, ...ALWAYS, GSD_CLI: path.join(gc, 'gsd-core/bin/gsd_run') };
  notice(NPMPKG, env);
  waitFor(path.join(c.env.XDG_CACHE_HOME as string, 'gsd-toolkit/latest-gsd-core-version'));
  const r = notice(NPMPKG, env);
  assert.equal(r.err, '• GSD 1.2.0 is out (you have 1.0.0) — update: gsdt-update\n');
});

// the same caches through bash's gsd_update_notice and the TS one, stale caches left alone (fresh files)
function bashNotice(pkg: string, env: NodeJS.ProcessEnv): Res {
  return exec('bash', ['-c', '. "$GSD_PKG/lib/common.sh"; . "$GSD_PKG/lib/version.sh"; gsd_update_notice'], { ...env, GSD_PKG: pkg });
}
const cases: Array<{ name: string; tool?: string; core?: string; haveCore?: string; gitDir?: boolean }> = [
  { name: 'both newer', tool: '9.0.0', core: '1.2.0', haveCore: '1.0.0' },
  { name: 'toolkit only', tool: '9.0.0' },
  { name: 'toolkit equal, gsd-core older', tool: '1.0.0', core: '1.2.0', haveCore: '1.0.0' },
  { name: 'gsd-core cache but not installed', core: '1.2.0' },
  { name: 'garbage cache', tool: 'garbage', core: 'x', haveCore: '1.0.0' },
  { name: 'nothing cached' },
  { name: 'a git checkout names its install.sh', tool: '9.0.0', core: '1.2.0', haveCore: '1.0.0', gitDir: true },
];
for (const k of cases) {
  test(`notice parity with bash: ${k.name}`, () => {
    const outs: string[] = [];
    for (const side of SIDES) {
      const rt = runtimes[`${side}-copy`] as { pkg: string };
      const c = ctx({});
      const cd = path.join(c.env.XDG_CACHE_HOME as string, 'gsd-toolkit');
      mkdirSync(cd, { recursive: true });
      const fresh = (f: string, v: string): void => {
        writeFileSync(path.join(cd, f), `${v}\n`);
        const now = new Date();
        utimesSync(path.join(cd, f), now, now);
      };
      if (k.tool) fresh('latest-version', k.tool);
      else fresh('latest-version', '');
      if (k.core !== undefined) fresh('latest-gsd-core-version', k.core);
      const env: NodeJS.ProcessEnv = { ...c.env, ...ALWAYS };
      if (k.haveCore) {
        const gc = path.join(c.home, 'gc');
        mkdirSync(path.join(gc, 'gsd-core/bin'), { recursive: true });
        writeFileSync(path.join(gc, 'gsd-core/bin/gsd_run'), '#!/bin/sh\n', { mode: 0o755 });
        writeFileSync(path.join(gc, 'gsd-core/VERSION'), `${k.haveCore}\n`);
        env.GSD_CLI = path.join(gc, 'gsd-core/bin/gsd_run');
      }
      if (k.gitDir) mkdirSync(path.join(rt.pkg, '.git'));
      try {
        const r = side === 'old' ? bashNotice(rt.pkg, env) : notice(rt.pkg, env);
        outs.push(norm(r.err, side));
      } finally {
        if (k.gitDir) rmSync(path.join(rt.pkg, '.git'), { recursive: true, force: true });
      }
    }
    assert.equal(outs[1], outs[0]);
  });
}
test('notice (release, GitHub): stale cache refreshed in the background through curl', () => {
  const rt = runtimes['neu-copy'] as { pkg: string };
  const c = ctx({ latest: '9.0.0' });
  const cacheF = path.join(c.env.XDG_CACHE_HOME as string, 'gsd-toolkit/latest-version');
  assert.equal(notice(rt.pkg, { ...c.env, ...ALWAYS }).err, '');
  waitFor(cacheF);
  assert.equal(readOr(cacheF), '9.0.0\n');
  assert.equal(notice(rt.pkg, { ...c.env, ...ALWAYS }).err, '• gsd-toolkit 9.0.0 is out (you have 1.0.0) — update: gsdt-update\n');
  assert.match(readOr(path.join(c.stub, 'curl.log')), /api\.github\.com\/repos\/acme\/gsd-toolkit\/releases\/latest/);
  assert.doesNotMatch(readOr(path.join(c.stub, 'npm.log')), /view gsd-toolkit/, 'this toolkit is not asked of npm for a release runtime');
});
test('notice: offline keeps the old value and waits a day (the file is touched)', () => {
  const rt = runtimes['neu-copy'] as { pkg: string };
  const c = ctx({});
  const cd = path.join(c.env.XDG_CACHE_HOME as string, 'gsd-toolkit');
  mkdirSync(cd, { recursive: true });
  const f = path.join(cd, 'latest-version');
  writeFileSync(f, '9.0.0\n');
  const old = new Date(Date.now() - 3 * 86400 * 1000);
  utimesSync(f, old, old);
  notice(rt.pkg, { ...c.env, ...ALWAYS });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && Date.now() - statSync(f).mtimeMs > 3600 * 1000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  assert.equal(readOr(f), '9.0.0\n', 'the old value stays');
  assert.ok(Date.now() - statSync(f).mtimeMs < 3600 * 1000, 'touched, so the next check waits a day');
});
