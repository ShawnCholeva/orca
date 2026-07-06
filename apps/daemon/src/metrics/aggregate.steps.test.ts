import { describe, expect, it } from "vitest";
import type { TemplateTransition, TemplateStepRun } from "./fetch.js";
import { computeStepMetrics, deriveInsights } from "./aggregate.js";

function sc(id: string, runId: string, step: string, verdict: "passed" | "failed", oracleSufficient: boolean, at: string): TemplateTransition {
  return {
    templateVersion: 1, stepTemplateId: step,
    transition: {
      id, goalId: "g", workflowRunId: runId, workflowStepRunId: `${runId}-${step}`,
      boundary: "step_complete", risk: null, stateDeps: null,
      evidence: { sensorsRun: [], verdict, untestedRegions: verdict === "failed" ? ["auth path"] : [], residualRisk: [], oracleAdequacy: { sufficient: oracleSufficient, gaps: oracleSufficient ? [] : ["no integration test"] } },
      telemetry: { cost: { tokens_in: 100, tokens_out: 50, cache_read_tokens: null, cache_creation_tokens: null, usd: 0.01 }, latency_ms: 100, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: verdict === "passed" ? "succeeded" : "failed", failure_code: verdict === "passed" ? null : "invalid_output" } },
      createdAt: at,
    },
  };
}

const names = new Map([["s", { name: "Generate Proposal", ordinal: 2 }]]);

describe("computeStepMetrics", () => {
  it("rolls up a step's three channels and failure clusters", () => {
    const ts = [
      sc("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z"),
      sc("b", "r2", "s", "failed", false, "2026-05-01T01:00:00.000Z"),
      sc("c", "r3", "s", "failed", false, "2026-05-01T02:00:00.000Z"),
    ];
    const runs: TemplateStepRun[] = ts.map((t, i) => ({
      workflowRunId: t.transition.workflowRunId!, stepTemplateId: "s", attempt: 1,
      status: t.transition.evidence!.verdict === "passed" ? "passed" : "failed",
      startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z",
      blockedReason: t.transition.evidence!.verdict === "passed" ? null : `fail ${i}`, templateVersion: 1,
    }));
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.stepTemplateId).toBe("s");
    expect(step.name).toBe("Generate Proposal");
    expect(step.runs).toBe(3);
    expect(step.quality.verdictPassRate).toBeCloseTo(1 / 3);
    expect(step.quality.untestedRegions).toContain("auth path");
    expect(step.quality.oracleGaps).toContain("no integration test");
    expect(step.failureClusters).toEqual([
      { failureCode: "invalid_output", boundary: "step_complete", count: 2, sampleTransitionIds: ["b", "c"] },
    ]);
    expect(step.recentReasons.map((r) => r.reason)).toContain("fail 2");
  });

  it("scores the FINAL attempt per run: a veto-then-pass step is 100, not 50 (#1/#7)", () => {
    // Same run+step emits two step_completes: a vetoed attempt then a revised pass.
    // The final attempt carries an actual passing sensor, so it earns the top
    // verified_executed tier (conf 1.0) — an honest, not merely self-reported, 100.
    const p1 = sc("p1", "r1", "s", "passed", true, "2026-05-01T00:10:00.000Z");
    p1.transition.evidence!.sensorsRun = [
      { kind: "unit", command: "npm test", exitCode: 0, durationMs: 500, result: "passed", summary: "ok", artifactRef: null },
    ];
    const ts = [
      sc("v1", "r1", "s", "failed", true, "2026-05-01T00:00:00.000Z"),
      p1,
    ];
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "failed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: "vetoed", templateVersion: 1 },
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 2, status: "passed", startedAt: "2026-05-01T00:06:00.000Z", finishedAt: "2026-05-01T00:10:00.000Z", blockedReason: null, templateVersion: 1 },
    ];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    // The delivered state is the final (passed) attempt; the intermediate veto is
    // credited as a recovery, not double-counted against the score.
    expect(step.score).toBe(100);
    expect(step.quality.verdictPassRate).toBe(1);
    expect(step.recovered).toBe(1);
    expect(step.failed).toBe(0);
  });

  it("does NOT credit an evaluation-failed completion as a verified pass (#8)", () => {
    // Critique-style: refute upheld, but the evaluation itself failed (no scoring
    // supplied) → the step_complete is stamped failed/evaluation_failed. It must be
    // UNVERIFIED (zero verified coverage), never projected as a verified 100/A.
    const ts: TemplateTransition[] = [
      {
        templateVersion: 1, stepTemplateId: "s",
        transition: {
          id: "e1", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s",
          boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
          refute: { verdict: "upheld", triggered_by: ["no_oracle"], risk_class: "low", reason: null, issue_refs: [] },
          telemetry: { cost: null, latency_ms: 11000, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "failed", failure_code: "evaluation_failed" } },
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      },
    ];
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:01:00.000Z", blockedReason: null, templateVersion: 1 },
    ];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.quality.verifiedSampleSize).toBe(0);
    expect(step.score).not.toBe(100);
  });

  it("scores a passing AI-reviewed step in the mid-range, not 100", () => {
    // No evidence, refute upheld → ai_reviewed (conf 0.55).
    const ts: TemplateTransition[] = ["r1", "r2", "r3"].map((r, i) => ({
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id: `a${i}`, goalId: "g", workflowRunId: r, workflowStepRunId: `${r}-s`,
        boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
        refute: { verdict: "upheld", triggered_by: ["no_oracle"], risk_class: "low", reason: null, issue_refs: [] },
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
        createdAt: `2026-05-01T0${i}:00:00.000Z`,
      },
    }));
    const runs: TemplateStepRun[] = ts.map((t) => ({ workflowRunId: t.transition.workflowRunId!, stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1 }));
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBe(55); // round(0.55 * 100)
    expect(step.verification.tier).toBe("ai_reviewed");
    expect(step.verification.tierLabel).toBe("Reviewed, not proven");
  });

  it("does not report sensorPassRate=1 when no sensors ran", () => {
    const ts = [sc("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z")]; // sc builds evidence with sensorsRun: []
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.quality.sensorPassRate).toBeNull();
  });

  it("false-acceptance: a refuted self-reported pass lowers the score and is counted", () => {
    const ts: TemplateTransition[] = [{
      templateVersion: 1, stepTemplateId: "s",
      transition: { id: "x", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s", boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
        refute: { verdict: "refuted", triggered_by: [], risk_class: "high", reason: "broke a rule", issue_refs: [] },
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
        createdAt: "2026-05-01T00:00:00.000Z" },
    }];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.verification.falseAcceptanceRate).toBe(1);
    expect(step.score).toBe(0); // refuted → isFail → contributes 0
  });

  it("is replayable: same evidence yields the same score twice", () => {
    const ts = [sc("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z")];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1 }];
    const args = { transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" as const };
    expect(computeStepMetrics(args)[0].score).toBe(computeStepMetrics(args)[0].score);
  });

  it("surfaces a refuted pass as a readable failure mode", () => {
    const ts: TemplateTransition[] = [{
      templateVersion: 1, stepTemplateId: "s",
      transition: { id: "x", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s", boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
        refute: { verdict: "refuted", triggered_by: [], risk_class: "high", reason: "broke a rule", issue_refs: [] },
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
        createdAt: "2026-05-01T00:00:00.000Z" },
    }];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.failureModes.some((f) => /overturned|independent check/i.test(f.label))).toBe(true);
    expect(step.reconciliation?.refuted).toBe(true);
  });
});

describe("deriveInsights", () => {
  it("flags a passing-but-weakly-verified step in plain language (no jargon)", () => {
    const insights = deriveInsights({
      stepTemplateId: "s", name: "X", ordinal: 0, score: 95, sampleSize: 10, confidence: "ok",
      runs: 10, passedFirstTry: 9, recovered: 1, failed: 0,
      quality: { verdictPassRate: 0.95, verifiedSampleSize: 10, sensorPassRate: 1, oracleSufficientRate: 0.2, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
      cost: { p50LatencyMs: 100, meanTokens: 100, meanUsd: 0.01, meanRetries: 0 },
      risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
      failureClusters: [],
      verification: { tier: "ai_reviewed", tierLabel: "Reviewed, not proven", confidence: 0.55, falseAcceptanceRate: 0, artifacts: [] },
      failureModes: [], reconciliation: null,
      trend: [], versionBoundaries: [], insights: [], recentReasons: [],
    });
    expect(insights.some((i) => /never independently proven|independently proven/i.test(i))).toBe(true);
    expect(insights.join(" ")).not.toMatch(/oracle|sensor|verdict/i);
  });

  it("flags cost without verification gain: high tokens, never independently proven", () => {
    const insights = deriveInsights({
      stepTemplateId: "s", name: "X", ordinal: 0, score: 50, sampleSize: 10, confidence: "ok",
      runs: 10, passedFirstTry: 4, recovered: 1, failed: 5,
      quality: { verdictPassRate: 0.5, verifiedSampleSize: 10, sensorPassRate: 1, oracleSufficientRate: 0.9, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
      cost: { p50LatencyMs: 200, meanTokens: 5000, meanUsd: 0.05, meanRetries: 0.2 },
      risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
      failureClusters: [],
      verification: { tier: "self_reported", tierLabel: "Reported success, no check", confidence: 0.3, falseAcceptanceRate: 0, artifacts: [] },
      failureModes: [], reconciliation: null,
      trend: [], versionBoundaries: [], insights: [], recentReasons: [],
    });
    expect(insights.some((i) => /independently proven/i.test(i))).toBe(true);
    expect(insights.join(" ")).not.toMatch(/oracle|sensor|verdict/i);
  });

  it("flags loop/churn: high mean retries", () => {
    const insights = deriveInsights({
      stepTemplateId: "s", name: "X", ordinal: 0, score: 80, sampleSize: 10, confidence: "ok",
      runs: 10, passedFirstTry: 3, recovered: 7, failed: 0,
      quality: { verdictPassRate: 0.8, verifiedSampleSize: 10, sensorPassRate: 1, oracleSufficientRate: 0.9, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
      cost: { p50LatencyMs: 150, meanTokens: 500, meanUsd: 0.02, meanRetries: 2.0 },
      risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
      failureClusters: [],
      verification: { tier: "unverified", tierLabel: "No check yet", confidence: 0, falseAcceptanceRate: 0, artifacts: [] },
      failureModes: [], reconciliation: null,
      trend: [], versionBoundaries: [], insights: [], recentReasons: [],
    });
    expect(insights.some((i) => /retry|loop|churn/i.test(i))).toBe(true);
  });

  it("yields empty insights for a healthy step", () => {
    const insights = deriveInsights({
      stepTemplateId: "s", name: "X", ordinal: 0, score: 90, sampleSize: 10, confidence: "ok",
      runs: 10, passedFirstTry: 9, recovered: 1, failed: 0,
      quality: { verdictPassRate: 0.9, verifiedSampleSize: 10, sensorPassRate: 1, oracleSufficientRate: 0.95, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
      cost: { p50LatencyMs: 100, meanTokens: 500, meanUsd: 0.01, meanRetries: 0.3 },
      risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
      failureClusters: [],
      verification: { tier: "unverified", tierLabel: "No check yet", confidence: 0, falseAcceptanceRate: 0, artifacts: [] },
      failureModes: [], reconciliation: null,
      trend: [], versionBoundaries: [], insights: [], recentReasons: [],
    });
    expect(insights).toEqual([]);
  });
});
