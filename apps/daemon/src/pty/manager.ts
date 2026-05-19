// ISOLATION: This is the ONLY file in the repo allowed to import node-pty.
import * as nodePty from "node-pty";

import type { PtyEvents, PtyHandle, PtyManager, PtyStartOptions } from "./types.js";

interface PtySpawnError extends Error {
  name: "PtySpawnError";
  code: "command_not_found" | "spawn_failed";
  cause: unknown;
}

function makePtySpawnError(code: "command_not_found" | "spawn_failed", cause: unknown): PtySpawnError {
  const err = new Error(`PTY spawn failed: ${code}`) as PtySpawnError;
  err.name = "PtySpawnError";
  err.code = code;
  err.cause = cause;
  return err;
}

export class NodePtyManager implements PtyManager {
  start(opts: PtyStartOptions): { handle: PtyHandle; events: PtyEvents } {
    let pty: nodePty.IPty;
    try {
      pty = nodePty.spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        cols: opts.cols,
        rows: opts.rows,
        encoding: null, // raw Buffer output
      });
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException;
      const code = err?.code === "ENOENT" ? "command_not_found" : "spawn_failed";
      throw makePtySpawnError(code, cause);
    }

    const handle: PtyHandle = {
      get pid() {
        return pty.pid;
      },
      write(data: Buffer): void {
        pty.write(data);
      },
      resize(cols: number, rows: number): void {
        pty.resize(cols, rows);
      },
      kill(signal?: "SIGTERM" | "SIGKILL"): void {
        pty.kill(signal);
      },
    };

    const dataHandlers = new Set<(chunk: Buffer) => void>();
    const exitHandlers = new Set<(exit: { exitCode: number | null; signal: string | null }) => void>();

    const dataDisposable = pty.onData((data) => {
      // node-pty types onData as IEvent<string>, but encoding:null delivers Buffer at runtime
      for (const h of dataHandlers) h(data as unknown as Buffer);
    });

    const exitDisposable = pty.onExit(({ exitCode, signal }) => {
      const exit = {
        exitCode: exitCode ?? null,
        signal: signal != null ? String(signal) : null,
      };
      for (const h of exitHandlers) h(exit);
      dataDisposable.dispose();
      exitDisposable.dispose();
      dataHandlers.clear();
      exitHandlers.clear();
    });

    const events: PtyEvents = {
      onData(handler): () => void {
        dataHandlers.add(handler);
        return () => dataHandlers.delete(handler);
      },
      onExit(handler): () => void {
        exitHandlers.add(handler);
        return () => exitHandlers.delete(handler);
      },
    };

    return { handle, events };
  }
}
