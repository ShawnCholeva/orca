import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import {
  OrchestrationRequest,
  OperatorSelection,
  WORKFLOW_FAILURE_MAX_MESSAGE_CHARS,
  type ModelProviderId,
  type OperatorDescriptor,
  type OperatorSelection as OperatorSelectionT,
  type WorkflowGuardrailConfig,
} from "@orca/contracts";

import { ProviderError, type ModelCompletionResponse, type ModelProvider } from "../../llm/types.js";
import { ModelProviderRegistry } from "../../llm/registry.js";
import { redactSecrets } from "../../memory/normalize.js";
import { evaluateGuardrail, type GuardrailContext } from "../guardrails/evaluator.js";
import { OrchestrationTransportBroker } from "../orchestration-transport/broker.js";
import { validateOperatorSelectionProposal } from "../orchestration-transport/proposals.js";
import { OperatorRegistry } from "./registry.js";

export interface SelectorInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
  stepName: string;
  stepPurpose: string;
  recommendedCapabilities: string[];
  recommendedOperatorIds: string[];
  guardrails: WorkflowGuardrailConfig[];
  orchestratorProvider: ModelProviderId | null;
  orchestratorModel: string | null;
}

export type OperatorSelectionSource = "llm" | "fallback";

export interface OperatorSelectionResult {
  selection: OperatorSelectionT;
  source: OperatorSelectionSource;
  llmCallId?: string;
}

type GuardrailCheck = {
  allowed: boolean;
  requiresApproval: boolean;
};

class RejectedOperatorProposalError extends Error {
  constructor(readonly selection: OperatorSelectionT) {
    super("operator proposal rejected");
    this.name = "RejectedOperatorProposalError";
  }
}

export class OperatorSelector {
  constructor(
    private readonly providers: ModelProviderRegistry,
    private readonly operators: OperatorRegistry,
    private readonly orchestrationTransportBroker: OrchestrationTransportBroker
  ) {}

  async select(
    db: Database.Database,
    now: () => string,
    input: SelectorInput
  ): Promise<OperatorSelectionResult> {
    const allOperators = await this.operators.list(input.goalId);
    const readyOperators = allOperators.filter((operator) => operator.ready);
    if (readyOperators.length === 0) {
      throw new Error("no_ready_operators");
    }

    const provider = input.orchestratorProvider
      ? this.providers.get(input.orchestratorProvider)
      : undefined;
    if (provider && input.orchestratorModel) {
      const first = await this.tryLlm(db, now, provider, input, readyOperators, []);
      if (first.valid) return first.result;

      const excluded = first.selection ? [first.selection.operatorId] : [];
      const retryOperators = readyOperators.filter((operator) => !excluded.includes(operator.id));
      if (excluded.length > 0 && retryOperators.length > 0) {
        const second = await this.tryLlm(db, now, provider, input, retryOperators, excluded);
        if (second.valid) return second.result;
      }
    }

    return {
      selection: this.fallbackRank(input, readyOperators),
      source: "fallback",
    };
  }

  private async tryLlm(
    db: Database.Database,
    now: () => string,
    provider: ModelProvider,
    input: SelectorInput,
    readyOperators: OperatorDescriptor[],
    excludedOperatorIds: string[]
  ): Promise<
    | { valid: true; result: OperatorSelectionResult }
    | { valid: false; selection?: OperatorSelectionT }
  > {
    try {
      const { selection, llmCallId } = await this.callLlm(
        db,
        now,
        provider,
        input,
        readyOperators,
        excludedOperatorIds
      );
      const registryOk = this.validateAgainstRegistry(selection, readyOperators);
      const guardrails = this.checkGuardrails(selection, input);
      if (!registryOk || !guardrails.allowed) {
        return { valid: false, selection };
      }
      return {
        valid: true,
        result: {
          selection: { ...selection, requiresUserApproval: selection.requiresUserApproval || guardrails.requiresApproval },
          source: "llm",
          llmCallId,
        },
      };
    } catch (err) {
      if (err instanceof RejectedOperatorProposalError) {
        return { valid: false, selection: err.selection };
      }
      return { valid: false };
    }
  }

  private async callLlm(
    db: Database.Database,
    now: () => string,
    provider: ModelProvider,
    input: SelectorInput,
    readyOperators: OperatorDescriptor[],
    excludedOperatorIds: string[]
  ): Promise<{ selection: OperatorSelectionT; llmCallId?: string }> {
    let llmCallId: string | undefined;
    const completionRequest = {
      model: input.orchestratorModel!,
      systemPrompt: [
        "You select the best operator for a workflow step.",
        "Choose exactly one operator from readyOperators.",
        "Return only structured JSON matching OperatorSelection.",
        "Prefer operators whose capabilities match recommendedCapabilities.",
        "Prefer cheaper operators when several would suffice.",
      ].join("\n"),
      userPrompt: JSON.stringify({
        stepName: input.stepName,
        stepPurpose: input.stepPurpose.slice(0, 1024),
        recommendedCapabilities: input.recommendedCapabilities.slice(0, 20),
        recommendedOperatorIds: input.recommendedOperatorIds.slice(0, 10),
        excludedOperatorIds: excludedOperatorIds.slice(0, 8),
        readyOperators: readyOperators.slice(0, 20).map((operator) => ({
          id: operator.id,
          kind: operator.kind,
          capabilities: operator.capabilities.slice(0, 20),
        })),
      }),
      responseSchemaName: "OperatorSelection",
      responseSchema: OperatorSelection,
      maxOutputTokens: 512,
      temperature: 0,
      callMetadata: {
        goalId: input.goalId,
        workflowRunId: input.workflowRunId,
        stepRunId: input.stepRunId,
      },
    } as const;

    const orchestrationRequest = OrchestrationRequest.parse({
      kind: "select_operator",
      goalId: input.goalId,
      workflowRunId: input.workflowRunId,
      stepRunId: input.stepRunId,
      providerId: provider.id,
      modelId: input.orchestratorModel,
      payload: {
        stepName: input.stepName,
        stepPurpose: input.stepPurpose.slice(0, 1024),
        recommendedCapabilities: input.recommendedCapabilities.slice(0, 20),
        recommendedOperatorIds: input.recommendedOperatorIds.slice(0, 10),
        excludedOperatorIds: excludedOperatorIds.slice(0, 8),
        readyOperators: readyOperators.slice(0, 20).map((operator) => ({
          id: operator.id,
          kind: operator.kind,
          capabilities: operator.capabilities.slice(0, 20),
        })),
      },
    });

    let rejectedSelection: OperatorSelectionT | undefined;
    const result = await this.orchestrationTransportBroker.propose(orchestrationRequest, {
      runSdkOneShot: async () => {
        const currentLlmCallId = randomUUID();
        llmCallId = currentLlmCallId;
        insertRunningLlmCall(db, now(), currentLlmCallId, provider, input);
        try {
          const response = await provider.complete<unknown>(completionRequest);
          const selection = sanitizeSelection(response.parsed);
          updateSucceededLlmCall(db, currentLlmCallId, response);
          return {
            parsed: selection,
            rawTextLength: response.rawTextLength,
            latencyMs: response.latencyMs,
          };
        } catch (err) {
          updateFailedLlmCall(db, currentLlmCallId, err);
          throw err;
        }
      },
      validateProposal: (proposal) => {
        const selection = sanitizeSelection(proposal);
        const validation = validateOperatorSelectionProposal({
          selection,
          goalId: input.goalId,
          workflowRunId: input.workflowRunId,
          stepRunId: input.stepRunId,
          stepTemplateId: input.stepName,
          readyOperators,
          guardrails: input.guardrails,
        });
        if (!validation.valid) {
          rejectedSelection = selection;
          return {
            accepted: false,
            failureMessage: validation.failureMessage,
          };
        }
        return { accepted: true, parsed: validation.selection };
      },
    });

    if (result.status === "proposed") {
      return { selection: result.parsed as OperatorSelectionT, llmCallId };
    }
    if (rejectedSelection) {
      throw new RejectedOperatorProposalError(rejectedSelection);
    }
    throw new ProviderError("provider_error", "broker did not return a proposal");
  }

  private validateAgainstRegistry(
    selection: OperatorSelectionT,
    readyOperators: OperatorDescriptor[]
  ): boolean {
    return readyOperators.some(
      (operator) =>
        operator.id === selection.operatorId && operator.kind === selection.operatorKind
    );
  }

  private checkGuardrails(selection: OperatorSelectionT, input: SelectorInput): GuardrailCheck {
    const ctx: GuardrailContext = {
      goalId: input.goalId,
      workflowRunId: input.workflowRunId,
      stepRunId: input.stepRunId,
      stepTemplateId: input.stepName,
      candidateAction: { kind: "select_operator", operatorId: selection.operatorId },
    };
    const results = input.guardrails.map((guardrail) => evaluateGuardrail(guardrail, ctx));
    return {
      allowed: !results.some((result) => result.result === "deny"),
      requiresApproval: results.some((result) => result.result === "require_approval"),
    };
  }

  private fallbackRank(
    input: SelectorInput,
    readyOperators: OperatorDescriptor[]
  ): OperatorSelectionT {
    const allowedOperators = readyOperators.filter((operator) =>
      this.checkGuardrails(
        {
          operatorId: operator.id,
          operatorKind: operator.kind,
          reason: "guardrail precheck",
          requiredCapabilities: [],
          alternativesConsidered: [],
          confidence: 0,
          requiresUserApproval: false,
        },
        input
      ).allowed
    );
    if (allowedOperators.length === 0) {
      throw new Error("no_allowed_operators");
    }

    const score = (operator: OperatorDescriptor): number => {
      let value = 0;
      const recommendedIndex = input.recommendedOperatorIds.indexOf(operator.id);
      if (recommendedIndex >= 0) value += 1000 - recommendedIndex;
      const overlap = operator.capabilities.filter((capability) =>
        input.recommendedCapabilities.includes(capability)
      ).length;
      value += overlap * 10;
      if (operator.kind === "human") value -= 5;
      return value;
    };

    const ranked = [...allowedOperators].sort((a, b) => {
      const scoreDelta = score(b) - score(a);
      return scoreDelta === 0 ? a.id.localeCompare(b.id) : scoreDelta;
    });
    const chosen = ranked[0]!;
    const guardrailCheck = this.checkGuardrails(
      {
        operatorId: chosen.id,
        operatorKind: chosen.kind,
        reason: "guardrail precheck",
        requiredCapabilities: [],
        alternativesConsidered: [],
        confidence: 0,
        requiresUserApproval: false,
      },
      input
    );

    return {
      operatorId: chosen.id,
      operatorKind: chosen.kind,
      reason: "deterministic fallback: best capability match among ready operators",
      requiredCapabilities: input.recommendedCapabilities.slice(0, 20),
      alternativesConsidered: ranked.slice(1, 9).map((operator) => operator.id),
      confidence: 0.5,
      requiresUserApproval: chosen.kind !== "human" || guardrailCheck.requiresApproval,
    };
  }
}

function insertRunningLlmCall(
  db: Database.Database,
  createdAt: string,
  id: string,
  provider: ModelProvider,
  input: SelectorInput
): void {
  db.prepare(
    "INSERT INTO workflow_llm_calls (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, provider_version, model, usage_tokens_input, usage_tokens_output, latency_ms, status, failure_code, failure_message, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, 'running', NULL, NULL, ?)"
  ).run(
    id,
    input.goalId,
    input.workflowRunId,
    input.stepRunId,
    provider.id,
    provider.version,
    input.orchestratorModel,
    createdAt
  );
}

function updateSucceededLlmCall(
  db: Database.Database,
  id: string,
  response: ModelCompletionResponse<unknown>
): void {
  db.prepare(
    "UPDATE workflow_llm_calls SET provider_version = ?, usage_tokens_input = ?, usage_tokens_output = ?, latency_ms = ?, status = 'succeeded', failure_code = NULL, failure_message = NULL WHERE id = ?"
  ).run(
    response.providerVersion,
    response.usageTokensInput ?? null,
    response.usageTokensOutput ?? null,
    Math.max(0, Math.trunc(response.latencyMs)),
    id
  );
}

function updateFailedLlmCall(db: Database.Database, id: string, err: unknown): void {
  const failureCode = err instanceof ProviderError ? err.code : "provider_error";
  const rawMessage = err instanceof Error ? err.message : "provider error";
  const failureMessage = redactSecrets(rawMessage.replace(/\s+/g, " ").trim()).slice(
    0,
    WORKFLOW_FAILURE_MAX_MESSAGE_CHARS
  );
  db.prepare(
    "UPDATE workflow_llm_calls SET status = 'failed', failure_code = ?, failure_message = ? WHERE id = ?"
  ).run(failureCode, failureMessage, id);
}

function sanitizeSelection(value: unknown): OperatorSelectionT {
  const parsed = OperatorSelection.safeParse(value);
  if (!parsed.success) {
    throw new ProviderError(
      "invalid_output",
      parsed.error.issues[0]?.message ?? "schema mismatch"
    );
  }
  const sanitized = OperatorSelection.safeParse({
    ...parsed.data,
    reason: redactSecrets(parsed.data.reason),
  });
  if (!sanitized.success) {
    throw new ProviderError(
      "invalid_output",
      sanitized.error.issues[0]?.message ?? "schema mismatch"
    );
  }
  return sanitized.data;
}
