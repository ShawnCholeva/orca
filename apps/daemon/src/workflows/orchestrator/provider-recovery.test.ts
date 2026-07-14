import { describe, expect, it } from "vitest";
import type { OperatorDescriptor, StepAgentChoice } from "@orca/contracts";
import { ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES } from "@orca/contracts";
import { buildProviderRecoveryChoices, composeProviderSwitchPrompt } from "./provider-recovery.js";

// Helpers to build minimal OperatorDescriptors for agents
function agent(
  adapterId: string,
  ready: boolean,
  notReadyReason?: string
): OperatorDescriptor {
  return {
    id: `agent:${adapterId}`,
    kind: "agent",
    displayName: adapterId.charAt(0).toUpperCase() + adapterId.slice(1),
    capabilities: [],
    ready,
    notReadyReason: ready ? undefined : notReadyReason,
    supportsRepoEditing: true,
    supportsTerminal: true,
  };
}

const DEFAULT_PREFERENCES: StepAgentChoice[] = [
  { adapterId: "claude-code", modelId: "claude-sonnet-4-6" },
  { adapterId: "codex", modelId: "gpt-5.4-mini" },
];

describe("buildProviderRecoveryChoices", () => {
  it("returns connected non-current agents with step-configured models", async () => {
    const choices = buildProviderRecoveryChoices({
      currentAdapterId: "claude-code",
      connectedAdapterIds: ["claude-code", "codex", "antigravity"],
      stepPreferences: DEFAULT_PREFERENCES,
      operators: [
        agent("claude-code", true),
        agent("codex", true),
        agent("antigravity", false, "authentication required"),
      ],
      supportsModel: (adapterId, modelId) =>
        adapterId === "codex" && modelId === "gpt-5.4-mini",
    });

    expect(choices).toEqual([
      {
        adapterId: "codex",
        displayName: "Codex",
        modelId: "gpt-5.4-mini",
        enabled: true,
        reason: null,
      },
      {
        adapterId: "antigravity",
        displayName: "Antigravity",
        modelId: null,
        enabled: false,
        reason: "not configured for this step",
      },
    ]);
  });

  it("returns empty array when only the current provider is connected", () => {
    const choices = buildProviderRecoveryChoices({
      currentAdapterId: "claude-code",
      connectedAdapterIds: ["claude-code"],
      stepPreferences: DEFAULT_PREFERENCES,
      operators: [agent("claude-code", true)],
      supportsModel: () => false,
    });

    expect(choices).toEqual([]);
  });

  it("disables a configured but not-ready provider with its readiness reason", () => {
    const choices = buildProviderRecoveryChoices({
      currentAdapterId: "claude-code",
      connectedAdapterIds: ["claude-code", "codex"],
      stepPreferences: DEFAULT_PREFERENCES,
      operators: [agent("claude-code", true), agent("codex", false, "needs_auth")],
      supportsModel: (adapterId, modelId) =>
        adapterId === "codex" && modelId === "gpt-5.4-mini",
    });

    expect(choices).toEqual([
      {
        adapterId: "codex",
        displayName: "Codex",
        modelId: "gpt-5.4-mini",
        enabled: false,
        reason: "needs_auth",
      },
    ]);
  });

  it("disables a provider whose configured model is not supported", () => {
    const choices = buildProviderRecoveryChoices({
      currentAdapterId: "claude-code",
      connectedAdapterIds: ["claude-code", "codex"],
      stepPreferences: DEFAULT_PREFERENCES,
      operators: [agent("claude-code", true), agent("codex", true)],
      supportsModel: () => false,
    });

    expect(choices).toEqual([
      {
        adapterId: "codex",
        displayName: "Codex",
        modelId: "gpt-5.4-mini",
        enabled: false,
        reason: "configured model is not supported",
      },
    ]);
  });

  it("excludes disconnected agents even if they appear in operators", () => {
    const choices = buildProviderRecoveryChoices({
      currentAdapterId: "claude-code",
      connectedAdapterIds: ["claude-code"],
      stepPreferences: DEFAULT_PREFERENCES,
      operators: [agent("claude-code", true), agent("codex", true)],
      supportsModel: () => true,
    });

    expect(choices).toEqual([]);
  });

  it("uses 'provider unavailable' as fallback when not-ready reason is absent", () => {
    const choices = buildProviderRecoveryChoices({
      currentAdapterId: "claude-code",
      connectedAdapterIds: ["claude-code", "codex"],
      stepPreferences: DEFAULT_PREFERENCES,
      operators: [
        agent("claude-code", true),
        // no notReadyReason
        { ...agent("codex", false), notReadyReason: undefined },
      ],
      supportsModel: (adapterId, modelId) =>
        adapterId === "codex" && modelId === "gpt-5.4-mini",
    });

    expect(choices).toEqual([
      {
        adapterId: "codex",
        displayName: "Codex",
        modelId: "gpt-5.4-mini",
        enabled: false,
        reason: "provider unavailable",
      },
    ]);
  });
});

describe("composeProviderSwitchPrompt", () => {
  const BASE_INPUT = {
    goalTitle: "Build the feature",
    goalIntent: "Implement the whole thing end-to-end.",
    stepInstructions: "Write the code for the next step.",
    outputSchema: [] as [],
    priorStepArtifacts: [] as [],
  };

  it("contains the original objective", () => {
    const prompt = composeProviderSwitchPrompt({
      agentPromptInput: BASE_INPUT,
      interruptedTail: "some tail content",
    });

    expect(prompt).toContain("Build the feature");
    expect(prompt).toContain("Write the code for the next step.");
  });

  it("includes a bounded interrupted-session handoff section", () => {
    const prompt = composeProviderSwitchPrompt({
      agentPromptInput: BASE_INPUT,
      interruptedTail: "the interrupted tail goes here",
    });

    expect(prompt).toContain("# Interrupted session handoff");
    expect(prompt).toContain("the interrupted tail goes here");
  });

  it("never exceeds the byte cap for a large tail", () => {
    const hugeTail = "x".repeat(ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES * 2);
    const prompt = composeProviderSwitchPrompt({
      agentPromptInput: BASE_INPUT,
      interruptedTail: hugeTail,
    });

    // The tail section must be capped
    const tailSection = prompt.slice(prompt.indexOf("# Interrupted session handoff"));
    expect(Buffer.byteLength(tailSection, "utf8")).toBeLessThanOrEqual(
      ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES + 512 // header overhead
    );
    // And the tail itself must be truncated
    expect(prompt).not.toContain(hugeTail);
  });

  it("handles an empty tail gracefully", () => {
    const prompt = composeProviderSwitchPrompt({
      agentPromptInput: BASE_INPUT,
      interruptedTail: "",
    });

    expect(prompt).toContain("# Interrupted session handoff");
  });
});
