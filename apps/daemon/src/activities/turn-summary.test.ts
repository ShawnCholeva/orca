import { describe, expect, it } from "vitest";
import { deriveTurnSummary } from "./turn-summary";

describe("deriveTurnSummary", () => {
  it("skips meta preamble and picks the substantive line", () => {
    const text = [
      "I now have a complete picture. Here's my analysis and plan.",
      "The webhook double-charges because the idempotency key is regenerated per retry.",
      "Details below.",
    ].join("\n");
    expect(deriveTurnSummary(text)).toBe(
      "The webhook double-charges because the idempotency key is regenerated per retry.",
    );
  });

  it("strips conversational lead-ins but keeps the substance on that line", () => {
    expect(deriveTurnSummary("Okay, so the tests pass now.")).toBe("the tests pass now.");
  });

  it("keeps a substantive first line untouched", () => {
    expect(deriveTurnSummary("Found the double-charge bug in verifier.ts.")).toBe(
      "Found the double-charge bug in verifier.ts.",
    );
  });

  it("strips markdown markers", () => {
    expect(deriveTurnSummary("## Result\n- did the thing")).toBe("Result");
  });

  it("falls back to the first line when everything is preamble", () => {
    expect(deriveTurnSummary("Let me start.\nI'll dig in.")).toBe("Let me start.");
  });

  it("caps length at 280 characters", () => {
    expect(deriveTurnSummary("x".repeat(400))).toHaveLength(280);
  });
});
