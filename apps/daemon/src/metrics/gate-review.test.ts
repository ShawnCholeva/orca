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
  it("keys the map by the predecessor step's stepId, not its node id, when they differ", () => {
    const g3: WorkflowGraph = { nodes: [
      { id: "n1", type: "step", name: "Proposal", stepId: "proposal" },
      { id: "gate", type: "gate", name: "G", instructions: "x" },
      { id: "n2", type: "step", name: "Execution", stepId: "execution", terminal: true },
    ], edges: [
      { from: "n1", to: "gate" },
      { from: "gate", to: "n2", port: "approved" }, { from: "gate", to: "n1", port: "rejected" },
    ], positions: {} } as never;
    const m = gateApprovalsByStep(g3, [{ nodeId: "gate", outcome: "approved", workflowRunId: "r1" }]);
    expect(m.get("proposal")?.has("r1")).toBe(true);
    expect(m.has("n1")).toBe(false);
  });
  it("skips a gate with multiple step predecessors (ambiguous → no credit)", () => {
    const g2: WorkflowGraph = { nodes: [
      { id: "a", type: "step", name: "A", stepId: "a" },
      { id: "b", type: "step", name: "B", stepId: "b" },
      { id: "gate", type: "gate", name: "G", instructions: "x" },
      { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
    ], edges: [
      { from: "a", to: "gate" }, { from: "b", to: "gate" },
      { from: "gate", to: "done", port: "approved" }, { from: "gate", to: "a", port: "rejected" },
    ], positions: {} } as never;
    const m = gateApprovalsByStep(g2, [{ nodeId: "gate", outcome: "approved", workflowRunId: "r1" }]);
    expect(m.size).toBe(0);
  });
});
