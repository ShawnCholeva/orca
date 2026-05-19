import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "./resolve.js";
import type { AgentAdapter } from "./types.js";
import type { ResolveFn } from "./resolve.js";

interface RealSmokeOptions {
  name: string;
  envKey: string;
  create(resolveFn: ResolveFn): AgentAdapter;
}

const INPUT = {
  goalId: "goal-smoke",
  sessionId: "session-smoke",
};

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function describeRealAdapterSmoke({ name, envKey, create }: RealSmokeOptions): void {
  describe.skipIf(process.env[envKey] !== "1")(`${name} real smoke (${envKey}=1)`, () => {
    it("starts in a temporary workspace, emits output, and exits after Ctrl-D", { timeout: 15_000 }, async () => {
      const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "orca-adapter-smoke-"));
      let handle: { write(data: Buffer): void; kill(signal?: "SIGTERM" | "SIGKILL"): void } | undefined;
      let exited = false;

      try {
        const adapter = create(resolveBinary);
        const spawn = await adapter.resolveSpawn({ ...INPUT, workspacePath: workspaceDir });
        const { NodePtyManager } = await import("../pty/manager.js");
        const manager = new NodePtyManager();
        const started = manager.start({
          ...spawn,
          cols: 80,
          rows: 24,
        });
        handle = started.handle;

        const firstOutput = new Promise<void>((resolve) => {
          started.events.onData((chunk) => {
            if (chunk.length > 0) resolve();
          });
        });
        const exit = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
          started.events.onExit((result) => {
            exited = true;
            resolve(result);
          });
        });

        await withTimeout(firstOutput, 5_000, "adapter did not emit output");
        handle.write(Buffer.from("\u0004"));
        const result = await withTimeout(exit, 5_000, "adapter did not exit after Ctrl-D");

        expect(result.signal).toBeNull();
      } finally {
        if (handle && !exited) {
          try {
            handle.kill("SIGKILL");
          } catch {
            // Best-effort cleanup for opt-in smoke tests.
          }
        }
        await rm(workspaceDir, { recursive: true, force: true });
      }
    });
  });
}
