import { describe, expect, it } from "vitest";
import type { TemplateTransition, TemplateStepRun } from "./fetch.js";
import { windowStart, SAMPLE_MIN, medianLatencyMs, firstPassRate, recoveredRate, escalatedRate, computeTemplateSummary } from "./aggregate.js";

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

function stepRun(runId: string, step: string, attempt: number, status: "passed" | "failed" | "blocked", version: number): TemplateStepRun {
  return {
    workflowRunId: runId,
    stepTemplateId: step,
    attempt,
    status,
    startedAt: "2026-05-01T00:00:00.000Z",
    finishedAt: "2026-05-01T00:01:00.000Z",
    blockedReason: status === "blocked" ? "blocked" : null,
    templateVersion: version,
  };
}

function gateTransition(id: string, runId: string, step: string, version: number, gateDecision: "require_approval" | "deny" | null): TemplateTransition {
  return {
    templateVersion: version, stepTemplateId: step,
    transition: {
      id, goalId: "g", workflowRunId: runId, workflowStepRunId: `${runId}-${step}`,
      boundary: "step_complete", risk: gateDecision ? { gate_decision: gateDecision } : null, stateDeps: null,
      evidence: { sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: true, gaps: [] } },
      telemetry: { cost: null, latency_ms: 100, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
      createdAt: "2026-05-01T00:00:00.000Z",
    },
  };
}

function humanInterventionTransition(id: string, runId: string, step: string, version: number): TemplateTransition {
  return {
    templateVersion: version, stepTemplateId: step,
    transition: {
      id, goalId: "g", workflowRunId: runId, workflowStepRunId: `${runId}-${step}`,
      boundary: "step_complete", risk: null, stateDeps: null,
      evidence: { sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: true, gaps: [] } },
      telemetry: { cost: null, latency_ms: 100, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [{ timestamp: "2026-05-01T00:00:00.000Z", action: "approved" }], outcome: { status: "succeeded", failure_code: null } },
      createdAt: "2026-05-01T00:00:00.000Z",
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

describe("recoveredRate", () => {
  it("counts distinct (run, step) with attempt > 1 and passed", () => {
    const runs: TemplateStepRun[] = [
      stepRun("r1", "s", 1, "passed", 1),
      stepRun("r2", "s", 1, "failed", 1),
      stepRun("r2", "s", 2, "passed", 1),
      stepRun("r3", "s", 1, "failed", 1),
      stepRun("r3", "s", 2, "failed", 1),
    ];
    // r1: first-pass, not recovered
    // r2: attempt 2 passed → recovered
    // r3: attempt 2 failed → not recovered
    // 1 recovered / 3 distinct = 0.333...
    expect(recoveredRate(runs)).toBeCloseTo(1 / 3);
  });

  it("returns null with no runs", () => {
    expect(recoveredRate([])).toBeNull();
  });
});

describe("escalatedRate", () => {
  it("counts distinct (run, step) with gate_decision require_approval or deny", () => {
    const ts: TemplateTransition[] = [
      gateTransition("a", "r1", "s", 1, "require_approval"),
      gateTransition("b", "r2", "s", 1, "deny"),
      gateTransition("c", "r3", "s", 1, null),
      gateTransition("d", "r4", "s", 1, null),
    ];
    // r1: require_approval → escalated
    // r2: deny → escalated
    // r3, r4: no gate decision → not escalated
    // 2 escalated / 4 distinct = 0.5
    expect(escalatedRate(ts)).toBeCloseTo(0.5);
  });

  it("counts transitions with human interventions as escalated", () => {
    const ts: TemplateTransition[] = [
      humanInterventionTransition("a", "r1", "s", 1),
      gateTransition("b", "r2", "s", 1, null),
      gateTransition("c", "r3", "s", 1, null),
    ];
    // r1: human intervention → escalated
    // r2, r3: no escalation
    // 1 escalated / 3 distinct = 0.333...
    expect(escalatedRate(ts)).toBeCloseTo(1 / 3);
  });

  it("returns null with no transitions", () => {
    expect(escalatedRate([])).toBeNull();
  });

  it("ignores transitions without workflowRunId or workflowStepRunId", () => {
    const ts: TemplateTransition[] = [
      {
        templateVersion: 1, stepTemplateId: "s",
        transition: {
          id: "a", goalId: "g", workflowRunId: null, workflowStepRunId: null,
          boundary: "step_complete", risk: { gate_decision: "require_approval" }, stateDeps: null,
          evidence: { sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: true, gaps: [] } },
          telemetry: { cost: null, latency_ms: 100, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      },
      gateTransition("b", "r2", "s", 1, null),
    ];
    // The first transition is skipped because it has no workflowRunId/workflowStepRunId
    // Only r2 is counted: 0 escalated / 1 distinct = 0
    expect(escalatedRate(ts)).toBeCloseTo(0);
  });

  it("returns null when all transitions lack workflowRunId or workflowStepRunId", () => {
    const ts: TemplateTransition[] = [
      {
        templateVersion: 1, stepTemplateId: "s",
        transition: {
          id: "a", goalId: "g", workflowRunId: null, workflowStepRunId: null,
          boundary: "step_complete", risk: { gate_decision: "require_approval" }, stateDeps: null,
          evidence: { sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: true, gaps: [] } },
          telemetry: { cost: null, latency_ms: 100, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      },
    ];
    expect(escalatedRate(ts)).toBeNull();
  });
});

describe("computeTemplateSummary", () => {
  it("happy path: two template versions → versionComparison non-null", () => {
    const summary = computeTemplateSummary({
      templateId: "t1", name: "Test Template", latestVersion: 2, runCount: 10,
      versions: [
        { version: 1, runs: 5, firstSeenAt: "2026-05-01T00:00:00.000Z" },
        { version: 2, runs: 5, firstSeenAt: "2026-05-02T00:00:00.000Z" },
      ],
      current: {
        transitions: [
          stepComplete("a", "r1", "s1", 1, 100, "passed", "2026-05-02T00:00:00.000Z"),
          stepComplete("b", "r2", "s1", 2, 120, "passed", "2026-05-03T00:00:00.000Z"),
        ],
        stepRuns: [
          stepRun("r1", "s1", 1, "passed", 1),
          stepRun("r2", "s1", 1, "passed", 2),
        ],
      },
      prior: { transitions: [], stepRuns: [] },
    });
    expect(summary.templateId).toBe("t1");
    expect(summary.latestVersion).toBe(2);
    expect(summary.versionComparison).not.toBeNull();
    expect(summary.versionComparison?.latest).toBe(2);
    expect(summary.versionComparison?.prior).toBe(1);
    expect(summary.versionComparison?.byDimension).toBeDefined();
  });

  it("single template version → versionComparison is null", () => {
    const summary = computeTemplateSummary({
      templateId: "t1", name: "Test Template", latestVersion: 1, runCount: 10,
      versions: [
        { version: 1, runs: 10, firstSeenAt: "2026-05-01T00:00:00.000Z" },
      ],
      current: {
        transitions: [
          stepComplete("a", "r1", "s1", 1, 100, "passed", "2026-05-02T00:00:00.000Z"),
        ],
        stepRuns: [
          stepRun("r1", "s1", 1, "passed", 1),
        ],
      },
      prior: { transitions: [], stepRuns: [] },
    });
    expect(summary.versionComparison).toBeNull();
  });

  it("runCount < SAMPLE_MIN → confidence is low", () => {
    const summary = computeTemplateSummary({
      templateId: "t1", name: "Test Template", latestVersion: 1, runCount: 3,
      versions: [
        { version: 1, runs: 3, firstSeenAt: "2026-05-01T00:00:00.000Z" },
      ],
      current: {
        transitions: [
          stepComplete("a", "r1", "s1", 1, 100, "passed", "2026-05-02T00:00:00.000Z"),
        ],
        stepRuns: [
          stepRun("r1", "s1", 1, "passed", 1),
        ],
      },
      prior: { transitions: [], stepRuns: [] },
    });
    expect(summary.runs).toBe(3);
    expect(summary.confidence).toBe("low");
  });

  it("runCount >= SAMPLE_MIN → confidence is ok", () => {
    const summary = computeTemplateSummary({
      templateId: "t1", name: "Test Template", latestVersion: 1, runCount: 5,
      versions: [
        { version: 1, runs: 5, firstSeenAt: "2026-05-01T00:00:00.000Z" },
      ],
      current: {
        transitions: [
          stepComplete("a", "r1", "s1", 1, 100, "passed", "2026-05-02T00:00:00.000Z"),
        ],
        stepRuns: [
          stepRun("r1", "s1", 1, "passed", 1),
        ],
      },
      prior: { transitions: [], stepRuns: [] },
    });
    expect(summary.confidence).toBe("ok");
  });

  it("includes recovered and escalated rates", () => {
    const summary = computeTemplateSummary({
      templateId: "t1", name: "Test Template", latestVersion: 1, runCount: 2,
      versions: [
        { version: 1, runs: 2, firstSeenAt: "2026-05-01T00:00:00.000Z" },
      ],
      current: {
        transitions: [
          stepComplete("a", "r1", "s1", 1, 100, "passed", "2026-05-02T00:00:00.000Z"),
          gateTransition("b", "r2", "s1", 1, "require_approval"),
        ],
        stepRuns: [
          stepRun("r1", "s1", 1, "passed", 1),
          stepRun("r2", "s1", 1, "failed", 1),
          stepRun("r2", "s1", 2, "passed", 1),
        ],
      },
      prior: { transitions: [], stepRuns: [] },
    });
    expect(summary.recovered).toBeCloseTo(0.5); // r2 is the recovered one
    expect(summary.escalated).toBeCloseTo(0.5); // r2 has gate_decision require_approval
  });
});
