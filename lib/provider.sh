#!/usr/bin/env bash
# Provider adapters for launch syntax and integration locations.  This file
# deliberately contains no workflow/state-machine logic.

gsd_provider_known() {
  case "$1" in claude|codex|custom) return 0 ;; *) return 1 ;; esac
}

# Gemini was a provider until 0.5.0, when GSD (gsd-core) dropped it. The name
# is refused with this reason — never taken as a custom executable — and
# gsd-init --no-launch removes what an older release set up for it.
GSD_GEMINI_GONE="Gemini is no longer supported (gsd-core, the new GSD, dropped it)"
gsd_provider_gone() { [ "$1" = gemini ]; }

gsd_provider_list_validate() {
  local remaining=$1 p seen=,
  case "$remaining" in ''|,*|*,|*,,*)
    echo "malformed providers list '$remaining'; use comma-separated names, e.g. claude,codex" >&2
    return 64 ;;
  esac
  while :; do
    p=${remaining%%,*}
    if gsd_provider_gone "$p"; then
      printf '%s — drop it from this repo with: gsd-init --no-launch\n' "$GSD_GEMINI_GONE" >&2
      return 64
    fi
    gsd_provider_known "$p" || {
      printf "unknown provider '%s' in providers; expected claude, codex, or custom\n" "$p" >&2
      return 64
    }
    case "$seen" in *",$p,"*) echo "duplicate provider '$p' in providers; list each provider once" >&2; return 64 ;; esac
    seen="$seen$p,"
    case "$remaining" in *,*) remaining=${remaining#*,} ;; *) break ;; esac
  done
}

gsd_provider_default_command() {
  case "$1" in
    claude) printf '%s\n' claude ;;
    codex) printf '%s\n' codex ;;
    custom) return 1 ;;
  esac
}

gsd_provider_instruction_file() {
  case "$1" in
    claude) printf '%s\n' CLAUDE.md ;;
    codex) printf '%s\n' AGENTS.md ;;
    custom) printf '%s\n' AGENTS.md ;;
  esac
}

gsd_provider_skill_root() { # provider, optional home
  local p=$1 h=${2:-$HOME}
  case "$p" in
    claude) printf '%s\n' "${GSD_CLAUDE_SKILL_DIR:-${GSD_SKILL_DIR:-$h/.claude/skills}}" ;;
    codex) printf '%s\n' "${GSD_CODEX_SKILL_DIR:-$h/.agents/skills}" ;;   # Codex's own; ~/.codex/skills is its old place
    custom) return 1 ;;
  esac
}

gsd_provider_native_hook() {
  case "$1" in claude) printf '%s\n' supported ;; *) printf '%s\n' unsupported ;; esac
}

# Flags verified against the external GSD review skill. This toolkit prints
# its invocation; it does not install that skill or execute a reviewer itself.
gsd_provider_review_flag() {
  case "$1" in claude|codex) printf -- '--%s\n' "$1" ;; *) return 1 ;; esac
}

# Optional UI tools (ui_gates): gsd-init prints these as a tip, nothing checks
# or requires them — gsd-ui check runs the project's Playwright from the
# shell, which every provider can do.
gsd_provider_ui_tip() {
  case "$1" in
    claude) printf '%s\n' '/plugin marketplace add anthropics/claude-code  then  /plugin install frontend-design@claude-code-plugins;  claude mcp add playwright npx @playwright/mcp@latest' ;;
    codex) printf '%s\n' "add the Playwright MCP server (npx @playwright/mcp@latest) to the $1 config" ;;
    *) return 1 ;;
  esac
}

# Add-ons gsd-doctor suggests for a project with screens (notes, never
# findings). $1=provider $2=addon → one line on how to get it; 1 = no text.
#   impeccable  design skill: audit/critique/polish commands and automatic
#               checks for AI-made pages (github.com/pbakaus/impeccable)
#   shadcn-mcp  the shadcn registry as an MCP server (ui.shadcn.com/docs/mcp)
gsd_provider_ui_addon() {
  case "$2" in
    impeccable)
      case "$1" in
        claude) printf '%s\n' 'Impeccable design skill (/impeccable audit, polish): copy dist/claude-code/.claude from github.com/pbakaus/impeccable into the project' ;;
        codex)  printf '%s\n' 'Impeccable design skill: copy dist/agents/.agents and dist/codex/.codex/hooks.json from github.com/pbakaus/impeccable into the project' ;;
        *) return 1 ;;
      esac ;;
    shadcn-mcp)
      case "$1" in
        claude) printf '%s\n' 'shadcn MCP (the agent picks real components): npx shadcn@latest mcp init --client claude' ;;
        codex)  printf '%s\n' 'shadcn MCP: add [mcp_servers.shadcn] command = "npx", args = ["shadcn@latest", "mcp"] to ~/.codex/config.toml' ;;
        *) return 1 ;;
      esac ;;
    *) return 1 ;;
  esac
}

# Shared registration metadata. Unsupported providers have no settings file.
gsd_provider_hook_metadata() {
  case "$1" in
    claude) GSD_HOOK_SETTINGS=.claude/settings.json; GSD_HOOK_EVENT=PreToolUse; GSD_HOOK_MATCHER=Skill; GSD_HOOK_COMMAND='$CLAUDE_PROJECT_DIR/scripts/hooks/gsd-worktree-guard.sh' ;;
    *) return 1 ;;
  esac
}

gsd_provider_hook_state() { # repo, provider => present|absent|invalid|unverified|unsupported
  gsd_provider_hook_metadata "$2" || { echo unsupported; return; }
  local file=$1/$GSD_HOOK_SETTINGS
  [ -f "$file" ] || { echo absent; return; }
  command -v jq >/dev/null 2>&1 || { echo unverified; return; }
  if ! jq -e --arg e "$GSD_HOOK_EVENT" 'type == "object" and ((.hooks // {}) | type == "object") and ((.hooks[$e] // []) | type == "array")' "$file" >/dev/null 2>&1; then echo invalid; return; fi
  if jq -e --arg e "$GSD_HOOK_EVENT" --arg m "$GSD_HOOK_MATCHER" --arg c "$GSD_HOOK_COMMAND" '
    (.disableAllHooks != true) and (.hooksConfig.enabled != false) and
    any((.hooks[$e] // [])[]; .matcher == $m and .disabled != true and
      any((.hooks // [])[]; .type == "command" and .command == $c and .disabled != true))
  ' "$file" >/dev/null 2>&1; then echo present; else echo absent; fi
}

# The user-level file that holds an agent's hooks: GSD's own, and our --global
# guard (install.sh writes it). Claude's sits next to its skills dir; Codex
# keeps hooks in $CODEX_HOME but skills in ~/.agents/skills.
gsd_provider_user_hook_file() { # provider => path
  case "$1" in
    claude) printf '%s\n' "${GSD_CLAUDE_SETTINGS:-$(dirname "$(gsd_provider_skill_root claude)")/settings.json}" ;;
    codex) printf '%s\n' "${GSD_CODEX_HOOKS:-${CODEX_HOME:-$HOME/.codex}/hooks.json}" ;;
    *) return 1 ;;
  esac
}

# GSD hooks that run a file that is gone (lib/gsd_hook_paths.py): every
# agent's user-level file, plus the repo's own settings when a repo is given.
# Prints the helper's tab-separated lines; nothing without python.
gsd_stale_hooks() { # [repo]
  local py p args=()
  py=$(gsd_python 2>/dev/null) || py=python3
  command -v "$py" >/dev/null 2>&1 || return 0
  for p in claude codex; do args+=("user:$(gsd_provider_user_hook_file "$p")"); done
  if [ -n "${1:-}" ]; then
    args+=(--project "$1")
    for p in .claude/settings.json .claude/settings.local.json; do args+=("project:$1/$p"); done
  fi
  "$py" "$GSD_PKG/lib/gsd_hook_paths.py" "${args[@]}" 2>/dev/null || true
}

# One stderr line per settings file with broken GSD hooks — they fail without
# a word, so gsd-start and gsd-list say it. Terminal only, like the update
# notice (GSD_UPDATE_NOTICE=always forces it); gsd-doctor has the details.
# User-level files only: the repo's own are doctor's.
gsd_stale_hooks_notice() {
  [ -t 2 ] || [ "${GSD_UPDATE_NOTICE:-}" = always ] || return 0
  gsd_stale_hooks "" | awk -F '\t' '!seen[$1 FS $4]++ { n[$1]++ }
    END { for (f in n) printf "⚠ %d GSD hook(s) in %s run a file that is gone, so they fail silently — run gsd-doctor\n", n[f], f }' >&2
  return 0
}

# The marked blocks this toolkit owns in a target repo's files. They are
# written as <!-- gsd-toolkit:<kind>:start/end -->; releases before 0.8.0 wrote
# gsd-worktrees: instead. Both are read (a start of one name may end with the
# other), so gsd-init --no-launch replaces an old block in place and doctor
# T016 reports it as out of date.
GSD_MARK_RE='gsd-(toolkit|worktrees)'
gsd_owned_markers_valid() { # file, marker kind; an absent block is valid
  [ -f "$1" ] || return 0
  awk -v start="<!-- $GSD_MARK_RE:$2:start -->" -v end="<!-- $GSD_MARK_RE:$2:end -->" '
    $0 ~ start { if ($0 !~ "^" start "$" || state != 0 || starts++) bad=1; state=1 }
    $0 ~ end { if ($0 !~ "^" end "$" || state != 1) bad=1; state=2 }
    END { exit (bad || state == 1) ? 1 : 0 }
  ' "$1"
}

gsd_owned_block_get() { # file, kind → the marked block as it is in the file
  [ -f "$1" ] || return 0
  awk -v start="^<!-- $GSD_MARK_RE:$2:start -->\$" -v end="^<!-- $GSD_MARK_RE:$2:end -->\$" '
    !on && $0 ~ start { on=1 } on { print } on && $0 ~ end { on=0 }
  ' "$1"
}

gsd_provider_instruction_members() { # file; supports older generated headers
  gsd_owned_block_get "$1" provider 2>/dev/null |
    sed -n 's/^## GSD worktrees (\([^)]*\) adapter)$/\1/p'
}

gsd_provider_instruction_integrated() { # repo, provider
  local file members
  file=$1/$(gsd_provider_instruction_file "$2")
  gsd_owned_markers_valid "$file" provider || return 1
  grep -qxE "<!-- $GSD_MARK_RE:provider:start -->" "$file" 2>/dev/null || return 1
  members=$(gsd_provider_instruction_members "$file")
  case ",$members," in *",$2,"*) ;; *) return 1 ;; esac
  gsd_owned_block_get "$file" provider |
    grep -qF 'Read and follow `.gsd/INSTRUCTIONS.md`.' || return 1
  grep -qxE "<!-- $GSD_MARK_RE:canonical:start -->" "$1/.gsd/INSTRUCTIONS.md" 2>/dev/null &&
    gsd_owned_markers_valid "$1/.gsd/INSTRUCTIONS.md" canonical
}

# The generated instruction blocks — one definition, written by
# gsd-bootstrap-repo and compared by gsd-doctor (T016: out of date).
gsd_canonical_block() { # providers, default provider, base, worktree dir, ui on|off
  local ui_text=""
  [ "${5:-on}" = off ] || ui_text="
Screens: every screen uses the design system in \`.planning/design/DESIGN.md\`
(tokens, components, page templates) — don't invent new styles. In a new
project with screens, make the first phase \"Design system\". Each phase with
screens picks a layout with \`/gsd-sketch\` before its UI-SPEC and records it in
\`<P>-LAYOUT.md\`. After the code review, look at the built pages, not only the
code: \`gsd-ui check <N>\` opens them in a browser, measures them and takes the
pictures; \`gsd-ui look <N>\` lists what to answer for every picture — open each
one and write what you saw; then show the user the sheet (\`gsd-ui sheet <N>\`)
and run \`gsd-ui approve <N>\` only after their yes. Never waive a finding or
skip a step without asking. \`gsd-flow-next\` asks for each step (\`ui_gates\` in
\`.gsd.conf\`).
"
  cat <<EOF
<!-- gsd-toolkit:canonical:start -->
# GSD worktree workflow

The shell commands are the source of truth. One feature equals one phase and
worktree. Several configured providers may hand the same phase between their
sessions; only one session may mutate that worktree at a time. Run \`gsd-list\`
before claiming work; attach or hand off with
\`gsd-start -p <N>\` or claim new work with \`gsd-start -n "<desc>"\`.

Inside the worktree, run \`gsd-flow-next <N>\` before every phase action:
ticket (with a tracker) → discuss → UI decision → with screens: design
system, layout (sketch), UI phase → plan → independent review → replan →
execute → verifier/gap loop → verify work → code review/fix → with screens:
UI check, UI look, UI approval, UI review → security → done. The human decisions are discuss,
the design system and sketch, UI approval, and review findings. Never bypass a guard unless the user explicitly requests
\`GSD_SKIP_GUARD=1\`.

\`gsd-finish\` is never automatic. Run it only with explicit user intent and as
the final action because it removes the worktree. Provider hooks are early
feedback only; \`gsd-flow-next\` invokes the mandatory neutral guard. Arbitrary
shell commands outside GSD are outside this enforcement boundary.
${ui_text}
Providers: \`$1\` (default: first, \`$2\`); base \`$3\`;
worktrees \`../$4/\`.
<!-- gsd-toolkit:canonical:end -->
EOF
}

gsd_provider_entry_block() { # the providers sharing this instruction file
  cat <<EOF
<!-- gsd-toolkit:provider:start -->
## GSD worktrees ($1 adapter)

Read and follow \`.gsd/INSTRUCTIONS.md\`. Use the \`gsdt-flow\` skill when it is
available; otherwise run \`gsd-flow-next <N>\` and follow each printed action.
For toolkit command syntax and workflow order, this marked adapter and the
canonical document supersede older unmarked GSD text in this file. Continue to
follow repository-specific policy from that older text.
<!-- gsd-toolkit:provider:end -->
EOF
}

gsd_replace_owned_block() { # file, kind, new block file; caller prevalidates
  local tmp; tmp=$(mktemp) || return 1
  [ ! -f "$1" ] || cp -p "$1" "$tmp"
  BLOCK_FILE=$3 BLOCK_KIND=$2 perl -0777 -pe '
    BEGIN { open my $b, "<", $ENV{BLOCK_FILE} or die $!; local $/; $block=<$b>; $kind=$ENV{BLOCK_KIND}; }
    if (/^<!-- gsd-(?:toolkit|worktrees):\Q$kind\E:start -->$/m) {
      s/^<!-- gsd-(?:toolkit|worktrees):\Q$kind\E:start -->\n.*?^<!-- gsd-(?:toolkit|worktrees):\Q$kind\E:end -->(?:\n|\z)/$block/msg;
    } else { $_ .= (length && !/\n\z/ ? "\n" : "") . "\n" . $block; }
  ' "${1:-/dev/null}" > "$tmp" || { rm -f "$tmp"; return 1; }
  # a linked file (AGENTS.md -> CLAUDE.md, dotfile repos) is written through, not replaced
  if [ -L "$1" ]; then cat "$tmp" > "$1" && rm -f "$tmp"; else mv "$tmp" "$1"; fi
}

gsd_command_guards_active() { # toolkit package; native hook/shim is not required
  [ -x "$1/bin/gsd-worktree-guard" ] && [ -x "$1/bin/gsd-start" ] &&
    [ -x "$1/bin/gsd-flow-next" ] &&
    grep -q 'gsd-worktree-guard.*--command' "$1/bin/gsd-start" &&
    grep -q 'gsd-worktree-guard.*--command' "$1/bin/gsd-flow-next"
}

gsd_provider_validate() { # provider, executable override
  local p=$1 c=${2:-}
  if gsd_provider_gone "$p"; then printf '%s — use claude, codex, or custom\n' "$GSD_GEMINI_GONE" >&2; return 64; fi
  gsd_provider_known "$p" || {
    printf "unknown provider '%s' (expected claude, codex, or custom)\n" "$p" >&2
    return 64
  }
  if [ "$p" = custom ] && [ -z "$c" ]; then
    echo "provider 'custom' requires an explicit agent command" >&2
    return 64
  fi
  case "$c" in *[[:space:]]*)
    echo "agent command must be one executable path/name, not a shell template" >&2; return 64 ;;
  esac
}

gsd_provider_resolve() { # repo, cli provider, cli command
  local repo=$1 cli_p=${2:-} cli_c=${3:-} conf_p conf_default conf_c provider_conf_c provider_env_c="" legacy legacy_c="" configured
  # The first entry in ordered `providers` is canonical. `provider` is read
  # only for repositories created before the provider-set configuration.
  configured=$(gsd_conf_get "$repo" providers)
  if [ -n "$configured" ] || grep -qE '^[[:space:]]*providers[[:space:]]*=' "$repo/.gsd.conf" 2>/dev/null; then
    gsd_provider_list_validate "$configured" || return
  fi
  if [ -n "$configured" ]; then conf_p=${configured%%,*}
  else conf_p=$(gsd_conf_get "$repo" provider)
  fi
  conf_default=${conf_p:-claude}
  GSD_PROVIDER_RESOLVED=${cli_p:-${GSD_PROVIDER:-$conf_p}}
  if [ -z "$GSD_PROVIDER_RESOLVED" ] && [ -n "${GSD_AGENT:-}" ]; then
    legacy=$GSD_AGENT
    if gsd_provider_known "$legacy" || gsd_provider_gone "$legacy"; then GSD_PROVIDER_RESOLVED=$legacy
    # An unknown legacy name is a custom executable. It is the LOWEST-priority
    # executable source: --agent-command and GSD_AGENT_COMMAND still win.
    else GSD_PROVIDER_RESOLVED=custom; legacy_c=$legacy; fi
  fi
  # Compatibility default for repositories created before providers existed.
  GSD_PROVIDER_RESOLVED=${GSD_PROVIDER_RESOLVED:-claude}
  gsd_provider_known "$GSD_PROVIDER_RESOLVED" || { gsd_provider_validate "$GSD_PROVIDER_RESOLVED" ""; return; }
  case "$GSD_PROVIDER_RESOLVED" in
    claude) provider_env_c=${GSD_CLAUDE_COMMAND:-} ;;
    codex) provider_env_c=${GSD_CODEX_COMMAND:-} ;;
    custom) provider_env_c=${GSD_CUSTOM_COMMAND:-} ;;
  esac
  provider_conf_c=$(gsd_conf_get "$repo" "${GSD_PROVIDER_RESOLVED}_command")
  conf_c=""
  [ "$GSD_PROVIDER_RESOLVED" != "$conf_default" ] || conf_c=$(gsd_conf_get "$repo" agent_command)
  GSD_AGENT_COMMAND_RESOLVED=${cli_c:-${GSD_AGENT_COMMAND:-${provider_env_c:-${provider_conf_c:-${conf_c:-$legacy_c}}}}}
  gsd_provider_validate "$GSD_PROVIDER_RESOLVED" "$GSD_AGENT_COMMAND_RESOLVED" || return
  if [ -z "$GSD_AGENT_COMMAND_RESOLVED" ]; then
    GSD_AGENT_COMMAND_RESOLVED=$(gsd_provider_default_command "$GSD_PROVIDER_RESOLVED") || return 64
  fi
}

gsd_model_validate() { # provider, optional model; default means CLI default
  local p=$1 model=${2:-}
  case "$model" in ''|default) return 0 ;; esac
  if [ "$p" = custom ]; then
    echo "custom provider has no model-flag adapter; configure its wrapper or use --model default" >&2
    return 64
  fi
  case "$model" in -*|*[[:space:]]*|*[[:cntrl:]]*)
    echo "model must be one model ID or alias, without whitespace or a leading '-'" >&2
    return 64 ;;
  esac
}

gsd_model_resolve() { # repo, provider, optional CLI override
  local repo=$1 p=$2 cli=${3:-} env_model="" configured
  case "$p" in
    claude) env_model=${GSD_CLAUDE_MODEL:-} ;;
    codex) env_model=${GSD_CODEX_MODEL:-} ;;
  esac
  configured=$(gsd_conf_get "$repo" "${p}_model")
  GSD_MODEL_RESOLVED=${cli:-${GSD_MODEL:-${env_model:-$configured}}}
  gsd_model_validate "$p" "$GSD_MODEL_RESOLVED" || return
  [ "$GSD_MODEL_RESOLVED" != default ] || GSD_MODEL_RESOLVED=""
}

gsd_start_mode_resolve() { # repo, optional CLI override
  local repo=$1 cli_mode=${2:-} configured
  configured=$(gsd_conf_get "$repo" start_mode)
  GSD_START_MODE_RESOLVED=${cli_mode:-${configured:-flow}}   # flow unless start_mode = discuss
  case "$GSD_START_MODE_RESOLVED" in
    discuss|flow) return 0 ;;
    *)
      printf "invalid start_mode '%s' (expected discuss or flow)\n" "$GSD_START_MODE_RESOLVED" >&2
      return 64
      ;;
  esac
}

# A session compacts its conversation once it holds this many tokens. The CLIs
# wait until their own window is nearly full (Claude: ~366k seen), and every
# turn before that re-sends the whole chat; a phase's artifacts carry its state,
# so compacting earlier loses little. 300k, not lower: discuss and the UI
# approvals (talk not yet in a file) ran at 110-145k, and /gsd-plan-phase
# reached 140k before its planner returned (it reads a 47k-token workflow), so
# a 200k window warned "context critical" mid-plan. They stay whole.
# `default` leaves the CLI's own setting.
GSD_COMPACT_AT_DEFAULT=300000
gsd_compact_resolve() { # repo → GSD_COMPACT_RESOLVED (empty = CLI default)
  local v
  v=${GSD_COMPACT_AT:-$(gsd_conf_get "$1" compact_at)}
  v=${v:-$GSD_COMPACT_AT_DEFAULT}
  GSD_COMPACT_RESOLVED=""
  [ "$v" != default ] || return 0
  if ! printf '%s' "$v" | grep -qE '^[0-9]+$' || [ "$((10#$v))" -lt 100000 ] || [ "$((10#$v))" -gt 1000000 ]; then
    printf "invalid compact_at '%s' (expected tokens 100000-1000000, or default)\n" "$v" >&2
    return 64
  fi
  # shellcheck disable=SC2034 # consumed by the caller
  GSD_COMPACT_RESOLVED=$((10#$v))
}

# A phase worktree carries the compact point in Claude's local settings
# (.claude/settings.local.json "env"), so a session opened there later with a
# plain `claude` gets it too, not only the one gsd-start launches. That file
# beats an exported variable, so a window the user exported (or `default`)
# removes ours. Only when the repo uses Claude; best-effort, never fatal.
gsd_compact_settings() { # repo, worktree, tokens (empty = remove ours)
  local repo=$1 wt=$2 n=${3:-} f=.claude/settings.local.json providers py
  providers=$(gsd_conf_get "$repo" providers)
  providers=${providers:-$(gsd_conf_get "$repo" provider)}
  case ",${providers:-claude}," in *,claude,*) ;; *) return 0 ;; esac
  [ -z "${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-}" ] || n=""
  [ -n "$n" ] || [ -f "$wt/$f" ] || return 0
  # Like gsd_baseref: a tracked, or not ignored, file would show up as
  # uncommitted work and stop gsd-finish (gsd-wt-new adds it to the exclude).
  if git -C "$wt" ls-files --error-unmatch -- "$f" >/dev/null 2>&1 \
     || ! git -C "$wt" check-ignore -q -- "$f" 2>/dev/null; then
    echo "• $f is tracked or not gitignored — compact point not saved there (a plain 'claude' keeps the CLI's own)"
    return 0
  fi
  py=$(gsd_python 2>/dev/null) || { echo "• no python 3.7+ — compact point not saved in $f"; return 0; }
  if [ -n "$n" ]; then "$py" "$GSD_PKG/lib/gsd_claude_env.py" "$wt/$f" CLAUDE_CODE_AUTO_COMPACT_WINDOW "$n"
  else "$py" "$GSD_PKG/lib/gsd_claude_env.py" "$wt/$f" CLAUDE_CODE_AUTO_COMPACT_WINDOW
  fi || echo "• could not update $f (not a JSON object?) — compact point not saved there"
}

gsd_provider_prompt() { # provider, kind, phase-or-empty
  local p=$1 kind=$2 n=${3:-}
  case "$kind" in
    discuss)
      case "$p" in
        claude) printf '/gsd-discuss-phase %s\n' "$n" ;;
        codex) printf 'Discuss GSD phase %s with the user and write its context artifact. Use the gsd-discuss-phase skill if available and obey .gsd/INSTRUCTIONS.md.\n' "$n" ;;
        custom) printf 'Discuss GSD phase %s with the user and write its context artifact; obey .gsd/INSTRUCTIONS.md.\n' "$n" ;;
      esac ;;
    flow)
      case "$p" in
        claude) printf '/gsdt-flow %s\n' "$n" ;;
        codex) printf 'Use the gsdt-flow skill to drive phase %s. Start by running gsd-flow-next %s and obey every reported gate.\n' "$n" "$n" ;;
        custom) printf 'Drive GSD phase %s by running gsd-flow-next %s before every phase step; obey every gate in .gsd/INSTRUCTIONS.md.\n' "$n" "$n" ;;
      esac ;;
    new)
      case "$p" in claude) echo /gsd-new-project ;; *) echo 'Initialize GSD planning for this repository. Use the gsd-new-project skill if available; otherwise follow the installed GSD planning documentation.' ;; esac ;;
    ingest)
      case "$p" in claude) echo /gsd-ingest-docs ;; *) echo 'Initialize GSD planning by ingesting the existing project documents. Use the gsd-ingest-docs skill if available; otherwise follow the installed GSD planning documentation.' ;; esac ;;
  esac
}

gsd_provider_argv() { # provider, executable, prompt, optional model, optional compact_at tokens
  local p=$1 c=$2 prompt=$3 model=${4:-} compact=${5:-}
  gsd_model_validate "$p" "$model" || return
  GSD_LAUNCH_ARGV=("$c")
  # Claude reads the compact point only from its environment; a value the user
  # already exported wins. Codex takes it as a config override.
  if [ -n "$compact" ] && [ "$p" = claude ] && [ -z "${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-}" ]; then
    GSD_LAUNCH_ARGV=(env "CLAUDE_CODE_AUTO_COMPACT_WINDOW=$compact" "$c")
  fi
  [ -z "$compact" ] || [ "$p" != codex ] || GSD_LAUNCH_ARGV+=(-c "model_auto_compact_token_limit=$compact")
  case "$p" in
    claude|codex)
      if [ -n "$model" ] && [ "$model" != default ]; then GSD_LAUNCH_ARGV+=(--model "$model"); fi ;;
  esac
  # shellcheck disable=SC2034 # output array is consumed by the caller
  GSD_LAUNCH_ARGV+=("$prompt")
}

gsd_shell_quote() { printf '%q' "$1"; }
gsd_provider_render() { # cwd followed by argv
  local cwd=$1 a out
  shift
  out="cd $(gsd_shell_quote "$cwd") &&"
  for a in "$@"; do out="$out $(gsd_shell_quote "$a")"; done
  printf '%s\n' "$out"
}
