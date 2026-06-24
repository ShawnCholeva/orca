// Pure, fail-safe parser for OTLP/JSON token telemetry emitted by shadow workers.
//
// Attribution key = the INJECTED resource attribute `orca.session.id` (NOT the
// CLI-native session.id / conversation.id). Shapes are the ones captured by the
// Task 3 spike (.superpowers/sdd/otel-spike-findings.md):
//   - Claude: METRIC `claude_code.token.usage`, datapoints discriminated by the
//     `type` attribute (input/output; cacheRead/cacheCreation ignored), numeric
//     `asDouble`. We count tokens from this metric ONLY. Claude's `api_request`
//     LOG duplicates the metric and is deliberately NOT counted (double-count).
//   - Codex: LOG `codex.sse_event` with kind `response.completed`; token fields
//     are STRING-typed and coerced via Number().
//
// PII (user.email / account ids) is never read. Any shape mismatch / missing
// pointer / NaN coercion contributes nothing; a malformed top-level yields [].

export interface OtlpTokenRow {
  sessionId: string;
  tokensIn: number;
  tokensOut: number;
  model?: string;
}

function attrString(
  attributes: unknown,
  key: string,
): string | undefined {
  if (!Array.isArray(attributes)) return undefined;
  for (const a of attributes) {
    if (a && typeof a === "object" && (a as { key?: unknown }).key === key) {
      const v = (a as { value?: { stringValue?: unknown } }).value;
      if (v && typeof v.stringValue === "string") return v.stringValue;
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

function parseMetricsRow(rm: unknown): OtlpTokenRow | undefined {
  if (!rm || typeof rm !== "object") return undefined;
  const sessionId = sessionIdOf((rm as { resource?: unknown }).resource);
  if (!sessionId) return undefined;

  let tokensIn = 0;
  let tokensOut = 0;
  let model: string | undefined;
  let sawTokens = false;

  for (const sm of asArray((rm as { scopeMetrics?: unknown }).scopeMetrics)) {
    for (const metric of asArray((sm as { metrics?: unknown }).metrics)) {
      if (!metric || typeof metric !== "object") continue;
      if ((metric as { name?: unknown }).name !== "claude_code.token.usage") continue;
      const dataPoints = (metric as { sum?: { dataPoints?: unknown } }).sum?.dataPoints;
      for (const dp of asArray(dataPoints)) {
        if (!dp || typeof dp !== "object") continue;
        const attrs = (dp as { attributes?: unknown }).attributes;
        const type = attrString(attrs, "type");
        if (type !== "input" && type !== "output") continue; // skip cacheRead/cacheCreation
        const value = (dp as { asDouble?: unknown }).asDouble;
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        if (type === "input") tokensIn += value;
        else tokensOut += value;
        sawTokens = true;
        model ??= attrString(attrs, "model");
      }
    }
  }

  if (!sawTokens) return undefined;
  return model === undefined
    ? { sessionId, tokensIn, tokensOut }
    : { sessionId, tokensIn, tokensOut, model };
}

function parseLogsRow(rl: unknown): OtlpTokenRow | undefined {
  if (!rl || typeof rl !== "object") return undefined;
  const sessionId = sessionIdOf((rl as { resource?: unknown }).resource);
  if (!sessionId) return undefined;

  let tokensIn = 0;
  let tokensOut = 0;
  let model: string | undefined;
  let sawTokens = false;

  for (const sl of asArray((rl as { scopeLogs?: unknown }).scopeLogs)) {
    for (const record of asArray((sl as { logRecords?: unknown }).logRecords)) {
      if (!record || typeof record !== "object") continue;
      const attrs = (record as { attributes?: unknown }).attributes;
      // Codex token-bearing record ONLY. Claude's `api_request` log is ignored
      // (its tokens are already counted from the metric — avoids double-count).
      if (attrString(attrs, "event.name") !== "codex.sse_event") continue;
      if (attrString(attrs, "event.kind") !== "response.completed") continue;

      const inN = Number(attrString(attrs, "input_token_count"));
      const outN = Number(attrString(attrs, "output_token_count"));
      if (Number.isFinite(inN)) tokensIn += inN;
      if (Number.isFinite(outN)) tokensOut += outN;
      sawTokens = true;
      model ??= attrString(attrs, "model");
    }
  }

  if (!sawTokens) return undefined;
  return model === undefined
    ? { sessionId, tokensIn, tokensOut }
    : { sessionId, tokensIn, tokensOut, model };
}

export function parseOtlpTokens(body: unknown): OtlpTokenRow[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];

  const rows: OtlpTokenRow[] = [];
  try {
    for (const rm of asArray((body as { resourceMetrics?: unknown }).resourceMetrics)) {
      const row = parseMetricsRow(rm);
      if (row) rows.push(row);
    }
    for (const rl of asArray((body as { resourceLogs?: unknown }).resourceLogs)) {
      const row = parseLogsRow(rl);
      if (row) rows.push(row);
    }
  } catch {
    return [];
  }
  return rows;
}
