import type {
  ModelProviderId,
  OperatorKind,
  OperatorSelection as OperatorSelectionT,
  WorkflowGuardrailConfig,
} from "@orca/contracts";

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
  allowedKinds?: OperatorKind[];
}

export type OperatorSelectionSource = "llm" | "fallback";

export interface OperatorSelectionTransportAttempt {
  attemptId: string;
  transport: "one_shot" | "hidden_interactive";
}

export interface OperatorSelectionResult {
  selection: OperatorSelectionT;
  source: OperatorSelectionSource;
  llmCallId?: string;
  transportAttempt?: OperatorSelectionTransportAttempt;
}
