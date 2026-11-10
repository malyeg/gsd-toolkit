#!/usr/bin/env bash
# gsd-toolkit shim — the real logic lives in the gsd-toolkit package
# (bin/gsdt-wt-new). This file exists so committed references keep working
# and never needs updating. Repo settings: .gsd.conf at the repo root.
command -v gsdt-wt-new >/dev/null 2>&1 \
  || { echo "error: gsdt-wt-new not found — install gsd-toolkit (https://github.com/malyeg/gsd-toolkit)" >&2; exit 1; }
exec gsdt-wt-new "$@"
