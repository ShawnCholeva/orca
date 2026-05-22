import type {
  AgentAdapter,
  AdapterSpawnInput,
  AdapterSpawnResult,
  AdapterAvailability,
  AdapterContextDelivery,
} from "./types.js";
import { buildSpawnEnv } from "./types.js";
import { resolveBinary, type ResolveFn } from "./resolve.js";
import { runCheckCommand, type RunCheckResult } from "../readiness/exec.js";
import { sanitizeOutput } from "../readiness/sanitize.js";
import { installUrlFor, signInCommandFor } from "../readiness/repair-links.js";
import type { AgentReadinessStatus, CheckStep, RepairAction } from "@orca/contracts";

export type RunCheckFn = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> },
) => Promise<RunCheckResult>;

const NOT_LOGGED_IN = /\bnot (logged in|authenticated)\b|please (log|sign) in/i;

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const;
  readonly title = "Codex";
  readonly contextDelivery: AdapterContextDelivery = { mode: "preview_only", maxBytes: 32768 };

  constructor(
    private readonly resolveFn: ResolveFn = resolveBinary,
    private readonly runFn: RunCheckFn = runCheckCommand,
  ) {}

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const result = await this.resolveFn(candidates());
    if ("error" in result) {
      throw Object.assign(
        new Error(`codex not found. Set ORCA_CODEX_BIN or install Codex. Tried: ${result.tried.join(", ")}`),
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
        detail: `codex not found. Set ORCA_CODEX_BIN or install Codex. Tried: ${result.tried.join(", ")}`,
      };
    }
    return { status: "available" };
  }

  async checkInstalled(): Promise<CheckStep & { version?: string }> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return { name: "installed", ok: false, command: "codex --version", detail: "codex not found on PATH" };
    }
    const r = await this.runFn(resolved.resolvedPath, ["--version"]);
    const version = parseVersion(r.stdout);
    if (r.exitCode === 0) {
      return { name: "installed", ok: true, command: "codex --version", version, detail: version };
    }
    return {
      name: "installed",
      ok: false,
      command: "codex --version",
      exitCode: r.exitCode,
      errorOutput: sanitizeOutput(r.stderr || r.stdout),
    };
  }

  async checkAuth(): Promise<CheckStep> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: "codex login status",
        detail: "binary not found",
      };
    }
    const r = await this.runFn(resolved.resolvedPath, ["login", "status"], {});
    if (r.timedOut) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: "codex login status",
        detail: "timeout",
      };
    }
    if (r.exitCode === 0) {
      return {
        name: "authenticated",
        ok: true,
        authStatus: "ready",
        command: "codex login status",
        detail: "authenticated",
      };
    }
    const combined = `${r.stdout}\n${r.stderr}`;
    if (NOT_LOGGED_IN.test(combined)) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "needs_auth",
        command: "codex login status",
        detail: "not signed in",
      };
    }
    return {
      name: "authenticated",
      ok: false,
      authStatus: "misconfigured",
      command: "codex login status",
      exitCode: r.exitCode,
      errorOutput: sanitizeOutput(r.stderr || r.stdout),
      detail: "unexpected login status output",
    };
  }

  repairFor(status: AgentReadinessStatus): RepairAction | undefined {
    if (status === "missing") {
      const url = installUrlFor("codex");
      return url ? { kind: "install_url", url, label: "Install Codex" } : undefined;
    }
    if (status === "needs_auth") {
      const command = signInCommandFor("codex");
      return command ? { kind: "run_command", command, label: "Sign in to Codex" } : undefined;
    }
    if (status === "misconfigured" || status === "failed") {
      return { kind: "run_command", command: "codex login status", label: "Retry check" };
    }
    return undefined;
  }
}

function candidates(): string[] {
  const override = process.env["ORCA_CODEX_BIN"];
  return override ? [override] : ["codex"];
}

function parseVersion(stdout: string): string | undefined {
  const m = stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : undefined;
}
