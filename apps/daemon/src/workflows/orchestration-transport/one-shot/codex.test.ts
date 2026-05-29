import type { OrchestrationRequest as OrchestrationRequestT } from "@orca/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AgentAdapter } from "../../../adapters/types.js";
import { createCodexOneShotRunner } from "./codex.js";

const REQUEST: OrchestrationRequestT = {
  kind: "select_operator",
  goalId: "goal-1",
  workflowRunId: "run-1",
  stepRunId: "step-1",
  providerId: "orca/openai",
  modelId: "gpt-5",
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
    id: "codex",
    title: "Codex",
    supportedExecutionModes: ["one_shot", "shadow_session"] as const,
    contextDelivery: { mode: "preview_only", maxBytes: 32768 },
    resolveSpawn: async () => ({
      command: "codex",
      args: [],
      env: { PATH: process.env["PATH"] ?? "" },
      cwd: "/tmp",
    }),
    probeAvailability: async () => ({ status: "available" }),
    checkInstalled: async () => ({ name: "installed", ok: true, command: "codex --version" }),
    checkAuth: async () => ({
      name: "authenticated",
      ok: authStatus === "ready",
      authStatus,
      command: "codex login status",
    }),
    repairFor: () => undefined,
    supportsModel: () => false,
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

describe("codex one-shot runner", () => {
  it("returns proposed when codex exits 0 with exactly one valid envelope", async () => {
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
    const runner = createCodexOneShotRunner({
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
        command: "codex",
        cwd: "/tmp",
      })
    );
    const stdin = processRunner.mock.calls[0]?.[0]?.stdin as string;
    expect(stdin).toContain('"kind":"select_operator"');
    expect(stdin).toContain('"providerId":"orca/openai"');
    expect(stdin).toContain("Return exactly one JSON object and no other text.");
  });

  it("maps invalid output to one_shot_parse_failed", async () => {
    const processRunner = vi.fn().mockResolvedValue({
      stdout: "not json",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      latencyMs: 8,
    });
    const runner = createCodexOneShotRunner({
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
      stderr: "429 rate limit exceeded",
      exitCode: 1,
      timedOut: false,
      latencyMs: 5,
    });
    const runner = createCodexOneShotRunner({
      adapter: makeAdapter(),
      processRunner,
    });

    const result = await runner.run(REQUEST);

    expect(result).toEqual({
      status: "failed",
      failureReason: "one_shot_rate_limited",
      failureMessage: "codex reported rate or quota limits",
      rawTextLength: 0,
      latencyMs: 5,
    });
  });

  it("maps missing auth to one_shot_unavailable without running process", async () => {
    const processRunner = vi.fn();
    const runner = createCodexOneShotRunner({
      adapter: makeAdapter({}, "needs_auth"),
      processRunner,
    });

    const result = await runner.run(REQUEST);

    expect(result).toEqual({
      status: "failed",
      failureReason: "one_shot_unavailable",
      failureMessage: "codex adapter is not ready",
      rawTextLength: null,
      latencyMs: 0,
    });
    expect(processRunner).not.toHaveBeenCalled();
  });

  it("maps strategy mismatch to one_shot_unavailable", async () => {
    const runner = createCodexOneShotRunner({
      adapter: makeAdapter({ id: "gemini-cli" }),
      processRunner: vi.fn(),
    });

    const result = await runner.run(REQUEST);

    expect(result).toEqual({
      status: "failed",
      failureReason: "one_shot_unavailable",
      failureMessage: "codex adapter strategy unavailable",
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
    const runner = createCodexOneShotRunner({
      adapter: makeAdapter(),
      processRunner,
    });

    const result = await runner.run(REQUEST);

    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("token=abcd1234");
    expect(JSON.stringify(result)).not.toContain("rate limit");
  });
});
