import {
  getModelProviderDisplayName,
  type OrchestrationTransport,
  type OrchestrationTransportAttempt,
  type OrchestrationTransportFailureReason,
  type OrchestrationTransportAttemptStatus,
} from "@orca/contracts";

export type WorkflowTransportStatusTone = "success" | "warning" | "danger" | "neutral";

export type WorkflowTransportStatusSummary = {
  label: string;
  tone: WorkflowTransportStatusTone;
};

export function summarizeWorkflowTransportStatus(
  attempts: OrchestrationTransportAttempt[],
): WorkflowTransportStatusSummary | null {
  const latest = attempts.at(-1);
  if (!latest) return null;

  if (latest.transport === "human_review") {
    return { label: "Needs human review", tone: "warning" };
  }

  if (latest.failureReason === "interactive_auth_lost") {
    return { label: "Worker auth required", tone: "warning" };
  }

  if (
    latest.failureReason === "one_shot_parse_failed" ||
    latest.failureReason === "interactive_output_invalid"
  ) {
    return { label: "Transport output invalid", tone: "danger" };
  }

  if (didFallbackToInteractiveWorker(attempts)) {
    return { label: "Fell back to interactive worker", tone: "warning" };
  }

  if (latest.status === "succeeded") {
    return {
      label: `Automated by ${getModelProviderDisplayName(latest.providerId)}`,
      tone: "success",
    };
  }
  return {
    label: `${formatTransportLabel(latest.transport)} ${formatAttemptStatus(latest.status)}`,
    tone: latest.status === "failed" || latest.status === "rejected" ? "danger" : "neutral",
  };
}

export function summarizeAttemptStatus(
  attempt: OrchestrationTransportAttempt,
  attempts: OrchestrationTransportAttempt[],
): WorkflowTransportStatusSummary {
  if (attempt.transport === "human_review") {
    return { label: "Needs human review", tone: "warning" };
  }
  if (attempt.failureReason === "interactive_auth_lost") {
    return { label: "Worker auth required", tone: "warning" };
  }
  if (
    attempt.failureReason === "one_shot_parse_failed" ||
    attempt.failureReason === "interactive_output_invalid"
  ) {
    return { label: "Transport output invalid", tone: "danger" };
  }
  if (
    attempt.transport === "hidden_interactive" &&
    attempts.some((item) => item.createdAt < attempt.createdAt && item.transport === "one_shot")
  ) {
    return { label: "Fell back to interactive worker", tone: "warning" };
  }
  if (attempt.status === "succeeded") {
    return {
      label: `Automated by ${getModelProviderDisplayName(attempt.providerId)}`,
      tone: "success",
    };
  }
  return {
    label: `${formatTransportLabel(attempt.transport)} ${formatAttemptStatus(attempt.status)}`,
    tone: attempt.status === "failed" || attempt.status === "rejected" ? "danger" : "neutral",
  };
}

export function didFallback(attempts: OrchestrationTransportAttempt[]): boolean {
  return attempts.some((attempt) => attempt.status === "fallback") || attempts.length > 1;
}

export function didFallbackToInteractiveWorker(
  attempts: OrchestrationTransportAttempt[],
): boolean {
  return attempts.some((attempt) => attempt.transport === "hidden_interactive") &&
    attempts.some((attempt) => attempt.transport === "one_shot");
}

export function formatTransportLabel(transport: OrchestrationTransport): string {
  switch (transport) {
    case "one_shot":
      return "One-shot";
    case "hidden_interactive":
      return "Interactive worker";
    case "human_review":
      return "Human review";
  }
}

export function formatAttemptStatus(status: OrchestrationTransportAttemptStatus): string {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "rejected":
      return "rejected";
    case "failed":
      return "failed";
    case "fallback":
      return "fell back";
  }
}

export function formatFailureReason(
  failureReason: OrchestrationTransportFailureReason | null,
): string | null {
  if (!failureReason) return null;
  switch (failureReason) {
    case "one_shot_unavailable":
      return "One-shot unavailable";
    case "one_shot_parse_failed":
      return "One-shot output invalid";
    case "one_shot_rate_limited":
      return "One-shot rate limited";
    case "interactive_spawn_failed":
      return "Worker failed to start";
    case "interactive_hung":
      return "Worker hung";
    case "interactive_auth_lost":
      return "Worker auth required";
    case "interactive_output_invalid":
      return "Interactive output invalid";
    case "daemon_restart":
      return "Daemon restarted";
    case "proposal_rejected":
      return "Proposal rejected";
  }
}
