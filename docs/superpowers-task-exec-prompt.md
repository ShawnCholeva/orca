  You are an autonomous engineer executing Task 1 of the Orca Agent Readiness
  implementation plan.
  
  Repo
  
  - Repo root: /home/shawn/projects/orca (TypeScript monorepo, pnpm workspaces).
  - Branch: main. Work directly on it (or in a worktree if your harness prefers).
  - Stack: TypeScript, Vitest, Fastify v5, Zod, better-sqlite3, Tauri v2 + React 18.
  - Test runners:
    - Daemon: cd apps/daemon && pnpm test -- <file>
    - Contracts: cd packages/contracts && pnpm test -- --run
    - Desktop: cd apps/desktop && pnpm test -- <file>
  - Typecheck: pnpm -r typecheck
  
  Inputs
 
  1. Implementation plan: docs/superpowers/plans/2026-05-22-agent-readiness.md
  2. Design spec (background only — do not re-derive design):
  docs/superpowers/specs/2026-05-22-agent-readiness-design.md
  3. Project context: CLAUDE.md at repo root.

  Your job
  Inputs

  1. Implementation plan: docs/superpowers/plans/2026-05-22-agent-readiness.md
  2. Design spec (background only — do not re-derive design):
  docs/superpowers/specs/2026-05-22-agent-readiness-design.md
  3. Project context: CLAUDE.md at repo root.

  Your job

  Execute only Task 1 from the plan. Do not start the next task. Do not refactor
  unrelated code. Do not change the plan.

  For Task 1:

  1. Read Task 1 in the plan file end-to-end before touching anything. Note its Files
   list and every checkbox step in order.
  2. Verify any prerequisite tasks (lower-numbered) are already done. If the tree is
  not in the expected state — required files missing, prior tests not passing, types
  from earlier tasks not exported — stop and report; do not paper over the gap.
  3. Execute the checkbox steps in order. Each step is meant to take 2–5 minutes. Treat
   the order as load-bearing:
    - Write the failing test first.
    - Run it and confirm it fails with the expected error.
    - Implement.
    - Run it and confirm it passes.
    - Commit with the exact commit message the plan specifies.
  4. Use the exact code shown in each step. The code blocks in the plan are not
  pseudocode. If you find a real defect (compile error, missing import, wrong API), fix
   the smallest thing needed to make the test pass and note the deviation in your
  report. Do not silently rewrite.
  5. Some tasks (Task 7, Tasks 8–10) intentionally do not commit — they leave the tree
  dirty until a later task. Honor that. Do not invent commits.
  6. Stay scoped. Files listed under "Files:" are the only ones you should
  create/modify. Touching anything else requires a one-line justification in your
  report.

  Verification gates
  
  Before claiming the task is complete, run every command the task names in its
  checkbox steps and confirm the expected output. Specifically:

  - Test commands must show the expected pass/fail at each step.
  - Typecheck commands (if listed) must pass.
  - The final commit (if the task commits) must be on branch with the message the plan
  specifies, no --no-verify, no --amend.

  If a step's "Expected" output does not appear, stop and report. Do not retry blindly.

  Out of scope
 
  - New features beyond what Task 1 describes.
  - Refactors of unrelated code.
  - Editing the plan or the spec.
  - Pushing to remote.
  - Skipping hooks or signing.

  Report at the end
  
  When Task 1 is done (or you stopped), report in this exact shape:

  Task: 1
  Status: completed | blocked | partial
  Commit SHA: <sha or "none — task does not commit per plan">
  Files changed: <list>
  Tests run: <command + result>
  Deviations from the plan: <none, or short list with reasons>
  Next task suggested: {N+1} | none — blocked by <reason>

  Be terse. The plan is the source of truth — don't restate it back at me.