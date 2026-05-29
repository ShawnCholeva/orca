import { describe, expect, it, vi } from "vitest";
import { judgeAgentResponse } from "./judgement.js";

describe("judgeAgentResponse", () => {
  it("returns paraphrase action when no step-complete block", async () => {
    const mediator = { invoke: vi.fn(async () => ({ kind: "paraphrase_agent_message", body: "hi" })) };
    const out = await judgeAgentResponse({
      mediator: mediator as any,
      schemaValidate: vi.fn(() => ({ ok: true as const })),
      goalId: "g", runId: "r", stepRunId: "s", adapterId: "claude-code", modelId: "claude-haiku-4-5",
      responseText: "agent says",
    });
    expect(out.kind).toBe("paraphrase_agent_message");
  });

  it("returns revise action when schema invalid (no orchestrator-LLM call)", async () => {
    const mediator = { invoke: vi.fn() };
    const out = await judgeAgentResponse({
      mediator: mediator as any,
      schemaValidate: () => ({ ok: false, errors: ["missing field"] }),
      goalId: "g", runId: "r", stepRunId: "s", adapterId: "claude-code", modelId: "claude-haiku-4-5",
      responseText: "```orca:step-complete\n{}\n```",
    });
    expect(out.kind).toBe("revise_step");
    expect(mediator.invoke).not.toHaveBeenCalled();
  });

  it("returns approve action when LLM approves", async () => {
    const mediator = { invoke: vi.fn(async () => ({ kind: "approve_step_complete" })) };
    const out = await judgeAgentResponse({
      mediator: mediator as any,
      schemaValidate: () => ({ ok: true }),
      goalId: "g", runId: "r", stepRunId: "s", adapterId: "claude-code", modelId: "claude-haiku-4-5",
      responseText: "```orca:step-complete\n{\"a\":1}\n```",
    });
    expect(out.kind).toBe("approve_step_complete");
  });
});
