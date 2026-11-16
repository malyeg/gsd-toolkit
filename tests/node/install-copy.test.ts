// install-copy.test.ts — lib/install-copy.sh, the 0.10.x copy installer kept as the
// test oracle for gsdt-setup (was tests/test-install-copy.sh). It copies the package
// into a runtime folder, links its commands into a bin dir and copies its skills into
// each agent's skill dir: a POSIX installer (links, .bak copies), so its sections run
// on macOS and Linux; the install.sh refusals at the end run everywhere.
import { existsSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  PKG, SKIP_WIN_LINKS, baseEnv, bash, copyFromPkg, findNames, fwd, has, hasnt, is, isLink, lexists, link, mkTmp, mkdirp, ok, readLF, run, stub,
  tryRead, whichHost, withHome, write,
} from './g5-helpers.ts';

const WORK = mkTmp('gsdt-icopy-');
const BIN = path.join(WORK, 'bin'), COPY = path.join(WORK, 'runtime'), SKILLS = path.join(WORK, 'skills');
const HOME_ = mkdirp(path.join(WORK, 'home'));
const SCRIPT = path.join(PKG, 'lib', 'install-copy.sh');
const hostPATH = process.env.PATH ?? process.env.Path ?? '';

type EnvX = Record<string, string | undefined>;
/** the env every install here runs with: no real gsd-core install (npx), a throwaway HOME */
const envFor = (extra: EnvX = {}, home = HOME_): NodeJS.ProcessEnv => withHome(baseEnv({ GSD_NO_CORE: '1', ...extra }), home);
/** lib/install-copy.sh <args> from `script` (default: this checkout's), stdout discarded like >/dev/null */
const icopy = (args: string[], extra: EnvX = {}, script = SCRIPT, home = HOME_, input = '') => bash(script, args, { env: envFor(extra, home), input });
const installCopy = () => {
  const r = icopy([], { GSD_BIN_DIR: BIN, GSD_COPY_DIR: COPY, GSD_CLAUDE_SKILL_DIR: SKILLS });
  is('install_copy succeeds (set -e)', r.status, 0);
  return r;
};
const markRe = /^<!-- gsd-toolkit-skill /m;
const rmlink = (p: string): void => { try { rmSync(p, { force: true }); } catch { /* gone */ } };

test('copy install: backups, links, runtime files, skills, the user hook', { skip: SKIP_WIN_LINKS }, () => {
  mkdirp(BIN); mkdirp(path.join(COPY, 'lib')); mkdirp(path.join(COPY, 'unrelated-dir'));
  write(path.join(BIN, 'gsdt-list'), 'local command\n');
  write(path.join(BIN, 'gsdt-list.bak'), 'older backup\n');
  write(path.join(COPY, 'lib', 'common.sh'), 'local library\n');
  write(path.join(COPY, 'unrelated-dir', 'file'), 'keep\n');
  installCopy();
  ok('gsdt-list is a link now', isLink(path.join(BIN, 'gsdt-list')));
  is('…into the runtime', readlinkSync(path.join(BIN, 'gsdt-list')), path.join(COPY, 'bin', 'gsdt-list'));
  is('an older .bak is kept', readLF(path.join(BIN, 'gsdt-list.bak')), 'older backup\n');
  is('the local command went to .bak.1', readLF(path.join(BIN, 'gsdt-list.bak.1')), 'local command\n');
  is('a local library went to .bak', readLF(path.join(COPY, 'lib', 'common.sh.bak')), 'local library\n');
  is('an unrelated dir in the runtime is kept', readLF(path.join(COPY, 'unrelated-dir', 'file')), 'keep\n');
  ok('shims are copied', existsSync(path.join(COPY, 'shims', 'scripts', 'gsdt-init.sh')) || existsSync(path.join(COPY, 'shims', 'scripts')));
  ok('the skills are copied into the runtime', existsSync(path.join(COPY, 'skills', 'gsdt-flow', 'SKILL.md')));
  // gsdt-rules is linked, and Claude's user settings get its SessionStart hook
  ok('gsdt-rules is linked', isLink(path.join(BIN, 'gsdt-rules')));
  has("Claude's settings get the gsdt-rules SessionStart hook", tryRead(path.join(WORK, 'settings.json')), "gsdt-rules' --hook");
  const r = icopy(['--no-user-hook'], { GSD_BIN_DIR: BIN, GSD_COPY_DIR: COPY, GSD_CLAUDE_SKILL_DIR: SKILLS });
  is('--no-user-hook succeeds', r.status, 0);
  hasnt('--no-user-hook removes the gsdt-rules hook', tryRead(path.join(WORK, 'settings.json')), 'gsdt-rules');
  installCopy();
  // a skill an older release shipped leaves the runtime on the next copy install
  write(path.join(COPY, 'skills', 'gsd-flow', 'SKILL.md'), 'old\n');
  installCopy();
  ok('a skill an older release shipped leaves the runtime', !existsSync(path.join(COPY, 'skills', 'gsd-flow')));
  // the page checker travels with the runtime: the Node script and the pinned axe-core
  ok('src/commands/ui-check.ts travels with the runtime', existsSync(path.join(COPY, 'src', 'commands', 'ui-check.ts')));
  ok('axe.min.js', existsSync(path.join(COPY, 'lib', 'vendor', 'axe-core', 'axe.min.js')));
  ok('axe-core LICENSE', existsSync(path.join(COPY, 'lib', 'vendor', 'axe-core', 'LICENSE')));
  ok('axe-core VERSION', existsSync(path.join(COPY, 'lib', 'vendor', 'axe-core', 'VERSION')));
  ok('the skills are installed for Claude', existsSync(path.join(SKILLS, 'gsdt-flow', 'SKILL.md')));
});

test('retired skills go, the user\'s own stay; a current copy marked by an older release is replaced', { skip: SKIP_WIN_LINKS }, () => {
  // A skill an older release placed but this one no longer ships (renamed or
  // retired) is removed; a skill of the user's own, with no marker, stays.
  mkdirp(path.join(SKILLS, 'gsd-retired')); mkdirp(path.join(SKILLS, 'gsd-retired2')); mkdirp(path.join(SKILLS, 'my-own'));
  write(path.join(SKILLS, 'gsd-retired', 'SKILL.md'), 'old\n'); write(path.join(SKILLS, 'gsd-retired', '.gsd-worktrees-skill'), '0.4.4\n');
  write(path.join(SKILLS, 'gsd-retired2', 'SKILL.md'), 'old\n<!-- gsd-worktrees-skill 0.5.0 -->\n');
  write(path.join(SKILLS, 'my-own', 'SKILL.md'), 'mine\n');
  // an older copy, marked by a file of its own, is replaced by one marked in SKILL.md
  write(path.join(SKILLS, 'gsdt-flow', '.gsd-worktrees-skill'), '0.4.4\n');
  link(path.join(PKG, 'skills', 'gsd-gone'), path.join(SKILLS, 'gsd-gone'));
  link(path.join(WORK, 'elsewhere', 'skill'), path.join(SKILLS, 'not-ours'));
  installCopy();
  ok('a retired skill (file mark) is removed', !existsSync(path.join(SKILLS, 'gsd-retired')));
  ok('a retired skill (SKILL.md mark) is removed', !existsSync(path.join(SKILLS, 'gsd-retired2')));
  ok('the old mark file is gone', !existsSync(path.join(SKILLS, 'gsdt-flow', '.gsd-worktrees-skill')));
  ok('the new mark is in SKILL.md', markRe.test(readLF(path.join(SKILLS, 'gsdt-flow', 'SKILL.md'))));
  ok('a link of ours to a skill that is gone is removed', !isLink(path.join(SKILLS, 'gsd-gone')));
  ok("the user's own skill stays", existsSync(path.join(SKILLS, 'my-own', 'SKILL.md')));
  ok('a link that is not ours stays', isLink(path.join(SKILLS, 'not-ours')));
  rmSync(path.join(SKILLS, 'my-own'), { recursive: true, force: true }); rmlink(path.join(SKILLS, 'not-ours'));
  const before = findNames(WORK, /\.bak/).length;
  installCopy();
  is('a plain re-install makes no new .bak', findNames(WORK, /\.bak/).length, before);
});

test('before 0.8.0 the package was gsd-worktrees: its skills and links are replaced', { skip: SKIP_WIN_LINKS }, () => {
  // Before 0.8.0 the package was gsd-worktrees: its skills (gsdw-*, the old
  // mark) are retired, and its command links (into share/gsd-worktrees, a
  // runtime that may be gone) are replaced in place, not moved to .bak.
  for (const s of ['gsdw-flow', 'gsdw-worktrees', 'gsdw-tracker']) write(path.join(SKILLS, s, 'SKILL.md'), 'old\n<!-- gsd-worktrees-skill 0.7.0 -->\n');
  const OLDRT = path.join(WORK, 'share', 'gsd-worktrees', 'releases', '0.7.0');
  rmlink(path.join(BIN, 'gsdt-list')); rmlink(path.join(BIN, 'gsdt-start'));
  link(path.join(OLDRT, 'bin', 'gsdt-list'), path.join(BIN, 'gsdt-list'));              // dangling: the old runtime is gone
  link(path.join(OLDRT, 'bin', 'gsd-retired-cmd'), path.join(BIN, 'gsd-retired-cmd'));
  write(path.join(OLDRT, 'bin', 'gsdt-start'), 'old\n');
  link(path.join(OLDRT, 'bin', 'gsdt-start'), path.join(BIN, 'gsdt-start'));            // live: into an old runtime folder
  installCopy();
  for (const s of ['gsdw-flow', 'gsdw-worktrees', 'gsdw-tracker']) ok(`${s} is retired`, !existsSync(path.join(SKILLS, s)));
  ok('gsdt-flow is there', existsSync(path.join(SKILLS, 'gsdt-flow', 'SKILL.md')));
  is('the dangling gsdt-list link is replaced in place', readlinkSync(path.join(BIN, 'gsdt-list')), path.join(COPY, 'bin', 'gsdt-list'));
  is('the live gsdt-start link is replaced in place', readlinkSync(path.join(BIN, 'gsdt-start')), path.join(COPY, 'bin', 'gsdt-start'));
  ok('a retired command link is removed', !isLink(path.join(BIN, 'gsd-retired-cmd')));
  is('…and nothing was moved to .bak', findNames(BIN, /^(gsdt-list\.bak\.[2-9].*|gsdt-start\.bak.*|gsd-retired-cmd.*)$/).length, 0);
  // a current copy marked by an older release is still ours: replaced, no .bak
  write(path.join(SKILLS, 'gsdt-tracker', 'SKILL.md'), 'old\n<!-- gsd-worktrees-skill 0.7.0 -->\n');
  installCopy();
  ok('a skill marked by an older release is replaced', markRe.test(readLF(path.join(SKILLS, 'gsdt-tracker', 'SKILL.md'))));
  ok('…without a .bak', !lexists(path.join(SKILLS, 'gsdt-tracker.bak')));
});

test('Codex: skills go to ~/.agents/skills', { skip: SKIP_WIN_LINKS }, () => {
  // Codex: skills go to ~/.agents/skills; ours left in the old ~/.codex/skills
  // (a marked copy, a link of ours, an older name) are removed, a user's stays.
  const CH = mkdirp(path.join(WORK, 'codex-home'));
  mkdirp(path.join(CH, '.codex', 'skills', 'gsd-flow')); mkdirp(path.join(CH, '.codex', 'skills', 'mine'));
  write(path.join(CH, '.codex', 'skills', 'gsd-flow', 'SKILL.md'), 'old\n'); write(path.join(CH, '.codex', 'skills', 'gsd-flow', '.gsd-worktrees-skill'), '0.4.4\n');
  link(path.join(PKG, 'skills', 'gsdt-tracker'), path.join(CH, '.codex', 'skills', 'gsdt-tracker'));
  write(path.join(CH, '.codex', 'skills', 'mine', 'SKILL.md'), 'mine\n');
  let r = icopy(['--agent', 'codex', '--no-user-hook'], { GSD_BIN_DIR: path.join(WORK, 'codex-bin'), GSD_COPY_DIR: path.join(WORK, 'codex-runtime') }, SCRIPT, CH);
  is('--agent codex succeeds', r.status, 0);
  ok('the skills are in ~/.agents/skills', existsSync(path.join(CH, '.agents', 'skills', 'gsdt-flow', 'SKILL.md')));
  ok('our old marked copy in ~/.codex/skills is removed', !existsSync(path.join(CH, '.codex', 'skills', 'gsd-flow')));
  ok('our old link in ~/.codex/skills is removed', !isLink(path.join(CH, '.codex', 'skills', 'gsdt-tracker')));
  ok("the user's skill stays", existsSync(path.join(CH, '.codex', 'skills', 'mine', 'SKILL.md')));
  // an older release's manifest records ~/.codex/skills: a reinstall from it
  // moves the skills too, and a recorded custom dir is kept
  const agentsReal = realpathSync(path.join(CH, '.agents', 'skills'));
  let CB = mkdirp(path.join(WORK, 'codex-bin2'));
  mkdirp(path.join(CH, '.codex', 'skills', 'gsd-worktrees'));
  write(path.join(CH, '.codex', 'skills', 'gsd-worktrees', 'SKILL.md'), 'old\n'); write(path.join(CH, '.codex', 'skills', 'gsd-worktrees', '.gsd-worktrees-skill'), '0.4.12\n');
  write(path.join(CB, '.gsd-install-manifest'), `providers\tcodex\ncodex_skills\t${realpathSync(path.join(CH, '.codex', 'skills'))}\n`);
  r = icopy(['--reuse-install-config', '--no-user-hook'], { GSD_BIN_DIR: CB, GSD_COPY_DIR: path.join(WORK, 'codex-runtime2') }, SCRIPT, CH);
  is('a reinstall from the old manifest succeeds', r.status, 0);
  ok('…moves the skills too', !existsSync(path.join(CH, '.codex', 'skills', 'gsd-worktrees')));
  ok('…and records ~/.agents/skills', readLF(path.join(CB, '.gsd-install-manifest')).split('\n').includes(`codex_skills\t${agentsReal}`));
  // …also with CODEX_HOME set now: the old default ignored it
  CB = mkdirp(path.join(WORK, 'codex-bin3')); mkdirp(path.join(WORK, 'other-codex'));
  mkdirp(path.join(CH, '.codex', 'skills', 'gsd-worktrees'));
  write(path.join(CH, '.codex', 'skills', 'gsd-worktrees', 'SKILL.md'), 'old\n'); write(path.join(CH, '.codex', 'skills', 'gsd-worktrees', '.gsd-worktrees-skill'), '0.4.12\n');
  write(path.join(CB, '.gsd-install-manifest'), `providers\tcodex\ncodex_skills\t${realpathSync(path.join(CH, '.codex', 'skills'))}\n`);
  r = icopy(['--reuse-install-config', '--no-user-hook'], { GSD_BIN_DIR: CB, GSD_COPY_DIR: path.join(WORK, 'codex-runtime3'), CODEX_HOME: path.join(WORK, 'other-codex') }, SCRIPT, CH);
  is('…also with CODEX_HOME set: succeeds', r.status, 0);
  ok('…the old skill moves', !existsSync(path.join(CH, '.codex', 'skills', 'gsd-worktrees')));
  ok('…and ~/.agents/skills is recorded', readLF(path.join(CB, '.gsd-install-manifest')).split('\n').includes(`codex_skills\t${agentsReal}`));
});

test('an isolated copy of the package: upgrade, retired commands, a link becomes a copy', { skip: SKIP_WIN_LINKS }, () => {
  // Move the source away without touching it: exercise a command from an isolated
  // copy of the package, then remove only that temporary fixture.
  const FIXTURE = path.join(WORK, 'source');
  copyFromPkg(FIXTURE, ['bin', 'lib', 'shims', 'skills', 'src']);
  writeFileSync(path.join(FIXTURE, 'install.sh'), readFileSync(path.join(PKG, 'install.sh')));
  const fscript = path.join(FIXTURE, 'lib', 'install-copy.sh');
  write(path.join(FIXTURE, 'bin', 'gsd-obsolete'), '#!/bin/sh\nexit 0\n', 0o755);
  const up = { GSD_BIN_DIR: path.join(WORK, 'upgrade-bin'), GSD_COPY_DIR: path.join(WORK, 'upgrade-runtime') };
  let r = icopy(['--agent', 'codex'], { ...up, GSD_CODEX_SKILL_DIR: path.join(WORK, 'upgrade-skills') }, fscript);
  is('the isolated package installs', r.status, 0);
  rmSync(path.join(FIXTURE, 'bin', 'gsd-obsolete'));
  link(path.join(WORK, 'unrelated-missing'), path.join(WORK, 'upgrade-bin', 'unrelated'));
  // a command an older release had (0.8.0's gsd-clickup) goes on update
  const OLDREL = path.join(WORK, 'share', 'gsd-toolkit', 'releases', '0.8.0');
  write(path.join(OLDREL, 'bin', 'gsd-clickup'), '#!/bin/sh\n');
  link(path.join(OLDREL, 'bin', 'gsd-clickup'), path.join(WORK, 'upgrade-bin', 'gsd-clickup'));
  r = icopy(['--reuse-install-config'], up, fscript);
  is('the update succeeds', r.status, 0);
  ok('a command the new release dropped is unlinked', !isLink(path.join(WORK, 'upgrade-bin', 'gsd-obsolete')));
  ok('…and leaves the runtime', !existsSync(path.join(WORK, 'upgrade-runtime', 'bin', 'gsd-obsolete')));
  ok('…its file is kept as .bak', existsSync(path.join(WORK, 'upgrade-runtime', 'bin', 'gsd-obsolete.bak')));
  ok('an unrelated link stays', isLink(path.join(WORK, 'upgrade-bin', 'unrelated')));
  ok("0.8.0's gsd-clickup is gone", !lexists(path.join(WORK, 'upgrade-bin', 'gsd-clickup')));
  // an old link install's skill (a link into a checkout) is replaced by a copy
  mkdirp(path.join(WORK, 'isolated-skills'));
  link(path.join(FIXTURE, 'skills', 'gsdt-flow'), path.join(WORK, 'isolated-skills', 'gsdt-flow'));
  r = icopy([], { GSD_BIN_DIR: path.join(WORK, 'isolated-bin'), GSD_COPY_DIR: path.join(WORK, 'isolated-runtime'), GSD_CLAUDE_SKILL_DIR: path.join(WORK, 'isolated-skills') }, fscript);
  is('the isolated install (claude) succeeds', r.status, 0);
  ok('a skill link becomes a directory', statSync(path.join(WORK, 'isolated-skills', 'gsdt-flow')).isDirectory());
  ok('…not a link', !isLink(path.join(WORK, 'isolated-skills', 'gsdt-flow')));
  rmSync(FIXTURE, { recursive: true, force: true });
  const h = run(path.join(WORK, 'isolated-bin', 'gsdt-planning-repair'), ['--help'], { env: envFor() });
  is('an installed command runs after the source is gone', h.status, 0);
});

test('unsafe destinations are refused; no Python is refused', { skip: SKIP_WIN_LINKS }, () => {
  let r = icopy([], { GSD_BIN_DIR: path.join(PKG, 'bin'), GSD_COPY_DIR: path.join(WORK, 'unsafe'), GSD_CLAUDE_SKILL_DIR: path.join(WORK, 'unused') });
  ok('overlapping source and destination are refused', r.status !== 0, r.out);
  has('…saying unsafe destination', r.out, 'unsafe destination');
  mkdirp(path.join(WORK, 'other-runtime'));
  write(path.join(WORK, 'other-runtime', 'marker'), 'keep\n');
  link(path.join(WORK, 'other-runtime'), path.join(WORK, 'runtime-link'));
  r = icopy([], { GSD_BIN_DIR: path.join(WORK, 'link-bin'), GSD_COPY_DIR: path.join(WORK, 'runtime-link'), GSD_CLAUDE_SKILL_DIR: path.join(WORK, 'unused') });
  ok('a symlink runtime root is refused', r.status !== 0, r.out);
  is('…the other runtime is untouched', readLF(path.join(WORK, 'other-runtime', 'marker')), 'keep\n');
  ok('…and got no bin', !existsSync(path.join(WORK, 'other-runtime', 'bin')));
  r = icopy([], { GSD_BIN_DIR: path.join(WORK, 'link-bin'), GSD_COPY_DIR: `${path.join(WORK, 'runtime-link')}/`, GSD_CLAUDE_SKILL_DIR: path.join(WORK, 'unused') });
  ok('a trailing-slash symlink runtime root is refused', r.status !== 0, r.out);
  ok('…and got no bin', !existsSync(path.join(WORK, 'other-runtime', 'bin')));
  r = icopy(['--agent', 'codex'], { GSD_BIN_DIR: path.join(WORK, 'unsafe-skill-bin'), GSD_CODEX_SKILL_DIR: path.join(PKG, 'skills') });
  ok('a skill root overlapping the source is refused', r.status !== 0, r.out);
  ok('…before anything is made', !existsSync(path.join(WORK, 'unsafe-skill-bin')));
  const NP = mkdirp(path.join(WORK, 'no-python'));
  for (const tool of ['bash', 'dirname']) symlinkSync(whichHost(tool)!, path.join(NP, tool));
  r = run(whichHost('bash')!, [fwd(SCRIPT)], { env: envFor({ PATH: NP, GSD_BIN_DIR: path.join(WORK, 'no-python-bin') }) });
  ok('a missing Python is refused', r.status !== 0, r.out);
  has('…saying Python 3.7+ is required', r.out, 'requires Python 3.7+');
  ok('…before anything is made', !existsSync(path.join(WORK, 'no-python-bin')));
});

test('gsd-core: added through npx for each chosen agent that has none', { skip: SKIP_WIN_LINKS }, () => {
  // gsd-core: lib/install-copy.sh adds it for each chosen agent that has none, through
  // npx (a stub here: it records its args and stdin, and writes what the real
  // installer leaves in the agent's dir).
  const CORE = mkdirp(path.join(WORK, 'core'));
  stub(path.join(CORE, 'stub'), 'npx', `
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync(process.env.CORE_LOG, a.join(' ') + '\\n');
let input = ''; try { input = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
appendFileSync(process.env.CORE_STDIN, input);
if (process.env.CORE_FAIL) { console.log('npm error 404'); process.exit(1); }
let d = process.env.HOME + '/.claude';
if (a.includes('--codex')) d = process.env.CODEX_HOME || process.env.HOME + '/.codex';
const i = a.indexOf('--config-dir'); if (i >= 0) d = a[i + 1];
mkdirSync(d + '/gsd-core/bin', { recursive: true });
writeFileSync(d + '/gsd-core/VERSION', '1.19.0\\n');
writeFileSync(d + '/gsd-core/bin/gsd_run', '#!/bin/sh\\n'); chmodSync(d + '/gsd-core/bin/gsd_run', 0o755);
`);
  const coreInstall = (name: string, args: string[], extra: EnvX = {}) => {
    mkdirp(path.join(CORE, name));
    const env = withHome(baseEnv({
      GSD_NO_CORE: undefined, PATH: [path.join(CORE, 'stub'), hostPATH].join(path.delimiter),
      CORE_LOG: path.join(CORE, `${name}.log`), CORE_STDIN: path.join(CORE, `${name}.stdin`),
      GSD_BIN_DIR: path.join(CORE, name, 'bin'), GSD_CLAUDE_SKILL_DIR: path.join(CORE, name, 'claude-skills'), ...extra,
    }), path.join(CORE, name));
    const r = bash(SCRIPT, args, { env, input: 'rest of install.sh\n' });
    writeFileSync(path.join(CORE, `${name}.out`), r.out);
    return r;
  };
  const log = (n: string): string => tryRead(path.join(CORE, `${n}.log`));
  const FULL = '-y --package=@opengsd/gsd-core@latest -- gsd-core --claude --global --profile=full';
  let r = coreInstall('fresh', ['--agent', 'claude']);
  ok('a fresh claude install succeeds', r.status === 0, r.out);
  ok('npx ran the gsd-core installer', log('fresh').split('\n').includes(FULL), log('fresh'));
  is("the installer never reads install.sh's stdin", tryRead(path.join(CORE, 'fresh.stdin')), '');
  ok('gsd_run is installed and executable', existsSync(path.join(CORE, 'fresh', '.claude', 'gsd-core', 'bin', 'gsd_run')) && (statSync(path.join(CORE, 'fresh', '.claude', 'gsd-core', 'bin', 'gsd_run')).mode & 0o111) !== 0);
  has('it says what it installed', r.out, '✔ claude gsd-core 1.19.0');
  ok('our skills are installed first', existsSync(path.join(CORE, 'fresh', 'claude-skills', 'gsdt-flow', 'SKILL.md')));
  r = coreInstall('fresh', ['--agent', 'claude']);   // it is there now: left alone
  is('a second run does not run npx again', log('fresh').split('\n').filter((l) => l !== '').length, 1);
  has('…it says gsd-core is already there', r.out, '• claude already has gsd-core 1.19.0');
  coreInstall('skip', ['--agent', 'claude', '--no-core']);
  ok('--no-core never runs npx', !existsSync(path.join(CORE, 'skip.log')));
  coreInstall('skip', ['--agent', 'claude', '--reuse-install-config']);   // an update never installs it
  ok('an update never installs gsd-core', !existsSync(path.join(CORE, 'skip.log')));
  coreInstall('skip', ['--agent', 'claude'], { GSD_NO_CORE: '1' });
  ok('GSD_NO_CORE=1 never runs npx', !existsSync(path.join(CORE, 'skip.log')));
  mkdirp(path.join(CORE, 'old', '.claude', 'get-shit-done'));   // the old GSD: no special case, gsd-core is installed
  coreInstall('old', ['--agent', 'claude']);
  ok('the old GSD is no special case: gsd-core is installed', log('old').trim() !== '');
  coreInstall('moved', ['--agent', 'codex'], { CODEX_HOME: path.join(CORE, 'moved', 'codex-home'), GSD_CODEX_SKILL_DIR: path.join(CORE, 'moved', 'codex-skills') });
  ok('codex with CODEX_HOME: --config-dir is passed', log('moved').split('\n').includes(`-y --package=@opengsd/gsd-core@latest -- gsd-core --codex --global --profile=full --config-dir ${path.join(CORE, 'moved', 'codex-home')}`), log('moved'));
  ok('…and gsd_run lands there', existsSync(path.join(CORE, 'moved', 'codex-home', 'gsd-core', 'bin', 'gsd_run')));
  r = coreInstall('failed', ['--agent', 'claude'], { CORE_FAIL: '1' });
  is('a failing npx still exits 0', r.status, 0);
  has('…and warns', r.out, '⚠ gsd-core for claude not installed');
  ok('…with the command to run', r.out.split('\n').some((l) => l.endsWith('run:  npx @opengsd/gsd-core@latest --claude --global --profile=full')), r.out);
  ok('…and still finishes', r.out.split('\n').some((l) => l.startsWith('Done')), r.out);
  const NN = mkdirp(path.join(CORE, 'nonode'));
  for (const tool of ['bash', 'dirname', 'python3', 'mkdir', 'readlink', 'ln', 'rm', 'mv', 'cp', 'cmp', 'find', 'sed', 'grep', 'cat', 'head', 'mktemp', 'basename', 'tr']) {
    const c = whichHost(tool); if (c !== null) symlinkSync(c, path.join(NN, tool));
  }
  mkdirp(path.join(CORE, 'nonpx'));
  r = bash(SCRIPT, ['--agent', 'claude'], {
    env: withHome(baseEnv({ PATH: NN, GSD_BIN_DIR: path.join(CORE, 'nonpx', 'bin'), GSD_CLAUDE_SKILL_DIR: path.join(CORE, 'nonpx', 'claude-skills') }), path.join(CORE, 'nonpx')),
  });
  is('without npx the install still exits 0', r.status, 0);
  has('…and says npx is missing', r.out, '⚠ gsd-core not installed for claude: no npx');
});

test('install.sh --copy and bad agents are refused before any download', () => {
  // install.sh --copy (what a very old release's get.sh runs on the release it
  // downloaded) goes to lib/install.sh, the bridge, which hands over to install.sh
  // (--copy dropped): a gemini agent is refused there, before any download
  let r = bash(path.join(PKG, 'install.sh'), ['--copy', '--agent', 'gemini'], { env: envFor() });
  ok('install.sh --copy reaches install.sh', r.status !== 0, r.out);
  has('…which refuses gemini', r.out, 'no longer supported');
  // without a package it refuses
  write(path.join(WORK, 'lone-install.sh'), readFileSync(path.join(PKG, 'install.sh'), 'utf8'));
  r = bash(path.join(WORK, 'lone-install.sh'), ['--copy'], { env: envFor() });
  ok('install.sh --copy outside a package is refused', r.status !== 0, r.out);
  has('…saying it installs an unpacked package', r.out, 'installs an unpacked package');
  // install.sh refuses a bad agent before it downloads or makes anything
  r = bash(path.join(PKG, 'install.sh'), ['--agent', 'gemini'], { env: envFor({ GSD_BIN_DIR: path.join(WORK, 'gem-bin') }) });
  ok('gemini is refused', r.status !== 0, r.out);
  has('…with its reason', r.out, 'no longer supported');
  ok('…before anything is made', !existsSync(path.join(WORK, 'gem-bin')));
});
