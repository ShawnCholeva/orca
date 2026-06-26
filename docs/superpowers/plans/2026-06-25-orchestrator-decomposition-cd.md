# OrchestratorService Decomposition (C/D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the pure ledger-commit trio to a module and consolidate shared DB-row access into `db-rows.ts`, leaving the cohesive advance/route engine in place (documented), with no behavior change.

**Architecture:** `db-rows.ts` first (shared `GoalRow`/`StepRunRow`/`readGoal`/`readStepRun`/`preferencesForGoal` + the 2 error classes the readers throw) so it imports from no orchestrator file (no cycle); then `ledger-commit.ts` (the trio as free functions, zero `this.*`, no deps object) importing row types from `db-rows.ts`; then a doc-comment on the engine + a FUTURE_WORK update.

**Tech Stack:** TypeScript, better-sqlite3, vitest. Daemon package `@orca/daemon`.

## Global Constraints

- **No behavior change.** Verbatim moves / pure relocations. Existing service-level suites are the guard; discipline is **baseline-green → change → typecheck → suites green → commit**.
- **No public-API change.** No `OrchestratorService` public-method signature changes (the ledger trio is private; row helpers/types/errors are module-internal relocations).
- **No forwarding stubs.** Moved private methods are deleted; call sites repoint.
- **`db-rows.ts` imports from no orchestrator file** (only `Database` type, `adapterIdForProvider` from `../../orchestrator-llm/model-provider-llm-client.js`, `StepAgentChoice` from `@orca/contracts`) — so it can never create a cycle.
- **Move bodies verbatim;** only the documented edits. State substrate stays unified (same `db` threaded; no per-unit state).
- We are on `main` — branch first (e.g. `feat/orchestrator-decomp-cd`). Single-file test: `pnpm --filter @orca/daemon test -- <substr>`; typecheck: `pnpm --filter @orca/daemon typecheck`.
- Refactor → **no new behavior tests**; existing suites guard. Optional unit tests only where they lock a non-obvious contract.

---

### Task 1: `db-rows.ts` — consolidate shared DB-row access

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/db-rows.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (delete 7 definitions; import them back)
- Modify: `apps/daemon/src/workflows/orchestrator/step-result-builder.ts` (delete local re-declarations; import)
- Modify: `apps/daemon/src/workflows/orchestrator/provider-recovery-controller.ts` (repoint imports)
- Modify: `apps/daemon/src/workflows/orchestrator/routes.ts` (repoint error-class imports)

**Interfaces:**
- Produces from `db-rows.ts`: `interface GoalRow`, `interface StepRunRow`, `readGoal(db, goalId: string): GoalRow`, `readStepRun(db, stepRunId: string | null): StepRunRow`, `preferencesForGoal(preferences: StepAgentChoice[], orchestratorProvider: GoalRow["orchestrator_provider"]): StepAgentChoice[]`, `class OrchestratorGoalNotFoundError`, `class OrchestratorStepNotFoundError`.

- [ ] **Step 1: Baseline — confirm the daemon suite is green**

Run: `pnpm --filter @orca/daemon test -- orchestrator`
Expected: PASS. (Before-state; if red, STOP and report — do not refactor on a red baseline.)

- [ ] **Step 2: Create `db-rows.ts` by moving the 7 definitions verbatim**

Create `apps/daemon/src/workflows/orchestrator/db-rows.ts`. Move **verbatim** from `service.ts`: `interface GoalRow` (123), `interface StepRunRow` (215), `class OrchestratorStepNotFoundError` (260), `class OrchestratorGoalNotFoundError` (278), `function readStepRun` (318), `function readGoal` (327), `function preferencesForGoal` (202). Export all 7 (the readers/preferencesForGoal/errors were `export`; make `readStepRun` and both interfaces `export` too). Imports the new file needs:
```ts
import type Database from "better-sqlite3";
import type { StepAgentChoice } from "@orca/contracts";
import { adapterIdForProvider } from "../../orchestrator-llm/model-provider-llm-client.js";
```
(Confirm `StepAgentChoice`'s exact import specifier against `service.ts` — copy it.)

- [ ] **Step 3: Repoint `service.ts` — delete the 7 defs, import them back**

In `service.ts`, delete the 7 moved definitions and add:
```ts
import {
  type GoalRow,
  type StepRunRow,
  readGoal,
  readStepRun,
  preferencesForGoal,
  OrchestratorGoalNotFoundError,
  OrchestratorStepNotFoundError,
} from "./db-rows.js";
```
All existing usages in `service.ts` (the `ctx` type annotations, `readGoal(...)`/`readStepRun(...)`/`preferencesForGoal(...)` calls, and `throw new Orchestrator*NotFoundError(...)`) stay byte-identical — only the definitions moved.

- [ ] **Step 4: Repoint `step-result-builder.ts` — delete local re-declarations, import**

In `step-result-builder.ts`, delete the local `interface StepRunRow` (line 19) and `interface GoalRow` (line 37); add `import type { GoalRow, StepRunRow } from "./db-rows.js";`. (The db-rows `StepRunRow` is the full row type; the builder functions use a subset of fields, so this is safe — typecheck confirms.)

- [ ] **Step 5: Repoint `provider-recovery-controller.ts` import source**

In `provider-recovery-controller.ts`, change the two import blocks that pull `GoalRow`/`StepRunRow` (lines 19–21) and `readGoal`/`preferencesForGoal` (lines 25–27) from `"./service.js"` to `"./db-rows.js"` (merge into one import if cleaner). No other change.

- [ ] **Step 6: Repoint `routes.ts` error-class imports**

In `routes.ts`, the import block (lines 14–21) pulls `OrchestratorGoalNotFoundError`/`OrchestratorStepNotFoundError` (and other names) from `"./service.js"`. Split it: import those **two** error classes from `"./db-rows.js"`, leave the rest importing from `"./service.js"`. The `error instanceof …` usages (lines 88–89) stay unchanged.

- [ ] **Step 7: Typecheck (enumerates any remaining importer)**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: exit 0. If it flags another file still importing a moved symbol from `./service.js` (or expecting it there), repoint that import to `./db-rows.js` and re-run until green. (Known importers handled above: service.ts, step-result-builder.ts, provider-recovery-controller.ts, routes.ts.)

- [ ] **Step 8: Run the daemon suite — confirm still green**

Run: `pnpm --filter @orca/daemon test -- orchestrator`
Expected: PASS, identical to Step 1 baseline.

- [ ] **Step 9: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/db-rows.ts apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/step-result-builder.ts apps/daemon/src/workflows/orchestrator/provider-recovery-controller.ts apps/daemon/src/workflows/orchestrator/routes.ts
git commit -m "refactor(orchestrator): consolidate shared DB-row access into db-rows.ts"
```

---

### Task 2: `ledger-commit.ts` — extract the pure ledger trio

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/ledger-commit.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (delete 3 methods; repoint 2 call sites)

**Interfaces:**
- Consumes from Task 1: `GoalRow`, `StepRunRow` from `./db-rows.js`.
- Produces from `ledger-commit.ts`:
  - `createStepOutputArtifact(db, now, ctx, body: string, options: RequestNextDecisionOptions, stagedEvents: DomainEvent[]): void`
  - `commitStepOutputAndLedger(db, now, ctx, output: unknown, updates: LedgerUpdate[], options, stagedEvents): void`
  - `completeStepWithLedger(db, now, ctx, block: unknown, options, stagedEvents, onReject?: "revise" | "drop"): Promise<{ rejections: string[] } | null>`
  - (`ctx` is `{ run: WorkflowRunT; stepRun: StepRunRow; stepTpl: WorkflowStepTemplate; goal: GoalRow }` — match the exact ctx type the methods use today.)

- [ ] **Step 1: Baseline — confirm the ledger-guard suites are green**

Run: `pnpm --filter @orca/daemon test -- service.skill-step service.agent-step service.gate-routing`
Expected: PASS. (These exercise the completion/ledger paths transitively.)

- [ ] **Step 2: Create `ledger-commit.ts` by moving the 3 methods verbatim**

Create `apps/daemon/src/workflows/orchestrator/ledger-commit.ts`. Move the bodies of `completeStepWithLedger` (service.ts:2886–2927), `commitStepOutputAndLedger` (2930–2952), `createStepOutputArtifact` (2954–2985) into exported free functions. **No deps object** (they have zero `this.*`). The only rewrites: the intra-trio calls become direct free-fn calls — `this.commitStepOutputAndLedger(...)` → `commitStepOutputAndLedger(...)`, `this.createStepOutputArtifact(...)` → `createStepOutputArtifact(...)`. Copy the import set the bodies use from `service.ts`: `createArtifact` (`../artifacts/usecases.js`), `commitLedgerVersion` + `latestCommittedLedger` (`../ledger/usecases.js`), `parseStepCompletionEnvelope`, `reviewAndNormalizeLedgerUpdates`, `LedgerUpdate` (from their current sources), `GoalRow`/`StepRunRow` from `./db-rows.js`, `WorkflowRunT`/`WorkflowStepTemplate` (the ctx types), `DomainEvent`, `RequestNextDecisionOptions`, `Database` — copy each specifier verbatim from `service.ts`.

- [ ] **Step 3: Repoint the 2 call sites and delete the 3 methods**

In `service.ts`, import the externally-called functions from `./ledger-commit.js` — `completeStepWithLedger` AND `createStepOutputArtifact` (the latter has a 3rd external caller in `commitSkillStepApproval`, ~service.ts:2371, beyond the two `completeStepWithLedger` sites; `commitStepOutputAndLedger` is the only purely-internal one). Run typecheck to enumerate every external call site. Repoint:
- service.ts:1526 `await this.completeStepWithLedger(db, now, ctx, block, options, stagedEvents)` → `await completeStepWithLedger(db, now, ctx, block, options, stagedEvents)`
- service.ts:1940 `await this.completeStepWithLedger(db, now, ctx, stash.block, options, stagedEvents, "drop")` → `await completeStepWithLedger(db, now, ctx, stash.block, options, stagedEvents, "drop")`

Then **delete** the 3 methods (`completeStepWithLedger`, `commitStepOutputAndLedger`, `createStepOutputArtifact`) from `service.ts`. Remove any now-orphaned imports in `service.ts` that were used only by the moved bodies (e.g. `createArtifact`/`commitLedgerVersion`/`parseStepCompletionEnvelope`/`reviewAndNormalizeLedgerUpdates` — verify each is unused elsewhere in `service.ts` before removing; if still used, keep it).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: exit 0.

- [ ] **Step 5: Run the ledger-guard suites — confirm still green**

Run: `pnpm --filter @orca/daemon test -- service.skill-step service.agent-step service.gate-routing`
Expected: PASS, identical to Step 1 baseline.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/ledger-commit.ts apps/daemon/src/workflows/orchestrator/service.ts
git commit -m "refactor(orchestrator): extract pure ledger-commit trio into ledger-commit.ts"
```

---

### Task 3: Document the cohesive engine + update FUTURE_WORK

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (doc-comment on `commitAdvanceOrComplete`)
- Modify: `FUTURE_WORK.md` (0.2 update + DispatchEngine item)

- [ ] **Step 1: Add the engine doc-comment**

In `service.ts`, add a doc-comment directly above `commitAdvanceOrComplete` (it moved during Task 2 deletions — find it by name, ~private async `commitAdvanceOrComplete(`):
```ts
/**
 * The advance/route engine — intentionally NOT extracted. This method plus the
 * gate/splitter routing (parkForGateApproval, evaluateAndParkSplitter,
 * routeGateDestination, decideGate, confirm*) form the orchestrator's irreducible
 * dispatch core: it recurses into requestNextDecision and calls spawnStepAgent,
 * with a routeGateDestination ⇄ evaluateAndParkSplitter cycle. Extracting it would
 * require injecting ~7 host callbacks (incl. requestNextDecision/spawnStepAgent it
 * recurses into) — a pass-through, not a seam. FUTURE_ARCHITECTURE: "deterministic
 * code owns lifecycle, routing, gates" (one core). The principled larger move is the
 * DispatchEngine split (FUTURE_WORK 0.2) — its own deliberate effort, not a piecemeal
 * extraction.
 */
```

- [ ] **Step 2: Update `FUTURE_WORK.md` 0.2**

In `FUTURE_WORK.md` §0.2: mark the **ledger trio + db-rows** done; state that **the advance/route engine is intentionally kept whole** (the coupling/pass-through reasoning); and add a new sub-item:

> 🟡 **DispatchEngine split (the principled larger move).** Relocate the cohesive engine (`requestNextDecision` + `commitAdvanceOrComplete` + gate/splitter routing + `spawnStepAgent` + `advanceToNextStep` + `reviseStep` + decision/event plumbing) into a `DispatchEngine` class, leaving `OrchestratorService` as the event-handler/reaction layer (`onWorkflowSessionCompleted`/`onSessionOutputChunk`/`onAgentResponseDone`/`onUserMessage`/`confirmStep`/revisions/…). The handler→engine dependency is **one-directional/acyclic** (verified: no engine method calls back into a handler), so it's a clean split — but a large, high-risk relocation of the most safety-critical code with a wide seam; **its own brainstorm/spec/SDD cycle.** Not piecemeal.

- [ ] **Step 3: Typecheck (doc-comment sanity) + commit**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: exit 0.

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts FUTURE_WORK.md
git commit -m "docs(orchestrator): document the irreducible engine; FUTURE_WORK 0.2 ledger/db-rows done + DispatchEngine item"
```

---

## Notes for the executor

- **Order matters:** `db-rows.ts` (Task 1) before `ledger-commit.ts` (Task 2) — the trio's `ctx` type imports `GoalRow`/`StepRunRow` from `db-rows.ts`, so doing db-rows first avoids a throwaway import-from-service.
- **Verbatim moves / pure relocations:** the only edits inside moved bodies are the intra-trio `this.X(`→`X(` rewrites (Task 2) and the import repoints (Task 1). No control-flow changes.
- **Baseline-green discipline** at each task; red baseline → stop and report.
- **Line numbers drift** as you edit — anchor on quoted code / symbol names, not absolute lines.
- **Engine untouched** beyond Task 3's doc-comment — do NOT attempt to extract `commitAdvanceOrComplete` or any gate/splitter method.
