#!/usr/bin/env bash
# test-commands.sh — command paths no other suite exercised: gsd-derive-port,
# gsd-start's refusals / --insert / -p / --flow / TDD default, a conflicting finish, stale
# lock reclaim, gsd-init's docs detection, and gsd-finish --pr.
# CI-safe: GSD's gsd_run and gh are stubbed; remotes are local bare repos.
# (gsd-tracker has its own suite: tests/test-tracker.sh.)
set -uo pipefail
PKG=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export PATH="$WORK/stub:$PKG/bin:$PATH"
unset GSD_PROVIDER GSD_AGENT GSD_AGENT_COMMAND GSD_LOCK_HELD GSD_SKIP_GUARD
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '%s\n' "$2" | sed 's/^/      /'; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
has() { if grep -q -- "$2" "$3"; then ok "$1"; else bad "$1" "$(tail -5 "$3")"; fi; }
fails() { local name=$1; shift; if "$@" > "$WORK/out" 2>&1; then bad "$name" "unexpected success"; else ok "$name"; fi; }
section() { printf '\n%s\n' "$1"; }
commit() { git -C "$1" add -A; git -C "$1" commit -qm "${2:-c}"; }

# ── stubs ────────────────────────────────────────────────────────────────────
mkdir -p "$WORK/stub"
# gsd_run (gsd-core): phase.add appends the next integer phase; phase.insert
# adds a zero-padded decimal after phase $3 (as gsd-core does) and prints JSON.
cat > "$WORK/stub/gsd_run" <<'SDK'
#!/usr/bin/env bash
case "$1 $2" in
  "runtime-identity --raw") echo '{"packageName":"@opengsd/gsd-core","version":"1.18.0"}' ;;
  "query phase.add")
    rm="$5/.planning/ROADMAP.md"
    n=$(grep -oE '^### Phase [0-9]+:' "$rm" | grep -oE '[0-9]+' | sort -n | tail -1)
    printf '\n### Phase %s: %s\n' "$((n + 1))" "$3" >> "$rm" ;;
  "query phase.insert")
    rm="$6/.planning/ROADMAP.md"; num="$(printf '%02d' "$3").1"
    printf '\n### Phase %s: %s (INSERTED)\n' "$num" "$4" >> "$rm"
    slug=$(printf '%s' "$4" | tr ' ' '-')
    printf '{\n  "phase_number": "%s",\n  "slug": "%s"\n}\n' "$num" "$slug" ;;
  "query config-set")   # $3=dotted key $4=value $6=project dir
    python3 - "$6/.planning/config.json" "$3" "$4" <<'PY'
import json, sys
f, key, val = sys.argv[1:]
c = json.load(open(f)); d = c; parts = key.split(".")
for k in parts[:-1]: d = d.setdefault(k, {})
d[parts[-1]] = {"true": True, "false": False}.get(val, val)
json.dump(c, open(f, "w"), indent=2)
PY
    ;;
  *) echo "stub gsd_run: unsupported $*" >&2; exit 1 ;;
esac
SDK
# gh: record the call, print a PR URL.
cat > "$WORK/stub/gh" <<'GH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_LOG"
echo "https://github.com/example/shop/pull/1"
GH
chmod +x "$WORK/stub/gsd_run" "$WORK/stub/gh"
export GSD_CLI="$WORK/stub/gsd_run"
export GH_LOG="$WORK/gh.log"

project() {  # $1=dir — repo on main + bare origin, roadmap with phase 1
  git init -q --bare -b main "$1.git"
  mkdir -p "$1/.planning/phases"; git -C "$1" init -qb main
  printf '# Roadmap\n\n### Phase 1: catalog\n' > "$1/.planning/ROADMAP.md"
  printf 'install = none\ntest = none\n' > "$1/.gsd.conf"
  commit "$1" init; git -C "$1" remote add origin "$1.git"; git -C "$1" push -qu origin main
}

section "gsd-derive-port — base + phase number"
port_on() {  # $1=branch → port for base 3000
  local d="$WORK/port-$RANDOM"; git init -qb "$1" "$d"; git -C "$d" commit -qm i --allow-empty
  (cd "$d" && gsd-derive-port 3000 2>&1)
}
is "phase-7-x → 3007"                 "$(port_on phase-7-x)" 3007
is "phase-12-x → 3012"                "$(port_on phase-12-x)" 3012
is "phase-3.1-x uses the integer part" "$(port_on phase-3.1-x)" 3003
is "padded phase-08.1-x is not octal"  "$(port_on phase-08.1-x)" 3008
is "a non-phase branch → the base"     "$(port_on main)" 3000
is "outside git → the base"            "$(cd "$WORK" && gsd-derive-port 3000)" 3000
fails "a non-numeric base is refused"  gsd-derive-port abc

section "gsd-start — refusals"
R="$WORK/shop"; project "$R"
fails "a bare description is refused (must say -n/-p/--insert)" bash -c 'cd "$1" && gsd-start "cart" --no-launch' _ "$R"
has   "…and the refusal lists the three choices" "gsd-start -n" "$WORK/out"
fails "-n and -p together are refused"  bash -c 'cd "$1" && gsd-start -n x -p 1 --no-launch' _ "$R"
fails "-p of a phase not in the roadmap" bash -c 'cd "$1" && gsd-start -p 9 --no-launch' _ "$R"
has   "…and says so"                    "phase 9 not found" "$WORK/out"
fails "re-claiming an existing title"   bash -c 'cd "$1" && gsd-start -n "Catalog" --no-launch' _ "$R"
# no gsd-core (the old GSD's gsd-sdk does not count) → refused, with the install.
# A bare PATH and an empty HOME, so no gsd-core of this machine is found.
mkdir -p "$WORK/oldgsd" "$WORK/oldhome"
printf '#!/bin/sh\necho 1.42.0\n' > "$WORK/oldgsd/gsd-sdk"; chmod +x "$WORK/oldgsd/gsd-sdk"
fails "no gsd-core, only the old gsd-sdk → a claim is refused" env -u GSD_CLI -u CLAUDE_CONFIG_DIR -u CODEX_HOME \
  HOME="$WORK/oldhome" PATH="$PKG/bin:$WORK/oldgsd:/usr/bin:/bin" bash -c 'cd "$1" && gsd-start -n "cart" --no-launch' _ "$R"
has   "…and says gsd-core is missing"   "GSD (gsd-core) not found" "$WORK/out"
has   "…with the install command"       "npx @opengsd/gsd-core@latest --claude --global" "$WORK/out"

section "gsd-start — claim, attach, insert, flow mode"
(cd "$R" && gsd-start -n "shopping cart" --no-launch) > "$WORK/out" 2>&1
is  "-n claims phase 2"          "$?" 0
has "…prints the flow launch (the default)" "gsdt-flow" "$WORK/out"
check_wt() { git -C "$R" worktree list | grep -q "phase-$1-"; }
if check_wt 2; then ok "…and creates the phase-2 worktree"; else bad "…and creates the phase-2 worktree"; fi
is  "…and pushes the claim"      "$(git --git-dir="$R.git" show main:.planning/ROADMAP.md | grep -c '^### Phase 2: shopping cart')" 1
(cd "$R" && gsd-start -p 2 --no-launch) > "$WORK/out" 2>&1
is  "-p re-attaches (idempotent)" "$?" 0
is  "…without a second worktree"  "$(git -C "$R" worktree list | grep -c 'phase-2-')" 1
(cd "$R" && gsd-start --insert 1 "price bug" --no-launch) > "$WORK/out" 2>&1
is  "--insert claims a padded decimal phase" "$?" 0
if check_wt 01.1; then ok "…on a phase-01.1 worktree (guard accepts it)"; else bad "…on a phase-01.1 worktree (guard accepts it)" "$(tail -3 "$WORK/out")"; fi
(cd "$R" && gsd-start -p 2 --flow --no-launch) > "$WORK/out" 2>&1
has "--flow prints the gsdt-flow launch" "gsdt-flow" "$WORK/out"

section "gsd-start — opens the session by default (in a terminal)"
# a fake agent CLI records that it was launched, and where
printf '#!/bin/sh\npwd > "%s/launched"\n' "$WORK" > "$WORK/stub/claude"; chmod +x "$WORK/stub/claude"
in_tty() {  # $1=a shell command, run with a terminal (BSD and util-linux `script` differ)
  if script --version 2>/dev/null | grep -q util-linux; then script -qec "$1" /dev/null
  else script -q /dev/null bash -c "$1"; fi
}
R="$WORK/launch"; project "$R"
rm -f "$WORK/launched"; in_tty "cd '$R' && gsd-start -p 1" > "$WORK/out" 2>&1 < /dev/null
case "$(cat "$WORK/launched" 2>/dev/null)" in */phase-1-*) ok "in a terminal the agent opens, in the worktree" ;; *) bad "in a terminal the agent opens, in the worktree" "$(tail -5 "$WORK/out")" ;; esac
rm -f "$WORK/launched"; in_tty "cd '$R' && gsd-start -p 1 --no-launch" > "$WORK/out" 2>&1 < /dev/null
if [ -e "$WORK/launched" ]; then bad "--no-launch only prints"; else ok "--no-launch only prints"; fi
has "…the command to run"               "Next:" "$WORK/out"
rm -f "$WORK/launched"; (cd "$R" && gsd-start -p 1) > "$WORK/out" 2>&1 < /dev/null
if [ -e "$WORK/launched" ]; then bad "with no terminal it only prints"; else ok "with no terminal it only prints"; fi
rm -f "$WORK/stub/claude"
(cd "$R" && gsd-start -p 1) > "$WORK/out" 2>&1
is  "no agent CLI installed → the default still succeeds (prints)" "$?" 0

section "gsd-start — TDD mode is the default"
tdd() { git -C "$R" show HEAD:.planning/config.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["workflow"].get("tdd_mode"))'; }
R="$WORK/tdd"; project "$R"
(cd "$R" && gsd-start -n "no config yet" --no-launch) > "$WORK/out" 2>&1
is  "no config.json (before /gsd-new-project) → claim still works" "$?" 0
if [ -f "$R/.planning/config.json" ]; then bad "…and makes no config.json"; else ok "…and makes no config.json"; fi
printf '{\n  "workflow": {\n    "research": true\n  }\n}\n' > "$R/.planning/config.json"; commit "$R" config; git -C "$R" push -q
(cd "$R" && gsd-start -n "first claim" --no-launch) > "$WORK/out" 2>&1
is  "tdd_mode unset → the claim commit turns it on" "$(tdd)" True
has "…and says so" "TDD mode on" "$WORK/out"
is  "…in the pushed claim" "$(git --git-dir="$R.git" show main:.planning/config.json | grep -c '"tdd_mode": true')" 1
printf '{\n  "workflow": {\n    "tdd_mode": false\n  }\n}\n' > "$R/.planning/config.json"; commit "$R" tdd-off; git -C "$R" push -q
(cd "$R" && gsd-start -n "after opting out" --no-launch) > "$WORK/out" 2>&1
is  "tdd_mode false (the project chose) → kept" "$(tdd)" False
printf '{\n  "workflow": {}\n}\n' > "$R/.planning/config.json"; commit "$R" tdd-unset; git -C "$R" push -q
(cd "$R" && gsd-start --insert 1 "hotfix" --no-launch) > "$WORK/out" 2>&1
is  "--insert turns it on too" "$(tdd)" True

section "gsd-wt-finish — a conflicting merge aborts cleanly"
R="$WORK/conflict"; project "$R"
printf 'base\n' > "$R/shared.txt"; commit "$R" base-file; git -C "$R" push -q
git -C "$R" worktree add -qb phase-1-catalog "$WORK/conflict-wt"
printf 'phase version\n' > "$WORK/conflict-wt/shared.txt"; commit "$WORK/conflict-wt" phase-edit
printf 'main version\n' > "$R/shared.txt"; commit "$R" main-edit; git -C "$R" push -q
before=$(git -C "$R" rev-parse HEAD)
fails "finish refuses"               bash -c 'cd "$1" && gsd-wt-finish 1' _ "$R"
has   "…naming the conflict"         "merge conflict" "$WORK/out"
is    "…main HEAD unchanged"         "$(git -C "$R" rev-parse HEAD)" "$before"
if [ -f "$R/.git/MERGE_HEAD" ]; then bad "…no merge left in progress"; else ok "…no merge left in progress"; fi
is    "…main working tree clean"     "$(git -C "$R" status --porcelain)" ""
if [ -d "$WORK/conflict-wt" ]; then ok "…worktree kept"; else bad "…worktree kept"; fi
is    "…origin untouched"            "$(git --git-dir="$R.git" rev-parse main)" "$before"

section "checkout lock — a crashed run's lock is reclaimed"
R="$WORK/lock"; project "$R"
mkdir "$R/.git/gsd-cmd.lock"; echo 999999 > "$R/.git/gsd-cmd.lock/pid"
(cd "$R" && gsd-wt-new --phase 1) > "$WORK/out" 2>&1
is  "the command still runs"      "$?" 0
has "…after reclaiming the lock"  "reclaimed stale gsd lock" "$WORK/out"
if [ -d "$R/.git/gsd-cmd.lock" ]; then bad "…and releases it at the end"; else ok "…and releases it at the end"; fi
out=$(bash -c '. "$1/lib/common.sh"; gsd_acquire_lock "$2" >/dev/null; kill -TERM $$; echo went-on' _ "$PKG" "$R" 2>/dev/null); rc=$?
is  "a TERM stops the command (exit 143)…" "$rc:$out" "143:"
if [ -d "$R/.git/gsd-cmd.lock" ]; then bad "…and releases the lock"; else ok "…and releases the lock"; fi

section "gsd-init — picks ingest when planning docs exist"
R="$WORK/docs"; mkdir -p "$R/docs"; git -C "$R" init -qb main
printf '# PRD\n' > "$R/docs/PRD-checkout.md"; commit "$R" docs
(cd "$R" && gsd-init --provider claude --no-launch) > "$WORK/out" 2>&1
has "a PRD → /gsd-ingest-docs" "gsd-ingest-docs" "$WORK/out"
R="$WORK/nodocs"; mkdir -p "$R"; git -C "$R" init -qb main; printf 'x\n' > "$R/a.txt"; commit "$R" code
(cd "$R" && gsd-init --provider claude --no-launch) > "$WORK/out" 2>&1
has "no docs → /gsd-new-project" "gsd-new-project" "$WORK/out"

section "gsd-init — asks where the tickets live"
R="$WORK/ask"; mkdir -p "$R"; git -C "$R" init -qb main; printf 'x\n' > "$R/a.txt"; commit "$R" code
printf '3\nscripts/t.sh\n' | (cd "$R" && GSD_TRACKER_ASK=always gsd-init --provider claude --no-launch) > "$WORK/out" 2>&1
is  "the answer lands in .gsd.conf"     "$(. "$PKG/lib/common.sh"; gsd_conf_get "$R" tracker)/$(. "$PKG/lib/common.sh"; gsd_conf_get "$R" tracker_command)" "custom/scripts/t.sh"
has "…and the next steps say what it needs" "write scripts/t.sh" "$WORK/out"
is  "…committed with the bootstrap"     "$(git -C "$R" status --porcelain -- .gsd.conf)" ""
: | (cd "$R" && GSD_TRACKER_ASK=always gsd-init --provider claude --no-launch) > "$WORK/out" 2>&1
if grep -q "Where do this project" "$WORK/out"; then bad "a set tracker is not asked again"; else ok "a set tracker is not asked again"; fi
R="$WORK/askflag"; mkdir -p "$R"; git -C "$R" init -qb main; printf 'x\n' > "$R/a.txt"; commit "$R" code
(cd "$R" && gsd-init --provider claude --tracker clickup --no-launch) > "$WORK/out" 2>&1
is  "--tracker clickup sets it, no question" "$(. "$PKG/lib/common.sh"; gsd_conf_get "$R" tracker)" clickup
fails "--tracker jira is refused"       bash -c 'cd "$1" && gsd-init --provider claude --tracker jira --no-launch' _ "$R"
fails "--tracker custom needs its script" bash -c 'cd "$1" && gsd-bootstrap-repo --agent claude --tracker custom' _ "$WORK/nodocs"
R="$WORK/noask"; mkdir -p "$R"; git -C "$R" init -qb main; printf 'x\n' > "$R/a.txt"; commit "$R" code
(cd "$R" && gsd-init --provider claude --no-launch) < /dev/null > "$WORK/out" 2>&1
is  "no terminal, no flag → no question, no tracker key" "$(grep -c 'Where do this project' "$WORK/out"):$(. "$PKG/lib/common.sh"; gsd_conf_get "$R" tracker)" "0:"
has "…and a hint how to set one"        "gsd-init --tracker clickup|custom" "$WORK/out"

section "gsd-init — opens the planning session, then checks the plan"
# a fake agent: records its argv; with PLAN=1 it writes a two-phase roadmap, as /gsd-new-project would
cat > "$WORK/stub/claude" <<STUB
#!/bin/sh
printf '%s\n' "\$*" > "$WORK/init-args"
[ "\${PLAN:-}" = 1 ] || exit 0
mkdir -p .planning; printf '# Roadmap\n\n### Phase 1: catalog\n\n### Phase 2: cart\n' > .planning/ROADMAP.md
STUB
chmod +x "$WORK/stub/claude"
R="$WORK/plan"; mkdir -p "$R"; git -C "$R" init -qb main; printf 'x\n' > "$R/a.txt"; commit "$R" code
in_tty "cd '$R' && PLAN=1 gsd-init --provider claude --tracker none" > "$WORK/out" 2>&1 < /dev/null
is  "in a terminal it runs the session, and the plan is there → exit 0" "$?" 0
has "…the session got /gsd-new-project" "gsd-new-project" "$WORK/init-args"
has "…it says the plan is ready"        "plan ready: 2 phase" "$WORK/out"
has "…and names the first phase"        "gsd-start -p 1" "$WORK/out"
R="$WORK/quit"; mkdir -p "$R"; git -C "$R" init -qb main; printf 'x\n' > "$R/a.txt"; commit "$R" code
in_tty "cd '$R' && gsd-init --provider claude --tracker none; echo rc=\$?" > "$WORK/out" 2>&1 < /dev/null
has "a session closed with no ROADMAP → exit 1" "rc=1" "$WORK/out"
has "…saying to run gsd-init again"      "Run gsd-init again" "$WORK/out"
rm -f "$WORK/init-args"
in_tty "cd '$R' && gsd-init --provider claude --tracker none --no-launch" > "$WORK/out" 2>&1 < /dev/null
if [ -e "$WORK/init-args" ]; then bad "--no-launch only prints"; else ok "--no-launch only prints"; fi
has "…the command"                      "Next:" "$WORK/out"
rm -f "$WORK/stub/claude"

section "gsd-finish --pr — push + open a PR, keep the worktree"
R="$WORK/pr"; project "$R"
git -C "$R" worktree add -qb phase-1-catalog "$WORK/pr-wt"
printf 'feature\n' > "$WORK/pr-wt/f.txt"; commit "$WORK/pr-wt" feature
: > "$GH_LOG"
(cd "$R" && gsd-finish 1 --pr) > "$WORK/out" 2>&1
is  "--pr succeeds"                   "$?" 0
if git --git-dir="$R.git" rev-parse -q --verify refs/heads/phase-1-catalog >/dev/null; then ok "…branch pushed"; else bad "…branch pushed" "$(tail -4 "$WORK/out")"; fi
has "…gh pr create, base main"        "pr create.*--base main" "$GH_LOG"
has "…head is the phase branch"       "--head phase-1-catalog" "$GH_LOG"
if [ -d "$WORK/pr-wt" ]; then ok "…worktree kept"; else bad "…worktree kept"; fi
is  "…nothing merged into main"       "$(git -C "$R" log --oneline main | grep -c feature)" 0

section "gsd-finish — flow = strict refuses a phase without the test audit"
R="$WORK/audit"; project "$R"
printf 'install = none\ntest = none\nflow = strict\n' > "$R/.gsd.conf"; commit "$R" strict; git -C "$R" push -q
git -C "$R" worktree add -qb phase-1-catalog "$WORK/audit-wt"
mkdir -p "$WORK/audit-wt/.planning/phases/01-catalog"
printf 'feature\n' > "$WORK/audit-wt/f.txt"; commit "$WORK/audit-wt" feature
before=$(git -C "$R" rev-parse HEAD)
fails "finish refuses without 01-VALIDATION.md" bash -c 'cd "$1" && gsd-wt-finish 1' _ "$R"
has   "…names the step"                "/gsd-validate-phase 1" "$WORK/out"
is    "…nothing merged"                "$(git -C "$R" rev-parse HEAD)" "$before"
fails "--pr refuses too"               bash -c 'cd "$1" && gsd-finish 1 --pr' _ "$R"
has   "…and opens no PR"               "no PR was opened" "$WORK/out"
printf -- '---\nnyquist_compliant: false\n---\n' > "$WORK/audit-wt/.planning/phases/01-catalog/01-VALIDATION.md"
commit "$WORK/audit-wt" draft
fails "the plan's draft does not count" bash -c 'cd "$1" && gsd-wt-finish 1' _ "$R"
(cd "$R" && GSD_SKIP_GUARD=1 gsd-finish 1 --pr) > "$WORK/out" 2>&1
is  "GSD_SKIP_GUARD=1 skips the gate (--pr opens the PR)" "$?" 0
git -C "$R" branch -q --unset-upstream phase-1-catalog   # the PR push tracked it; the merge path below expects none
printf -- '---\nnyquist_compliant: true\n---\n' > "$WORK/audit-wt/.planning/phases/01-catalog/01-VALIDATION.md"
commit "$WORK/audit-wt" audited
(cd "$R" && gsd-wt-finish 1) > "$WORK/out" 2>&1
is  "audited → finish lands"           "$?" 0
is  "…the feature is on main"          "$(git -C "$R" log --oneline main | grep -c feature)" 1

section "finish — the gates read the branch when its worktree is gone"
R="$WORK/gone"; project "$R"
printf 'install = none\ntest = none\nflow = strict\n' > "$R/.gsd.conf"; commit "$R" strict; git -C "$R" push -q
git -C "$R" worktree add -qb phase-1-catalog "$WORK/gone-wt"
mkdir -p "$WORK/gone-wt/.planning/phases/01-catalog"; : > "$WORK/gone-wt/.planning/phases/01-catalog/.gitkeep"
printf 'feature\n' > "$WORK/gone-wt/f.txt"; commit "$WORK/gone-wt" feature
git -C "$R" worktree remove "$WORK/gone-wt"
fails "--pr with no worktree still refuses a missing audit" bash -c 'cd "$1" && gsd-finish 1 --pr' _ "$R"
has   "…names the step"                 "/gsd-validate-phase 1" "$WORK/out"
fails "…and so does the merge path"     bash -c 'cd "$1" && gsd-wt-finish 1' _ "$R"
is    "…leaving no throwaway worktree"  "$(git -C "$R" worktree list | wc -l | tr -d ' ')" 1

section "finish — files the tests leave behind do not stop the cleanup"
R="$WORK/leftover"; project "$R"
printf 'install = none\ntest = mkdir -p cov && echo a > cov/out\n' > "$R/.gsd.conf"; commit "$R" tests; git -C "$R" push -q
(cd "$R" && gsd-wt-new --phase 1) >/dev/null 2>&1
wt=$(git -C "$R" worktree list --porcelain | awk '/^worktree /{w=substr($0,10)} /^branch refs\/heads\/phase-1-/{print w; exit}')
printf 'x\n' > "$wt/f.txt"; commit "$wt" feat
(cd "$R" && gsd-wt-finish 1) > "$WORK/out" 2>&1
is  "finish succeeds"                   "$?" 0
has "…saying what it removed"           "cov/" "$WORK/out"
if [ -d "$wt" ]; then bad "…worktree removed" "$(tail -3 "$WORK/out")"; else ok "…worktree removed"; fi
is  "…branch deleted"                   "$(git -C "$R" branch --list 'phase-1-*' | wc -l | tr -d ' ')" 0

section "finish — a gsd-batch worktree (batch-*)"
R="$WORK/batch"; project "$R"
# strict gates on: a batch has no phase folder, and must land anyway
printf 'install = none\ntest = none\nflow = strict\nui_gates = strict\n' > "$R/.gsd.conf"; commit "$R" strict; git -C "$R" push -q
BB=batch-2026-11-09-fix-labels; bw="$WORK/batch-worktrees/$BB"
fails "gsd-wt-new --batch refuses a name that is not batch-…" bash -c 'cd "$1" && gsd-wt-new --batch fix-labels' _ "$R"
(cd "$R" && gsd-wt-new --batch "$BB") > "$WORK/out" 2>&1
is  "gsd-wt-new --batch makes the worktree" "$?" 0
is  "…on its own branch, off main"   "$(git -C "$bw" branch --show-current):$(git -C "$R" merge-base main "$BB")" "$BB:$(git -C "$R" rev-parse main)"
is  "…no ROADMAP change"             "$(git -C "$R" status --porcelain | wc -l | tr -d ' ')" 0
is  "…and a clean worktree"          "$(git -C "$bw" status --porcelain | wc -l | tr -d ' ')" 0
(cd "$R" && gsd-wt-new --batch "$BB") > "$WORK/out" 2>&1
has "…reused when run again"          "already has a worktree" "$WORK/out"
printf 'label\n' > "$bw/f.txt"; commit "$bw" "fix: labels"
: > "$GH_LOG"
(cd "$bw" && gsd-finish --pr) > "$WORK/out" 2>&1
is  "--pr from inside the batch worktree" "$?" 0
has "…head is the batch branch"       "--head $BB" "$GH_LOG"
if [ -d "$bw" ]; then ok "…worktree kept"; else bad "…worktree kept"; fi
is  "…nothing merged into main"       "$(git -C "$R" log --oneline main | grep -c 'fix: labels')" 0
git -C "$R" branch -q --unset-upstream "$BB"
(cd "$bw" && gsd-finish) > "$WORK/out" 2>&1
is  "gsd-finish with no argument lands it" "$?" 0
is  "…the fix is on main"             "$(git -C "$R" log --oneline main | grep -c 'fix: labels')" 1
is  "…and pushed"                     "$(git --git-dir="$R.git" log --oneline main | grep -c 'fix: labels')" 1
if [ -d "$bw" ]; then bad "…worktree removed" "$(tail -3 "$WORK/out")"; else ok "…worktree removed"; fi
is  "…branch deleted"                 "$(git -C "$R" branch --list "$BB" | wc -l | tr -d ' ')" 0
printf 'install = none\ntest = false\n' > "$R/.gsd.conf"; commit "$R" failing; git -C "$R" push -q
(cd "$R" && gsd-wt-new --batch "$BB-2") >/dev/null 2>&1
printf 'y\n' > "$bw-2/g.txt"; commit "$bw-2" "fix: other"
before=$(git -C "$R" rev-parse main)
fails "failing tests stop a batch finish" bash -c 'cd "$1" && gsd-finish "$2"' _ "$R" "$BB-2"
has   "…naming the batch worktree"    "removing the batch worktree" "$WORK/out"
is    "…nothing merged"               "$(git -C "$R" rev-parse main)" "$before"
if [ -d "$bw-2" ]; then ok "…worktree kept"; else bad "…worktree kept"; fi

section "phase branches — a slug ending in -pr, a worktree deleted by hand"
R="$WORK/slugpr"; project "$R"
printf '# Roadmap\n\n### Phase 1: improve PR\n' > "$R/.planning/ROADMAP.md"; commit "$R" title; git -C "$R" push -q
(cd "$R" && gsd-wt-new --phase 1) >/dev/null 2>&1
wt="$WORK/slugpr-worktrees/phase-1-improve-pr"
is  "a phase titled 'improve PR' gets phase-1-improve-pr" "$([ -d "$wt" ] && echo yes)" yes
rm -rf "$wt"
(cd "$R" && gsd-wt-new --phase 1) > "$WORK/out" 2>&1
is  "a deleted worktree folder is re-created" "$?:$([ -d "$wt" ] && echo yes)" "0:yes"
printf 'x\n' > "$wt/f.txt"; commit "$wt" feat
(cd "$R" && gsd-wt-finish 1) > "$WORK/out" 2>&1
is  "…and the -pr phase finishes"       "$?" 0
git -C "$R" branch -q phase-2-thing; git -C "$R" branch -q phase-2-thing-pr
is  "a real /gsd-pr-branch helper is still skipped" "$(. "$PKG/lib/common.sh"; gsd_phase_branch "$R" 2)" phase-2-thing
fails "…and finishing it by name is refused" bash -c 'cd "$1" && gsd-wt-finish phase-2-thing-pr' _ "$R"

section "origin without the base branch, gsd-start -p after another machine's claim"
R="$WORK/noorigin"; git init -q --bare -b main "$R.git"; mkdir -p "$R/.planning/phases"; git -C "$R" init -qb main
printf '# Roadmap\n\n### Phase 1: catalog\n' > "$R/.planning/ROADMAP.md"; printf 'install = none\ntest = none\n' > "$R/.gsd.conf"
commit "$R" init; git -C "$R" remote add origin "$R.git"
fails "gsd-start on an empty origin refuses" bash -c 'cd "$1" && gsd-start -n "next" --no-launch' _ "$R"
has   "…saying to push the base branch" "origin has no 'main' branch" "$WORK/out"
(cd "$R" && gsd-wt-new --phase 1) >/dev/null 2>&1
fails "gsd-wt-finish on an empty origin refuses" bash -c 'cd "$1" && gsd-wt-finish 1' _ "$R"
has   "…with the same hint"             "origin has no 'main' branch" "$WORK/out"
R="$WORK/attach"; project "$R"; git clone -q "$R.git" "$WORK/attach-other"
printf '\n### Phase 2: other\n' >> "$WORK/attach-other/.planning/ROADMAP.md"; commit "$WORK/attach-other" claim2; git -C "$WORK/attach-other" push -q
(cd "$R" && gsd-start -p 2 --no-launch) > "$WORK/out" 2>&1
is  "gsd-start -p sees a phase claimed elsewhere" "$?" 0

section "worktree.baseRef = head — a wave's plans can run in parallel"
# gsd-core's base-check reads it from the PHASE worktree's .claude/ (or the
# user's ~/.claude) — an empty HOME, so this machine's settings do not count.
bh() { env -u CLAUDE_CONFIG_DIR HOME="$WORK/brhome" "$@"; }
baseref() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("worktree",{}).get("baseRef"))' "$1/.claude/settings.local.json" 2>/dev/null; }
R="$WORK/baseref"; project "$R"
printf '.claude/settings.local.json\n' > "$R/.gitignore"; commit "$R" ignore; git -C "$R" push -q
mkdir -p "$R/.claude"; printf '{"permissions":{"allow":["Bash(ls)"]}}\n' > "$R/.claude/settings.local.json"
(cd "$R" && bh gsd-start -n "cart" --no-launch) > "$WORK/out" 2>&1
wt=$(git -C "$R" worktree list --porcelain | sed -n 's/^worktree \(.*phase-2-.*\)/\1/p')
is  "gsd-start: the new worktree has worktree.baseRef = head" "$(baseref "$wt")" head
is  "…keeping the copied permissions" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["permissions"]["allow"][0])' "$wt/.claude/settings.local.json")" "Bash(ls)"
is  "…the main checkout's copy is untouched" "$(baseref "$R")" None
is  "…and the worktree stays clean" "$(git -C "$wt" status --porcelain)" ""
rm "$wt/.claude/settings.local.json"
(cd "$R" && bh gsd-start -p 2 --no-launch) > "$WORK/out" 2>&1
is  "gsd-start -p adds it to a reused worktree without it" "$(baseref "$wt")" head
printf '{"worktree":{"baseRef":"origin"}}\n' > "$wt/.claude/settings.local.json"
(cd "$R" && bh gsd-start -p 2 --no-launch) > "$WORK/out" 2>&1
is  "another value is the user's: kept" "$(baseref "$wt")" origin
has "…and said" 'keeps worktree.baseRef = "origin"' "$WORK/out"
R="$WORK/baseref-noignore"; project "$R"
(cd "$R" && bh gsd-wt-new --phase 1) > "$WORK/out" 2>&1
wt="$WORK/baseref-noignore-worktrees/phase-1-catalog"
is  "no .gitignore line: still set (the repo's exclude list covers it)" "$(baseref "$wt")" head
is  "…and the worktree stays clean" "$(git -C "$wt" status --porcelain)" ""
R="$WORK/baseref-tracked"; project "$R"
mkdir -p "$R/.claude"; printf '{}\n' > "$R/.claude/settings.local.json"; git -C "$R" add -f .claude/settings.local.json; commit "$R" tracked; git -C "$R" push -q
(cd "$R" && bh gsd-wt-new --phase 1) > "$WORK/out" 2>&1
wt="$WORK/baseref-tracked-worktrees/phase-1-catalog"
is  "a TRACKED settings.local.json is not changed" "$(git -C "$wt" status --porcelain)" ""
has "…and said" "is tracked by git" "$WORK/out"

section "lint — bash 3.2 traps"
# macOS bash 3.2 in a UTF-8 locale reads "$VAR…" as a variable named VAR plus
# the first byte of "…" → "unbound variable" under set -u. Worse, with the lock's
# EXIT trap installed the script then exits 0, so the crash looks like success.
# Always brace a variable that touches a non-ASCII character: ${VAR}…
risky=$(cd "$PKG" && LC_ALL=C grep -nE '\$[A-Za-z_][A-Za-z0-9_]*[^ -~[:space:]]' \
          bin/* lib/*.sh lib/tracker/*.sh install.sh tools/*.sh shims/scripts/*.sh shims/scripts/hooks/*.sh || true)
is "no \$VAR directly followed by a non-ASCII character" "$risky" ""

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
