# M6-000 — Baseline Verification

## Snapshot

- Baseline SHA: `31f24cd8a3c05511f486a5e9bac9d02860398bbf`
- Branch: `main`
- Date: 2026-05-20
- Working tree: clean

## Commands Run

- `pnpm install --frozen-lockfile` -> exit 0
  - Lockfile already in sync
- `pnpm -r typecheck` -> exit 0
  - `@orca/contracts`, `@orca/daemon`, `@orca/desktop` all green
- `pnpm -r test` -> exit 0

## Test Result Summary

- `packages/contracts`: 1 test file, 30 tests passed
- `apps/desktop`: 9 test files, 134 tests passed
- `apps/daemon`: 48 test files passed, 4 skipped; 560 tests passed, 5 skipped

## Regression Anchors (Required to PASS)

- `apps/daemon/test/m1-017.integration.test.ts` — PASS (6 tests)
- `apps/daemon/src/m2-loop.test.ts` — PASS (8 tests)
- `apps/daemon/test/m3-create-goal-with-workspaces.integration.test.ts` — PASS (1 test)
- `apps/daemon/test/m4-011-shell-vertical-slice.integration.test.ts` — PASS (2 tests)
- `apps/daemon/test/m5-shared-memory.integration.test.ts` — PASS (2 tests)

## Notes

No pre-existing dirty paths were present for this baseline run.
