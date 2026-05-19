import type { PtyEvents, PtyHandle, PtyManager, PtyStartOptions } from "./types.js";

interface FakePtyState {
  pid: number;
  dead: boolean;
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
}

const stateMap = new WeakMap<PtyHandle, FakePtyState>();
let nextPid = 1000;

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
    },
    get isDead() {
      return state.dead;
    },
  };
}

export class FakePtyManager implements PtyManager {
  private readonly handles: PtyHandle[] = [];

  start(_opts: PtyStartOptions): { handle: PtyHandle; events: PtyEvents } {
    const state: FakePtyState = {
      pid: nextPid++,
      dead: false,
      dataHandlers: new Set(),
      exitHandlers: new Set(),
    };

    const handle: PtyHandle = {
      get pid() {
        return state.pid;
      },
      write(_data: Buffer): void {
        // no-op after exit; noop in fake otherwise
        if (state.dead) return;
      },
      resize(_cols: number, _rows: number): void {
        // no-op in fake
      },
      kill(signal?: "SIGTERM" | "SIGKILL"): void {
        if (state.dead) return;
        state.dead = true;
        const sig = signal ?? "SIGTERM";
        for (const h of state.exitHandlers) h({ exitCode: null, signal: sig });
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

  /** Reset all live handles; call between tests. */
  reset(): void {
    this.handles.length = 0;
    nextPid = 1000;
  }
}
