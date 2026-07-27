import { describe, expect, it } from "vitest";
import type { WorkflowGraph } from "@orca/contracts";
import type { TemplateTransition } from "./fetch.js";
import { classifyTier, strongestTier, TIER_CONFIDENCE, buildArtifacts, computeCalibration, effectiveSourceConfidence, CALIBRATION_MIN, CALIBRATION_SCORE_MIN, PRIOR_STRENGTH } from "./verification.js";
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
  it("computes per-source Beta posterior for grounding against refute; independent_review unmeasurable (no vindication supplied); self unmeasurable", () => {
    // 12 grounding-passed completions, each with a refute; 3 refuted / 9 upheld.
    // Beta shrinkage: raw rate 9/12=0.75 pulled toward the grounding prior (0.7) by the
    // K=4 pseudo-count prior: (alpha0=2.8 + 9) / (K=4 + sampleSize=12) = 11.8/16 = 0.7375.
    const txs: TemplateTransition[] = [];
    for (let i = 0; i < 12; i++) txs.push(txc(`r${i}`, { evidence: ev(), refute: { verdict: i < 3 ? "refuted" : "upheld" } }));
    const cal = computeCalibration(txs);
    const g = cal.find((c) => c.source === "grounding")!;
    expect(g.state).toBe("measured");
    expect(g.measured).toBeCloseTo(11.8 / 16, 5);
    expect(g.sampleSize).toBe(12);
    // independent_review is now calibratable in principle (vindication-only), but with no
    // `opts.vindication` supplied (backward-compat single-arg call) it gets zero labels —
    // its bucket (refute-upheld completions) has 0/9 coverage → unmeasurable, same outcome
    // as before but for a different reason (no vindication data, not "always circular").
    expect(cal.find((c) => c.source === "independent_review")!.state).toBe("unmeasurable");
    expect(cal.find((c) => c.source === "self_report")!.measured).toBeNull();
  });

  it("computes per-source Beta posterior for executable against refute", () => {
    // 8 executable-passed completions, each with a refute; 2 refuted / 6 upheld.
    // Beta shrinkage: raw rate 6/8=0.75 pulled UP toward the executable prior (1.0):
    // (alpha0=4 + 6) / (K=4 + sampleSize=8) = 10/12 = 0.8333.
    const txs: TemplateTransition[] = [];
    for (let i = 0; i < 8; i++) txs.push(txc(`e${i}`, { evidence: execEv(), refute: { verdict: i < 2 ? "refuted" : "upheld" } }));
    const entry = computeCalibration(txs).find((c) => c.source === "executable")!;
    expect(entry.state).toBe("measured");
    expect(entry.measured).toBeCloseTo(10 / 12, 5);
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

  it("self_report is always unmeasurable regardless of data (no independent check exists)", () => {
    const txs = Array.from({ length: 20 }, (_, i) => txc(`x${i}`, { evidence: ev(), refute: { verdict: "upheld" } }));
    const cal = computeCalibration(txs);
    const entry = cal.find((c) => c.source === "self_report")!;
    expect(entry.state).toBe("unmeasurable");
    expect(entry.measured).toBeNull();
    expect(entry.sampleSize).toBe(0);
  });

  it("independent_review without opts.vindication has no labels → unmeasurable (not 'always circular' anymore, just no data)", () => {
    const txs = Array.from({ length: 20 }, (_, i) => txc(`x${i}`, { evidence: ev(), refute: { verdict: "upheld" } }));
    const entry = computeCalibration(txs).find((c) => c.source === "independent_review")!;
    expect(entry.state).toBe("unmeasurable");
    expect(entry.measured).toBeNull();
    expect(entry.sampleSize).toBe(0);
  });

  // --- Phase 2b: vindication-weighted Beta posteriors ---

  function graphWith(node: { id: string; type: "gate" | "step" | "splitter" | "delegate"; evalSubstrate?: "worker" | "shadow" }): WorkflowGraph {
    return {
      nodes: [{ ...node, name: node.id } as never],
      edges: [],
      positions: {},
    };
  }
  const workerGateGraph = graphWith({ id: "worker-gate", type: "gate", evalSubstrate: "worker" }); // vindicatorWeight 0.55
  const shadowGateGraph = graphWith({ id: "shadow-gate", type: "gate", evalSubstrate: "shadow" }); // vindicatorWeight 0.4
  const vindicatedOr = (cond: boolean, other: "bounced"): "vindicated" | "bounced" => (cond ? "vindicated" : other);

  it("independent_review calibrates from vindication (no refute involved in bucketing via gate approval)", () => {
    // 10 completions, gate-approved into the independent_review bucket (no refute upheld at
    // all, so sourcesPassed().independentReview is false for every one — bucket membership
    // comes purely from gateApprovedByCompletion). 2 vindicated, 8 bounced, terminal (weight 1.0).
    const txs = Array.from({ length: 10 }, (_, i) => txc(`v${i}`, { evidence: null }));
    const vindication = new Map(txs.map((t, i) => [
      `${t.transition.workflowRunId}::${t.stepTemplateId}`,
      { outcome: vindicatedOr(i < 2, "bounced"), byNodeId: null },
    ]));
    const cal = computeCalibration(txs, { vindication, gateApprovedByCompletion: () => true });
    const entry = cal.find((c) => c.source === "independent_review")!;
    // alpha0=2.2, beta0=1.8 (prior 0.55, K=4); labels: +2 alpha, +8 beta.
    // measured = (2.2+2)/(4+10) = 4.2/14 = 0.3
    expect(entry.state).toBe("measured");
    expect(entry.sampleSize).toBe(10);
    expect(entry.measured).toBeCloseTo(4.2 / 14, 5);
    expect(entry.measured!).toBeLessThan(0.55);
  });

  it("CRUX: independent_review's posterior is unaffected by refute verdicts — only vindication moves it", () => {
    // 10 completions all refute-upheld (which would ALSO push independent_review's posterior
    // UP toward the prior/above if refute were (wrongly) used as a label here) but mostly
    // downstream-bounced. If refute labels leaked in, measured would be ~0.59 (higher, and
    // above the 0.55 prior); the correct vindication-only posterior is 0.3 (below the prior).
    const txs = Array.from({ length: 10 }, (_, i) => txc(`cx${i}`, { evidence: null, refute: { verdict: "upheld" } }));
    const vindication = new Map(txs.map((t, i) => [
      `${t.transition.workflowRunId}::${t.stepTemplateId}`,
      { outcome: vindicatedOr(i < 2, "bounced"), byNodeId: null },
    ]));
    const cal = computeCalibration(txs, { vindication });
    const entry = cal.find((c) => c.source === "independent_review")!;
    expect(entry.measured).toBeCloseTo(4.2 / 14, 5); // vindication-only value, NOT ~0.59
    expect(entry.measured!).toBeLessThan(SOURCE_CONFIDENCE.independent_review);
  });

  it("executable/grounding combine refute labels AND weighted vindication labels", () => {
    // grounding bucket: 6 completions refute-only (4 upheld, 2 refuted) + 4 completions
    // vindication-only (worker gate, weight 0.55: 3 vindicated, 1 bounced).
    const refuteOnly = Array.from({ length: 6 }, (_, i) => txc(`gr${i}`, { evidence: ev(), refute: { verdict: i < 4 ? "upheld" : "refuted" } }));
    const vindOnly = Array.from({ length: 4 }, (_, i) => txc(`gv${i}`, { evidence: ev() }));
    const vindication = new Map(vindOnly.map((t, i) => [
      `${t.transition.workflowRunId}::${t.stepTemplateId}`,
      { outcome: vindicatedOr(i < 3, "bounced"), byNodeId: "worker-gate" },
    ]));
    const cal = computeCalibration([...refuteOnly, ...vindOnly], { vindication, graph: workerGateGraph });
    const entry = cal.find((c) => c.source === "grounding")!;
    // alpha = 4 (refute upheld) + 3*0.55 (vindicated) = 5.65; beta = 2 (refuted) + 1*0.55 (bounced) = 2.55
    // sampleSize = 5.65 + 2.55 = 8.2; alpha0=2.8, beta0=1.2 (K=4, prior 0.7)
    // measured = (2.8 + 5.65) / (4 + 8.2) = 8.45 / 12.2
    expect(entry.sampleSize).toBeCloseTo(8.2, 5);
    expect(entry.state).toBe("measured");
    expect(entry.measured).toBeCloseTo(8.45 / 12.2, 5);
  });

  it("no refute + no vindication data (or all pending) → zero label weight, insufficient coverage, posterior mathematically equals the prior", () => {
    // 6 grounding-passed completions, no refute, vindication present but every outcome pending.
    const txs = Array.from({ length: 6 }, (_, i) => txc(`p${i}`, { evidence: ev() }));
    const vindication = new Map(txs.map((t) => [
      `${t.transition.workflowRunId}::${t.stepTemplateId}`,
      { outcome: "pending" as const, byNodeId: null },
    ]));
    const entry = computeCalibration(txs, { vindication }).find((c) => c.source === "grounding")!;
    // Zero labeled completions out of a non-empty bucket → coverage gate → unmeasurable.
    // (Mathematically, alpha=alpha0, beta=beta0 here, so alpha/(alpha+beta) == the prior —
    // computeCalibration just doesn't surface `measured` below the coverage floor.)
    expect(entry.state).toBe("unmeasurable");
    expect(entry.measured).toBeNull();
    expect(entry.sampleSize).toBe(0);
  });

  it("anti-gaming: weighted sampleSize crosses CALIBRATION_MIN at the weighted count, not the raw label count", () => {
    // Same source (independent_review), same CALIBRATION_MIN(5) threshold, different
    // vindicator strength. n labels all "vindicated" at weight w need n*w >= 5.
    // terminal/human anchor (w=1.0): n=5 suffices. worker gate (w=0.55): n=9 insufficient
    // (4.95<5), n=10 measured (5.5>=5). shadow gate (w=0.4): n=12 insufficient (4.8<5),
    // n=13 measured (5.2>=5) — ~2.5x the raw label count of the anchor case for the same
    // effective evidence, so a chain of weak (shadow-gate) vindications can't cheaply move
    // a score.
    const bucketOf = (n: number, byNodeId: string | null) => {
      const txs = Array.from({ length: n }, (_, i) => txc(`ag-${byNodeId ?? "anchor"}-${i}`, { evidence: null }));
      const vindication = new Map(txs.map((t) => [
        `${t.transition.workflowRunId}::${t.stepTemplateId}`,
        { outcome: "vindicated" as const, byNodeId },
      ]));
      return { txs, vindication };
    };
    const anchor5 = bucketOf(5, null);
    expect(computeCalibration(anchor5.txs, { vindication: anchor5.vindication, gateApprovedByCompletion: () => true }).find((c) => c.source === "independent_review")!.state).toBe("measured");

    const worker9 = bucketOf(9, "worker-gate");
    expect(computeCalibration(worker9.txs, { vindication: worker9.vindication, graph: workerGateGraph, gateApprovedByCompletion: () => true }).find((c) => c.source === "independent_review")!.state).toBe("insufficient");
    const worker10 = bucketOf(10, "worker-gate");
    const w10entry = computeCalibration(worker10.txs, { vindication: worker10.vindication, graph: workerGateGraph, gateApprovedByCompletion: () => true }).find((c) => c.source === "independent_review")!;
    expect(w10entry.state).toBe("measured");
    expect(w10entry.sampleSize).toBeCloseTo(5.5, 5);

    const shadow12 = bucketOf(12, "shadow-gate");
    expect(computeCalibration(shadow12.txs, { vindication: shadow12.vindication, graph: shadowGateGraph, gateApprovedByCompletion: () => true }).find((c) => c.source === "independent_review")!.state).toBe("insufficient");
    const shadow13 = bucketOf(13, "shadow-gate");
    const s13entry = computeCalibration(shadow13.txs, { vindication: shadow13.vindication, graph: shadowGateGraph, gateApprovedByCompletion: () => true }).find((c) => c.source === "independent_review")!;
    expect(s13entry.state).toBe("measured");
    expect(s13entry.sampleSize).toBeCloseTo(5.2, 5);
  });

  it("PRIOR_STRENGTH constant is 4 (K pseudo-count weight)", () => {
    expect(PRIOR_STRENGTH).toBe(4);
  });
});

describe("effectiveSourceConfidence", () => {
  it("effectiveSourceConfidence: measured feeds in past threshold; executable capped-down; self_report fixed", () => {
    const measuredCal = [{ source: "grounding", assumed: 0.7, measured: 0.5, sampleSize: CALIBRATION_SCORE_MIN, state: "measured" }] as never;
    expect(effectiveSourceConfidence("grounding", measuredCal)).toBe(0.5);           // measured used
    expect(effectiveSourceConfidence("grounding", undefined)).toBe(0.7);             // prior when no cal
    const exeCal = [{ source: "executable", assumed: 1.0, measured: 1.3, sampleSize: CALIBRATION_SCORE_MIN, state: "measured" }] as never;
    expect(effectiveSourceConfidence("executable", exeCal)).toBe(1.0);              // capped at prior (can't exceed)
    // Boundary check: even a manufactured self_report entry claiming "measured" must not
    // move the score — self_report is not in the score-applied set at all (computeCalibration
    // never actually produces this shape for self_report; this proves the gate itself, not
    // just the absence of data).
    const selfCal = [{ source: "self_report", assumed: 0.3, measured: 0.9, sampleSize: 50, state: "measured" }] as never;
    expect(effectiveSourceConfidence("self_report", selfCal)).toBe(SOURCE_CONFIDENCE.self_report);
  });

  it("Task 3: independent_review moves off the prior once measured past CALIBRATION_SCORE_MIN (down and up)", () => {
    const down = [{ source: "independent_review", assumed: 0.55, measured: 4.2 / 14, sampleSize: 10, state: "measured" }] as never;
    expect(effectiveSourceConfidence("independent_review", down)).toBeCloseTo(4.2 / 14, 5);
    expect(effectiveSourceConfidence("independent_review", down)).toBeLessThan(SOURCE_CONFIDENCE.independent_review);
    const up = [{ source: "independent_review", assumed: 0.55, measured: 0.9, sampleSize: 10, state: "measured" }] as never;
    expect(effectiveSourceConfidence("independent_review", up)).toBeCloseTo(0.9, 5);
    expect(effectiveSourceConfidence("independent_review", up)).toBeGreaterThan(SOURCE_CONFIDENCE.independent_review);
  });

  it("NO-MOVEMENT: independent_review below CALIBRATION_SCORE_MIN or not measured stays at the prior", () => {
    const belowThreshold = [{ source: "independent_review", assumed: 0.55, measured: 0.9, sampleSize: CALIBRATION_SCORE_MIN - 1, state: "measured" }] as never;
    expect(effectiveSourceConfidence("independent_review", belowThreshold)).toBe(SOURCE_CONFIDENCE.independent_review);
    const unmeasured = [{ source: "independent_review", assumed: 0.55, measured: null, sampleSize: 0, state: "unmeasurable" }] as never;
    expect(effectiveSourceConfidence("independent_review", unmeasured)).toBe(SOURCE_CONFIDENCE.independent_review);
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
