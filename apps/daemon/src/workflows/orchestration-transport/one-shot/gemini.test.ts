import type { OrchestrationRequest as OrchestrationRequestT } from "@orca/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AgentAdapter } from "../../../adapters/types.js";
import { createGeminiOneShotRunner } from "./gemini.js";

const REQUEST: OrchestrationRequestT = {
  kind: "select_operator",
  goalId: "goal-1",
  workflowRunId: "run-1",
  stepRunId: "step-1",
  providerId: "orca/google-gemini",
  modelId: "gemini-2.5-pro",
  payload: {
    stepName: "Execution",
    stepPurpose: "Pick an operator",
    recommendedCapabilities: ["implementation"],
    recommendedOperatorIds: ["agent:codex"],
    excludedOperatorIds: [],
    readyOperators: [{ id: "agent:codex", kind: "agent", capabilities: ["implementation"] }],
  },
};

function makeAdapter(
  overrides: Partial<AgentAdapter> = {},
  authStatus: "ready" | "needs_auth" | "misconfigured" = "ready"
): AgentAdapter {
  return {
    id: "gemini-cli",
    title: "Gemini CLI",
    supportedExecutionModes: ["one_shot"] as const,
    contextDelivery: { mode: "preview_only", maxBytes: 32768 },
    resolveSpawn: async () => ({
      command: "gemini",
      args: [],
      env: { PATH: process.env["PATH"] ?? "" },
      cwd: "/tmp",
    }),
    probeAvailability: async () => ({ status: "available" }),
    checkInstalled: async () => ({ name: "installed", ok: true, command: "gemini --version" }),
    checkAuth: async () => ({
      name: "authenticated",
      ok: authStatus === "ready",
      authStatus,
      command: "gemini auth",
    }),
    repairFor: () => undefined,
    ...overrides,
  };
}

function envelope(payload: unknown): string {
  return JSON.stringify({
    orcaProposalVersion: 1,
    kind: "select_operator",
    payload,
  });
}

describe("gemini one-shot runner", () => {
  it("returns proposed when gemini exits 0 with exactly one valid envelope", async () => {
    const processRunner = vi.fn().mockResolvedValue({
      stdout: envelope({
        operatorId: "agent:codex",
        operatorKind: "agent",
        reason: "best match",
        requiredCapabilities: ["implementation"],
        alternativesConsidered: ["human"],
        confidence: 0.9,
        requiresUserApproval: false,
      }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      latencyMs: 33,
    });
    const runner = createGeminiOneShotRunner({
      adapter: makeAdapter(),
      processRunner,
      workspacePath: "/tmp/workspace",
    });

    const result = await runner.run(REQUEST);

    expect(result).toMatchObject({
      status: "proposed",
      rawTextLength: expect.any(Number),
      latencyMs: 33,
      parsed: {
        operatorId: "agent:codex",
        operatorKind: "agent",
      },
    });
    expect(processRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "gemini",
        cwd: "/tmp",
      })
    );
    const stdin = processRunner.mock.calls[0]?.[0]?.stdin as string;
    expect(stdin).toContain('"kind":"select_operator"');
    expect(stdin).toContain('"providerId":"orca/google-gemini"');
    expect(stdin).toContain("Return exactly one JSON object and no other text.");
  });

  it("accepts oauth/local credential readiness without requiring GOOGLE_API_KEY", async () => {
    const processRunner = vi.fn().mockResolvedValue({
      stdout: envelope({
        operatorId: "agent:codex",
        operatorKind: "agent",
        reason: "best match",
        requiredCapabilities: ["implementation"],
        alternativesConsidered: ["human"],
        confidence: 0.8,
        requiresUserApproval: false,
      }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      latencyMs: 6,
    });
    const runner = createGeminiOneShotRunner({
      adapter: makeAdapter({
        checkAuth: async () => ({
          name: "authenticated",
          ok: true,
          authStatus: "ready",
          command: "gemini auth",
          detail: "configuration detected; not smoke-tested (oauth)",
        }),
      }),
      processRunner,
    });

    const result = await runner.run(REQUEST);

    expect(result.status).toBe("proposed");
    expect(processRunner).toHaveBeenCalledTimes(1);
  });

  it("maps invalid output to one_shot_parse_failed", async () => {
    const processRunner = vi.fn().mockResolvedValue({
      stdout: "not json",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      latencyMs: 8,
    });
    const runner = createGeminiOneShotRunner({
      adapter: makeAdapter(),
      processRunner,
    });

    const result = await runner.run(REQUEST);

    expect(result).toEqual({
      status: "failed",
      failureReason: "one_shot_parse_failed",
      failureMessage: "no proposal envelope found",
      rawTextLength: "not json".length,
      latencyMs: 8,
    });
  });

  it("maps rate-limit output to one_shot_rate_limited", async () => {
    const processRunner = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "429 quota exceeded",
      exitCode: 1,
      timedOut: false,
      latencyMs: 5,
    });
    const runner = createGeminiOneShotRunner({
      adapter: makeAdapter(),
      processRunner,
    });

    const result = await runner.run(REQUEST);

    expect(result).toEqual({
      status: "failed",
      failureReason: "one_shot_rate_limited",
      failureMessage: "gemini reported rate or quota limits",
      rawTextLength: 0,
      latencyMs: 5,
    });
  });

  it("maps missing auth to one_shot_unavailable without running process", async () => {
    const processRunner = vi.fn();
    const runner = createGeminiOneShotRunner({
      adapter: makeAdapter({}, "needs_auth"),
      processRunner,
    });

    const result = await runner.run(REQUEST);

    expect(result).toEqual({
      status: "failed",
      failureReason: "one_shot_unavailable",
      failureMessage: "gemini adapter is not ready",
      rawTextLength: null,
      latencyMs: 0,
    });
    expect(processRunner).not.toHaveBeenCalled();
  });

  it("maps strategy mismatch to one_shot_unavailable", async () => {
    const runner = createGeminiOneShotRunner({
      adapter: makeAdapter({ id: "codex" }),
      processRunner: vi.fn(),
    });

    const result = await runner.run(REQUEST);

    expect(result).toEqual({
      status: "failed",
      failureReason: "one_shot_unavailable",
      failureMessage: "gemini adapter strategy unavailable",
      rawTextLength: null,
      latencyMs: 0,
    });
  });

  it("does not return raw stdout or stderr in failure results", async () => {
    const processRunner = vi.fn().mockResolvedValue({
      stdout: "token=abcd1234",
      stderr: "rate limit",
      exitCode: 1,
      timedOut: false,
      latencyMs: 7,
    });
    const runner = createGeminiOneShotRunner({
      adapter: makeAdapter(),
      processRunner,
    });

    const result = await runner.run(REQUEST);

    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("token=abcd1234");
    expect(JSON.stringify(result)).not.toContain("rate limit");
  });
});
