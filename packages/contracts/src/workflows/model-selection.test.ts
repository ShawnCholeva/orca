import { describe, expect, it } from "vitest";
import { EffortLevel, NodeModelSelection, StepAgentChoice } from "./index.js";

describe("EffortLevel", () => {
  it("accepts the five levels the CLI exposes", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      expect(EffortLevel.parse(level)).toBe(level);
    }
  });

  it("rejects ultracode, which is a UI combination and not a level", () => {
    expect(() => EffortLevel.parse("ultracode")).toThrow();
  });
});

describe("StepAgentChoice legacy transform", () => {
  it("reads a legacy pair as a pinned choice with a default variant", () => {
    const parsed = StepAgentChoice.parse({ adapterId: "claude-code", modelId: "claude-haiku-4-5" });
    expect(parsed).toEqual({
      kind: "pinned",
      adapterId: "claude-code",
      modelId: "claude-haiku-4-5",
      contextVariant: "default",
      effort: null,
    });
  });

  it("preserves providerId when a legacy pair carries one", () => {
    const parsed = StepAgentChoice.parse({
      adapterId: "codex", modelId: "gpt-5.5", providerId: "orca/openai",
    });
    expect(parsed).toMatchObject({ kind: "pinned", providerId: "orca/openai" });
  });

  it("accepts an explicit pinned choice with a variant and effort", () => {
    const parsed = StepAgentChoice.parse({
      kind: "pinned", adapterId: "claude-code", modelId: "claude-opus-5",
      contextVariant: "1m", effort: "xhigh",
    });
    expect(parsed).toMatchObject({ contextVariant: "1m", effort: "xhigh" });
  });

  it("accepts a profile reference", () => {
    expect(StepAgentChoice.parse({ kind: "profile", ref: "deep-reasoning" }))
      .toEqual({ kind: "profile", ref: "deep-reasoning" });
  });

  it("rejects a profile reference with an empty ref", () => {
    expect(() => StepAgentChoice.parse({ kind: "profile", ref: "" })).toThrow();
  });
});

describe("NodeModelSelection", () => {
  it("rejects an unknown kind", () => {
    expect(() => NodeModelSelection.parse({ kind: "auto" })).toThrow();
  });
});
