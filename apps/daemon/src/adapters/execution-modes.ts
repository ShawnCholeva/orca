import type { AdapterExecutionModeConfig, AdapterId } from "@orca/contracts";

export const ADAPTER_EXECUTION_MODE_DEFAULTS: Record<AdapterId, AdapterExecutionModeConfig> = {
  "claude-code": {
    adapterId: "claude-code",
    enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
    disabledExecutionModes: [
      {
        mode: "one_shot",
        reason: "post 2026-06-15 the -p flag bills against API budget; shadow_session uses interactive subscription",
      },
    ],
  },
  codex: {
    adapterId: "codex",
    enabledExecutionModes: [
      { mode: "one_shot", preferred: true },
      { mode: "shadow_session" },
    ],
    disabledExecutionModes: [],
  },
  opencode: {
    adapterId: "opencode",
    enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
    disabledExecutionModes: [
      { mode: "one_shot", reason: "adapter does not implement one-shot yet" },
    ],
  },
  "gemini-cli": {
    adapterId: "gemini-cli",
    enabledExecutionModes: [{ mode: "one_shot", preferred: true }],
    disabledExecutionModes: [],
  },
  "shell-manual": {
    adapterId: "shell-manual",
    enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
    disabledExecutionModes: [],
  },
};
