import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetricsPage } from "./MetricsPage";
import * as api from "../api";

afterEach(() => vi.restoreAllMocks());

const summary = {
  templateId: "tpl", name: "Brainstorm", latestVersion: 1, runs: 12,
  dimensions: { trajectoryEfficiency: { value: null }, verificationStrength: { value: 0.82 },
    recovery: { value: 0.28 }, stateConsistency: { value: 1 }, safetyCompliance: { value: 0.92 }, replayability: { value: 1 } },
  firstPass: 0.64, recovered: 0.28, escalated: 0.08,
  latencyP50Ms: 2400,
  deltas: { trajectoryEfficiency: null, verificationStrength: 0.04, recovery: 0.05,
    stateConsistency: 0, safetyCompliance: -0.03, replayability: 0, latencyP50Ms: -300 },
  versionComparison: null, versions: [{ version: 1, runs: 12, firstSeenAt: "2026-05-01T00:00:00.000Z" }], confidence: "ok" as const,
  calibration: [],
  gateHealth: { value: 78, grade: "C" as const, delta: null, confidence: "ok" as const },
};

describe("MetricsPage", () => {
  it("shows a loading state then renders the health tile", async () => {
    vi.spyOn(api, "getTemplateMetricsSummaries").mockResolvedValue([summary]);
    vi.spyOn(api, "getTemplateMetricsDetail").mockResolvedValue({ summary, steps: [], gates: [], policyGateway: { decisionDist: {}, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] } });
    render(<MetricsPage />);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Step health")).toBeInTheDocument());
    expect(screen.getByText("Brainstorm")).toBeInTheDocument();
  });

  it("shows Step health and Gate health as two distinct readouts", async () => {
    vi.spyOn(api, "getTemplateMetricsSummaries").mockResolvedValue([summary]);
    vi.spyOn(api, "getTemplateMetricsDetail").mockResolvedValue({ summary, steps: [], gates: [], policyGateway: { decisionDist: {}, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] } });
    render(<MetricsPage />);
    expect(await screen.findByText("Step health")).toBeInTheDocument();
    expect(screen.getByText("Gate health")).toBeInTheDocument();
    expect(screen.queryByText("Workflow health")).toBeNull();
  });

  it("shows the empty state when no templates have runs", async () => {
    vi.spyOn(api, "getTemplateMetricsSummaries").mockResolvedValue([]);
    render(<MetricsPage />);
    await waitFor(() => expect(screen.getByText(/Run a workflow to see metrics/i)).toBeInTheDocument());
  });

  it("shows an error state on fetch failure", async () => {
    vi.spyOn(api, "getTemplateMetricsSummaries").mockRejectedValue(new Error("boom"));
    render(<MetricsPage />);
    await waitFor(() => expect(screen.getByText(/Couldn't load metrics/i)).toBeInTheDocument());
  });

  it("renders em dash for null metrics (not 0 / F)", async () => {
    const nullSummary = {
      ...summary,
      dimensions: { ...summary.dimensions, verificationStrength: { value: null } },
      firstPass: null, confidence: "ok" as const,
    };
    vi.spyOn(api, "getTemplateMetricsSummaries").mockResolvedValue([nullSummary]);
    vi.spyOn(api, "getTemplateMetricsDetail").mockResolvedValue({ summary: nullSummary, steps: [], gates: [], policyGateway: { decisionDist: {}, overPermissive: { count: 0, sampleTransitionIds: [] }, boundaryViolations: [] } });
    render(<MetricsPage />);
    await waitFor(() => expect(screen.getByText("Step health")).toBeInTheDocument());
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("F")).not.toBeInTheDocument();
  });
});
