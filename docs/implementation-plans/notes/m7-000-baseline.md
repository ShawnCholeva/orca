# M7-000 Baseline Verification

## Commit SHA

```
bb011706b4c62a62b9f0acb4b49ca84870d484df
```

## Typecheck Summary

All 3 packages passed (`packages/contracts`, `apps/daemon`, `apps/desktop`). Zero errors.

## Test Summary

| Package | Files | Tests | Outcome |
|---------|-------|-------|---------|
| packages/contracts | 1 passed | 36 passed | green |
| apps/desktop | 14 passed | 182 passed | green |
| apps/daemon | 61 passed / 4 skipped | 728 passed / 5 skipped | green |
| **Total** | **76 passed / 4 skipped** | **946 passed / 5 skipped** | **green** |

Skipped tests are pre-existing smoke tests requiring live PTY/adapter processes (flagged `.skip`).

## Named M1–M6 Regression Anchors

| Anchor | Test file | Result |
|--------|-----------|--------|
| M1 Goal CRUD + live events | `test/m1-017.integration.test.ts` (6 tests) | PASS |
| M2 plugin/skill registry | `src/m2-loop.test.ts` (8 tests) | PASS |
| M3 Goal-with-workspaces integration | `test/m3-create-goal-with-workspaces.integration.test.ts` (1 test) | PASS |
| M4 session lifecycle integration | `test/m4-011-shell-vertical-slice.integration.test.ts` (2 tests) | PASS |
| M5 daemon proof-loop integration | `test/m5-shared-memory.integration.test.ts` (2 tests) | PASS |
| M6 daemon proof-loop integration | `test/context-proof-loop.integration.test.ts` (1 test) | PASS |

## Pre-Existing Dirty Paths

The following path was modified before M7-000 ran and is **not attributed to M7**:

```
modified: docs/operation-flow/4-do-implementation-plan.md
```

Change: `Current task: M7-000` → `Current task: M7-001` (task pointer pre-incremented in the operation-flow doc).

All other tracked files were clean.
