// local-files.test.ts — the gitignored files a phase worktree gets from the main checkout (src/local-files.ts):
// local/dev/test/e2e env files only, never prod; `copy_files` in .gsd.conf; reuse fills in what is missing;
// doctor T035 names a worktree that lacks them. Throwaway repos and HOME throughout.
// Run: node --test tests/node/local-files.test.ts
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { envSafe, isEnvName, localFiles } from '../../src/local-files.ts';
import { PKG, gitOk, gsdt, hostPath, joinPath, tmp, write } from './g2-helpers.ts';
import type { Env } from './g2-helpers.ts';

describe('envSafe: an allow-list of names', () => {
  it('local, dev, develop, development, e2e, test (and their .local forms) are copied', () => {
    for (const n of ['.env', '.env.local', '.env.dev', '.env.develop', '.env.development', '.env.e2e', '.env.test', '.env.test.local', '.env.development.local', 'apps/api/.env', 'apps/web/.ENV.Local', '.env.example']) {
      assert.equal(envSafe(n), true, n);
    }
  });
  it('prod, production, staging, preview, anything unknown are not', () => {
    for (const n of ['.env.prod', '.env.production', '.env.production.local', '.env.staging', '.env.preview', '.env.local.prod', 'apps/api/.env.prod', '.env.qa']) {
      assert.equal(envSafe(n), false, n);
    }
  });
  it('isEnvName: only .env and .env.<x> file names', () => {
    assert.equal(isEnvName('a/.env'), true);
    assert.equal(isEnvName('.envrc'), false);
    assert.equal(isEnvName('config/env.ts'), false);
  });
});

const WORK = tmp('gsd-localfiles-');
const HOME = path.join(WORK, 'home');
mkdirSync(HOME, { recursive: true });
const env = (): Env => ({
  HOME,
  USERPROFILE: HOME,
  XDG_CONFIG_HOME: path.join(HOME, '.config'),
  GSD_NO_CORE: '1',
  GSD_NO_UPDATE_CHECK: '1',
  GSD_CLAUDE_SETTINGS: path.join(WORK, 'claude-settings.json'),
  GSD_CLAUDE_SKILL_DIR: path.join(WORK, 'skills'),
  PATH: joinPath([path.join(PKG, 'bin'), ...hostPath()]),
});

function mkrepo(name: string, conf = 'base = develop\ninstall = none\n'): string {
  const dir = path.join(WORK, name);
  gitOk(WORK, ['init', '-q', '-b', 'develop', dir]);
  write(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n- [ ] **Phase 1: One**\n\n### Phase 1: One\n');
  write(path.join(dir, '.gsd.conf'), conf);
  write(path.join(dir, '.gitignore'), '.env\n.env.*\n!.env.example\nnode_modules/\n');
  write(path.join(dir, '.env.example'), 'KEY=\n');
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  // the local files: in the main checkout only (gitignored)
  for (const f of ['.env', '.env.test', '.env.production', 'apps/api/.env', 'apps/api/.env.e2e', 'apps/api/.env.prod', '.env.staging']) write(path.join(dir, f), `${f}\n`);
  write(path.join(dir, 'node_modules', 'x', '.env'), 'dep\n');
  return dir;
}
const wtOf = (repo: string): string => path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`, 'phase-1-one');
const wtNew = (repo: string) => gsdt('wt-new', ['--phase', '1', '--no-install'], { env: env(), cwd: repo });

describe('gsdt-wt-new copies the safe env files', () => {
  it('local/dev/test/e2e copied, prod/staging left out and named, node_modules ignored', () => {
    const R = mkrepo('a');
    const r = wtNew(R);
    assert.equal(r.status, 0, r.out + r.stderr);
    const WT = wtOf(R);
    for (const f of ['.env', '.env.test', 'apps/api/.env', 'apps/api/.env.e2e']) assert.ok(existsSync(path.join(WT, f)), `${f} copied: ${r.out}`);
    for (const f of ['.env.production', 'apps/api/.env.prod', '.env.staging', 'node_modules/x/.env']) assert.ok(!existsSync(path.join(WT, f)), `${f} not copied`);
    assert.match(r.out, /not copied \(not a local\/dev\/test env[^\n]*\.env\.production/);
    assert.match(r.out, /apps\/api\/\.env\.prod/);
  });

  it('reuse fills in what is missing and never overwrites', () => {
    const R = path.join(WORK, 'a');
    const WT = wtOf(R);
    writeFileSync(path.join(WT, '.env'), 'changed in the phase\n');
    rmSync(path.join(WT, 'apps', 'api', '.env.e2e'));
    const r = wtNew(R);
    assert.equal(r.status, 0, r.out + r.stderr);
    assert.match(r.out, /reusing it/);
    assert.equal(readFileSync(path.join(WT, '.env'), 'utf8'), 'changed in the phase\n');
    assert.ok(existsSync(path.join(WT, 'apps', 'api', '.env.e2e')));
    assert.doesNotMatch(r.out, /copied \.env\n/);
  });

  it('doctor T035: a worktree that lacks one is a warning, not a finding', () => {
    const R = path.join(WORK, 'a');
    rmSync(path.join(wtOf(R), '.env.test'));
    const j = JSON.parse(gsdt('doctor', ['--json'], { env: env(), cwd: R }).stdout) as { findings: { code: string }[]; warnings: { code: string; message: string; fix: string }[] };
    const w = j.warnings.find((x) => x.code === 'T035');
    assert.ok(w !== undefined, JSON.stringify(j.warnings));
    assert.match(w.message, /phase-1-one lacks local files the main checkout has: \.env\.test/);
    assert.match(w.fix, /gsdt-start -p 1 --no-launch/);
    assert.ok(!j.findings.some((f) => f.code === 'T035' || (f.code === 'T017' && /copy_files/.test(JSON.stringify(f)))));
  });

  it('copy_files: extra files (even a prod env, named on purpose), or none', () => {
    const R = mkrepo('b', 'base = develop\ninstall = none\ncopy_files = config/*.yml, .env.staging\n');
    write(path.join(R, '.gitignore'), '.env\n.env.*\n!.env.example\nnode_modules/\nconfig/*.yml\n');
    write(path.join(R, 'config', 'secrets.yml'), 'k: v\n');
    const lf = localFiles(R);
    assert.ok(lf.copy.includes('config/secrets.yml'), JSON.stringify(lf));
    assert.ok(lf.copy.includes('.env.staging'));
    assert.ok(lf.skipped.includes('.env.production'));
    write(path.join(R, '.gsd.conf'), 'base = develop\ninstall = none\ncopy_files = none\n');
    const none = localFiles(R);
    assert.ok(!none.copy.some((f) => f.includes('.env')), JSON.stringify(none));
    assert.deepEqual(none.skipped, []);
  });
});
