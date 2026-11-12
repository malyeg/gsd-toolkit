#!/usr/bin/env python3
"""Codex usage-limit helpers for bin/gsdt-codex-wait. Reads text and files only;
never calls Codex.

  parse --base EPOCH   text on stdin → the reset time as epoch seconds.
                       exit 0 = found (printed), 1 = a limit message without a
                       readable time, 2 = no limit message at all.
  scan --home DIR --since EPOCH
                       newest Codex session log ($CODEX_HOME/sessions/**.jsonl)
                       changed since EPOCH that records a usage-limit error →
                       "<mtime>\t<message>"; exit 1 when there is none.
  when EPOCH           local time for messages, e.g. "Sun Oct 11 01:22 EEST".

Codex's message looks like "You’ve hit your usage limit. … try again at Oct
11th, 2026 1:22 AM." (curly apostrophe; local time, minutes only). Older
builds said "try again in 2 days 3 hours". Python 3.7+, stdlib only.
"""
import json
import os
import re
import sys
import time

LIMIT = re.compile(r"hit your usage limit", re.I)
MONTHS = {m: i + 1 for i, m in enumerate(
    "jan feb mar apr may jun jul aug sep oct nov dec".split())}
AMPM = r"(?:\s*([ap])\.?m\.?)?"
AT_DATE = re.compile(
    r"try again at\s+([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?"
    r"\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?" + AMPM, re.I)
AT_TIME = re.compile(r"try again at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?" + AMPM, re.I)
IN_DUR = re.compile(
    r"try again in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)",
    re.I)
UNIT = re.compile(r"(\d+)\s*([dhms])", re.I)
SECONDS = {"d": 86400, "h": 3600, "m": 60, "s": 1}


def hour24(h, ampm):
    h = int(h)
    if ampm:
        h = h % 12 + (12 if ampm.lower() == "p" else 0)
    return h


def local_epoch(y, mo, d, h, mi, s):
    return int(time.mktime((y, mo, d, h, mi, s, 0, 0, -1)))


def reset_from(text, base):
    """The reset time in the LAST "try again" of text, or None."""
    found = []
    for m in AT_DATE.finditer(text):
        mo = MONTHS.get(m.group(1).lower()[:3])
        if mo:
            found.append((m.start(), local_epoch(
                int(m.group(3)), mo, int(m.group(2)),
                hour24(m.group(4), m.group(7)), int(m.group(5)), int(m.group(6) or 0))))
    for m in AT_TIME.finditer(text):
        t = time.localtime(base)
        e = local_epoch(t.tm_year, t.tm_mon, t.tm_mday,
                        hour24(m.group(1), m.group(4)), int(m.group(2)), int(m.group(3) or 0))
        found.append((m.start(), e + 86400 if e <= base else e))
    for m in IN_DUR.finditer(text):
        secs = sum(int(n) * SECONDS[u[0].lower()] for n, u in UNIT.findall(m.group(1)))
        if secs:
            found.append((m.start(), base + secs))
    return max(found)[1] if found else None


def strings(o):
    if isinstance(o, str):
        yield o
    elif isinstance(o, dict):
        for v in o.values():
            yield from strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from strings(v)


def limit_message(path):
    """The last usage-limit message recorded in one session log, or None."""
    msg = None
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                if "usage limit" not in line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                for s in strings(o):
                    if LIMIT.search(s):
                        msg = s
    except OSError:
        return None
    return msg


def scan(home, since):
    logs = []
    for root, _dirs, files in os.walk(os.path.join(home, "sessions")):
        for name in files:
            if name.endswith(".jsonl"):
                p = os.path.join(root, name)
                try:
                    mt = os.stat(p).st_mtime
                except OSError:
                    continue
                if mt >= since:
                    logs.append((mt, p))
    for mt, p in sorted(logs, reverse=True):
        msg = limit_message(p)
        if msg:
            return int(mt), msg
    return None


def main(argv):
    cmd, args = (argv[0] if argv else ""), argv[1:]
    opts = dict(zip(args[::2], args[1::2]))
    if cmd == "parse":
        text = sys.stdin.read()
        if not LIMIT.search(text):
            return 2
        e = reset_from(text, int(opts.get("--base", time.time())))
        if e is None:
            return 1
        print(e)
        return 0
    if cmd == "scan":
        hit = scan(opts["--home"], int(opts.get("--since", 0)))
        if not hit:
            return 1
        print("%d\t%s" % (hit[0], " ".join(hit[1].split())))
        return 0
    if cmd == "when" and args:
        print(time.strftime("%a %b %d %H:%M %Z", time.localtime(int(args[0]))))
        return 0
    sys.stderr.write(__doc__)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
