import { describe, expect, it } from "vitest";
import {
  formatRevisionForWorker,
  incrementReviseAttempt,
  REVISE_CAP,
  summarizeEscalationFeedback,
} from "./revise-loop.js";

describe("formatRevisionForWorker", () => {
  // Live incident (2026-07-29): the user's revision text was delivered to the
  // Research worker verbatim, as a bare user turn. Read as a standalone
  // instruction it licensed work the step forbids.
  const args = { stepName: "Research", feedback: "I want to resolve the blocking constraint before we move on" };

  it("carries the user's words verbatim", () => {
    expect(formatRevisionForWorker({ ...args, readOnly: false })).toContain(args.feedback);
  });

  it("names the step so the worker knows it has not advanced", () => {
    expect(formatRevisionForWorker({ ...args, readOnly: false })).toContain("Research");
  });

  it("restates the read-only contract when the step forbids writes", () => {
    expect(formatRevisionForWorker({ ...args, readOnly: true })).toMatch(/make no code changes/i);
  });

  it("omits the read-only clause when the step permits writes", () => {
    expect(formatRevisionForWorker({ ...args, readOnly: false })).not.toMatch(/make no code changes/i);
  });
});

describe("revise loop counter", () => {
  it("REVISE_CAP is 3", () => { expect(REVISE_CAP).toBe(3); });

  it("first attempt: nextAttempt = 1, capReached = false", () => {
    const r = incrementReviseAttempt(0);
    expect(r.nextAttempt).toBe(1);
    expect(r.capReached).toBe(false);
  });

  it("third attempt reaches cap", () => {
    expect(incrementReviseAttempt(2).capReached).toBe(true);
  });
});

describe("summarizeEscalationFeedback", () => {
  it("passes short prose through untouched", () => {
    const feedback = "The plan step never named a persistence host. Pick one and re-emit.";
    expect(summarizeEscalationFeedback(feedback)).toBe(feedback);
  });

  it("keeps the lead that names the failing check and drops the log payload", () => {
    const log = Array.from({ length: 40 }, (_, i) => `@creator-desk/api:test:  ${i}| expect(before.json())`).join("\n");
    const out = summarizeEscalationFeedback(
      `Required verification did not pass. Fix these and re-run, then re-emit completion:\n- unit (\`npm run test\`): ${log}`
    );
    expect(out).toContain("Required verification did not pass");
    expect(out).toContain("unit (`npm run test`)");
    expect(out).toContain("(Shortened. The agent was given the full detail.)");
    // The screenful of runner output is what made this unreadable in the chat.
    expect(out.length).toBeLessThan(600);
  });

  it("never ends an excerpt mid-word", () => {
    const out = summarizeEscalationFeedback("word ".repeat(400));
    const excerpt = out.split("…")[0];
    expect(excerpt.endsWith("word")).toBe(true);
  });

  it("cuts hard when there is no break to cut on", () => {
    const out = summarizeEscalationFeedback("x".repeat(2000));
    expect(out.length).toBeLessThan(600);
    expect(out).toContain("(Shortened. The agent was given the full detail.)");
  });
});
