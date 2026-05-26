import type { OrchestrationRequest } from "@orca/contracts";
import { describe, expect, it } from "vitest";

import {
  listHiddenWorkerDrivers,
  resolveHiddenWorkerDriver,
} from "./registry.js";

const REQUEST: OrchestrationRequest = {
  kind: "select_operator",
  goalId: "goal-1",
  workflowRunId: "run-1",
  stepRunId: "step-1",
  providerId: "orca/openai",
  modelId: "gpt-5",
  payload: {
    operators: [{ operatorId: "agent:codex", operatorKind: "agent" }],
  },
};

function proposalEnvelope(kind: string): string {
  return JSON.stringify({
    orcaProposalVersion: 1,
    kind,
    payload: {
      operatorId: "agent:codex",
      operatorKind: "agent",
      reason: "best fit",
      requiredCapabilities: ["repo_edit"],
      alternativesConsidered: [],
      confidence: 0.72,
      requiresUserApproval: false,
    },
  });
}

const SUCCESS_TRANSCRIPT: Record<OrchestrationRequest["providerId"], string> = {
  "orca/anthropic": [
    "Claude Code ready",
    "claude> waiting for input",
    "<ORCA_PROPOSAL>",
    proposalEnvelope("select_operator"),
    "</ORCA_PROPOSAL>",
  ].join("\n"),
  "orca/openai": [
    "Codex interactive ready",
    "codex> waiting for input",
    "<ORCA_PROPOSAL>",
    proposalEnvelope("select_operator"),
    "</ORCA_PROPOSAL>",
  ].join("\n"),
  "orca/google-gemini": [
    "Gemini interactive ready",
    "gemini> waiting for input",
    "<ORCA_PROPOSAL>",
    proposalEnvelope("select_operator"),
    "</ORCA_PROPOSAL>",
  ].join("\n"),
};

describe("hidden-worker driver registry", () => {
  it("resolves provider drivers with expected adapter mapping", () => {
    expect(resolveHiddenWorkerDriver("orca/anthropic").adapterId).toBe("claude-code");
    expect(resolveHiddenWorkerDriver("orca/openai").adapterId).toBe("codex");
    expect(resolveHiddenWorkerDriver("orca/google-gemini").adapterId).toBe("gemini-cli");
  });

  it("lists all provider drivers exactly once", () => {
    const drivers = listHiddenWorkerDrivers();
    expect(drivers).toHaveLength(3);
    expect(new Set(drivers.map((driver) => driver.providerId))).toEqual(
      new Set(["orca/anthropic", "orca/openai", "orca/google-gemini"])
    );
  });
});

describe("hidden-worker transcript fixtures", () => {
  for (const providerId of [
    "orca/anthropic",
    "orca/openai",
    "orca/google-gemini",
  ] as const) {
    it(`${providerId} detects ready, boundaries, auth, permission, malformed, hung, and rate-limit`, () => {
      const driver = resolveHiddenWorkerDriver(providerId);
      const readyTranscript = SUCCESS_TRANSCRIPT[providerId];
      const proposal = driver.extractProposalOutput(readyTranscript);
      const requestInput = driver.buildRequestInput({ ...REQUEST, providerId });
      const hooks = driver.buildHookConfigInput({
        workerId: "worker-1",
        attemptId: "attempt-1",
      });

      expect(driver.detectReady(readyTranscript)).toBe(true);
      expect(proposal).toContain('"orcaProposalVersion":1');
      expect(requestInput).toContain("ORCA_WORKER_REQUEST_V1");
      expect(requestInput).toContain("<ORCA_PROPOSAL>");
      expect(hooks).toMatchObject({
        providerId,
        adapterId: driver.adapterId,
        workerId: "worker-1",
        attemptId: "attempt-1",
        configScope: "worker",
      });

      const authTranscript = "login required - authenticate before continuing";
      expect(driver.detectAuthLost(authTranscript)).toBe(true);

      const permissionTranscript = "Permission request: allow tool execution?";
      expect(driver.detectPermissionPrompt(permissionTranscript)).toBe(true);

      const malformedTranscript = [
        "ready",
        "<ORCA_PROPOSAL>",
        "{not-json}",
        "</ORCA_PROPOSAL>",
      ].join("\n");
      expect(driver.extractProposalOutput(malformedTranscript)).toBe("{not-json}");

      const hungTranscript = "worker heartbeat... still running...";
      expect(driver.extractProposalOutput(hungTranscript)).toBeNull();

      const limitedTranscript = "429 rate limit exceeded; quota reached";
      expect(driver.detectRateLimited(limitedTranscript)).toBe(true);

      const summary = driver.summarizeDebug("token=sk-abcdef0123456789 this is safe");
      expect(summary).not.toContain("sk-abcdef0123456789");
      expect(summary.length).toBeLessThanOrEqual(256);
    });
  }
});
