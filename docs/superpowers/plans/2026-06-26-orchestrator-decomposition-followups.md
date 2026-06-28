# Orchestrator Decomposition Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four tracked mechanical cleanups from the orchestrator-decomposition arc — extract shared dispatch types, finish the dead `operatorSelector` excision, rename pure-engine test locals, and enable `noUnusedLocals`.

**Architecture:** Four independent, no-behavior-change cleanups, each its own task and commit. Existing suites are the guard.

**Tech Stack:** TypeScript, vitest. Daemon package `@orca/daemon`.

## Global Constraints

- **No behavior change.** Pure refactors/cleanups. Existing suites are the guard; discipline: **baseline-green → change → typecheck → suites green → commit.** Red baseline → STOP and report.
- We are on `main` — branch first (e.g. `feat/orchestrator-decomp-followups`). Typecheck: `pnpm --filter @orca/daemon typecheck`; single-file test: `pnpm --filter @orca/daemon test -- <substr>`.
- `noUnusedLocals` is OFF until Task 4 — until then, grep to confirm an import is unused before removing it.
- Tasks are independent; do them in order (1→4) so Task 4's gate also catches any orphan the earlier tasks leave.

---

### Task 1: Extract shared dispatch types/errors → `dispatch-types.ts`

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/dispatch-types.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts` (remove the moved defs; import them)
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (drop the type/error re-export; import from dispatch-types)
- Modify: every other importer of these symbols from `./service.js` (typecheck-enumerated): `ledger-commit.ts`, `orchestrator-message.ts`, `provider-recovery-controller.ts`, `routes.ts`, `steps/routes.ts`, and the test files (`skill-step-test-helpers.ts`, `session-completion.test.ts`, `agent-interview.test.ts`, `service.adaptive-delivery.test.ts`, `readiness/service.test.ts`)

**Interfaces:**
- Produces from `dispatch-types.ts`: `interface StepDispatchCapabilities`, `interface RequestNextDecisionOptions`, `interface TokenAccumulator`, `class OrchestratorRunNotFoundError`, `class OrchestratorRunNotActiveError`, `class OrchestratorTemplateNotFoundError`.

- [ ] **Step 1: Baseline — confirm green**

Run: `pnpm --filter @orca/daemon test -- orchestrator`
Expected: PASS. (Red baseline → STOP.)

- [ ] **Step 2: Create `dispatch-types.ts` by moving the 3 types + 3 error classes verbatim**

Create `apps/daemon/src/workflows/orchestrator/dispatch-types.ts`. Move **verbatim** from `dispatch-engine.ts`: `StepDispatchCapabilities` (84–88), `RequestNextDecisionOptions` (90–97), `TokenAccumulator` (128–…), and the three error classes `OrchestratorRunNotFoundError` (99–106), `OrchestratorRunNotActiveError` (108–115), `OrchestratorTemplateNotFoundError` (117–124). Add the imports the interfaces need (`ResolvedMode`, `EventBus`, `WorkflowStepResult`, `StateDepsFacet` — copy the exact specifiers from `dispatch-engine.ts`). Export all 6.

- [ ] **Step 3: `dispatch-engine.ts` — delete the moved defs, import them back**

In `dispatch-engine.ts`, delete those 6 definitions; add `import { type StepDispatchCapabilities, type RequestNextDecisionOptions, type TokenAccumulator, OrchestratorRunNotFoundError, OrchestratorRunNotActiveError, OrchestratorTemplateNotFoundError } from "./dispatch-types.js";`. All in-file usages unchanged.

- [ ] **Step 4: `service.ts` — import from dispatch-types; drop the type/error re-export**

In `service.ts`, change the imports of `StepDispatchCapabilities`/`RequestNextDecisionOptions`/`TokenAccumulator` + the 3 error classes from `./dispatch-engine.js` to `./dispatch-types.js`. **Delete** the re-export block lines that re-export these 6 symbols (service.ts:102–106 the `export type {...}` and the 3 error classes from the `export {...}` at 107–114). Keep the runtime-helper re-exports (`NULL_ACCUMULATOR`, `buildTelemetry`, `nowWithFirstTimestamp`) — they stay in `dispatch-engine.ts`, re-exported from `service.ts` as before.

- [ ] **Step 5: Repoint the other importers; typecheck-enumerate the rest**

Repoint these files' imports of the 6 symbols from `./service.js` (or `../orchestrator/service.js`) to `dispatch-types.js`: `ledger-commit.ts`, `orchestrator-message.ts`, `provider-recovery-controller.ts`, `routes.ts`, `steps/routes.ts`, and the test files (`skill-step-test-helpers.ts`, `session-completion.test.ts`, `agent-interview.test.ts`, `service.adaptive-delivery.test.ts`, `readiness/service.test.ts`). Then run `pnpm --filter @orca/daemon typecheck` — it flags any remaining importer expecting these from `service.js`; repoint each to `dispatch-types.js` until exit 0. (Other modules that import these via `db-rows.js` are unrelated — `OrchestratorStepNotFoundError`/`OrchestratorGoalNotFoundError` live in `db-rows.ts`, not here; do NOT touch those.)

- [ ] **Step 6: Typecheck + suite**

Run: `pnpm --filter @orca/daemon typecheck` → exit 0.
Run: `pnpm --filter @orca/daemon test -- orchestrator readiness steps/routes` → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/dispatch-types.ts apps/daemon/src/workflows/orchestrator/dispatch-engine.ts apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/ledger-commit.ts apps/daemon/src/workflows/orchestrator/orchestrator-message.ts apps/daemon/src/workflows/orchestrator/provider-recovery-controller.ts apps/daemon/src/workflows/orchestrator/routes.ts apps/daemon/src/workflows/steps/routes.ts apps/daemon/src/workflows/orchestrator/*.test.ts apps/daemon/src/readiness/service.test.ts
git commit -m "refactor(orchestrator): extract shared dispatch types/errors into dispatch-types.ts"
```

---

### Task 2: Finish the dead `operatorSelector` excision

**Files:**
- Modify: `apps/daemon/src/daemon-context.ts` (drop the field + construction + import)
- Possibly modify: `apps/daemon/src/workflows/operators/selector.ts` (drop the `OperatorSelector` class if dead)

- [ ] **Step 1: Baseline — confirm green + confirm `operatorSelector` is dead**

Run: `pnpm --filter @orca/daemon test -- orchestrator` → PASS.
Run: `rg -n "operatorSelector|OperatorSelector" apps/daemon/src --glob '*.ts' | grep -v "\.test\.ts"`. Expect the ONLY non-test references are in `daemon-context.ts` (import + `operatorSelector:` field + `new OperatorSelector(...)` construction) and the class definition in `workflows/operators/selector.ts`. If any other non-test file reads `.operatorSelector` or uses the class, STOP and report.

- [ ] **Step 2: Remove the `operatorSelector` wiring from `daemon-context.ts`**

In `daemon-context.ts`: delete the `operatorSelector: …` field from the `DaemonContext` type/interface, the `operatorSelector: new OperatorSelector(...)` construction, and the `OperatorSelector` import. Grep `daemon-context.ts` to confirm no remaining `operatorSelector` reference.

- [ ] **Step 3: Decide the `OperatorSelector` class**

Run: `rg -rn "OperatorSelector\b" apps/daemon/src --glob '*.ts'`. The other exports of `selector.ts` (`SelectorInput`, `OperatorSelectionResult`, `OperatorSelectionSource`, `OperatorSelectionTransportAttempt`) are used elsewhere and STAY — do not touch them or delete the file.
- If, after Step 2, the only remaining references to the **`OperatorSelector` class** are its own definition + a dedicated test (`selector.test.ts`), **delete the class AND its test** (the test only exists to cover the now-removed class).
- If a non-test, non-`daemon-context` consumer of the class exists, leave the class and report it (it wasn't actually dead).
- If the class is referenced nowhere outside its definition (no test even), delete just the class.

- [ ] **Step 4: Typecheck + suite**

Run: `pnpm --filter @orca/daemon typecheck` → exit 0.
Run: `pnpm --filter @orca/daemon test` → PASS (full daemon suite — `daemon-context` is widely constructed; confirm nothing broke; the two acknowledged flakes may need an isolated re-run).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/daemon-context.ts apps/daemon/src/workflows/operators/selector.ts
git commit -m "refactor(daemon): excise dead operatorSelector (field, construction, class)"
```
(Add `selector.test.ts` to the `git add` if you deleted it.)

---

### Task 3: Rename pure-engine test locals `service` → `engine`

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.gate-routing.test.ts`, `service.splitter-routing.test.ts`, `service.skill-step.test.ts`, `service.adaptive-delivery.test.ts`

- [ ] **Step 1: Baseline — confirm green**

Run: `pnpm --filter @orca/daemon test -- gate-routing splitter-routing skill-step adaptive-delivery` → PASS.

- [ ] **Step 2: Rename in each of the 4 files**

In each file, the `makeService` helper returns a `DispatchEngine` and tests use `const service = makeService(...)` then `service.requestNextDecision(...)` etc. Rename for clarity: the helper `makeService` → `makeEngine` and the local `service` → `engine` (and any `makeJudgeService`-style variants that return a `DispatchEngine`). **Cosmetic only** — do NOT change any assertion, DB setup, or call argument. Scope the rename to the engine-holding identifiers in these 4 files; do not touch unrelated `service` strings (e.g. in SQL or comments) if any. Verify by reading the diff that only identifier names changed.

- [ ] **Step 3: Suite**

Run: `pnpm --filter @orca/daemon test -- gate-routing splitter-routing skill-step adaptive-delivery` → PASS, identical to baseline.

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.gate-routing.test.ts apps/daemon/src/workflows/orchestrator/service.splitter-routing.test.ts apps/daemon/src/workflows/orchestrator/service.skill-step.test.ts apps/daemon/src/workflows/orchestrator/service.adaptive-delivery.test.ts
git commit -m "test(orchestrator): rename pure-engine test locals service->engine"
```

---

### Task 4: Enable `noUnusedLocals` + sweep the dead locals

**Files:**
- Modify: the daemon tsconfig (`apps/daemon/tsconfig.json` or the base it extends — wherever `compilerOptions` lives)
- Modify: every file the flag flags (~58, mostly test files — enumerated by typecheck)

- [ ] **Step 1: Baseline — confirm green + size the sweep**

Run: `pnpm --filter @orca/daemon test` → PASS.
Run: `cd apps/daemon && npx tsc --noEmit -p tsconfig.json --noUnusedLocals 2>&1 | grep "error TS6133" | wc -l` → expect ~58. List them: `npx tsc --noEmit -p tsconfig.json --noUnusedLocals 2>&1 | grep "error TS6133"`.

- [ ] **Step 2: Enable `noUnusedLocals` in the daemon tsconfig**

Find where the daemon's `compilerOptions` are set (`apps/daemon/tsconfig.json`, or its `extends` base). Add `"noUnusedLocals": true` to the daemon's `compilerOptions` (NOT `noUnusedParameters` — out of scope this task). If the base tsconfig is shared by other packages, set it in `apps/daemon/tsconfig.json`'s own `compilerOptions` (override), not the shared base, to keep the change scoped to the daemon.

- [ ] **Step 3: Fix every flagged unused local/import (typecheck-driven)**

Run `pnpm --filter @orca/daemon typecheck`. For EACH `error TS6133: 'X' is declared but its value is never read`:
- If it's an unused **import**, remove it from the import statement (or the whole import line if it was the only name).
- If it's an unused **local variable/binding** in real code, remove the declaration — BUT if removing it would drop a side-effecting call (`const x = doThing()` where `doThing()` has effects), keep the call and drop only the binding (`doThing();`). If a flagged local looks intentional (e.g. a destructure that documents a shape), prefer `// eslint-disable`-equivalent only if removal changes behavior — otherwise remove.
- If a flagged unused local is in a TEST and removing it would weaken the test's intent (e.g. a captured spy that *should* be asserted), STOP and report that one rather than deleting silently.
Re-run typecheck until exit 0. (These are ~58, the large majority dead imports/locals in test files — mechanical.)

- [ ] **Step 4: Full suite + typecheck**

Run: `pnpm --filter @orca/daemon typecheck` → exit 0 (the flag is now on).
Run: `pnpm --filter @orca/daemon test` → PASS (no test weakened/removed; only dead symbols deleted).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/tsconfig.json apps/daemon/src
git commit -m "chore(daemon): enable noUnusedLocals; remove the dead locals/imports it surfaces"
```

---

## Notes for the executor

- Each task is independent and no-behavior-change; baseline-green → change → typecheck → suite → commit.
- Task 1's import repointing is **typecheck-driven** — never hand-enumerate importers; let the compiler list them.
- Task 4 is mostly dead test imports; the rule is *delete dead symbols, never weaken a test*. If a flagged local is a should-be-asserted spy or a side-effecting call, handle per Step 3 / STOP-and-report.
- `noUnusedParameters` is deliberately NOT enabled (8 hits, some intentional) — out of scope.
- Line numbers drift — anchor on symbol names.
