// gsdt-bootstrap-repo — install GSD worktree integration into the current repo (conf, shims,
// instructions, hooks). Port of the bash bin/gsdt-bootstrap-repo (kept as the parity oracle in
// tests/fixtures/p8-old-bins/). `gsdt-init` calls main() in-process. Still outside this file:
// `bash -n` (the self-check), `git`, and `jq` (merging the native hook into Claude's settings,
// as the bash did; without jq the hook is reported as absent and the file is left alone).
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeGuardHook } from '../claude-settings.ts';
import {
  base,
  baserefEnsure,
  chmodPlusX,
  chomp,
  commandOnPath,
  confGet,
  git,
  GsdExit,
  gsdPkg,
  isDir,
  isFile,
  planningApply,
  planningHook,
  wtdir,
} from '../common.ts';
import {
  canonicalBlock,
  ownedBlockGet,
  ownedMarkersValid,
  providerEntryBlock,
  providerHookMetadata,
  providerHookState,
  providerInstructionFile,
  providerListValidate,
  providerValidate,
  replaceOwnedBlock,
} from '../provider.ts';
import { err, inherit, out } from '../stdio.ts';

const HELP = `gsdt-bootstrap-repo — install GSD worktree integration into the current repo
USAGE
  gsdt-bootstrap-repo [--agent claude|codex]... [options]
OPTIONS
  --agent <provider>       provider to integrate; repeat for multiple providers
  --agents <a,b,...>       comma-separated provider list
  --agent-command <path>   executable override for the default provider
  --provider-command <p=path> executable override for one provider; repeatable
  --base <branch>          base branch (auto-detected by default)
  --commit                 commit only the installed integration files
  --no-ui                  no screens in this project: ui_gates = off
  --tracker <t>            ticket tracker: none, clickup or custom (tracker = in .gsd.conf)
  --tracker-command <path> with --tracker custom: the repo's tracker script
  --src <path>             deprecated; ignored
  -h, --help               show help
`;

/** bash `die`: `✖ <message>` on stderr, exit 1 */
export class Die extends Error {
  lines: string[];
  constructor(lines: string[]) {
    super(lines.join('\n'));
    this.lines = lines;
  }
}
export const die = (...lines: string[]): never => {
  throw new Die(lines);
};
/** bash `exit N` after the output so far */
export class Stop extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}
/** a Failure from a resolver/validator: its text (if any) to stderr, its code out */
export function stopOn(r: { ok?: false; code: number; message: string }): never {
  if (r.message !== '') err(`${r.message}\n`);
  throw new Stop(r.code);
}
/** run a main() body and turn Die/Stop/GsdExit into an exit code */
export function guarded(fn: () => number): number {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Die) {
      for (const l of e.lines) err(`✖ ${l}\n`);
      return 1;
    }
    if (e instanceof Stop) return e.code;
    if (e instanceof GsdExit) {
      err(e.message);
      return e.code;
    }
    throw e;
  }
}

export function main(argv: string[]): number {
  return guarded(() => run(argv));
}

const SPC = '[ \\t\\n\\r\\f\\v]';
const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const say = (s = ''): void => out(`${s}\n`);
const readLatin1 = (f: string): string | null => {
  try {
    return readFileSync(f, 'latin1');
  } catch {
    return null;
  }
};
/** perl's per-line view of a file: every line with its "\n" */
const perlLines = (t: string): string[] => t.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const keyRe = (k: string): RegExp => new RegExp(`^${SPC}*${reEscape(k)}${SPC}*=`);

// perl -pi: a line that starts with the key becomes `key = value`; no such line: one is appended
export function setConfKey(conf: string, k: string, v: string): void {
  const re = new RegExp(`^${SPC}*${reEscape(k)}${SPC}*=[^\\n]*`);
  const t = readLatin1(conf) ?? '';
  writeFileSync(conf, perlLines(t).map((l) => l.replace(re, () => `${k} = ${v}`)).join(''), 'latin1');
  const now = readLatin1(conf) ?? '';
  if (!now.split('\n').some((l) => keyRe(k).test(l))) {
    // (the bash glued the new line onto a last line that had no newline: `providers = claudetracker = x`)
    appendFileSync(conf, `${now !== '' && !now.endsWith('\n') ? '\n' : ''}${k} = ${v}\n`);
  }
}
// perl -ni: drop the lines that start with the key
export function removeConfKey(conf: string, k: string): void {
  const t = readLatin1(conf) ?? '';
  writeFileSync(conf, perlLines(t).filter((l) => !keyRe(k).test(l)).join(''), 'latin1');
}

/** a temp file holding `text` (utf-8), for replaceOwnedBlock */
function tempBlock(text: string): string {
  const d = mkdtempSync(path.join(tmpdir(), 'gsdt-block-'));
  const f = path.join(d, 'block');
  writeFileSync(f, text);
  return f;
}
function replaceBlock(file: string, kind: string, text: string): void {
  const f = tempBlock(text);
  try {
    if (!replaceOwnedBlock(file, kind, f)) throw new Stop(1);
  } finally {
    rmSync(path.dirname(f), { recursive: true, force: true });
  }
}

/** the provider list without gemini (claude if that was all) */
function dropGone(list: string): string {
  if (!`,${list},`.includes(',gemini,')) return list;
  const l = `,${list},`.replace(/,gemini,/g, ',').replace(/^,/, '').replace(/,$/, '');
  return l || 'claude';
}

const splitList = (s: string): string[] => (s === '' ? [] : s.split(','));

function run(argv: string[]): number {
  const PKG = gsdPkg();
  let TRACKER = '';
  let TRACKER_COMMAND = '';
  let BASE = '';
  let BASE_EXPLICIT = false;
  let COMMIT = false;
  let NO_UI = false;
  let AGENT_COMMAND = '';
  let SELECTED = '';
  let COMMAND_PROVIDERS = '';
  const COMMAND: Record<string, string> = { claude: '', codex: '', custom: '' };
  const addProvider = (p: string): void => {
    if (p !== 'claude' && p !== 'codex' && p !== 'custom') {
      if (p === 'gemini') die('Gemini is no longer supported (gsd-core, the new GSD, dropped it); use claude, codex, or custom');
      die(`unknown provider '${p}' (expected claude, codex, or custom)`);
    }
    if (!`,${SELECTED},`.includes(`,${p},`)) SELECTED = SELECTED ? `${SELECTED},${p}` : p;
  };
  const setProviderCommand = (p: string, c: string): void => {
    if (/[ \t\n\r\f\v]/.test(c)) die('provider command must be one executable path/name');
    if (p !== 'claude' && p !== 'codex' && p !== 'custom') die(`unknown provider '${p}'`);
    COMMAND[p] = c;
  };
  const providerCommand = (p: string): string => COMMAND[p] ?? '';

  for (let i = 0; i < argv.length; ) {
    const a = argv[i] as string;
    const has2 = argv.length - i >= 2;
    const v = argv[i + 1] as string;
    switch (a) {
      case '-h':
      case '--help':
        out(HELP);
        return 0;
      case '--base':
        if (!has2) die('--base needs a value');
        BASE = v;
        BASE_EXPLICIT = true;
        i += 2;
        break;
      case '--agent':
        if (!has2) die('--agent needs a provider');
        addProvider(v);
        i += 2;
        break;
      case '--agents':
        if (!has2) die('--agents needs a comma-separated list');
        if (v.startsWith(',') || v.endsWith(',') || v.includes(',,')) die(`malformed --agents list: ${v}`);
        for (const p of splitList(v)) addProvider(p);
        i += 2;
        break;
      case '--agent-command':
        if (!has2) die('--agent-command needs one executable path/name');
        AGENT_COMMAND = v;
        i += 2;
        break;
      case '--provider-command': {
        if (!has2) die('--provider-command needs provider=executable');
        if (!v.includes('=')) die('--provider-command needs provider=executable');
        const pcP = v.slice(0, v.indexOf('='));
        const pcC = v.slice(v.indexOf('=') + 1);
        if (pcP === '' || pcC === '') die(`malformed --provider-command: ${v}`);
        setProviderCommand(pcP, pcC);
        if (!`,${COMMAND_PROVIDERS},`.includes(`,${pcP},`)) COMMAND_PROVIDERS = COMMAND_PROVIDERS ? `${COMMAND_PROVIDERS},${pcP}` : pcP;
        i += 2;
        break;
      }
      case '--commit':
        COMMIT = true;
        i += 1;
        break;
      case '--no-ui':
        NO_UI = true;
        i += 1;
        break;
      case '--tracker':
        if (!has2) die('--tracker needs none, clickup or custom');
        TRACKER = v;
        i += 2;
        break;
      case '--tracker-command':
        if (!has2 || v === '') die("--tracker-command needs the script's path");
        TRACKER_COMMAND = v;
        i += 2;
        break;
      case '--src':
        if (!has2) die('--src needs a value');
        say('• --src is deprecated and ignored');
        i += 2;
        break;
      default:
        die(`unknown arg: ${a} (see gsdt-bootstrap-repo --help)`);
    }
  }

  const top = git('.', ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) die('run this from inside the target git repo');
  const DEST = chomp(top.stdout);
  if (!['', 'none', 'clickup', 'custom'].includes(TRACKER)) die(`unknown tracker '${TRACKER}' (expected none, clickup or custom)`);
  if (TRACKER_COMMAND !== '' && TRACKER !== 'custom') die('--tracker-command goes with --tracker custom');
  if (/[ \t\n\r\f\v]/.test(TRACKER_COMMAND)) die('--tracker-command must be one path, not a command line');
  if (TRACKER === 'custom' && TRACKER_COMMAND === '' && confGet(DEST, 'tracker_command') === '') {
    die('--tracker custom needs --tracker-command <script> (e.g. scripts/tracker.sh)');
  }
  if (DEST === PKG) die("you're inside the toolkit repo itself — cd into the target repo first");
  const DIRTY_BEFORE = chomp(git(DEST, ['status', '--porcelain']).stdout);
  const CONF = `${DEST}/.gsd.conf`;

  // Gemini was a provider until 0.5.0: an older repo's list loses it here, and the Gemini
  // files we wrote for it are removed below.
  const GEMINI_DROPPED = `,${confGet(DEST, 'providers')},${confGet(DEST, 'provider')},`.includes(',gemini,');
  let OLD_PROVIDERS = dropGone(confGet(DEST, 'providers'));
  const confText = readLatin1(CONF);
  if (SELECTED === '' && confText !== null && confText.split('\n').some((l) => keyRe('providers').test(l))) {
    const bad = providerListValidate(OLD_PROVIDERS);
    if (bad) stopOn(bad);
  }
  if (OLD_PROVIDERS === '') OLD_PROVIDERS = dropGone(confGet(DEST, 'provider'));
  const OLD_DEFAULT = splitFirst(OLD_PROVIDERS) || 'claude';
  if (SELECTED === '') SELECTED = OLD_PROVIDERS || COMMAND_PROVIDERS || process.env.GSD_PROVIDER || process.env.GSD_AGENT || 'claude';
  {
    const bad = providerListValidate(SELECTED);
    if (bad) stopOn(bad);
  }
  {
    let checked = '';
    for (const p of splitList(SELECTED)) {
      addProvider(p);
      checked = checked ? `${checked},${p}` : p;
    }
    SELECTED = checked;
  }
  const DEFAULT = splitFirst(SELECTED);
  for (const p of splitList(COMMAND_PROVIDERS)) {
    if (!`,${SELECTED},`.includes(`,${p},`)) die(`command override for '${p}' is outside providers '${SELECTED}'; select integrations with --agents`);
  }
  // Keep the old generic executable bound to its original provider on migration. Explicit
  // overrides win; existing provider-specific keys already have priority. A legacy agent_command
  // that ran Gemini goes with it.
  let OLD_COMMAND = confGet(DEST, 'agent_command');
  const rawOld = (confGet(DEST, 'providers') || confGet(DEST, 'provider')).replace(/[ \t\n\r\f\v]/g, '');
  if (splitFirst(rawOld) === 'gemini') OLD_COMMAND = '';
  if (OLD_COMMAND !== '' && providerCommand(OLD_DEFAULT) === '' && confGet(DEST, `${OLD_DEFAULT}_command`) === '') {
    const bad = providerValidate(OLD_DEFAULT, OLD_COMMAND);
    if (bad) stopOn(bad);
    setProviderCommand(OLD_DEFAULT, OLD_COMMAND);
  }
  if (AGENT_COMMAND !== '') setProviderCommand(DEFAULT, AGENT_COMMAND);
  for (const p of splitList(SELECTED)) {
    let effective = providerCommand(p);
    if (effective === '') effective = confGet(DEST, `${p}_command`);
    const bad = providerValidate(p, effective);
    if (bad) stopOn(bad);
  }
  // Reject ambiguous ownership before changing any repository file. An unmatched, nested, inline,
  // reversed, or duplicate marker must never eat user content.
  for (const p of splitList(SELECTED)) {
    const f = `${DEST}/${providerInstructionFile(p)}`;
    if (!isFile(f)) continue;
    if (!ownedMarkersValid(f, 'provider')) die(`ambiguous GSD markers in ${f}; repair the start/end pair manually (all files preserved)`);
  }
  if (!ownedMarkersValid(`${DEST}/.gsd/INSTRUCTIONS.md`, 'canonical')) die('ambiguous canonical GSD markers; repair the start/end pair (all files preserved)');
  if (BASE === '') BASE = base(DEST);
  if (BASE === '') die('could not determine base branch — pass --base <branch>');
  if (BASE_EXPLICIT && git(DEST, ['show-ref', '--verify', '--quiet', `refs/heads/${BASE}`]).status !== 0) die(`branch '${BASE}' does not exist`);
  const WT_DIR = wtdir(DEST);
  let PM: string;
  if (isFile(`${DEST}/pnpm-lock.yaml`)) PM = 'pnpm install';
  else if (isFile(`${DEST}/yarn.lock`)) PM = 'yarn install';
  else if (isFile(`${DEST}/package-lock.json`) || isFile(`${DEST}/package.json`)) PM = 'npm install';
  else PM = 'none';
  out(`Toolkit     : ${PKG}\nTarget repo : ${DEST}\nBase branch : ${BASE}\nProviders   : ${SELECTED} (default: ${DEFAULT})\n\n`);

  if (!existsSync(CONF)) {
    let c = '# .gsd.conf — committed, inspectable GSD worktree configuration.\n';
    c += `base = ${BASE}\nwtdir = ${WT_DIR}\ninstall = ${PM}\nproviders = ${SELECTED}\n`;
    if (COMMAND.claude !== '') c += `claude_command = ${COMMAND.claude}\n`;
    if (COMMAND.codex !== '') c += `codex_command = ${COMMAND.codex}\n`;
    if (COMMAND.custom !== '') c += `custom_command = ${COMMAND.custom}\n`;
    c += '# start_mode = discuss  # optional; default is flow (gsdt-start opens /gsdt-flow)\n# flow = strict\n';
    c += NO_UI ? 'ui_gates = off\n' : '# ui_gates = strict  # UI gates: warn (default), strict, off\n';
    writeFileSync(CONF, c);
    say('✔ .gsd.conf (created)');
  } else {
    setConfKey(CONF, 'providers', SELECTED);
    removeConfKey(CONF, 'provider');
    removeConfKey(CONF, 'agent_command');
    if (COMMAND.claude !== '') setConfKey(CONF, 'claude_command', COMMAND.claude as string);
    if (COMMAND.codex !== '') setConfKey(CONF, 'codex_command', COMMAND.codex as string);
    removeConfKey(CONF, 'gemini_command');
    removeConfKey(CONF, 'gemini_model');
    if (COMMAND.custom !== '') setConfKey(CONF, 'custom_command', COMMAND.custom as string);
    if (BASE_EXPLICIT) setConfKey(CONF, 'base', BASE);
    if (NO_UI) setConfKey(CONF, 'ui_gates', 'off');
    say('✔ .gsd.conf (provider configuration updated; other keys preserved)');
  }
  if (TRACKER !== '') {
    setConfKey(CONF, 'tracker', TRACKER);
    if (TRACKER_COMMAND !== '') setConfKey(CONF, 'tracker_command', TRACKER_COMMAND);
    say(`✔ .gsd.conf: tracker = ${TRACKER}${TRACKER_COMMAND !== '' ? ` (${TRACKER_COMMAND})` : ''}`);
  }
  mkdirSync(`${DEST}/scripts/hooks`, { recursive: true });
  mkdirSync(`${DEST}/.gsd`, { recursive: true });
  for (const rel of [
    'scripts/gsdt-new-worktree-feature.sh',
    'scripts/gsdt-finish-worktree-feature.sh',
    'scripts/gsdt-derive-port.sh',
    'scripts/gsdt-planning-repair.sh',
    'scripts/hooks/gsdt-worktree-guard.sh',
  ]) {
    copyShim(`${PKG}/shims/${rel}`, `${DEST}/${rel}`);
    say(`✔ ${rel} (shim)`);
  }
  for (const pat of ['.gsd-install.status', '.gsd-install.log', '.claude/settings.local.json']) {
    const gi = `${DEST}/.gitignore`;
    const text = readLatin1(gi);
    if (text !== null && text.split('\n').includes(pat)) continue;
    // a .gitignore whose last line has no newline would glue our line onto it
    if (text !== null && text.length > 0 && !text.endsWith('\n')) appendFileSync(gi, '\n');
    appendFileSync(gi, `${pat}\n`);
  }
  {
    const line = baserefEnsure(DEST, '.');
    if (line !== '') say(line);
  }
  for (const l of planningApply(DEST)) say(l);

  const CANON = `${DEST}/.gsd/INSTRUCTIONS.md`;
  const canonText = readLatin1(CANON);
  if (canonText !== null && canonText.split('\n').includes('<!-- gsd-worktrees:canonical -->')) {
    let bak = `${CANON}.bak`;
    for (let n = 1; pathExists(bak); n++) bak = `${CANON}.bak.${n}`;
    copyFileSync(CANON, bak);
    // Migrate the recognizable legacy generated span, retaining additions after it.
    const SOL = '(?<![^\\n])';
    writeFileSync(CANON, canonText.replace(new RegExp(`${SOL}<!-- gsd-worktrees:canonical -->\\n[\\s\\S]*?${SOL}worktrees \`[^\\n]*\`\\.\\n?`), ''), 'latin1');
    say(`• legacy canonical content backed up to ${bak}`);
  }
  if (!existsSync(CANON)) writeFileSync(CANON, '');
  replaceBlock(CANON, 'canonical', canonicalBlock(SELECTED, DEFAULT, BASE, WT_DIR));
  say('✔ .gsd/INSTRUCTIONS.md (repo settings + core; the rules come from gsdt-rules)');

  const mergeHook = (provider: string, settings: string, event: string, matcher: string, command: string): void => {
    const shown = settings.startsWith(`${DEST}/`) ? settings.slice(DEST.length + 1) : settings;
    mkdirSync(path.dirname(settings), { recursive: true });
    if (!existsSync(settings)) writeFileSync(settings, '{}\n');
    if (providerHookState(DEST, provider) === 'present') {
      say(`• ${shown} already registers the guard`);
      return;
    }
    if (commandOnPath('jq') === null || spawnSync('jq', ['empty', settings], { stdio: 'ignore' }).status !== 0) {
      say(`⚠ ${shown} is not mergeable JSON; preserved unchanged (native hook absent)`);
      return;
    }
    if (providerHookState(DEST, provider) === 'invalid') {
      say(`⚠ incompatible hook structure in ${settings}; preserved unchanged`);
      return;
    }
    // Do not override an explicit user decision to disable native hooks.
    if (spawnSync('jq', ['-e', '.disableAllHooks == true or .hooksConfig.enabled == false', settings], { stdio: 'ignore' }).status === 0) {
      say(`⚠ native hooks disabled in ${settings}; preserved unchanged`);
      return;
    }
    const r = spawnSync(
      'jq',
      ['--arg', 'e', event, '--arg', 'm', matcher, '--arg', 'c', command, '.hooks //= {} | .hooks[$e] = ((.hooks[$e] // []) + [{matcher:$m,hooks:[{type:"command",command:$c}]}])', settings],
      { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
    );
    if (r.status !== 0) die(`could not merge native hook into ${settings} (original preserved)`);
    writeFileSync(settings, r.stdout);
    say(`✔ ${shown} (${provider} native guard hook)`);
  };

  for (const p of splitList(SELECTED)) {
    if (p === 'claude') preserveLegacyClaude(DEST);
    const entry = providerInstructionFile(p);
    const members = splitList(SELECTED).filter((m) => providerInstructionFile(m) === entry).join(',');
    const file = `${DEST}/${entry}`;
    if (!existsSync(file)) writeFileSync(file, '');
    replaceBlock(file, 'provider', providerEntryBlock(members));
    say(`✔ ${entry} (${members} entrypoint; unrelated content preserved)`);
    const meta = providerHookMetadata(p);
    if (meta !== null) mergeHook(p, `${DEST}/${meta.settings}`, meta.event, meta.matcher, meta.command);
    else say(`• ${p} native guard hook: unsupported; command-level guard remains active`);
  }

  // What an older release wrote for Gemini: the marked block in GEMINI.md (the file goes too when
  // nothing else is left) and our hook in .gemini/settings.json. Text and settings of the user's
  // own stay. A GEMINI.md that is a link (to AGENTS.md, say) is left alone.
  const GEMINI_FILES: string[] = [];
  {
    const f = `${DEST}/GEMINI.md`;
    const s = `${DEST}/.gemini/settings.json`;
    if (!isLink(f) && ownedBlockGet(f, 'provider') !== '' && ownedMarkersValid(f, 'provider')) {
      replaceBlock(f, 'provider', '');
      const t = readLatin1(f) ?? '';
      writeFileSync(f, t.replace(/\n+$/, '\n'), 'latin1');
      if (!/[^ \t\n\r\f\v]/.test(readLatin1(f) ?? '')) {
        unlinkSync(f);
        say('✔ GEMINI.md removed (only the gsd-toolkit block was in it; Gemini is no longer supported)');
      } else {
        say('✔ GEMINI.md: the gsd-toolkit block removed (Gemini is no longer supported)');
      }
      GEMINI_FILES.push('GEMINI.md');
    }
    if (isFile(s) && /gsdt?-worktree-guard/.test(readLatin1(s) ?? '')) {
      // Any hook naming the guard is ours (doctor's T061 finds it by that name), however its path
      // was written and under whichever event.
      if (!removeGuardHook(s)) say('⚠ .gemini/settings.json still names the worktree guard — remove that hook by hand');
      else {
        say('✔ .gemini/settings.json: the gsd-toolkit hook removed');
        GEMINI_FILES.push('.gemini/settings.json');
      }
    }
  }
  if (GEMINI_DROPPED) say('✔ .gsd.conf: gemini removed from providers (Gemini is no longer supported)');

  for (const f of [...gsdtScripts(DEST), `${DEST}/scripts/hooks/gsdt-worktree-guard.sh`]) {
    const rc = inherit('bash', ['-n', f]);
    if (rc !== 0) throw new Stop(rc);
  }
  say('✔ self-check (shims parse)');

  if (COMMIT) {
    if (DIRTY_BEFORE !== '') say('⚠ target repo had existing changes — skipped --commit');
    else {
      const files = ['.gsd.conf', '.gsd/INSTRUCTIONS.md', 'scripts', '.gitignore', '.gitattributes'];
      for (const p of splitList(SELECTED)) {
        files.push(providerInstructionFile(p));
        if (p === 'claude') files.push('.claude/settings.json');
      }
      // a removed Gemini file is staged only if git tracked it (else git add dies)
      for (const f of GEMINI_FILES) {
        if (existsSync(`${DEST}/${f}`) || git(DEST, ['ls-files', '--error-unmatch', '--', f]).status === 0) files.push(f);
      }
      let rc = inherit('git', ['-C', DEST, 'add', '--', ...files]);
      if (rc !== 0) throw new Stop(rc);
      const hook = planningHook(DEST);
      if (hook.versioned && isFile(hook.path)) {
        rc = inherit('git', ['-C', DEST, 'add', '--', hook.path]);
        if (rc !== 0) throw new Stop(rc);
      }
      if (git(DEST, ['diff', '--cached', '--quiet']).status !== 0) {
        rc = inherit('git', ['-C', DEST, 'commit', '-q', '-m', 'chore: add gsd-toolkit workflow']);
        if (rc !== 0) throw new Stop(rc);
      }
      say('✔ bootstrap changes committed');
    }
  }
  say();
  say(`✅ provider-neutral GSD workflow installed (default: ${DEFAULT})`);
  say(`Next: gsdt-init --no-launch (preserves ${SELECTED}), or gsdt-start -n "<desc>"`);
  return 0;
}

const splitFirst = (s: string): string => s.split(',')[0] as string;
const pathExists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** cp onto a file that exists keeps its mode, a new file gets the source's (minus the umask); then chmod +x */
function copyShim(src: string, dest: string): void {
  const data = readFileSync(src);
  if (existsSync(dest)) writeFileSync(dest, data);
  else writeFileSync(dest, data, { mode: statSync(src).mode & 0o777 });
  chmodPlusX(dest);
}

/** scripts/gsdt-*.sh, in byte order */
function gsdtScripts(dest: string): string[] {
  const dir = `${dest}/scripts`;
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^gsdt-.*\.sh$/.test(n))
    .sort()
    .map((n) => `${dir}/${n}`);
}

/** CLAUDE.md with the old unmarked GSD text: it is kept and the marked adapter is appended */
function preserveLegacyClaude(dest: string): void {
  const text = readLatin1(`${dest}/CLAUDE.md`);
  if (text === null) return;
  const ls = text.split('\n');
  if (!ls.some((l) => l.startsWith('## GSD planning system'))) return;
  if (!ls.some((l) => /scripts\/hooks\/gsdt?-worktree-guard.sh/.test(l))) return;
  if (ls.some((l) => /<!-- gsd-(toolkit|worktrees):provider:start -->/.test(l))) return;
  say('• preserved unmarked legacy GSD instructions in CLAUDE.md; the marked adapter will be appended');
}

