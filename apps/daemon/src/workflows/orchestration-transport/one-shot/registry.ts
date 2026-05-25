import type { ModelProviderId } from "@orca/contracts";

import type {
  OneShotAllowedAdapterId,
  ResolveOneShotRunnerDeps,
  ResolveOneShotRunnerResult,
} from "./types.js";

const PROVIDER_ALLOWLIST: Partial<Record<ModelProviderId, OneShotAllowedAdapterId>> = {
  "orca/openai": "codex",
  "orca/google-gemini": "gemini-cli",
};

export async function resolveOneShotRunner(
  providerId: ModelProviderId,
  deps: ResolveOneShotRunnerDeps,
): Promise<ResolveOneShotRunnerResult> {
  const adapterId = PROVIDER_ALLOWLIST[providerId];
  if (!adapterId) {
    return unavailable(providerId);
  }

  const adapter = deps.adapterRegistry.get(adapterId);
  if (!adapter) {
    return unavailable(providerId);
  }

  const readiness = await deps.readinessLookup(adapterId);
  if (!readiness || readiness.status !== "ready") {
    return unavailable(providerId);
  }

  const runner = deps.runners[adapterId];
  if (!runner || runner.adapterId !== adapterId) {
    return unavailable(providerId);
  }

  return {
    status: "available",
    providerId,
    adapterId,
    runner,
  };
}

function unavailable(providerId: ModelProviderId): ResolveOneShotRunnerResult {
  return {
    status: "unavailable",
    providerId,
    failureReason: "one_shot_unavailable",
  };
}

export function getOneShotAllowlist(): Readonly<
  Partial<Record<ModelProviderId, OneShotAllowedAdapterId>>
> {
  return PROVIDER_ALLOWLIST;
}
