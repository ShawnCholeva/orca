# OrchestratorService Decomposition (Seams B + A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract step-scoring (Seam B) and provider-recovery (Seam A) out of the 4,641-line `OrchestratorService`, with no behavior change, naming the execution-plane seam as `RunnerPort`.

**Architecture:** Seam B → a free-function module the class calls (private methods deleted, call sites repointed). Seam A → provider recovery lifted entirely into a standalone `ProviderRecoveryController` that `server.ts` calls directly, depending on a new `RunnerPort` (the execution-plane capability surface); two pure shared helpers extracted as free functions used by both the controller and the orchestrator.

**Tech Stack:** TypeScript, better-sqlite3, Fastify, vitest. Daemon package `@orca/daemon`.

## Global Constraints

- **No behavior change.** Pure structural refactor. The existing service-level suites are the behavior-preservation guard and must stay green.
- **17 of the 21 public `OrchestratorService` methods stay byte-identical.** The 4 public *recovery* methods (`waitForProvider`/`retryProvider`/`refreshProviderRecovery`/`switchProvider`) **relocate** (same signatures) to `ProviderRecoveryController`; `server.ts`'s 4 routes repoint to it.
- **Delete private methods, don't stub.** A moved private method is deleted; its callers call the module function directly. No forwarding stubs on `OrchestratorService`.
- **Move method bodies verbatim.** Only rewrite the named `this.*` references (per the mapping in each step); do not otherwise edit logic. Preserve the existing `undefined`-worker-fn guard/throw behavior exactly.
- **State substrate stays unified.** Every extracted unit receives the same `db` and writes through the same event spine — do not introduce per-unit state.
- **Constructor signature is frozen EXCEPT removing the now-unused `workerWait` param** (user decision). After recovery lifts out, `workerWait` is the *only* dep with no surviving `OrchestratorService` reference (its sole use, service.ts:1165, moves to the controller) — remove it. All other params stay (still referenced: `workerSpawn`@2595, `workerDeliver`, `operators`, `launcher`, `sessionOutputStore`, …). Removal is **typecheck-driven**: delete the param, then `pnpm --filter @orca/daemon typecheck` flags every call site passing a 13th+ positional arg; fix each by dropping the `workerWait` argument; repeat until green. `workerWait` is still needed for the `RunnerPort` (via the hoisted `workerWaitFn` in `server.ts`) — it just stops being an `OrchestratorService` constructor arg.
- New files live under `apps/daemon/src/workflows/orchestrator/`.
- Test a single file: `pnpm --filter @orca/daemon test -- <path-substr>`; typecheck: `pnpm --filter @orca/daemon typecheck`. We are on `main` — branch first (e.g. `feat/orchestrator-decomp-ab`).
- This is a refactor: there is **no new behavior to TDD**. The discipline is **baseline-green → extract → green → typecheck**. Add a focused unit test only where it locks a non-obvious contract; it does not replace the suite guard.

---

### Task 1: Seam B — extract step scoring & result building

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/step-result-builder.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (delete 5 private methods at ~2896–3092; add deps getter; repoint 5 call sites)

**Interfaces:**
- Produces: module `step-result-builder.ts` exporting:
  - `StepResultBuilderDeps = { broker: Pick<OrchestrationTransportBroker,"propose">; readStepOutputAsRecord: (db, runId: string, stepRunId: string) => Record<string, unknown> | null; retryCount: (stepRun: StepRunRow) => number; artifactCountForStep: (db, stepRunId: string) => number }` — NB: type `retryCount`/`artifactCountForStep` to the **actual** class method signatures (`retryCount(stepRun: StepRunRow)`), not a guessed `(db, stepRunId)`.
  - `scoringFacts(deps, db, stepRun, terminalStatus, finishedAt): StepResultScoringFacts`
  - `buildApprovalStepResult(deps, db, ctx, scoring, finishedAt): WorkflowStepResult`
  - `withResultSummary(deps, db, stepRun, result): WorkflowStepResult`
  - `replayEvaluationFailedResult(deps, db, stepRun, finishedAt): WorkflowStepResult`
  - `scoreCompletedStepResult(deps, db, ctx, output, finishedAt): Promise<WorkflowStepResult>`

- [ ] **Step 1: Baseline — confirm the Seam B guard suites are green**

Run: `pnpm --filter @orca/daemon test -- service.skill-step session-completion service.agent-step`
Expected: PASS. (This is the before-state; if anything is already red, stop and report — do not refactor on a red baseline.)

- [ ] **Step 2: Create `step-result-builder.ts` by moving the 5 methods verbatim**

Create `apps/daemon/src/workflows/orchestrator/step-result-builder.ts`. Move the bodies of `scoringFacts` (service.ts ~2896–2915), `buildApprovalStepResult` (~2923–2954), `withResultSummary` (~2958–2990), `replayEvaluationFailedResult` (~2998–3015), `scoreCompletedStepResult` (~3017–3092) into exported free functions, each taking `deps: StepResultBuilderDeps` as the first parameter. Apply exactly these rewrites inside the moved bodies:
- `this.retryCount(` → `deps.retryCount(`
- `this.artifactCountForStep(` → `deps.artifactCountForStep(`
- `this.readStepOutputAsRecord(` → `deps.readStepOutputAsRecord(`
- `this.broker` → `deps.broker`
- intra-module calls: `this.scoringFacts(` → `scoringFacts(deps, `; `this.withResultSummary(` → `withResultSummary(deps, ` (i.e. lines 2929, 2933, 3003, 3028 become free-fn calls passing `deps` through)

Define the `StepResultBuilderDeps` interface at the top. Import the same types/free-fn helpers the methods currently use (`StepResultScoringFacts`, `WorkflowStepResult`, `StepResultScoringProposal`, `buildScoredStepResult`, `buildEvaluationFailedStepResult`, `scoreStepResult`, `OrchestrationTransportBroker`, `Database`, etc.) — copy the import set from `service.ts`.

- [ ] **Step 3: Add the deps getter to `OrchestratorService`**

In `service.ts`, add (near the other private helpers):
```ts
private get stepResultBuilderDeps(): StepResultBuilderDeps {
  return {
    broker: this.broker,
    readStepOutputAsRecord: this.readStepOutputAsRecord.bind(this),
    retryCount: this.retryCount.bind(this),
    artifactCountForStep: this.artifactCountForStep.bind(this),
  };
}
```
Add the import: `import { type StepResultBuilderDeps, scoringFacts, buildApprovalStepResult, withResultSummary, replayEvaluationFailedResult, scoreCompletedStepResult } from "./step-result-builder.js";` (`readStepOutputAsRecord`, `retryCount`, `artifactCountForStep` stay as private methods on the class — they are shared, not part of Seam B.)

- [ ] **Step 4: Repoint the 5 external call sites and delete the 5 private methods**

Repoint (the `ctx`/args are unchanged — only the receiver changes):
- service.ts:559 `this.replayEvaluationFailedResult(db, stepRun, finishedAt)` → `replayEvaluationFailedResult(this.stepResultBuilderDeps, db, stepRun, finishedAt)`
- service.ts:716 `this.scoringFacts(db, stepRun, "passed", finishedAt)` → `scoringFacts(this.stepResultBuilderDeps, db, stepRun, "passed", finishedAt)`
- service.ts:1890 `this.buildApprovalStepResult(db, ctx, action.scoring, finishedAt)` → `buildApprovalStepResult(this.stepResultBuilderDeps, db, ctx, action.scoring, finishedAt)`
- service.ts:2296 `this.buildApprovalStepResult(db, ctx, stash.scoring ?? undefined, stash.finishedAt)` → `buildApprovalStepResult(this.stepResultBuilderDeps, db, ctx, stash.scoring ?? undefined, stash.finishedAt)`
- service.ts:2842 `await this.scoreCompletedStepResult(db, ctx, …)` → `await scoreCompletedStepResult(this.stepResultBuilderDeps, db, ctx, …)` (keep the remaining args identical)

Then **delete** the 5 now-moved private methods (`scoringFacts`, `buildApprovalStepResult`, `withResultSummary`, `replayEvaluationFailedResult`, `scoreCompletedStepResult`) from `service.ts`.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: exit 0. (A type error here usually means a missed `this.*`→`deps.*` rewrite or a dropped import — fix it, don't loosen types.)

- [ ] **Step 6: Run the Seam B guard suites — confirm still green**

Run: `pnpm --filter @orca/daemon test -- service.skill-step session-completion service.agent-step`
Expected: PASS, identical to the Step 1 baseline.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/step-result-builder.ts apps/daemon/src/workflows/orchestrator/service.ts
git commit -m "refactor(orchestrator): extract step-result-builder (Seam B) out of OrchestratorService"
```

---

### Task 2: Seam A — lift provider recovery out into ProviderRecoveryController

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/runner-port.ts`
- Create: `apps/daemon/src/workflows/orchestrator/repair-context.ts`
- Create: `apps/daemon/src/workflows/orchestrator/provider-recovery-controller.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (delete 7 recovery methods + 2 helpers; repoint 4 helper call sites)
- Modify: `apps/daemon/src/server.ts` (hoist worker fns; build `RunnerPort`; construct controller; repoint 4 routes)
- Modify: `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts` (recovery tests target the controller)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `runner-port.ts`: `RunnerPort = { launch: WorkflowSessionLauncher["launch"]; workerSpawn: (input: { sessionId: string; goalId: string; adapterId: string }) => Promise<void>; workerDeliver: (sessionId: string, text: string) => Promise<"delivered"|"no_session"|"timeout">; workerWait: (sessionId: string, adapterId: string) => Promise<void>; readTail: SessionOutputStore["readTail"] }`
  - `repair-context.ts`: `collectPriorStepArtifacts(db, runId: string, currentStepRunId: string): Array<{ stepId: string; outputJson: unknown }>`; `latestRejectingGate(db, runId: string): { reason: string; issueRefs: string[] } | null`
  - `provider-recovery-controller.ts`: `class ProviderRecoveryController` with constructor `({ runner: RunnerPort; operators: Pick<OperatorRegistry,"list">; stepDispatch: StepDispatchCapabilities | undefined })` and public `waitForProvider`/`retryProvider`/`refreshProviderRecovery`/`switchProvider` (same signatures as the current `OrchestratorService` methods).

- [ ] **Step 1: Baseline — confirm the Seam A guard suites are green**

Run: `pnpm --filter @orca/daemon test -- provider-recovery service.adaptive-delivery service.agent-step`
Expected: PASS. (Before-state. `provider-recovery.test.ts` covers the pure helpers; `service.agent-step.test.ts` covers the recovery methods directly.)

- [ ] **Step 2: Extract the two pure helpers into `repair-context.ts`**

Create `apps/daemon/src/workflows/orchestrator/repair-context.ts`. Move `collectPriorStepArtifacts` (service.ts ~2628–2654) and `latestRejectingGate` (~2661–2669) **verbatim** as exported free functions (they use zero `this.*` — only `db`, ids, and free fns `listArtifactsForRun`/`listGateDecisionsForRun`). Copy their imports from `service.ts`.

- [ ] **Step 3: Repoint the orchestrator's 4 helper call sites and delete the 2 private methods**

In `service.ts`, add `import { collectPriorStepArtifacts, latestRejectingGate } from "./repair-context.js";` and repoint:
- service.ts:1361 `this.collectPriorStepArtifacts(db, run.id, stepRun.id)` → `collectPriorStepArtifacts(db, run.id, stepRun.id)`
- service.ts:1362 `this.latestRejectingGate(db, run.id)` → `latestRejectingGate(db, run.id)`
- service.ts:2579 `this.collectPriorStepArtifacts(db, ctx.run.id, ctx.stepRun.id)` → `collectPriorStepArtifacts(db, ctx.run.id, ctx.stepRun.id)`
- service.ts:2580 `this.latestRejectingGate(db, ctx.run.id)` → `latestRejectingGate(db, ctx.run.id)`

Then **delete** the `collectPriorStepArtifacts` and `latestRejectingGate` private methods from `service.ts`. Typecheck-confirm now: `pnpm --filter @orca/daemon typecheck` → exit 0.

- [ ] **Step 4: Create `runner-port.ts`**

Create `apps/daemon/src/workflows/orchestrator/runner-port.ts`:
```ts
import type { SessionOutputStore } from "../../sessions/output-store.js";
import type { WorkflowSessionLauncher } from "./session-launcher.js";

/**
 * The execution-plane capability surface the control plane invokes — the in-process
 * precursor to FUTURE_ARCHITECTURE's network Runner Protocol (the "local runner is
 * the first runner"). Grows to absorb workerTerminate/workerInterrupt when their
 * consumer (interruptStepAgent) is extracted.
 */
export interface RunnerPort {
  launch: WorkflowSessionLauncher["launch"];
  workerSpawn: (input: { sessionId: string; goalId: string; adapterId: string }) => Promise<void>;
  workerDeliver: (sessionId: string, text: string) => Promise<"delivered" | "no_session" | "timeout">;
  workerWait: (sessionId: string, adapterId: string) => Promise<void>;
  readTail: SessionOutputStore["readTail"];
}
```
(Both `import type` specifiers are verified against `service.ts` — `SessionOutputStore` at service.ts:38, `WorkflowSessionLauncher` at service.ts:68.)

- [ ] **Step 5: Create `provider-recovery-controller.ts` by moving the 7 recovery methods verbatim**

Create `apps/daemon/src/workflows/orchestrator/provider-recovery-controller.ts` with a `ProviderRecoveryController` class. Move these `OrchestratorService` methods into it **verbatim**: `loadProviderRecoveryContext` (~1079–1136), `persistCheckpoint` (~1138–1146), `waitForProvider` (~1149–1174), `retryProvider` (~1181–1235), `refreshProviderRecovery` (~1238–1272), `switchProvider` (~1280–1318), `startRecoveryReplacementSession` (~1330–1400). Keep `loadProviderRecoveryContext`/`persistCheckpoint`/`startRecoveryReplacementSession` `private`; the other four `public`, same signatures.

Constructor + rewrites:
```ts
constructor(private readonly deps: {
  runner: RunnerPort;
  operators: Pick<OperatorRegistry, "list">;
  stepDispatch: StepDispatchCapabilities | undefined;
}) {}
```
Inside the moved bodies, apply exactly:
- `this.workerWait(` → `this.deps.runner.workerWait(`
- `this.workerDeliver(` → `this.deps.runner.workerDeliver(`
- `this.workerSpawn(` → `this.deps.runner.workerSpawn(`
- `this.launcher.launch(` → `this.deps.runner.launch(`
- `this.sessionOutputStore.readTail(` → `this.deps.runner.readTail(`
- `this.operators.list(` → `this.deps.operators.list(`
- `this.stepDispatch?` → `this.deps.stepDispatch?`
- `this.collectPriorStepArtifacts(` → `collectPriorStepArtifacts(` (import from `./repair-context.js`)
- `this.latestRejectingGate(` → `latestRejectingGate(` (import from `./repair-context.js`)
- `this.loadProviderRecoveryContext`/`this.persistCheckpoint`/`this.startRecoveryReplacementSession` stay `this.*` (they're now methods on the controller)

Preserve the existing `undefined`-worker behavior exactly — the `RunnerPort` members carry the same optionality the constructor params had; if a body currently guards/throws on an absent worker fn, keep that guard verbatim.

**Concrete import sources** for the new file:
- `RunnerPort` from `./runner-port.js`
- `collectPriorStepArtifacts`, `latestRejectingGate` from `./repair-context.js`
- `buildProviderRecoveryChoices`, `composeProviderSwitchPrompt` from `./provider-recovery.js` (service.ts:109)
- `ProviderRecoveryCheckpoint` (and any other contract types the bodies use) from `@orca/contracts`
- `OperatorRegistry` from `../operators/registry.js` (service.ts:42)
- `StepDispatchCapabilities` from `./service.js` (it's `export interface` at service.ts:120 — type-only import; no cycle, since `service.ts` does NOT import the controller)
- `Database` type as `service.ts` imports it
- **Recovery error classes** (e.g. `OrchestratorProviderRecoveryNotFoundError`): grep `service.ts` for where these are declared. If they're defined *in* `service.ts`, either `export` them there and import into the controller, or move the recovery-specific ones into the controller file. Verify no other `service.ts` code still references a moved error class before deleting it from `service.ts`.

- [ ] **Step 6: Delete the 7 recovery methods from `OrchestratorService`**

Remove all 7 methods listed in Step 5 from `service.ts`. They have **no internal callers** (only `server.ts` and the test call the 4 public ones), so nothing else in `service.ts` references them. Keep the constructor params `launcher`, `workerSpawn`, `workerDeliver`, `sessionOutputStore`, `operators`, `stepDispatch` (all still referenced elsewhere). **Remove the `workerWait` constructor param** (now unused — see Step 6b). `onSessionOutputChunk` is untouched.

- [ ] **Step 6b: Remove the now-unused `workerWait` constructor param (typecheck-driven)**

In `service.ts`, delete the `workerWait?: (sessionId: string, adapterId: string) => Promise<void>` parameter-property from the `OrchestratorService` constructor (it sits between `recoveryPromptComposer` and `workerInterrupt`). Then run `pnpm --filter @orca/daemon typecheck` — it will error at every `new OrchestratorService(...)` site that passes a 13th+ positional arg (server.ts + the test `makeService` helpers that set wait/interrupt/otlp). Fix each flagged site by **dropping the `workerWait` positional argument** (the value that was the wait fn), leaving the args after it (workerInterrupt, otlpAccumulator) intact. Re-run typecheck until exit 0. `server.ts` keeps the hoisted `workerWaitFn` (Step 7) for the `RunnerPort` — only its constructor-arg position is removed.

- [ ] **Step 7: Wire `server.ts` — hoist worker fns, build `RunnerPort`, construct the controller, repoint routes**

In `apps/daemon/src/server.ts`, just before `const orchestratorService = new OrchestratorService(` (line ~699), hoist the three worker fns currently passed inline (the `workerSpawn` async body at 708–717, `workerDeliver` at 719, `workerWait` at 727) into named consts:
```ts
const workerSpawnFn = async ({ sessionId, goalId, adapterId }: { sessionId: string; goalId: string; adapterId: string }) => {
  /* …move the exact body from lines 709–716 verbatim… */
};
const workerDeliverFn = (sessionId: string, text: string) => workerSessions.deliver(sessionId, text);
const workerWaitFn = (sessionId: string, adapterId: string) => workerSessions.waitForProviderReset(sessionId, adapterId);
```
Pass `workerSpawnFn`/`workerDeliverFn` into the `new OrchestratorService(...)` positional args in place of those inline lambdas (behavior identical). **Do NOT pass `workerWaitFn` to the constructor** — the `workerWait` param was removed in Step 6b; drop that positional argument from this `new OrchestratorService(...)` call (the args after it — workerInterrupt, otlpAccumulator — stay). `workerWaitFn` is used **only** for the `RunnerPort` below. Then build the port + controller:
```ts
const runnerPort: RunnerPort = {
  launch: daemonContext.workflowSessionLauncher.launch.bind(daemonContext.workflowSessionLauncher),
  workerSpawn: workerSpawnFn,
  workerDeliver: workerDeliverFn,
  workerWait: workerWaitFn,
  readTail: sessionOutputStore.readTail.bind(sessionOutputStore),
};
const recoveryController = new ProviderRecoveryController({
  runner: runnerPort,
  operators: daemonContext.operatorRegistry,
  stepDispatch: daemonContext.stepDispatchCapabilities,
});
```
Add imports for `RunnerPort` and `ProviderRecoveryController`. Repoint the 4 routes: change `orchestratorService.waitForProvider(` (1920), `orchestratorService.retryProvider(` (1943), `orchestratorService.refreshProviderRecovery(` (1966), `orchestratorService.switchProvider(` (1989) to `recoveryController.waitForProvider(` / `.retryProvider(` / `.refreshProviderRecovery(` / `.switchProvider(` — args unchanged.

- [ ] **Step 8: Repoint the recovery tests to the controller**

In `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts`, the recovery tests call `service.waitForProvider(...)`/`retryProvider(...)`/`switchProvider(...)` directly. In that file's `makeService`/setup, also construct a `ProviderRecoveryController` from the **same fakes** the service uses (build a `RunnerPort` from the fake worker fns + fake `sessionOutputStore.readTail`, plus the fake `operatorRegistry`/`stepDispatch`), and change the recovery-test call sites from `service.<m>(...)` to `recoveryController.<m>(...)`. DB setup and all assertions stay identical — this is a mechanical receiver change, not a behavior change. (If the fakes for worker fns / sessionOutputStore aren't already in that file's helper, mirror how `server.ts` supplies them.)

- [ ] **Step 9: Typecheck**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: exit 0.

- [ ] **Step 10: Run the Seam A guard suites + the full orchestrator suite**

Run: `pnpm --filter @orca/daemon test -- provider-recovery service.adaptive-delivery service.agent-step`
Expected: PASS (recovery tests now exercise the controller).

Run: `pnpm --filter @orca/daemon test -- orchestrator`
Expected: PASS (full orchestrator suite — the broad behavior-preservation guard).

- [ ] **Step 11: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/runner-port.ts apps/daemon/src/workflows/orchestrator/repair-context.ts apps/daemon/src/workflows/orchestrator/provider-recovery-controller.ts apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/server.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "refactor(orchestrator): lift provider recovery into ProviderRecoveryController + RunnerPort (Seam A)"
```

---

### Task 3: Update FUTURE_WORK.md 0.2

**Files:**
- Modify: `FUTURE_WORK.md` (the 0.2 section)

- [ ] **Step 1: Record A+B done and the C/D coupling reality**

In `FUTURE_WORK.md` §0.2, note that Seams B (step-result-builder) and A (provider recovery → `ProviderRecoveryController` + `RunnerPort`) are extracted, and that **C (ledger commit) and D (gate/splitter routing) are a single bidirectionally-coupled cluster** (not two independent seams) deferred to their own brainstorm — `commitAdvanceOrComplete` ↔ `routeGateDestination`/park methods mutually recurse and re-enter `requestNextDecision`. Keep the four collaborator-extraction bullets that remain (provider recovery now done; the other three are C/D + the already-done emit slice).

- [ ] **Step 2: Commit**

```bash
git add FUTURE_WORK.md
git commit -m "docs(future-work): mark 0.2 Seams A+B done; record C/D as one coupled cluster"
```

---

## Notes for the executor

- **Verbatim moves.** For every method body move, the ONLY edits are the `this.*`→`deps.*`/free-fn rewrites listed in the step. If you find yourself changing control flow, stop — that's not this refactor.
- **Baseline-green discipline.** Each task starts by running its guard suite to confirm green. If the baseline is red, stop and report — never refactor on a red baseline.
- **Line numbers drift** as you edit within a task. Anchor on the quoted code/method names, not the absolute line number.
- **The constructor signature is frozen except `workerWait`** — remove only that one now-unused param (Step 6b, typecheck-driven across all call sites); keep every other param.
- **The one honest test change** is Step 8 (recovery tests repoint to the controller) — same assertions, new receiver. Everything else is tests-unchanged.
