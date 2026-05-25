# M8-018 Gate - Consolidated HTTP Surface

Date: 2026-05-25
Reviewer: Codex
Baseline note: `docs/implementation-plans/notes/m8-000-baseline.md`
Gate SHA: `59c10e0342ec773fe7eb4b35f173db9e32faae9d`

## Scope

Gate 3 verifies M8-018 route consolidation and HTTP-surface integration coverage,
then confirms the required full-suite regression gate is green.

## Validation Runs

- `pnpm -r typecheck` -> exit 0
  - `packages/contracts` passed
  - `apps/daemon` passed
  - `apps/desktop` passed
- `pnpm -r test` -> exit 0
  - `packages/contracts`: `Test Files 3 passed`; `Tests 65 passed`
  - `apps/desktop`: `Test Files 24 passed`; `Tests 283 passed`
  - `apps/daemon`: `Test Files 119 passed | 7 skipped`; `Tests 1336 passed | 8 skipped`
  - Totals: `Test Files 146 passed | 7 skipped`; `Tests 1684 passed | 8 skipped`

## Gate Checks

- All required M8 routes are mounted, including:
  - workflow templates
  - workflow runs
  - workflow decisions
  - workflow artifacts
  - workflow step-runs (`GET detail`, `POST submit-input`)
  - operators/providers
  - goal orchestrator-model patch
- New integration test exercises each listed route with schema validation and 200/400/404 patterns:
  - `apps/daemon/src/workflows/__tests__/http-surface.test.ts`
- Goal scoping checks are covered for run/step/artifact/decision direct-id reads.

## Outcome

Gate is green. M8-019 can proceed.
