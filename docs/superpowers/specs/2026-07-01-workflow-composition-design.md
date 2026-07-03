# Workflow Composition — Design (Sub-project E of Phase 5)

**Date:** 2026-07-01
**Status:** Designing (user-approved section-by-section 2026-07-01), pending implementation plan
**Phase item:** FUTURE_WORK 5.1 — "Sub-workflow composition — a `workflow` operator / delegate seam (highest-payoff item)."
**Builds on:** the graph-authoritative workflow engine (node cursor, `template_snapshot`, gate/splitter park-resume), the four-axis harness spine (Executable/Governed/Stateful/Inspectable), and — for cross-goal template metrics — sub-project A/B.

---

## 1. Context & scope

Templates are flat graphs today: `OperatorKind = z.enum(["agent","model","human"])` (`packages/contracts/src/workflows/index.ts:119`), graph nodes are `step|gate|splitter` only (`index.ts:303`), steps cap at `max(20)`, and **no node can reference another template**. This sub-project (**E**) adds the **delegate seam**: a node in a parent workflow spawns a **child `WorkflowRun`** of an independently-versioned template, running with an **isolated state space** — parent values mapped in via an explicit `reads` contract and results mapped back via `writes`, with full parent↔child lineage.

Per FUTURE_WORK 5.1 this is also "the same primitive the Fan-out / fan-in idea needs"; we **land the single-child delegate seam first**, shaped so fan-out (N children under one parent) is additive.

### Decisions taken during brainstorming (2026-07-01)
| Decision | Choice |
|---|---|
| Primary job | **Reuse-via-delegation** (invoke an independently-versioned child template), with **isolated child state as the load-bearing invariant** (the paper's context-offloading + read-set/write-set), fan-out **deferred**. |
| Child-run identity | **Full `WorkflowRun` on the SAME goal**; the "one active run per goal" invariant generalizes to **one active *leaf* run** — the parent parks in a `delegating` state, the child is the active leaf, control returns on child terminal. |
| Mechanism | **A 4th graph node type `delegate`** (not a step operator, not a gate/splitter outcome node). |
| Failure | Child terminal failure **propagates**: parent blocks with the child's reason. Outcome-port branching (`completed`/`failed`) **deferred** but additive. |

### Non-goals (E)
- **Fan-out / fan-in** (N-way parallel delegation) — the invariant + join are shaped to allow it; not built now.
- **Outcome-port branching** on the delegate node (`completed`/`failed` ports) — deferred; first cut is single success edge + propagate-on-failure.
- **Semantic / CRDT conflict merge** (paper §5.2.4/p.64) — Orca **detects-and-surfaces** conflicts, never auto-merges; consistent with its existing stance. Not building merge.
- **Workspace file-rollback on child failure** — the engine rolls back run *state*, not files (git is the user's). Not built.
- **Per-child runner placement** — forward-compatible (spawn/join is control-plane; child steps ride `RunnerPort`), not built.
- **Child goals / a lighter non-run sub-construct** — rejected during brainstorming (goals are heavyweight; a second run concept diverges the engine).
- **MAS-level failure attribution (E, §4.3 EvoMAC):** distinguishing a child's *internal* failure from *bad `reads`* handed down by the parent — deferred. The `CompositionFacet` already links each child run to its delegation context, so B's future diagnosis can segment a reused child template's metrics by delegation context (rather than pooling heterogeneous parents) when this lands. Recorded, not built.

---

## 2. Paper & FUTURE_ARCHITECTURE alignment

The through-line: **the delegate boundary is a governed, verified, state-tracked, inspectable transition — identical in kind to a step** (the paper's "reliability comes from governed state transitions, not better prompts," §3.4). Composition inherits Orca's four-axis spine rather than adding an ungoverned path.

- **Transactional shared program state (p.64):** "each action should declare its **read set, write set, assumptions, version dependencies, verifier obligations, and conflict policy**… re-verification after merge." → The delegate node carries `reads`/`writes`/pinned `childTemplateVersion`; the join runs belief-divergence (assumptions), an `operating_mode`-derived conflict policy, and an optional deterministic re-verify (I1/I3/I4).
- **Context offloading / "a coherent view too large for one window" (§3.2.6, §4.3):** the isolated child state space + compact `writes` summary keep the parent blackboard lean.
- **Planning as contract formation (§3.4.2):** the delegate node's explicit contract *is* a per-action contract over the next state transition.
- **Permissioned state transition + safety governor (§3.4.3, p.64):** child steps are risk-classified, permission-tiered, budget-capped, and safety-floored exactly like any step; the spawn adds a depth/cycle guard (I8), a budget that spans the composition (I2), an **auditable `GoalDecision` + opt-in Supervised launch confirm** (B, §5.2.5 HITL-as-durable-state).
- **Termination governed by verification (§3.4.4, §5.2.2):** the join is **verdict-gated** — a child that terminates with a non-`passed` evidence verdict does not join cleanly (A1); the child's verification *scope* (verdict/untested/residual-risk) is surfaced to the parent, not just its outputs (A2).
- **Inspectable / replayable (§3.5.1):** spawn/join emit `HarnessTransition`s with a `CompositionFacet` (I7); child-step transitions accumulate the child template's metrics **cross-goal**, feeding B's learning loop.
- **FUTURE_ARCHITECTURE:** spawn/join is **control-plane** `DispatchEngine` logic; child steps ride the existing `RunnerPort` (runner-agnostic, I6). The child template version pin makes composition reproducible/replayable (the versioned/stable spine). The **typed template interface** (`inputs` → terminal `outputSchema`) is the composable, versioned unit the marketplace destination assumes (I5). Owner-scoping of child-template resolution is the additive tenancy seam.

---

## 3. Contract & graph model

### 3.1 The `delegate` node
`WorkflowGraphNode.type` gains `"delegate"` (`index.ts:303`). Delegate-only fields (all optional on the shared node, required-when-`delegate` by refinement):
```ts
// on WorkflowGraphNode
childTemplateId?: Id100
childTemplateVersion?: number            // pinned (version dependency)
reads?: Record<string, string>           // { childInputKey: parentKeyName } — parentKeyName is a bare output key available on incoming paths (NOT a {{...}} template)
writes?: Record<string, string>          // { parentOutputKey: childOutputKey } — childOutputKey is a bare key on the child's terminal outputSchema
validationRequired?: boolean             // I4 — re-verify child changes at join
requiresLaunchApproval?: boolean         // B — park for a human launch confirm before spawning, only under operating_mode = human_review (default off)
```
Routing: **one outgoing edge, no port** — treated like a step node in `resolveStepNext` (`graph-routing.ts:69`). Outcome ports are the deferred enhancement; the single edge keeps them additive.

### 3.2 Typed template interface (I5)
`WorkflowTemplate` gains optional `inputs: WorkflowStepOutputSchema` (reusing the field-shape at `output-schema.ts:36`, default `[]`) — the template's **entry inputs**. A template's public interface is **`inputs` (entry) → terminal step `outputSchema` (exit)**. The child's first steps reference `{{key}}` against `inputs`; `validateSchemaReferences` treats declared inputs as "produced at entry."

### 3.3 `CompositionFacet` (I7)
New facet in `packages/contracts/src/harness/`, carried on two new boundaries `delegate_spawn` / `delegate_join`:
```ts
CompositionFacet {
  childRunId: string
  childTemplateId: string
  childTemplateVersion: number
  readsKeys: string[]
  writesKeys: string[]
  depth: number
  costRollupUsd: number | null
  // A1/A2 — the child's terminal EvidenceFacet, surfaced so the parent's continuation is
  // evidence-grounded (§3.4.4 "termination governed by verification", §5.2.2 "declare what it
  // verifies, what it cannot verify"). null when the child produced no terminal evidence.
  childVerdict?: "passed" | "failed" | "partial" | null            // join only
  childUntestedRegions?: string[]                                  // join only
  childResidualRisk?: string[]                                     // join only
  beliefDivergence?: { diverged: boolean; details?: string } | null   // join only
  verifyResult?: { ran: boolean; vetoed: boolean; reason?: string } | null  // join only
}
```

### 3.4 Validation (extends `validate-graph.ts`; now cross-template)
- Delegate node: exactly one outgoing edge (no port); `childTemplateId` resolves to an **installed** template at the pinned version.
- `reads` keys (`childInputKey`) must exactly match the child template's declared `inputs`; each `parentKeyRef` must be available on the delegate node's incoming paths (extends the existing `{{key}}` forward fixpoint).
- `writes` `childOutputKey`s must match the child's **terminal** step `outputSchema` keys; the `parentOutputKey`s feed the parent fixpoint downstream (like a step's outputs).
- **Delegation DAG (I8):** the cross-template delegation graph (template → its delegate targets) must be acyclic — no template transitively delegates to itself — checked at author/install time.

---

## 4. Child-run lifecycle & the delegation stack

### 4.1 Spawn (`DispatchEngine` reaches a delegate node)
1. Resolve `reads` → gather the parent's current **values** for the mapped keys from the parent blackboard.
2. **Snapshot the goal's workspace version(s)** onto the composition row (I3 baseline). The snapshot reads workspace version **through the existing `RunnerPort`-movable resolver** the belief-divergence launch-snapshot already uses (D) — so composition stays control-plane-pure when the control/execution split becomes a network boundary.
3. **Governed launch (B):** record the spawn as an auditable `GoalDecision` (what template, what version, what resolved `reads`, depth) — HITL-as-durable-state (p.64 §5.2.5), not only a transition. Under `operating_mode = human_review`, a delegate may **park for a launch confirm** before spawning (opt-in per node via `requiresLaunchApproval?`, default off so L4 isn't over-gated); under `automated` it never parks. The child's internal steps remain individually gated regardless.
4. Create a **child `WorkflowRun`** — same goal, child template at the pinned version, its own immutable `template_snapshot_json` (via the existing `startWorkflowRun` path, generalized to accept a parent-composition context). Status `active`.
5. **Seed isolated state:** materialize the mapped `reads` as a synthetic *entry* `step_output` artifact in the **child** namespace (so the child's first step sees them through the normal prior-outputs/`{{key}}` path — and only them). **This artifact IS the resolved `reads` values, persisted** — so the delegation is fully replayable (C); the `delegate_spawn` transition links to it.
6. Parent → status **`delegating`**; `goals.active_workflow_run_id` → child (active leaf). Write the composition row; emit a `delegate_spawn` transition.
7. Child's initial step launches via the existing `createInitialStep`/`spawnStepAgent`.

### 4.2 Advance
The child runs its own graph with the **entire existing engine** (steps, gates, splitters, step cards, transitions, crash-retry). The active leaf is the child; supervision applies to child steps.

### 4.3 Join (child reaches its terminal step)
Detected because the run has a `parent_composition_id` → it does **not** yield a goal-level mark-done. Instead:
1. **Verdict-gated join (A1 — termination governed by verification, §3.4.4):** read the child's terminal step `EvidenceFacet.verdict`. A **non-`passed`** terminal verdict (`failed`/`partial`) is **not** a clean join — it is treated as a child failure per §4.5 (propagate → parent blocks; escalate-pause under Supervised). Only a `passed` terminal verdict proceeds to the writes-back below. The child's `verdict` + `untestedRegions` + `residualRisk` are recorded on the `CompositionFacet` (A2) so the parent's continuation — and the human — see the sub-workflow's verification *scope*, not just its outputs (§5.2.2).
2. Map `writes` → materialize a `step_output` artifact **attributed to the parent's delegate node** in the parent namespace (**untrusted evidence**, I4).
3. **Belief-divergence (I3):** compare the composition-row workspace snapshot vs live (via the same `RunnerPort` resolver); on divergence apply the `operating_mode`-derived conflict policy (warn-proceed / escalate-pause), surfaced on the `delegate_join` transition's StateDeps.
4. **Re-verify (I4):** if `validationRequired`, run the deterministic **sensor veto** over the child's changes; a veto blocks the parent with the veto reason.
5. **Cost roll-up (I2):** the child run's `step_complete` costs fold into the composition row and the parent's cumulative spend.
6. Child → `completed`; parent → `active`, cursor advances from the delegate node's single outgoing edge; `active_workflow_run_id` → parent. Emit `delegate_join`.
7. Parent's next node launches, reading `writes` via the unchanged blackboard/`{{key}}` path.

### 4.4 The delegation-stack invariant
`delegating` is a **new** status outside the existing partial-unique index predicate (`active|paused|blocked`), so delegating parents are automatically excluded from the "one active" uniqueness — no index change needed (§5). A chain of `delegating` parents coexists with exactly one active leaf; `active_workflow_run_id` always points to the deepest active leaf. Single-child → a linear stack; fan-out later → siblings under one parent (the same invariant already permits it).

### 4.5 Failure / cancel / re-entry / resume
- **Child step fails/blocks:** ordinary in-child handling; parent stays dormant in `delegating`.
- **Child run fails terminally:** composition row → `failed`; parent → `blocked` with the child's reason (propagate). Human resolves at the parent (retry the delegate, or fail the parent run). Outcome-port branching deferred.
- **Cancel cascades down:** cancelling the goal/parent run walks the composition rows and cancels the active child + deeper descendants.
- **Re-entry / retry:** composition uniqueness is `(parent_run_id, delegate_node_id, spawn_seq)` — `spawn_seq` increments per re-entry (backward edge / gate loop / retry after a blocked child), mirroring step `attempt`; each re-entry spawns a fresh child run; prior attempts retained (append-only).
- **Runtime depth guard (I8):** a spawn exceeding `MAX_DELEGATION_DEPTH` fails the run with a clear reason (defense-in-depth beyond the static DAG check).
- **Resume:** a `delegating` parent + active child reconstruct from statuses + composition rows (like gate-parked cursors); the resume machinery treats the active leaf as resumable, the delegating parent as dormant until join.

### 4.6 Governance
- **Automatic spawn**, no launch gate (first cut): the spawn is orchestration, not a boundary-crossing tool action; child steps are risk-classified, permission-tiered, and safety-floored exactly like any step — composition can't bypass the Governed axis.
- **Owner/tenancy (additive seam):** child-template resolution carries an owner predicate — no delegating to another owner's private template. A no-op under today's single-owner model.

---

## 5. Persistence (one additive migration)

```sql
CREATE TABLE workflow_run_compositions (
  id                              TEXT PRIMARY KEY,
  goal_id                         TEXT NOT NULL REFERENCES goals(id),
  parent_run_id                   TEXT NOT NULL REFERENCES workflow_runs(id),
  child_run_id                    TEXT NOT NULL REFERENCES workflow_runs(id),
  delegate_node_id                TEXT NOT NULL,
  spawn_seq                       INTEGER NOT NULL DEFAULT 0,
  reads_json                      TEXT NOT NULL,
  writes_json                     TEXT NOT NULL,
  parent_workspace_snapshot_json  TEXT,
  depth                           INTEGER NOT NULL DEFAULT 0,
  status                          TEXT NOT NULL,   -- active|completed|failed|cancelled
  cost_rollup_usd                 REAL,
  created_at                      TEXT NOT NULL,
  finished_at                     TEXT
);
CREATE UNIQUE INDEX idx_compositions_parent_node_seq
  ON workflow_run_compositions (parent_run_id, delegate_node_id, spawn_seq);
CREATE INDEX idx_compositions_child ON workflow_run_compositions (child_run_id);

ALTER TABLE workflow_runs ADD COLUMN parent_composition_id TEXT;  -- nullable; cheap join-detection
```
**The active-leaf invariant needs no index change.** The existing `idx_workflow_runs_active_per_goal` is a partial unique index over `status IN ('active','paused','blocked')`. Because `delegating` is a **new** status outside that predicate, delegating parents are *automatically* excluded — a chain of `delegating` parents coexists with exactly one active leaf under the unchanged index. (The only migration touch to `workflow_runs` is the additive `parent_composition_id` column + widening the `status` CHECK to include `delegating`.)

`WorkflowRunStatus` gains `delegating` (additive enum + CHECK on `workflow_runs.status`). Contracts: `WorkflowRun.parentCompositionId` (nullable), the `delegate` node type, template `inputs`, and `CompositionFacet` — all additive.

---

## 6. Desktop UI

Reuse maximally; the genuinely-new surfaces:
- **Delegate node visual** in the Workflow graph (renders from existing `positions`) — sub-workflow shape labeled *"→ {childTemplate} v{n}"* + `reads`/`writes` badges + a state chip (idle / delegating / joined / blocked).
- **Delegation breadcrumb + nested-run view** — entering a delegate node shows *Parent › Child* and renders the active leaf (child) run's graph; navigating up shows the parent with the delegate node highlighted "Delegating…". The one substantial new UI.
- Inside the child: step cards, Sessions panel, and context-preview (showing **only** the mapped reads — isolation made visible) are the existing run UI, unchanged.

---

## 7. Testing (TDD — tests before implementation)

- **Contracts:** delegate node + template `inputs` + `CompositionFacet` parse/round-trip; `delegating` status.
- **Validation:** delegate node rules (single outgoing edge, child resolves, `reads`↔child `inputs`, `writes`↔child terminal outputs); **delegation-DAG cycle rejection**; depth cap.
- **Engine spawn:** delegate node → child run created, reads entry-artifact seeded, parent→`delegating`, `active_workflow_run_id`→child, composition row + `delegate_spawn` transition.
- **Isolation:** a child step's assembled context contains the mapped reads and **nothing** from the parent blackboard.
- **Join:** child terminal (with a `passed` verdict) → `writes` materialized as the parent delegate-node `step_output`, parent→`active`, cursor advances, `delegate_join` transition, child→`completed`, **no goal-level mark-done for the child**.
- **Verdict-gated join (A1/A2):** a child that reaches terminal with a `failed`/`partial` verdict is treated as a child failure (parent blocks / escalates), **not** a clean join; the `CompositionFacet` carries the child's `verdict` + `untestedRegions` + `residualRisk`.
- **Governed launch (B):** the spawn writes an auditable `GoalDecision`; a `requiresLaunchApproval` delegate parks for a human confirm under `human_review` and never parks under `automated`.
- **Four-axis:** belief-divergence surfaces on a workspace move (I3); child step costs count against the parent budget cap + `mark_done` roll-up (I2); `validationRequired` join runs the sensor veto and a veto blocks the parent (I4).
- **Failure/cancel/re-entry/resume:** child-run failure → parent blocks with reason; cancel cascades down the stack; delegate re-entry → new composition row (`spawn_seq`+1); delegating-parent + active-child survive a simulated restart.
- **Desktop:** breadcrumb + nested child graph render; delegate node states; isolation visible in context preview.

---

## 8. Docs shipped with E

- **ORCA.md §5 / §14** — the 4th node type (`delegate`), the delegation stack + `delegating` status, isolated child state, the `reads`/`writes` contract + typed template interface, and the four-axis integration.
- **FUTURE_WORK.md 5.1** — mark **landed** (single-child delegate seam); record deferred: fan-out (same seam over N), outcome-port branching, semantic-merge, workspace file-rollback, per-child runner placement.
- **FUTURE_ARCHITECTURE.md** — composition realized as **control-plane** + runner-agnostic; the typed template interface as the marketplace-composable-unit seam; owner-scoping the additive tenancy step.

---

## 9. Exit criteria

1. A parent template with a `delegate` node runs a **child `WorkflowRun`** of an independently-versioned template on the same goal, with the parent parked in `delegating` and the child as the active leaf.
2. The child runs with an **isolated state space** — it sees only the mapped `reads`, never the parent blackboard; the parent's next step sees only the mapped `writes` (a compact summary), materialized on the delegate node.
3. The delegate boundary is **governed/verified/state-tracked/inspectable**: the join is **verdict-gated** and surfaces the child's verification scope (A1/A2); `operating_mode`-derived conflict policy + belief-divergence at join (I3/I1), budget spanning the composition (I2), optional deterministic re-verify (I4), an auditable `GoalDecision` + opt-in Supervised launch confirm (B), and `delegate_spawn`/`delegate_join` `HarnessTransition`s carrying resolved `reads` values (I7/C).
4. Cross-template validation rejects cyclic delegation and unresolved/over-deep children; failure propagates to the parent; cancel cascades; re-entry is append-only via `spawn_seq`; the stack survives restart.
5. The Workflow panel renders the delegate node + a delegation breadcrumb into the nested child run; isolation is visible in the context preview.
6. One **composed built-in** exercises the seam end-to-end in the app.
7. Composition adds **one additive migration**; spawn/join is **control-plane** (no execution-plane code); the contracts are additive; the reused child template's metrics accumulate **cross-goal** (feeding B).
8. Deferred items (fan-out, outcome ports, semantic-merge, file-rollback, per-child runner) are **documented**, not hidden.
