import { describe, expect, it } from "vitest";
import { CompositionFacet, HARNESS_FACETS, HarnessTransitionBoundary } from "./index.js";

describe("composition facet", () => {
  it("parses a join composition facet with verdict + scope", () => {
    const f = CompositionFacet.parse({
      childRunId: "r2", childTemplateId: "orca/code-review", childTemplateVersion: 3,
      readsKeys: ["diff_ref"], writesKeys: ["review_findings"], depth: 1, costRollupUsd: 0.12,
      childVerdict: "passed", childUntestedRegions: [], childResidualRisk: [],
      beliefDivergence: { diverged: false }, verifyResult: { ran: false, vetoed: false },
    });
    expect(f.childVerdict).toBe("passed");
  });

  it("registers the composition facet + delegate boundaries", () => {
    expect(HARNESS_FACETS.some((x) => x.key === "composition")).toBe(true);
    expect(HarnessTransitionBoundary.safeParse("delegate_spawn").success).toBe(true);
    expect(HarnessTransitionBoundary.safeParse("delegate_join").success).toBe(true);
  });
});
