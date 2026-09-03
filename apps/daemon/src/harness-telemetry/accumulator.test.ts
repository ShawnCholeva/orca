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

describe("SessionCostAccumulator eviction", () => {
  const row = (sessionId: string) => ({ sessionId, tokensIn: 1, tokensOut: 1 });

  it("bounds the map instead of growing for the life of the process", () => {
    const acc = new SessionCostAccumulator();
    // Only step_complete/mark_done drain, so every gate surrogate, refute turn
    // and crashed step used to leave its entry behind forever.
    for (let i = 0; i < 1500; i++) acc.ingest([row(`sess-${i}`)]);

    expect(acc.peek("sess-0")).toBeNull(); // oldest evicted
    expect(acc.peek("sess-1499")).not.toBeNull(); // newest kept
  });

  it("evicts the least recently fed session, not the earliest seen", () => {
    const acc = new SessionCostAccumulator();
    acc.ingest([row("long-lived")]);
    for (let i = 0; i < 1200; i++) {
      acc.ingest([row(`sess-${i}`)]);
      // A session still receiving OTLP rows must survive the sweep — evicting
      // the busiest session would be worse than not evicting at all.
      acc.ingest([row("long-lived")]);
    }
    expect(acc.peek("long-lived")).not.toBeNull();
  });

  it("keeps summing across ingests for a session that is never evicted", () => {
    const acc = new SessionCostAccumulator();
    acc.ingest([{ sessionId: "s", tokensIn: 10, tokensOut: 5, usd: 0.25 }]);
    acc.ingest([{ sessionId: "s", tokensIn: 3, tokensOut: 2, usd: 0.5 }]);
    const drained = acc.drain("s");
    expect(drained).toMatchObject({ tokensIn: 13, tokensOut: 7, usd: 0.75 });
  });
});
