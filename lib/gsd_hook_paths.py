#!/usr/bin/env python3
"""gsd_hook_paths.py — find GSD hooks that point at files that are gone.

An agent runs a hook whose program is missing as a failed command, and most
events show nothing: the guard or monitor just stops running. The usual cause
is a path written in at install time that a later upgrade moved (GSD's
installer bakes in the absolute node path; nvm, Volta, fnm and asdf keep each
version in its own folder, so the next Node upgrade orphans it).

Usage: gsd_hook_paths.py <scope>:<settings file> [--project <dir>] ...
  scope = user | project (where the fix is run: --global or --local)
  --project <dir> applies to the files after it: $CLAUDE_PROJECT_DIR expands
  to <dir> there.

Prints one line per missing file, tab-separated:
  <settings file> <scope> <owner> <hook> <event> <missing path>
owner = toolkit (our gsdt-worktree-guard or gsdt-rules) | gsd (any other gsd-* hook);
hook = the hook's number in its file, so one hook missing two files counts once.

Only GSD hooks count: a command is checked when one of its words names a
gsd-* program or script. Everything else in those files (the user's own
hooks, other tools) is left alone. Only absolute paths are checked; a bare
name (node, bash) resolves on the hook's PATH, which this cannot see, and a
word holding any other $VARIABLE is skipped. Reads files only; a missing or
unreadable file is skipped.
"""
import json
import os
import re
import shlex
import sys

GSD_WORD = re.compile(r"^gsdt?-[A-Za-z0-9_.-]+$")


def commands(data):
    """(event, command) for every hook and the status line."""
    hooks = data.get("hooks")
    if isinstance(hooks, dict):
        for event, groups in hooks.items():
            if not isinstance(groups, list):
                continue
            for group in groups:
                if not isinstance(group, dict):
                    continue
                inner = group.get("hooks")
                # Claude and Codex nest {matcher, hooks: [...]}; tolerate a
                # flat entry too.
                for h in inner if isinstance(inner, list) else [group]:
                    if isinstance(h, dict) and isinstance(h.get("command"), str):
                        yield event, h["command"]
    status = data.get("statusLine")
    if isinstance(status, dict) and isinstance(status.get("command"), str):
        yield "statusLine", status["command"]


def expand(word, project):
    home = os.path.expanduser("~")
    if word == "~" or word.startswith("~/"):
        word = home + word[1:]
    word = word.replace("${HOME}", home).replace("$HOME", home)
    if project:
        word = word.replace("${CLAUDE_PROJECT_DIR}", project).replace("$CLAUDE_PROJECT_DIR", project)
    return None if "$" in word else word


def missing(command, project):
    try:
        words = shlex.split(command)
    except ValueError:
        return None, []
    names = [os.path.basename(w) for w in words]
    if not any(GSD_WORD.match(n) for n in names):
        return None, []
    owner = "toolkit" if any(n in names for n in ("gsdt-worktree-guard", "gsdt-rules", "gsd-worktree-guard", "gsd-rules")) else "gsd"
    # A runner picked at run time ("$(for n in <node> … ; do …)", gsd-core's
    # chain) falls back on its own: only its gsd-* scripts can be judged.
    if "$(" in command or "`" in command:
        words = [w for w, n in zip(words, names) if GSD_WORD.match(n)]
    gone = []
    for w in words:
        p = expand(w, project)
        if p and p.startswith("/") and not os.path.exists(p) and p not in gone:
            gone.append(p)
    return owner, gone


def main(argv):
    project = None
    i = 0
    while i < len(argv):
        arg = argv[i]
        i += 1
        if arg == "--project":
            project = argv[i] if i < len(argv) else None
            i += 1
            continue
        scope, _, path = arg.partition(":")
        try:
            with open(path) as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        for n, (event, command) in enumerate(commands(data), 1):
            owner, gone = missing(command, project if scope == "project" else None)
            for p in gone:
                print("\t".join((path, scope, owner, str(n), event, p)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
