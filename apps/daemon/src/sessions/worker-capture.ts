/**
 * What to do with a chunk of a workflow worker's tmux pane.
 *
 * Its own module because it is the seam where output has to do BOTH things: be
 * stored so a viewer opening later sees the session, and be pushed so a viewer
 * already open sees it now. It shipped doing only the first, which made a live
 * worker's terminal look dead — a bug invisible to any test that opened a
 * session fresh, since a fresh open reads the store.
 */
export interface WorkerCaptureDeps {
  appendChunk(sessionId: string, chunk: Buffer): { seq: number; byteOffset: number };
  broadcastOutput(sessionId: string, seq: number, byteOffset: number, chunk: Buffer): void;
}

export function createWorkerCaptureSink(
  deps: WorkerCaptureDeps
): (sessionId: string, chunk: Buffer) => void {
  return (sessionId, chunk) => {
    const { seq, byteOffset } = deps.appendChunk(sessionId, chunk);
    deps.broadcastOutput(sessionId, seq, byteOffset, chunk);
  };
}
