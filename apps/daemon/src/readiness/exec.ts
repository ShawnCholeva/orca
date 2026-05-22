import { execFile } from "node:child_process";
import os from "node:os";

export interface RunCheckOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  cwd?: string;
}

export type FailureKind = "spawn" | "timeout" | "max_buffer" | "exit";

export interface RunCheckResult {
  exitCode?: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  failureKind?: FailureKind;
  spawnError?: { code?: string; message: string };
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BUFFER = 256 * 1024;
const SIGKILL_GRACE_MS = 1000;

export function runCheckCommand(
  command: string,
  args: string[],
  opts: RunCheckOptions = {},
): Promise<RunCheckResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env["PATH"] ?? "" };
    if (opts.env) Object.assign(env, opts.env);

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    let childExited = false;
    let softTimer: NodeJS.Timeout | undefined;
    let sigkillTimer: NodeJS.Timeout | undefined;

    // We manage timeout ourselves so we control SIGTERM -> SIGKILL escalation.
    const child = execFile(
      command,
      args,
      {
        maxBuffer: MAX_BUFFER,
        cwd: opts.cwd ?? os.tmpdir(),
        env,
        windowsHide: true,
        shell: false,
      },
      (err, stdout, stderr) => {
        if (sigkillTimer) clearTimeout(sigkillTimer);
        if (softTimer) clearTimeout(softTimer);
        const durationMs = Date.now() - start;

        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() ?? "",
            durationMs,
            timedOut: false,
            failureKind: "spawn",
            spawnError: { code: "ENOENT", message: err.message },
          });
          return;
        }

        const errCode = (err as { code?: number | string } | null)?.code;
        if (errCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() ?? "",
            durationMs,
            timedOut: false,
            failureKind: "max_buffer",
            spawnError: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", message: (err as Error).message },
          });
          return;
        }

        const exitCode = typeof errCode === "number" ? errCode : err ? undefined : 0;
        const failureKind: FailureKind | undefined = timedOut
          ? "timeout"
          : exitCode !== 0
            ? "exit"
            : undefined;

        resolve({
          exitCode,
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          durationMs,
          timedOut,
          failureKind,
        });
      },
    );

    // Close stdin so the child cannot block waiting for input.
    child.stdin?.end();
    child.once("exit", () => {
      childExited = true;
    });

    // Soft timeout: SIGTERM first, then SIGKILL after the grace window.
    softTimer = setTimeout(() => {
      timedOut = true;
      if (!childExited) child.kill("SIGTERM");
      sigkillTimer = setTimeout(() => {
        if (!childExited) child.kill("SIGKILL");
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);
  });
}
