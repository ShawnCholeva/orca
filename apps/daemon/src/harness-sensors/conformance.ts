import { WorkflowSensorKind } from "@orca/contracts";
import { HARNESS_SENSORS, UNIMPLEMENTED_SENSOR_KINDS } from "./detect.js";

/**
 * Every WorkflowSensorKind must be either registered (has a detector/script) or
 * explicitly declared unimplemented — and never both. Closes the integration/static
 * declared-but-dead drift; forces a decision when a kind is added.
 */
export function assertSensorConformance(): void {
  const registered = new Set(HARNESS_SENSORS.map((s) => s.kind));
  const unimplemented = new Set(UNIMPLEMENTED_SENSOR_KINDS);
  for (const kind of WorkflowSensorKind.options) {
    if (!registered.has(kind) && !unimplemented.has(kind)) {
      throw new Error(`Sensor drift: kind '${kind}' is neither registered nor declared unimplemented`);
    }
  }
  for (const kind of UNIMPLEMENTED_SENSOR_KINDS) {
    if (registered.has(kind)) {
      throw new Error(`Sensor drift: kind '${kind}' is both registered and declared unimplemented`);
    }
  }
}
