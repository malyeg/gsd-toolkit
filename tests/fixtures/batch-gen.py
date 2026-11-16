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
