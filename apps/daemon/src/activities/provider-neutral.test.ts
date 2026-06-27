import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EventBus } from "../events.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { listActivitiesByGoal } from "./projection.js";
import type { ActivityStoreCtx } from "./store.js";
import { ActivityUpdater } from "./updater.js";

describe("provider-neutral activity contract", () => {
  let db: Database.Database;
  let ctx: ActivityStoreCtx;
  let updater: ActivityUpdater;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, defaultMigrationsDir());
    db.prepare(
      `INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
       VALUES ('g1', 'Goal', '', 'active', 1, '2026-06-05', '2026-06-05', null)`
    ).run();

    const bus = new EventBus();
    let nextId = 0;
    ctx = {
      db,
      bus,
      now: () => "2026-06-05T00:00:00.000Z",
      idFactory: () => `activity-${++nextId}`
    };
    updater = new ActivityUpdater(() => 0);
  });

  afterEach(() => {
    db.close();
  });

  it("produces a coherent thread with zero reasoning notes when no transcript exists", () => {
    updater.apply(ctx, {
      kind: "step_started",
      goalId: "g1",
      workflowRunId: "r1",
      stepRunId: "s1",
      agentSessionId: "codex-sess",
      stepName: "S"
    });
    updater.apply(ctx, {
      kind: "tool_use",
      goalId: "g1",
      workflowRunId: "r1",
      stepRunId: "s1",
      agentSessionId: "codex-sess",
      category: "running",
      detail: "ran build",
      diff: null
    });
    updater.apply(ctx, {
      kind: "turn_completed",
      stepRunId: "s1",
      summary: "done",
      confidence: null
    });

    const acts = listActivitiesByGoal(db, "g1");
    const a = acts.find((x) => x.stepRunId === "s1");

    expect(a?.status).toBe("completed");
    // no reasoning_note signals were applied → no empty steps from reasoning
    expect(a?.steps.every((s) => s.text !== "")).toBe(true);
    expect(a?.steps.some((s) => s.category === "running")).toBe(true);
  });
});
