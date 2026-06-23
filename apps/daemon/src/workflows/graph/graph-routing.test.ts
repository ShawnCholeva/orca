import { describe, expect, it } from "vitest";
import type { WorkflowGraph, WorkflowStepTemplate } from "@orca/contracts";
import {
  effectiveGraph,
  findInitialStepNode,
  resolveGateNext,
  resolveStepNext,
  resolveSplitterNext,
} from "./graph-routing.js";

const steps: WorkflowStepTemplate[] = [
  { id: "analysis", ordinal: 0, name: "Analysis", instructions: "x", outputSchema: [{ key: "s", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "m" }] },
  { id: "execution", ordinal: 1, name: "Execution", instructions: "x", outputSchema: [{ key: "s", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "m" }] },
  { id: "validation", ordinal: 2, name: "Validation", instructions: "x", outputSchema: [{ key: "s", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "m" }] },
  { id: "done", ordinal: 3, name: "Done", instructions: "x", outputSchema: [{ key: "s", type: "string", required: true }], agentPreference: [{ adapterId: "claude-code", modelId: "m" }] },
];

const featureGraph: WorkflowGraph = {
  nodes: [
    { id: "analysis", type: "step", name: "Analysis", stepId: "analysis" },
    { id: "execution", type: "step", name: "Execution", stepId: "execution" },
    { id: "validation", type: "step", name: "Validation", stepId: "validation" },
    { id: "gate", type: "gate", name: "Release Readiness", instructions: "approve when passed" },
    { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
  ],
  edges: [
    { from: "analysis", to: "execution" },
    { from: "execution", to: "validation" },
    { from: "validation", to: "gate" },
    { from: "gate", to: "done", port: "approved" },
    { from: "gate", to: "execution", port: "rejected" },
  ],
  positions: {},
};

const splitterGraph: WorkflowGraph = {
  nodes: [
    { id: "triage", type: "step", name: "Triage", stepId: "triage" },
    { id: "route", type: "splitter", name: "Route", instructions: "pick", branches: ["go_a", "go_b"] },
    { id: "a", type: "step", name: "A", stepId: "a" },
    { id: "b", type: "step", name: "B", stepId: "b", terminal: true },
  ],
  edges: [
    { from: "triage", to: "route" },
    { from: "route", to: "a", port: "go_a" },
    { from: "route", to: "b", port: "go_b" },
    { from: "a", to: "b" },
  ],
  positions: {},
};

describe("findInitialStepNode", () => {
  it("returns the node for the lowest-ordinal step", () => {
    expect(findInitialStepNode(featureGraph, steps)?.id).toBe("analysis");
  });
});

describe("resolveStepNext", () => {
  it("returns the next step node", () => {
    expect(resolveStepNext(featureGraph, "analysis")).toEqual({ kind: "step", nodeId: "execution" });
  });

  it("returns the gate node", () => {
    expect(resolveStepNext(featureGraph, "validation")).toEqual({ kind: "gate", nodeId: "gate" });
  });

  it("returns terminal for a terminal step node", () => {
    expect(resolveStepNext(featureGraph, "done")).toEqual({ kind: "terminal" });
  });
});

describe("resolveGateNext", () => {
  it("routes approved forward", () => {
    expect(resolveGateNext(featureGraph, "gate", "approved")).toEqual({ kind: "step", nodeId: "done" });
  });

  it("routes rejected backward", () => {
    expect(resolveGateNext(featureGraph, "gate", "rejected")).toEqual({ kind: "step", nodeId: "execution" });
  });
});

describe("effectiveGraph (legacy materialization)", () => {
  it("materializes a linear graph when graph is null, marking the last step terminal", () => {
    const g = effectiveGraph(null, steps);
    expect(g.edges).toEqual([
      { from: "analysis", to: "execution" },
      { from: "execution", to: "validation" },
      { from: "validation", to: "done" },
    ]);
    const done = g.nodes.find((n) => n.id === "done");
    expect(done?.terminal).toBe(true);
  });
});

describe("resolveSplitterNext", () => {
  it("routes a selected branch to its destination step", () => {
    expect(resolveSplitterNext(splitterGraph, "route", "go_a")).toEqual({ kind: "step", nodeId: "a" });
  });

  it("classifies a step that follows a step into a splitter destination", () => {
    const dest = resolveStepNext(splitterGraph, "triage");
    expect(dest).toEqual({ kind: "splitter", nodeId: "route" });
  });

  it("throws when the branch has no edge", () => {
    expect(() => resolveSplitterNext(splitterGraph, "route", "go_c")).toThrow(
      "splitter route must have exactly one 'go_c' edge, found 0"
    );
  });
});
