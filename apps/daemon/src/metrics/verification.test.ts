import { describe, expect, it } from "vitest";
import type { TemplateTransition } from "./fetch.js";
import { classifyTier, strongestTier, TIER_CONFIDENCE, buildArtifacts, computeCalibration } from "./verification.js";

function tx(over: Partial<TemplateTransition["transition"]>): TemplateTransition {
  return {
    templateVersion: 1, stepTemplateId: "s",
    transition: {
      id: "t", goalId: "g", workflowRunId: "r", workflowStepRunId: "r-s",
      boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
      telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null,
        prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [],
        outcome: { status: "succeeded", failure_code: null } },
      createdAt: "2026-05-01T00:00:00.000Z", ...over,
    },
  };
}

describe("classifyTier", () => {
  it("verified_executed: sensors ran and oracle sufficient", () => {
    expect(classifyTier(tx({ evidence: { sensorsRun: [{ kind: "unit", command: "t", exitCode: 0, durationMs: 1, result: "passed", summary: "", artifactRef: null }], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: true, gaps: [] } } }))).toBe("verified_executed");
  });
  it("partially_verified: sensors ran but oracle not sufficient", () => {
    expect(classifyTier(tx({ evidence: { sensorsRun: [{ kind: "unit", command: "t", exitCode: 1, durationMs: 1, result: "failed", summary: "", artifactRef: null }], verdict: "partial", untestedRegions: ["x"], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: ["no integ test"] } } }))).toBe("partially_verified");
  });
  it("ai_reviewed: no evidence, refute upheld", () => {
    expect(classifyTier(tx({ evidence: null, refute: { verdict: "upheld", triggered_by: [], risk_class: "low", reason: null, issue_refs: [] } }))).toBe("ai_reviewed");
  });
  it("no evidence + inconclusive refute → self_reported, not unverified (spec §6)", () => {
    const base = {
      id: "t1", goalId: "g", workflowRunId: "r1", workflowStepRunId: "r1-s",
      boundary: "step_complete", risk: null, stateDeps: null, evidence: null,
      telemetry: null, createdAt: "2026-05-01T00:00:00.000Z",
    };
    for (const verdict of ["unavailable", "uncertain"] as const) {
      const t = { templateVersion: 1, stepTemplateId: "s", transition: { ...base, refute: { verdict, triggered_by: ["no_oracle"], risk_class: "low", reason: null, issue_refs: [] } } };
      expect(classifyTier(t as never)).toBe("self_reported");
    }
    // A bare claim with no refute attempted stays unverified.
    const bare = { templateVersion: 1, stepTemplateId: "s", transition: { ...base, refute: null } };
    expect(classifyTier(bare as never)).toBe("unverified");
  });
  it("self_reported: no evidence and refute inconclusive (spec §6)", () => {
    // An inconclusive refute (uncertain/unavailable) means the self-report is the only
    // signal left — record it at self_reported confidence per spec §6, rather than
    // dropping the completion from the score entirely.
    expect(classifyTier(tx({ evidence: null, refute: { verdict: "uncertain", triggered_by: [], risk_class: "low", reason: null, issue_refs: [] } }))).toBe("self_reported");
  });
  it("unverified: evaluation_failed", () => {
    expect(classifyTier(tx({ evidence: null, telemetry: { cost: null, latency_ms: 1, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "failed", failure_code: "evaluation_failed" } } }))).toBe("unverified");
  });
});

describe("strongestTier", () => {
  it("picks the strongest present", () => {
    expect(strongestTier(["self_reported", "ai_reviewed", "unverified"])).toBe("ai_reviewed");
  });
  it("unverified when list empty", () => {
    expect(strongestTier([])).toBe("unverified");
  });
});

describe("buildArtifacts", () => {
  it("always includes a low-confidence self_report artifact", () => {
    const a = buildArtifacts({ hasEvidence: false, anySensors: false, oracleSufficientRate: 0, oracleGaps: [], hasRefute: false, falseAccept: 0 });
    expect(a.some((x) => x.source === "self_report")).toBe(true);
  });
  it("marks the independent_review verdict fail when a pass was overturned", () => {
    const a = buildArtifacts({ hasEvidence: false, anySensors: false, oracleSufficientRate: 0, oracleGaps: [], hasRefute: true, falseAccept: 2 });
    expect(a.find((x) => x.source === "independent_review")?.verdict).toBe("fail");
  });
});

describe("TIER_CONFIDENCE", () => {
  it("is monotonic and absolute (ai_reviewed caps below executed)", () => {
    expect(TIER_CONFIDENCE.verified_executed).toBeGreaterThan(TIER_CONFIDENCE.ai_reviewed);
    expect(TIER_CONFIDENCE.ai_reviewed).toBeGreaterThan(TIER_CONFIDENCE.self_reported);
  });
});

// no-evidence completion at ai_reviewed tier: refute upheld → pass, refuted → overturned.
function aiReviewed(id: string, verdict: "upheld" | "refuted", minute: number): TemplateTransition {
  return tx({
    id, workflowRunId: `r-${id}`, workflowStepRunId: `r-${id}-s`,
    evidence: null, refute: { verdict, triggered_by: [], risk_class: "low", reason: null, issue_refs: [] },
    createdAt: `2026-05-01T00:${String(minute).padStart(2, "0")}:00.000Z`,
  });
}

// evidence-tier completion (verified_executed: sensors ran, oracle sufficient), no refute.
function evidencePassed(id: string, minute: number): TemplateTransition {
  return tx({
    id, workflowRunId: `r-${id}`, workflowStepRunId: `r-${id}-s`,
    evidence: {
      sensorsRun: [{ kind: "unit", command: "t", exitCode: 0, durationMs: 1, result: "passed", summary: "", artifactRef: null }],
      verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: true, gaps: [] },
    },
    createdAt: `2026-05-01T01:${String(minute).padStart(2, "0")}:00.000Z`,
  });
}

// self_reported completion: no evidence, refute inconclusive.
function selfReported(id: string, minute: number): TemplateTransition {
  return tx({
    id, workflowRunId: `r-${id}`, workflowStepRunId: `r-${id}-s`,
    evidence: null, refute: { verdict: "uncertain", triggered_by: [], risk_class: "low", reason: null, issue_refs: [] },
    createdAt: `2026-05-01T02:${String(minute).padStart(2, "0")}:00.000Z`,
  });
}

describe("computeCalibration", () => {
  it("measures ai_reviewed survival among independently-concluded claims", () => {
    // 13 upheld + 2 refuted no-evidence completions (distinct runs) → claims 15, measured 13/15.
    const ts = [
      ...Array.from({ length: 13 }, (_, i) => aiReviewed(`u${i}`, "upheld", i)),
      ...Array.from({ length: 2 }, (_, i) => aiReviewed(`f${i}`, "refuted", 20 + i)),
    ];
    const entry = computeCalibration(ts).find((c) => c.tier === "ai_reviewed")!;
    expect(entry.state).toBe("measured");
    expect(entry.measured).toBeCloseTo(13 / 15);
    expect(entry.sampleSize).toBe(15);
    expect(entry.assumed).toBeCloseTo(0.55);
  });

  it("self_reported is always unmeasurable; zero-refute evidence tier is unmeasurable (never measured 1.0)", () => {
    // 6 evidence-passed completions with NO refute → verified_executed tier: passes 6, coverage 0 → unmeasurable, measured null.
    const evidenceTs = Array.from({ length: 6 }, (_, i) => evidencePassed(`e${i}`, i));
    const selfReportedTs = Array.from({ length: 6 }, (_, i) => selfReported(`s${i}`, i));
    const entries = computeCalibration([...evidenceTs, ...selfReportedTs]);
    const verified = entries.find((c) => c.tier === "verified_executed")!;
    expect(verified.state).toBe("unmeasurable");
    expect(verified.measured).toBeNull();
    expect(verified.sampleSize).toBe(6);
    const self = entries.find((c) => c.tier === "self_reported")!;
    expect(self.state).toBe("unmeasurable");
    expect(self.measured).toBeNull();
  });

  it("below CALIBRATION_MIN claims → insufficient with measured null", () => {
    // 3 upheld + 1 refuted → claims 4 < CALIBRATION_MIN (5).
    const ts = [
      ...Array.from({ length: 3 }, (_, i) => aiReviewed(`u${i}`, "upheld", i)),
      aiReviewed("f0", "refuted", 10),
    ];
    const entry = computeCalibration(ts).find((c) => c.tier === "ai_reviewed")!;
    expect(entry.state).toBe("insufficient");
    expect(entry.measured).toBeNull();
    expect(entry.sampleSize).toBe(4);
  });
});
