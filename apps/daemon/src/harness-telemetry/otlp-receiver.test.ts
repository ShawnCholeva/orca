import { describe, expect, it } from "vitest";
import { parseOtlpTokens } from "./otlp-receiver.js";

// Fixtures below are built from the REAL envelopes captured by the Task 3 spike
// (.superpowers/sdd/otel-spike-findings.md). The injected resource attribute
// `orca.session.id` is the attribution key (NOT the CLI-native session.id /
// conversation.id). Token numbers are the verbatim captured values.

// Claude metrics envelope: `claude_code.token.usage` datapoints discriminated by
// the `type` attribute; numeric value in `asDouble`. tokens_in=5799, tokens_out=54.
const claudeMetrics = {
  resourceMetrics: [
    {
      resource: {
        attributes: [
          { key: "orca.session.id", value: { stringValue: "ORCA-CLAUDE-1" } },
          { key: "orca.goal.id", value: { stringValue: "GOAL-9" } },
          { key: "host.arch", value: { stringValue: "arm64" } },
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
                    attributes: [
                      // PII that MUST be ignored.
                      { key: "user.email", value: { stringValue: "leak@example.com" } },
                      { key: "model", value: { stringValue: "claude-opus-4-8" } },
                      { key: "type", value: { stringValue: "input" } },
                    ],
                    asDouble: 5799,
                  },
                  {
                    attributes: [{ key: "type", value: { stringValue: "output" } }],
                    asDouble: 54,
                  },
                  // cacheRead / cacheCreation must NOT be summed.
                  {
                    attributes: [{ key: "type", value: { stringValue: "cacheRead" } }],
                    asDouble: 14157,
                  },
                  {
                    attributes: [{ key: "type", value: { stringValue: "cacheCreation" } }],
                    asDouble: 2225,
                  },
                ],
              },
            },
            // cost metric (no `type`) must be ignored by the token parser.
            {
              name: "claude_code.cost.usage",
              sum: {
                dataPoints: [{ attributes: [], asDouble: 0.0596735 }],
              },
            },
          ],
        },
      ],
    },
  ],
};

// Claude LOGS envelope carrying the `api_request` event. This DUPLICATES the
// metric and MUST be ignored to avoid double-counting.
const claudeApiRequestLog = {
  resourceLogs: [
    {
      resource: {
        attributes: [
          { key: "orca.session.id", value: { stringValue: "ORCA-CLAUDE-1" } },
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
                { key: "session.id", value: { stringValue: "f040b04f-cli-native" } },
              ],
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
  it("extracts Claude token.usage keyed by orca.session.id (input/output only)", () => {
    const rows = parseOtlpTokens(claudeMetrics);
    const r = rows.find((x) => x.sessionId === "ORCA-CLAUDE-1");
    expect(r).toBeDefined();
    expect(r?.tokensIn).toBe(5799);
    expect(r?.tokensOut).toBe(54);
    expect(r?.model).toBe("claude-opus-4-8");
  });

  it("does NOT count cacheRead/cacheCreation or the cost metric", () => {
    const rows = parseOtlpTokens(claudeMetrics);
    const r = rows.find((x) => x.sessionId === "ORCA-CLAUDE-1");
    // 5799 + 54, NOT 5799 + 14157 + 2225 etc.
    expect((r?.tokensIn ?? 0) + (r?.tokensOut ?? 0)).toBe(5853);
  });

  it("IGNORES the Claude api_request LOG (avoids double-count)", () => {
    const rows = parseOtlpTokens(claudeApiRequestLog);
    expect(rows).toEqual([]);
  });

  it("coerces Codex string token counts and keys by orca.session.id", () => {
    const rows = parseOtlpTokens(codexLogs);
    const r = rows.find((x) => x.sessionId === "ORCA-CODEX-1");
    expect(r).toBeDefined();
    // sums both response.completed turns: in 12426+12426, out 0+6
    expect(r?.tokensIn).toBe(24852);
    expect(r?.tokensOut).toBe(6);
    expect(r?.model).toBe("gpt-5.5");
  });

  it("never reads PII (only sessionId/tokens/model on each row)", () => {
    const rows = [...parseOtlpTokens(claudeMetrics), ...parseOtlpTokens(codexLogs)];
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["model", "sessionId", "tokensIn", "tokensOut"]);
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

  it("skips a resource with no orca.session.id, contributing nothing", () => {
    const noSession = {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.token.usage",
                  sum: { dataPoints: [{ attributes: [{ key: "type", value: { stringValue: "input" } }], asDouble: 100 }] },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(parseOtlpTokens(noSession)).toEqual([]);
  });

  it("drops NaN token coercions without throwing", () => {
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
  });
});
