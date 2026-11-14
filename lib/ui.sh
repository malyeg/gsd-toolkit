# shellcheck shell=bash
# lib/ui.sh — the UI quality gates, one definition shared by gsdt-flow-next,
# gsdt-worktree-guard, gsdt-doctor and gsdt-ui (see docs/ui-quality-plan.md).
#
#   .planning/design/DESIGN.md   the project's design system (one per project).
#                                A stub carries GSD_UI_STUB; it counts as filled
#                                once that line is gone.
#   <P>-LAYOUT.md                per phase with screens: the chosen /gsd-sketch
#                                (`sketch:`), the pages to shoot (`pages:`), and
#                                the layout contract. `sketch: skip <reason>` is
#                                an explicit, visible opt-out. Optional `url:`
#                                names this phase's app (several-app projects).
#                                For the check: `app:` (where Playwright is
#                                installed), and per page `main_button:`,
#                                `expect:`, `waive:`.
#   <P>-UI-CHECK.md              per phase: what gsdt-ui check measured on the
#                                rendered pages. One run = one capture; the
#                                pictures and the sheet sit in <P>-SHOTS/ (not
#                                committed).
#   <P>-UI-LOOK.md               per phase: what the agent saw, per picture and
#                                rule, for that capture.
#   <P>-UI-APPROVAL.md           per phase: the user's yes to that capture (or a
#                                recorded waiver).
#   <P>-SHOTS.md                 gsdt-ui shots (manual, no checks; the flow step
#                                before 0.4.0).
#
# ui_gates in .gsd.conf (main checkout): warn (default) = gsdt-flow-next shows
# the steps, gsdt-finish warns; strict = the guard and gsdt-finish block too,
# doctor reports findings; off = none of it.
#
# gsd_ui_gate is the one answer to "which UI step is open": gsdt-flow-next, the
# guard, gsdt-wt-finish and gsdt-doctor all ask it (docs/plan-ui-check.md).
# Needs lib/common.sh.

GSD_UI_STUB='<!-- gsd:design-stub'

gsd_ui_gates() {  # $1=any checkout → warn|strict|off
  local v
  v=$(gsd_conf_get "$(gsd_main "$1" 2>/dev/null || true)" ui_gates)
  [ -n "$v" ] || v=$(gsd_conf_get "$1" ui_gates)
  case "$v" in strict|off) printf '%s' "$v" ;; *) printf warn ;; esac
}

gsd_ui_design_file() { printf '%s/.planning/design/DESIGN.md' "$1"; }

gsd_ui_design_state() {  # $1=checkout → missing|stub|ok
  local f; f=$(gsd_ui_design_file "$1")
  [ -f "$f" ] || { printf missing; return; }
  if grep -qF "$GSD_UI_STUB" "$f"; then printf stub; else printf ok; fi
}

gsd_ui_field() {  # $1=file $2=key → value of the first `key: value` line
  [ -f "$1" ] || return 0
  sed -n -E "s/^$2:[[:space:]]*//p" "$1" | head -1 | sed -e 's/[[:space:]]*$//'
}

gsd_ui_winner() {  # $1=sketch dir → the winner from its README frontmatter ('' = none)
  local w
  w=$(sed -n '/^---$/,/^---$/p' "$1/README.md" 2>/dev/null | sed -n -E 's/^winner:[[:space:]]*//p' | head -1 | tr -d "\"'[:space:]")
  case "$w" in ''|null|'~'|none) ;; *) printf '%s' "$w" ;; esac
}

gsd_ui_layout_state() {  # $1=checkout $2=phase dir $3=P → missing|nosketch|badsketch|nowinner|nopages|skip|ok
  local f="$2/$3-LAYOUT.md" s
  [ -f "$f" ] || { printf missing; return; }
  s=$(gsd_ui_field "$f" sketch)
  case "$s" in
    '') printf nosketch; return ;;
    skip|skip[[:space:]]*) printf skip; return ;;
  esac
  [ -d "$1/$s" ] || { printf badsketch; return; }
  [ -n "$(gsd_ui_winner "$1/$s")" ] || { printf nowinner; return; }
  [ -n "$(gsd_ui_field "$f" pages)" ] || { printf nopages; return; }
  printf ok
}

gsd_ui_shots_state() {  # $1=phase dir $2=P → missing|skip|ok
  local f="$1/$2-SHOTS.md"
  [ -f "$f" ] || { printf missing; return; }
  if [ -n "$(gsd_ui_field "$f" skipped)" ]; then printf skip; else printf ok; fi
}

gsd_ui_has_screens() {  # $1=checkout → true when any phase has a UI-SPEC or LAYOUT
  local f
  for f in "$1"/.planning/phases/*/*-UI-SPEC.md "$1"/.planning/phases/*/*-LAYOUT.md; do
    [ -f "$f" ] && return 0
  done
  return 1
}

gsd_ui_phase_screens() {  # $1=phase dir $2=P → true when this phase has screens
  [ -f "$1/$2-UI-SPEC.md" ] || [ -f "$1/$2-LAYOUT.md" ]
}

gsd_ui_playwright() {  # $1=checkout $2=app: from LAYOUT ('' = none) → the playwright CLI ('' = none)
  local d
  if [ -n "${GSD_PLAYWRIGHT:-}" ]; then printf '%s' "$GSD_PLAYWRIGHT"; return 0; fi
  for d in ${2:+"$1/$2"} "$1" "$1"/apps/* "$1"/packages/*; do
    [ -x "$d/node_modules/.bin/playwright" ] && { printf '%s' "$d/node_modules/.bin/playwright"; return 0; }
  done
  if command -v playwright >/dev/null 2>&1; then command -v playwright; fi
}

gsd_ui_global_root() {  # → the global npm node_modules folder ('' = none); GSD_NPM_GLOBAL_ROOT overrides
  local r
  if [ -n "${GSD_NPM_GLOBAL_ROOT+x}" ]; then printf '%s' "$GSD_NPM_GLOBAL_ROOT"; return 0; fi
  command -v npm >/dev/null 2>&1 || return 0
  r=$(npm root -g 2>/dev/null) || return 0
  [ -d "$r" ] && printf '%s' "$r"
}

gsd_ui_playwright_installed() {  # $1=checkout → where a Playwright package is: project|global ('' + 1 = none; files only, nothing is run)
  local d g
  for d in ${GSD_PLAYWRIGHT_ROOT:+"$GSD_PLAYWRIGHT_ROOT"} "$1" "$1"/apps/* "$1"/packages/*; do
    [ -e "$d/node_modules/playwright/package.json" ] || [ -e "$d/node_modules/@playwright/test/package.json" ] || continue
    printf project; return 0
  done
  g=$(gsd_ui_global_root)
  if [ -n "$g" ] && { [ -e "$g/playwright/package.json" ] || [ -e "$g/@playwright/test/package.json" ]; }; then
    printf global; return 0
  fi
  return 1
}

# ── the rendered-page check (gsdt-ui check / look / approve) ──────────────────
# shellcheck disable=SC2034  # read by bin/gsdt-ui
GSD_UI_WIDTHS='375 768 1440'
GSD_UI_RULES='R1|One main focus per screen
R2|The main button is on the first screen, never covered
R3|More than ~12 items → search, filters or tabs
R4|One alignment system per page
R5|Consistent title casing
R6|Header and footer are lighter than the content
R7|No large empty areas; cards in a row have equal structure
R8|Images: same shape and treatment; no blank or near-empty images
R9|Nothing wraps alone onto its own row at any size
R10|Matches the chosen sketch: same sections, same order'

gsd_ui_rules() {  # $1=checkout → `R<n>|<rule>` lines: the project's (DESIGN.md `- R<n>: …`), else the defaults
  local r
  r=$(sed -n -E 's/^- (R[0-9]+):[[:space:]]*(.*[^[:space:]])[[:space:]]*$/\1|\2/p' "$(gsd_ui_design_file "$1")" 2>/dev/null)
  printf '%s\n' "${r:-$GSD_UI_RULES}"
}

gsd_ui_fm() {  # $1=file $2=key → the value in the file's frontmatter
  sed -n '/^---$/,/^---$/p' "$1" 2>/dev/null | sed -n -E "s/^$2:[[:space:]]*//p" | head -1 | sed -e 's/[[:space:]]*$//'
}

gsd_ui_fields() {  # $1=file $2=key → the value of EVERY `key: value` line, one per line
  [ -f "$1" ] || return 0
  sed -n -E "s/^$2:[[:space:]]*//p" "$1" | sed -e 's/[[:space:]]*$//' -e '/^$/d'
}

gsd_ui_page_hash() {  # $1=page path → 6 hex; picture names carry it so /a/b and /a-b differ
  printf '%s' "$1" | git hash-object --stdin | cut -c1-6
}

gsd_ui_min_font() {  # $1=checkout → ui_min_font (8–32), default 12
  local v; v=$(gsd_conf_get "$(gsd_main "$1" 2>/dev/null || true)" ui_min_font)
  [ -n "$v" ] || v=$(gsd_conf_get "$1" ui_min_font)
  case "$v" in ''|*[!0-9]*) printf 12; return ;; esac
  if [ "$((10#$v))" -ge 8 ] && [ "$((10#$v))" -le 32 ]; then printf '%s' "$((10#$v))"; else printf 12; fi
}

gsd_ui_code_state() {  # $1=checkout → a hash of the working tree outside .planning/ ('' = unknown)
  # The tree git would write for the files as they are on disk now, so a commit
  # of unchanged content keeps the hash. Built in a throwaway index and object
  # directory: the checkout, its index and its object store are not touched.
  local top idx objs tmp h
  top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || return 0
  idx=$(git -C "$top" rev-parse --git-path index 2>/dev/null) || return 0
  objs=$(git -C "$top" rev-parse --git-path objects 2>/dev/null) || return 0
  case "$idx" in /*) ;; *) idx="$top/$idx" ;; esac
  case "$objs" in /*) ;; *) objs="$top/$objs" ;; esac
  tmp=$(mktemp -d 2>/dev/null) || return 0
  mkdir -p "$tmp/objects"
  # -p keeps the index's own mtime: git re-reads a file whose mtime is not
  # older than the index's ("racy git"). A fresh mtime on the copy would hide
  # a same-size edit made in the second of the last index write.
  [ ! -f "$idx" ] || cp -p "$idx" "$tmp/index"
  h=$(cd "$top" \
    && GIT_INDEX_FILE="$tmp/index" GIT_OBJECT_DIRECTORY="$tmp/objects" GIT_ALTERNATE_OBJECT_DIRECTORIES="$objs" \
       git add -A -- . ':(exclude).planning' >/dev/null 2>&1 \
    && GIT_INDEX_FILE="$tmp/index" GIT_OBJECT_DIRECTORY="$tmp/objects" GIT_ALTERNATE_OBJECT_DIRECTORIES="$objs" \
       git rm -r -q --cached --ignore-unmatch -- .planning >/dev/null 2>&1 \
    && GIT_INDEX_FILE="$tmp/index" GIT_OBJECT_DIRECTORY="$tmp/objects" GIT_ALTERNATE_OBJECT_DIRECTORIES="$objs" \
       git write-tree 2>/dev/null) || h=""
  rm -rf "$tmp"
  printf '%s' "$h"
}

gsd_ui_inputs_state() {  # $1=checkout $2=phase dir $3=P → what a UI check is valid for: <code hash>+<LAYOUT hash> ('' = unknown)
  # The LAYOUT says what is checked (pages, url, main_button, expect, waive),
  # and it lives in .planning/, outside the code hash: an edit to it must make
  # an older check stale too.
  local code lay
  code=$(gsd_ui_code_state "$1"); [ -n "$code" ] || return 0
  lay=$(git hash-object "$2/$3-LAYOUT.md" 2>/dev/null || true)
  printf '%s+%s' "$code" "${lay:-none}"
}

gsd_ui_exempt() {  # $1=checkout $2=phase dir $3=P → true when the phase's UI review is already on the base branch
  # Only a review that was MERGED exempts a phase from the newer steps; one
  # written in the phase's own worktree exempts nothing.
  local base rel ref
  base=$(gsd_base "$(gsd_main "$1" 2>/dev/null || printf '%s' "$1")")
  rel="${2#"$1"/}/$3-UI-REVIEW.md"
  for ref in "refs/remotes/origin/$base" "refs/heads/$base"; do
    git -C "$1" cat-file -e "$ref:$rel" 2>/dev/null && return 0
  done
  return 1
}

gsd_ui_check_state() {  # $1=checkout $2=phase dir $3=P $4=nostale ('' = compare the code) → missing|error|failed|skipped|stale|passed
  local f="$2/$3-UI-CHECK.md" st code now
  [ -f "$f" ] || { printf missing; return; }
  st=$(gsd_ui_fm "$f" status)
  case "$st" in
    skipped) printf skipped; return ;;
    passed|failed) ;;
    *) printf error; return ;;
  esac
  code=$(gsd_ui_fm "$f" code)
  if [ -z "${4:-}" ] && [ -n "$code" ]; then
    # a check written before the LAYOUT was part of it holds the code hash only
    case "$code" in *+*) now=$(gsd_ui_inputs_state "$1" "$2" "$3") ;; *) now=$(gsd_ui_code_state "$1") ;; esac
    [ -z "$now" ] || [ "$now" = "$code" ] || { printf stale; return; }
  fi
  printf '%s' "$st"
}

gsd_ui_check_list() {  # $1=UI-CHECK.md $2=section (Shots, Questions, …) → its `- a | b | c` lines, without the `- `
  [ -f "$1" ] || return 0
  awk -v want="## $2" '/^## /{on = ($0 == want); next} on && /^- /{print substr($0, 3)}' "$1"
}

gsd_ui_look_keys() {  # $1=checkout $2=phase dir $3=P → the answers a complete look file holds: `page|width|id` lines
  local f="$2/$3-UI-CHECK.md" rules
  rules=$(gsd_ui_rules "$1" | cut -d'|' -f1)
  gsd_ui_check_list "$f" Shots | while IFS= read -r line; do
    page=$(printf '%s' "$line" | awk -F' [|] ' '{print $1}'); w=$(printf '%s' "$line" | awk -F' [|] ' '{print $2}')
    for r in $rules; do printf '%s|%s|%s\n' "$page" "$w" "$r"; done
    gsd_ui_check_list "$f" Questions | awk -F' [|] ' -v p="$page" -v w="$w" '$2 == p && $3 == w {print p "|" w "|" $1}'
  done
}

gsd_ui_look_answers() {  # $1=UI-LOOK.md → `page|width|id|verdict|text` for every answered line
  [ -f "$1" ] || return 0
  LC_ALL=C awk '
    /^## / { page = ""; w = ""
      n = split($0, a, " ")
      if (n == 4 && a[3] == "at" && a[4] ~ /^[0-9]+px$/) { page = a[2]; w = a[4]; sub(/px$/, "", w) }
      next }
    page != "" && /^- [RQ][0-9]+:/ {
      id = $2; sub(/:$/, "", id)
      rest = $0; sub(/^- [RQ][0-9]+:[ \t]*/, "", rest)
      verdict = rest; sub(/[ \t].*$/, "", verdict)
      text = rest; sub(/^[^ \t]+[ \t]*/, "", text)
      sub(/^(—|--|-|:)[ \t]*/, "", text); sub(/[ \t]+$/, "", text)
      if (verdict == "ok" || verdict == "fixed" || verdict == "bad" || verdict == "n/a")
        print page "|" w "|" id "|" verdict "|" text
    }' "$1"
}

gsd_ui_look_state() {  # $1=checkout $2=phase dir $3=P → missing|stale|open|bad|complete
  local f="$2/$3-UI-LOOK.md" cap
  [ -f "$f" ] || { printf missing; return; }
  cap=$(gsd_ui_fm "$2/$3-UI-CHECK.md" capture)
  [ -n "$cap" ] && [ "$(gsd_ui_fm "$f" capture)" = "$cap" ] || { printf stale; return; }
  { gsd_ui_look_keys "$1" "$2" "$3" | sed 's/^/K|/'; gsd_ui_look_answers "$f" | sed 's/^/A|/'; } | LC_ALL=C awk -F'|' '
    $1 == "K" { want[$2 "|" $3 "|" $4] = 1; n++ }
    $1 == "A" { k = $2 "|" $3 "|" $4; text = $6; for (i = 7; i <= NF; i++) text = text "|" $i
                if (length(text) >= 3) got[k] = $5 }
    END { if (n == 0) { print "open"; exit }
          for (k in want) { if (!(k in got)) { open = 1 } else if (got[k] == "bad") bad = 1 }
          if (open) print "open"; else if (bad) print "bad"; else print "complete" }' | tr -d '\n'
}

gsd_ui_approval_state() {  # $1=phase dir $2=P → missing|stale|ok|waived
  local f="$1/$2-UI-APPROVAL.md"
  [ -f "$f" ] || { printf missing; return; }
  case "$(gsd_ui_fm "$f" status)" in
    waived) [ -n "$(gsd_ui_fm "$f" reason)" ] && printf waived || printf missing ;;
    approved)
      if [ -n "$(gsd_ui_fm "$f" capture)" ] && [ "$(gsd_ui_fm "$f" capture)" = "$(gsd_ui_fm "$1/$2-UI-CHECK.md" capture)" ]; then printf ok
      else printf stale; fi ;;
    *) printf missing ;;
  esac
}

gsd_ui_gate() {  # $1=checkout $2=phase dir $3=P $4=nostale → `step|state|what is open` for the first open UI step ('' = none)
  local cs ls as
  cs=$(gsd_ui_check_state "$1" "$2" "$3" "${4:-}")
  case "$cs" in
    missing) printf 'ui-check|missing|the rendered pages were never checked (no %s-UI-CHECK.md)' "$3"; return ;;
    error)   printf 'ui-check|error|the last check could not run: %s' "$(gsd_ui_fm "$2/$3-UI-CHECK.md" error)"; return ;;
    failed)  printf 'ui-check|failed|the check found %s problem(s) — see %s-UI-CHECK.md' "$(gsd_ui_fm "$2/$3-UI-CHECK.md" failures)" "$3"; return ;;
    stale)   printf 'ui-check|stale|the code or %s-LAYOUT.md changed after the last check' "$3"; return ;;
  esac
  if [ "$cs" = passed ]; then
    ls=$(gsd_ui_look_state "$1" "$2" "$3")
    case "$ls" in
      complete) ;;
      missing) printf 'ui-look|missing|nobody wrote down what the pictures show (no %s-UI-LOOK.md)' "$3"; return ;;
      stale)   printf 'ui-look|stale|%s-UI-LOOK.md describes older pictures' "$3"; return ;;
      bad)     printf 'ui-look|bad|%s-UI-LOOK.md has a line marked bad — fix the page, then check again' "$3"; return ;;
      *)       printf 'ui-look|open|%s-UI-LOOK.md has lines without an answer' "$3"; return ;;
    esac
  fi
  as=$(gsd_ui_approval_state "$2" "$3")
  case "$as" in
    ok|waived) ;;
    stale) printf 'ui-approve|stale|the user approved older pictures' ;;
    *)     printf 'ui-approve|missing|the user has not approved the pages' ;;
  esac
}

gsd_ui_step_cmd() {  # $1=step $2=phase number → the command that closes it
  case "$1" in
    ui-check)   printf 'gsdt-ui check %s' "$2" ;;
    ui-look)    printf 'gsdt-ui look %s, then answer every line' "$2" ;;
    ui-approve) printf 'show the user the sheet (gsdt-ui sheet %s); on a yes: gsdt-ui approve %s' "$2" "$2" ;;
  esac
}

gsd_ui_finish_gate() {  # $1=MAIN $2=phase branch $3=its worktree → 1 = refuse the finish (ui_gates = strict)
  local gates n pd p gate
  gates=$(gsd_ui_gates "$1")
  [ "$gates" != off ] || return 0
  gsd_phase_dir "$3" "$2" || return 0
  n=$GSD_N; pd=$GSD_PD; p=$GSD_P
  gsd_ui_phase_screens "$pd" "$p" || return 0
  ! gsd_ui_exempt "$3" "$pd" "$p" || return 0
  gate=$(gsd_ui_gate "$3" "$pd" "$p")
  [ -n "$gate" ] || return 0
  if [ "$gates" = strict ] && [ "${GSD_SKIP_GUARD:-}" != 1 ]; then
    echo "✗ phase $n has screens and its UI steps are open (ui_gates = strict): ${gate##*|}." >&2
    echo "  In the phase worktree: $(gsd_ui_step_cmd "${gate%%|*}" "$n")   (or GSD_SKIP_GUARD=1 if the user asked to skip it)" >&2
    return 1
  fi
  echo "⚠ phase $n has screens and its UI steps are open: ${gate##*|} — next: $(gsd_ui_step_cmd "${gate%%|*}" "$n")" >&2
  [ "$gates" != strict ] || echo "  (GSD_SKIP_GUARD=1 — finishing anyway)" >&2
  return 0
}

gsd_ui_stack() {  # $1=checkout → words for what the app uses: tailwind shadcn react (files only)
  local f words=""
  for f in "$1"/package.json "$1"/apps/*/package.json "$1"/packages/*/package.json; do
    [ -f "$f" ] || continue
    grep -q '"tailwindcss"' "$f" && words="$words tailwind"
    grep -q '"react"' "$f" && words="$words react"
  done
  for f in "$1"/components.json "$1"/apps/*/components.json "$1"/packages/*/components.json; do
    [ -f "$f" ] && words="$words shadcn"
  done
  printf '%s' "$words" | tr ' ' '\n' | sed '/^$/d' | sort -u | tr '\n' ' ' | sed 's/ $//'
}

gsd_ui_addon_present() {  # $1=checkout $2=addon (impeccable|shadcn-mcp) → true when it looks installed (files only)
  local d
  case "$2" in
    impeccable)
      for d in "$1/.claude/skills" "$1/.agents/skills" "$HOME/.claude/skills" "$HOME/.agents/skills"; do
        [ -e "$d/impeccable" ] && return 0
      done ;;
    shadcn-mcp)
      grep -qs 'shadcn' "$1/.mcp.json" "$HOME/.claude.json" "$HOME/.codex/config.toml" && return 0 ;;
  esac
  return 1
}

gsd_ui_scaffold_design() {  # $1=checkout — create the DESIGN.md stub + refs/ when missing; never overwrites
  local d="$1/.planning/design"
  mkdir -p "$d/refs"
  [ -e "$d/refs/.gitkeep" ] || : > "$d/refs/.gitkeep"
  [ -f "$d/DESIGN.md" ] && return 0
  cat > "$d/DESIGN.md" <<'EOF'
# Design system

<!-- gsd:design-stub — delete this line once the sections below are filled -->

Every screen in this project uses what is listed here. Don't invent new
styles: add to this file first, then use it.

## References

3–5 screenshots of real apps whose look you want, in `.planning/design/refs/`
(Mobbin, Refero, or apps you use). One line each: what to take from it.

Start from a real design system, not a blank page: ask the agent to browse
https://styles.refero.design (real systems written for AI: colors, type,
spacing) and pick the 3 closest to this product; the user chooses one, or
which parts of each to mix. Name it here.

## Tokens

Color, type scale, spacing, radius, shadow — and the file they live in.

Fonts: pick them on purpose — the default font is the first sign of an
AI-made page. Free: https://www.fontshare.com; pairs for headings and body:
https://fontjoy.com.

## Components

Name → file (seed from shadcn/Radix or the project's UI kit). Take a tested
part before drawing one: https://ui.shadcn.com, https://21st.dev,
https://reactbits.dev (React). Icons from one set only.

## Page templates

List, detail, form, dashboard, … → file. Each phase names the template its
screens use in `<P>-LAYOUT.md`.

## Layout rules

Every picture of a built page is held against these (`gsdt-ui look`). Edit
them for this project; keep the `- R<n>: ` form.

EOF
  printf '%s\n' "$GSD_UI_RULES" | sed -E 's/^(R[0-9]+)[|]/- \1: /' >> "$d/DESIGN.md"
}

gsd_ui_layout_template() {  # $1=file $2=phase number — write the LAYOUT template; never overwrites
  [ -f "$1" ] && return 0
  cat > "$1" <<EOF
# Phase $2 layout

<!-- gsd:layout — the layout contract for this phase's screens. gsdt-flow-next
     reads sketch: and pages:; gsdt-ui check reads the rest.
     - url (optional): the app to open when the project has several, e.g.
       http://localhost:{port:3100} ({port:<base>} = this phase's port).
     - app (optional): the folder where Playwright is installed, e.g. apps/web.
     - main_button: one line per page — "/path = Button text", or
       "/path = css=<selector>", or "/path = none". Without "/path =" the
       line holds for every page.
     - expect (optional): "/path = text that must be visible on that page".
     - waive (only with the user's yes), one line per accepted finding:
       "<check> | <page> | <width> | <target> | <reason>"  (* = any). -->

sketch:
pages:
url:
app:
template:
reference:
main_button:
expect:

## Sections, top to bottom

1.

## Main focus

## Main button

## Notes
EOF
}
