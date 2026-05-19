# M5-000 — Baseline Verification

## Snapshot

- Baseline SHA: `598030260ddd152c3c31da3db9a5df8acfd59c66`
- Branch: `main`
- Date: 2026-05-19
- Working tree: clean

## Commands Run

- `pnpm install --frozen-lockfile` -> exit 0
  - Lockfile already in sync
- `pnpm -r typecheck` -> exit 0
  - `@orca/contracts`, `@orca/daemon`, `@orca/desktop` all green
- `pnpm -r test` -> exit 0

## Test Result Summary

- `packages/contracts`: 1 test file, 30 tests passed
- `apps/desktop`: 5 test files, 74 tests passed
- `apps/daemon`: 30 test files passed, 4 skipped; 377 tests passed, 5 skipped

## Regression Anchors (Required to PASS)

- `apps/daemon/test/m1-017.integration.test.ts` — PASS (6 tests)
- `apps/daemon/src/m2-loop.test.ts` — PASS (8 tests)
- `apps/daemon/test/m3-create-goal-with-workspaces.integration.test.ts` — PASS (1 test)
- `apps/daemon/test/m4-011-shell-vertical-slice.integration.test.ts` — PASS (2 tests)

## Notes

No pre-existing dirty paths were present for this baseline run.
