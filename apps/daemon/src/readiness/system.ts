import os from "node:os";
import { readFileSync } from "node:fs";
import type {
  AgentReadinessStatus,
  CheckStep,
  RepairAction,
  SystemReadinessReport,
} from "@orca/contracts";
import { runCheckCommand, inheritCredEnv, type RunCheckResult } from "./exec.js";
import { sanitizeOutput } from "./sanitize.js";
import { parseVersion } from "./version.js";

export type RunCheckFn = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> },
) => Promise<RunCheckResult>;

const TMUX_WIKI_INSTALL = "https://github.com/tmux/tmux/wiki/Installing";

/**
 * Probe whether `tmux` is installed and runnable. tmux backs Orca's shadow
 * sessions, so onboarding treats it as a hard requirement: a missing or broken
 * tmux yields a `missing`/`failed` status with an OS-appropriate repair hint
 * the user can act on and retry, mirroring the per-agent readiness flow.
 */
export async function checkTmuxReadiness(
  runFn: RunCheckFn = runCheckCommand,
  clock: () => string = () => new Date().toISOString(),
): Promise<SystemReadinessReport> {
  const checkedAt = clock();
  const command = "tmux -V";
  let r: RunCheckResult;
  try {
    r = await runFn("tmux", ["-V"], { env: inheritCredEnv() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return report("failed", [
      { name: "installed", ok: false, command, detail: "tmux check failed", errorOutput: sanitizeOutput(message) },
    ], checkedAt);
  }

  // ENOENT (not on PATH) → not installed.
  if (r.failureKind === "spawn") {
    return report(
      "missing",
      [{ name: "installed", ok: false, command, detail: "tmux not found on PATH" }],
      checkedAt,
    );
  }

  if (r.timedOut) {
    return report(
      "failed",
      [{ name: "installed", ok: false, command, detail: "tmux -V timed out" }],
      checkedAt,
    );
  }

  if (r.exitCode === 0) {
    const version = parseVersion(r.stdout, "tmux");
    return report(
      "ready",
      [{ name: "installed", ok: true, command, detail: version ?? "tmux installed" }],
      checkedAt,
      version,
    );
  }

  return report(
    "failed",
    [
      {
        name: "installed",
        ok: false,
        command,
        exitCode: r.exitCode,
        errorOutput: sanitizeOutput(r.stderr || r.stdout),
        detail: "tmux -V failed",
      },
    ],
    checkedAt,
  );
}

function report(
  status: AgentReadinessStatus,
  steps: CheckStep[],
  checkedAt: string,
  version?: string,
): SystemReadinessReport {
  return {
    dependency: "tmux",
    status,
    steps,
    repair: status === "ready" ? undefined : tmuxRepairFor(),
    checkedAt,
    ...(version ? { version } : {}),
  };
}

/**
 * Best-effort OS-specific instruction for installing tmux. macOS and Linux ship
 * a one-line package-manager command; Windows has no native tmux, so we point at
 * the upstream install guide (typically WSL).
 */
export function tmuxRepairFor(platform: NodeJS.Platform = os.platform()): RepairAction {
  if (platform === "darwin") {
    return { kind: "run_command", command: "brew install tmux", label: "Install tmux (Homebrew)" };
  }
  if (platform === "linux") {
    const { command, label } = linuxTmuxInstall();
    return { kind: "run_command", command, label };
  }
  // Windows / other: no native tmux package — direct the user to the install guide.
  return { kind: "install_url", url: TMUX_WIKI_INSTALL, label: "How to install tmux" };
}

function linuxTmuxInstall(): { command: string; label: string } {
  const family = detectLinuxFamily();
  switch (family) {
    case "fedora":
      return { command: "sudo dnf install -y tmux", label: "Install tmux (dnf)" };
    case "arch":
      return { command: "sudo pacman -S --noconfirm tmux", label: "Install tmux (pacman)" };
    case "suse":
      return { command: "sudo zypper install -y tmux", label: "Install tmux (zypper)" };
    case "alpine":
      return { command: "sudo apk add tmux", label: "Install tmux (apk)" };
    case "debian":
    default:
      return { command: "sudo apt-get install -y tmux", label: "Install tmux (apt)" };
  }
}

type LinuxFamily = "debian" | "fedora" | "arch" | "suse" | "alpine";

function detectLinuxFamily(): LinuxFamily {
  let osRelease = "";
  try {
    osRelease = readFileSync("/etc/os-release", "utf8").toLowerCase();
  } catch {
    return "debian";
  }
  const ids = `${matchField(osRelease, "id")} ${matchField(osRelease, "id_like")}`;
  if (/\b(fedora|rhel|centos|rocky|almalinux)\b/.test(ids)) return "fedora";
  if (/\b(arch|manjaro|endeavouros)\b/.test(ids)) return "arch";
  if (/\b(suse|opensuse|sles)\b/.test(ids)) return "suse";
  if (/\balpine\b/.test(ids)) return "alpine";
  return "debian";
}

function matchField(content: string, key: string): string {
  const m = new RegExp(`^${key}=("?)(.*)\\1$`, "m").exec(content);
  return m ? m[2] : "";
}
