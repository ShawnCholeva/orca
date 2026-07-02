import { describe, expect, it } from "vitest";
import { HarnessTransition, HarnessTransitionBoundary, HARNESS_FACETS } from "./index.js";

describe("HARNESS_FACETS registry", () => {
  const ENVELOPE_KEYS = ["boundary", "createdAt", "goalId", "id", "workflowRunId", "workflowStepRunId"];

  it("registers exactly the facet fields of HarnessTransition", () => {
    const shapeKeys = Object.keys(HarnessTransition.shape).sort();
    const facetKeys = shapeKeys.filter((k) => !ENVELOPE_KEYS.includes(k));
    expect(HARNESS_FACETS.map((f) => f.key).sort()).toEqual(facetKeys);
  });

  it("maps each facet key to its snake_case _json column", () => {
    expect(HARNESS_FACETS.map((f) => [f.key, f.column])).toEqual([
      ["risk", "risk_json"],
      ["evidence", "evidence_json"],
      ["stateDeps", "state_deps_json"],
      ["telemetry", "telemetry_json"],
      ["composition", "composition_json"],
    ]);
  });
});

describe("HarnessTransition", () => {
  it("accepts a spine record with null facets", () => {
    const parsed = HarnessTransition.parse({
      id: "t1",
      goalId: "g1",
      workflowRunId: "r1",
      workflowStepRunId: "s1",
      boundary: "step_complete",
      risk: null,
      evidence: null,
      stateDeps: null,
      telemetry: null,
      createdAt: "2026-06-23T00:00:00.000Z",
    });
    expect(parsed.boundary).toBe("step_complete");
    expect(parsed.evidence).toBeNull();
  });

  it("rejects an unknown boundary", () => {
    expect(HarnessTransitionBoundary.safeParse("nope").success).toBe(false);
  });

  it("rejects extra keys (strict)", () => {
    const r = HarnessTransition.safeParse({
      id: "t1", goalId: "g1", workflowRunId: null, workflowStepRunId: null,
      boundary: "tool_gate", risk: null, evidence: null, stateDeps: null,
      telemetry: null, createdAt: "2026-06-23T00:00:00.000Z", extra: 1,
    });
    expect(r.success).toBe(false);
  });
});

import { EvidenceFacet, HarnessTransition as HT } from "./index.js";

describe("EvidenceFacet", () => {
  it("accepts a failed verdict with one sensor", () => {
    const f = EvidenceFacet.parse({
      sensorsRun: [
        { kind: "unit", command: "pnpm test", exitCode: 1, durationMs: 1200,
          result: "failed", summary: "1 failing", artifactRef: null },
      ],
      verdict: "failed",
      untestedRegions: [],
      residualRisk: [],
      oracleAdequacy: { sufficient: false, gaps: ["typecheck did not run"] },
    });
    expect(f.verdict).toBe("failed");
  });

  it("is accepted as the evidence facet on a transition", () => {
    const t = HT.parse({
      id: "t", goalId: "g", workflowRunId: null, workflowStepRunId: "s",
      boundary: "step_complete",
      risk: null,
      evidence: {
        sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [],
        oracleAdequacy: { sufficient: true, gaps: [] },
      },
      stateDeps: null, telemetry: null, createdAt: "2026-06-23T00:00:00.000Z",
    });
    expect(t.evidence?.verdict).toBe("passed");
  });
});

import { RiskFacet, OperatingMode } from "./index.js";

describe("RiskFacet", () => {
  it("accepts a require_approval facet", () => {
    const f = RiskFacet.parse({
      risk_class: "high",
      permission_tier: "full_access",
      classification_reasons: ["bash: network access (curl)"],
      gate_decision: "require_approval",
      hard_constraint_violations: [],
    });
    expect(f.gate_decision).toBe("require_approval");
  });
  it("is accepted as the risk facet on a transition", () => {
    const t = HarnessTransition.parse({
      id: "t", goalId: "g", workflowRunId: null, workflowStepRunId: null,
      boundary: "tool_gate",
      risk: { risk_class: "low", permission_tier: "read_only",
              classification_reasons: [], gate_decision: "allow", hard_constraint_violations: [] },
      evidence: null, stateDeps: null, telemetry: null, createdAt: "2026-06-23T00:00:00.000Z",
    });
    expect(t.risk?.gate_decision).toBe("allow");
  });
  it("rejects an unknown operating mode", () => {
    expect(OperatingMode.safeParse("yolo").success).toBe(false);
  });
});

import { TelemetryFacet, FailureCode, CostEntry } from "./index.js";

describe("CostEntry", () => {
  it("defaults cache fields to null when omitted (existing serialized facets still parse)", () => {
    const c = CostEntry.parse({ tokens_in: 1200, tokens_out: 340, usd: 0.0123 });
    expect(c.cache_read_tokens).toBeNull();
    expect(c.cache_creation_tokens).toBeNull();
  });
  it("accepts populated cache fields", () => {
    const c = CostEntry.parse({
      tokens_in: 1200, tokens_out: 340, usd: 0.0123,
      cache_read_tokens: 50, cache_creation_tokens: 10,
    });
    expect(c.cache_read_tokens).toBe(50);
    expect(c.cache_creation_tokens).toBe(10);
  });
});

describe("TelemetryFacet", () => {
  it("accepts a cost+outcome facet", () => {
    const t = TelemetryFacet.parse({
      cost: { tokens_in: 1200, tokens_out: 340, usd: 0.0123 },
      latency_ms: 880, model: "claude-opus-4-8", provider_id: "anthropic", provider_version: null,
      prompt_ref: null, raw_output_ref: null,
      rejected_alternatives: [{ option: "codex", reason: "lower fit score" }],
      human_interventions: [{ kind: "approval", ref: "appr-1" }],
      outcome: { status: "succeeded", failure_code: null },
    });
    expect(t.cost?.usd).toBeCloseTo(0.0123);
    expect(t.outcome.status).toBe("succeeded");
  });
  it("allows null cost (no usage source)", () => {
    const t = TelemetryFacet.parse({
      cost: null, latency_ms: null, model: null, provider_id: null, provider_version: null,
      prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [],
      outcome: { status: "failed", failure_code: "timeout" },
    });
    expect(t.cost).toBeNull();
  });
  it("rejects an unknown failure_code", () => {
    expect(FailureCode.safeParse("kaboom").success).toBe(false);
  });
  it("is accepted as the telemetry facet on a transition", () => {
    const tr = HarnessTransition.parse({
      id: "t", goalId: "g", workflowRunId: null, workflowStepRunId: null, boundary: "step_complete",
      risk: null, evidence: null, stateDeps: null,
      telemetry: { cost: null, latency_ms: 5, model: null, provider_id: null, provider_version: null,
        prompt_ref: null, raw_output_ref: null, rejected_alternatives: [], human_interventions: [],
        outcome: { status: "succeeded", failure_code: null } },
      createdAt: "2026-06-24T00:00:00.000Z",
    });
    expect(tr.telemetry?.outcome.status).toBe("succeeded");
  });
});

import { StateDepsFacet, ConflictPolicy } from "./index.js";

describe("StateDepsFacet", () => {
  it("accepts a populated facet", () => {
    const f = StateDepsFacet.parse({
      read_set: [{ kind: "memory_item", ref: "m1", version: "2026-06-24T00:00:00.000Z" }],
      write_set: [{ kind: "file", ref: "src/x.ts", change_kind: "modified" }],
      assumptions: [{ statement: "config is valid", source_ref: null, verified: false }],
      version_deps: [{ ref: "ws1", observed_version: "main@abc" }],
      conflict_policy: "escalate",
      conflicts: [],
    });
    expect(f.write_set[0].change_kind).toBe("modified");
    expect(f.conflicts).toEqual([]);
  });
  it("defaults conflicts/assumptions/etc. to empty arrays", () => {
    const f = StateDepsFacet.parse({ conflict_policy: "auto" });
    expect(f.read_set).toEqual([]);
    expect(f.conflicts).toEqual([]);
  });
  it("rejects an unknown conflict_policy", () => {
    expect(ConflictPolicy.safeParse("yolo").success).toBe(false);
  });
  it("is accepted as the stateDeps facet on a transition", () => {
    const t = HarnessTransition.parse({
      id: "t", goalId: "g", workflowRunId: null, workflowStepRunId: null, boundary: "step_launch",
      risk: null, evidence: null, telemetry: null,
      stateDeps: { conflict_policy: "escalate" },
      createdAt: "2026-06-24T00:00:00.000Z",
    });
    expect(t.stateDeps?.conflict_policy).toBe("escalate");
  });
});
