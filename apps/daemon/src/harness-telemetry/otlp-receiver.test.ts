import { describe, expect, it } from "vitest";
import { parseOtlpTokens } from "./otlp-receiver.js";

// Fixtures below are built from the REAL envelopes captured by the Task 3 spike
// (.superpowers/sdd/otel-spike-findings.md). The injected resource attribute
// `orca.session.id` is the attribution key (NOT the CLI-native session.id /
// conversation.id). Token numbers are the verbatim captured values.

// Claude LOGS envelope carrying the `api_request` event — now the SOLE Claude
// token source. One record carries tokens + cache + cost + duration + model in
// named numeric fields. (Spike: scope com.anthropic.claude_code.events,
// event.name=="api_request"; orca.session.id on the same resourceLogs envelope.)
const claudeApiRequestLog = {
  resourceLogs: [
    {
      resource: {
        attributes: [
          { key: "orca.session.id", value: { stringValue: "ORCA-CLAUDE-1" } },
          { key: "orca.goal.id", value: { stringValue: "GOAL-9" } },
          // PII that MUST be ignored.
          { key: "user.email", value: { stringValue: "leak@example.com" } },
          { key: "service.name", value: { stringValue: "claude-code" } },
        ],
      },
      scopeLogs: [
        {
          scope: { name: "com.anthropic.claude_code.events" },
          logRecords: [
            {
              attributes: [
                { key: "event.name", value: { stringValue: "api_request" } },
                { key: "model", value: { stringValue: "claude-opus-4-8" } },
                { key: "input_tokens", value: { intValue: 5799 } },
                { key: "output_tokens", value: { intValue: 54 } },
                { key: "cache_read_tokens", value: { intValue: 14157 } },
                { key: "cache_creation_tokens", value: { intValue: 2225 } },
                { key: "cost_usd", value: { doubleValue: 0.0596735 } },
                { key: "cost_usd_micros", value: { intValue: 59674 } },
                { key: "duration_ms", value: { intValue: 3819 } },
                // PII / CLI-native id that MUST be ignored.
                { key: "user.email", value: { stringValue: "leak@example.com" } },
                { key: "session.id", value: { stringValue: "f040b04f-cli-native" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// The OLD Claude METRIC `claude_code.token.usage` — now deliberately NOT counted
// (Claude reads only the api_request log; this avoids a metric-vs-log double-count).
const claudeMetricsOnly = {
  resourceMetrics: [
    {
      resource: {
        attributes: [
          { key: "orca.session.id", value: { stringValue: "ORCA-CLAUDE-1" } },
          { key: "service.name", value: { stringValue: "claude-code" } },
        ],
      },
      scopeMetrics: [
        {
          scope: { name: "com.anthropic.claude_code" },
          metrics: [
            {
              name: "claude_code.token.usage",
              unit: "tokens",
              sum: {
                dataPoints: [
                  {
                    attributes: [{ key: "type", value: { stringValue: "input" } }],
                    asDouble: 5799,
                  },
                  {
                    attributes: [{ key: "type", value: { stringValue: "output" } }],
                    asDouble: 54,
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
};

// Codex LOGS envelope: `codex.sse_event` with kind `response.completed`. Token
// fields are STRING-typed → must be Number()-coerced. Two model turns captured.
const codexLogs = {
  resourceLogs: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "codex_exec" } },
          { key: "orca.session.id", value: { stringValue: "ORCA-CODEX-1" } },
          { key: "telemetry.sdk.language", value: { stringValue: "rust" } },
        ],
      },
      scopeLogs: [
        {
          scope: { name: "codex_otel.log_only" },
          logRecords: [
            // first turn
            {
              attributes: [
                { key: "event.name", value: { stringValue: "codex.sse_event" } },
                { key: "event.kind", value: { stringValue: "response.completed" } },
                { key: "input_token_count", value: { stringValue: "12426" } },
                { key: "output_token_count", value: { stringValue: "0" } },
                { key: "cached_token_count", value: { stringValue: "10624" } },
                { key: "model", value: { stringValue: "gpt-5.5" } },
                { key: "user.email", value: { stringValue: "leak@example.com" } },
                { key: "conversation.id", value: { stringValue: "019ef825-cli-native" } },
              ],
            },
            // a non-token event that must be skipped
            {
              attributes: [
                { key: "event.name", value: { stringValue: "codex.api_request" } },
              ],
            },
            // final turn
            {
              attributes: [
                { key: "event.name", value: { stringValue: "codex.sse_event" } },
                { key: "event.kind", value: { stringValue: "response.completed" } },
                { key: "input_token_count", value: { stringValue: "12426" } },
                { key: "output_token_count", value: { stringValue: "6" } },
                { key: "cached_token_count", value: { stringValue: "10624" } },
                { key: "model", value: { stringValue: "gpt-5.5" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("parseOtlpTokens", () => {
  it("extracts Claude api_request log keyed by orca.session.id (tokens+cache+cost+duration)", () => {
    const rows = parseOtlpTokens(claudeApiRequestLog);
    const r = rows.find((x) => x.sessionId === "ORCA-CLAUDE-1");
    expect(r).toBeDefined();
    expect(r?.tokensIn).toBe(5799);
    expect(r?.tokensOut).toBe(54);
    expect(r?.cacheReadTokens).toBe(14157);
    expect(r?.cacheCreationTokens).toBe(2225);
    expect(r?.usd).toBe(0.0596735);
    expect(r?.durationMs).toBe(3819);
    expect(r?.model).toBe("claude-opus-4-8");
  });

  it("does NOT count the Claude token.usage METRIC anymore (no double path)", () => {
    // Claude tokens now come ONLY from the api_request log; the metric alone
    // yields no rows, so the metric+log can never double-count.
    expect(parseOtlpTokens(claudeMetricsOnly)).toEqual([]);
  });

  it("coerces Codex string token counts (incl. cached) and keys by orca.session.id", () => {
    const rows = parseOtlpTokens(codexLogs);
    const r = rows.find((x) => x.sessionId === "ORCA-CODEX-1");
    expect(r).toBeDefined();
    // sums both response.completed turns: in 12426+12426, out 0+6, cache 10624+10624
    expect(r?.tokensIn).toBe(24852);
    expect(r?.tokensOut).toBe(6);
    expect(r?.cacheReadTokens).toBe(21248);
    expect(r?.cacheCreationTokens).toBe(0);
    expect(r?.usd).toBeNull(); // Codex emits no cost
    expect(r?.durationMs).toBeNull(); // sse_event carries no duration
    expect(r?.model).toBe("gpt-5.5");
  });

  it("never reads PII (only the named fields on each row)", () => {
    const rows = [
      ...parseOtlpTokens(claudeApiRequestLog),
      ...parseOtlpTokens(codexLogs),
    ];
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual([
        "cacheCreationTokens",
        "cacheReadTokens",
        "durationMs",
        "model",
        "sessionId",
        "tokensIn",
        "tokensOut",
        "usd",
      ]);
    }
  });

  it("returns [] on malformed input (fail-safe)", () => {
    expect(parseOtlpTokens({ nope: true })).toEqual([]);
    expect(parseOtlpTokens(null)).toEqual([]);
    expect(parseOtlpTokens(undefined)).toEqual([]);
    expect(parseOtlpTokens("garbage")).toEqual([]);
    expect(parseOtlpTokens(42)).toEqual([]);
    expect(parseOtlpTokens([])).toEqual([]);
  });

  it("missing fields contribute nothing (cache→0, usd/durationMs→null)", () => {
    const sparse = {
      resourceLogs: [
        {
          resource: {
            attributes: [{ key: "orca.session.id", value: { stringValue: "SPARSE" } }],
          },
          scopeLogs: [
            {
              scope: { name: "com.anthropic.claude_code.events" },
              logRecords: [
                {
                  attributes: [
                    { key: "event.name", value: { stringValue: "api_request" } },
                    { key: "input_tokens", value: { intValue: 10 } },
                    { key: "output_tokens", value: { intValue: 2 } },
                    // no cache, no cost, no duration, no model
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const r = parseOtlpTokens(sparse).find((x) => x.sessionId === "SPARSE");
    expect(r?.tokensIn).toBe(10);
    expect(r?.tokensOut).toBe(2);
    expect(r?.cacheReadTokens).toBe(0);
    expect(r?.cacheCreationTokens).toBe(0);
    expect(r?.usd).toBeNull();
    expect(r?.durationMs).toBeNull();
    expect(r?.model).toBeUndefined();
  });

  it("skips a resource with no orca.session.id, contributing nothing", () => {
    const noSession = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
          scopeLogs: [
            {
              scope: { name: "com.anthropic.claude_code.events" },
              logRecords: [
                {
                  attributes: [
                    { key: "event.name", value: { stringValue: "api_request" } },
                    { key: "input_tokens", value: { intValue: 100 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(parseOtlpTokens(noSession)).toEqual([]);
  });

  it("drops NaN token coercions without throwing (Codex)", () => {
    const badCodex = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: "orca.session.id", value: { stringValue: "S" } }] },
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    { key: "event.name", value: { stringValue: "codex.sse_event" } },
                    { key: "event.kind", value: { stringValue: "response.completed" } },
                    { key: "input_token_count", value: { stringValue: "not-a-number" } },
                    { key: "output_token_count", value: { stringValue: "5" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const rows = parseOtlpTokens(badCodex);
    const r = rows.find((x) => x.sessionId === "S");
    expect(r?.tokensIn).toBe(0); // NaN dropped → 0
    expect(r?.tokensOut).toBe(5);
    expect(r?.usd).toBeNull();
    expect(r?.durationMs).toBeNull();
  });
});
