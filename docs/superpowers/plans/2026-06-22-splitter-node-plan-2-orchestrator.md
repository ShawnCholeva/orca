# Splitter Node — Plan 2: Orchestrator Evaluation & Routing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `splitter` node into the orchestrator run lifecycle so that when a run's cursor reaches a splitter, the orchestrator evaluates the branch via the LLM broker, records the decision, and routes — parking for a "Continue" confirmation in supervised mode and routing inline in unsupervised mode.

**Architecture:** The splitter is the first real user of the *auto-evaluate → stash full destination → confirm → route* pattern that `confirmGate` already scaffolds (gates today only use the human-pick path). We reuse the gate's **routing/park machinery** and the **broker-call pattern** from `run_step_skill` (Plan 1 already shipped the contracts schemas, `resolveSplitterNext`, validation, and `recordSplitDecision`). A new `evaluateAndParkSplitter` builds a `SplitEvaluationRequest`, calls `broker.propose({ kind: "evaluate_split" })`, validates the `SplitEvaluationProposal`, records the split decision, then either parks (supervised) or routes inline (unsupervised) through a generalized `routeBranchDestination`. A new `confirmSplit` + HTTP route performs the deferred supervised route.

**Tech Stack:** TypeScript, better-sqlite3, Zod, Fastify, Vitest.

## Global Constraints

- Splitters are **always automated** (LLM picks the branch). There is no human branch-pick. Supervised mode only adds a *Continue* confirmation checkpoint before routing; it never lets the user change the branch.
- `selectedBranch` returned by the LLM **must** be one of the splitter node's declared `branches`; if not, the run blocks with a clear reason (never route to an undeclared branch).
- Supervision is global: `getSupervisionMode(db)` from `apps/daemon/src/settings/store.js` returns `"supervised" | "unsupervised"` (default `"supervised"`).
- The split confirmation stash lives in its **own** column `pending_split_route_json` — never reuse `pending_gate_route_json` (a run is parked at one node at a time, but separate columns keep `confirmGate`/`decideGate` and `confirmSplit` from cross-routing each other's stash).
- Reuse Plan 1 primitives — do not reimplement: `resolveSplitterNext`, `recordSplitDecision`, `listSplitDecisionsForRun`, `nextTraversalSeq`, `SplitEvaluationRequest`, `SplitEvaluationProposal`. Reuse `latestCommittedLedger`, `gateDestinationStepTemplateId`, `insertStepForRouting`, `nextAttemptForStep`, `spawnStepAgent`, `pauseForConfirmation`, `expireConfirmation`.
- Do **not** change gate behavior, `decideGate`, `parkForGateApproval`, or the gate stash. `routeGateDestination` is generalized in place to also handle splitter destinations (a gate or splitter may route *to* a splitter), but its existing step/gate behavior must be byte-for-byte preserved.
- Contracts already built in Plan 1. If contracts change here (they should not), run `pnpm --filter @orca/contracts build` first.
- Test commands: daemon → `pnpm --filter @orca/daemon test`; typecheck → `pnpm --filter @orca/daemon typecheck`.

## Key existing code (anchors, read before editing)

- `apps/daemon/src/workflows/steps/usecases.ts`: `AdvanceResult` (lines ~298-301), `advanceToNextStepOrGate` (lines ~316-395). The gate arm writes `current_node_kind='gate'`, `current_step_run_id=NULL` and returns `{ kind: "gate", nodeId }`.
- `apps/daemon/src/workflows/orchestrator/service.ts`:
  - `requestNextDecision` consumes `advanceToNextStepOrGate` result; the `result.kind === "gate"` branch is at ~3216-3230 inside `commitAdvanceOrComplete`.
  - `parkForGateApproval` ~3371-3441; `decideGate` ~3449-3542; `routeGateDestination` ~3552-3619; `confirmGate` ~3663-3721.
  - `gateDestinationStepTemplateId` ~351-354; `readStepRun` ~300; broker-call pattern in `run_step_skill` ~2444-2474; supervised pause `getSupervisionMode(db) === "supervised"` ~1558 with `pauseForConfirmation` ~1579.
  - source step output is read from `workflow_artifacts WHERE step_run_id = ? AND type = 'step_output'`, JSON-parsed, with `_completion` stripped (see ~431, ~569).
  - `GoalRow` has `orchestrator_provider: ModelProviderId | null` and `orchestrator_model: string | null` (~111-112).
- `apps/daemon/src/workflows/orchestration-transport/broker.ts`: `propose(request, { validateProposal })` → `{ status: "proposed", parsed, ... }` or non-proposed; `validateProposal(raw) => { accepted: true, parsed } | { accepted: false, failureMessage }`.
- Gate integration test to mirror: `apps/daemon/src/workflows/orchestrator/service.gate-routing.test.ts`.

## File Structure

- Modify `apps/daemon/src/workflows/steps/usecases.ts` — `AdvanceResult` + splitter arm.
- Modify `apps/daemon/src/workflows/steps/usecases.test.ts` (or the nearest advance test) — splitter-arm unit test.
- Create `apps/daemon/migrations/0039_workflow_run_pending_split_route.sql` — `pending_split_route_json` column.
- Modify `apps/daemon/src/migrations.ts` — register 0039.
- Modify `apps/daemon/src/workflows/orchestrator/service.ts` — `evaluateAndParkSplitter`, generalize `routeGateDestination` → handle splitter dest, `confirmSplit`, `requestNextDecision` splitter branch, resume-confirmations splitter support, `buildSplitEvaluationRequest` helper, source-output helper.
- Modify `apps/daemon/src/server.ts` — `POST /v1/workflows/runs/:id/confirm-split`.
- Create `apps/daemon/src/workflows/orchestrator/service.splitter-routing.test.ts` — integration tests.
- Modify `apps/daemon/src/workflows/orchestration-transport/proposals.ts` — already lists `evaluate_split` as unsupported (Plan 1). No change needed; the broker uses the caller-supplied `validateProposal`, not the envelope parser.

---

### Task 1: `advanceToNextStepOrGate` splitter arm

**Files:**
- Modify: `apps/daemon/src/workflows/steps/usecases.ts` (`AdvanceResult` ~298-301; the `resolveStepNext` dispatch ~362-395)
- Test: `apps/daemon/src/workflows/steps/usecases.test.ts`

**Interfaces:**
- Consumes: `resolveStepNext` returning a `Destination` that may now be `{ kind: "splitter" }` (Plan 1).
- Produces: `AdvanceResult` gains `{ kind: "splitter"; nodeId: string }`; when the next destination is a splitter, the function writes `current_node_kind='splitter'`, `current_step_run_id=NULL`, `current_node_id=<splitterNodeId>` and returns `{ kind: "splitter", nodeId }`.

- [ ] **Step 1: Write the failing test**

In `apps/daemon/src/workflows/steps/usecases.test.ts`, add a test that builds a run whose current step routes to a splitter node and asserts the advance result + cursor. Use the file's existing DB/seed helpers (mirror an existing `advanceToNextStepOrGate` gate test in this file; if none, mirror the seed pattern from `gates/usecases.test.ts`). The assertion:

```typescript
it("advances a step into a splitter node, parking the cursor", () => {
  // seed: template with step 's0' -> splitter 'route' (branches a/b) -> steps a,b -> terminal
  // insert an active step run for s0, then:
  const result = advanceToNextStepOrGate(db, () => "2026-06-22T00:00:01.000Z", s0RunId);
  expect(result).toEqual({ kind: "splitter", nodeId: "route" });
  const run = db.prepare("SELECT current_node_id, current_node_kind, current_step_run_id FROM workflow_runs WHERE id = ?").get(runId);
  expect(run).toMatchObject({ current_node_id: "route", current_node_kind: "splitter", current_step_run_id: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- steps/usecases`
Expected: FAIL — current code falls through to the step arm for a splitter destination (returns `{ kind: "step" }` and tries to insert a step run), so the result/cursor assertion fails.

- [ ] **Step 3: Extend `AdvanceResult`**

```typescript
export type AdvanceResult =
  | { kind: "step"; stepRun: WorkflowStepRunT }
  | { kind: "gate"; nodeId: string }
  | { kind: "splitter"; nodeId: string }
  | { kind: "completed-terminal"; stepRun: WorkflowStepRunT };
```

- [ ] **Step 4: Add the splitter arm**

In `advanceToNextStepOrGate`, alongside the existing `dest.kind === "gate"` arm, add (before the step fallback):

```typescript
    if (dest.kind === "splitter") {
      db.prepare(
        "UPDATE workflow_runs SET current_step_run_id = NULL, current_node_id = ?, current_node_kind = 'splitter' WHERE id = ?"
      ).run(dest.nodeId, current.workflowRunId);
      return { kind: "splitter", nodeId: dest.nodeId };
    }
```

(Use the same run-id source the gate arm uses — e.g. `current.workflowRunId`. Match the gate arm's exact column writes.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- steps/usecases`
Expected: PASS (existing gate/step/terminal advance tests stay green).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows/steps/usecases.ts apps/daemon/src/workflows/steps/usecases.test.ts
git commit -m "feat(daemon): advanceToNextStepOrGate parks the cursor at a splitter node"
```

---

### Task 2: `pending_split_route_json` migration

**Files:**
- Create: `apps/daemon/migrations/0039_workflow_run_pending_split_route.sql`
- Modify: `apps/daemon/src/migrations.ts` (after `"0038_workflow_split_decisions.sql"`)
- Test: the existing `apps/daemon/src/migrations.test.ts` migration-list assertions (update them)

**Interfaces:**
- Produces: `workflow_runs.pending_split_route_json TEXT` (nullable), the deferred-route stash for supervised splitter confirmation.

- [ ] **Step 1: Update the failing migration-list assertions first (TDD for the registration)**

In every migration-list `toEqual([...])` in `apps/daemon/src/migrations.test.ts`, `apps/daemon/test/migrations-0006.test.ts`, and `apps/daemon/src/migrations/suggested-orchestration.test.ts`, add `"0039_workflow_run_pending_split_route.sql"` immediately after the `"0038_workflow_split_decisions.sql"` line (matching each file's quote/comma style — note the suggested-orchestration list's last entry needs a trailing comma added to the prior line).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @orca/daemon test -- migrations`
Expected: FAIL — the registered list (once Step 4 lands) must include 0039; right now the assertion includes a file that isn't registered, OR the file isn't created yet. (If run before Steps 3-4, fails because the discovered file is absent / list mismatch.)

- [ ] **Step 3: Create the migration**

Create `apps/daemon/migrations/0039_workflow_run_pending_split_route.sql`:

```sql
-- 0039_workflow_run_pending_split_route.sql
-- Deferred-route stash for a splitter parked at a supervised confirmation
-- checkpoint. Mirrors pending_gate_route_json but is consumed only by
-- confirmSplit, so gate and splitter confirmation paths never cross-route.
ALTER TABLE workflow_runs ADD COLUMN pending_split_route_json TEXT;
```

- [ ] **Step 4: Register the migration**

In `apps/daemon/src/migrations.ts` `migrationFiles`, after `"0038_workflow_split_decisions.sql",` add:

```typescript
  "0039_workflow_run_pending_split_route.sql",
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @orca/daemon test -- migrations`
Expected: PASS (all migration suites green; 0039 applies on a fresh DB).

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/migrations/0039_workflow_run_pending_split_route.sql apps/daemon/src/migrations.ts apps/daemon/src/migrations.test.ts apps/daemon/test/migrations-0006.test.ts apps/daemon/src/migrations/suggested-orchestration.test.ts
git commit -m "feat(daemon): add pending_split_route_json stash column (migration 0039)"
```

---

### Task 3: Generalize `routeGateDestination` to handle splitter destinations

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (`routeGateDestination` ~3552-3619)
- Test: `apps/daemon/src/workflows/orchestrator/service.splitter-routing.test.ts` (created in Task 6 — for now add a focused unit-ish integration test here or fold into Task 6; this task's behavior is covered by Task 6's "gate routes to splitter" case)

**Interfaces:**
- Consumes: `Destination` with possible `kind: "splitter"`.
- Produces: `routeGateDestination`'s `dest` parameter type widens to `{ kind: "step" | "gate" | "splitter"; nodeId: string }`; a splitter destination moves the cursor (`current_step_run_id=NULL, current_node_id=?, current_node_kind='splitter'`) and then calls `this.evaluateAndParkSplitter(...)` (Task 4). Existing step and gate behavior unchanged.

- [ ] **Step 1: Widen the `dest` parameter type**

Change the signature's `dest: { kind: "step" | "gate"; nodeId: string }` to `dest: { kind: "step" | "gate" | "splitter"; nodeId: string }`.

- [ ] **Step 2: Add the splitter destination branch**

Immediately after the existing `if (dest.kind === "gate") { ... return; }` block, add:

```typescript
    if (dest.kind === "splitter") {
      db.prepare(
        "UPDATE workflow_runs SET current_step_run_id = NULL, current_node_id = ?, current_node_kind = 'splitter' WHERE id = ?"
      ).run(dest.nodeId, run.id);
      const stepRun = readStepRun(db, sourceStepRunId);
      const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
      if (!stepTpl) {
        this.blockRun(
          db, now,
          { run, stepRun, stepTpl: template.steps[0]!, goal },
          `source step template not found: ${stepRun.step_template_id}`,
          options
        );
        return;
      }
      await this.evaluateAndParkSplitter(
        db, now,
        { run, stepRun, stepTpl, template, goal, splitterNodeId: dest.nodeId },
        options
      );
      return;
    }
```

This mirrors the gate-destination branch but evaluates the splitter (Task 4) rather than parking for a human pick.

- [ ] **Step 3: Verify it compiles (no behavior change to step/gate yet)**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: FAIL only on `this.evaluateAndParkSplitter` not existing yet (Task 4). That is expected; proceed to Task 4 and re-verify there. (Do not commit a non-compiling tree — this task's commit happens after Task 4 makes it compile. Combine Steps here with Task 4's commit, OR temporarily stub `evaluateAndParkSplitter` to throw and commit; prefer combining commits with Task 4.)

**Note:** Tasks 3 and 4 are tightly coupled (3 calls 4). Implement 3 then 4, run tests, and commit them together as one logical unit if a reviewer would otherwise see a non-compiling intermediate. The reviewer reviews the combined diff.

---

### Task 4: `evaluateAndParkSplitter` — broker evaluation + supervised park / inline route

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (add private methods near `parkForGateApproval`)
- Test: covered by Task 6 integration tests (supervised park + unsupervised inline + undeclared-branch block)

**Interfaces:**
- Consumes: `SplitEvaluationRequest`, `SplitEvaluationProposal` (Plan 1 contracts); `resolveSplitterNext`, `recordSplitDecision`, `nextTraversalSeq`, `latestCommittedLedger`, `listSplitDecisionsForRun`, `getSupervisionMode`, `this.broker.propose`, `pauseForConfirmation`, `routeGateDestination`.
- Produces: `private async evaluateAndParkSplitter(db, now, ctx, options): Promise<void>` where `ctx = { run, stepRun, stepTpl, template, goal, splitterNodeId }`. Records the split decision, then supervised → stash `pending_split_route_json` + `pauseForConfirmation` + record an `evaluate_split` decision trace; unsupervised → route inline via `routeGateDestination` and spawn.

- [ ] **Step 1: Add a source-step-output helper (if not already present)**

Add a private helper to read the source step's output artifact (mirrors the gate-eval intent):

```typescript
  private readStepOutputForRun(db: Database.Database, stepRunId: string): Record<string, unknown> | null {
    const row = db
      .prepare("SELECT body FROM workflow_artifacts WHERE step_run_id = ? AND type = 'step_output' LIMIT 1")
      .get(stepRunId) as { body: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.body) as Record<string, unknown>;
      const { _completion, ...rest } = parsed;
      void _completion;
      return rest;
    } catch {
      return null;
    }
  }
```

(If an equivalent private helper already exists in `service.ts`, reuse it instead of adding a duplicate.)

- [ ] **Step 2: Add a request builder**

```typescript
  private buildSplitEvaluationRequest(
    db: Database.Database,
    ctx: { run: WorkflowRunT; stepRun: StepRunRow; goal: GoalRow; splitterNode: WorkflowGraphNode }
  ): SplitEvaluationRequest {
    const { run, stepRun, goal, splitterNode } = ctx;
    const priorDecisions = listSplitDecisionsForRun(db, run.id).map((d) => ({
      nodeId: d.nodeId,
      selectedBranch: d.selectedBranch,
      reason: d.reason,
    }));
    const committedLedger = latestCommittedLedger(db, run.id).records.map((r) => ({
      id: r.id,
      recordType: r.recordType,
      status: r.status,
      note: r.note,
    }));
    return SplitEvaluationRequest.parse({
      splitter: {
        nodeId: splitterNode.id,
        name: splitterNode.name,
        instructions: splitterNode.instructions ?? "",
        branches: splitterNode.branches ?? [],
      },
      goal: { id: goal.id, description: goal.description },
      sourceStepOutput: this.readStepOutputForRun(db, stepRun.id),
      priorDecisions,
      committedLedger,
    });
  }
```

(Match the exact `LedgerRecord` field names from `latestCommittedLedger` — adjust `r.recordType/status/note` to the real projection field names.)

- [ ] **Step 3: Add `evaluateAndParkSplitter`**

```typescript
  /**
   * The run cursor is parked at a splitter (current_node_kind='splitter').
   * Evaluates the branch via the orchestrator broker, validates the selected
   * branch against the node's declared branches, records the split decision,
   * then routes — parking for a Continue confirmation in supervised mode or
   * routing inline in unsupervised mode.
   */
  private async evaluateAndParkSplitter(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      template: WorkflowTemplateT;
      goal: GoalRow;
      splitterNodeId: string;
    },
    options: RequestNextDecisionOptions
  ): Promise<void> {
    const { run, stepRun, stepTpl, template, goal, splitterNodeId } = ctx;
    const graph = effectiveGraph(template.graph, template.steps);
    const splitterNode = graph.nodes.find(
      (n) => n.id === splitterNodeId && n.type === "splitter"
    );
    if (!splitterNode) {
      this.blockRun(db, now, { run, stepRun, stepTpl, goal }, `splitter node not found in graph: ${splitterNodeId}`, options);
      return;
    }
    const branches = splitterNode.branches ?? [];

    const request = OrchestrationRequest.parse({
      kind: "evaluate_split",
      goalId: goal.id,
      workflowRunId: run.id,
      stepRunId: stepRun.id,
      providerId: goal.orchestrator_provider,
      modelId: goal.orchestrator_model,
      payload: this.buildSplitEvaluationRequest(db, { run, stepRun, goal, splitterNode }),
    });
    const validate = (raw: unknown) => {
      const parsed = SplitEvaluationProposal.safeParse(raw);
      if (!parsed.success) return { accepted: false as const, failureMessage: "invalid split proposal" };
      if (!branches.includes(parsed.data.selectedBranch)) {
        return { accepted: false as const, failureMessage: `selectedBranch '${parsed.data.selectedBranch}' is not a declared branch` };
      }
      return { accepted: true as const, parsed: parsed.data };
    };

    let result = await this.broker.propose(request, { validateProposal: validate });
    if (result.status !== "proposed") {
      result = await this.broker.propose(request, { validateProposal: validate });
    }
    if (result.status !== "proposed") {
      this.blockRun(db, now, { run, stepRun, stepTpl, goal }, `splitter ${splitterNode.id} evaluation failed`, options);
      return;
    }
    const proposal = result.parsed as SplitEvaluationProposal;

    let dest;
    try {
      dest = resolveSplitterNext(graph, splitterNode.id, proposal.selectedBranch);
    } catch (e) {
      this.blockRun(db, now, { run, stepRun, stepTpl, goal }, `splitter ${splitterNode.id} routing failed: ${(e as Error).message}`, options);
      return;
    }
    if (dest.kind !== "step" && dest.kind !== "gate" && dest.kind !== "splitter") {
      this.blockRun(db, now, { run, stepRun, stepTpl, goal }, `splitter ${splitterNode.id} resolved to an unroutable destination`, options);
      return;
    }

    const ledger = latestCommittedLedger(db, run.id);
    const seq = nextTraversalSeq(db, run.id);
    recordSplitDecision(db, now, {
      goalId: goal.id,
      workflowRunId: run.id,
      nodeId: splitterNode.id,
      traversalSeq: seq,
      selectedBranch: proposal.selectedBranch,
      reason: proposal.reason,
      selectedEdgeTo: dest.nodeId,
      inputsConsidered: proposal.inputsConsidered,
      ledgerVersion: ledger.version,
    });

    if (getSupervisionMode(db) === "supervised") {
      const stagedEvents: DomainEvent[] = [];
      db.transaction(() => {
        db.prepare("UPDATE workflow_runs SET pending_split_route_json = ? WHERE id = ?").run(
          JSON.stringify({
            splitterNodeId: splitterNode.id,
            selectedBranch: proposal.selectedBranch,
            destNodeId: dest.nodeId,
            destKind: dest.kind,
            sourceStepRunId: stepRun.id,
          }),
          run.id
        );
        recordDecisionInTx(db, now, {
          goalId: goal.id,
          workflowRunId: run.id,
          stepRunId: stepRun.id,
          decisionType: "evaluate_split",
          selectedAction: `splitter:${splitterNode.id}:${proposal.selectedBranch}`,
          reason: proposal.reason,
          influencedBy: [{ kind: "workflow_step", id: stepTpl.id, label: stepTpl.name, effect: "satisfied" }],
          inputFingerprint: decisionFingerprint({
            runId: run.id, stepRunId: stepRun.id, decisionType: "evaluate_split",
            payload: `${splitterNode.id}:${proposal.selectedBranch}`,
          }),
        }, { idFactory: options.idFactory, stagedEvents });
      })();
      this.publish(options.bus, stagedEvents);
      pauseForConfirmation(
        { db, bus: options.bus ?? new EventBus() },
        { stepRunId: stepRun.id, summary: `Routing to "${proposal.selectedBranch}": ${proposal.reason}` }
      );
      return;
    }

    // Unsupervised: route inline immediately.
    await this.routeGateDestination(
      db, now,
      { run, template, goal, sourceStepRunId: stepRun.id },
      { kind: dest.kind, nodeId: dest.nodeId },
      options
    );
    const after = getWorkflowRunById(db, run.id);
    if (after && after.status === "active" && after.currentStepRunId) {
      const nextStepRun = readStepRun(db, after.currentStepRunId);
      const nextTpl = template.steps.find((s) => s.id === nextStepRun.step_template_id);
      if (nextTpl) {
        await this.spawnStepAgent(db, now, { run: after, stepRun: nextStepRun, stepTpl: nextTpl, template, goal }, options);
      }
    }
  }
```

Add any missing imports: `SplitEvaluationRequest`, `SplitEvaluationProposal`, `OrchestrationRequest` (likely already imported), `resolveSplitterNext` (from `../graph/graph-routing.js`), `recordSplitDecision` (from `../splitters/usecases.js`), `listSplitDecisionsForRun` (from `../splitters/projection.js`), `WorkflowGraphNode` type.

- [ ] **Step 4: Verify compile**

Run: `pnpm --filter @orca/daemon typecheck`
Expected: PASS (Task 3 + Task 4 now compile together). Adjust field names (`StepRunRow.step_template_id`, `LedgerRecord` fields, `GoalRow.description`) to the real shapes if tsc complains.

- [ ] **Step 5: Commit Tasks 3+4 together**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts
git commit -m "feat(daemon): evaluate splitter via broker, route inline or park for confirm"
```

---

### Task 5: `requestNextDecision` splitter branch + `confirmSplit` + resume support

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`
- Test: covered by Task 6

**Interfaces:**
- Consumes: `evaluateAndParkSplitter` (Task 4), `routeGateDestination` (Task 3).
- Produces:
  - In `commitAdvanceOrComplete`, a `result.kind === "splitter"` branch that calls `evaluateAndParkSplitter` then mirrors the gate branch's "did it stay active with a current step?" check.
  - `async confirmSplit(db, now, runId, options): Promise<void>` — reads + clears `pending_split_route_json`, expires the confirmation, routes via `routeGateDestination`, then `requestNextDecision` to spawn.
  - The resume-all-confirmations path (used when supervision flips to unsupervised) also resumes splitter parks.

- [ ] **Step 1: Add the splitter branch in `commitAdvanceOrComplete`**

After the existing `if (result.kind === "gate") { ... }` block (the one calling `parkForGateApproval`), add a sibling:

```typescript
      if (result.kind === "splitter") {
        await this.evaluateAndParkSplitter(
          db, now,
          { run, stepRun, stepTpl, template, goal, splitterNodeId: result.nodeId },
          options
        );
        const after = getWorkflowRunById(db, run.id);
        if (!after || after.status !== "active" || !after.currentStepRunId) {
          return this.commitNoopLatestDecision(db, run.id, stepRun.id);
        }
      }
```

(Supervised park leaves `current_step_run_id` NULL → returns the noop latest decision, exactly like the parked-gate case. Unsupervised inline route either advanced to a step with a spawned agent or parked at a downstream splitter/gate.)

- [ ] **Step 2: Add `confirmSplit`** (mirror `confirmGate`)

```typescript
  /**
   * User "Continue" for a supervised splitter decision held at a confirmation
   * checkpoint. Reads + clears pending_split_route_json, expires the confirmation
   * activity, then performs the deferred route. Idempotent: a null/consumed stash
   * is a no-op. The splitter is NOT re-evaluated — the decision is already recorded
   * and deduped by traversal_seq.
   */
  async confirmSplit(
    db: Database.Database,
    now: () => string,
    runId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const run = getWorkflowRunById(db, runId);
    if (!run) return;
    const stashRow = db
      .prepare("SELECT pending_split_route_json FROM workflow_runs WHERE id = ?")
      .get(runId) as { pending_split_route_json: string | null } | undefined;
    if (!stashRow?.pending_split_route_json) return;

    let stash: { splitterNodeId: string; selectedBranch: string; destNodeId: string; destKind: "step" | "gate" | "splitter"; sourceStepRunId: string };
    try {
      stash = JSON.parse(stashRow.pending_split_route_json);
    } catch {
      db.prepare("UPDATE workflow_runs SET pending_split_route_json = NULL WHERE id = ?").run(runId);
      return;
    }

    const template = loadRunTemplate(db, run);
    if (!template) return;
    const goal = readGoal(db, run.goalId);

    db.prepare("UPDATE workflow_runs SET pending_split_route_json = NULL WHERE id = ?").run(runId);
    expireConfirmation({ db, bus: options.bus ?? new EventBus() }, { stepRunId: stash.sourceStepRunId });

    await this.routeGateDestination(
      db, now,
      { run, template, goal, sourceStepRunId: stash.sourceStepRunId },
      { kind: stash.destKind, nodeId: stash.destNodeId },
      options
    );
    const after = getWorkflowRunById(db, runId);
    if (after && after.status === "active" && after.currentStepRunId) {
      await this.requestNextDecision(db, now, runId, options);
    }
  }
```

- [ ] **Step 3: Resume splitter parks when supervision flips to unsupervised**

Find the method that resumes all supervised confirmations (around lines ~2112-2140, "Continues all workflow runs currently paused at a supervised confirmation checkpoint"). Where it currently resumes step confirmations and gate confirmations, add resumption of runs with a non-null `pending_split_route_json` by calling `this.confirmSplit(db, now, run.id, options)` for each. Match the existing query/iteration pattern in that method exactly.

- [ ] **Step 4: Verify compile + run gate tests for no-regression**

Run: `pnpm --filter @orca/daemon typecheck && pnpm --filter @orca/daemon test -- gate-routing`
Expected: typecheck PASS; gate-routing tests PASS unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts
git commit -m "feat(daemon): route splitter on Continue (confirmSplit) and on supervision flip"
```

---

### Task 6: HTTP route + integration tests

**Files:**
- Modify: `apps/daemon/src/server.ts` (near the `confirm-gate` route ~1751)
- Create: `apps/daemon/src/workflows/orchestrator/service.splitter-routing.test.ts`

**Interfaces:**
- Consumes: `orchestratorService.confirmSplit`, `evaluateAndParkSplitter` (via run lifecycle).
- Produces: `POST /v1/workflows/runs/:id/confirm-split` → `confirmSplit`; integration coverage of supervised park→confirm→route, unsupervised inline route, and undeclared-branch block.

- [ ] **Step 1: Write the failing integration tests**

Create `apps/daemon/src/workflows/orchestrator/service.splitter-routing.test.ts`, mirroring `service.gate-routing.test.ts`'s harness (in-memory DB + migrations + a fake/stub broker). Cover:

```typescript
// 1. Supervised: cursor reaches splitter -> broker picks 'go_a' -> run parks
//    (current_step_run_id NULL, pending_split_route_json set, a split decision
//    recorded, a confirmation activity paused). Then confirmSplit -> routes to
//    the 'go_a' step, spawns its agent, clears the stash.
// 2. Unsupervised: cursor reaches splitter -> broker picks 'go_b' -> routes
//    inline to the 'go_b' step immediately, no stash, decision recorded.
// 3. Undeclared branch: broker returns selectedBranch not in branches ->
//    validateProposal rejects -> after retries the run blocks with a clear reason;
//    no split decision recorded, no route taken.
// 4. confirmSplit is idempotent: a second call with a cleared stash is a no-op.
```

Use the project's existing broker stubbing approach from `service.gate-routing.test.ts` / `service.skill-step.test.ts` (inject a broker whose `propose` returns `{ status: "proposed", parsed: { selectedBranch, reason, inputsConsidered: [] } }`). Set supervision mode via `setSupervisionMode(db, "supervised"|"unsupervised", now)`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @orca/daemon test -- splitter-routing`
Expected: FAIL — route not wired and/or assertions unmet until Step 3-4. (Tasks 1-5 logic exists, but the integration wiring asserts the full lifecycle.)

- [ ] **Step 3: Add the HTTP route**

In `apps/daemon/src/server.ts`, next to the `confirm-gate` POST handler, add:

```typescript
  app.post("/v1/workflows/runs/:id/confirm-split", async (req, reply) => {
    const { id } = req.params as { id: string };
    await orchestratorService.confirmSplit(db, now, id, { bus, idFactory });
    return reply.send({ ok: true });
  });
```

(Match the exact handler style, `now`/`bus`/`idFactory` sources, and reply shape of the adjacent `confirm-gate` route.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @orca/daemon test -- splitter-routing`
Expected: PASS (all four cases green).

- [ ] **Step 5: Full daemon typecheck + targeted suites**

Run: `pnpm --filter @orca/daemon typecheck && pnpm --filter @orca/daemon test -- splitter gate-routing migrations steps/usecases`
Expected: typecheck clean; all listed suites green.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/server.ts apps/daemon/src/workflows/orchestrator/service.splitter-routing.test.ts
git commit -m "feat(daemon): confirm-split route + splitter orchestration integration tests"
```

---

## Self-Review

**Spec coverage:**
- Orchestrator wiring of `evaluate_split` (cursor reaches splitter → broker eval → record → route) → Tasks 1, 3, 4, 5. ✓
- `selectedBranch` validated against declared branches; block otherwise → Task 4 `validate` + block paths. ✓
- Supervised park-for-Continue vs unsupervised inline route → Task 4 (`getSupervisionMode`), Task 5 (`confirmSplit`, resume). ✓
- Separate `pending_split_route_json` stash → Task 2. ✓
- Generalized `routeBranchDestination` (here: `routeGateDestination` widened to splitter dest, so gate/splitter can target a splitter) → Task 3. ✓
- Gates untouched: `parkForGateApproval`/`decideGate`/`confirmGate` unchanged; only `routeGateDestination`'s dest type widened additively → Tasks 3-5. ✓
- HTTP entry point for the Continue → Task 6. ✓

**Placeholder scan:** New method bodies are given in full; integration-test cases are specified with the exact four scenarios and the stubbing approach (the test file is mirrored from an existing one rather than hand-transcribed line-by-line because the harness is large and already exists — the implementer adapts the existing harness, which is the intended pattern). Insertion points carry line anchors. No "TODO"/"handle edge cases".

**Type consistency:** `selectedBranch`/`reason`/`inputsConsidered` match `SplitEvaluationProposal` (Plan 1). `recordSplitDecision` input matches Plan 1's `SplitDecisionInput`. `dest.kind` widened consistently across `routeGateDestination`, `confirmSplit` stash, and `evaluateAndParkSplitter`. `AdvanceResult` splitter variant matches the `commitAdvanceOrComplete` branch.

**Risk note for the implementer/reviewer:** This plan edits the orchestrator (`service.ts`, the system's most critical file). Tasks 3-4 are coupled and commit together. Field names in the reference code (`StepRunRow.step_template_id`, `latestCommittedLedger` record fields, `GoalRow` orchestrator fields) must be reconciled against the real types at implementation time — adjust to compile, keeping the documented behavior. Use a capable model (not the cheapest) for Tasks 3-6.
