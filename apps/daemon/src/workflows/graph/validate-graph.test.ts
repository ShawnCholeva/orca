import { describe, expect, it } from "vitest";
import type { WorkflowGraph, WorkflowStepTemplate } from "@orca/contracts";
import { validateGraph, validateSchemaReferences } from "./validate-graph.js";

function step(id: string, ordinal: number): WorkflowStepTemplate {
  return {
    id,
    ordinal,
    name: id,
    instructions: "do",
    outputSchema: [{ key: "s", type: "string", required: true }],
    agentPreference: [{ adapterId: "claude-code", modelId: "m" }],
  };
}

const steps = [step("analysis", 0), step("execution", 1), step("validation", 2), step("done", 3)];

const valid: WorkflowGraph = {
  nodes: [
    { id: "analysis", type: "step", name: "Analysis", stepId: "analysis" },
    { id: "execution", type: "step", name: "Execution", stepId: "execution" },
    { id: "validation", type: "step", name: "Validation", stepId: "validation" },
    { id: "gate", type: "gate", name: "Gate", instructions: "approve when passed" },
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

describe("validateGraph", () => {
  it("accepts the valid feature graph", () => {
    expect(validateGraph(valid, steps)).toEqual([]);
  });

  it("rejects when there is no terminal step", () => {
    const g = { ...valid, nodes: valid.nodes.map((n) => (n.id === "done" ? { ...n, terminal: false } : n)) };
    expect(validateGraph(g, steps)).toContain("exactly one terminal step is required (found 0)");
  });

  it("rejects when a terminal step has an outgoing edge", () => {
    const g = { ...valid, edges: [...valid.edges, { from: "done", to: "analysis" }] };
    expect(validateGraph(g, steps)).toContain("terminal step 'done' must have no outgoing edges");
  });

  it("rejects a nonterminal step with no outgoing edge", () => {
    const g = { ...valid, edges: valid.edges.filter((e) => e.from !== "analysis") };
    expect(validateGraph(g, steps)).toContain("step 'analysis' must have exactly one outgoing edge (found 0)");
  });

  it("rejects a gate missing the rejected port", () => {
    const g = { ...valid, edges: valid.edges.filter((e) => !(e.from === "gate" && e.port === "rejected")) };
    expect(validateGraph(g, steps)).toContain("gate 'gate' must have exactly one 'rejected' edge (found 0)");
  });

  it("rejects a self-edge", () => {
    const g = { ...valid, edges: [...valid.edges, { from: "execution", to: "execution" }] };
    expect(validateGraph(g, steps)).toContain("self-edge is not allowed: execution -> execution");
  });

  it("rejects a duplicate directed edge", () => {
    const g = { ...valid, edges: [...valid.edges, { from: "analysis", to: "execution" }] };
    expect(validateGraph(g, steps)).toContain("duplicate edge: analysis -> execution");
  });

  it("rejects an edge to an unknown node", () => {
    const g = { ...valid, edges: valid.edges.map((e) => (e.from === "analysis" ? { ...e, to: "ghost" } : e)) };
    expect(validateGraph(g, steps)).toContain("edge references unknown node: analysis -> ghost");
  });

  it("rejects a step node referencing a missing step template", () => {
    const g = { ...valid, nodes: valid.nodes.map((n) => (n.id === "analysis" ? { ...n, stepId: "missing" } : n)) };
    expect(validateGraph(g, steps)).toContain("step node 'analysis' references unknown step template 'missing'");
  });

  it("rejects an unreachable node", () => {
    const g: WorkflowGraph = {
      ...valid,
      nodes: [...valid.nodes, { id: "orphan", type: "step", name: "Orphan", stepId: "execution" }],
    };
    expect(validateGraph(g, steps)).toContain("node 'orphan' is unreachable from the initial step");
  });

  it("rejects a direct step edge carrying a port", () => {
    const g = { ...valid, edges: valid.edges.map((e) => (e.from === "analysis" ? { ...e, port: "approved" as const } : e)) };
    expect(validateGraph(g, steps)).toContain("step edge must not carry a port: analysis -> execution");
  });
});

describe("validateSchemaReferences", () => {
  function refStep(id: string, ordinal: number, instructions: string, produces: string[]): WorkflowStepTemplate {
    return {
      id,
      ordinal,
      name: id,
      instructions,
      outputSchema: produces.map((k) => ({ key: k, type: "string" as const, required: true })),
      agentPreference: [{ adapterId: "claude-code", modelId: "m" }],
    };
  }

  it("accepts a reference produced on every incoming path", () => {
    const s = [refStep("a", 0, "", ["plan"]), refStep("b", 1, "use {{plan}}", [])];
    const g: WorkflowGraph = {
      nodes: [
        { id: "a", type: "step", name: "A", stepId: "a" },
        { id: "b", type: "step", name: "B", stepId: "b", terminal: true },
      ],
      edges: [{ from: "a", to: "b" }],
      positions: {},
    };
    expect(validateSchemaReferences(g, s)).toEqual([]);
  });

  it("rejects a reference to a key produced by no upstream node", () => {
    const s = [refStep("a", 0, "", ["plan"]), refStep("b", 1, "use {{missing}}", [])];
    const g: WorkflowGraph = {
      nodes: [
        { id: "a", type: "step", name: "A", stepId: "a" },
        { id: "b", type: "step", name: "B", stepId: "b", terminal: true },
      ],
      edges: [{ from: "a", to: "b" }],
      positions: {},
    };
    expect(validateSchemaReferences(g, s)).toContain(
      "step 'b' references '{{missing}}' which is not produced on every incoming path"
    );
  });

  it("allows platform context keys (goal, workspace)", () => {
    const s = [refStep("a", 0, "use {{goal}} and {{workspace}}", ["plan"])];
    const g: WorkflowGraph = {
      nodes: [{ id: "a", type: "step", name: "A", stepId: "a", terminal: true }],
      edges: [],
      positions: {},
    };
    expect(validateSchemaReferences(g, s)).toEqual([]);
  });
});
