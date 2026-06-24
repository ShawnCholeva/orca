// The parser always emits the cache/cost/duration fields, but ingest tolerates
// their absence (cache → 0, usd/durationMs → null) so older callers stay valid.
type Row = {
  sessionId: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  usd?: number | null;
  durationMs?: number | null;
  model?: string;
};
type Acc = {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  usd: number | null; // authoritative provider cost; null when no row carried one (Codex)
  durationMs: number | null; // total provider-reported model time; null when none carried one
  model?: string;
};

// In-memory per-session token accumulator. OTEL signals arrive incrementally;
// we sum per-session totals until a transition boundary drains the session.
// usd/durationMs stay null until a row carries an authoritative value, then sum.
export class SessionCostAccumulator {
  private readonly bySession = new Map<string, Acc>();
  ingest(rows: Row[]): void {
    for (const r of rows) {
      const cur =
        this.bySession.get(r.sessionId) ?? {
          tokensIn: 0,
          tokensOut: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          usd: null,
          durationMs: null,
        };
      cur.tokensIn += r.tokensIn;
      cur.tokensOut += r.tokensOut;
      cur.cacheReadTokens += r.cacheReadTokens ?? 0;
      cur.cacheCreationTokens += r.cacheCreationTokens ?? 0;
      if (r.usd != null) cur.usd = (cur.usd ?? 0) + r.usd;
      if (r.durationMs != null) cur.durationMs = (cur.durationMs ?? 0) + r.durationMs;
      if (r.model && !cur.model) cur.model = r.model;
      this.bySession.set(r.sessionId, cur);
    }
  }
  drain(sessionId: string): Acc | null {
    const cur = this.bySession.get(sessionId);
    if (!cur) return null;
    this.bySession.delete(sessionId);
    return cur;
  }
  peek(sessionId: string): Acc | null {
    return this.bySession.get(sessionId) ?? null;
  }
}
