import { describe, expect, it } from "vitest";
import { ClaudeAgentProvider } from "./claude.js";

// Pane fixtures captured from a live probe of the current Claude Code CLI
// (2026-07-06): during an active turn the CLI renders a cycling spinner glyph
// plus a gerund with an ellipsis — it does NOT render "esc to interrupt".
// detectTurnStarted keying only on that legacy phrase was a permanent
// false-negative: submits were never confirmed, Enters were re-sent into
// running turns, and slow refute turns were abandoned as `unavailable`
// even though the model completed them (dishonest boundary).

const RUNNING_PANE = [
  "✳ Newspapering…",
  "  ⎿  Tip: Use /memory to view and manage Claude memory",
  "  tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf",
  "────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────",
  "  ctx:97%  5h:30%  7d:46%  Fable 5",
  "  ← for agents",
].join("\n");

const RUNNING_PANE_VARIANT_GLYPHS = ["✢ Cooking…", "✽ Deliberating…", "· Simmering…", "∗ Working…", "✻ Reticulating…"];

const COMPLETED_PANE = [
  "  30",
  "✻ Cooked for 4s",
  "  tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf",
  "────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────",
  "  ctx:97%  5h:30%  7d:46%  Fable 5",
].join("\n");

const IDLE_FRESH_PANE = [
  "────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────",
  "  Fable 5",
  "  ← for agents",
].join("\n");

// Older CLI versions rendered this phrase while running; keep detecting it.
const LEGACY_RUNNING_PANE = "✻ Thinking… (esc to interrupt)";

// A completed turn whose RESPONSE TEXT contains an ellipsis word must not
// read as running (spinner match must be line-anchored to the glyph).
const COMPLETED_WITH_ELLIPSIS_BODY = [
  "⏺ The plan is Loading… then done.",
  "✻ Cooked for 2s",
  "❯ ",
].join("\n");

describe("ClaudeAgentProvider.turnParser().detectTurnStarted", () => {
  const detect = new ClaudeAgentProvider().turnParser().detectTurnStarted!;

  it("detects the current CLI's running spinner (no 'esc to interrupt' rendered)", () => {
    expect(detect(RUNNING_PANE)).toBe(true);
  });

  it("detects every observed spinner glyph variant", () => {
    for (const line of RUNNING_PANE_VARIANT_GLYPHS) {
      expect(detect(`${line}\n❯ `), line).toBe(true);
    }
  });

  it("still detects the legacy 'esc to interrupt' phrase", () => {
    expect(detect(LEGACY_RUNNING_PANE)).toBe(true);
  });

  it("does not fire on a completed turn ('Cooked for Ns' has no ellipsis)", () => {
    expect(detect(COMPLETED_PANE)).toBe(false);
  });

  it("does not fire on an idle fresh pane", () => {
    expect(detect(IDLE_FRESH_PANE)).toBe(false);
  });

  it("does not fire on ellipsis words inside response text", () => {
    expect(detect(COMPLETED_WITH_ELLIPSIS_BODY)).toBe(false);
  });
});
