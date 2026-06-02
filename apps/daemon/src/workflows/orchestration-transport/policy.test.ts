import { describe, expect, it } from "vitest";

import { resolveTransportPlan } from "./policy.js";

describe("orchestration transport policy", () => {
  it("uses one-shot before hidden interactive and human review for OpenAI", () => {
    expect(resolveTransportPlan("orca/openai")).toEqual([
      "one_shot",
      "hidden_interactive",
      "human_review",
    ]);
  });

  it("skips one-shot for Claude in v1", () => {
    expect(resolveTransportPlan("orca/anthropic")).toEqual([
      "hidden_interactive",
      "human_review",
    ]);
  });
});
