import { createHash } from "node:crypto";

import type Database from "better-sqlite3";
import { OrchestrationRequest, type OrchestrationRequest as OrchestrationRequestT } from "@orca/contracts";

import type { EventBus } from "../../events.js";
import { ProviderError } from "../../llm/types.js";
import { mapProviderErrorToTransportFailureReason, createPendingTransportAttempt, markTransportAttemptFailed, markTransportAttemptRunning, markTransportAttemptSucceeded } from "./attempts.js";

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

export interface BrokerCompatibilityOptions {
  runSdkOneShot?: () => Promise<SdkCompatibilityResult>;
}

export interface OrchestrationTransportBrokerDeps {
  db: Database.Database;
  bus: EventBus;
  now: () => string;
  idFactory: () => string;
}

export class OrchestrationTransportBroker {
  constructor(private readonly deps: OrchestrationTransportBrokerDeps) {}

  async propose(
    request: OrchestrationRequestT,
    options?: BrokerCompatibilityOptions
  ): Promise<BrokerResult> {
    const parsedRequest = OrchestrationRequest.parse(request);
    const attempt = createPendingTransportAttempt(
      {
        db: this.deps.db,
        bus: this.deps.bus,
        now: this.deps.now,
        idFactory: this.deps.idFactory,
      },
      {
        goalId: parsedRequest.goalId,
        workflowRunId: parsedRequest.workflowRunId,
        stepRunId: parsedRequest.stepRunId,
        decisionId: null,
        decisionKind: parsedRequest.kind,
        providerId: parsedRequest.providerId,
        modelId: parsedRequest.modelId,
        transport: "one_shot",
        inputFingerprint: fingerprintRequest(parsedRequest),
      }
    );

    markTransportAttemptRunning(
      {
        db: this.deps.db,
        bus: this.deps.bus,
        now: this.deps.now,
        idFactory: this.deps.idFactory,
      },
      attempt.id
    );

    if (!options?.runSdkOneShot) {
      markTransportAttemptFailed(
        {
          db: this.deps.db,
          bus: this.deps.bus,
          now: this.deps.now,
          idFactory: this.deps.idFactory,
        },
        {
          attemptId: attempt.id,
          failureReason: "one_shot_unavailable",
          failureMessage: "sdk one-shot path unavailable",
        }
      );
      return {
        status: "needs_human_review",
        attemptId: attempt.id,
        reviewPayloadId: this.deps.idFactory(),
      };
    }

    try {
      const sdkResult = await options.runSdkOneShot();
      markTransportAttemptSucceeded(
        {
          db: this.deps.db,
          bus: this.deps.bus,
          now: this.deps.now,
          idFactory: this.deps.idFactory,
        },
        {
          attemptId: attempt.id,
          rawTextLength: sdkResult.rawTextLength,
          latencyMs: sdkResult.latencyMs,
        }
      );
      return {
        status: "proposed",
        attemptId: attempt.id,
        transport: "one_shot",
        parsed: sdkResult.parsed,
        rawTextLength: sdkResult.rawTextLength,
        latencyMs: sdkResult.latencyMs,
      };
    } catch (err) {
      const failureReason =
        err instanceof ProviderError
          ? mapProviderErrorToTransportFailureReason(err)
          : "one_shot_unavailable";
      markTransportAttemptFailed(
        {
          db: this.deps.db,
          bus: this.deps.bus,
          now: this.deps.now,
          idFactory: this.deps.idFactory,
        },
        {
          attemptId: attempt.id,
          failureReason,
          failureMessage: err instanceof Error ? err.message : "sdk one-shot failure",
        }
      );
      return {
        status: "needs_human_review",
        attemptId: attempt.id,
        reviewPayloadId: this.deps.idFactory(),
      };
    }
  }
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
