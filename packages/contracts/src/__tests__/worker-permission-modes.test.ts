import { describe, it, expect } from "vitest";
import {
  Goal,
  PendingApproval,
  OrchestratorChatMessage,
  SubmitPermissionDecisionRequest,
  UpdateWorkerPermissionModeRequest,
} from "../index.js";

const baseGoal = {
  id: "g1", title: "t", description: "d", status: "active" as const,
  createdAt: "2026-06-03T00:00:00.000Z", updatedAt: "2026-06-03T00:00:00.000Z",
  archivedAt: null,
};

describe("worker permission modes contracts", () => {
  it("Goal defaults workerPermissionMode to 'ask'", () => {
    expect(Goal.parse(baseGoal).workerPermissionMode).toBe("ask");
  });

  it("Goal accepts 'auto' and rejects unknown modes", () => {
    expect(Goal.parse({ ...baseGoal, workerPermissionMode: "auto" }).workerPermissionMode).toBe("auto");
    expect(Goal.safeParse({ ...baseGoal, workerPermissionMode: "yolo" }).success).toBe(false);
  });

  it("PendingApproval round-trips and is strict", () => {
    const ok = { approvalId: "a1", sessionId: "s1", toolName: "Bash", summary: "rm -rf x", detail: "rm -rf x --force" };
    expect(PendingApproval.parse(ok)).toMatchObject(ok);
    expect(PendingApproval.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(PendingApproval.safeParse({ approvalId: "a1", sessionId: "s1", toolName: "Bash", summary: "ls" }).success).toBe(true);
  });

  it("PendingApproval accepts an optional canRemember boolean and round-trips it", () => {
    const ok = { approvalId: "a1", sessionId: "s1", toolName: "Bash", summary: "ls", canRemember: false };
    expect(PendingApproval.parse(ok)).toMatchObject(ok);
    expect(PendingApproval.parse({ ...ok, canRemember: true }).canRemember).toBe(true);
    expect(PendingApproval.safeParse({ ...ok, canRemember: "yes" }).success).toBe(false);
  });

  it("OrchestratorChatMessage carries an optional pendingApproval", () => {
    const msg = {
      id: "m1", goalId: "g1", role: "orchestrator" as const, kind: "message" as const,
      body: "The agent wants to run a command.", correlationId: "c1",
      createdAt: "2026-06-03T00:00:00.000Z",
      pendingApproval: { approvalId: "a1", sessionId: "s1", toolName: "Bash", summary: "ls" },
    };
    expect(OrchestratorChatMessage.parse(msg).pendingApproval?.approvalId).toBe("a1");
  });

  it("SubmitPermissionDecisionRequest validates decision + remember default", () => {
    expect(SubmitPermissionDecisionRequest.parse({ decision: "allow" })).toEqual({ decision: "allow", remember: false });
    expect(SubmitPermissionDecisionRequest.parse({ decision: "deny", remember: true })).toEqual({ decision: "deny", remember: true });
    expect(SubmitPermissionDecisionRequest.safeParse({ decision: "maybe" }).success).toBe(false);
  });

  it("UpdateWorkerPermissionModeRequest validates the mode", () => {
    expect(UpdateWorkerPermissionModeRequest.parse({ workerPermissionMode: "auto" }).workerPermissionMode).toBe("auto");
    expect(UpdateWorkerPermissionModeRequest.safeParse({ workerPermissionMode: "x" }).success).toBe(false);
  });
});
