# DispatchEngine Split — Phase 1 (Narrow the Seam) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the pure utility/query shared-helpers out of `OrchestratorService` to free-function modules and drop the dead `operatorSelector` constructor param — no behavior change.

**Architecture:** Three free-function extractions (delete-and-repoint, no forwarding stubs) plus a typecheck-driven dead-param removal. Each helper is verified `this.*`-free, so it moves with no deps object.

**Tech Stack:** TypeScript, better-sqlite3, vitest. Daemon package `@orca/daemon`.

## Global Constraints

- **No behavior change.** Verbatim moves / pure relocations. Existing service-level suites are the guard; discipline is **baseline-green → extract → typecheck → suites green → commit**. Red baseline → STOP and report.
- **No public-API change** (all moved methods are private helpers).
- **No forwarding stubs** — deleted private methods; call sites repoint to the free functions.
- **Move bodies verbatim;** the only edits are removing `private`/`this.` and the call-site receiver. No control-flow changes.
- We are on `main` — branch first (e.g. `feat/dispatchengine-narrow-seam`). Single-file test: `pnpm --filter @orca/daemon test -- <substr>`; typecheck: `pnpm --filter @orca/daemon typecheck`.
- Refactor → **no new behavior tests**; existing suites guard. Optional unit tests only where they lock a non-obvious contract.

---

### Task 1: `queries.ts` — extract the 5 pure read helpers

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/queries.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`

**Interfaces:**
- Produces from `queries.ts`:
  - `stepRunIdsByTemplateId(db, workflowRunId: string): Record<string, string>`
  - `artifactCountForStep(db, stepRunId: string): number`
  - `retryCount(stepRun: StepRunRow): number`
  - `hasActiveUnansweredQuestion(db, stepArtifacts: ReturnType<typeof listArtifactsForRun>, stepRunId: string): boolean`
  - `readStepOutputAsRecord(db, runId: string, stepRunId: string): Record<string, unknown> | null`

- [ ] **Step 1: Baseline — confirm the orchestrator suite is green**

Run: `pnpm --filter @orca/daemon test -- orchestrator`
Expected: PASS. (If red, STOP and report — do not refactor on a red baseline.)

- [ ] **Step 2: Create `queries.ts` by moving the 5 helpers verbatim**

Create `apps/daemon/src/workflows/orchestrator/queries.ts`. Move the bodies of `stepRunIdsByTemplateId` (service.ts:2392–2404), `artifactCountForStep` (2406–2412), `retryCount` (2414–2420), `hasActiveUnansweredQuestion` (2431–2449), `readStepOutputAsRecord` (2990–3010) **verbatim** as exported free functions (drop `private`; they are already `this.*`-free). Imports the file needs:
```ts
import type Database from "better-sqlite3";
import { InterviewTurn } from "@orca/contracts";
import type { StepRunRow } from "./db-rows.js";
import { listArtifactsForRun } from "../artifacts/projection.js";
```
(`InterviewTurn` is used by `hasActiveUnansweredQuestion`; `listArtifactsForRun` only for its `ReturnType<>` in that signature; `StepRunRow` for `retryCount`. Confirm each specifier against `service.ts`.)

- [ ] **Step 3: Repoint call sites + the deps getter; delete the 5 methods**

In `service.ts`, add `import { stepRunIdsByTemplateId, artifactCountForStep, retryCount, hasActiveUnansweredQuestion, readStepOutputAsRecord } from "./queries.js";`. Repoint:
- the 2 `this.stepRunIdsByTemplateId(...)` call sites → `stepRunIdsByTemplateId(...)`
- the 2 `this.hasActiveUnansweredQuestion(...)` call sites → `hasActiveUnansweredQuestion(...)`
- the 1 `this.readStepOutputAsRecord(...)` call site → `readStepOutputAsRecord(...)`
- the `stepResultBuilderDeps` getter (service.ts:2422–2429): replace `readStepOutputAsRecord: this.readStepOutputAsRecord.bind(this)`, `retryCount: this.retryCount.bind(this)`, `artifactCountForStep: this.artifactCountForStep.bind(this)` with the bare free-fn references `readStepOutputAsRecord`, `retryCount`, `artifactCountForStep` (keep `broker: this.broker`).

Then **delete** the 5 methods from `service.ts`. (`retryCount`/`artifactCountForStep` have no direct `this.` call sites beyond the getter; `readStepOutputAsRecord` has one direct site + the getter — all handled above.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: exit 0. (A type error usually means a missed repoint — fix it.)

- [ ] **Step 5: Run the orchestrator suite — confirm still green**

Run: `pnpm --filter @orca/daemon test -- orchestrator`
Expected: PASS, identical to Step 1 baseline.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/queries.ts apps/daemon/src/workflows/orchestrator/service.ts
git commit -m "refactor(orchestrator): extract pure read-query helpers into queries.ts"
```

---

### Task 2: `orchestrator-message.ts` + `publishStaged`

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/orchestrator-message.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/queries.ts` (add `publishStaged`)
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`

**Interfaces:**
- Produces:
  - `postOrchestratorMessage(db, now: () => string, goalId: string, body: string, options: RequestNextDecisionOptions, role?: "orchestrator" | "user", pendingQuestion?: PendingQuestionT, pendingRevision?: { workflowRunId: string }): void` (from `orchestrator-message.ts`)
  - `publishStaged(bus: EventBus | undefined, events: DomainEvent[]): void` (from `queries.ts`)

- [ ] **Step 1: Baseline — confirm green**

Run: `pnpm --filter @orca/daemon test -- orchestrator`
Expected: PASS.

- [ ] **Step 2: Create `orchestrator-message.ts` by moving `postOrchestratorMessage` verbatim**

Create `apps/daemon/src/workflows/orchestrator/orchestrator-message.ts`. Move the body of `postOrchestratorMessage` (service.ts:1715–1767) **verbatim** as an exported free function (drop `private`; it's already `this.*`-free). Imports it needs:
```ts
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { DomainEvent } from "@orca/contracts";
import type { RequestNextDecisionOptions } from "./service.js";   // import type — erased, no runtime cycle (same pattern as ledger-commit.ts)
```
Plus the `PendingQuestionT` type — copy its exact import specifier from `service.ts`. (`role` defaults to `"orchestrator"` exactly as in the original.)

- [ ] **Step 3: Add `publishStaged` to `queries.ts`**

Append to `apps/daemon/src/workflows/orchestrator/queries.ts`:
```ts
import type { DomainEvent } from "@orca/contracts";
import type { EventBus } from "../../events.js";
import { publishStagedWorkflowEvents } from "../events.js";

/** Flush staged workflow events if a bus is present (the orchestrator's publish guard). */
export function publishStaged(bus: EventBus | undefined, events: DomainEvent[]): void {
  if (bus) publishStagedWorkflowEvents(bus, events);
}
```
(Confirm the `EventBus` import path matches how `service.ts` imports it — `../../events.js`. `publishStagedWorkflowEvents` is already imported in `service.ts` from `../events.js`.)

- [ ] **Step 4: Repoint call sites; delete both methods**

In `service.ts`:
- add `import { postOrchestratorMessage } from "./orchestrator-message.js";` and add `publishStaged` to the `./queries.js` import.
- repoint the 17 `this.postOrchestratorMessage(...)` call sites → `postOrchestratorMessage(...)` (args unchanged).
- repoint the 15 `this.publish(...)` call sites → `publishStaged(...)` (args unchanged — both take `(bus, events)`).
- **delete** the `postOrchestratorMessage` method (1715–1767) and the `publish` method (3866–3870) from `service.ts`. If `publishStagedWorkflowEvents` is now unused directly in `service.ts` (it was only used inside the deleted `publish`), remove it from the `../events.js` import — verify first (typecheck will flag if still needed; note `noUnusedLocals` is off, so grep `service.ts` for `publishStagedWorkflowEvents` to confirm zero remaining uses before removing).

- [ ] **Step 5: Typecheck + suite**

Run: `pnpm --filter @orca/daemon typecheck` → exit 0.
Run: `pnpm --filter @orca/daemon test -- orchestrator` → PASS (identical to baseline).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/orchestrator-message.ts apps/daemon/src/workflows/orchestrator/queries.ts apps/daemon/src/workflows/orchestrator/service.ts
git commit -m "refactor(orchestrator): extract postOrchestratorMessage + publishStaged helpers"
```

---

### Task 3: Drop the dead `operatorSelector` constructor param

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (constructor)
- Modify: every `new OrchestratorService(...)` site (server.ts + test `makeService` helpers) — enumerated by typecheck

- [ ] **Step 1: Baseline — confirm green + confirm operatorSelector is dead**

Run: `pnpm --filter @orca/daemon test -- orchestrator` → PASS.
Run: `rg -n "operatorSelector" apps/daemon/src/workflows/orchestrator/service.ts` → expect ONE hit (the constructor param at line ~408). If there are other usages, STOP and report (it's not dead).

- [ ] **Step 2: Delete the `operatorSelector` constructor parameter**

In `service.ts`, delete the `private readonly operatorSelector: Pick<OperatorSelector, "select">,` parameter (the FIRST constructor param, ~line 408). Remove the now-unused `OperatorSelector` import if nothing else in `service.ts` uses it (grep to confirm).

- [ ] **Step 3: Typecheck — enumerate + fix every construction site**

Run: `pnpm --filter @orca/daemon typecheck`
It will error at every `new OrchestratorService(...)` call passing a first positional arg that no longer matches (server.ts + the test `makeService` helpers). For EACH flagged site, **drop the first positional argument** (the `operatorSelector`/selector value). Re-run typecheck until exit 0. (The param was first, so removal shifts all args — typecheck flags every site; none can be silently missed.)

- [ ] **Step 4: Run the full orchestrator suite**

Run: `pnpm --filter @orca/daemon test -- orchestrator`
Expected: PASS. (The construction-site changes are arity-only; behavior unchanged.)

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/server.ts apps/daemon/src/workflows/orchestrator/*.test.ts
git commit -m "refactor(orchestrator): drop dead operatorSelector constructor param"
```
(Adjust `git add` to whatever files typecheck flagged — include every `new OrchestratorService(...)` site that changed.)

---

## Notes for the executor

- **Verbatim moves:** the only edits to a moved body are dropping `private` and the `this.` prefix; nothing else. If a moved method has a `this.X` that ISN'T a parameter (i.e. it's not actually `this.*`-free), STOP and report.
- **Baseline-green discipline** at each task; red baseline → stop.
- **Line numbers drift** as you edit — anchor on quoted code / method names.
- **`noUnusedLocals` is off** (known gap, FUTURE_WORK Appendix B) — it will NOT flag orphaned imports, so when a task says "remove the now-unused import," grep to confirm zero remaining uses rather than relying on typecheck.
- **Phase 2 (the two-class DispatchEngine split) is NOT in this plan** — it's its own brainstorm after this lands.
