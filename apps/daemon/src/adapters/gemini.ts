import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
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

type EnvReader = () => Record<string, string | undefined>;
type FileExists = (p: string) => boolean;
type FileReader = (p: string) => string;

export class GeminiAdapter implements AgentAdapter {
  readonly id = "gemini-cli" as const;
  readonly title = "Gemini CLI";
  readonly contextDelivery: AdapterContextDelivery = { mode: "preview_only", maxBytes: 32768 };

  constructor(
    private readonly resolveFn: ResolveFn = resolveBinary,
    private readonly runFn: RunCheckFn = runCheckCommand,
    private readonly envFn: EnvReader = () => process.env as Record<string, string | undefined>,
    private readonly existsFn: FileExists = existsSync,
    private readonly readFn: FileReader = (p) => readFileSync(p, "utf8"),
  ) {}

  async resolveSpawn(input: AdapterSpawnInput): Promise<AdapterSpawnResult> {
    const result = await this.resolveFn(candidates());
    if ("error" in result) {
      throw Object.assign(
        new Error(`gemini not found. Set ORCA_GEMINI_CLI_BIN or install Gemini CLI. Tried: ${result.tried.join(", ")}`),
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
        detail: `gemini not found. Set ORCA_GEMINI_CLI_BIN or install Gemini CLI. Tried: ${result.tried.join(", ")}`,
      };
    }
    return { status: "available" };
  }

  async checkInstalled(): Promise<CheckStep & { version?: string }> {
    const resolved = await this.resolveFn(candidates());
    if ("error" in resolved) {
      return { name: "installed", ok: false, command: "gemini --version", detail: "gemini not found on PATH" };
    }
    const r = await this.runFn(resolved.resolvedPath, ["--version"]);
    const version = parseVersion(r.stdout);
    if (r.exitCode === 0) {
      return { name: "installed", ok: true, command: "gemini --version", version, detail: version };
    }
    return {
      name: "installed",
      ok: false,
      command: "gemini --version",
      exitCode: r.exitCode,
      errorOutput: sanitizeOutput(r.stderr || r.stdout),
    };
  }

  async checkAuth(): Promise<CheckStep> {
    const env = this.envFn();
    const cmd = "gemini auth (configuration probe)";
    const home = env["HOME"] ?? os.homedir();
    const settingsPath = path.join(home, ".gemini", "settings.json");

    // 1. Gemini API key
    if (nonEmpty(env["GEMINI_API_KEY"])) {
      return readyStep(cmd, "gemini_api_key");
    }

    // Parse settings if present (used by modes 2 + 4)
    let settings: { selectedAuthType?: string } | null = null;
    if (this.existsFn(settingsPath)) {
      try {
        settings = JSON.parse(this.readFn(settingsPath));
      } catch {
        settings = null;
      }
    }

    // 2. Vertex API key (express mode)
    //    Gemini SDK + CLI use GOOGLE_API_KEY together with GOOGLE_GENAI_USE_VERTEXAI=true
    //    to select Vertex AI in express mode. Settings.json is a secondary signal.
    const usingVertexFromEnv =
      isTruthyEnvFlag(env["GOOGLE_GENAI_USE_VERTEXAI"]) || settings?.selectedAuthType === "vertex-ai";
    if (nonEmpty(env["GOOGLE_API_KEY"]) && usingVertexFromEnv) {
      return readyStep(cmd, "vertex_api_key");
    }

    // 3. Vertex ADC / service account
    const project = env["GOOGLE_CLOUD_PROJECT"] ?? env["GOOGLE_CLOUD_PROJECT_ID"];
    const location = env["GOOGLE_CLOUD_LOCATION"];
    const credEnv = env["GOOGLE_APPLICATION_CREDENTIALS"];
    const adcDefault = path.join(home, ".config", "gcloud", "application_default_credentials.json");
    if (project && location) {
      const credPath = credEnv ?? (this.existsFn(adcDefault) ? adcDefault : null);
      if (credPath && this.existsFn(credPath)) {
        return readyStep(cmd, "vertex_adc");
      }
    }

    // 4. OAuth (Google login)
    if (settings?.selectedAuthType === "oauth-personal") {
      const cache = path.join(home, ".gemini", "oauth_creds.json");
      if (this.existsFn(cache)) {
        return readyStep(cmd, "oauth");
      }
      // partial match: settings says oauth, no credential cache → misconfigured
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: cmd,
        detail: "settings.json selectedAuthType=oauth-personal but credential cache missing",
      };
    }

    // Partial vertex configuration but no creds → misconfigured
    if (settings?.selectedAuthType === "vertex-ai") {
      return {
        name: "authenticated",
        ok: false,
        authStatus: "misconfigured",
        command: cmd,
        detail: "settings.json selects vertex-ai but no credentials found",
      };
    }

    return {
      name: "authenticated",
      ok: false,
      authStatus: "needs_auth",
      command: cmd,
      detail: "no Gemini credentials detected",
    };
  }

  repairFor(status: AgentReadinessStatus): RepairAction | undefined {
    if (status === "missing") {
      const url = installUrlFor("gemini-cli");
      return url ? { kind: "install_url", url, label: "Install Gemini CLI" } : undefined;
    }
    if (status === "needs_auth") {
      const command = signInCommandFor("gemini-cli");
      return command
        ? { kind: "run_command", command, label: "Sign in to Gemini CLI", requiresAppRestart: true }
        : undefined;
    }
    if (status === "misconfigured" || status === "failed") {
      return { kind: "run_command", command: "gemini", label: "Retry after fixing config", requiresAppRestart: true };
    }
    return undefined;
  }
}

function candidates(): string[] {
  const override = process.env["ORCA_GEMINI_CLI_BIN"];
  return override ? [override] : ["gemini"];
}

function parseVersion(stdout: string): string | undefined {
  const m = stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : undefined;
}

function nonEmpty(v: string | undefined): boolean {
  return typeof v === "string" && v.length > 0;
}

function isTruthyEnvFlag(v: string | undefined): boolean {
  if (!v) return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "yes";
}

function readyStep(command: string, method: string): CheckStep {
  return {
    name: "authenticated",
    ok: true,
    authStatus: "ready",
    command,
    detail: `configuration detected; not smoke-tested (${method})`,
  };
}
