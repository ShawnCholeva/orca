import type {
  AgentAdapter,
  AdapterSpawnInput,
  AdapterSpawnResult,
  AdapterAvailability,
  AdapterContextDelivery,
} from "./types.js";
import { buildSpawnEnv } from "./types.js";
import { resolveBinary, type ResolveFn } from "./resolve.js";
import { runCheckCommand, inheritCredEnv, type RunCheckResult } from "../readiness/exec.js";
import { sanitizeOutput } from "../readiness/sanitize.js";
import { installUrlFor, signInCommandFor } from "../readiness/repair-links.js";
import { parseVersion } from "../readiness/version.js";
import type { AgentReadinessStatus, CheckStep, RepairAction, ExecutionMode } from "@orca/contracts";
import { adapterSupportsModel } from "./model-catalog.js";

export type RunCheckFn = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> },
) => Promise<RunCheckResult>;

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code" as const;
  readonly title = "Claude Code";
  readonly supportedExecutionModes: ExecutionMode[] = ["shadow_session", "one_shot"];
  readonly contextDelivery: AdapterContextDelivery = { mode: "preview_only", maxBytes: 32768 };

  supportsModel(modelId: string): boolean {
    return adapterSupportsModel(this.id, modelId);
  }

  constructor(
    private readonly resolveFn: ResolveFn = resolveBinary,
    private readonly runFn: RunCheckFn = runCheckCommand,
  ) {}

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const result = await this.resolveFn(candidates());
    if ("error" in result) {
      throw Object.assign(
        new Error(
          `claude not found. Set ORCA_CLAUDE_CODE_BIN or install Claude Code. Tried: ${result.tried.join(", ")}`,
        ),
        { code: "command_not_found" },
      );
    }
    return { command: result.resolvedPath, args: [], env: buildSpawnEnv(input), cwd: input.workspacePath };
  }

  async probeAvailability(): Promise<AdapterAvailability> {
    const result = await this.resolveFn(candidates());
    if ("error" in result) {
      return {
        status: "unavailable",
        detail: `claude not found. Set ORCA_CLAUDE_CODE_BIN or install Claude Code. Tried: ${result.tried.join(", ")}`,
      };
    }
    return { status: "available" };
  }

  async checkInstalled(): Promise<CheckStep & { version?: string }> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return {
        name: "installed",
        ok: false,
        command: "claude --version",
        detail: "claude not found on PATH",
      };
    }
    const r = await this.runFn(resolved.resolvedPath, ["--version"], { env: inheritCredEnv() });
    const version = parseVersion(r.stdout, "claude");
    if (r.exitCode === 0) {
      return { name: "installed", ok: true, command: "claude --version", version, detail: version };
    }
    return {
      name: "installed",
      ok: false,
      command: "claude --version",
      exitCode: r.exitCode,
      errorOutput: sanitizeOutput(r.stderr || r.stdout),
      detail: "claude --version failed",
    };
  }

  async checkAuth(): Promise<CheckStep> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: "claude auth status --json",
        detail: "binary not found",
      };
    }
    const r = await this.runFn(resolved.resolvedPath, ["auth", "status", "--json"], { env: inheritCredEnv() });
    if (r.timedOut) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: "claude auth status --json",
        detail: "timeout",
      };
    }
    const parsed = extractJsonObject<{ loggedIn?: boolean }>(r.stdout);
    // JSON drives the classification first; exit code is a tiebreaker only.
    if (parsed && typeof parsed.loggedIn === "boolean") {
      if (parsed.loggedIn === true) {
        return {
          name: "authenticated",
          ok: true,
          authStatus: "ready",
          command: "claude auth status --json",
          detail: "authenticated",
        };
      }
      return {
        name: "authenticated",
        ok: false,
        authStatus: "needs_auth",
        command: "claude auth status --json",
        exitCode: r.exitCode,
        detail: "not signed in",
      };
    }
    return {
      name: "authenticated",
      ok: false,
      authStatus: "misconfigured",
      command: "claude auth status --json",
      exitCode: r.exitCode,
      errorOutput: sanitizeOutput(r.stderr || r.stdout),
      detail: "unexpected auth status output",
    };
  }

  repairFor(status: AgentReadinessStatus): RepairAction | undefined {
    if (status === "missing") {
      const url = installUrlFor("claude-code");
      return url ? { kind: "install_url", url, label: "Install Claude Code" } : undefined;
    }
    if (status === "needs_auth") {
      const command = signInCommandFor("claude-code");
      return command ? { kind: "run_command", command, label: "Sign in to Claude Code" } : undefined;
    }
    if (status === "misconfigured" || status === "failed") {
      return { kind: "run_command", command: "claude auth status --json", label: "Retry check" };
    }
    return undefined;
  }
}

function candidates(): string[] {
  const override = process.env["ORCA_CLAUDE_CODE_BIN"];
  return override ? [override] : ["claude"];
}

// Tolerate banner/warning lines around the JSON object some CLIs emit on stdout.
function extractJsonObject<T>(stdout: string): T | null {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    const first = stdout.indexOf("{");
    const last = stdout.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(stdout.slice(first, last + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}
