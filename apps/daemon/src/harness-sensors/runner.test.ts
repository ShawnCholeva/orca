// apps/daemon/src/harness-sensors/runner.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSensors } from "./runner.js";

const dirs: string[] = [];
// A workspace whose `typecheck`/`test` scripts are deterministic node exits.
function workspace(scripts: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-runner-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts }));
  return dir;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("runSensors", () => {
  it("passes when the sensor command exits 0", async () => {
    const ws = workspace({ typecheck: "node -e \"process.exit(0)\"" });
    const ev = await runSensors({ workspacePath: ws, required: ["typecheck"] });
    expect(ev.verdict).toBe("passed");
    expect(ev.sensorsRun).toHaveLength(1);
    expect(ev.sensorsRun[0]!.result).toBe("passed");
    expect(ev.oracleAdequacy.sufficient).toBe(true);
  }, 20000);

  it("fails and stops fast when a cheap sensor exits non-zero", async () => {
    const ws = workspace({
      typecheck: "node -e \"process.exit(1)\"",
      test: "node -e \"process.exit(0)\"",
    });
    const ev = await runSensors({ workspacePath: ws, required: ["unit_tests", "typecheck"] });
    expect(ev.verdict).toBe("failed");
    // Fail-fast: typecheck (cheapest) ran and failed; unit never ran.
    expect(ev.sensorsRun.map((s) => s.kind)).toEqual(["typecheck"]);
    expect(ev.oracleAdequacy.sufficient).toBe(false);
  }, 20000);

  it("is partial with a gap when a required label has no script", async () => {
    const ws = workspace({ typecheck: "node -e \"process.exit(0)\"" });
    const ev = await runSensors({ workspacePath: ws, required: ["typecheck", "unit_tests"] });
    expect(ev.verdict).toBe("partial");
    expect(ev.oracleAdequacy.sufficient).toBe(false);
    expect(ev.oracleAdequacy.gaps.join(" ")).toContain("unit_tests");
  }, 20000);
});

describe("no-op stub scripts", () => {
  it("records a stub as skipped, never passed, and refuses oracle sufficiency", async () => {
    // Observed live: `"typecheck": "echo no types"` exited 0 and was recorded as a
    // passing deterministic sensor, while the AGENT correctly classified it as
    // skipped ("it exercises no type checker, so it provides no signal"). That
    // inverts the Executable axis — the oracle the self-report is checked against
    // became the softer of the two.
    const ws = workspace({ typecheck: "echo no types" });
    const ev = await runSensors({ workspacePath: ws, required: ["typecheck"] });
    expect(ev.sensorsRun[0]!.result).toBe("skipped");
    expect(ev.sensorsRun[0]!.exitCode).toBeNull();
    expect(ev.sensorsRun[0]!.summary).toContain("no-op stub");
    expect(ev.oracleAdequacy.sufficient).toBe(false);
    expect(ev.oracleAdequacy.gaps.join(" ")).toContain("nothing was checked");
    expect(ev.verdict).toBe("partial");
  }, 20000);

  it("still credits a real check that runs alongside a stub", async () => {
    const ws = workspace({ typecheck: "echo no types", test: "node -e \"process.exit(0)\"" });
    const ev = await runSensors({ workspacePath: ws, required: ["typecheck", "unit_tests"] });
    const byKind = new Map(ev.sensorsRun.map((s) => [s.kind, s.result]));
    expect(byKind.get("typecheck")).toBe("skipped");
    expect(byKind.get("unit")).toBe("passed");
    // The real test ran, but a required check was a no-op, so the oracle is not
    // sufficient — partial evidence, honestly labelled.
    expect(ev.oracleAdequacy.sufficient).toBe(false);
  }, 20000);

  it("does not skip a script that merely starts with echo", async () => {
    // `echo x && <real command>` contains something that can fail. Detection is
    // narrow on purpose: over-skipping a real check suppresses real evidence.
    const ws = workspace({ typecheck: "echo starting && node -e \"process.exit(0)\"" });
    const ev = await runSensors({ workspacePath: ws, required: ["typecheck"] });
    expect(ev.sensorsRun[0]!.result).toBe("passed");
    expect(ev.oracleAdequacy.sufficient).toBe(true);
  }, 20000);
});
