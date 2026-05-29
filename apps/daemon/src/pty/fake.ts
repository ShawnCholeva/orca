import type { PtyEvents, PtyHandle, PtyManager, PtyStartOptions } from "./types.js";

interface FakePtyState {
  pid: number;
  dead: boolean;
  writtenChunks: Buffer[];
  dataHandlers: Set<(chunk: Buffer) => void>;
  exitHandlers: Set<(exit: { exitCode: number | null; signal: string | null }) => void>;
}

/** Control handle returned by controlFakePty for test injection. */
export interface FakePtyControl {
  /** Inject output bytes as if the PTY produced them. */
  emitData(chunk: Buffer): void;
  /** Trigger exit, fires exit handlers once and prevents further data. */
  emitExit(exit: { exitCode: number | null; signal: string | null }): void;
  /** True after exit has been emitted. */
  readonly isDead: boolean;
  /** Bytes written to the PTY via handle.write(). */
  readonly writtenChunks: readonly Buffer[];
}

const stateMap = new WeakMap<PtyHandle, FakePtyState>();

/** Returns a FakePtyControl for a handle produced by FakePtyManager. */
export function controlFakePty(handle: PtyHandle): FakePtyControl {
  const state = stateMap.get(handle);
  if (!state) throw new Error("controlFakePty: not a FakePtyManager handle");

  return {
    emitData(chunk: Buffer): void {
      if (state.dead) return;
      for (const h of state.dataHandlers) h(chunk);
    },
    emitExit(exit): void {
      if (state.dead) return;
      state.dead = true;
      for (const h of state.exitHandlers) h(exit);
      state.dataHandlers.clear();
      state.exitHandlers.clear();
    },
    get isDead() {
      return state.dead;
    },
    get writtenChunks() {
      return state.writtenChunks as readonly Buffer[];
    },
  };
}

export class FakePtyManager implements PtyManager {
  private nextPid = 1000;
  readonly handles: PtyHandle[] = [];

  start(_opts: PtyStartOptions): { handle: PtyHandle; events: PtyEvents } {
    const state: FakePtyState = {
      pid: this.nextPid++,
      dead: false,
      writtenChunks: [],
      dataHandlers: new Set(),
      exitHandlers: new Set(),
    };

    const handle: PtyHandle = {
      get pid() {
        return state.pid;
      },
      write(data: Buffer): void {
        if (state.dead) return;
        state.writtenChunks.push(data);
      },
      resize(_cols: number, _rows: number): void {},
      kill(signal?: "SIGTERM" | "SIGKILL"): void {
        if (state.dead) return;
        state.dead = true;
        const sig = signal ?? "SIGTERM";
        for (const h of state.exitHandlers) h({ exitCode: null, signal: sig });
        state.dataHandlers.clear();
        state.exitHandlers.clear();
      },
    };

    stateMap.set(handle, state);
    this.handles.push(handle);

    const events: PtyEvents = {
      onData(handler): () => void {
        state.dataHandlers.add(handler);
        return () => state.dataHandlers.delete(handler);
      },
      onExit(handler): () => void {
        state.exitHandlers.add(handler);
        return () => state.exitHandlers.delete(handler);
      },
    };

    return { handle, events };
  }

  /** Reset pid counter between tests. */
  reset(): void {
    this.nextPid = 1000;
  }
}
