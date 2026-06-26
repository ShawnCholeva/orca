# DispatchEngine Split — Phase 2 (the two-class split) — Design

**Date:** 2026-06-25
**Phase:** FUTURE_WORK 0.2 — "DispatchEngine split", **part 2 of 2** (Phase 1 narrowed the seam; this performs the split).
**Scope:** Relocate the cohesive advance/route engine out of `OrchestratorService` into a `DispatchEngine` class, leaving `OrchestratorService` as the event-handler/reaction layer. **No behavior change.** Done as a **transitional-delegate two-step** for safety on the system's most safety-critical file.
**Status:** Approved design, pre-implementation

## Why & shape

A full-granularity boundary map (post-Phase-1, service.ts = 3,735 lines) confirms the engine↔handler boundary is **acyclic** — handlers call the engine; no engine method calls a handler (exhaustive `this.<handler>` grep yields only `continueAllPausedSteps → confirmStep`, both handlers). So a two-class split is a *clean* relocation, not a pass-through. After Phase 1's seam-narrowing, handlers reach the engine through exactly **8 methods**: `requestNextDecision`, `advanceToNextStep`, `spawnStepAgent`, `blockRun`, `commitDeterministicStepSelection`, `commitUserInputDecision`, `confirmGate`, `confirmSplit`.

The two halves are conceptually distinct: **react-to-stimulus** (hooks/routes/user → `onWorkflowSessionCompleted`/`onSessionOutputChunk`/`onAgentResponseDone`/`onUserMessage`/`confirmStep`/revisions/…) vs **advance-the-graph** (dispatch/commit/gate/splitter routing). This aligns with FUTURE_ARCHITECTURE's "deterministic code owns lifecycle, routing, gates" (the engine is that core) and the paper's "single harness-level control process" framing (the engine is the cohesive governor; we name it, we don't fragment it).

## Governing constraints

- **No behavior change.** Verbatim method moves; existing service-level suites are the guard at every step.
- **Acyclic boundary preserved:** handlers → engine only. No engine method may call a handler.
- **End state has ZERO delegates.** Step 1 introduces thin transitional delegates purely to keep Step 1's diff a pure body-move (all external callers + tests unchanged/green); Step 2 removes them. The final structure is delegate-free (engine-public methods called directly on the `DispatchEngine`, consistent with the recovery lift-out).
- State substrate stays unified (`db` threaded through; no per-unit state).

## Current-state map (verified, service.ts = 3,735 lines)

### Deps partition (constructor params; `operatorSelector` already removed)
| Dep | Side |
|---|---|
| `launcher`, `workerSpawn` | **ENGINE-only** |
| `sessionOutputStore`, `orchestratorMediator`, `workerTerminate`, `shadowAsk`, `recoveryPromptComposer`, `workerInterrupt` | **HANDLER-only** |
| `broker`, `operators`, `stepDispatch`, `workerDeliver`, `otlpAccumulator` | **SHARED** (both sides use directly) |

### Engine methods (move to `DispatchEngine`) — current lines
`advanceToNextStep` (1997), `requestNextDecision` (2149), `commitSkillStepDecision` (2175), `commitNoop` (2348), `commitNoopLatestDecision` (2365), `hasOpenLaunchRecommendation` (2378), `commitLaunchRecommendation` (2390), `commitAgentStepDecision` (2469), `recordStepLaunchTransition` (2550), `commitDeterministicStepSelection` (2604), `commitAdvanceOrComplete` (2708), `parkForGateApproval` (2895), `buildSplitEvaluationRequest` (2973), `evaluateAndParkSplitter` (3019), `decideGate` (3226), `routeGateDestination` (3329), `confirmGate` (3465), `confirmSplit` (3532), `blockRun` (3587), `commitUserInputDecision` (3649), `appendDecisionRequested` (3714), `spawnStepAgent` (2074). (~21 methods.)

### Engine public surface (callable from outside the engine)
- **External (routes/server):** `requestNextDecision`, `decideGate`, `confirmGate`, `confirmSplit`.
- **Handler-internal (cross-boundary):** `requestNextDecision`, `advanceToNextStep`, `spawnStepAgent`, `blockRun`, `commitDeterministicStepSelection`, `commitUserInputDecision`, `confirmGate`, `confirmSplit`.
- **Union (public on `DispatchEngine`, 9):** the above two sets merged. The rest are `private` within the engine.

### Handlers + handler helpers (stay on `OrchestratorService`)
`onWorkflowSessionCompleted` (449), `onSessionOutputChunk` (695), `onAgentResponseDone` (1003), `stashJudgeFailure` (1075), `runStashedJudgeRetry` (1100), `applyOrchestratorAction` (1155), `reviseStep` (1506), `acknowledgeUserMessageAction` (1562), `onUserMessage` (1591), `startWorkflowFirstStep` (1721), `respawnStepAgent` (1750), `confirmStep` (1782), `requestStepRevision` (1840), `submitStepRevision` (1861), `postHandoffClosingSummary` (1894), `continueAllPausedSteps` (1941), `interruptStepAgent` (3429). Plus a `this.engine` reference.

### `stepResultBuilderDeps` getter (2339)
Builds `{ broker, readStepOutputAsRecord, retryCount, artifactCountForStep }` — 3 are already free fns (queries.ts); only `broker` is instance state. Convert to a free fn `buildStepResultBuilderDeps(broker)` so both sides call it (removes it from the seam). Callers: 485, 642, 1480, 1826 (handler-side) + any engine use (`commitSkillStepDecision` path) — the free fn serves both.

### External call sites
- `server.ts:1852` `confirmGate`, `:1862` `confirmSplit`, `:1889` `decideGate` (all ENGINE).
- `workflows/orchestrator/routes.ts:74` and `workflows/steps/routes.ts:238`: `requestNextDecision` (ENGINE) — these route files construct `OrchestratorService` *only* to call `requestNextDecision`.
- All other `server.ts` calls (`onAgentResponseDone`, `onUserMessage`, `confirmStep`, `startWorkflowFirstStep`, `respawnStepAgent`, `continueAllPausedSteps`, `requestStepRevision`, `submitStepRevision`, `interruptStepAgent`, `onWorkflowSessionCompleted`, `onSessionOutputChunk`) are HANDLER — stay on `OrchestratorService`.

## Design — the two steps

### Step 1: Introduce `DispatchEngine`; `OrchestratorService` delegates (transitional)

1. **Create `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts`** with `class DispatchEngine`. Constructor: `{ broker, operators, launcher, stepDispatch, workerSpawn, workerDeliver, otlpAccumulator }` (engine-only + shared deps). Move the ~21 engine methods **verbatim** into it — their internal `this.<engineMethod>` and `this.<dep>` references are unchanged (the engine now holds those methods + deps). The 9 union methods are `public`; the rest `private`. Copy the free-fn imports the bodies use (queries, ledger-commit, the many workflow free fns, etc.).
2. **Convert `stepResultBuilderDeps` getter → free fn** `buildStepResultBuilderDeps(broker)` (add to `queries.ts` or alongside `step-result-builder.ts`); repoint its callers (engine + handler) to the free fn. This removes the only getter from the seam.
3. **`OrchestratorService`:** keep the constructor signature **unchanged** (external callers untouched in Step 1). In the constructor body, build `this.engine = new DispatchEngine(this.broker, this.operators, this.launcher, this.stepDispatch, this.workerSpawn, this.workerDeliver, this.otlpAccumulator)`. **Delete** the ~21 engine methods from the class. Add **9 thin transitional delegates** — one per union method (`requestNextDecision`, `advanceToNextStep`, `spawnStepAgent`, `blockRun`, `commitDeterministicStepSelection`, `commitUserInputDecision`, `confirmGate`, `confirmSplit`, `decideGate`) — each `f(...args) { return this.engine.f(...args); }`, preserving the original visibility (public for the 4 external, private for the rest).
4. **Result of Step 1:** every handler body, every route, `server.ts`, and every test call site is **byte-identical** — they all still call `this.<method>` / `service.<method>`, which now delegates to `this.engine`. The risky body-move is verified in isolation by the unchanged suites.

### Step 2: Remove the transitional delegates

1. **Handler-internal repoints:** change the handler bodies' calls to the 8 cross-boundary methods from `this.<method>(…)` → `this.engine.<method>(…)` (in `onWorkflowSessionCompleted`, `onSessionOutputChunk`, `confirmStep`, `reviseStep`, `startWorkflowFirstStep`, `respawnStepAgent`, `continueAllPausedSteps`). Delete the 9 delegates from `OrchestratorService`.
2. **Change `OrchestratorService`'s constructor** to take `engine: DispatchEngine` (in place of the engine-only `launcher`/`workerSpawn` it no longer uses directly), keeping the shared + handler-only deps. (Verify no surviving `OrchestratorService` method still uses `launcher`/`workerSpawn` — they were engine-only — before dropping them.)
3. **`server.ts`:** construct `DispatchEngine` first; pass it into `new OrchestratorService(engine, …)`. Repoint `server.ts:1852/1862/1889` to `dispatchEngine.confirmGate/confirmSplit/decideGate`. (The `_orchestratorServiceRef` stays pointed at the handler class.)
4. **Route files:** `workflows/orchestrator/routes.ts` and `workflows/steps/routes.ts` construct a `DispatchEngine` (engine-only deps) instead of `OrchestratorService`, and call `dispatchEngine.requestNextDecision`. (They never used the handler class for anything else.)
5. **Constructor-signature ripple is typecheck-driven:** after changing the `OrchestratorService` ctor, typecheck flags every construction site; fix each (server.ts + the test helpers).
6. **Tests:** the 4 pure-engine suites (`service.gate-routing`, `service.splitter-routing`, `service.skill-step`, `service.adaptive-delivery`) construct a `DispatchEngine` and call engine methods on it; the 3 handler suites (`session-completion`, `agent-interview`, `orchestrator-e2e`) construct `OrchestratorService(engine, …)`; the straddler `service.agent-step.test.ts` constructs both (engine + handler wired together) and splits its calls accordingly (engine methods on the engine, handler methods on the service). Assertions unchanged.

## Testing

No behavior change → no new behavior tests. Guard = existing suites green at each step:
- **Step 1:** suites stay **green and unchanged** (pure move + delegate). This is the key safety property — `pnpm --filter @orca/daemon typecheck` + `test -- orchestrator` before/after.
- **Step 2:** suites green after the call-site/constructor repoints (tests' construction changes, assertions unchanged). Run the full daemon suite before committing Step 2.

## Sequencing (2 tasks)

1. **Step 1** — `DispatchEngine` + transitional delegates + `buildStepResultBuilderDeps` free fn (pure move; all callers unchanged).
2. **Step 2** — remove delegates, repoint handler-internal + external calls, hoist engine construction to `server.ts` + route files, rewire tests.

(Optional Task 3 docs: mark FUTURE_WORK 0.2 DispatchEngine done.)

## Alignment (verified)

- **Paper — `DispatchEngine` IS the "Control Unit" pattern.** The survey holds up **L2MAC's Control Unit** as the cleanest harness control center: *"The Control Unit manages all reads and writes… ensuring that each agent invocation receives a precisely controlled context window"* (p.41), gating whether *"the instruction pipeline"* advances; p.48 names it among *"coordinated control surfaces"* (p.16). `DispatchEngine` is exactly that — the dedicated dispatch/advance/route/gate component, separated from the reaction layer. Naming it adopts a recognized pattern, not an invention.
- **Paper — modularize behavior, not state (caution honored).** p.41 ("Shared-Harness Synchronization") warns that splitting work across units creates *"invisible state divergence."* The two classes are **not** separate agents — they co-operate over **one shared `db` + the append-only event spine**, with no per-unit state. We modularize behavior while the state substrate stays unified, avoiding the divergence the paper flags. (A future extraction must preserve this — pass the transactional `db`, never fork state.)
- **FUTURE_ARCHITECTURE — line 95:** *"deterministic code owns lifecycle, **routing**, gates."* `DispatchEngine` makes that deterministic core a named, focused unit. **§1 / line 52:** control-plane modularity serves *"the daemon graduates into a standalone server"* — a modular control plane (engine + reaction layer) is more liftable than a 3.7k-line god-class. The append-only event spine (line 98) stays unified across both halves.
- **Paper / FUTURE_ARCH — the governor stays whole.** The split is acyclic (handlers→engine only); both halves remain one cohesive control loop ("single harness-level control process," p.28). Naming the two surfaces does not fragment the governor.
- **ORCA.md:** subsystem-grain; both classes live in `orchestrator/`; responsibilities preserved. Optional post-merge note that the engine is now `DispatchEngine`.

## Out of scope

- Any behavior change or public-API semantics change (the 4 engine-public methods keep identical signatures, just relocated to `DispatchEngine`).
- The `daemon-context.ts` `operatorSelector` excision (separate tracked follow-up).
- Further splitting the engine internally (it's the irreducible core).
