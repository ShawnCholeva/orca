import type { ModelProviderId, OrchestrationTransport } from "@orca/contracts";

export function resolveTransportPlan(
  providerId: ModelProviderId
): OrchestrationTransport[] {
  switch (providerId) {
    case "orca/openai":
      return ["one_shot", "hidden_interactive", "human_review"];
    case "orca/anthropic":
      return ["hidden_interactive", "human_review"];
    case "orca/google":
      return ["hidden_interactive", "human_review"];
  }
}
