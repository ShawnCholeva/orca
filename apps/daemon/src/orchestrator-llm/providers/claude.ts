import { extractActionBlock } from "../sentinel.js";
import { buildShadowHookSettings } from "../shadow-hook-settings.js";
import type {
  ShadowCaptureMode,
  ShadowHookConfig,
  ShadowLaunch,
  ShadowProvider,
  ShadowTurnParse,
} from "./types.js";

export class ClaudeShadowProvider implements ShadowProvider {
  readonly id = "claude-code" as const;
  readonly displayName = "Claude Code";
  readonly modelProviderId = "orca/anthropic";

  launch(deps: { binOverride?: string }): ShadowLaunch {
    return { bin: deps.binOverride ?? process.env["ORCA_CLAUDE_CODE_BIN"] ?? "claude" };
  }

  hookConfig(args: { goalId: string; port: number; authToken: string }): ShadowHookConfig {
    return {
      files: [
        {
          relPath: ".claude/settings.local.json",
          contents: JSON.stringify(buildShadowHookSettings(args), null, 2),
        },
      ],
    };
  }

  captureMode(): ShadowCaptureMode {
    return { kind: "hook" };
  }

  turnParser(): ShadowTurnParse {
    return {
      parseAction: (turnText) => extractActionBlock(turnText),
    };
  }
}
