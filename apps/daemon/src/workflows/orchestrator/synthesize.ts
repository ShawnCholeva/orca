import {
  OrchestrationRequest,
  SynthesisProposal,
  SynthesisRequest,
  validateStepOutput,
  type ModelProviderId,
  type WorkflowStepOutputSchema,
} from "@orca/contracts";
import type { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";
import { SHADOW_LLM_TIMEOUT_MS } from "../../orchestrator-llm/shadow-llm-client.js";
import type { ShadowAdapterId } from "../../orchestrator-llm/shadow-session.js";
import type { ShadowAsk } from "./recover-step-scoring.js";
import { parseOrcaOutputBlock } from "./orca-output.js";
import type { StepExecutionInput } from "./step-input.js";

export interface SynthesisDeps {
  broker: Pick<OrchestrationTransportBroker, "propose">;
  shadowAsk?: ShadowAsk;
}

export interface SynthesisInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
  providerId: ModelProviderId;
  modelId: string;
  adapterId?: ShadowAdapterId;
  outputSchema: WorkflowStepOutputSchema;
  stepInput: StepExecutionInput;
  sessionResult: string;
}

export type SynthesisResult =
  | { ok: true; output: Record<string, unknown>; source: "agent" | "orchestrator" }
  | { ok: false; reason: string };

export async function synthesizeStepOutput(
  deps: SynthesisDeps,
  input: SynthesisInput
): Promise<SynthesisResult> {
  // (1) Parse path: extract orca-output block and validate against schema
  const parsed = parseOrcaOutputBlock(input.sessionResult);
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const v = validateStepOutput(input.outputSchema, parsed);
    if (v.ok) {
      return { ok: true, output: parsed as Record<string, unknown>, source: "agent" };
    }
  }

  // (2) Synthesize path: call broker with validateProposal, retry once on non-proposed
  for (let attempt = 0; attempt < 2; attempt++) {
    const requestPayload = SynthesisRequest.parse({
      sessionResult: input.sessionResult,
      outputSchema: input.outputSchema,
      stepInput: input.stepInput,
    });
    const validateProposal = (raw: unknown) => {
      const proposal = SynthesisProposal.safeParse(raw);
      if (!proposal.success) {
        return { accepted: false as const, failureMessage: "invalid synthesis proposal structure" };
      }
      const validated = validateStepOutput(input.outputSchema, proposal.data.output);
      if (!validated.ok) {
        return {
          accepted: false as const,
          failureMessage: `schema: ${validated.errors.join("; ")}`,
        };
      }
      return { accepted: true as const, parsed: proposal.data };
    };

    if (input.adapterId && deps.shadowAsk) {
      try {
        const { text } = await deps.shadowAsk.ask(input.goalId, {
          adapterId: input.adapterId,
          systemPrompt: [
            "Synthesize a workflow step output from the supplied session result.",
            "Produce one JSON object matching SynthesisProposal.",
            "The object must contain an output field matching the supplied outputSchema.",
            "Output protocol (MANDATORY): emit exactly one fenced block and nothing after the closing fence:",
            "```orca:action",
            '{ ...the SynthesisProposal JSON object... }',
            "```",
          ].join("\n"),
          userPrompt: JSON.stringify(requestPayload),
          timeoutMs: SHADOW_LLM_TIMEOUT_MS,
        });
        const validation = validateProposal(JSON.parse(text));
        if (validation.accepted) {
          return {
            ok: true,
            output: validation.parsed.output,
            source: "orchestrator",
          };
        }
      } catch {
        // Retry once, matching the existing broker synthesis behavior.
      }
      continue;
    }

    const request = OrchestrationRequest.parse({
      kind: "synthesize_step_output",
      goalId: input.goalId,
      workflowRunId: input.workflowRunId,
      stepRunId: input.stepRunId,
      providerId: input.providerId,
      modelId: input.modelId,
      adapterId: input.adapterId,
      payload: requestPayload,
    });

    const result = await deps.broker.propose(request, {
      validateProposal,
    });

    if (result.status === "proposed") {
      const proposal = result.parsed as SynthesisProposal;
      return { ok: true, output: proposal.output, source: "orchestrator" };
    }
  }

  return { ok: false, reason: "schema validation failed after retry" };
}
