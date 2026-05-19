export interface PtyStartOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtyHandle {
  readonly pid: number;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

export interface PtyEvents {
  onData(handler: (chunk: Buffer) => void): () => void;
  onExit(handler: (exit: { exitCode: number | null; signal: string | null }) => void): () => void;
}

export interface PtyManager {
  start(opts: PtyStartOptions): { handle: PtyHandle; events: PtyEvents };
}
