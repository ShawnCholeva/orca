# OrchestratorService Decomposition — Seams B + A (0.2, part 1) — Design

**Date:** 2026-06-25
**Phase:** FUTURE_WORK Phase 0.2 — "Decompose `OrchestratorService` (~4,641 lines)"
**Scope:** This spec covers **Seam B (step scoring & result building)** and **Seam A (provider recovery state machine)** only. Seam C (ledger commit) + Seam D (gate/splitter routing) are a bidirectionally-coupled cluster and get their **own brainstorm + spec** after A+B land.
**Status:** Approved design, pre-implementation

## Goal

Extract two of `OrchestratorService`'s natural seams into sibling collaborator modules to shrink and de-risk the most safety-critical file in the system, **with no behavior change**, and in a way that **moves toward FUTURE_ARCHITECTURE's control-plane / execution-plane split** by naming the execution-plane capability surface as a `RunnerPort`.

## Governing constraints

- **No behavior change.** Pure structural refactor. The existing service-level test suites (which `new OrchestratorService(...)` and call public methods) are the behavior-preservation guard and must stay **green, unchanged**, before→after each seam.
- **External signatures are preserved, but Seam A's 4 public methods *relocate*.** Seam B touches no public methods. Seam A's 4 public recovery methods (`waitForProvider`/`retryProvider`/`refreshProviderRecovery`/`switchProvider`) have **zero internal callers** (only `server.ts`), so they **move — same signatures — onto a new `ProviderRecoveryController`**, and `server.ts`'s 4 call sites repoint to it. The other 17 public `OrchestratorService` methods stay byte-identical. So the contract is preserved; the *home* of the 4 recovery methods changes (a deliberate decomposition, not an API change).
- **Delete private methods, delegate only the public API:**
  - **Private** moved methods are **deleted from the class** — their internal call sites are updated to call the module free function directly (`scoringFacts(this.stepResultBuilderDeps, db, …)`). This is the actual file-size reduction; a forwarding stub for a private single-use method is pass-through indirection (CLAUDE.md "no abstractions for single-use code") and is **not** kept.
  - **Public** moved methods (part of the 21-method external API) **keep a one-line delegate** whose body forwards to the module. That delegate is the legitimate facade/entrypoint — `server.ts`/routes call it, and preserving the public signature is what freezes the external contract. It is not dead indirection.
  - Intra-seam calls become direct free-function calls inside the module. Cost: a handful of call-site edits per seam (Seam B ≈ 5), caught by typecheck + the test suites.
- **Not in scope:** building the Runner Protocol or any network boundary (that's migration step 1); extracting shared helpers (`readStepOutputAsRecord`, `collectPriorStepArtifacts`, etc.) — they're passed as injected callbacks, not moved; C/D.
- **Storage-agnostic:** collaborators take `db` as a parameter (as the methods already do); no new hardcoded SQLite assumptions, so they survive the SQLite↔Postgres switch (FUTURE_ARCH §4).

## FUTURE_ARCHITECTURE alignment

The orchestrator is **control plane**. Its execution-plane dependencies (`workerSpawn`/`workerDeliver`/`workerWait`/`workerTerminate`/`workerInterrupt`, `launcher`, `sessionOutputStore`) already exist as injected constructor params, but **scattered**. That scatter is the latent seam migration-step-1 promotes to the network Runner Protocol (FUTURE_ARCH §2). This refactor **groups the subset Seam A uses into one `RunnerPort` interface** — naming the seam, with no behavior change and no new abstraction (we need a deps object for the extraction regardless). `RunnerPort` is the **in-process precursor to the network Runner Protocol**; when step 1 lands, only the implementation behind it changes, not the orchestrator. The port grows to absorb `workerTerminate`/`workerInterrupt` when their consumer (`interruptStepAgent`) later extracts.

## Paper alignment (*Code as Agent Harness*)

The decomposition is independently supported by the survey, which reframes it from "tidy a big file" to "separate the harness layers the literature already treats as distinct":

- **Separable harness layers (p.28).** The field "distinguish[es] orchestration, working state, **execution substrates**, evaluation harnesses, observability, and governance as **separable harness layers rather than incidental implementation details**." 0.2 separates *orchestration* (the `OrchestratorService` control plane) from the *execution substrate* (`RunnerPort`). Precedent: Anthropic's and Cursor's long-running harnesses "separate planning, generation, and evaluation into distinct roles" / planner–worker coordination (p.20).
- **`RunnerPort` is the named locus of sandbox + permission enforcement (p.16/p.28/p.64).** The paper places "policies and permission tiers" and "Sandboxed Execution / Permissioned State Transition (read-only · sandbox-edit · full-access)" at the **execution-substrate boundary** — exactly the seam `RunnerPort` names. We add **no** enforcement here now (Orca's Governed axis lives elsewhere; FUTURE_ARCH keeps it), but this is a second, independent reason the boundary is worth naming: it is where sandbox/permission enforcement lands at the destination.
- **Modularize behavior, not state (p.64).** The survey warns that fragmenting "transactional shared program state" breaks consistency ("synchronization alone does not provide transactional semantics"). This design extracts **behavior** while the **state substrate stays unified** — every extracted unit receives the same `db` and writes through the same event spine; no per-unit state is introduced. A future extraction (incl. C/D) must preserve this: pass the transactional `db` through, never fork state across units.

Layers this spec does **not** yet separate (observability, governance) are future, paper-consistent work — not in scope here.

### Present-state & path consistency (ORCA.md, FUTURE_WORK.md)

- **ORCA.md (present) — verified, no change required.** ORCA.md describes the orchestrator at the *subsystem* grain: `orchestrator/` as "the mediation engine: step dispatch … judgement, revise loop, crash retry, resume, worker sessions/questions, synthesis" (line 104), and provider recovery as a feature ("a typed `ProviderRecoveryCheckpoint` drives a wait/retry/switch state machine," line 292). The new modules all live **inside `orchestrator/`** and every responsibility/feature is preserved, so both stay accurate. (Optional coarse-grained note post-merge that recovery is now a standalone controller; not required.)
- **FUTURE_WORK.md (path).** This spec is **0.2 part 1**. On completion, update 0.2 to mark A+B done and record that C and D are one bidirectionally-coupled cluster (not two independent seams), deferred to their own brainstorm.

## Current-state map (verified, service.ts = 4,641 lines)

`class OrchestratorService` at service.ts:482–4641. 15 injected constructor deps (service.ts:485–515); one non-param field `sessionOutputStore` (service.ts:483). Tests instantiate directly via local `makeService(...)` helpers and call public methods against in-memory SQLite — there is no shared harness class.

### Seam B — step scoring & result building (all private)
| Method | Lines | Signature | External `this.*` deps |
|---|---|---|---|
| `scoringFacts` | 2896–2915 | `(db, stepRun, terminalStatus, finishedAt) → StepResultScoringFacts` | `retryCount`, `artifactCountForStep` |
| `buildApprovalStepResult` | 2923–2954 | `(db, ctx{stepRun}, scoring, finishedAt) → WorkflowStepResult` | (intra-seam: `scoringFacts`, `withResultSummary`) |
| `withResultSummary` | 2958–2990 | `(db, stepRun, result) → WorkflowStepResult` | `readStepOutputAsRecord` |
| `replayEvaluationFailedResult` | 2998–3015 | `(db, stepRun, finishedAt) → WorkflowStepResult` | (intra-seam: `scoringFacts`) |
| `scoreCompletedStepResult` | 3017–3092 | `(db, ctx{run,stepRun,stepTpl,goal}, output, finishedAt) → Promise<WorkflowStepResult>` | `broker`, (intra-seam: `scoringFacts`) |

Internal callers (must stay working via delegates): approve branch `applyOrchestratorAction` (1890), `confirmStep` (2296), `commitSkillStepDecision` (2842), `onWorkflowSessionCompleted` (559 replay, 716 facts). Outward edges: `broker`, `readStepOutputAsRecord`, `retryCount`, `artifactCountForStep`. No calls into A/C/D. **Lowest-coupling seam → done first to prove the pattern.**

### Seam A — provider recovery (6 public command methods + 3 private helpers)
| Method | Lines | Vis | External `this.*` deps |
|---|---|---|---|
| `loadProviderRecoveryContext` | 1079–1136 | priv | none (DB reads) |
| `persistCheckpoint` | 1138–1146 | priv | none |
| `waitForProvider` | 1149–1174 | **pub** | `workerWait` |
| `retryProvider` | 1181–1235 | **pub** | `workerDeliver`, `sessionOutputStore.readTail`, `startRecoveryReplacementSession` |
| `refreshProviderRecovery` | 1238–1272 | **pub** | `operators.list`, `stepDispatch.supportsModel` |
| `switchProvider` | 1280–1318 | **pub** | `stepDispatch.isAdapterReady`, `startRecoveryReplacementSession` |
| `startRecoveryReplacementSession` | 1330–1400 | priv | `sessionOutputStore.readTail`, `launcher.launch`, `workerSpawn`, `workerDeliver`, `collectPriorStepArtifacts`, `latestRejectingGate` |

Seam A calls into **none** of B/C/D. The resumption-side handler `onSessionOutputChunk` (769–1077) shares only the `pending_provider_recovery_json` DB column (via free fns `pauseForProviderRecovery`/`resumeFromProviderRecovery`), **not** these methods — so it is **not touched** by this extraction. The 4 public methods are called only from `server.ts` (1920/1943/1966/1989). Guard suites: `service.adaptive-delivery.test.ts`, output-chunk paths in `service.agent-step.test.ts`, plus pure `provider-recovery.test.ts`.

## Design

### Pattern — two shapes, chosen by what the seam *is*
- **Seam B is internal helper logic** (no public methods) → **free-function module**. Each method becomes `f(deps, ...args)`; the private methods are **deleted** from the class and their ~5 internal call sites call the module fn directly (`f(this.stepResultBuilderDeps, ...)`); intra-seam calls become in-module free-fn calls. The class keeps only a `private get stepResultBuilderDeps()`. **No delegates.**
- **Seam A is a self-contained public-facing unit** (4 public methods, zero internal callers) → **lift to a standalone `ProviderRecoveryController` class**. The class holds its deps and owns the methods; `OrchestratorService` loses all 7 recovery methods entirely; `server.ts` constructs the controller and calls it. A class (not free fns) fits here because there's a held deps set + a repeatedly-called public surface that the composition root owns.

The rule: free functions for stateless internal helpers; a small controller class only where there's a public surface with held dependencies. Neither shape leaves a forwarding stub on `OrchestratorService`.

### Seam B → `apps/daemon/src/workflows/orchestrator/step-result-builder.ts`
```ts
export interface StepResultBuilderDeps {
  broker: Pick<OrchestrationTransportBroker, "propose">;
  readStepOutputAsRecord: (db: Database.Database, runId: string, stepRunId: string) => Record<string, unknown> | null;
  retryCount: (db: Database.Database, stepRunId: string) => number;
  artifactCountForStep: (db: Database.Database, stepRunId: string) => number;
}
export function scoringFacts(deps, db, stepRun, terminalStatus, finishedAt): StepResultScoringFacts
export function buildApprovalStepResult(deps, db, ctx, scoring, finishedAt): WorkflowStepResult
export function withResultSummary(deps, db, stepRun, result): WorkflowStepResult
export function replayEvaluationFailedResult(deps, db, stepRun, finishedAt): WorkflowStepResult
export function scoreCompletedStepResult(deps, db, ctx, output, finishedAt): Promise<WorkflowStepResult>
```
All five Seam-B methods are **private**, so all five are **deleted from the class**; their ~5 internal call sites (1890, 2296, 2842, 559, 716) are repointed to the module functions, and intra-seam calls (`buildApprovalStepResult`→`scoringFacts`/`withResultSummary`, etc.) become in-module free-function calls. The class keeps only `private get stepResultBuilderDeps(): StepResultBuilderDeps`. No delegates (none of these are public API).

### Seam A → lift provider recovery out of `OrchestratorService`

Three new files; `OrchestratorService` loses all 7 recovery methods + 2 shared helpers; `server.ts` rewires.

**1. `runner-port.ts` — the execution-plane capability surface** (FUTURE_ARCH §2 precursor to the network Runner Protocol; grows as more consumers extract). Assembled at the composition root (`server.ts`), not inside any control-plane class:
```ts
export interface RunnerPort {
  launch: WorkflowSessionLauncher["launch"];
  workerSpawn: (input: { sessionId: string; goalId: string; adapterId: string }) => Promise<void>;
  workerDeliver: (sessionId: string, text: string) => Promise<"delivered" | "no_session" | "timeout">;
  workerWait: (sessionId: string, adapterId: string) => Promise<void>;
  readTail: SessionOutputStore["readTail"];
}
```

**2. `repair-context.ts` — the two shared pure helpers as free functions.** `collectPriorStepArtifacts(db, runId, currentStepRunId)` and `latestRejectingGate(db, runId)` are pure DB reads (zero `this`). They're used by BOTH recovery and the orchestrator (`reviseStep` at service.ts:1361/1362, `spawnStepAgent` at 2579/2580). Extract verbatim as free fns; **delete the 2 private methods** from `OrchestratorService` and repoint its 4 call sites (1361/1362, 2579/2580) to the free fns. Both the controller and the orchestrator import them — no controller→orchestrator back-dependency.

**3. `provider-recovery-controller.ts` — the `ProviderRecoveryController` class.** Owns the 4 public methods + 3 private helpers (`loadProviderRecoveryContext`, `persistCheckpoint`, `startRecoveryReplacementSession`), imports the two `repair-context` free fns directly:
```ts
export class ProviderRecoveryController {
  constructor(private readonly deps: {
    runner: RunnerPort;
    operators: Pick<OperatorRegistry, "list">;
    stepDispatch: StepDispatchCapabilities | undefined;
  }) {}
  async waitForProvider(db, now, runId, checkpointId, options?): Promise<void>
  async retryProvider(db, now, runId, checkpointId, options?): Promise<void>
  async refreshProviderRecovery(db, now, runId, checkpointId, options?): Promise<void>
  async switchProvider(db, now, runId, checkpointId, adapterId, options?): Promise<void>
  // + private loadProviderRecoveryContext / persistCheckpoint / startRecoveryReplacementSession
}
```
Method bodies move **verbatim**, with `this.workerWait`/`this.launcher`/`this.sessionOutputStore.readTail`/etc. rewritten to `this.deps.runner.*`, and `this.operators`/`this.stepDispatch` to `this.deps.*`. The existing `undefined`-worker-fn behavior is preserved exactly (the methods already guard/throw on absence; the `RunnerPort` members carry the same optionality semantics — no new "is it defined" logic).

**4. `OrchestratorService`** drops the 7 recovery methods + 2 shared helpers, and the recovery-only constructor deps it no longer uses internally **stay** (they still feed `reviseStep`/`spawnStepAgent`/agent commit — only the *recovery* consumption moves). `onSessionOutputChunk` is **untouched** (it shares only the `pending_provider_recovery_json` column via free fns, never the seam methods).

**5. `server.ts`** assembles a `RunnerPort` from the worker fns + launcher + sessionOutputStore it already has, constructs `new ProviderRecoveryController({ runner, operators, stepDispatch })`, and repoints the 4 routes (1920/1943/1966/1989) from `orchestratorService.X(...)` to `recoveryController.X(...)`.

## Testing

No new behavior → **no new behavior tests**. The guard is the existing suites staying green unchanged:
- **Seam B:** `service.skill-step.test.ts`, `session-completion.test.ts`, approve/confirm paths in `service.agent-step.test.ts`.
- **Seam A:** the recovery tests in `service.agent-step.test.ts` call `service.waitForProvider(...)`/`retryProvider`/`switchProvider` **directly on the service instance** — so when those methods move to `ProviderRecoveryController`, those tests **repoint** to call the controller instead (construct it in the file's helper; assertions and DB setup stay identical — a mechanical relocation, not a behavior change). `provider-recovery.test.ts` (pure helpers) is unaffected; `service.adaptive-delivery.test.ts` exercises the `onSessionOutputChunk` resume path, which is untouched. This is the one place Seam A is not "tests unchanged" — inherent to lifting the methods out (which is the chosen design).
- After each seam: run that seam's suites + `pnpm --filter @orca/daemon typecheck`; before committing, run the full orchestrator suite. Optionally add focused unit tests for the new module/controller where they lock a non-obvious contract, but they do not replace the public-API guard.

## Sequencing (2 PRs)

1. **Seam B** → `step-result-builder.ts` (free fns) + deps getter; 5 private methods deleted, ~5 call sites repointed. Smallest, proves the free-fn pattern.
2. **Seam A** → `runner-port.ts` + `repair-context.ts` (2 shared free fns) + `provider-recovery-controller.ts` (class); `OrchestratorService` loses 7 recovery methods + 2 helpers; `server.ts` assembles `RunnerPort`, constructs the controller, repoints 4 routes; recovery tests repoint to the controller. The execution-plane alignment seam (larger than B).

Also update **FUTURE_WORK 0.2** to record: A+B extracted via this pattern; C/D are a single bidirectionally-coupled cluster (not two independent seams) deferred to their own brainstorm.

## Out of scope (this spec)

- Seam C (ledger commit) and Seam D (gate/splitter routing) — own brainstorm after A+B.
- Grouping `workerTerminate`/`workerInterrupt` into `RunnerPort` (no extracted consumer yet).
- Any constructor-signature change / external-API change.
- Building the Runner Protocol or a network execution-plane boundary (migration step 1).
