type Row = { sessionId: string; tokensIn: number; tokensOut: number; model?: string };
type Acc = { tokensIn: number; tokensOut: number; model?: string };

// In-memory per-session token accumulator. OTEL metrics are delta-temporality
// streams; we sum deltas until a transition boundary drains the session total.
export class SessionCostAccumulator {
  private readonly bySession = new Map<string, Acc>();
  ingest(rows: Row[]): void {
    for (const r of rows) {
      const cur = this.bySession.get(r.sessionId) ?? { tokensIn: 0, tokensOut: 0 };
      cur.tokensIn += r.tokensIn;
      cur.tokensOut += r.tokensOut;
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
