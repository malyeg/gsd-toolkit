# shellcheck shell=bash
# lib/context.sh — what GSD adds to an agent's context, for gsdt-doctor.
#
# Every session lists each installed skill's and agent's name and description;
# gsd-core installs ~75 skills and ~35 agents. A skill's full text loads only
# when it runs, so only the listing is counted. Tokens are estimated as
# characters / 4 — /context in a Claude session has the real numbers.
#
# Needs lib/common.sh, lib/provider.sh (gsd_provider_skill_root) and lib/ui.sh
# (gsd_ui_gates). Reads files only; node runs only to read gsd-core's own
# skill-group list (clusters.cjs), never anything that changes state.

# shellcheck disable=SC2034  # used by bin/gsdt-doctor
GSD_CONTEXT_BIG_KIB=32   # a GSD planning file, or AGENTS.md, over this is noted

# gsd-core skills (names without gsd-) the toolkit runs: the phase flow's steps
# (bin/gsdt-flow-next) and gsdt-init's planning session. With ui_gates = off the
# layout step is gone, so sketch is not needed; ui-phase and ui-review still run.
gsd_core_required_skills() {  # $1=repo
  local s="new-project ingest-docs discuss-phase plan-phase review execute-phase code-review verify-work validate-phase secure-phase ui-phase ui-review"
  [ "$(gsd_ui_gates "$1")" = off ] || s="$s sketch"
  printf '%s\n' "$s" | tr ' ' '\n'
}

gsd_agent_home() {  # $1=claude|codex → the agent's config folder
  case "$1" in
    claude) printf '%s\n' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" ;;
    codex)  printf '%s\n' "${CODEX_HOME:-$HOME/.codex}" ;;
    *) return 1 ;;
  esac
}

# The folder holding gsd-core's gsd-* skills for an agent; nonzero when none.
gsd_core_skill_dir() {  # $1=agent
  local d
  for d in "$(gsd_provider_skill_root "$1" 2>/dev/null)" "$(gsd_agent_home "$1")/skills"; do
    [ "$d" != /skills ] && [ -n "$d" ] || continue
    if ls -d "$d"/gsd-*/ >/dev/null 2>&1; then printf '%s\n' "$d"; return 0; fi
  done
  return 1
}

# "<files> <chars>" of what an agent lists every session for these files:
# name, description and when_to_use in a Markdown front matter (indented
# continuation lines included), or name/description lines in a .toml agent.
gsd_listing_size() {  # files…
  [ $# -gt 0 ] || { echo "0 0"; return 0; }
  awk '
    FNR == 1 { n++; fm = 0; k = 0; toml = (FILENAME ~ /\.toml$/) }
    toml { if ($0 ~ /^(name|description)[ \t]*=/) c += length($0) + 1; next }
    FNR == 1 && /^---/ { fm = 1; next }
    fm == 1 && /^---/ { fm = 2; next }
    fm != 1 { next }
    /^(name|description|when_to_use):/ { k = 1; c += length($0) + 1; next }
    /^[A-Za-z_-]+:/ { k = 0; next }
    k && /^[ \t]/ { c += length($0) + 1 }
    END { print n + 0, c + 0 }' "$@"
}

gsd_tokens_fmt() {  # $1=chars → "~1.2k tokens" / "~300 tokens"
  local t=$(( $1 / 4 ))
  if [ "$t" -ge 1000 ]; then printf '~%d.%dk tokens' $((t / 1000)) $(((t % 1000) / 100))
  else printf '~%d tokens' "$t"; fi
}

# gsd-core's skill groups: "<group> on|off <skill> <skill>…" per line, off =
# disabled in <agent home>/.gsd-surface.json (what /gsd-surface writes). Read
# from gsd-core's clusters.cjs; empty without node or that file.
gsd_core_clusters() {  # $1=agent home
  local f="" c
  command -v node >/dev/null 2>&1 || return 0
  for c in "$1/gsd-core/bin/lib/clusters.cjs" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/lib/clusters.cjs"; do
    [ -f "$c" ] && { f=$c; break; }
  done
  [ -n "$f" ] || return 0
  node -e '
    const [f, s] = process.argv.slice(1);
    const C = require(f).CLUSTERS || {};
    let off = [];
    try { off = JSON.parse(require("fs").readFileSync(s, "utf8")).disabledClusters || []; } catch (e) {}
    for (const [k, v] of Object.entries(C)) console.log(k + " " + (off.includes(k) ? "off" : "on") + " " + v.join(" "));
  ' "$f" "$1/.gsd-surface.json" 2>/dev/null || true
}

# Groups the toolkit does not need that still have skills installed:
# "<group> <skills> <chars>" per line. Hiding one never hides a skill another
# group needs: gsd-core removes every skill of a disabled group, so a group is
# hideable only when none of its skills is required.
gsd_core_hideable() {  # $1=repo $2=agent
  local sd home req g st rest s
  sd=$(gsd_core_skill_dir "$2") || return 0
  home=$(gsd_agent_home "$2")
  req=" $(gsd_core_required_skills "$1" | tr '\n' ' ') "
  gsd_core_clusters "$home" | while read -r g st rest; do
    [ "$st" = on ] || continue
    set --
    for s in $rest; do
      case "$req" in *" $s "*) continue 2 ;; esac
      [ -f "$sd/gsd-$s/SKILL.md" ] && set -- "$@" "$sd/gsd-$s/SKILL.md"
    done
    [ $# -gt 0 ] || continue
    printf '%s %s\n' "$g" "$(gsd_listing_size "$@")"
  done
}

# Required skills missing from an agent's skill folder, as gsd-<name>.
gsd_core_missing_skills() {  # $1=repo $2=skill dir
  local s
  for s in $(gsd_core_required_skills "$1"); do
    [ -f "$2/gsd-$s/SKILL.md" ] || printf 'gsd-%s\n' "$s"
  done
}

# The disabled groups that hold these skills ("gsd-x gsd-y" → "g1 g2"), or
# nothing when one of them is in no disabled group (then only a profile with
# that skill brings it back).
gsd_core_groups_for() {  # $1=agent home $2=missing skills (space-separated, gsd- prefixed)
  local groups="" s g st rest found
  for s in $2; do
    found=""
    while read -r g st rest; do
      [ "$st" = off ] || continue
      case " $rest " in *" ${s#gsd-} "*) found=$g; break ;; esac
    done <<EOF
$(gsd_core_clusters "$1")
EOF
    [ -n "$found" ] || return 0
    case " $groups " in *" $found "*) ;; *) groups="${groups:+$groups }$found" ;; esac
  done
  printf '%s\n' "$groups"
}
