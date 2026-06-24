import { describe, expect, it, beforeEach } from "vitest";
import { SessionCostAccumulator } from "./accumulator.js";

let acc: SessionCostAccumulator;
beforeEach(() => { acc = new SessionCostAccumulator(); });

describe("SessionCostAccumulator", () => {
  it("sums token rows per session and drains them", () => {
    acc.ingest([{ sessionId: "s1", tokensIn: 100, tokensOut: 20, model: "claude-opus-4-8" }]);
    acc.ingest([{ sessionId: "s1", tokensIn: 50, tokensOut: 10 }]);
    acc.ingest([{ sessionId: "s2", tokensIn: 5, tokensOut: 5, model: "gpt-5" }]);
    const d1 = acc.drain("s1");
    expect(d1).toEqual({ tokensIn: 150, tokensOut: 30, model: "claude-opus-4-8" });
    expect(acc.drain("s1")).toBeNull(); // cleared
    expect(acc.drain("s2")?.tokensIn).toBe(5);
  });
  it("returns null draining an unknown session", () => {
    expect(acc.drain("nope")).toBeNull();
  });
});
