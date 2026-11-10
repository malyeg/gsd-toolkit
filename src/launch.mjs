// Dev/test launcher (strangler phase): bin/gsdt-<name> runs
//   node src/launch.mjs <name> [args…]
// It checks the Node version first (an older Node would die on the type
// syntax with a confusing error), then imports src/commands/<name>.ts — Node
// ≥ 24 strips the types — and exits with what its main() returns.
// P11 replaces this with package.json "bin" entries over dist/.
const [major] = process.versions.node.split('.').map(Number);
const [name, ...args] = process.argv.slice(2);
// `gsdt-rules --hook` runs as a Claude SessionStart hook: whatever goes wrong it
// must say nothing and exit 0 (the bash version could not fail either).
const quiet = name === 'rules' && args.includes('--hook');
if (major < 24) {
  if (quiet) process.exit(0);
  process.stderr.write(`gsdt-${name}: needs Node.js >= 24 (found ${process.versions.node})\n`);
  process.exit(1);
}
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  process.stderr.write(`launch.mjs: bad command name: ${name ?? ''}\n`);
  process.exit(2);
}
try {
  const mod = await import(new URL(`./commands/${name}.ts`, import.meta.url).href);
  process.exitCode = await mod.main(args);
} catch (e) {
  if (!quiet) throw e;
  process.exitCode = 0;
}
