import { describe, expect, it } from "vitest";
import { HarnessTransition, HarnessTransitionBoundary } from "./index.js";

describe("HarnessTransition", () => {
  it("accepts a spine record with null facets", () => {
    const parsed = HarnessTransition.parse({
      id: "t1",
      goalId: "g1",
      workflowRunId: "r1",
      workflowStepRunId: "s1",
      boundary: "step_complete",
      risk: null,
      evidence: null,
      stateDeps: null,
      telemetry: null,
      createdAt: "2026-06-23T00:00:00.000Z",
    });
    expect(parsed.boundary).toBe("step_complete");
    expect(parsed.evidence).toBeNull();
  });

  it("rejects an unknown boundary", () => {
    expect(HarnessTransitionBoundary.safeParse("nope").success).toBe(false);
  });

  it("rejects extra keys (strict)", () => {
    const r = HarnessTransition.safeParse({
      id: "t1", goalId: "g1", workflowRunId: null, workflowStepRunId: null,
      boundary: "tool_gate", risk: null, evidence: null, stateDeps: null,
      telemetry: null, createdAt: "2026-06-23T00:00:00.000Z", extra: 1,
    });
    expect(r.success).toBe(false);
  });
});

import { EvidenceFacet, HarnessTransition as HT } from "./index.js";

describe("EvidenceFacet", () => {
  it("accepts a failed verdict with one sensor", () => {
    const f = EvidenceFacet.parse({
      sensorsRun: [
        { kind: "unit", command: "pnpm test", exitCode: 1, durationMs: 1200,
          result: "failed", summary: "1 failing", artifactRef: null },
      ],
      verdict: "failed",
      untestedRegions: [],
      residualRisk: [],
      oracleAdequacy: { sufficient: false, gaps: ["typecheck did not run"] },
    });
    expect(f.verdict).toBe("failed");
  });

  it("is accepted as the evidence facet on a transition", () => {
    const t = HT.parse({
      id: "t", goalId: "g", workflowRunId: null, workflowStepRunId: "s",
      boundary: "step_complete",
      risk: null,
      evidence: {
        sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [],
        oracleAdequacy: { sufficient: true, gaps: [] },
      },
      stateDeps: null, telemetry: null, createdAt: "2026-06-23T00:00:00.000Z",
    });
    expect(t.evidence?.verdict).toBe("passed");
  });
});
