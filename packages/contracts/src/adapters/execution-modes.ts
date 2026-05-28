import { z } from "zod";
import { AdapterId } from "./ids.js";

export const ExecutionMode = z.enum(["shadow_session", "one_shot"]);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

export const EnabledExecutionModeEntry = z
  .object({
    mode: ExecutionMode,
    preferred: z.boolean().optional(),
  })
  .strict();
export type EnabledExecutionModeEntry = z.infer<typeof EnabledExecutionModeEntry>;

export const DisabledExecutionModeEntry = z
  .object({
    mode: ExecutionMode,
    reason: z.string().min(1).max(500),
  })
  .strict();
export type DisabledExecutionModeEntry = z.infer<typeof DisabledExecutionModeEntry>;

export const AdapterExecutionModeConfig = z
  .object({
    adapterId: AdapterId,
    enabledExecutionModes: z.array(EnabledExecutionModeEntry).max(8),
    disabledExecutionModes: z.array(DisabledExecutionModeEntry).max(8),
  })
  .strict();
export type AdapterExecutionModeConfig = z.infer<typeof AdapterExecutionModeConfig>;

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string };

export function validateAdapterExecutionModeConfig(
  config: AdapterExecutionModeConfig,
  supportedModes: ExecutionMode[]
): ValidationResult {
  const supported = new Set(supportedModes);
  if (config.enabledExecutionModes.length === 0) {
    return { ok: false, reason: "enabledExecutionModes must be non-empty" };
  }

  const preferredCount = config.enabledExecutionModes.filter((e) => e.preferred === true).length;
  if (preferredCount !== 1) {
    return {
      ok: false,
      reason: `enabledExecutionModes must contain exactly one preferred entry (found ${preferredCount})`,
    };
  }

  const enabledModes = new Set(config.enabledExecutionModes.map((e) => e.mode));
  const disabledModes = new Set(config.disabledExecutionModes.map((e) => e.mode));
  for (const mode of enabledModes) {
    if (disabledModes.has(mode)) {
      return { ok: false, reason: `mode ${mode} cannot be both enabled and disabled` };
    }
  }

  for (const e of config.enabledExecutionModes) {
    if (!supported.has(e.mode)) {
      return { ok: false, reason: `mode ${e.mode} not supported by adapter ${config.adapterId}` };
    }
  }

  return { ok: true };
}
