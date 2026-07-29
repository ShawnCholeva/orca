import { describe, expect, it } from "vitest";
import type { TemplateTransition, TemplateStepRun } from "./fetch.js";
import { computeStepMetrics, deriveInsights } from "./aggregate.js";
import type { CalibrationEntry } from "./verification.js";
import { firstSentence } from "./usecases.js";

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
const nowIso = "2026-05-08T00:00:00.000Z";

// Completion-shape builders for band-derivation tests, reusing sc()'s base shape
// (same evidence/telemetry skeleton composed-score.test.ts uses via tx()/ev()).
function groundingPassedTxs(step: string, n: number): TemplateTransition[] {
  return Array.from({ length: n }, (_, i) => {
    const t = sc(`g${i}`, `r${i}`, step, "passed", false, `2026-05-01T00:0${i}:00.000Z`);
    t.transition.evidence!.grounding = {
      checks: [{ rule: "paths_exist", field: "files_in_scope", mode: "enforce", result: "passed", detail: "" }],
      verdict: "passed",
    };
    return t;
  });
}
function executableTxs(step: string, n: number): TemplateTransition[] {
  return Array.from({ length: n }, (_, i) => {
    const t = sc(`e${i}`, `r${i}`, step, "passed", true, `2026-05-01T00:0${i}:00.000Z`);
    t.transition.evidence!.sensorsRun = [
      { kind: "unit", command: "npm test", exitCode: 0, durationMs: 500, result: "passed", summary: "ok", artifactRef: null },
    ];
    return t;
  });
}
function selfReportTxs(step: string, n: number): TemplateTransition[] {
  return Array.from({ length: n }, (_, i) => sc(`s${i}`, `r${i}`, step, "passed", false, `2026-05-01T00:0${i}:00.000Z`));
}
function unverifiedTxs(step: string, n: number): TemplateTransition[] {
  return Array.from({ length: n }, (_, i) => ({
    templateVersion: 1, stepTemplateId: step,
    transition: {
      id: `u${i}`, goalId: "g", workflowRunId: `r${i}`, workflowStepRunId: `r${i}-${step}`,
      boundary: "step_complete", risk: null, stateDeps: null, evidence: null, refute: null,
      telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "failed", failure_code: "evaluation_failed" } },
      createdAt: `2026-05-01T00:0${i}:00.000Z`,
    },
  }));
}
function passRuns(step: string, n: number): TemplateStepRun[] {
  return Array.from({ length: n }, (_, i) => ({
    workflowRunId: `r${i}`, stepTemplateId: step, attempt: 1, status: "passed",
    startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0,
  }));
}

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
      blockedReason: t.transition.evidence!.verdict === "passed" ? null : `fail ${i}`, templateVersion: 1, stallRescues: 0,
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
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "failed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: "vetoed", templateVersion: 1, stallRescues: 0 },
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 2, status: "passed", startedAt: "2026-05-01T00:06:00.000Z", finishedAt: "2026-05-01T00:10:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 },
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
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:01:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 },
    ];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.quality.verifiedSampleSize).toBe(0);
    expect(step.score).toBeNull();
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
    const runs: TemplateStepRun[] = ts.map((t) => ({ workflowRunId: t.transition.workflowRunId!, stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 }));
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBe(55); // round(0.55 * 100)
    expect(step.verification.tier).toBe("ai_reviewed");
    expect(step.verification.tierLabel).toBe("Reviewed, not proven");
  });

  it("does not report sensorPassRate=1 when no sensors ran", () => {
    const ts = [sc("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z")]; // sc builds evidence with sensorsRun: []
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 }];
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
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.verification.falseAcceptanceRate).toBe(1);
    expect(step.score).toBe(0); // refuted → isFail → contributes 0
  });

  it("is replayable: same evidence yields the same score twice", () => {
    const ts = [sc("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z")];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 }];
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
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.failureModes.some((f) => /overturned|independent check/i.test(f.label))).toBe(true);
    expect(step.reconciliation?.refuted).toBe(true);
  });

  it("hard failures drag the score: a run that dies without a step_complete counts as 0", () => {
    // One verified pass (conf 1.0 via sensors+sufficient oracle) + one hard-failed run.
    const p1 = sc("p1", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z");
    p1.transition.evidence!.sensorsRun = [
      { kind: "unit", command: "npm test", exitCode: 0, durationMs: 500, result: "passed", summary: "ok", artifactRef: null },
    ];
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 },
      { workflowRunId: "r2", stepTemplateId: "s", attempt: 1, status: "failed", startedAt: "2026-05-01T01:00:00.000Z", finishedAt: "2026-05-01T01:05:00.000Z", blockedReason: "provider crashed", templateVersion: 1, stallRescues: 0 },
    ];
    const [step] = computeStepMetrics({ transitions: [p1], stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBe(50); // (1.0 + 0) / 2 — not 100
    expect(step.quality.scoredSampleSize).toBe(2);
  });

  it("survivorship edge: a FINAL attempt that hard-fails AFTER an earlier passing completion scores the run as a hard fail, not a 1.0 pass", () => {
    // attempt-1 emits a passing step_complete at T1; attempt-2 (the run's FINAL
    // attempt) hard-fails later at T2 > T1 with no second step_complete. The stale
    // pass from attempt-1 must not be credited — the run's delivered state is the
    // later hard failure.
    const p1 = sc("p1", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z"); // T1
    p1.transition.evidence!.sensorsRun = [
      { kind: "unit", command: "npm test", exitCode: 0, durationMs: 500, result: "passed", summary: "ok", artifactRef: null },
    ];
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 },
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 2, status: "failed", startedAt: "2026-05-01T00:06:00.000Z", finishedAt: "2026-05-01T01:00:00.000Z", blockedReason: "regressed after the recorded pass", templateVersion: 1, stallRescues: 0 }, // T2 > T1
    ];
    const [step] = computeStepMetrics({ transitions: [p1], stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBe(0);
    expect(step.quality.scoredSampleSize).toBe(1);
  });

  it("veto-then-pass is unaffected by the survivorship edge fix (final attempt PASSED)", () => {
    // Same shape as the #1/#7 test above but re-asserted here to guard the new
    // supersededByHardFail logic doesn't touch runs whose final attempt passed.
    const p1 = sc("p1", "r1", "s", "passed", true, "2026-05-01T00:10:00.000Z");
    p1.transition.evidence!.sensorsRun = [
      { kind: "unit", command: "npm test", exitCode: 0, durationMs: 500, result: "passed", summary: "ok", artifactRef: null },
    ];
    const ts = [
      sc("v1", "r1", "s", "failed", true, "2026-05-01T00:00:00.000Z"),
      p1,
    ];
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "failed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: "vetoed", templateVersion: 1, stallRescues: 0 },
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 2, status: "passed", startedAt: "2026-05-01T00:06:00.000Z", finishedAt: "2026-05-01T00:10:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 },
    ];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBe(100);
  });

  it("pure hard-fail (no completion at all) is unaffected by the survivorship edge fix", () => {
    const ts: TemplateTransition[] = [{
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id: "launch1", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s",
        boundary: "step_launch", risk: null, stateDeps: null, evidence: null,
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    }];
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "failed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: "provider crashed", templateVersion: 1, stallRescues: 0 },
    ];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBe(0);
    expect(step.quality.scoredSampleSize).toBe(1);
  });

  it("survivorship edge: no reclassification when the failed final attempt has no finishedAt (no ordering evidence)", () => {
    const p1 = sc("p1", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z");
    p1.transition.evidence!.sensorsRun = [
      { kind: "unit", command: "npm test", exitCode: 0, durationMs: 500, result: "passed", summary: "ok", artifactRef: null },
    ];
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 },
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 2, status: "failed", startedAt: "2026-05-01T00:06:00.000Z", finishedAt: null, blockedReason: "still running when sampled", templateVersion: 1, stallRescues: 0 },
    ];
    const [step] = computeStepMetrics({ transitions: [p1], stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBe(100);
  });

  it("score is 0 (not null) when EVERY final attempt hard-fails — no step_complete at all", () => {
    // Zero step_complete transitions for this step; both final attempts hard-fail
    // (one "failed", one "blocked"). computeStepMetrics buckets steps by transition,
    // so give the step ONE non-step_complete boundary transition to make it appear
    // in byStep at all (a fully transition-less step remains invisible — known
    // plan-level limitation, not fixed here).
    const ts: TemplateTransition[] = [{
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id: "launch1", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s",
        boundary: "step_launch", risk: null, stateDeps: null, evidence: null,
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    }];
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "failed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: "provider crashed", templateVersion: 1, stallRescues: 0 },
      { workflowRunId: "r2", stepTemplateId: "s", attempt: 1, status: "blocked", startedAt: "2026-05-01T01:00:00.000Z", finishedAt: "2026-05-01T01:05:00.000Z", blockedReason: "waiting on approval", templateVersion: 1, stallRescues: 0 },
    ];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBe(0);
    expect(step.quality.scoredSampleSize).toBe(2);
  });

  it("score is null (not 0) when nothing is scoreable", () => {
    // Only an evaluation_failed completion on a passed run: unverified, no hard fail.
    const ts: TemplateTransition[] = [{
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id: "e1", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s",
        boundary: "step_complete", risk: null, stateDeps: null, evidence: null, refute: null,
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "failed", failure_code: "evaluation_failed" } },
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    }];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:01:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBeNull();
    expect(step.quality.scoredSampleSize).toBe(0);
  });

  it("a self_reported completion (inconclusive refute) is unknown, dropped from the mean (T2)", () => {
    // Refute ran but was inconclusive ("unavailable") — no passing verifier, so
    // composedScore marks it established:false (unknown). Previously this floored
    // to the self_report confidence (0.3); now it's excluded from the score mean.
    const ts: TemplateTransition[] = [{
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id: "u1", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s",
        boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
        refute: { verdict: "unavailable", triggered_by: ["no_oracle"], risk_class: "low", reason: null, issue_refs: [] },
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    }];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBeNull();
    expect(step.verification.tier).toBe("unverified");
  });

  it("oracleSufficientRate is null (not 0) when no evidence completions exist", () => {
    const ts: TemplateTransition[] = [{
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id: "n1", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s",
        boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
        refute: { verdict: "upheld", triggered_by: ["no_oracle"], risk_class: "low", reason: null, issue_refs: [] },
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    }];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.quality.oracleSufficientRate).toBeNull();
  });

  it("grounding-only evidence keeps oracleSufficientRate null and surfaces a grounding artifact", () => {
    // A reasoning step whose completion carries only grounding checks: no
    // execution oracle ran, so the rate must stay null (unknown), not become 0.
    const t = sc("g1", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z");
    t.transition.evidence!.oracleAdequacy = { sufficient: false, gaps: [] };
    t.transition.evidence!.grounding = {
      checks: [{ rule: "paths_exist", field: "files_in_scope", mode: "enforce", result: "passed", detail: "" }],
      verdict: "passed",
    };
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 }];
    const [step] = computeStepMetrics({ transitions: [t], stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.quality.oracleSufficientRate).toBeNull();
    expect(step.verification.tier).toBe("partially_verified");
    expect(step.verification.artifacts.some((a) => a.source === "grounding")).toBe(true);
    expect(step.verification.artifacts.some((a) => a.source === "executable")).toBe(false);
  });

  it("failure clusters dedupe step_complete failures to the FINAL attempt (recovered veto not double-counted)", () => {
    const p1 = sc("p1", "r1", "s", "passed", true, "2026-05-01T00:10:00.000Z");
    const ts = [sc("v1", "r1", "s", "failed", true, "2026-05-01T00:00:00.000Z"), p1];
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "failed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: "vetoed", templateVersion: 1, stallRescues: 0 },
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 2, status: "passed", startedAt: "2026-05-01T00:06:00.000Z", finishedAt: "2026-05-01T00:10:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 },
    ];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    // The vetoed attempt "v1" was recovered; it must not survive as a failure cluster.
    expect(step.failureClusters).toEqual([]);
  });

  it("surfaces refute reasons: recentRefuteReasons + reconciliation.refuteReason", () => {
    const ts: TemplateTransition[] = [{
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id: "x", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s",
        boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
        refute: { verdict: "refuted", triggered_by: [], risk_class: "high", reason: "claimed tests ran but none exist", issue_refs: [] },
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    }];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.verification.recentRefuteReasons).toEqual(["claimed tests ran but none exist"]);
    expect(step.reconciliation?.refuteReason).toBe("claimed tests ran but none exist");
  });

  it("versionScoreDelta: per-step latest-vs-prior version score delta with VERSION_MIN gating", () => {
    const mk = (id: string, run: string, verdict: "passed" | "failed", v: number, at: string) => {
      const t = sc(id, run, "s", verdict, true, at);
      t.templateVersion = v;
      return t;
    };
    // v1: two failed evidence completions → composedScore 0 each (ev.verdict "failed" → zero()).
    // v2: two passed, with a real sensor that ran and oracleAdequacy.sufficient=true (via
    // sc()'s oracleSufficient param) → composedScore's executable verifier requires both
    // sensorsRun.length > 0 AND sufficient (matching classifyTier) → composed score 1.0 each,
    // honestly earned this time (verified_executed tier, not just a vacuous sufficiency).
    const c = mk("c", "r3", "passed", 2, "2026-05-02T00:00:00.000Z");
    const d = mk("d", "r4", "passed", 2, "2026-05-02T01:00:00.000Z");
    c.transition.evidence!.sensorsRun = [
      { kind: "unit", command: "npm test", exitCode: 0, durationMs: 1, result: "passed", summary: "", artifactRef: null },
    ];
    d.transition.evidence!.sensorsRun = [
      { kind: "unit", command: "npm test", exitCode: 0, durationMs: 1, result: "passed", summary: "", artifactRef: null },
    ];
    const ts = [
      mk("a", "r1", "failed", 1, "2026-05-01T00:00:00.000Z"), mk("b", "r2", "failed", 1, "2026-05-01T01:00:00.000Z"),
      c, d,
    ];
    const runs: TemplateStepRun[] = ts.map((t) => ({
      workflowRunId: t.transition.workflowRunId!, stepTemplateId: "s", attempt: 1,
      status: t.transition.evidence!.verdict === "passed" ? "passed" : "failed",
      startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z",
      blockedReason: null, templateVersion: t.templateVersion, stallRescues: 0,
    }));
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    // v2 mean = 1.0 (composed executable score), v1 mean = 0 → delta 1.0
    expect(step.versionScoreDelta).toBeCloseTo(1.0);
  });

  it("versionScoreDelta sees an all-hard-fail version even though it has no step_complete (I1)", () => {
    // v1: two scored completions (evidence present, no sensors, refute upheld →
    // independent review confidence 0.55 each; established, unlike a bare self-report).
    const ts = [
      sc("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z"),
      sc("b", "r2", "s", "passed", true, "2026-05-01T01:00:00.000Z"),
    ];
    for (const t of ts) {
      t.transition.refute = { verdict: "upheld", triggered_by: ["no_oracle"], risk_class: "low", reason: null, issue_refs: [] };
    }
    const runsV1: TemplateStepRun[] = ts.map((t) => ({
      workflowRunId: t.transition.workflowRunId!, stepTemplateId: "s", attempt: 1,
      status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z",
      blockedReason: null, templateVersion: 1, stallRescues: 0,
    }));
    // v2: two runs that hard-fail — never emit a step_complete at all.
    const runsV2: TemplateStepRun[] = [
      { workflowRunId: "r3", stepTemplateId: "s", attempt: 1, status: "failed", startedAt: "2026-05-02T00:00:00.000Z", finishedAt: "2026-05-02T00:05:00.000Z", blockedReason: "provider crashed", templateVersion: 2, stallRescues: 0 },
      { workflowRunId: "r4", stepTemplateId: "s", attempt: 1, status: "blocked", startedAt: "2026-05-02T01:00:00.000Z", finishedAt: "2026-05-02T01:05:00.000Z", blockedReason: "timed out", templateVersion: 2, stallRescues: 0 },
    ];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: [...runsV1, ...runsV2], stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    // v2 (all hard-fail) scores 0, v1 scores 0.55 → delta is negative, and the pair
    // must be visible even though v2 has zero finalStepCompletes.
    expect(step.versionScoreDelta).not.toBeNull();
    expect(step.versionScoreDelta!).toBeLessThan(0);
    expect(step.versionScoreDeltaVersions).toEqual({ latest: 2, prior: 1 });
  });

  it("versionInvalidOutputRateDelta: invalid-output completion rate, latest minus prior, VERSION_MIN-gated", () => {
    const mk = (id: string, run: string, code: string | null, v: number, at: string) => {
      const t = sc(id, run, "s", code ? "failed" : "passed", true, at);
      t.templateVersion = v;
      t.transition.telemetry!.outcome = { status: code ? "failed" : "succeeded", failure_code: code as never };
      return t;
    };
    const ts = [
      mk("a", "r1", null, 1, "2026-05-01T00:00:00.000Z"), mk("b", "r2", null, 1, "2026-05-01T01:00:00.000Z"),
      mk("c", "r3", "invalid_output", 2, "2026-05-02T00:00:00.000Z"), mk("d", "r4", null, 2, "2026-05-02T01:00:00.000Z"),
    ];
    const runs: TemplateStepRun[] = ts.map((t) => ({
      workflowRunId: t.transition.workflowRunId!, stepTemplateId: "s", attempt: 1, status: "passed",
      startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: t.templateVersion, stallRescues: 0,
    }));
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.versionInvalidOutputRateDelta).toBeCloseTo(0.5); // v2: 1/2, v1: 0/2
  });

  it("scores identical-evidence completions identically (composed, not tier-quantized)", () => {
    // Two completions, each: grounding FAIL → evidence.verdict 'failed' → composed 0.
    // (Same evidence must yield the same score — the Research/Proposal incoherence fix.)
    const mk = (id: string, runId: string): TemplateTransition => ({
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id, goalId: "g", workflowRunId: runId, workflowStepRunId: `${runId}-s`,
        boundary: "step_complete", risk: null, stateDeps: null,
        evidence: { sensorsRun: [], verdict: "failed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: [] }, grounding: { checks: [], verdict: "failed" } },
        refute: { verdict: "upheld", triggered_by: [], risk_class: "low", reason: null, issue_refs: [] },
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "failed", failure_code: "invalid_output" } },
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    });
    const ts = [mk("a", "r1"), mk("b", "r2")];
    const runs: TemplateStepRun[] = ts.map((t) => ({ workflowRunId: t.transition.workflowRunId!, stepTemplateId: "s", attempt: 1, status: "failed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 }));
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBe(0); // both failed grounding → 0, no split by verification tier
  });

  it("emits an inspectable scoreBreakdown", () => {
    const t = sc("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z");
    t.transition.evidence!.sensorsRun = [
      { kind: "unit", command: "npm test", exitCode: 0, durationMs: 500, result: "passed", summary: "ok", artifactRef: null },
    ];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 }];
    const [step] = computeStepMetrics({ transitions: [t], stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.quality.scoreBreakdown?.meanBase).toBe(1);
    expect(step.quality.scoreBreakdown?.meanCoverage).toBe(1);
    expect(step.quality.scoreBreakdown?.coverageLimited).toBe(0);
    expect(step.quality.scoreBreakdown?.verifierMix).toEqual({ executable: 1, grounding: 0, independentReview: 0, selfReportOnly: 0 });
  });

  it("scoreBreakdown excludes fail-edge completions (refuted/failed) from coverage and verifier-mix stats", () => {
    // Fail-edge: refute upheld → composedScore's zero() (base:0, coverage:0). Must
    // NOT count toward coverageLimited or selfReportOnly — it's a failure, not a
    // coverage-capped or self-reported pass.
    const failed: TemplateTransition = {
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id: "f1", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s",
        boundary: "step_complete", risk: null, stateDeps: null,
        evidence: { sensorsRun: [], verdict: "failed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: [] } },
        refute: { verdict: "refuted", triggered_by: [], risk_class: "low", reason: "overturned", issue_refs: [] },
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "failed", failure_code: "invalid_output" } },
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    };
    // Grounding-passed (enforce, non-skipped) → composedScore.verifiers.grounding true, base 0.7.
    const groundingPassed: TemplateTransition = {
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id: "g1", goalId: "g", workflowRunId: "r2", workflowStepRunId: "r2-s",
        boundary: "step_complete", risk: null, stateDeps: null,
        evidence: {
          sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [],
          oracleAdequacy: { sufficient: false, gaps: [] },
          grounding: { checks: [{ rule: "paths_exist", field: "files_in_scope", mode: "enforce", result: "passed", detail: "" }], verdict: "passed" },
        },
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
        createdAt: "2026-05-01T00:01:00.000Z",
      },
    };
    const ts = [failed, groundingPassed];
    // r1's finishedAt equals its own completion's createdAt (not after) so the
    // hard-fail-supersede reclassification (aggregate.ts ~306-314, a DIFFERENT
    // mechanism for a later attempt superseding a stale earlier pass) does not
    // kick in here — this test isolates the scoreBreakdown fail-edge filter itself.
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "failed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:00:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 },
      { workflowRunId: "r2", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:01:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 },
    ];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.quality.scoreBreakdown?.coverageLimited).toBe(0);
    expect(step.quality.scoreBreakdown?.verifierMix).toEqual({ executable: 0, grounding: 1, independentReview: 0, selfReportOnly: 0 });
  });

  it("scoreBreakdown is empty when every completion is a fail-edge", () => {
    const failed: TemplateTransition = {
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id: "f1", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s",
        boundary: "step_complete", risk: null, stateDeps: null,
        evidence: { sensorsRun: [], verdict: "failed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: [] } },
        refute: { verdict: "refuted", triggered_by: [], risk_class: "low", reason: "overturned", issue_refs: [] },
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "failed", failure_code: "invalid_output" } },
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    };
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "failed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:00:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 },
    ];
    const [step] = computeStepMetrics({ transitions: [failed], stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.quality.scoreBreakdown?.meanBase).toBeNull();
    expect(step.quality.scoreBreakdown?.meanCoverage).toBeNull();
    expect(step.quality.scoreBreakdown?.coverageLimited).toBe(0);
    expect(step.quality.scoreBreakdown?.verifierMix).toEqual({ executable: 0, grounding: 0, independentReview: 0, selfReportOnly: 0 });
  });

  it("bands a majority-executed step 'strong' when the step requires execution", () => {
    // 2/3 scored completions had execution → STRICT majority → strong band. The step
    // is EXECUTION-REQUIRING (passed via requiresExecution) — the pre-Phase-B1 test's
    // intent (majority-executed → strong) is preserved by supplying that ceiling.
    const exec1 = sc("e1", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z");
    exec1.transition.evidence!.sensorsRun = [
      { kind: "unit", command: "npm test", exitCode: 0, durationMs: 500, result: "passed", summary: "ok", artifactRef: null },
    ];
    const exec2 = sc("e2", "r2", "s", "passed", true, "2026-05-01T00:01:00.000Z");
    exec2.transition.evidence!.sensorsRun = [
      { kind: "unit", command: "npm test", exitCode: 0, durationMs: 500, result: "passed", summary: "ok", artifactRef: null },
    ];
    const grounding = sc("g1", "r3", "s", "passed", true, "2026-05-01T00:02:00.000Z");
    grounding.transition.evidence!.oracleAdequacy = { sufficient: false, gaps: [] };
    grounding.transition.evidence!.grounding = {
      checks: [{ rule: "paths_exist", field: "files_in_scope", mode: "enforce", result: "passed", detail: "" }],
      verdict: "passed",
    };
    const ts = [exec1, exec2, grounding];
    const runs: TemplateStepRun[] = ts.map((t) => ({
      workflowRunId: t.transition.workflowRunId!, stepTemplateId: "s", attempt: 1, status: "passed",
      startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0,
    }));
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d", requiresExecution: new Set(["s"]) });
    expect(step.verification.band).toEqual({ level: "strong", label: "Run & tested" });
  });

  it("bands a HIGH-scoring grounding-only no-code step 'strong' (ceiling-relative, kind ≠ magnitude)", () => {
    // Grounding-only completions can score high (base 0.7); this step does NOT
    // require execution (requiresExecution not provided), so it is judged at its
    // best-available verifier — grounding — not against an execution bar it could
    // never meet. The score and the band both land honestly high here.
    const g1 = sc("g1", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z");
    g1.transition.evidence!.oracleAdequacy = { sufficient: false, gaps: [] };
    g1.transition.evidence!.grounding = {
      checks: [{ rule: "paths_exist", field: "files_in_scope", mode: "enforce", result: "passed", detail: "" }],
      verdict: "passed",
    };
    const g2 = sc("g2", "r2", "s", "passed", true, "2026-05-01T00:01:00.000Z");
    g2.transition.evidence!.oracleAdequacy = { sufficient: false, gaps: [] };
    g2.transition.evidence!.grounding = {
      checks: [{ rule: "paths_exist", field: "files_in_scope", mode: "enforce", result: "passed", detail: "" }],
      verdict: "passed",
    };
    const ts = [g1, g2];
    const runs: TemplateStepRun[] = ts.map((t) => ({
      workflowRunId: t.transition.workflowRunId!, stepTemplateId: "s", attempt: 1, status: "passed",
      startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0,
    }));
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBeGreaterThanOrEqual(70); // grounding base 0.7 × full coverage — a HIGH score
    expect(step.verification.band.level).toBe("strong");
    expect(step.verification.band.label).toBe("Reviewed");
  });

  it("bands a step with no conclusive verification 'needs_evidence'", () => {
    // evaluation_failed completion: unverified, no hard fail, score stays null.
    const ts: TemplateTransition[] = [{
      templateVersion: 1, stepTemplateId: "s",
      transition: {
        id: "e1", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s",
        boundary: "step_complete", risk: null, stateDeps: null, evidence: null, refute: null,
        telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "failed", failure_code: "evaluation_failed" } },
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    }];
    const runs: TemplateStepRun[] = [{ workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:01:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 }];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBeNull();
    expect(step.verification.band.level).toBe("needs_evidence");
    expect(step.verification.band.label).toBe("Not checked yet");
  });

  it("a step with only self-reported completions scores unknown (null / needs_evidence)", () => {
    // Bare completions: no sensors, no grounding, no refute — established:false
    // (unknown) per composedScore (Task 1). Must be excluded from the score mean,
    // not floored to the old self_report confidence.
    const [step] = computeStepMetrics({ transitions: selfReportTxs("s", 2), stepRuns: passRuns("s", 2), stepNames: names, nowIso, period: "7d" });
    expect(step.score).toBeNull();
    expect(step.verification.band.level).toBe("needs_evidence");
  });

  describe("step-type-aware band (Phase B1: ceiling-relative level + honest label)", () => {
    it("no-code step at its ceiling (grounding-majority) bands STRONG 'Reviewed'", () => {
      const [step] = computeStepMetrics({ transitions: groundingPassedTxs("s", 3), stepRuns: passRuns("s", 3), stepNames: names, nowIso, period: "7d" });
      expect(step.verification.band.level).toBe("strong");
      expect(step.verification.band.label).toBe("Reviewed");
    });

    it("a step that REQUIRES execution but wasn't executed bands WEAK 'Not tested'", () => {
      const [step] = computeStepMetrics({ transitions: groundingPassedTxs("s", 3), stepRuns: passRuns("s", 3), stepNames: names, nowIso, period: "7d", requiresExecution: new Set(["s"]) });
      expect(step.verification.band.level).toBe("weak");
      expect(step.verification.band.label).toBe("Not tested");
    });

    it("executed step bands STRONG 'Run & tested' when it requires execution", () => {
      const [step] = computeStepMetrics({ transitions: executableTxs("s", 3), stepRuns: passRuns("s", 3), stepNames: names, nowIso, period: "7d", requiresExecution: new Set(["s"]) });
      expect(step.verification.band.level).toBe("strong");
      expect(step.verification.band.label).toBe("Run & tested");
    });

    it("self-report-only no-code step bands 'needs_evidence' — unknown, not floored WEAK (T2)", () => {
      // No sensors, no grounding, no refute: established:false (unknown), excluded
      // from the score mean → score null, band needs_evidence, not a floored WEAK.
      const [step] = computeStepMetrics({ transitions: selfReportTxs("s", 3), stepRuns: passRuns("s", 3), stepNames: names, nowIso, period: "7d" });
      expect(step.verification.band.level).toBe("needs_evidence");
      expect(step.verification.band.label).toBe("Not checked yet");
    });

    it("a self-reported step reviewed by an APPROVING gate scores ~55, not unknown (Task 5)", () => {
      // Same bare self-report shape as selfReportTxs (no sensors, no grounding, no
      // refute) — normally unknown/null. gateApprovedByCompletion supplies the
      // real gate-approval signal (Task 3's gateApprovalsByStep, threaded read-time);
      // composedScore compounds it as a second independent review (Task 4).
      const gateApprovedByCompletion = (t: TemplateTransition) =>
        t.stepTemplateId === "s" && t.transition.workflowRunId === "r0";
      const [step] = computeStepMetrics({
        transitions: selfReportTxs("s", 1), stepRuns: passRuns("s", 1), stepNames: names, nowIso, period: "7d",
        gateApprovedByCompletion,
      });
      expect(step.score).toBe(55);
    });

    it("no conclusive verification → needs_evidence 'Not checked yet'", () => {
      const [step] = computeStepMetrics({ transitions: unverifiedTxs("s", 1), stepRuns: passRuns("s", 1), stepNames: names, nowIso, period: "7d" });
      expect(step.verification.band.level).toBe("needs_evidence");
      expect(step.verification.band.label).toBe("Not checked yet");
    });
  });

  it("tallies vindication outcomes over the step's final completions (Task 3, observational)", () => {
    const vindicationByCompletion = (t: TemplateTransition) =>
      t.transition.workflowRunId === "r0" ? "vindicated" as const : t.transition.workflowRunId === "r1" ? "bounced" as const : undefined;
    const [step] = computeStepMetrics({
      transitions: selfReportTxs("s", 2), stepRuns: passRuns("s", 2), stepNames: names, nowIso, period: "7d",
      vindicationByCompletion,
    });
    expect(step.vindication).toEqual({ vindicated: 1, bounced: 1, pending: 0 });
  });

  it("omits vindication entirely when no vindicationByCompletion predicate is supplied", () => {
    const [step] = computeStepMetrics({ transitions: selfReportTxs("s", 1), stepRuns: passRuns("s", 1), stepNames: names, nowIso, period: "7d" });
    expect(step.vindication).toBeUndefined();
  });

  it("shows only the current template's steps — fossils and retyped/renamed ids drop out", () => {
    const at = "2026-05-01T00:00:00.000Z";
    // three step_complete transitions: one current step, one retired step, one that is now a gate (plain step-era id)
    const tx = (id: string, run: string) => ({
      templateVersion: 1, stepTemplateId: id,
      transition: { workflowRunId: run, boundary: "step_complete", createdAt: at,
        evidence: { sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: [] } },
        telemetry: { outcome: { status: "succeeded", failure_code: null } } } as never,
    });
    const run = (id: string, r: string): TemplateStepRun => ({ workflowRunId: r, stepTemplateId: id, attempt: 1, status: "passed", startedAt: at, finishedAt: at, blockedReason: null, templateVersion: 1, stallRescues: 0 });
    const stepNames = new Map([["triage", { name: "Triage", ordinal: 0 }]]); // current template has ONE step

    const steps = computeStepMetrics({
      transitions: [tx("triage", "r1"), tx("validate_build", "r2"), tx("critique", "r3")],
      stepRuns: [run("triage", "r1"), run("validate_build", "r2"), run("critique", "r3")],
      stepNames, nowIso: "2026-05-08T00:00:00.000Z", period: "7d",
    });
    expect(steps.map((s) => s.stepTemplateId)).toEqual(["triage"]); // fossil + now-a-gate id excluded
  });

  it("falls back to showing all steps when the template's step set is unknown (empty stepNames)", () => {
    const at = "2026-05-01T00:00:00.000Z";
    const tx = (id: string, run: string) => ({
      templateVersion: 1, stepTemplateId: id,
      transition: { workflowRunId: run, boundary: "step_complete", createdAt: at,
        evidence: { sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: [] } },
        telemetry: { outcome: { status: "succeeded", failure_code: null } } } as never,
    });
    const run = (id: string, r: string): TemplateStepRun => ({ workflowRunId: r, stepTemplateId: id, attempt: 1, status: "passed", startedAt: at, finishedAt: at, blockedReason: null, templateVersion: 1, stallRescues: 0 });
    const steps = computeStepMetrics({
      transitions: [tx("a", "r1"), tx("b", "r2")], stepRuns: [run("a", "r1"), run("b", "r2")],
      stepNames: new Map(), nowIso: "2026-05-08T00:00:00.000Z", period: "7d",
    });
    expect(steps.map((s) => s.stepTemplateId).sort()).toEqual(["a", "b"]); // no filtering when set is unknown
  });
});

describe("deriveInsights", () => {
  it("flags a passing-but-weakly-verified step in plain language (no jargon)", () => {
    const insights = deriveInsights({
      stepTemplateId: "s", name: "X", ordinal: 0, score: 95, sampleSize: 10, confidence: "ok",
      runs: 10, passedFirstTry: 9, recovered: 1, failed: 0,
      quality: { verdictPassRate: 0.95, verifiedSampleSize: 10, scoredSampleSize: 10, sensorPassRate: 1, oracleSufficientRate: 0.2, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
      cost: { p50LatencyMs: 100, meanTokens: 100, meanUsd: 0.01, meanRetries: 0 },
      risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
      failureClusters: [],
      verification: { tier: "ai_reviewed", tierLabel: "Reviewed, not proven", confidence: 0.55, falseAcceptanceRate: 0, artifacts: [], recentRefuteReasons: [], band: { level: "weak", label: "Weakly verified" } },
      failureModes: [], reconciliation: null,
      trend: [], versionBoundaries: [], versionScoreDelta: null, versionInvalidOutputRateDelta: null, insights: [], recentReasons: [],
    });
    expect(insights.some((i) => /never independently proven|independently proven/i.test(i))).toBe(true);
    expect(insights.join(" ")).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });

  it("flags a self-reported pass as never independently proven (self_reported tier)", () => {
    const insights = deriveInsights({
      stepTemplateId: "s", name: "X", ordinal: 0, score: 30, sampleSize: 10, confidence: "ok",
      runs: 10, passedFirstTry: 10, recovered: 0, failed: 0,
      quality: { verdictPassRate: 1, verifiedSampleSize: 10, scoredSampleSize: 10, sensorPassRate: null, oracleSufficientRate: 0, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
      cost: { p50LatencyMs: 100, meanTokens: 100, meanUsd: 0.01, meanRetries: 0 },
      risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
      failureClusters: [],
      verification: { tier: "self_reported", tierLabel: "Reported success, no check", confidence: 0.3, falseAcceptanceRate: 0, artifacts: [], recentRefuteReasons: [], band: { level: "weak", label: "Weakly verified" } },
      failureModes: [], reconciliation: null,
      trend: [], versionBoundaries: [], versionScoreDelta: null, versionInvalidOutputRateDelta: null, insights: [], recentReasons: [],
    });
    expect(insights.some((i) => /never independently proven|independently proven/i.test(i))).toBe(true);
    expect(insights.join(" ")).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });

  it("flags a high false-acceptance rate as approving work without proof", () => {
    const insights = deriveInsights({
      stepTemplateId: "s", name: "X", ordinal: 0, score: 40, sampleSize: 10, confidence: "ok",
      runs: 10, passedFirstTry: 7, recovered: 0, failed: 3,
      quality: { verdictPassRate: 0.7, verifiedSampleSize: 10, scoredSampleSize: 10, sensorPassRate: 1, oracleSufficientRate: 0.9, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
      cost: { p50LatencyMs: 100, meanTokens: 100, meanUsd: 0.01, meanRetries: 0 },
      risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
      failureClusters: [],
      verification: { tier: "unverified", tierLabel: "No check yet", confidence: 0, falseAcceptanceRate: 0.3, artifacts: [], recentRefuteReasons: [], band: { level: "needs_evidence", label: "Needs more evidence" } },
      failureModes: [], reconciliation: null,
      trend: [], versionBoundaries: [], versionScoreDelta: null, versionInvalidOutputRateDelta: null, insights: [], recentReasons: [],
    });
    expect(insights.some((i) => /approves work without proof/i.test(i))).toBe(true);
    expect(insights.join(" ")).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });

  it("flags the most common failure mode by label and count", () => {
    const insights = deriveInsights({
      stepTemplateId: "s", name: "X", ordinal: 0, score: 60, sampleSize: 10, confidence: "ok",
      runs: 10, passedFirstTry: 7, recovered: 0, failed: 3,
      quality: { verdictPassRate: 0.7, verifiedSampleSize: 10, scoredSampleSize: 10, sensorPassRate: 1, oracleSufficientRate: 0.9, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
      cost: { p50LatencyMs: 100, meanTokens: 100, meanUsd: 0.01, meanRetries: 0 },
      risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
      failureClusters: [],
      verification: { tier: "unverified", tierLabel: "No check yet", confidence: 0, falseAcceptanceRate: 0, artifacts: [], recentRefuteReasons: [], band: { level: "needs_evidence", label: "Needs more evidence" } },
      failureModes: [{ label: "Timeout", count: 3, pct: 1 }], reconciliation: null,
      trend: [], versionBoundaries: [], versionScoreDelta: null, versionInvalidOutputRateDelta: null, insights: [], recentReasons: [],
    });
    expect(insights.some((i) => /most common problem: timeout \(3×\)/i.test(i))).toBe(true);
    expect(insights.join(" ")).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });

  it("flags loop/churn: high mean retries", () => {
    const insights = deriveInsights({
      stepTemplateId: "s", name: "X", ordinal: 0, score: 80, sampleSize: 10, confidence: "ok",
      runs: 10, passedFirstTry: 3, recovered: 7, failed: 0,
      quality: { verdictPassRate: 0.8, verifiedSampleSize: 10, scoredSampleSize: 10, sensorPassRate: 1, oracleSufficientRate: 0.9, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
      cost: { p50LatencyMs: 150, meanTokens: 500, meanUsd: 0.02, meanRetries: 2.0 },
      risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
      failureClusters: [],
      verification: { tier: "unverified", tierLabel: "No check yet", confidence: 0, falseAcceptanceRate: 0, artifacts: [], recentRefuteReasons: [], band: { level: "needs_evidence", label: "Needs more evidence" } },
      failureModes: [], reconciliation: null,
      trend: [], versionBoundaries: [], versionScoreDelta: null, versionInvalidOutputRateDelta: null, insights: [], recentReasons: [],
    });
    expect(insights.some((i) => /retry|loop|churn/i.test(i))).toBe(true);
  });

  it("yields empty insights for a healthy step", () => {
    const insights = deriveInsights({
      stepTemplateId: "s", name: "X", ordinal: 0, score: 90, sampleSize: 10, confidence: "ok",
      runs: 10, passedFirstTry: 9, recovered: 1, failed: 0,
      quality: { verdictPassRate: 0.9, verifiedSampleSize: 10, scoredSampleSize: 10, sensorPassRate: 1, oracleSufficientRate: 0.95, untestedRegions: [], residualRisk: [], oracleGaps: [], limitingDimension: null },
      cost: { p50LatencyMs: 100, meanTokens: 500, meanUsd: 0.01, meanRetries: 0.3 },
      risk: { riskClassDist: {}, gateDecisionDist: {}, hardConstraintViolations: 0, approvals: { count: 0, sampleTransitionIds: [] } },
      failureClusters: [],
      verification: { tier: "unverified", tierLabel: "No check yet", confidence: 0, falseAcceptanceRate: 0, artifacts: [], recentRefuteReasons: [], band: { level: "needs_evidence", label: "Needs more evidence" } },
      failureModes: [], reconciliation: null,
      trend: [], versionBoundaries: [], versionScoreDelta: null, versionInvalidOutputRateDelta: null, insights: [], recentReasons: [],
    });
    expect(insights).toEqual([]);
  });
});

describe("computeStepMetrics: calibration divergence insight", () => {
  // A completion whose only calibratable source is grounding (enforce-mode check
  // passed, no sensors run) — verifierMix.grounding > 0, so the grounding calibration
  // entry is one the step actually used and can surface.
  const groundingTx = (id: string, runId: string, at: string): TemplateTransition => ({
    templateVersion: 1, stepTemplateId: "s",
    transition: {
      id, goalId: "g", workflowRunId: runId, workflowStepRunId: `${runId}-s`,
      boundary: "step_complete", risk: null, stateDeps: null,
      evidence: {
        sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [],
        oracleAdequacy: { sufficient: false, gaps: [] },
        grounding: { checks: [{ rule: "paths_exist", field: "files_in_scope", mode: "enforce", result: "passed", detail: "" }], verdict: "passed" },
      },
      telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
      createdAt: at,
    },
  });
  const ts = [groundingTx("a", "r1", "2026-05-01T00:00:00.000Z")];
  const runs: TemplateStepRun[] = [{
    workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed",
    startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z",
    blockedReason: null, templateVersion: 1, stallRescues: 0,
  }];

  it("reports the divergence observationally, without claiming it moved the score", () => {
    const calibration: CalibrationEntry[] = [
      { source: "grounding", assumed: 0.7, measured: 0.95, sampleSize: 13, state: "measured" },
    ];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d", calibration });
    expect(step.quality.scoreBreakdown?.verifierMix.grounding).toBeGreaterThan(0);
    // Honest wording: reports measured vs. assumed, never claims the score changed.
    expect(step.insights.join(" ")).toMatch(/hold up 95%.*70% assumed/);
    expect(step.insights.join(" ")).not.toMatch(/now count for|so passes here/i);
    expect(step.insights.join(" ")).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });

  it("no divergence insight for a calibratable source the step didn't use", () => {
    const calibration: CalibrationEntry[] = [
      { source: "executable", assumed: 1.0, measured: 0.6, sampleSize: 13, state: "measured" },
    ];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d", calibration });
    expect(step.insights.some((i) => i.includes("hold up"))).toBe(false);
  });

  it("no divergence insight when sampleSize is below 10", () => {
    const calibration: CalibrationEntry[] = [
      { source: "grounding", assumed: 0.7, measured: 0.95, sampleSize: 9, state: "measured" },
    ];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d", calibration });
    expect(step.insights.some((i) => i.includes("hold up"))).toBe(false);
  });
});

describe("computeStepMetrics: independent_review calibration feeds the composed score (Task 3)", () => {
  // No evidence, refute upheld → ai_reviewed passes (independent_review prior 0.55
  // each). independent_review is calibrated via vindication only (never against refute
  // — it IS the refute signal, circular) — but once a vindication-derived posterior is
  // `measured` past CALIBRATION_SCORE_MIN, it DOES move the score (Task 3), same as
  // executable/grounding already did.
  const aiReviewedPasses: TemplateTransition[] = ["r1", "r2", "r3"].map((r, i) => ({
    templateVersion: 1, stepTemplateId: "s",
    transition: {
      id: `a${i}`, goalId: "g", workflowRunId: r, workflowStepRunId: `${r}-s`,
      boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
      refute: { verdict: "upheld", triggered_by: ["no_oracle"], risk_class: "low", reason: null, issue_refs: [] },
      telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
      createdAt: `2026-05-01T0${i}:00:00.000Z`,
    },
  }));
  const runs: TemplateStepRun[] = aiReviewedPasses.map((t) => ({
    workflowRunId: t.transition.workflowRunId!, stepTemplateId: "s", attempt: 1, status: "passed",
    startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0,
  }));

  it("a fully-upheld ai_reviewed step rises to the measured calibration when past threshold (100 now applies, Task 3)", () => {
    const calibration: CalibrationEntry[] = [
      { source: "independent_review", assumed: 0.55, measured: 1.0, sampleSize: 12, state: "measured" },
    ];
    const [step] = computeStepMetrics({ transitions: aiReviewedPasses, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d", calibration });
    expect(step.score).toBe(100);
    expect(step.verification.tier).toBe("ai_reviewed");
    expect(step.verification.tierLabel).toBe("Reviewed, not proven");
  });

  it("without calibration the same step keeps the 0.55 prior (score 55)", () => {
    const [step] = computeStepMetrics({ transitions: aiReviewedPasses, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.score).toBe(55);
  });

  it("NO-MOVEMENT: a small measured sample (below CALIBRATION_SCORE_MIN) does not move the score", () => {
    const calibration: CalibrationEntry[] = [
      { source: "independent_review", assumed: 0.55, measured: 1.0, sampleSize: 6, state: "measured" },
    ];
    const [step] = computeStepMetrics({ transitions: aiReviewedPasses, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d", calibration });
    expect(step.score).toBe(55);
  });

  it("a low measured rate now lowers the score below the prior (30 applies, Task 3)", () => {
    const calibration: CalibrationEntry[] = [
      { source: "independent_review", assumed: 0.55, measured: 0.3, sampleSize: 12, state: "measured" },
    ];
    const [step] = computeStepMetrics({ transitions: aiReviewedPasses, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d", calibration });
    expect(step.score).toBe(30);
  });
});

describe("step description + completionPolicy", () => {
  it("surfaces description (first sentence of instructions) + completionPolicy on the step metric", () => {
    const ts = [sc("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z")];
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 },
    ];
    const namesWithMeta = new Map([["s", { name: "Generate", ordinal: 2, description: "Assess the goal without changing code.", completionPolicy: "reasoning" }]]);
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: namesWithMeta, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.description).toBe("Assess the goal without changing code.");
    expect(step.completionPolicy).toBe("reasoning");
  });

  it("leaves description/completionPolicy undefined when stepNames doesn't carry them", () => {
    const ts = [sc("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z")];
    const runs: TemplateStepRun[] = [
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 },
    ];
    const [step] = computeStepMetrics({ transitions: ts, stepRuns: runs, stepNames: names, nowIso: "2026-05-08T00:00:00.000Z", period: "7d" });
    expect(step.description).toBeUndefined();
    expect(step.completionPolicy).toBeUndefined();
  });
});

describe("firstSentence", () => {
  it("takes the first sentence up to the first '. '", () => {
    expect(firstSentence("A. B")).toBe("A.");
  });

  it("caps a no-period string over 140 chars at a word boundary with an ellipsis", () => {
    const long = "word ".repeat(40).trim(); // 199 chars, no period
    const result = firstSentence(long)!;
    expect(result.length).toBeLessThanOrEqual(141);
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns undefined for empty or whitespace-only input", () => {
    expect(firstSentence("")).toBeUndefined();
    expect(firstSentence("   ")).toBeUndefined();
  });
});

describe("rescued steps cost the score", () => {
  const sr = (runId: string, over: Partial<TemplateStepRun> = {}): TemplateStepRun => ({
    workflowRunId: runId, stepTemplateId: "s", attempt: 1, status: "passed",
    startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:05:00.000Z",
    blockedReason: null, templateVersion: 1, stallRescues: 0, ...over,
  });
  // sc() alone leaves a completion unestablished (composed-score.ts requires an actual
  // passing verifier — sensorsRun.length > 0 for "executable" — not just oracleSufficient);
  // attach a passing sensor so these completions reach verified_executed (score 1) and the
  // rescue-weight math in the denominator is the only thing under test here.
  const scExecuted = (...args: Parameters<typeof sc>): TemplateTransition => {
    const t = sc(...args);
    t.transition.evidence!.sensorsRun = [
      { kind: "unit", command: "npm test", exitCode: 0, durationMs: 500, result: "passed", summary: "ok", artifactRef: null },
    ];
    return t;
  };

  it("a step that needed one rescue scores below three clean passes", () => {
    const ts = [
      scExecuted("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z"),
      scExecuted("b", "r2", "s", "passed", true, "2026-05-01T01:00:00.000Z"),
      scExecuted("c", "r3", "s", "passed", true, "2026-05-01T02:00:00.000Z"),
    ];
    const clean = computeStepMetrics({
      transitions: ts, stepRuns: [sr("r1"), sr("r2"), sr("r3")],
      stepNames: names, nowIso, period: "30d",
    })[0]!;
    const rescued = computeStepMetrics({
      transitions: ts, stepRuns: [sr("r1"), sr("r2"), sr("r3", { stallRescues: 1 })],
      stepNames: names, nowIso, period: "30d",
    })[0]!;

    expect(clean.verification.confidence).toBe(1);
    // n = 3 + 0.5 → 3.0 / 3.5
    expect(rescued.verification.confidence).toBeCloseTo(3 / 3.5, 6);
    expect(rescued.verification.confidence).toBeLessThan(clean.verification.confidence);
  });

  it("counts rescues from every attempt, not just the final one", () => {
    const ts = [scExecuted("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z")];
    const step = computeStepMetrics({
      transitions: ts,
      stepRuns: [
        sr("r1", { attempt: 1, status: "blocked", stallRescues: 2, blockedReason: "no progress" }),
        sr("r1", { attempt: 2, status: "passed", stallRescues: 0 }),
      ],
      stepNames: names, nowIso, period: "30d",
    })[0]!;
    // one conclusive pass, two rescues → 1.0 / (1 + 1.0)
    expect(step.verification.confidence).toBeCloseTo(0.5, 6);
  });

  // The brief's original version of this test left stallRescues at its default (0) on
  // both step runs, so it passed identically whether or not STALL_WEIGHT was wired into
  // the denominator — it was proving the pre-existing hardFailedFinals path, not this
  // feature. Adding a rescue to the cancelled run makes the hard-fail and rescue
  // channels compound in one assertion, so this test actually depends on STALL_WEIGHT.
  it("a blocked final with no completion is a hard zero, and rescues on it still add weight", () => {
    const step = computeStepMetrics({
      transitions: [scExecuted("a", "r1", "s", "passed", true, "2026-05-01T00:00:00.000Z")],
      stepRuns: [
        sr("r1"),
        sr("r2", { status: "blocked", blockedReason: "run_cancelled", finishedAt: "2026-05-01T01:00:00.000Z", stallRescues: 1 }),
      ],
      stepNames: names, nowIso, period: "30d",
    })[0]!;
    // one conclusive pass, one hard-failed run, one rescue on that same run
    // → 1.0 / (1 + 1 + 0.5*1) = 0.4
    expect(step.verification.confidence).toBeCloseTo(0.4, 6);
  });
});
