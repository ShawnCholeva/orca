import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractActionBlock } from "../sentinel.js";
import { buildShadowHookSettings } from "../shadow-hook-settings.js";
import { buildAgentHookSettings } from "../../agent-hooks/hook-settings.js";
import type {
  ProviderTerminalFailure,
  ShadowCaptureMode,
  ShadowHookConfig,
  ShadowLaunch,
  ShadowProvider,
  ShadowTurnParse,
} from "./types.js";
import type { TmuxRunner } from "../../tmux/runner.js";

const CLAUDE_SESSION_LIMIT =
  /hit your session limit|session limit[\s\S]{0,80}resets/i;
const CLAUDE_RESET = /resets\s+(\d{1,2}:\d{2}\s*(?:am|pm))(?:\s*\(([^)]+)\))?/i;

function resolveNextZonedTime(clockText: string, timezone: string, detectedAt: Date): string | null {
  // Validate the IANA timezone by attempting to use it.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return null;
  }

  // Parse the 12-hour clock text (e.g. "4:20am").
  const m = clockText.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
  if (!m) return null;
  let hours = parseInt(m[1]!, 10);
  const minutes = parseInt(m[2]!, 10);
  const meridiem = m[3]!.toLowerCase();
  if (meridiem === "am") {
    if (hours === 12) hours = 0;
  } else {
    if (hours !== 12) hours += 12;
  }

  // Get the current date in the target timezone to determine the calendar date to try.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localDateStr = fmt.format(detectedAt); // e.g. "2026-06-12"
  const [year, month, day] = localDateStr.split("-").map(Number) as [number, number, number];

  // Build the candidate reset time in the target timezone.
  // Use a UTC-based approach: find UTC ms for the clock time in the timezone.
  function zonedToUtcMs(y: number, mo: number, d: number, h: number, min: number): number {
    // Create a UTC instant that represents the given wall-clock time in `timezone`.
    // Strategy: format a known UTC instant through the timezone and adjust until it matches.
    // We use the trick of formatting with parts to find the offset at a specific moment.
    const candidate = Date.UTC(y, mo - 1, d, h, min, 0, 0);
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    // Two-pass: get local time at candidate, compute offset, then pinpoint.
    const parts = dtf.formatToParts(new Date(candidate));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
    const lh = parseInt(get("hour"), 10) % 24;
    const lm = parseInt(get("minute"), 10);
    const ld = parseInt(get("day"), 10);
    const lmo = parseInt(get("month"), 10);
    const ly = parseInt(get("year"), 10);
    const localMs = Date.UTC(ly, lmo - 1, ld, lh, lm, 0, 0);
    const offset = candidate - localMs; // UTC - local = offset
    return Date.UTC(y, mo - 1, d, h, min, 0, 0) + offset;
  }

  let resetMs = zonedToUtcMs(year, month, day, hours, minutes);

  // If the computed reset time is at or before detectedAt, advance by one day.
  if (resetMs <= detectedAt.getTime()) {
    resetMs = zonedToUtcMs(year, month, day + 1, hours, minutes);
  }

  return new Date(resetMs).toISOString();
}

function parseClaudeSessionLimit(text: string, detectedAt = new Date()): ProviderTerminalFailure | null {
  if (!CLAUDE_SESSION_LIMIT.test(text)) return null;
  const match = text.match(CLAUDE_RESET);
  const clockText = match?.[1]?.replace(/\s+/g, "") ?? null;
  const timezone = match?.[2] ?? null;
  const resetTimeText = match
    ? `${match[1]}${timezone ? ` (${timezone})` : ""}`.slice(0, 160)
    : null;
  return {
    code: "session_limit",
    message: "Claude Code session limit reached",
    resetTimeText,
    resetAt: clockText && timezone ? resolveNextZonedTime(clockText, timezone, detectedAt) : null,
    timezone,
  };
}

export class ClaudeShadowProvider implements ShadowProvider {
  readonly id = "claude-code" as const;
  readonly displayName = "Claude Code";
  readonly modelProviderId = "orca/anthropic";
  readonly supportsPermissionPersistence = true;

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
      detectError: (turnText, detectedAt) => parseClaudeSessionLimit(turnText, detectedAt ?? new Date()),
      detectTurnStarted: (text) => /esc to interrupt/i.test(text),
    };
  }

  async waitForLimitReset(ctx: {
    tmux: TmuxRunner;
    sessionName: string;
    dbg: (msg: string) => void;
  }): Promise<void> {
    await ctx.tmux.run(["send-keys", "-t", ctx.sessionName, "Enter"]);
    ctx.dbg("claude session-limit wait selected");
  }
}
