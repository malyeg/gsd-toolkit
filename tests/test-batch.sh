#!/usr/bin/env bash
# test-batch.sh — gsd-batch-report: token counts per batch from Claude Code
# transcripts. Fixture transcripts are generated into a throwaway folder: a
# /gsd-quick-batch run with prompts typed mid-run, duplicate message ids,
# a helper with no meta file, a nested helper, an unrelated helper; a second
# batch in the same session; a /gsdt-batch run with its pause for the OK and
# its done line; a session with no batch.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; PKG="$(cd "$HERE/.." && pwd)"
BR="$PKG/bin/gsd-batch-report"
PASS=0; FAIL=0; WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
ok()  { PASS=$((PASS + 1)); printf '  ✔ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✘ %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3', got '$2'"; fi; }
has() { if grep -q -- "$2" "$3"; then ok "$1"; else bad "$1" "no '$2' in: $(cat "$3")"; fi; }
hasnt() { if grep -q -- "$2" "$3"; then bad "$1" "'$2' found in: $(cat "$3")"; else ok "$1"; fi; }
section() { printf '\n%s\n' "$1"; }

export TZ=UTC
unset CLAUDE_CONFIG_DIR
P="$WORK/proj"; mkdir -p "$P"

# ---------------------------------------------------------------- fixtures
cat > "$WORK/gen.py" <<'PY'
import json, os, sys, time
P = sys.argv[1]
NOW = time.time()
SECRET = "SECRET-TEXT-42"

def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))

def u(fresh, cw, cr, out, cw1h=0):
    d = {"input_tokens": fresh, "cache_creation_input_tokens": cw,
         "cache_read_input_tokens": cr, "output_tokens": out}
    if cw1h:
        d["cache_creation"] = {"ephemeral_1h_input_tokens": cw1h, "ephemeral_5m_input_tokens": cw - cw1h}
    return d

class F:
    def __init__(self, base):
        self.lines, self.base = [], base
    def at(self, m):
        return iso(self.base + 60 * m)
    def asst(self, m, mid, usage, tools=(), text=None, model="claude-opus-5-5"):
        c = []
        if text: c.append({"type": "text", "text": text})
        for name, tid, inp in tools:
            c.append({"type": "tool_use", "id": tid, "name": name, "input": inp})
        msg = {"id": mid, "role": "assistant", "content": c, "usage": usage}
        if model: msg["model"] = model
        self.lines.append({"type": "assistant", "isSidechain": False, "timestamp": self.at(m), "message": msg})
    def human(self, m, text):
        self.lines.append({"type": "user", "isSidechain": False, "timestamp": self.at(m),
                           "origin": {"kind": "human"}, "message": {"role": "user", "content": text}})
    def cmd(self, m, name, args=""):
        self.lines.append({"type": "user", "isSidechain": False, "timestamp": self.at(m), "message": {"role": "user",
            "content": "<command-name>/%s</command-name>\n<command-args>%s</command-args>" % (name, args)}})
    def result(self, m, tid, agent=None, status="async_launched"):
        r = {"status": status}
        if agent: r["agentId"] = agent
        self.lines.append({"type": "user", "isSidechain": False, "timestamp": self.at(m), "toolUseResult": r,
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "content": "x"}]}})
    def note(self, m, tid):
        self.lines.append({"type": "user", "isSidechain": False, "timestamp": self.at(m),
            "origin": {"kind": "task-notification"},
            "message": {"role": "user", "content": "<task-notification><tool-use-id>%s</tool-use-id></task-notification>" % tid}})
    def junk(self):
        self.lines.append({"type": "attachment"})
    def write(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            for o in self.lines:
                fh.write(json.dumps(o) + "\n")
            fh.write("{not json\n")

def agent(session, aid, meta, f):
    d = os.path.join(P, session, "subagents")
    f.write(os.path.join(d, "agent-%s.jsonl" % aid))
    if meta is not None:
        with open(os.path.join(d, "agent-%s.meta.json" % aid), "w") as fh:
            json.dump(meta, fh)

def spawn(tid, atype, desc, model=None):
    inp = {"subagent_type": atype, "description": desc, "prompt": SECRET}
    if model: inp["model"] = model
    return ("Agent", tid, inp)

# Session A — two /gsd-quick-batch runs, 2 days ago.
A = "aaaa1111-0000-4000-8000-000000000001"
a = F(NOW - 2 * 86400)
a.human(0, "earlier work " + SECRET)
a.asst(1, "m_pre", u(1, 1, 1, 1))
a.asst(2, "m_c1", u(10, 100, 1000, 5), text="thinking")               # line before the start …
a.asst(2, "m_c1", u(10, 100, 1000, 5), tools=[("Skill", "tsk1", {"skill": "gsd-core:gsd-quick-batch", "args": SECRET})])
a.result(2, "tsk1", status="ok")
a.asst(3, "m_c2", u(2, 200, 2000, 10), tools=[spawn("toolu_p1", "gsd-planner", "Plan 261109-aa1: one"),
                                              spawn("toolu_p2", "gsd-planner", "Plan 261109-aa2: two")])
a.result(3, "toolu_p1", "ap1"); a.result(3, "toolu_p2", "ap2")
a.asst(10, "m_c3", u(3, 300, 3000, 15), tools=[spawn("toolu_e1", "gsd-executor", "Execute 261109-aa1: one"),
                                               spawn("toolu_e2", "gsd-executor", "Execute 261109-aa2: two")])
a.result(10, "toolu_e1", "ae1"); a.result(10, "toolu_e2", "ae2")
a.junk()
a.human(12, "how is it going? " + SECRET)                               # ae2 still working → not the end
a.asst(13, "m_c4", u(4, 400, 4000, 20), tools=[("Bash", "tb_c", {"command": "x"})])
a.human(14, "/compact")
a.cmd(14, "compact")
a.note(20, "toolu_e2")
a.asst(21, "m_c5", u(5, 0, 500, 25))
a.human(22, "thanks")                                                   # settled → the end
a.asst(23, "m_post", u(1000, 1000, 1000, 1000))
a.cmd(30, "gsd-quick-batch", SECRET)                                    # batch 2, typed
a.asst(31, "m_b2", u(7, 70, 700, 7), tools=[spawn("toolu_p3", "gsd-planner", "Plan 261109-bb1: three")])
a.result(40, "toolu_p3", "ap3", status="completed")
a.asst(41, "m_b2end", u(1, 10, 100, 1))
a.write(os.path.join(P, A + ".jsonl"))

p1 = F(NOW - 2 * 86400)
p1.asst(4, "m_p1a", u(1, 10, 100, 1), tools=[("Bash", "tb1", {"command": SECRET})])
p1.asst(4, "m_p1a", u(1, 10, 100, 1), tools=[("Bash", "tb2", {"command": "y"})])   # same id: usage once
p1.asst(5, "m_p1b", u(1, 10, 100, 1), tools=[("Bash", "tb2", {"command": "y"}),     # same tool id: once
                                            spawn("toolu_n1", "Explore", "look")])
agent(A, "ap1", {"agentType": "gsd-planner", "model": "opus", "toolUseId": "toolu_p1",
                 "description": "Plan 261109-aa1: one"}, p1)
n1 = F(NOW - 2 * 86400)
n1.asst(5, "m_n1", u(1, 1, 1, 1), tools=[("Bash", "tb3", {})], model="claude-haiku-5-5")
agent(A, "an1", {"agentType": "Explore", "model": "haiku", "toolUseId": "toolu_n1"}, n1)
p2 = F(NOW - 2 * 86400)
p2.asst(6, "m_p2", u(2, 20, 200, 2), model=None)                       # no model → the meta's
agent(A, "ap2", {"agentType": "gsd-planner", "model": "opus", "toolUseId": "toolu_p2"}, p2)
e1 = F(NOW - 2 * 86400)
e1.asst(15, "m_e1", u(3, 30, 300, 3, cw1h=30), model="claude-sonnet-5-5")
agent(A, "ae1", {"agentType": "gsd-executor", "model": "sonnet", "toolUseId": "toolu_e1"}, e1)
e2 = F(NOW - 2 * 86400)
e2.asst(20, "m_e2", u(4, 40, 400, 4), model="claude-sonnet-5-5")
agent(A, "ae2", None, e2)                                               # no meta: linked by the result
x1 = F(NOW - 2 * 86400)
x1.asst(1, "m_x1", u(999, 999, 999, 999))
agent(A, "ax1", {"agentType": "general-purpose<b>" + SECRET, "model": "sonnet", "toolUseId": "toolu_other"}, x1)
p3 = F(NOW - 2 * 86400)
p3.asst(35, "m_p3", u(5, 50, 500, 5))
agent(A, "ap3", {"agentType": "gsd-planner", "model": "opus", "toolUseId": "toolu_p3"}, p3)

# Session C — a /gsdt-batch run, 1 hour ago.
C = "cccc3333-0000-4000-8000-000000000003"
c = F(NOW - 3600)
c.cmd(0, "gsdt-batch", SECRET)
c.asst(1, "m_g1", u(1, 10, 100, 1), tools=[spawn("toolu_s1", "general-purpose", "Scout batch items", "sonnet")],
       model="claude-sonnet-5-5")
c.result(5, "toolu_s1", "as1", status="completed")
c.asst(6, "m_g2", u(1, 10, 100, 1), text="sorted list", model="claude-sonnet-5-5")
c.human(10, "ok")                                                       # the pause for the OK
c.asst(11, "m_g3", u(1, 10, 100, 1), tools=[("Skill", "tsk2", {"skill": "gsd-quick-batch"})], model="claude-sonnet-5-5")
c.asst(12, "m_g4", u(1, 10, 100, 1), tools=[spawn("toolu_g1", "gsd-planner", "Plan 261109-cc1: a"),
                                            spawn("toolu_g2", "gsd-planner", "Plan 261109-cc2: b")],
       model="claude-sonnet-5-5")
c.result(13, "toolu_g1", "ag1", status="completed"); c.result(13, "toolu_g2", "ag2", status="completed")
c.human(14, "unrelated question while it runs")                        # a planned item has no executor yet
c.asst(15, "m_g5", u(1, 10, 100, 1), text="gsdt-batch: done items=3 real=2 tiny=1", model="claude-sonnet-5-5")
c.human(16, "next thing")
c.asst(17, "m_after", u(500, 500, 500, 500), model="claude-sonnet-5-5")
c.write(os.path.join(P, C + ".jsonl"))
s1 = F(NOW - 3600)
s1.asst(2, "m_s1", u(1, 1, 1, 1), model="claude-sonnet-5-5")
agent(C, "as1", {"agentType": "general-purpose", "model": "sonnet", "toolUseId": "toolu_s1"}, s1)
for aid, tid in (("ag1", "toolu_g1"), ("ag2", "toolu_g2")):
    g = F(NOW - 3600)
    g.asst(12, "m_" + aid, u(1, 1, 1, 1))
    agent(C, aid, {"agentType": "gsd-planner", "model": "opus", "toolUseId": tid}, g)

# Session B — no batch.
b = F(NOW - 7200)
b.human(0, "hello"); b.asst(1, "m_b", u(5, 5, 5, 5))
b.write(os.path.join(P, "bbbb2222-0000-4000-8000-000000000002.jsonl"))
PY
python3 "$WORK/gen.py" "$P" || { echo "fixture generator failed"; exit 1; }

# jq-free JSON reads: j <file> <python expression on d>
j() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$1" "$2"; }
role() { printf 'next(r for r in d["batches"][%s]["roles"] if r["role"]=="%s" and r["model"]=="%s")' "$1" "$2" "$3"; }

section "help and usage"
"$BR" --help > "$WORK/out" 2>&1; is "--help exits 0" "$?" 0
has "--help explains --baseline" "--baseline" "$WORK/out"
"$BR" --last x --dir "$P" > /dev/null 2>&1; is "--last x → 64" "$?" 64
"$BR" --last 1 --days 2 --dir "$P" > /dev/null 2>&1; is "--last with --days → 64" "$?" 64
"$BR" --session 'a;b' --dir "$P" > /dev/null 2>&1; is "a bad --session → 64" "$?" 64
"$BR" --bogus > /dev/null 2>&1; is "unknown option → 64" "$?" 64
"$BR" --baseline "$WORK/nope.json" --dir "$P" > /dev/null 2>&1; is "missing --baseline file → 64" "$?" 64

section "providers"
"$BR" --provider codex > "$WORK/out" 2>&1; is "codex → exit 0" "$?" 0
has "…says not supported yet" "not supported yet for codex" "$WORK/out"
"$BR" --provider gemini > "$WORK/out" 2>&1; is "gemini → 64" "$?" 64
has "…with the reason" "no longer supported" "$WORK/out"
"$BR" --provider nope > /dev/null 2>&1; is "unknown provider → 64" "$?" 64

section "finding batches"
"$BR" --dir "$P" --last 9 --json > "$WORK/all.json"; is "--json exits 0" "$?" 0
is "3 batches (the session without one is skipped)" "$(j "$WORK/all.json" 'len(d["batches"])')" 3
is "…in time order" "$(j "$WORK/all.json" '[b["skill"] for b in d["batches"]]')" "['gsd-quick-batch', 'gsd-quick-batch', 'gsdt-batch']"
is "batch 1 ends at the first prompt once settled" "$(j "$WORK/all.json" 'd["batches"][0]["ended_by"]')" "your next prompt"
is "batch 2 (typed) runs to the end of the session" "$(j "$WORK/all.json" 'd["batches"][1]["ended_by"]')" "end of session"
is "gsdt-batch ends at its done line" "$(j "$WORK/all.json" 'd["batches"][2]["ended_by"]')" "done line"
"$BR" --dir "$P" > "$WORK/out"
has "default = the last batch" "1 batch · 3 items" "$WORK/out"
"$BR" --dir "$P" --days 1 --json > "$WORK/d.json"
is "--days 1 → only the recent batch" "$(j "$WORK/d.json" '[b["skill"] for b in d["batches"]]')" "['gsdt-batch']"
"$BR" --dir "$P" --session aaaa1111 --json > "$WORK/s.json"
is "--session <prefix> → that session's batches" "$(j "$WORK/s.json" 'len(d["batches"])')" 2

section "counting — batch 1"
F="$WORK/all.json"
is "coordinator: turns once per message id, only inside the window" "$(j "$F" "$(role 0 coordinator opus)['turns']")" 5
is "coordinator fresh input" "$(j "$F" "$(role 0 coordinator opus)['fresh_input']")" 24
is "coordinator cache write" "$(j "$F" "$(role 0 coordinator opus)['cache_write']")" 1000
is "coordinator cache read" "$(j "$F" "$(role 0 coordinator opus)['cache_read']")" 10500
is "coordinator output" "$(j "$F" "$(role 0 coordinator opus)['output']")" 75
is "planners: 2 agents (one from its meta model)" "$(j "$F" "$(role 0 gsd-planner opus)['agents']")" 2
is "planners: duplicate message id counted once" "$(j "$F" "$(role 0 gsd-planner opus)['turns']")" 3
is "planners: Bash calls once per tool id" "$(j "$F" "$(role 0 gsd-planner opus)['bash']")" 2
is "planners: input" "$(j "$F" "$(role 0 gsd-planner opus)['input']")" 444
is "nested helper counted (Explore · haiku)" "$(j "$F" "$(role 0 Explore haiku)['agents']")" 1
is "executors: 2 (one with no meta file)" "$(j "$F" "$(role 0 gsd-executor sonnet)['agents']")" 2
is "executors: 1h cache write kept apart" "$(j "$F" "$(role 0 gsd-executor sonnet)['cache_write_1h']")" 30
is "executors: weighted input (7 + 40×1.25 + 30×2 + 700×0.1)" "$(j "$F" "$(role 0 gsd-executor sonnet)['weighted_input']")" 187
is "an unrelated helper is not counted" "$(j "$F" 'sorted(r["role"] for r in d["batches"][0]["roles"])')" "['Explore', 'coordinator', 'gsd-executor', 'gsd-planner']"
is "items = the quick ids" "$(j "$F" 'd["batches"][0]["items"]')" 2
is "per-item input" "$(j "$F" "$(role 0 gsd-planner opus)['per_item']['input']")" 222

section "counting — batch 2 and gsdt-batch"
is "batch 2: its coordinator only" "$(j "$F" "$(role 1 coordinator opus)['turns']")" 2
is "batch 2: a helper with a sync result" "$(j "$F" "$(role 1 gsd-planner opus)['input']")" 555
is "batch 2: 1 item (from the planner's quick id)" "$(j "$F" 'd["batches"][1]["items"]')" 1
is "gsdt-batch: the pause and the nested quick-batch stay in" "$(j "$F" "$(role 2 coordinator sonnet)['turns']")" 5
is "gsdt-batch: the scout counted" "$(j "$F" "$(role 2 general-purpose sonnet)['agents']")" 1
is "gsdt-batch: items from the done line" "$(j "$F" 'd["batches"][2]["items"], d["batches"][2]["items_from"], d["batches"][2]["real"], d["batches"][2]["tiny"]')" "(3, 'done line', 2, 1)"
is "combined: items add up" "$(j "$F" 'd["combined"]["items"]')" 6

section "text report"
"$BR" --dir "$P" --last 9 > "$WORK/out"; is "exit 0" "$?" 0
has "role table" "gsd-planner · opus" "$WORK/out"
has "input split" "CACHE RD" "$WORK/out"
has "per-item table vs the baseline" "BASE IN" "$WORK/out"
has "baseline named" "the week before 2026-11-09" "$WORK/out"
has "an unknown role is marked new" "Explore · haiku .* new" "$WORK/out"
"$BR" --dir "$P" --last 9 --items 4 > "$WORK/out4"
has "--items overrides the count" "· 4 items" "$WORK/out4"
"$BR" --dir "$P" --last 9 --json > "$WORK/base.json"
"$BR" --dir "$P" --baseline "$WORK/base.json" > "$WORK/out"
has "--baseline: a saved report" "from a saved report" "$WORK/out"
cat "$WORK/all.json" "$WORK/out" > "$WORK/everything"
hasnt "transcript text never printed" "SECRET-TEXT-42" "$WORK/everything"
hasnt "an odd agentType is not printed" "<b>" "$WORK/everything"

section "nothing to report"
mkdir -p "$WORK/empty"; cp "$P/bbbb2222-0000-4000-8000-000000000002.jsonl" "$WORK/empty/"
"$BR" --dir "$WORK/empty" > "$WORK/out"; is "no batch → exit 0" "$?" 0
has "…and says so" "no /gsd-quick-batch or /gsdt-batch run found" "$WORK/out"
"$BR" --dir "$WORK/empty" --json > "$WORK/e.json"
is "--json: an empty list" "$(j "$WORK/e.json" 'd["batches"]')" "[]"
"$BR" --dir "$WORK/nowhere" > "$WORK/out"; is "missing folder → exit 0" "$?" 0
has "…and says where it looked" "looked in $WORK/nowhere" "$WORK/out"

section "finding the transcripts of a repo"
R="$WORK/my repo.x"; mkdir -p "$R"; git -C "$R" init -q
H="$WORK/claudehome"; RP=$(cd "$R" && pwd)
name=$(printf '%s' "$RP" | LC_ALL=C sed 's/[^A-Za-z0-9]/-/g')
mkdir -p "$H/projects"; ln -s "$P" "$H/projects/$name"
(cd "$R" && CLAUDE_CONFIG_DIR="$H" "$BR" --last 9 --json) > "$WORK/r.json"
is "from inside the repo, CLAUDE_CONFIG_DIR honored" "$(j "$WORK/r.json" 'len(d["batches"])')" 3
CLAUDE_CONFIG_DIR="$H" "$BR" --repo "$R" --last 9 --json > "$WORK/r.json"
is "--repo <path>" "$(j "$WORK/r.json" 'len(d["batches"])')" 3
long="/$(printf 'x%.0s' $(seq 1 230))"
lname=$(printf '%s' "$long" | sed 's/[^A-Za-z0-9]/-/g'); mkdir -p "$H/projects/${lname:0:200}-abc123"
is "a long path: cut at 200 + hash suffix" "$(python3 "$PKG/lib/gsd_batch_report.py" projdir --home "$H" --repo "$long")" "$H/projects/${lname:0:200}-abc123"

section "gsd-batch — the launcher"
GB="$PKG/bin/gsd-batch"
cd "$WORK" || exit 1   # never run from inside this repo: a slip would make a batch worktree here
D=$(date +%Y-%m-%d)
L="$WORK/launch"; mkdir -p "$L/.planning"; git -C "$L" init -q -b main
git -C "$L" config user.email t@t; git -C "$L" config user.name t
printf '# Roadmap\n\n### Phase 1: catalog\n' > "$L/.planning/ROADMAP.md"
printf 'brief\n' > "$L/brief.md"; printf 'install = none\ntest = none\n' > "$L/.gsd.conf"
git -C "$L" add -A; git -C "$L" commit -qm init
printf 'notes\n' > "$L/a.md"   # not committed
LP=$(cd "$L" && pwd -P); LW="$(dirname "$LP")/launch-worktrees"
"$GB" --help > "$WORK/out" 2>&1; is "--help exits 0" "$?" 0
"$GB" --repo "$L" --print > /dev/null 2>&1; is "no task list → 64" "$?" 64
"$GB" --repo "$WORK/nope" --print x > /dev/null 2>&1; is "not a repo → 64" "$?" 64
"$GB" --repo "$L" --print "- fix a
- fix b" --validate > "$WORK/out" 2> "$WORK/err"
is "claude: a fresh Sonnet session in the batch worktree, flags before the list" "$(cat "$WORK/out")" \
  "cd $(printf '%q' "$LW/batch-$D-fix-a") && claude --model sonnet $'/gsdt-batch --validate\\n- fix a\\n- fix b'"
has "--print says which worktree it would make" "would make worktree .*batch-$D-fix-a (branch 'batch-$D-fix-a' off main)" "$WORK/err"
is "--print makes nothing" "$(git -C "$L" branch --list 'batch-*' | wc -l | tr -d ' ')" 0
(cd "$L" && "$GB" --print --model opus --file a.md) > "$WORK/out" 2>&1
has "claude: --model wins" "claude --model opus /gsdt-batch.*--file.*a.md" "$WORK/out"
has "--file: the name of the file is the slug" "batch-$D-a " "$WORK/out"
has "--file not committed: read from the main checkout, by absolute path" "file.*$LP/a.md" "$WORK/out"
(cd "$L" && "$GB" --print --file brief.md) > "$WORK/out" 2>/dev/null
has "--file committed: the worktree's own copy" "file.*$LW/batch-$D-brief/brief.md" "$WORK/out"
(cd "$L" && "$GB" --print --file nope.md) > "$WORK/out" 2>&1; is "--file missing → 64" "$?" 64
(cd "$L" && "$GB" --print --model default --file a.md) > "$WORK/out" 2>&1
hasnt "claude: --model default → the CLI's own" "--model" "$WORK/out"
(cd "$L" && "$GB" --print --provider codex --file a.md) > "$WORK/out" 2> "$WORK/err"
has "codex: launched with the skill named" "codex Use.*gsdt-batch.*skill" "$WORK/out"
hasnt "codex: no --model sonnet" "sonnet" "$WORK/out"
has "codex: says the switch is Claude-only" "Claude-only" "$WORK/err"
"$GB" --repo "$L" --print --provider custom --agent-command myagent x > "$WORK/out" 2>/dev/null
has "custom: its own executable" "myagent Run" "$WORK/out"
"$GB" --repo "$L" --print "Read plan/FIX-BRIEF-7.md. Fix only the real ones." > "$WORK/out" 2>&1
has "a brief is passed on as typed" "/gsdt-batch.*Read.*FIX-BRIEF-7.md..*Fix.*only.*the.*real.*ones." "$WORK/out"
has "…its first words name the batch" "batch-$D-read-plan-fix-brief-7" "$WORK/out"
"$GB" --repo "$L" --print --provider gemini x > "$WORK/out" 2>&1; is "gemini → 64" "$?" 64
has "…with the reason" "no longer supported" "$WORK/out"

section "gsd-batch — its own batch-* worktree"
BW="$LW/batch-$D-fix-a"
"$GB" --repo "$L" "- fix a" < /dev/null > "$WORK/out" 2> "$WORK/err"; is "no terminal → worktree made, command printed, exit 0" "$?" 0
is "…the command opens the session in the worktree" "$(cut -d' ' -f1-2 "$WORK/out")" "cd $(printf '%q' "$BW")"
is "…on its own branch, off main" "$(git -C "$BW" branch --show-current):$(git -C "$L" merge-base main "batch-$D-fix-a")" "batch-$D-fix-a:$(git -C "$L" rev-parse main)"
has "…with worktree.baseRef = head (quick-batch runs items in parallel)" '"baseRef": "head"' "$BW/.claude/settings.local.json"
is "…a clean worktree" "$(git -C "$BW" status --porcelain | wc -l | tr -d ' ')" 0
is "…the main checkout stays on main" "$(git -C "$L" branch --show-current)" main
"$GB" --repo "$L" "- fix a" < /dev/null > "$WORK/out" 2>/dev/null
has "a taken name gets -2 (a new batch never reuses another's worktree)" "batch-$D-fix-a-2 " "$WORK/out"
"$GB" --repo "$L" --name fix-a "- other" < /dev/null > "$WORK/out" 2> "$WORK/err"
has "--name: that worktree is reused" "already has a worktree" "$WORK/err"
is "…no -3" "$(git -C "$L" branch --list "batch-$D-fix-a-3" | wc -l | tr -d ' ')" 0
(cd "$BW" && "$GB" --print --resume) > "$WORK/out" 2> "$WORK/err"
is "from inside a batch worktree: the session runs there" "$(cut -d' ' -f1-2 "$WORK/out")" "cd $(printf '%q' "$BW")"
has "…and makes nothing" "would use worktree" "$WORK/err"
U="$WORK/unplanned"; mkdir -p "$U"; git -C "$U" init -q -b main; git -C "$U" commit -qm i --allow-empty
mkdir -p "$U/.planning"; printf 'x\n' > "$U/.planning/STATE.md"
"$GB" --repo "$U" --print "- fix a" > "$WORK/out" 2>&1; is ".planning/ not committed → refused (64)" "$?" 64
has "…saying why" "gsd-core would then run the batch in the main checkout" "$WORK/out"

section "a batch worktree in the guard, gsd-list, gsd-doctor"
for c in gsd-quick-batch gsd-quick gsd-fast; do
  "$PKG/bin/gsd-worktree-guard" --command "$c" --repo "$BW" > "$WORK/out" 2>&1
  is "the guard allows $c in a batch worktree" "$?" 0
done
"$PKG/bin/gsd-worktree-guard" --command gsd-plan-phase --args 1 --repo "$BW" > "$WORK/out" 2>&1
is "…but not phase work" "$?" 2
"$PKG/bin/gsd-list" --repo "$L" > "$WORK/out" 2>&1
has "gsd-list shows the batch, attached" "● batch-$D-fix-a" "$WORK/out"
has "…and how to land it" "gsd-finish <branch>" "$WORK/out"
git -C "$L" worktree remove --force "$LW/batch-$D-fix-a-2"
PATH="$PKG/bin:$PATH" "$PKG/bin/gsd-doctor" --repo "$L" > "$WORK/out" 2>&1
has "gsd-doctor: a batch branch with no worktree is W017" "branch(es) with no worktree: batch-$D-fix-a-2" "$WORK/out"
hasnt "…an attached one is not" "no worktree:.*batch-$D-fix-a " "$WORK/out"

section "the skill and the instructions"
SK="$PKG/skills/gsdt-batch/SKILL.md"
if [ -f "$SK" ]; then ok "skills/gsdt-batch/SKILL.md exists"; else bad "skills/gsdt-batch/SKILL.md exists"; fi
has "its name" "^name: gsdt-batch$" "$SK"
has "it says it replaces /gsd-quick-batch" "INSTEAD of /gsd-quick-batch" "$SK"
has "it takes a brief in plain words" "OR any brief in plain words" "$SK"
has "a brief gets an Opus helper (it decides what is real)" "a brief → \`model: opus\`" "$SK"
has "recommended items are never built" "never built" "$SK"
has "it prints the done line the report and the mod read" "gsdt-batch: done items=" "$SK"
has "in the main checkout it stops and prints the gsd-batch command" "MAIN checkout: STOP" "$SK"
has "it never lands the batch itself: it prints gsd-finish" "gsd-finish <batch-branch>" "$SK"
hasnt "provider-neutral: no literal Skill() calls" "Skill(" "$SK"
H2="$WORK/insthome"; mkdir -p "$H2"
if HOME="$H2" bash "$PKG/lib/install.sh" --agent claude --no-user-hook > "$WORK/inst" 2>&1; then
  has "install copies it, with the toolkit mark" "^<!-- gsd-toolkit-skill " "$H2/.claude/skills/gsdt-batch/SKILL.md"
else
  bad "lib/install.sh ran" "$(tail -5 "$WORK/inst")"
fi
# shellcheck source=../lib/provider.sh
. "$PKG/lib/provider.sh"
gsd_rules_text off > "$WORK/canon"
has "the toolkit rules (gsd-rules) point at the gsd-batch script" "\`gsd-batch '<task list or brief>'\` in a terminal (the script, not the skill)" "$WORK/canon"

section "an enriched line is ONE quick-batch item"
QB=""
if command -v gsd_run >/dev/null 2>&1; then QB="$(dirname "$(command -v gsd_run)")/lib/quick-batch.cjs"; fi
if [ -n "$QB" ] && [ -f "$QB" ] && command -v node >/dev/null 2>&1; then
  printf '%s\n' \
    '- fix the price label on the card — Likely files: a.ts, b.ts; Tests: a.spec.ts; Done when: label shows EGP' \
    '- make the English name required — Likely files: c.ts; Tests: c.spec.ts; Done when: save refuses an empty name' \
    > "$WORK/items.md"
  n=$(node -e 'const q=require(process.argv[1]); const r=q.parseTaskList(require("fs").readFileSync(process.argv[2],"utf8")); console.log(r.ok ? r.value.length + ":" + r.value[0].description.slice(0,13) : r.reason)' "$QB" "$WORK/items.md")
  is "gsd-core's parser: 2 lines → 2 items, original words first" "$n" "2:fix the price"
else
  echo "  - skipped: gsd-core (gsd_run + node) not found"
fi

section "lint"
for f in "$BR" "$GB" "$HERE/test-batch.sh"; do
  bash -n "$f" 2>/dev/null; is "bash -n $(basename "$f")" "$?" 0
done
python3 -m py_compile "$PKG/lib/gsd_batch_report.py" 2>/dev/null; is "python compiles" "$?" 0
risky=$(LC_ALL=C grep -nE '\$[A-Za-z_][A-Za-z0-9_]*[^ -~[:space:]]' "$BR" "$GB" || true)
is "bash 3.2: no \$VAR directly followed by a non-ASCII character" "$risky" ""

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
