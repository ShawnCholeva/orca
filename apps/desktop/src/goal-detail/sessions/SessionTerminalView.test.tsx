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
let latestTerminal: { cols: number; rows: number; options: { fontSize: number } } | null = null;
// The element xterm was opened on — where a real keystroke's DOM event lands.
let openedContainer: HTMLElement | null = null;

/** A keystroke as the DOM delivers it, then the data xterm emits for it. */
function typeIntoTerminal(data: string): void {
  openedContainer?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
  onDataHandler?.(data);
}

const resizeCalls: { cols: number; rows: number }[] = [];
const constructorOptions: Record<string, unknown>[] = [];
// Monospace cell proportions, so a font size maps to a rendered screen size.
const CELL_WIDTH_RATIO = 0.6;
const CELL_HEIGHT_RATIO = 1.2;
/** How far past the screen box a row draws, as a fallback glyph makes it. */
let rowOverflowPx = 0;
let focusCalls = 0;

/** The box the terminal has to fit inside; jsdom reports 0 for every element. */
function stubSurfaceBox(width: number, height: number): void {
  for (const [prop, value] of [["clientWidth", width], ["clientHeight", height]] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList?.contains("session-terminal-surface") ? value : 0;
      },
    });
  }
}

vi.mock("xterm", () => ({
  Terminal: vi.fn().mockImplementation((opts: Record<string, unknown>) => {
    constructorOptions.push(opts);
    const terminal = {
      cols: (opts?.["cols"] as number) ?? 80,
      rows: (opts?.["rows"] as number) ?? 24,
      options: { fontSize: 13 } as { fontSize: number; disableStdin?: boolean },
      loadAddon: vi.fn(),
      focus: vi.fn(() => { focusCalls += 1; }),
      open: vi.fn((el: HTMLElement) => {
        openedContainer = el;
        // A stand-in for what xterm renders: a screen whose size is the grid times
        // the cell, and a cell proportional to the font. The component measures
        // this, so the test has to have it.
        const screen = document.createElement("div");
        screen.className = "xterm-screen";
        Object.defineProperty(screen, "clientWidth", {
          get: () => Math.round(terminal.cols * terminal.options.fontSize * CELL_WIDTH_RATIO),
        });
        Object.defineProperty(screen, "clientHeight", {
          get: () => Math.round(terminal.rows * terminal.options.fontSize * CELL_HEIGHT_RATIO),
        });
        el.appendChild(screen);
        // The rows xterm draws. A row can render WIDER than the screen box when a
        // glyph falls back to another font, which is the overflow that hung
        // outside the panel — so a row's extra width is modelled here.
        const rows = document.createElement("div");
        rows.className = "xterm-rows";
        const row = document.createElement("div");
        const cell = document.createElement("span");
        Object.defineProperty(cell, "getBoundingClientRect", {
          value: () => ({
            right: Math.round(terminal.cols * terminal.options.fontSize * CELL_WIDTH_RATIO) + rowOverflowPx,
          }),
        });
        row.appendChild(cell);
        rows.appendChild(row);
        Object.defineProperty(rows, "getBoundingClientRect", { value: () => ({ left: 0 }) });
        screen.appendChild(rows);
      }),
      write: vi.fn((data: unknown) => terminalWrites.push(data)),
      resize: vi.fn((cols: number, rows: number) => {
        resizeCalls.push({ cols, rows });
        terminal.cols = cols;
        terminal.rows = rows;
      }),
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

// The room the container leaves at the base font size — what a real FitAddon
// measures, and what the pinned path scales the type against.
let proposedRoom: { cols: number; rows: number } | undefined = { cols: 253, rows: 47 };
const fitCalls: string[] = [];

vi.mock("xterm-addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(() => fitCalls.push("fit")),
    proposeDimensions: vi.fn(() => proposedRoom),
    dispose: vi.fn(() => fitDisposes.push("fit")),
  })),
}));

type SessionErrorLike = { type: "session.error"; sessionId?: string; code: string; message: string };
type StreamHandlers = {
  onOpen(): void;
  onFrame(frame: SessionOutputFrame | SessionErrorLike): void;
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

function makeDetail(
  chunks: { seq: number; data: string }[],
  nextSeq = chunks.length,
  pane: { paneFixed: boolean; terminalCols: number | null; terminalRows: number | null } = {
    paneFixed: false, terminalCols: null, terminalRows: null,
  },
): GetSessionResponse {
  return {
    session: {
      ...pane,
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

async function renderTerminal(
  status: "running" | "exited" = "running",
  pane: { cols: number; rows: number } | null = null,
  autoFocus = false,
): Promise<Root> {
  const { SessionTerminalView } = await import("./SessionTerminalView");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SessionTerminalView sessionId="sess-1" status={status} pane={pane} autoFocus={autoFocus} />,
    );
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
      typeIntoTerminal("ls\n");
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
      typeIntoTerminal("ignored");
    });

    expect(sentFrames.some((frame) => (frame as { type?: string }).type === "session.input")).toBe(false);
  });

  it("never forwards xterm's own answers to the terminal queries in the output", async () => {
    // A viewer is not the agent's terminal — tmux already answered these. Ours
    // were reaching the live agent's stdin as if a human had typed them.
    await renderTerminal();
    await act(async () => {
      streamHandlers?.onOpen();
      // No DOM key event: this is the write queue replying to a device-attributes
      // query it just rendered.
      onDataHandler?.("\u001b[?62;c");
    });

    expect(sentFrames.some((frame) => (frame as { type?: string }).type === "session.input")).toBe(false);

    // A real keystroke still goes through.
    await act(async () => {
      typeIntoTerminal("a");
    });
    expect(sentFrames).toContainEqual({
      type: "session.input",
      sessionId: "sess-1",
      dataBase64: b64("a"),
    });
  });
});

describe("SessionTerminalView agent_busy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    terminalWrites.length = 0;
    sentFrames.length = 0;
    streamHandlers = null;
    ResizeObserverMock.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    getSession.mockResolvedValue(makeDetail([{ seq: 0, data: "tail\n" }], 1));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("shows a passing notice — not a failure — when the agent refuses a key mid-turn", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderTerminal();
    await act(async () => {});
    await act(async () => { streamHandlers?.onOpen(); });

    await act(async () => {
      streamHandlers?.onFrame({
        type: "session.error",
        sessionId: "sess-1",
        code: "agent_busy",
        message: "the agent is working — wait for it to finish its turn",
      });
    });

    expect(document.body.textContent).toContain("the agent is working");
    // A busy agent is not a broken session, so nothing renders as an error…
    expect(document.querySelector(".form-error")).toBeNull();

    // …and the notice clears itself once the moment has passed.
    await act(async () => { vi.advanceTimersByTime(2500); });
    expect(document.body.textContent).not.toContain("the agent is working");
  });

  it("still surfaces a real session error", async () => {
    await renderTerminal();
    await act(async () => {});
    await act(async () => { streamHandlers?.onOpen(); });

    await act(async () => {
      streamHandlers?.onFrame({
        type: "session.error",
        sessionId: "sess-1",
        code: "not_active",
        message: "session not running",
      });
    });

    expect(document.querySelector(".form-error")?.textContent).toBe("session not running");
  });
});

// A workflow worker's pane is created at a fixed size and never resized. Its
// recorded output is full of redraws addressed to those exact coordinates, so a
// viewer that picks its own column count scatters them — which is what made the
// embedded terminal unreadable.
describe("SessionTerminalView with a daemon-owned pane", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    terminalWrites.length = 0;
    resizeCalls.length = 0;
    constructorOptions.length = 0;
    fitCalls.length = 0;
    sentFrames.length = 0;
    streamHandlers = null;
    latestTerminal = null;
    proposedRoom = { cols: 253, rows: 47 };
    rowOverflowPx = 0;
    focusCalls = 0;
    ResizeObserverMock.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const PANE = { cols: 220, rows: 50 };
  // What the grid measures at the base font: 220 * 13 * 0.6 by 50 * 13 * 1.2.
  const BASE_W = 1716;
  const BASE_H = 780;

  it("builds the terminal at the pane's grid, with no first frame at another size", async () => {
    stubSurfaceBox(BASE_W, BASE_H);
    getSession.mockResolvedValue(makeDetail([], 0));
    await renderTerminal("running", PANE);
    await act(async () => {});

    // Constructed at the grid — never 80x24 first and corrected afterwards.
    expect(constructorOptions.at(-1)).toMatchObject({ cols: 220, rows: 50 });
    expect(resizeCalls.at(-1)).toEqual({ cols: 220, rows: 50 });
    expect(latestTerminal?.options.fontSize).toBe(13);
    // Fitting would have chosen the column count instead — the bug.
    expect(fitCalls).toHaveLength(0);
  });

  it("keeps the whole grid inside the box rather than letting columns hang out", async () => {
    // The rounding that made proposeDimensions() call an overflowing grid a fit.
    stubSurfaceBox(BASE_W - 40, BASE_H);
    getSession.mockResolvedValue(makeDetail([], 0));
    await renderTerminal("running", PANE);
    await act(async () => {});

    const size = latestTerminal!.options.fontSize;
    expect(Math.round(220 * size * CELL_WIDTH_RATIO)).toBeLessThanOrEqual(BASE_W - 40);
    expect(Math.round(50 * size * CELL_HEIGHT_RATIO)).toBeLessThanOrEqual(BASE_H);
    expect(resizeCalls.at(-1)).toEqual({ cols: 220, rows: 50 });
  });

  it("shrinks for a row that draws wider than the grid xterm reports", async () => {
    // Symbol and box-drawing glyphs fall back to another font and push a row past
    // the width xterm claims. Trusting that claim left those rows clipped.
    rowOverflowPx = 40;
    stubSurfaceBox(BASE_W, BASE_H);
    getSession.mockResolvedValue(makeDetail([], 0));
    await renderTerminal("running", PANE);
    await act(async () => {});

    const size = latestTerminal!.options.fontSize;
    expect(size).toBeLessThan(13);
    expect(Math.round(220 * size * CELL_WIDTH_RATIO) + rowOverflowPx).toBeLessThanOrEqual(BASE_W);
    expect(resizeCalls.at(-1)).toEqual({ cols: 220, rows: 50 });
  });

  it("re-measures once there is content, since an empty grid cannot overflow", async () => {
    // The rows that overflow carry the agent's prompt, rules and status line —
    // none of which exist at mount, when the first measurement is taken.
    stubSurfaceBox(BASE_W, BASE_H);
    getSession.mockResolvedValue(makeDetail([], 0));
    await renderTerminal("running", PANE);
    await act(async () => {});
    expect(latestTerminal?.options.fontSize).toBe(13);

    rowOverflowPx = 40;
    await act(async () => {
      streamHandlers?.onOpen();
      streamHandlers?.onFrame({
        type: "session.output", sessionId: "sess-1", seq: 0, byteOffset: 0, dataBase64: b64("drawn"),
      });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    const size = latestTerminal!.options.fontSize;
    expect(size).toBeLessThan(13);
    expect(Math.round(220 * size * CELL_WIDTH_RATIO) + rowOverflowPx).toBeLessThanOrEqual(BASE_W);
  });

  it("lets width decide when width is the tighter axis", async () => {
    stubSurfaceBox(BASE_W / 2, BASE_H * 3);
    getSession.mockResolvedValue(makeDetail([], 0));
    await renderTerminal("running", PANE);
    await act(async () => {});

    // Half the width it wants, three times the height: width decides. 13/2 = 6.5.
    expect(latestTerminal?.options.fontSize).toBe(6.5);
    expect(resizeCalls.at(-1)).toEqual({ cols: 220, rows: 50 });
  });

  it("never proposes a size to a daemon-owned pane", async () => {
    stubSurfaceBox(BASE_W, BASE_H);
    getSession.mockResolvedValue(makeDetail([], 0));
    await renderTerminal("running", PANE);
    await act(async () => {});
    await act(async () => { streamHandlers?.onOpen(); });

    expect(sentFrames.some((f) => (f as { type?: string }).type === "session.resize")).toBe(false);
  });

  it("re-scales rather than re-flows when the container changes size", async () => {
    stubSurfaceBox(BASE_W / 2, BASE_H * 3);
    getSession.mockResolvedValue(makeDetail([], 0));
    await renderTerminal("running", PANE);
    await act(async () => {});
    expect(latestTerminal?.options.fontSize).toBe(6.5);

    stubSurfaceBox(BASE_W * 2, BASE_H * 3);
    await act(async () => { ResizeObserverMock.instances[0]?.emit(); });

    // Twice the room: the type doubles off the BASE size, never compounding off
    // the size the previous pass already set.
    expect(latestTerminal?.options.fontSize).toBe(26);
    expect(resizeCalls.at(-1)).toEqual({ cols: 220, rows: 50 });
  });

  it("still lets a pty-backed session size itself", async () => {
    stubSurfaceBox(BASE_W, BASE_H);
    getSession.mockResolvedValue(makeDetail([], 0));
    await renderTerminal("running", null);
    await act(async () => {});

    expect(fitCalls.length).toBeGreaterThan(0);
    expect(resizeCalls).toHaveLength(0);
  });
});

describe("SessionTerminalView autoFocus", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    focusCalls = 0;
    rowOverflowPx = 0;
    sentFrames.length = 0;
    streamHandlers = null;
    ResizeObserverMock.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    getSession.mockResolvedValue(makeDetail([], 0));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("puts the keyboard in the terminal when the view exists for this one session", async () => {
    await renderTerminal("running", null, true);
    await act(async () => {});

    expect(focusCalls).toBe(1);
  });

  it("leaves focus alone when it is one terminal among several", async () => {
    await renderTerminal("running", null, false);
    await act(async () => {});

    expect(focusCalls).toBe(0);
  });
});
