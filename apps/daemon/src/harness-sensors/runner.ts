// apps/daemon/src/harness-sensors/runner.ts
import type { EvidenceFacet, SensorResult } from "@orca/contracts";
import { runCheckCommand } from "../readiness/exec.js";
import { inheritCredEnv } from "../readiness/exec.js";
import { detectSensors } from "./detect.js";

const SENSOR_TIMEOUT_MS = 180_000; // tests/typecheck need far longer than the 5s readiness default
const SUMMARY_MAX = 4000;

function summarize(stdout: string, stderr: string): string {
  const tail = (stderr + "\n" + stdout).trim();
  return tail.length > SUMMARY_MAX ? tail.slice(tail.length - SUMMARY_MAX) : tail;
}

export async function runSensors(opts: {
  workspacePath: string;
  required: string[];
  timeoutMs?: number;
}): Promise<EvidenceFacet> {
  const sensors = detectSensors(opts.workspacePath, opts.required);
  const detectedLabels = new Set(sensors.map((s) => s.kind));
  const sensorsRun: SensorResult[] = [];

  let failed = false;
  for (const sensor of sensors) {
    const res = await runCheckCommand(sensor.command, sensor.args, {
      cwd: opts.workspacePath,
      timeoutMs: opts.timeoutMs ?? SENSOR_TIMEOUT_MS,
      env: inheritCredEnv(),
    });
    const result: SensorResult["result"] = res.timedOut
      ? "failed"
      : res.exitCode === 0
        ? "passed"
        : "failed";
    sensorsRun.push({
      kind: sensor.kind,
      command: `${sensor.command} ${sensor.args.join(" ")}`,
      exitCode: res.exitCode ?? null,
      durationMs: res.durationMs,
      result,
      summary: summarize(res.stdout, res.stderr),
      artifactRef: null, // P2.5: offload full output; summary suffices for the veto
    });
    if (result === "failed") {
      failed = true;
      break; // fail-fast: a cheap failure pre-empts the expensive sensors
    }
  }

  // A required label maps to a sensor kind via detect.ts's LABEL_TO_SCRIPT.
  const requiredKinds: Array<{ label: string; kind: SensorResult["kind"] }> = [
    { label: "typecheck", kind: "typecheck" },
    { label: "lint", kind: "lint" },
    { label: "unit_tests", kind: "unit" },
    { label: "build", kind: "build" },
  ];
  const gaps: string[] = [];
  for (const rk of requiredKinds) {
    if (!opts.required.includes(rk.label)) continue;
    if (!detectedLabels.has(rk.kind)) gaps.push(`${rk.label}: no matching script`);
  }

  const missingRequired = gaps.length > 0;
  const verdict: EvidenceFacet["verdict"] = failed
    ? "failed"
    : missingRequired
      ? "partial"
      : "passed";

  const passedAllRequired =
    !failed &&
    !missingRequired &&
    sensorsRun.every((s) => s.result === "passed");

  return {
    sensorsRun,
    verdict,
    untestedRegions: [],
    residualRisk: [],
    oracleAdequacy: { sufficient: passedAllRequired, gaps },
  };
}
