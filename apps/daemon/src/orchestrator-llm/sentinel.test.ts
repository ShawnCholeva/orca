import { describe, it, expect } from "vitest";
import { extractActionBlock, SENTINEL_INSTRUCTION } from "./sentinel.js";

describe("extractActionBlock", () => {
  it("returns null when no closing fence yet", () => {
    expect(extractActionBlock("```orca:action\n{\"kind\":\"answer")).toBeNull();
  });

  it("extracts inner JSON between the orca:action fences", () => {
    const out = "chatter\n```orca:action\n{\"kind\":\"answer_user_directly\",\"body\":\"hi\"}\n```\nmore";
    expect(extractActionBlock(out)).toBe('{"kind":"answer_user_directly","body":"hi"}');
  });

  it("returns the LAST complete block when several appear", () => {
    const out =
      "```orca:action\n{\"a\":1}\n```\n```orca:action\n{\"b\":2}\n```\n";
    expect(extractActionBlock(out)).toBe('{"b":2}');
  });

  it("instruction string mentions the fence token", () => {
    expect(SENTINEL_INSTRUCTION).toContain("```orca:action");
  });
});
