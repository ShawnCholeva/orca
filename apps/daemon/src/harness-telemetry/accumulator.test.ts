import { describe, expect, it, beforeEach } from "vitest";
import { SessionCostAccumulator } from "./accumulator.js";

let acc: SessionCostAccumulator;
beforeEach(() => { acc = new SessionCostAccumulator(); });

describe("SessionCostAccumulator", () => {
  it("sums tokens + cache + usd + duration per session and drains them", () => {
    acc.ingest([
      {
        sessionId: "s1",
        tokensIn: 100,
        tokensOut: 20,
        cacheReadTokens: 1000,
        cacheCreationTokens: 200,
        usd: 0.01,
        durationMs: 500,
        model: "claude-opus-4-8",
      },
    ]);
    acc.ingest([
      {
        sessionId: "s1",
        tokensIn: 50,
        tokensOut: 10,
        cacheReadTokens: 500,
        cacheCreationTokens: 100,
        usd: 0.02,
        durationMs: 300,
      },
    ]);
    const d1 = acc.drain("s1");
    expect(d1).toEqual({
      tokensIn: 150,
      tokensOut: 30,
      cacheReadTokens: 1500,
      cacheCreationTokens: 300,
      usd: 0.03,
      durationMs: 800,
      model: "claude-opus-4-8",
    });
    expect(acc.drain("s1")).toBeNull(); // cleared
  });

  it("a Codex-only session drains usd=null and durationMs=null", () => {
    acc.ingest([
      {
        sessionId: "cx",
        tokensIn: 12426,
        tokensOut: 6,
        cacheReadTokens: 10624,
        cacheCreationTokens: 0,
        usd: null,
        durationMs: null,
        model: "gpt-5.5",
      },
    ]);
    const d = acc.drain("cx");
    expect(d).toEqual({
      tokensIn: 12426,
      tokensOut: 6,
      cacheReadTokens: 10624,
      cacheCreationTokens: 0,
      usd: null,
      durationMs: null,
      model: "gpt-5.5",
    });
  });

  it("returns null draining an unknown session", () => {
    expect(acc.drain("nope")).toBeNull();
  });
});
