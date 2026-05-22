You are an autonomous engineer executing the Wrap-up section of the Orca Agent
Readiness implementation plan.

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
2. Design spec (background only - do not re-derive design):
   docs/superpowers/specs/2026-05-22-agent-readiness-design.md
3. Project context: CLAUDE.md at repo root.

Your job

Execute only the Wrap-up section from the plan. There is no Task 21 in this plan.
Do not start unrelated work. Do not refactor unrelated code. Do not change the
plan or spec.

For Wrap-up:

1. Read the Wrap-up section end-to-end before touching anything.
2. Verify Task 20 is already committed with:
   `test(daemon): gated real auth-status smoke tests`
3. Run the exact automated verification command named in Wrap-up:
   `pnpm -r typecheck && pnpm -r test`
4. Perform the manual onboarding walkthrough from Wrap-up if your environment can
   run the desktop app. If it cannot, stop after automated verification and report
   the blocker clearly.
5. Do not commit unless the Wrap-up section or the user explicitly asks for a
   commit.

Context from Tasks 1-20 (already done):

- Readiness contracts are exported from packages/contracts/src/index.ts.
- ClaudeCodeAdapter, CodexAdapter, OpenCodeAdapter, GeminiAdapter, and
  ShellManualAdapter exist and are registered.
- ReadinessService persists reports and daemon readiness endpoints exist.
- Desktop onboarding renders real readiness rows with retry and continue-anyway
  behavior.
- NoReadyAgentsBanner is mounted after onboarding when zero connected agents are
  ready.
- Task 20 added gated real auth-status smoke tests for Claude, Codex, and
  OpenCode.

Verification gates

Before claiming Wrap-up is complete, run every command the Wrap-up names and
confirm the expected output. Specifically:

- `pnpm -r typecheck && pnpm -r test` must pass.
- Manual walkthrough steps must be reported as passed, skipped, or blocked with
  concrete reasons.
- If a verification command fails, stop and report. Do not paper over the gap.

- Run /code-review, if there are issues found fix them.

Out of scope

- New features beyond the Wrap-up section.
- Refactors of unrelated code.
- Editing the plan or the spec.
- Pushing to remote.
- Skipping hooks or signing.

Report at the end

When Wrap-up is done (or you stopped), report in this exact shape:

Task: Wrap-up
Status: completed | blocked | partial
Commit SHA: none - wrap-up does not commit per plan
Files changed: <list>
Tests run: <command + result>
Deviations from the plan: <none, or short list with reasons>
Next task suggested: none - plan complete | none - blocked by <reason>
