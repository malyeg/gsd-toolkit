#!/usr/bin/env bash
# gsd-toolkit shim — the real logic lives in the gsd-toolkit package
# (bin/gsdt-planning-repair). This file exists so committed references (CI
# jobs, git hooks, package.json scripts) keep working and never need updating.
# Repo settings: .gsd.conf at the repo root.
command -v gsdt-planning-repair >/dev/null 2>&1 \
  || { echo "error: gsdt-planning-repair not found — install gsd-toolkit (https://github.com/malyeg/gsd-toolkit)" >&2; exit 1; }
exec gsdt-planning-repair "$@"
