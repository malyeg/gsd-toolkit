#!/usr/bin/env python3
"""gsd_claude_env.py — set or remove one variable in a Claude settings file.

gsdt-start launches Claude with CLAUDE_CODE_AUTO_COMPACT_WINDOW, but a session
opened later in the same worktree with a plain `claude` would not get it.
Claude also reads the "env" object of .claude/settings.local.json, so the
worktree carries the value there.

Usage: gsd_claude_env.py <settings file> <NAME> [<value>]
  with a value: set env.NAME to it (as a string)
  without one:  remove env.NAME (and an "env" left empty)

Everything else in the file (permissions Claude saved, the user's own keys)
is kept, in order. A file that is not a JSON object is left alone (exit 3).
Unchanged content is not rewritten; a change is written atomically.
"""
import json
import os
import sys
import tempfile


def main(argv):
    if len(argv) not in (3, 4):
        print("usage: gsd_claude_env.py <settings file> <NAME> [<value>]", file=sys.stderr)
        return 64
    path, name = argv[1], argv[2]
    value = argv[3] if len(argv) == 4 else None
    data = {}
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
            data = json.loads(text) if text.strip() else {}
        except (OSError, ValueError):
            return 3
        if not isinstance(data, dict):
            return 3
    elif value is None:
        return 0
    env = data.get("env")
    if env is not None and not isinstance(env, dict):
        return 3
    before = json.dumps(data, sort_keys=True)
    if value is None:
        if env is not None:
            env.pop(name, None)
            if not env:
                del data["env"]
    else:
        data.setdefault("env", {})[name] = value
    if json.dumps(data, sort_keys=True) == before and os.path.exists(path):
        return 0
    folder = os.path.dirname(path) or "."
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".gsd-settings.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.chmod(tmp, os.stat(path).st_mode & 0o777 if os.path.exists(path) else 0o644)
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
