import type { AdapterId, ModelProviderId } from "@orca/contracts";

import type { WorkerHookConfigScope } from "../hooks.js";
import type { HiddenWorkerDriver } from "../runtime.js";
import { claudeHiddenWorkerDriver } from "./claude.js";
import { codexHiddenWorkerDriver } from "./codex.js";
import { geminiHiddenWorkerDriver } from "./gemini.js";

export interface ProviderHiddenWorkerDriver extends HiddenWorkerDriver {
  providerId: ModelProviderId;
  adapterId: AdapterId;
  hookConfigScope: WorkerHookConfigScope;
  buildHookConfigInput(input: {
    workerId: string;
    attemptId: string;
  }): {
    providerId: ModelProviderId;
    adapterId: AdapterId;
    workerId: string;
    attemptId: string;
    configScope: WorkerHookConfigScope;
  };
  detectRateLimited(output: string): boolean;
  detectPermissionPrompt(output: string): boolean;
  summarizeDebug(output: string, fallback?: string): string;
}

const DRIVER_BY_PROVIDER: Record<ModelProviderId, ProviderHiddenWorkerDriver> = {
  "orca/anthropic": claudeHiddenWorkerDriver,
  "orca/openai": codexHiddenWorkerDriver,
  "orca/google-gemini": geminiHiddenWorkerDriver,
};

export function resolveHiddenWorkerDriver(
  providerId: ModelProviderId
): ProviderHiddenWorkerDriver {
  return DRIVER_BY_PROVIDER[providerId];
}

export function listHiddenWorkerDrivers(): ProviderHiddenWorkerDriver[] {
  return Object.values(DRIVER_BY_PROVIDER);
}
