// Pure, fail-safe parser for OTLP/JSON token telemetry emitted by shadow workers.
//
// Attribution key = the INJECTED resource attribute `orca.session.id` (NOT the
// CLI-native session.id / conversation.id). Shapes are the ones captured by the
// Task 3 spike (.superpowers/sdd/otel-spike-findings.md):
//   - Claude: LOG `api_request` (scope com.anthropic.claude_code.events). ONE
//     record carries tokens + cache + cost + duration + model in named numeric
//     fields. We read this log ONLY (the `claude_code.token.usage` metric is no
//     longer counted — a single source eliminates the metric-vs-log double-count).
//   - Codex: LOG `codex.sse_event` with kind `response.completed`; token fields
//     are STRING-typed and coerced via Number(). Codex carries a single
//     `cached_token_count` (→ cacheReadTokens; cacheCreationTokens=0) and emits
//     no cost (usd=null) and no per-event duration (durationMs=null).
//
// PII (user.email / account ids) is never read. Any missing field contributes
// nothing (cache defaults 0; usd/durationMs default null); a malformed top-level
// yields [].

export interface OtlpTokenRow {
  sessionId: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  usd: number | null; // authoritative provider cost (Claude cost_usd); null when none (Codex)
  durationMs: number | null; // provider-reported latency (Claude duration_ms); null when absent (Codex)
  model?: string;
}

function attrString(attributes: unknown, key: string): string | undefined {
  if (!Array.isArray(attributes)) return undefined;
  for (const a of attributes) {
    if (a && typeof a === "object" && (a as { key?: unknown }).key === key) {
      const v = (a as { value?: { stringValue?: unknown } }).value;
      if (v && typeof v.stringValue === "string") return v.stringValue;
    }
  }
  return undefined;
}

// Read a numeric attribute, tolerating OTLP `intValue` / `doubleValue` (number
// or numeric-string per the JSON encoding) and `stringValue`. Returns undefined
// when absent or non-finite.
function attrNumber(attributes: unknown, key: string): number | undefined {
  if (!Array.isArray(attributes)) return undefined;
  for (const a of attributes) {
    if (a && typeof a === "object" && (a as { key?: unknown }).key === key) {
      const v = (a as {
        value?: { intValue?: unknown; doubleValue?: unknown; stringValue?: unknown };
      }).value;
      if (!v || typeof v !== "object") return undefined;
      const raw =
        v.doubleValue ?? v.intValue ?? (typeof v.stringValue === "string" ? v.stringValue : undefined);
      if (raw === undefined) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

function sessionIdOf(resource: unknown): string | undefined {
  if (!resource || typeof resource !== "object") return undefined;
  return attrString((resource as { attributes?: unknown }).attributes, "orca.session.id");
}

function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}

function parseLogsRow(rl: unknown): OtlpTokenRow | undefined {
  if (!rl || typeof rl !== "object") return undefined;
  const sessionId = sessionIdOf((rl as { resource?: unknown }).resource);
  if (!sessionId) return undefined;

  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let usd: number | null = null;
  let durationMs: number | null = null;
  let model: string | undefined;
  let saw = false;

  for (const sl of asArray((rl as { scopeLogs?: unknown }).scopeLogs)) {
    for (const record of asArray((sl as { logRecords?: unknown }).logRecords)) {
      if (!record || typeof record !== "object") continue;
      const attrs = (record as { attributes?: unknown }).attributes;
      const eventName = attrString(attrs, "event.name");

      if (eventName === "api_request") {
        // Claude: one record carries tokens + cache + cost + duration + model.
        const inN = attrNumber(attrs, "input_tokens");
        const outN = attrNumber(attrs, "output_tokens");
        const cacheReadN = attrNumber(attrs, "cache_read_tokens");
        const cacheCreationN = attrNumber(attrs, "cache_creation_tokens");
        const costN = attrNumber(attrs, "cost_usd");
        const durationN = attrNumber(attrs, "duration_ms");
        if (inN !== undefined) tokensIn += inN;
        if (outN !== undefined) tokensOut += outN;
        if (cacheReadN !== undefined) cacheReadTokens += cacheReadN;
        if (cacheCreationN !== undefined) cacheCreationTokens += cacheCreationN;
        if (costN !== undefined) usd = (usd ?? 0) + costN;
        if (durationN !== undefined) durationMs = (durationMs ?? 0) + durationN;
        model ??= attrString(attrs, "model");
        saw = true;
        continue;
      }

      if (eventName === "codex.sse_event") {
        // Codex: STRING-typed token fields; cached_token_count → cacheReadTokens.
        if (attrString(attrs, "event.kind") !== "response.completed") continue;
        const inN = Number(attrString(attrs, "input_token_count"));
        const outN = Number(attrString(attrs, "output_token_count"));
        const cachedN = Number(attrString(attrs, "cached_token_count"));
        if (Number.isFinite(inN)) tokensIn += inN;
        if (Number.isFinite(outN)) tokensOut += outN;
        if (Number.isFinite(cachedN)) cacheReadTokens += cachedN;
        model ??= attrString(attrs, "model");
        saw = true;
      }
    }
  }

  if (!saw) return undefined;
  const row: OtlpTokenRow = {
    sessionId,
    tokensIn,
    tokensOut,
    cacheReadTokens,
    cacheCreationTokens,
    usd,
    durationMs,
  };
  if (model !== undefined) row.model = model;
  return row;
}

export function parseOtlpTokens(body: unknown): OtlpTokenRow[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];

  const rows: OtlpTokenRow[] = [];
  try {
    // Tokens for BOTH providers now come from logs (Claude api_request,
    // Codex sse_event). The Claude `claude_code.token.usage` metric is no
    // longer read — keeping a single source avoids any double-count.
    for (const rl of asArray((body as { resourceLogs?: unknown }).resourceLogs)) {
      const row = parseLogsRow(rl);
      if (row) rows.push(row);
    }
  } catch {
    return [];
  }
  return rows;
}
