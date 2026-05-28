import { describe, expect, it } from "vitest";
import {
  augmentInstructionsWithOutputConvention,
  parseOrcaOutputBlock,
} from "./orca-output.js";

describe("augmentInstructionsWithOutputConvention", () => {
  it("appends the orca-output convention exactly once", () => {
    const out = augmentInstructionsWithOutputConvention("Do the thing.");
    expect(out).toMatch(/```orca-output/);
    expect(out.indexOf("```orca-output")).toBe(out.lastIndexOf("```orca-output"));
  });
  it("is idempotent if convention is already present", () => {
    const first = augmentInstructionsWithOutputConvention("x");
    const second = augmentInstructionsWithOutputConvention(first);
    expect(second).toBe(first);
  });
});

describe("parseOrcaOutputBlock", () => {
  it("extracts the LAST orca-output block as JSON", () => {
    const text = [
      "noise",
      "```orca-output",
      '{"a":1}',
      "```",
      "more noise",
      "```orca-output",
      '{"a":2}',
      "```",
      "trailing",
    ].join("\n");
    expect(parseOrcaOutputBlock(text)).toEqual({ a: 2 });
  });
  it("returns null when no block is present", () => {
    expect(parseOrcaOutputBlock("nothing here")).toBeNull();
  });
  it("returns null when the block is not valid JSON", () => {
    expect(parseOrcaOutputBlock("```orca-output\nnot json\n```")).toBeNull();
  });
});
