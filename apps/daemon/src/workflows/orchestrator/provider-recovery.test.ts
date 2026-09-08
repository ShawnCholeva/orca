import { describe, expect, it } from "vitest";
import type { AdapterId, CatalogModel, OperatorDescriptor, StepAgentChoice } from "@orca/contracts";
import { ORCHESTRATION_WORKER_OUTPUT_TAIL_MAX_BYTES } from "@orca/contracts";
import { SEED_PROFILES } from "../../adapters/model-catalog/profiles.js";
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

const CODEX_MINI: CatalogModel = {
  id: "gpt-5.4-mini", family: "gpt-5-mini", displayName: "GPT-5.4 mini", contextWindow: 400_000,
  supports1mSuffix: false, pricingTier: null, advisorRank: 1,
  supportedEfforts: [], defaultEffort: null,
};
/** Only codex ships the step's configured model; every other adapter is empty. */
const catalogFor = async (adapterId: AdapterId): Promise<CatalogModel[]> =>
  adapterId === "codex" ? [CODEX_MINI] : [];
const emptyCatalog = async (): Promise<CatalogModel[]> => [];
const profiles = SEED_PROFILES;

const DEFAULT_PREFERENCES: StepAgentChoice[] = [
  { kind: "pinned", adapterId: "claude-code", modelId: "claude-sonnet-4-6", contextVariant: "default", effort: null },
  { kind: "pinned", adapterId: "codex", modelId: "gpt-5.4-mini", contextVariant: "default", effort: null },
];

describe("buildProviderRecoveryChoices", () => {
  it("returns connected non-current agents with step-configured models", async () => {
    const choices = await buildProviderRecoveryChoices({
      currentAdapterId: "claude-code",
      connectedAdapterIds: ["claude-code", "codex", "antigravity"],
      stepPreferences: DEFAULT_PREFERENCES,
      operators: [
        agent("claude-code", true),
        agent("codex", true),
        agent("antigravity", false, "authentication required"),
      ],
      catalogFor,
      profiles,
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

  it("returns empty array when only the current provider is connected", async () => {
    const choices = await buildProviderRecoveryChoices({
      currentAdapterId: "claude-code",
      connectedAdapterIds: ["claude-code"],
      stepPreferences: DEFAULT_PREFERENCES,
      operators: [agent("claude-code", true)],
      catalogFor: emptyCatalog,
      profiles,
    });

    expect(choices).toEqual([]);
  });

  it("disables a configured but not-ready provider with its readiness reason", async () => {
    const choices = await buildProviderRecoveryChoices({
      currentAdapterId: "claude-code",
      connectedAdapterIds: ["claude-code", "codex"],
      stepPreferences: DEFAULT_PREFERENCES,
      operators: [agent("claude-code", true), agent("codex", false, "needs_auth")],
      catalogFor,
      profiles,
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

  it("disables a provider whose configured model is not supported", async () => {
    const choices = await buildProviderRecoveryChoices({
      currentAdapterId: "claude-code",
      connectedAdapterIds: ["claude-code", "codex"],
      stepPreferences: DEFAULT_PREFERENCES,
      operators: [agent("claude-code", true), agent("codex", true)],
      catalogFor: emptyCatalog,
      profiles,
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

  it("excludes disconnected agents even if they appear in operators", async () => {
    const choices = await buildProviderRecoveryChoices({
      currentAdapterId: "claude-code",
      connectedAdapterIds: ["claude-code"],
      stepPreferences: DEFAULT_PREFERENCES,
      operators: [agent("claude-code", true), agent("codex", true)],
      catalogFor,
      profiles,
    });

    expect(choices).toEqual([]);
  });

  it("uses 'provider unavailable' as fallback when not-ready reason is absent", async () => {
    const choices = await buildProviderRecoveryChoices({
      currentAdapterId: "claude-code",
      connectedAdapterIds: ["claude-code", "codex"],
      stepPreferences: DEFAULT_PREFERENCES,
      operators: [
        agent("claude-code", true),
        // no notReadyReason
        { ...agent("codex", false), notReadyReason: undefined },
      ],
      catalogFor,
      profiles,
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

  it("resolves a profile-arm preference against the candidate adapter's own catalog", async () => {
    const choices = await buildProviderRecoveryChoices({
      currentAdapterId: "claude-code",
      connectedAdapterIds: ["claude-code", "codex"],
      // A profile names no adapter, so every candidate gets to satisfy it.
      stepPreferences: [{ kind: "profile", ref: "light" }],
      operators: [agent("claude-code", true), agent("codex", true)],
      catalogFor,
      profiles,
    });

    expect(choices).toEqual([
      {
        adapterId: "codex",
        displayName: "Codex",
        modelId: "gpt-5.4-mini",
        enabled: true,
        reason: null,
      },
    ]);
  });

  it("disables an adapter whose catalog satisfies no model in the profile", async () => {
    const choices = await buildProviderRecoveryChoices({
      currentAdapterId: "claude-code",
      connectedAdapterIds: ["claude-code", "codex"],
      // "reasoning" needs minStrength 4; the codex entry ranks 1.
      stepPreferences: [{ kind: "profile", ref: "reasoning" }],
      operators: [agent("claude-code", true), agent("codex", true)],
      catalogFor,
      profiles,
    });

    expect(choices).toEqual([
      {
        adapterId: "codex",
        displayName: "Codex",
        modelId: null,
        enabled: false,
        reason: "no model here matches the configured profile",
      },
    ]);
  });

  it("prefers a pinned arm over the profile arm for the adapter it names", async () => {
    const choices = await buildProviderRecoveryChoices({
      currentAdapterId: "claude-code",
      connectedAdapterIds: ["claude-code", "codex"],
      stepPreferences: [
        { kind: "profile", ref: "reasoning" },
        { kind: "pinned", adapterId: "codex", modelId: "gpt-5.4-mini", contextVariant: "default", effort: null },
      ],
      operators: [agent("claude-code", true), agent("codex", true)],
      catalogFor,
      profiles,
    });

    // The unsatisfiable profile does not disable an adapter the step pinned.
    expect(choices).toEqual([
      {
        adapterId: "codex",
        displayName: "Codex",
        modelId: "gpt-5.4-mini",
        enabled: true,
        reason: null,
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
