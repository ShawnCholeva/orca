import { describe, expect, it } from "vitest";
import { sourcesPassed, SOURCE_CONFIDENCE } from "./source-signals.js";

const ev = (o: Record<string, unknown>) => ({ sensorsRun: [], verdict: "passed", untestedRegions: [], residualRisk: [], oracleAdequacy: { sufficient: false, gaps: [] }, ...o }) as never;

describe("sourcesPassed", () => {
  it("executable needs sensors ran AND sufficient", () => {
    expect(sourcesPassed(ev({ sensorsRun: [{ kind: "unit" }], oracleAdequacy: { sufficient: true, gaps: [] } }), null).executable).toBe(true);
    expect(sourcesPassed(ev({ sensorsRun: [], oracleAdequacy: { sufficient: true, gaps: [] } }), null).executable).toBe(false); // no sensors
    expect(sourcesPassed(ev({ sensorsRun: [{ kind: "unit" }], oracleAdequacy: { sufficient: false, gaps: [] } }), null).executable).toBe(false); // not sufficient
  });
  it("grounding needs an enforce-mode non-skipped check + verdict passed", () => {
    expect(sourcesPassed(ev({ grounding: { verdict: "passed", checks: [{ mode: "enforce", result: "passed" }] } }), null).grounding).toBe(true);
    expect(sourcesPassed(ev({ grounding: { verdict: "passed", checks: [{ mode: "observe", result: "passed" }] } }), null).grounding).toBe(false); // no enforce
  });
  it("independentReview is refute upheld", () => {
    expect(sourcesPassed(null, { verdict: "upheld" } as never).independentReview).toBe(true);
    expect(sourcesPassed(null, { verdict: "refuted" } as never).independentReview).toBe(false);
  });
  it("SOURCE_CONFIDENCE holds the four designed priors", () => {
    expect(SOURCE_CONFIDENCE).toEqual({ executable: 1.0, grounding: 0.7, independent_review: 0.55, self_report: 0.3 });
  });
});
