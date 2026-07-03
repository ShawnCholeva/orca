import { describe, expect, it } from "vitest";
import type { WorkflowGraph, WorkflowStepTemplate, WorkflowTemplate } from "@orca/contracts";
import { validateGraph, validateDelegationAcyclic, validateSchemaReferences } from "./validate-graph.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(
  id: string,
  ordinal: number,
  outputKeys: string[] = ["result"]
): WorkflowStepTemplate {
  return {
    id,
    ordinal,
    name: id,
    instructions: "do the thing",
    outputSchema: outputKeys.map((k) => ({ key: k, type: "string" as const, required: true })),
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-opus-4-5" }],
  };
}

function makeTemplate(
  id: string,
  graph: WorkflowGraph | null,
  steps: WorkflowStepTemplate[],
  extra: Partial<WorkflowTemplate> = {}
): WorkflowTemplate {
  return {
    id,
    name: id,
    description: "test template",
    version: 1,
    isBuiltIn: false,
    isLocked: false,
    steps,
    inputs: [],
    guardrails: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scope: "global",
    scopeName: "",
    category: "custom",
    graph,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Fixtures: child template
// child has one `inputs` field ("ticket_id") and a terminal step that outputs "report"
// ---------------------------------------------------------------------------

const childSteps = [makeStep("work", 0, ["status"]), makeStep("done", 1, ["report"])];
const childGraph: WorkflowGraph = {
  nodes: [
    { id: "work", type: "step", name: "work", stepId: "work" },
    { id: "done", type: "step", name: "done", stepId: "done", terminal: true },
  ],
  edges: [{ from: "work", to: "done" }],
  positions: {},
};
const childTemplate = makeTemplate("child-1", childGraph, childSteps, {
  inputs: [{ key: "ticket_id", type: "string", required: true }],
});

// ---------------------------------------------------------------------------
// Fixtures: parent template — init → delegate → finalize(terminal)
// ---------------------------------------------------------------------------

const parentSteps = [makeStep("init", 0, ["init_out"]), makeStep("finalize", 1, ["final"])];

/** Build a parent graph with configurable delegate node properties. */
function makeParentGraph(delegateOverride: Partial<NonNullable<WorkflowGraph["nodes"][number]>> = {}): WorkflowGraph {
  return {
    nodes: [
      { id: "init", type: "step", name: "init", stepId: "init" },
      {
        id: "del",
        type: "delegate",
        name: "del",
        childTemplateId: "child-1",
        childTemplateVersion: 1,
        reads: { ticket_id: "init_out" },   // childInputKey: parentKeyName
        writes: { parent_report: "report" }, // parentOutputKey: childOutputKey
        ...delegateOverride,
      },
      { id: "finalize", type: "step", name: "finalize", stepId: "finalize", terminal: true },
    ],
    edges: [
      { from: "init", to: "del" },
      { from: "del", to: "finalize" },
    ],
    positions: {},
  };
}

const resolveChild = (id: string): WorkflowTemplate | null =>
  id === "child-1" ? childTemplate : null;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateGraph — delegate node cross-template validation", () => {
  it("(1) accepts a valid delegate node (reads⊆child inputs, writes⊆child terminal outputSchema, one edge)", () => {
    const errors = validateGraph(makeParentGraph(), parentSteps, { resolveChild });
    expect(errors).toEqual([]);
  });

  it("(2) reports a violation when a reads key is not declared in the child template inputs", () => {
    const graph = makeParentGraph({
      reads: { nonexistent_input: "init_out" }, // childInputKey "nonexistent_input" not in child.inputs
    });
    const errors = validateGraph(graph, parentSteps, { resolveChild });
    expect(errors.some((e) => e.includes("nonexistent_input"))).toBe(true);
  });

  it("(3) reports a violation when a writes child-key is not in the child terminal step outputSchema", () => {
    const graph = makeParentGraph({
      writes: { parent_report: "nonexistent_output" }, // childOutputKey "nonexistent_output" not in terminal outputSchema
    });
    const errors = validateGraph(graph, parentSteps, { resolveChild });
    expect(errors.some((e) => e.includes("nonexistent_output"))).toBe(true);
  });

  it("(4) reports a violation when a delegate node has ≠1 outgoing edge", () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "init", type: "step", name: "init", stepId: "init" },
        {
          id: "del",
          type: "delegate",
          name: "del",
          childTemplateId: "child-1",
          childTemplateVersion: 1,
          reads: { ticket_id: "init_out" },
          writes: { parent_report: "report" },
        },
        { id: "finalize", type: "step", name: "finalize", stepId: "finalize", terminal: true },
      ],
      edges: [
        { from: "init", to: "del" },
        // del has no outgoing edge → 0 edges instead of 1
      ],
      positions: {},
    };
    const errors = validateGraph(graph, parentSteps, { resolveChild });
    expect(errors.some((e) => e.includes("del") && e.includes("outgoing"))).toBe(true);
  });
});

describe("validateSchemaReferences — delegate reads availability", () => {
  it("(valid) returns [] when the delegate reads value is produced by an upstream step", () => {
    // makeParentGraph has reads: { ticket_id: "init_out" }, "init" produces "init_out"
    const errors = validateSchemaReferences(makeParentGraph(), parentSteps);
    expect(errors).toEqual([]);
  });

  it("(invalid) reports a violation when a delegate reads from a parent key not produced on any incoming path", () => {
    const graph = makeParentGraph({
      reads: { ticket_id: "typo_key" }, // "typo_key" is not produced by any upstream step
    });
    const errors = validateSchemaReferences(graph, parentSteps);
    expect(errors.some((e) => e.includes("typo_key"))).toBe(true);
  });
});

describe("validateDelegationAcyclic", () => {
  it("returns a violation when template A delegates B and B delegates A", () => {
    // A → B → A (cycle)
    const graphA: WorkflowGraph = {
      nodes: [
        { id: "s", type: "step", name: "s", stepId: "s" },
        { id: "delA", type: "delegate", name: "delA", childTemplateId: "template-b", childTemplateVersion: 1 },
        { id: "t", type: "step", name: "t", stepId: "t", terminal: true },
      ],
      edges: [{ from: "s", to: "delA" }, { from: "delA", to: "t" }],
      positions: {},
    };
    const graphB: WorkflowGraph = {
      nodes: [
        { id: "s", type: "step", name: "s", stepId: "s" },
        { id: "delB", type: "delegate", name: "delB", childTemplateId: "template-a", childTemplateVersion: 1 },
        { id: "t", type: "step", name: "t", stepId: "t", terminal: true },
      ],
      edges: [{ from: "s", to: "delB" }, { from: "delB", to: "t" }],
      positions: {},
    };
    const stepsAB = [makeStep("s", 0), makeStep("t", 1)];
    const templateA = makeTemplate("template-a", graphA, stepsAB);
    const templateB = makeTemplate("template-b", graphB, stepsAB);

    const resolver = (id: string): WorkflowTemplate | null => {
      if (id === "template-a") return templateA;
      if (id === "template-b") return templateB;
      return null;
    };

    const errors = validateDelegationAcyclic(resolver, templateA);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("cycle"))).toBe(true);
  });

  it("returns [] for a non-cyclic delegation chain (A → B, B has no delegates)", () => {
    const graphA: WorkflowGraph = {
      nodes: [
        { id: "s", type: "step", name: "s", stepId: "s" },
        { id: "del", type: "delegate", name: "del", childTemplateId: "template-b", childTemplateVersion: 1 },
        { id: "t", type: "step", name: "t", stepId: "t", terminal: true },
      ],
      edges: [{ from: "s", to: "del" }, { from: "del", to: "t" }],
      positions: {},
    };
    const stepsAB = [makeStep("s", 0), makeStep("t", 1)];
    const templateA = makeTemplate("template-a", graphA, stepsAB);
    const templateB = makeTemplate("template-b", null, stepsAB); // no graph → no delegates

    const resolver = (id: string): WorkflowTemplate | null => {
      if (id === "template-b") return templateB;
      return null;
    };

    expect(validateDelegationAcyclic(resolver, templateA)).toEqual([]);
  });
});
