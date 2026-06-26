# DispatchEngine Split — Phase 1 (Narrow the Seam) — Design

**Date:** 2026-06-25
**Phase:** FUTURE_WORK 0.2 — "DispatchEngine split", **part 1 of 2** (narrow the seam). Part 2 (the actual two-class split) is its own brainstorm after this lands.
**Scope:** Extract the pure utility/query shared-helpers out of `OrchestratorService` to free-function modules and drop the dead `operatorSelector` constructor param — tightening the eventual engine↔handler interface and shrinking the class. **No behavior change.**
**Status:** Approved design, pre-implementation

## Why (the Phase-2 context)

A boundary map of `OrchestratorService` (3,871 lines) confirmed a future `DispatchEngine` (advance/route engine) vs handler-`OrchestratorService` split would be **acyclic** (handlers → engine only; no engine→handler back-edge — exhaustively verified). But the seam is **wide**: ~8 shared helpers are called by both sides. Several are *pure utilities/queries* with **zero `this.*`** — pulling them to free-function modules removes them from the seam entirely, tightening Phase 2's engine interface from ~13 methods to ~8 genuine graph-operation entry points. This phase does exactly that. It is also independently valuable: the helpers become unit-testable in isolation, the class shrinks, and one dead injected dependency is removed.

## Governing constraints

- **No behavior change.** Verbatim moves; existing service-level suites are the guard (baseline-green → extract → typecheck → green → commit).
- **No public-API change** to `OrchestratorService` (all moved methods are private helpers).
- **No forwarding stubs** — moved private methods are deleted; call sites repoint to the free functions.
- All extracted helpers are verified **`this.*`-free** (pure DB reads / pure functions / param-threaded), so they move with **no deps object**.
- Dead-param removal is **typecheck-driven** (delete → typecheck flags every `new OrchestratorService(...)` site → drop the arg → green), exactly like the prior `workerWait` removal.

## Current-state map (verified, service.ts = 3,871 lines)

All seven targets confirmed `this.*`-free:

| Helper | Line | Shape |
|---|---|---|
| `stepRunIdsByTemplateId(db, runId)` | 2392 | DB query → `Record<string,string>` |
| `artifactCountForStep(db, stepRunId)` | 2406 | `SELECT COUNT(*)` → number |
| `retryCount(stepRun: StepRunRow)` | 2414 | pure: `attempt-1 + revise_attempts + crash_retries` |
| `hasActiveUnansweredQuestion(db, stepArtifacts, stepRunId)` | 2431 | DB query + `InterviewTurn` parse → boolean |
| `readStepOutputAsRecord(db, runId, stepRunId)` | 2990 | DB query + JSON parse → `Record<string,unknown>|null` |
| `postOrchestratorMessage(db, now, goalId, body, options, role?, pendingQuestion?, pendingRevision?)` | 1715 | DB-write txn + `options.bus?.publish` |
| `publish(bus, stagedEvents)` | 3866 | one-liner: `if (bus) publishStagedWorkflowEvents(bus, stagedEvents)` |

`stepResultBuilderDeps` getter (2422) builds `{ broker, readStepOutputAsRecord, retryCount, artifactCountForStep }` — after extraction it references the free fns (and keeps `this.broker`).

Dead dep: **`operatorSelector`** (constructor param 408) — assigned to a field, **never read** anywhere in the file.

## Design

### 1. `orchestrator/queries.ts` — the 5 pure read helpers
Move `stepRunIdsByTemplateId`, `artifactCountForStep`, `retryCount`, `hasActiveUnansweredQuestion`, `readStepOutputAsRecord` **verbatim** as exported free functions. Imports needed: `Database` (better-sqlite3), `StepRunRow` (`./db-rows.js`), `InterviewTurn` (`@orca/contracts`), `listArtifactsForRun`'s return type for the `hasActiveUnansweredQuestion` param (copy the type usage from `service.ts`). Delete the 5 methods from `service.ts`; repoint their call sites to the free fns; the `stepResultBuilderDeps` getter references `readStepOutputAsRecord`/`retryCount`/`artifactCountForStep` from `./queries.js`.

### 2. `orchestrator/orchestrator-message.ts` — `postOrchestratorMessage`
Move it **verbatim** as an exported free function (it's already param-threaded: `db, now, goalId, body, options, role?, pendingQuestion?, pendingRevision?`). Imports: `Database`, `randomUUID`, `RequestNextDecisionOptions` (`import type` from `./service.js` — erased, no runtime cycle, same pattern accepted in `ledger-commit.ts`), `PendingQuestionT`, `DomainEvent`. Delete from `service.ts`; repoint the ~15 call sites to the free function.

### 3. `publish` → use the existing util behind a tiny guard
`publish` is already a one-line wrapper over `publishStagedWorkflowEvents` (from `../events.js`). Replace it with a tiny exported free fn `publishStaged(bus: EventBus | undefined, events: DomainEvent[])` (in `queries.ts` or a small `events-util.ts`) doing the `if (bus)` guard, **or** inline `if (bus) publishStagedWorkflowEvents(bus, events)` at the call sites. Delete the `publish` method; repoint the ~15 call sites. (Pick the free-fn `publishStaged` form to keep call sites one-line and centralize the guard.)

### 4. Drop the dead `operatorSelector` constructor param
Delete the `operatorSelector` parameter-property from the constructor. Run `pnpm --filter @orca/daemon typecheck` — it flags every `new OrchestratorService(...)` site passing that positional arg (server.ts + test `makeService` helpers); drop the argument at each; re-run until green. (It's the **first** positional param, so removal shifts all subsequent args — typecheck enumerates every affected site; none can be silently missed.)

## Testing

No behavior change → no new behavior tests. Guard = existing suites green, unchanged:
- The 5 queries + `postOrchestratorMessage` + `publish` are exercised transitively through the orchestrator suites (`service.*.test.ts`, `session-completion`, `agent-interview`, e2e). After each module extraction: `pnpm --filter @orca/daemon typecheck` + `pnpm --filter @orca/daemon test -- orchestrator`.
- Optional: small unit tests for the pure query free fns (they had none) — not required.
- The `operatorSelector` removal touches the `new OrchestratorService(...)` arity at every construction site (server.ts + ~9 test helpers) — typecheck is the enumerator; suites confirm behavior.

## Sequencing (3 tasks)

1. **`queries.ts`** — the 5 read helpers; repoint call sites + the `stepResultBuilderDeps` getter; delete from class.
2. **`orchestrator-message.ts` + `publishStaged`** — extract `postOrchestratorMessage` and the publish guard; repoint call sites; delete both methods.
3. **Drop `operatorSelector`** — typecheck-driven param removal across all construction sites.

(Tasks 1 and 2 are independent extractions; Task 3 is the dead-param removal. Each is baseline-green → extract → typecheck → suites green → commit.)

## Alignment

- **FUTURE_ARCHITECTURE / FUTURE_WORK:** directly serves the tracked DispatchEngine split (control-plane modularity); narrows the seam so Phase 2 is a tight, lower-risk boundary.
- **Paper:** these are pure *working-state reads* + *event plumbing* — naturally separable utility/query helpers, consistent with the "separable harness layers" framing; extracting them is not fragmenting the control loop (the engine methods stay put).

## Out of scope

- The Phase-2 two-class `DispatchEngine`/`OrchestratorService` split (its own brainstorm).
- Refactoring `step-result-builder.ts`'s deps interface to import the query free fns directly (optional later simplification — the `stepResultBuilderDeps` getter is retained here).
- Any public-API or behavior change.
