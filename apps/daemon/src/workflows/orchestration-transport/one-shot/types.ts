import type { AdapterId, ModelProviderId } from "@orca/contracts";

import type { AdapterRegistry } from "../../../adapters/registry.js";

export type OneShotAllowedAdapterId = Extract<AdapterId, "codex" | "gemini-cli">;

export interface OneShotRunInput {
  requestJson: string;
  timeoutMs: number;
}

export interface OneShotRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  latencyMs: number;
}

export interface OneShotRunner {
  readonly adapterId: OneShotAllowedAdapterId;
  run(input: OneShotRunInput): Promise<OneShotRunResult>;
}

export interface OneShotReadiness {
  status: string;
}

export type OneShotReadinessLookup = (
  adapterId: OneShotAllowedAdapterId,
) => Promise<OneShotReadiness | null>;

export interface ResolveOneShotRunnerDeps {
  adapterRegistry: AdapterRegistry;
  readinessLookup: OneShotReadinessLookup;
  runners: Partial<Record<OneShotAllowedAdapterId, OneShotRunner>>;
}

export type ResolveOneShotRunnerResult =
  | {
      status: "available";
      providerId: ModelProviderId;
      adapterId: OneShotAllowedAdapterId;
      runner: OneShotRunner;
    }
  | {
      status: "unavailable";
      providerId: ModelProviderId;
      failureReason: "one_shot_unavailable";
    };
