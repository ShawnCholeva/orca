import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";
import {
  WORKFLOW_FAILURE_MAX_MESSAGE_CHARS,
  type AdapterId,
  type ModelProviderId,
  type OrchestrationTransportFailureReason,
  type WorkerHookCapabilities,
} from "@orca/contracts";

import { sanitizeOutput } from "../../../readiness/sanitize.js";

export type WorkerHookCapabilityKey =
  | "sessionStart"
  | "promptSubmit"
  | "beforeModel"
  | "afterModel"
  | "beforeToolSelection"
  | "beforeToolUse"
  | "permissionRequest"
  | "afterToolUse"
  | "stop"
  | "stopFailure"
  | "sessionEnd";

export type WorkerHookCapabilityStatus =
  | "supported"
  | "unsupported"
  | "verify"
  | "skipped";

export type WorkerHookConfigScope = "worker" | "global" | "unsupported";

export type WorkerHookTraceStatus =
  | "started"
  | "succeeded"
  | "blocked"
  | "failed"
  | "skipped";

export interface WorkerHookCapability {
  key: WorkerHookCapabilityKey;
  eventName: string | null;
  status: WorkerHookCapabilityStatus;
  reason?: string;
}

export interface ResolvedWorkerHookCapabilities {
  providerId: ModelProviderId;
  adapterId: string;
  expectedAdapterId: AdapterId;
  configScope: WorkerHookConfigScope;
  canGenerateWorkerConfig: boolean;
  capabilities: WorkerHookCapability[];
  skippedReason?: string;
}

export interface GenerateWorkerHookConfigInput {
  runtimeDir: string;
  providerId: ModelProviderId;
  adapterId: string;
  workerId: string;
  attemptId: string;
  configScope?: WorkerHookConfigScope;
  now?: () => string;
}

export interface WorkerHookConfigGenerationResult extends ResolvedWorkerHookCapabilities {
  configDir: string | null;
  configPath: string | null;
}

export interface RecordWorkerHookTraceInput {
  id?: string;
  attemptId: string;
  workerId: string;
  providerId: ModelProviderId;
  hookEventName: string;
  hookStatus: WorkerHookTraceStatus;
  summary: string;
  failureReason?: OrchestrationTransportFailureReason | null;
  createdAt?: string;
}

export interface WorkerHookTraceRow {
  id: string;
  attempt_id: string;
  worker_id: string;
  provider_id: ModelProviderId;
  hook_event_name: string;
  hook_status: WorkerHookTraceStatus;
  summary: string;
  failure_reason: OrchestrationTransportFailureReason | null;
  created_at: string;
}

export interface WorkerHookTraceCtx {
  db: Database.Database;
  now?: () => string;
  idFactory?: () => string;
}

type ProviderDirectory = "claude" | "codex" | "gemini";

type HookCapabilityTemplate = Omit<WorkerHookCapability, "status"> & {
  status: Exclude<WorkerHookCapabilityStatus, "skipped">;
};

const EXPECTED_ADAPTER_BY_PROVIDER: Record<ModelProviderId, AdapterId> = {
  "orca/anthropic": "claude-code",
  "orca/openai": "codex",
  "orca/google-gemini": "gemini-cli",
};

const PROVIDER_DIRECTORY_BY_ID: Record<ModelProviderId, ProviderDirectory> = {
  "orca/anthropic": "claude",
  "orca/openai": "codex",
  "orca/google-gemini": "gemini",
};

const CONFIG_FILE_BY_PROVIDER: Record<ModelProviderId, "settings.json" | "hooks.json"> = {
  "orca/anthropic": "settings.json",
  "orca/openai": "hooks.json",
  "orca/google-gemini": "settings.json",
};

const CAPABILITY_TEMPLATES: Record<ModelProviderId, HookCapabilityTemplate[]> = {
  "orca/anthropic": [
    { key: "sessionStart", eventName: "SessionStart", status: "supported" },
    { key: "promptSubmit", eventName: "UserPromptSubmit", status: "supported" },
    { key: "beforeToolUse", eventName: "PreToolUse", status: "supported" },
    { key: "permissionRequest", eventName: "PermissionRequest", status: "supported" },
    { key: "afterToolUse", eventName: "PostToolUse", status: "supported" },
    { key: "stop", eventName: "Stop", status: "supported" },
    { key: "stopFailure", eventName: "StopFailure", status: "supported" },
    { key: "sessionEnd", eventName: "SessionEnd", status: "supported" },
  ],
  "orca/openai": [
    { key: "sessionStart", eventName: "SessionStart", status: "supported" },
    { key: "promptSubmit", eventName: "UserPromptSubmit", status: "supported" },
    { key: "beforeToolUse", eventName: "PreToolUse", status: "supported" },
    { key: "permissionRequest", eventName: "PermissionRequest", status: "supported" },
    { key: "afterToolUse", eventName: "PostToolUse", status: "supported" },
    { key: "stop", eventName: "Stop", status: "supported" },
    {
      key: "stopFailure",
      eventName: "StopFailure",
      status: "verify",
      reason: "Codex stopFailure hook support must be confirmed for the installed CLI version",
    },
    {
      key: "sessionEnd",
      eventName: "SessionEnd",
      status: "verify",
      reason: "Codex sessionEnd hook support must be confirmed for the installed CLI version",
    },
  ],
  "orca/google-gemini": [
    {
      key: "promptSubmit",
      eventName: "BeforeAgent",
      status: "verify",
      reason: "Gemini BeforeAgent request-envelope blocking must be confirmed per installed CLI version",
    },
    { key: "beforeModel", eventName: "BeforeModel", status: "supported" },
    { key: "afterModel", eventName: "AfterModel", status: "supported" },
    { key: "beforeToolSelection", eventName: "BeforeToolSelection", status: "supported" },
    { key: "beforeToolUse", eventName: "BeforeTool", status: "supported" },
    { key: "afterToolUse", eventName: "AfterTool", status: "supported" },
    { key: "stop", eventName: "AfterAgent", status: "supported" },
    { key: "sessionEnd", eventName: "SessionEnd", status: "supported" },
  ],
};

const PROMPT_CAPABILITY_KEYS = new Set<WorkerHookCapabilityKey>([
  "promptSubmit",
  "beforeModel",
]);
const STOP_CAPABILITY_KEYS = new Set<WorkerHookCapabilityKey>([
  "stop",
  "stopFailure",
  "sessionEnd",
]);
const STATE_CAPABILITY_KEYS = new Set<WorkerHookCapabilityKey>([
  "sessionStart",
  "sessionEnd",
]);

function nowIso(now?: () => string): string {
  return now?.() ?? new Date().toISOString();
}

function idFactory(ctx: WorkerHookTraceCtx): () => string {
  return ctx.idFactory ?? randomUUID;
}

function cloneCapabilities(providerId: ModelProviderId): WorkerHookCapability[] {
  return CAPABILITY_TEMPLATES[providerId].map((capability) => ({ ...capability }));
}

function markSkipped(
  capabilities: WorkerHookCapability[],
  reason: string
): WorkerHookCapability[] {
  return capabilities.map((capability) => ({
    ...capability,
    status: "skipped",
    reason,
  }));
}

function sanitizeHookText(input: string, fallback: string): string {
  const sanitized = sanitizeOutput(input).replace(/\s+/g, " ").trim();
  const capped = sanitized.slice(0, WORKFLOW_FAILURE_MAX_MESSAGE_CHARS);
  return capped.length > 0 ? capped : fallback;
}

function sanitizeSegment(input: string): string {
  const segment = input.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
  return segment.length > 0 ? segment : "unknown";
}

function assertInsideRuntimeDir(runtimeDir: string, targetPath: string): void {
  const root = path.resolve(runtimeDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error("worker hook config path escaped runtime directory");
}

function hasEnabledCapability(
  capabilities: WorkerHookCapability[],
  keys: Set<WorkerHookCapabilityKey>
): boolean {
  return capabilities.some(
    (capability) =>
      keys.has(capability.key) &&
      (capability.status === "supported" || capability.status === "verify")
  );
}

function requireHookTrace(db: Database.Database, id: string): WorkerHookTraceRow {
  const row = db
    .prepare("SELECT * FROM orchestration_worker_hook_traces WHERE id = ?")
    .get(id) as WorkerHookTraceRow | undefined;
  if (!row) throw new Error(`Orchestration worker hook trace not found: ${id}`);
  return row;
}

export function providerHookDirectory(providerId: ModelProviderId): ProviderDirectory {
  return PROVIDER_DIRECTORY_BY_ID[providerId];
}

export function resolveWorkerHookCapabilities(input: {
  providerId: ModelProviderId;
  adapterId: string;
  configScope?: WorkerHookConfigScope;
}): ResolvedWorkerHookCapabilities {
  const configScope = input.configScope ?? "worker";
  const expectedAdapterId = EXPECTED_ADAPTER_BY_PROVIDER[input.providerId];
  const baseCapabilities = cloneCapabilities(input.providerId);

  if (input.adapterId !== expectedAdapterId) {
    const skippedReason = `adapter ${input.adapterId} does not confirm ${input.providerId} hook support`;
    return {
      providerId: input.providerId,
      adapterId: input.adapterId,
      expectedAdapterId,
      configScope: "unsupported",
      canGenerateWorkerConfig: false,
      capabilities: markSkipped(baseCapabilities, skippedReason),
      skippedReason,
    };
  }

  if (configScope === "global") {
    const skippedReason =
      "global hook configuration requires explicit user opt-in and is skipped for hidden workers";
    return {
      providerId: input.providerId,
      adapterId: input.adapterId,
      expectedAdapterId,
      configScope,
      canGenerateWorkerConfig: false,
      capabilities: markSkipped(baseCapabilities, skippedReason),
      skippedReason,
    };
  }

  if (configScope === "unsupported") {
    const skippedReason = "worker-scoped hook configuration is not supported by this adapter";
    return {
      providerId: input.providerId,
      adapterId: input.adapterId,
      expectedAdapterId,
      configScope,
      canGenerateWorkerConfig: false,
      capabilities: markSkipped(baseCapabilities, skippedReason),
      skippedReason,
    };
  }

  return {
    providerId: input.providerId,
    adapterId: input.adapterId,
    expectedAdapterId,
    configScope,
    canGenerateWorkerConfig: true,
    capabilities: baseCapabilities,
  };
}

export function toContractWorkerHookCapabilities(
  resolved: ResolvedWorkerHookCapabilities,
  detectedAt: string
): WorkerHookCapabilities {
  return {
    providerId: resolved.providerId,
    supportsPromptHooks: hasEnabledCapability(resolved.capabilities, PROMPT_CAPABILITY_KEYS),
    supportsStopHooks: hasEnabledCapability(resolved.capabilities, STOP_CAPABILITY_KEYS),
    supportsStateHooks: hasEnabledCapability(resolved.capabilities, STATE_CAPABILITY_KEYS),
    detectedAt,
  };
}

export function generateWorkerHookConfig(
  input: GenerateWorkerHookConfigInput
): WorkerHookConfigGenerationResult {
  const resolved = resolveWorkerHookCapabilities(input);
  if (!resolved.canGenerateWorkerConfig) {
    return {
      ...resolved,
      configDir: null,
      configPath: null,
    };
  }

  const runtimeRoot = path.resolve(input.runtimeDir);
  const configDir = path.join(
    runtimeRoot,
    "orchestration-workers",
    providerHookDirectory(input.providerId),
    sanitizeSegment(input.workerId)
  );
  const configPath = path.join(configDir, CONFIG_FILE_BY_PROVIDER[input.providerId]);
  assertInsideRuntimeDir(runtimeRoot, configDir);
  assertInsideRuntimeDir(runtimeRoot, configPath);

  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        orcaWorkerHookConfigVersion: 1,
        providerId: input.providerId,
        adapterId: input.adapterId,
        workerId: input.workerId,
        attemptId: input.attemptId,
        scope: "worker",
        authority: "trace_only",
        workflowMutationAllowed: false,
        mutationCredentialsAllowed: false,
        generatedAt: nowIso(input.now),
        hooks: resolved.capabilities.map((capability) => ({
          key: capability.key,
          eventName: capability.eventName,
          status: capability.status,
          enabled: capability.status === "supported",
          traceOnly: true,
          reason: capability.reason,
        })),
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );

  return {
    ...resolved,
    configDir,
    configPath,
  };
}

export function recordWorkerHookTrace(
  ctx: WorkerHookTraceCtx,
  input: RecordWorkerHookTraceInput
): WorkerHookTraceRow {
  const id = input.id ?? idFactory(ctx)();
  const createdAt = input.createdAt ?? nowIso(ctx.now);
  const hookEventName = sanitizeHookText(input.hookEventName, "unknown-hook");
  const summary = sanitizeHookText(input.summary, "hook trace recorded");

  ctx.db
    .prepare(
      "INSERT INTO orchestration_worker_hook_traces (id, attempt_id, worker_id, provider_id, hook_event_name, hook_status, summary, failure_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      id,
      input.attemptId,
      input.workerId,
      input.providerId,
      hookEventName,
      input.hookStatus,
      summary,
      input.failureReason ?? null,
      createdAt
    );

  return requireHookTrace(ctx.db, id);
}
