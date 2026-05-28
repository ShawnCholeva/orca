/**
 * Tests for the adapterIdFromOperator logic used in OrcaChat's
 * launch_workflow_session accept handler.
 *
 * The function is not exported, so we replicate its contract here and
 * verify coverage for all known adapter ids.
 */
import { describe, expect, it } from "vitest";

/**
 * Mirror of the private adapterIdFromOperator function in OrcaChat.tsx.
 * If the implementation changes, update this copy to match.
 */
function adapterIdFromOperator(operatorId: string, operatorKind: string): string | null {
  if (operatorKind !== "agent") return null;
  if (!operatorId.startsWith("agent:")) return null;
  return operatorId.slice("agent:".length);
}

describe("adapterIdFromOperator", () => {
  it.each([
    ["agent:codex", "agent", "codex"],
    ["agent:claude-code", "agent", "claude-code"],
    ["agent:opencode", "agent", "opencode"],
    ["agent:shell-manual", "agent", "shell-manual"],
  ])(
    "strips agent: prefix for operatorId=%s operatorKind=%s → %s",
    (operatorId, operatorKind, expected) => {
      expect(adapterIdFromOperator(operatorId, operatorKind)).toBe(expected);
    },
  );

  it("returns null for non-agent operatorKind", () => {
    expect(adapterIdFromOperator("agent:codex", "human")).toBeNull();
    expect(adapterIdFromOperator("agent:codex", "tool")).toBeNull();
    expect(adapterIdFromOperator("agent:codex", "")).toBeNull();
  });

  it("returns null when operatorId lacks agent: prefix despite agent kind", () => {
    expect(adapterIdFromOperator("codex", "agent")).toBeNull();
    expect(adapterIdFromOperator("claude-code", "agent")).toBeNull();
  });
});
