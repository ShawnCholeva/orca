import { describe, expect, it } from "vitest";
import type { WorkflowGraph } from "@orca/contracts";
import { gateApprovalsByStep } from "./gate-review.js";

const graph: WorkflowGraph = {
  nodes: [
    { id: "proposal", type: "step", name: "Proposal", stepId: "proposal" },
    { id: "critique", type: "gate", name: "Critique", instructions: "x" },
    { id: "execution", type: "step", name: "Execution", stepId: "execution", terminal: true },
  ],
  edges: [
    { from: "proposal", to: "critique" },
    { from: "critique", to: "execution", port: "approved" },
    { from: "critique", to: "proposal", port: "rejected" },
  ],
  positions: {},
} as never;

describe("gateApprovalsByStep", () => {
  it("maps an approved gate decision to its predecessor step + run", () => {
    const m = gateApprovalsByStep(graph, [{ nodeId: "critique", outcome: "approved", workflowRunId: "r1" }]);
    expect(m.get("proposal")?.has("r1")).toBe(true);
  });
  it("ignores rejected decisions", () => {
    const m = gateApprovalsByStep(graph, [{ nodeId: "critique", outcome: "rejected", workflowRunId: "r1" }]);
    expect(m.get("proposal")?.has("r1") ?? false).toBe(false);
  });
  it("ignores a gate with no step predecessor", () => {
    const m = gateApprovalsByStep(graph, [{ nodeId: "unknown_gate", outcome: "approved", workflowRunId: "r1" }]);
    expect(m.size).toBe(0);
  });
});
