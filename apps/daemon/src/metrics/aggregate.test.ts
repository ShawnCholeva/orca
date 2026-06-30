import { describe, expect, it } from "vitest";
import type { TemplateTransition, TemplateStepRun } from "./fetch.js";
import { windowStart, SAMPLE_MIN, medianLatencyMs, firstPassRate } from "./aggregate.js";

function stepComplete(id: string, runId: string, step: string, version: number, latency: number, verdict: "passed" | "failed", at: string): TemplateTransition {
  return {
    templateVersion: version, stepTemplateId: step,
    transition: {
      id, goalId: "g", workflowRunId: runId, workflowStepRunId: `${runId}-${step}`,
      boundary: "step_complete", risk: null, stateDeps: null,
      evidence: { sensorsRun: [], verdict, untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: true, gaps: [] } },
      telemetry: { cost: null, latency_ms: latency, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: verdict === "passed" ? "succeeded" : "failed", failure_code: verdict === "passed" ? null : "invalid_output" } },
      createdAt: at,
    },
  };
}

describe("windowStart", () => {
  it("subtracts the period from now", () => {
    expect(windowStart("2026-05-08T00:00:00.000Z", "7d")).toBe("2026-05-01T00:00:00.000Z");
    expect(windowStart("2026-05-02T00:00:00.000Z", "24h")).toBe("2026-05-01T00:00:00.000Z");
  });
});

describe("medianLatencyMs", () => {
  it("returns the median latency over step_complete transitions", () => {
    const ts = [
      stepComplete("a", "r1", "s", 1, 100, "passed", "2026-05-01T00:00:00.000Z"),
      stepComplete("b", "r2", "s", 1, 300, "passed", "2026-05-01T00:00:00.000Z"),
      stepComplete("c", "r3", "s", 1, 200, "passed", "2026-05-01T00:00:00.000Z"),
    ];
    expect(medianLatencyMs(ts)).toBe(200);
  });
  it("returns null with no latency data", () => { expect(medianLatencyMs([])).toBeNull(); });
});

describe("firstPassRate", () => {
  it("counts distinct (run, step) passing on attempt 1", () => {
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:01:00.000Z", blockedReason: null, templateVersion: 1 },
      { workflowRunId: "r2", stepTemplateId: "s", attempt: 1, status: "failed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:01:00.000Z", blockedReason: "boom", templateVersion: 1 },
      { workflowRunId: "r2", stepTemplateId: "s", attempt: 2, status: "passed", startedAt: "2026-05-01T00:02:00.000Z", finishedAt: "2026-05-01T00:03:00.000Z", blockedReason: null, templateVersion: 1 },
    ];
    expect(firstPassRate(runs)).toBeCloseTo(0.5); // r1 first-pass; r2 recovered (not first-pass)
  });

  it("SAMPLE_MIN is 5", () => { expect(SAMPLE_MIN).toBe(5); });
});
