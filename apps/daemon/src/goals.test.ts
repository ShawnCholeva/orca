import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { closeDatabase, openDatabase } from "./db.js";
import { defaultMigrationsDir, runMigrations } from "./migrations.js";
import { eventBus } from "./events.js";
import {
  archiveGoal,
  createGoal,
  listGoals,
  NotFoundError,
  updateGoal,
  ValidationError,
} from "./goals.js";

const tempDirs: string[] = [];

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: "silent",
    getAuthToken: () => "test-token",
  };
}

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-goals-test-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir);
  return db;
}

function forceGoalInsertFailure(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER force_goal_insert_failure BEFORE INSERT ON goals
    BEGIN SELECT RAISE(ABORT, 'forced failure for rollback test'); END;
  `);
}

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createGoal", () => {
  it("returns a Goal; events and goals each have exactly one row with matching id", () => {
    const db = setup();

    const goal = createGoal({ title: "X" });

    expect(goal.id).toBeTypeOf("string");
    expect(goal.title).toBe("X");
    expect(goal.status).toBe("active");
    expect(goal.archivedAt).toBeNull();

    const eventCount = (
      db.prepare("SELECT count(*) as cnt FROM events").get() as { cnt: number }
    ).cnt;
    const goalCount = (
      db.prepare("SELECT count(*) as cnt FROM goals").get() as { cnt: number }
    ).cnt;

    expect(eventCount).toBe(1);
    expect(goalCount).toBe(1);

    const eventRow = db
      .prepare("SELECT type, goal_id FROM events WHERE goal_id = ?")
      .get(goal.id) as { type: string; goal_id: string } | undefined;

    expect(eventRow?.type).toBe("goal.created");
    expect(eventRow?.goal_id).toBe(goal.id);
  });

  it("rolls back both event and goal rows when the goal insert fails", () => {
    const db = setup();
    forceGoalInsertFailure(db);

    expect(() => createGoal({ title: "Y" })).toThrow();

    const eventCount = (
      db.prepare("SELECT count(*) as cnt FROM events").get() as { cnt: number }
    ).cnt;
    const goalCount = (
      db.prepare("SELECT count(*) as cnt FROM goals").get() as { cnt: number }
    ).cnt;

    expect(eventCount).toBe(0);
    expect(goalCount).toBe(0);
  });

  it("does not call bus.publish when the transaction rolls back", () => {
    const db = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");
    forceGoalInsertFailure(db);

    expect(() => createGoal({ title: "Z" })).toThrow();

    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("calls bus.publish exactly once on success with a numeric seq", () => {
    setup();
    const publishSpy = vi.spyOn(eventBus, "publish");

    createGoal({ title: "Alpha" });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0]![0]!;
    expect(typeof event.seq).toBe("number");
    expect(event.seq).toBeGreaterThan(0);
    expect(event.type).toBe("goal.created");
  });

  it("throws ValidationError for invalid input", () => {
    setup();
    expect(() => createGoal({ title: "" })).toThrow(ValidationError);
    expect(() => createGoal({})).toThrow(ValidationError);
  });
});

describe("listGoals", () => {
  it("returns the created goal", () => {
    setup();

    const created = createGoal({ title: "Beta" });
    const goals = listGoals();

    expect(goals).toHaveLength(1);
    expect(goals[0]!.id).toBe(created.id);
    expect(goals[0]!.title).toBe("Beta");
    expect(goals[0]!.status).toBe("active");
  });
});

describe("updateGoal", () => {
  it("persists title/description and writes a goal.updated event with the patch payload", () => {
    const db = setup();
    const created = createGoal({ title: "Original", description: "old" });

    const updated = updateGoal(created.id, { title: "New Title" });
    expect(updated.title).toBe("New Title");
    expect(updated.description).toBe("old");
    expect(updated.updatedAt >= created.updatedAt).toBe(true);

    const eventRow = db
      .prepare(
        "SELECT type, goal_id, payload FROM events WHERE goal_id = ? AND type = 'goal.updated'"
      )
      .get(created.id) as { type: string; goal_id: string; payload: string } | undefined;

    expect(eventRow?.type).toBe("goal.updated");
    expect(JSON.parse(eventRow!.payload)).toEqual({ title: "New Title" });
  });

  it("can update both title and description in one call", () => {
    setup();
    const created = createGoal({ title: "Orig" });
    const updated = updateGoal(created.id, { title: "T", description: "D" });
    expect(updated.title).toBe("T");
    expect(updated.description).toBe("D");
  });

  it("throws NotFoundError for unknown id", () => {
    setup();
    expect(() => updateGoal("missing-id", { title: "x" })).toThrow(NotFoundError);
  });

  it("throws ValidationError when no fields provided", () => {
    setup();
    const created = createGoal({ title: "A" });
    expect(() => updateGoal(created.id, {})).toThrow(ValidationError);
  });

  it("publishes goal.updated event with numeric seq", () => {
    setup();
    const created = createGoal({ title: "A" });
    const publishSpy = vi.spyOn(eventBus, "publish");

    updateGoal(created.id, { title: "B" });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0]![0]!;
    expect(event.type).toBe("goal.updated");
    expect(event.goalId).toBe(created.id);
    expect(typeof event.seq).toBe("number");
    expect(event.seq).toBeGreaterThan(0);
  });
});

describe("archiveGoal", () => {
  it("sets archived_at, removes goal from listGoals, and emits goal.archived event", () => {
    const db = setup();
    const created = createGoal({ title: "ToArchive" });

    const archived = archiveGoal(created.id);
    expect(archived.status).toBe("archived");
    expect(archived.archivedAt).not.toBeNull();

    expect(listGoals()).toHaveLength(0);

    const row = db
      .prepare("SELECT status, archived_at FROM goals WHERE id = ?")
      .get(created.id) as { status: string; archived_at: string | null };
    expect(row.status).toBe("archived");
    expect(row.archived_at).not.toBeNull();

    const eventRow = db
      .prepare(
        "SELECT type, payload FROM events WHERE goal_id = ? AND type = 'goal.archived'"
      )
      .get(created.id) as { type: string; payload: string } | undefined;
    expect(eventRow?.type).toBe("goal.archived");
    expect(JSON.parse(eventRow!.payload)).toEqual({});
  });

  it("throws NotFoundError for unknown id", () => {
    setup();
    expect(() => archiveGoal("missing-id")).toThrow(NotFoundError);
  });
});
