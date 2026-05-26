import { createHash } from "node:crypto";

import type Database from "better-sqlite3";
import {
  OrchestrationRequest,
  type OrchestrationRequest as OrchestrationRequestT,
  type OrchestrationTransportFailureReason,
} from "@orca/contracts";

import type { EventBus } from "../../events.js";
import { ProviderError } from "../../llm/types.js";
import {
  createPendingTransportAttempt,
  emitHumanReviewRequested,
  emitTransportFallback,
  mapProviderErrorToTransportFailureReason,
  markTransportAttemptFailed,
  markTransportAttemptRejected,
  markTransportAttemptRunning,
  markTransportAttemptSucceeded,
} from "./attempts.js";
import { createHumanReviewRequest } from "./human-review.js";
import { resolveTransportPlan } from "./policy.js";

export type BrokerResult =
  | {
      status: "proposed";
      attemptId: string;
      transport: "one_shot" | "hidden_interactive";
      parsed: unknown;
      rawTextLength: number | null;
      latencyMs: number;
    }
  | {
      status: "needs_human_review";
      attemptId: string;
      reviewPayloadId: string;
    };

export interface SdkCompatibilityResult {
  parsed: unknown;
  rawTextLength: number;
  latencyMs: number;
}

export type AutomatedTransportResult =
  | {
      status: "proposed";
      parsed: unknown;
      rawTextLength: number | null;
      latencyMs: number;
    }
  | {
      status: "rejected";
      failureMessage?: string | null;
      rawTextLength?: number | null;
      latencyMs?: number | null;
    }
  | {
      status: "failed";
      failureReason: OrchestrationTransportFailureReason;
      failureMessage?: string | null;
      rawTextLength?: number | null;
      latencyMs?: number | null;
    };

export type ProposalValidationResult =
  | { accepted: true; parsed?: unknown }
  | { accepted: false; failureMessage?: string | null };

export interface BrokerCompatibilityOptions {
  runSdkOneShot?: () => Promise<SdkCompatibilityResult>;
  runOneShot?: (request: OrchestrationRequestT) => Promise<AutomatedTransportResult>;
  runHiddenInteractive?: (input: {
    attemptId: string;
    request: OrchestrationRequestT;
    validateProposal?: (proposal: unknown) => ProposalValidationResult | Promise<ProposalValidationResult>;
  }) => Promise<AutomatedTransportResult>;
  validateProposal?: (proposal: unknown) => ProposalValidationResult | Promise<ProposalValidationResult>;
}

export interface OrchestrationTransportBrokerDeps {
  db: Database.Database;
  bus: EventBus;
  now: () => string;
  idFactory: () => string;
}

type AttemptCtx = Parameters<typeof createPendingTransportAttempt>[0];

export class OrchestrationTransportBroker {
  constructor(private readonly deps: OrchestrationTransportBrokerDeps) {}

  async propose(
    request: OrchestrationRequestT,
    options?: BrokerCompatibilityOptions
  ): Promise<BrokerResult> {
    const parsedRequest = OrchestrationRequest.parse(request);
    if (options?.runSdkOneShot && !options.runOneShot && !options.runHiddenInteractive) {
      return this.proposeSdkCompatibility(parsedRequest, options);
    }

    const plan = resolveTransportPlan(parsedRequest.providerId);
    const inputFingerprint = fingerprintRequest(parsedRequest);

    for (const transport of plan) {
      const attempt = createPendingTransportAttempt(this.attemptCtx(), {
        goalId: parsedRequest.goalId,
        workflowRunId: parsedRequest.workflowRunId,
        stepRunId: parsedRequest.stepRunId,
        decisionId: null,
        decisionKind: parsedRequest.kind,
        providerId: parsedRequest.providerId,
        modelId: parsedRequest.modelId,
        transport,
        inputFingerprint,
      });

      if (transport === "human_review") {
        return this.createHumanReviewResult(parsedRequest, attempt.id);
      }

      const result = await this.runAutomatedTransport(
        transport,
        { ...parsedRequest, attemptId: attempt.id },
        attempt.id,
        options
      );
      if (result.status === "proposed") {
        return result;
      }

      emitTransportFallback(this.attemptCtx(), {
        attemptId: attempt.id,
        failureReason: result.failureReason,
      });
    }

    throw new Error("transport policy did not include human_review fallback");
  }

  private async proposeSdkCompatibility(
    request: OrchestrationRequestT,
    options: BrokerCompatibilityOptions
  ): Promise<BrokerResult> {
    const attempt = createPendingTransportAttempt(this.attemptCtx(), {
      goalId: request.goalId,
      workflowRunId: request.workflowRunId,
      stepRunId: request.stepRunId,
      decisionId: null,
      decisionKind: request.kind,
      providerId: request.providerId,
      modelId: request.modelId,
      transport: "one_shot",
      inputFingerprint: fingerprintRequest(request),
    });

    const result = await this.runAutomatedTransport(
      "one_shot",
      { ...request, attemptId: attempt.id },
      attempt.id,
      options
    );
    if (result.status === "proposed") return result;

    emitTransportFallback(this.attemptCtx(), {
      attemptId: attempt.id,
      failureReason: result.failureReason,
    });
    const humanAttempt = createPendingTransportAttempt(this.attemptCtx(), {
      goalId: request.goalId,
      workflowRunId: request.workflowRunId,
      stepRunId: request.stepRunId,
      decisionId: null,
      decisionKind: request.kind,
      providerId: request.providerId,
      modelId: request.modelId,
      transport: "human_review",
      inputFingerprint: fingerprintRequest(request),
    });
    return this.createHumanReviewResult(request, humanAttempt.id);
  }

  private createHumanReviewResult(
    request: OrchestrationRequestT,
    attemptId: string
  ): BrokerResult {
    const review = createHumanReviewRequest(
      {
        db: this.deps.db,
        now: this.deps.now,
        idFactory: this.deps.idFactory,
      },
      {
        request,
        attemptId,
      }
    );
    emitHumanReviewRequested(this.attemptCtx(), attemptId);
    return {
      status: "needs_human_review",
      attemptId,
      reviewPayloadId: review.id,
    };
  }

  private async runAutomatedTransport(
    transport: "one_shot" | "hidden_interactive",
    request: OrchestrationRequestT,
    attemptId: string,
    options?: BrokerCompatibilityOptions
  ): Promise<
    | Extract<BrokerResult, { status: "proposed" }>
    | { status: "not_proposed"; failureReason: OrchestrationTransportFailureReason }
  > {
    const result =
      transport === "one_shot"
        ? await this.runOneShot(request, attemptId, options)
        : await this.runHiddenInteractive(request, attemptId, options);

    if (result.status === "proposed") {
      const validation = await validateProposal(result.parsed, options?.validateProposal);
      if (validation.accepted) {
        const parsed = Object.prototype.hasOwnProperty.call(validation, "parsed")
          ? validation.parsed
          : result.parsed;
        if (transport === "one_shot") {
          markTransportAttemptSucceeded(this.attemptCtx(), {
            attemptId,
            rawTextLength: result.rawTextLength,
            latencyMs: result.latencyMs,
          });
        }
        return {
          status: "proposed",
          attemptId,
          transport,
          parsed,
          rawTextLength: result.rawTextLength,
          latencyMs: result.latencyMs,
        };
      }

      if (transport === "one_shot") {
        markTransportAttemptRejected(this.attemptCtx(), {
          attemptId,
          failureReason: "proposal_rejected",
          failureMessage: validation.failureMessage ?? "proposal rejected by validation",
          rawTextLength: result.rawTextLength,
          latencyMs: result.latencyMs,
        });
      }
      return { status: "not_proposed", failureReason: "proposal_rejected" };
    }

    if (result.status === "rejected") {
      if (transport === "one_shot") {
        markTransportAttemptRejected(this.attemptCtx(), {
          attemptId,
          failureReason: "proposal_rejected",
          failureMessage: result.failureMessage ?? "proposal rejected by validation",
          rawTextLength: result.rawTextLength ?? null,
          latencyMs: result.latencyMs ?? null,
        });
      }
      return { status: "not_proposed", failureReason: "proposal_rejected" };
    }

    if (transport === "one_shot") {
      markTransportAttemptFailed(this.attemptCtx(), {
        attemptId,
        failureReason: result.failureReason,
        failureMessage: result.failureMessage ?? null,
        rawTextLength: result.rawTextLength ?? null,
        latencyMs: result.latencyMs ?? null,
      });
    }
    return { status: "not_proposed", failureReason: result.failureReason };
  }

  private async runOneShot(
    request: OrchestrationRequestT,
    attemptId: string,
    options?: BrokerCompatibilityOptions
  ): Promise<AutomatedTransportResult> {
    markTransportAttemptRunning(this.attemptCtx(), attemptId);

    if (options?.runOneShot) {
      return options.runOneShot(request);
    }

    if (!options?.runSdkOneShot) {
      return {
        status: "failed",
        failureReason: "one_shot_unavailable",
        failureMessage: "one-shot path unavailable",
      };
    }

    try {
      const sdkResult = await options.runSdkOneShot();
      return {
        status: "proposed",
        parsed: sdkResult.parsed,
        rawTextLength: sdkResult.rawTextLength,
        latencyMs: sdkResult.latencyMs,
      };
    } catch (err) {
      return {
        status: "failed",
        failureReason:
          err instanceof ProviderError
            ? mapProviderErrorToTransportFailureReason(err)
            : "one_shot_unavailable",
        failureMessage: err instanceof Error ? err.message : "sdk one-shot failure",
      };
    }
  }

  private async runHiddenInteractive(
    request: OrchestrationRequestT,
    attemptId: string,
    options?: BrokerCompatibilityOptions
  ): Promise<AutomatedTransportResult> {
    if (!options?.runHiddenInteractive) {
      markTransportAttemptRunning(this.attemptCtx(), attemptId);
      markTransportAttemptFailed(this.attemptCtx(), {
        attemptId,
        failureReason: "interactive_spawn_failed",
        failureMessage: "hidden interactive path unavailable",
      });
      return {
        status: "failed",
        failureReason: "interactive_spawn_failed",
        failureMessage: "hidden interactive path unavailable",
      };
    }

    return options.runHiddenInteractive({
      attemptId,
      request,
      validateProposal: options.validateProposal,
    });
  }

  private attemptCtx(): AttemptCtx {
    return {
      db: this.deps.db,
      bus: this.deps.bus,
      now: this.deps.now,
      idFactory: this.deps.idFactory,
    };
  }
}

async function validateProposal(
  proposal: unknown,
  validate?: (proposal: unknown) => ProposalValidationResult | Promise<ProposalValidationResult>
): Promise<ProposalValidationResult> {
  return validate ? await validate(proposal) : { accepted: true };
}

function fingerprintRequest(request: OrchestrationRequestT): string {
  const json = JSON.stringify({
    kind: request.kind,
    goalId: request.goalId,
    workflowRunId: request.workflowRunId,
    stepRunId: request.stepRunId,
    providerId: request.providerId,
    modelId: request.modelId,
    payload: request.payload,
  });
  return createHash("sha256").update(json).digest("hex");
}
