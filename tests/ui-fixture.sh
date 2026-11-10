# shellcheck shell=bash
# ui-fixture.sh — fixture files for the checks of the rendered pages, sourced
# by the suites (no browser: the files are written as gsdt-ui would write them).
#
#   ui_fix_check <phase dir> <P> [status] [capture] [code]
#       <P>-UI-CHECK.md for the pages / and /cart at 375px. An empty code
#       means "not compared", so the state never turns stale by itself.
#   ui_fix_look <phase dir> <P> [capture] [verdict] [rules]
#       <P>-UI-LOOK.md answering every rule for both pictures.
#   ui_fix_approval <phase dir> <P> [capture]
#   ui_fix_all <phase dir> <P>      a passed check, a complete look, an approval

ui_fix_check() {
  { printf -- '---\nstatus: %s\ncapture: %s\ntaken: 2026-01-01T00:00:00Z\ncode: %s\n' "${3:-passed}" "${4:-cap1}" "${5:-}"
    printf 'url: http://localhost:3005\nfailures: %s\nwaived: 0\nquestions: 1\nunchecked: 0\n---\n\n' "$([ "${3:-passed}" = failed ] && echo 2 || echo 0)"
    printf '## Failures\n\nNone.\n\n## Questions\n\n- Q1 | /cart | 375 | C2 | possible clipped text in 1 element(s): div.box "long"\n\n'
    printf '## Shots\n\n- / | 375 | home-375-aaaaaa.png\n- /cart | 375 | cart-375-bbbbbb.png\n'; } > "$1/$2-UI-CHECK.md"
}

ui_fix_look() {
  local r
  { printf -- '---\ncapture: %s\n---\n\n# look\n\n## / at 375px\n\n' "${3:-cap1}"
    for r in ${5:-R1 R2 R3 R4 R5 R6 R7 R8 R9 R10}; do printf -- '- %s: %s — seen in the picture\n' "$r" "${4:-ok}"; done
    printf '\n## /cart at 375px\n\n'
    for r in ${5:-R1 R2 R3 R4 R5 R6 R7 R8 R9 R10}; do printf -- '- %s: ok — seen in the picture\n' "$r"; done
    printf -- '- Q1: n/a — the box scrolls\n'; } > "$1/$2-UI-LOOK.md"
}

ui_fix_approval() {
  printf -- '---\nstatus: approved\ncapture: %s\nby: t\napproved: 2026-01-01T00:00:00Z\n---\n' "${3:-cap1}" > "$1/$2-UI-APPROVAL.md"
}

ui_fix_all() { ui_fix_check "$1" "$2"; ui_fix_look "$1" "$2"; ui_fix_approval "$1" "$2"; }
