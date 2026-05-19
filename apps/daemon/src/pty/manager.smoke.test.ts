import { describe, expect, it } from "vitest";
import { NodePtyManager } from "./manager.js";

const RUN = process.env["ORCA_RUN_REAL_PTY"] === "1";

describe.skipIf(!RUN)("NodePtyManager smoke (ORCA_RUN_REAL_PTY=1)", () => {
  it("spawns sh, receives output, observes exit 0", async () => {
    const manager = new NodePtyManager();
    const { handle, events } = manager.start({
      command: "/bin/sh",
      args: ["-c", "echo orca && exit 0"],
      cwd: "/tmp",
      env: {},
      cols: 80,
      rows: 24,
    });

    expect(typeof handle.pid).toBe("number");
    expect(handle.pid).toBeGreaterThan(0);

    const chunks: Buffer[] = [];
    events.onData((chunk) => chunks.push(chunk));

    const result = await new Promise<{ exitCode: number | null; signal: string | null }>(
      (resolve) => events.onExit(resolve),
    );

    const output = Buffer.concat(chunks).toString();
    expect(output).toContain("orca");
    expect(result.exitCode).toBe(0);
  });

  it("exits non-zero for missing binary (forkpty defers exec failure to exit handler)", async () => {
    // On Linux, forkpty succeeds but execve fails in the child — no synchronous throw.
    // The child exits with code 127 (command not found convention).
    const manager = new NodePtyManager();
    const { events } = manager.start({
      command: "/nonexistent/binary/orca-no-such-command",
      args: [],
      cwd: "/tmp",
      env: {},
      cols: 80,
      rows: 24,
    });
    const result = await new Promise<{ exitCode: number | null; signal: string | null }>(
      (resolve) => events.onExit(resolve),
    );
    expect(result.exitCode).not.toBe(0);
  });
});
