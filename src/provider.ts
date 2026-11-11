// src/provider.ts — port of lib/provider.sh (provider adapters: launch syntax
// and integration locations; no workflow logic). Conventions: see the top of
// src/common.ts. Validators return a Failure ({ok:false, code, message} — the
// text bash printed to stderr) or null for "fine"; resolvers return Result<T>.
import { chmodSync, copyFileSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CANONICAL_PREFIX,
  CANONICAL_SUFFIX,
  ENTRY_HOW_DEFAULT,
  ENTRY_TEMPLATE,
  RULES_BASE,
  RULES_SCREENS,
} from './rules-text.ts';
import { chomp, commandOnPath, confGet, git, gsdPkg, isExec, isFile, python, run } from './common.ts';
import type { Failure, Result } from './common.ts';

const fail = (message: string, code = 64): Failure => ({ ok: false, code, message });
const SPACE = /[ \t\n\r\f\v]/;

// ── provider facts ──────────────────────────────────────────────────────────

/** gsd_provider_known */
export function providerKnown(p: string): boolean {
  return p === 'claude' || p === 'codex' || p === 'custom';
}

export const GSD_GEMINI_GONE = 'Gemini is no longer supported (gsd-core, the new GSD, dropped it)';
/** gsd_provider_gone */
export function providerGone(p: string): boolean {
  return p === 'gemini';
}

/** gsd_provider_list_validate — null = fine */
export function providerListValidate(list: string): Failure | null {
  if (list === '' || list.startsWith(',') || list.endsWith(',') || list.includes(',,')) {
    return fail(`malformed providers list '${list}'; use comma-separated names, e.g. claude,codex`);
  }
  const seen = new Set<string>();
  for (const p of list.split(',')) {
    if (providerGone(p)) return fail(`${GSD_GEMINI_GONE} — drop it from this repo with: gsdt-init --no-launch`);
    if (!providerKnown(p)) return fail(`unknown provider '${p}' in providers; expected claude, codex, or custom`);
    if (seen.has(p)) return fail(`duplicate provider '${p}' in providers; list each provider once`);
    seen.add(p);
  }
  return null;
}

/** gsd_provider_default_command — null for custom (bash status 1); '' for an unknown name (status 0, no output) */
export function providerDefaultCommand(p: string): string | null {
  if (p === 'custom') return null;
  return p === 'claude' ? 'claude' : p === 'codex' ? 'codex' : ''; // unknown: bash prints nothing, status 0
}

/** gsd_provider_instruction_file — '' for an unknown provider (bash prints nothing) */
export function providerInstructionFile(p: string): string {
  return p === 'claude' ? 'CLAUDE.md' : p === 'codex' || p === 'custom' ? 'AGENTS.md' : '';
}

const nz = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);

/** gsd_provider_skill_root — provider, optional home; null for custom (status 1); '' for an unknown name */
export function providerSkillRoot(p: string, home?: string): string | null {
  const h = home || process.env.HOME || '';
  if (p === 'claude') return nz(process.env.GSD_CLAUDE_SKILL_DIR) ?? nz(process.env.GSD_SKILL_DIR) ?? `${h}/.claude/skills`;
  if (p === 'codex') return nz(process.env.GSD_CODEX_SKILL_DIR) ?? `${h}/.agents/skills`;
  return p === 'custom' ? null : ''; // unknown: bash prints nothing, status 0
}

/** gsd_provider_native_hook */
export function providerNativeHook(p: string): 'supported' | 'unsupported' {
  return p === 'claude' ? 'supported' : 'unsupported';
}

/** gsd_provider_review_flag — null (bash status 1) for a provider with none */
export function providerReviewFlag(p: string): string | null {
  return p === 'claude' || p === 'codex' ? `--${p}` : null;
}

/** gsd_provider_ui_tip — null when there is none */
export function providerUiTip(p: string): string | null {
  if (p === 'claude') {
    return '/plugin marketplace add anthropics/claude-code  then  /plugin install frontend-design@claude-code-plugins;  claude mcp add playwright npx @playwright/mcp@latest';
  }
  if (p === 'codex') return `add the Playwright MCP server (npx @playwright/mcp@latest) to the ${p} config`;
  return null;
}

/** gsd_provider_ui_addon — $1=provider $2=addon → one line, or null (bash status 1) */
export function providerUiAddon(p: string, addon: string): string | null {
  if (addon === 'impeccable') {
    if (p === 'claude') {
      return 'Impeccable design skill (/impeccable audit, polish): copy dist/claude-code/.claude from github.com/pbakaus/impeccable into the project';
    }
    if (p === 'codex') {
      return 'Impeccable design skill: copy dist/agents/.agents and dist/codex/.codex/hooks.json from github.com/pbakaus/impeccable into the project';
    }
    return null;
  }
  if (addon === 'shadcn-mcp') {
    if (p === 'claude') return 'shadcn MCP (the agent picks real components): npx shadcn@latest mcp init --client claude';
    if (p === 'codex') {
      return 'shadcn MCP: add [mcp_servers.shadcn] command = "npx", args = ["shadcn@latest", "mcp"] to ~/.codex/config.toml';
    }
    return null;
  }
  return null;
}

export type HookMetadata = { settings: string; event: string; matcher: string; command: string };

/** gsd_provider_hook_metadata — GSD_HOOK_SETTINGS/EVENT/MATCHER/COMMAND; null = no native hook */
export function providerHookMetadata(p: string): HookMetadata | null {
  if (p === 'claude') {
    return {
      settings: '.claude/settings.json',
      event: 'PreToolUse',
      matcher: 'Skill',
      command: '$CLAUDE_PROJECT_DIR/scripts/hooks/gsdt-worktree-guard.sh',
    };
  }
  return null;
}

/** gsd_provider_hook_state — present|absent|invalid|unverified|unsupported */
export function providerHookState(repo: string, provider: string): string {
  const meta = providerHookMetadata(provider);
  if (meta === null) return 'unsupported';
  const file = `${repo}/${meta.settings}`;
  if (!isFile(file)) return 'absent';
  // The documented states include `unverified` (no jq), so the check stays jq's own.
  if (commandOnPath('jq') === null) return 'unverified';
  const valid = run('jq', [
    '-e',
    '--arg',
    'e',
    meta.event,
    'type == "object" and ((.hooks // {}) | type == "object") and ((.hooks[$e] // []) | type == "array")',
    file,
  ]);
  if (valid.status !== 0) return 'invalid';
  const present = run('jq', [
    '-e',
    '--arg',
    'e',
    meta.event,
    '--arg',
    'm',
    meta.matcher,
    '--arg',
    'c',
    meta.command,
    `
    (.disableAllHooks != true) and (.hooksConfig.enabled != false) and
    any((.hooks[$e] // [])[]; .matcher == $m and .disabled != true and
      any((.hooks // [])[]; .type == "command" and .command == $c and .disabled != true))
  `,
    file,
  ]);
  return present.status === 0 ? 'present' : 'absent';
}

/** gsd_provider_user_hook_file — the user-level file holding an agent's hooks (null = none) */
export function providerUserHookFile(p: string): string | null {
  if (p === 'claude') {
    const root = providerSkillRoot('claude') as string;
    return nz(process.env.GSD_CLAUDE_SETTINGS) ?? `${path.dirname(root)}/settings.json`;
  }
  if (p === 'codex') {
    return nz(process.env.GSD_CODEX_HOOKS) ?? `${nz(process.env.CODEX_HOME) ?? `${process.env.HOME ?? ''}/.codex`}/hooks.json`;
  }
  return null;
}

/**
 * gsd_stale_hooks — GSD hooks that run a file that is gone: the helper's
 * tab-separated lines ('' without python). TODO(P5): lib/gsd_hook_paths.py.
 */
export function staleHooks(repo = ''): string {
  const py = python() ?? 'python3';
  if (commandOnPath(py) === null) return '';
  const args: string[] = [];
  for (const p of ['claude', 'codex']) args.push(`user:${providerUserHookFile(p)}`);
  if (repo !== '') {
    args.push('--project', repo);
    for (const f of ['.claude/settings.json', '.claude/settings.local.json']) args.push(`project:${repo}/${f}`);
  }
  return run(py, [`${gsdPkg()}/lib/gsd_hook_paths.py`, ...args]).stdout;
}

/**
 * gsd_stale_hooks_notice — the stderr lines (one per settings file with broken
 * hooks); [] when stderr is no terminal (GSD_UPDATE_NOTICE=always forces them).
 */
export function staleHooksNotice(): string[] {
  if (!process.stderr.isTTY && process.env.GSD_UPDATE_NOTICE !== 'always') return [];
  const seen = new Set<string>();
  const n = new Map<string, number>();
  for (const line of staleHooks('').split('\n')) {
    if (line === '') continue;
    const f = line.split('\t');
    const key = `${f[0] ?? ''}\t${f[3] ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    n.set(f[0] ?? '', (n.get(f[0] ?? '') ?? 0) + 1);
  }
  return [...n].map(([f, c]) => `⚠ ${c} GSD hook(s) in ${f} run a file that is gone, so they fail silently — run gsdt-doctor`);
}

// ── the marked blocks this toolkit owns in a target repo's files ────────────

export const GSD_MARK_RE = 'gsd-(toolkit|worktrees)';

const lines = (t: string): string[] => {
  const l = t.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
};
const readBytes = (f: string): string | null => {
  try {
    return readFileSync(f, 'latin1');
  } catch {
    return null;
  }
};
const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** gsd_owned_markers_valid — an absent block (or file) is valid */
export function ownedMarkersValid(file: string, kind: string): boolean {
  if (!isFile(file)) return true;
  const text = readBytes(file);
  if (text === null) return true;
  const k = reEscape(kind);
  const start = new RegExp(`<!-- ${GSD_MARK_RE}:${k}:start -->`);
  const startFull = new RegExp(`^<!-- ${GSD_MARK_RE}:${k}:start -->$`);
  const end = new RegExp(`<!-- ${GSD_MARK_RE}:${k}:end -->`);
  const endFull = new RegExp(`^<!-- ${GSD_MARK_RE}:${k}:end -->$`);
  let state = 0;
  let starts = 0;
  let bad = false;
  for (const line of lines(text)) {
    if (start.test(line)) {
      // awk: `!~ ^start$ || state != 0 || starts++` — starts++ runs only when the first two are false
      if (!startFull.test(line) || state !== 0 || starts++ > 0) bad = true;
      state = 1;
    }
    if (end.test(line)) {
      if (!endFull.test(line) || state !== 1) bad = true;
      state = 2;
    }
  }
  return !(bad || state === 1);
}

/** gsd_owned_block_get — the marked block as it is in the file (every line + "\n"; '' when none) */
export function ownedBlockGet(file: string, kind: string): string {
  if (!isFile(file)) return '';
  const text = readBytes(file);
  if (text === null) return '';
  const k = reEscape(kind);
  const start = new RegExp(`^<!-- ${GSD_MARK_RE}:${k}:start -->$`);
  const end = new RegExp(`^<!-- ${GSD_MARK_RE}:${k}:end -->$`);
  let on = false;
  let out = '';
  for (const line of lines(text)) {
    if (!on && start.test(line)) on = true;
    if (on) out += `${line}\n`;
    if (on && end.test(line)) on = false;
  }
  return Buffer.from(out, 'latin1').toString('utf8');
}

/** gsd_provider_instruction_members — the adapters named in the provider block's header (one per matching line) */
export function providerInstructionMembers(file: string): string[] {
  const out: string[] = [];
  for (const l of lines(ownedBlockGet(file, 'provider'))) {
    const m = /^## GSD worktrees \(([^)]*) adapter\)$/.exec(l);
    if (m) out.push(m[1] as string);
  }
  return out;
}

/** gsd_provider_instruction_integrated — repo, provider */
export function providerInstructionIntegrated(repo: string, provider: string): boolean {
  const file = `${repo}/${providerInstructionFile(provider)}`;
  if (!ownedMarkersValid(file, 'provider')) return false;
  const text = readBytes(file);
  if (text === null) return false;
  const startLine = new RegExp(`^<!-- ${GSD_MARK_RE}:provider:start -->$`);
  if (!lines(text).some((l) => startLine.test(l))) return false;
  const members = providerInstructionMembers(file).join('\n');
  if (!`,${members},`.includes(`,${provider},`)) return false;
  if (!ownedBlockGet(file, 'provider').includes('Read and follow `.gsd/INSTRUCTIONS.md`')) return false;
  const canon = readBytes(`${repo}/.gsd/INSTRUCTIONS.md`);
  if (canon === null) return false;
  const canonStart = new RegExp(`^<!-- ${GSD_MARK_RE}:canonical:start -->$`);
  return lines(canon).some((l) => canonStart.test(l)) && ownedMarkersValid(`${repo}/.gsd/INSTRUCTIONS.md`, 'canonical');
}

// ── the generated text (one definition; byte-identical with the bash) ───────

/** gsd_rules_text — ui 'on'|'off' (off leaves out the screens paragraph); ends with a newline */
export function rulesText(ui = 'on'): string {
  return `${RULES_BASE}${ui === 'off' ? '' : RULES_SCREENS}\n`;
}

/** gsd_repo_values — providers, default provider, base, worktree dir, [ui_gates, flow]; ends with a newline */
export function repoValues(providers: string, defaultProvider: string, base: string, wtdirName: string, uiGates = '', flow = ''): string {
  if (uiGates !== '') {
    return `Providers: \`${providers}\` (default: first, \`${defaultProvider}\`); base \`${base}\`;\nworktrees \`../${wtdirName}/\`; flow \`${flow || 'off'}\`; ui_gates \`${uiGates}\`.\n`;
  }
  return `Providers: \`${providers}\` (default: first, \`${defaultProvider}\`); base \`${base}\`;\nworktrees \`../${wtdirName}/\`.\n`;
}

/** gsd_canonical_block — providers, default provider, base, worktree dir */
export function canonicalBlock(providers: string, defaultProvider: string, base: string, wtdirName: string): string {
  return `${CANONICAL_PREFIX}${chomp(repoValues(providers, defaultProvider, base, wtdirName))}\n${CANONICAL_SUFFIX}`;
}

const ENTRY_HOW_CLAUDE = `The toolkit's rules are the output of \`gsdt-rules\`: a session-start hook loads
them ("GSD toolkit rules"); when they are not in your context, run \`gsdt-rules\`
before any GSD or phase work and follow its output.`;

/** gsd_provider_entry_block — the providers sharing this instruction file (comma list) */
export function providerEntryBlock(providers: string): string {
  const how = `,${providers},`.includes(',claude,') ? ENTRY_HOW_CLAUDE : ENTRY_HOW_DEFAULT;
  return ENTRY_TEMPLATE.replace('@@M@@', () => providers).replace('@@HOW@@', () => how);
}

/**
 * gsd_replace_owned_block — replace (or append) the marked block of `kind` in
 * file with the text of blockFile. Caller prevalidates the markers. false = failed.
 * Like the bash: a file that did not exist is created with mode 0600 (mktemp's).
 */
export function replaceOwnedBlock(file: string, kind: string, blockFile: string): boolean {
  let block: string;
  try {
    block = readFileSync(blockFile, 'latin1');
  } catch {
    return false;
  }
  let content = '';
  let mode = 0o600;
  let missing = false;
  try {
    content = readFileSync(file, 'latin1');
    mode = statSync(file).mode & 0o7777;
  } catch {
    missing = true;
  }
  const k = reEscape(kind);
  const startRe = new RegExp(`(?<![^\\n])<!-- gsd-(?:toolkit|worktrees):${k}:start -->(?![^\\n])`);
  let result: string;
  if (missing) {
    // perl -0777 -pe finds no file, so it prints nothing: bash creates an EMPTY file (mode 0600).
    // The block is not written — kept for parity.
    result = '';
  } else if (startRe.test(content)) {
    const full = new RegExp(
      `(?<![^\\n])<!-- gsd-(?:toolkit|worktrees):${k}:start -->\\n[\\s\\S]*?(?<![^\\n])<!-- gsd-(?:toolkit|worktrees):${k}:end -->(?:\\n|$)`,
      'g',
    );
    result = content.replace(full, () => block);
  } else {
    result = `${content}${content.length > 0 && !content.endsWith('\n') ? '\n' : ''}\n${block}`;
  }
  let isLink = false;
  try {
    isLink = lstatSync(file).isSymbolicLink();
  } catch {
    // none
  }
  if (isLink) {
    try {
      writeFileSync(file, result, 'latin1');
    } catch {
      return false;
    }
    return true;
  }
  let tmpDir = '';
  try {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'gsd-block.'));
    const tmp = `${tmpDir}/f`;
    writeFileSync(tmp, result, { encoding: 'latin1', mode });
    chmodSync(tmp, mode);
    try {
      renameSync(tmp, file);
    } catch {
      copyFileSync(tmp, file); // across devices: mv would copy too
    }
    return true;
  } catch {
    return false;
  } finally {
    if (tmpDir !== '') rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** gsd_command_guards_active — toolkit package; the native hook/shim is not required */
export function commandGuardsActive(pkg: string): boolean {
  if (!(isExec(`${pkg}/bin/gsdt-worktree-guard`) && isExec(`${pkg}/bin/gsdt-start`) && isExec(`${pkg}/bin/gsdt-flow-next`))) {
    return false;
  }
  const has = (f: string): boolean => (readBytes(f) ?? '').split('\n').some((l) => /gsdt-worktree-guard.*--command/.test(l));
  // P3b: flow-next is TypeScript and runs the guard in-process (guardArgv(['--command', …))
  const inProcess = (readBytes(`${pkg}/src/commands/flow-next.ts`) ?? '').includes("guardArgv(['--command'");
  return has(`${pkg}/bin/gsdt-start`) && (has(`${pkg}/bin/gsdt-flow-next`) || inProcess);
}

// ── resolving provider, executable, model, start mode, compact point ────────

/** gsd_provider_validate — provider, executable override */
export function providerValidate(p: string, c = ''): Failure | null {
  if (providerGone(p)) return fail(`${GSD_GEMINI_GONE} — use claude, codex, or custom`);
  if (!providerKnown(p)) return fail(`unknown provider '${p}' (expected claude, codex, or custom)`);
  if (p === 'custom' && c === '') return fail("provider 'custom' requires an explicit agent command");
  if (SPACE.test(c)) return fail('agent command must be one executable path/name, not a shell template');
  return null;
}

export type ProviderResolved = { provider: string; command: string };

/** gsd_provider_resolve — repo, cli provider, cli command → GSD_PROVIDER_RESOLVED + GSD_AGENT_COMMAND_RESOLVED */
export function providerResolve(repo: string, cliP = '', cliC = ''): Result<ProviderResolved> {
  const env = process.env;
  const configured = confGet(repo, 'providers');
  let hasKey = false;
  try {
    hasKey = (readFileSync(`${repo}/.gsd.conf`, 'latin1') ?? '').split('\n').some((l) => /^[ \t\n\r\f\v]*providers[ \t\n\r\f\v]*=/.test(l));
  } catch {
    // no conf
  }
  if (configured !== '' || hasKey) {
    const bad = providerListValidate(configured);
    if (bad) return bad;
  }
  const confP = configured !== '' ? (configured.split(',')[0] as string) : confGet(repo, 'provider');
  const confDefault = confP || 'claude';
  let provider = cliP || env.GSD_PROVIDER || confP;
  let legacyC = '';
  if (provider === '' && env.GSD_AGENT) {
    const legacy = env.GSD_AGENT;
    if (providerKnown(legacy) || providerGone(legacy)) provider = legacy;
    else {
      // An unknown legacy name is a custom executable, the LOWEST-priority source.
      provider = 'custom';
      legacyC = legacy;
    }
  }
  provider = provider || 'claude';
  if (!providerKnown(provider)) {
    return providerValidate(provider, '') ?? fail('', 64);
  }
  const providerEnvC = provider === 'claude' ? env.GSD_CLAUDE_COMMAND : provider === 'codex' ? env.GSD_CODEX_COMMAND : env.GSD_CUSTOM_COMMAND;
  const providerConfC = confGet(repo, `${provider}_command`);
  const confC = provider === confDefault ? confGet(repo, 'agent_command') : '';
  let command = cliC || env.GSD_AGENT_COMMAND || providerEnvC || providerConfC || confC || legacyC;
  const bad = providerValidate(provider, command);
  if (bad) return bad;
  if (command === '') {
    const d = providerDefaultCommand(provider);
    if (d === null) return fail('', 64);
    command = d;
  }
  return { ok: true, value: { provider, command } };
}

/** gsd_model_validate — provider, optional model; default means CLI default */
export function modelValidate(p: string, model = ''): Failure | null {
  if (model === '' || model === 'default') return null;
  if (p === 'custom') return fail('custom provider has no model-flag adapter; configure its wrapper or use --model default');
  // eslint-disable-next-line no-control-regex
  if (model.startsWith('-') || SPACE.test(model) || /[\x00-\x1f\x7f]/.test(model)) {
    return fail("model must be one model ID or alias, without whitespace or a leading '-'");
  }
  return null;
}

/** gsd_model_resolve — repo, provider, optional CLI override → GSD_MODEL_RESOLVED ('' = CLI default) */
export function modelResolve(repo: string, p: string, cli = ''): Result<string> {
  const env = process.env;
  const envModel = p === 'claude' ? env.GSD_CLAUDE_MODEL : p === 'codex' ? env.GSD_CODEX_MODEL : undefined;
  const configured = confGet(repo, `${p}_model`);
  let model = cli || env.GSD_MODEL || envModel || configured;
  const bad = modelValidate(p, model);
  if (bad) return bad;
  if (model === 'default') model = '';
  return { ok: true, value: model };
}

/** gsd_start_mode_resolve — repo, optional CLI override → discuss | flow */
export function startModeResolve(repo: string, cliMode = ''): Result<string> {
  const mode = cliMode || confGet(repo, 'start_mode') || 'flow';
  if (mode === 'discuss' || mode === 'flow') return { ok: true, value: mode };
  return fail(`invalid start_mode '${mode}' (expected discuss or flow)`);
}

export const GSD_COMPACT_AT_DEFAULT = 300000;

/** gsd_compact_resolve — repo → GSD_COMPACT_RESOLVED ('' = CLI default) */
export function compactResolve(repo: string): Result<string> {
  let v = process.env.GSD_COMPACT_AT || confGet(repo, 'compact_at');
  v = v || String(GSD_COMPACT_AT_DEFAULT);
  if (v === 'default') return { ok: true, value: '' };
  if (!/^[0-9]+$/.test(v) || BigInt(v) < 100000n || BigInt(v) > 1000000n) {
    return fail(`invalid compact_at '${v}' (expected tokens 100000-1000000, or default)`);
  }
  return { ok: true, value: BigInt(v).toString() };
}

/**
 * gsd_compact_settings — repo, worktree, tokens ('' = remove ours). Returns what
 * bash echoed (a note, or '' ). Best effort, never fatal.
 * TODO(P8): lib/gsd_claude_env.py is still run as a program.
 */
export function compactSettings(repo: string, wt: string, tokens = ''): string {
  let n = tokens;
  const f = '.claude/settings.local.json';
  let providers = confGet(repo, 'providers');
  providers = providers || confGet(repo, 'provider');
  if (!`,${providers || 'claude'},`.includes(',claude,')) return '';
  if (process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) n = '';
  if (n === '' && !isFile(`${wt}/${f}`)) return '';
  if (git(wt, ['ls-files', '--error-unmatch', '--', f]).status === 0 || git(wt, ['check-ignore', '-q', '--', f]).status !== 0) {
    return `• ${f} is tracked or not gitignored — compact point not saved there (a plain 'claude' keeps the CLI's own)\n`;
  }
  const py = python();
  if (py === null) return `• no python 3.7+ — compact point not saved in ${f}\n`;
  const args = [`${gsdPkg()}/lib/gsd_claude_env.py`, `${wt}/${f}`, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'];
  if (n !== '') args.push(n);
  const r = run(py, args, { inheritStderr: true });
  let out = r.stdout;
  if (r.status !== 0) out += `• could not update ${f} (not a JSON object?) — compact point not saved there\n`;
  return out;
}

// ── prompts, argv, rendering ────────────────────────────────────────────────

/** gsd_provider_prompt — provider, kind (discuss|flow|batch|new|ingest), phase-or-text ('' for an unknown kind) */
export function providerPrompt(p: string, kind: string, n = ''): string {
  switch (kind) {
    case 'discuss':
      if (p === 'claude') return `/gsd-discuss-phase ${n}`;
      if (p === 'codex') {
        return `Discuss GSD phase ${n} with the user and write its context artifact. Use the gsd-discuss-phase skill if available and obey .gsd/INSTRUCTIONS.md.`;
      }
      if (p === 'custom') return `Discuss GSD phase ${n} with the user and write its context artifact; obey .gsd/INSTRUCTIONS.md.`;
      return '';
    case 'flow':
      if (p === 'claude') return `/gsdt-flow ${n}`;
      if (p === 'codex') {
        return `Use the gsdt-flow skill to drive phase ${n}. Start by running gsdt-flow-next ${n} and obey every reported gate.`;
      }
      if (p === 'custom') {
        return `Drive GSD phase ${n} by running gsdt-flow-next ${n} before every phase step; obey every gate in .gsd/INSTRUCTIONS.md.`;
      }
      return '';
    case 'batch':
      if (p === 'claude') return `/gsdt-batch ${n}`;
      if (p === 'codex') return `Use the gsdt-batch skill to run this task list or brief as one batch: ${n}`;
      if (p === 'custom') {
        return `Run this task list or brief as one batch, following the gsdt-batch skill steps (scout, sort, gsd-quick-batch, gsd-fast, gsdt-batch-report): ${n}`;
      }
      return '';
    case 'new':
      return p === 'claude'
        ? '/gsd-new-project'
        : 'Initialize GSD planning for this repository. Use the gsd-new-project skill if available; otherwise follow the installed GSD planning documentation.';
    case 'ingest':
      return p === 'claude'
        ? '/gsd-ingest-docs'
        : 'Initialize GSD planning by ingesting the existing project documents. Use the gsd-ingest-docs skill if available; otherwise follow the installed GSD planning documentation.';
    default:
      return '';
  }
}

/**
 * gsd_provider_argv — provider, executable, prompt, optional model, optional
 * compact_at tokens → GSD_LAUNCH_ARGV
 */
export function providerArgv(p: string, c: string, prompt: string, model = '', compact = ''): Result<string[]> {
  const bad = modelValidate(p, model);
  if (bad) return bad;
  let argv = [c];
  // Claude reads the compact point only from its environment; a value the user already exported wins.
  if (compact !== '' && p === 'claude' && !process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) {
    argv = ['env', `CLAUDE_CODE_AUTO_COMPACT_WINDOW=${compact}`, c];
  }
  if (compact !== '' && p === 'codex') argv.push('-c', `model_auto_compact_token_limit=${compact}`);
  if ((p === 'claude' || p === 'codex') && model !== '' && model !== 'default') argv.push('--model', model);
  argv.push(prompt);
  return { ok: true, value: argv };
}

// bash's `printf %q` (bash 5, and 3.2 with a locale set): a string holding a
// control character is written whole as $'…' (\a \b \E \f \n \r \t \v, other
// controls as \NNN octal, \\ and \'); otherwise these characters get a backslash
// (`#` only first) and everything else — non-ASCII included — passes through.
// Not replicated: bash >= 4.4 also escapes a leading `~` and no longer escapes
// `,`; the text is for people to paste and both forms are valid.
const Q_ESC = new Set(' !"$&\'()*,;<>?[\\]^`{|}'.split(''));
const Q_NAMED: Record<number, string> = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r', 27: 'E' };

/** gsd_shell_quote */
export function shellQuote(s: string): string {
  if (s === '') return "''";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(s)) {
    let out = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0) as number;
      if (cp < 0x20 || cp === 0x7f) out += `\\${Q_NAMED[cp] ?? cp.toString(8).padStart(3, '0')}`;
      else if (ch === '\\' || ch === "'") out += `\\${ch}`;
      else out += ch;
    }
    return `$'${out}'`;
  }
  let out = '';
  let i = 0;
  for (const ch of s) {
    out += Q_ESC.has(ch) || (ch === '#' && i === 0) ? `\\${ch}` : ch;
    i++;
  }
  return out;
}

/** gsd_provider_render — cwd followed by argv */
export function providerRender(cwd: string, ...argv: string[]): string {
  let out = `cd ${shellQuote(cwd)} &&`;
  for (const a of argv) out += ` ${shellQuote(a)}`;
  return out;
}
