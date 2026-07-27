import { describe, it, expect } from "vitest";
import { vindicatorWeight } from "./vindicator-weight";
import type { WorkflowGraph } from "@orca/contracts";

describe("vindicatorWeight", () => {
  const graph: WorkflowGraph = {
    nodes: [
      { id: "step-1", type: "step", name: "Step 1" } as never,
      { id: "worker-gate-1", type: "gate", name: "Worker Gate", evalSubstrate: "worker", instructions: "test", agentPreference: [{ adapterId: "test", modelId: "test" }] } as never,
      { id: "shadow-gate-1", type: "gate", name: "Shadow Gate", evalSubstrate: "shadow" } as never,
      { id: "splitter-1", type: "splitter", name: "Splitter", branches: ["a", "b"] } as never,
      { id: "delegate-1", type: "delegate", name: "Delegate", childTemplateId: "tmpl", childTemplateVersion: 1 } as never,
    ],
    edges: [],
    positions: {},
  };

  it("returns 1.0 for terminal (byNodeId === null)", () => {
    expect(vindicatorWeight(null, graph)).toBe(1.0);
  });

  it("returns 0.55 for worker gate", () => {
    expect(vindicatorWeight("worker-gate-1", graph)).toBe(0.55);
  });

  it("returns 0.4 for shadow gate", () => {
    expect(vindicatorWeight("shadow-gate-1", graph)).toBe(0.4);
  });

  it("returns 0.5 for step", () => {
    expect(vindicatorWeight("step-1", graph)).toBe(0.5);
  });

  it("returns 0.3 for splitter", () => {
    expect(vindicatorWeight("splitter-1", graph)).toBe(0.3);
  });

  it("returns 0.55 for delegate", () => {
    expect(vindicatorWeight("delegate-1", graph)).toBe(0.55);
  });

  it("returns 0.3 for unknown node (node not found)", () => {
    expect(vindicatorWeight("unknown-node-id", graph)).toBe(0.3);
  });

  it("returns 0.3 for gate without explicit evalSubstrate", () => {
    const graphWithDefaultGate: WorkflowGraph = {
      nodes: [
        { id: "default-gate", type: "gate", name: "Default Gate" } as never,
      ],
      edges: [],
      positions: {},
    };
    expect(vindicatorWeight("default-gate", graphWithDefaultGate)).toBe(0.4);
  });
});
