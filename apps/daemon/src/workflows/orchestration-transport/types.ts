import type {
  ModelProviderId,
  OrchestrationDecisionKind,
  OrchestrationTransport,
  OrchestrationTransportAttemptStatus,
  OrchestrationTransportFailureReason,
} from "@orca/contracts";

export interface TransportAttemptIdentity {
  goalId: string;
  workflowRunId: string;
  stepRunId: string | null;
  attemptId: string;
  providerId: ModelProviderId;
  transport: OrchestrationTransport;
}

export interface CreateTransportAttemptInput {
  goalId: string;
  workflowRunId: string;
  stepRunId: string | null;
  decisionId?: string | null;
  decisionKind: OrchestrationDecisionKind;
  providerId: ModelProviderId;
  modelId: string;
  transport: OrchestrationTransport;
  workerId?: string | null;
  inputFingerprint: string;
}

export interface FinishTransportAttemptInput {
  attemptId: string;
  failureReason?: OrchestrationTransportFailureReason;
  failureMessage?: string | null;
  rawTextLength?: number | null;
  latencyMs?: number | null;
}

export interface TransportAttemptRow {
  id: string;
  goal_id: string;
  workflow_run_id: string;
  step_run_id: string | null;
  decision_id: string | null;
  provider_id: ModelProviderId;
  model: string;
  transport: OrchestrationTransport;
  worker_id: string | null;
  status: OrchestrationTransportAttemptStatus;
  failure_reason: OrchestrationTransportFailureReason | null;
  failure_message: string | null;
  raw_text_length: number | null;
  latency_ms: number | null;
  input_fingerprint: string;
  created_at: string;
  finished_at: string | null;
}
