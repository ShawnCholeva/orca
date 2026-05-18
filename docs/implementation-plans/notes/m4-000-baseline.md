# M4-000 — Baseline Verification

## Snapshot

- Baseline SHA: `279d435af82a55e08544a6f46cce473c7c3426de`
- Branch: `main`
- Date: 2026-05-18
- Working tree: clean (only `.claude/` per-user config untracked; not part of the project)

## Commands Run

- `pnpm install --frozen-lockfile` → exit 0 (lockfile already in sync)
- `pnpm -r typecheck` → exit 0
  - `@orca/contracts`, `@orca/daemon`, `@orca/desktop` all green
- `pnpm -r test` → exit 0

## Test Result Summary

- `apps/desktop`: 3 test files, 44 tests passed
- `apps/daemon`: 19 test files, 206 tests passed
- Total: 22 files, 250 tests passed; 0 failures

## Regression Anchors (Required to PASS)

- `apps/daemon/test/m1-017.integration.test.ts` — PASS (6 tests)
- `apps/daemon/src/m2-loop.test.ts` — PASS (8 tests)
- `apps/daemon/test/m3-create-goal-with-workspaces.integration.test.ts` — PASS (1 test)

## Notes

This baseline anchors M4 work. Any later M4-induced failure is to be diagnosed
against this SHA and the test inventory above. No source or test code was
modified in M4-000.
