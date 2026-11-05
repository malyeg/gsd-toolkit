#!/usr/bin/env python3
"""Adapt Claude's hook JSON to the command guard's four NUL-delimited fields.

The guard reads the payload with jq when it can; this is its fallback. Only
Claude payloads are read (--claude): Gemini, the other native hook, went with
its support in 0.5.0.
"""

import json
import sys


def emit(kind, command="", args="", repo=""):
    sys.stdout.buffer.write("\0".join((kind, command, args, repo)).encode() + b"\0")


def main():
    try:
        if len(sys.argv) < 2 or sys.argv[1] != "--claude":
            raise ValueError("unsupported hook payload; only Claude's is read")
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("payload is not an object")
        tool_input = payload.get("tool_input")
        if tool_input is None:
            tool_input = {}
        if not isinstance(tool_input, dict):
            raise ValueError("tool_input must be an object")
        command = payload.get("command_name", tool_input.get("skill", ""))
        args = payload.get("command_args", tool_input.get("args", ""))
        if not isinstance(command, str) or not isinstance(args, str):
            raise ValueError("command and arguments must be strings")
        if "\0" in command or "\0" in args:
            raise ValueError("NUL in hook command or arguments")
        command = command.lstrip("/")
        if command.startswith("gsd:"):  # namespaced form of a GSD skill
            command = "gsd-" + command[4:]
        # a plugin's namespace names the same skill: gsd-core:gsd-plan-phase
        plugin, sep, rest = command.partition(":")
        if sep and rest.startswith("gsd-"):
            command = rest
        if command in ("gsdt-flow", "gsdw-flow"):  # this toolkit's flow skill (gsdw-: before 0.8.0); the guard knows it as gsd-flow
            command = "gsd-flow"
        cwd = payload.get("cwd")
        emit("guard" if command.startswith("gsd-") else "allow", command, args,
             cwd if isinstance(cwd, str) and "\0" not in cwd else "")
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        emit("block", str(exc))


if __name__ == "__main__":
    main()
