import { describe, expect, it } from "vitest";
import { deriveEvidenceScope } from "./scope.js";
import type { SensorResult } from "@orca/contracts";

const sensor = (kind: SensorResult["kind"]): SensorResult => ({
  kind, command: "npm run x", exitCode: 0, durationMs: 1, result: "passed", summary: "", artifactRef: null,
});

describe("deriveEvidenceScope", () => {
  it("code changed, nothing executed → gap + per-file untested + residual risk", () => {
    const r = deriveEvidenceScope({ writeSet: ["src/calc.js", "README.md"], availableSensors: ["unit"], ranSensors: [] });
    expect(r.gaps).toContain("code changed but nothing executed it");
    expect(r.gaps).toContain("unit tests are available here but none ran over this change");
    expect(r.untestedRegions).toContain("src/calc.js — changed, no test or check ran over it");
    expect(r.untestedRegions.some((u) => u.includes("README.md"))).toBe(false); // non-code file not listed
    expect(r.residualRisk.length).toBeGreaterThan(0);
  });

  it("non-code output, no execution → 'nothing was executed to check this', NOT dinged for unrun sensors", () => {
    const r = deriveEvidenceScope({ writeSet: ["docs/plan.md"], availableSensors: ["unit", "typecheck"], ranSensors: [] });
    expect(r.gaps).toContain("nothing was executed to check this — semantic correctness is unverified");
    expect(r.gaps.some((g) => g.includes("available here but none ran"))).toBe(false); // gated on code write-set
    expect(r.untestedRegions).toContain("semantic correctness — nothing was executed");
  });

  it("code changed, some sensors ran → no per-file untested; unran available sensor still a gap", () => {
    const r = deriveEvidenceScope({ writeSet: ["src/a.ts"], availableSensors: ["unit", "lint"], ranSensors: [sensor("unit")] });
    expect(r.untestedRegions).toEqual([]); // something executed
    expect(r.gaps).toContain("lint is available here but none ran over this change");
    expect(r.gaps.some((g) => g.includes("unit"))).toBe(false); // unit DID run
  });

  it("no jargon; caps applied", () => {
    const many = Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`);
    const r = deriveEvidenceScope({ writeSet: many, availableSensors: [], ranSensors: [] });
    expect(r.untestedRegions.length).toBeLessThanOrEqual(64);
    // Derived strings render in the UI, so they must pass the same no-jargon bar as Phase 1.
    expect(JSON.stringify(r)).not.toMatch(/\b(oracle|sensor|verdict|refute|veto)\b/i);
  });
});
