import { describe, expect, it } from "vitest";
import type { TemplateTransition } from "./fetch.js";
import { classifyTier, strongestTier, TIER_CONFIDENCE, buildArtifacts } from "./verification.js";

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
