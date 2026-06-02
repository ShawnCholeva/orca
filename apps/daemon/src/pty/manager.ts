// ISOLATION: This is the ONLY file in the repo allowed to import node-pty.
import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as nodePty from "node-pty";

import type { PtyEvents, PtyHandle, PtyManager, PtyStartOptions } from "./types.js";

const nodeRequire = createRequire(import.meta.url);

interface PtySpawnError extends Error {
  name: "PtySpawnError";
  code: "command_not_found" | "spawn_failed";
  cause: unknown;
}

function makePtySpawnError(code: "command_not_found" | "spawn_failed", cause: unknown): PtySpawnError {
  const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : "";
  const err = new Error(`PTY spawn failed: ${code}${detail}`) as PtySpawnError;
  err.name = "PtySpawnError";
  err.code = code;
  err.cause = cause;
  return err;
}

interface SpawnHelperStat {
  mode: number;
}

export interface EnsureNodePtySpawnHelperExecutableDeps {
  platform?: NodeJS.Platform;
  resolveSpawnHelperPath?: () => string | null;
  statSync?: (filePath: string) => SpawnHelperStat;
  chmodSync?: (filePath: string, mode: number) => void;
}

function resolveNodePtySpawnHelperPath(): string | null {
  if (process.platform === "win32") return null;

  try {
    const utils = nodeRequire("node-pty/lib/utils") as {
      loadNativeModule(name: "pty"): { dir: string };
    };
    const native = utils.loadNativeModule("pty");
    const unixTerminalPath = nodeRequire.resolve("node-pty/lib/unixTerminal");
    const helperPath = path.resolve(path.dirname(unixTerminalPath), native.dir, "spawn-helper");
    return helperPath.replace("app.asar", "app.asar.unpacked").replace("node_modules.asar", "node_modules.asar.unpacked");
  } catch {
    return null;
  }
}

export function ensureNodePtySpawnHelperExecutable(
  deps: EnsureNodePtySpawnHelperExecutableDeps = {},
): void {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return;

  const helperPath = (deps.resolveSpawnHelperPath ?? resolveNodePtySpawnHelperPath)();
  if (!helperPath) return;

  const readStat = deps.statSync ?? statSync;
  const chmod = deps.chmodSync ?? chmodSync;
  let stat: SpawnHelperStat;
  try {
    stat = readStat(helperPath);
  } catch (cause) {
    throw new Error(
      `node-pty spawn-helper is missing or unreadable at ${helperPath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  if ((stat.mode & 0o111) !== 0) return;

  try {
    chmod(helperPath, stat.mode | 0o111);
  } catch (cause) {
    throw new Error(
      `node-pty spawn-helper is not executable at ${helperPath} and chmod failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

export class NodePtyManager implements PtyManager {
  start(opts: PtyStartOptions): { handle: PtyHandle; events: PtyEvents } {
    let pty: nodePty.IPty;
    try {
      ensureNodePtySpawnHelperExecutable();
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
