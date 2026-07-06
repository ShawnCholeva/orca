import { describe, expect, it } from "vitest";
import { labelForFailure } from "./failure-labels.js";

describe("labelForFailure", () => {
  it("maps a known code to a plain sentence (no jargon)", () => {
    const s = labelForFailure("evaluation_failed");
    expect(s).toMatch(/checkable result|without producing/i);
    expect(s).not.toMatch(/oracle|sensor|verdict/i);
  });
  it("falls back readably for an unknown code", () => {
    expect(labelForFailure("some_new_code")).toMatch(/some new code|unclassified/i);
  });
});
