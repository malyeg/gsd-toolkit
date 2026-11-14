#!/usr/bin/env python3
"""Token report for quick-task batches, for bin/gsdt-batch-report. Reads Claude
Code transcripts only; writes nothing, calls nothing.

  projdir --home CLAUDE_HOME --repo PATH [--repo PATH …]
      → the Claude Code project folder of the first PATH that has one (else
      of the first PATH; it may not exist).
  report --dir DIR [--last N | --days N | --session ID] [--items N] [--json]
      [--baseline FILE] [--now EPOCH]

DIR is one Claude Code project folder (~/.claude/projects/<sanitized-cwd>).
A session is <session>.jsonl there; its helpers are <session>/subagents/
agent-<id>.jsonl, each with an optional agent-<id>.meta.json (agentType,
model, toolUseId).

A BATCH starts where the main session invokes /gsd-quick-batch or /gsdt-batch
(a Skill tool call, or a typed slash command) and ends at the first of:
  - the next batch start (a /gsd-quick-batch run BY an open /gsdt-batch is
    part of it, not a new batch), or /clear;
  - a done line, kept in: "gsdt-batch: done items=N real=N tiny=N" (printed
    by the gsdt-batch skill) or "GSD ► QUICK BATCH COMPLETE";
  - the next prompt the user types once the batch is SETTLED: its run has
    started (for /gsdt-batch, its pause for the user's OK comes before), no
    helper it spawned is still working, and every item a planner took has an
    executor. Other slash commands (/compact …) never end a batch;
  - the end of the session file.
Only the main-session lines inside the window count as the coordinator. A
helper counts when the Agent call that spawned it is inside the window
(meta toolUseId, else the call's result agentId), and so do the helpers IT
spawned. Helpers are counted whole, even when they finish after the window.

Usage is counted once per message.id (several lines share an id and repeat
its usage); tool calls are counted from every line, once per tool_use id.
Input is split into fresh input, cache write and cache read; WEIGHTED is
the input cost in fresh-token units (cache write 5m ×1.25, 1h ×2, read ×0.1).

Transcript text is untrusted: it is matched and counted, never printed. Only
fixed names (roles, model families) and numbers reach the output.
Python 3.7+, stdlib only.
"""
import argparse
import datetime as dt
import glob
import json
import os
import re
import sys
import time

BATCH_SKILLS = ("gsd-quick-batch", "gsdt-batch")
RUN_SKILLS = ("gsd-quick-batch", "gsd-quick", "gsd-fast")
RUN_AGENTS = ("gsd-planner", "gsd-executor")
CMD_RE = re.compile(r"<command-name>\s*/?([A-Za-z0-9:_-]+)\s*</command-name>")
DONE_RE = re.compile(r"(?m)^\W*gsdt-batch: done\b([^\n]*)")
QB_DONE_RE = re.compile(r"GSD\s*\S?\s*QUICK BATCH COMPLETE")
KV_RE = re.compile(r"\b(items|real|tiny)=(\d+)\b")
QUICK_ID_RE = re.compile(r"\b(\d{6}-[a-z0-9]{3,4})\b")
SAFE_NAME = re.compile(r"^[A-Za-z0-9_.:-]{1,40}$")
NOT_HUMAN = ("<task-notification>", "<local-command-stdout>",
             "<local-command-caveat>", "<local-command-stderr>",
             "<bash-input>", "<bash-stdout>", "<bash-stderr>")

# Baseline from docs/plan-gsdt-batch.md: medyour-platform, the 7 days before
# 2026-11-09, 8 /gsd-quick-batch runs, 50 items (one gsd-planner per item).
# Input there is ONE summed number (fresh + cache write + cache read).
BASELINE = {
    "items": 50,
    "batches": 8,
    "roles": {
        "gsd-planner": {"model": "opus", "agents": 50, "input": 299e6, "output": 2.5e6},
        "gsd-executor": {"model": "sonnet", "agents": 50, "input": 183e6, "output": 1.2e6},
        "coordinator": {"model": "opus", "agents": 0, "turns": 914, "input": 151e6, "output": 0.5e6},
        "general-purpose": {"model": "sonnet", "agents": 5, "input": 52e6, "output": 0.15e6},
    },
}


def family(model):
    """claude-opus-5-5 → opus; an alias stays; anything odd → 'other'."""
    if not isinstance(model, str) or not model or model == "<synthetic>":
        return None
    m = model.lower()
    for f in ("opus", "sonnet", "haiku", "fable"):
        if f in m:
            return f
    return "other"


def safe(name, default="other"):
    return name if isinstance(name, str) and SAFE_NAME.match(name) else default


def skill_name(s):
    """'gsd-core:gsd-quick-batch' → 'gsd-quick-batch'."""
    if not isinstance(s, str):
        return ""
    return s.strip().lstrip("/").split(":")[-1]


def read_jsonl(path):
    out = []
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if isinstance(o, dict):
                    out.append(o)
    except OSError:
        pass
    return out


def blocks(o):
    m = o.get("message")
    if not isinstance(m, dict):
        return []
    c = m.get("content")
    return [b for b in c if isinstance(b, dict)] if isinstance(c, list) else []


def text_of(o):
    m = o.get("message")
    if not isinstance(m, dict):
        return ""
    c = m.get("content")
    if isinstance(c, str):
        return c
    return "\n".join(b.get("text", "") for b in blocks(o)
                     if b.get("type") == "text" and isinstance(b.get("text"), str))


def is_human(o):
    """A prompt the user typed (slash commands included)."""
    if o.get("type") != "user" or o.get("isMeta") or o.get("isCompactSummary") \
            or o.get("isSidechain") or o.get("toolUseResult") is not None:
        return False
    origin = o.get("origin")
    if isinstance(origin, dict) and origin.get("kind") and origin.get("kind") != "human":
        return False
    if any(b.get("type") == "tool_result" for b in blocks(o)):
        return False
    t = text_of(o).lstrip()
    return bool(t) and not t.startswith(NOT_HUMAN)


def ts_epoch(o):
    t = o.get("timestamp")
    if not isinstance(t, str):
        return None
    try:
        return dt.datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


class Tally:
    """Counts for one role (agentType × model family)."""
    FIELDS = ("agents", "turns", "bash", "fresh", "cache_write", "cache_write_1h",
              "cache_read", "output")

    def __init__(self):
        for f in self.FIELDS:
            setattr(self, f, 0)

    def add(self, other):
        for f in self.FIELDS:
            setattr(self, f, getattr(self, f) + getattr(other, f))

    @property
    def input(self):
        return self.fresh + self.cache_write + self.cache_read

    @property
    def weighted(self):
        w5 = self.cache_write - self.cache_write_1h
        return self.fresh + 1.25 * w5 + 2.0 * self.cache_write_1h + 0.1 * self.cache_read


def count_lines(lines, seen_msg, seen_tool):
    """→ (Tally without agents, first model family seen, tool_use list)."""
    t = Tally()
    model = None
    uses = []
    for o in lines:
        if o.get("type") != "assistant":
            continue
        m = o.get("message")
        if not isinstance(m, dict):
            continue
        model = model or family(m.get("model"))
        for b in blocks(o):
            if b.get("type") != "tool_use":
                continue
            tid = b.get("id")
            if not isinstance(tid, str) or tid in seen_tool:
                continue
            seen_tool.add(tid)
            uses.append(b)
            if b.get("name") == "Bash":
                t.bash += 1
        mid = m.get("id")
        u = m.get("usage")
        if not isinstance(mid, str) or mid in seen_msg or not isinstance(u, dict):
            continue
        seen_msg.add(mid)
        t.turns += 1

        def num(k, d=u):
            v = d.get(k)
            return v if isinstance(v, int) and v > 0 else 0
        t.fresh += num("input_tokens")
        t.cache_write += num("cache_creation_input_tokens")
        cc = u.get("cache_creation")
        if isinstance(cc, dict):
            t.cache_write_1h += min(num("ephemeral_1h_input_tokens", cc),
                                    num("cache_creation_input_tokens"))
        t.cache_read += num("cache_read_input_tokens")
        t.output += num("output_tokens")
    return t, model, uses


class Session:
    def __init__(self, path):
        self.path = path
        self.id = os.path.basename(path)[:-len(".jsonl")]
        self.lines = read_jsonl(path)
        self.sub_dir = os.path.join(os.path.dirname(path), self.id, "subagents")
        self.metas = {}       # toolUseId → agent id
        self.meta_of = {}     # agent id → meta dict
        self.result_agent = {}  # tool_use id → agent id (from Agent results)
        self._agents = {}
        self._last = {}
        self.note_results(self.lines)
        for mp in glob.glob(os.path.join(self.sub_dir, "agent-*.meta.json")):
            aid = os.path.basename(mp)[len("agent-"):-len(".meta.json")]
            try:
                with open(mp, encoding="utf-8") as fh:
                    meta = json.load(fh)
            except (OSError, ValueError):
                continue
            if not isinstance(meta, dict):
                continue
            self.meta_of[aid] = meta
            tu = meta.get("toolUseId")
            if isinstance(tu, str):
                self.metas[tu] = aid

    def note_results(self, lines):
        for o in lines:
            r = o.get("toolUseResult")
            if not isinstance(r, dict) or not isinstance(r.get("agentId"), str):
                continue
            for b in blocks(o):
                if b.get("type") == "tool_result" and isinstance(b.get("tool_use_id"), str):
                    self.result_agent.setdefault(b["tool_use_id"], r["agentId"])

    def agent_of(self, tool_id):
        return self.metas.get(tool_id) or self.result_agent.get(tool_id)

    def agent_last(self, aid):
        """Time of the helper's last logged line (None = unknown)."""
        if aid not in self._last:
            last = None
            for o in self.agent_lines(aid):
                t = ts_epoch(o)
                if t and (last is None or t > last):
                    last = t
            self._last[aid] = last
        return self._last[aid]

    def busy(self, tool_ids, when):
        """Was any of these helpers still working at time `when`?"""
        if when is None:
            return False
        for tid in tool_ids:
            aid = self.agent_of(tid)
            last = self.agent_last(aid) if aid else None
            if last is not None and last > when:
                return True
        return False

    def agent_lines(self, aid):
        if aid not in self._agents:
            p = os.path.join(self.sub_dir, "agent-%s.jsonl" % aid)
            self._agents[aid] = read_jsonl(p) if re.match(r"^[A-Za-z0-9_-]+$", aid) else []
            self.note_results(self._agents[aid])
        return self._agents[aid]


def classify(o):
    """One main-session line → dict of what it means for batch boundaries:
    start (batch skill), human ('clear' / 'command' / 'text'), run (the batch
    started its real work), marker (a done line: skill name), done (its
    numbers), spawned [(tool id, agent type, quick ids)]."""
    e = {"start": None, "human": None, "run": False, "marker": None, "done": None,
         "spawned": []}
    if o.get("isSidechain"):
        return e
    if o.get("type") == "assistant":
        for b in blocks(o):
            if b.get("type") != "tool_use":
                continue
            inp = b.get("input") if isinstance(b.get("input"), dict) else {}
            if b.get("name") == "Skill":
                s = skill_name(inp.get("skill"))
                if s in BATCH_SKILLS:
                    e["start"] = s
                elif s in RUN_SKILLS:
                    e["run"] = True
            elif b.get("name") in ("Agent", "Task") and isinstance(b.get("id"), str):
                atype = inp.get("subagent_type")
                desc = inp.get("description") if isinstance(inp.get("description"), str) else ""
                e["spawned"].append((b["id"], atype, set(QUICK_ID_RE.findall(desc))))
                e["run"] = e["run"] or atype in RUN_AGENTS
        t = text_of(o)
        m = DONE_RE.search(t)
        if m:
            e["marker"], e["done"] = "gsdt-batch", {k: int(v) for k, v in KV_RE.findall(m.group(1))}
        elif QB_DONE_RE.search(t):
            e["marker"] = "gsd-quick-batch"
        return e
    if o.get("type") != "user":
        return e
    if is_human(o):
        t = text_of(o)
        m = CMD_RE.search(t)
        if not m:
            # the raw "/compact" line a typed command leaves before its own
            e["human"] = "command" if t.lstrip().startswith("/") else "text"
        elif skill_name(m.group(1)) in BATCH_SKILLS:
            e["start"] = skill_name(m.group(1))
        else:
            e["human"] = "clear" if skill_name(m.group(1)) == "clear" else "command"
    return e


def find_batches(sess):
    """→ list of {start, end (exclusive), skill, done, ended_by}. A typed
    prompt ends a batch only once it is SETTLED: its run has started, no
    helper it spawned was still working then (its own log has a later line),
    and every item a planner took has an executor. Slash commands other than
    /clear never end it."""
    ev = [classify(o) for o in sess.lines]
    n = len(ev)
    out = []
    i = 0
    while i < n:
        skill = ev[i]["start"]
        if not skill:
            i += 1
            continue
        running = skill == "gsd-quick-batch"
        spawned, planned, executed = [], set(), set()
        end, ended_by, done = n, "end of session", None
        for j in range(i + 1, n):
            e = ev[j]
            if e["start"]:
                if skill == "gsdt-batch" and e["start"] == "gsd-quick-batch":
                    running = True
                    continue
                end, ended_by = j, "next batch"
                break
            if e["human"] == "clear":
                end, ended_by = j, "/clear"
                break
            running = running or e["run"]
            for tid, atype, ids in e["spawned"]:
                spawned.append(tid)
                if atype == "gsd-planner":
                    planned |= ids
                elif atype == "gsd-executor":
                    executed |= ids
            if e["marker"] == skill:
                end, ended_by, done = j + 1, "done line", e["done"]
                break
            if e["human"] == "text" and running and planned <= executed \
                    and not sess.busy(spawned, ts_epoch(sess.lines[j])):
                end, ended_by = j, "your next prompt"
                break
        out.append({"start": i, "end": end, "skill": skill, "done": done, "ended_by": ended_by})
        i = max(end, i + 1)
    return out


def measure(sess, b, seen_msg, seen_tool):
    """→ dict for one batch."""
    window = [o for o in sess.lines[b["start"]:b["end"]] if not o.get("isSidechain")]
    roles = {}

    def role(name, model):
        key = (name, model or "other")
        if key not in roles:
            roles[key] = Tally()
        return roles[key]

    t, model, uses = count_lines(window, seen_msg, seen_tool)
    if t.turns:
        role("coordinator", model).add(t)
    quick_ids = set()
    planners = 0
    unlinked = 0
    queue = list(uses)
    done_agents = set()
    while queue:
        u = queue.pop(0)
        if u.get("name") not in ("Agent", "Task"):
            continue
        tid = u.get("id")
        aid = sess.agent_of(tid)
        if not aid:
            unlinked += 1
            continue
        if aid in done_agents:
            continue
        done_agents.add(aid)
        inp = u.get("input") if isinstance(u.get("input"), dict) else {}
        meta = sess.meta_of.get(aid, {})
        atype = safe(meta.get("agentType") or inp.get("subagent_type") or "general-purpose")
        desc = meta.get("description") if isinstance(meta.get("description"), str) \
            else inp.get("description") if isinstance(inp.get("description"), str) else ""
        lines = sess.agent_lines(aid)
        at, amodel, auses = count_lines(lines, seen_msg, seen_tool)
        amodel = amodel or family(meta.get("model")) or family(inp.get("model"))
        r = role(atype, amodel)
        at.agents = 1
        r.add(at)
        if atype in RUN_AGENTS:
            quick_ids.update(QUICK_ID_RE.findall(desc))
        if atype == "gsd-planner":
            planners += 1
        queue.extend(auses)
    done = b.get("done") or {}
    if "items" in done:
        items, src = done["items"], "done line"
    elif quick_ids:
        items, src = len(quick_ids), "quick ids"
    else:
        items, src = planners, "planners"
    start_o = sess.lines[b["start"]]
    last_ts = None
    for o in reversed(window):
        last_ts = ts_epoch(o) if o.get("type") == "assistant" else None
        if last_ts:
            break
    return {
        "session": sess.id,
        "skill": b["skill"],
        "start": ts_epoch(start_o),
        "end": last_ts,
        "items": items,
        "items_from": src,
        "real": done.get("real"),
        "tiny": done.get("tiny"),
        "unlinked_agents": unlinked,
        "ended_by": b["ended_by"],
        "roles": roles,
    }


def scan(d):
    batches = []
    for p in glob.glob(os.path.join(d, "*.jsonl")):
        try:
            with open(p, encoding="utf-8", errors="replace") as fh:
                raw = fh.read()
        except OSError:
            continue
        if not any(s in raw for s in BATCH_SKILLS):
            continue
        sess = Session(p)
        seen_msg, seen_tool = set(), set()
        for b in find_batches(sess):
            batches.append(measure(sess, b, seen_msg, seen_tool))
    batches.sort(key=lambda x: x["start"] or 0)
    return batches


def human_n(n):
    n = float(n)
    for unit, div in (("G", 1e9), ("M", 1e6), ("k", 1e3)):
        if abs(n) >= div:
            v = n / div
            return ("%.1f%s" % (v, unit)) if v < 100 else ("%d%s" % (round(v), unit))
    return "%d" % round(n)


def when(e):
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(e)) if e else "?"


def role_rows(roles):
    order = {"coordinator": 0, "gsd-planner": 1, "gsd-executor": 2}
    return sorted(roles.items(), key=lambda kv: (order.get(kv[0][0], 3), kv[0][0], kv[0][1]))


def total(roles):
    t = Tally()
    for v in roles.values():
        t.add(v)
    return t


def to_json(batches, combined, items):
    def tj(t):
        return {"agents": t.agents, "turns": t.turns, "bash": t.bash,
                "fresh_input": t.fresh, "cache_write": t.cache_write,
                "cache_write_1h": t.cache_write_1h, "cache_read": t.cache_read,
                "input": t.input, "output": t.output, "weighted_input": round(t.weighted)}

    def rj(roles, n):
        out = []
        for (name, model), t in role_rows(roles):
            r = tj(t)
            r.update(role=name, model=model)
            if n:
                r["per_item"] = {"input": round(t.input / n), "output": round(t.output / n),
                                 "weighted_input": round(t.weighted / n)}
            out.append(r)
        return out
    return {
        "batches": [{k: (rj(v, b["items"]) if k == "roles" else v) for k, v in b.items()}
                    for b in batches],
        "combined": {"batches": len(batches), "items": items, "roles": rj(combined, items),
                     "total": tj(total(combined))},
        "baseline": BASELINE,
    }


def print_text(d, batches, combined, items, base):
    print("gsdt-batch-report — %d batch%s · %d item%s · %s" % (
        len(batches), "" if len(batches) == 1 else "es", items, "" if items == 1 else "s", d))
    for b in batches:
        extra = ""
        if b["real"] is not None or b["tiny"] is not None:
            extra = " (real %s, tiny %s)" % (b["real"] if b["real"] is not None else "?",
                                             b["tiny"] if b["tiny"] is not None else "?")
        print("  %s  %s → %s  /%s  %d item%s%s [%s]%s" % (
            b["session"][:8], when(b["start"]), when(b["end"])[11:], b["skill"], b["items"],
            "" if b["items"] == 1 else "s", extra, b["items_from"],
            ("  ⚠ %d helper(s) not found" % b["unlinked_agents"]) if b["unlinked_agents"] else ""))
    print()
    hdr = "%-28s %6s %6s %7s %9s %9s %9s %8s %9s"
    print(hdr % ("ROLE", "AGENTS", "TURNS", "BASH/AG", "FRESH IN", "CACHE WR", "CACHE RD",
                 "OUTPUT", "WEIGHTED"))
    rows = role_rows(combined) + [(("TOTAL", ""), total(combined))]
    for (name, model), t in rows:
        label = name if not model else "%s · %s" % (name, model)
        per = ("%.1f" % (t.bash / t.agents)) if t.agents else "–"
        print(hdr % (label[:28], t.agents or "–", t.turns, per, human_n(t.fresh),
                     human_n(t.cache_write), human_n(t.cache_read), human_n(t.output),
                     human_n(t.weighted)))
    print()
    if not items:
        print("Per item: no item count (pass --items N).")
        return
    print("PER ITEM — input = fresh + cache write + cache read (%s has only this sum)"
          % ("the baseline" if base["builtin"] else "BASE IN"))
    hdr2 = "%-28s %9s %9s %9s %10s %8s"
    print(hdr2 % ("ROLE", "INPUT", "WEIGHTED", "OUTPUT", "BASE IN", "CHANGE"))
    by_name, models = {}, {}
    for (name, model), t in role_rows(combined):
        by_name.setdefault(name, Tally()).add(t)
        models.setdefault(name, []).append(model)
    rows2 = [(n, "+".join(models[n]), t) for n, t in by_name.items()]
    rows2.append(("TOTAL", "", total(combined)))
    for name, model, t in rows2:
        label = name if not model else "%s · %s" % (name, model)
        if name == "TOTAL":
            base_in = sum(base["roles"].values()) / base["items"] if base["items"] else None
        elif name in base["roles"] and base["items"]:
            base_in = base["roles"][name] / base["items"]
        else:
            base_in = None
        if base_in:
            pct = 100.0 * (t.input / items - base_in) / base_in
            change = "%+d%%" % round(pct) if round(pct) else "0%"
        else:
            change = "new"
        print(hdr2 % (label[:28], human_n(t.input / items), human_n(t.weighted / items),
                      human_n(t.output / items), human_n(base_in) if base_in else "–", change))
    print()
    print("Baseline: " + base["label"])


def load_baseline(path):
    """→ {label, items, roles: {role: input}, builtin}; a saved --json run, or
    the built-in numbers. None = unreadable file."""
    if not path:
        return {"builtin": True, "items": BASELINE["items"],
                "roles": {k: v["input"] for k, v in BASELINE["roles"].items()},
                "label": "%d /gsd-quick-batch runs, %d items, the week before 2026-11-09 "
                         "(docs/plan-gsdt-batch.md). It summed WHOLE sessions, so its "
                         "coordinator and helper numbers include work outside the batches."
                         % (BASELINE["batches"], BASELINE["items"])}
    try:
        with open(path, encoding="utf-8") as fh:
            j = json.load(fh)
        c = j["combined"]
        roles = {}
        for r in c["roles"]:
            roles[safe(r["role"])] = roles.get(safe(r["role"]), 0) + int(r["input"])
        return {"builtin": False, "items": int(c["items"]), "roles": roles,
                "label": "%d batch(es), %d items, from a saved report"
                         % (int(c["batches"]), int(c["items"]))}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def projdir(home, repos):
    """Claude Code's folder for a working directory: every character that is
    not a letter or digit becomes '-'; a name over 200 characters is cut and
    gets a hash suffix. The real path is tried too (macOS /tmp → /private/tmp)."""
    base = os.path.join(home, "projects")
    first = None
    for path in [x for r in repos for x in (r, os.path.realpath(r))]:
        name = re.sub(r"[^A-Za-z0-9]", "-", path)
        cand = os.path.join(base, name)
        first = first or cand
        if os.path.isdir(cand):
            return cand
        if len(name) > 200:
            hits = sorted(glob.glob(os.path.join(base, glob.escape(name[:200]) + "-*")))
            if hits:
                return hits[0]
    return first


def main(argv):
    ap = argparse.ArgumentParser(prog="gsd_batch_report.py")
    sub = ap.add_subparsers(dest="cmd")
    pd = sub.add_parser("projdir")
    pd.add_argument("--home", required=True)
    pd.add_argument("--repo", required=True, action="append")
    r = sub.add_parser("report")
    r.add_argument("--dir", required=True)
    g = r.add_mutually_exclusive_group()
    g.add_argument("--last", type=int)
    g.add_argument("--days", type=float)
    g.add_argument("--session")
    r.add_argument("--items", type=int)
    r.add_argument("--json", action="store_true")
    r.add_argument("--now", type=float)
    r.add_argument("--baseline")
    a = ap.parse_args(argv)
    if a.cmd == "projdir":
        print(projdir(a.home, a.repo))
        return 0
    if a.cmd != "report":
        ap.print_usage(sys.stderr)
        return 64
    batches = scan(a.dir)
    if a.session:
        batches = [b for b in batches if b["session"].startswith(a.session)]
    elif a.days is not None:
        cut = (a.now or time.time()) - a.days * 86400
        batches = [b for b in batches if (b["start"] or 0) >= cut]
    else:
        batches = batches[-(a.last or 1):]
    combined = {}
    for b in batches:
        for k, t in b["roles"].items():
            combined.setdefault(k, Tally()).add(t)
    items = a.items if a.items is not None else sum(b["items"] for b in batches)
    if a.json:
        json.dump(to_json(batches, combined, items), sys.stdout, indent=1)
        sys.stdout.write("\n")
        return 0
    if not batches:
        print("gsdt-batch-report: no /gsd-quick-batch or /gsdt-batch run found in %s" % a.dir)
        return 0
    base = load_baseline(a.baseline)
    if base is None:
        print("gsdt-batch-report: cannot read --baseline %s (a saved --json report)" % a.baseline,
              file=sys.stderr)
        return 64
    print_text(a.dir, batches, combined, items, base)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
