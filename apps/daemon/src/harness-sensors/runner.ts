// apps/daemon/src/harness-sensors/runner.ts
import type { EvidenceFacet, SensorResult } from "@orca/contracts";
import { runCheckCommand } from "../readiness/exec.js";
import { inheritCredEnv } from "../readiness/exec.js";
import { detectSensors, HARNESS_SENSORS, isNoOpScript } from "./detect.js";

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
  const stubbed: string[] = [];
  for (const sensor of sensors) {
    // A script that provably cannot fail is not a passing check — it is the
    // absence of one. Record it as `skipped` (never `passed`) and let it raise an
    // oracle gap, so it can neither credit `executable` nor lift the tier.
    if (isNoOpScript(sensor.scriptBody)) {
      sensorsRun.push({
        kind: sensor.kind,
        command: `${sensor.command} ${sensor.args.join(" ")}`,
        exitCode: null,
        durationMs: 0,
        result: "skipped",
        summary: `Not run: the script is a no-op stub (\`${sensor.scriptBody}\`), so it exercises nothing and can only exit 0.`,
        artifactRef: null,
      });
      stubbed.push(sensor.kind);
      continue;
    }
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

  const gaps: string[] = [];
  for (const entry of HARNESS_SENSORS) {
    if (!opts.required.includes(entry.label)) continue;
    if (!detectedLabels.has(entry.kind)) gaps.push(`${entry.label}: no matching script`);
    else if (stubbed.includes(entry.kind)) gaps.push(`${entry.label}: the script is a no-op stub, so nothing was checked`);
  }

  const missingRequired = gaps.length > 0;
  const verdict: EvidenceFacet["verdict"] = failed
    ? "failed"
    : missingRequired
      ? "partial"
      : "passed";

  // A skipped stub is not a pass. Requiring every sensor to have actually passed
  // keeps `sufficient` false whenever any required check was a no-op.
  const passedAllRequired =
    !failed &&
    !missingRequired &&
    sensorsRun.length > 0 &&
    sensorsRun.every((s) => s.result === "passed");

  return {
    sensorsRun,
    verdict,
    untestedRegions: [],
    residualRisk: [],
    oracleAdequacy: { sufficient: passedAllRequired, gaps },
  };
}
