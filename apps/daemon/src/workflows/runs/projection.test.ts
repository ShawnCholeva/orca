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
