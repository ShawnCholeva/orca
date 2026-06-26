# DispatchEngine Split — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relocate the advance/route engine out of `OrchestratorService` into a `DispatchEngine` class (the reaction layer stays on `OrchestratorService`), with no behavior change, via a transitional-delegate two-step.

**Architecture:** Step 1 moves the ~21 engine methods into a new `DispatchEngine`; `OrchestratorService` builds it internally and keeps 9 thin transitional delegates so every external caller + test stays byte-identical (isolates the body-move). Step 2 removes the delegates: handler-internal calls → `this.engine.X`, external routes/server → the engine, engine construction hoisted to `server.ts`, the `OrchestratorService` ctor takes `engine` (typecheck-driven), route files construct `DispatchEngine`, tests rewired.

**Tech Stack:** TypeScript, better-sqlite3, vitest. Daemon package `@orca/daemon`.

## Global Constraints

- **No behavior change.** Verbatim method moves; existing service-level suites are the guard at every step. Discipline: **baseline-green → change → typecheck → suites green → commit.** Red baseline → STOP and report.
- **Acyclic boundary preserved:** handlers → engine only. No engine method may call a handler. If you find an engine method calling a handler (`onWorkflowSessionCompleted`/`onSessionOutputChunk`/`onAgentResponseDone`/`onUserMessage`/`confirmStep`/`requestStepRevision`/`submitStepRevision`/`startWorkflowFirstStep`/`respawnStepAgent`/`continueAllPausedSteps`/`interruptStepAgent`), STOP and report.
- **End state has ZERO delegates** (Step 1's delegates are transitional; Step 2 removes all 9).
- **Move bodies verbatim** — the only edits are the documented receiver/visibility changes. No control-flow changes.
- We are on `main` — branch first (e.g. `feat/dispatchengine-split`). Single-file test: `pnpm --filter @orca/daemon test -- <substr>`; typecheck: `pnpm --filter @orca/daemon typecheck`.
- `noUnusedLocals` is OFF — typecheck won't flag orphaned imports; grep to confirm before removing any.
- Refactor → no new behavior tests; existing suites guard.

## Reference (from the verified boundary map, service.ts = 3,735 lines)

**Engine methods to move (~21):** `advanceToNextStep` (1997), `requestNextDecision` (2149), `commitSkillStepDecision` (2175), `commitNoop` (2348), `commitNoopLatestDecision` (2365), `hasOpenLaunchRecommendation` (2378), `commitLaunchRecommendation` (2390), `commitAgentStepDecision` (2469), `recordStepLaunchTransition` (2550), `commitDeterministicStepSelection` (2604), `commitAdvanceOrComplete` (2708), `parkForGateApproval` (2895), `buildSplitEvaluationRequest` (2973), `evaluateAndParkSplitter` (3019), `decideGate` (3226), `routeGateDestination` (3329), `confirmGate` (3465), `confirmSplit` (3532), `blockRun` (3587), `commitUserInputDecision` (3649), `appendDecisionRequested` (3714), `spawnStepAgent` (2074).

**Engine ctor deps (7):** `broker`, `operators`, `launcher`, `stepDispatch`, `workerSpawn`, `workerDeliver`, `otlpAccumulator`.

**The 9 union methods (public on `DispatchEngine`; transitional delegates in Step 1):** `requestNextDecision`, `advanceToNextStep`, `spawnStepAgent`, `blockRun`, `commitDeterministicStepSelection`, `commitUserInputDecision`, `confirmGate`, `confirmSplit`, `decideGate`. (The other ~12 engine methods are `private` within the engine.)

**Handler→engine call sites (Step 2 repoints to `this.engine.X`):** `requestNextDecision` @ onWorkflowSessionCompleted (479,486,676); `advanceToNextStep` @ reviseStep (1481), confirmStep (1827); `spawnStepAgent` @ onWorkflowSessionCompleted (542), startWorkflowFirstStep (1735), respawnStepAgent (1773); `blockRun` @ onWorkflowSessionCompleted (517,570,605); `commitDeterministicStepSelection` @ onSessionOutputChunk (848); `commitUserInputDecision` @ onSessionOutputChunk (980); `confirmGate` @ continueAllPausedSteps (1969); `confirmSplit` @ continueAllPausedSteps (1979). (Line numbers are pre-Step-1; anchor on the handler method + the called method.)

**External engine call sites (Step 2 repoints to the engine instance):** `server.ts:1852` confirmGate, `:1862` confirmSplit, `:1889` decideGate; `workflows/orchestrator/routes.ts:74` requestNextDecision; `workflows/steps/routes.ts:238` requestNextDecision.

---

### Task 1: Step 1 — introduce `DispatchEngine`; `OrchestratorService` delegates (transitional)

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/queries.ts` (add `buildStepResultBuilderDeps`)

**Interfaces:**
- Produces: `class DispatchEngine` with constructor `(broker, operators, launcher, stepDispatch, workerSpawn, workerDeliver, otlpAccumulator)` (match the exact param types from `service.ts`'s constructor) and the ~21 engine methods; the 9 union methods `public`, the rest `private`.
- Produces: `buildStepResultBuilderDeps(broker: Pick<OrchestrationTransportBroker,"propose">): StepResultBuilderDeps` (from `queries.ts`).

- [ ] **Step 1: Baseline — confirm the daemon suite is green**

Run: `pnpm --filter @orca/daemon test -- orchestrator`
Expected: PASS. (Red baseline → STOP and report.)

- [ ] **Step 2: Convert the `stepResultBuilderDeps` getter to a free fn**

In `queries.ts`, add:
```ts
import type { OrchestrationTransportBroker } from "../transport/broker.js"; // match service.ts's specifier for the broker type
import type { StepResultBuilderDeps } from "./step-result-builder.js";

export function buildStepResultBuilderDeps(
  broker: Pick<OrchestrationTransportBroker, "propose">,
): StepResultBuilderDeps {
  return { broker, readStepOutputAsRecord, retryCount, artifactCountForStep };
}
```
(`readStepOutputAsRecord`/`retryCount`/`artifactCountForStep` are already in `queries.ts`. Confirm the `OrchestrationTransportBroker` and `StepResultBuilderDeps` import specifiers against `service.ts`.) In `service.ts`, delete the `private get stepResultBuilderDeps()` getter (≈2339) and repoint its callers (≈485, 642, 1480, 1826) to `buildStepResultBuilderDeps(this.broker)`. Add the import. Typecheck + `test -- orchestrator` → green before continuing.

- [ ] **Step 3: Create `dispatch-engine.ts` and move the ~21 engine methods verbatim**

Create `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts` with `class DispatchEngine`. Constructor: the 7 engine deps as `private readonly` parameter-properties (copy their exact types from `service.ts`'s constructor params). Move the ~21 engine methods (listed in Reference) **verbatim** into the class — their internal `this.<engineMethod>` calls (to each other) and `this.<dep>` references are UNCHANGED (the engine now owns those methods + deps). Mark the 9 union methods `public`; the rest `private`. Copy every import the moved bodies use from `service.ts` (the workflow free fns — `advanceToNextStepOrGate`, `recordDecisionInTx`, `decisionFingerprint`, `createRecommendationForWorkflowInTx`, `materializeStepResultActivity`, `effectiveGraph`, `resolveStepNext`, `getWorkflowRunById`, `loadRunTemplate`, `resolveGateNext`, `resolveSplitterNext`, `recordGateDecision`, `recordSplitDecision`, etc.; `readGoal`/`readStepRun` from `db-rows.js`; the `queries.js` fns incl. `publishStaged` + `buildStepResultBuilderDeps`; `postOrchestratorMessage` from `orchestrator-message.js`; `completeStepWithLedger`/`createStepOutputArtifact` from `ledger-commit.js`; `scoreCompletedStepResult`/`buildScoredStepResult` from `step-result-builder.js`; the contract types; `Database`; `EventBus`). If a moved body references a `this.<method>` that is NOT one of the ~21 engine methods nor a `this.<dep>`, STOP and report (it would be an engine→handler back-edge or a missed shared helper).

- [ ] **Step 4: `OrchestratorService` — build the engine internally, delete the moved methods, add 9 delegates**

In `service.ts`:
- Add `import { DispatchEngine } from "./dispatch-engine.js";` and a `private readonly engine: DispatchEngine;` field.
- In the constructor body (signature UNCHANGED), assign: `this.engine = new DispatchEngine(this.broker, this.operators, this.launcher, this.stepDispatch, this.workerSpawn, this.workerDeliver, this.otlpAccumulator);`
- **Delete** the ~21 engine methods from the class.
- Add **9 transitional delegate methods**, each forwarding to `this.engine`, preserving the original visibility (public: `requestNextDecision`, `advanceToNextStep`, `decideGate`, `confirmGate`, `confirmSplit`; private: `spawnStepAgent`, `blockRun`, `commitDeterministicStepSelection`, `commitUserInputDecision`). Example:
  ```ts
  async requestNextDecision(db: Database.Database, now: () => string, workflowRunId: string, options: RequestNextDecisionOptions = {}): Promise<{ decision: WorkflowDecisionTrace; recommendationIds: string[] }> {
    return this.engine.requestNextDecision(db, now, workflowRunId, options);
  }
  ```
  Copy each delegate's signature verbatim from the original method (now in `dispatch-engine.ts`). The handler bodies still call `this.<method>(...)` → these delegates → `this.engine`; **no handler/route/server/test call site changes.**
- Remove now-orphaned imports from `service.ts` that were used ONLY by the moved engine bodies (grep each to confirm zero remaining uses — `noUnusedLocals` is off).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: exit 0. (Errors usually mean a moved body referenced a `this.*` that isn't on the engine, or a missing import — fix per Step 3/4, do not introduce a deps object or a back-edge.)

- [ ] **Step 6: Run the full orchestrator suite — confirm green & unchanged**

Run: `pnpm --filter @orca/daemon test -- orchestrator`
Expected: PASS, identical to Step 1 baseline. (No test changed — this is the key safety property of Step 1.)

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/dispatch-engine.ts apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/queries.ts
git commit -m "refactor(orchestrator): introduce DispatchEngine; OrchestratorService delegates (transitional)"
```

---

### Task 2: Step 2 — remove the transitional delegates

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (repoint handler-internal calls; change ctor; delete 9 delegates)
- Modify: `apps/daemon/src/server.ts` (construct engine; repoint 3 external calls; pass engine to service)
- Modify: `apps/daemon/src/workflows/orchestrator/routes.ts`, `apps/daemon/src/workflows/steps/routes.ts` (construct `DispatchEngine`; repoint `requestNextDecision`)
- Modify: the orchestrator test files (rewire construction)

**Interfaces:**
- Consumes: `DispatchEngine` (Task 1).
- Produces: `OrchestratorService` constructor now takes `engine: DispatchEngine` first, then the shared + handler-only deps (drops `launcher`, `workerSpawn`).

- [ ] **Step 1: Baseline — confirm green**

Run: `pnpm --filter @orca/daemon test -- orchestrator`
Expected: PASS.

- [ ] **Step 2: Repoint handler-internal calls to `this.engine.X` and delete the 9 delegates**

In `service.ts`, in each handler body, change the call to a cross-boundary method from `this.<method>(…)` → `this.engine.<method>(…)`:
- `onWorkflowSessionCompleted`: `requestNextDecision` (3 sites), `spawnStepAgent` (1), `blockRun` (3)
- `onSessionOutputChunk`: `commitDeterministicStepSelection` (1), `commitUserInputDecision` (1)
- `confirmStep`: `advanceToNextStep` (1)
- `reviseStep`: `advanceToNextStep` (1)
- `startWorkflowFirstStep`: `spawnStepAgent` (1)
- `respawnStepAgent`: `spawnStepAgent` (1)
- `continueAllPausedSteps`: `confirmGate` (1), `confirmSplit` (1)
(Anchor on the handler method + the called method; line numbers shifted after Task 1.) Then **delete all 9 delegate methods** from `service.ts`.

- [ ] **Step 3: Change the `OrchestratorService` constructor to take `engine`**

In `service.ts`, change the constructor to accept `engine: DispatchEngine` as the first parameter and assign `this.engine = engine` (remove the internal `new DispatchEngine(...)` from Task 1). **Drop the `launcher` and `workerSpawn` constructor params** (they were engine-only; verify no surviving `OrchestratorService` method references `this.launcher`/`this.workerSpawn` first — grep). Keep all other params (shared: `broker`,`operators`,`stepDispatch`,`workerDeliver`,`otlpAccumulator`; handler-only: `sessionOutputStore`,`orchestratorMediator`,`workerTerminate`,`shadowAsk`,`recoveryPromptComposer`,`workerInterrupt`).

- [ ] **Step 4: `server.ts` — construct the engine, repoint externals, pass engine to service**

In `server.ts`: construct `const dispatchEngine = new DispatchEngine(daemonContext.orchestrationTransportBroker, daemonContext.operatorRegistry, daemonContext.workflowSessionLauncher, daemonContext.stepDispatchCapabilities, workerSpawnFn, workerDeliverFn, otlpAccumulator);` (use the same dep expressions currently passed to `new OrchestratorService`). Change `new OrchestratorService(...)` to pass `dispatchEngine` first, then the remaining (shared + handler-only) deps in the new ctor order — drop the `launcher`/`workerSpawn` args. Repoint the 3 external calls: `orchestratorService.confirmGate` (1852), `.confirmSplit` (1862), `.decideGate` (1889) → `dispatchEngine.confirmGate/confirmSplit/decideGate`.

- [ ] **Step 5: Route files — construct `DispatchEngine`**

In `workflows/orchestrator/routes.ts` and `workflows/steps/routes.ts`: replace `new OrchestratorService(deps.orchestrationTransportBroker, deps.operatorRegistry, deps.workflowSessionLauncher, undefined, deps.stepDispatch)` with `new DispatchEngine(deps.orchestrationTransportBroker, deps.operatorRegistry, deps.workflowSessionLauncher, deps.stepDispatch, undefined, undefined, undefined)` (engine ctor order; the engine's `workerSpawn`/`workerDeliver`/`otlpAccumulator` are optional in these route contexts exactly as before — match the prior `undefined` for the launcher position semantics). Repoint `requestNextDecision` calls (`routes.ts:74`, `steps/routes.ts:238`) to the `DispatchEngine` instance. Update the local variable name/type to `DispatchEngine`. Add the import; remove the `OrchestratorService` import if now unused (grep).

- [ ] **Step 6: Typecheck — enumerate + fix every construction site**

Run: `pnpm --filter @orca/daemon typecheck`
The `OrchestratorService` ctor change flags every `new OrchestratorService(...)` site. Fix each (server.ts done in Step 4; the test `makeService` helpers in Step 7). Re-run until exit 0.

- [ ] **Step 7: Rewire tests**

- **Pure-engine suites** (`service.gate-routing.test.ts`, `service.splitter-routing.test.ts`, `service.skill-step.test.ts`, `service.adaptive-delivery.test.ts`): their `makeService` constructs a `DispatchEngine` (engine deps) and the tests call `requestNextDecision`/`decideGate`/`confirmGate`/`confirmSplit` on it. Rename the helper/var to the engine. Assertions unchanged.
- **Handler suites** (`session-completion.test.ts`, `agent-interview.test.ts`, `__tests__/orchestrator-e2e.test.ts`): construct a `DispatchEngine` first, then `new OrchestratorService(engine, …handler+shared deps)`; call handler methods on the service. Assertions unchanged.
- **Straddler** (`service.agent-step.test.ts`): construct both — `const engine = new DispatchEngine(...)`, `const service = new OrchestratorService(engine, ...)`; engine-method calls (`requestNextDecision`, `advanceToNextStep`) go on `engine`, handler calls on `service`. Assertions unchanged. (`advanceToNextStep`/`requestNextDecision` are public on the engine; the handler methods stay on the service.)

- [ ] **Step 8: Full daemon suite + typecheck**

Run: `pnpm --filter @orca/daemon typecheck` → exit 0.
Run: `pnpm --filter @orca/daemon test` → PASS (full daemon suite; the two acknowledged flakes `http-surface.test.ts`/`human-review.test.ts` may need an isolated re-run).

- [ ] **Step 9: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/server.ts apps/daemon/src/workflows/orchestrator/routes.ts apps/daemon/src/workflows/steps/routes.ts apps/daemon/src/workflows/orchestrator/*.test.ts apps/daemon/src/__tests__/orchestrator-e2e.test.ts
git commit -m "refactor(orchestrator): remove transitional delegates; DispatchEngine is the engine, OrchestratorService the reaction layer"
```

---

### Task 3: Update FUTURE_WORK.md

**Files:**
- Modify: `FUTURE_WORK.md` (the 0.2 DispatchEngine item)

- [ ] **Step 1: Mark the DispatchEngine split done**

In `FUTURE_WORK.md` §0.2, mark the **DispatchEngine split** item ✅ DONE (Phase 1 narrowed the seam; Phase 2 performed the two-class split: `DispatchEngine` owns advance/route/gate, `OrchestratorService` is the event-handler/reaction layer; acyclic handlers→engine; the engine is the paper's "Control Unit"). Reference the spec/plan `docs/superpowers/specs|plans/2026-06-25-dispatchengine-phase2-split*`.

- [ ] **Step 2: Commit**

```bash
git add FUTURE_WORK.md
git commit -m "docs(future-work): mark DispatchEngine split (0.2) done"
```

---

## Notes for the executor

- **Step 1 is the safety isolator:** after Task 1, ZERO call sites outside `service.ts`/`queries.ts` changed, and every test is byte-identical and green. Do not repoint any handler/route/server/test call in Task 1 — that's Task 2.
- **Verbatim moves:** the only edits inside a moved engine body are visibility (`private`→`public` for the 9) and nothing else — the `this.*` references stay. If a body needs a `this.<handler>`, STOP (back-edge).
- **Constructor ripple (Task 2)** is typecheck-driven — never hand-count construction sites.
- **Line numbers drift** heavily across both tasks — anchor on method names + the called method.
- **`noUnusedLocals` is off** — grep to confirm an import is unused before removing it.
