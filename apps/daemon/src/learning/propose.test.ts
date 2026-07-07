import { describe, expect, it, vi } from "vitest";
import type { DiagnosisBundle } from "./diagnose.js";
import {
  buildProposePayload, validateRevisionProposal, proposeInstructionRevision,
  composeProposePrompt, buildShadowProposeRunner, type BrokerLike,
} from "./propose.js";
import { serializeSchema } from "./schema-mutation.js";

const bundle: DiagnosisBundle = {
  stepTemplateId: "s1", currentInstructions: "Generate a proposal.",
  component: "step_instructions", currentOutputSchemaJson: "[]",
  targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
  evidence: {
    sampleTransitionIds: ["t1"], revisionSignalIds: ["rs1"], revisionFeedbackTexts: ["follow the schema"],
    refuteReasons: ["claimed tests ran but none exist"], supersededReasons: ["output missed the acceptance list"],
    metricSnapshot: { score: 60, verdictPassRate: 0.57, oracleSufficientRate: 0.8, versionDelta: -0.05 },
  },
};

describe("buildProposePayload", () => {
  it("compacts the bundle (instruction, failure mode, feedback, snapshot)", () => {
    const payload = buildProposePayload(bundle);
    expect(payload).toMatchObject({ currentInstructions: "Generate a proposal.", targetedFailureMode: { rule: "R2" } });
    expect(JSON.stringify(payload).length).toBeLessThan(65536);
    expect(payload.refuteReasons).toEqual(bundle.evidence.refuteReasons);
    expect(payload.supersededReasons).toEqual(bundle.evidence.supersededReasons);
  });
});

describe("validateRevisionProposal", () => {
  const validate = validateRevisionProposal(bundle);
  it("rejects empty / oversized / identical / bad-invariant fills", () => {
    expect(validate({ proposedInstructions: "", predictedImprovement: "x", invariantsPreserved: [], rationale: "r" }).accepted).toBe(false);
    expect(validate({ proposedInstructions: "Generate a proposal.", predictedImprovement: "x", invariantsPreserved: [], rationale: "r" }).accepted).toBe(false);
    expect(validate({ proposedInstructions: "New text.", predictedImprovement: "x", invariantsPreserved: ["nope"], rationale: "r" }).accepted).toBe(false);
  });
  it("accepts a valid fill", () => {
    const res = validate({ proposedInstructions: "Generate a proposal and validate it against the output schema.", predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"], rationale: "r" });
    expect(res.accepted).toBe(true);
  });
});

describe("proposeInstructionRevision", () => {
  it("returns ok with the parsed proposal on a proposed result", async () => {
    const parsed = { proposedInstructions: "New, schema-aware instruction.", predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"], rationale: "r" };
    const broker: BrokerLike = { propose: vi.fn(async (_req, opts) => { opts.validateProposal(parsed); return { status: "proposed" as const, parsed }; }) };
    const out = await proposeInstructionRevision({ broker, providerId: "orca/anthropic", modelId: "m" }, { goalId: "g", workflowRunId: "r", stepRunId: "sr" }, bundle);
    expect(out.ok).toBe(true);
    expect(out.ok && "proposedInstructions" in out.proposal ? out.proposal.proposedInstructions : undefined).toBe("New, schema-aware instruction.");
  });
  it("gives an honest parked-for-review reason when the broker escalates with NO rejected candidate", async () => {
    // No automated transport produced anything (the model was never reached or returned
    // nothing) — the reason must say the request was parked, not imply a model reviewed
    // the step and declined.
    const broker: BrokerLike = { propose: vi.fn(async () => ({ status: "needs_human_review" as const, reviewPayloadId: "x" })) };
    const out = await proposeInstructionRevision({ broker, providerId: "p", modelId: "m" }, { goalId: "g", workflowRunId: "r", stepRunId: "sr" }, bundle);
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.reason).toMatch(/human review/i);
    expect(out.ok ? "" : out.reason).not.toMatch(/didn't produce a change to apply/i);
    expect(out.ok ? "" : out.reason).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });
  it("passes a hidden-interactive runner through to the broker when one is supplied", async () => {
    const runner = vi.fn(async () => ({ status: "rejected" as const, failureMessage: "nope" }));
    const broker: BrokerLike = { propose: vi.fn(async () => ({ status: "needs_human_review" as const, reviewPayloadId: "x" })) };
    await proposeInstructionRevision({ broker, providerId: "p", modelId: "m", runHiddenInteractive: runner }, { goalId: "g", workflowRunId: "r", stepRunId: "sr" }, bundle);
    const opts = vi.mocked(broker.propose).mock.calls[0][1] as { runHiddenInteractive?: unknown };
    expect(opts.runHiddenInteractive).toBe(runner);
  });
  it("returns a plain reason when the broker escalates to human review after a rejected candidate", async () => {
    // Broker tries a no-op candidate, gets rejected, then gives up to human review —
    // the reason must be preserved, not lost to null.
    const noop = { proposedInstructions: "Generate a proposal.", predictedImprovement: "x", invariantsPreserved: [], rationale: "r" };
    const broker: BrokerLike = { propose: vi.fn(async (_req, opts) => { opts.validateProposal(noop); return { status: "needs_human_review" as const, reviewPayloadId: "x" }; }) };
    const out = await proposeInstructionRevision({ broker, providerId: "p", modelId: "m" }, { goalId: "g", workflowRunId: "r", stepRunId: "sr" }, bundle);
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.reason).toMatch(/already adequate|no change/i);
    expect(out.ok ? "" : out.reason).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });
  it("final-gate: catches a no-op the broker proposed without honoring validateProposal", async () => {
    // Broker ignores validateProposal and returns a no-op proposal — the final re-validation
    // in proposeInstructionRevision still refuses it with an honest reason.
    const noop = { proposedInstructions: "Generate a proposal.", predictedImprovement: "x", invariantsPreserved: [], rationale: "r" };
    const broker: BrokerLike = { propose: vi.fn(async () => ({ status: "proposed" as const, parsed: noop })) };
    const out = await proposeInstructionRevision({ broker, providerId: "p", modelId: "m" }, { goalId: "g", workflowRunId: "r", stepRunId: "sr" }, bundle);
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.reason).toMatch(/already adequate|no change/i);
  });
});

describe("composeProposePrompt", () => {
  it("carries the drafting instruction, the payload, and the orca:action fence contract", () => {
    const { systemPrompt, userPrompt } = composeProposePrompt(bundle);
    expect(systemPrompt).toContain("MINIMAL, targeted edit");
    expect(systemPrompt).toContain("```orca:action");
    expect(systemPrompt).toContain("proposedInstructions");
    expect(systemPrompt).toContain("Do NOT use any tools");
    expect(JSON.parse(userPrompt)).toMatchObject({ currentInstructions: "Generate a proposal." });
  });
  it("schema bundles ask for a proposedOutputSchema instead", () => {
    const schemaBundle: DiagnosisBundle = { ...bundle, component: "step_output_schema" as const,
      currentOutputSchemaJson: serializeSchema([{ key: "summary", type: "string", required: true }]) };
    const { systemPrompt } = composeProposePrompt(schemaBundle);
    expect(systemPrompt).toContain("proposedOutputSchema");
    expect(systemPrompt).toContain("TIGHTEN ONLY");
  });
});

describe("buildShadowProposeRunner", () => {
  type Ask = (key: string, input: { adapterId: "claude-code" | "codex" | "antigravity"; systemPrompt: string; userPrompt: string; timeoutMs: number }) => Promise<{ text: string }>;
  const shadowDeps = (ask: Ask) => ({
    shadowAsk: { ask }, adapterId: "claude-code" as const, sessionKey: "tpl::propose", timeoutMs: 1000,
  });
  const validFill = { proposedInstructions: "New, schema-aware instruction.", predictedImprovement: "fewer invalid", invariantsPreserved: ["safetyCompliance"], rationale: "r" };
  const validate = validateRevisionProposal(bundle);
  const runnerInput = (v = validate) => ({ attemptId: "a1", request: {} as never, validateProposal: v as never });

  it("proposes when the shadow ask returns a valid fill", async () => {
    const ask = vi.fn<Ask>(async () => ({ text: JSON.stringify(validFill) }));
    const runner = buildShadowProposeRunner(shadowDeps(ask), bundle);
    const out = await runner(runnerInput());
    expect(out.status).toBe("proposed");
    if (out.status === "proposed") {
      expect(out.parsed).toEqual(validFill);
      expect(out.rawTextLength).toBe(JSON.stringify(validFill).length);
    }
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toBe("tpl::propose");
  });

  it("retries once with the rejection fed back, then proposes", async () => {
    const noop = { ...validFill, proposedInstructions: "Generate a proposal." }; // identical → rejected
    const ask = vi.fn<Ask>()
      .mockResolvedValueOnce({ text: JSON.stringify(noop) })
      .mockResolvedValueOnce({ text: JSON.stringify(validFill) });
    const runner = buildShadowProposeRunner(shadowDeps(ask), bundle);
    const out = await runner(runnerInput());
    expect(out.status).toBe("proposed");
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][1].userPrompt).toMatch(/rejected/i);
    expect(ask.mock.calls[1][1].userPrompt).toContain("identical");
  });

  it("rejects after exhausting attempts on invalid fills", async () => {
    const ask = vi.fn<Ask>(async () => ({ text: "not json at all" }));
    const runner = buildShadowProposeRunner(shadowDeps(ask), bundle);
    const out = await runner(runnerInput());
    expect(out.status).toBe("rejected");
    if (out.status === "rejected") expect(out.failureMessage).toMatch(/JSON/i);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("fails (transport-level) when the shadow ask throws", async () => {
    const ask = vi.fn<Ask>(async () => { throw new Error("spawn timeout"); });
    const runner = buildShadowProposeRunner(shadowDeps(ask), bundle);
    const out = await runner(runnerInput());
    expect(out.status).toBe("failed");
    if (out.status === "failed") {
      expect(out.failureReason).toBe("interactive_spawn_failed");
      expect(out.failureMessage).toContain("spawn timeout");
    }
  });
});

describe("schema component", () => {
  it("schema bundles produce a schema payload and a whitelist-enforcing validator", () => {
    const schemaBundle: DiagnosisBundle = { ...bundle, component: "step_output_schema" as const,
      currentOutputSchemaJson: serializeSchema([{ key: "summary", type: "string", required: true }]) };
    const payload = buildProposePayload(schemaBundle);
    expect(payload.currentOutputSchema).toBe(schemaBundle.currentOutputSchemaJson);
    expect(payload.instruction).toContain("tighten");

    const validate = validateRevisionProposal(schemaBundle);
    const good = validate({ proposedOutputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "evidence_refs", type: "array", itemType: "string", required: true },
    ], predictedImprovement: "x", invariantsPreserved: [], rationale: "y" });
    expect(good.accepted).toBe(true);

    const deletion = validate({ proposedOutputSchema: [{ key: "evidence_refs", type: "array", itemType: "string", required: true }],
      predictedImprovement: "x", invariantsPreserved: [], rationale: "y" });
    expect(deletion.accepted).toBe(false);
    if (!deletion.accepted) expect(deletion.failureMessage).toContain("removed");

    const noop = validate({ proposedOutputSchema: [{ key: "summary", type: "string", required: true }],
      predictedImprovement: "x", invariantsPreserved: [], rationale: "y" });
    expect(noop.accepted).toBe(false); // identical schema is a no-op
  });
});
