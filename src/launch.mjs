// The one launcher. bin/gsdt-<name> (bash) and the npm entries
// (dist/bin/gsdt-<name>.js, made by tools/build.mjs) both run
//   node src/launch.mjs <name> [args…]
// It checks the Node version first (an older Node would die on the type
// syntax with a confusing error), then imports src/commands/<name>.ts — Node
// ≥ 24 strips the types — or, where the .ts files are not shipped (the npm
// package: Node will not strip types under node_modules), the compiled
// dist/commands/<name>.js. It exits with what main() returns.
import { existsSync } from 'node:fs';
const [major] = process.versions.node.split('.').map(Number);
const [name, ...args] = process.argv.slice(2);
// The guard's only escape hatch, before anything can fail.
if (name === 'worktree-guard' && process.env.GSD_SKIP_GUARD === '1') process.exit(0);
// `gsdt-rules --hook` runs as a Claude SessionStart hook, `gsdt-notify --hook` as a
// Notification hook: whatever goes wrong they must say nothing and exit 0 (the
// bash version could not fail either).
const quiet = (name === 'rules' || name === 'notify') && args.includes('--hook');
// `gsdt-worktree-guard` runs as a hook: a crash must never let a call through
// with exit 1 (that is not a block). It blocks (2), or with --global lets it
// through, like the bash guard did with a payload it could not read.
const guarding = name === 'worktree-guard';
const guardFail = (why) => {
  if (args.includes('--global')) process.exit(0);
  process.stderr.write(`BLOCKED: gsdt-worktree-guard: ${why}\n`);
  process.exit(2);
};
if (major < 24) {
  if (quiet) process.exit(0);
  if (guarding) guardFail(`needs Node.js >= 24 (found ${process.versions.node})`);
  process.stderr.write(`gsdt-${name}: needs Node.js >= 24 (found ${process.versions.node})\n`);
  process.exit(1);
}
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  process.stderr.write(`launch.mjs: bad command name: ${name ?? ''}\n`);
  process.exit(2);
}
try {
  const ts = new URL(`./commands/${name}.ts`, import.meta.url);
  const mod = await import((existsSync(ts) ? ts : new URL(`../dist/commands/${name}.js`, import.meta.url)).href);
  process.exitCode = await mod.main(args);
} catch (e) {
  if (guarding) guardFail(String(e instanceof Error ? e.message : e).split('\n')[0]);
  if (!quiet) throw e;
  process.exitCode = 0;
}
