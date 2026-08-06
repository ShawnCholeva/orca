import type { StepSkillProposal } from "@orca/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetWorkflowEventPreparedStatements } from "../events.js";
import { closeDatabase } from "../../db.js";
import { resetWorkflowStepProjectionPreparedStatements } from "../steps/projection.js";
import { DispatchEngine } from "./dispatch-engine.js";
import {
  cleanupHarness,
  fakeBroker,
  fakeRegistry,
  fakeStepDispatch,
  NOW,
  seedSkillWorkflow,
  setupHarness,
} from "./skill-step-test-helpers.js";

// commitAgentStepDecision's direct-launch attempt falls back to a launch
// recommendation on any launcher failure via a bare `catch {}` — swallowing
// the thrown error with no trace. That cost real debugging time chasing this
// bug (the exception could have pointed straight at the cause). This locks
// in that the throw is at least logged before the fallback runs; the
// fallback behavior itself is unchanged.

const ASK: StepSkillProposal = { action: "ask", question: "What problem are we solving?" };

function makeEngine(raw: StepSkillProposal): DispatchEngine {
  return new DispatchEngine(
    fakeBroker(raw),
    fakeRegistry(),
    { launch: async () => { throw new Error("direct_launch_unsupported: no workspace attached"); } },
    fakeStepDispatch(),
    undefined,
    undefined,
    undefined
  );
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  resetWorkflowStepProjectionPreparedStatements();
  cleanupHarness();
});

describe("DispatchEngine commitAgentStepDecision direct-launch failure", () => {
  it("logs the caught launcher error before falling back to a launch recommendation", async () => {
    const { db, bus, idFactory } = setupHarness();
    seedSkillWorkflow(db);
    const engine = makeEngine(ASK);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // First call: deterministically selects the operator (no launch attempt yet).
    await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    expect(errorSpy).not.toHaveBeenCalled();

    // Second call: routes into the agent branch and attempts a direct launch,
    // which throws — that throw must be logged before the recommendation fallback.
    const second = await engine.requestNextDecision(db, () => NOW, "run-1", { bus, idFactory });
    expect(second.decision.selectedAction).toBe("launch:agent:claude-code");
    expect(second.recommendationIds).toHaveLength(1);

    expect(errorSpy).toHaveBeenCalled();
    const loggedTheThrow = errorSpy.mock.calls.some((args) =>
      args.some((a) => a instanceof Error && a.message.includes("direct_launch_unsupported"))
    );
    expect(loggedTheThrow).toBe(true);

    errorSpy.mockRestore();
  });
});
