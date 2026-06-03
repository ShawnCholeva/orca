import { describe, expect, it } from "vitest";
import type { WorkflowStepDraft } from "./StepEditor";
import { buildInitialGraph, reconcileGraph } from "./graph-sync";

function makeStep(id: string, name = id): WorkflowStepDraft {
  return {
    id,
    ordinal: 0,
    name,
    instructions: "",
    outputSchema: [{ key: "result", type: "string" as const, required: true }],
    agentPreference: [{ adapterId: "claude-code" as const, modelId: "claude-haiku-4-5" }],
  };
}

describe("buildInitialGraph", () => {
  it("builds a linear graph from steps", () => {
    const steps = [makeStep("s1", "Alpha"), makeStep("s2", "Beta")];
    const graph = buildInitialGraph(steps);

    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0]).toMatchObject({ id: "s1", type: "step", name: "Alpha", stepId: "s1" });
    expect(graph.nodes[1]).toMatchObject({ id: "s2", type: "step", name: "Beta", stepId: "s2" });
    expect(graph.edges).toEqual([["s1", "s2"]]);
    expect(graph.positions["s1"]).toMatchObject({ x: 110 });
    expect(graph.positions["s2"]).toMatchObject({ x: 110 });
    expect(graph.positions["s2"]!.y).toBeGreaterThan(graph.positions["s1"]!.y);
  });

  it("builds an empty graph for zero steps", () => {
    const graph = buildInitialGraph([]);
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
    expect(Object.keys(graph.positions)).toHaveLength(0);
  });

  it("single step has no edges", () => {
    const graph = buildInitialGraph([makeStep("s1")]);
    expect(graph.edges).toHaveLength(0);
  });
});

describe("reconcileGraph", () => {
  it("preserves existing step positions and gate nodes when adding a step", () => {
    const steps = [makeStep("s1"), makeStep("s2")];
    const base = buildInitialGraph(steps);

    // Add a gate node manually
    const graphWithGate = {
      ...base,
      nodes: [...base.nodes, { id: "gate-1", type: "gate" as const, name: "Gate", condition: "x > 0" }],
      positions: { ...base.positions, "gate-1": { x: 200, y: 300 } },
    };

    // Reconcile with a new step added
    const nextSteps = [...steps, makeStep("s3")];
    const result = reconcileGraph(nextSteps, graphWithGate);

    // s1 and s2 positions preserved
    expect(result.positions["s1"]).toEqual(base.positions["s1"]);
    expect(result.positions["s2"]).toEqual(base.positions["s2"]);

    // gate preserved
    expect(result.nodes.find((n) => n.id === "gate-1")).toBeTruthy();
    expect(result.positions["gate-1"]).toEqual({ x: 200, y: 300 });

    // s3 got a position
    expect(result.positions["s3"]).toBeDefined();

    // All three step nodes present
    const stepNodes = result.nodes.filter((n) => n.type === "step");
    expect(stepNodes).toHaveLength(3);
  });

  it("drops removed step's node, position, and incident edges", () => {
    const steps = [makeStep("s1"), makeStep("s2"), makeStep("s3")];
    const base = buildInitialGraph(steps);

    // Remove s2
    const nextSteps = [makeStep("s1"), makeStep("s3")];
    const result = reconcileGraph(nextSteps, base);

    expect(result.nodes.find((n) => n.id === "s2")).toBeUndefined();
    expect(result.positions["s2"]).toBeUndefined();
    // edges involving s2 dropped
    for (const [a, b] of result.edges) {
      expect(a).not.toBe("s2");
      expect(b).not.toBe("s2");
    }
  });

  it("syncs step-node name when step name changes", () => {
    const steps = [makeStep("s1", "Original")];
    const base = buildInitialGraph(steps);

    const renamed = [makeStep("s1", "Renamed")];
    const result = reconcileGraph(renamed, base);

    const node = result.nodes.find((n) => n.id === "s1");
    expect(node?.name).toBe("Renamed");
  });

  it("keeps gate nodes and drops no-longer-valid edges referencing removed steps", () => {
    const steps = [makeStep("s1"), makeStep("s2")];
    const base = buildInitialGraph(steps);

    // Add a gate connecting s1 → gate → s2
    const graphWithGate = {
      ...base,
      nodes: [...base.nodes, { id: "g1", type: "gate" as const, name: "Check", condition: "" }],
      edges: [["s1", "g1"] as [string, string], ["g1", "s2"] as [string, string]],
      positions: { ...base.positions, g1: { x: 110, y: 150 } },
    };

    // Remove s2
    const nextSteps = [makeStep("s1")];
    const result = reconcileGraph(nextSteps, graphWithGate);

    // Gate preserved
    expect(result.nodes.find((n) => n.id === "g1")).toBeTruthy();
    // s2 node dropped
    expect(result.nodes.find((n) => n.id === "s2")).toBeUndefined();
    // s2-incident edge dropped; s1→g1 preserved
    expect(result.edges.some(([a, b]) => a === "s1" && b === "g1")).toBe(true);
    expect(result.edges.some(([a, b]) => b === "s2" || a === "s2")).toBe(false);
  });

  it("null graph bootstrap: buildInitialGraph produces linear graph", () => {
    const steps = [makeStep("a"), makeStep("b"), makeStep("c")];
    const graph = buildInitialGraph(steps);
    expect(graph.edges).toEqual([["a", "b"], ["b", "c"]]);
  });

  it("drops self-loops and duplicate directed edges, keeps back-edges", () => {
    const steps = [makeStep("s1"), makeStep("s2")];
    const graph = {
      nodes: buildInitialGraph(steps).nodes,
      edges: [
        ["s1", "s2"],
        ["s1", "s2"], // exact duplicate -> dropped
        ["s2", "s1"], // directed back-edge -> kept
        ["s1", "s1"], // self-loop -> dropped
      ] as [string, string][],
      positions: buildInitialGraph(steps).positions,
    };
    const result = reconcileGraph(steps, graph);
    expect(result.edges).toEqual([
      ["s1", "s2"],
      ["s2", "s1"],
    ]);
  });
});
