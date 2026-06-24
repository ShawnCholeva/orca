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
// Ordered cheapest-first so the runner can fail fast.
export const LABEL_TO_SCRIPT: Array<{ label: string; kind: WorkflowSensorKind; script: string }> = [
  { label: "typecheck", kind: "typecheck", script: "typecheck" },
  { label: "lint", kind: "lint", script: "lint" },
  { label: "unit_tests", kind: "unit", script: "test" },
  { label: "build", kind: "build", script: "build" },
];

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
  for (const entry of LABEL_TO_SCRIPT) {
    if (!required.includes(entry.label)) continue;
    if (typeof scripts[entry.script] !== "string") continue;
    out.push({ kind: entry.kind, command: "npm", args: ["run", entry.script] });
  }
  return out;
}
