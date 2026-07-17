// apps/daemon/src/harness-sensors/detect.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import type { WorkflowSensorKind } from "@orca/contracts";

export type DetectedSensor = {
  kind: WorkflowSensorKind;
  command: string;
  args: string[];
};

// Maps a guardrail `required` label to (sensor kind, package.json script name).
// Registry is the single source; runner.ts consumes it too. Ordered cheapest-first
// so the runner can fail fast.
export type SensorSpec = { kind: WorkflowSensorKind; label: string; script: string };

const SENSOR_REGISTRY: SensorSpec[] = [];
function defineSensor(spec: SensorSpec): SensorSpec {
  SENSOR_REGISTRY.push(spec);
  return spec;
}

// Ordered cheapest-first for fail-fast: typecheck/lint/static are quick checks,
// unit is mid, integration and build are the heaviest.
defineSensor({ kind: "typecheck", label: "typecheck", script: "typecheck" });
defineSensor({ kind: "lint", label: "lint", script: "lint" });
defineSensor({ kind: "static", label: "static_analysis", script: "static" });
defineSensor({ kind: "unit", label: "unit_tests", script: "test" });
defineSensor({ kind: "integration", label: "integration_tests", script: "test:integration" });
defineSensor({ kind: "build", label: "build", script: "build" });

export const HARNESS_SENSORS: readonly SensorSpec[] = SENSOR_REGISTRY;

// Declared-but-unimplemented kinds. Listing them here (rather than silently
// omitting) is what the conformance guard checks — adding a new WorkflowSensorKind
// forces a register-or-defer decision instead of silent drift. The full ladder is
// now registered; this stays as the seam for any future kind.
export const UNIMPLEMENTED_SENSOR_KINDS: readonly WorkflowSensorKind[] = [];

function readScripts(workspacePath: string): Record<string, string> {
  try {
    const raw = readFileSync(path.join(workspacePath, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

export function detectSensors(workspacePath: string, required: string[]): DetectedSensor[] {
  const scripts = readScripts(workspacePath);
  const out: DetectedSensor[] = [];
  for (const entry of HARNESS_SENSORS) {
    if (!required.includes(entry.label)) continue;
    if (typeof scripts[entry.script] !== "string") continue;
    out.push({ kind: entry.kind, command: "npm", args: ["run", entry.script] });
  }
  return out;
}

/** Sensor kinds whose package.json script exists in the workspace, regardless of
 *  guardrail `required` — i.e. what verification COULD run here. */
export function availableSensorKinds(workspacePath: string): WorkflowSensorKind[] {
  const scripts = readScripts(workspacePath);
  return HARNESS_SENSORS.filter((entry) => typeof scripts[entry.script] === "string").map((e) => e.kind);
}
