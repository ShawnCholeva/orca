import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import {
  ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES,
  OrchestrationRequest,
  type OrchestrationRequest as OrchestrationRequestT,
  type OrchestrationTransportFailureReason,
} from "@orca/contracts";

import type { AdapterRegistry } from "../../../adapters/registry.js";
import type { EventBus } from "../../../events.js";
import { redactSecrets } from "../../../memory/normalize.js";
import type { PtyHandle, PtyManager } from "../../../pty/types.js";
import {
  markTransportAttemptFailed,
  markTransportAttemptRejected,
  markTransportAttemptRunning,
  markTransportAttemptSucceeded,
} from "../attempts.js";
import { parseOrchestrationProposal } from "../proposals.js";
import type { OrchestrationWorkerStore } from "./store.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_DECISION_TIMEOUT_MS = 60_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_CAPTURE_MAX_BYTES = 256 * 1024;
const REQUEST_MAX_BYTES = ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES + 4096;
const DENIED_ENV_KEYS = new Set([
  "ORCA_AUTH_TOKEN",
  "ORCA_DESKTOP_TOKEN",
  "ORCA_API_TOKEN",
  "ORCA_MUTATION_TOKEN",
]);

export interface HiddenWorkerDriver {
  buildRequestInput(request: OrchestrationRequestT): string;
  detectReady(output: string): boolean;
  detectAuthLost(output: string): boolean;
  extractProposalOutput(output: string): string | null;
}

export interface ProposalValidationResult {
  accepted: boolean;
  failureMessage?: string;
}

export interface OrchestrationWorkerRuntimeDeps {
  db: Database.Database;
  bus: EventBus;
  adapterRegistry: AdapterRegistry;
  ptyManager: PtyManager;
  workerStore: OrchestrationWorkerStore;
  now?: () => string;
  nowMs?: () => number;
  idFactory?: () => string;
  startupTimeoutMs?: number;
  decisionTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface RunHiddenWorkerAttemptInput {
  attemptId: string;
  request: OrchestrationRequestT;
  adapterId: string;
  workspacePath: string;
  driver: HiddenWorkerDriver;
  workerId?: string;
  validateProposal?: (proposal: unknown) => ProposalValidationResult | Promise<ProposalValidationResult>;
}

export type RunHiddenWorkerAttemptResult =
  | {
      status: "proposed";
      attemptId: string;
      workerId: string;
      parsed: unknown;
      rawTextLength: number;
      latencyMs: number;
    }
  | {
      status: "rejected";
      attemptId: string;
      workerId: string;
      failureReason: "proposal_rejected";
      failureMessage: string;
      rawTextLength: number | null;
      latencyMs: number;
    }
  | {
      status: "failed";
      attemptId: string;
      workerId: string;
      failureReason: Extract<
        OrchestrationTransportFailureReason,
        | "interactive_spawn_failed"
        | "interactive_hung"
        | "interactive_auth_lost"
        | "interactive_output_invalid"
      >;
      failureMessage: string;
      rawTextLength: number | null;
      latencyMs: number;
    };

interface RuntimeFailure {
  reason: Extract<
    OrchestrationTransportFailureReason,
    "interactive_spawn_failed" | "interactive_hung" | "interactive_auth_lost" | "interactive_output_invalid"
  >;
  message: string;
  rawTextLength: number | null;
}

function sanitizeFailureMessage(message: string): string {
  return redactSecrets(message.replace(/\s+/g, " ").trim()).slice(0, 256);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function appendBoundedUtf8(current: string, next: Buffer, maxBytes: number): string {
  const currentBytes = Buffer.byteLength(current, "utf8");
  if (currentBytes >= maxBytes) return current;
  const remaining = maxBytes - currentBytes;
  if (next.byteLength <= remaining) {
    return current + next.toString("utf8");
  }
  const slice = next.subarray(0, remaining);
  return current + new TextDecoder("utf-8", { fatal: false }).decode(slice);
}

function sanitizeWorkerEnv(env: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (DENIED_ENV_KEYS.has(key)) continue;
    if (/^ORCA_.*TOKEN$/i.test(key)) continue;
    if (/^ORCA_.*MUTATION/i.test(key)) continue;
    next[key] = value;
  }
  return next;
}

function failure(
  reason: RuntimeFailure["reason"],
  message: string,
  rawTextLength: number | null = null
): RuntimeFailure {
  return {
    reason,
    message: sanitizeFailureMessage(message) || "hidden worker runtime failure",
    rawTextLength,
  };
}

export class OrchestrationWorkerRuntime {
  constructor(private readonly deps: OrchestrationWorkerRuntimeDeps) {}

  async runAttempt(input: RunHiddenWorkerAttemptInput): Promise<RunHiddenWorkerAttemptResult> {
    const now = this.deps.now ?? (() => new Date().toISOString());
    const nowMs = this.deps.nowMs ?? (() => Date.now());
    const idFactory = this.deps.idFactory ?? randomUUID;
    const startupTimeoutMs = this.deps.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const decisionTimeoutMs = this.deps.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    const heartbeatTimeoutMs = this.deps.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    const pollIntervalMs = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    const request = OrchestrationRequest.parse(input.request);
    const workerId = input.workerId ?? idFactory();
    const startedMs = nowMs();

    markTransportAttemptRunning(
      {
        db: this.deps.db,
        bus: this.deps.bus,
        now,
        idFactory,
      },
      input.attemptId
    );

    const adapter = this.deps.adapterRegistry.get(input.adapterId);
    if (!adapter) {
      return this.failAttempt(
        input.attemptId,
        workerId,
        failure("interactive_spawn_failed", `worker adapter unavailable: ${input.adapterId}`),
        now,
        idFactory,
        startedMs,
        false
      );
    }

    let spawnResult: {
      command: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
    };
    try {
      spawnResult = await adapter.resolveSpawn({
        goalId: request.goalId,
        sessionId: workerId,
        workspacePath: input.workspacePath,
        role: "orchestration_transport",
      });
    } catch (error) {
      return this.failAttempt(
        input.attemptId,
        workerId,
        failure(
          "interactive_spawn_failed",
          error instanceof Error ? error.message : "worker spawn command resolution failed"
        ),
        now,
        idFactory,
        startedMs,
        false
      );
    }

    this.deps.workerStore.createWorker({
      id: workerId,
      providerId: request.providerId,
      modelId: request.modelId,
      adapterId: input.adapterId,
      state: "starting",
      command: spawnResult.command,
      argsJson: JSON.stringify(spawnResult.args),
      cwd: spawnResult.cwd,
      currentGoalId: request.goalId,
      currentWorkflowRunId: request.workflowRunId,
      currentStepRunId: request.stepRunId,
      createdAt: now(),
    });

    let handle: PtyHandle;
    let onDataOff: (() => void) | undefined;
    let onExitOff: (() => void) | undefined;
    let exited = false;
    let startupOutput = "";
    let decisionOutput = "";
    let lastOutputAt = nowMs();

    try {
      const started = this.deps.ptyManager.start({
        command: spawnResult.command,
        args: spawnResult.args,
        cwd: spawnResult.cwd,
        env: sanitizeWorkerEnv(spawnResult.env),
        cols: 120,
        rows: 40,
      });
      handle = started.handle;
      onDataOff = started.events.onData((chunk) => {
        lastOutputAt = nowMs();
        startupOutput = appendBoundedUtf8(startupOutput, chunk, DEFAULT_CAPTURE_MAX_BYTES);
        decisionOutput = appendBoundedUtf8(decisionOutput, chunk, DEFAULT_CAPTURE_MAX_BYTES);
        this.deps.workerStore.appendWorkerOutput(workerId, chunk);
      });
      onExitOff = started.events.onExit(() => {
        exited = true;
      });
    } catch (error) {
      return this.failAttempt(
        input.attemptId,
        workerId,
        failure(
          "interactive_spawn_failed",
          error instanceof Error ? error.message : "failed to spawn hidden interactive worker"
        ),
        now,
        idFactory,
        startedMs,
        true
      );
    }

    this.deps.workerStore.transitionWorkerState({
      workerId,
      state: "ready",
      startedAt: now(),
      lastHealthAt: now(),
    });

    const startupFailure = await this.waitUntil(
      { timeoutMs: startupTimeoutMs, pollIntervalMs },
      nowMs,
      () => {
        if (input.driver.detectAuthLost(startupOutput)) {
          this.deps.workerStore.transitionWorkerState({
            workerId,
            state: "auth_required",
            lastHealthAt: now(),
            failureReason: "interactive_auth_lost",
            failureDetail: "worker requires login",
          });
          return failure("interactive_auth_lost", "worker reported login/authentication required");
        }
        if (input.driver.detectReady(startupOutput)) {
          return null;
        }
        if (exited) {
          return failure(
            "interactive_spawn_failed",
            "worker exited before becoming ready",
            startupOutput.length
          );
        }
        if (nowMs() - lastOutputAt >= heartbeatTimeoutMs) {
          this.deps.workerStore.transitionWorkerState({
            workerId,
            state: "hung",
            lastHealthAt: now(),
            failureReason: "interactive_hung",
            failureDetail: "worker startup heartbeat timed out",
          });
          return failure("interactive_hung", "hidden worker startup heartbeat timed out");
        }
        return undefined;
      }
    );

    if (startupFailure) {
      if (startupFailure.reason === "interactive_hung") {
        this.deps.workerStore.transitionWorkerState({
          workerId,
          state: "hung",
          lastHealthAt: now(),
          failureReason: "interactive_hung",
          failureDetail: startupFailure.message,
        });
      }
      return this.failAttempt(
        input.attemptId,
        workerId,
        startupFailure,
        now,
        idFactory,
        startedMs,
        true,
        handle,
        onDataOff,
        onExitOff
      );
    }

    this.deps.workerStore.transitionWorkerState({
      workerId,
      state: "awaiting_input",
      lastHealthAt: now(),
    });

    const requestInput = input.driver.buildRequestInput(request);
    if (Buffer.byteLength(requestInput, "utf8") > REQUEST_MAX_BYTES) {
      return this.failAttempt(
        input.attemptId,
        workerId,
        failure("interactive_output_invalid", "hidden-worker request input exceeded bounded size"),
        now,
        idFactory,
        startedMs,
        true,
        handle
      );
    }

    this.deps.workerStore.transitionWorkerState({
      workerId,
      state: "producing_decision",
      lastHealthAt: now(),
    });
    handle.write(Buffer.from(requestInput, "utf8"));

    const proposalFailure = await this.waitUntil(
      { timeoutMs: decisionTimeoutMs, pollIntervalMs },
      nowMs,
      () => {
        if (input.driver.detectAuthLost(decisionOutput)) {
          this.deps.workerStore.transitionWorkerState({
            workerId,
            state: "auth_required",
            lastHealthAt: now(),
            failureReason: "interactive_auth_lost",
            failureDetail: "worker lost authentication during decision",
          });
          return failure("interactive_auth_lost", "worker lost authentication during decision");
        }
        const proposalText = input.driver.extractProposalOutput(decisionOutput);
        if (proposalText !== null) return null;
        if (exited) {
          return failure(
            "interactive_output_invalid",
            "worker exited before returning a proposal envelope",
            decisionOutput.length
          );
        }
        if (nowMs() - lastOutputAt >= heartbeatTimeoutMs) {
          this.deps.workerStore.transitionWorkerState({
            workerId,
            state: "hung",
            lastHealthAt: now(),
            failureReason: "interactive_hung",
            failureDetail: "worker decision heartbeat timed out",
          });
          return failure("interactive_hung", "hidden worker decision heartbeat timed out");
        }
        return undefined;
      }
    );

    if (proposalFailure) {
      if (proposalFailure.reason === "interactive_hung") {
        this.deps.workerStore.transitionWorkerState({
          workerId,
          state: "hung",
          lastHealthAt: now(),
          failureReason: "interactive_hung",
          failureDetail: proposalFailure.message,
        });
      }
      return this.failAttempt(
        input.attemptId,
        workerId,
        proposalFailure,
        now,
        idFactory,
        startedMs,
        true,
        handle,
        onDataOff,
        onExitOff
      );
    }

    const proposalText = input.driver.extractProposalOutput(decisionOutput);
    if (proposalText === null) {
      return this.failAttempt(
        input.attemptId,
        workerId,
        failure(
          "interactive_output_invalid",
          "worker produced no extractable proposal envelope",
          decisionOutput.length
        ),
        now,
        idFactory,
        startedMs,
        true,
        handle,
        onDataOff,
        onExitOff
      );
    }

    const parsed = parseOrchestrationProposal(proposalText, {
      expectedKind: request.kind,
      malformedFailureReason: "interactive_output_invalid",
    });

    if (!parsed.ok) {
      return this.failAttempt(
        input.attemptId,
        workerId,
        failure("interactive_output_invalid", parsed.failureMessage, parsed.rawTextLength),
        now,
        idFactory,
        startedMs,
        true,
        handle,
        onDataOff,
        onExitOff
      );
    }

    if (input.validateProposal) {
      const verdict = await input.validateProposal(parsed.parsed);
      if (!verdict.accepted) {
        markTransportAttemptRejected(
          {
            db: this.deps.db,
            bus: this.deps.bus,
            now,
            idFactory,
          },
          {
            attemptId: input.attemptId,
            failureReason: "proposal_rejected",
            failureMessage: verdict.failureMessage ?? "proposal rejected by validation",
            rawTextLength: parsed.rawTextLength,
            latencyMs: nowMs() - startedMs,
          }
        );
        handle.kill("SIGTERM");
        this.deps.workerStore.markWorkerStopped(workerId, now());
        onDataOff?.();
        onExitOff?.();
        return {
          status: "rejected",
          attemptId: input.attemptId,
          workerId,
          failureReason: "proposal_rejected",
          failureMessage: sanitizeFailureMessage(
            verdict.failureMessage ?? "proposal rejected by validation"
          ),
          rawTextLength: parsed.rawTextLength,
          latencyMs: nowMs() - startedMs,
        };
      }
    }

    markTransportAttemptSucceeded(
      {
        db: this.deps.db,
        bus: this.deps.bus,
        now,
        idFactory,
      },
      {
        attemptId: input.attemptId,
        rawTextLength: parsed.rawTextLength,
        latencyMs: nowMs() - startedMs,
      }
    );
    handle.kill("SIGTERM");
    this.deps.workerStore.markWorkerStopped(workerId, now());
    onDataOff?.();
    onExitOff?.();

    return {
      status: "proposed",
      attemptId: input.attemptId,
      workerId,
      parsed: parsed.parsed,
      rawTextLength: parsed.rawTextLength,
      latencyMs: nowMs() - startedMs,
    };
  }

  private async waitUntil(
    options: {
      timeoutMs: number;
      pollIntervalMs: number;
    },
    nowMs: () => number,
    check: () => RuntimeFailure | null | undefined
  ): Promise<RuntimeFailure | null> {
    const startedAtMs = nowMs();

    while (true) {
      const outcome = check();
      if (outcome === null) return null;
      if (outcome !== undefined) return outcome;

      const nowAt = nowMs();
      if (nowAt - startedAtMs >= options.timeoutMs) {
        return failure("interactive_hung", "hidden worker exceeded timeout budget");
      }

      await delay(options.pollIntervalMs);
    }
  }

  private failAttempt(
    attemptId: string,
    workerId: string,
    runtimeFailure: RuntimeFailure,
    now: () => string,
    idFactory: () => string,
    startedMs: number,
    workerRowExists: boolean,
    handle?: PtyHandle,
    onDataOff?: () => void,
    onExitOff?: () => void
  ): RunHiddenWorkerAttemptResult {
    if (handle) {
      try {
        handle.kill("SIGTERM");
      } catch {
        // Ignore PTY shutdown errors while failing the attempt.
      }
    }
    onDataOff?.();
    onExitOff?.();
    if (workerRowExists) {
      this.deps.workerStore.markWorkerFailed({
        workerId,
        failureReason: runtimeFailure.reason,
        failureDetail: runtimeFailure.message,
        stoppedAt: now(),
      });
    }

    markTransportAttemptFailed(
      {
        db: this.deps.db,
        bus: this.deps.bus,
        now,
        idFactory,
      },
      {
        attemptId,
        failureReason: runtimeFailure.reason,
        failureMessage: runtimeFailure.message,
        rawTextLength: runtimeFailure.rawTextLength,
        latencyMs: (this.deps.nowMs ?? (() => Date.now()))() - startedMs,
      }
    );

    return {
      status: "failed",
      attemptId,
      workerId,
      failureReason: runtimeFailure.reason,
      failureMessage: runtimeFailure.message,
      rawTextLength: runtimeFailure.rawTextLength,
      latencyMs: (this.deps.nowMs ?? (() => Date.now()))() - startedMs,
    };
  }
}
