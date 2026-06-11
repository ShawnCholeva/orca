# Step-Result Scoring & Activity Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make normal step completion produce real model scores via the existing shadow approval turn (no API key, no `claude -p`), surface every terminal step result as one expandable Activity Thread card, and close the direct-SDK fall-through for shadow-only adapters.

**Architecture:** Scoring rides the shadow orchestrator's existing `approve_step_complete` turn — the action gains an optional, loosely-typed `scoring` field that never breaks approval parsing and is validated separately with `StepResultScoringProposal`. The daemon combines valid scoring with daemon-measured facts into a `WorkflowStepResult`; missing/invalid scoring and all replay/recovery paths write a non-blocking evaluation-failure result. Every terminal step transition idempotently materializes one `step_result` activity that the projection enriches by joining `workflow_step_runs.step_result_json` + the template step name. The desktop renders a collapsed/expandable result card.

**Tech Stack:** TypeScript, Zod (`@orca/contracts`), better-sqlite3, Vitest, React (desktop).

**Source spec:** `docs/superpowers/specs/2026-06-08-step-result-scoring-and-activity-visibility-design.md` (authoritative; supersedes the PRD).

---

## Agent recommendation legend

Each task carries an **Agent:** line. Heuristic used:

- **Sonnet** — code is fully specified and the change is localized/mechanical: contract/schema edits, pure helpers, SQL migrations, projection joins, UI rendering with provided code.
- **GPT 5.5** — the task needs cross-file integration reasoning, test-harness wiring, prompt-engineering judgment, multi-call-site correctness, or novel shadow-turn logic where a wrong abstraction is easy to pick.

---

## File Structure

**Phase A — Scoring via shadow approval turn**
- Modify `packages/contracts/src/workflows/index.ts` — add optional `scoring` to the `approve_step_complete` action variant.
- Modify `apps/daemon/src/workflows/steps/step-result.ts` — add `buildScoredStepResult(facts, proposal)`.
- Modify `apps/daemon/src/orchestrator-llm/prompts.ts` — teach the orchestrator to emit `scoring` on approval.
- Modify `apps/daemon/src/workflows/orchestrator/service.ts` — approval handler builds result from `action.scoring`; replay path writes evaluation-failed; remove the broker scoring call from the normal path.

**Phase B — Shadow-only policy**
- Create `apps/daemon/src/workflows/orchestrator/recover-step-scoring.ts` — typed shadow-evaluation helper for worker-exit recovery.
- Modify `apps/daemon/src/workflows/orchestrator/service.ts` — wire recovery turn; disable direct model operators for shadow-only adapters.
- Modify `apps/daemon/src/workflows/operators/selector.ts` / `apps/daemon/src/workflows/orchestrator/synthesize.ts` — audit gate (guard against SDK fast-path for shadow-only adapters).

**Phase C — Activity data model**
- Modify `packages/contracts/src/index.ts` — add `step_result` source kind + optional result-card fields on `Activity`.
- Create `apps/daemon/migrations/0025_activity_step_result.sql` — partial unique index for idempotency.
- Modify `apps/daemon/src/migrations.ts` — register the migration.
- Create `apps/daemon/src/activities/step-result-activity.ts` — idempotent materialization + reconciliation.
- Modify `apps/daemon/src/activities/projection.ts` — enrich `step_result` rows by join.
- Modify `apps/daemon/src/workflows/orchestrator/service.ts` — call materialization at terminal transition; call reconciliation at startup.

**Phase D — Desktop result card**
- Modify `apps/desktop/src/orchestrator/ActivityThread.tsx` — render the result card.

---

# Phase A — Scoring via shadow approval turn

### Task 1: Add optional `scoring` to the approval action contract

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts:1675`
- Test: `packages/contracts/src/__tests__/workflow-contracts.test.ts`

**Agent: Sonnet** — single schema line + additive tests; code fully provided.

- [ ] **Step 1: Write the failing tests** — append to `workflow-contracts.test.ts`:

```ts
import { OrchestratorAction } from "@orca/contracts";

describe("OrchestratorAction approve_step_complete scoring", () => {
  const validScoring = {
    successScore: 0.8,
    quality: {
      outputCompleteness: 0.8,
      outputCorrectness: 0.8,
      instructionAdherence: 0.9,
      downstreamReadiness: 0.8,
      riskLevel: 0.2,
    },
    reason: "ready for next step",
    handoffReady: true,
  };

  it("parses approval with valid scoring and preserves it", () => {
    const parsed = OrchestratorAction.parse({ kind: "approve_step_complete", scoring: validScoring });
    expect(parsed.kind).toBe("approve_step_complete");
    expect((parsed as { scoring?: unknown }).scoring).toEqual(validScoring);
  });

  it("preserves the approval action when scoring is malformed", () => {
    const parsed = OrchestratorAction.safeParse({ kind: "approve_step_complete", scoring: { successScore: "oops" } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.kind).toBe("approve_step_complete");
  });

  it("parses approval with no scoring", () => {
    const parsed = OrchestratorAction.parse({ kind: "approve_step_complete" });
    expect(parsed.kind).toBe("approve_step_complete");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @orca/contracts -- workflow-contracts`
Expected: FAIL — the malformed-scoring case currently strips `scoring`, and the valid case finds `scoring` undefined.

- [ ] **Step 3: Add the field** — at `packages/contracts/src/workflows/index.ts:1675`, replace the approval variant:

```ts
  z.object({ kind: z.literal("approve_step_complete"), scoring: z.unknown().optional(), rationale: z.string().max(2000).optional() }),
```

> `z.unknown().optional()` is deliberate: it captures whatever the model emits without rejecting it, so a malformed `scoring` can never invalidate the approval. Validation happens separately in Task 4.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @orca/contracts -- workflow-contracts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/workflows/index.ts packages/contracts/src/__tests__/workflow-contracts.test.ts
git commit -m "feat(contracts): allow optional scoring on approve_step_complete"
```

---

### Task 2: Add `buildScoredStepResult` helper

**Files:**
- Modify: `apps/daemon/src/workflows/steps/step-result.ts`
- Test: Create `apps/daemon/src/workflows/steps/step-result.scored.test.ts`

**Agent: Sonnet** — pure function, existing combine logic to lift from `step-result-scoring.ts:77-93`.

- [ ] **Step 1: Write the failing test** — create `step-result.scored.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { StepResultScoringFacts, StepResultScoringProposal } from "@orca/contracts";
import { buildScoredStepResult } from "./step-result.js";

const facts: StepResultScoringFacts = {
  stepId: "00000000-0000-0000-0000-000000000001",
  stepStatus: "completed",
  performance: { durationSeconds: 96, retries: 0 },
  outcome: { producedArtifactsCount: 1, blockingIssuesCount: 0, warningsCount: 0 },
};

const proposal: StepResultScoringProposal = {
  successScore: 0.82,
  quality: {
    outputCompleteness: 0.8,
    outputCorrectness: 0.85,
    instructionAdherence: 0.9,
    downstreamReadiness: 0.8,
    riskLevel: 0.2,
  },
  reason: "Output complete and correct.",
  handoffReady: true,
};

describe("buildScoredStepResult", () => {
  it("combines daemon facts with shadow-owned scoring", () => {
    const result = buildScoredStepResult(facts, proposal);
    expect(result.evaluationStatus).toBe("scored");
    expect(result.successScore).toBe(0.82);
    expect(result.quality).toEqual(proposal.quality);
    expect(result.performance).toEqual(facts.performance);
    expect(result.outcome.producedArtifactsCount).toBe(1);
    expect(result.outcome.handoffReady).toBe(true);
    expect(result.outcome.reason).toBe("Output complete and correct.");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @orca/daemon -- step-result.scored`
Expected: FAIL — `buildScoredStepResult` is not exported.

- [ ] **Step 3: Implement** — add to `apps/daemon/src/workflows/steps/step-result.ts` (extend the contracts import to include the two types and `WorkflowStepResult` is already imported):

```ts
import {
  WORKFLOW_FAILURE_MAX_MESSAGE_CHARS,
  WorkflowStepResult,
  type StepResultScoringFacts,
  type StepResultScoringProposal,
  type WorkflowStepResult as WorkflowStepResultT,
  type WorkflowStepResultStatus,
} from "@orca/contracts";
```

```ts
export function buildScoredStepResult(
  facts: StepResultScoringFacts,
  proposal: StepResultScoringProposal
): WorkflowStepResultT {
  return WorkflowStepResult.parse({
    stepId: facts.stepId,
    stepStatus: facts.stepStatus,
    evaluationStatus: "scored",
    successScore: proposal.successScore,
    quality: proposal.quality,
    performance: facts.performance,
    outcome: {
      reason: sanitizeStepResultReason(proposal.reason),
      producedArtifactsCount: facts.outcome.producedArtifactsCount,
      blockingIssuesCount: facts.outcome.blockingIssuesCount,
      warningsCount: facts.outcome.warningsCount,
      handoffReady: proposal.handoffReady,
    },
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @orca/daemon -- step-result.scored`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/steps/step-result.ts apps/daemon/src/workflows/steps/step-result.scored.test.ts
git commit -m "feat(daemon): add buildScoredStepResult helper"
```

---

### Task 3: Teach the orchestrator prompt to emit scoring on approval

**Files:**
- Modify: `apps/daemon/src/orchestrator-llm/prompts.ts:78`
- Test: Create `apps/daemon/src/orchestrator-llm/prompts.test.ts`

**Agent: GPT 5.5** — the wording determines real-world scoring fill-rate (spec Decision 12 observes fill-rate in practice); choosing instructions that reliably elicit valid `StepResultScoringProposal` is a prompt-engineering judgment call.

- [ ] **Step 1: Write the failing test** — create `prompts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { composeOrchestratorPrompt } from "./prompts.js";

function approvalPrompt() {
  return composeOrchestratorPrompt({
    triggerKind: "response_done",
    context: {} as never,
    triggerPayload: {} as never,
  }).systemPrompt;
}

describe("orchestrator prompt scoring guidance", () => {
  it("instructs the model to include a scoring object on approval", () => {
    const sys = approvalPrompt();
    expect(sys).toContain("approve_step_complete");
    expect(sys).toContain("scoring");
    expect(sys).toContain("successScore");
    expect(sys).toContain("riskLevel");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @orca/daemon -- prompts`
Expected: FAIL — the prompt does not mention `scoring`/`successScore`.

> If `composeOrchestratorPrompt`'s `triggerKind`/`context`/`triggerPayload` types reject the casts above, open `prompts.ts:43-66` and pass the minimal real shape instead. Run the test first to see the exact type error before adjusting.

- [ ] **Step 3: Update the prompt** — at `apps/daemon/src/orchestrator-llm/prompts.ts:78`, replace the approval bullet and add a scoring-semantics line just below the bullet list:

```ts
    '- {"kind":"approve_step_complete","scoring":{"successScore":0.0,"quality":{"outputCompleteness":0.0,"outputCorrectness":0.0,"instructionAdherence":0.0,"downstreamReadiness":0.0,"riskLevel":0.0},"reason":"<short>","handoffReady":true}}  (the orca:step-complete block satisfies the step; ALWAYS include scoring when you approve)',
```

Add after the bullet list (before `'Every shape also accepts an optional "rationale"...'`):

```ts
    'When you approve_step_complete you MUST score the completed step. All scoring numbers are 0..1.',
    'successScore and each quality dimension: 1 = best. riskLevel is inverted: 0 = no risk, 1 = severe risk.',
    'Score from the agent evidence (output block, artifacts, assumptions, warnings). The agent never authors its own score.',
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @orca/daemon -- prompts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/orchestrator-llm/prompts.ts apps/daemon/src/orchestrator-llm/prompts.test.ts
git commit -m "feat(daemon): orchestrator scores the step on approval"
```

---

### Task 4: Build the scored result from `action.scoring` in the approval handler

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (imports; `approve_step_complete` case at `651-684`; add `buildApprovalStepResult` method)
- Test: `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts`

**Agent: GPT 5.5** — discriminated-union narrowing, orphan cleanup, and harness-driven integration assertion.

- [ ] **Step 1: Add imports** — extend the existing `@orca/contracts` import in `service.ts` to include `StepResultScoringProposal`, and the `step-result.js` import (currently brings in `buildEvaluationFailedStepResult` at line 59) to include `buildScoredStepResult`:

```ts
import { buildEvaluationFailedStepResult, buildScoredStepResult } from "../steps/step-result.js";
```

- [ ] **Step 2: Add the `buildApprovalStepResult` method** — place it next to `scoreCompletedStepResult` (near `service.ts:1349`):

```ts
  /**
   * Builds the terminal step result for a normal approval. Scoring is owned by
   * the shadow orchestrator and arrives on the approve_step_complete action;
   * the daemon owns the measured facts. Missing or invalid scoring yields a
   * non-blocking evaluation-failure result.
   */
  private buildApprovalStepResult(
    db: Database.Database,
    ctx: { stepRun: StepRunRow },
    scoring: unknown,
    finishedAt: string
  ): WorkflowStepResult {
    const facts = this.scoringFacts(db, ctx.stepRun, "passed", finishedAt);
    const proposal = StepResultScoringProposal.safeParse(scoring);
    if (proposal.success) {
      return buildScoredStepResult(facts, proposal.data);
    }
    return buildEvaluationFailedStepResult({
      stepId: ctx.stepRun.id,
      stepStatus: facts.stepStatus,
      startedAt: ctx.stepRun.started_at,
      finishedAt,
      retries: facts.performance.retries,
      producedArtifactsCount: facts.outcome.producedArtifactsCount,
      blockingIssuesCount: facts.outcome.blockingIssuesCount,
      warningsCount: facts.outcome.warningsCount,
      reason: scoring === undefined ? "approval omitted scoring proposal" : "invalid step result scoring proposal",
    });
  }
```

- [ ] **Step 3: Rewire the `approve_step_complete` case** — at `service.ts:667-671`, replace:

```ts
        const output = block && typeof block === "object" && !Array.isArray(block)
          ? (block as Record<string, unknown>)
          : null;
        const finishedAt = now();
        const stepResult = await this.scoreCompletedStepResult(db, ctx, output, finishedAt);
```

with:

```ts
        const finishedAt = now();
        const stepResult = this.buildApprovalStepResult(db, ctx, action.scoring, finishedAt);
```

> This removes the only use of the `output` local in this branch (it existed solely to feed the old broker scoring call). The artifact is still written from `block` at lines 654-661, so nothing else needs it.

- [ ] **Step 4: Write the integration test** — add to `service.agent-step.test.ts`, using the file's existing harness helpers (`setupHarness`, `seedSkillWorkflow`, `OrchestratorService`, a fake mediator). Mirror the existing approve-path test in this file for setup; assert on the persisted result:

```ts
it("persists a model-scored result when the orchestrator approves with scoring", async () => {
  const h = setupHarness();
  const fakeMediator = {
    invokeWithBackoff: async (): Promise<OrchestratorAction> => ({
      kind: "approve_step_complete",
      scoring: {
        successScore: 0.82,
        quality: { outputCompleteness: 0.8, outputCorrectness: 0.85, instructionAdherence: 0.9, downstreamReadiness: 0.8, riskLevel: 0.2 },
        reason: "Output complete.",
        handoffReady: true,
      },
    }),
  } as unknown as OrchestratorMediator;
  // ... seed a skill workflow with an active agent step (mirror the existing approve test setup) ...
  // ... drive onAgentResponseDone with an orca:step-complete block in the response text ...
  const row = h.db.prepare("SELECT step_result_json FROM workflow_step_runs WHERE id = ?").get(stepRunId) as { step_result_json: string };
  const result = JSON.parse(row.step_result_json);
  expect(result.evaluationStatus).toBe("scored");
  expect(result.successScore).toBe(0.82);
  cleanupHarness(h);
});
```

> Guardrail: run the existing suite first (`npm test -w @orca/daemon -- service.agent-step`) to confirm the exact `setupHarness`/`onAgentResponseDone` signatures, then fill the seed/drive lines to match the existing approve test in the same file. Do not invent helper names — every helper used must already be imported at the top of this test file.

- [ ] **Step 5: Run to verify pass**

Run: `npm test -w @orca/daemon -- service.agent-step`
Expected: PASS (new test green, existing approve tests still green)

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck -w @orca/daemon
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "feat(daemon): score completed steps from the shadow approval turn"
```

---

### Task 5: Replay/idempotency path writes a deterministic evaluation-failure result

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts:299-304` (+ add `replayEvaluationFailedResult` method)
- Test: `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts` (or the test that exercises the synthesize/replay branch)

**Agent: Sonnet** — localized swap; code provided.

- [ ] **Step 1: Add the method** — near `buildApprovalStepResult`:

```ts
  /**
   * Replay/reconciliation: step_output already exists but step_result_json is
   * null (crash between artifact write and result persistence). There is no
   * live approval turn or worker session to score against, so we write a
   * deterministic evaluation-failure result from measured facts — no model call.
   */
  private replayEvaluationFailedResult(
    db: Database.Database,
    stepRun: StepRunRow,
    finishedAt: string
  ): WorkflowStepResult {
    const facts = this.scoringFacts(db, stepRun, "passed", finishedAt);
    return buildEvaluationFailedStepResult({
      stepId: stepRun.id,
      stepStatus: facts.stepStatus,
      startedAt: stepRun.started_at,
      finishedAt,
      retries: facts.performance.retries,
      producedArtifactsCount: facts.outcome.producedArtifactsCount,
      blockingIssuesCount: facts.outcome.blockingIssuesCount,
      warningsCount: facts.outcome.warningsCount,
      reason: "result recovered on replay without live scoring",
    });
  }
```

- [ ] **Step 2: Rewire the replay branch** — at `service.ts:299-304`, replace the `scoreCompletedStepResult` call:

```ts
      const stepResult = this.replayEvaluationFailedResult(db, stepRun, finishedAt);
```

> This removes the `parsedObjectOrNull(existing.body)` argument. After editing, run `rg -n "parsedObjectOrNull" apps/daemon/src/workflows/orchestrator/service.ts`. If this was its last use, remove the now-orphaned import; if other uses remain, leave it.

- [ ] **Step 3: Write the test** — assert that re-entering with `step_output` present but `step_result_json` null persists an evaluation-failure result and advances. Drive the synthesize/replay entry point (the function containing `service.ts:280-309`) and assert:

```ts
const result = JSON.parse(stepRow.step_result_json);
expect(result.evaluationStatus).toBe("failed");
expect(result.outcome.reason).toContain("recovered on replay");
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @orca/daemon -- service.agent-step`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "feat(daemon): write evaluation-failed on step-result replay"
```

---

# Phase B — Shadow-only policy

> Context confirmed in source: with no `ANTHROPIC_API_KEY`, `attempts.ts:61` maps `missing_api_key → one_shot_unavailable`, so every `broker.propose` that relies on the SDK fast-path falls through to `hidden_interactive → human_review` for Claude. The shadow building block is `ShadowSessionManager.ask(goalId, { adapterId, systemPrompt, userPrompt, timeoutMs }) → { text }` (`shadow-session.ts:152`), already wired into the mediator via `ShadowSessionLlmClient` (`shadow-llm-client.ts`).

### Task 6: Worker-exit recovery — score via a bounded structured shadow turn

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/recover-step-scoring.ts`
- Test: Create `apps/daemon/src/workflows/orchestrator/recover-step-scoring.test.ts`

**Agent: GPT 5.5** — novel shadow-turn composition + parsing + bounded failure handling; the abstraction boundary matters.

- [ ] **Step 1: Write the failing test** — create `recover-step-scoring.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { recoverStepScoring } from "./recover-step-scoring.js";

const facts = {
  stepId: "00000000-0000-0000-0000-000000000001",
  stepStatus: "completed" as const,
  performance: { durationSeconds: 10, retries: 0 },
  outcome: { producedArtifactsCount: 1, blockingIssuesCount: 0, warningsCount: 0 },
};

const validText = JSON.stringify({
  successScore: 0.7,
  quality: { outputCompleteness: 0.7, outputCorrectness: 0.7, instructionAdherence: 0.7, downstreamReadiness: 0.7, riskLevel: 0.3 },
  reason: "recovered output is adequate",
  handoffReady: true,
});

describe("recoverStepScoring", () => {
  it("returns a scored result when the shadow turn yields a valid proposal", async () => {
    const ask = vi.fn().mockResolvedValue({ text: validText });
    const result = await recoverStepScoring({ ask }, { goalId: "g", adapterId: "claude-code", timeoutMs: 1000, facts, prompt: { systemPrompt: "s", userPrompt: "u" } });
    expect(result.evaluationStatus).toBe("scored");
    expect(result.successScore).toBe(0.7);
  });

  it("returns an evaluation-failure result when the shadow turn times out", async () => {
    const ask = vi.fn().mockRejectedValue(new Error("shadow ask timed out"));
    const result = await recoverStepScoring({ ask }, { goalId: "g", adapterId: "claude-code", timeoutMs: 1000, facts, prompt: { systemPrompt: "s", userPrompt: "u" } });
    expect(result.evaluationStatus).toBe("failed");
  });

  it("returns an evaluation-failure result when the shadow text is malformed", async () => {
    const ask = vi.fn().mockResolvedValue({ text: "not json" });
    const result = await recoverStepScoring({ ask }, { goalId: "g", adapterId: "claude-code", timeoutMs: 1000, facts, prompt: { systemPrompt: "s", userPrompt: "u" } });
    expect(result.evaluationStatus).toBe("failed");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @orca/daemon -- recover-step-scoring`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — create `recover-step-scoring.ts`:

```ts
import {
  StepResultScoringProposal,
  type StepResultScoringFacts,
  type WorkflowStepResult,
} from "@orca/contracts";
import type { ShadowAdapterId } from "../../orchestrator-llm/shadow-session.js";
import { buildEvaluationFailedStepResult, buildScoredStepResult } from "../steps/step-result.js";

export interface ShadowAsk {
  ask(goalId: string, input: { adapterId: ShadowAdapterId; systemPrompt: string; userPrompt: string; timeoutMs: number }): Promise<{ text: string }>;
}

export interface RecoverStepScoringInput {
  goalId: string;
  adapterId: ShadowAdapterId;
  timeoutMs: number;
  facts: StepResultScoringFacts;
  prompt: { systemPrompt: string; userPrompt: string };
  startedAt?: string | null;
  finishedAt?: string;
}

export async function recoverStepScoring(
  deps: ShadowAsk,
  input: RecoverStepScoringInput
): Promise<WorkflowStepResult> {
  const fail = (reason: string): WorkflowStepResult =>
    buildEvaluationFailedStepResult({
      stepId: input.facts.stepId,
      stepStatus: input.facts.stepStatus,
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? new Date().toISOString(),
      retries: input.facts.performance.retries,
      producedArtifactsCount: input.facts.outcome.producedArtifactsCount,
      blockingIssuesCount: input.facts.outcome.blockingIssuesCount,
      warningsCount: input.facts.outcome.warningsCount,
      reason,
    });

  let text: string;
  try {
    ({ text } = await deps.ask(input.goalId, {
      adapterId: input.adapterId,
      systemPrompt: input.prompt.systemPrompt,
      userPrompt: input.prompt.userPrompt,
      timeoutMs: input.timeoutMs,
    }));
  } catch (err) {
    return fail(err instanceof Error ? err.message : "shadow recovery turn failed");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("shadow recovery returned non-JSON");
  }

  const proposal = StepResultScoringProposal.safeParse(raw);
  if (!proposal.success) return fail("shadow recovery returned invalid scoring proposal");
  return buildScoredStepResult(input.facts, proposal.data);
}
```

> The `facts.performance.durationSeconds` already encodes the measured duration; the eval-failed builder recomputes from `startedAt/finishedAt`, so pass them when available for an accurate fallback duration.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @orca/daemon -- recover-step-scoring`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/workflows/orchestrator/recover-step-scoring.ts apps/daemon/src/workflows/orchestrator/recover-step-scoring.test.ts
git commit -m "feat(daemon): bounded shadow recovery scoring for worker-exit"
```

---

### Task 7: Wire worker-exit recovery into the service

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts:452` (the `onWorkflowSessionCompleted` synthesis path) + constructor deps for a shadow-ask handle and a recovery prompt composer.
- Test: `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts`

**Agent: GPT 5.5** — threading a new dependency through the service constructor and call site; must preserve advancement on failure.

- [ ] **Step 1:** Add an optional shadow-ask dependency to the service constructor deps (mirror how `this.broker`/`this.orchestratorMediator` are injected). Inspect the constructor (`rg -n "orchestratorMediator" apps/daemon/src/workflows/orchestrator/service.ts`) and add a sibling optional field `shadowAsk?: ShadowAsk` plus a recovery-prompt composer (a small function returning `{ systemPrompt, userPrompt }` from the step + recovered output; reuse `composeOrchestratorPrompt` style or a dedicated scoring prompt).

- [ ] **Step 2:** At `service.ts:452`, replace the `scoreCompletedStepResult` call with: if `this.shadowAsk` and the goal adapter is shadow-only, call `recoverStepScoring(...)` with `scoringFacts(db, stepRun, "passed", finishedAt)`; otherwise fall back to `buildEvaluationFailedStepResult(...)`. On any failure `recoverStepScoring` already returns an evaluation-failed result, so advancement always proceeds.

```ts
    const facts = this.scoringFacts(db, stepRun, "passed", finishedAt);
    const stepResult = this.shadowAsk
      ? await recoverStepScoring(this.shadowAsk, {
          goalId: goal.id,
          adapterId: resolveShadowAdapterId(goal),
          timeoutMs: RECOVERY_SHADOW_TIMEOUT_MS,
          facts,
          prompt: composeRecoveryScoringPrompt({ stepTpl, goal, output: result.output }),
          startedAt: stepRun.started_at,
          finishedAt,
        })
      : buildEvaluationFailedStepResult({
          stepId: stepRun.id, stepStatus: facts.stepStatus, startedAt: stepRun.started_at, finishedAt,
          retries: facts.performance.retries, producedArtifactsCount: facts.outcome.producedArtifactsCount,
          blockingIssuesCount: facts.outcome.blockingIssuesCount, warningsCount: facts.outcome.warningsCount,
          reason: "no shadow session available for recovery scoring",
        });
```

> Define `RECOVERY_SHADOW_TIMEOUT_MS` next to the service (reuse the same timeout constant the mediator's `ShadowSessionLlmClient` is constructed with in `server.ts:621-623` — grep it and import/share it rather than introducing a new number). `resolveShadowAdapterId` and `composeRecoveryScoringPrompt` are small local helpers; the adapter id comes from the goal's orchestrator provider/adapter (same source the mediator uses).

- [ ] **Step 3:** Test both branches: a fake `shadowAsk` returning valid scoring → recovered result is `scored`; a rejecting `shadowAsk` → result is `failed` and the run still advances. Assert advancement via the next-step status as the existing tests do.

- [ ] **Step 4: Run + commit**

Run: `npm test -w @orca/daemon -- service.agent-step` → PASS

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "feat(daemon): score worker-exit recovery via bounded shadow turn"
```

---

### Task 8: Disable direct model operators + audit selector/synthesize for shadow-only adapters

**Files:**
- Modify: `apps/daemon/src/workflows/operators/selector.ts:222` (guard the `runSdkOneShot` fast-path) and `apps/daemon/src/workflows/orchestrator/synthesize.ts:63`.
- Modify: model-operator selection so a shadow-only adapter never selects a direct model operator (`service.ts:1244` is the `run_step_skill` execution; the *selection* guard belongs where operators are chosen — `rg -n "MODEL_OPERATOR_ID|kind === \"model\"|operatorKind" apps/daemon/src/workflows`).
- Test: `apps/daemon/src/workflows/operators/selector.test.ts` (+ a synthesize test) + `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts`.

**Agent: GPT 5.5** — multi-call-site correctness; "fixed or provably unreachable" requires reasoning about which adapters reach each path.

- [ ] **Step 1:** Determine the shadow-only signal. An adapter is shadow-only when its execution-mode config has `one_shot` in `disabledExecutionModes` (contract `AdapterExecutionModeConfig`, `execution-modes.ts`). Find the resolver the broker already uses (`AdapterModeResolver` / `modeResolver`, `broker.ts:27`) and reuse it — do not add a parallel notion of "shadow-only".

- [ ] **Step 2 (selector):** Write a failing test asserting that for a shadow-only adapter, `selector.select(...)` does NOT pass `runSdkOneShot` (and instead routes through the shadow path or returns the fallback selection). Then guard `selector.ts:222`: only attach `runSdkOneShot` when the adapter's `one_shot` mode is enabled; otherwise route selection through the shadow session client (mirror `RoutedOrchestratorLlmClient` usage) or the existing fallback selection.

- [ ] **Step 3 (synthesize):** Write a failing test that for a shadow-only adapter, synthesis does not depend on the SDK fast-path. Apply the same guard at `synthesize.ts:63`.

- [ ] **Step 4 (model operators):** Write a failing test that operator selection for a shadow-only adapter never returns a direct model operator. Add the guard at the selection site; ensure no fallback silently re-enables `ModelProvider.complete`.

- [ ] **Step 5:** Run the affected suites:

Run: `npm test -w @orca/daemon -- selector synthesize service.agent-step`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/workflows
git commit -m "feat(daemon): route orchestration through shadow for shadow-only adapters"
```

> Scope guardrail: do not change behavior for adapters that legitimately enable `one_shot` (with an API key) — their SDK path stays unchanged. Every edited caller must end either shadow-routed or provably unreachable for shadow-only adapters; note which in the commit body.

---

# Phase C — Activity data model

### Task 9: Add `step_result` source kind + optional result-card fields to `Activity`

**Files:**
- Modify: `packages/contracts/src/index.ts:1046` (source-kind enum) and `:1069` (`Activity`)
- Test: `packages/contracts/src/__tests__/` (the activity-contracts test; `rg -l "ActivitySourceKind|Activity\b" packages/contracts/src/__tests__`)

**Agent: Sonnet** — additive schema change; code provided.

- [ ] **Step 1: Write failing tests:**

```ts
import { Activity, ActivitySourceKind, WorkflowStepResult } from "@orca/contracts";

it("accepts step_result as a source kind", () => {
  expect(ActivitySourceKind.parse("step_result")).toBe("step_result");
});

it("accepts a result-card payload on a step_result activity", () => {
  const base = {
    id: "a1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: null,
    turnOrdinal: 5, status: "completed", currentText: "", finalSummary: null,
    sourceKind: "step_result", workCategory: null, confidence: null,
    createdAt: "2026-06-09T00:00:00.000Z", updatedAt: "2026-06-09T00:00:00.000Z",
    completedAt: "2026-06-09T00:00:00.000Z",
    stepName: "Investigate",
    stepResult: {
      stepId: "s1", stepStatus: "completed", evaluationStatus: "scored", successScore: 0.8,
      quality: { outputCompleteness: 0.8, outputCorrectness: 0.8, instructionAdherence: 0.8, downstreamReadiness: 0.8, riskLevel: 0.2 },
      performance: { durationSeconds: 10, retries: 0 },
      outcome: { reason: "ok", producedArtifactsCount: 1, blockingIssuesCount: 0, warningsCount: 0, handoffReady: true },
    },
  };
  const parsed = Activity.parse(base);
  expect(parsed.stepName).toBe("Investigate");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @orca/contracts -- activity`
Expected: FAIL — enum rejects `step_result`; `Activity` is `.strict()` and rejects `stepName`/`stepResult`.

- [ ] **Step 3: Edit the contract** — add `"step_result"` to the enum at `index.ts:1046`:

```ts
export const ActivitySourceKind = z.enum([
  "step_started",
  "tool_use",
  "question_pending",
  "permission_pending",
  "turn_completed",
  "weak_signal",
  "step_result"
]);
```

Add the two optional fields just before `createdAt` in `Activity` (`index.ts:1084`). `WorkflowStepResult` is exported from `./workflows/index.js`; ensure it is imported/available in `index.ts`:

```ts
    stepName: z.string().max(256).optional(),
    stepResult: WorkflowStepResult.optional(),
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @orca/contracts -- activity`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/__tests__/
git commit -m "feat(contracts): step_result activity source kind + result-card fields"
```

---

### Task 10: Migration — partial unique index for one result activity per step run

**Files:**
- Create: `apps/daemon/migrations/0025_activity_step_result.sql`
- Modify: `apps/daemon/src/migrations.ts:37` (append to the registered list)
- Test: `apps/daemon/src/migrations.test.ts`

**Agent: Sonnet** — mechanical SQL + registration.

- [ ] **Step 1: Create the migration:**

```sql
-- 0025_activity_step_result.sql
-- Idempotency for terminal step-result activities: at most one step_result
-- activity per step run, surviving event replay and daemon recovery.
CREATE UNIQUE INDEX idx_activities_one_step_result_per_step
  ON activities(step_run_id) WHERE source_kind = 'step_result';
```

- [ ] **Step 2: Register it** — append after `"0024_activities.sql",` at `migrations.ts:37`:

```ts
  "0025_activity_step_result.sql",
```

- [ ] **Step 3: Run the migration suite**

Run: `npm test -w @orca/daemon -- migrations`
Expected: PASS — migrations apply cleanly in order (the existing test applies all registered migrations to a fresh DB).

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/migrations/0025_activity_step_result.sql apps/daemon/src/migrations.ts
git commit -m "feat(daemon): unique index for one step_result activity per step run"
```

---

### Task 11: Idempotent materialization + startup reconciliation

**Files:**
- Create: `apps/daemon/src/activities/step-result-activity.ts`
- Test: Create `apps/daemon/src/activities/step-result-activity.test.ts`

**Agent: GPT 5.5** — idempotency + reconciliation correctness across replay; the unique-index conflict handling must be exactly right.

- [ ] **Step 1: Write failing tests** (seed an `activities`-capable DB the way `apps/daemon/src/activities/store.ts` tests / `routes.test.ts` do — reuse that setup):

```ts
import { describe, expect, it } from "vitest";
import { materializeStepResultActivity, reconcileStepResultActivities } from "./step-result-activity.js";
// ... reuse the activities test harness (in-memory db with migrations applied, an EventBus spy) ...

describe("materializeStepResultActivity", () => {
  it("creates exactly one step_result activity for a terminal step run", () => {
    const events: string[] = [];
    const ctx = makeCtx(events); // db + bus that records published event types
    seedTerminalStepRun(ctx.db, { stepRunId: "s1", goalId: "g1", workflowRunId: "r1", stepName: "Investigate" });
    materializeStepResultActivity(ctx, { goalId: "g1", workflowRunId: "r1", stepRunId: "s1" });
    materializeStepResultActivity(ctx, { goalId: "g1", workflowRunId: "r1", stepRunId: "s1" }); // replay
    const rows = ctx.db.prepare("SELECT * FROM activities WHERE step_run_id = 's1' AND source_kind = 'step_result'").all();
    expect(rows).toHaveLength(1);
    expect(events.filter((t) => t === "activity.changed")).toHaveLength(1);
  });

  it("reconciliation backfills terminal rows missing a result activity", () => {
    const ctx = makeCtx([]);
    seedTerminalStepRun(ctx.db, { stepRunId: "s2", goalId: "g1", workflowRunId: "r1", stepName: "Plan" }); // result present, no activity
    reconcileStepResultActivities(ctx);
    const rows = ctx.db.prepare("SELECT * FROM activities WHERE step_run_id = 's2' AND source_kind = 'step_result'").all();
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @orca/daemon -- step-result-activity`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — create `step-result-activity.ts`. Insert a minimal `completed` activity row with `source_kind='step_result'`; rely on the unique index for idempotency (catch the constraint error and treat as already-materialized). Emit `activity.changed` only on actual insert. Reconciliation scans terminal step rows with a non-null `step_result_json` and no `step_result` activity.

```ts
import { randomUUID } from "node:crypto";
import type { DomainEvent } from "@orca/contracts";
import type { ActivityStoreCtx } from "./store.js";

export interface MaterializeInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
}

const SQLITE_CONSTRAINT = "SQLITE_CONSTRAINT_UNIQUE";

export function materializeStepResultActivity(ctx: ActivityStoreCtx, input: MaterializeInput): void {
  const now = ctx.now?.() ?? new Date().toISOString();
  const id = ctx.idFactory?.() ?? randomUUID();
  let event: DomainEvent | undefined;
  ctx.db.transaction(() => {
    const turn = ctx.db
      .prepare("SELECT MAX(turn_ordinal) AS m FROM activities WHERE step_run_id = ?")
      .get(input.stepRunId) as { m: number | null };
    const turnOrdinal = (turn.m ?? -1) + 1;
    try {
      ctx.db
        .prepare(
          `INSERT INTO activities (
             id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal,
             status, current_text, final_summary, source_kind, work_category, confidence,
             pending_question, created_at, updated_at, completed_at
           ) VALUES (?, ?, ?, ?, NULL, ?, 'completed', '', NULL, 'step_result', NULL, NULL, NULL, ?, ?, ?)`
        )
        .run(id, input.goalId, input.workflowRunId, input.stepRunId, turnOrdinal, now, now, now);
    } catch (err) {
      if ((err as { code?: string }).code === SQLITE_CONSTRAINT) return; // already materialized
      throw err;
    }
    const payload = {
      activityId: id, goalId: input.goalId, workflowRunId: input.workflowRunId,
      stepRunId: input.stepRunId, turnOrdinal, status: "completed",
    };
    const eventId = randomUUID();
    const res = ctx.db
      .prepare("INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(eventId, "activity.changed", input.goalId, JSON.stringify(payload), now);
    event = { seq: Number(res.lastInsertRowid), id: eventId, type: "activity.changed", goalId: input.goalId, payload, createdAt: now };
  })();
  if (event !== undefined) ctx.bus.publish(event);
}

export function reconcileStepResultActivities(ctx: ActivityStoreCtx): void {
  const rows = ctx.db
    .prepare(
      `SELECT sr.id AS step_run_id, sr.goal_id, sr.workflow_run_id
       FROM workflow_step_runs sr
       WHERE sr.step_result_json IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM activities a
           WHERE a.step_run_id = sr.id AND a.source_kind = 'step_result'
         )`
    )
    .all() as Array<{ step_run_id: string; goal_id: string; workflow_run_id: string }>;
  for (const r of rows) {
    materializeStepResultActivity(ctx, { goalId: r.goal_id, workflowRunId: r.workflow_run_id, stepRunId: r.step_run_id });
  }
}
```

> Verify the `workflow_step_runs` columns referenced (`goal_id`, `workflow_run_id`, `step_result_json`) against the table — `rg -n "goal_id|workflow_run_id|step_result_json" apps/daemon/migrations/0022_workflow_step_result.sql` (and the table's original DDL). Adjust column names to match exactly.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @orca/daemon -- step-result-activity`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/activities/step-result-activity.ts apps/daemon/src/activities/step-result-activity.test.ts
git commit -m "feat(daemon): idempotent step_result activity materialization + reconciliation"
```

---

### Task 12: Enrich `step_result` activities in the projection

**Files:**
- Modify: `apps/daemon/src/activities/projection.ts`
- Test: `apps/daemon/src/activities/` projection test (`rg -l "listActivitiesByGoal" apps/daemon/src/activities`)

**Agent: Sonnet** — additive join; code provided.

- [ ] **Step 1: Write failing test** — seed a `step_result` activity + a terminal step run with `step_result_json` and a template step name; assert `listActivitiesByGoal` returns the activity with `stepResult` parsed and `stepName` populated.

- [ ] **Step 2: Implement** — in `projection.ts`, after building each `ActivityT`, for rows with `source_kind === 'step_result'` load `step_result_json` and the step name and attach them. Add a helper and use it inside `listActivitiesByGoal`:

```ts
import { Activity, PendingQuestion, WorkflowStepResult, type Activity as ActivityT, type PendingQuestion as PendingQuestionT } from "@orca/contracts";

function enrichStepResult(db: Database.Database, activity: ActivityT): ActivityT {
  if (activity.sourceKind !== "step_result") return activity;
  const row = db
    .prepare(
      `SELECT sr.step_result_json AS result_json, st.name AS step_name
       FROM workflow_step_runs sr
       LEFT JOIN workflow_step_templates st ON st.id = sr.step_template_id
       WHERE sr.id = ?`
    )
    .get(activity.stepRunId) as { result_json: string | null; step_name: string | null } | undefined;
  if (!row?.result_json) return activity;
  return Activity.parse({
    ...activity,
    stepName: row.step_name ?? undefined,
    stepResult: WorkflowStepResult.parse(JSON.parse(row.result_json)),
  });
}
```

Then map: `return rows.map(rowToActivity).map((a) => enrichStepResult(db, a));`

> The step-name source may not be `workflow_step_templates` — templates can be stored denormalized. Confirm with `rg -n "step.*name|templateId|step_template" apps/daemon/src/workflows/steps/projection.ts` and use whatever join `workflows/steps/projection.ts:45` already uses to resolve a step's name. Match that existing query.

- [ ] **Step 3: Run + commit**

Run: `npm test -w @orca/daemon -- activit` → PASS

```bash
git add apps/daemon/src/activities/projection.ts apps/daemon/src/activities/
git commit -m "feat(daemon): project step_result activities with parsed result + step name"
```

---

### Task 13: Materialize at the terminal transition + reconcile at startup

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts` (after `step_result_json` is persisted at `:1802`, and the blocked/failed transitions in `workflows/steps/usecases.ts:281,344,377`)
- Modify: the daemon startup wiring (`apps/daemon/src/server.ts`) to call `reconcileStepResultActivities` once after migrations.
- Test: `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts` + a startup/reconcile test.

**Agent: GPT 5.5** — integration across multiple terminal write sites + startup wiring; must fire for all terminal states (completed/blocked/failed/cancelled).

- [ ] **Step 1:** Identify every site that persists `step_result_json` (Phase-A grep already found them: `service.ts:1802`, `usecases.ts:281/344/377`). After each successful persist + terminal workflow event emission, call `materializeStepResultActivity(activityCtx, { goalId, workflowRunId, stepRunId })`. Thread an `ActivityStoreCtx` (db + bus) into these paths the same way events are already published.

- [ ] **Step 2:** Write a test: drive a normal completion (Phase-A approve path) and assert exactly one `activities` row with `source_kind='step_result'` exists for the step run and an `activity.changed` event was published. Repeat for a blocked and a failed transition.

- [ ] **Step 3:** In `server.ts`, after migrations run and the activity store/bus exist, call `reconcileStepResultActivities(activityCtx)` once. Write a test that a terminal step row with a result but no activity gets backfilled on this call.

- [ ] **Step 4:** Run + commit

Run: `npm test -w @orca/daemon -- service.agent-step activit` → PASS

```bash
git add apps/daemon/src/workflows apps/daemon/src/server.ts
git commit -m "feat(daemon): materialize step_result activity on every terminal transition + startup reconcile"
```

> Guardrail: materialization must never throw out of the terminal transaction in a way that blocks workflow advancement — it is presentation. Wrap the call so a projection failure is logged, not propagated (mirror how `activity.changed` publication is already best-effort).

---

# Phase D — Desktop result card

### Task 14: Render the result card in the Activity Thread

**Files:**
- Modify: `apps/desktop/src/orchestrator/ActivityThread.tsx`
- Test: `apps/desktop/src/orchestrator/ActivityThread.test.tsx`

**Agent: Sonnet** — pure rendering from typed data; full code provided.

- [ ] **Step 1: Write failing tests** in `ActivityThread.test.tsx` (mirror the existing render/test setup in that file):

```tsx
function stepResultActivity(over: Partial<Activity> = {}): Activity {
  return {
    id: "res1", goalId: "g1", workflowRunId: "r1", stepRunId: "s1", agentSessionId: null,
    turnOrdinal: 9, status: "completed", currentText: "", finalSummary: null,
    sourceKind: "step_result", workCategory: null, confidence: null,
    createdAt: "2026-06-09T00:00:00.000Z", updatedAt: "2026-06-09T00:00:00.000Z", completedAt: "2026-06-09T00:00:00.000Z",
    stepName: "Investigate",
    stepResult: {
      stepId: "s1", stepStatus: "completed", evaluationStatus: "scored", successScore: 0.82,
      quality: { outputCompleteness: 0.8, outputCorrectness: 0.85, instructionAdherence: 0.9, downstreamReadiness: 0.8, riskLevel: 0.2 },
      performance: { durationSeconds: 96, retries: 0 },
      outcome: { reason: "Output complete.", producedArtifactsCount: 1, blockingIssuesCount: 0, warningsCount: 0, handoffReady: true },
    },
    ...over,
  } as Activity;
}

it("renders a scored result card with a percentage and expands to metrics", () => {
  render(<ActivityThread goalId="g1" activities={[stepResultActivity()]} renderQuestionForm={() => null} />);
  const card = screen.getByTestId("step-result-card");
  expect(card).toHaveTextContent("Investigate");
  expect(card).toHaveTextContent("82%");
  fireEvent.click(screen.getByTestId("step-result-expand"));
  expect(card).toHaveTextContent("Instruction adherence");
});

it("shows 'Evaluation failed' and never a percentage for failed evaluation", () => {
  const failed = stepResultActivity({
    stepResult: { ...stepResultActivity().stepResult!, evaluationStatus: "failed", successScore: 0, quality: { outputCompleteness: 0, outputCorrectness: 0, instructionAdherence: 0, downstreamReadiness: 0, riskLevel: 1 }, outcome: { ...stepResultActivity().stepResult!.outcome, reason: "step result evaluation failed: shadow timeout", handoffReady: false } },
  });
  render(<ActivityThread goalId="g1" activities={[failed]} renderQuestionForm={() => null} />);
  const card = screen.getByTestId("step-result-card");
  expect(card).toHaveTextContent("Evaluation failed");
  expect(card).not.toHaveTextContent("%");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @orca/desktop -- ActivityThread`
Expected: FAIL — no `step-result-card` testid.

- [ ] **Step 3: Implement** — add a `StepResultCard` and render `step_result` activities. In `ActivityThread.tsx`:

```tsx
import { useState } from "react";

const pct = (v: number) => `${Math.round(v * 100)}%`;

function StepResultCard({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const r = activity.stepResult;
  if (!r) return null;
  const scored = r.evaluationStatus === "scored";
  return (
    <div className="step-result-card" data-testid="step-result-card" data-status={r.stepStatus} data-eval={r.evaluationStatus}>
      <div className="step-result-head">
        <span className="step-result-name">{activity.stepName ?? "Step"}</span>
        <span className="step-result-state">{r.stepStatus}</span>
        {scored ? <span className="step-result-score">{pct(r.successScore)}</span> : <span className="step-result-eval-failed">Evaluation failed</span>}
        {scored ? <span className="step-result-handoff">{r.outcome.handoffReady ? "Ready for handoff" : "Not ready"}</span> : null}
        <button type="button" data-testid="step-result-expand" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Details"}</button>
      </div>
      <div className="step-result-reason">{r.outcome.reason}</div>
      <div className="step-result-counts">
        {r.outcome.producedArtifactsCount} artifacts · {r.outcome.blockingIssuesCount} blockers · {r.outcome.warningsCount} warnings
      </div>
      {open ? (
        <dl className="step-result-metrics">
          {scored ? (
            <>
              <div><dt>Output completeness</dt><dd>{pct(r.quality.outputCompleteness)}</dd></div>
              <div><dt>Output correctness</dt><dd>{pct(r.quality.outputCorrectness)}</dd></div>
              <div><dt>Instruction adherence</dt><dd>{pct(r.quality.instructionAdherence)}</dd></div>
              <div><dt>Downstream readiness</dt><dd>{pct(r.quality.downstreamReadiness)}</dd></div>
              <div><dt>Risk level (higher = riskier)</dt><dd>{pct(r.quality.riskLevel)}</dd></div>
            </>
          ) : null}
          <div><dt>Duration</dt><dd>{r.performance.durationSeconds}s</dd></div>
          <div><dt>Retries</dt><dd>{r.performance.retries}</dd></div>
          {r.performance.totalTurns !== undefined ? <div><dt>Total turns</dt><dd>{r.performance.totalTurns}</dd></div> : null}
          {r.performance.toolCalls !== undefined ? <div><dt>Tool calls</dt><dd>{r.performance.toolCalls}</dd></div> : null}
        </dl>
      ) : null}
    </div>
  );
}
```

Render result cards in document order alongside summaries. Replace the `completed.map(...)` block so each completed activity renders either its summary (existing behavior) or a `StepResultCard` when `sourceKind === "step_result"`:

```tsx
  const terminalCards = activities.filter(
    (a) => isMeaningfulCompleted(a) || a.sourceKind === "step_result"
  );
```

```tsx
      {terminalCards.map((activity) =>
        activity.sourceKind === "step_result" ? (
          <StepResultCard key={activity.id} activity={activity} />
        ) : (
          <div key={activity.id} className="activity-summary" data-testid="activity-summary">
            {activity.finalSummary}
          </div>
        )
      )}
```

> Ordering: `activities` already arrives ordered by `created_at, id` (projection query), and the result activity is materialized after the step's worker-turn summaries, so it naturally sorts last for the step. Do not re-sort here.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w @orca/desktop -- ActivityThread`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/orchestrator/ActivityThread.tsx apps/desktop/src/orchestrator/ActivityThread.test.tsx
git commit -m "feat(desktop): render terminal step-result cards in the Activity Thread"
```

---

### Task 15: Full verification sweep

**Agent: Sonnet** — run commands, read output, fix only what the output names.

- [ ] **Step 1: Typecheck the workspaces**

Run: `npm run typecheck -w @orca/contracts && npm run typecheck -w @orca/daemon`
Expected: no errors. (Desktop: run its typecheck script if present — `node -p "require('./apps/desktop/package.json').scripts"`.)

- [ ] **Step 2: Full test run**

Run: `npm test -w @orca/contracts && npm test -w @orca/daemon && npm test -w @orca/desktop`
Expected: all green.

- [ ] **Step 3: Negative-path confirmation (spec acceptance)** — confirm by grep that no scoring/selection/synthesis path can reach the SDK for shadow-only adapters:

Run: `rg -n "runSdkOneShot|provider.complete|claude -p" apps/daemon/src/workflows`
Expected: every remaining `runSdkOneShot` site is guarded by an `one_shot`-enabled check (Task 8).

- [ ] **Step 4: Commit any fixes, then finish**

```bash
git add -A && git commit -m "chore: verification fixes for step-result scoring + activity visibility"
```

---

## Spec coverage check

| Spec section | Task(s) |
|---|---|
| Normal completion scored in one shadow turn | 1, 3, 4 |
| Approval survives missing/malformed scoring | 1, 4 |
| Combine shadow scoring + daemon facts → `WorkflowStepResult` | 2, 4 |
| Worker-exit recovery (bounded shadow turn) | 6, 7 |
| Replay/reconciliation → evaluation-failed, no model call | 5, 11 |
| Disable Claude model operators; audit selector/synthesize | 8 |
| `step_result_json` stays canonical; payloads identifier-only | 9, 11 (activity stores no result; projection joins) |
| `step_result` activity source kind + result-card data | 9, 12 |
| Idempotent materialization (one per step run) | 10, 11 |
| Startup reconciliation | 11, 13 |
| Materialize on every terminal transition + `activity.changed` | 13 |
| Deterministic card ordering after turn summaries | 11 (turn_ordinal), 14 |
| Collapsed card + expandable metrics | 14 |
| `Evaluation failed` never shows `0%` | 14 |
| All terminal states render cards | 13, 14 |
| Reliability bar = unit tests (no eval gate) | 1, 3, 4 tests |

---

## Notes for the executor

- **Run tests before editing** any file flagged with a "confirm/verify against source" guardrail — several joins and helper signatures must be matched to existing code, and the failing test/typecheck output is the fastest way to see the exact shape.
- **Phase order matters:** A → C depend on Phase A's `buildScoredStepResult`/contracts; D depends on C's contract fields. B is independent of C/D and can be done after A.
- **Never let presentation block workflow state:** materialization/projection failures are logged, not thrown (Task 13 guardrail).
