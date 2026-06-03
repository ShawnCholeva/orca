# Workflow Step Result Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a strict hidden `stepResult` for every terminal workflow step, with daemon-owned facts, orchestrator-owned scoring, and explicit daemon-authored evaluation-failure results when scoring cannot complete.

**Architecture:** Add a shared `WorkflowStepResult` contract and persist it as `workflow_step_runs.step_result_json`. Low-level step usecases always persist a valid result on terminal transitions; orchestrator code attempts scoring before terminalization and passes the scored result into those usecases. If no scored result is supplied, the daemon writes an explicit `evaluationStatus: "failed"` result from measured facts.

**Tech Stack:** TypeScript, Zod contracts in `@orca/contracts`, SQLite migrations via `better-sqlite3`, daemon workflow usecases, orchestration transport broker, Vitest.

---

## File Structure

- `packages/contracts/src/workflows/index.ts`
  - Add `WorkflowStepResult*` schemas and types.
  - Add `score_step_result` to `OrchestrationDecisionKind`.
  - Add `StepResultScoringRequest` and `StepResultScoringProposal`.
  - Add `stepResult` to `WorkflowStepRun`.

- `packages/contracts/src/__tests__/workflow-contracts.test.ts`
  - Contract tests for scored results, evaluation-failed results, score bounds, missing fields, and `WorkflowStepRun.stepResult`.

- `apps/daemon/migrations/0022_workflow_step_result.sql`
  - Add `step_result_json` to `workflow_step_runs`.

- `apps/daemon/src/migrations.ts`
  - Register migration `0022_workflow_step_result.sql`.

- `apps/daemon/src/migrations.test.ts`
  - Update expected migration list and assert the column exists.

- `apps/daemon/src/workflows/steps/step-result.ts`
  - New focused daemon helper for measured step-result facts, status mapping, fallback evaluation-failure result, and strict serialization.

- `apps/daemon/src/workflows/steps/projection.ts`
  - Read `step_result_json` and expose parsed `stepResult`.

- `apps/daemon/src/workflows/steps/usecases.ts`
  - Persist `step_result_json` during `advanceToNextStep`, `markStepBlocked`, and `failStep`.
  - Accept an optional pre-scored `WorkflowStepResult`; otherwise build daemon evaluation-failed result.

- `apps/daemon/src/workflows/steps/projection.test.ts`
  - Assert active steps expose `stepResult: null` and terminal rows expose parsed results.

- `apps/daemon/src/workflows/steps/usecases.test.ts`
  - Assert terminal transitions persist strict results for completed, blocked, and failed steps.

- `apps/daemon/src/workflows/orchestrator/step-result-scoring.ts`
  - New orchestrator helper that calls the broker with `score_step_result` and validates proposals.

- `apps/daemon/src/workflows/orchestrator/step-result-scoring.test.ts`
  - Unit tests for successful scoring, invalid proposal rejection, and non-proposed broker results.

- `apps/daemon/src/workflows/orchestrator/service.ts`
  - Before advancing a completed step, attempt orchestrator scoring and pass the result to the step usecase.
  - Preserve current behavior if scoring fails: step advances and receives a daemon-authored evaluation-failed result.

- `apps/daemon/src/workflows/orchestrator/session-completion.test.ts`
  - Assert session completion writes scored result when broker scores and writes failed-evaluation result when scoring proposal fails.

---

### Task 1: Contracts

**Files:**
- Modify: `packages/contracts/src/workflows/index.ts`
- Modify: `packages/contracts/src/__tests__/workflow-contracts.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add imports in `packages/contracts/src/__tests__/workflow-contracts.test.ts`:

```ts
import {
  StepResultScoringProposal,
  StepResultScoringRequest,
  WorkflowStepResult,
  WorkflowStepRun,
} from "../workflows/index.js";
```

If those names are already imported through the existing grouped import, add them to that existing import instead.

Add tests near the existing workflow entity contract tests:

```ts
describe("WorkflowStepResult", () => {
  const scoredResult = {
    stepId: "step-run-1",
    stepStatus: "completed",
    evaluationStatus: "scored",
    successScore: 0.92,
    quality: {
      outputCompleteness: 0.95,
      outputCorrectness: 0.9,
      instructionAdherence: 0.88,
      downstreamReadiness: 0.91,
      riskLevel: 0.12,
    },
    performance: {
      durationSeconds: 42,
      retries: 1,
    },
    outcome: {
      reason: "Output satisfies the step instructions and is ready for the next step.",
      producedArtifactsCount: 1,
      blockingIssuesCount: 0,
      warningsCount: 1,
      handoffReady: true,
    },
  };

  it("accepts a fully scored result", () => {
    expect(WorkflowStepResult.parse(scoredResult)).toEqual(scoredResult);
  });

  it("accepts an explicit evaluation-failed result", () => {
    const result = {
      ...scoredResult,
      evaluationStatus: "failed",
      successScore: 0,
      quality: {
        outputCompleteness: 0,
        outputCorrectness: 0,
        instructionAdherence: 0,
        downstreamReadiness: 0,
        riskLevel: 1,
      },
      outcome: {
        ...scoredResult.outcome,
        reason: "step result evaluation failed: evaluation proposal did not validate",
        handoffReady: false,
      },
    };
    expect(WorkflowStepResult.parse(result)).toEqual(result);
  });

  it("rejects scores outside 0 through 1", () => {
    const parsed = WorkflowStepResult.safeParse({
      ...scoredResult,
      successScore: 1.2,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects missing required quality fields", () => {
    const parsed = WorkflowStepResult.safeParse({
      ...scoredResult,
      quality: {
        outputCompleteness: 0.95,
        outputCorrectness: 0.9,
        instructionAdherence: 0.88,
        downstreamReadiness: 0.91,
      },
    });
    expect(parsed.success).toBe(false);
  });
});
```

Add a test near orchestration request/proposal tests:

```ts
describe("step result scoring contracts", () => {
  it("accepts scoring requests and proposals", () => {
    const request = {
      step: {
        id: "step-run-1",
        templateId: "execution",
        name: "Execution",
        instructions: "Implement the approved plan.",
        status: "passed",
      },
      goal: {
        id: "goal-1",
        description: "Build the feature.",
      },
      output: { summary: "Implemented." },
      facts: {
        stepId: "step-run-1",
        stepStatus: "completed",
        performance: { durationSeconds: 42, retries: 0 },
        outcome: {
          producedArtifactsCount: 1,
          blockingIssuesCount: 0,
          warningsCount: 0,
        },
      },
    };

    expect(StepResultScoringRequest.parse(request)).toEqual(request);

    const proposal = {
      successScore: 0.9,
      quality: {
        outputCompleteness: 0.9,
        outputCorrectness: 0.85,
        instructionAdherence: 0.95,
        downstreamReadiness: 0.8,
        riskLevel: 0.1,
      },
      reason: "Implementation output is complete enough for downstream QA.",
      handoffReady: true,
    };

    expect(StepResultScoringProposal.parse(proposal)).toEqual(proposal);
  });
});
```

Update the existing `stepRun` fixture to include `stepResult: null`, then add one assertion that `WorkflowStepRun` accepts a parsed terminal result:

```ts
expect(WorkflowStepRun.parse({ ...stepRun, stepResult: scoredResult })).toMatchObject({
  stepResult: scoredResult,
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @orca/contracts exec vitest run src/__tests__/workflow-contracts.test.ts
```

Expected: FAIL with missing exports such as `WorkflowStepResult` or `StepResultScoringRequest`.

- [ ] **Step 3: Implement contract schemas**

In `packages/contracts/src/workflows/index.ts`, add a reusable score schema near the workflow constants:

```ts
const Score01 = z.number().min(0).max(1);
```

Add `score_step_result` to `OrchestrationDecisionKind`:

```ts
export const OrchestrationDecisionKind = z.enum([
  "select_operator",
  "score_transition",
  "repair_artifact",
  "run_audit",
  "run_step_skill",
  "synthesize_step_output",
  "score_step_result",
]);
```

Add the result schemas near `WorkflowStepRunStatus` and before `WorkflowStepRun`:

```ts
export const WorkflowStepResultStatus = z.enum([
  "completed",
  "partial",
  "blocked",
  "failed",
  "cancelled",
]);
export type WorkflowStepResultStatus = z.infer<typeof WorkflowStepResultStatus>;

export const WorkflowStepResultEvaluationStatus = z.enum(["scored", "failed"]);
export type WorkflowStepResultEvaluationStatus = z.infer<
  typeof WorkflowStepResultEvaluationStatus
>;

export const WorkflowStepResultQuality = z
  .object({
    outputCompleteness: Score01,
    outputCorrectness: Score01,
    instructionAdherence: Score01,
    downstreamReadiness: Score01,
    riskLevel: Score01,
  })
  .strict();
export type WorkflowStepResultQuality = z.infer<typeof WorkflowStepResultQuality>;

export const WorkflowStepResultPerformance = z
  .object({
    durationSeconds: z.number().int().nonnegative(),
    retries: z.number().int().nonnegative(),
    totalTurns: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
  })
  .strict();
export type WorkflowStepResultPerformance = z.infer<
  typeof WorkflowStepResultPerformance
>;

export const WorkflowStepResultOutcome = z
  .object({
    reason: z.string().min(1).max(WORKFLOW_FAILURE_MAX_MESSAGE_CHARS),
    producedArtifactsCount: z.number().int().nonnegative(),
    blockingIssuesCount: z.number().int().nonnegative(),
    warningsCount: z.number().int().nonnegative(),
    handoffReady: z.boolean(),
  })
  .strict();
export type WorkflowStepResultOutcome = z.infer<typeof WorkflowStepResultOutcome>;

export const WorkflowStepResult = z
  .object({
    stepId: Id,
    stepStatus: WorkflowStepResultStatus,
    evaluationStatus: WorkflowStepResultEvaluationStatus,
    successScore: Score01,
    quality: WorkflowStepResultQuality,
    performance: WorkflowStepResultPerformance,
    outcome: WorkflowStepResultOutcome,
  })
  .strict();
export type WorkflowStepResult = z.infer<typeof WorkflowStepResult>;
```

Add `stepResult` to `WorkflowStepRun`:

```ts
stepResult: WorkflowStepResult.nullable(),
```

Add scoring request/proposal schemas near `SynthesisRequest` / `SynthesisProposal`:

```ts
export const StepResultScoringFacts = z
  .object({
    stepId: Id,
    stepStatus: WorkflowStepResultStatus,
    performance: WorkflowStepResultPerformance,
    outcome: z
      .object({
        producedArtifactsCount: z.number().int().nonnegative(),
        blockingIssuesCount: z.number().int().nonnegative(),
        warningsCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type StepResultScoringFacts = z.infer<typeof StepResultScoringFacts>;

export const StepResultScoringRequest = z
  .object({
    step: z
      .object({
        id: Id,
        templateId: Id100,
        name: z.string().min(1).max(WORKFLOW_TEMPLATE_MAX_NAME_CHARS),
        instructions: BoundedString(
          WORKFLOW_STEP_MAX_INSTRUCTIONS_BYTES,
          "instructions"
        ),
        status: WorkflowStepRunStatus,
      })
      .strict(),
    goal: z
      .object({
        id: Id,
        description: BoundedString(WORKFLOW_TEMPLATE_MAX_DESCRIPTION_BYTES, "description"),
      })
      .strict(),
    output: z.record(z.unknown()).nullable(),
    facts: StepResultScoringFacts,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!hasMaxSerializedBytes(value, ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `StepResultScoringRequest must be at most ${ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES} bytes when serialized`,
      });
    }
  });
export type StepResultScoringRequest = z.infer<typeof StepResultScoringRequest>;

export const StepResultScoringProposal = z
  .object({
    successScore: Score01,
    quality: WorkflowStepResultQuality,
    reason: z.string().min(1).max(WORKFLOW_FAILURE_MAX_MESSAGE_CHARS),
    handoffReady: z.boolean(),
  })
  .strict();
export type StepResultScoringProposal = z.infer<typeof StepResultScoringProposal>;
```

- [ ] **Step 4: Run contract tests**

Run:

```bash
pnpm --filter @orca/contracts exec vitest run src/__tests__/workflow-contracts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit contracts**

```bash
git add packages/contracts/src/workflows/index.ts packages/contracts/src/__tests__/workflow-contracts.test.ts
git commit -m "feat(contracts): add workflow step results"
```

---

### Task 2: Migration and Projection

**Files:**
- Create: `apps/daemon/migrations/0022_workflow_step_result.sql`
- Modify: `apps/daemon/src/migrations.ts`
- Modify: `apps/daemon/src/migrations.test.ts`
- Modify: `apps/daemon/src/workflows/steps/projection.ts`
- Modify: `apps/daemon/src/workflows/steps/projection.test.ts`

- [ ] **Step 1: Write failing projection test**

In `apps/daemon/src/workflows/steps/projection.test.ts`, add this helper result object near the existing test setup:

```ts
const scoredStepResult = {
  stepId: "sr1",
  stepStatus: "completed",
  evaluationStatus: "scored",
  successScore: 0.9,
  quality: {
    outputCompleteness: 0.9,
    outputCorrectness: 0.8,
    instructionAdherence: 0.95,
    downstreamReadiness: 0.85,
    riskLevel: 0.1,
  },
  performance: {
    durationSeconds: 60,
    retries: 0,
  },
  outcome: {
    reason: "Ready for downstream use.",
    producedArtifactsCount: 1,
    blockingIssuesCount: 0,
    warningsCount: 0,
    handoffReady: true,
  },
};
```

Add tests:

```ts
it("returns null stepResult for active steps", () => {
  const result = getWorkflowStepRunById(db, "sr1");
  expect(result?.stepResult).toBeNull();
});

it("parses step_result_json for terminal steps", () => {
  db.prepare("UPDATE workflow_step_runs SET status = 'passed', step_result_json = ? WHERE id = ?")
    .run(JSON.stringify(scoredStepResult), "sr1");

  resetWorkflowStepProjectionPreparedStatements();

  const result = getWorkflowStepRunById(db, "sr1");
  expect(result?.stepResult).toEqual(scoredStepResult);
});
```

- [ ] **Step 2: Write failing migration test**

In `apps/daemon/src/migrations.test.ts`, add `"0022_workflow_step_result.sql"` to the expected `applied` list after `0021_workflow_template_scope_graph.sql`.

Add this assertion to the test that checks created schema details:

```ts
const stepRunColumns = db
  .prepare("PRAGMA table_info(workflow_step_runs)")
  .all() as Array<{ name: string }>;
expect(stepRunColumns.map((column) => column.name)).toContain("step_result_json");
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm --filter @orca/daemon test -- src/migrations.test.ts src/workflows/steps/projection.test.ts
```

Expected: FAIL because the migration file and projection column do not exist.

- [ ] **Step 4: Add migration**

Create `apps/daemon/migrations/0022_workflow_step_result.sql`:

```sql
-- 0022_workflow_step_result.sql
ALTER TABLE workflow_step_runs ADD COLUMN step_result_json TEXT;
```

In `apps/daemon/src/migrations.ts`, append the migration:

```ts
  "0021_workflow_template_scope_graph.sql",
  "0022_workflow_step_result.sql",
] as const;
```

- [ ] **Step 5: Update projection**

In `apps/daemon/src/workflows/steps/projection.ts`, update imports:

```ts
import {
  WorkflowStepResult,
  WorkflowStepRun,
  type WorkflowStepRun as WorkflowStepRunT,
} from "@orca/contracts";
```

Add `step_result_json` to `WorkflowStepRunRow`:

```ts
step_result_json: string | null;
```

Update the SELECT:

```ts
"SELECT id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, started_at, finished_at, blocked_reason, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at, step_result_json FROM workflow_step_runs WHERE id = ?"
```

Parse the result inside `rowToStepRun`:

```ts
const stepResult = row.step_result_json
  ? WorkflowStepResult.parse(JSON.parse(row.step_result_json))
  : null;
```

Add it to `WorkflowStepRun.parse`:

```ts
stepResult,
```

- [ ] **Step 6: Run migration and projection tests**

Run:

```bash
pnpm --filter @orca/daemon test -- src/migrations.test.ts src/workflows/steps/projection.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit migration/projection**

```bash
git add apps/daemon/migrations/0022_workflow_step_result.sql apps/daemon/src/migrations.ts apps/daemon/src/migrations.test.ts apps/daemon/src/workflows/steps/projection.ts apps/daemon/src/workflows/steps/projection.test.ts
git commit -m "feat(daemon): persist step result column"
```

---

### Task 3: Daemon Step Result Builder and Terminal Usecases

**Files:**
- Create: `apps/daemon/src/workflows/steps/step-result.ts`
- Modify: `apps/daemon/src/workflows/steps/usecases.ts`
- Modify: `apps/daemon/src/workflows/steps/usecases.test.ts`

- [ ] **Step 1: Write failing builder tests**

Create `apps/daemon/src/workflows/steps/step-result.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildEvaluationFailedStepResult,
  mapStepRunStatusToResultStatus,
} from "./step-result.js";

describe("workflow step result builder", () => {
  it("maps terminal step statuses", () => {
    expect(mapStepRunStatusToResultStatus("passed")).toBe("completed");
    expect(mapStepRunStatusToResultStatus("blocked")).toBe("blocked");
    expect(mapStepRunStatusToResultStatus("failed")).toBe("failed");
    expect(mapStepRunStatusToResultStatus("skipped")).toBe("cancelled");
  });

  it("rejects non-terminal status mapping", () => {
    expect(() => mapStepRunStatusToResultStatus("active")).toThrow(/non-terminal/);
  });

  it("builds explicit evaluation-failed result", () => {
    const result = buildEvaluationFailedStepResult({
      stepId: "step-1",
      stepStatus: "completed",
      startedAt: "2026-06-03T00:00:00.000Z",
      finishedAt: "2026-06-03T00:01:05.000Z",
      retries: 2,
      producedArtifactsCount: 1,
      blockingIssuesCount: 0,
      warningsCount: 0,
      reason: "model timed out",
    });

    expect(result).toMatchObject({
      stepId: "step-1",
      stepStatus: "completed",
      evaluationStatus: "failed",
      successScore: 0,
      quality: {
        outputCompleteness: 0,
        outputCorrectness: 0,
        instructionAdherence: 0,
        downstreamReadiness: 0,
        riskLevel: 1,
      },
      performance: {
        durationSeconds: 65,
        retries: 2,
      },
      outcome: {
        reason: "step result evaluation failed: model timed out",
        producedArtifactsCount: 1,
        blockingIssuesCount: 0,
        warningsCount: 0,
        handoffReady: false,
      },
    });
  });
});
```

- [ ] **Step 2: Write failing usecase tests**

In `apps/daemon/src/workflows/steps/usecases.test.ts`, update the local row SELECT helper to include `step_result_json`.

Add this helper:

```ts
function readStepResultJson(id: string) {
  const row = db
    .prepare("SELECT step_result_json FROM workflow_step_runs WHERE id = ?")
    .get(id) as { step_result_json: string | null };
  expect(row.step_result_json).toBeTruthy();
  return JSON.parse(row.step_result_json!) as unknown;
}
```

Add tests:

```ts
it("advanceToNextStep persists provided scored step result", () => {
  const run = startWorkflowRun(ctx, goal.id, "orca/engineering");
  const first = createInitialStep(db, () => NOW, run.id);
  const scored = {
    stepId: first.id,
    stepStatus: "completed",
    evaluationStatus: "scored",
    successScore: 0.87,
    quality: {
      outputCompleteness: 0.9,
      outputCorrectness: 0.8,
      instructionAdherence: 0.9,
      downstreamReadiness: 0.85,
      riskLevel: 0.2,
    },
    performance: {
      durationSeconds: 0,
      retries: 0,
    },
    outcome: {
      reason: "Ready for the next step.",
      producedArtifactsCount: 0,
      blockingIssuesCount: 0,
      warningsCount: 0,
      handoffReady: true,
    },
  };

  advanceToNextStep(db, () => NOW, first.id, undefined, scored);

  expect(readStepResultJson(first.id)).toEqual(scored);
});

it("markStepBlocked persists daemon evaluation-failed step result", () => {
  const run = startWorkflowRun(ctx, goal.id, "orca/engineering");
  const first = createInitialStep(db, () => NOW, run.id);

  markStepBlocked(db, () => NOW, first.id, "Need input");

  expect(readStepResultJson(first.id)).toMatchObject({
    stepId: first.id,
    stepStatus: "blocked",
    evaluationStatus: "failed",
    successScore: 0,
    outcome: {
      reason: "step result evaluation failed: orchestrator scoring not supplied",
      blockingIssuesCount: 1,
      handoffReady: false,
    },
  });
});

it("failStep persists daemon evaluation-failed step result", () => {
  const run = startWorkflowRun(ctx, goal.id, "orca/engineering");
  const first = createInitialStep(db, () => NOW, run.id);

  failStep(db, () => NOW, first.id);

  expect(readStepResultJson(first.id)).toMatchObject({
    stepId: first.id,
    stepStatus: "failed",
    evaluationStatus: "failed",
    successScore: 0,
    outcome: {
      reason: "step result evaluation failed: orchestrator scoring not supplied",
      blockingIssuesCount: 1,
      handoffReady: false,
    },
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm --filter @orca/daemon test -- src/workflows/steps/step-result.test.ts src/workflows/steps/usecases.test.ts
```

Expected: FAIL because `step-result.ts`, function signatures, and `step_result_json` writes do not exist.

- [ ] **Step 4: Implement step result builder**

Create `apps/daemon/src/workflows/steps/step-result.ts`:

```ts
import {
  WORKFLOW_FAILURE_MAX_MESSAGE_CHARS,
  WorkflowStepResult,
  type WorkflowStepResult as WorkflowStepResultT,
  type WorkflowStepResultStatus,
} from "@orca/contracts";
import { redactSecrets } from "../../memory/normalize.js";

type TerminalStepRunStatus = "passed" | "blocked" | "failed" | "skipped";

export interface StepResultFactsInput {
  stepId: string;
  stepStatus: WorkflowStepResultStatus;
  startedAt: string | null;
  finishedAt: string;
  retries: number;
  producedArtifactsCount: number;
  blockingIssuesCount: number;
  warningsCount: number;
}

export interface EvaluationFailedStepResultInput extends StepResultFactsInput {
  reason: string;
}

export function mapStepRunStatusToResultStatus(status: string): WorkflowStepResultStatus {
  switch (status as TerminalStepRunStatus) {
    case "passed":
      return "completed";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "skipped":
      return "cancelled";
    default:
      throw new Error(`non-terminal step status cannot produce step_result: ${status}`);
  }
}

export function durationSeconds(startedAt: string | null, finishedAt: string): number {
  if (!startedAt) return 0;
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished <= started) {
    return 0;
  }
  return Math.floor((finished - started) / 1000);
}

export function sanitizeStepResultReason(reason: string): string {
  const sanitized = redactSecrets(reason.replace(/\s+/g, " ").trim()).slice(
    0,
    WORKFLOW_FAILURE_MAX_MESSAGE_CHARS
  );
  return sanitized.length > 0 ? sanitized : "unknown evaluation failure";
}

export function buildEvaluationFailedStepResult(
  input: EvaluationFailedStepResultInput
): WorkflowStepResultT {
  return WorkflowStepResult.parse({
    stepId: input.stepId,
    stepStatus: input.stepStatus,
    evaluationStatus: "failed",
    successScore: 0,
    quality: {
      outputCompleteness: 0,
      outputCorrectness: 0,
      instructionAdherence: 0,
      downstreamReadiness: 0,
      riskLevel: 1,
    },
    performance: {
      durationSeconds: durationSeconds(input.startedAt, input.finishedAt),
      retries: input.retries,
    },
    outcome: {
      reason: `step result evaluation failed: ${sanitizeStepResultReason(input.reason)}`,
      producedArtifactsCount: input.producedArtifactsCount,
      blockingIssuesCount: input.blockingIssuesCount,
      warningsCount: input.warningsCount,
      handoffReady: false,
    },
  });
}

export function serializeStepResult(result: WorkflowStepResultT): string {
  return JSON.stringify(WorkflowStepResult.parse(result));
}
```

- [ ] **Step 5: Update usecases**

In `apps/daemon/src/workflows/steps/usecases.ts`, update imports:

```ts
import type {
  DomainEvent,
  WorkflowStepResult,
  WorkflowStepRun as WorkflowStepRunT,
} from "@orca/contracts";
import { WorkflowStepResult as WorkflowStepResultSchema } from "@orca/contracts";
```

Import helpers:

```ts
import {
  buildEvaluationFailedStepResult,
  mapStepRunStatusToResultStatus,
  serializeStepResult,
} from "./step-result.js";
```

Extend `WorkflowStepRunRow`:

```ts
revise_attempts?: number;
crash_retries?: number;
step_result_json: string | null;
```

Add helpers below `readStepRow`:

```ts
function retryCount(row: WorkflowStepRunRow): number {
  return Math.max(row.attempt - 1, 0) + (row.revise_attempts ?? 0) + (row.crash_retries ?? 0);
}

function artifactCountForStep(db: Database.Database, stepRunId: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS count FROM workflow_artifacts WHERE step_run_id = ?")
      .get(stepRunId) as { count: number }
  ).count;
}

function terminalIssueCount(status: string): number {
  return status === "blocked" || status === "failed" ? 1 : 0;
}

function terminalStepResult(
  db: Database.Database,
  row: WorkflowStepRunRow,
  terminalStatus: "passed" | "blocked" | "failed" | "skipped",
  finishedAt: string,
  supplied?: WorkflowStepResult
): WorkflowStepResult {
  if (supplied) return WorkflowStepResultSchema.parse(supplied);
  return buildEvaluationFailedStepResult({
    stepId: row.id,
    stepStatus: mapStepRunStatusToResultStatus(terminalStatus),
    startedAt: row.started_at,
    finishedAt,
    retries: retryCount(row),
    producedArtifactsCount: artifactCountForStep(db, row.id),
    blockingIssuesCount: terminalIssueCount(terminalStatus),
    warningsCount: 0,
    reason: "orchestrator scoring not supplied",
  });
}
```

Change `advanceToNextStep` signature:

```ts
export function advanceToNextStep(
  db: Database.Database,
  now: () => string,
  currentStepRunId: string,
  eventOptions?: StepEventOptions,
  suppliedStepResult?: WorkflowStepResult
): WorkflowStepRunT | null {
```

Inside `advanceToNextStep`, replace the step update with:

```ts
const row = readStepRow(db, currentStepRunId);
const result = terminalStepResult(db, row, "passed", timestamp, suppliedStepResult);
db.prepare(
  "UPDATE workflow_step_runs SET status = 'passed', finished_at = ?, blocked_reason = NULL, step_result_json = ? WHERE id = ?"
).run(timestamp, serializeStepResult(result), currentStepRunId);
```

In `markStepBlocked`, set `timestamp`, build result, and update:

```ts
const timestamp = now();
const raw = readStepRow(db, stepRunId);
const result = terminalStepResult(db, raw, "blocked", timestamp);
db.prepare(
  "UPDATE workflow_step_runs SET status = 'blocked', blocked_reason = ?, finished_at = ?, step_result_json = ? WHERE id = ?"
).run(sanitizeReason(reason), timestamp, serializeStepResult(result), stepRunId);
```

Use `timestamp` when emitting the event.

In `failStep`, replace the update:

```ts
const raw = readStepRow(db, stepRunId);
const result = terminalStepResult(db, raw, "failed", timestamp);
db.prepare(
  "UPDATE workflow_step_runs SET status = 'failed', finished_at = ?, step_result_json = ? WHERE id = ?"
).run(timestamp, serializeStepResult(result), stepRunId);
```

- [ ] **Step 6: Run step tests**

Run:

```bash
pnpm --filter @orca/daemon test -- src/workflows/steps/step-result.test.ts src/workflows/steps/usecases.test.ts src/workflows/steps/projection.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit daemon builder/usecases**

```bash
git add apps/daemon/src/workflows/steps/step-result.ts apps/daemon/src/workflows/steps/step-result.test.ts apps/daemon/src/workflows/steps/usecases.ts apps/daemon/src/workflows/steps/usecases.test.ts
git commit -m "feat(daemon): write terminal step results"
```

---

### Task 4: Orchestrator Step Result Scoring Helper

**Files:**
- Create: `apps/daemon/src/workflows/orchestrator/step-result-scoring.ts`
- Create: `apps/daemon/src/workflows/orchestrator/step-result-scoring.test.ts`

- [ ] **Step 1: Write failing scoring helper tests**

Create `apps/daemon/src/workflows/orchestrator/step-result-scoring.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { scoreStepResult, type StepResultScoringInput } from "./step-result-scoring.js";

const input: StepResultScoringInput = {
  goalId: "goal-1",
  workflowRunId: "run-1",
  stepRunId: "step-1",
  providerId: "orca/anthropic",
  modelId: "claude-sonnet-4-6",
  goal: { id: "goal-1", description: "Build the feature." },
  step: {
    id: "step-1",
    templateId: "execution",
    name: "Execution",
    instructions: "Implement the plan.",
    status: "passed",
  },
  output: { summary: "Done." },
  facts: {
    stepId: "step-1",
    stepStatus: "completed",
    performance: { durationSeconds: 30, retries: 0 },
    outcome: {
      producedArtifactsCount: 1,
      blockingIssuesCount: 0,
      warningsCount: 0,
    },
  },
};

describe("scoreStepResult", () => {
  it("returns a strict scored step result", async () => {
    const propose = vi.fn(async (_req, options) => {
      const proposal = {
        successScore: 0.8,
        quality: {
          outputCompleteness: 0.8,
          outputCorrectness: 0.75,
          instructionAdherence: 0.9,
          downstreamReadiness: 0.85,
          riskLevel: 0.2,
        },
        reason: "Ready for handoff.",
        handoffReady: true,
      };
      const validated = await options.validateProposal(proposal);
      return {
        status: "proposed" as const,
        attemptId: "attempt-1",
        transport: "one_shot" as const,
        parsed: validated.accepted ? validated.parsed : proposal,
        rawTextLength: 10,
        latencyMs: 1,
      };
    });

    const result = await scoreStepResult({ broker: { propose } }, input);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.stepResult).toMatchObject({
      stepId: "step-1",
      stepStatus: "completed",
      evaluationStatus: "scored",
      successScore: 0.8,
      outcome: {
        reason: "Ready for handoff.",
        handoffReady: true,
        producedArtifactsCount: 1,
      },
    });
  });

  it("returns failure for invalid proposals", async () => {
    const propose = vi.fn(async (_req, options) => {
      const validated = await options.validateProposal({ successScore: 2 });
      return {
        status: "needs_human_review" as const,
        attemptId: "attempt-1",
        reviewPayloadId: "review-1",
        failureMessage: validated.accepted ? null : validated.failureMessage,
      };
    });

    const result = await scoreStepResult({ broker: { propose } }, input);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/invalid step result scoring proposal/i);
  });

  it("returns failure for non-proposed broker result", async () => {
    const propose = vi.fn(async () => ({
      status: "needs_human_review" as const,
      attemptId: "attempt-1",
      reviewPayloadId: "review-1",
    }));

    const result = await scoreStepResult({ broker: { propose } }, input);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/step result scoring did not produce/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @orca/daemon test -- src/workflows/orchestrator/step-result-scoring.test.ts
```

Expected: FAIL because `step-result-scoring.ts` does not exist.

- [ ] **Step 3: Implement scoring helper**

Create `apps/daemon/src/workflows/orchestrator/step-result-scoring.ts`:

```ts
import {
  OrchestrationRequest,
  StepResultScoringProposal,
  StepResultScoringRequest,
  WorkflowStepResult,
  type ModelProviderId,
  type StepResultScoringFacts,
  type WorkflowStepResult as WorkflowStepResultT,
  type WorkflowStepRunStatus,
} from "@orca/contracts";
import type { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";

export interface StepResultScoringDeps {
  broker: Pick<OrchestrationTransportBroker, "propose">;
}

export interface StepResultScoringInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
  providerId: ModelProviderId;
  modelId: string;
  goal: {
    id: string;
    description: string;
  };
  step: {
    id: string;
    templateId: string;
    name: string;
    instructions: string;
    status: WorkflowStepRunStatus;
  };
  output: Record<string, unknown> | null;
  facts: StepResultScoringFacts;
}

export type StepResultScoringResult =
  | { ok: true; stepResult: WorkflowStepResultT }
  | { ok: false; reason: string };

export async function scoreStepResult(
  deps: StepResultScoringDeps,
  input: StepResultScoringInput
): Promise<StepResultScoringResult> {
  const requestPayload = StepResultScoringRequest.parse({
    step: input.step,
    goal: input.goal,
    output: input.output,
    facts: input.facts,
  });

  const request = OrchestrationRequest.parse({
    kind: "score_step_result",
    goalId: input.goalId,
    workflowRunId: input.workflowRunId,
    stepRunId: input.stepRunId,
    providerId: input.providerId,
    modelId: input.modelId,
    payload: requestPayload,
  });

  const result = await deps.broker.propose(request, {
    validateProposal: (raw) => {
      const proposal = StepResultScoringProposal.safeParse(raw);
      if (!proposal.success) {
        return {
          accepted: false,
          failureMessage: "invalid step result scoring proposal structure",
        };
      }

      const stepResult = WorkflowStepResult.parse({
        stepId: input.facts.stepId,
        stepStatus: input.facts.stepStatus,
        evaluationStatus: "scored",
        successScore: proposal.data.successScore,
        quality: proposal.data.quality,
        performance: input.facts.performance,
        outcome: {
          reason: proposal.data.reason,
          producedArtifactsCount: input.facts.outcome.producedArtifactsCount,
          blockingIssuesCount: input.facts.outcome.blockingIssuesCount,
          warningsCount: input.facts.outcome.warningsCount,
          handoffReady: proposal.data.handoffReady,
        },
      });

      return { accepted: true, parsed: stepResult };
    },
  });

  if (result.status !== "proposed") {
    return { ok: false, reason: "step result scoring did not produce a proposal" };
  }

  const parsed = WorkflowStepResult.safeParse(result.parsed);
  if (!parsed.success) {
    return { ok: false, reason: "invalid step result scoring proposal result" };
  }

  return { ok: true, stepResult: parsed.data };
}
```

- [ ] **Step 4: Run scoring helper tests**

Run:

```bash
pnpm --filter @orca/daemon test -- src/workflows/orchestrator/step-result-scoring.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit scoring helper**

```bash
git add apps/daemon/src/workflows/orchestrator/step-result-scoring.ts apps/daemon/src/workflows/orchestrator/step-result-scoring.test.ts
git commit -m "feat(daemon): score workflow step results"
```

---

### Task 5: Wire Scoring Into Orchestrator Completion

**Files:**
- Modify: `apps/daemon/src/workflows/orchestrator/service.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/session-completion.test.ts`
- Modify: `apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts`

- [ ] **Step 1: Write failing service tests**

In `apps/daemon/src/workflows/orchestrator/session-completion.test.ts`, add a helper:

```ts
function readPersistedStepResult(db: Database.Database, stepRunId: string) {
  const row = db
    .prepare("SELECT step_result_json FROM workflow_step_runs WHERE id = ?")
    .get(stepRunId) as { step_result_json: string | null };
  expect(row.step_result_json).toBeTruthy();
  return JSON.parse(row.step_result_json!);
}
```

Add one test in the successful session-completion describe block:

```ts
it("scores and persists step_result after session completion", async () => {
  const { sessionId, stepRunId } = seedWorkflowWithSession(db);
  const broker = fakeSynthesisBroker({ problem: "solved" });
  const service = makeService(broker.broker, fakeOutputStore(snapshotWithText(sessionId, "done")));

  await service.onWorkflowSessionCompleted(db, () => NOW, { sessionId });

  expect(readPersistedStepResult(db, stepRunId)).toMatchObject({
    stepId: stepRunId,
    stepStatus: "completed",
    evaluationStatus: "scored",
  });
});
```

Update `fakeSynthesisBroker` so it can answer both `synthesize_step_output` and `score_step_result`:

```ts
if ((request as { kind?: string }).kind === "score_step_result") {
  const proposal = {
    successScore: 0.82,
    quality: {
      outputCompleteness: 0.8,
      outputCorrectness: 0.8,
      instructionAdherence: 0.85,
      downstreamReadiness: 0.8,
      riskLevel: 0.2,
    },
    reason: "Ready for next step.",
    handoffReady: true,
  };
  const validated = options?.validateProposal
    ? await options.validateProposal(proposal)
    : { accepted: true as const, parsed: proposal };
  return {
    status: "proposed",
    attemptId: `attempt-${calls}`,
    transport: "one_shot",
    parsed: Object.prototype.hasOwnProperty.call(validated, "parsed")
      ? (validated as { parsed: unknown }).parsed
      : proposal,
    rawTextLength: null,
    latencyMs: 1,
  };
}
```

Add failure test:

```ts
it("persists evaluation-failed step_result when scoring fails", async () => {
  const { sessionId, stepRunId } = seedWorkflowWithSession(db);
  const propose = vi.fn(async (request: { kind?: string }, options?: BrokerCompatibilityOptions) => {
    if (request.kind === "score_step_result") {
      const validated = options?.validateProposal
        ? await options.validateProposal({ successScore: 2 })
        : { accepted: false as const };
      return {
        status: "needs_human_review" as const,
        attemptId: "score-attempt",
        reviewPayloadId: "review-1",
        failureMessage: validated.accepted ? null : validated.failureMessage,
      };
    }
    const validated = options?.validateProposal
      ? await options.validateProposal({ output: { problem: "solved" } })
      : { accepted: true as const, parsed: { output: { problem: "solved" } } };
    return {
      status: "proposed" as const,
      attemptId: "synth-attempt",
      transport: "one_shot" as const,
      parsed: Object.prototype.hasOwnProperty.call(validated, "parsed")
        ? (validated as { parsed: unknown }).parsed
        : { output: { problem: "solved" } },
      rawTextLength: null,
      latencyMs: 1,
    };
  });
  const service = makeService({ propose }, fakeOutputStore(snapshotWithText(sessionId, "done")));

  await service.onWorkflowSessionCompleted(db, () => NOW, { sessionId });

  expect(readPersistedStepResult(db, stepRunId)).toMatchObject({
    stepId: stepRunId,
    stepStatus: "completed",
    evaluationStatus: "failed",
    successScore: 0,
    outcome: {
      handoffReady: false,
    },
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @orca/daemon test -- src/workflows/orchestrator/session-completion.test.ts src/workflows/orchestrator/service.agent-step.test.ts
```

Expected: FAIL because orchestrator code does not score or pass step results into `advanceToNextStep`.

- [ ] **Step 3: Add scoring facts helpers in service**

In `apps/daemon/src/workflows/orchestrator/service.ts`, import:

```ts
import { scoreStepResult } from "./step-result-scoring.js";
import {
  buildEvaluationFailedStepResult,
  durationSeconds,
  mapStepRunStatusToResultStatus,
} from "../steps/step-result.js";
import type { StepResultScoringFacts, WorkflowStepResult } from "@orca/contracts";
```

Add private helpers near `stepRunIdsByTemplateId`:

```ts
private artifactCountForStep(db: Database.Database, stepRunId: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS count FROM workflow_artifacts WHERE step_run_id = ?")
      .get(stepRunId) as { count: number }
  ).count;
}

private retryCount(stepRun: StepRunRow): number {
  return (
    Math.max(stepRun.attempt - 1, 0) +
    (stepRun.revise_attempts ?? 0) +
    (stepRun.crash_retries ?? 0)
  );
}

private scoringFacts(
  db: Database.Database,
  stepRun: StepRunRow,
  terminalStatus: "passed" | "blocked" | "failed" | "skipped",
  finishedAt: string
): StepResultScoringFacts {
  return {
    stepId: stepRun.id,
    stepStatus: mapStepRunStatusToResultStatus(terminalStatus),
    performance: {
      durationSeconds: durationSeconds(stepRun.started_at, finishedAt),
      retries: this.retryCount(stepRun),
    },
    outcome: {
      producedArtifactsCount: this.artifactCountForStep(db, stepRun.id),
      blockingIssuesCount: terminalStatus === "blocked" || terminalStatus === "failed" ? 1 : 0,
      warningsCount: 0,
    },
  };
}
```

Add scoring helper:

```ts
private async scoreCompletedStepResult(
  db: Database.Database,
  now: () => string,
  ctx: {
    run: WorkflowRunT;
    stepRun: StepRunRow;
    stepTpl: WorkflowStepTemplate;
    goal: GoalRow;
  },
  output: Record<string, unknown> | null
): Promise<WorkflowStepResult> {
  const finishedAt = now();
  const facts = this.scoringFacts(db, ctx.stepRun, "passed", finishedAt);
  if (!ctx.goal.orchestrator_provider || !ctx.goal.orchestrator_model) {
    return buildEvaluationFailedStepResult({
      stepId: ctx.stepRun.id,
      stepStatus: facts.stepStatus,
      startedAt: ctx.stepRun.started_at,
      finishedAt,
      retries: facts.performance.retries,
      producedArtifactsCount: facts.outcome.producedArtifactsCount,
      blockingIssuesCount: facts.outcome.blockingIssuesCount,
      warningsCount: facts.outcome.warningsCount,
      reason: "orchestrator model not configured",
    });
  }

  const result = await scoreStepResult(
    { broker: this.broker },
    {
      goalId: ctx.goal.id,
      workflowRunId: ctx.run.id,
      stepRunId: ctx.stepRun.id,
      providerId: ctx.goal.orchestrator_provider,
      modelId: ctx.goal.orchestrator_model,
      goal: { id: ctx.goal.id, description: ctx.goal.description },
      step: {
        id: ctx.stepRun.id,
        templateId: ctx.stepTpl.id,
        name: ctx.stepTpl.name,
        instructions: ctx.stepTpl.instructions,
        status: "passed",
      },
      output,
      facts,
    }
  );

  if (result.ok) return result.stepResult;

  return buildEvaluationFailedStepResult({
    stepId: ctx.stepRun.id,
    stepStatus: facts.stepStatus,
    startedAt: ctx.stepRun.started_at,
    finishedAt,
    retries: facts.performance.retries,
    producedArtifactsCount: facts.outcome.producedArtifactsCount,
    blockingIssuesCount: facts.outcome.blockingIssuesCount,
    warningsCount: facts.outcome.warningsCount,
    reason: result.reason,
  });
}
```

- [ ] **Step 4: Pass scored result into terminal advancement**

Add `stepResultByStepRunId` to the local `RequestNextDecisionOptions` interface in `apps/daemon/src/workflows/orchestrator/service.ts`:

```ts
stepResultByStepRunId?: Record<string, WorkflowStepResult>;
```

In `onWorkflowSessionCompleted`, after creating the `step_output` artifact and before `requestNextDecision`, call:

```ts
const stepResult = await this.scoreCompletedStepResult(
  db,
  now,
  { run, stepRun, stepTpl, goal },
  result.output
);
await this.requestNextDecision(db, now, run.id, { ...options, stepResultByStepRunId: { [stepRun.id]: stepResult } });
```

In `commitAdvanceOrComplete`, change:

```ts
advanceToNextStep(db, now, stepRun.id, {
  idFactory: options.idFactory,
  stagedEvents,
});
```

to:

```ts
advanceToNextStep(
  db,
  now,
  stepRun.id,
  {
    idFactory: options.idFactory,
    stagedEvents,
  },
  options.stepResultByStepRunId?.[stepRun.id]
);
```

In `applyOrchestratorAction` for `approve_step_complete`, parse the block and score before advancing:

```ts
const output = block && typeof block === "object" && !Array.isArray(block)
  ? (block as Record<string, unknown>)
  : null;
const stepResult = await this.scoreCompletedStepResult(db, now, ctx, output);
await this.advanceToNextStep(db, now, ctx.run.id, {
  ...options,
  stepResultByStepRunId: { [ctx.stepRun.id]: stepResult },
});
```

- [ ] **Step 5: Run orchestrator tests**

Run:

```bash
pnpm --filter @orca/daemon test -- src/workflows/orchestrator/session-completion.test.ts src/workflows/orchestrator/service.agent-step.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit orchestrator wiring**

```bash
git add apps/daemon/src/workflows/orchestrator/service.ts apps/daemon/src/workflows/orchestrator/session-completion.test.ts apps/daemon/src/workflows/orchestrator/service.agent-step.test.ts
git commit -m "feat(daemon): score completed workflow steps"
```

---

### Task 6: Full Verification

**Files:**
- No planned file modifications.

- [ ] **Step 1: Run contract verification**

Run:

```bash
pnpm --filter @orca/contracts typecheck
pnpm --filter @orca/contracts exec vitest run src/__tests__/workflow-contracts.test.ts src/workflows/output-schema.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run daemon focused verification**

Run:

```bash
pnpm --filter @orca/daemon typecheck
pnpm --filter @orca/daemon test -- src/migrations.test.ts src/workflows/steps/step-result.test.ts src/workflows/steps/projection.test.ts src/workflows/steps/usecases.test.ts src/workflows/orchestrator/step-result-scoring.test.ts src/workflows/orchestrator/session-completion.test.ts src/workflows/orchestrator/service.agent-step.test.ts
```

Expected: PASS.

- [ ] **Step 3: Inspect generated diffs**

Run:

```bash
git diff --stat
git diff --check
```

Expected:

- `git diff --stat` shows only contracts, daemon, migration, and tests related to step results.
- `git diff --check` exits successfully with no whitespace errors.

- [ ] **Step 4: Final status**

Run:

```bash
git status --short
```

Expected: clean working tree.

---

## Self-Review

- Spec coverage:
  - Strict `WorkflowStepResult`: Task 1.
  - `step_result_json` persistence: Task 2.
  - Terminal steps always get a result: Task 3.
  - Daemon evaluation-failure result: Tasks 3 and 5.
  - Orchestrator-owned subjective scoring: Tasks 4 and 5.
  - Measurement-only behavior: Task 5 keeps advancement on the existing path and passes evaluation-failed results on scoring failure.
  - UI unchanged: no desktop files in plan.

- Placeholder scan:
  - No task uses open-ended implementation instructions. Each code change includes exact paths, function names, snippets, commands, and expected results.

- Type consistency:
  - Contract names use camelCase in TypeScript: `stepResult`, `stepId`, `stepStatus`, `evaluationStatus`, `successScore`, `durationSeconds`.
  - DB column stays snake_case: `step_result_json`.
  - Orchestration decision kind is `score_step_result`.
