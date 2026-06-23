import { describe, expect, it } from "vitest";
import { GateEvaluationProposal, GateEvaluationRequest, OrchestrationDecisionKind, WorkflowGraph, WorkflowGraphEdge, WorkflowGraphNode } from "./index.js";

describe("WorkflowGraphEdge", () => {
  it("parses a labeled object edge", () => {
    const edge = WorkflowGraphEdge.parse({ from: "a", to: "b" });
    expect(edge).toEqual({ from: "a", to: "b" });
  });

  it("parses a gate edge with a port", () => {
    const edge = WorkflowGraphEdge.parse({ from: "g", to: "x", port: "approved" });
    expect(edge.port).toBe("approved");
  });

  it("normalizes a legacy two-element array edge to { from, to }", () => {
    const edge = WorkflowGraphEdge.parse(["a", "b"]);
    expect(edge).toEqual({ from: "a", to: "b" });
  });

  it("accepts an arbitrary string port value", () => {
    const edge = WorkflowGraphEdge.parse({ from: "g", to: "x", port: "maybe" });
    expect(edge.port).toBe("maybe");
  });

  it("rejects a port exceeding max length", () => {
    expect(() => WorkflowGraphEdge.parse({ from: "g", to: "x", port: "x".repeat(61) })).toThrow();
  });

  it("parses a whole graph whose edges mix legacy and labeled forms", () => {
    const graph = WorkflowGraph.parse({
      nodes: [
        { id: "a", type: "step", name: "A", stepId: "a" },
        { id: "b", type: "step", name: "B", stepId: "b" },
      ],
      edges: [["a", "b"]],
      positions: { a: { x: 0, y: 0 }, b: { x: 0, y: 1 } },
    });
    expect(graph.edges[0]).toEqual({ from: "a", to: "b" });
  });
});

describe("WorkflowGraphNode", () => {
  it("accepts a terminal step node", () => {
    const node = WorkflowGraphNode.parse({
      id: "done",
      type: "step",
      name: "Done",
      stepId: "done",
      terminal: true,
    });
    expect(node.terminal).toBe(true);
  });

  it("accepts a gate node with instructions", () => {
    const node = WorkflowGraphNode.parse({
      id: "gate",
      type: "gate",
      name: "Release Readiness",
      instructions: "Approve only when validation passed.",
    });
    expect(node.instructions).toBe("Approve only when validation passed.");
  });

  it("still accepts a legacy gate node with a condition field", () => {
    const node = WorkflowGraphNode.parse({
      id: "gate",
      type: "gate",
      name: "Gate",
      condition: "x === true",
    });
    expect(node.condition).toBe("x === true");
  });
});

describe("WorkflowGraphNode splitter", () => {
  it("parses a splitter node with branches", () => {
    const node = WorkflowGraphNode.parse({
      id: "route",
      type: "splitter",
      name: "Route",
      instructions: "pick a tier",
      branches: ["clarify_first", "ground_and_design", "approach_only"],
    });
    expect(node.type).toBe("splitter");
    expect(node.branches).toEqual(["clarify_first", "ground_and_design", "approach_only"]);
  });

  it("rejects a splitter declaring fewer than 2 branches", () => {
    expect(() =>
      WorkflowGraphNode.parse({ id: "r", type: "splitter", name: "R", branches: ["only"] })
    ).toThrow();
  });

  it("accepts an arbitrary string edge port (splitter branch label)", () => {
    const edge = WorkflowGraphEdge.parse({ from: "route", to: "clarify", port: "clarify_first" });
    expect(edge.port).toBe("clarify_first");
  });
});

describe("gate evaluation contract", () => {
  it("includes evaluate_gate in the decision kinds", () => {
    expect(OrchestrationDecisionKind.options).toContain("evaluate_gate");
  });

  it("parses a valid gate proposal", () => {
    const p = GateEvaluationProposal.parse({
      outcome: "rejected",
      reason: "tests failed",
      issueRefs: ["i1"],
      inputsConsidered: ["validation"],
    });
    expect(p.outcome).toBe("rejected");
  });

  it("rejects an outcome outside approved/rejected", () => {
    expect(() => GateEvaluationProposal.parse({ outcome: "maybe", reason: "x", inputsConsidered: [] })).toThrow();
  });

  it("GateEvaluationRequest defaults committedLedger to empty array when omitted", () => {
    const req = GateEvaluationRequest.parse({
      gate: { nodeId: "gate1", name: "Release Gate", instructions: "approve when green" },
      goal: { id: "goal1", description: "ship it" },
      sourceStepOutput: null,
      priorGateDecisions: [],
      availableOutcomes: ["approved", "rejected"],
    });
    expect(req.committedLedger).toEqual([]);
  });

  it("GateEvaluationRequest accepts committedLedger entries", () => {
    const req = GateEvaluationRequest.parse({
      gate: { nodeId: "gate1", name: "Release Gate", instructions: "approve when green" },
      goal: { id: "goal1", description: "ship it" },
      sourceStepOutput: null,
      priorGateDecisions: [],
      availableOutcomes: ["approved"],
      committedLedger: [{ id: "lr1", recordType: "step_result", status: "completed", note: "all tests passed" }],
    });
    expect(req.committedLedger).toHaveLength(1);
    expect(req.committedLedger[0].id).toBe("lr1");
  });

  it("GateEvaluationRequest rejects a committedLedger entry with a note over 500 chars", () => {
    expect(() =>
      GateEvaluationRequest.parse({
        gate: { nodeId: "gate1", name: "Release Gate", instructions: "approve when green" },
        goal: { id: "goal1", description: "ship it" },
        sourceStepOutput: null,
        priorGateDecisions: [],
        availableOutcomes: ["approved"],
        committedLedger: [{ id: "lr1", recordType: "step_result", status: "completed", note: "x".repeat(501) }],
      })
    ).toThrow();
  });

  it("GateEvaluationRequest accepts a committedLedger entry with a note of exactly 500 chars", () => {
    const req = GateEvaluationRequest.parse({
      gate: { nodeId: "gate1", name: "Release Gate", instructions: "approve when green" },
      goal: { id: "goal1", description: "ship it" },
      sourceStepOutput: null,
      priorGateDecisions: [],
      availableOutcomes: ["approved"],
      committedLedger: [{ id: "lr1", recordType: "step_result", status: "completed", note: "x".repeat(500) }],
    });
    expect(req.committedLedger[0].note).toHaveLength(500);
  });

  it("GateEvaluationRequest at worst-case committedLedger (35 records × 500-char note) still parses under the size guard", () => {
    // Each record: id(128) + recordType(64) + status(64) + note(500) ≈ 806 bytes
    // 35 × 806 ≈ 28 210 bytes — well under 65 536.
    const maxRecord = {
      id: "i".repeat(128),
      recordType: "r".repeat(64),
      status: "s".repeat(64),
      note: "n".repeat(500),
    };
    const req = GateEvaluationRequest.parse({
      gate: { nodeId: "gate1", name: "Release Gate", instructions: "approve when green" },
      goal: { id: "goal1", description: "ship it" },
      sourceStepOutput: null,
      priorGateDecisions: [],
      availableOutcomes: ["approved"],
      committedLedger: Array.from({ length: 35 }, () => ({ ...maxRecord })),
    });
    expect(req.committedLedger).toHaveLength(35);
  });

  it("GateEvaluationRequest rejects a committedLedger with more than 35 entries", () => {
    const record = { id: "lr1", recordType: "step_result", status: "completed", note: "ok" };
    expect(() =>
      GateEvaluationRequest.parse({
        gate: { nodeId: "gate1", name: "Release Gate", instructions: "approve when green" },
        goal: { id: "goal1", description: "ship it" },
        sourceStepOutput: null,
        priorGateDecisions: [],
        availableOutcomes: ["approved"],
        committedLedger: Array.from({ length: 36 }, () => ({ ...record })),
      })
    ).toThrow();
  });
});
