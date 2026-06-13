import { describe, expect, it } from "vitest";
import { GateEvaluationProposal, OrchestrationDecisionKind, WorkflowGraph, WorkflowGraphEdge, WorkflowGraphNode } from "./index.js";

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

  it("rejects an unknown port", () => {
    expect(() => WorkflowGraphEdge.parse({ from: "g", to: "x", port: "maybe" })).toThrow();
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
});
