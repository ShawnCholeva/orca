import { describe, expect, it } from "vitest";
import { getWorkflowMetrics, getLearningLog, gradeFor, statusMeta } from "./metrics-data";

describe("metrics-data", () => {
  it("returns at least three workflows, each with steps", () => {
    const wfs = getWorkflowMetrics();
    expect(wfs.length).toBeGreaterThanOrEqual(3);
    for (const wf of wfs) {
      expect(wf.steps.length).toBeGreaterThan(0);
    }
  });

  it("exposes a learning log with known event types", () => {
    const log = getLearningLog();
    expect(log.length).toBeGreaterThan(0);
    for (const e of log) {
      expect(["applied", "observed", "proposed", "reverted"]).toContain(e.type);
    }
  });

  it("grades by score boundaries", () => {
    expect(gradeFor(95)).toBe("A");
    expect(gradeFor(85)).toBe("B");
    expect(gradeFor(75)).toBe("C");
    expect(gradeFor(65)).toBe("D");
    expect(gradeFor(40)).toBe("F");
  });

  it("maps every status to a tone", () => {
    expect(statusMeta.healthy.tone).toBe("run");
    expect(statusMeta.watch.tone).toBe("warn");
    expect(statusMeta.degraded.tone).toBe("err");
  });
});
