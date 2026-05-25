# M9-000 Baseline Verification (M8 Green Baseline)

Date: 2026-05-25

## Commands Run

- `pnpm install --frozen-lockfile`
- `pnpm -r typecheck`
- `pnpm -r test`

## Baseline Commit

- `git rev-parse HEAD`: `c012ed60ed4865dc32f8471391b63e05a88cbb86`

## Pre-existing Dirty Paths

From `git status --short` before M9 implementation changes:

- `M docs/operation-flow/4-do-implementation-plan.md`
- `?? docs/implementation-plans/milestone-9.md`
- `?? docs/superpowers/specs/2026-05-25-orchestrator-transport-fallback-design.md`

## Typecheck Summary

- Workspace scope: 3 projects (`@orca/contracts`, `@orca/daemon`, `@orca/desktop`)
- Result: all typecheck targets passed (exit 0)

## Test Summary

- `@orca/contracts`: `Test Files 3 passed`, `Tests 65 passed`
- `@orca/daemon`: `Test Files 124 passed | 7 skipped`, `Tests 1349 passed | 8 skipped`
- `@orca/desktop`: `Test Files 33 passed`, `Tests 303 passed`
- Aggregate: `Test Files 160 passed | 7 skipped`, `Tests 1717 passed | 8 skipped`
- Result: recursive suite passed (exit 0)

## M8 Regression Anchors Confirmed Green

- Workflow contracts: `packages/contracts/src/__tests__/workflow-contracts.test.ts`
- Workflow HTTP surface: `apps/daemon/src/workflows/__tests__/http-surface.test.ts`
- Operator selection: `apps/daemon/src/workflows/operators/selector.test.ts`
- Orchestrator service: `apps/daemon/src/workflows/orchestrator/service.test.ts`
- Goal-detail workflow UI: `apps/desktop/src/goal-detail/workflow/WorkflowRunPanel.test.tsx`
