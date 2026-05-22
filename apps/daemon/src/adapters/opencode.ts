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
import type { AgentReadinessStatus, CheckStep, RepairAction } from "@orca/contracts";

export type RunCheckFn = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> },
) => Promise<RunCheckResult>;

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
// `opencode auth list --pure` prints a TUI-like list plus a footer like:
//   └  3 credentials
// Take the LAST line matching "N credentials"; the footer count line always
// trails the provider list, so anchoring on "last match" survives label text
// that happens to contain a digit-prefixed word.
const CRED_COUNT_GLOBAL = /(?:^|\n)[\s│└┌─]*(\d+)\s+credentials\s*(?=\n|$)/gi;

function lastCredCount(cleaned: string): number | null {
  const all = [...cleaned.matchAll(CRED_COUNT_GLOBAL)];
  if (all.length === 0) return null;
  return Number(all[all.length - 1][1]);
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = "opencode" as const;
  readonly title = "opencode";
  readonly contextDelivery: AdapterContextDelivery = { mode: "preview_only", maxBytes: 32768 };

  constructor(
    private readonly resolveFn: ResolveFn = resolveBinary,
    private readonly runFn: RunCheckFn = runCheckCommand,
  ) {}

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const result = await this.resolveFn(candidates());
    if ("error" in result) {
      throw Object.assign(
        new Error(`opencode not found. Set ORCA_OPENCODE_BIN or install opencode. Tried: ${result.tried.join(", ")}`),
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
        detail: `opencode not found. Set ORCA_OPENCODE_BIN or install opencode. Tried: ${result.tried.join(", ")}`,
      };
    }
    return { status: "available" };
  }

  async checkInstalled(): Promise<CheckStep & { version?: string }> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return { name: "installed", ok: false, command: "opencode --version", detail: "opencode not found on PATH" };
    }
    const r = await this.runFn(resolved.resolvedPath, ["--version"], { env: inheritCredEnv() });
    const version = parseVersion(r.stdout, "opencode");
    if (r.exitCode === 0) {
      return { name: "installed", ok: true, command: "opencode --version", version, detail: version };
    }
    return {
      name: "installed",
      ok: false,
      command: "opencode --version",
      exitCode: r.exitCode,
      errorOutput: sanitizeOutput(r.stderr || r.stdout),
      detail: "opencode --version failed",
    };
  }

  async checkAuth(): Promise<CheckStep> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: "opencode auth list",
        detail: "binary not found",
      };
    }
    const r = await this.runFn(resolved.resolvedPath, ["auth", "list", "--pure"], { env: inheritCredEnv() });
    if (r.timedOut) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: "opencode auth list",
        detail: "timeout",
      };
    }
    if (r.exitCode !== 0) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: "opencode auth list",
        exitCode: r.exitCode,
        errorOutput: sanitizeOutput(r.stderr || r.stdout),
        detail: "auth list failed",
      };
    }
    const cleaned = r.stdout.replace(ANSI, "");
    const credentialCount = lastCredCount(cleaned);
    if (credentialCount === null || credentialCount <= 0) {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "needs_auth",
        command: "opencode auth list",
        detail: "no credentials stored",
      };
    }
    return {
      name: "authenticated",
      ok: true,
      authStatus: "ready",
      command: "opencode auth list",
      detail: `authenticated (${credentialCount} credentials)`,
    };
  }

  repairFor(status: AgentReadinessStatus): RepairAction | undefined {
    if (status === "missing") {
      const url = installUrlFor("opencode");
      return url ? { kind: "install_url", url, label: "Install opencode" } : undefined;
    }
    if (status === "needs_auth") {
      const command = signInCommandFor("opencode");
      return command ? { kind: "run_command", command, label: "Sign in to opencode" } : undefined;
    }
    if (status === "misconfigured" || status === "failed") {
      return { kind: "run_command", command: "opencode auth list", label: "Retry check" };
    }
    return undefined;
  }
}

function candidates(): string[] {
  const override = process.env["ORCA_OPENCODE_BIN"];
  return override ? [override] : ["opencode"];
}
