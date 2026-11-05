#!/usr/bin/env bash
#
# lib/install.sh — install THIS unpacked package: copy it into a runtime
# folder, link its commands into ~/.local/bin, copy its skills into each
# agent's skill dir. Not run by hand: ../install.sh (curl | bash, or
# ./install.sh) downloads a release and runs that release's copy of this file.
# Tests run it straight on a checkout.
#
# Usage (internal):
#   lib/install.sh [--agent claude|codex]... [--all-agents] [--no-user-hook] [--no-core] [--reuse-install-config]
#   (--copy is accepted and ignored: older releases' get.sh pass it)
#
# It also installs GSD itself (gsd-core, with npx) for each chosen agent that
# has none. --no-core leaves that out; an update (--reuse-install-config)
# never does it.
#
# Claude also gets a user-level hook (next to its skills dir:
# ~/.claude/settings.json). It refuses /gsd-new-project
# and /gsd-ingest-docs in a repo gsd-init has not set up, and nothing else
# there; in a set-up repo it applies the whole guard (gsd-worktree-guard
# --global). --no-user-hook leaves it out (and removes it).
#
# Env:
#   GSD_BIN_DIR   install target (default: ~/.local/bin)
#   GSD_COPY_DIR  the runtime (default: GSD_BIN_DIR/../share/gsd-toolkit)
#   GSD_CLAUDE_SETTINGS   where the user-level hook goes
#   GSD_GEMINI_SKILL_DIR, GSD_GEMINI_SETTINGS   an old Gemini setup to clean up
#   GSD_NO_CORE=1 same as --no-core (tests)
set -euo pipefail

BIN_DIR="${GSD_BIN_DIR:-$HOME/.local/bin}"
PROVIDERS=""; REUSE=0; USER_HOOK=""; CORE=on
add_provider() { case ",$PROVIDERS," in *",$1,"*) ;; *) PROVIDERS="${PROVIDERS:+$PROVIDERS,}$1" ;; esac; }
while [ $# -gt 0 ]; do
  case "$1" in
    --copy) shift ;;   # older get.sh pass it; copying is the only mode
    --reuse-install-config) REUSE=1; shift ;;
    --agent) [ $# -ge 2 ] || { echo '--agent needs a provider' >&2; exit 1; }
      case "$2" in
        claude|codex) add_provider "$2" ;;
        gemini) echo 'Gemini is no longer supported (gsd-core, the new GSD, dropped it); use --agent claude or codex' >&2; exit 1 ;;
        *) echo "unknown provider: $2" >&2; exit 1 ;;
      esac; shift 2 ;;
    --all-agents) PROVIDERS=claude,codex; shift ;;
    --no-user-hook) USER_HOOK=off; shift ;;
    --no-core) CORE=off; shift ;;
    -h|--help) echo 'usage: lib/install.sh [--agent claude|codex]... [--all-agents] [--no-user-hook] [--no-core] [--reuse-install-config]'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
. "$REPO/lib/common.sh"
. "$REPO/lib/provider.sh"
INSTALL_PYTHON=$(gsd_python) || { echo 'installation requires Python 3.7+ (python3 or python on PATH)' >&2; exit 1; }
backup_path() { local base=$1 out=$1.bak n=1; while [ -e "$out" ] || [ -L "$out" ]; do out=$base.bak.$n; n=$((n+1)); done; printf '%s\n' "$out"; }
absolute_path() { "$INSTALL_PYTHON" -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
within() { case "$1/" in "$2/"*) return 0 ;; *) return 1 ;; esac; }
# A command link or skill this toolkit placed earlier (from any checkout or
# release runtime) is replaced in place, not moved to .bak: a gsd-list.bak on
# PATH, or a gsdt-flow.bak in an agent's skill dir, would be picked up as real.
toolkit_pkg() { [ -f "$1/install.sh" ] && [ -f "$1/lib/common.sh" ]; }
owned_link() {  # $1=symlink $2=bin|skills
  local t; t=$(readlink "$1") || return 1
  case "$t" in /*) ;; *) t="$(dirname "$1")/$t" ;; esac
  toolkit_pkg "$(dirname "$(dirname "$t")")" && return 0
  # a removed release (gsd-worktrees: the package's name before 0.8.0)
  case "$t" in */gsd-toolkit/releases/*/"$2"/*|*/gsd-worktrees/releases/*/"$2"/*) return 0 ;; esac
  return 1
}
BIN_DIR=$(absolute_path "$BIN_DIR")
if within "$BIN_DIR" "$REPO" || within "$REPO" "$BIN_DIR"; then
  echo "unsafe destination: bin and source directories must not overlap" >&2; exit 1
fi
MANIFEST=$BIN_DIR/.gsd-install-manifest
# Gemini was an agent until 0.5.0. An install that set it up (its manifest
# says so) loses our skills and user hook there; nothing else is touched.
GEMINI_OLD=""
if [ -f "$MANIFEST" ] && grep -qE $'^providers\t(.*,)?gemini(,|$)' "$MANIFEST"; then
  GEMINI_OLD=$(sed -n $'s/^gemini_skills\t//p' "$MANIFEST" | head -1)
  GEMINI_OLD=${GEMINI_OLD:-$HOME/.gemini/skills}
fi
GEMINI_OLD=${GSD_GEMINI_SKILL_DIR:-$GEMINI_OLD}
[ -z "${GSD_GEMINI_SETTINGS:-}" ] || GEMINI_OLD=${GEMINI_OLD:-$(dirname "$GSD_GEMINI_SETTINGS")/skills}
if [ "$REUSE" = 1 ] && [ -f "$MANIFEST" ]; then
  while IFS=$'\t' read -r key value; do
    case "$key" in
      # recorded agents are kept; any --agent given now is added to them
      providers) oldifs=$IFS; IFS=,; for p in $value; do [ "$p" = gemini ] || add_provider "$p"; done; IFS=$oldifs ;;
      claude_skills) GSD_CLAUDE_SKILL_DIR=${GSD_CLAUDE_SKILL_DIR:-$value} ;;
      # Codex's old default (~/.codex/skills, recorded by releases before
      # 0.5.0; they ignored CODEX_HOME) is not a choice: those skills move to
      # its own ~/.agents/skills
      codex_skills) case "$value" in "$(absolute_path "$HOME/.codex/skills")"|"$(absolute_path "${CODEX_HOME:-$HOME/.codex}/skills")") ;; *) GSD_CODEX_SKILL_DIR=${GSD_CODEX_SKILL_DIR:-$value} ;; esac ;;
      gemini_skills) ;;   # read above, for the clean-up
      user_hook) USER_HOOK=${USER_HOOK:-$value} ;;
      *) echo "invalid install manifest key: $key" >&2; exit 1 ;;
    esac
  done < "$MANIFEST"
fi
[ -n "$PROVIDERS" ] || PROVIDERS=claude
USER_HOOK=${USER_HOOK:-on}
gsd_provider_list_validate "$PROVIDERS"
case ",$PROVIDERS," in *,custom,*) echo 'custom provider has no installable skill format' >&2; exit 1 ;; esac
oldifs=$IFS; IFS=,
for provider in $PROVIDERS; do
  skillpath=$(gsd_provider_skill_root "$provider")
  case "$skillpath" in *$'\t'*|*$'\n'*) echo 'skill destination cannot contain tabs or newlines' >&2; exit 1 ;; esac
  skillpath=$(absolute_path "$skillpath")
  if within "$skillpath" "$REPO" || within "$REPO" "$skillpath"; then
    echo 'unsafe skill destination: skills and source directories must not overlap' >&2; exit 1
  fi
done
IFS=$oldifs

COPY_REQUEST=${GSD_COPY_DIR:-$BIN_DIR/../share/gsd-toolkit}
COPY_REQUEST=$("$INSTALL_PYTHON" -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$COPY_REQUEST")
if [ -L "$COPY_REQUEST" ]; then
  echo "unsafe destination: runtime root is a symlink ($COPY_REQUEST)" >&2
  exit 1
fi
COPY_DIR=$(absolute_path "$COPY_REQUEST")
if within "$COPY_DIR" "$REPO" || within "$REPO" "$COPY_DIR" \
  || within "$BIN_DIR" "$REPO" || within "$REPO" "$BIN_DIR" \
  || within "$COPY_DIR" "$BIN_DIR" || within "$BIN_DIR" "$COPY_DIR"; then
  echo "unsafe destination: runtime, bin, and source directories must not overlap" >&2
  exit 1
fi
# Merge only package-owned paths. Unrelated files remain in place; changed
# paths get distinct backups, so repeated installs never clobber old copies.
copy_tree() {
  local src=$1 dst=$2 path rel target bak
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    if [ ! -d "$dst" ] || [ -L "$dst" ]; then
      bak=$(backup_path "$dst"); mv "$dst" "$bak"
      echo "• existing $dst preserved at $bak"
    fi
  fi
  mkdir -p "$dst"
  while IFS= read -r path; do
    rel=${path#"$src"/}; target="$dst/$rel"
    if [ -d "$path" ] && [ ! -L "$path" ]; then
      if [ -e "$target" ] || [ -L "$target" ]; then
        if [ ! -d "$target" ] || [ -L "$target" ]; then
          bak=$(backup_path "$target"); mv "$target" "$bak"
          echo "• existing $target preserved at $bak"
        fi
      fi
      mkdir -p "$target"
    else
      if [ -e "$target" ] || [ -L "$target" ]; then
        if [ -L "$path" ] && [ -L "$target" ] && [ "$(readlink "$path")" = "$(readlink "$target")" ]; then continue; fi
        if [ -f "$path" ] && [ -f "$target" ] && [ ! -L "$target" ] \
          && cmp -s "$path" "$target" && { [ ! -x "$path" ] || [ -x "$target" ]; }; then continue; fi
        bak=$(backup_path "$target"); mv "$target" "$bak"
        echo "• existing $target preserved at $bak"
      fi
      cp -P "$path" "$target"
    fi
  done < <(find "$src" -mindepth 1 -type d -name __pycache__ -prune -o -mindepth 1 -print)
}
mkdir -p "$COPY_DIR"
# Only retire commands named by our previous inventory. Preserve their bytes
# in backups and leave unrelated runtime files and PATH links alone.
if [ -f "$COPY_DIR/.gsd-owned-commands" ]; then
  while IFS= read -r old; do
    case "$old" in gsd-*) ;; *) echo 'invalid copied command inventory' >&2; exit 1 ;; esac
    case "$old" in */*|*..*) echo 'unsafe copied command inventory' >&2; exit 1 ;; esac
    [ ! -e "$REPO/bin/$old" ] || continue
    if [ -e "$COPY_DIR/bin/$old" ] || [ -L "$COPY_DIR/bin/$old" ]; then
      bak=$(backup_path "$COPY_DIR/bin/$old"); mv "$COPY_DIR/bin/$old" "$bak"
      echo "• retired command preserved at $bak"
    fi
    if [ -L "$BIN_DIR/$old" ] && [ "$(readlink "$BIN_DIR/$old")" = "$COPY_DIR/bin/$old" ]; then rm -f "$BIN_DIR/$old"; fi
  done < "$COPY_DIR/.gsd-owned-commands"
fi
for component in bin lib shims skills; do copy_tree "$REPO/$component" "$COPY_DIR/$component"; done
# A skill an older release shipped (renamed gsd-flow → gsdw-flow → gsdt-flow) would
# stay in the runtime's skills/, which is only ever ours: doctor would
# compare it against the installed ones. Remove it.
for d in "$COPY_DIR"/skills/*/; do
  [ -f "$d/SKILL.md" ] && [ ! -d "$REPO/skills/$(basename "$d")" ] || continue
  rm -rf "${d%/}"; echo "✂ runtime skill $(basename "$d") removed (not in this version)"
done
for top in install.sh VERSION; do
  [ -f "$REPO/$top" ] || continue
  if [ -e "$COPY_DIR/$top" ] || [ -L "$COPY_DIR/$top" ]; then
    if ! { [ -f "$COPY_DIR/$top" ] && [ ! -L "$COPY_DIR/$top" ] && cmp -s "$REPO/$top" "$COPY_DIR/$top"; }; then
      bak=$(backup_path "$COPY_DIR/$top"); mv "$COPY_DIR/$top" "$bak"
      cp -P "$REPO/$top" "$COPY_DIR/$top"
    fi
  else
    cp -P "$REPO/$top" "$COPY_DIR/$top"
  fi
done
inventory=$(mktemp)
for command_file in "$REPO"/bin/*; do basename "$command_file" >> "$inventory"; done
mv "$inventory" "$COPY_DIR/.gsd-owned-commands"
mkdir -p "$BIN_DIR"

for f in "$REPO"/bin/*; do
  name=$(basename "$f")
  dest="$BIN_DIR/$name"
  # Preserve any command already at this path unless it points to this runtime.
  target="$COPY_DIR/bin/$name"
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$target" ]; then
    echo "✔ $name → $dest"; continue
  fi
  if [ -L "$dest" ] && owned_link "$dest" bin; then
    rm -f "$dest"
  elif [ -e "$dest" ] || [ -L "$dest" ]; then
    bak=$(backup_path "$dest"); mv "$dest" "$bak"
    echo "• existing $name preserved at $bak"
  fi
  ln -s "$target" "$dest"
  echo "✔ $name → $dest"
done

# Prune links left behind by commands DELETED from bin/ — a dangling symlink
# would otherwise sit on PATH forever as a broken command. Links into another
# toolkit runtime (an older release) for a command this version no longer has
# go too.
for dest in "$BIN_DIR"/gsd-*; do
  [ -L "$dest" ] || continue
  [ ! -e "$REPO/bin/$(basename "$dest")" ] || continue
  case "$(readlink "$dest")" in
    "$REPO"/bin/*) [ -e "$dest" ] || { rm -f "$dest"; echo "✂ $(basename "$dest") removed (deleted from the toolkit)"; } ;;
    *) if owned_link "$dest" bin; then rm -f "$dest"; echo "✂ $(basename "$dest") removed (not in this version)"; fi ;;
  esac
done

# ── the agent-facing skill ───────────────────────────────────────────────────
# A copy, never a link: a link into the package would dangle once a later
# release removes this one.
install_skills() {
  local provider=$1 SKILL_DIR d name dest bak old
  SKILL_DIR=$(gsd_provider_skill_root "$provider")
  mkdir -p "$SKILL_DIR"
  for d in "$REPO"/skills/*/; do
    name=$(basename "$d")
    dest="$SKILL_DIR/$name"
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      if [ -d "$dest" ] && [ ! -L "$dest" ] \
        && ! gsd_skill_differs "$d" "$dest"; then
        echo "• $provider skill $name already current"; continue
      elif [ -L "$dest" ] && owned_link "$dest" skills; then
        rm -f "$dest"
      elif [ -d "$dest" ] && [ ! -L "$dest" ] && gsd_skill_owned "$dest"; then
        rm -rf "$dest"
      else
        bak=$(backup_path "$dest"); mv "$dest" "$bak"
        echo "• existing $provider skill $name preserved at $bak"
      fi
    fi
    cp -R "${d%/}" "$dest"
    # marks the copy as the toolkit's, so the next update replaces it in place
    # (a line in SKILL.md, not a file of its own — see gsd_skill_owned)
    printf '%s %s -->\n' "$GSD_SKILL_MARK" "$(head -1 "$REPO/VERSION" 2>/dev/null)" >> "$dest/SKILL.md"
    echo "✔ $provider skill $name → $dest"
  done
  retire_skills "$SKILL_DIR" "$provider" ""
  # Codex reads skills from ~/.agents/skills; ~/.codex/skills is its old place.
  # Ours there would load twice (or stale): move them out.
  if [ "$provider" = codex ] && [ -z "${GSD_CODEX_SKILL_DIR:-}" ]; then
    for old in "$HOME/.codex/skills" ${CODEX_HOME:+"$CODEX_HOME/skills"}; do
      [ ! -d "$old" ] || [ "$old" = "$SKILL_DIR" ] || retire_skills "$old" codex all
    done
  fi
}
# A skill this toolkit placed earlier but no longer ships (renamed or
# retired) would keep loading with old advice: remove it. With "all", every
# skill of ours in that dir goes (an old location).
retire_skills() {  # $1=skill dir  $2=provider  $3=""|all
  local dest name
  for dest in "$1"/*; do
    name=$(basename "$dest")
    [ "$3" = all ] || [ ! -d "$REPO/skills/$name" ] || continue
    if [ -L "$dest" ]; then
      # a dangling link of ours; a live link into another checkout stays
      # (unless the whole dir is an old location)
      [ "$3" = all ] || [ ! -e "$dest" ] || continue
      case "$(readlink "$dest")" in "$REPO"/skills/*) ;; *) owned_link "$dest" skills || continue ;; esac
      rm -f "$dest"
    elif [ -d "$dest" ] && gsd_skill_owned "$dest"; then
      rm -rf "$dest"
    else
      continue
    fi
    echo "✔ $2 skill $name retired → removed $dest"
  done
}
oldifs=$IFS; IFS=,; for provider in $PROVIDERS; do install_skills "$provider"; done; IFS=$oldifs
[ -z "$GEMINI_OLD" ] || [ ! -d "$GEMINI_OLD" ] || retire_skills "$GEMINI_OLD" gemini all

# ── the user-level hook: /gsd-new-project only after gsd-init ────────────────
# Before gsd-init a repo has no toolkit files, so no repo hook can stop a bare
# /gsd-new-project — only one in the user's own settings can. The settings
# file sits next to the provider's skills dir (~/.claude/skills →
# ~/.claude/settings.json). Ours is the entry whose command runs
# gsd-worktree-guard --global: replaced on every install, never duplicated.
# Settings that turn hooks off, or are not a JSON object, are left alone.
user_hook() {  # $1=provider $2=on|off
  local provider=$1 settings guard cmd
  case "$provider" in
    claude) settings=$(gsd_provider_user_hook_file "$provider") ;;
    gemini) settings=${GSD_GEMINI_SETTINGS:-$(dirname "$GEMINI_OLD")/settings.json} ;;   # removal only
    *) return 0 ;;
  esac
  [ "$2" = on ] || [ -f "$settings" ] || return 0
  guard="$BIN_DIR/gsd-worktree-guard"
  case "$guard" in *"'"*) echo "• $provider user hook skipped: the bin path holds a quote"; return 0 ;; esac
  # A missing toolkit (uninstalled) must not break every slash command: no guard → allow.
  cmd="[ ! -x '$guard' ] || exec '$guard' --global"
  mkdir -p "$(dirname "$settings")"
  "$INSTALL_PYTHON" - "$settings" "$provider" "$2" "$cmd" <<'PY'
import json, os, sys
path, provider, mode, cmd = sys.argv[1:]
try:
    with open(path) as f:
        text = f.read()
    data = json.loads(text) if text.strip() else {}
except FileNotFoundError:
    text, data = None, {}
except ValueError:
    print("⚠ %s is not valid JSON; left unchanged (no %s user hook)" % (path, provider)); sys.exit(0)
if not isinstance(data, dict) or not isinstance(data.get("hooks", {}), dict):
    print("⚠ %s has an unexpected shape; left unchanged (no %s user hook)" % (path, provider)); sys.exit(0)
if mode == "on" and (data.get("disableAllHooks") is True or (data.get("hooksConfig") or {}).get("enabled") is False):
    print("• hooks are turned off in %s; %s user hook not added" % (path, provider)); sys.exit(0)
hooks = data.setdefault("hooks", {})
wanted = {"claude": [("PreToolUse", "Skill"), ("UserPromptExpansion", "gsd.*")],
          "gemini": [("BeforeTool", "activate_skill")]}[provider]
def ours(h):
    c = h.get("command", "") if isinstance(h, dict) else ""
    return "gsd-worktree-guard" in c and "--global" in c
for event in [e for e, _ in wanted if e in hooks]:
    groups = hooks[event]
    if not isinstance(groups, list):
        continue
    kept = []
    for g in groups:
        if isinstance(g, dict) and isinstance(g.get("hooks"), list):
            rest = [h for h in g["hooks"] if not ours(h)]
            if not rest and g["hooks"]:
                continue
            g["hooks"] = rest
        kept.append(g)
    if kept: hooks[event] = kept
    else: del hooks[event]
if mode == "on":
    entry = lambda m: {"matcher": m, "hooks": [{"type": "command", "command": cmd}]}
    for event, matcher in wanted:
        if not isinstance(hooks.get(event, []), list):
            print("⚠ %s: hooks.%s is not a list; left unchanged (no %s user hook)" % (path, event, provider)); sys.exit(0)
        hooks.setdefault(event, []).append(entry(matcher))
if not hooks:
    del data["hooks"]
new = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
if new != text:
    # write through a symlink (dotfile repos link settings.json) and keep the mode
    real = os.path.realpath(path)
    tmp = real + ".gsd-tmp"
    with open(tmp, "w") as f:
        f.write(new)
    try:
        os.chmod(tmp, os.stat(real).st_mode & 0o7777)
    except FileNotFoundError:
        pass
    os.replace(tmp, real)
if mode == "on":
    print("✔ %s user hook: /gsd-new-project only after gsd-init → %s" % (provider, path))
elif new != text:
    print("✂ %s user hook removed from %s" % (provider, path))
PY
}
oldifs=$IFS; IFS=,; for provider in $PROVIDERS; do user_hook "$provider" "$USER_HOOK"; done; IFS=$oldifs
[ -z "$GEMINI_OLD" ] || user_hook gemini off

manifest_tmp=$(mktemp)
printf 'providers\t%s\n' "$PROVIDERS" > "$manifest_tmp"
# only the opt-out is recorded: a default manifest stays readable by older releases
[ "$USER_HOOK" = on ] || printf 'user_hook\t%s\n' "$USER_HOOK" >> "$manifest_tmp"
oldifs=$IFS; IFS=,
for provider in $PROVIDERS; do
  printf '%s_skills\t%s\n' "$provider" "$(absolute_path "$(gsd_provider_skill_root "$provider")")" >> "$manifest_tmp"
done
IFS=$oldifs
if { [ -e "$MANIFEST" ] || [ -L "$MANIFEST" ]; } && ! cmp -s "$manifest_tmp" "$MANIFEST"; then
  bak=$(backup_path "$MANIFEST"); mv "$MANIFEST" "$bak"
  echo "• previous installation settings preserved at $bak"
fi
mv "$manifest_tmp" "$MANIFEST"

# ── GSD itself (gsd-core) ────────────────────────────────────────────────────
# The toolkit needs gsd-core: gsd-start claims phases with its gsd_run. An
# install adds it (lib/core.sh) for each chosen agent that has none. Runs
# after our skills: they are gsdt-*, so gsd-core's installer (it deletes
# skills/gsd-*) keeps them. An agent that has gsd-core is left alone here;
# gsd-update brings it to the latest. An update (--reuse-install-config),
# --no-core and GSD_NO_CORE=1 (tests) skip this. Failing here never fails
# the install: it prints the command to run.
# shellcheck source=lib/core.sh
. "$REPO/lib/core.sh"
if [ "$CORE" = on ] && [ "$REUSE" = 0 ] && [ -z "${GSD_NO_CORE:-}" ]; then
  oldifs=$IFS; IFS=,; for provider in $PROVIDERS; do gsd_core_sync "$provider" install; done; IFS=$oldifs
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "⚠ $BIN_DIR is not on your PATH — add it to your shell profile" ;;
esac
echo ""
echo "Done. Try:  gsd-list --help"
