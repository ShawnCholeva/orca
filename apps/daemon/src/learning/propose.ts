import { DimensionKey, ProposeInstructionRevisionProposal, ProposeSchemaRevisionProposal, type OrchestrationRequest } from "@orca/contracts";
import type { ShadowAdapterId } from "../orchestrator-llm/shadow-session.js";
import type { ShadowAsk } from "../workflows/orchestrator/recover-step-scoring.js";
import type { AutomatedTransportResult, ProposalValidationResult } from "../workflows/orchestration-transport/broker.js";
import type { DiagnosisBundle } from "./diagnose.js";
import { parseSchema, serializeSchema, validateSchemaTightening } from "./schema-mutation.js";

// The hidden-interactive runner the broker executes for its hidden_interactive
// transport — same shape as BrokerCompatibilityOptions.runHiddenInteractive.
export type HiddenInteractiveRunner = (input: {
  attemptId: string;
  request: OrchestrationRequest;
  validateProposal?: (proposal: unknown) => ProposalValidationResult | Promise<ProposalValidationResult>;
}) => Promise<AutomatedTransportResult>;

export type BrokerLike = {
  propose(
    request: OrchestrationRequest,
    options: {
      validateProposal: (raw: unknown) => { accepted: true; parsed?: unknown } | { accepted: false; failureMessage?: string | null };
      runHiddenInteractive?: HiddenInteractiveRunner;
    },
  ): Promise<{ status: "proposed"; parsed: unknown } | { status: "needs_human_review"; reviewPayloadId: string }>;
};

const INSTRUCTION =
  "You are improving one step's instruction text for a workflow template. Produce a MINIMAL, targeted edit " +
  "that addresses the diagnosed failure mode while preserving the listed invariants. Fix the diagnosed failure; " +
  "do not rewrite what already works. Return only the structured proposal.";

const SCHEMA_INSTRUCTION =
  "You are improving one step's REQUIRED OUTPUT STRUCTURE (its output schema) for a workflow template. " +
  "The step passes review but is weakly verified — tighten the schema so the step must show its work: " +
  "add checkable required fields (evidence references, risks, acceptance-criteria mapping). " +
  "TIGHTEN ONLY: you may add fields, make optional fields required, and add descriptions. " +
  "Never remove, rename, or retype a field, and never change an enum. Return only the structured proposal.";

export function buildProposePayload(bundle: DiagnosisBundle): Record<string, unknown> {
  if (bundle.component === "step_output_schema") {
    return {
      instruction: SCHEMA_INSTRUCTION,
      currentOutputSchema: bundle.currentOutputSchemaJson,
      targetedFailureMode: bundle.targetedFailureMode,
      refuteReasons: bundle.evidence.refuteReasons,
      metricSnapshot: bundle.evidence.metricSnapshot,
    };
  }
  return {
    instruction: INSTRUCTION,
    currentInstructions: bundle.currentInstructions,
    targetedFailureMode: bundle.targetedFailureMode,
    revisionFeedbackTexts: bundle.evidence.revisionFeedbackTexts,
    refuteReasons: bundle.evidence.refuteReasons,
    supersededReasons: bundle.evidence.supersededReasons,
    metricSnapshot: bundle.evidence.metricSnapshot,
  };
}

export function validateRevisionProposal(bundle: DiagnosisBundle) {
  if (bundle.component === "step_output_schema") {
    const before = parseSchema(bundle.currentOutputSchemaJson) ?? [];
    return (raw: unknown): { accepted: true; parsed: ProposeSchemaRevisionProposal } | { accepted: false; failureMessage: string } => {
      const parsed = ProposeSchemaRevisionProposal.safeParse(raw);
      if (!parsed.success) return { accepted: false, failureMessage: "proposal failed schema (check field shapes / invariant keys)" };
      const tightening = validateSchemaTightening(before, parsed.data.proposedOutputSchema);
      if (!tightening.ok) return { accepted: false, failureMessage: `not a pure tightening: ${tightening.errors.join("; ").slice(0, 400)}` };
      if (serializeSchema(parsed.data.proposedOutputSchema) === serializeSchema(before)) {
        return { accepted: false, failureMessage: "proposed schema is identical to current (no-op)" };
      }
      return { accepted: true, parsed: parsed.data };
    };
  }
  const currentInstructions = bundle.currentInstructions;
  return (raw: unknown): { accepted: true; parsed: ProposeInstructionRevisionProposal } | { accepted: false; failureMessage: string } => {
    const parsed = ProposeInstructionRevisionProposal.safeParse(raw);
    if (!parsed.success) return { accepted: false, failureMessage: "proposal failed schema (check invariant keys / length)" };
    if (parsed.data.proposedInstructions.trim() === currentInstructions.trim()) {
      return { accepted: false, failureMessage: "proposed instructions are identical to current (no-op)" };
    }
    return { accepted: true, parsed: parsed.data };
  };
}

// Prompt for the shadow session that drafts the revision. Mirrors composeJudgePrompt
// (judge.ts): no tools, everything needed is in the message, one orca:action block out.
export function composeProposePrompt(bundle: DiagnosisBundle): { systemPrompt: string; userPrompt: string } {
  const isSchema = bundle.component === "step_output_schema";
  const shape = isSchema
    ? '{ "proposedOutputSchema": [ { "key": "...", "type": "...", "required": true } ], "predictedImprovement": "...", "invariantsPreserved": [...], "rationale": "..." }'
    : '{ "proposedInstructions": "...", "predictedImprovement": "...", "invariantsPreserved": [...], "rationale": "..." }';
  const systemPrompt = [
    isSchema ? SCHEMA_INSTRUCTION : INSTRUCTION,
    "Do NOT use any tools — do not read files, run commands, or search the workspace; you already",
    "have everything you need in this message. Reason from the provided data and emit the proposal directly.",
    `invariantsPreserved entries must be drawn from: ${DimensionKey.options.join(", ")}.`,
    "Emit exactly one JSON object in one fenced block, nothing after:",
    "```orca:action",
    shape,
    "```",
  ].join("\n");
  return { systemPrompt, userPrompt: JSON.stringify(buildProposePayload(bundle)) };
}

// The ShadowAsk-backed hidden_interactive transport for proposal drafting — the same
// control-plane-pure seam the refute channel and the counterfactual judge already ride.
// Validation happens inside the loop so a rejected draft is retried once WITH the
// rejection fed back, instead of burning the whole transport on one bad fill.
export function buildShadowProposeRunner(
  deps: { shadowAsk: ShadowAsk; adapterId: ShadowAdapterId; sessionKey: string; timeoutMs: number },
  bundle: DiagnosisBundle,
): HiddenInteractiveRunner {
  return async (input) => {
    const { systemPrompt, userPrompt } = composeProposePrompt(bundle);
    const started = Date.now();
    let feedback: string | null = null;
    let lastFailure = "no attempts made";
    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string;
      try {
        ({ text } = await deps.shadowAsk.ask(deps.sessionKey, {
          adapterId: deps.adapterId, systemPrompt,
          userPrompt: feedback == null ? userPrompt : `${userPrompt}\n\nYour previous draft was rejected: ${feedback}. Emit a corrected proposal.`,
          timeoutMs: deps.timeoutMs,
        }));
      } catch (err) {
        return {
          status: "failed", failureReason: "interactive_spawn_failed",
          failureMessage: err instanceof Error ? err.message : String(err),
          latencyMs: Date.now() - started,
        };
      }
      let raw: unknown;
      try { raw = JSON.parse(text); } catch {
        lastFailure = "response was not valid JSON";
        feedback = lastFailure;
        continue;
      }
      const v = input.validateProposal ? await input.validateProposal(raw) : { accepted: true as const };
      if (v.accepted) return { status: "proposed", parsed: raw, rawTextLength: text.length, latencyMs: Date.now() - started };
      lastFailure = v.failureMessage ?? "proposal rejected by validation";
      feedback = lastFailure;
    }
    return { status: "rejected", failureMessage: lastFailure, latencyMs: Date.now() - started };
  };
}

// A propose attempt either yields a valid revision, or does not — with an honest,
// human-plain reason. Surfacing the reason (rather than collapsing every non-result
// to null) is what lets the analyze stage record WHY a diagnosed step produced no
// proposal, instead of silently dropping it (inspectability, paper §5.2 / §3.5).
export type ProposeResult =
  | { ok: true; proposal: ProposeInstructionRevisionProposal | ProposeSchemaRevisionProposal }
  | { ok: false; reason: string };

// Map a validator's technical failure message to plain, jargon-free language for the
// learning log. Never leaks the five banned terms (oracle/sensor/verdict/refute/veto).
function plainProposeReason(raw: string | null, component: DiagnosisBundle["component"]): string {
  // No validator rejection was ever captured: the model was never reached (or returned
  // nothing usable) and the broker parked the request — say that, don't imply a model
  // reviewed the step and declined.
  if (!raw) return "no automated draft was produced — the request was set aside for human review";
  const r = raw.toLowerCase();
  if (r.includes("no-op") || r.includes("identical")) {
    return component === "step_output_schema"
      ? "the current output checks are already adequate — nothing to tighten"
      : "the current instructions are already adequate — no change was suggested";
  }
  if (r.includes("tightening") || r.includes("removed")) {
    return "the suggested change would remove or weaken a field, so it wasn't a valid tightening";
  }
  return "the suggested change didn't match the required shape";
}

export async function proposeInstructionRevision(
  deps: { broker: BrokerLike; providerId: string; modelId: string; runHiddenInteractive?: HiddenInteractiveRunner },
  ctx: { goalId: string; workflowRunId: string; stepRunId: string },
  bundle: DiagnosisBundle,
): Promise<ProposeResult> {
  const request: OrchestrationRequest = {
    kind: "propose_instruction_revision",
    goalId: ctx.goalId, workflowRunId: ctx.workflowRunId, stepRunId: ctx.stepRunId,
    providerId: deps.providerId, modelId: deps.modelId,
    payload: buildProposePayload(bundle),
  } as OrchestrationRequest;

  // Wrap the validator so the LAST concrete rejection is captured even when the broker
  // ultimately escalates to human review (it retries on rejection and, on giving up,
  // returns needs_human_review — losing the reason otherwise).
  const validate = validateRevisionProposal(bundle);
  let lastRejection: string | null = null;
  const result = await deps.broker.propose(request, {
    validateProposal: (raw) => {
      const r = validate(raw);
      if (!r.accepted) lastRejection = r.failureMessage;
      return r;
    },
    runHiddenInteractive: deps.runHiddenInteractive,
  });
  if (result.status !== "proposed") {
    return { ok: false, reason: plainProposeReason(lastRejection, bundle.component) };
  }
  // Final gate: re-validate the accepted proposal here too — defence-in-depth (a broker
  // that ignores validateProposal can't sneak a no-op or whitelist-violating change past
  // us) and the honest reason when it does.
  const check = validate(result.parsed);
  if (!check.accepted) {
    return { ok: false, reason: plainProposeReason(check.failureMessage, bundle.component) };
  }
  return { ok: true, proposal: check.parsed };
}
