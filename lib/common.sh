# shellcheck shell=bash
# lib/common.sh — shared helpers for the gsd-toolkit commands. Sourced, not run.
#
# Per-repo settings come from an OPTIONAL committed `.gsd.conf` at the repo
# root (key = value); anything not set there falls back to detection, so most
# repos need no config at all:
#
#   base    = develop            # base branch (detect: develop, else main, else current)
#   wtdir   = myrepo-worktrees   # sibling dir for worktrees (detect: <repo-name>-worktrees)
#   install = pnpm install       # worktree bootstrap cmd; 'none' disables (detect: by lockfile)

gsd_main() {  # $1=any path inside the repo → the MAIN checkout (first worktree entry)
  # substr, not $2: a checkout path with a space in it would be cut at the space
  git -C "${1:-.}" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10); exit}'
}

gsd_conf_get() {  # $1=repo root  $2=key → value ('' when unset)
  [ -f "$1/.gsd.conf" ] || return 0
  sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1/.gsd.conf" \
    | head -1 | sed -e 's/[[:space:]]*$//' -e 's/[[:space:]]*#.*$//'
}

gsd_base() {  # $1=repo root (any checkout — branch refs are shared)
  local v; v=$(gsd_conf_get "$1" base)
  if [ -n "$v" ]; then printf '%s\n' "$v"; return 0; fi
  if   git -C "$1" show-ref --verify --quiet refs/heads/develop; then echo develop
  elif git -C "$1" show-ref --verify --quiet refs/heads/main;    then echo main
  else git -C "$1" branch --show-current; fi
}

gsd_flow_mode() {  # $1=MAIN checkout → strict|off (`flow` in .gsd.conf)
  [ "$(gsd_conf_get "$1" flow)" = strict ] && echo strict || echo off
}

gsd_conf_providers() {  # $1=MAIN checkout → the configured list (legacy `provider`, else claude)
  local v; v=$(gsd_conf_get "$1" providers)
  [ -n "$v" ] || v=$(gsd_conf_get "$1" provider)
  printf '%s\n' "${v:-claude}"
}

gsd_wtdir() {  # $1=MAIN checkout → NAME of the sibling worktrees dir
  local v; v=$(gsd_conf_get "$1" wtdir)
  printf '%s\n' "${v:-$(basename "$1")-worktrees}"
}

gsd_register_merge_driver() {  # $1=repo root — register the .planning merge driver
  # Merge drivers live in git config, which is NOT versioned, so a clone that
  # never ran gsd-bootstrap-repo would fall back to a plain conflict on the
  # union-merged planning files. Every gsd command that is about to merge
  # re-asserts the registration first; it is idempotent and costs one git call.
  # Worktrees share the main checkout's config, so one registration covers all
  # of them.
  command -v gsd-planning-merge >/dev/null 2>&1 || return 0
  local want="gsd-planning-merge %O %A %B %P"
  [ "$(git -C "$1" config --get merge.gsd-planning.driver 2>/dev/null)" = "$want" ] && return 0
  git -C "$1" config merge.gsd-planning.driver "$want"
  git -C "$1" config merge.gsd-planning.name \
    "GSD planning files: union, then reconcile single-value lines"
}

gsd_reviews_problem() {  # $1=<P>-REVIEWS.md  $2=review_provider → why it is no usable review
  # The one test of "the cross-AI review really happened", shared by
  # gsd-flow-next (review step) and the guard (flow = strict, execute-phase).
  # /gsd-review keeps going when a reviewer fails (e.g. a Codex usage limit,
  # its stderr discarded) and can still write the file, with that reviewer's
  # "## <Name> Review" section (gsd-core: "## <Name> Review (<instance>)" for
  # one of several reviewer instances) empty or holding only the error. Not usable:
  # the configured reviewer's section failed, or every review section did.
  # Failed = empty, or a short body (≤ 5 lines) carrying a limit/failure
  # message — a long one is a real review that quotes it. A file without
  # such sections (hand-recorded review) is not judged. Prints the reason
  # and returns 0 when unusable; returns 1 when fine.
  # A body runs on past the reviewer's own "##" headings: gsd-core asks for one
  # "## <plan id>" per plan, and some write "## Summary". It ends at the next
  # review heading, at "## Consensus…", at the end of the file, or at a "---"
  # right before a "##" that is no plan id (gsd-core writes "---" after each
  # section; a person's "## Verification" may follow). Headings and "---" are
  # not body lines, so a section with only those is empty.
  [ -f "$1" ] || return 1
  awk -v want="$(printf '%s review' "${2:-}" | tr '[:upper:]' '[:lower:]')" '
    function done_sec(   bad, what) {
      if (sec == "") return
      total++
      bad = (lines == 0 || (mark != "" && lines <= 5))
      if (bad) {
        failed++; what = sec (lines == 0 ? " is empty" : " — " mark)
        if (first == "") first = what
        if (tolower(base) == want) own = what
      }
      sec = ""
    }
    NR == 1 && /^---[[:space:]]*$/ { fm = 1; next }
    fm { if (/^---[[:space:]]*$/) fm = 0; next }
    /^---[[:space:]]*$/ { rule = 1; next }
    /^## / {
      h = substr($0, 4); sub(/[[:space:]]+$/, "", h); lh = tolower(h)
      plan = (lh ~ /^(plan )?[0-9]/)
      if (!plan && lh ~ /review( \([^)]*\))?$/) { done_sec(); sec = h; base = h; sub(/ \([^)]*\)$/, "", base); lines = 0; mark = "" }
      else if (lh ~ /^consensus/ || (rule && !plan)) done_sec()
      rule = 0; next
    }
    /[^[:space:]]/ { rule = 0 }
    /^#+ / { next }
    sec != "" && /[^[:space:]]/ {
      lines++; l = tolower($0)
      if (l ~ /hit your usage limit/) mark = "usage limit hit"
      else if (mark == "" && l ~ /failed or returned empty|returned empty content/) mark = "reviewer failed"
    }
    END { done_sec(); if (own != "") print own; else if (total > 0 && failed == total) print first }
  ' "$1" | grep .
}

gsd_workflow_flag() {  # $1=checkout $2=key → true | false | "" (unset or unreadable)
  # GSD's own switches live in .planning/config.json under "workflow".
  local py; py=$(gsd_python) || return 0
  "$py" - "$1/.planning/config.json" "$2" 2>/dev/null <<'PY' || true
import json, sys
try:
    v = json.load(open(sys.argv[1])).get("workflow", {}).get(sys.argv[2])
except Exception:
    v = None
print("true" if v is True else "false" if v is False else "")
PY
}

gsd_validation_problem() {  # $1=phase dir $2=<P> $3=checkout → why the test audit is still open
  # The one test of "/gsd-validate-phase ran", shared by gsd-flow-next
  # (validate step), the guard (flow = strict, secure-phase) and doctor (T040).
  # plan-phase writes a draft <P>-VALIDATION.md (nyquist_compliant: false).
  # validate-phase sets nyquist_compliant: true when every requirement has an
  # automated test, or appends a "## Validation Audit" table when some stay
  # manual-only. Not required with workflow.nyquist_validation = false: then
  # validate-phase exits at once. Prints the reason and returns 0 when open;
  # returns 1 when done.
  [ "$(gsd_workflow_flag "$3" nyquist_validation)" = false ] && return 1
  local f="$1/$2-VALIDATION.md" c
  [ -f "$f" ] || { echo "no $2-VALIDATION.md"; return 0; }
  # YAML spellings of true: "true", 'true', True, true # comment, CRLF lines
  c=$(tr -d '\r' < "$f" | sed -n '/^---$/,/^---$/p' | sed -n -E 's/^nyquist_compliant:[[:space:]]*//p' | head -1 \
        | sed -E 's/[[:space:]]+#.*$//' | tr -d "\"'[:space:]" | tr '[:upper:]' '[:lower:]')
  [ "$c" = true ] && return 1
  grep -q '^## Validation Audit' "$f" && return 1
  echo "$2-VALIDATION.md is the plan's draft (nyquist_compliant: false, no audit)"
}

gsd_phase_dir() {  # $1=checkout $2=phase-<N>-* branch → GSD_PD (phase dir), GSD_P (its prefix), GSD_N; 1 = none
  # Dirs come padded (07-, 02.1- from gsd-core) or not (7.1-); the artifact
  # prefix is taken from the dir that exists.
  local ni nd c d
  GSD_PD=""; GSD_P=""
  GSD_N=$(printf '%s' "$2" | sed -n -E 's/^phase-([0-9]+([.][0-9]+)?)-.*/\1/p')
  [ -n "$GSD_N" ] && [ -d "$1" ] || return 1
  ni=$((10#${GSD_N%%.*})); case "$GSD_N" in *.*) nd=".${GSD_N#*.}" ;; *) nd="" ;; esac
  for c in "$(printf '%02d' "$ni")$nd" "$ni$nd"; do
    for d in "$1/.planning/phases/$c"-*; do [ -d "$d" ] && { GSD_PD=$d; GSD_P=$c; return 0; }; done
  done
  return 1
}

gsd_origin_lacks() {  # $1=checkout $2=branch → true when origin answers but has no such branch
  # Tells "push the base branch first" apart from a network or divergence failure.
  local rc=0
  git -C "$1" ls-remote --exit-code --heads origin "$2" >/dev/null 2>&1 || rc=$?
  [ "$rc" = 2 ]
}

gsd_phase_branch() {  # $1=MAIN $2=phase number → the phase's feature branch ('' = none)
  # /gsd-pr-branch names its helper <branch>-pr. Skip X-pr only when X is also
  # a phase-N branch: a phase whose own slug ends in -pr ("improve PR") counts.
  local all b
  all=$(git -C "$1" for-each-ref --format='%(refname:short)' "refs/heads/phase-$2-*" 2>/dev/null) || return 0
  printf '%s\n' "$all" | while IFS= read -r b; do
    [ -n "$b" ] || continue
    case "$b" in *-pr) printf '%s\n' "$all" | grep -qxF -- "${b%-pr}" && continue ;; esac
    printf '%s\n' "$b"
  done | head -1
}

gsd_is_pr_helper() {  # $1=MAIN $2=branch → true when it is the -pr helper of another branch
  case "$2" in *-pr) git -C "$1" show-ref --verify --quiet "refs/heads/${2%-pr}" ;; *) return 1 ;; esac
}

gsd_gate_tree() {  # $1=MAIN $2=phase branch $3=its worktree → GSD_GATE_WT: the branch's files for the finish gates
  # The gates read the phase's files. With the worktree gone (removed by hand,
  # or --pr after a cleanup) they would find nothing and pass, so check the
  # branch out, detached, in a throwaway worktree. gsd_gate_tree_done removes it.
  GSD_GATE_WT=$3; GSD_GATE_TMP=""
  [ -n "$3" ] && [ -d "$3" ] && return 0
  GSD_GATE_TMP=$(mktemp -d 2>/dev/null) || return 1
  GSD_GATE_WT="$GSD_GATE_TMP/tree"
  git -C "$1" worktree add -q --detach "$GSD_GATE_WT" "$2" >/dev/null 2>&1 && return 0
  rm -rf "$GSD_GATE_TMP"; GSD_GATE_TMP=""; GSD_GATE_WT=$3
  return 1
}

gsd_gate_tree_done() {  # $1=MAIN — remove the throwaway worktree gsd_gate_tree made
  [ -n "${GSD_GATE_TMP:-}" ] || return 0
  git -C "$1" worktree remove --force "$GSD_GATE_WT" >/dev/null 2>&1 || true
  rm -rf "$GSD_GATE_TMP"; git -C "$1" worktree prune >/dev/null 2>&1 || true
  GSD_GATE_TMP=""
}

gsd_finish_gates() {  # $1=MAIN $2=phase branch $3=its worktree → 1 = refuse (the UI steps, then the test audit)
  local rc=0
  gsd_gate_tree "$1" "$2" "$3" \
    || echo "⚠ could not check out '$2' to check its files — the finish gates see only what is on disk" >&2
  gsd_ui_finish_gate "$1" "$2" "$GSD_GATE_WT" && gsd_flow_finish_gate "$1" "$2" "$GSD_GATE_WT" || rc=1
  gsd_gate_tree_done "$1"
  return "$rc"
}

gsd_flow_finish_gate() {  # $1=MAIN $2=phase branch $3=its worktree → 1 = refuse the finish (flow = strict)
  # Called by gsd-wt-finish and gsd-finish --pr, before anything is merged or
  # pushed. It checks the test audit (/gsd-validate-phase): the guard holds
  # the earlier steps, but nothing runs after validate except secure.
  [ "$(gsd_conf_get "$1" flow)" = strict ] || return 0
  [ "${GSD_SKIP_GUARD:-}" != 1 ] || return 0
  gsd_phase_dir "$3" "$2" || return 0
  local why
  why=$(gsd_validation_problem "$GSD_PD" "$GSD_P" "$3") || return 0
  echo "✗ phase $GSD_N has no test audit (flow = strict): $why." >&2
  echo "  In the phase worktree: /gsd-validate-phase $GSD_N   (or GSD_SKIP_GUARD=1 if the user asked to skip it)" >&2
  return 1
}

# GSD's command-line tool: gsd-core's gsd_run. A name proves nothing (other
# packages ship a gsd-tools too), so a candidate counts only when
# runtime-identity says it is gsd-core. An npx
# install puts nothing on PATH: look in each agent's config dir too.
# GSD_CLI overrides (tests). Each probe starts node; every command calls this once.
GSD_CORE_INSTALL="npx @opengsd/gsd-core@latest"
gsd_cli() {  # → gsd-core's gsd_run; nonzero when none
  local c id
  for c in "${GSD_CLI:-}" "$(command -v gsd_run 2>/dev/null || true)" \
           "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/gsd_run" \
           "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/gsd_run"; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    # captured, not piped to grep -q: under pipefail an early-closed pipe fails it
    id=$("$c" runtime-identity --raw 2>/dev/null) || continue
    case "$id" in *'"packageName":"@opengsd/gsd-core"'*|*'"packageName": "@opengsd/gsd-core"'*) ;; *) continue ;; esac
    printf '%s\n' "$c"; return 0
  done
  return 1
}
gsd_cli_missing() {  # → why there is no gsd_cli, and the fix
  printf '%s\n' "GSD (gsd-core) not found — install it:  $GSD_CORE_INSTALL --claude --global --profile=full"
}

# A skill copy this toolkit installed (install.sh --copy) ends its SKILL.md
# with this comment line. It used to be a .gsd-worktrees-skill file next to
# SKILL.md, but gsd-core's installer stops on any file under skills/gsd-*/ it
# cannot prove it owns, and it keeps SKILL.md. The old file is still read, and
# so is the mark releases before 0.8.0 wrote (the package was gsd-worktrees).
GSD_SKILL_MARK='<!-- gsd-toolkit-skill'
GSD_SKILL_MARK_OLD='<!-- gsd-worktrees-skill'
gsd_skill_owned() {  # dir → 0 when it is a copy this toolkit placed
  [ -f "$1/.gsd-worktrees-skill" ] || grep -qF -e "$GSD_SKILL_MARK" -e "$GSD_SKILL_MARK_OLD" "$1/SKILL.md" 2>/dev/null
}
gsd_skill_differs() {  # src dest → 0 when dest is not the current copy of src
  local src=${1%/} dest=${2%/}
  [ -d "$dest" ] && [ ! -f "$dest/.gsd-worktrees-skill" ] || return 0
  diff -qr -x SKILL.md "$src" "$dest" >/dev/null 2>&1 || return 0
  ! grep -vF -e "$GSD_SKILL_MARK" -e "$GSD_SKILL_MARK_OLD" "$dest/SKILL.md" 2>/dev/null | cmp -s - "$src/SKILL.md"
}

gsd_python() {  # → the interpreter for lib/gsd_planning.py; nonzero when none
  # Most systems have `python3`, but minimal images (and Windows) name it
  # `python`. Checking the NAME is not enough: `python` is still Python 2 on
  # older systems, which cannot run the reconciler at all — so verify the
  # version by asking the interpreter itself. Cached: the reconciler is called
  # several times per finish, and each probe is a process spawn.
  if [ -n "${GSD_PYTHON:-}" ]; then printf '%s\n' "$GSD_PYTHON"; return 0; fi
  local py
  for py in python3 python; do
    command -v "$py" >/dev/null 2>&1 || continue
    "$py" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)' 2>/dev/null || continue
    GSD_PYTHON="$py"
    printf '%s\n' "$py"
    return 0
  done
  return 1
}

# gsd-core's worktree.baseRef = "head": /gsd-execute-phase runs a wave's plans
# in parallel only when it (or Claude Code) forks their worktrees from HEAD.
# Without it, base-check compares HEAD with origin/HEAD — always different on
# a phase branch — and runs every plan one by one. gsd-core takes the first
# baseRef it finds in <cwd>/.claude/settings.local.json, <cwd>/.claude/
# settings.json, then ~/.claude/settings.json (CLAUDE_CONFIG_DIR), where <cwd>
# is the PHASE worktree (it has its own .planning/), so each worktree needs it.
# We write the gitignored local file, as `gsd-tools worktree set-baseref` does.
gsd_baseref() {  # check|ensure <dir> → head | missing | set | other:<value> | invalid | tracked | unignored | nopython
  # check reports what gsd-core would see; ensure adds the key to the local
  # file when no layer sets it (set), keeping every other key. A different
  # value in any layer is the user's choice: never changed.
  local py st
  py=$(gsd_python) || { echo nopython; return 0; }
  st=$(gsd__baseref_py "$py" check "$2")
  [ "$1" = ensure ] && [ "$st" = missing ] || { echo "$st"; return 0; }
  # Writing a tracked, or not ignored, file would show up as uncommitted work
  # and stop gsd-finish.
  if git -C "$2" ls-files --error-unmatch -- .claude/settings.local.json >/dev/null 2>&1; then
    echo tracked; return 0
  fi
  git -C "$2" check-ignore -q -- .claude/settings.local.json 2>/dev/null || { echo unignored; return 0; }
  gsd__baseref_py "$py" ensure "$2"
}
gsd__baseref_py() {  # <python> check|ensure <dir>
  "$1" - "$2" "$3/.claude/settings.local.json" "$3/.claude/settings.json" \
    "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" <<'PY' 2>/dev/null || echo invalid
import json, os, shutil, sys, tempfile
mode, local = sys.argv[1], os.path.realpath(sys.argv[2])

def read(path):  # → (settings dict or None, parsed?)
    if not os.path.exists(path):
        return None, True
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None, False
    return (data, True) if isinstance(data, dict) else (None, False)

data, ok = read(local)
for path in sys.argv[2:]:
    s = data if path == sys.argv[2] else read(path)[0]
    wt = s.get("worktree") if s else None
    ref = wt.get("baseRef") if isinstance(wt, dict) else None
    if isinstance(ref, str):
        print("head" if ref == "head" else "other:" + ref); sys.exit(0)
if not ok or (data is not None and "worktree" in data and not isinstance(data["worktree"], dict)):
    print("invalid"); sys.exit(0)
if mode != "ensure":
    print("missing"); sys.exit(0)
data = data if data is not None else {}
data.setdefault("worktree", {})["baseRef"] = "head"
d = os.path.dirname(local)
os.makedirs(d, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=d, prefix=".settings.local.")
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
if os.path.exists(local):
    shutil.copymode(local, tmp)
else:
    os.chmod(tmp, 0o644)
os.replace(tmp, local)
print("set")
PY
}

gsd_baseref_ensure() {  # <dir> [label] → one line saying what happened; never fails
  local st label=${2:-$1}
  st=$(gsd_baseref ensure "$1")
  case "$st" in
    set)      echo "✔ ${label}/.claude/settings.local.json: worktree.baseRef = \"head\" (plans in a wave can run in parallel)" ;;
    head)     ;;
    other:*)  echo "• ${label}/.claude/settings.local.json keeps worktree.baseRef = \"${st#other:}\" (yours; \"head\" lets a wave's plans run in parallel)" ;;
    tracked)  echo "⚠ ${label}/.claude/settings.local.json is tracked by git — not changed; add worktree.baseRef = \"head\" yourself so a wave's plans run in parallel" ;;
    unignored) echo "⚠ .claude/settings.local.json is not gitignored in ${label} — not written; run gsd-init, then add worktree.baseRef = \"head\" so a wave's plans run in parallel" ;;
    nopython) echo "⚠ no python 3.7+ — could not set worktree.baseRef = \"head\" in ${label}/.claude/settings.local.json" ;;
    *)        echo "⚠ ${label}/.claude/settings.local.json is not plain JSON — not changed; add worktree.baseRef = \"head\" yourself so a wave's plans run in parallel" ;;
  esac
  return 0
}

gsd__add_missing() { GSD_PLANNING_MISSING="${GSD_PLANNING_MISSING:+$GSD_PLANNING_MISSING }$1"; }

gsd_planning_hook() {  # $1=repo root → GSD_HOOK_PATH, GSD_HOOK_LABEL, GSD_HOOK_VERSIONED
  # Husky owns post-merge where it is installed (core.hooksPath points into
  # .husky/_, which husky regenerates), and there the hook is a VERSIONED file.
  #
  # Everywhere else, ASK GIT for the hooks dir and decide by WHERE IT LANDS —
  # do not assume .git/hooks. A repo may point core.hooksPath at a tracked
  # directory (scripts/git-hooks is a common convention), and there the hook
  # belongs in the commit like any other file. Assuming it was always
  # unversioned left it untracked in exactly such a repo: it worked for the
  # clone that ran the bootstrap and protected nobody else.
  local dir gitdir root
  if [ -d "$1/.husky" ]; then
    GSD_HOOK_PATH="$1/.husky/post-merge"
    GSD_HOOK_LABEL=".husky/post-merge"
    GSD_HOOK_VERSIONED=1
    return 0
  fi
  dir="$(git -C "$1" rev-parse --path-format=absolute --git-path hooks 2>/dev/null)"
  gitdir="$(git -C "$1" rev-parse --path-format=absolute --git-dir 2>/dev/null)"
  # Take the root from GIT too, not from "$1": these are string comparisons, and
  # a caller-supplied path can spell the same directory differently (on macOS
  # /var vs /private/var), which would silently flip the answer.
  root="$(git -C "$1" rev-parse --path-format=absolute --show-toplevel 2>/dev/null)" || root="$1"
  [ -n "$root" ] || root="$1"
  GSD_HOOK_PATH="$dir/post-merge"
  # Order matters: .git/ is itself inside the working tree, so test it first.
  case "$dir/" in
    "$gitdir"/*) GSD_HOOK_VERSIONED=0 ;;   # per clone — cannot be committed
    "$root"/*)   GSD_HOOK_VERSIONED=1 ;;   # in the working tree — tracked
    *)           GSD_HOOK_VERSIONED=0 ;;   # outside the repo entirely
  esac
  if [ "$GSD_HOOK_VERSIONED" = 1 ]; then
    GSD_HOOK_LABEL="${GSD_HOOK_PATH#"$root"/}"
  else
    GSD_HOOK_LABEL="$(git -C "$1" rev-parse --git-path hooks)/post-merge (not versioned)"
  fi
}

gsd_planning_status() {  # $1=repo root → GSD_PLANNING_MISSING + GSD_ATTRS_STATE
  # The single source of truth for "is this repo's .planning merge safety
  # installed". gsd-bootstrap-repo applies what this reports missing and
  # gsd-doctor reports it — one predicate, so the two can never disagree about
  # what counts as installed. Three items; the repair SHIM is not one of them,
  # it rides along with the ordinary shims.
  local repo="$1" attrs="$1/.gitattributes"
  GSD_PLANNING_MISSING=""

  if grep -qE '^\.planning/(ROADMAP|STATE)\.md[[:space:]]+merge=union[[:space:]]*$' "$attrs" 2>/dev/null; then
    GSD_ATTRS_STATE=union            # the dangerous one: keeps BOTH sides
  elif [ "$(grep -cE '^\.planning/(ROADMAP|STATE)\.md[[:space:]]+merge=gsd-planning[[:space:]]*$' "$attrs" 2>/dev/null)" = 2 ]; then
    GSD_ATTRS_STATE=ok
  else
    GSD_ATTRS_STATE=absent
  fi
  [ "$GSD_ATTRS_STATE" = ok ] || gsd__add_missing attributes

  [ "$(git -C "$repo" config --get merge.gsd-planning.driver 2>/dev/null)" \
      = "gsd-planning-merge %O %A %B %P" ] || gsd__add_missing driver

  gsd_planning_hook "$repo"
  { [ -x "$GSD_HOOK_PATH" ] && grep -q 'gsd-planning-repair' "$GSD_HOOK_PATH" 2>/dev/null; } || gsd__add_missing hook
}

gsd_planning_apply() {  # $1=repo root — install whatever gsd_planning_status reports missing
  local repo="$1" attrs="$1/.gitattributes" line
  gsd_planning_status "$repo"

  case " $GSD_PLANNING_MISSING " in *" attributes "*)
    if [ "$GSD_ATTRS_STATE" = union ]; then
      perl -pi -e 's{^(\.planning/(?:ROADMAP|STATE)\.md\s+merge=)union\s*$}{$1gsd-planning\n}' "$attrs"
      echo "✔ .gitattributes (migrated .planning merge=union → merge=gsd-planning)"
    fi
    for line in '.planning/ROADMAP.md merge=gsd-planning' '.planning/STATE.md merge=gsd-planning'; do
      grep -qxF "$line" "$attrs" 2>/dev/null || echo "$line" >> "$attrs"
    done
    echo "✔ .gitattributes (merge=gsd-planning for .planning/ROADMAP.md + STATE.md)"
  ;; esac

  case " $GSD_PLANNING_MISSING " in *" driver "*)
    if gsd_register_merge_driver "$repo" \
       && [ -n "$(git -C "$repo" config --get merge.gsd-planning.driver 2>/dev/null)" ]; then
      echo "✔ merge driver registered (merge.gsd-planning → gsd-planning-merge)"
    else
      echo "⚠ could not register the merge driver — gsd-finish re-asserts it on every run"
    fi
  ;; esac

  case " $GSD_PLANNING_MISSING " in *" hook "*)
    # The driver covers merges; the hook covers a plain `git pull` on the base
    # branch by someone who never runs gsd-finish.
    local body='#!/usr/bin/env sh
# Installed by gsd-bootstrap-repo (gsd-toolkit).
# .planning/ROADMAP.md and STATE.md merge with a union-then-reconcile driver.
# A pull whose driver was missing, or a merge done by another tool, can still
# leave both sides of a single-value line behind — reconcile them here.
command -v gsd-planning-repair >/dev/null 2>&1 || exit 0
[ -d .planning ] || exit 0
gsd-planning-repair || true
'
    mkdir -p "$(dirname "$GSD_HOOK_PATH")"
    if [ -e "$GSD_HOOK_PATH" ]; then
      if ! grep -q 'gsd-planning-repair' "$GSD_HOOK_PATH"; then
        printf '\n%s\n' "$body" | sed '1d' >> "$GSD_HOOK_PATH"
      fi
      echo "✔ $GSD_HOOK_LABEL (existing hook repaired)"
    else
      printf '%s' "$body" > "$GSD_HOOK_PATH"
      chmod +x "$GSD_HOOK_PATH"
      echo "✔ $GSD_HOOK_LABEL (created)"
    fi
    chmod +x "$GSD_HOOK_PATH"
  ;; esac
}

gsd_release_lock() { rm -rf "${GSD_LOCKDIR:-}" 2>/dev/null || true; }

gsd__mkdir_excl() {  # $1=dir → true only for the one caller that made it
  # Not the mkdir command: uutils' (Ubuntu 26.04) can tell two racing callers
  # both that they made it. Perl's mkdir is the plain system call.
  perl -e 'mkdir $ARGV[0] or exit 1' "$1" 2>/dev/null
}

gsd_acquire_lock() {  # $1=MAIN checkout — serialize gsd commands on this checkout
  # Two gsd commands on the SAME machine share the main checkout (index, HEAD,
  # ROADMAP); this lock serializes them. Sets GSD_LOCKDIR and installs a
  # release trap. Re-entrant: a no-op when the caller already holds the lock
  # (gsd-finish exports GSD_LOCK_HELD=1 before delegating to gsd-wt-finish).
  # NOT exported here: gsd-start execs an agent session after releasing, and an
  # inherited GSD_LOCK_HELD=1 would disable locking for that whole session.
  [ "${GSD_LOCK_HELD:-}" = 1 ] && return 0
  GSD_LOCKDIR="$1/.git/gsd-cmd.lock"
  local waited=0 lockpid
  until gsd__mkdir_excl "$GSD_LOCKDIR"; do
    # Reclaim a stale lock left by a crashed run (owner PID gone). mv first so
    # only one waiter wins the reclaim.
    lockpid=$(cat "$GSD_LOCKDIR/pid" 2>/dev/null || true)
    if [ -n "$lockpid" ] && ! kill -0 "$lockpid" 2>/dev/null; then
      if mv "$GSD_LOCKDIR" "$GSD_LOCKDIR.stale.$$" 2>/dev/null; then
        rm -rf "$GSD_LOCKDIR.stale.$$"
        echo "▶ reclaimed stale gsd lock (owner PID $lockpid no longer running)"
      fi
      continue
    fi
    [ "$waited" -eq 0 ] && echo "▶ another gsd command is using this checkout — waiting (lock: $GSD_LOCKDIR)…"
    waited=$((waited + 1))
    if [ "$waited" -ge 300 ]; then
      echo "✖ gave up waiting after 300s — if no gsd command is running, remove the stale lock: rm -rf $GSD_LOCKDIR" >&2
      return 1
    fi
    sleep 1
  done
  echo "$$" > "$GSD_LOCKDIR/pid"
  # A signal must STOP the command: a bare release trap on INT/TERM runs and
  # then lets the script carry on (and exit 0). Exiting fires the EXIT release.
  trap gsd_release_lock EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

gsd__npm_has_test() {  # $1=package.json — true when "scripts" defines "test"
  # Scoped to the scripts object: a dependency named "test" must not count.
  perl -0777 -ne 'exit((/"scripts"\s*:\s*\{[^}]*"test"\s*:/s) ? 0 : 1)' "$1" 2>/dev/null
}

gsd_test_cmd() {  # $1=repo root → pre-merge test command ('' = skip)
  # `test =` in .gsd.conf wins ('none' disables); otherwise the same detection
  # table gsd-core uses for workflow.test_command.
  local v; v=$(gsd_conf_get "$1" test)
  if [ -n "$v" ]; then
    [ "$v" = none ] || printf '%s\n' "$v"
    return 0
  fi
  local x; for x in "$1"/*.xcodeproj; do [ -e "$x" ] && { echo "xcodebuild test"; return 0; }; done
  if   false; then :
  elif [ -f "$1/Makefile" ] && grep -qE '^test:' "$1/Makefile";     then echo "make test"
  elif [ -f "$1/Justfile" ] || [ -f "$1/justfile" ];                then echo "just test"
  elif [ -f "$1/Cargo.toml" ];                                       then echo "cargo test"
  elif [ -f "$1/go.mod" ];                                           then echo "go test ./..."
  elif [ -f "$1/package.json" ] && gsd__npm_has_test "$1/package.json"; then echo "npm test"
  elif [ -f "$1/pyproject.toml" ] || [ -f "$1/pytest.ini" ];         then echo "python -m pytest"
  fi
}

gsd_install_cmd() {  # $1=repo root → worktree bootstrap command ('' = skip)
  local v; v=$(gsd_conf_get "$1" install)
  if [ -n "$v" ]; then
    [ "$v" = none ] || printf '%s\n' "$v"
    return 0
  fi
  if   [ -f "$1/pnpm-lock.yaml" ];     then echo "pnpm install"
  elif [ -f "$1/yarn.lock" ];          then echo "yarn install"
  elif [ -f "$1/package-lock.json" ] || [ -f "$1/package.json" ]; then echo "npm install"
  fi
}
