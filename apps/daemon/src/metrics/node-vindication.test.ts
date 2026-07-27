import { describe, expect, it } from "vitest";
import { deriveGateVindication, deriveSplitterVindication } from "./node-vindication.js";

const graph = { nodes: [
  { id: "proposal", type: "step", name: "P", stepId: "proposal" },
  { id: "critique", type: "gate", name: "C", instructions: "x" },
  { id: "execution", type: "step", name: "E", stepId: "execution" },
  { id: "review", type: "gate", name: "V", instructions: "x" },
  { id: "done", type: "step", name: "D", stepId: "done", terminal: true },
], edges: [
  { from: "proposal", to: "critique" }, { from: "critique", to: "execution", port: "approved" }, { from: "critique", to: "proposal", port: "rejected" },
  { from: "execution", to: "review" }, { from: "review", to: "done", port: "approved" }, { from: "review", to: "execution", port: "rejected" },
], positions: {} } as never;

const splitterGraph = { nodes: [
  { id: "triage", type: "step", name: "T", stepId: "triage" },
  { id: "route", type: "splitter", name: "R" },
  { id: "fast", type: "step", name: "F", stepId: "fast", terminal: true },
  { id: "slow", type: "step", name: "S", stepId: "slow", terminal: true },
], edges: [
  { from: "triage", to: "route" },
  { from: "route", to: "fast", port: "fast" },
  { from: "route", to: "slow", port: "slow" },
], positions: {} } as never;

const markDone = (runId: string, at: string) => ({ templateVersion: 1, stepTemplateId: null,
  transition: { id: `${runId}-done-${at}`, workflowRunId: runId, boundary: "mark_done", createdAt: at } } as never);
// A hard-fail step_complete: telemetry.outcome.status === "failed".
const hardFail = (runId: string, at: string) => ({ templateVersion: 1, stepTemplateId: "execution",
  transition: { id: `${runId}-fail-${at}`, workflowRunId: runId, boundary: "step_complete", createdAt: at,
    telemetry: { outcome: { status: "failed", failure_code: null } } } } as never);
// Abandonment: a goal_archived/session_archived failure_code, on any boundary,
// often without a "failed" status (an endless reject loop just stops).
const abandoned = (runId: string, at: string) => ({ templateVersion: 1, stepTemplateId: null,
  transition: { id: `${runId}-abandon-${at}`, workflowRunId: runId, boundary: "step_launch", createdAt: at,
    telemetry: { outcome: { status: "denied", failure_code: "goal_archived" } } } } as never);

const gate = (runId: string, node: string, outcome: "approved" | "rejected", at: string, seq = 1) =>
  ({ id: `${runId}-${node}-${at}`, workflowRunId: runId, nodeId: node, traversalSeq: seq, outcome, reason: "",
    issueRefs: [], recommendedOutcome: null, recommendedReason: null, selectedEdgeTo: "", createdAt: at, templateVersion: 1 });
const split = (runId: string, node: string, branch: string, at: string, seq = 1) =>
  ({ id: `${runId}-${node}-${branch}-${at}`, workflowRunId: runId, nodeId: node, traversalSeq: seq,
    selectedBranch: branch, selectedEdgeTo: "", createdAt: at, templateVersion: 1 });

describe("deriveGateVindication", () => {
  it("approved, mark_done after ⇒ vindicated; byNodeId = approved-edge destination", () => {
    const m = deriveGateVindication({
      transitions: [markDone("r1", "t2")],
      gateDecisions: [gate("r1", "critique", "approved", "t1")],
      graph,
    });
    expect(m.get("r1::critique::1")).toEqual({ outcome: "vindicated", byNodeId: "execution" });
  });

  it("approved, hard-fail after (no mark_done) ⇒ false_accept", () => {
    const m = deriveGateVindication({
      transitions: [hardFail("r1", "t2")],
      gateDecisions: [gate("r1", "critique", "approved", "t1")],
      graph,
    });
    expect(m.get("r1::critique::1")).toEqual({ outcome: "false_accept", byNodeId: "execution" });
  });

  it("approved, abandoned (goal_archived) after (no mark_done) ⇒ false_accept", () => {
    const m = deriveGateVindication({
      transitions: [abandoned("r1", "t2")],
      gateDecisions: [gate("r1", "critique", "approved", "t1")],
      graph,
    });
    expect(m.get("r1::critique::1")).toEqual({ outcome: "false_accept", byNodeId: "execution" });
  });

  it("approved, run still in progress ⇒ pending", () => {
    const m = deriveGateVindication({
      transitions: [],
      gateDecisions: [gate("r1", "critique", "approved", "t1")],
      graph,
    });
    expect(m.get("r1::critique::1")).toEqual({ outcome: "pending", byNodeId: "execution" });
  });

  it("rejection ⇒ not labeled (false-reject deferred)", () => {
    const m = deriveGateVindication({
      transitions: [markDone("r1", "t2")],
      gateDecisions: [gate("r1", "critique", "rejected", "t1")],
      graph,
    });
    expect(m.has("r1::critique::1")).toBe(false);
  });

  it("approved-edge target that is itself a terminal step ⇒ byNodeId is still that step's id (classify() doesn't special-case .terminal)", () => {
    const m = deriveGateVindication({
      transitions: [markDone("r1", "t2")],
      gateDecisions: [gate("r1", "review", "approved", "t1")],
      graph,
    });
    expect(m.get("r1::review::1")).toEqual({ outcome: "vindicated", byNodeId: "done" });
  });

  it("no matching 'approved' port edge (malformed/mistargeted) ⇒ resolveGateNext throws, guarded to byNodeId null", () => {
    const m = deriveGateVindication({
      transitions: [markDone("r1", "t2")],
      gateDecisions: [gate("r1", "execution", "approved", "t1")],
      graph,
    });
    expect(m.get("r1::execution::1")).toEqual({ outcome: "vindicated", byNodeId: null });
  });
});

describe("deriveSplitterVindication", () => {
  it("routed, mark_done after, no re-decide ⇒ vindicated; byNodeId = branch destination", () => {
    const m = deriveSplitterVindication({
      transitions: [markDone("r1", "t2")],
      splitDecisions: [split("r1", "route", "fast", "t1", 1)],
      graph: splitterGraph,
    });
    expect(m.get("r1::route::1")).toEqual({ outcome: "vindicated", byNodeId: "fast" });
  });

  it("re-decided to a different branch later ⇒ false_accept for the earlier decision; the later one is pending", () => {
    const d1 = split("r1", "route", "fast", "t1", 1);
    const d2 = split("r1", "route", "slow", "t2", 2);
    const m = deriveSplitterVindication({ transitions: [], splitDecisions: [d1, d2], graph: splitterGraph });
    expect(m.get("r1::route::1")).toEqual({ outcome: "false_accept", byNodeId: "fast" });
    expect(m.get("r1::route::2")).toEqual({ outcome: "pending", byNodeId: "slow" });
  });

  it("re-decided to the SAME branch again ⇒ not a misroute (still eligible for vindicated/pending)", () => {
    const d1 = split("r1", "route", "fast", "t1", 1);
    const d2 = split("r1", "route", "fast", "t2", 2);
    const m = deriveSplitterVindication({
      transitions: [markDone("r1", "t3")],
      splitDecisions: [d1, d2],
      graph: splitterGraph,
    });
    expect(m.get("r1::route::1")).toEqual({ outcome: "vindicated", byNodeId: "fast" });
  });

  it("routed, run still in progress ⇒ pending", () => {
    const m = deriveSplitterVindication({
      transitions: [],
      splitDecisions: [split("r1", "route", "fast", "t1", 1)],
      graph: splitterGraph,
    });
    expect(m.get("r1::route::1")).toEqual({ outcome: "pending", byNodeId: "fast" });
  });

  it("routed, run terminally failed after (no re-decide, no mark_done) ⇒ false_accept", () => {
    const m = deriveSplitterVindication({
      transitions: [hardFail("r1", "t2")],
      splitDecisions: [split("r1", "route", "fast", "t1", 1)],
      graph: splitterGraph,
    });
    expect(m.get("r1::route::1")).toEqual({ outcome: "false_accept", byNodeId: "fast" });
  });

  it("routed, run abandoned (session_archived) after ⇒ false_accept", () => {
    const abandonedSession = { templateVersion: 1, stepTemplateId: null,
      transition: { id: "r1-abandon-t2", workflowRunId: "r1", boundary: "step_launch", createdAt: "t2",
        telemetry: { outcome: { status: "denied", failure_code: "session_archived" } } } } as never;
    const m = deriveSplitterVindication({
      transitions: [abandonedSession],
      splitDecisions: [split("r1", "route", "fast", "t1", 1)],
      graph: splitterGraph,
    });
    expect(m.get("r1::route::1")).toEqual({ outcome: "false_accept", byNodeId: "fast" });
  });

  it("no matching branch edge (malformed/unknown branch) ⇒ resolveSplitterNext throws, guarded to byNodeId null", () => {
    const m = deriveSplitterVindication({
      transitions: [markDone("r1", "t2")],
      splitDecisions: [split("r1", "route", "unknown", "t1", 1)],
      graph: splitterGraph,
    });
    expect(m.get("r1::route::1")).toEqual({ outcome: "vindicated", byNodeId: null });
  });
});
