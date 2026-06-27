import { describe, expect, it } from "vitest";
import { extractOrchestratorReasoning } from "./reasoning-extract.js";

describe("extractOrchestratorReasoning", () => {
  it("returns prose with the orca:action block stripped", () => {
    const turn = "I'll route to the feature branch because the goal has a spec.\n\n```orca:action\n{\"kind\":\"route\"}\n```";
    expect(extractOrchestratorReasoning(turn)).toBe("I'll route to the feature branch because the goal has a spec.");
  });
  it("returns empty string when only the action block is present", () => {
    expect(extractOrchestratorReasoning("```orca:action\n{}\n```")).toBe("");
  });
});
