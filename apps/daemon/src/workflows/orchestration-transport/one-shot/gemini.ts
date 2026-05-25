import { spawn } from "node:child_process";

import {
  ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES,
  WORKFLOW_FAILURE_MAX_MESSAGE_CHARS,
  OrchestrationRequest,
  type OrchestrationRequest as OrchestrationRequestT,
  type OrchestrationTransportFailureReason,
} from "@orca/contracts";

import type { AdapterSpawnInput, AgentAdapter } from "../../../adapters/types.js";
import { redactSecrets } from "../../../memory/normalize.js";
import { parseOrchestrationProposal } from "../proposals.js";

type OneShotFailureReason = Extract<
  OrchestrationTransportFailureReason,
  "one_shot_unavailable" | "one_shot_parse_failed" | "one_shot_rate_limited"
>;

export type GeminiOneShotResult =
  | {
      status: "proposed";
      parsed: unknown;
      rawTextLength: number;
      latencyMs: number;
    }
  | {
      status: "failed";
      failureReason: OneShotFailureReason;
      failureMessage: string;
      rawTextLength: number | null;
      latencyMs: number;
    };

export interface GeminiOneShotRunner {
  readonly adapterId: "gemini-cli";
  run(request: OrchestrationRequestT): Promise<GeminiOneShotResult>;
}

export interface GeminiOneShotRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  latencyMs: number;
}

export type GeminiOneShotProcessRunner = (input: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  timeoutMs: number;
}) => Promise<GeminiOneShotRunResult>;

export interface CreateGeminiOneShotRunnerDeps {
  adapter: AgentAdapter;
  processRunner?: GeminiOneShotProcessRunner;
  timeoutMs?: number;
  workspacePath?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 128 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const REQUEST_JSON_MAX_BYTES = ORCHESTRATION_REQUEST_MAX_PAYLOAD_BYTES + 4096;
const PROCESS_KILL_GRACE_MS = 1000;

const RATE_LIMIT_PATTERN =
  /\brate.?limit(?:ed|ing)?\b|\bquota\b|\btoo many requests\b|\binsufficient_quota\b|\b429\b/i;

export function createGeminiOneShotRunner(deps: CreateGeminiOneShotRunnerDeps): GeminiOneShotRunner {
  const processRunner = deps.processRunner ?? runGeminiProcess;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workspacePath = deps.workspacePath ?? process.cwd();

  return {
    adapterId: "gemini-cli",
    run: async (request) => {
      if (deps.adapter.id !== "gemini-cli") {
        return failed("one_shot_unavailable", "gemini adapter strategy unavailable", null, 0);
      }

      const parsedRequest = OrchestrationRequest.parse(request);

      const auth = await deps.adapter.checkAuth();
      if (!auth.ok || auth.authStatus !== "ready") {
        return failed("one_shot_unavailable", "gemini adapter is not ready", null, 0);
      }

      const spawnInput: AdapterSpawnInput = {
        goalId: parsedRequest.goalId,
        sessionId: parsedRequest.attemptId ?? `orchestration-one-shot-${parsedRequest.goalId}`,
        workspacePath,
        role: "orchestration_transport",
      };

      let spawnConfig;
      try {
        spawnConfig = await deps.adapter.resolveSpawn(spawnInput);
      } catch (error) {
        return failed(
          "one_shot_unavailable",
          error instanceof Error ? error.message : "gemini spawn resolution failed",
          null,
          0
        );
      }

      const requestJson = JSON.stringify(parsedRequest);
      if (Buffer.byteLength(requestJson, "utf8") > REQUEST_JSON_MAX_BYTES) {
        return failed("one_shot_unavailable", "orchestration request exceeds one-shot input bound", null, 0);
      }
      const stdin = buildGeminiInput(parsedRequest.kind, requestJson);

      const runResult = await processRunner({
        command: spawnConfig.command,
        args: spawnConfig.args,
        cwd: spawnConfig.cwd,
        env: spawnConfig.env,
        stdin,
        timeoutMs,
      });

      const combined = `${runResult.stdout}\n${runResult.stderr}`;
      if (runResult.timedOut) {
        return failed("one_shot_unavailable", "gemini one-shot timed out", null, runResult.latencyMs);
      }

      if (runResult.exitCode !== 0) {
        if (RATE_LIMIT_PATTERN.test(combined)) {
          return failed(
            "one_shot_rate_limited",
            "gemini reported rate or quota limits",
            runResult.stdout.length,
            runResult.latencyMs
          );
        }
        return failed(
          "one_shot_unavailable",
          "gemini one-shot process failed",
          runResult.stdout.length,
          runResult.latencyMs
        );
      }

      const parsedProposal = parseOrchestrationProposal(runResult.stdout, {
        expectedKind: parsedRequest.kind,
        malformedFailureReason: "one_shot_parse_failed",
      });
      if (!parsedProposal.ok) {
        const failureReason: OneShotFailureReason = RATE_LIMIT_PATTERN.test(combined)
          ? "one_shot_rate_limited"
          : "one_shot_parse_failed";
        return failed(
          failureReason,
          parsedProposal.failureMessage,
          parsedProposal.rawTextLength,
          runResult.latencyMs
        );
      }

      return {
        status: "proposed",
        parsed: parsedProposal.parsed,
        rawTextLength: parsedProposal.rawTextLength,
        latencyMs: runResult.latencyMs,
      };
    },
  };
}

function buildGeminiInput(kind: OrchestrationRequestT["kind"], requestJson: string): string {
  return [
    "You are the Orca one-shot transport runner.",
    "Return exactly one JSON object and no other text.",
    "The JSON object must have this envelope shape:",
    `{"orcaProposalVersion":1,"kind":"${kind}","payload":{...}}`,
    `The \"kind\" field must be exactly \"${kind}\".`,
    "Validate your payload against the expected Orca schema for that kind before returning.",
    "Request JSON follows.",
    requestJson,
  ].join("\n");
}

function sanitizeFailureMessage(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  const redacted = redactSecrets(compact);
  const bounded = redacted.slice(0, WORKFLOW_FAILURE_MAX_MESSAGE_CHARS);
  return bounded.length > 0 ? bounded : "gemini one-shot failed";
}

function failed(
  failureReason: OneShotFailureReason,
  failureMessage: string,
  rawTextLength: number | null,
  latencyMs: number
): GeminiOneShotResult {
  return {
    status: "failed",
    failureReason,
    failureMessage: sanitizeFailureMessage(failureMessage),
    rawTextLength,
    latencyMs,
  };
}

async function runGeminiProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  timeoutMs: number;
}): Promise<GeminiOneShotRunResult> {
  const startedAt = Date.now();

  return await new Promise<GeminiOneShotRunResult>((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { PATH: process.env["PATH"] ?? "", ...input.env },
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let exitCode: number | null = null;
    let settled = false;
    let childExited = false;
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout,
        stderr,
        exitCode,
        timedOut,
        latencyMs: Date.now() - startedAt,
      });
    };

    child.on("error", (err) => {
      stderr = appendBounded(stderr, err.message, MAX_STDERR_BYTES, () => stderrBytes, (v) => {
        stderrBytes = v;
      });
      exitCode = null;
      finish();
    });
    child.on("exit", (code) => {
      childExited = true;
      exitCode = typeof code === "number" ? code : null;
      finish();
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendBounded(
        stdout,
        chunk.toString(),
        MAX_STDOUT_BYTES,
        () => stdoutBytes,
        (v) => {
          stdoutBytes = v;
        }
      );
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendBounded(
        stderr,
        chunk.toString(),
        MAX_STDERR_BYTES,
        () => stderrBytes,
        (v) => {
          stderrBytes = v;
        }
      );
    });

    child.stdin.end(input.stdin);

    termTimer = setTimeout(() => {
      timedOut = true;
      if (!childExited) child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!childExited) child.kill("SIGKILL");
      }, PROCESS_KILL_GRACE_MS);
    }, input.timeoutMs);
  });
}

function appendBounded(
  current: string,
  next: string,
  maxBytes: number,
  getCurrentBytes: () => number,
  setCurrentBytes: (value: number) => void
): string {
  const currentBytes = getCurrentBytes();
  if (currentBytes >= maxBytes) return current;

  const remaining = maxBytes - currentBytes;
  const nextBuffer = Buffer.from(next, "utf8");
  const chunk = nextBuffer.byteLength > remaining ? nextBuffer.subarray(0, remaining).toString("utf8") : next;
  setCurrentBytes(currentBytes + Buffer.byteLength(chunk, "utf8"));
  return current + chunk;
}
