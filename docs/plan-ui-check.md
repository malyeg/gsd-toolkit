# Plan: UI checks that look at the rendered page (0.4.0)

Status: **built in 0.4.0** (revision 2). Written 2026-09-27, revised the same day
after the review in `docs/plan-ui-check-review.md` (31 findings; the accepted
ones are marked `[#n]` below). Builds on the UI gates from 0.3.0 / 0.3.1
(`docs/ui-quality-plan.md`, `lib/ui.sh`, `bin/gsdt-ui`).

## Problem

Phases with screens still ship weak pages, even when `/gsd-ui-phase` and
`/gsd-ui-review` ran. Example: a blog list page (l4h-website, phase 7) that
passed the UI spec — colors, fonts and spacing were right — and still had:

| Seen on the page | Kind |
|---|---|
| Footer titles in mixed casing ("PRODUCTS" / "Experiments") | visible in a screenshot |
| Stray white boxes beside each footer title | visible in a screenshot |
| One footer column wrapped alone onto a second row | visible in a screenshot |
| Small white text on teal, about 3:1 contrast (needs 4.5:1) | measurable |
| Text under 12px (tags, dates, header buttons) | measurable |
| Flat hero: a color block with one word | layout decision |
| Four equal cards, no featured post, no way to browse topics | layout decision |
| Footer heavier than the content | layout decision |
| Thumbnails are raw 3D screenshots; one is mostly blank | content / art direction |

What 0.3.x covers: one design system (`DESIGN.md`), a chosen sketch per phase
(`<P>-LAYOUT.md`, with `url:` since 0.3.1), screenshots before ui-review
(`gsdt-ui shots`, `<P>-SHOTS.md`).

What is still open:

1. Nothing **measures** the rendered page.
2. The agent is only *told* to look at the screenshots. Nothing records that
   it did, or what it saw.
3. The user has no fast way to judge the result before `gsdt-finish`.
4. The layout rules are a few lines of prose, not a checklist.

## Goals and non-goals

Goals: catch measurable breakage automatically; make the agent go through a
fixed checklist against each screenshot and write down what it saw; give the
user a 30-second look and record the approval; keep all of it provider-neutral
and optional (`ui_gates`).

Non-goals: judging beauty automatically; mobile apps (React Native / Expo —
web only); pixel-diff visual regression; seeding app data; starting the app
(the agent starts it, as today).

## Scope

| Release | What |
|---|---|
| **0.4.0** | the runner (module lookup, capture id, staged output), checks C1–C8, waivers, the sheet, the look file, the approval, the finish gate, shared predicates, the instruction text, a real-browser CI job |
| **0.4.1** | pages behind a login (`ui_auth`), add-on suggestions in doctor |

Waivers moved from 0.4.1 into 0.4.0: without them one false alarm locks a
phase under `ui_gates = strict`.

## Design

### 1. The files of a phase with screens

| File | Written by | Holds |
|---|---|---|
| `<P>-LAYOUT.md` | the agent, with the user | `sketch:`, `pages:`, `url:`, and new: `app:`, `main_button:`, `expect:`, `waive:` |
| `<P>-UI-CHECK.md` | `gsdt-ui check` | the machine result of one capture `[#27]` |
| `<P>-SHOTS/` | `gsdt-ui check` | the pictures and the sheet (`index.html`); never committed |
| `<P>-UI-LOOK.md` | `gsdt-ui look`, then the agent | what the agent saw, per picture and rule `[#27]` |
| `<P>-UI-APPROVAL.md` | `gsdt-ui approve` | the user's yes, naming the capture `[#30]` |

New LAYOUT lines (each may repeat):

```
app: apps/web                          # where Playwright is installed [#3]
main_button: /blog = Read the guide    # per page; text, css=<selector>, or none [#17]
expect: /blog = Latest posts           # text that must be visible [#18]
waive: C3 | /blog | 375 | .brand-tag | brand color, agreed with <user> [#31]
```

`main_button:` and `expect:` without `<page> =` apply to every page.

### 2. The capture id and staleness `[#4]`

- One run of `gsdt-ui check` = one **capture**. Its id is a hash of the
  pictures it took (names + content). Same pictures → same id.
- `<P>-UI-CHECK.md` records `capture:` and `code:` — a hash of the working
  tree outside `.planning/` at capture time (committing the same content does
  not change it), plus `+` a hash of `<P>-LAYOUT.md` (what was checked: pages,
  url, main_button, expect, waive). A check written before 0.4.10 holds the
  code hash only and is compared on that.
- `<P>-UI-LOOK.md` and `<P>-UI-APPROVAL.md` name the capture they belong to.
- **Stale** means: the code or the LAYOUT changed since the check (`code:` differs), or the
  look / approval names another capture.
- After a code change the agent re-runs `gsdt-ui check`. When the pages look
  the same, the capture id is the same, and the look and the approval stay
  valid. When a page changed, the look and the approval open again.

### 3. `gsdt-ui check <N>` — measure the rendered page

- Runs `lib/ui-check.mjs` with Node and the **project's** Playwright. The
  toolkit installs no browser.
- **Module lookup `[#1][#3]`.** A toolkit-owned script cannot `import` the
  project's packages, so the runner resolves `playwright` (then
  `@playwright/test`) with `createRequire` anchored at a package root:
  `GSD_PLAYWRIGHT_ROOT`, then `app:` in LAYOUT, then the repo root, then
  `apps/*` and `packages/*`. Several different installs and no `app:` → it
  refuses and asks for `app:`. The path and version go into the report.
- **Trust `[#21]`.** The runner launches the project's own Playwright, so it
  runs project code with the user's rights — the same trust as the project's
  test suite. It never loads the project's Playwright config. `gsdt-doctor`
  never imports or launches anything; it only looks at files.
- Pages and address come from LAYOUT (`pages:`, `url:`) and `ui_url`, as
  `gsdt-ui shots` resolves them. Sizes: 375×812, 768×1024, 1440×900.
- **Readiness `[#19]`.** Per page: wait for `load`, scroll the page once (lazy
  images), wait for fonts and images, then for the `expect:` text. One fixed
  time budget per page (30 s). Animations are turned off.
- Checks:

  | Id | Check | Result |
  |---|---|---|
  | C1 | the page scrolls sideways (more than 1px); names the widest element `[#11]` | failure |
  | C2 | possible clipped text `[#12]` | question for the look file |
  | C3 | contrast, by a pinned `axe-core` shipped with the toolkit `[#29]` | violations = failures; "could not measure" = question `[#13]` |
  | C4 | visible text under `ui_min_font` (default 12px). Visibility is measured on the rendered element, not read from `aria-hidden` or class names `[#14]` | failure |
  | C5 | broken `<img>` images (CSS backgrounds are out of scope) `[#15]` | failure |
  | C6 | uncaught page errors = failure; console errors are listed only `[#16]` | failure / listed |
  | C7 | the page's `main_button:`: exactly one match, inside the first screen, not covered (5 points) `[#17]` | failure; `none` = not applicable; no line = **not checked** |
  | C8 | load failed, HTTP >= 400, landed on another address (login redirect), or the `expect:` text is missing `[#18]` | failure |

- "Not checked" is never a pass: it is counted in `unchecked:`, and under
  `ui_gates = strict` the status is `failed`.
- Messages in the committed report are cut to 200 characters `[#16]`.
- **Staged output `[#7]`.** A run writes into `<P>-SHOTS/.run/`. Only a
  complete run is published (pictures, sheet, `<P>-UI-CHECK.md`). A run that
  could not finish records `status: error` and removes the old pictures, so
  an old pass never stays in place.
- **Waivers `[#31]`.** `waive: <check> | <page> | <size> | <target> | <reason>`
  in LAYOUT; `*` matches any page, size or target. A waived finding is
  listed, not counted. A malformed line stops the run. No expiry: a waiver
  lives and ends with its phase.
- `<P>-UI-CHECK.md`:

  ```
  ---
  status: passed | failed | error | skipped
  capture: 3f9a1c20be71
  taken: 2026-09-27T10:00:00Z
  code: <hash>
  url: http://localhost:3007
  runner: playwright 1.55.0 (apps/web)
  axe: 4.10.2
  failures: 3
  waived: 1
  questions: 2
  unchecked: 0
  ---
  ## Shots / Failures / Waived / Questions / Not checked / Listed
  - C3 | /blog | 375 | .hero p | contrast 3.1:1 (needs 4.5:1)
  ```

- Exit codes: 0 passed, 1 failed checks, 2 could not run.
- `gsdt-ui check <N> --skip "<reason>"` records `status: skipped` `[#9]`.
- `gsdt-ui shots` stays for manual use (Playwright CLI, no checks) `[#28]`. It
  now finds the CLI in `app:`, `apps/*` and `packages/*` too, and gives
  pictures a hashed name.

### 4. Screenshot sheet

`gsdt-ui check` writes `<P>-SHOTS/index.html`: the result on top, every
picture grouped by page, the chosen sketch named beside them. A static file,
git-ignored like the PNGs. Every text is HTML-escaped; picture names carry a
hash of the page path, so `/a/b` and `/a-b` never collide `[#23]`.
`gsdt-ui sheet <N>` prints its path (and opens it on a terminal).

### 5. Rules checklist `[#24]`

Defaults, defined once in `lib/ui.sh`. A project edits them in `DESIGN.md`
(`## Layout rules`, lines `- R<n>: <rule>`); the stub carries the defaults.

| Id | Rule |
|---|---|
| R1 | One main focus per screen |
| R2 | The main button is on the first screen, never covered |
| R3 | More than ~12 items → search, filters or tabs |
| R4 | One alignment system per page |
| R5 | Consistent title casing |
| R6 | Header and footer are lighter than the content |
| R7 | No large empty areas; cards in a row have equal structure |
| R8 | Images: same shape and treatment; no blank or near-empty images |
| R9 | Nothing wraps alone onto its own row at any size |
| R10 | Matches the chosen sketch: same sections, same order |

### 6. `<P>-UI-LOOK.md` — what the agent saw `[#8]`

- `gsdt-ui look <N>` writes the template for the current capture: one section
  per picture (page × size), one line per rule, plus one line per question
  from the check (C2, C3 "could not measure").
- The agent opens each picture and answers each line:
  `ok — <what it saw>`, `fixed — <what was wrong, what changed>`,
  `bad — <what is wrong>`, `n/a — <why>`.
- Complete = the file names the current capture, **every** (picture, rule)
  and question has an answer with text, and none is `bad`. The expected set
  comes from `<P>-UI-CHECK.md` and the rule list, not from the look file, so
  deleting lines does not pass.
- On a new capture the template is written again; the old answers are kept
  beside each line as `was:`.
- This cannot prove the agent looked. It forces a written claim per picture
  and rule that the user and ui-review can hold against the sheet.

### 7. Approval `[#30][#9]`

- `gsdt-ui approve <N>` writes `<P>-UI-APPROVAL.md` (`status: approved`,
  `capture:`, `by:`, `approved:`). It refuses unless the check passed and the
  look is complete for that capture.
- `gsdt-ui approve <N> --waive "<reason>"` records `status: waived` — the user
  chose not to look, or there are no pictures (check skipped).
- Three separate records, each needing the user's yes: a skipped check
  (no runner, or the pages cannot be captured), and a waived approval.

### 8. Flow, guard, finish, doctor `[#5][#6][#10]`

Order for a phase with screens, after code review:

```
ui-check → ui-look → ui-approve → ui-review
```

| Step | Done when | Command |
|---|---|---|
| `ui-check` | `<P>-UI-CHECK.md` is `passed` (or `skipped`) and not stale | `gsdt-ui check <N>`; on failure fix the code and re-run |
| `ui-look` | `<P>-UI-LOOK.md` complete for the capture | `gsdt-ui look <N>`, then the agent fills it |
| `ui-approve` | `<P>-UI-APPROVAL.md` names the capture (or is waived) | the agent shows the sheet and **stops for the user**; on a yes: `gsdt-ui approve <N>` |
| `ui-review` | `<P>-UI-REVIEW.md` (as today) | `/gsd-ui-review <N>` |

- **One shared answer.** `gsd_ui_gate` in `lib/ui.sh` names the first open UI
  step. `gsdt-flow-next`, the guard, `gsdt-finish` and doctor all ask it.
- **Old phases `[#5]`.** A phase is left alone only when its
  `<P>-UI-REVIEW.md` is already on the base branch. A review written in the
  phase's own worktree exempts nothing.
- **Modes:**

  | | `off` | `warn` (default) | `strict` |
  |---|---|---|---|
  | `gsdt-flow-next` shows the steps | no | yes | yes |
  | the guard blocks `/gsd-ui-review` | no | no | yes |
  | `gsdt-finish` | nothing | prints a warning | refuses (`GSD_SKIP_GUARD=1` is the escape) |
  | `gsdt-doctor`, merged phases | nothing | nothing | T040: `ui-check`, `ui-approve` |
  | `gsdt-doctor`, committed pictures | nothing | note | T081 `[#22]` |

- Doctor's UI debt no longer needs `flow = strict`; `flow_since` and
  `flow_skip` still limit it. A phase merged with a 0.3.x `<P>-SHOTS.md` is
  not in debt.
- Doctor notes are listed in `--json` (`"notes"`) `[#25]`.
- The instruction text in `lib/provider.sh` names the new steps. After the
  update T016 flags each project until `gsdt-doctor --fix` refreshes it
  `[#25]`.

### 9. Config, codes, docs, tests

- `.gsd.conf`: `ui_min_font` (8–32; T018 on a bad value).
- Environment: `GSD_PLAYWRIGHT_ROOT`, `GSD_UI_RUNNER` (tests).
- Tests `[#26]`: flow, guard, finish and doctor states from fixture files and
  a stub runner; `tests/test-ui-browser.sh` runs the real runner against
  fixture pages for C1–C8 in a CI job that installs Chromium (it skips
  without `GSD_PLAYWRIGHT_ROOT`); `node --check lib/ui-check.mjs` in the
  syntax step.
- Docs: `docs/features.md`, `docs/providers.md`, `docs/ui-quality-plan.md`,
  README, CLAUDE.md, `docs/command-order.html`, the `gsdw-flow` skill,
  CHANGELOG `## 0.4.0`.

## Later (0.4.1)

- **Pages behind a login `[#20]`.** `ui_auth = <path>`: a Playwright
  `storageState` file made by the project's own login script. It holds login
  secrets: the toolkit passes it to the browser, refuses a tracked file, and
  never copies it into a report.
- **Add-on suggestions in doctor:** built in 0.4.1 as Impeccable + the shadcn
  MCP (Tailwind / `components.json`). MUI and Figma MCPs left out until their
  setup can be checked.

## Not adopted (from the review)

- Per-tool version and config fingerprints: the capture id plus the code hash
  is enough.
- `storageState` schema and origin validation: the browser scopes cookies by
  origin; the real risk is a committed file.
- Waiver expiry: a waiver ends with its phase.

## Risks

- **False alarms** in C4 and C3. Mitigation: rendered-visibility tests,
  waivers.
- **More steps.** Three before ui-review, one needs the user. Mitigation:
  `warn` default, `--skip`, `--waive`; an unchanged page keeps its approval.
- **A new language** (Node, next to bash / Python / Perl). Playwright needs
  Node anyway; the parked TypeScript port moves everything to Node.
- **The look file can be filled without looking.** Accepted: it is a record;
  the user's approval of the sheet is the gate.
- **Pages that change on every load** (dates, random content) get a new
  capture id each run, so the approval opens again. Accepted.
