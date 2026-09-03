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

// Only `step_complete` and `mark_done` drain (buildTelemetry). Every session
// that never reaches one — gate surrogates, refute turns, shadow sessions and
// crashed steps — leaves its entry behind for the life of the process, so the
// map grew without bound.
//
// The cap evicts on INGEST rather than on session termination. Terminating is
// the semantically obvious hook and is the wrong one: a crashed step's
// step_complete is emitted from the completion path AFTER the session is marked
// failed, so evicting there would race the drain and destroy exactly the cost
// data a crashed run makes most interesting. Eviction by age touches nothing a
// live turn is still filling.
//
// Note this bounds MEMORY only. An evicted entry's cost was already going to be
// discarded — nothing drains those sessions — so the cap neither saves nor
// loses cost data. Capturing it is a separate change at the emission boundary.
const MAX_TRACKED_SESSIONS = 1000;

// In-memory per-session token accumulator. OTEL signals arrive incrementally;
// we sum per-session totals until a transition boundary drains the session.
// usd/durationMs stay null until a row carries an authoritative value, then sum.
export class SessionCostAccumulator {
  private readonly bySession = new Map<string, Acc>();

  /**
   * Drop the oldest entries once past the cap. Map iterates in insertion order,
   * and an entry is re-inserted on every ingest, so "oldest" is genuinely the
   * least recently fed session rather than the earliest one seen.
   */
  private evictOldest(): void {
    if (this.bySession.size <= MAX_TRACKED_SESSIONS) return;
    let dropped = 0;
    for (const key of this.bySession.keys()) {
      if (this.bySession.size <= MAX_TRACKED_SESSIONS) break;
      this.bySession.delete(key);
      dropped += 1;
    }
    console.warn(
      `[harness-telemetry] cost accumulator evicted ${dropped} undrained session(s) past the ${MAX_TRACKED_SESSIONS} cap; their tokens were never attributed to a transition`
    );
  }

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
      // Delete before set so a re-fed session moves to the back of the
      // insertion order — otherwise eviction would drop the busiest sessions.
      this.bySession.delete(r.sessionId);
      this.bySession.set(r.sessionId, cur);
    }
    this.evictOldest();
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
