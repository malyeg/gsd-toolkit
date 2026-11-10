// Generated once from lib/provider.sh (the bash heredocs); the text is the
// contract — tests/ts/p1-parity.test.ts compares it byte for byte with the
// bash functions. Edit lib/provider.sh and this file together while both exist.

export const RULES_BASE = `# GSD worktree workflow

The shell commands are the source of truth. One feature equals one phase and
worktree. Several configured providers may hand the same phase between their
sessions; only one session may mutate that worktree at a time. Run \`gsdt-list\`
before claiming work; attach or hand off with
\`gsdt-start -p <N>\` or claim new work with \`gsdt-start -n "<desc>"\`.

Inside the worktree, run \`gsdt-flow-next <N>\` before every phase action:
ticket (with a tracker) → discuss → UI decision → with screens: design
system, layout (sketch), UI phase → plan → independent review → replan →
execute → verifier/gap loop → verify work → code review/fix → with screens:
UI check, UI look, UI approval, UI review → security → done. The human decisions are discuss,
the design system and sketch, UI approval, and review findings. Never bypass a guard unless the user explicitly requests
\`GSD_SKIP_GUARD=1\`.

\`gsdt-finish\` is never automatic. Run it only with explicit user intent and as
the final action because it removes the worktree. Provider hooks are early
feedback only; \`gsdt-flow-next\` invokes the mandatory neutral guard. Arbitrary
shell commands outside GSD are outside this enforcement boundary.

For several quick tasks or a fix brief, tell the user to run
\`gsdt-batch '<task list or brief>'\` in a terminal (the script, not the skill):
it makes a \`batch-*\` worktree and a fresh, cheaper session there. Never
\`/gsd-quick-batch\`. \`/gsdt-batch\` only works inside a \`batch-*\` worktree.
`;

export const RULES_SCREENS = `
Screens: every screen uses the design system in \`.planning/design/DESIGN.md\`
(tokens, components, page templates) — don't invent new styles. In a new
project with screens, make the first phase "Design system". Each phase with
screens picks a layout with \`/gsd-sketch\` before its UI-SPEC and records it in
\`<P>-LAYOUT.md\`. After the code review, look at the built pages, not only the
code: \`gsdt-ui check <N>\` opens them in a browser, measures them and takes the
pictures; \`gsdt-ui look <N>\` lists what to answer for every picture — open each
one and write what you saw; then show the user the sheet (\`gsdt-ui sheet <N>\`)
and run \`gsdt-ui approve <N>\` only after their yes. Never waive a finding or
skip a step without asking. \`gsdt-flow-next\` asks for each step (\`ui_gates\` in
\`.gsd.conf\`).
`;

export const CANONICAL_PREFIX = `<!-- gsd-toolkit:canonical:start -->
# GSD worktree workflow

This repo uses gsd-toolkit. Its full rules come from the installed toolkit:
run \`gsdt-rules\` and follow its output (Claude Code loads it when a session
starts). If \`gsdt-rules\` is not found, install the toolkit:
https://github.com/malyeg/gsd-toolkit#install

These hold even without the toolkit (a teammate, CI, a cloud session):
- One phase = one \`phase-<N>-<slug>\` git worktree; the main checkout stays
  on the base branch.
- Run \`gsdt-flow-next <N>\` before every phase action and follow it.
- \`gsdt-finish\` is never automatic: run it only when the user asks, as the
  last action (it removes the worktree).
- Never bypass a guard unless the user explicitly asks for \`GSD_SKIP_GUARD=1\`.

`;

export const CANONICAL_SUFFIX = `<!-- gsd-toolkit:canonical:end -->
`;

export const ENTRY_TEMPLATE = `<!-- gsd-toolkit:provider:start -->
## GSD worktrees (@@M@@ adapter)

Read and follow \`.gsd/INSTRUCTIONS.md\` (this repo's settings and core rules).
@@HOW@@
Use the \`gsdt-flow\` skill when it is available; otherwise run
\`gsdt-flow-next <N>\` and follow each printed action.
For toolkit command syntax and workflow order, this marked adapter and the
canonical document supersede older unmarked GSD text in this file. Continue to
follow repository-specific policy from that older text.
<!-- gsd-toolkit:provider:end -->
`;

export const ENTRY_HOW_DEFAULT = `Before any GSD or phase work, run \`gsdt-rules\` and follow its output: it prints
the toolkit's rules for the installed version.`;
