import { describe, expect, it } from "vitest";
import { buildPipeline } from "./pipeline.js";

describe("buildPipeline", () => {
  const graph = JSON.stringify({
    nodes: [
      { id: "triage", type: "step", name: "Triage" },
      { id: "route", type: "splitter", name: "Route" },
      { id: "clarify", type: "step", name: "Clarify" },
      { id: "research", type: "step", name: "Research" },
      { id: "proposal", type: "step", name: "Proposal" },
      { id: "critique", type: "gate", name: "Critique" },
      { id: "execution", type: "step", name: "Execution" },
      { id: "review", type: "gate", name: "Verify" },
      { id: "done", type: "step", name: "Done" },
    ],
    edges: [
      { from: "triage", to: "route" }, { from: "route", to: "clarify" }, { from: "route", to: "research" }, { from: "route", to: "proposal" },
      { from: "clarify", to: "research" }, { from: "research", to: "proposal" },
      { from: "proposal", to: "critique" }, { from: "critique", to: "execution" }, { from: "critique", to: "proposal" },
      { from: "execution", to: "review" }, { from: "review", to: "done" }, { from: "review", to: "execution" },
    ],
  });

  it("preserves node order", () => {
    const p = buildPipeline(graph)!;
    expect(p.map((n) => n.nodeId)).toEqual(["triage", "route", "clarify", "research", "proposal", "critique", "execution", "review", "done"]);
  });

  it("computes gate guards using the forward edge, not the reject loop", () => {
    const p = buildPipeline(graph)!;
    expect(p.find((n) => n.nodeId === "critique")!.guards).toEqual({ from: "proposal", to: "execution" });
    expect(p.find((n) => n.nodeId === "review")!.guards).toEqual({ from: "execution", to: "done" });
  });

  it("computes splitter branches", () => {
    const p = buildPipeline(graph)!;
    expect(p.find((n) => n.nodeId === "route")!.branchesTo).toEqual(["clarify", "research", "proposal"]);
  });

  it("returns undefined for null or malformed graphs", () => {
    expect(buildPipeline(null)).toBeUndefined();
    expect(buildPipeline("{not json")).toBeUndefined();
  });

  it("omits guards when a gate has only a backward out-edge (no forward edge)", () => {
    const backwardOnlyGraph = JSON.stringify({
      nodes: [
        { id: "a", type: "step", name: "A" },
        { id: "g", type: "gate", name: "G" },
        { id: "b", type: "step", name: "B" },
      ],
      edges: [
        { from: "a", to: "g" },
        { from: "g", to: "a" },
      ],
    });
    const p = buildPipeline(backwardOnlyGraph)!;
    expect(p.find((n) => n.nodeId === "g")!.guards).toBeUndefined();
  });
});
