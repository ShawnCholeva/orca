// apps/daemon/src/harness-sensors/detect.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectSensors } from "./detect.js";

const dirs: string[] = [];
function workspaceWith(scripts: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-detect-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts }));
  return dir;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("detectSensors", () => {
  it("maps required labels to package.json scripts, cheapest-first", () => {
    const ws = workspaceWith({ typecheck: "tsc --noEmit", test: "vitest run" });
    const sensors = detectSensors(ws, ["unit_tests", "typecheck"]);
    expect(sensors.map((s) => s.kind)).toEqual(["typecheck", "unit"]);
    expect(sensors[0]!.command).toBe("npm");
    expect(sensors[0]!.args).toEqual(["run", "typecheck"]);
  });

  it("omits a required label that has no matching script", () => {
    const ws = workspaceWith({ test: "vitest run" });
    const sensors = detectSensors(ws, ["typecheck", "unit_tests"]);
    expect(sensors.map((s) => s.kind)).toEqual(["unit"]);
  });

  it("returns nothing when there is no package.json", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-detect-empty-"));
    dirs.push(dir);
    expect(detectSensors(dir, ["typecheck"])).toEqual([]);
  });
});
