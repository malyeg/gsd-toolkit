#!/usr/bin/env python3
"""
gsd_planning.py — reconcile GSD planning files after a union-style merge.

`.planning/ROADMAP.md` and `.planning/STATE.md` carry a union merge strategy so
parallel phase sessions can each append their own entries without conflicting.
Union is right for append-only content and WRONG for every line that is a single
source of truth: when a phase branch flips a line that the base branch also
changed, union keeps BOTH sides and the file starts contradicting itself.

This module reconciles the both-sides result back to one coherent file.

    reconcile   Fix ONE file in place. Structural only — no counter is
                recomputed, because a merge driver runs mid-merge when the rest
                of the tree is not yet consistent. Conflicting counters resolve
                to the most-advanced candidate; `repair` fixes them properly.

    repair      Fix .planning/ROADMAP.md + STATE.md AND recompute every derived
                counter from ground truth: phases from the roadmap, plans and
                summaries from disk. Idempotent. With --check it writes nothing
                and exits 1 if either file needs repair.

Two rules the reconciliation is built on, both learned from real corruption:

  * Keyed content (checklist entries, table rows, phase detail sections) keeps
    the position of the key's FIRST occurrence and the content of its BEST
    occurrence — "[x]" beats "[ ]", a real status beats "Not started", and among
    equals the longer text wins because it carries the "(completed <date>)"
    suffix. Keeping the later line instead would reorder phases out of sequence.

  * Single-value fields resolve to their LAST occurrence, because
    `git merge-file --union` emits ours-then-theirs inside a conflict hunk, so
    the last copy is the incoming branch's value. This is verified against real
    merges — see tests/fixtures.

Deduplication of single-value fields is always SCOPED to the block that owns the
field. STATE.md's "## Session Continuity" section is never touched: its
`Last session:` / `Stopped at:` / `Resume file:` lines are one entry per past
session and legitimately repeat. A global "keep the last occurrence" pass would
silently delete real history.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

PHASE_NUM = r"\d+(?:\.\d+)?"

# Two severities, because they call for different reactions. CORRUPT means the
# file contradicts itself — union kept both sides of a single-value line — and
# that must never reach a shared branch, so `--check` exits nonzero on it.
# ADVISORY means the file is coherent but drifted or hand-editable: a stale
# counter, a phase missing from the progress table, a stray table row. Those are
# reported and (where derivable) fixed, but they never fail a check, because
# they are not caused by merging and would otherwise paint CI red permanently.
CORRUPT = "corrupt"
ADVISORY = "advisory"


# ── generic helpers ──────────────────────────────────────────────────────────


def phase_sort_key(key: str) -> tuple[int, int]:
    major, _, minor = key.partition(".")
    return (int(major), int(minor) if minor else 0)


def dedupe_keyed(lines, key_of, rank_of):
    """One line per key, at the FIRST occurrence's position, carrying the
    highest-ranked occurrence's content. Lines with no key pass through."""
    best = {}
    for line in lines:
        key = key_of(line)
        if key is None:
            continue
        if key not in best or rank_of(line) > rank_of(best[key]):
            best[key] = line

    out, seen, dropped = [], set(), []
    for line in lines:
        key = key_of(line)
        if key is None:
            out.append(line)
            continue
        if key in seen:
            dropped.append(key)
            continue
        seen.add(key)
        out.append(best[key])
    return out, dropped


def section_bounds(lines, heading_rx, stop_rx=re.compile(r"^#{1,6}\s")):
    """[start, end) for a section: its heading through the line before the NEXT
    HEADING OF ANY LEVEL.

    Any level, not same-or-higher, on purpose. ROADMAP.md puts every
    `### Phase N:` detail section after `## Progress`, so stopping only at
    `##` made the Progress "section" run to end of file — and the progress-row
    dedupe then ran across all of them, silently deleting a numbered table row
    in one phase's detail because another phase's detail had the same number."""
    for i, line in enumerate(lines):
        if heading_rx.match(line):
            for j in range(i + 1, len(lines)):
                if stop_rx.match(lines[j]):
                    return i, j
            return i, len(lines)
    return None


def apply_to_section(lines, bounds, fn):
    """Replace lines[start:end] with fn(lines[start:end])."""
    if bounds is None:
        return lines, []
    start, end = bounds
    new, dropped = fn(lines[start:end])
    return lines[:start] + new + lines[end:], dropped


def dedupe_last(lines, prefixes):
    """Collapse each `<prefix>...` line to a single line at the FIRST
    occurrence's position carrying the LAST occurrence's value — union emits
    ours-then-theirs, so the last copy is the incoming branch's."""
    dropped = []
    for prefix in prefixes:
        hits = [i for i, line in enumerate(lines) if line.startswith(prefix)]
        if len(hits) <= 1:
            continue
        winner, keep, drop = lines[hits[-1]], hits[0], set(hits[1:])
        lines = [
            winner if i == keep else line
            for i, line in enumerate(lines)
            if i not in drop
        ]
        dropped.extend([prefix] * (len(hits) - 1))
    return lines, dropped


# ── ROADMAP.md ───────────────────────────────────────────────────────────────

CHECKLIST_RX = re.compile(rf"^- \[([ xX])\] \*\*Phase ({PHASE_NUM})\b")
DETAIL_RX = re.compile(rf"^### Phase ({PHASE_NUM})\b")
TABLE_ROW_RX = re.compile(rf"^\|\s*({PHASE_NUM})\s*\.?\s+\S")
STATUS_RANK = {"not started": 0, "blocked": 1, "in progress": 2, "complete": 3}


def checklist_rank(line):
    mark = CHECKLIST_RX.match(line).group(1).lower()
    return (1 if mark == "x" else 0, len(line))


def table_row_rank(line):
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    plans = cells[1] if len(cells) > 1 else ""
    status = (cells[2] if len(cells) > 2 else "").lower()
    rank = 1 if status and status != "-" else 0
    for name, value in STATUS_RANK.items():
        if status.startswith(name):
            rank = value
            break
    done = re.match(r"(\d+)", plans)
    return (rank, int(done.group(1)) if done else 0, len(line))


def dedupe_detail_sections(lines):
    """Collapse duplicated `### Phase N:` blocks, keeping the first block's
    position and the longest block's content."""
    starts = [i for i, line in enumerate(lines) if DETAIL_RX.match(line)]
    if not starts:
        return lines, []

    blocks = []  # (key, start, end)
    heading_rx = re.compile(r"^#{1,3}\s")
    for i, start in enumerate(starts):
        end = len(lines)
        for j in range(start + 1, len(lines)):
            if heading_rx.match(lines[j]):
                end = j
                break
        blocks.append((DETAIL_RX.match(lines[start]).group(1), start, end))

    best = {}
    for key, start, end in blocks:
        body = "".join(lines[start:end])
        if key not in best or len(body) > len(best[key][0]):
            best[key] = (body, lines[start:end])

    out, seen, dropped, i = [], set(), [], 0
    span = {start: (key, end) for key, start, end in blocks}
    while i < len(lines):
        if i in span:
            key, end = span[i]
            if key in seen:
                dropped.append(key)
            else:
                seen.add(key)
                out.extend(best[key][1])
            i = end
            continue
        out.append(lines[i])
        i += 1
    return out, dropped


def reconcile_roadmap(lines):
    problems = []

    lines, dropped = dedupe_keyed(
        lines,
        lambda line: CHECKLIST_RX.match(line).group(2) if CHECKLIST_RX.match(line) else None,
        checklist_rank,
    )
    for key in dropped:
        problems.append((CORRUPT, f"ROADMAP.md: duplicate checklist entry for Phase {key}"))

    progress = section_bounds(lines, re.compile(r"^## Progress\b"))
    lines, dropped = apply_to_section(
        lines,
        progress,
        lambda block: dedupe_keyed(
            block,
            lambda line: TABLE_ROW_RX.match(line).group(1) if TABLE_ROW_RX.match(line) else None,
            table_row_rank,
        ),
    )
    for key in dropped:
        problems.append((CORRUPT, f"ROADMAP.md: duplicate progress-table row for Phase {key}"))

    lines, dropped = dedupe_detail_sections(lines)
    for key in dropped:
        problems.append((CORRUPT, f"ROADMAP.md: duplicate '### Phase {key}' detail section"))

    problems.extend(detect_table_gaps(lines))
    return lines, problems


def detect_table_gaps(lines):
    """A phase in the checklist but absent from the ## Progress table. Not merge
    damage — /gsd-phase's insert path has left rows out — but it is exactly the
    kind of drift that makes the roadmap look self-contradictory, so surface it
    rather than silently inventing a row with a title we would have to guess."""
    listed = {m.group(2) for m in map(CHECKLIST_RX.match, lines) if m}
    progress = section_bounds(lines, re.compile(r"^## Progress\b"))
    if not progress or not listed:
        return []
    start, end = progress
    tabled = {m.group(1) for m in map(TABLE_ROW_RX.match, lines[start:end]) if m}
    return [
        (ADVISORY, f"ROADMAP.md: Phase {key} is in the checklist but has no ## Progress row")
        for key in sorted(listed - tabled, key=phase_sort_key)
    ]


# ── STATE.md frontmatter ─────────────────────────────────────────────────────

FM_TOP_RX = re.compile(r"^([A-Za-z_][\w-]*):\s*(.*)$")
FM_SUB_RX = re.compile(r"^(\s+)([A-Za-z_][\w-]*):\s*(.*)$")
DERIVED_COUNTERS = (
    "progress.total_phases",
    "progress.completed_phases",
    "progress.total_plans",
    "progress.completed_plans",
    "progress.percent",
)


def unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def as_int(value):
    match = re.match(r"-?\d+", unquote(value))
    return int(match.group(0)) if match else -1


def split_frontmatter(lines):
    """(start, end) indices of the frontmatter body, or None."""
    if not lines or lines[0].strip() != "---":
        return None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return 1, i
    return None


def parse_frontmatter(body):
    """-> (order, values): dotted paths in first-occurrence order, and every
    value seen for each path. A parent mapping is recorded as a bare path."""
    order, values = [], {}

    def record(path, value):
        if path not in values:
            order.append(path)
            values[path] = []
        values[path].append(value)

    parent = None
    for line in body:
        if not line.strip():
            continue
        sub = FM_SUB_RX.match(line)
        if sub and parent:
            record(f"{parent}.{sub.group(2)}", sub.group(3))
            continue
        top = FM_TOP_RX.match(line)
        if not top:
            continue
        key, value = top.group(1), top.group(2)
        if value.strip() == "":
            parent = key
            record(key, "")
        else:
            parent = None
            record(key, value)
    return order, values


def resolve_frontmatter(order, values, truth=None):
    """Collapse each path to one value. Derived counters come from `truth` when
    it is supplied; `last_updated` takes the newest; other conflicts take the
    last copy (the incoming branch's, per union's ours-then-theirs order)."""
    resolved, problems = {}, []
    for path in order:
        seen = values[path]
        distinct = {unquote(v) for v in seen}
        # A plan counter that recomputes to zero while the file claims
        # otherwise means the phase files are not where we looked, not that the
        # work vanished. Keep the file's figure and say so.
        if (
            truth
            and path in ("progress.total_plans", "progress.completed_plans")
            and truth.get(path) == 0
            and any(as_int(v) > 0 for v in seen)
        ):
            resolved[path] = max(seen, key=as_int)
            problems.append(
                (
                    ADVISORY,
                    f"STATE.md: {path} left at {unquote(resolved[path])} — no plan files found "
                    f"under .planning/phases/*/, so the recomputed 0 is not believable",
                )
            )
            continue
        if truth and path in truth:
            resolved[path] = str(truth[path])
            if distinct != {str(truth[path])}:
                problems.append(
                    (
                        CORRUPT if len(distinct) > 1 else ADVISORY,
                        f"STATE.md: {path} recomputed to {truth[path]} "
                        f"(file had {', '.join(unquote(v) for v in seen)})",
                    )
                )
            continue
        if len(distinct) == 1:
            resolved[path] = seen[0]
            continue
        problems.append(
            (
                CORRUPT,
                f"STATE.md: conflicting '{path}' in frontmatter "
                f"({len(seen)} values: {', '.join(unquote(v) for v in seen)})",
            )
        )
        if path == "last_updated":
            resolved[path] = max(seen, key=unquote)
        elif path.startswith("progress."):
            resolved[path] = max(seen, key=as_int)
        else:
            resolved[path] = seen[-1]
    return resolved, problems


def emit_frontmatter(body, resolved):
    """Rewrite the frontmatter by WALKING THE ORIGINAL LINES: a key's first
    occurrence takes its resolved value, later occurrences are dropped, and
    anything we did not parse is passed through untouched.

    Rebuilding from the parsed keys instead would silently delete every line the
    parser has no model for — YAML lists, comments, blank lines. Dropping real
    content is the failure this whole module exists to prevent, so the parser
    only ever gets to change what it positively recognises."""
    out, seen, parent = [], set(), None
    for line in body:
        path = None
        sub = FM_SUB_RX.match(line)
        top = FM_TOP_RX.match(line)
        if sub and parent:
            path = f"{parent}.{sub.group(2)}"
            indent = sub.group(1)
            key = sub.group(2)
        elif top:
            key = top.group(1)
            path = key
            indent = ""
            parent = key if top.group(2).strip() == "" else None
        if path is None:
            out.append(line)  # not ours — verbatim
            continue
        if path in seen:
            continue  # a later copy of a key we have already emitted
        seen.add(path)
        value = resolved.get(path, "")
        out.append(f"{indent}{key}:\n" if value.strip() == "" else f"{indent}{key}: {value}\n")
    return out


# ── STATE.md body ────────────────────────────────────────────────────────────

POSITION_KEYS = ("Phase:", "Plan:", "Worktree:", "Status:", "Last activity:", "Progress:")
VELOCITY_KEYS = (
    "- Total plans completed:",
    "- Average duration:",
    "- Total execution time:",
    "- Last 5 plans:",
    "- Trend:",
)
BY_PHASE_ROW_RX = re.compile(r"^\|\s*(\d+(?:\.\d+)?)\s*\|\s*[\d/]+\s*\|")


def by_phase_rank(line):
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    plans = re.match(r"(\d+)", cells[1] if len(cells) > 1 else "")
    return (int(plans.group(1)) if plans else 0, len(line))


def reconcile_state_body(lines, truth=None):
    problems = []

    # "**Current focus:**" lives just above ## Current Position, in the
    # Project Reference block — single-value, and it appears nowhere else.
    lines, dropped = dedupe_last(lines, ("**Current focus:**",))
    for _ in dropped:
        problems.append((CORRUPT, "STATE.md: duplicate '**Current focus:**' line"))

    # Scoped to ## Current Position ONLY. The same key names recur in
    # ## Session Continuity, one per past session — never dedupe them there.
    position = section_bounds(lines, re.compile(r"^## Current Position\b"))
    lines, dropped = apply_to_section(
        lines, position, lambda block: dedupe_last(block, POSITION_KEYS)
    )
    for key in dropped:
        problems.append((CORRUPT, f"STATE.md: duplicate '{key}' in ## Current Position"))

    metrics = section_bounds(lines, re.compile(r"^## Performance Metrics\b"))
    lines, dropped = apply_to_section(
        lines, metrics, lambda block: dedupe_last(block, VELOCITY_KEYS)
    )
    for key in dropped:
        problems.append((CORRUPT, f"STATE.md: duplicate '{key.strip()}' in the velocity block"))

    metrics = section_bounds(lines, re.compile(r"^## Performance Metrics\b"))
    lines, dropped = apply_to_section(
        lines,
        metrics,
        lambda block: dedupe_keyed(
            block,
            lambda line: BY_PHASE_ROW_RX.match(line).group(1)
            if BY_PHASE_ROW_RX.match(line)
            else None,
            by_phase_rank,
        ),
    )
    for key in dropped:
        problems.append((CORRUPT, f"STATE.md: duplicate by-phase row for Phase {key}"))

    if truth:
        lines, fixed = recompute_state_body(lines, truth)
        problems.extend(fixed)

    problems.extend(detect_orphan_rows(lines))
    return lines, problems


PROGRESS_RX = re.compile(r"^Progress: \[[^\]]*\]\s*\d+%(.*)$")
COUNT_RX = re.compile(r"\s*\(\d+ of \d+ phases complete\)\s*")


def recompute_state_body(lines, truth):
    """Rewrite the two derived body values: the Current Position progress bar
    and the velocity total. Both restate frontmatter counters in prose."""
    problems = []
    done = truth["progress.completed_phases"]
    total = truth["progress.total_phases"]
    percent = truth["progress.percent"]
    filled = round(percent / 10)
    bar = "█" * filled + "░" * (10 - filled)
    count = f" ({done} of {total} phases complete)"

    position = section_bounds(lines, re.compile(r"^## Current Position\b"))
    if position:
        start, end = position
        for i in range(start, end):
            if lines[i].startswith("Progress:"):
                # Keep the line's own form: GSD's template writes the bar
                # without the "(N of M phases complete)" count, and that is
                # not drift. Only the bar, the percent and a count go stale.
                m = PROGRESS_RX.match(lines[i].rstrip("\n"))
                rest = m.group(1) if m else count
                if COUNT_RX.fullmatch(rest):
                    rest = count
                want = f"Progress: [{bar}] {percent}%{rest}\n"
                if lines[i] != want:
                    problems.append(
                        (
                            ADVISORY,
                            f"STATE.md: progress bar recomputed to {percent}% "
                            f"(was {lines[i].strip()})",
                        )
                    )
                    lines[i] = want
                break

    if "progress.completed_plans" not in truth:
        return lines, problems
    want_total = f"- Total plans completed: {truth['progress.completed_plans']}\n"
    metrics = section_bounds(lines, re.compile(r"^## Performance Metrics\b"))
    if metrics:
        start, end = metrics
        for i in range(start, end):
            if lines[i].startswith("- Total plans completed:"):
                # Same guard as the frontmatter counters: a recomputed 0 against
                # a nonzero figure means we did not find the plan files.
                if truth["progress.completed_plans"] == 0 and as_int(lines[i].split(":", 1)[1]) > 0:
                    break
                if lines[i] != want_total:
                    problems.append(
                        (
                            ADVISORY,
                            f"STATE.md: velocity total recomputed to "
                            f"{truth['progress.completed_plans']} (was {lines[i].strip()})",
                        )
                    )
                    lines[i] = want_total
                break
    return lines, problems


def detect_orphan_rows(lines):
    """A table row sitting outside any table — /gsd-fast has appended one past
    EOF before. Reported, never silently re-homed: the cell order of a stray row
    rarely matches the table it belongs to, and guessing would corrupt data."""
    problems = []
    for i, line in enumerate(lines):
        if not line.startswith("|"):
            continue
        prev = lines[i - 1] if i else ""
        nxt = lines[i + 1] if i + 1 < len(lines) else ""
        if not prev.startswith("|") and not nxt.startswith("|"):
            problems.append(
                (
                    ADVISORY,
                    f"STATE.md:{i + 1}: table row outside any table — "
                    f"move it into the table it belongs to by hand: {line.strip()[:60]}",
                )
            )
    return problems


def reconcile_state(lines, truth=None):
    bounds = split_frontmatter(lines)
    problems = []
    if bounds:
        start, end = bounds
        order, values = parse_frontmatter(lines[start:end])
        resolved, fm_problems = resolve_frontmatter(order, values, truth)
        problems.extend(fm_problems)
        lines = lines[:start] + emit_frontmatter(lines[start:end], resolved) + lines[end:]
    # No frontmatter is how GSD writes a new project's STATE.md: nothing to
    # reconcile there, and nothing to report.

    lines, body_problems = reconcile_state_body(lines, truth)
    problems.extend(body_problems)
    return lines, problems


# ── ground truth ─────────────────────────────────────────────────────────────


def compute_truth(planning: Path):
    """Recompute the counters from ground truth. Phases come from the roadmap
    (detail headings ∪ checklist entries), plans and summaries from disk.
    Neither side of a corrupted frontmatter can be trusted: after one real
    phase-11 merge the two candidates were 30/12/96 and 28/11/103 while the
    truth was 30/13/111."""
    roadmap = planning / "ROADMAP.md"
    if not roadmap.exists():
        return None

    text = roadmap.read_text(encoding="utf-8").splitlines()
    phases, complete = set(), set()
    for line in text:
        detail = DETAIL_RX.match(line)
        if detail:
            phases.add(detail.group(1))
        entry = CHECKLIST_RX.match(line)
        if entry:
            phases.add(entry.group(2))
            if entry.group(1).lower() == "x":
                complete.add(entry.group(2))

    total = len(phases)
    truth = {
        "progress.total_phases": total,
        "progress.completed_phases": len(complete),
        "progress.percent": round(len(complete) / total * 100) if total else 0,
    }

    # Plan counters come from disk, so they are only trustworthy when the disk
    # actually holds the phase directories. A repo whose phases/ has been
    # archived away — or a caller pointed at the wrong .planning — would
    # otherwise have real counters silently rewritten to zero.
    phases_dir = planning / "phases"
    if phases_dir.is_dir():
        truth["progress.total_plans"] = len(list(phases_dir.glob("*/*-PLAN.md")))
        truth["progress.completed_plans"] = len(list(phases_dir.glob("*/*-SUMMARY.md")))
    return truth


# ── entry points ─────────────────────────────────────────────────────────────


def read(path: Path):
    return path.read_text(encoding="utf-8").splitlines(keepends=True)


def process(path: Path, kind: str, truth=None):
    lines = read(path)
    if kind == "roadmap":
        return reconcile_roadmap(lines)
    return reconcile_state(lines, truth)


def kind_of(path: Path, hint: str | None = None):
    name = (hint or path.name).rsplit("/", 1)[-1]
    if name == "ROADMAP.md":
        return "roadmap"
    if name == "STATE.md":
        return "state"
    return None


def cmd_reconcile(args):
    """Structural pass over one file, in place. No counters recomputed — a
    merge driver runs mid-merge, when the rest of the tree is not yet
    consistent."""
    path = Path(args.file)
    kind = kind_of(path, args.path)
    if kind is None:
        return 0  # not a file we reconcile — leave the union result as is
    before = read(path)
    after, problems = process(path, kind)
    if after != before:
        path.write_text("".join(after), encoding="utf-8")
    for level, message in problems:
        if level == CORRUPT:
            print(f"  reconciled — {message}", file=sys.stderr)
    return 0


def cmd_repair(args):
    planning = Path(args.planning)
    truth = compute_truth(planning)
    if truth is None:
        print(f"✖ {planning}/ROADMAP.md not found", file=sys.stderr)
        return 2

    all_problems, changed = [], []
    for name, kind in (("ROADMAP.md", "roadmap"), ("STATE.md", "state")):
        path = planning / name
        if not path.exists():
            continue
        before = read(path)
        # compute_truth() counts DISTINCT phase keys, so it reads the same
        # before and after the roadmap is deduplicated — --check and a real
        # repair therefore always report the same counters.
        after, problems = (
            reconcile_roadmap(before) if kind == "roadmap" else reconcile_state(before, truth)
        )
        if after != before and not args.check:
            path.write_text("".join(after), encoding="utf-8")
        if after != before:
            changed.append(name)
        all_problems.extend(problems)

    corrupt = [m for level, m in all_problems if level == CORRUPT]
    advisory = [m for level, m in all_problems if level == ADVISORY]

    if not all_problems:
        print("✔ .planning/ is consistent")
        return 0

    if corrupt:
        verb = "union-merge damage found" if args.check else "repaired union-merge damage"
        print(f"{'✖' if args.check else '▶'} {verb} in {', '.join(changed) or '.planning/'}:")
        for message in corrupt:
            print(f"  • {message}")
    if advisory:
        print("• advisories (not merge damage — reported, never fail a check):")
        for message in advisory:
            print(f"  - {message}")
    if args.check and changed and not corrupt:
        # gsdt-doctor offers --fix only on this line: some advisories need a hand edit
        print(f"• a repair would update: {', '.join(changed)}")
    return 1 if (args.check and corrupt) else 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="gsd_planning", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    rec = sub.add_parser("reconcile", help="structural pass over one file, in place")
    rec.add_argument("file")
    rec.add_argument("--path", help="the file's repo-relative path (git's %%P)")
    rec.set_defaults(func=cmd_reconcile)

    rep = sub.add_parser("repair", help="reconcile + recompute counters")
    rep.add_argument("planning", help="path to the .planning directory")
    rep.add_argument("--check", action="store_true", help="report only; exit 1 if repair is needed")
    rep.set_defaults(func=cmd_repair)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
