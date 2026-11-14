#!/usr/bin/env node
// tools/build.mjs — build the npm package's runnable files (npm run build;
// npm pack/publish run it through "prepack"):
//   1. tsc: src/**/*.ts → dist/**/*.js (tsconfig.json; imports rewritten .ts → .js)
//   2. dist/bin/gsdt-<name>.js for each command in package.json "bin": a
//      #!/usr/bin/env node entry that runs src/launch.mjs <name> — npm links
//      these into its bin dir (and writes .cmd/.ps1 wrappers on Windows).
// src/launch.mjs is shipped as is; it loads dist/commands/<name>.js when the
// .ts files are absent.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
rmSync(path.join(root, 'dist'), { recursive: true, force: true });
// TypeScript 7's tsc is a native binary: run it from node_modules/.bin
const tsc = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const r = spawnSync(tsc, ['-p', path.join(root, 'tsconfig.json')], { stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) process.exit(r.status ?? 1);
mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true });
for (const [cmd, rel] of Object.entries(pkg.bin)) {
  const want = `dist/bin/${cmd}.js`;
  if (rel !== want || !cmd.startsWith('gsdt-')) {
    process.stderr.write(`build: package.json bin.${cmd} must be ${want}\n`);
    process.exit(1);
  }
  const f = path.join(root, want);
  writeFileSync(
    f,
    `#!/usr/bin/env node\n// ${cmd} — made by tools/build.mjs\nprocess.argv.splice(2, 0, ${JSON.stringify(cmd.slice(5))});\nawait import('../../src/launch.mjs');\n`,
  );
  chmodSync(f, 0o755);
}
