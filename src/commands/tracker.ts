// gsdt-tracker — read and write tickets from the shell (port of bin/gsdt-tracker).
// Launcher: bin/gsdt-tracker → src/launch.mjs tracker. Standalone: the command and
// everything under src/tracker/ import only node:* and each other.
export { main, HELP } from '../tracker/cli.ts';
