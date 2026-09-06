import { describe, expect, it } from "vitest";
import type { TemplateTransition, TemplateStepRun } from "./fetch.js";
import type { CountedRate } from "@orca/contracts";
const ratio = (r: CountedRate | null) => (r == null ? null : r.pos / r.n);
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

// `status` mirrors TemplateStepRun.status (a bare string) rather than a hand-listed
// subset: a narrower literal union here silently excludes real statuses — `active`
// and `pending` are exactly the ones the settled-finals rule needs to construct.
function stepRun(runId: string, step: string, attempt: number, status: string, version: number): TemplateStepRun {
  return {
    workflowRunId: runId,
    stepTemplateId: step,
    attempt,
    status,
    startedAt: "2026-05-01T00:00:00.000Z",
    finishedAt: "2026-05-01T00:01:00.000Z",
    blockedReason: status === "blocked" ? "blocked" : null,
    templateVersion: version,
    stallRescues: 0,
  };
}

function gateTransition(id: string, runId: string, step: string, version: number, gateDecision: "require_approval" | "deny" | null): TemplateTransition {
  return {
    templateVersion: version, stepTemplateId: step,
    transition: {
      id, goalId: "g", workflowRunId: runId, workflowStepRunId: `${runId}-${step}`,
      boundary: "step_complete", risk: gateDecision ? { risk_class: "medium", permission_tier: "sandbox_edit", classification_reasons: [], gate_decision: gateDecision, hard_constraint_violations: [] } : null, stateDeps: null,
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
      telemetry: { cost: null, latency_ms: 100, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [{ kind: "approval", ref: "appr-1" }], outcome: { status: "succeeded", failure_code: null } },
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
      { workflowRunId: "r1", stepTemplateId: "s", attempt: 1, status: "passed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:01:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 },
      { workflowRunId: "r2", stepTemplateId: "s", attempt: 1, status: "failed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:01:00.000Z", blockedReason: "boom", templateVersion: 1, stallRescues: 0 },
      { workflowRunId: "r2", stepTemplateId: "s", attempt: 2, status: "passed", startedAt: "2026-05-01T00:02:00.000Z", finishedAt: "2026-05-01T00:03:00.000Z", blockedReason: null, templateVersion: 1, stallRescues: 0 },
    ];
    expect(ratio(firstPassRate(runs))).toBeCloseTo(0.5); // r1 first-pass; r2 recovered (not first-pass)
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
    expect(ratio(recoveredRate(runs))).toBeCloseTo(1 / 3);
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
    expect(ratio(escalatedRate(ts))).toBeCloseTo(0.5);
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
    expect(ratio(escalatedRate(ts))).toBeCloseTo(1 / 3);
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
          boundary: "step_complete", risk: { risk_class: "medium", permission_tier: "sandbox_edit", classification_reasons: [], gate_decision: "require_approval", hard_constraint_violations: [] }, stateDeps: null,
          evidence: { sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: true, gaps: [] } },
          telemetry: { cost: null, latency_ms: 100, model: null, provider_id: null, provider_version: null, prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [], outcome: { status: "succeeded", failure_code: null } },
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      },
      gateTransition("b", "r2", "s", 1, null),
    ];
    // The first transition is skipped because it has no workflowRunId/workflowStepRunId
    // Only r2 is counted: 0 escalated / 1 distinct = 0
    expect(ratio(escalatedRate(ts))).toBeCloseTo(0);
  });

  it("returns null when all transitions lack workflowRunId or workflowStepRunId", () => {
    const ts: TemplateTransition[] = [
      {
        templateVersion: 1, stepTemplateId: "s",
        transition: {
          id: "a", goalId: "g", workflowRunId: null, workflowStepRunId: null,
          boundary: "step_complete", risk: { risk_class: "medium", permission_tier: "sandbox_edit", classification_reasons: [], gate_decision: "require_approval", hard_constraint_violations: [] }, stateDeps: null,
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

  it("excludes gate surrogates from the latency median", () => {
    // Gates emitted no transitions until be490cb, so passing the unfiltered list
    // was harmless. Now they carry latency_ms, and a gate's duration answers a
    // different question than a step's — pooling them is the median of neither.
    // GateMetrics reports its own p50 over exactly these, so nothing is lost.
    const summary = computeTemplateSummary({
      templateId: "t1", name: "T", latestVersion: 1, runCount: 3,
      versions: [{ version: 1, runs: 3, firstSeenAt: "2026-05-01T00:00:00.000Z" }],
      current: {
        transitions: [
          stepComplete("a", "r1", "s1", 1, 100, "passed", "2026-05-02T00:00:00.000Z"),
          stepComplete("b", "r2", "s1", 1, 200, "passed", "2026-05-02T00:00:00.000Z"),
          stepComplete("c", "r3", "s1", 1, 300, "passed", "2026-05-02T00:00:00.000Z"),
          // A fast gate check would drag the median down toward itself.
          stepComplete("g", "r1", "__gate__:verify", 1, 5, "passed", "2026-05-02T00:00:00.000Z"),
          stepComplete("h", "r2", "__gate__:critique", 1, 5, "passed", "2026-05-02T00:00:00.000Z"),
        ],
        stepRuns: [
          stepRun("r1", "s1", 1, "passed", 1),
          stepRun("r2", "s1", 1, "passed", 1),
          stepRun("r3", "s1", 1, "passed", 1),
        ],
      },
      prior: { transitions: [], stepRuns: [] },
    });
    // Median of the three real steps (100/200/300), not of all five.
    expect(summary.latencyP50Ms).toBe(200);
  });

  it("excludes gate surrogates from firstPass and recovered", () => {
    // closeSurrogate sets status='passed' unconditionally, so every surrogate is
    // a guaranteed first-pass in both numerator and denominator. And a gate
    // loop-back bumps the surrogate's attempt, producing attempt>1 + passed --
    // which recoveredRate reads as a step that failed and then recovered, so
    // re-entering a gate used to IMPROVE the recovery tile.
    const summary = computeTemplateSummary({
      templateId: "t1", name: "T", latestVersion: 1, runCount: 2,
      versions: [{ version: 1, runs: 2, firstSeenAt: "2026-05-01T00:00:00.000Z" }],
      current: {
        transitions: [stepComplete("a", "r1", "s1", 1, 100, "passed", "2026-05-02T00:00:00.000Z")],
        stepRuns: [
          stepRun("r1", "s1", 1, "failed", 1),
          stepRun("r2", "s1", 1, "failed", 1),
          // Surrogates: one plain close, one from a gate loop-back.
          stepRun("r1", "__gate__:verify", 1, "passed", 1),
          stepRun("r2", "__gate__:verify", 2, "passed", 1),
        ],
      },
      prior: { transitions: [], stepRuns: [] },
    });
    // Both real steps failed on their only attempt: nothing passed first time and
    // nothing recovered. The surrogates must not manufacture either.
    // The gate surrogate must not swell the denominator either — that is the whole
    // point of carrying n rather than a bare ratio.
    expect(summary.firstPass).toEqual({ pos: 0, n: 2 });
    expect(summary.recovered).toEqual({ pos: 0, n: 2 });
  });

  it("excludes a step still running from the outcome rates", () => {
    // The founder's 30d population was 9 passed + 4 daemon-killed + 1 ACTIVE.
    // Dividing by 14 asserted a terminal outcome about a step still in flight;
    // the residual read as "5 never passed". A thing in progress is not an
    // observation of that thing.
    const summary = computeTemplateSummary({
      templateId: "t1", name: "T", latestVersion: 1, runCount: 3,
      versions: [{ version: 1, runs: 3, firstSeenAt: "2026-05-01T00:00:00.000Z" }],
      current: {
        transitions: [stepComplete("a", "r1", "s1", 1, 100, "passed", "2026-05-02T00:00:00.000Z")],
        stepRuns: [
          stepRun("r1", "s1", 1, "passed", 1),
          stepRun("r2", "s1", 1, "passed", 1),
          stepRun("r3", "s1", 1, "active", 1),
        ],
      },
      prior: { transitions: [], stepRuns: [] },
    });
    // Two settled steps, both first-time passes — not 2 of 3.
    expect(summary.firstPass).toEqual({ pos: 2, n: 2 });
  });

  it("keeps infrastructure-killed steps in the population", () => {
    // Deliberately NOT excluded here: that would answer a different question than
    // the label asks, and it would rest on matching free text. The split lands
    // with a recorded step-level cause instead.
    const summary = computeTemplateSummary({
      templateId: "t1", name: "T", latestVersion: 1, runCount: 2,
      versions: [{ version: 1, runs: 2, firstSeenAt: "2026-05-01T00:00:00.000Z" }],
      current: {
        transitions: [stepComplete("a", "r1", "s1", 1, 100, "passed", "2026-05-02T00:00:00.000Z")],
        stepRuns: [
          stepRun("r1", "s1", 1, "passed", 1),
          { ...stepRun("r2", "s1", 1, "blocked", 1), blockedReason: "crashed 3 times (worker_exited_no_signal)" },
        ],
      },
      prior: { transitions: [], stepRuns: [] },
    });
    expect(summary.firstPass).toEqual({ pos: 1, n: 2 });
  });

  it("partitions every final attempt into exactly one bucket, and the parts sum", () => {
    // The sum is the property that matters: a reader sees the cut instead of
    // inheriting it, and a miscategorised step lands visibly in the wrong bucket
    // rather than vanishing from a denominator.
    const summary = computeTemplateSummary({
      templateId: "t1", name: "T", latestVersion: 1, runCount: 5,
      versions: [{ version: 1, runs: 5, firstSeenAt: "2026-05-01T00:00:00.000Z" }],
      current: {
        transitions: [stepComplete("a", "r1", "s1", 1, 100, "passed", "2026-05-02T00:00:00.000Z")],
        stepRuns: [
          stepRun("r1", "s1", 1, "passed", 1),
          { ...stepRun("r2", "s1", 2, "passed", 1) },
          { ...stepRun("r3", "s1", 1, "blocked", 1), blockedReason: "crashed", blockedCode: "worker_exited_no_signal" },
          { ...stepRun("r4", "s1", 1, "blocked", 1), blockedReason: "gave up", blockedCode: "revise_cap" },
          stepRun("r5", "s1", 1, "active", 1),
        ],
      },
      prior: { transitions: [], stepRuns: [] },
    });

    const o = summary.stepOutcomes!;
    expect(o).toMatchObject({
      passedFirstTime: 1, passedAfterRetry: 1,
      infraKilled: 1, failedOnMerit: 1, unattributed: 0, stillRunning: 1,
    });
    const sum = o.passedFirstTime + o.passedAfterRetry + o.failedOnMerit +
      o.infraKilled + o.unattributed + o.skipped + o.stillRunning;
    expect(sum).toBe(o.scope.steps);
    expect(o.scope).toMatchObject({ steps: 5, runs: 5, templates: 1, inferred: false });
  });

  it("counts a step that predates blocked_code as unattributed, never guessed", () => {
    // All five of the founder's runs derive to inferred. Matching the free text
    // tells you the FAMILY, not the member — guessing a specific code here would
    // put an advisory signal under a load-bearing name.
    const summary = computeTemplateSummary({
      templateId: "t1", name: "T", latestVersion: 1, runCount: 2,
      versions: [{ version: 1, runs: 2, firstSeenAt: "2026-05-01T00:00:00.000Z" }],
      current: {
        transitions: [stepComplete("a", "r1", "s1", 1, 100, "passed", "2026-05-02T00:00:00.000Z")],
        stepRuns: [
          stepRun("r1", "s1", 1, "passed", 1),
          // Historical row: a reason, no code.
          { ...stepRun("r2", "s1", 1, "blocked", 1), blockedReason: "crashed 3 times (worker_exited_no_signal)" },
        ],
      },
      prior: { transitions: [], stepRuns: [] },
    });

    const o = summary.stepOutcomes!;
    expect(o.unattributed).toBe(1);
    expect(o.infraKilled).toBe(0); // NOT guessed, even though the sentence names it
    expect(o.scope.inferred).toBe(true); // and the claim carries that it is weak
  });

  it("withholds the version comparison when either side is below the per-side floor", () => {
    // v16 with 1 run vs v14 with 3 runs rendered as a comparison. Neither side can
    // support a delta; the contract carries null rather than a number to hedge.
    const summary = computeTemplateSummary({
      templateId: "t1", name: "Test Template", latestVersion: 2, runCount: 4,
      versions: [
        { version: 1, runs: 3, firstSeenAt: "2026-05-01T00:00:00.000Z" },
        { version: 2, runs: 1, firstSeenAt: "2026-05-02T00:00:00.000Z" },
      ],
      current: {
        transitions: [
          stepComplete("a", "r1", "s1", 1, 100, "passed", "2026-05-02T00:00:00.000Z"),
          stepComplete("b", "r2", "s1", 2, 120, "passed", "2026-05-03T00:00:00.000Z"),
        ],
        stepRuns: [stepRun("r1", "s1", 1, "passed", 1), stepRun("r2", "s1", 1, "passed", 2)],
      },
      prior: { transitions: [], stepRuns: [] },
    });
    expect(summary.versionComparison).toBeNull();
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
    expect(ratio(summary.recovered)).toBeCloseTo(0.5); // r2 is the recovered one
    expect(ratio(summary.escalated)).toBeCloseTo(0.5); // r2 has gate_decision require_approval
  });
});
