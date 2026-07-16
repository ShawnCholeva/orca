# Gate Evidence Bundle & "Working on…" Bubble Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every workflow gate a visible "Working on <gate>…" reviewing phase and replace the gate approval card's prose blob with a structured evidence bundle (recommendation · summary · residual risks with severity · evidence reviewed), and guarantee no human ever decides a gate blind.

**Architecture:** Additive contract fields (`residualRisks`, `inputsConsidered`, `reason`) flow from the reviewer output (`GateEvaluationProposal`, worker + shadow) → the run's `pending_gate_route_json` stash → the projected `PendingGateReview` → the desktop gate card. The desktop "Working on <gate>…" bubble is derived purely from existing run state (`currentNodeKind === "gate"` + `pendingGateReview == null` + `!hasLiveActivity`) with a single-tail-bubble invariant. The daemon's shadow-gate branch is restructured so a supervised gate runs its reviewer first and parks *with* a recommendation instead of blind.

**Tech Stack:** TypeScript, Zod (`@orca/contracts`), better-sqlite3 (daemon), React + Vitest + Testing Library (desktop), Playwright MCP (browser verify).

## Global Constraints

- Reviewer output contract is `GateEvaluationProposal` (shared by worker and shadow substrates) — `packages/contracts/src/workflows/index.ts:890`.
- New `residualRisks` element shape: `{ risk: string (1..512); severity: "low" | "medium" | "high" }`.
- `residualRisks` and `inputsConsidered` on `PendingGateReview` default to `[]` so pre-existing/parsed data stays valid.
- Severity scale is exactly `low | medium | high` (no `critical`).
- "Evidence reviewed" disclosure defaults **collapsed**.
- Single-bubble invariant: at most one tail "thinking" indicator at any time.
- No blind parks: the only surviving `parkForGateApproval` without a recommendation is the reviewer-unavailable safety terminus.
- Do not touch unrelated code; match existing style (see CLAUDE.md §3).
- Per-package tests run via Vitest, e.g. `pnpm --filter @orca/contracts test`, `pnpm --filter @orca/daemon test`, `pnpm --filter @orca/desktop test`. Typecheck all: `pnpm typecheck`.
- Contract type re-exports resolve from `@orca/contracts` (barrel wildcard export of `./workflows/index.js`).

---

## Task 1: Contracts — add `residualRisks` to the proposal and the projected review

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts` (add `GateResidualRisk` ~line 431; extend `PendingGateReview` 434-441; extend `GateEvaluationProposal` 890-898)
- Test: `packages/contracts/src/__tests__/workflow-contracts.test.ts`

**Interfaces:**
- Produces:
  - `GateResidualRisk = { risk: string; severity: "low" | "medium" | "high" }`
  - `GateEvaluationProposal` gains `residualRisks: GateResidualRisk[]` (default `[]`)
  - `PendingGateReview` gains `reason: string | null`, `residualRisks: GateResidualRisk[]` (default `[]`), `inputsConsidered: string[]` (default `[]`)

- [ ] **Step 1: Write the failing test**

Add to `packages/contracts/src/__tests__/workflow-contracts.test.ts` — first add `GateEvaluationProposal`, `PendingGateReview`, `GateResidualRisk` to the existing top-of-file contracts import (same source as `CreateGoalRequest`), then append:

```ts
describe("GateEvaluationProposal residualRisks", () => {
  it("accepts structured residual risks with severity", () => {
    const parsed = GateEvaluationProposal.parse({
      reasoning: "ok",
      outcome: "approved",
      reason: "meets bar",
      inputsConsidered: ["sourceStepOutput"],
      residualRisks: [{ risk: "SQLite cross-thread access", severity: "medium" }],
    });
    expect(parsed.residualRisks).toEqual([
      { risk: "SQLite cross-thread access", severity: "medium" },
    ]);
  });

  it("defaults residualRisks to [] when omitted", () => {
    const parsed = GateEvaluationProposal.parse({
      reasoning: "ok",
      outcome: "approved",
      reason: "meets bar",
      inputsConsidered: [],
    });
    expect(parsed.residualRisks).toEqual([]);
  });

  it("rejects an unknown severity", () => {
    const r = GateEvaluationProposal.safeParse({
      reasoning: "ok",
      outcome: "approved",
      reason: "meets bar",
      inputsConsidered: [],
      residualRisks: [{ risk: "x", severity: "critical" }],
    });
    expect(r.success).toBe(false);
  });
});

describe("PendingGateReview evidence bundle", () => {
  it("carries reason, residualRisks and inputsConsidered", () => {
    const parsed = PendingGateReview.parse({
      gateNodeId: "critique",
      recommendedOutcome: "approved",
      reasoning: "long summary",
      reason: "one-liner",
      residualRisks: [{ risk: "rate limits", severity: "low" }],
      inputsConsidered: ["sourceStepOutput", "committedLedger"],
      issueRefs: [],
    });
    expect(parsed.reason).toBe("one-liner");
    expect(parsed.residualRisks[0]?.severity).toBe("low");
    expect(parsed.inputsConsidered).toHaveLength(2);
  });

  it("defaults residualRisks and inputsConsidered to []", () => {
    const parsed = PendingGateReview.parse({
      gateNodeId: "critique",
      recommendedOutcome: "rejected",
      reasoning: null,
      reason: null,
      issueRefs: ["fix X"],
    });
    expect(parsed.residualRisks).toEqual([]);
    expect(parsed.inputsConsidered).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/contracts test -- workflow-contracts`
Expected: FAIL — `residualRisks`/`reason`/`inputsConsidered` unknown keys rejected by `.strict()`.

- [ ] **Step 3: Add `GateResidualRisk` and extend `PendingGateReview`**

In `packages/contracts/src/workflows/index.ts`, immediately before `PendingGateReview` (line 432), add:

```ts
export const GateResidualRisk = z
  .object({
    risk: z.string().min(1).max(512),
    severity: z.enum(["low", "medium", "high"]),
  })
  .strict();
export type GateResidualRisk = z.infer<typeof GateResidualRisk>;
```

Then replace the `PendingGateReview` object (lines 434-441) with:

```ts
export const PendingGateReview = z
  .object({
    gateNodeId: Id100,
    recommendedOutcome: z.enum(["approved", "rejected"]),
    reasoning: z.string().max(8000).nullable(),
    reason: z.string().max(1024).nullable(),
    residualRisks: z.array(GateResidualRisk).max(50).default([]),
    inputsConsidered: z.array(z.string().max(512)).max(50).default([]),
    issueRefs: z.array(z.string().max(500)).max(50),
  })
  .strict();
```

- [ ] **Step 4: Extend `GateEvaluationProposal`**

In the same file, replace the `GateEvaluationProposal` object (lines 890-898) with:

```ts
export const GateEvaluationProposal = z
  .object({
    reasoning: z.string().min(1).max(REASONING_MAX),
    outcome: z.enum(["approved", "rejected"]),
    reason: z.string().min(1).max(1024),
    residualRisks: z.array(GateResidualRisk).max(50).default([]),
    issueRefs: z.array(z.string().min(1).max(128)).max(50).optional(),
    inputsConsidered: z.array(z.string().min(1).max(512)).max(50),
  })
  .strict();
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orca/contracts test -- workflow-contracts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @orca/contracts typecheck`
Expected: no errors.

```bash
git add packages/contracts/src/workflows/index.ts packages/contracts/src/__tests__/workflow-contracts.test.ts
git commit -m "feat(contracts): structured residual risks + evidence on gate review"
```

---

## Task 2: Daemon — carry the structured fields through park, complete, and projection

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts` (`parkForGateApproval` param 1666 + stash 1689-1696; `completeGateWorker` supervised branch 2526-2531)
- Modify: `apps/daemon/src/workflows/runs/projection.ts` (parsed stash type 78-84; projection 86-91; export `rowToRun`)
- Test: `apps/daemon/src/workflows/runs/projection.test.ts` (create)

**Interfaces:**
- Consumes: `GateResidualRisk` (Task 1).
- Produces:
  - `parkForGateApproval`'s `recommendation` param gains `residualRisks: GateResidualRisk[]` and `inputsConsidered: string[]`.
  - `rowToRun(row)` exported from `projection.ts` — projects a run row (incl. new gate-review fields) to `WorkflowRunT`.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/workflows/runs/projection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rowToRun } from "./projection.js";

const baseRow = {
  id: "r1",
  goal_id: "g1",
  template_id: "orca/adaptive-delivery",
  template_version: 1,
  status: "active",
  current_step_run_id: null,
  started_at: "2026-07-16T00:00:00.000Z",
  finished_at: null,
  blocked_reason: null,
  current_node_id: "critique",
  current_node_kind: "gate",
  traversal_seq: 3,
  pending_split_route_json: null,
  pending_gate_route_json: null,
};

describe("rowToRun gate review projection", () => {
  it("surfaces residualRisks, reason and inputsConsidered from the stash", () => {
    const run = rowToRun({
      ...baseRow,
      pending_gate_route_json: JSON.stringify({
        awaitingHumanDecision: true,
        gateNodeId: "critique",
        recommendedOutcome: "approved",
        reasoning: "long summary",
        reason: "one-liner",
        issueRefs: [],
        residualRisks: [{ risk: "rate limits", severity: "low" }],
        inputsConsidered: ["sourceStepOutput"],
      }),
    });
    expect(run.pendingGateReview).toEqual({
      gateNodeId: "critique",
      recommendedOutcome: "approved",
      reasoning: "long summary",
      reason: "one-liner",
      issueRefs: [],
      residualRisks: [{ risk: "rate limits", severity: "low" }],
      inputsConsidered: ["sourceStepOutput"],
    });
  });

  it("defaults residualRisks/inputsConsidered and null reason for a legacy stash", () => {
    const run = rowToRun({
      ...baseRow,
      pending_gate_route_json: JSON.stringify({
        awaitingHumanDecision: true,
        gateNodeId: "critique",
        recommendedOutcome: "rejected",
        reasoning: "old",
        issueRefs: ["fix X"],
      }),
    });
    expect(run.pendingGateReview?.residualRisks).toEqual([]);
    expect(run.pendingGateReview?.inputsConsidered).toEqual([]);
    expect(run.pendingGateReview?.reason).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- projection`
Expected: FAIL — `rowToRun` is not exported / new fields absent.

- [ ] **Step 3: Export `rowToRun` and project the new fields**

In `apps/daemon/src/workflows/runs/projection.ts`, change `function rowToRun(` (line 50) to `export function rowToRun(`.

Replace the parsed-stash type and projection block (lines 78-91) with:

```ts
      const g = JSON.parse(row.pending_gate_route_json) as {
        awaitingHumanDecision?: boolean;
        gateNodeId?: string;
        recommendedOutcome?: "approved" | "rejected";
        reasoning?: string | null;
        reason?: string | null;
        issueRefs?: string[];
        residualRisks?: { risk: string; severity: "low" | "medium" | "high" }[];
        inputsConsidered?: string[];
      };
      if (g.awaitingHumanDecision && g.gateNodeId && (g.recommendedOutcome === "approved" || g.recommendedOutcome === "rejected")) {
        pendingGateReview = {
          gateNodeId: g.gateNodeId,
          recommendedOutcome: g.recommendedOutcome,
          reasoning: g.reasoning ?? null,
          reason: g.reason ?? null,
          issueRefs: Array.isArray(g.issueRefs) ? g.issueRefs : [],
          residualRisks: Array.isArray(g.residualRisks) ? g.residualRisks : [],
          inputsConsidered: Array.isArray(g.inputsConsidered) ? g.inputsConsidered : [],
        };
      }
```

(`WorkflowRun.parse` at the return already validates the projected object against the extended `PendingGateReview`, which supplies the `[]` defaults if a key is somehow absent.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- projection`
Expected: PASS.

- [ ] **Step 5: Extend the write side — `parkForGateApproval` and `completeGateWorker`**

In `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts`, change the `recommendation` param type (line 1666) to:

```ts
    recommendation?: { recommendedOutcome: "approved" | "rejected"; reasoning: string | null; issueRefs: string[]; reason: string; residualRisks: GateResidualRisk[]; inputsConsidered: string[] }
```

Add `GateResidualRisk` to the existing `@orca/contracts` import at the top of the file (alongside `GateEvaluationProposal`/`GateEvaluationRequest`).

In the stash spread (lines 1690-1695), add the two fields:

```ts
          ? {
                recommendedOutcome: recommendation.recommendedOutcome,
                reasoning: recommendation.reasoning,
                issueRefs: recommendation.issueRefs,
                reason: recommendation.reason,
                residualRisks: recommendation.residualRisks,
                inputsConsidered: recommendation.inputsConsidered,
              }
```

In `completeGateWorker`'s supervised branch (lines 2526-2531), extend the recommendation object:

```ts
        {
          recommendedOutcome: proposal.outcome,
          reasoning: proposal.reasoning ?? null,
          issueRefs: proposal.issueRefs ?? [],
          reason: proposal.reason,
          residualRisks: proposal.residualRisks,
          inputsConsidered: proposal.inputsConsidered,
        }
```

- [ ] **Step 6: Typecheck, run daemon tests, commit**

Run: `pnpm --filter @orca/daemon typecheck && pnpm --filter @orca/daemon test -- projection`
Expected: no type errors; projection tests PASS.

```bash
git add apps/daemon/src/workflows/runs/projection.ts apps/daemon/src/workflows/runs/projection.test.ts apps/daemon/src/workflows/orchestrator/dispatch-engine.ts
git commit -m "feat(daemon): carry residual risks + evidence through gate park and projection"
```

---

## Task 3: Daemon — reviewer prompts emit residual risks, and no shadow gate parks blind

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/gate-worker.ts` (prompt 9-10, 26)
- Modify: `apps/daemon/src/workflows/orchestrator/gate-evaluation.ts` (prompt 31-37)
- Modify: `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts` (`evaluateAndParkGate` shadow branch 2138-2181)
- Test: `apps/daemon/src/workflows/orchestrator/gate-evaluation.test.ts` (extend)

**Interfaces:**
- Consumes: `GateEvaluationProposal.residualRisks`, `PendingGateReview` (Tasks 1-2).
- Produces: a supervised shadow gate parks *with* a `PendingGateReview` recommendation whenever a shadow adapter is available.

- [ ] **Step 1: Write the failing test**

Open `apps/daemon/src/workflows/orchestrator/gate-evaluation.test.ts`, read its existing setup, and add a test that asserts the composed prompts require `residualRisks`. Append (mirroring the file's import of `composeGateEvaluationPrompt`):

```ts
import { composeGateWorkerPrompt } from "./gate-worker.js";

const REQ = {
  gate: { nodeId: "critique", name: "Critique", instructions: "Judge the design." },
  goal: { id: "g1", intent: "ship it" },
  sourceStepOutput: { plan: "..." },
  priorGateDecisions: [],
  availableOutcomes: ["approved", "rejected"] as ("approved" | "rejected")[],
  committedLedger: [],
};

describe("reviewer prompts request residual risks", () => {
  it("worker prompt asks for residualRisks with severity", () => {
    const p = composeGateWorkerPrompt(REQ);
    expect(p).toContain("residualRisks");
    expect(p).toMatch(/severity/i);
  });

  it("shadow prompt asks for residualRisks with severity", () => {
    const { systemPrompt } = composeGateEvaluationPrompt(REQ);
    expect(systemPrompt).toContain("residualRisks");
    expect(systemPrompt).toMatch(/severity/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/daemon test -- gate-evaluation`
Expected: FAIL — prompts don't mention `residualRisks`.

- [ ] **Step 3: Add residual risks to the worker prompt**

In `apps/daemon/src/workflows/orchestrator/gate-worker.ts`, after the `issueRefs` instruction (line 10), insert a new array element:

```ts
    "`residualRisks` MUST list the risks that remain even if you approve — each a short",
    "statement with a severity of \"low\", \"medium\", or \"high\". Use [] only if genuinely none.",
    "",
```

Replace the emitted JSON template (line 26) with:

```ts
    `{ "reasoning": "...", "outcome": ${request.availableOutcomes.map((o) => `"${o}"`).join("|")}, "reason": "...", "residualRisks": [{ "risk": "...", "severity": "low|medium|high" }], "issueRefs": [...], "inputsConsidered": [...] }`,
```

- [ ] **Step 4: Add residual risks to the shadow prompt**

In `apps/daemon/src/workflows/orchestrator/gate-evaluation.ts`, after the `issueRefs` line (line 32), insert:

```ts
    "List in `residualRisks` the risks that remain even if you approve — each a short statement",
    'with a severity of "low", "medium", or "high"; use [] only if genuinely none.',
```

Replace the emitted JSON template (line 37) with:

```ts
    '{ "reasoning": "...", "outcome": "...", "reason": "...", "residualRisks": [{ "risk": "...", "severity": "low|medium|high" }], "issueRefs": [...], "inputsConsidered": [...] }',
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orca/daemon test -- gate-evaluation`
Expected: PASS.

- [ ] **Step 6: Restructure the shadow branch so a supervised gate parks with a recommendation**

In `apps/daemon/src/workflows/orchestrator/dispatch-engine.ts`, replace the shadow branch (lines 2138-2181, everything after the `evalSubstrate === "worker"` early return) with:

```ts
    // No blind parks: a gate reviewer runs even when a human will decide. Resolve a
    // shadow reviewer regardless of review mode.
    let adapterId: ShadowAdapterId | null = null;
    if (this.shadowAsk) {
      try {
        adapterId = resolveShadowAdapterId(goal);
      } catch {
        adapterId = null;
      }
    }
    // The ONLY surviving blind park: no reviewer can run at all (reviewer unavailable).
    if (!this.shadowAsk || !adapterId) {
      this.parkForGateApproval(db, now, { run, stepRun, stepTpl, template, goal, gateNodeId }, options);
      return;
    }

    // An oversized source output/ledger can exceed the request payload cap. Rather
    // than throw out of the dispatch flow, degrade to the reviewer-unavailable park.
    let gateRequest: GateEvaluationRequest;
    try {
      gateRequest = this.buildGateEvaluationRequest(db, { run, stepRun, goal, gateNode, graph });
    } catch {
      this.parkForGateApproval(db, now, { run, stepRun, stepTpl, template, goal, gateNodeId }, options);
      return;
    }
    const proposal = await evaluateGate(this.shadowAsk, {
      goalId: goal.id,
      adapterId,
      request: gateRequest,
      timeoutMs: SHADOW_LLM_TIMEOUT_MS,
    });
    if (!proposal) {
      // Evaluation failed — reviewer-unavailable park (labeled in the card).
      this.parkForGateApproval(db, now, { run, stepRun, stepTpl, template, goal, gateNodeId }, options);
      return;
    }

    if (goalRequiresHumanReview(db, goal.id)) {
      // Supervised: park WITH the reviewer's verdict as a recommendation; the human
      // decides (decideGate). Do NOT auto-record a gate decision.
      this.parkForGateApproval(
        db,
        now,
        { run, stepRun, stepTpl, template, goal, gateNodeId },
        options,
        {
          recommendedOutcome: proposal.outcome,
          reasoning: proposal.reasoning ?? null,
          issueRefs: proposal.issueRefs ?? [],
          reason: proposal.reason,
          residualRisks: proposal.residualRisks,
          inputsConsidered: proposal.inputsConsidered,
        }
      );
      return;
    }

    // Automated: route inline through the shared gate tail.
    await this.applyGateProposal(
      db,
      now,
      { run, stepRun, stepTpl, template, goal, gateNode, graph },
      proposal,
      options
    );
```

- [ ] **Step 7: Add the supervised-park assertion to the gate suite**

Open `apps/daemon/src/workflows/orchestrator/dispatch-engine.gate-worker.test.ts` (or the shadow gate test if the harness fits better), read its setup, and add a test for a **shadow** gate under a human-review goal that stubs `evaluateGate`/`shadowAsk` to return a proposal with `residualRisks`, drives the gate, and asserts the projected run:

```ts
    // after driving the shadow gate for a goal that requires human review:
    const run = /* read the run via the suite's existing helper */;
    expect(run.pendingGateReview).not.toBeNull();
    expect(run.pendingGateReview?.recommendedOutcome).toBe("approved");
    expect(run.pendingGateReview?.residualRisks.length).toBeGreaterThan(0);
```

If the existing harness cannot cheaply stub the shadow ask, mark this assertion as covered by the Task 6 browser verify and add a `// covered by browser verify` note instead of a brittle test — do not fabricate a passing test.

- [ ] **Step 8: Typecheck, run daemon tests, commit**

Run: `pnpm --filter @orca/daemon typecheck && pnpm --filter @orca/daemon test`
Expected: no type errors; gate tests PASS.

```bash
git add apps/daemon/src/workflows/orchestrator/gate-worker.ts apps/daemon/src/workflows/orchestrator/gate-evaluation.ts apps/daemon/src/workflows/orchestrator/dispatch-engine.ts apps/daemon/src/workflows/orchestrator/gate-evaluation.test.ts apps/daemon/src/workflows/orchestrator/dispatch-engine.gate-worker.test.ts
git commit -m "feat(daemon): reviewer emits residual risks; supervised gates never park blind"
```

---

## Task 4: Desktop — structured gate evidence bundle card

**Files:**
- Modify: `apps/desktop/src/orchestrator/ActivityThread.tsx` (`LiveActivity` gateReview prop type 434-439; gate-review render block 495-513)
- Modify: `apps/desktop/src/orchestrator/orca-chat.css` (append gate evidence styles)
- Test: `apps/desktop/src/orchestrator/ActivityThread.test.tsx`

**Interfaces:**
- Consumes: projected `PendingGateReview` fields (Tasks 1-2), passed as `gateReview` from `OrcaChat.tsx:1168` (already wired — no change needed there).
- Produces: gate card renders recommendation, summary, residual-risk list with severities, and a collapsed "Evidence reviewed" disclosure.

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/orchestrator/ActivityThread.test.tsx` inside `describe("LiveActivity", ...)`:

```ts
  it("renders the gate evidence bundle: risks with severity and collapsed evidence", () => {
    render(
      <LiveActivity
        activity={mk({
          status: "paused_for_input",
          sourceKind: "gate_decision_pending",
          currentText: 'Gate "Critique" needs your approval to continue.',
        })}
        onGateDecide={vi.fn()}
        gateReview={{
          recommendedOutcome: "approved",
          reasoning: "The design decomposes into single-purpose modules.",
          reason: "meets the bar",
          residualRisks: [
            { risk: "SQLite cross-thread access", severity: "high" },
            { risk: "CoinGecko rate limits", severity: "low" },
          ],
          inputsConsidered: ["sourceStepOutput", "committedLedger"],
          issueRefs: [],
        }}
      />,
    );

    expect(screen.getByTestId("gate-review-risks")).toBeInTheDocument();
    expect(screen.getByText("SQLite cross-thread access")).toBeInTheDocument();
    const risk = screen.getByText("SQLite cross-thread access").closest("li");
    expect(risk).toHaveAttribute("data-severity", "high");
    // Evidence reviewed is present but collapsed (a <details> without [open]).
    const evidence = screen.getByTestId("gate-review-evidence");
    expect(evidence).toBeInTheDocument();
    expect(evidence).not.toHaveAttribute("open");
    expect(screen.getByText("committedLedger")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test -- ActivityThread`
Expected: FAIL — `gate-review-risks`/`gate-review-evidence` testids absent; prop type rejects new fields.

- [ ] **Step 3: Extend the `gateReview` prop type**

In `apps/desktop/src/orchestrator/ActivityThread.tsx`, replace the `gateReview` prop type (lines 434-439) with:

```ts
  // A gate reviewer's verdict, surfaced as a structured evidence bundle on the card.
  gateReview?: {
    recommendedOutcome: "approved" | "rejected";
    reasoning: string | null;
    reason: string | null;
    residualRisks: { risk: string; severity: "low" | "medium" | "high" }[];
    inputsConsidered: string[];
    issueRefs: string[];
  } | null;
```

- [ ] **Step 4: Restructure the gate-review render block**

Replace the `gateReview` block (lines 495-513) with:

```tsx
          {gateReview ? (
            <div className="gate-review" data-testid="gate-review">
              <div className="gate-review-verdict" data-testid="gate-review-verdict">
                Critic recommends{" "}
                <strong>{gateReview.recommendedOutcome === "rejected" ? "back to Proposal" : "approve"}</strong>
              </div>
              {gateReview.reasoning ? (
                <div className="gate-review-reasoning" data-testid="gate-review-reasoning">
                  {gateReview.reasoning}
                </div>
              ) : null}
              {gateReview.residualRisks.length > 0 ? (
                <div className="gate-review-group">
                  <div className="gate-review-group-label">Residual risks</div>
                  <ul className="gate-review-risks" data-testid="gate-review-risks">
                    {gateReview.residualRisks.map((r, i) => (
                      <li key={`${r.risk}-${i}`} className="gate-review-risk" data-severity={r.severity}>
                        <span className="gate-review-risk-sev" aria-hidden="true">{r.severity}</span>
                        <span className="gate-review-risk-text">{r.risk}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {gateReview.issueRefs.length > 0 ? (
                <ul className="gate-review-issues" data-testid="gate-review-issues">
                  {gateReview.issueRefs.map((ref, i) => (
                    <li key={`${ref}-${i}`}>{ref}</li>
                  ))}
                </ul>
              ) : null}
              {gateReview.inputsConsidered.length > 0 ? (
                <details className="gate-review-evidence" data-testid="gate-review-evidence">
                  <summary className="gate-review-evidence-summary">Evidence reviewed</summary>
                  <ul className="gate-review-evidence-list">
                    {gateReview.inputsConsidered.map((ev, i) => (
                      <li key={`${ev}-${i}`}>{ev}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : null}
```

- [ ] **Step 5: Add styles**

Append to `apps/desktop/src/orchestrator/orca-chat.css`:

```css
.gate-review-group { margin-top: 8px; }
.gate-review-group-label { font-size: 12px; font-weight: 600; color: var(--text-muted, #8b949e); margin-bottom: 4px; }
.gate-review-risks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.gate-review-risk { display: flex; align-items: baseline; gap: 8px; }
.gate-review-risk-sev {
  flex: none; text-transform: uppercase; font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
  padding: 1px 6px; border-radius: 999px; color: #fff;
}
.gate-review-risk[data-severity="low"] .gate-review-risk-sev { background: var(--ok, #3fb950); }
.gate-review-risk[data-severity="medium"] .gate-review-risk-sev { background: #d29922; }
.gate-review-risk[data-severity="high"] .gate-review-risk-sev { background: #f85149; }
.gate-review-risk-text { min-width: 0; }
.gate-review-evidence { margin-top: 8px; }
.gate-review-evidence-summary { cursor: pointer; font-size: 12px; color: var(--text-muted, #8b949e); }
.gate-review-evidence-list { margin: 4px 0 0; padding-left: 18px; font-size: 12px; color: var(--text-muted, #8b949e); }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop test -- ActivityThread`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm --filter @orca/desktop typecheck`
Expected: no errors.

```bash
git add apps/desktop/src/orchestrator/ActivityThread.tsx apps/desktop/src/orchestrator/orca-chat.css apps/desktop/src/orchestrator/ActivityThread.test.tsx
git commit -m "feat(desktop): structured gate evidence bundle card"
```

---

## Task 5: Desktop — "Working on <gate>…" bubble with single-bubble invariant

**Files:**
- Modify: `apps/desktop/src/orchestrator/OrcaChat.tsx` (derive `showGateWorking` ~after line 753; harden `showStepWorking` 739-753; render bubble ~after line 1196)
- Test: `apps/desktop/src/orchestrator/OrcaChat.test.tsx`

**Interfaces:**
- Consumes: `awaitingGate`, `gateNode` (already derived, 636-642), `pendingGateReview` (721), `hasLiveActivity`, `runBlocked`, `showStarting`, `sendingMessage`, `awaitingReply` (all in scope).
- Produces: a single `data-testid="gate-working"` tail bubble during the gate-reviewing window.

- [ ] **Step 1: Write the failing test**

In `apps/desktop/src/orchestrator/OrcaChat.test.tsx`, read how existing tests stub `getWorkflowRunMock`, then add a test whose run is parked at a gate with no review yet:

```ts
  it("shows a single 'Working on <gate>…' bubble while a gate reviewer runs", async () => {
    // Arrange a run parked at the Critique gate, reviewer still running:
    //   currentNodeKind = "gate", currentNodeId = "critique",
    //   currentStepRunId = null, pendingGateReview = null,
    //   and NO gate_decision_pending activity in the stream yet.
    // (Mirror the existing getWorkflowRunMock / getGoalDetailMock setup.)
    // ...render OrcaChat...

    const bubbles = await screen.findAllByText(/Working on Critique…/);
    expect(bubbles).toHaveLength(1);
    expect(screen.queryByTestId("gate-decision")).not.toBeInTheDocument();
    // Single-bubble invariant: the step-working bubble is not also present.
    expect(screen.queryByTestId("step-working")).not.toBeInTheDocument();
  });
```

If the OrcaChat harness is too heavy to arrange this state cheaply, implement the derivation + render (Steps 3-4), rely on Task 4's card test plus the Task 6 browser verify for behavioral coverage, and leave a `// gate-working bubble: see browser verify` note rather than a brittle test.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @orca/desktop test -- OrcaChat`
Expected: FAIL — no `Working on Critique…` bubble rendered.

- [ ] **Step 3: Derive `showGateWorking` and harden `showStepWorking`**

In `apps/desktop/src/orchestrator/OrcaChat.tsx`, add `!awaitingGate` to the `showStepWorking` conjunction (insert after line 740's `activeStepRunning &&`):

```ts
    activeStepRunning &&
    !awaitingGate &&
```

Immediately after the `showStepWorking` block ends (after line 753), add:

```ts
  // Honest progress while a gate's reviewer runs. A run parked at a gate has
  // current_step_run_id = NULL, so showStepWorking (which keys off an active
  // stepRun) never fires here. Derive the reviewing window from the run cursor:
  // parked at a gate (awaitingGate) with no verdict surfaced yet
  // (pendingGateReview == null) and no live pause card up (hasLiveActivity flips
  // true the instant the gate parks for a decision). Holds for both substrates —
  // worker (async) and shadow (brief sync eval). Single-bubble invariant: the
  // guards below make this mutually exclusive with every other tail indicator.
  const gateWorkingName = awaitingGate ? gateNode?.name ?? "Gate" : null;
  const showGateWorking =
    awaitingGate &&
    pendingGateReview == null &&
    !hasLiveActivity &&
    !runBlocked &&
    !showStarting &&
    !sendingMessage &&
    !awaitingReply;
```

- [ ] **Step 4: Render the bubble**

After the `showStepWorking` render block (after line 1196), add:

```tsx
            {showGateWorking && (
              <div data-testid="gate-working">
                <ThinkingRow label={`Working on ${gateWorkingName}…`} />
              </div>
            )}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @orca/desktop test -- OrcaChat`
Expected: PASS (or the note from Step 1 stands).

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @orca/desktop typecheck`
Expected: no errors.

```bash
git add apps/desktop/src/orchestrator/OrcaChat.tsx apps/desktop/src/orchestrator/OrcaChat.test.tsx
git commit -m "feat(desktop): 'Working on <gate>…' bubble during gate review"
```

---

## Task 6: End-to-end browser verification

**Files:** none (verification only).

**Interfaces:** Consumes the full stack from Tasks 1-5.

- [ ] **Step 1: Build contracts + daemon, start the browser app**

Run: `pnpm --filter @orca/contracts build && pnpm --filter @orca/daemon build`
Then start the browser dev server: `pnpm dev:browser` (note the printed Local URL).

- [ ] **Step 2: Drive an Adaptive Delivery run to the Critique gate**

Using the Playwright MCP tools (`mcp__playwright__browser_navigate` to the Local URL, then snapshot/click/type), start or resume a goal on the **Adaptive Delivery** workflow and advance through steps until the run reaches the **Critique** gate. Click **Continue** on the Proposal step.

- [ ] **Step 3: Verify Part A — the working bubble**

Immediately after Continue, confirm **exactly one** `Working on Critique…` bubble (`data-testid="gate-working"`) appears while the reviewer runs, and that:
- `data-testid="step-working"` is NOT simultaneously present,
- `data-testid="gate-decision"` is NOT present yet,
- the composer "Thinking…" placeholder is not duplicating the tail state.

Take a screenshot (`mcp__playwright__browser_take_screenshot`) for the record.

- [ ] **Step 4: Verify Part B — the evidence bundle**

When the reviewer finishes and the gate card appears, confirm the working bubble is **replaced** (not joined) by the card, and the card shows:
- the recommendation line ("Critic recommends approve/back to Proposal"),
- a tightened summary (not the whole card),
- a **Residual risks** list with severity chips (`data-testid="gate-review-risks"`),
- a collapsed **Evidence reviewed** disclosure (`data-testid="gate-review-evidence"`, closed by default) that expands on click,
- Approve / Reject buttons.

Take a screenshot.

- [ ] **Step 5: Verify the shadow gate (no blind park)**

Repeat the drive for a **Bug Triage & Fix** goal to its **Verdict** gate (shadow substrate) under a supervised goal; confirm it too surfaces a structured recommendation card (not a bare "needs your approval" line) — proving no blind park.

- [ ] **Step 6: Full typecheck + test sweep, then final commit**

Run: `pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add -A
git commit -m "test: verify gate evidence bundle + working bubble end-to-end" --allow-empty
```

---

## Self-Review

**Spec coverage:**
- Part A working bubble → Task 5 (+ Task 6 verify). ✓
- Single-bubble invariant → Task 5 Step 3 (`!awaitingGate` on step bubble; mutual-exclusion guards) + Task 6 Step 3. ✓
- B1 reviewer contract (`residualRisks`) → Task 1 + Task 3 (worker & shadow prompts). ✓
- B2 project to run (`reason`, `residualRisks`, `inputsConsidered`) → Tasks 1-2. ✓
- B3 card UI (proposed transition via existing `currentText` header, recommendation, summary, risks, collapsed evidence) → Task 4. ✓
- B4 no blind parks → Task 3 Step 6. ✓
- Reuse note (borrow step card's disclosure grammar) → Task 4 uses the same `<details>`/`data-testid` pattern. ✓
- "What's being approved" is carried by the existing `activity.currentText` header ("Gate 'X' needs your approval to continue") — no separate next-node lookup added (YAGNI). Noted so a reviewer doesn't flag it missing.

**Placeholder scan:** No TBD/TODO. The two "if the harness is too heavy" fallbacks (Task 3 Step 7, Task 5 Step 1) are explicit, bounded instructions with a concrete alternative (browser verify) — not vague deferrals.

**Type consistency:** `GateResidualRisk` `{ risk, severity }` is identical across contracts (Task 1), daemon param/projection (Tasks 2-3), and the desktop prop type (Task 4). `residualRisks`/`inputsConsidered`/`reason` names match at every layer. Projection defaults (`[]`, `null`) align with the `.default([])`/`.nullable()` contract.
