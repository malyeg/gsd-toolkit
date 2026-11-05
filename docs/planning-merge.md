# The `.planning/` merge problem

Why `ROADMAP.md` and `STATE.md` get their own merge driver, and the three
layers that keep them correct when phases finish in parallel.

`ROADMAP.md` and `STATE.md` are shared state that parallel phase sessions all
write to, so they merge automatically instead of conflicting. The original
strategy was git's built-in `union` — keep both sides — which is right for the
append-only parts of those files and wrong for every line that is a single
source of truth. When a phase branch flipped `- [ ] **Phase 11**` to `- [x]`
and the base branch had also touched the adjacent line, union kept both, and
the roadmap ended up claiming Phase 11 was simultaneously complete and not
started. The frontmatter went the same way: two `status:`/`stopped_at:` values
and two full sets of progress counters.

The fix is three layers, because the damage has three entry points:

1. **`merge=gsd-planning`** (the driver) — union first, so nobody loses their
   additions, then reconcile. Keyed content (checklist entries, progress rows,
   `### Phase N` sections) collapses to one per phase, keeping the position of
   the phase's *first* occurrence and the content of its *best* one — `[x]`
   beats `[ ]`, a real status beats "Not started", and among equals the longer
   line wins because it carries the `(completed <date>)` suffix. Keeping the
   later line instead would push phases out of numeric order, which is exactly
   what happened in one hand repair. Single-value lines collapse to their last
   copy, which is the incoming branch's, because union writes ours-then-theirs.
2. **`gsd-planning-repair`** — run by `gsd-finish` after *both* of its merge
   points (the phase merge, and the `pull` on the push-retry path, which fires
   precisely when a parallel session moved the base branch), and by the
   `post-merge` hook for plain `git pull`. It redoes the structural pass and
   then recomputes the progress counters, which a merge cannot get right by
   picking a side: after one real phase-11 merge the two candidates were
   30 phases/12 complete/96 plans and 28/11/103, and the truth was 30/13/111.
   Counters come from the roadmap's `### Phase` headings and `- [x] **Phase`
   entries, and from `.planning/phases/*/*-PLAN.md` and `*-SUMMARY.md` on disk.
3. **`gsd-planning-repair --check`** — the CI guard, so a corrupted file cannot
   reach the shared branch unnoticed:

   ```yaml
   - uses: actions/checkout@v4
   - run: |
       git clone --depth 1 https://github.com/malyeg/gsd-toolkit.git /tmp/gsd
       /tmp/gsd/bin/gsd-planning-repair --check
   ```

   It exits 1 only on union-merge damage. Drift that merging did not cause — a
   stale counter, a phase missing from the progress table, a table row
   `/gsd-fast` appended past EOF — is reported as an advisory and never fails
   the check.

**What the repair never touches:** STATE.md's `## Session Continuity` section.
Its `Last session:` / `Stopped at:` / `Resume file:` lines are one entry per
past session and legitimately repeat, so every single-value dedupe is scoped to
the block that owns the field (`## Current Position`, the velocity block, the
frontmatter). A global keep-the-last-occurrence pass deletes real history — an
early hand-written attempt at this destroyed seven entries that way, and
`tests/test-planning-reconcile.sh` asserts that section stays byte-identical.

**Fallbacks.** Merge drivers live in git config, which is not versioned, so a
clone that never ran `gsd-init` gets plain union — the repair fixes
that afterwards, and the test suite covers the no-driver path explicitly.
Without `python3`, the driver does the plain union and warns; that is exactly
today's behaviour, never worse.

