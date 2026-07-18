import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

type ApiModule = typeof import("./api");

describe("getTemplateMetricsSummaries", () => {
  let api: ApiModule;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    api = await import("./api");
  });

  it("requests the templates endpoint with the period and returns summaries", async () => {
    const summaries = [{
      templateId: "tpl", name: "Brainstorm", latestVersion: 1, runs: 3,
      dimensions: {
        trajectoryEfficiency: { value: null }, verificationStrength: { value: 0.8 },
        recovery: { value: null }, stateConsistency: { value: 1 },
        safetyCompliance: { value: 1 }, replayability: { value: 1 },
      },
      firstPass: null, recovered: null, escalated: null,
      latencyP50Ms: null,
      deltas: { trajectoryEfficiency: null, verificationStrength: null, recovery: null,
                stateConsistency: null, safetyCompliance: null, replayability: null, latencyP50Ms: null },
      versionComparison: null, versions: [], confidence: "low", calibration: [],
      gateHealth: { value: null, grade: null, delta: null, confidence: "low" },
    }];
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ summaries }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await api.getTemplateMetricsSummaries("7d");
    expect(result).toHaveLength(1);
    expect(result[0]!.templateId).toBe("tpl");
    expect(fetchMock.mock.calls[0]![0]).toContain("/v1/metrics/templates?period=7d");
  });
});

describe("getTemplateMetricsDetail", () => {
  let api: ApiModule;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    api = await import("./api");
  });

  it("requests the template detail endpoint with period and returns detail", async () => {
    const summary = {
      templateId: "tpl", name: "Brainstorm", latestVersion: 1, runs: 3,
      dimensions: {
        trajectoryEfficiency: { value: null }, verificationStrength: { value: 0.8 },
        recovery: { value: null }, stateConsistency: { value: 1 },
        safetyCompliance: { value: 1 }, replayability: { value: 1 },
      },
      firstPass: null, recovered: null, escalated: null,
      latencyP50Ms: null,
      deltas: { trajectoryEfficiency: null, verificationStrength: null, recovery: null,
                stateConsistency: null, safetyCompliance: null, replayability: null, latencyP50Ms: null },
      versionComparison: null, versions: [], confidence: "low", calibration: [],
      gateHealth: { value: null, grade: null, delta: null, confidence: "low" },
    };
    const detail = { summary, steps: [], gates: [], policyGateway: { decisionDist: { allow: 0, require_approval: 0, deny: 0 }, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] }, completionGate: { verdictDist: { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 }, vetoed: { count: 0, sampleTransitionIds: [] } } };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await api.getTemplateMetricsDetail("tpl", "7d");
    expect(result.summary.templateId).toBe("tpl");
    expect(result.steps).toEqual([]);
    expect(fetchMock.mock.calls[0]![0]).toContain("/v1/metrics/templates/tpl?period=7d");
  });
});
