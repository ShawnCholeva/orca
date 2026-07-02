import { describe, expect, it } from "vitest";
import { WorkflowGraphNode, WorkflowRunStatus, WorkflowRunComposition } from "./index.js";

describe("composition contracts", () => {
  it("parses a delegate node with reads/writes", () => {
    const node = WorkflowGraphNode.parse({
      id: "d1", type: "delegate", name: "Review",
      childTemplateId: "orca/code-review", childTemplateVersion: 3,
      reads: { diff_ref: "change_ref" }, writes: { review_findings: "findings" },
      validationRequired: false, requiresLaunchApproval: false,
    });
    expect(node.type).toBe("delegate");
    expect(node.childTemplateId).toBe("orca/code-review");
  });

  it("accepts the delegating run status", () => {
    expect(WorkflowRunStatus.safeParse("delegating").success).toBe(true);
  });

  it("round-trips a WorkflowRunComposition", () => {
    const c = {
      id: "c1", goalId: "g", parentRunId: "r1", childRunId: "r2", delegateNodeId: "d1",
      spawnSeq: 0, reads: { diff_ref: "change_ref" }, writes: { review_findings: "findings" },
      depth: 1, status: "active" as const, costRollupUsd: null,
      createdAt: "2026-07-01T00:00:00.000Z", finishedAt: null,
    };
    expect(WorkflowRunComposition.parse(c)).toMatchObject({ id: "c1", status: "active" });
  });
});
