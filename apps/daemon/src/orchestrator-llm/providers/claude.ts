import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  permissionRule(toolName: string, toolInput: unknown): string | null {
    const input = (toolInput ?? {}) as Record<string, unknown>;
    if (toolName === "Bash") {
      const cmd = typeof input.command === "string" ? input.command.trim() : "";
      const firstToken = cmd.split(/\s+/)[0] ?? "";
      return firstToken ? `Bash(${firstToken}:*)` : null;
    }
    if (toolName === "Read" || toolName === "Edit" || toolName === "Write") {
      const p = typeof input.file_path === "string" ? input.file_path : "";
      return p ? `${toolName}(${p})` : null;
    }
    if (toolName === "NotebookEdit") {
      const p = typeof input.notebook_path === "string" ? input.notebook_path : "";
      return p ? `NotebookEdit(${p})` : null;
    }
    if (toolName === "WebFetch") {
      const url = typeof input.url === "string" ? input.url : "";
      try {
        const host = new URL(url).host;
        return host ? `WebFetch(domain:${host})` : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  writePermissionRule(workspacePath: string, rule: string): void {
    const dir = join(workspacePath, ".claude");
    const file = join(dir, "settings.local.json");
    let json: Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        // Only a plain object is a valid settings file; an array/primitive is not
        // something we understand — leave it untouched rather than clobber it.
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        json = parsed as Record<string, unknown>;
      } catch {
        return; // malformed — never clobber the user's file
      }
    }
    const permissions = (typeof json.permissions === "object" && json.permissions !== null)
      ? (json.permissions as Record<string, unknown>)
      : {};
    const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : [];
    if (allow.includes(rule)) return; // dedupe
    allow.push(rule);
    permissions.allow = allow;
    json.permissions = permissions;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, "utf8");
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
