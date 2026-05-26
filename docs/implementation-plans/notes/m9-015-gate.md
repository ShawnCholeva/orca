# M9-015 Gate - Broker Fallback Policy

Date: 2026-05-26
Reviewer: Codex
Baseline note: `docs/implementation-plans/notes/m9-000-baseline.md`
Prior gate note: `docs/implementation-plans/notes/m9-006-gate.md`
Gate SHA: `bee4c6095fb1156580c97dce8a98aa142cefc195`

## Scope

Gate 3 verifies M9-015 broker fallback sequencing from one-shot to hidden
interactive to human review, rejected proposal handling, and full-suite
regression health.

## Validation Runs

- `pnpm --filter @orca/daemon test orchestration-transport/broker workflows/operators/selector` -> exit 0
  - `apps/daemon`: `Test Files 2 passed`; `Tests 11 passed`
- `pnpm --filter @orca/daemon test orchestration-transport/broker workflows/operators/selector workflow-engineering-loop` -> exit 0
  - `apps/daemon`: `Test Files 3 passed`; `Tests 12 passed`
- `pnpm -r typecheck` -> exit 0
  - `packages/contracts` passed
  - `apps/daemon` passed
  - `apps/desktop` passed
- `pnpm -r test` -> exit 0
  - `packages/contracts`: `Test Files 3 passed`; `Tests 67 passed`
  - `apps/desktop`: `Test Files 33 passed`; `Tests 303 passed`
  - `apps/daemon`: `Test Files 137 passed | 7 skipped`; `Tests 1423 passed | 8 skipped`
  - Totals: `Test Files 173 passed | 7 skipped`; `Tests 1793 passed | 8 skipped`

## Gate Checks

- Broker executes ordered transport policy one step at a time.
- OpenAI and Gemini policies attempt `one_shot`, then `hidden_interactive`, then `human_review`.
- Claude policy skips `one_shot` and attempts `hidden_interactive`, then `human_review`.
- Each fallback has a prior attempt row and emits an explicit content-free fallback event.
- Rejected proposals are recorded as `rejected` with `proposal_rejected`, distinct from failed transports.
- The SDK compatibility path remains bounded to the existing selector use case so M8 workflow behavior remains green until M9-017 replaces that branch.

## Outcome

Gate is green. M9-016 can proceed.
