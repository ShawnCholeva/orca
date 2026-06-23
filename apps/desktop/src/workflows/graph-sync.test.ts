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
    expect(graph.edges).toEqual([{ from: "s1", to: "s2" }]);
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

  it("marks the last step terminal", () => {
    const graph = buildInitialGraph([makeStep("s1"), makeStep("s2"), makeStep("s3")]);
    expect(graph.nodes.map((n) => n.terminal ?? false)).toEqual([false, false, true]);
  });

  it("single step is terminal", () => {
    const graph = buildInitialGraph([makeStep("s1")]);
    expect(graph.nodes[0]!.terminal).toBe(true);
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
    for (const e of result.edges) {
      expect(e.from).not.toBe("s2");
      expect(e.to).not.toBe("s2");
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
      edges: [{ from: "s1", to: "g1" }, { from: "g1", to: "s2" }],
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
    expect(result.edges.some((e) => e.from === "s1" && e.to === "g1")).toBe(true);
    expect(result.edges.some((e) => e.to === "s2" || e.from === "s2")).toBe(false);
  });

  it("null graph bootstrap: buildInitialGraph produces linear graph", () => {
    const steps = [makeStep("a"), makeStep("b"), makeStep("c")];
    const graph = buildInitialGraph(steps);
    expect(graph.edges).toEqual([{ from: "a", to: "b" }, { from: "b", to: "c" }]);
  });

  it("drops self-loops and duplicate directed edges, keeps back-edges", () => {
    const steps = [makeStep("s1"), makeStep("s2")];
    const graph = {
      nodes: buildInitialGraph(steps).nodes,
      edges: [
        { from: "s1", to: "s2" },
        { from: "s1", to: "s2" }, // exact duplicate -> dropped
        { from: "s2", to: "s1" }, // directed back-edge -> kept
        { from: "s1", to: "s1" }, // self-loop -> dropped
      ],
      positions: buildInitialGraph(steps).positions,
    };
    const result = reconcileGraph(steps, graph);
    expect(result.edges).toEqual([
      { from: "s1", to: "s2" },
      { from: "s2", to: "s1" },
    ]);
  });

  it("buildInitialGraph emits labeled object edges", () => {
    const g = buildInitialGraph([
      { id: "a", name: "A" } as any,
      { id: "b", name: "B" } as any,
    ]);
    expect(g.edges[0]).toEqual({ from: "a", to: "b" });
  });

  it("reconcileGraph drops edges whose endpoints were removed, using object edges", () => {
    const g = reconcileGraph(
      [{ id: "a", name: "A" } as any],
      { nodes: [{ id: "a", type: "step", name: "A", stepId: "a" }], edges: [{ from: "a", to: "gone" }], positions: { a: { x: 0, y: 0 } } } as any,
    );
    expect(g.edges).toEqual([]);
  });

  it("defaults the last step terminal when no node is terminal", () => {
    const steps = [makeStep("s1"), makeStep("s2")];
    const graph = {
      nodes: [
        { id: "s1", type: "step" as const, name: "s1", stepId: "s1" },
        { id: "s2", type: "step" as const, name: "s2", stepId: "s2" },
      ],
      edges: [{ from: "s1", to: "s2" }],
      positions: { s1: { x: 110, y: 20 }, s2: { x: 110, y: 112 } },
    };
    const next = reconcileGraph(steps, graph);
    const s2 = next.nodes.find((n) => n.id === "s2");
    expect(s2!.terminal).toBe(true);
  });

  it("preserves existing splitter nodes (and branches) when adding a step", () => {
    const steps = [makeStep("s1"), makeStep("s2")];
    const base = buildInitialGraph(steps);
    const graphWithSplitter = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: "split-1", type: "splitter" as const, name: "Route", branches: ["go_a", "go_b"] },
      ],
      positions: { ...base.positions, "split-1": { x: 200, y: 300 } },
    };
    const result = reconcileGraph([...steps, makeStep("s3")], graphWithSplitter);
    const splitter = result.nodes.find((n) => n.id === "split-1");
    expect(splitter).toBeTruthy();
    expect(splitter?.branches).toEqual(["go_a", "go_b"]);
    expect(result.positions["split-1"]).toEqual({ x: 200, y: 300 });
  });

  it("preserves an existing terminal flag instead of overriding it", () => {
    const steps = [makeStep("s1"), makeStep("s2")];
    const graph = {
      nodes: [
        { id: "s1", type: "step" as const, name: "s1", stepId: "s1", terminal: true },
        { id: "s2", type: "step" as const, name: "s2", stepId: "s2" },
      ],
      edges: [],
      positions: { s1: { x: 110, y: 20 }, s2: { x: 110, y: 112 } },
    };
    const next = reconcileGraph(steps, graph);
    expect(next.nodes.find((n) => n.id === "s1")!.terminal).toBe(true);
    expect(next.nodes.find((n) => n.id === "s2")!.terminal ?? false).toBe(false);
  });
});
