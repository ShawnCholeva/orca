import { describe, expect, it } from "vitest";
import { buildSplitterMetrics } from "./splitter-metrics.js";
import type { SplitDecisionRow } from "./fetch.js";
import { betaMean } from "./verification.js";
import { NODE_PRIOR_STRENGTH } from "./gate-metrics.js";
import { SPLITTER_CONFIDENCE_PRIOR } from "./splitter-metrics.js";
import type { NodeVindicationResult } from "./node-vindication.js";
import type { WorkflowGraph } from "@orca/contracts";

const names = new Map([["route", { name: "Route" }]]);

const split = (over: Partial<SplitDecisionRow>): SplitDecisionRow => ({
  id: "d", workflowRunId: "r1", nodeId: "route", traversalSeq: 1,
  selectedBranch: "fast", selectedEdgeTo: "fast", createdAt: "2026-07-16T00:00:00.000Z", templateVersion: 1, ...over,
});

// route is an LLM splitter (no branchKey), fed by triage.
const llmGraph = {
  nodes: [
    { id: "triage", type: "step", name: "T", stepId: "triage" },
    { id: "route", type: "splitter", name: "R" },
    { id: "fast", type: "step", name: "F", stepId: "fast", terminal: true },
    { id: "slow", type: "step", name: "S", stepId: "slow", terminal: true },
  ],
  edges: [
    { from: "triage", to: "route" },
    { from: "route", to: "fast", port: "fast" },
    { from: "route", to: "slow", port: "slow" },
  ],
  positions: {},
} as unknown as WorkflowGraph;

// route is a deterministic splitter (branchKey set), fed by triage.
const deterministicGraph = {
  nodes: [
    { id: "triage", type: "step", name: "T", stepId: "triage" },
    { id: "route", type: "splitter", name: "R", branchKey: "recommended_tier" },
    { id: "fast", type: "step", name: "F", stepId: "fast", terminal: true },
    { id: "slow", type: "step", name: "S", stepId: "slow", terminal: true },
  ],
  edges: [
    { from: "triage", to: "route" },
    { from: "route", to: "fast", port: "fast" },
    { from: "route", to: "slow", port: "slow" },
  ],
  positions: {},
} as unknown as WorkflowGraph;

describe("buildSplitterMetrics", () => {
  it("mostly false_accept ⇒ low confidence, high misrouteRate", () => {
    const decisions: SplitDecisionRow[] = [
      split({ id: "d1", traversalSeq: 1 }),
      split({ id: "d2", traversalSeq: 2 }),
      split({ id: "d3", traversalSeq: 3 }),
      split({ id: "d4", traversalSeq: 4 }),
    ];
    const vindication = new Map<string, NodeVindicationResult>([
      ["r1::route::1", { outcome: "false_accept", byNodeId: "fast" }],
      ["r1::route::2", { outcome: "false_accept", byNodeId: "fast" }],
      ["r1::route::3", { outcome: "false_accept", byNodeId: "fast" }],
      ["r1::route::4", { outcome: "vindicated", byNodeId: "fast" }],
    ]);
    const [m] = buildSplitterMetrics({ splitDecisions: decisions, splitterVindication: vindication, graph: llmGraph, names });
    expect(m.misrouteRate).toBeCloseTo(0.75, 5);
    // Hand-verified: betaMean(0.5, 4, pos=1, neg=3) = (0.5*4 + 1) / (4 + 1 + 3) = 3/8 = 0.375
    expect(m.confidence.value).toBeCloseTo(0.375, 10);
    expect(m.confidence.value).toBeCloseTo(betaMean(SPLITTER_CONFIDENCE_PRIOR, NODE_PRIOR_STRENGTH, 1, 3), 10);
    expect(m.confidence.sampleSize).toBe(4);
    expect(m.confidence.state).toBe("insufficient"); // 4 < NODE_CONFIDENCE_MIN(5)
    expect(m.decisions).toBe(4);
    expect(m.retrospectiveOnly).toBe(true);
  });

  it("mostly vindicated ⇒ high confidence, low misrouteRate, 'measured' once sampleSize meets the floor", () => {
    const decisions: SplitDecisionRow[] = Array.from({ length: 5 }, (_, i) => split({ id: `d${i}`, traversalSeq: i + 1 }));
    const vindication = new Map<string, NodeVindicationResult>(
      decisions.map((d, i) => [`r1::route::${i + 1}`, { outcome: i === 0 ? "false_accept" : "vindicated", byNodeId: "fast" } as NodeVindicationResult]),
    );
    const [m] = buildSplitterMetrics({ splitDecisions: decisions, splitterVindication: vindication, graph: llmGraph, names });
    expect(m.misrouteRate).toBeCloseTo(0.2, 5);
    expect(m.confidence.value).toBeGreaterThan(0.5);
    expect(m.confidence.sampleSize).toBe(5);
    expect(m.confidence.state).toBe("measured"); // 5 >= NODE_CONFIDENCE_MIN(5)
  });

  it("no labeled decisions ⇒ confidence.value null, misrouteRate null (pending only)", () => {
    const decisions = [split({ id: "d1", traversalSeq: 1 })];
    const vindication = new Map<string, NodeVindicationResult>([
      ["r1::route::1", { outcome: "pending", byNodeId: "fast" }],
    ]);
    const [m] = buildSplitterMetrics({ splitDecisions: decisions, splitterVindication: vindication, graph: llmGraph, names });
    expect(m.confidence.value).toBeNull();
    expect(m.confidence.sampleSize).toBe(0);
    expect(m.confidence.state).toBe("insufficient");
    expect(m.misrouteRate).toBeNull();
    expect(m.decisions).toBe(1);
  });

  it("LLM splitter (no branchKey) ⇒ deterministic:false, attributedToNodeId:null", () => {
    const decisions = [split({ id: "d1", traversalSeq: 1 })];
    const vindication = new Map<string, NodeVindicationResult>([["r1::route::1", { outcome: "vindicated", byNodeId: "fast" }]]);
    const [m] = buildSplitterMetrics({ splitDecisions: decisions, splitterVindication: vindication, graph: llmGraph, names });
    expect(m.deterministic).toBe(false);
    expect(m.attributedToNodeId).toBeNull();
  });

  it("deterministic splitter (branchKey set, fed by triage) ⇒ deterministic:true, attributedToNodeId:'triage'", () => {
    const decisions = [split({ id: "d1", traversalSeq: 1 })];
    const vindication = new Map<string, NodeVindicationResult>([["r1::route::1", { outcome: "vindicated", byNodeId: "fast" }]]);
    const [m] = buildSplitterMetrics({ splitDecisions: decisions, splitterVindication: vindication, graph: deterministicGraph, names });
    expect(m.deterministic).toBe(true);
    expect(m.attributedToNodeId).toBe("triage");
  });

  it("predecessor step's node id !== stepId ⇒ attributedToNodeId is the stepId (join key), not the raw node id", () => {
    // Regression for the carried-over identity bug: attributedToNodeId must match the
    // identity a transition's stepTemplateId carries (stepId ?? id), not the graph node id.
    const graph = {
      nodes: [
        { id: "triage-node-1", type: "step", name: "T", stepId: "triage" },
        { id: "route", type: "splitter", name: "R", branchKey: "recommended_tier" },
        { id: "fast", type: "step", name: "F", stepId: "fast", terminal: true },
        { id: "slow", type: "step", name: "S", stepId: "slow", terminal: true },
      ],
      edges: [
        { from: "triage-node-1", to: "route" },
        { from: "route", to: "fast", port: "fast" },
        { from: "route", to: "slow", port: "slow" },
      ],
      positions: {},
    } as unknown as WorkflowGraph;
    const decisions = [split({ id: "d1", traversalSeq: 1 })];
    const vindication = new Map<string, NodeVindicationResult>([["r1::route::1", { outcome: "vindicated", byNodeId: "fast" }]]);
    const [m] = buildSplitterMetrics({ splitDecisions: decisions, splitterVindication: vindication, graph, names });
    expect(m.deterministic).toBe(true);
    expect(m.attributedToNodeId).toBe("triage");
    expect(m.attributedToNodeId).not.toBe("triage-node-1");
  });

  it("nodeId + name pass through from `names`", () => {
    const decisions = [split({ id: "d1", traversalSeq: 1 })];
    const [m] = buildSplitterMetrics({ splitDecisions: decisions, splitterVindication: new Map(), graph: llmGraph, names });
    expect(m.nodeId).toBe("route");
    expect(m.name).toBe("Route");
  });
});
