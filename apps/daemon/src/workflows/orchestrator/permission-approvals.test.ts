import { describe, it, expect } from "vitest";
import { PermissionApprovalStore } from "./permission-approvals.js";

describe("PermissionApprovalStore", () => {
  it("records a pending approval and resolves it with a decision", async () => {
    const store = new PermissionApprovalStore(() => "fixed-id");
    const handle = store.record({ toolUseId: "t1", sessionId: "s1", goalId: "g1", toolName: "Bash", summary: "ls", toolInput: {} });
    expect(handle.isNew).toBe(true);
    expect(handle.approvalId).toBe("fixed-id");
    const ok = store.resolveDecision("fixed-id", "allow");
    expect(ok).toBe(true);
    await expect(handle.answered).resolves.toBe("allow");
  });

  it("dedupes a duplicate toolUseId to the same pending approval (isNew=false)", () => {
    const store = new PermissionApprovalStore();
    const first = store.record({ toolUseId: "dup", sessionId: "s1", goalId: "g1", toolName: "Bash", summary: "ls", toolInput: {} });
    const second = store.record({ toolUseId: "dup", sessionId: "s1", goalId: "g1", toolName: "Bash", summary: "ls", toolInput: {} });
    expect(second.isNew).toBe(false);
    expect(second.approvalId).toBe(first.approvalId);
  });

  it("resolveDecision returns false for an unknown or already-resolved approval", () => {
    const store = new PermissionApprovalStore(() => "x");
    expect(store.resolveDecision("nope", "deny")).toBe(false);
    store.record({ toolUseId: "t", sessionId: "s", goalId: "g", toolName: "Bash", summary: "ls", toolInput: {} });
    expect(store.resolveDecision("x", "deny")).toBe(true);
    expect(store.resolveDecision("x", "deny")).toBe(false); // already resolved
  });

  it("get returns the pending approval's goalId for scope checks", () => {
    const store = new PermissionApprovalStore(() => "x");
    store.record({ toolUseId: "t", sessionId: "s", goalId: "g9", toolName: "Bash", summary: "ls", toolInput: {} });
    expect(store.get("x")?.goalId).toBe("g9");
  });

  it("stores and returns the raw toolInput for later rule derivation", () => {
    const store = new PermissionApprovalStore(() => "x");
    store.record({ toolUseId: "t", sessionId: "s", goalId: "g", toolName: "Bash", summary: "rm -rf build", toolInput: { command: "rm -rf build" } });
    expect(store.get("x")?.toolInput).toEqual({ command: "rm -rf build" });
  });
});
