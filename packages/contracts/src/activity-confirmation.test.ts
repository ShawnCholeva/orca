import { describe, expect, it } from "vitest";
import { ActivitySourceKind, Activity } from "./index.js";

describe("step_confirmation_pending source kind", () => {
  it("is a valid source kind", () => {
    expect(ActivitySourceKind.parse("step_confirmation_pending")).toBe(
      "step_confirmation_pending"
    );
  });

  it("Activity accepts a paused confirmation row", () => {
    const a = Activity.parse({
      id: "a1",
      goalId: "g1",
      workflowRunId: "r1",
      stepRunId: "s1",
      agentSessionId: "sess1",
      turnOrdinal: 2,
      status: "paused_for_input",
      currentText: "Completeness 90% · Correctness 85% · Ready for handoff",
      finalSummary: null,
      sourceKind: "step_confirmation_pending",
      workCategory: null,
      confidence: null,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      completedAt: null
    });
    expect(a.sourceKind).toBe("step_confirmation_pending");
  });
});
