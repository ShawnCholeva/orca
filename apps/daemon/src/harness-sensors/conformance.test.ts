import { describe, expect, it } from "vitest";
import { WorkflowSensorKind } from "@orca/contracts";
import { HARNESS_SENSORS, UNIMPLEMENTED_SENSOR_KINDS } from "./detect.js";
import { assertSensorConformance } from "./conformance.js";

describe("sensor registry conformance", () => {
  it("covers every WorkflowSensorKind as registered-or-unimplemented", () => {
    const covered = new Set<string>([
      ...HARNESS_SENSORS.map((s) => s.kind),
      ...UNIMPLEMENTED_SENSOR_KINDS,
    ]);
    for (const kind of WorkflowSensorKind.options) expect(covered.has(kind)).toBe(true);
    expect(() => assertSensorConformance()).not.toThrow();
  });

  it("declares integration and static as explicitly unimplemented", () => {
    expect([...UNIMPLEMENTED_SENSOR_KINDS].sort()).toEqual(["integration", "static"]);
  });
});
