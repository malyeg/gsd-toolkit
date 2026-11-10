# UI quality plan

Follow-up: **0.4.0** adds the check of the rendered pages, the look file and
the approval — see [plan-ui-check.md](plan-ui-check.md). `gsdt-ui check`
replaces `gsdt-ui shots` as the flow step.

Status: **built in 0.3.0** (2026-09-26). Items 1–7 below are in `lib/ui.sh`,
`bin/gsdt-ui`, `gsdt-flow-next`, the guard (rule 5), doctor (T080) and bootstrap.
The answers to the open questions are at the end. Written 2026-09-25.

## Problem

Projects built with GSD + this toolkit ship ugly screens, even when the UI
phase runs. It is not only colors and fonts: **page layout** is the main
failure. Example seen: a catalog page with a weak hero, a flat wall of ~45
identical cards (no search / filter / tabs), tiny look-alike thumbnails,
half-empty cards, mixed alignment, and the main CTA hidden behind the cookie
banner.

## Root causes

1. **The UI-SPEC has no layout section.** Upstream template
   `~/.claude/get-shit-done/templates/UI-SPEC.md` covers Design System, Spacing,
   Typography, Color, Copywriting, Registry Safety. No wireframe, no page
   structure, no hierarchy / main focus, no "how does the user find things".
   `ui-review` checks the code against that spec, so a badly laid-out page
   passes.
2. **The agent never sees the page.** `ui-review` reads code; nothing renders
   and screenshots the result.
3. **No visual reference.** Words like "clean, modern" let the model fall back
   to the average web look (Anthropic calls it "distributional convergence").
4. **No shared design system across phases.** Parallel worktree phases each
   invent their own styles, so the combined app looks inconsistent.

Already in place (don't rebuild): `gsdt-flow-next` requires `<P>-UI-REVIEW.md`
for phases with screens (`bin/gsdt-flow-next`, step `ui-review`), the guard enforces it
(`bin/gsdt-worktree-guard`, `gsd-secure-phase` rule), and doctor reports it (`bin/gsdt-doctor`, T040 report).

## Manual recipe (works today, no toolkit change)

### Once per project

1. Install tools (Claude):
   ```
   /plugin marketplace add anthropics/claude-code
   /plugin install frontend-design@claude-code-plugins
   claude mcp add playwright npx @playwright/mcp@latest
   ```
2. Save 3–5 screenshots of real apps you like in `.planning/design/refs/`
   (Mobbin, Refero, or sites you use).
3. **Phase 1 = design system**: tokens (color, type, spacing), base components
   (seed from shadcn/Radix), **page templates** (list, detail, form,
   dashboard), and one `DESIGN.md` index of all of it.
4. Project `CLAUDE.md` rule: "All UI must use `DESIGN.md` components and page
   templates. Don't invent new styles."

### Every phase with screens

1. discuss-phase: name the page template and the reference it should feel like.
2. `/gsd-sketch` **before** the spec; pick one mockup = the layout contract.
3. `/gsd-ui-phase`, telling it: "Follow `DESIGN.md` and the chosen sketch. Add a
   layout section: sections top to bottom, the one main focus, the main
   button."
4. plan + execute.
5. Screenshot loop: "Open the page with Playwright at 375, 768 and 1440px.
   Compare to the sketch. Fix differences. Repeat until it matches."
6. `/gsd-ui-review`, then a 30-second human look before `gsdt-finish`.

Layout rules worth putting in every spec: one main focus per screen; more than
~12 items needs search / filters / tabs; main CTA visible on the first screen
and never covered by overlays; one alignment system per page; consistent
title casing.

## Toolkit plan (to build)

Constraint: the core must stay provider-neutral (CLAUDE.md "Core vs
adapters"). Agent-specific tools go through `lib/provider.sh` / bootstrap and
stay optional.

| # | Item | Where | Kind |
|---|------|-------|------|
| 1 | **gsdt-init sets up design** — creates `.planning/design/refs/` + stub `DESIGN.md`, adds the "all UI uses DESIGN.md" rule to the generated instructions, and tells the init session that phase 1 is "Design system". `--no-ui` skips it for backend/CLI projects. gsdt-init only **prepares**; the design system is **built** in a normal phase (it is real code that needs review, tests and a merge). Updates later = a normal phase. | `bin/gsdt-init`, `gsdt-bootstrap-repo`, `.gsd/INSTRUCTIONS.md` block | core |
| 2 | **Design-system gate** — before the first `ui-phase`, require `DESIGN.md` to be filled (not the stub). Doctor warns when missing. | `gsdt-flow-next`, guard, doctor | core |
| 3 | **Sketch gate** — a phase with screens can't reach `plan-phase` until a chosen sketch exists. | `gsdt-flow-next`, guard, doctor | core |
| 4 | **Layout file** — toolkit-owned `<P>-LAYOUT.md` (sections, main focus, main CTA, template used, reference). We can't edit the upstream UI-SPEC template, so the layout lives here. | flow + templates | core |
| 5 | **Screenshot step** — `scripts/gsd-ui-shots.sh` using the Playwright CLI (not MCP, so any provider works) saves screenshots at 375/768/1440 into the phase dir; `ui-review` step requires them. | new shim/script, flow | core |
| 6 | **Layout check in ui-review** — the review must compare the screenshots with the sketch and the layout rules above. | flow step reason / instructions | core |
| 7 | **Optional provider extras** — bootstrap offers `frontend-design` (Claude) and Playwright MCP per provider that supports it; doctor reports missing as info (new `T0xx`), never blocks. | `lib/provider.sh`, bootstrap, doctor | adapter |
| — | Lint rules (no raw hex, no arbitrary sizes) and removing `className` escape hatches | project-side, stack-specific | docs only |

Invariant reminder: the phase-flow artifact list is shared by `gsdt-flow-next`,
the guard's `flow = strict` rule and doctor's T040 report — items 2–5 must
change all three together, with tests in `tests/test-flow-next.sh` and
`tests/test-worktree-guard.sh`.

### Decisions (built in 0.3.0)

- **Chosen sketch:** `sketch: <folder>` in `<P>-LAYOUT.md`, and that folder's
  `README.md` (written by `/gsd-sketch`) has a `winner:` that is not `null`.
  `sketch: skip <reason>` is an explicit opt-out, only with the user's OK.
- **Stub vs filled DESIGN.md:** the stub has a `<!-- gsd:design-stub … -->`
  line; filled = that line is gone.
- **App address and pages:** `ui_url` in `.gsd.conf`, default
  `http://localhost:{port}`. `{port}` is the phase's derived port (base from the
  `gsdt-derive-port.sh <base>` dev script); `{port:<base>}` writes the base in
  the URL. A fixed URL works but parallel phases then share one app. Pages come
  from `pages:` in `<P>-LAYOUT.md`. Projects with several apps (e.g. two
  portals on 3000 and 3100) name the phase's app with `url:` in
  `<P>-LAYOUT.md`, which wins over `ui_url` (0.3.1). The screenshot step is one command,
  `gsdt-ui shots` (not a shim), using the Playwright CLI.
- **On by default?** `ui_gates = warn` (default): `gsdt-flow-next` shows the
  steps, doctor notes; `strict`: the guard blocks too and doctor reports T080;
  `off`: none of it (`gsdt-init --no-ui`). Phases whose UI-SPEC was written
  before 0.3.0 skip the two pre-spec steps.
- **gsdt-init does not create `.planning/design/`:** an existing `.planning/`
  switches `/gsd-ingest-docs` into merge mode. The stub is created by the
  flow's design-system step (`gsdt-ui design`); the instructions tell a new
  project with screens to make phase 1 "Design system".
- **Screenshots are not committed:** the PNGs sit in `<P>-SHOTS/` (with its own
  `.gitignore`); `<P>-SHOTS.md` is the committed record.

## Sources

- [Improving frontend design through Skills (Anthropic)](https://claude.com/blog/improving-frontend-design-through-skills)
- [Tips for getting LLMs to write good UI](https://sampiercelolla.com/tips-for-getting-llms-to-write-good-ui-code/)
- [Claude Code screenshot verification with Playwright MCP](https://qaskills.sh/blog/claude-code-screenshot-frontend-verification-mcp)
- [Claude + shadcn + Playwright MCP case study](https://medium.com/@karthikmulugu/i-let-claude-design-my-entire-website-using-shadcn-magic-ui-and-playwright-mcp-heres-what-ad24860b705b)
- [AI UI design reference sites (Mobbin, Refero, 21st.dev)](https://griffinwooldridge.com/blog/ai-ui-design-reference-sites)
- [Frontend Design Skill: why your UIs still look AI-generated](https://wmedia.es/en/tips/claude-code-frontend-design-skill)
- [GSD features (ui-phase / UI-SPEC)](https://github.com/gsd-build/get-shit-done/blob/main/docs/FEATURES.md)
