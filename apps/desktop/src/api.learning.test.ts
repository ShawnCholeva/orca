import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn() }));

type ApiModule = typeof import("./api");

const proposal = {
  id: "p1", templateId: "tpl", templateVersionAtProposal: 1, stepTemplateId: "s1", component: "step_instructions",
  beforeInstructions: "old", afterInstructions: "new",
  targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 8, signalCount: null },
  predictedImprovement: "x", invariantsPreserved: ["safetyCompliance"], falsifier: "version_comparison", rollbackPlan: "revert_to_before",
  evidence: { sampleTransitionIds: [], revisionSignalIds: [], metricSnapshot: { score: 60, verdictPassRate: 0.5, oracleSufficientRate: 0.8, versionDelta: null } },
  rationale: "r", humanEdited: false, status: "pending",
  createdAt: "2026-06-30T00:00:00.000Z", decidedAt: null, decidedBy: null, appliedAsVersion: null,
};

describe("learning api", () => {
  let api: ApiModule;
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(async () => {
    vi.resetModules(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
    api = await import("./api");
  });

  it("analyzeTemplate POSTs with the period and returns proposals", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ proposals: [proposal] }), { status: 200, headers: { "content-type": "application/json" } }));
    const out = await api.analyzeTemplate("tpl", "7d");
    expect(out[0]!.id).toBe("p1");
    expect(fetchMock.mock.calls[0]![0]).toContain("/v1/learning/templates/tpl/analyze?period=7d");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("POST");
  });

  it("applyProposal POSTs editedInstructions and returns the proposal", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ proposal: { ...proposal, status: "applied" } }), { status: 200, headers: { "content-type": "application/json" } }));
    const out = await api.applyProposal("p1", "human text");
    expect(out.status).toBe("applied");
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ editedInstructions: "human text" });
  });
});
