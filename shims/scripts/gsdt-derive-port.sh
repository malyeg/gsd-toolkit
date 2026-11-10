#!/usr/bin/env bash
# gsd-toolkit shim — the real logic lives in the gsd-toolkit package
# (bin/gsdt-derive-port). Referenced from app package.json dev scripts, so it
# degrades gracefully: without the toolkit (CI, a teammate's machine) it
# prints the bare base port and plain `dev` keeps working.
command -v gsdt-derive-port >/dev/null 2>&1 && exec gsdt-derive-port "$@"
echo "${1:?usage: gsdt-derive-port.sh <base-port>}"
