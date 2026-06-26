# OrchestratorService Decomposition — C/D (ledger trio + db-rows) — Design

**Date:** 2026-06-25
**Phase:** FUTURE_WORK Phase 0.2 part 2 — the "C/D" cluster
**Scope:** Extract the pure **ledger-commit trio** to a free-function module; consolidate shared **DB-row access** into `db-rows.ts`; **deliberately leave the advance/route engine in place** (documented); add a FUTURE_WORK item for a later **DispatchEngine** split.
**Status:** Approved design, pre-implementation

## The headline finding (why this is small)

A fresh map of the C/D cluster (post-A+B, service.ts now 4,047 lines) shows the advance/route engine is **not cleanly extractable**, and forcing it would harm the most safety-critical path:

- **`commitAdvanceOrComplete` + the D-cluster** (`parkForGateApproval`, `evaluateAndParkSplitter`, `decideGate`, `routeGateDestination`, confirmers) would require **7 injected callbacks** if extracted — including `requestNextDecision` and `spawnStepAgent`, *the very methods it recurses back into* — plus a real `routeGateDestination ⇄ evaluateAndParkSplitter` cycle (service.ts:3505 ⇄ 3667). A module taking those 7 callbacks is a **pass-through, not a seam**; it would move ~770 lines without creating a boundary.
- This is the **honest shape of the system**: the dispatch/advance/route loop is the orchestrator's irreducible cohesive core. The paper frames it directly — "controller-centric orchestration where planning is embedded in the routing substrate itself" (p.20); "harness mechanisms are not isolated add-on modules, but coordinated control surfaces" (p.16). We peel off peripheral concerns; we do **not** fragment the control substrate.

So C/D's clean wins are only: the **pure ledger I/O trio** (a genuine peripheral concern) and the **shared-types consolidation** (closing a prior review Minor). The engine stays, documented.

## Governing constraints

- **No behavior change.** Verbatim moves; existing service-level suites are the guard (baseline-green → extract → green → typecheck).
- **Frozen public API.** No `OrchestratorService` public-method signature changes (the ledger trio is private; the row helpers/types/errors are module-internal relocations).
- **No forwarding stubs.** Private methods move out and are deleted; call sites repoint.
- **`db-rows.ts` imports from no orchestrator file** (one-directional) — so it can never cause a cycle; everyone imports *from* it.
- **State substrate stays unified** — `db` threaded through; no per-unit state.

## Current-state map (verified, service.ts = 4,047 lines)

### Pure ledger trio (Seam C I/O subset) — all private, **zero `this.*`**
| Method | Lines | Calls (this.*) |
|---|---|---|
| `createStepOutputArtifact` | 2954–2985 | none (free fn `createArtifact`) |
| `commitStepOutputAndLedger` | 2930–2952 | only `this.createStepOutputArtifact` |
| `completeStepWithLedger` | 2886–2927 (async) | only `this.commitStepOutputAndLedger`; free fns `parseStepCompletionEnvelope`, `latestCommittedLedger`, `reviewAndNormalizeLedgerUpdates` |

External callers (stay in the class, repoint to module fns): `onAgentResponseDone` (~service.ts:1526) and `confirmStep` (~service.ts:1940) call `this.completeStepWithLedger`. Tests never call the trio directly (covered transitively via `requestNextDecision`/completion paths in `service.skill-step.test.ts`).

### Shared DB-row access (consolidation targets)
| Symbol | Lines | Notes |
|---|---|---|
| `interface GoalRow` | 123 | typed on every C/D `ctx`; also re-declared locally in `step-result-builder.ts` (the prior Minor) |
| `interface StepRunRow` | 215 | same |
| `readGoal` | 327 (exported) | `SELECT … FROM goals`; throws `OrchestratorGoalNotFoundError` |
| `readStepRun` | 318 (local) | `SELECT * FROM workflow_step_runs`; throws `OrchestratorStepNotFoundError` |
| `preferencesForGoal` | 202 (exported) | pure; uses `adapterIdForProvider` (imported from `../../orchestrator-llm/model-provider-llm-client.js`) + `StepAgentChoice` (contract) |
| `OrchestratorStepNotFoundError` | 260 (exported) | thrown by `readStepRun` |
| `OrchestratorGoalNotFoundError` | 278 (exported) | thrown by `readGoal` |

Cross-file consumers today: `provider-recovery-controller.ts` imports `readGoal`/`preferencesForGoal`/`GoalRow`/`StepRunRow` from `./service.js` (the prior Minor face #2); `orchestrator/routes.ts` imports the two error classes from `./service.js` (`error instanceof …` mapping). (`orchestrator-chat/usecases.ts` has its *own* local `GoalRow` — separate subsystem, out of scope.)

### The engine (stays) — for the doc-comment
`commitAdvanceOrComplete` (2987–3158) + D-cluster: `parkForGateApproval` (3202), `buildSplitEvaluationRequest` (3280), `evaluateAndParkSplitter` (3326), `decideGate` (3533, public), `routeGateDestination` (3636), `confirmGate` (3772, public), `confirmSplit` (3839, public). 7-callback injection surface; `route ⇄ evaluate` cycle; re-enters `requestNextDecision`.

## Design

### 1. `ledger-commit.ts` — extract the trio (free fns, no deps object)
Create `apps/daemon/src/workflows/orchestrator/ledger-commit.ts`. Move the three methods **verbatim** as exported free functions. They have **zero `this.*`**, so there is **no deps object** — the functions call each other directly (`completeStepWithLedger(...)` → `commitStepOutputAndLedger(...)` → `createStepOutputArtifact(...)`). Copy the import set from `service.ts` (`createArtifact`, `commitLedgerVersion`, `parseStepCompletionEnvelope`, `latestCommittedLedger`, `reviewAndNormalizeLedgerUpdates`, `LedgerUpdate`, the ctx row types from `db-rows.ts`, `DomainEvent`, `Database`, `RequestNextDecisionOptions`). The `ctx` param type (`{ run, stepRun, stepTpl, goal }`) uses `GoalRow`/`StepRunRow` imported from `db-rows.ts`. Repoint the 2 call sites (`onAgentResponseDone`, `confirmStep`) to `completeStepWithLedger(db, now, ctx, block, options, stagedEvents, onReject)`; delete the 3 methods from `service.ts`.

### 2. `db-rows.ts` — consolidate shared DB-row access (the fuller version)
Create `apps/daemon/src/workflows/orchestrator/db-rows.ts` exporting: `GoalRow`, `StepRunRow`, `readGoal`, `readStepRun`, `preferencesForGoal`, **and** the two error classes `OrchestratorGoalNotFoundError`, `OrchestratorStepNotFoundError` (so the readers' throws live with them — keeping `db-rows.ts` importing from no orchestrator file). `db-rows.ts` imports only: `Database` type, `adapterIdForProvider` (from `../../orchestrator-llm/model-provider-llm-client.js`), `StepAgentChoice` (from `@orca/contracts`). Then:
- **`service.ts`** — delete the 5 definitions + 2 error classes (lines 123, 202, 215, 260, 278, 318, 327); add one import from `./db-rows.js`. All usages unchanged.
- **`step-result-builder.ts`** — delete its **local `GoalRow`/`StepRunRow` re-declarations**; import them from `./db-rows.js` (closes prior Minor face #1).
- **`provider-recovery-controller.ts`** — change the import source for `readGoal`/`preferencesForGoal`/`GoalRow`/`StepRunRow` from `./service.js` to `./db-rows.js` (closes face #2).
- **`orchestrator/routes.ts`** — change its import of `OrchestratorGoalNotFoundError`/`OrchestratorStepNotFoundError` from `./service.js` to `./db-rows.js` (verified: routes.ts does `error instanceof …` mapping on these two).
- **Blast radius is typecheck-driven**: after the move, `pnpm --filter @orca/daemon typecheck` flags any remaining importer of a moved symbol; repoint each to `./db-rows.js` until green. (Known importers: `service.ts`, `provider-recovery-controller.ts`, `step-result-builder.ts`, `orchestrator/routes.ts`.)

### 3. Leave the advance/route engine — doc-comment only
Add a concise doc-comment on `commitAdvanceOrComplete` (and/or the class header) stating: this method + the gate/splitter routing form the orchestrator's irreducible dispatch core — extraction would require injecting `requestNextDecision`/`spawnStepAgent`/`blockRun`/`commitNoopLatestDecision`/`publish`/`appendDecisionRequested`/`broker` (a pass-through), with a `routeGateDestination ⇄ evaluateAndParkSplitter` cycle; intentionally kept whole. Point at the FUTURE_WORK DispatchEngine item for the principled larger move. **No code change beyond the comment.**

### 4. FUTURE_WORK update
- Mark the **ledger trio + db-rows** done under 0.2; note the engine intentionally kept whole.
- Add a new item: **"DispatchEngine split"** — relocate the cohesive engine (`requestNextDecision` + `commitAdvanceOrComplete` + D-cluster + `spawnStepAgent` + `advanceToNextStep` + `reviseStep` + decision/event plumbing) into a `DispatchEngine` class, leaving `OrchestratorService` as the event-handler/reaction layer (`onWorkflowSessionCompleted`/`onSessionOutputChunk`/`onAgentResponseDone`/`onUserMessage`/`confirmStep`/revisions/…). The handler→engine dependency is **one-directional/acyclic** (verified: no engine method calls back into a handler), so it's a clean split — **but** a large, high-risk relocation of the most safety-critical code with a wide seam, deserving **its own brainstorm/spec/SDD cycle**. Not in scope here.

## Alignment (four axes + paper) — verified

Both unusual moves (keep the engine whole; extract ledger/db-rows) were checked against FUTURE_ARCHITECTURE and the paper:

**Move 1 — keep the dispatch/route engine cohesive (the "don't decompose" decision):**
- **FUTURE_ARCHITECTURE line 95:** *"Deterministic core, selective AI … deterministic code owns lifecycle, **routing**, gates."* Lifecycle + routing + gates are one deterministic core; keeping `commitAdvanceOrComplete` + gate/splitter routing together preserves it. Fragmenting it would split the cost spine's deterministic core.
- **Paper:** the control loop is *"a single harness-level control process … the harness acts as a cybernetic governor: a control layer that observes the effects of agent actions and regulates subsequent state transitions"* (p.28). "Controller-centric orchestration where planning is embedded in the routing substrate itself" (p.20). Splitting it across 7 injected callbacks would fracture the governor — the opposite of the paper's framing.

**Move 2 — extract ledger I/O + consolidate `db-rows.ts` (the separable concerns):**
- **Paper:** the field treats *"working state"* as a **named separable harness layer** (p.28), and *state offloading … to databases* of *durable task state* as a distinct, **auditable** concern separated from the active control loop (p.24). The ledger (versioned, downstream steps read it instead of re-parsing transcripts) is exactly that durable task state — so isolating its write-path is paper-endorsed.
- **FUTURE_ARCHITECTURE line 39/98:** the ledger is control-plane state on the append-only event spine; isolating its write-path keeps the control plane modular (the "daemon graduates into a standalone server" direction, §1).
- **FUTURE_ARCHITECTURE §4 / migration step 2 (line 115) — the storage-provider seam (SQLite ⟷ Postgres):** `db-rows.ts` centralizing the raw `SELECT … FROM goals/workflow_step_runs` row access is a concrete step *toward* that seam — when the Postgres swap lands, the raw row reads sit in one module to put behind the storage interface rather than scattered through `service.ts`. (A genuine destination payoff, not just cleanup.)

**Other axes:**
- **ORCA.md (present):** subsystem-grain; `orchestrator/` keeps all responsibilities (new modules live inside it). No change required.
- **FUTURE_WORK (path):** this is 0.2 part 2; updates 0.2 + adds the DispatchEngine item (itself consistent with control-plane modularity).

## Testing

No behavior change → no new behavior tests. Guard = existing suites green, unchanged:
- Ledger trio: `service.skill-step.test.ts` (drives completion via `requestNextDecision`) + `service.agent-step.test.ts`/`service.gate-routing.test.ts` completion paths.
- `db-rows.ts`: pure relocation — typecheck + the full daemon suite. Optionally a tiny unit test for `readGoal`/`readStepRun`/`preferencesForGoal` (they had none), but not required.
- After each task: that task's suites + `pnpm --filter @orca/daemon typecheck`; before committing the second task, the full orchestrator (and ideally full daemon) suite.

## Sequencing (3 tasks)

1. **`ledger-commit.ts`** — extract the trio (free fns, no deps); repoint 2 call sites; delete from class.
2. **`db-rows.ts`** — consolidate types + readers + 2 error classes; repoint `service.ts`/`step-result-builder.ts`/`provider-recovery-controller.ts`/`routes.ts` (typecheck-driven).
3. **Docs** — doc-comment on the engine + FUTURE_WORK update (ledger/db-rows done; DispatchEngine item added).

## Out of scope

- The advance/route engine extraction (deliberately — it's a pass-through; the DispatchEngine item is the principled alternative, its own effort).
- `orchestrator-chat/usecases.ts`'s separate local `GoalRow` (different subsystem).
- Any public-API change.
