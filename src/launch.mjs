// Dev/test launcher (strangler phase): bin/gsdt-<name> runs
//   node src/launch.mjs <name> [args…]
// It checks the Node version first (an older Node would die on the type
// syntax with a confusing error), then imports src/commands/<name>.ts — Node
// ≥ 24 strips the types — and exits with what its main() returns.
// P11 replaces this with package.json "bin" entries over dist/.
const [major] = process.versions.node.split('.').map(Number);
const [name, ...args] = process.argv.slice(2);
if (major < 24) {
  process.stderr.write(`gsdt-${name}: needs Node.js >= 24 (found ${process.versions.node})\n`);
  process.exit(1);
}
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  process.stderr.write(`launch.mjs: bad command name: ${name ?? ''}\n`);
  process.exit(2);
}
const mod = await import(new URL(`./commands/${name}.ts`, import.meta.url).href);
process.exitCode = await mod.main(args);
