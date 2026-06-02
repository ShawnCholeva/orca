import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import type { GetSessionResponse, SessionOutputFrame } from "@orca/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

vi.mock("xterm/css/xterm.css", () => ({}));

const terminalWrites: unknown[] = [];
const terminalDisposes: unknown[] = [];
let onDataHandler: ((data: string) => void) | null = null;
let latestTerminal: { cols: number; rows: number } | null = null;

vi.mock("xterm", () => ({
  Terminal: vi.fn().mockImplementation(() => {
    const terminal = {
      cols: 80,
      rows: 24,
      loadAddon: vi.fn(),
      open: vi.fn(),
      write: vi.fn((data: unknown) => terminalWrites.push(data)),
      onData: vi.fn((handler: (data: string) => void) => {
        onDataHandler = handler;
        return { dispose: vi.fn() };
      }),
      dispose: vi.fn(() => terminalDisposes.push("terminal")),
    };
    latestTerminal = terminal;
    return terminal;
  }),
}));

const fitDisposes: unknown[] = [];

vi.mock("xterm-addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
    dispose: vi.fn(() => fitDisposes.push("fit")),
  })),
}));

type StreamHandlers = {
  onOpen(): void;
  onFrame(frame: SessionOutputFrame): void;
  onStatus(status: string): void;
};

const sentFrames: unknown[] = [];
let streamHandlers: StreamHandlers | null = null;
let streamClosed = false;
const getSession = vi.fn();

vi.mock("../../api", () => ({
  getSession,
  openSessionStream: vi.fn().mockImplementation((handlers: StreamHandlers) => {
    streamHandlers = handlers;
    return {
      send: vi.fn((frame: unknown) => {
        sentFrames.push(frame);
        return true;
      }),
      close: vi.fn(() => {
        streamClosed = true;
      }),
    };
  }),
  toErrorMessage: (err: unknown, fallback: string) => err instanceof Error ? err.message : fallback,
}));

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];
  private cb: ResizeObserverCallback;

  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    ResizeObserverMock.instances.push(this);
  }

  observe = vi.fn();
  disconnect = vi.fn();

  emit() {
    this.cb([], this as unknown as ResizeObserver);
  }
}

function b64(value: string): string {
  return btoa(value);
}

function textFromWrite(value: unknown): string {
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  return String(value);
}

function makeDetail(chunks: { seq: number; data: string }[], nextSeq = chunks.length): GetSessionResponse {
  return {
    session: {
      id: "sess-1",
      goalId: "goal-1",
      workspaceId: "ws-1",
      adapterId: "claude-code",
      role: null,
      title: "claude-code session",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      exitedAt: null,
      instruction: null,
      pid: 123,
      command: "/bin/sh",
      args: [],
      cwd: "/tmp/repo",
      terminalCols: 80,
      terminalRows: 24,
      exitCode: null,
      exitSignal: null,
      failureReason: null,
      failureDetail: null,
      archivedAt: null,
    },
    output: {
      sessionId: "sess-1",
      firstByteOffset: 0,
      nextSeq,
      totalBytesKept: chunks.reduce((sum, chunk) => sum + chunk.data.length, 0),
      chunks: chunks.map((chunk, index) => ({
        seq: chunk.seq,
        byteOffset: index,
        dataBase64: b64(chunk.data),
      })),
    },
  };
}

async function renderTerminal(status: "running" | "exited" = "running"): Promise<Root> {
  const { SessionTerminalView } = await import("./SessionTerminalView");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SessionTerminalView sessionId="sess-1" status={status} />);
  });
  return root;
}

describe("SessionTerminalView", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    terminalWrites.length = 0;
    terminalDisposes.length = 0;
    fitDisposes.length = 0;
    sentFrames.length = 0;
    streamHandlers = null;
    streamClosed = false;
    onDataHandler = null;
    latestTerminal = null;
    ResizeObserverMock.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    getSession.mockResolvedValue(makeDetail([{ seq: 0, data: "tail\n" }], 1));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("fetches and writes the initial tail before the websocket opens", async () => {
    await renderTerminal();
    await act(async () => {});

    expect(getSession).toHaveBeenCalledTimes(1);
    expect(terminalWrites.map(textFromWrite)).toEqual(["tail\n"]);
    expect(sentFrames.some((frame) => (frame as { type?: string }).type === "session.subscribe")).toBe(false);
  });

  it("writes the initial tail once and appends live output after subscribing", async () => {
    await renderTerminal();
    await act(async () => {});

    await act(async () => {
      streamHandlers?.onOpen();
    });

    expect(terminalWrites.map(textFromWrite)).toEqual(["tail\n"]);
    expect(sentFrames).toContainEqual({ type: "session.subscribe", sessionId: "sess-1" });

    await act(async () => {
      streamHandlers?.onFrame({
        type: "session.output",
        sessionId: "sess-1",
        seq: 1,
        byteOffset: 5,
        dataBase64: b64("live\n"),
      });
    });

    expect(terminalWrites.map(textFromWrite)).toEqual(["tail\n", "live\n"]);
  });

  it("refetches detail once when a live frame skips a sequence", async () => {
    getSession
      .mockResolvedValueOnce(makeDetail([{ seq: 0, data: "tail\n" }], 1))
      .mockResolvedValueOnce(makeDetail([
        { seq: 0, data: "tail\n" },
        { seq: 1, data: "missed\n" },
        { seq: 2, data: "gap\n" },
      ], 3));

    await renderTerminal();
    await act(async () => {
      streamHandlers?.onOpen();
    });

    await act(async () => {
      streamHandlers?.onFrame({
        type: "session.output",
        sessionId: "sess-1",
        seq: 2,
        byteOffset: 12,
        dataBase64: b64("gap\n"),
      });
    });

    expect(getSession).toHaveBeenCalledTimes(2);
    expect(terminalWrites.map(textFromWrite)).toEqual(["tail\n", "missed\n", "gap\n"]);
  });

  it("refetches the tail and resubscribes when the session stream reconnects", async () => {
    getSession
      .mockResolvedValueOnce(makeDetail([{ seq: 0, data: "tail\n" }], 1))
      .mockResolvedValueOnce(makeDetail([
        { seq: 0, data: "tail\n" },
        { seq: 1, data: "after-reconnect\n" },
      ], 2));

    await renderTerminal();

    await act(async () => {
      streamHandlers?.onOpen();
    });
    await act(async () => {
      streamHandlers?.onOpen();
    });

    expect(getSession).toHaveBeenCalledTimes(2);
    expect(sentFrames.filter((frame) => (frame as { type?: string }).type === "session.subscribe")).toHaveLength(2);
    expect(terminalWrites.map(textFromWrite)).toEqual(["tail\n", "after-reconnect\n"]);
  });

  it("sends input frames, resize frames only on dimension changes, and unsubscribes on unmount", async () => {
    const root = await renderTerminal();
    await act(async () => {
      streamHandlers?.onOpen();
    });

    await act(async () => {
      onDataHandler?.("ls\n");
    });

    expect(sentFrames).toContainEqual({
      type: "session.input",
      sessionId: "sess-1",
      dataBase64: b64("ls\n"),
    });

    await act(async () => {
      ResizeObserverMock.instances[0]?.emit();
      ResizeObserverMock.instances[0]?.emit();
    });

    expect(sentFrames.filter((frame) => (frame as { type?: string }).type === "session.resize")).toHaveLength(1);

    await act(async () => {
      if (latestTerminal) {
        latestTerminal.cols = 100;
        latestTerminal.rows = 30;
      }
      ResizeObserverMock.instances[0]?.emit();
    });

    expect(sentFrames.filter((frame) => (frame as { type?: string }).type === "session.resize")).toHaveLength(2);

    await act(async () => {
      root.unmount();
    });

    expect(sentFrames).toContainEqual({ type: "session.unsubscribe", sessionId: "sess-1" });
    expect(streamClosed).toBe(true);
    expect(terminalDisposes).toEqual(["terminal"]);
    expect(fitDisposes).toEqual(["fit"]);

    const sentBeforeDisposedInput = sentFrames.length;
    await act(async () => {
      onDataHandler?.("after-dispose");
    });
    expect(sentFrames).toHaveLength(sentBeforeDisposedInput);
  });

  it("does not send terminal input after the session reaches a terminal status", async () => {
    await renderTerminal("exited");
    await act(async () => {
      streamHandlers?.onOpen();
      onDataHandler?.("ignored");
    });

    expect(sentFrames.some((frame) => (frame as { type?: string }).type === "session.input")).toBe(false);
  });
});
