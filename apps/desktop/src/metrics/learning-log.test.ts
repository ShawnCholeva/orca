import { describe, expect, it } from "vitest";
import type { LearningEvent, TemplateInstructionProposal } from "@orca/contracts";
import { eventLine, synthesizedLine } from "./learning-log";

const stepName = (id: string | null) => (id === "verify" ? "Verify Proposal" : id ?? "the workflow");

function event(overrides: Partial<LearningEvent> & Pick<LearningEvent, "eventType" | "payload">): LearningEvent {
  return {
    id: "e1", templateId: "tpl", proposalId: "p1", stepTemplateId: "verify",
    templateVersion: 3, createdAt: "2026-07-05T10:00:00.000Z",
    ...overrides,
  } as LearningEvent;
}

describe("eventLine", () => {
  it("created — instruction edit, failureCode present", () => {
    const e = event({ eventType: "created", payload: { kind: "created", component: "step_instructions", rule: "R2", failureCode: "invalid_output" } });
    expect(eventLine(e, stepName)).toBe(
      "Proposed an instruction edit for Verify Proposal — targets Produced output that didn't match what the step asked for."
    );
  });

  it("created — output schema, no failureCode, R1", () => {
    const e = event({ eventType: "created", payload: { kind: "created", component: "step_output_schema", rule: "R1", failureCode: null } });
    expect(eventLine(e, stepName)).toBe(
      "Proposed a tighter output check for Verify Proposal — targets underperforming scores."
    );
  });

  it("created — R3 ruleText", () => {
    const e = event({ eventType: "created", payload: { kind: "created", component: "step_instructions", rule: "R3", failureCode: null } });
    expect(eventLine(e, stepName)).toBe(
      "Proposed an instruction edit for Verify Proposal — targets repeated user re-steers."
    );
  });

  it("created — R4 ruleText", () => {
    const e = event({ eventType: "created", payload: { kind: "created", component: "step_instructions", rule: "R4", failureCode: null } });
    expect(eventLine(e, stepName)).toBe(
      "Proposed an instruction edit for Verify Proposal — targets weak verification."
    );
  });

  it("judged — reuses VERDICT_META labels", () => {
    const e = event({ eventType: "judged", payload: { kind: "judged", verdict: "regression_risk", solvedSampleSize: 2, failureSampleSize: 1 } });
    expect(eventLine(e, stepName)).toBe("Independent evaluation: regression risk (2 solved · 1 failure cases).");
  });

  it("applied — humanEdited false", () => {
    const e = event({ eventType: "applied", payload: { kind: "applied", appliedAsVersion: 5, humanEdited: false } });
    expect(eventLine(e, stepName)).toBe("Applied as v5.");
  });

  it("applied — humanEdited true", () => {
    const e = event({ eventType: "applied", payload: { kind: "applied", appliedAsVersion: 5, humanEdited: true } });
    expect(eventLine(e, stepName)).toBe("Applied as v5 (edited before applying).");
  });

  it("dismissed", () => {
    const e = event({ eventType: "dismissed", payload: { kind: "dismissed" } });
    expect(eventLine(e, stepName)).toBe("Dismissed.");
  });

  it("superseded — by apply", () => {
    const e = event({ eventType: "superseded", payload: { kind: "superseded", by: "apply" } });
    expect(eventLine(e, stepName)).toBe("Superseded (another change was applied).");
  });

  it("superseded — by staleness", () => {
    const e = event({ eventType: "superseded", payload: { kind: "superseded", by: "staleness" } });
    expect(eventLine(e, stepName)).toBe("Superseded (the template moved on).");
  });

  it("superseded — by restore", () => {
    const e = event({ eventType: "superseded", payload: { kind: "superseded", by: "restore" } });
    expect(eventLine(e, stepName)).toBe("Superseded (defaults restored).");
  });

  it("rolled_back — variant 1: schema canary rejection rate", () => {
    const e = event({
      eventType: "rolled_back",
      payload: { kind: "rolled_back", outcome: { targetDelta: null, targetDeltaVersions: null, invalidOutputRateDelta: 0.5, regressionDetected: true } },
    });
    expect(eventLine(e, stepName)).toBe("Rolled back — new checks were rejecting output (+50%).");
  });

  it("rolled_back — variant 2: target step didn't improve", () => {
    const e = event({
      eventType: "rolled_back",
      payload: { kind: "rolled_back", outcome: { targetDelta: -0.08, targetDeltaVersions: { latest: 4, prior: 3 }, invalidOutputRateDelta: null, regressionDetected: true } },
    });
    expect(eventLine(e, stepName)).toBe("Rolled back — the target step didn't improve (-8 points, v3→v4).");
  });

  it("rolled_back — variant 3: generic watched-measure regression", () => {
    const e = event({
      eventType: "rolled_back",
      payload: { kind: "rolled_back", outcome: { targetDelta: null, targetDeltaVersions: null, invalidOutputRateDelta: null, regressionDetected: true } },
    });
    expect(eventLine(e, stepName)).toBe("Rolled back — a watched measure regressed.");
  });

  it("rolled_back — variant 4: no regression detected (manual rollback)", () => {
    const e = event({
      eventType: "rolled_back",
      payload: { kind: "rolled_back", outcome: { targetDelta: 0.1, targetDeltaVersions: { latest: 4, prior: 3 }, invalidOutputRateDelta: null, regressionDetected: false } },
    });
    expect(eventLine(e, stepName)).toBe("Rolled back.");
  });

  it("baseline_restored — with superseded proposals", () => {
    const e = event({ eventType: "baseline_restored", proposalId: null, stepTemplateId: null, payload: { kind: "baseline_restored", supersededCount: 2 } });
    expect(eventLine(e, stepName)).toBe("Restored the default template, superseding 2 pending changes.");
  });

  it("baseline_restored — nothing superseded", () => {
    const e = event({ eventType: "baseline_restored", proposalId: null, stepTemplateId: null, payload: { kind: "baseline_restored", supersededCount: 0 } });
    expect(eventLine(e, stepName)).toBe("Restored the default template.");
  });

  it("analyzed — with skips", () => {
    const e = event({
      eventType: "analyzed", proposalId: null,
      payload: { kind: "analyzed", stepsDiagnosed: 3, proposalsCreated: 1, skips: [{ stepTemplateId: "verify", reason: "below sample threshold" }] },
    });
    expect(eventLine(e, stepName)).toBe("Reviewed 3 steps — created 1 proposal; skipped Verify Proposal: below sample threshold.");
  });

  it("analyzed — without skips, nothing to propose", () => {
    const e = event({
      eventType: "analyzed", proposalId: null,
      payload: { kind: "analyzed", stepsDiagnosed: 2, proposalsCreated: 0, skips: [] },
    });
    expect(eventLine(e, stepName)).toBe("Reviewed 2 steps — nothing to propose.");
  });
});

describe("synthesizedLine", () => {
  const proposal: TemplateInstructionProposal = {
    id: "p1", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "verify", component: "step_instructions",
    beforeInstructions: "Generate.", afterInstructions: "Generate and validate.",
    targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
    predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"], falsifier: "version_comparison", rollbackPlan: "revert_to_before",
    evidence: { sampleTransitionIds: ["t1"], revisionSignalIds: [], metricSnapshot: { score: 60, verdictPassRate: 0.57, oracleSufficientRate: 0.8, versionDelta: -0.05 } },
    rationale: "because", humanEdited: false, status: "applied",
    createdAt: "2026-05-01T00:00:00.000Z", decidedAt: "2026-05-01T00:00:00.000Z", decidedBy: "system", appliedAsVersion: 2,
  } as TemplateInstructionProposal;

  it("marks the row as pre-dating the learning log", () => {
    const line = synthesizedLine(proposal, stepName);
    expect(line).toContain("(before the learning log existed)");
    expect(line).toContain("Verify Proposal");
    expect(line).toContain("(applied)");
  });

  it("renders internal enum statuses as plain words, not snake_case", () => {
    const line = synthesizedLine({ ...proposal, status: "rolled_back" }, stepName);
    expect(line).toContain("(rolled back)");
    expect(line).not.toContain("rolled_back");
  });
});
