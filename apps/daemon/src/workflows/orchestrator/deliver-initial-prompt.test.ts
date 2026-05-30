import { describe, expect, it, vi } from "vitest";
import {
  deliverInitialPrompt,
  renderSessionTailText,
  type DeliverInitialPromptDeps,
} from "./deliver-initial-prompt.js";

function fakeHandle() {
  const writes: string[] = [];
  return {
    writes,
    handle: { write: (b: Buffer) => void writes.push(b.toString("utf8")) },
  };
}

const noSleep = () => Promise.resolve();

describe("deliverInitialPrompt", () => {
  it("returns no_session when the session has no live handle", async () => {
    const deps: DeliverInitialPromptDeps = {
      getHandle: () => undefined,
      readTailText: () => "",
      sleep: noSleep,
    };
    expect(await deliverInitialPrompt(deps, "s1", "do it")).toBe("no_session");
  });

  it("writes the prompt as a bracketed paste + Enter once the input box is ready", async () => {
    const { writes, handle } = fakeHandle();
    const deps: DeliverInitialPromptDeps = {
      getHandle: () => handle,
      readTailText: () => "auto mode on (shift+tab to cycle)",
      sleep: noSleep,
    };
    const result = await deliverInitialPrompt(deps, "s1", "line one\nline two");
    expect(result).toBe("delivered");
    // First write: bracketed-paste wrapped prompt. Second: the submit Enter.
    expect(writes[0]).toBe("\x1b[200~line one\nline two\x1b[201~");
    expect(writes[1]).toBe("\r");
  });

  it("answers the first-run trust prompt with Enter, then delivers", async () => {
    const { writes, handle } = fakeHandle();
    const panes = ["Do you trust the files in this folder?", "auto mode on"];
    let i = 0;
    const deps: DeliverInitialPromptDeps = {
      getHandle: () => handle,
      readTailText: () => panes[Math.min(i++, panes.length - 1)]!,
      sleep: noSleep,
      readyQuietMs: 0,
    };
    const result = await deliverInitialPrompt(deps, "s1", "go");
    expect(result).toBe("delivered");
    // Enter for trust, then paste + Enter for the prompt.
    expect(writes[0]).toBe("\r");
    expect(writes[1]).toBe("\x1b[200~go\x1b[201~");
    expect(writes[2]).toBe("\r");
  });

  it("times out without submitting if the agent never becomes ready", async () => {
    const { writes, handle } = fakeHandle();
    let t = 0;
    const deps: DeliverInitialPromptDeps = {
      getHandle: () => handle,
      readTailText: () => "still booting...",
      sleep: noSleep,
      now: () => (t += 100), // advances past the 20s deadline quickly
      readyTimeoutMs: 500,
    };
    const result = await deliverInitialPrompt(deps, "s1", "go");
    expect(result).toBe("timeout");
    expect(writes).toEqual([]);
  });

  it("returns no_session if the session dies during the readiness wait", async () => {
    let alive = true;
    const deps: DeliverInitialPromptDeps = {
      getHandle: () => (alive ? { write: vi.fn() } : undefined),
      readTailText: () => {
        alive = false; // session exits right as we observe a ready pane
        return "auto mode on";
      },
      sleep: noSleep,
    };
    expect(await deliverInitialPrompt(deps, "s1", "go")).toBe("no_session");
  });
});

describe("renderSessionTailText", () => {
  it("decodes and concatenates base64 chunks", () => {
    const snapshot = {
      chunks: [
        { dataBase64: Buffer.from("hello ").toString("base64") },
        { dataBase64: Buffer.from("world").toString("base64") },
      ],
    };
    expect(renderSessionTailText(snapshot)).toBe("hello world");
  });

  it("keeps only the trailing scan window for large output", () => {
    const big = "x".repeat(20 * 1024) + "READY";
    const snapshot = { chunks: [{ dataBase64: Buffer.from(big).toString("base64") }] };
    const out = renderSessionTailText(snapshot);
    expect(out.length).toBe(16 * 1024);
    expect(out.endsWith("READY")).toBe(true);
  });
});
