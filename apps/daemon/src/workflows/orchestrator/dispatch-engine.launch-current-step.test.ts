import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { closeDatabase } from "../../db.js";
import { resetWorkflowEventPreparedStatements } from "../events.js";
import { DispatchEngine } from "./dispatch-engine.js";
import {
  cleanupHarness,
  fakeRegistry,
  fakeStepDispatch,
  NOW,
  seedSkillWorkflow,
  setupHarness,
} from "./skill-step-test-helpers.js";

// launchCurrentStepIfIdle is the client-facing follow-through a route calls
// after requestNextDecision to actually launch the run's current step worker
// (requestNextDecision itself only *selects* an operator — see its doc
// comment in dispatch-engine.ts). These tests cover the no-op guards it
// inherits from spawnRoutedStep: a parked gate/splitter destination (null
// current step) and a run that isn't active.

function makeEngine(): DispatchEngine {
  const broker = { async propose(): Promise<never> { throw new Error("broker should not be called"); } };
  return new DispatchEngine(
    broker,
    fakeRegistry(),
    { launch: async () => { throw new Error("launcher should not be called"); } },
    fakeStepDispatch(),
    undefined,
    undefined,
    undefined
  );
}

function sessionCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c;
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  cleanupHarness();
});

describe("DispatchEngine.launchCurrentStepIfIdle no-op guards", () => {
  it("no-ops when the run's current step is null (parked gate/splitter destination)", async () => {
    const { db } = setupHarness();
    seedSkillWorkflow(db);
    db.prepare("UPDATE workflow_runs SET current_step_run_id = NULL WHERE id = 'run-1'").run();

    const engine = makeEngine();
    await expect(
      engine.launchCurrentStepIfIdle(db, () => NOW, "run-1", {})
    ).resolves.toBeUndefined();

    expect(sessionCount(db)).toBe(0);
  });

  it("no-ops when the run is not active", async () => {
    const { db } = setupHarness();
    seedSkillWorkflow(db);
    db.prepare("UPDATE workflow_runs SET status = 'blocked' WHERE id = 'run-1'").run();

    const engine = makeEngine();
    await expect(
      engine.launchCurrentStepIfIdle(db, () => NOW, "run-1", {})
    ).resolves.toBeUndefined();

    expect(sessionCount(db)).toBe(0);
  });
});
