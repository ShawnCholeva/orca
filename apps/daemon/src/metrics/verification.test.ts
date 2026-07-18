import { describe, expect, it } from "vitest";
import type { TemplateTransition } from "./fetch.js";
import { classifyTier, strongestTier, TIER_CONFIDENCE, buildArtifacts, computeCalibration, effectiveSourceConfidence, CALIBRATION_MIN, CALIBRATION_SCORE_MIN } from "./verification.js";
import { SOURCE_CONFIDENCE } from "./source-signals.js";

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
  it("partially_verified: no sensors but a passed enforce-mode grounding check", () => {
    expect(classifyTier(tx({ evidence: {
      sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [],
      oracleAdequacy: { sufficient: false, gaps: [] },
      grounding: { checks: [{ rule: "paths_exist", field: "files_in_scope", mode: "enforce", result: "passed", detail: "" }], verdict: "passed" },
    } }))).toBe("partially_verified");
  });
  it("grounding alone never reaches verified_executed even when the facet passed", () => {
    expect(classifyTier(tx({ evidence: {
      sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [],
      oracleAdequacy: { sufficient: true, gaps: [] },
      grounding: { checks: [{ rule: "member_of", field: "chosen_approach", mode: "enforce", result: "passed", detail: "" }], verdict: "passed" },
    } }))).not.toBe("verified_executed");
  });
  it("ai_reviewed: observe-only or skipped grounding gives no tier upgrade", () => {
    expect(classifyTier(tx({ evidence: {
      sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [],
      oracleAdequacy: { sufficient: false, gaps: [] },
      grounding: { checks: [{ rule: "subset_of_prior", field: "delivered_requirements", mode: "observe", result: "passed", detail: "" }], verdict: "passed" },
    } }))).toBe("ai_reviewed");
    expect(classifyTier(tx({ evidence: {
      sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [],
      oracleAdequacy: { sufficient: false, gaps: [] },
      grounding: { checks: [{ rule: "paths_exist", field: "known_files", mode: "enforce", result: "skipped", detail: "" }], verdict: "skipped" },
    } }))).toBe("ai_reviewed");
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
    const a = buildArtifacts({ hasEvidence: false, anySensors: false, oracleSufficientRate: 0, oracleGaps: [], hasRefute: false, falseAccept: 0, hasGrounding: false, groundingFailed: false });
    expect(a.some((x) => x.source === "self_report")).toBe(true);
  });
  it("marks the independent_review verdict fail when a pass was overturned", () => {
    const a = buildArtifacts({ hasEvidence: false, anySensors: false, oracleSufficientRate: 0, oracleGaps: [], hasRefute: true, falseAccept: 2, hasGrounding: false, groundingFailed: false });
    expect(a.find((x) => x.source === "independent_review")?.verdict).toBe("fail");
  });
  it("includes a grounding artifact when grounding checks ran", () => {
    const a = buildArtifacts({ hasEvidence: true, anySensors: false, oracleSufficientRate: 0, oracleGaps: [], hasRefute: false, falseAccept: 0, hasGrounding: true, groundingFailed: false });
    const g = a.find((x) => x.source === "grounding");
    expect(g?.verdict).toBe("pass");
    expect(g?.cannotVerify).toContain("nothing was executed");
    const failed = buildArtifacts({ hasEvidence: true, anySensors: false, oracleSufficientRate: 0, oracleGaps: [], hasRefute: false, falseAccept: 0, hasGrounding: true, groundingFailed: true });
    expect(failed.find((x) => x.source === "grounding")?.verdict).toBe("fail");
  });
  it("executable artifact's cannotVerify shows the real gap, not the 'untested regions' placeholder", () => {
    const arts = buildArtifacts({
      hasEvidence: true, anySensors: true, oracleSufficientRate: 0.5,
      oracleGaps: ["lint is available here but none ran over this change"],
      hasRefute: false, falseAccept: 0, hasGrounding: false, groundingFailed: false,
    });
    const exe = arts.find((a) => a.source === "executable")!;
    expect(exe.cannotVerify).toContain("lint is available here but none ran");
    expect(exe.cannotVerify).not.toBe("untested regions");
  });
});

describe("TIER_CONFIDENCE", () => {
  it("is monotonic and absolute (ai_reviewed caps below executed)", () => {
    expect(TIER_CONFIDENCE.verified_executed).toBeGreaterThan(TIER_CONFIDENCE.ai_reviewed);
    expect(TIER_CONFIDENCE.ai_reviewed).toBeGreaterThan(TIER_CONFIDENCE.self_reported);
  });
});

// Calibration-test fixtures. `txc` builds a step_complete transition with the given
// evidence/refute on a distinct run — runId doubles as id/workflowRunId, so
// finalCompletions (dedup by run+step) never collapses two calibration fixtures together.
function txc(runId: string, opts: {
  evidence?: TemplateTransition["transition"]["evidence"];
  refute?: { verdict: "upheld" | "refuted" | "uncertain" | "unavailable" };
}): TemplateTransition {
  return tx({
    id: runId, workflowRunId: runId, workflowStepRunId: `${runId}-s`,
    evidence: opts.evidence ?? null,
    refute: opts.refute ? { verdict: opts.refute.verdict, triggered_by: [], risk_class: "low", reason: null, issue_refs: [] } : null,
  });
}

const groundingPassed = { verdict: "passed" as const, checks: [{ rule: "paths_exist", field: "files_in_scope", mode: "enforce" as const, result: "passed" as const, detail: "" }] };
// grounding-passed evidence (no sensors run — grounding is the only source that passed).
const ev = () => ({
  sensorsRun: [], verdict: "passed" as const, untestedRegions: [], residualRisk: [],
  oracleAdequacy: { sufficient: false, gaps: [] }, grounding: groundingPassed,
});
// executable-passed evidence (sensors ran, oracle sufficient).
const execEv = () => ({
  sensorsRun: [{ kind: "unit" as const, command: "t", exitCode: 0, durationMs: 1, result: "passed" as const, summary: "", artifactRef: null }],
  verdict: "passed" as const, untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: true, gaps: [] },
});

describe("computeCalibration", () => {
  it("computes per-source survival for grounding against refute; review/self unmeasurable", () => {
    // 12 grounding-passed completions, each with a refute; 3 refuted / 9 upheld.
    const txs: TemplateTransition[] = [];
    for (let i = 0; i < 12; i++) txs.push(txc(`r${i}`, { evidence: ev(), refute: { verdict: i < 3 ? "refuted" : "upheld" } }));
    const cal = computeCalibration(txs);
    const g = cal.find((c) => c.source === "grounding")!;
    expect(g.state).toBe("measured");
    expect(g.measured).toBeCloseTo(9 / 12, 5);
    expect(cal.find((c) => c.source === "independent_review")!.state).toBe("unmeasurable");
    expect(cal.find((c) => c.source === "self_report")!.measured).toBeNull();
  });

  it("computes per-source survival for executable against refute", () => {
    // 8 executable-passed completions, each with a refute; 2 refuted / 6 upheld.
    const txs: TemplateTransition[] = [];
    for (let i = 0; i < 8; i++) txs.push(txc(`e${i}`, { evidence: execEv(), refute: { verdict: i < 2 ? "refuted" : "upheld" } }));
    const entry = computeCalibration(txs).find((c) => c.source === "executable")!;
    expect(entry.state).toBe("measured");
    expect(entry.measured).toBeCloseTo(6 / 8, 5);
    expect(entry.sampleSize).toBe(8);
    expect(entry.assumed).toBeCloseTo(SOURCE_CONFIDENCE.executable);
  });

  it("coverage gate: too few of a source's passes had a refute run → unmeasurable", () => {
    // 10 grounding-passed completions, only 3 have a refute run → coverage 0.3 < CALIBRATION_COVERAGE (0.5).
    const txs: TemplateTransition[] = [
      ...Array.from({ length: 3 }, (_, i) => txc(`c${i}`, { evidence: ev(), refute: { verdict: "upheld" } })),
      ...Array.from({ length: 7 }, (_, i) => txc(`n${i}`, { evidence: ev() })),
    ];
    const entry = computeCalibration(txs).find((c) => c.source === "grounding")!;
    expect(entry.state).toBe("unmeasurable");
    expect(entry.measured).toBeNull();
  });

  it("below CALIBRATION_MIN claims → insufficient with measured null", () => {
    const n = CALIBRATION_MIN - 1; // claims below the floor
    const txs = Array.from({ length: n }, (_, i) => txc(`u${i}`, { evidence: ev(), refute: { verdict: "upheld" } }));
    const entry = computeCalibration(txs).find((c) => c.source === "grounding")!;
    expect(entry.state).toBe("insufficient");
    expect(entry.measured).toBeNull();
    expect(entry.sampleSize).toBe(n);
  });

  it("independent_review and self_report are always unmeasurable regardless of data", () => {
    const txs = Array.from({ length: 20 }, (_, i) => txc(`x${i}`, { evidence: ev(), refute: { verdict: "upheld" } }));
    const cal = computeCalibration(txs);
    for (const source of ["independent_review", "self_report"] as const) {
      const entry = cal.find((c) => c.source === source)!;
      expect(entry.state).toBe("unmeasurable");
      expect(entry.measured).toBeNull();
      expect(entry.sampleSize).toBe(0);
    }
  });
});

describe("effectiveSourceConfidence", () => {
  it("effectiveSourceConfidence: measured feeds in past threshold; executable capped-down; review/self fixed", () => {
    const measuredCal = [{ source: "grounding", assumed: 0.7, measured: 0.5, sampleSize: CALIBRATION_SCORE_MIN, state: "measured" }] as never;
    expect(effectiveSourceConfidence("grounding", measuredCal)).toBe(0.5);           // measured used
    expect(effectiveSourceConfidence("grounding", undefined)).toBe(0.7);             // prior when no cal
    const exeCal = [{ source: "executable", assumed: 1.0, measured: 1.3, sampleSize: CALIBRATION_SCORE_MIN, state: "measured" }] as never;
    expect(effectiveSourceConfidence("executable", exeCal)).toBe(1.0);              // capped at prior (can't exceed)
    expect(effectiveSourceConfidence("independent_review", measuredCal)).toBe(0.55); // never calibrated
  });

  it("returns the prior when no calibration is provided", () => {
    expect(effectiveSourceConfidence("grounding")).toBe(SOURCE_CONFIDENCE.grounding);
    expect(effectiveSourceConfidence("grounding", [])).toBe(SOURCE_CONFIDENCE.grounding);
  });

  it("returns the prior for insufficient or unmeasurable entries", () => {
    const entries = [
      { source: "grounding", assumed: 0.7, measured: null, sampleSize: 3, state: "insufficient" },
      { source: "executable", assumed: 1.0, measured: null, sampleSize: 0, state: "unmeasurable" },
    ] as never;
    expect(effectiveSourceConfidence("grounding", entries)).toBe(SOURCE_CONFIDENCE.grounding);
    expect(effectiveSourceConfidence("executable", entries)).toBe(SOURCE_CONFIDENCE.executable);
  });

  it("returns the prior when the measured sample is below CALIBRATION_SCORE_MIN", () => {
    const entries = [{ source: "grounding", assumed: 0.7, measured: 0.9, sampleSize: CALIBRATION_SCORE_MIN - 1, state: "measured" }] as never;
    expect(effectiveSourceConfidence("grounding", entries)).toBe(SOURCE_CONFIDENCE.grounding);
  });

  it("lowers grounding below its prior when independent review overturns claims often", () => {
    const entries = [{ source: "grounding", assumed: 0.7, measured: 0.4, sampleSize: CALIBRATION_SCORE_MIN, state: "measured" }] as never;
    expect(effectiveSourceConfidence("grounding", entries)).toBeCloseTo(0.4);
  });
});
