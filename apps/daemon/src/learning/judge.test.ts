import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { JudgeInstructionEditRequest } from "@orca/contracts";
import type { ShadowAsk } from "../workflows/orchestrator/recover-step-scoring.js";
import { judgeInstructionEdit, composeJudgePrompt } from "./judge.js";

const REQ: JudgeInstructionEditRequest = {
  step: { name: "analyze", currentInstructions: "Cover the error paths.", proposedInstructions: "Cover error paths and log them." },
  targetedFailureMode: { rule: "R2", failureCode: "invalid_output", clusterCount: 4, signalCount: null },
  solvedCases: [{ stepRunId: "s1", output: "{\"ok\":1}" }],
  failureCases: [{ stepRunId: "s2", output: "{\"bad\":1}" }],
};
const ask = (text: string): ShadowAsk => ({ async ask() { return { text }; } });
const askThrows = (): ShadowAsk => ({ async ask() { throw new Error("shadow down"); } });

describe("judgeInstructionEdit", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it("parses a regression_risk verdict and preserves regressionCases", async () => {
    const p = { verdict: "regression_risk", regressionRisk: "likely", addressesFailureMode: "partial", regressionCases: ["s1"], reason: "would drop error check", inputsConsidered: ["s1", "s2"] };
    const r = await judgeInstructionEdit(ask(JSON.stringify(p)), { judgeSessionKey: "t1::judge", adapterId: "claude-code", request: REQ, timeoutMs: 1000 });
    expect(r).toEqual(p);
  });
  it("respects an uncertain verdict", async () => {
    const p = { verdict: "uncertain", regressionRisk: "possible", addressesFailureMode: "unclear", regressionCases: [], reason: "cannot tell", inputsConsidered: [] };
    const r = await judgeInstructionEdit(ask(JSON.stringify(p)), { judgeSessionKey: "t1::judge", adapterId: "claude-code", request: REQ, timeoutMs: 1000 });
    expect(r?.verdict).toBe("uncertain");
  });
  it("returns null + logs on throw / non-JSON / invalid", async () => {
    expect(await judgeInstructionEdit(askThrows(), { judgeSessionKey: "k", adapterId: "claude-code", request: REQ, timeoutMs: 1000 })).toBeNull();
    expect(await judgeInstructionEdit(ask("not json"), { judgeSessionKey: "k", adapterId: "claude-code", request: REQ, timeoutMs: 1000 })).toBeNull();
    expect(await judgeInstructionEdit(ask(JSON.stringify({ verdict: "nope" })), { judgeSessionKey: "k", adapterId: "claude-code", request: REQ, timeoutMs: 1000 })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[judge]"));
  });
  it("asks the isolated ${templateId}::judge key", async () => {
    const seen: string[] = [];
    const spy: ShadowAsk = { async ask(key: string) { seen.push(key); return { text: JSON.stringify({ verdict: "pass", regressionRisk: "none", addressesFailureMode: "yes", regressionCases: [], reason: "ok", inputsConsidered: [] }) }; } };
    await judgeInstructionEdit(spy, { judgeSessionKey: "t1::judge", adapterId: "claude-code", request: REQ, timeoutMs: 1000 });
    expect(seen).toEqual(["t1::judge"]);
  });
  it("prompt grounds on instructions + both buckets, forbids deferring to prior scoring", () => {
    const { systemPrompt, userPrompt } = composeJudgePrompt(REQ);
    expect(systemPrompt).toContain("orca:action");
    expect(systemPrompt).toContain("INSTRUCTIONS");
    expect(systemPrompt).toContain("regress");
    expect(userPrompt).toContain("proposedInstructions");
  });
});
