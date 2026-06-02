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

const AUTH_PROBE_PROMPT = "Reply exactly: ORCA_AUTH_OK";
const NOT_AUTHENTICATED =
  /\bnot (?:yet |currently )?(?:logged in|signed in|authenticated)\b|\b(?:please (?:log|sign) in|login required|authentication required|unauthorized)\b|google sign-in|sign in with google/i;

export class AntigravityAdapter implements AgentAdapter {
  readonly id = "antigravity" as const;
  readonly title = "Antigravity";
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
        new Error(`agy not found. Set ORCA_ANTIGRAVITY_BIN or install Antigravity. Tried: ${result.tried.join(", ")}`),
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
        detail: `agy not found. Set ORCA_ANTIGRAVITY_BIN or install Antigravity. Tried: ${result.tried.join(", ")}`,
      };
    }
    return { status: "available" };
  }

  async checkInstalled(): Promise<CheckStep & { version?: string }> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return { name: "installed", ok: false, command: "agy --version", detail: "agy not found on PATH" };
    }
    const r = await this.runFn(resolved.resolvedPath, ["--version"], { env: inheritCredEnv() });
    const version = parseVersion(r.stdout, "agy");
    if (r.exitCode === 0) {
      return { name: "installed", ok: true, command: "agy --version", version, detail: version };
    }
    return {
      name: "installed",
      ok: false,
      command: "agy --version",
      exitCode: r.exitCode,
      errorOutput: sanitizeOutput(r.stderr || r.stdout),
      detail: "agy --version failed",
    };
  }

  async checkAuth(): Promise<CheckStep> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: `agy -p "${AUTH_PROBE_PROMPT}"`,
        detail: "binary not found",
      };
    }
    const r = await this.runFn(resolved.resolvedPath, ["-p", AUTH_PROBE_PROMPT], {
      env: inheritCredEnv(),
      timeoutMs: 8000,
    });
    const combined = `${r.stdout}\n${r.stderr}`;
    if (r.timedOut) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: `agy -p "${AUTH_PROBE_PROMPT}"`,
        detail: "timeout",
      };
    }
    if (r.exitCode === 0 && /\bORCA_AUTH_OK\b/.test(combined)) {
      return {
        name: "authenticated",
        ok: true,
        authStatus: "ready",
        command: `agy -p "${AUTH_PROBE_PROMPT}"`,
        detail: "authenticated",
      };
    }
    if (NOT_AUTHENTICATED.test(combined)) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "needs_auth",
        command: `agy -p "${AUTH_PROBE_PROMPT}"`,
        exitCode: r.exitCode,
        detail: "not signed in",
      };
    }
    return {
      name: "authenticated",
      ok: false,
      authStatus: "misconfigured",
      command: `agy -p "${AUTH_PROBE_PROMPT}"`,
      exitCode: r.exitCode,
      errorOutput: sanitizeOutput(r.stderr || r.stdout),
      detail: "unexpected auth probe output",
    };
  }

  repairFor(status: AgentReadinessStatus): RepairAction | undefined {
    if (status === "missing") {
      const url = installUrlFor("antigravity");
      return url ? { kind: "install_url", url, label: "Install Antigravity" } : undefined;
    }
    if (status === "needs_auth") {
      const command = signInCommandFor("antigravity");
      return command ? { kind: "run_command", command, label: "Sign in to Antigravity" } : undefined;
    }
    if (status === "misconfigured" || status === "failed") {
      return { kind: "run_command", command: `agy -p "${AUTH_PROBE_PROMPT}"`, label: "Retry check" };
    }
    return undefined;
  }
}

function candidates(): string[] {
  const override = process.env["ORCA_ANTIGRAVITY_BIN"];
  return override ? [override] : ["agy"];
}
