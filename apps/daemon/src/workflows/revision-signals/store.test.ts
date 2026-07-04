import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations, defaultMigrationsDir } from "../../migrations.js";
import { recordRevisionSignal, listRevisionSignals } from "./store.js";

const scoring = {
  reasoning: "output meets the step's stated instructions",
  successScore: 0.9,
  quality: {
    outputCompleteness: 0.9,
    outputCorrectness: 0.85,
    instructionAdherence: 0.95,
    downstreamReadiness: 0.8,
    riskLevel: 0.1
  },
  reason: "ok",
  handoffReady: true
};

describe("revision signal store", () => {
  it("records and lists signals with incrementing index", () => {
    const db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
    recordRevisionSignal(db, { id: "1", stepRunId: "s1", goalId: "g1", supersededScoring: scoring, feedbackText: "more tests", now: "t0" });
    recordRevisionSignal(db, { id: "2", stepRunId: "s1", goalId: "g1", supersededScoring: scoring, feedbackText: null, now: "t1" });
    const rows = listRevisionSignals(db, "s1");
    expect(rows.map((r) => r.revisionIndex)).toEqual([0, 1]);
    expect(rows[0].feedbackText).toBe("more tests");
    expect(rows[1].supersededScoring.successScore).toBe(0.9);
  });
});
