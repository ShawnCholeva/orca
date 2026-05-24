# M8-000 Baseline Verification

## Commit SHA

```
48595fad3122fa04497bac6058dd46b63b33f4df
```

## Typecheck Summary

- Command: `pnpm -r typecheck`
- Result: exit 0
- Final summary lines:
  - `packages/contracts typecheck: Done`
  - `apps/daemon typecheck: Done`
  - `apps/desktop typecheck: Done`
- Count: 3/3 workspace packages passed.

## Test Summary

- Command: `pnpm -r test`
- Result: exit 0
- Final summary lines:
  - `packages/contracts`: `Test Files  2 passed (2)`; `Tests  59 passed (59)`
  - `apps/desktop`: `Test Files  24 passed (24)`; `Tests  283 passed (283)`
  - `apps/daemon`: `Test Files  100 passed | 7 skipped (107)`; `Tests  1242 passed | 8 skipped (1250)`
- Totals:
  - Test files: 126 passed, 7 skipped
  - Tests: 1584 passed, 8 skipped

## Named M1-M7 Regression Anchors

| Anchor | Test file / suite evidence from run | Result |
|---|---|---|
| M1 Goal CRUD + live events | `apps/daemon/test/daemon.integration.test.ts` (`describe.sequential('daemon integration loop')`) with passing cases for goal create + WS delivery of `goal.created` | PASS |
| M2 plugin/skill registry | `apps/daemon/src/registry/bootstrap.test.ts` and `apps/daemon/src/registry/registry-hardening.test.ts` | PASS |
| M3 Goal-with-workspaces integration | `apps/daemon/test/create-goal-with-workspaces.integration.test.ts` (`daemon integration: full guided goal and workspace loop`) | PASS |
| M4 session lifecycle integration (final M4 anchor) | `apps/daemon/test/shell-session-vertical-slice.integration.test.ts` (`real shell session vertical slice`) | PASS |
| M5 daemon proof-loop integration (final M5 anchor) | `apps/daemon/test/shared-memory.integration.test.ts` (`shared memory daemon proof-loop integration`) | PASS |
| M6 daemon proof-loop integration (final M6 anchor) | `apps/daemon/test/context-proof-loop.integration.test.ts` | PASS |
| M7 orchestration-loop integration (final M7 anchor) | `apps/daemon/src/__tests__/orchestration-loop.test.ts` (`orchestration proof loop`) | PASS |

## Pre-existing Dirty Paths (Not Attributed To M8)

Captured from `git status --short` before running M8-000 commands:

```
M docs/operation-flow/4-do-implementation-plan.md
?? docs/ideas/orca-workflow-driven-orchestrator-goal.md
?? docs/ideas/orca-workflow-metrics-goal.md
?? docs/ideas/references/
?? docs/implementation-plans/milestone-8.md
```
