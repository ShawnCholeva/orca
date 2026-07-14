import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { RefuteCompletionRequest } from "@orca/contracts";
import type { ShadowAsk } from "./recover-step-scoring.js";
import { refuteStepCompletion, composeRefutePrompt } from "./refute-completion.js";

const REQ: RefuteCompletionRequest = {
  step: { name: "Analyze", instructions: "Cover the error paths." },
  goal: { id: "goal-1", intent: "Ship the feature." },
  stepOutput: { summary: "done" }, selfReportedScoring: { successScore: 0.9 },
  oracle: { ran: false, verdict: null, sensorsRun: [], gaps: [] },
};
const ask = (text: string): ShadowAsk => ({ async ask() { return { text }; } });
const askThrows = (): ShadowAsk => ({ async ask() { throw new Error("shadow down"); } });

describe("refuteStepCompletion", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it("parses each tri-state verdict and preserves issueRefs", async () => {
    const p = { reasoning: "no error-path handling in the step output", verdict: "refuted", reason: "misses error paths", issueRefs: ["no-error-path"], inputsConsidered: ["stepOutput"] };
    const r = await refuteStepCompletion(ask(JSON.stringify(p)), { refuteSessionKey: "goal-1::refute", adapterId: "claude-code", request: REQ, timeoutMs: 1000 });
    expect(r).toEqual(p);
  });
  it("respects an uncertain verdict (not coerced to refuted)", async () => {
    const p = { reasoning: "evidence is ambiguous either way", verdict: "uncertain", reason: "cannot tell", issueRefs: [], inputsConsidered: [] };
    const r = await refuteStepCompletion(ask(JSON.stringify(p)), { refuteSessionKey: "goal-1::refute", adapterId: "claude-code", request: REQ, timeoutMs: 1000 });
    expect(r?.verdict).toBe("uncertain");
  });
  it("returns null + logs on throw / non-JSON / invalid", async () => {
    expect(await refuteStepCompletion(askThrows(), { refuteSessionKey: "k", adapterId: "claude-code", request: REQ, timeoutMs: 1000 })).toBeNull();
    expect(await refuteStepCompletion(ask("not json"), { refuteSessionKey: "k", adapterId: "claude-code", request: REQ, timeoutMs: 1000 })).toBeNull();
    expect(await refuteStepCompletion(ask(JSON.stringify({ verdict: "no" })), { refuteSessionKey: "k", adapterId: "claude-code", request: REQ, timeoutMs: 1000 })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[refute]"));
  });
  it("clamps overlong free-text fields instead of discarding the verdict", async () => {
    // Live failure mode (2026-07-07): the reviewer answered "upheld" with a
    // >2000-char reasoning; the schema cap rejected the whole proposal → null →
    // "unavailable" → a needless human pause. Reasoning/reason are audit trail,
    // not gate inputs — truncate, keep the verdict.
    const p = {
      reasoning: "x".repeat(5000), verdict: "upheld", reason: "y".repeat(3000),
      issueRefs: ["z".repeat(300)], inputsConsidered: ["w".repeat(900)],
    };
    const r = await refuteStepCompletion(ask(JSON.stringify(p)), { refuteSessionKey: "goal-1::refute", adapterId: "claude-code", request: REQ, timeoutMs: 1000 });
    expect(r?.verdict).toBe("upheld");
    expect(r!.reasoning.length).toBeLessThanOrEqual(2000);
    expect(r!.reason.length).toBeLessThanOrEqual(1024);
    expect(r!.issueRefs[0]!.length).toBeLessThanOrEqual(128);
    expect(r!.inputsConsidered[0]!.length).toBeLessThanOrEqual(512);
  });
  it("still rejects a genuinely malformed proposal (bad verdict)", async () => {
    const p = { reasoning: "r", verdict: "maybe", reason: "", issueRefs: [], inputsConsidered: [] };
    expect(await refuteStepCompletion(ask(JSON.stringify(p)), { refuteSessionKey: "k", adapterId: "claude-code", request: REQ, timeoutMs: 1000 })).toBeNull();
  });
  it("uses the isolated refute session key (not the bare goalId)", async () => {
    const seen: string[] = [];
    const spy: ShadowAsk = { async ask(key: string) { seen.push(key); return { text: JSON.stringify({ reasoning: "no concrete failure found", verdict: "upheld", reason: "ok", issueRefs: [], inputsConsidered: [] }) }; } };
    await refuteStepCompletion(spy, { refuteSessionKey: "goal-1::refute", adapterId: "claude-code", request: REQ, timeoutMs: 1000 });
    expect(seen).toEqual(["goal-1::refute"]);
  });
  it("scopes the prompt by oracle coverage", () => {
    const { systemPrompt, userPrompt } = composeRefutePrompt({ ...REQ, oracle: { ran: true, verdict: "passed", sensorsRun: [{ kind: "test", summary: "ok" }], gaps: ["integration"] } });
    expect(systemPrompt).toContain("orca:action");
    expect(systemPrompt).toContain("refute");
    expect(userPrompt).toContain("integration");
  });
  it("emits reasoning before the verdict in the prompt literal", () => {
    const { systemPrompt } = composeRefutePrompt(REQ);
    expect(systemPrompt.indexOf('"reasoning"')).toBeGreaterThan(-1);
    expect(systemPrompt.indexOf('"reasoning"')).toBeLessThan(systemPrompt.indexOf('"verdict"'));
  });
  it("directs the reviewer to judge only from the provided data and use no tools", () => {
    const { systemPrompt } = composeRefutePrompt(REQ);
    expect(systemPrompt).toMatch(/do NOT use any tools/i);
    expect(systemPrompt.toLowerCase()).toContain("provided");
  });
  it("returns null when the model omits the now-required reasoning", async () => {
    const bad = JSON.stringify({ verdict: "upheld", reason: "", issueRefs: [], inputsConsidered: [] });
    expect(await refuteStepCompletion(ask(bad), { refuteSessionKey: "k", adapterId: "claude-code", request: REQ, timeoutMs: 1000 })).toBeNull();
  });
});
