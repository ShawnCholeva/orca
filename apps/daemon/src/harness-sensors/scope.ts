import type { SensorResult, WorkflowSensorKind } from "@orca/contracts";
import { isCodeFile } from "./code-files.js";

// Plain-language "available but unran" gap phrasing per sensor kind (no jargon).
// Written per-kind (rather than a shared template) so singular labels ("lint",
// "the build") and plural labels ("unit tests") each get grammatically correct
// subject-verb agreement.
const SENSOR_GAP_PHRASE: Record<WorkflowSensorKind, string> = {
  typecheck: "type checks are available here but none ran over this change",
  lint: "lint is available here but none ran over this change",
  unit: "unit tests are available here but none ran over this change",
  integration: "integration tests are available here but none ran over this change",
  build: "the build is available here but none ran over this change",
  static: "static analysis is available here but none ran over this change",
};

const REGION_CAP = 64;
const STR_CAP = 512;
const capList = (xs: string[]): string[] => [...new Set(xs.map((x) => x.slice(0, STR_CAP)))].slice(0, REGION_CAP);

export function deriveEvidenceScope(input: {
  writeSet: string[];
  availableSensors: WorkflowSensorKind[];
  ranSensors: SensorResult[];
}): { untestedRegions: string[]; gaps: string[]; residualRisk: string[] } {
  const ran = new Set(input.ranSensors.map((s) => s.kind));
  const hasExecutionOracle = input.ranSensors.length > 0;
  const codeFiles = input.writeSet.filter(isCodeFile);
  const gaps: string[] = [];
  const untestedRegions: string[] = [];
  const residualRisk: string[] = [];

  if (codeFiles.length > 0) {
    // Diversity gaps: verification that exists here but didn't run over this change.
    for (const kind of input.availableSensors) {
      if (!ran.has(kind)) gaps.push(SENSOR_GAP_PHRASE[kind]);
    }
    if (!hasExecutionOracle) {
      gaps.push("code changed but nothing executed it");
      for (const f of codeFiles) untestedRegions.push(`${f} — changed, no test or check ran over it`);
      residualRisk.push("a change could ship with a defect no check would catch");
    }
  } else if (!hasExecutionOracle) {
    // Non-code output with no execution: the whole semantic surface is unverified.
    // (No "oracle"/"sensor"/etc. — these strings render in the UI and must pass no-jargon.)
    gaps.push("nothing was executed to check this — semantic correctness is unverified");
    untestedRegions.push("semantic correctness — nothing was executed");
    untestedRegions.push("runtime behavior");
  }

  return { untestedRegions: capList(untestedRegions), gaps: capList(gaps), residualRisk: capList(residualRisk) };
}
