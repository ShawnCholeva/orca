import { describe, it, expect } from "vitest";
import {
  GATED_PATTERNS,
  MEASUREMENT_STATES,
  collapsesToNumber,
  deltaAllowed,
  gateFor,
  labelForMeasurementState,
  proportionInterval,
  rangesOverlap,
  zeroEventUpperBound,
} from "./n-gate";

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 4);

describe("zeroEventUpperBound", () => {
  // The exact one-sided 95% bound, 1 - 0.05^(1/n). The familiar 3/n "rule of three"
  // is an asymptotic approximation to this and overstates below n~30 — which is the
  // whole operating range here, so the exact form is the only one we ship.
  it("matches the exact bound at the sample sizes this product actually sees", () => {
    near(zeroEventUpperBound(1)!, 0.95);
    near(zeroEventUpperBound(2)!, 0.7764);
    near(zeroEventUpperBound(3)!, 0.6316);
    near(zeroEventUpperBound(4)!, 0.5271);
    near(zeroEventUpperBound(5)!, 0.4507);
    near(zeroEventUpperBound(10)!, 0.2589);
  });

  it("stays well below 3/n where 3/n is nonsense", () => {
    for (const n of [1, 2, 3]) expect(zeroEventUpperBound(n)!).toBeLessThan(3 / n);
    expect(zeroEventUpperBound(1)!).toBeLessThanOrEqual(1);
  });

  it("converges toward 3/n once n is large enough for the approximation", () => {
    expect(Math.abs(zeroEventUpperBound(30)! - 3 / 30)).toBeLessThan(0.006);
  });

  it("is null-safe at n=0", () => {
    expect(zeroEventUpperBound(0)).toBeNull();
  });
});

describe("proportionInterval", () => {
  it("returns null with no observations at all", () => {
    expect(proportionInterval(0, 0)).toBeNull();
  });

  it("uses the two-sided Wilson interval when some passed and some failed", () => {
    const r = proportionInterval(2, 1)!;
    expect(r.bound).toBe("two-sided");
    near(r.point, 2 / 3);
    near(r.lower, 0.2077);
    near(r.upper, 0.9385);
  });

  it("uses the exact one-sided bound when nothing failed", () => {
    const r = proportionInterval(4, 0)!;
    expect(r.bound).toBe("lower");
    near(r.point, 1);
    near(r.lower, 0.4729);
    expect(r.upper).toBe(1);
  });

  it("uses the exact one-sided bound when nothing passed", () => {
    const r = proportionInterval(0, 4)!;
    expect(r.bound).toBe("upper");
    near(r.point, 0);
    expect(r.lower).toBe(0);
    near(r.upper, 0.5271);
  });

  it("reports the founder's live cases", () => {
    const oneOfOne = proportionInterval(1, 0)!;
    near(oneOfOne.lower, 0.05); // exact one-sided, NOT Wilson's 0.2065
    expect(oneOfOne.upper).toBe(1);

    const eighteenOfTwenty = proportionInterval(18, 2)!;
    near(eighteenOfTwenty.lower, 0.699);
    near(eighteenOfTwenty.upper, 0.9721);

    const ninetyOfHundred = proportionInterval(90, 10)!;
    near(ninetyOfHundred.lower, 0.8256);
    near(ninetyOfHundred.upper, 0.9448);
  });

  it("never produces a zero-width interval, which is the whole point", () => {
    for (const [pos, neg] of [[1, 0], [0, 1], [4, 0], [0, 4], [100, 0]]) {
      const r = proportionInterval(pos, neg)!;
      expect(r.upper - r.lower).toBeGreaterThan(0);
    }
  });

  it("narrows monotonically as evidence accrues at a fixed rate", () => {
    const widths = [10, 40, 100].map((n) => {
      const r = proportionInterval(n * 0.9, n * 0.1)!;
      return r.upper - r.lower;
    });
    expect(widths[1]).toBeLessThan(widths[0]);
    expect(widths[2]).toBeLessThan(widths[1]);
  });

  it("stays inside [0,1] at every sample size", () => {
    for (let n = 1; n <= 60; n++) {
      for (const pos of [0, 1, Math.floor(n / 2), n]) {
        if (pos > n) continue;
        const r = proportionInterval(pos, n - pos)!;
        expect(r.lower).toBeGreaterThanOrEqual(0);
        expect(r.upper).toBeLessThanOrEqual(1);
        expect(r.lower).toBeLessThanOrEqual(r.upper);
      }
    }
  });
});

describe("gateFor", () => {
  it("never gates a fact — a sum is exact at n=1", () => {
    expect(gateFor("fact", 1)).toMatchObject({ meets: true, form: "value" });
    expect(gateFor("fact", 1).gate).toBeNull();
  });

  it("always shows individual runs — at low n the aggregate IS the list", () => {
    expect(gateFor("runRows", 1)).toMatchObject({ meets: true, form: "rows" });
  });

  it("changes the FORM of a proportion rather than suppressing it", () => {
    expect(gateFor("proportion", 0).form).toBe("none");
    expect(gateFor("proportion", 1).form).toBe("outcome");
    expect(gateFor("proportion", 4).form).toBe("countWithInterval");
    expect(gateFor("proportion", 5).form).toBe("rateWithInterval");
  });

  it("shows raw points below the median and mean gates", () => {
    expect(gateFor("median", 4)).toMatchObject({ meets: false, form: "points", gate: 5 });
    expect(gateFor("median", 5)).toMatchObject({ meets: true, form: "value" });
    expect(gateFor("mean", 7)).toMatchObject({ meets: false, form: "points", gate: 8 });
    expect(gateFor("mean", 8)).toMatchObject({ meets: true, form: "valueWithSpread" });
  });

  it("bans tail percentiles at every sample size and routes to the worst run", () => {
    for (const n of [4, 50, 500, 100000]) {
      expect(gateFor("tail", n)).toMatchObject({ meets: false, form: "worstRun" });
    }
  });

  it("refuses to draw a trend line through too few points", () => {
    expect(gateFor("trend", 11)).toMatchObject({ meets: false, form: "points" });
    expect(gateFor("trend", 12)).toMatchObject({ meets: true, form: "line" });
  });

  it("suppresses cohort baselines and statistical anomaly detection at low n", () => {
    expect(gateFor("cohortBaseline", 19).form).toBe("suppress");
    expect(gateFor("cohortBaseline", 20).form).toBe("value");
    expect(gateFor("statisticalAnomaly", 29).form).toBe("ruleThresholds");
    expect(gateFor("statisticalAnomaly", 30).form).toBe("value");
  });

  it("covers every declared pattern", () => {
    for (const p of GATED_PATTERNS) expect(() => gateFor(p, 3)).not.toThrow();
  });
});

describe("deltaAllowed", () => {
  const range = (n: number, lower: number, upper: number) => ({ n, lower, upper });

  it("refuses a delta when either side is below the per-side minimum", () => {
    // The founder's live case: v16 has 1 run, v14 has 3.
    expect(deltaAllowed(range(1, 0.0, 1.0), range(3, 0.2, 0.9))).toBe(false);
    expect(deltaAllowed(range(5, 0.0, 0.1), range(4, 0.8, 0.9))).toBe(false);
  });

  it("refuses a delta when the two sides' ranges overlap", () => {
    expect(deltaAllowed(range(10, 0.4, 0.8), range(10, 0.6, 0.95))).toBe(false);
  });

  it("allows a delta only when both sides are sampled and the ranges are disjoint", () => {
    expect(deltaAllowed(range(10, 0.1, 0.35), range(10, 0.6, 0.95))).toBe(true);
  });

  it("treats touching ranges as overlapping — a difference of exactly zero is not a difference", () => {
    expect(deltaAllowed(range(10, 0.1, 0.5), range(10, 0.5, 0.9))).toBe(false);
  });
});

describe("rangesOverlap", () => {
  it("is symmetric", () => {
    const a = { lower: 0.1, upper: 0.4 };
    const b = { lower: 0.3, upper: 0.9 };
    expect(rangesOverlap(a, b)).toBe(rangesOverlap(b, a));
  });

  it("detects containment", () => {
    expect(rangesOverlap({ lower: 0.1, upper: 0.9 }, { lower: 0.3, upper: 0.4 })).toBe(true);
  });
});

describe("collapsesToNumber", () => {
  // Decision-relevance, not width: the bar collapses when uncertainty can no longer
  // change the verdict. A width threshold would never fire — at n=100 a 90% rate
  // still carries a ~6pp Wilson half-width.
  const bands = [0.5, 0.8];

  it("collapses when the whole interval sits inside one band", () => {
    expect(collapsesToNumber({ lower: 0.85, upper: 0.95 }, bands)).toBe(true);
    expect(collapsesToNumber({ lower: 0.1, upper: 0.45 }, bands)).toBe(true);
  });

  it("keeps the bar when the interval straddles a band edge", () => {
    expect(collapsesToNumber({ lower: 0.75, upper: 0.9 }, bands)).toBe(false);
    expect(collapsesToNumber({ lower: 0.45, upper: 0.55 }, bands)).toBe(false);
  });

  it("separates decision-relevance from width, which is the whole reason for the rule", () => {
    const r = proportionInterval(90, 10)!; // [0.826, 0.945] — 12pp wide at n=100
    expect(r.upper - r.lower).toBeGreaterThan(0.1);
    // A width rule (collapse under ~5pp) would still be drawing a bar here, forever.
    // Decision-relevance collapses it: no band edge falls inside, so the uncertainty
    // cannot change the verdict.
    expect(collapsesToNumber(r, bands)).toBe(true);
    // Move an edge inside the same interval and the bar earns its place again.
    expect(collapsesToNumber(r, [0.5, 0.9])).toBe(false);
  });

  it("collapses with no bands to compare against only when the interval is a point", () => {
    expect(collapsesToNumber({ lower: 0.2, upper: 0.9 }, [])).toBe(true);
  });
});

describe("labelForMeasurementState", () => {
  it("says nothing when the value is measured", () => {
    expect(labelForMeasurementState("measured")).toBeNull();
  });

  it("gives every unmeasured state a distinct, non-empty sentence", () => {
    const seen = new Set<string>();
    for (const state of MEASUREMENT_STATES) {
      if (state === "measured") continue;
      const label = labelForMeasurementState(state)!;
      expect(label.length).toBeGreaterThan(0);
      expect(seen.has(label)).toBe(false);
      seen.add(label);
    }
  });

  it("keeps the copy free of internal jargon", () => {
    for (const state of MEASUREMENT_STATES) {
      const label = labelForMeasurementState(state);
      if (label) expect(label).not.toMatch(/\b(oracle|sensor|verdict|refute|veto|facet|telemetry|null)\b/i);
    }
  });

  it("names the remedy: waiting for runs is different from owing engineering work", () => {
    expect(labelForMeasurementState("insufficient", { needed: 3 })).toMatch(/3 more/);
    expect(labelForMeasurementState("unmeasurable_coverage", { checked: 1, of: 4 })).toMatch(/1 of 4/);
    // The distinction the founder can act on: recorded-but-dropped is urgent
    // (data is being destroyed now); never-recorded is not.
    expect(labelForMeasurementState("uninstrumented", { lossy: true }))
      .not.toBe(labelForMeasurementState("uninstrumented"));
  });

  it("falls back cleanly when the caller has no counts to interpolate", () => {
    expect(labelForMeasurementState("insufficient")).toBeTruthy();
    expect(labelForMeasurementState("unmeasurable_coverage")).toBeTruthy();
  });

  // unmeasurable_structural covers several situations that share a remedy but not
  // a sentence: a self-report nothing can verify, a reasoning step with nothing to
  // execute, a total whose intervals overlap. One hardcoded sentence would state
  // something untrue about two of the three.
  it("lets the caller name what specifically cannot be formed or checked", () => {
    expect(labelForMeasurementState("unmeasurable_structural", {
      reason: "no waiting total — two of these prompts overlap",
    })).toBe("no waiting total — two of these prompts overlap");
  });

  it("asserts no particular cause when the caller names none", () => {
    const fallback = labelForMeasurementState("unmeasurable_structural")!;
    expect(fallback).toBeTruthy();
    // Must not claim self-reporting, which is only one of the situations.
    expect(fallback).not.toMatch(/self|report|execut/i);
  });

  it("refuses to claim a value is unrecorded when we only know it is absent", () => {
    const unknown = labelForMeasurementState("unknown")!;
    const uninstrumented = labelForMeasurementState("uninstrumented")!;
    expect(unknown).not.toBe(uninstrumented);
    // Must not assert the stronger claim.
    expect(unknown).toMatch(/haven't established/i);
  });

  it("frames a per-side shortfall against its own threshold and unit", () => {
    expect(labelForMeasurementState("insufficient", { have: 3, need: 5, unit: "runs per version" }))
      .toBe("Needs 5 runs per version; this has 3.");
    expect(labelForMeasurementState("insufficient", { have: 2, need: 5 }))
      .toBe("Needs 5 runs; this has 2.");
  });
});
