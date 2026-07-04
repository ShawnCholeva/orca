import { EventBus } from "../../events.js";
import type { ResolvedMode } from "../../adapters/dispatcher.js";
import type {
  RefuteFacet,
  StateDepsFacet,
  WorkflowStepResult,
} from "@orca/contracts";

export interface StepDispatchCapabilities {
  isAdapterReady(adapterId: string): Promise<boolean>;
  supportsModel(adapterId: string, modelId: string): boolean;
  resolveMode(adapterId: string): ResolvedMode;
}

export interface RequestNextDecisionOptions {
  bus?: EventBus;
  idFactory?: () => string;
  stepResultByStepRunId?: Record<string, WorkflowStepResult>;
  terminalFinishedAtByStepRunId?: Record<string, string>;
  /** StateDepsFacet to attach to the step's eventual step_complete transition. */
  stateDepsByStepRunId?: Record<string, StateDepsFacet>;
  /** RefuteFacet to attach to a non-gated step's step_complete transition,
   *  recorded downstream at advanceToNextStep (gated steps thread it directly
   *  onto their own evidence-gate emit instead). */
  refuteByStepRunId?: Record<string, RefuteFacet>;
}

export class OrchestratorRunNotFoundError extends Error {
  readonly code = "workflow_run_not_found" as const;

  constructor(runId: string) {
    super(`Workflow run not found: ${runId}`);
    this.name = "OrchestratorRunNotFoundError";
  }
}

export class OrchestratorRunNotActiveError extends Error {
  readonly code = "workflow_run_not_active" as const;

  constructor(runId: string) {
    super(`Workflow run is not active: ${runId}`);
    this.name = "OrchestratorRunNotActiveError";
  }
}

export class OrchestratorTemplateNotFoundError extends Error {
  readonly code = "workflow_template_not_found" as const;

  constructor(templateId: string) {
    super(`Workflow template not found: ${templateId}`);
    this.name = "OrchestratorTemplateNotFoundError";
  }
}

// Drain-only view of the OTLP SessionCostAccumulator (Task 5). Drains and clears
// a session's accrued worker tokens; returns null when nothing accrued.
export interface TokenAccumulator {
  drain(sessionId: string): {
    tokensIn: number;
    tokensOut: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    usd: number | null; // authoritative provider cost (Claude); null when none carried (Codex)
    durationMs: number | null; // provider-reported model time; null when none carried (Codex)
    model?: string;
  } | null;
}
