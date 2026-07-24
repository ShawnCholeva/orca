import { describe, expect, it } from "vitest";
import { deriveVindication } from "./vindication.js";

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

const sc = (runId: string, step: string, at: string) => ({ templateVersion: 1, stepTemplateId: step,
  transition: { id: `${runId}-${step}-${at}`, workflowRunId: runId, boundary: "step_complete", createdAt: at } } as never);
const markDone = (runId: string, at: string) => ({ templateVersion: 1, stepTemplateId: null,
  transition: { id: `${runId}-done-${at}`, workflowRunId: runId, boundary: "mark_done", createdAt: at } } as never);
const gate = (runId: string, node: string, outcome: "approved" | "rejected", at: string) =>
  ({ id: `${runId}-${node}-${at}`, workflowRunId: runId, nodeId: node, traversalSeq: 1, outcome, reason: "", issueRefs: [], recommendedOutcome: null, recommendedReason: null, selectedEdgeTo: "", createdAt: at, templateVersion: 1 });
const split = (runId: string, node: string, at: string) =>
  ({ id: `${runId}-${node}-${at}`, workflowRunId: runId, nodeId: node, traversalSeq: 1, selectedBranch: "b", selectedEdgeTo: "x", createdAt: at, templateVersion: 1 });
const delegateJoin = (runId: string, at: string) => ({ templateVersion: 1, stepTemplateId: null,
  transition: { id: `${runId}-djoin-${at}`, workflowRunId: runId, boundary: "delegate_join", createdAt: at } } as never);

const splitterGraph = { nodes: [
  { id: "triage", type: "step", name: "T", stepId: "triage" },
  { id: "route", type: "splitter", name: "R" },
], edges: [{ from: "triage", to: "route" }], positions: {} } as never;

const delegateGraph = { nodes: [
  { id: "s", type: "step", name: "S", stepId: "s" },
  { id: "d", type: "delegate", name: "D" },
], edges: [{ from: "s", to: "d" }], positions: {} } as never;

const stepGraph = { nodes: [
  { id: "a", type: "step", name: "A", stepId: "a" },
  { id: "b", type: "step", name: "B", stepId: "b", terminal: true },
], edges: [{ from: "a", to: "b" }], positions: {} } as never;

describe("deriveVindication", () => {
  it("gate-approved downstream → vindicated", () => {
    const m = deriveVindication({ transitions: [sc("r1", "proposal", "t1")], gateDecisions: [gate("r1", "critique", "approved", "t2")], splitDecisions: [], graph });
    expect(m.get("r1::proposal")).toEqual({ outcome: "vindicated", byNodeId: "critique" });
  });
  it("gate-rejected downstream → bounced", () => {
    const m = deriveVindication({ transitions: [sc("r1", "proposal", "t1")], gateDecisions: [gate("r1", "critique", "rejected", "t2")], splitDecisions: [], graph });
    expect(m.get("r1::proposal")).toEqual({ outcome: "bounced", byNodeId: "critique" });
  });
  it("no downstream decision yet → pending", () => {
    const m = deriveVindication({ transitions: [sc("r1", "proposal", "t1")], gateDecisions: [], splitDecisions: [], graph });
    expect(m.get("r1::proposal")).toEqual({ outcome: "pending", byNodeId: "critique" });
  });
  it("labels the FINAL completion: reject-then-redo-then-approve → vindicated", () => {
    const m = deriveVindication({
      transitions: [sc("r1", "proposal", "t1"), sc("r1", "proposal", "t3")],
      gateDecisions: [gate("r1", "critique", "rejected", "t2"), gate("r1", "critique", "approved", "t4")],
      splitDecisions: [], graph });
    expect(m.get("r1::proposal")).toEqual({ outcome: "vindicated", byNodeId: "critique" });
  });
  it("terminal step vindicated by mark_done", () => {
    const m = deriveVindication({ transitions: [sc("r1", "done", "t1"), markDone("r1", "t2")], gateDecisions: [], splitDecisions: [], graph });
    expect(m.get("r1::done")).toEqual({ outcome: "vindicated", byNodeId: null });
  });
  it("terminal step pending without mark_done", () => {
    const m = deriveVindication({ transitions: [sc("r1", "done", "t1")], gateDecisions: [], splitDecisions: [], graph });
    expect(m.get("r1::done")).toEqual({ outcome: "pending", byNodeId: null });
  });
  it("downstream step proceeded → vindicated (execution → review gate approved isn't needed; execution vindicated when review approves)", () => {
    // execution's downstream is the 'review' gate:
    const m = deriveVindication({ transitions: [sc("r1", "execution", "t1")], gateDecisions: [gate("r1", "review", "approved", "t2")], splitDecisions: [], graph });
    expect(m.get("r1::execution")).toEqual({ outcome: "vindicated", byNodeId: "review" });
  });
  it("splitter downstream routed → vindicated", () => {
    const m = deriveVindication({ transitions: [sc("r1", "triage", "t1")], gateDecisions: [], splitDecisions: [split("r1", "route", "t2")], graph: splitterGraph });
    expect(m.get("r1::triage")).toEqual({ outcome: "vindicated", byNodeId: "route" });
  });
  it("splitter downstream not yet routed → pending", () => {
    const m = deriveVindication({ transitions: [sc("r1", "triage", "t1")], gateDecisions: [], splitDecisions: [], graph: splitterGraph });
    expect(m.get("r1::triage")).toEqual({ outcome: "pending", byNodeId: "route" });
  });
  it("delegate downstream joined → vindicated", () => {
    const m = deriveVindication({ transitions: [sc("r1", "s", "t1"), delegateJoin("r1", "t2")], gateDecisions: [], splitDecisions: [], graph: delegateGraph });
    expect(m.get("r1::s")).toEqual({ outcome: "vindicated", byNodeId: "d" });
  });
  it("delegate downstream not yet joined → pending", () => {
    const m = deriveVindication({ transitions: [sc("r1", "s", "t1")], gateDecisions: [], splitDecisions: [], graph: delegateGraph });
    expect(m.get("r1::s")).toEqual({ outcome: "pending", byNodeId: "d" });
  });
  it("downstream step completed → vindicated", () => {
    const m = deriveVindication({ transitions: [sc("r1", "a", "t1"), sc("r1", "b", "t2")], gateDecisions: [], splitDecisions: [], graph: stepGraph });
    expect(m.get("r1::a")).toEqual({ outcome: "vindicated", byNodeId: "b" });
  });
  it("downstream step not yet completed → pending", () => {
    const m = deriveVindication({ transitions: [sc("r1", "a", "t1")], gateDecisions: [], splitDecisions: [], graph: stepGraph });
    expect(m.get("r1::a")).toEqual({ outcome: "pending", byNodeId: "b" });
  });
});
