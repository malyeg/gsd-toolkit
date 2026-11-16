// npm.test.ts — the npm package, as users get it (was tests/test-npm.sh): `npm pack`
// this checkout (prepack builds dist/), `npm install -g` the tarball into a throwaway
// prefix, then run the installed commands with NOTHING from the checkout on PATH:
// package contents, every entry, the merge driver in a real merge, the guard hook,
// doctor in a set-up repo, gsdt-setup (skills, user hooks, moving a 0.10.x install
// off ~/.local/bin) and gsdt-update's npm mode (curl and npm stubbed).
// Needs node >= 24, npm and the dev dependencies (npm ci) for the build.
import { copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  HAVE_NPM, HAVE_TSC, PKG, SKIP_WIN_LINKS, WIN, baseEnv, countLines, fwd, git, gitOk, has, hasnt, is, isLink, lexists, link, mkTmp,
  mkdirp, npm, ok, read, readLF, run, stub, sums, sysPath, tarList, tryRead, whichHost, withHome, write,
} from './g5-helpers.ts';


const SKIP = !HAVE_NPM && 'needs node and npm';
const WORK = mkTmp('gsdt-npm-');
const PFX = path.join(WORK, 'pfx');
const BINDIR = WIN ? PFX : path.join(PFX, 'bin');
const VER = readLF(path.join(PKG, 'VERSION')).split('\n')[0]!;
const npmEnv = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  baseEnv({
    GSD_NO_UPDATE_CHECK: '1', GSD_NO_CORE: '1', npm_config_cache: path.join(WORK, 'npm-cache'),
    npm_config_offline: 'true', npm_config_update_notifier: 'false', ...extra,
  });
// the installed commands, with only the system tools and node on PATH (no checkout bin/)
const PATHV = sysPath([BINDIR]);
const H0 = mkdirp(path.join(WORK, 'home0'));   // a throwaway HOME for the commands that read one
const instEnv = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  withHome(npmEnv({ PATH: PATHV, XDG_CONFIG_HOME: path.join(H0, '.config'), XDG_CACHE_HOME: path.join(H0, '.cache'), ...extra }), H0);
/** run an installed command found on the env's PATH, as a user's shell would */
function inst(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = instEnv(), input = '') {
  const found = WIN ? name : whichHost(name, env.PATH) ?? name;
  return run(found, args, { cwd, env, input });
}

type Packed = { tgz: string; tgzName: string; list: string[]; want: string[] };
let packed: Packed | null = null;
function pack(): Packed {
  if (packed) return packed;
  ok('dev dependencies installed (run: npm ci)', HAVE_TSC);
  const r = npm(['pack', '--silent', '--pack-destination', WORK], { cwd: PKG, env: npmEnv({ PATH: sysPath() }) });
  const name = r.stdout.trim().split('\n').pop() ?? '';
  const tgz = path.join(WORK, name);
  ok(`npm pack built ${name}`, name !== '' && existsSync(tgz), r.out);
  const files = readdirSync(path.join(PKG, 'bin'));
  const want = [...new Set([...files, 'gsdt-setup'])].sort();
  packed = { tgz, tgzName: name, list: tarList(tgz).map((l) => l.replace(/^package\//, '')), want };
  return packed;
}
let installed: { ipkg: string } | null = null;
function install(): { ipkg: string } {
  if (installed) return installed;
  const { tgz } = pack();
  const r = npm(['install', '-g', '--prefix', PFX, '--offline', '--no-audit', '--no-fund', '--silent', tgz], { env: npmEnv({ PATH: sysPath() }) });
  ok('npm install -g', r.status === 0, r.out);
  const pkgDir = WIN ? path.join(PFX, 'node_modules', 'gsd-toolkit') : path.join(PFX, 'lib', 'node_modules', 'gsd-toolkit');
  ok(`installed at ${pkgDir}`, existsSync(pkgDir));
  installed = { ipkg: realpathSync.native(pkgDir) };
  return installed;
}

test('pack', { skip: SKIP }, () => {
  const { tgzName, list, want } = pack();
  ok(`npm pack built ${tgzName}`, tgzName.endsWith('.tgz'));
  const pj = JSON.parse(read(path.join(PKG, 'package.json'))) as { version: string; bin: Record<string, string> };
  is('package.json version = VERSION', pj.version, VER);
  is('package.json bin = bin/* + gsdt-setup', Object.keys(pj.bin).sort().join(' '), want.join(' '));
  const miss = want.filter((n) => !list.includes(`dist/bin/${n}.js`));
  is('every bin entry is in the tarball', miss.join(' '), '');
  for (const f of ['src/launch.mjs', 'dist/commands/start.js', 'dist/tracker/cli.js', 'shims/scripts/hooks/gsdt-worktree-guard.sh',
    'skills/gsdt-flow/SKILL.md', 'lib/vendor/axe-core/axe.min.js', 'VERSION', 'LICENSE']) {
    ok(`ships ${f}`, list.includes(f));
  }
  is('no TypeScript sources shipped', list.filter((l) => /\.ts$/.test(l)).length, 0);
  is('no bash/python/perl libs shipped', list.filter((l) => /^lib\/[^/]+\.(sh|py|pl)$|^lib\/tracker\//.test(l)).length, 0);
  is('no tests or install.sh shipped', list.filter((l) => /^tests\/|^install\.sh$|^tools\//.test(l)).length, 0);
});

test('install -g into a throwaway prefix', { skip: SKIP }, () => {
  const { ipkg } = install();
  const { want } = pack();
  const badLink: string[] = [];
  for (const n of want) {
    const p = whichHost(n, PATHV);
    if (p === null) { badLink.push(`${n}(missing)`); continue; }
    if (WIN) {
      // npm's Windows shims are .cmd files that name the package's entry, not links
      const shim = readFileSync(p, 'utf8');
      if (!shim.replace(/\\/g, '/').includes(`node_modules/gsd-toolkit/dist/bin/${n}.js`)) badLink.push(`${n}→${shim.slice(0, 80)}`);
    } else {
      const r = realpathSync.native(p);
      if (!r.startsWith(`${ipkg}/dist/bin/`)) badLink.push(`${n}→${r}`);
    }
  }
  is("every command on PATH is the package's npm entry", badLink.join(' '), '');
});

test('every entry starts', { skip: SKIP }, () => {
  install();
  const { want } = pack();
  for (const n of want) {
    if (['gsdt-planning-merge', 'gsdt-wt-finish', 'gsdt-derive-port', 'gsdt-worktree-guard'].includes(n)) continue;
    const r = inst(n, ['--help'], WORK);
    ok(`${n} --help (rc ${r.status})`, r.status === 0 && r.out.includes(n), r.out.split('\n').slice(0, 3).join('\n'));
    hasnt(`${n}: no module error`, r.out, 'Cannot find module');
  }
  is('gsdt-derive-port 300 (a number, rc 0)', inst('gsdt-derive-port', ['300'], WORK).status, 0);
  is('gsdt-rules --hook outside a repo: silent', inst('gsdt-rules', ['--hook'], WORK).out, '');
  const g = inst('gsdt-worktree-guard', ['--global'], WORK, instEnv(), '{}');
  is('guard --global on {}: allowed', `${g.out}rc=${g.status}`, 'rc=0');
  const s = inst('gsdt-worktree-guard', ['--command', 'gsd-execute-phase', '--args', '1', '--repo', WORK], WORK, instEnv({ GSD_SKIP_GUARD: '1' }));
  is('GSD_SKIP_GUARD=1: allowed', `${s.out}rc=${s.status}`, 'rc=0');
});

test('a set-up repo, run from the npm install', { skip: SKIP }, () => {
  const { ipkg } = install();
  const R = path.join(WORK, 'repo'), O = path.join(WORK, 'origin.git');
  gitOk(WORK, ['init', '-q', '--bare', '-b', 'main', O]);
  gitOk(WORK, ['init', '-q', '-b', 'main', R]);
  gitOk(R, ['commit', '-q', '--allow-empty', '-m', 'init']);
  gitOk(R, ['remote', 'add', 'origin', O]);
  gitOk(R, ['push', '-q', '-u', 'origin', 'main']);
  const env = instEnv();
  let r = inst('gsdt-bootstrap-repo', ['--agent', 'claude', '--no-ui'], R, env);
  is('gsdt-bootstrap-repo rc', r.status, 0);
  hasnt('bootstrap: no module error', r.out, 'Cannot find module');
  is('merge driver runs gsdt-planning-merge by name', gitOk(R, ['config', 'merge.gsd-planning.driver']).trim().split(/\s+/)[0], 'gsdt-planning-merge');
  ok('shims copied from the package', existsSync(path.join(R, 'scripts', 'gsdt-finish-worktree-feature.sh')));
  mkdirp(path.join(R, '.planning'));
  has('.gitattributes routes STATE.md to the driver', tryRead(path.join(R, '.gitattributes')), 'merge=gsd-planning');
  const stateF = path.join(R, '.planning', 'STATE.md'), roadF = path.join(R, '.planning', 'ROADMAP.md');
  write(stateF, '# State\n\n## Current Position\n\nPhase: 1\nStatus: planning\n\n## Session Continuity\n\nLast session: x\n');
  write(roadF, '# Roadmap\n\n- [ ] **Phase 1: one**\n');
  gitOk(R, ['add', '-A']); gitOk(R, ['commit', '-qm', 'setup']);
  gitOk(R, ['checkout', '-qb', 'side']);
  write(stateF, readLF(stateF).replace(/^Status: planning/m, 'Status: executing'));
  gitOk(R, ['commit', '-qam', 'side']);
  gitOk(R, ['checkout', '-q', 'main']);
  write(stateF, readLF(stateF).replace(/^Status: planning/m, 'Status: verifying'));
  writeFileSync(roadF, `${readLF(roadF)}- [ ] **Phase 2: two**\n`);
  gitOk(R, ['commit', '-qam', 'main']);
  const m = git(R, ['merge', '-q', '--no-edit', 'side'], env);
  is('planning merge through the npm driver: no conflict', m.status, 0);
  const st = readLF(stateF);
  has('merged STATE: Session Continuity kept', st, 'Last session: x');
  has("merged STATE takes side's status", st, 'Status: executing');
  is('one Status line (reconciled, not a plain union)', countLines(st, /^Status:/), 1);
  r = inst('gsdt-doctor', ['--verbose'], R, env);
  hasnt('doctor: no module error', r.out, 'Cannot find module');
  hasnt('doctor: command guards found in the npm package (no T053)', r.out, 'T053');
  has('doctor: PATH commands resolve to the package', r.out, `PATH commands resolve to ${ipkg}`);
  r = inst('gsdt-list', [], R, env);
  is('gsdt-list rc', r.status, 0);
  r = inst('gsdt-tracker', ['config'], R, env);
  is('gsdt-tracker config rc (standalone set ships)', r.status, 0);
  has('gsdt-tracker config prints the tracker', r.out, 'tracker=');
  r = inst('gsdt-rules', [], R, env);
  has('gsdt-rules prints the rules', r.out, 'gsdt-start');
});

test('gsdt-setup (temp HOME)', { skip: SKIP }, async (t) => {
  install();
  const H = path.join(WORK, 'home');
  const oldRt = path.join(H, '.local', 'share', 'gsd-toolkit', 'releases', '0.10.0');
  mkdirp(path.join(H, '.local', 'bin')); mkdirp(path.join(oldRt, 'bin')); mkdirp(path.join(oldRt, 'lib'));
  write(path.join(oldRt, 'install.sh'), ''); write(path.join(oldRt, 'lib', 'common.sh'), '');
  write(path.join(oldRt, 'bin', 'gsdt-list'), '#!/bin/sh\n', 0o755);
  if (!WIN) {
    link(path.join(oldRt, 'bin', 'gsdt-list'), path.join(H, '.local', 'bin', 'gsdt-list'));
    link(process.execPath, path.join(H, '.local', 'bin', 'gsdt-mine'));   // not ours: stays
  }
  write(path.join(H, '.local', 'bin', '.gsd-install-manifest'), 'providers\tclaude,codex\n');
  write(path.join(H, '.claude', 'settings.json'), '{\n  "model": "opus",\n  "n": 1.0\n}\n');
  const env = withHome(instEnv({ XDG_CONFIG_HOME: path.join(H, '.config') }), H);
  const r = inst('gsdt-setup', [], WORK, env);

  await t.test('skills, hooks, settings, manifest', () => {
    is('gsdt-setup rc', r.status, 0);
    hasnt('setup: no module error', r.out, 'Cannot find module');
    for (const a of [path.join(H, '.claude', 'skills'), path.join(H, '.agents', 'skills')]) {
      const f = path.join(a, 'gsdt-flow', 'SKILL.md');
      ok(`skill gsdt-flow in ${a} (agents kept from the 0.10.x install)`, existsSync(f), r.out);
      const lines = tryRead(f).split('\n'); if (lines[lines.length - 1] === '') lines.pop();
      has('skill marked with the version', lines[lines.length - 1] ?? '', VER);
    }
    const S = readLF(path.join(H, '.claude', 'settings.json'));
    has('user hook: guard from the npm bin', S, `exec '${fwd(BINDIR)}/gsdt-worktree-guard' --global`);
    has('user hook: rules from the npm bin', S, `exec '${fwd(BINDIR)}/gsdt-rules' --hook`);
    has('other settings kept byte-exact (1.0 stays 1.0)', S, '"n": 1.0');
    has('manifest records the agents', tryRead(path.join(H, '.config', 'gsd', 'setup-manifest')), 'providers\tclaude,codex');
  });
  await t.test('the 0.10.x install is moved off ~/.local/bin', { skip: SKIP_WIN_LINKS }, () => {
    ok('0.10.x link removed', !isLink(path.join(H, '.local', 'bin', 'gsdt-list')), r.out);
    ok('a link that is not ours stays', isLink(path.join(H, '.local', 'bin', 'gsdt-mine')));
    ok('0.10.x runtime removed', !lexists(path.join(H, '.local', 'share', 'gsd-toolkit')), r.out);
    ok('old manifest removed', !lexists(path.join(H, '.local', 'bin', '.gsd-install-manifest')));
  });
  await t.test('a second run changes nothing', () => {
    const before = readFileSync(path.join(H, '.claude', 'settings.json'), 'utf8');
    const o = inst('gsdt-setup', [], WORK, env);
    is('second run: settings unchanged (no duplicate hooks)', readFileSync(path.join(H, '.claude', 'settings.json'), 'utf8'), before);
    has('second run: skills already current', o.out, 'already current');
  });
});

test('gsdt-update, npm mode (GitHub = a curl stub serving the release; npm stubbed)', { skip: SKIP }, () => {
  install();
  const { tgz } = pack();
  const H = path.join(WORK, 'home');
  // The release is the one source: latest from the GitHub API, SHA256SUMS + the .tgz from the
  // release download; the npm registry is never asked (the npm stub fails any `view`).
  const STUB = mkdirp(path.join(WORK, 'stub'));
  const rel = mkdirp(path.join(WORK, 'rel', 'v99.0.0'));
  copyFileSync(tgz, path.join(rel, 'gsd-toolkit-99.0.0.tgz'));
  sums(rel, ['gsd-toolkit-99.0.0.tgz']);
  const curlLog = path.join(WORK, 'curl.log'), npmLog = path.join(WORK, 'npm.log');
  stub(STUB, 'curl', `
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(curlLog)}, a.join(' ') + '\\n');
let out = '', url = '';
for (let i = 0; i < a.length; i++) {
  if (a[i] === '-o') out = a[++i];
  else if (['-H', '--max-time', '--retry', '--retry-delay'].includes(a[i])) i++;
  else if (a[i].startsWith('http')) url = a[i];
}
if (url.endsWith('/releases/latest')) process.stdout.write('{"tag_name": "v' + (process.env.LATEST ?? '') + '"}');
else if (url.includes('/releases/download/')) {
  const f = ${JSON.stringify(path.join(WORK, 'rel'))} + '/' + url.split('/releases/download/')[1];
  if (!existsSync(f)) process.exit(22);
  if (out) copyFileSync(f, out); else process.stdout.write(readFileSync(f));
} else process.exit(6);
`);
  stub(STUB, 'npm', `
import { appendFileSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(npmLog)}, a.join(' ') + '\\n');
process.exit(['install', 'i'].includes(a[0]) ? Number(process.env.NPM_INSTALL_RC ?? 0) : 1);
`);
  const upd = (latest: string, args: string[]) => inst('gsdt-update', args, WORK, withHome(npmEnv({
    PATH: sysPath([STUB, BINDIR]), XDG_CONFIG_HOME: path.join(H, '.config'), XDG_CACHE_HOME: path.join(WORK, 'cache'),
    GSD_UPDATE_REPO: 'acme/gsd-toolkit', LATEST: latest,
  }), H));
  let o = upd('99.0.0', ['--check', '--no-core']);
  is('update --check rc', o.status, 0);
  has('update --check: installed version', o.out, `installed : ${VER}`);
  has('update --check: latest from GitHub', o.out, 'latest    : 99.0.0  (acme/gsd-toolkit)');
  has('update --check: offers the update', o.out, 'update available');
  writeFileSync(npmLog, '');
  o = upd('99.0.0', ['--no-core']);
  is(`update rc: ${o.out}\ncurl log:\n${tryRead(curlLog)}`, o.status, 0);
  const nl = tryRead(npmLog);
  has('update ran npm install -g on the downloaded .tgz', nl, 'install -g --no-audit --no-fund');
  has("…the release's gsd-toolkit-99.0.0.tgz", nl, 'gsd-toolkit-99.0.0.tgz');
  ok('no npm registry lookup', !nl.split('\n').some((l) => /^view\b/.test(l)), nl);
  has('update says it installed', o.out, 'gsd-toolkit 99.0.0 installed');
  o = upd(VER, ['--check', '--no-core']);
  has('same version: up to date', o.out, 'up to date');
});
