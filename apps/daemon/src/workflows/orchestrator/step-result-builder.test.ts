import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { buildApprovalStepResult, type StepResultBuilderDeps } from "./step-result-builder.js";
import type { StepRunRow } from "./db-rows.js";

const stepRun: StepRunRow = {
  id: "step-1",
  goal_id: "goal-1",
  workflow_run_id: "run-1",
  step_template_id: "tpl-1",
  ordinal: 0,
  attempt: 1,
  status: "active",
  started_at: "2026-06-09T00:00:00.000Z",
  selected_operator_id: null,
  selected_model_id: null,
  revise_attempts: 0,
  crash_retries: 0,
  step_result_json: null,
  pending_provider_recovery_json: null,
  pending_judge_json: null,
  pending_revision_json: null,
};

const deps: StepResultBuilderDeps = {
  broker: { propose: async () => ({ status: "needs_human_review", attemptId: "a1", reviewPayloadId: "r1" }) },
  readStepOutputAsRecord: () => null,
  retryCount: () => 0,
  artifactCountForStep: () => 0,
};

describe("buildApprovalStepResult", () => {
  it("scores a fresh approval proposal (reasoning present)", () => {
    const db = new Database(":memory:");
    const result = buildApprovalStepResult(
      deps,
      db,
      { stepRun },
      {
        reasoning: "output meets requirements",
        successScore: 0.9,
        quality: {
          outputCompleteness: 0.9,
          outputCorrectness: 0.9,
          instructionAdherence: 0.9,
          downstreamReadiness: 0.9,
          riskLevel: 0.1,
        },
        reason: "Done.",
        handoffReady: true,
      },
      "2026-06-09T00:01:00.000Z"
    );
    db.close();
    expect(result.evaluationStatus).toBe("scored");
    expect(result.successScore).toBe(0.9);
  });

  // Regression: a step parked at a human-confirmation checkpoint BEFORE reasoning
  // became required (Phase 5.5) stashed a scoring proposal with no `reasoning`
  // field. Re-parsing that stash on human-confirm must still score the step --
  // not silently degrade to a non-blocking evaluation-failure result.
  it("re-parses a pre-5.5 stashed scoring proposal that lacks reasoning", () => {
    const db = new Database(":memory:");
    const result = buildApprovalStepResult(
      deps,
      db,
      { stepRun },
      {
        successScore: 0.7,
        quality: {
          outputCompleteness: 0.7,
          outputCorrectness: 0.7,
          instructionAdherence: 0.7,
          downstreamReadiness: 0.7,
          riskLevel: 0.3,
        },
        reason: "Pre-5.5 completion.",
        handoffReady: true,
      },
      "2026-06-09T00:01:00.000Z"
    );
    db.close();
    expect(result.evaluationStatus).toBe("scored");
    expect(result.successScore).toBe(0.7);
    expect(result.outcome.reason).toBe("Pre-5.5 completion.");
  });
});
