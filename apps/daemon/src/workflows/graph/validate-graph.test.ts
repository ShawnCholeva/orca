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
    expect(validateGraph(g, steps)).toContain("at least one terminal step is required (found 0)");
  });

  it("accepts multiple terminal steps (one per branch)", () => {
    const s = [step("a", 0), step("done1", 1), step("done2", 2)];
    const g: WorkflowGraph = {
      nodes: [
        { id: "a", type: "step", name: "A", stepId: "a" },
        { id: "gate", type: "gate", name: "Gate", instructions: "x" },
        { id: "done1", type: "step", name: "Done1", stepId: "done1", terminal: true },
        { id: "done2", type: "step", name: "Done2", stepId: "done2", terminal: true },
      ],
      edges: [
        { from: "a", to: "gate" },
        { from: "gate", to: "done1", port: "approved" },
        { from: "gate", to: "done2", port: "rejected" },
      ],
      positions: {},
    };
    expect(validateGraph(g, s)).toEqual([]);
  });

  it("rejects a branch that never reaches a terminal", () => {
    const s = [step("a", 0), step("done", 1), step("x", 2), step("y", 3)];
    const g: WorkflowGraph = {
      nodes: [
        { id: "a", type: "step", name: "A", stepId: "a" },
        { id: "gate", type: "gate", name: "Gate", instructions: "x" },
        { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
        { id: "x", type: "step", name: "X", stepId: "x" },
        { id: "y", type: "step", name: "Y", stepId: "y" },
      ],
      edges: [
        { from: "a", to: "gate" },
        { from: "gate", to: "done", port: "approved" },
        { from: "gate", to: "x", port: "rejected" },
        { from: "x", to: "y" },
        { from: "y", to: "x" },
      ],
      positions: {},
    };
    const errs = validateGraph(g, s);
    expect(errs).toContain("branch from 'x' never reaches a terminal step");
    expect(errs).toContain("branch from 'y' never reaches a terminal step");
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

  it("validates a worker-backed gate with a backward loop edge", () => {
    const graph = {
      nodes: [
        { id: "a", type: "step", name: "A", stepId: "a" },
        { id: "g", type: "gate", name: "G", evalSubstrate: "worker", instructions: "x",
          agentPreference: [{ adapterId: "claude-code", modelId: "claude-opus-4-8" }] },
        { id: "b", type: "step", name: "B", stepId: "b", terminal: true },
      ],
      edges: [ {from:"a",to:"g"}, {from:"g",to:"b",port:"approved"}, {from:"g",to:"a",port:"rejected"} ],
      positions: { a:{x:0,y:0}, g:{x:0,y:1}, b:{x:0,y:2} },
    };
    expect(() => validateGraph(graph as never, [step("a", 0), step("b", 1)])).not.toThrow();
  });
});

describe("validateGraph splitter", () => {
  const splitterSteps = [step("triage", 0), step("a", 1), step("b", 2), step("done", 3)];

  const splitterValid: WorkflowGraph = {
    nodes: [
      { id: "triage", type: "step", name: "Triage", stepId: "triage" },
      { id: "route", type: "splitter", name: "Route", instructions: "pick", branches: ["go_a", "go_b"] },
      { id: "a", type: "step", name: "A", stepId: "a" },
      { id: "b", type: "step", name: "B", stepId: "b" },
      { id: "done", type: "step", name: "Done", stepId: "done", terminal: true },
    ],
    edges: [
      { from: "triage", to: "route" },
      { from: "route", to: "a", port: "go_a" },
      { from: "route", to: "b", port: "go_b" },
      { from: "a", to: "done" },
      { from: "b", to: "done" },
    ],
    positions: {},
  };

  it("accepts a well-formed splitter graph", () => {
    expect(validateGraph(splitterValid, splitterSteps)).toEqual([]);
  });

  it("rejects a splitter with a missing branch edge", () => {
    const g = { ...splitterValid, edges: splitterValid.edges.filter((e) => e.port !== "go_b") };
    expect(validateGraph(g, splitterSteps)).toContain(
      "splitter 'route' must have exactly one 'go_b' edge (found 0)"
    );
  });

  it("rejects a splitter outgoing edge with an undeclared port", () => {
    const g = {
      ...splitterValid,
      nodes: splitterValid.nodes.map((n) => (n.id === "route" ? { ...n, branches: ["go_a", "go_b"] } : n)),
      edges: [...splitterValid.edges, { from: "route", to: "done", port: "go_c" }],
    };
    expect(validateGraph(g, splitterSteps)).toContain("splitter edge must carry a declared branch port: route -> done");
  });

  it("rejects a splitter with duplicate branch labels", () => {
    const g = {
      ...splitterValid,
      nodes: splitterValid.nodes.map((n) => (n.id === "route" ? { ...n, branches: ["go_a", "go_a"] } : n)),
    };
    expect(validateGraph(g, splitterSteps)).toContain("splitter 'route' has duplicate branch labels");
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
