import { describe, expect, it } from "vitest";
import { ClaudeShadowProvider } from "./claude.js";
import { CodexShadowProvider } from "./codex.js";

const args = {
  goalId: "g",
  sessionId: "s",
  resolverCommand: ["node", "r.js"],
  configDir: "/tmp/cfg",
  otlpBaseUrl: "http://127.0.0.1:8787/v1/otlp",
  authToken: "tok",
};

describe("worker OTEL telemetry wiring", () => {
  it("Claude worker env enables telemetry pointed at the daemon receiver", () => {
    const cfg = new ClaudeShadowProvider().workerHookConfig(args);
    expect(cfg.env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
    expect(cfg.env?.OTEL_METRICS_EXPORTER).toBe("otlp");
    expect(cfg.env?.OTEL_LOGS_EXPORTER).toBe("otlp");
    expect(cfg.env?.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
    // Claude appends /v1/metrics, /v1/logs itself — base URL only.
    expect(cfg.env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("http://127.0.0.1:8787/v1/otlp");
    expect(cfg.env?.OTEL_EXPORTER_OTLP_HEADERS).toBe("Authorization=Bearer tok");
    expect(cfg.env?.OTEL_METRICS_INCLUDE_SESSION_ID).toBe("true");
    expect(cfg.env?.OTEL_METRIC_EXPORT_INTERVAL).toBe("5000");
    // Orca's id is injected as a resource attribute — the parser keys cost on it.
    expect(cfg.env?.OTEL_RESOURCE_ATTRIBUTES).toBe("orca.session.id=s,orca.goal.id=g");
  });

  it("Codex config.toml includes a struct-form [otel.exporter.\"otlp-http\"] block + resource attrs", () => {
    const cfg = new CodexShadowProvider().workerHookConfig(args);
    const toml = cfg.files.find((f) => f.relPath === "config.toml")?.contents ?? "";
    expect(toml).toContain("[otel]");
    expect(toml).toContain("log_user_prompt = false");
    // The flat `exporter = "otlp-http"` form is REJECTED by codex 0.139.0 — must be the struct/table form.
    expect(toml).toContain('[otel.exporter."otlp-http"]');
    // Codex posts to the endpoint verbatim — give it the FULL /v1/logs path.
    expect(toml).toContain('endpoint = "http://127.0.0.1:8787/v1/otlp/v1/logs"');
    // Orca's id injected via env so the parser keys cost on it.
    expect(cfg.env?.OTEL_RESOURCE_ATTRIBUTES).toBe("orca.session.id=s,orca.goal.id=g");
  });
});
