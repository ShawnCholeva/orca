# Gate-Evaluator (L4→L5 Seam) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under `operating_mode='automated'` (L5), resolve a workflow gate with an LLM evaluator that fills a verdict + enumerated issue list; the deterministic core branches on it, routes the failing criterion back to the closing step, and terminates honestly when the goal won't converge — while `human_review` (L4) keeps the human verdict exactly as today.

**Architecture:** The gate is the PEV *Verify* phase. The deterministic `DispatchEngine` (control plane) owns the L4/L5 branch, routing, the reject cap, and termination; the LLM only produces `GateEvaluationProposal`. The LLM call rides the runner-agnostic `ShadowAsk` seam (the live shadow-session path `synthesize.ts`/`recover-step-scoring.ts` already use) — an **optional** `DispatchEngine` dep, faked in tests, backed in prod by the `ShadowSessionManager` `server.ts` already builds. The `{reason, issueRefs}` repair channel is already plumbed (`latestRejectingGate → repairContext`); the automated path just fills `issueRefs`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), better-sqlite3, Zod contracts (`@orca/contracts`), Vitest. Monorepo pnpm workspace; daemon package `@orca/daemon`.

## Global Constraints

- Deterministic core owns lifecycle/routing/branching/termination; the LLM only fills the verdict/issue list — it never advances the flow. (CLAUDE.md; FUTURE_ARCHITECTURE line 95)
- L4 (`human_review`) completion stays human-authoritative — `parkForGateApproval` / `decideGate` behavior is unchanged.
- Do NOT touch `apps/daemon/src/workflows/composition/join.ts` or wire a `delegate→gate` resume path (pre-existing orphan; out of scope).
- Reuse existing contracts verbatim: `GateEvaluationRequest` / `GateEvaluationProposal` (`packages/contracts/src/workflows/index.ts:833-861`); `evaluate_gate` is already an `OrchestrationDecisionKind`. No contract changes.
- Every commit: `pnpm --filter @orca/daemon build` must stay green (tsc typechecks test files — a stale fixture breaks `pnpm dev:desktop`) AND the touched vitest dirs pass.
- ESM: all intra-package imports use explicit `.js` specifiers.
- Branch `phase5-3-gate-evaluator` off `main`; never commit to `main`.

---

### Task 1: `gate-evaluation.ts` — LLM evaluator module

Pure module mirroring `recover-step-scoring.ts`: compose a gate-eval prompt, ask the shadow seam, parse `GateEvaluationProposal`, retry once, return `null` on any failure. No DB, no engine — unit-testable in isolation.

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/gate-evaluation.ts`
- Test: `apps/daemon/src/workflows/orchestrator/gate-evaluation.test.ts`

**Interfaces:**
- Consumes: `ShadowAsk` (`import type { ShadowAsk } from "./recover-step-scoring.js"`); `GateEvaluationRequest`, `GateEvaluationProposal` (from `@orca/contracts`); `SHADOW_LLM_TIMEOUT_MS` (`../../orchestrator-llm/shadow-llm-client.js`); `ShadowAdapterId` (`../../orchestrator-llm/shadow-session.js`).
- Produces:
  - `export const GATE_REJECT_CAP = 3`
  - `export function composeGateEvaluationPrompt(request: GateEvaluationRequest): { systemPrompt: string; userPrompt: string }`
  - `export function issueRefsEqual(a: string[], b: string[]): boolean`
  - `export async function evaluateGate(deps: ShadowAsk, input: { goalId: string; adapterId: ShadowAdapterId; request: GateEvaluationRequest; timeoutMs: number }): Promise<GateEvaluationProposal | null>`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/orchestrator/gate-evaluation.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { GateEvaluationRequest, GateEvaluationProposal } from "@orca/contracts";
import type { ShadowAsk } from "./recover-step-scoring.js";
import { evaluateGate, composeGateEvaluationPrompt, issueRefsEqual, GATE_REJECT_CAP } from "./gate-evaluation.js";

const REQUEST: GateEvaluationRequest = {
  gate: { nodeId: "gate", name: "Review Gate", instructions: "Approve when the deliverable meets the goal." },
  goal: { id: "goal-1", description: "Ship the feature." },
  sourceStepOutput: { summary: "done" },
  priorGateDecisions: [],
  availableOutcomes: ["approved", "rejected"],
  committedLedger: [],
};

function askReturning(text: string): ShadowAsk {
  return { async ask() { return { text }; } };
}
function askThrowing(): ShadowAsk {
  return { async ask() { throw new Error("shadow down"); } };
}

describe("evaluateGate", () => {
  it("parses an approved proposal", async () => {
    const proposal: GateEvaluationProposal = {
      outcome: "approved", reason: "Meets the goal.", issueRefs: [], inputsConsidered: ["sourceStepOutput"],
    };
    const result = await evaluateGate(askReturning(JSON.stringify(proposal)), {
      goalId: "goal-1", adapterId: "claude-code", request: REQUEST, timeoutMs: 1000,
    });
    expect(result).toEqual(proposal);
  });

  it("preserves the enumerated issueRefs on a rejected proposal", async () => {
    const proposal: GateEvaluationProposal = {
      outcome: "rejected", reason: "Two gaps.", issueRefs: ["missing-tests", "no-error-handling"], inputsConsidered: ["sourceStepOutput"],
    };
    const result = await evaluateGate(askReturning(JSON.stringify(proposal)), {
      goalId: "goal-1", adapterId: "claude-code", request: REQUEST, timeoutMs: 1000,
    });
    expect(result?.issueRefs).toEqual(["missing-tests", "no-error-handling"]);
  });

  it("returns null when ask throws", async () => {
    const result = await evaluateGate(askThrowing(), {
      goalId: "goal-1", adapterId: "claude-code", request: REQUEST, timeoutMs: 1000,
    });
    expect(result).toBeNull();
  });

  it("returns null on non-JSON and on an invalid proposal", async () => {
    expect(await evaluateGate(askReturning("not json"), { goalId: "g", adapterId: "claude-code", request: REQUEST, timeoutMs: 1000 })).toBeNull();
    expect(await evaluateGate(askReturning(JSON.stringify({ outcome: "maybe" })), { goalId: "g", adapterId: "claude-code", request: REQUEST, timeoutMs: 1000 })).toBeNull();
  });

  it("retries once, then succeeds on the second turn", async () => {
    let calls = 0;
    const flaky: ShadowAsk = {
      async ask() {
        calls += 1;
        if (calls === 1) return { text: "garbage" };
        return { text: JSON.stringify({ outcome: "approved", reason: "ok", issueRefs: [], inputsConsidered: [] }) };
      },
    };
    const result = await evaluateGate(flaky, { goalId: "g", adapterId: "claude-code", request: REQUEST, timeoutMs: 1000 });
    expect(calls).toBe(2);
    expect(result?.outcome).toBe("approved");
  });

  it("exposes GATE_REJECT_CAP and an evidence-grounded prompt with the request embedded", () => {
    expect(GATE_REJECT_CAP).toBe(3);
    const { systemPrompt, userPrompt } = composeGateEvaluationPrompt(REQUEST);
    expect(systemPrompt).toContain("orca:action");
    // p.31: the evaluator interprets deterministic evidence, it does not replace it.
    expect(systemPrompt).toContain("committedLedger");
    expect(systemPrompt).toContain("do NOT override");
    expect(userPrompt).toContain("Review Gate");
  });
});

describe("issueRefsEqual", () => {
  it("is order-insensitive and length-sensitive", () => {
    expect(issueRefsEqual(["a", "b"], ["b", "a"])).toBe(true);
    expect(issueRefsEqual(["a"], ["a", "b"])).toBe(false);
    expect(issueRefsEqual([], [])).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/gate-evaluation.test.ts`
Expected: FAIL — `Cannot find module './gate-evaluation.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/daemon/src/workflows/orchestrator/gate-evaluation.ts`:

```typescript
import { GateEvaluationProposal, type GateEvaluationRequest } from "@orca/contracts";
import type { ShadowAdapterId } from "../../orchestrator-llm/shadow-session.js";
import type { ShadowAsk } from "./recover-step-scoring.js";

/**
 * Deterministic bound on how many times one gate node may reject and re-route
 * before the run is blocked as non-converging. Paired with the accumulated issue
 * evidence on the block reason (agent-harness.pdf p.31/p.46: termination is
 * verification-governed, and a bare iteration cap needs an objective signal).
 * Sibling of REVISE_CAP.
 */
export const GATE_REJECT_CAP = 3;

export function composeGateEvaluationPrompt(
  request: GateEvaluationRequest
): { systemPrompt: string; userPrompt: string } {
  // p.31: a critique should INTERPRET deterministic sensor outputs, not replace
  // them. The committedLedger carries the deterministic evidence (sensor/verify
  // records, decisions); the evaluator grounds its verdict in it and must not
  // override a verdict already present there — this is also how the automated
  // gate composes with composition's verdict-gated join instead of fighting it.
  const systemPrompt = [
    "You are the gate evaluator (the Verify step) for a workflow. Decide whether the source",
    "step output satisfies the gate, judged against the goal and the gate instructions.",
    "Ground your verdict in the supplied EVIDENCE: the committedLedger records (deterministic",
    "sensor results, verifications, and prior decisions) and the sourceStepOutput. Interpret",
    "that evidence — do NOT override a deterministic sensor/verification verdict already present",
    "in it, and do not invent findings the evidence does not support.",
    "Choose an outcome from availableOutcomes only, and list in inputsConsidered exactly which",
    "evidence you used.",
    "On 'rejected', issueRefs MUST be a short enumerated list of specific, addressable failures",
    "— 'fix only these; do not rewrite what is correct'. On 'approved', issueRefs is [].",
    "Produce exactly one GateEvaluationProposal JSON object in one fenced block, nothing after",
    "the closing fence:",
    "```orca:action",
    '{ "outcome": "...", "reason": "...", "issueRefs": [...], "inputsConsidered": [...] }',
    "```",
  ].join("\n");
  return { systemPrompt, userPrompt: JSON.stringify(request) };
}

/**
 * Order-insensitive equality of two issue lists. Powers the objective
 * non-progress (stagnation) termination signal: if a gate re-rejects with the
 * exact same unresolved issues, the loop is not converging (agent-harness.pdf
 * p.46 — a bare iteration cap lacks an objective quality criterion).
 */
export function issueRefsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export async function evaluateGate(
  deps: ShadowAsk,
  input: {
    goalId: string;
    adapterId: ShadowAdapterId;
    request: GateEvaluationRequest;
    timeoutMs: number;
  }
): Promise<GateEvaluationProposal | null> {
  const { systemPrompt, userPrompt } = composeGateEvaluationPrompt(input.request);
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      ({ text } = await deps.ask(input.goalId, {
        adapterId: input.adapterId,
        systemPrompt,
        userPrompt,
        timeoutMs: input.timeoutMs,
      }));
    } catch {
      continue; // retry once
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      continue;
    }
    const parsed = GateEvaluationProposal.safeParse(raw);
    if (parsed.success) return parsed.data;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/gate-evaluation.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Build + commit**

```bash
pnpm --filter @orca/daemon build
git add apps/daemon/src/workflows/orchestrator/gate-evaluation.ts apps/daemon/src/workflows/orchestrator/gate-evaluation.test.ts
git commit -m "feat(gate): LLM gate evaluator module (ShadowAsk-backed, retry-once)"
```

---

### Task 2: `evaluateAndParkGate` governor — L5 route + issueRefs, L4 unchanged

Add the deterministic governor to `DispatchEngine`: L4/no-evaluator → `parkForGateApproval` (unchanged); L5 → `evaluateGate`, branch on the verdict, record the gate decision **with `issueRefs`**, and route inline (forward on approve, backward to the closing step on reject). Wire the two `parkForGateApproval` call sites through it. Add the optional `shadowAsk?` constructor dep.

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts`
- Test: `apps/daemon/src/workflows/orchestrator/service.gate-routing.test.ts` (extend — reuse its `makeEngine`, graph builders, goal-insert helper)

**Interfaces:**
- Consumes (existing, verified): constructor params `dispatch-engine.ts:238-247`; `goalRequiresHumanReview(db, goalId)` `:106`; `resolveShadowAdapterId(goal): ShadowAdapterId` `:209` (throws when no shadow adapter); `readStepOutputAsRecord(db, runId, stepRunId)`; `latestCommittedLedger(db, runId)`; `resolveGateNext(graph, gateNodeId, outcome)`; `recordGateDecision(db, now, GateDecisionInput)` where `GateDecisionInput` = `{ goalId, workflowRunId, nodeId, traversalSeq, outcome, reason, selectedEdgeTo, inputsConsidered, issueRefs, ledgerVersion }`; `nextTraversalSeq`; `routeGateDestination(db, now, { run, template, goal, sourceStepRunId }, { kind, nodeId }, options)`; `spawnStepAgent`; `parkForGateApproval` `:1594`; `blockRun(db, now, { run, stepRun, stepTpl, goal }, reason, options)` `:2486`; `evaluateGate`, `GATE_REJECT_CAP`, `composeGateEvaluationPrompt` from `./gate-evaluation.js`; `SHADOW_LLM_TIMEOUT_MS`; `GateEvaluationRequest` from `@orca/contracts`; `listGateDecisionsForRun` from `../gates/projection.js` (NEW import).
- Produces: private `evaluateAndParkGate(db, now, ctx, options): Promise<void>`; private `buildGateEvaluationRequest(db, ctx): GateEvaluationRequest`; new optional readonly ctor field `shadowAsk?: ShadowAsk`.

- [ ] **Step 1: Write the failing tests (approve, reject+issueRefs, null-fallback, L4 regression)**

Extend `service.gate-routing.test.ts`. Add imports near the top:

```typescript
import type { ShadowAsk } from "./recover-step-scoring.js";
import { listGateDecisionsForRun } from "../gates/projection.js";
import { latestRejectingGate } from "./repair-context.js";
```

Add a fake-ask factory and an engine factory that injects it (place beside `makeEngine`):

```typescript
function fakeGateAsk(proposal: {
  outcome: "approved" | "rejected";
  reason: string;
  issueRefs?: string[];
  inputsConsidered?: string[];
}): ShadowAsk {
  return {
    async ask() {
      return {
        text: JSON.stringify({
          outcome: proposal.outcome,
          reason: proposal.reason,
          issueRefs: proposal.issueRefs ?? [],
          inputsConsidered: proposal.inputsConsidered ?? ["sourceStepOutput"],
        }),
      };
    },
  };
}

function makeEngineWithAsk(
  broker: Pick<OrchestrationTransportBroker, "propose">,
  shadowAsk: ShadowAsk | undefined,
  launcher: WorkflowSessionLauncher = makeLauncher()
): DispatchEngine {
  return new DispatchEngine(
    broker,
    { async list() { return [agentOperatorDescriptor()]; } },
    launcher,
    fakeStepDispatch(),
    undefined,
    undefined,
    undefined,
    shadowAsk,
  );
}
```

Add a new `describe` block. It reuses the existing suite's `db`, `bus`, goal-insert helper, and the linear `analysis → validation → gate` graph pattern already set up for gate tests (the gate's `approved` edge → terminal step, `rejected` edge → `analysis`). Reuse whatever `seedRunAtGate(...)` / setup the existing gate tests use to drive a run to the parked-at-gate state; the assertions below are the new behavior:

```typescript
describe("OrchestratorService automated gate evaluation (L5)", () => {
  it("approves and routes forward without a human decision", async () => {
    db.prepare("UPDATE goals SET operating_mode = 'automated', orchestrator_provider = 'orca/anthropic' WHERE id = 'goal-1'").run();
    const engine = makeEngineWithAsk(fakeStepBroker(), fakeGateAsk({ outcome: "approved", reason: "Meets the goal." }));
    // drive the run so the validation step completes and the cursor reaches the gate
    await advanceRunToGate(engine); // helper mirroring the existing gate tests' setup

    const decisions = listGateDecisionsForRun(db, "run-1");
    expect(decisions.at(-1)).toMatchObject({ nodeId: "gate", outcome: "approved" });
    const run = getWorkflowRunById(db, "run-1")!;
    expect(run.status).toBe("active"); // routed forward, not parked awaiting a human
    expect(db.prepare("SELECT pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'").get())
      .toMatchObject({ pending_gate_route_json: null });
  });

  it("rejects, records the enumerated issueRefs, and routes back to the closing step", async () => {
    db.prepare("UPDATE goals SET operating_mode = 'automated', orchestrator_provider = 'orca/anthropic' WHERE id = 'goal-1'").run();
    const engine = makeEngineWithAsk(
      fakeStepBroker(),
      fakeGateAsk({ outcome: "rejected", reason: "Missing tests.", issueRefs: ["missing-tests", "no-error-handling"] }),
    );
    await advanceRunToGate(engine);

    const decision = listGateDecisionsForRun(db, "run-1").at(-1)!;
    expect(decision.outcome).toBe("rejected");
    expect(decision.issueRefs).toEqual(["missing-tests", "no-error-handling"]);
    expect(latestRejectingGate(db, "run-1")).toEqual({
      reason: "Missing tests.",
      issueRefs: ["missing-tests", "no-error-handling"],
    });
  });

  it("falls back to a human park when the evaluator returns null", async () => {
    db.prepare("UPDATE goals SET operating_mode = 'automated', orchestrator_provider = 'orca/anthropic' WHERE id = 'goal-1'").run();
    const brokenAsk: ShadowAsk = { async ask() { throw new Error("shadow down"); } };
    const engine = makeEngineWithAsk(fakeStepBroker(), brokenAsk);
    await advanceRunToGate(engine);

    // No automated decision recorded; the run is parked awaiting a human decideGate.
    expect(listGateDecisionsForRun(db, "run-1")).toHaveLength(0);
    const stash = db.prepare("SELECT pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'").get() as { pending_gate_route_json: string | null };
    expect(JSON.parse(stash.pending_gate_route_json!)).toMatchObject({ awaitingHumanDecision: true });
  });

  it("L4 human_review still parks for a human decideGate (no auto-eval)", async () => {
    // operating_mode left at default (human_review); shadowAsk present but must NOT be consulted.
    const asked = { n: 0 };
    const spyAsk: ShadowAsk = { async ask() { asked.n += 1; return { text: "{}" }; } };
    const engine = makeEngineWithAsk(fakeStepBroker(), spyAsk);
    await advanceRunToGate(engine);

    expect(asked.n).toBe(0);
    expect(listGateDecisionsForRun(db, "run-1")).toHaveLength(0);
    const stash = db.prepare("SELECT pending_gate_route_json FROM workflow_runs WHERE id = 'run-1'").get() as { pending_gate_route_json: string | null };
    expect(JSON.parse(stash.pending_gate_route_json!)).toMatchObject({ awaitingHumanDecision: true });
  });
});
```

> Implementation note for the worker: the existing gate suite already drives a run to the gate (see the `it("parks at the gate awaiting a human decision", ...)` case). Factor its setup into a local `advanceRunToGate(engine)` helper (or inline the same steps) so all four tests share it. `orchestrator_provider = 'orca/anthropic'` maps to the `claude-code` shadow adapter via `resolveShadowAdapterId`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/service.gate-routing.test.ts -t "automated gate evaluation"`
Expected: FAIL — `DispatchEngine` constructor takes 7 args (8th `shadowAsk` unknown) / no auto-eval, run parks so `outcome: "approved"` assertion fails.

- [ ] **Step 3: Add the constructor dep + imports**

In `dispatch-engine.ts`, add the import near the other gate imports (`:45`):

```typescript
import { listGateDecisionsForRun } from "../gates/projection.js";
import { SHADOW_LLM_TIMEOUT_MS } from "../../orchestrator-llm/shadow-llm-client.js";
import type { ShadowAsk } from "./recover-step-scoring.js";
import { evaluateGate, issueRefsEqual, GATE_REJECT_CAP } from "./gate-evaluation.js";
import { GateEvaluationRequest } from "@orca/contracts";
```

Add the optional field to the constructor (after `otlpAccumulator`, `:246`):

```typescript
    private readonly otlpAccumulator: TokenAccumulator = NULL_ACCUMULATOR,
    private readonly shadowAsk?: ShadowAsk,
  ) {}
```

- [ ] **Step 4: Add `buildGateEvaluationRequest` and `evaluateAndParkGate`**

Add both private methods (place beside `buildSplitEvaluationRequest` / `evaluateAndParkSplitter`, ~`:1700`):

```typescript
  private buildGateEvaluationRequest(
    db: Database.Database,
    ctx: { run: WorkflowRunT; stepRun: StepRunRow; goal: GoalRow; gateNode: WorkflowGraphNode }
  ): GateEvaluationRequest {
    const { run, stepRun, goal, gateNode } = ctx;
    const graph = effectiveGraph(loadRunTemplate(db, run)!.graph, loadRunTemplate(db, run)!.steps);
    const availableOutcomes = (["approved", "rejected"] as const).filter((o) =>
      graph.edges.some((e) => e.from === gateNode.id && e.port === o)
    );
    const priorGateDecisions = listGateDecisionsForRun(db, run.id)
      .map((d) => ({ nodeId: d.nodeId, outcome: d.outcome, reason: d.reason.slice(0, 1024) }))
      .slice(-50);
    const committedLedger = latestCommittedLedger(db, run.id)
      .records.slice(-35)
      .map((r) => ({
        id: r.id.slice(0, 128),
        recordType: r.recordType.slice(0, 64),
        status: r.status.slice(0, 64),
        note: r.note.slice(0, 500),
      }));
    return GateEvaluationRequest.parse({
      gate: { nodeId: gateNode.id, name: gateNode.name, instructions: gateNode.instructions ?? "" },
      goal: { id: goal.id, description: goal.description },
      sourceStepOutput: readStepOutputAsRecord(db, run.id, stepRun.id),
      priorGateDecisions,
      availableOutcomes,
      committedLedger,
    });
  }

  /**
   * Gate = the PEV Verify phase. In human_review (L4) — or when no shadow
   * evaluator is available — parks for a human decideGate (unchanged). In
   * automated (L5), the LLM fills the verdict + issue list; the deterministic
   * core branches, bounds the reject loop (GATE_REJECT_CAP), records the decision
   * with issueRefs (which flow to the closing step via latestRejectingGate ->
   * repairContext), and routes inline (forward on approve, backward on reject).
   */
  private async evaluateAndParkGate(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      template: WorkflowTemplateT;
      goal: GoalRow;
      gateNodeId: string;
    },
    options: RequestNextDecisionOptions
  ): Promise<void> {
    const { run, stepRun, stepTpl, template, goal, gateNodeId } = ctx;
    const graph = effectiveGraph(template.graph, template.steps);
    const gateNode = graph.nodes.find((n) => n.id === gateNodeId && n.type === "gate");
    if (!gateNode) {
      this.blockRun(db, now, { run, stepRun, stepTpl, goal }, `gate node not found in graph: ${gateNodeId}`, options);
      return;
    }

    // L4, or no evaluator wired: keep the human-authoritative park (unchanged).
    let adapterId: ShadowAdapterId | null = null;
    if (this.shadowAsk && !goalRequiresHumanReview(db, goal.id)) {
      try {
        adapterId = resolveShadowAdapterId(goal);
      } catch {
        adapterId = null;
      }
    }
    if (!this.shadowAsk || goalRequiresHumanReview(db, goal.id) || !adapterId) {
      this.parkForGateApproval(db, now, { run, stepRun, stepTpl, template, goal, gateNodeId }, options);
      return;
    }

    const proposal = await evaluateGate(this.shadowAsk, {
      goalId: goal.id,
      adapterId,
      request: this.buildGateEvaluationRequest(db, { run, stepRun, goal, gateNode }),
      timeoutMs: SHADOW_LLM_TIMEOUT_MS,
    });
    if (!proposal) {
      // Escalate to a human — the same safety terminus as the broker's human_review.
      this.parkForGateApproval(db, now, { run, stepRun, stepTpl, template, goal, gateNodeId }, options);
      return;
    }

    // Honest, verification-governed termination (agent-harness.pdf p.31/p.46):
    // stop on an OBJECTIVE non-progress signal — the same unresolved issues recur
    // (stagnation) — or at the hard GATE_REJECT_CAP ceiling; never on model
    // confidence. The block reason carries the enumerated issue evidence.
    if (proposal.outcome === "rejected") {
      const priorRejects = listGateDecisionsForRun(db, run.id).filter(
        (d) => d.nodeId === gateNode.id && d.outcome === "rejected"
      );
      const issues = proposal.issueRefs ?? [];
      const stagnated =
        issues.length > 0 &&
        priorRejects.length > 0 &&
        issueRefsEqual(issues, priorRejects[priorRejects.length - 1]!.issueRefs);
      if (priorRejects.length + 1 >= GATE_REJECT_CAP || stagnated) {
        const detail = issues.join(", ");
        const why = stagnated ? "unresolved issues recurred" : `${priorRejects.length + 1} rejections`;
        this.blockRun(
          db,
          now,
          { run, stepRun, stepTpl, goal },
          `gate "${gateNode.name}" not converging (${why}): ${proposal.reason}${detail ? ` [${detail}]` : ""}`,
          options
        );
        return;
      }
    }

    let dest: Destination;
    try {
      dest = resolveGateNext(graph, gateNode.id, proposal.outcome);
    } catch (e) {
      this.blockRun(db, now, { run, stepRun, stepTpl, goal }, `gate ${gateNode.id} routing failed: ${(e as Error).message}`, options);
      return;
    }
    if (dest.kind !== "step" && dest.kind !== "gate" && dest.kind !== "splitter") {
      this.blockRun(db, now, { run, stepRun, stepTpl, goal }, `gate ${gateNode.id} resolved to an unroutable destination`, options);
      return;
    }

    const ledger = latestCommittedLedger(db, run.id);
    const seq = nextTraversalSeq(db, run.id);
    recordGateDecision(db, now, {
      goalId: goal.id,
      workflowRunId: run.id,
      nodeId: gateNode.id,
      traversalSeq: seq,
      outcome: proposal.outcome,
      reason: proposal.reason,
      selectedEdgeTo: dest.nodeId,
      inputsConsidered: proposal.inputsConsidered,
      issueRefs: proposal.issueRefs ?? [],
      ledgerVersion: ledger.version,
    });

    // Route inline (automated => no Continue). Mirrors evaluateAndParkSplitter's
    // unsupervised tail: route the cursor, then spawn the destination step (a
    // gate/splitter destination re-parks inside routeGateDestination and no-ops here).
    await this.routeGateDestination(
      db,
      now,
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

> Note: `parkForGateApproval`'s ctx type includes `template`; confirm the field list matches its signature at `:1594-1607` (it destructures `{ run, stepRun, stepTpl, template, goal, gateNodeId }`). Pass exactly those.

- [ ] **Step 5: Wire the two call sites**

At `dispatch-engine.ts:1023` replace the direct call:

```typescript
      if (result.kind === "gate") {
        await this.evaluateAndParkGate(
          db,
          now,
          { run, stepRun, stepTpl, template, goal, gateNodeId: result.nodeId },
          options
        );
        const after = getWorkflowRunById(db, run.id);
        if (!after || after.status !== "active" || !after.currentStepRunId) {
          return this.commitNoopLatestDecision(db, run.id, stepRun.id);
        }
      }
```

At `routeGateDestination`'s gate re-park (`:2219`) replace `this.parkForGateApproval(...)` with:

```typescript
      await this.evaluateAndParkGate(
        db,
        now,
        { run, stepRun, stepTpl, template, goal, gateNodeId: dest.nodeId },
        options
      );
      return;
```

(`routeGateDestination` becomes `async`-safe — it is already `async`; the `this.parkForGateApproval` call it replaces was in the `dest.kind === "gate"` branch. Keep the surrounding block-on-missing-`stepTpl` guard.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/service.gate-routing.test.ts`
Expected: PASS — the four new cases plus all pre-existing gate tests (L4 regression guard).

- [ ] **Step 7: Build + commit**

```bash
pnpm --filter @orca/daemon build
git add apps/daemon/src/workflows/orchestrator/dispatch-engine.ts apps/daemon/src/workflows/orchestrator/service.gate-routing.test.ts
git commit -m "feat(gate): automated L5 gate evaluator wiring + issueRefs repair channel; L4 unchanged"
```

---

### Task 3: Honest termination — objective non-progress + reject-cap ceiling

Pin the two termination signals from Task 2: (a) **stagnation** — the same unresolved `issueRefs` recur across rejections (the objective "not improving" signal the paper asks for, p.46) — blocks even before the cap; (b) the hard **`GATE_REJECT_CAP`** ceiling. In both cases the run is **blocked** carrying the accumulated issue evidence instead of re-routing. The implementation already landed in Task 2 — these are the dedicated failing tests that pin the behavior.

**Files:**
- Test: `apps/daemon/src/workflows/orchestrator/service.gate-routing.test.ts` (extend)

**Interfaces:**
- Consumes: `recordGateDecision`, `nextTraversalSeq` (`../gates/usecases.js`) to pre-seed prior rejects; `GATE_REJECT_CAP` (`./gate-evaluation.js`); `getWorkflowRunById`.

- [ ] **Step 1: Write the failing test**

```typescript
import { recordGateDecision, nextTraversalSeq } from "../gates/usecases.js";
import { GATE_REJECT_CAP } from "./gate-evaluation.js";

it("blocks the run after GATE_REJECT_CAP rejections (honest termination)", async () => {
  db.prepare("UPDATE goals SET operating_mode = 'automated', orchestrator_provider = 'orca/anthropic' WHERE id = 'goal-1'").run();
  // Pre-seed GATE_REJECT_CAP - 1 prior rejections on this gate so the next reject trips the cap.
  for (let i = 0; i < GATE_REJECT_CAP - 1; i++) {
    recordGateDecision(db, () => NOW, {
      goalId: "goal-1", workflowRunId: "run-1", nodeId: "gate",
      traversalSeq: nextTraversalSeq(db, "run-1"), outcome: "rejected",
      reason: `prior reject ${i}`, selectedEdgeTo: "analysis",
      inputsConsidered: [], issueRefs: [`old-${i}`], ledgerVersion: 0,
    });
  }
  const engine = makeEngineWithAsk(
    fakeStepBroker(),
    fakeGateAsk({ outcome: "rejected", reason: "Still failing.", issueRefs: ["missing-tests"] }),
  );
  await advanceRunToGate(engine);

  const run = getWorkflowRunById(db, "run-1")!;
  expect(run.status).toBe("blocked");
  // The last recorded gate decision is still the pre-seeded set — the tripping reject does NOT re-route.
  const rejects = listGateDecisionsForRun(db, "run-1").filter((d) => d.outcome === "rejected");
  expect(rejects).toHaveLength(GATE_REJECT_CAP - 1);
});

it("blocks early on stagnation (identical unresolved issues recur) before the cap", async () => {
  db.prepare("UPDATE goals SET operating_mode = 'automated', orchestrator_provider = 'orca/anthropic' WHERE id = 'goal-1'").run();
  // ONE prior rejection (well under GATE_REJECT_CAP=3) with the SAME issue set the evaluator repeats.
  recordGateDecision(db, () => NOW, {
    goalId: "goal-1", workflowRunId: "run-1", nodeId: "gate",
    traversalSeq: nextTraversalSeq(db, "run-1"), outcome: "rejected",
    reason: "first pass", selectedEdgeTo: "analysis",
    inputsConsidered: [], issueRefs: ["missing-tests"], ledgerVersion: 0,
  });
  const engine = makeEngineWithAsk(
    fakeStepBroker(),
    fakeGateAsk({ outcome: "rejected", reason: "Same problem.", issueRefs: ["missing-tests"] }),
  );
  await advanceRunToGate(engine);

  // Stagnation (same unresolved issue) trips the block even though the cap is not reached.
  expect(getWorkflowRunById(db, "run-1")!.status).toBe("blocked");
  expect(listGateDecisionsForRun(db, "run-1").filter((d) => d.outcome === "rejected")).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail, then pass**

Run: `pnpm --filter @orca/daemon exec vitest run src/workflows/orchestrator/service.gate-routing.test.ts -t "converging|stagnation|GATE_REJECT_CAP"`
Expected: both PASS if Task 2's termination block is correct. If either FAILS (run still `active`, an extra reject recorded), fix the `priorRejects + 1 >= GATE_REJECT_CAP || stagnated` guard in `evaluateAndParkGate` until green. (Write-the-test-first holds: both fail against a no-termination implementation.)

- [ ] **Step 3: Commit**

```bash
pnpm --filter @orca/daemon build
git add apps/daemon/src/workflows/orchestrator/service.gate-routing.test.ts
git commit -m "test(gate): objective non-progress (stagnation) + GATE_REJECT_CAP terminate a non-converging gate"
```

---

### Task 4: Production wiring + docs

Pass the shadow-backed `ShadowAsk` into the production `DispatchEngine` so L5 gates go live, and update the orientation docs.

**Files:**
- Modify: `apps/daemon/src/server.ts` (the `new DispatchEngine(...)` construction; reuse the `ShadowSessionManager` already built ~`:725`)
- Modify: `ORCA.md` (gate section), `FUTURE_WORK.md` (mark 5.3 landed)

**Interfaces:**
- Consumes: the existing `ShadowSessionManager` instance in `server.ts` (its `ask(goalId, input)` satisfies `ShadowAsk`). Find the `new DispatchEngine(` call and add the 8th argument.

- [ ] **Step 1: Locate the production DispatchEngine construction**

Run: `grep -n "new DispatchEngine(" apps/daemon/src/server.ts`
Read the surrounding block and the `ShadowSessionManager` variable name (the one wired into `ShadowSessionLlmClient` ~`:725`, e.g. `shadowSessions`).

- [ ] **Step 2: Pass `shadowAsk` as the 8th constructor argument**

Add `{ ask: (goalId, input) => shadowSessions.ask(goalId, input) }` (or pass `shadowSessions` directly if it structurally satisfies `ShadowAsk`) as the final argument to `new DispatchEngine(...)`. Match the existing argument formatting.

- [ ] **Step 3: Build to typecheck the wiring**

Run: `pnpm --filter @orca/daemon build`
Expected: PASS (no type error — `ShadowSessionManager.ask` conforms to `ShadowAsk`).

- [ ] **Step 4: Update ORCA.md gate section**

In the gate/workflow section, note: gates are the PEV Verify phase — resolved by a human in `human_review` (L4) and by the LLM gate evaluator in `automated` (L5); the deterministic core owns routing + the `GATE_REJECT_CAP` termination bound; the LLM only fills the verdict + `issueRefs` (which route to the closing step via `latestRejectingGate → repairContext`).

- [ ] **Step 5: Update FUTURE_WORK.md item 5.3**

Change the 5.3 bullet's status marker to landed and append a one-line resume note (mirroring how 5.2/5B note their landing): the automated gate evaluator is wired via the `ShadowAsk` seam; L4 human path unchanged; issue-list channel lit on the gate path; `revise_step.feedback` enumeration + human-issue enumeration deferred to 5.4.

- [ ] **Step 6: Full daemon test sweep + commit**

```bash
pnpm --filter @orca/daemon exec vitest run src/workflows
pnpm --filter @orca/daemon build
git add apps/daemon/src/server.ts ORCA.md FUTURE_WORK.md
git commit -m "feat(gate): wire production shadow gate evaluator + docs (5.3 landed)"
```

---

## Doc Alignment (agent-harness.pdf + FUTURE_ARCHITECTURE.md)

Every design choice traces to a principle in the orientation docs:

- **Gate = PEV Verify phase; deterministic core as cybernetic governor** (paper p.28–31; FUTURE_ARCHITECTURE line 95 "deterministic code owns lifecycle, routing, gates"). `evaluateAndParkGate` owns the L4/L5 branch, routing, termination; the LLM only fills `GateEvaluationProposal`. It never advances the flow.
- **Interpret sensor outputs, don't replace them** (paper p.31). The prompt (Task 1) grounds the verdict in the `committedLedger` deterministic evidence + `sourceStepOutput` and forbids overriding a verdict already present. This is *also* the concrete mechanism by which the automated gate **composes with composition's verdict-gated join instead of fighting it**: a failed child verdict / I4 sensor veto blocks the parent upstream of any gate, and where a gate does run its evidence includes those deterministic records.
- **Termination governed by verification, not model confidence — with an objective criterion** (paper p.31; and p.46, which names bare fixed-iteration caps as "the most significant gap in the field"). Task 2/3 stop on **stagnation** (identical unresolved `issueRefs` recur — objective non-progress) *or* the hard `GATE_REJECT_CAP` ceiling, and the block reason carries the enumerated issue evidence. Termination is never an LLM "unachievable" self-report.
- **Bounded continue/revise/stop feedback via an enumerated issue list** (paper p.28). `issueRefs` = "fix only these; don't rewrite what's correct", routed to the closing step via the already-plumbed `latestRejectingGate → repairContext`.
- **Independent verification / anti-circularity** (paper p.37 — AgentCoder's independent Test Designer; the mode-collapse principle). 5.3 keeps the gate verdict **evidence-grounded** (judged against goal/instructions/ledger, not a self-review of the evaluator's own generation) and deliberately does **not** collapse the gate into the producer. The dedicated independent/adversarial *refute* pass is **5.4** — this plan preserves that seam (the gate stays deterministic-authoritative; a refute can later *inform* it) rather than pre-empting it.
- **Control/execution-plane split + RunnerPort** (FUTURE_ARCHITECTURE §2). The gate *decision* is control-plane; the LLM *call* rides the runner-agnostic `ShadowAsk` seam (execution-plane), injected as an optional dep exactly as `synthesize.ts`/`recover-step-scoring.ts` already do — not a control-plane hard-coupling to `ShadowSessionManager`. **Forward consolidation:** `RunnerPort` is the designated execution-plane surface and its own doc says it "grows to absorb" capabilities; absorbing `ShadowAsk` into `RunnerPort` is the natural follow-up, tracked but out of this surgical scope.
- **Cost spine — "selective AI, invoked only where judgment is needed"** (FUTURE_ARCHITECTURE line 95). A gate is inherently a judgment point, so the L5 call is warranted. A deterministic short-circuit (a gate whose outcome is already machine-decided, e.g. a `branchKey`-style verdict field like the splitter's `resolveDeterministicSplit`) is the future cost optimization; no producer emits such a field today, so adding it now would be dead code (YAGNI) — the design leaves room for it without pre-building it.

## Self-Review

**Spec coverage:**
- L5 automated eval driving the gate → Task 2 (`evaluateAndParkGate`, approve/reject routing).
- Derive criteria from goal + ledger + instructions → Task 2 (`buildGateEvaluationRequest`).
- Branch on verdict + route failing criterion back via backward-edge routing → Task 2 (`resolveGateNext` + `routeGateDestination`, `rejected` edge → closing step).
- Terminate honestly when unachievable → Tasks 2+3 (stagnation on recurring `issueRefs` **or** `GATE_REJECT_CAP` → `blockRun` with issue evidence; objective criterion per paper p.46).
- L4 human verdict unchanged → Task 2 (L4 branch → `parkForGateApproval`; regression guard test).
- Reuse broker/eval plumbing, mirror `evaluateAndParkSplitter` → Task 2 (same shape; runner-agnostic `ShadowAsk` seam per FUTURE_ARCHITECTURE, the live variant of the dormant broker path).
- `{reason, issueRefs}` enumerated issue list routed to the failing step → Task 2 (`recordGateDecision` with `issueRefs`; verified via `latestRejectingGate`).
- Evaluator interprets, does not replace, deterministic evidence (paper p.31) → Task 1 prompt (grounds in `committedLedger` + `sourceStepOutput`; verified by prompt-content assertions).
- Independent-verification seam preserved for 5.4 (paper p.37) → Doc Alignment note (evidence-grounded, non-circular; refute pass deferred to 5.4).
- Composition compose-not-fight → prompt evidence-grounding (interpret, don't override the join's deterministic verdict) + no `join.ts` change; automated gate only governs step→gate; documented out-of-scope.

**Placeholder scan:** none — all steps carry concrete code/commands. The one setup helper `advanceRunToGate(engine)` is explicitly derived from the existing gate suite's parked-at-gate setup (Task 2 Step 1 note).

**Type consistency:** `ShadowAsk` (single source: `recover-step-scoring.ts`), `GateEvaluationRequest`/`GateEvaluationProposal` (contracts), `GateDecisionInput` fields, and `resolveGateNext(graph, id, outcome)` signatures are used identically across Tasks 1–3. Constructor arg count (8, `shadowAsk` last) is consistent between the impl (Task 2 Step 3) and both test engine factories.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-03-gate-evaluator-l4-l5-seam.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
