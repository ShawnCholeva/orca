import { describe, expect, it } from "vitest";
import { gradeFor, healthOf, pctLabel } from "./metrics-data";
import type { TemplateMetricsSummary } from "@orca/contracts";

describe("metrics-data formatting helpers", () => {
  it("gradeFor maps scores to letters", () => {
    expect(gradeFor(95)).toBe("A");
    expect(gradeFor(61)).toBe("D");
    expect(gradeFor(40)).toBe("F");
  });

  it("healthOf reads verificationStrength as a 0..100 health", () => {
    const summary = { dimensions: { verificationStrength: { value: 0.82 } } } as TemplateMetricsSummary;
    expect(healthOf(summary)).toBe(82);
  });

  it("pctLabel renders a 0..1 metric as a percentage, or — when null", () => {
    expect(pctLabel({ value: 0.64 })).toBe("64%");
    expect(pctLabel({ value: null })).toBe("—");
  });
});
