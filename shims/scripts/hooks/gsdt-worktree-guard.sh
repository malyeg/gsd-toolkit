#!/usr/bin/env bash
# gsd-toolkit shim — the real guard lives in the gsd-toolkit package
# (bin/gsdt-worktree-guard). Provider adapters may register this defense-in-depth
# native hook; the supported shell flow calls the shared guard directly. This
# shim fails open when the toolkit is missing.
command -v gsdt-worktree-guard >/dev/null 2>&1 || exit 0
exec gsdt-worktree-guard "$@"
