import { join } from "node:path";
import { extractActionBlock } from "../sentinel.js";
import { buildShadowHookSettings } from "../shadow-hook-settings.js";
import { buildAgentHookSettings } from "../../agent-hooks/hook-settings.js";
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

  workerHookConfig(args: { goalId: string; sessionId: string; port: number; authToken: string; configDir: string }) {
    // goalId is part of the shared seam signature; Claude's worker hooks key off
    // sessionId only (the daemon resolves goal from session), so it's unused here.
    const settings = buildAgentHookSettings({ sessionId: args.sessionId, port: args.port, authToken: args.authToken });
    return {
      files: [{ relPath: "settings.json", contents: JSON.stringify(settings, null, 2) }],
      spawnArgs: ["--settings", join(args.configDir, "settings.json")],
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
