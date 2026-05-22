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

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
// Current `opencode auth list` prints a TUI-like list plus a footer such as:
//   └  3 credentials
// Parse the count instead of provider labels; labels can contain spaces, domains,
// and auth method suffixes and may include account/provider-identifying text.
const CRED_COUNT = /^[\s│└┌─]*?(\d+)\s+credentials\s*$/im;
const ZERO_CRED_FOOTER = /^[\s│└┌─]*?0\s+credentials\s*$/im;

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
    const r = await this.runFn(resolved.resolvedPath, ["--version"]);
    const version = parseVersion(r.stdout);
    if (r.exitCode === 0) {
      return { name: "installed", ok: true, command: "opencode --version", version, detail: version };
    }
    return {
      name: "installed",
      ok: false,
      command: "opencode --version",
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
        command: "opencode auth list",
        detail: "binary not found",
      };
    }
    const r = await this.runFn(resolved.resolvedPath, ["auth", "list", "--pure"], {});
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
    const countMatch = cleaned.match(CRED_COUNT);
    const credentialCount = countMatch ? Number(countMatch[1]) : 0;
    if (credentialCount <= 0 || ZERO_CRED_FOOTER.test(cleaned)) {
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

function parseVersion(stdout: string): string | undefined {
  const m = stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : undefined;
}
