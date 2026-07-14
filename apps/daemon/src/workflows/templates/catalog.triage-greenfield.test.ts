import { describe, expect, it } from "vitest";
import type { GroundingCheck } from "@orca/contracts";

import { evaluateGrounding } from "../../harness-sensors/grounding.js";
import { BUILTIN_TEMPLATE_CATALOG } from "./catalog.js";

// OBS-6: Triage must represent the codebase honestly (a `codebase_state` field,
// not a vacuously-true `has_code_understanding` boolean) and must never let a
// greenfield/from-scratch goal route to `approach_only` (skipping Clarify +
// Research). The deterministic grounding gate is the enforcement point.

const triageGrounding: GroundingCheck[] = (() => {
  const def = BUILTIN_TEMPLATE_CATALOG.find((d) => d.id === "orca/adaptive-delivery");
  const triage = def?.steps.find((s) => s.id === "triage");
  return (triage?.grounding ?? []) as GroundingCheck[];
})();

function grade(output: Record<string, unknown>) {
  return evaluateGrounding({
    checks: triageGrounding,
    output,
    readPriorOutput: () => null,
    probe: null, // no path checks needed here (known_files omitted)
  }).verdict;
}

describe("Triage greenfield routing gate", () => {
  it("exposes an honest codebase_state field instead of has_code_understanding", () => {
    const def = BUILTIN_TEMPLATE_CATALOG.find((d) => d.id === "orca/adaptive-delivery")!;
    const triage = def.steps.find((s) => s.id === "triage")!;
    const keys = triage.outputSchema.map((f) => f.key);
    expect(keys).toContain("codebase_state");
    expect(keys).not.toContain("has_code_understanding");
    const codebase = triage.outputSchema.find((f) => f.key === "codebase_state")!;
    expect(codebase.enum).toEqual(["greenfield", "existing_ungrounded", "existing_understood"]);
  });

  it("REJECTS approach_only for a greenfield goal (no skipping Clarify + Research)", () => {
    expect(
      grade({ recommended_tier: "approach_only", codebase_state: "greenfield", has_product_intent: true })
    ).toBe("failed");
  });

  it("REJECTS approach_only when relevant code exists but is not yet grounded", () => {
    expect(
      grade({ recommended_tier: "approach_only", codebase_state: "existing_ungrounded", has_product_intent: true })
    ).toBe("failed");
  });

  it("ALLOWS approach_only only when the existing code is already understood", () => {
    expect(
      grade({ recommended_tier: "approach_only", codebase_state: "existing_understood", has_product_intent: true })
    ).toBe("passed");
  });

  it("ALLOWS ground_and_design for a greenfield goal", () => {
    expect(
      grade({ recommended_tier: "ground_and_design", codebase_state: "greenfield", has_product_intent: true })
    ).toBe("passed");
  });

  it("ALLOWS ground_and_design when code exists but is ungrounded", () => {
    expect(
      grade({ recommended_tier: "ground_and_design", codebase_state: "existing_ungrounded", has_product_intent: true })
    ).toBe("passed");
  });

  it("REJECTS ground_and_design when the code is already understood (that is approach_only territory)", () => {
    expect(
      grade({ recommended_tier: "ground_and_design", codebase_state: "existing_understood", has_product_intent: true })
    ).toBe("failed");
  });

  it("ALLOWS clarify_first when product intent is absent", () => {
    expect(
      grade({ recommended_tier: "clarify_first", codebase_state: "greenfield", has_product_intent: false })
    ).toBe("passed");
  });
});
