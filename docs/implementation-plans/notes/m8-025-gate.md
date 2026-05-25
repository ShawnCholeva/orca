# M8-025 Gate - Engineering Workflow Proof Loop

Date: 2026-05-25
Reviewer: Codex
Baseline note: `docs/implementation-plans/notes/m8-000-baseline.md`
Gate SHA: `c436d7a10449b563d2122a9c281afc78021f48b7`

## Scope

Gate 4 verifies the end-to-end Engineering workflow proof loop, including the
required restart sub-test, then confirms the required full-suite regression
gate is green before the milestone documentation pass.

## Validation Runs

- `pnpm --filter @orca/daemon test workflow-engineering-loop` -> exit 0
  - `apps/daemon`: `Test Files 1 passed`; `Tests 1 passed`
- `pnpm -r typecheck` -> exit 0
  - `packages/contracts` passed
  - `apps/daemon` passed
  - `apps/desktop` passed
- `pnpm -r test` -> exit 0
  - `packages/contracts`: `Test Files 3 passed`; `Tests 65 passed`
  - `apps/desktop`: `Test Files 33 passed`; `Tests 303 passed`
  - `apps/daemon`: `Test Files 124 passed | 7 skipped`; `Tests 1349 passed | 8 skipped`
  - Totals: `Test Files 160 passed | 7 skipped`; `Tests 1717 passed | 8 skipped`

## Gate Checks

- Added `apps/daemon/src/__tests__/workflow-engineering-loop.test.ts` to drive:
  - Goal creation with persisted orchestrator provider/model
  - Engineering workflow start with atomic run + first step creation
  - Intake question loop and advance recommendation acceptance
  - Research, PRD, Issue Breakdown, Execution, QA, Review, and Done progression
  - generator-task creation linked to `workflow_step_run_id`
  - launch recommendation acceptance with simulated session completion + M5 summaries
  - final workflow completion through the existing recommendation accept-flow
- Restart sub-test restarts the daemon between Research and PRD, verifies the
  run remains resumable, and completes the loop after restart.
- Assertions cover:
  - `workflow_runs.status='completed'`
  - all 8 step runs persisted as `passed`
  - required artifacts and workflow decisions present through REST projections
  - `workflow_llm_calls` schema remains metadata-only
  - happy-path workflow events are present, content-free, and within the 4 KiB cap

## Outcome

Gate is green. M8-026 can proceed.
