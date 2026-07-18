import { describe, expect, it } from "vitest";
import { composedScore } from "./composed-score.js";
import type { TemplateTransition } from "./fetch.js";

const tx = (over: Record<string, unknown>): TemplateTransition => ({
  templateVersion: 1, stepTemplateId: "s",
  transition: { workflowRunId: "r", boundary: "step_complete", createdAt: "2026-07-16T00:00:00Z", ...over } as never,
});
const ev = (o: Record<string, unknown>) => ({ sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: [] }, ...o });
// A grounding verdict of "passed" backed by an enforce-mode, non-skipped check — the
// minimum classifyTier requires to count grounding as having actually run.
const groundingPassed = { verdict: "passed", checks: [{ mode: "enforce", result: "passed" }] };

describe("composedScore", () => {
  it("refuted → 0", () => expect(composedScore(tx({ refute: { verdict: "refuted" } })).score).toBe(0));
  it("evidence failed → 0", () => expect(composedScore(tx({ evidence: ev({ verdict: "failed" }) })).score).toBe(0));
  it("full sensor pass (sufficient) → 1.0", () => {
    const r = composedScore(tx({ evidence: ev({ sensorsRun: [{ kind: "unit" }], oracleAdequacy: { sufficient: true, gaps: [] } }) }));
    expect(r.score).toBe(1); expect(r.base).toBe(1); expect(r.coverage).toBe(1);
  });
  it("grounding + review, no execution → ~0.86", () => {
    const r = composedScore(tx({ evidence: ev({ grounding: groundingPassed }), refute: { verdict: "upheld" } }));
    expect(r.base).toBeCloseTo(0.865, 3); expect(r.coverage).toBe(1); expect(r.score).toBeCloseTo(0.865, 3);
  });
  it("grounding only → 0.70", () => {
    expect(composedScore(tx({ evidence: ev({ grounding: groundingPassed }) })).score).toBeCloseTo(0.7, 5);
  });
  it("verdict passed with only an observe-mode check → grounding not credited, self-report floor", () => {
    const r = composedScore(tx({ evidence: ev({ grounding: { verdict: "passed", checks: [{ mode: "observe", result: "passed" }] } }) }));
    expect(r.verifiers.grounding).toBe(false); // verdict alone isn't enough — must match classifyTier's enforce-mode requirement
    expect(r.score).toBeCloseTo(0.3, 5);
  });
  it("verdict passed with an enforce-mode non-skipped check → grounding credited, base 0.7", () => {
    const r = composedScore(tx({ evidence: ev({ grounding: { verdict: "passed", checks: [{ mode: "enforce", result: "passed" }] } }) }));
    expect(r.verifiers.grounding).toBe(true);
    expect(r.base).toBeCloseTo(0.7, 5);
  });
  it("self-report only (no verifiers) → 0.30 floor", () => {
    expect(composedScore(tx({ evidence: ev({}) })).score).toBeCloseTo(0.3, 5);
  });
  it("partial oracle (sensors ran, sufficient=false) → executable excluded, grounding base × 1.0", () => {
    const r = composedScore(tx({ evidence: ev({ sensorsRun: [{ kind: "typecheck" }], verdict: "partial", grounding: groundingPassed }) }));
    expect(r.verifiers.executable).toBe(false); // sufficiency-gated
    expect(r.base).toBeCloseTo(0.7, 5); expect(r.coverage).toBe(1); expect(r.score).toBeCloseTo(0.7, 5);
  });
  it("vacuous sufficiency (no required sensors, sensorsRun empty) → executable excluded, self-report floor", () => {
    const r = composedScore(tx({ evidence: ev({ sensorsRun: [], oracleAdequacy: { sufficient: true, gaps: [] } }) }));
    expect(r.verifiers.executable).toBe(false); // sufficient alone must not grant executable credit — match classifyTier
    expect(r.score).toBeCloseTo(0.3, 5);
  });
  it("code change, no execution → coverage floors from per-file untested", () => {
    const r = composedScore(tx({
      evidence: ev({ grounding: groundingPassed, untestedRegions: ["src/a.ts — changed, no test or check ran over it"] }),
      stateDeps: { write_set: [{ kind: "file", ref: "src/a.ts", change_kind: "modified" }] },
    }));
    expect(r.coverage).toBeCloseTo(0.3, 5); // 1 of 1 code file untested → floor
    expect(r.score).toBeCloseTo(0.7 * 0.3, 5);
  });
  it("non-code write-set → coverage 1.0 (no double-penalty)", () => {
    const r = composedScore(tx({
      evidence: ev({ grounding: { verdict: "passed" }, untestedRegions: ["semantic correctness — nothing was executed"] }),
      stateDeps: { write_set: [{ kind: "file", ref: "docs/x.md", change_kind: "modified" }] },
    }));
    expect(r.coverage).toBe(1);
  });
  it("prefix collision fix: a.ts must not match a.tsx untested region", () => {
    const r = composedScore(tx({
      evidence: ev({ grounding: groundingPassed, untestedRegions: ["src/a.tsx — changed, no test or check ran over it"] }),
      stateDeps: { write_set: [
        { kind: "file", ref: "src/a.ts", change_kind: "modified" },
        { kind: "file", ref: "src/a.tsx", change_kind: "modified" },
      ] },
    }));
    expect(r.coverage).toBeCloseTo(0.5, 5); // 1 untested of 2 → max(0.3, 1 - 1/2) = 0.5
    expect(r.score).toBeCloseTo(0.7 * 0.5, 5);
  });
  it("uses the calibrated grounding confidence when calibration is supplied", () => {
    const r = composedScore(tx({ evidence: ev({ grounding: groundingPassed }) }), [
      { source: "grounding", assumed: 0.7, measured: 0.5, sampleSize: 10, state: "measured" },
    ] as never);
    const noCal = composedScore(tx({ evidence: ev({ grounding: groundingPassed }) }));
    expect(noCal.base).toBeCloseTo(0.7, 5);   // designed prior (2b-i behavior preserved when no calibration)
    expect(r.base).toBeCloseTo(0.5, 5); // calibrated grounding survival feeds base
  });
});
