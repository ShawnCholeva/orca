# M8-010 Gate - Workflow Step Lifecycle

Date: 2026-05-24
Reviewer: Codex
Baseline note: `docs/implementation-plans/notes/m8-000-baseline.md`
Gate SHA: `5fbeea7bf07f71052710a2f272516d957049b567`

## Scope

Gate 2 verifies M8-010 step-run lifecycle + exit-criteria bookkeeping, and confirms
the required full-suite regression gate is green before continuing to later M8 work.

## Validation Runs

- `pnpm -r typecheck` -> exit 0
  - `packages/contracts` passed
  - `apps/daemon` passed
  - `apps/desktop` passed
- `pnpm -r test` -> exit 0
  - `packages/contracts`: `Test Files 3 passed`; `Tests 65 passed`
  - `apps/desktop`: `Test Files 24 passed`; `Tests 283 passed`
  - `apps/daemon`: `Test Files 110 passed | 7 skipped`; `Tests 1286 passed | 8 skipped`
  - Totals: `Test Files 137 passed | 7 skipped`; `Tests 1634 passed | 8 skipped`

## Gate Checks

- `startWorkflowRun` now creates `workflow_runs` + first `workflow_step_runs` row in one transaction.
- Initial step creation emits `workflow.step.started` in-transaction; publish occurs after commit.
- Step lifecycle usecases implemented for:
  - initial step create
  - exit-criteria satisfaction bookkeeping
  - advance to next step / run completion
  - blocked, failed, skipped transitions
  - retry attempt with fingerprint increment
- New step tests cover:
  - full 8-step Engineering progression to completed run
  - blocked run resume reusing the same step (`attempt=1`)
  - fail + retry creating `attempt=2` with distinct fingerprint

## Outcome

Gate is green. M8-011 can proceed.
