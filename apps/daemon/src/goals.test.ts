import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { closeDatabase, openDatabase } from "./db.js";
import { defaultMigrationsDir, runMigrations } from "./migrations.js";
import { eventBus } from "./events.js";
import { quickGoalSkill } from "./skills/quick-goal.js";
import { SkillRegistry } from "./registry/skill-registry.js";
import {
  archiveGoal,
  createGoal,
  type CreateGoalCtx,
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

function setup(): { db: Database.Database; ctx: CreateGoalCtx } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-goals-test-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  const skills = new SkillRegistry();
  skills.register(quickGoalSkill);
  skills.freeze();
  return { db, ctx: { db, bus: eventBus, skills } };
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
  it("returns a Goal; events table has two rows (skill.invoked + goal.created) and goals has one row", () => {
    const { db, ctx } = setup();

    const goal = createGoal({ title: "X" }, ctx);

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

    expect(eventCount).toBe(2);
    expect(goalCount).toBe(1);

    const eventRow = db
      .prepare("SELECT type, goal_id FROM events WHERE goal_id = ? AND type = 'goal.created'")
      .get(goal.id) as { type: string; goal_id: string } | undefined;

    expect(eventRow?.type).toBe("goal.created");
    expect(eventRow?.goal_id).toBe(goal.id);
  });

  it("rolls back both event and goal rows when the goal insert fails", () => {
    const { db, ctx } = setup();
    forceGoalInsertFailure(db);

    expect(() => createGoal({ title: "Y" }, ctx)).toThrow();

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
    const { db, ctx } = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");
    forceGoalInsertFailure(db);

    expect(() => createGoal({ title: "Z" }, ctx)).toThrow();

    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("publishes skill.invoked then goal.created on success, both with numeric seqs", () => {
    const { ctx } = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");

    createGoal({ title: "Alpha" }, ctx);

    expect(publishSpy).toHaveBeenCalledTimes(2);
    const skillEvent = publishSpy.mock.calls[0]![0]!;
    const goalEvent = publishSpy.mock.calls[1]![0]!;
    expect(skillEvent.type).toBe("skill.invoked");
    expect(typeof skillEvent.seq).toBe("number");
    expect(skillEvent.seq).toBeGreaterThan(0);
    expect(goalEvent.type).toBe("goal.created");
    expect(typeof goalEvent.seq).toBe("number");
    expect(goalEvent.seq).toBeGreaterThan(skillEvent.seq);
  });

  it("throws ValidationError for invalid input", () => {
    const { ctx } = setup();
    expect(() => createGoal({ title: "" }, ctx)).toThrow(ValidationError);
    expect(() => createGoal({}, ctx)).toThrow(ValidationError);
  });
});

describe("createGoal — M2-008 event ordering and payload invariants", () => {
  it("skill.invoked has a strictly smaller seq than goal.created, both share the same goalId", () => {
    const { db, ctx } = setup();
    const goal = createGoal({ title: "M2 ordering" }, ctx);

    const rows = db
      .prepare("SELECT seq, type, goal_id FROM events WHERE goal_id = ? ORDER BY seq ASC")
      .all(goal.id) as { seq: number; type: string; goal_id: string }[];

    expect(rows).toHaveLength(2);
    expect(rows[0]!.type).toBe("skill.invoked");
    expect(rows[1]!.type).toBe("goal.created");
    expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq);
    expect(rows[0]!.goal_id).toBe(goal.id);
    expect(rows[1]!.goal_id).toBe(goal.id);
  });

  it("skill.invoked payload has skillId, extensionPoint, and non-negative integer durationMs", () => {
    const { db, ctx } = setup();
    const goal = createGoal({ title: "Timing check" }, ctx);

    const row = db
      .prepare("SELECT payload FROM events WHERE goal_id = ? AND type = 'skill.invoked'")
      .get(goal.id) as { payload: string } | undefined;

    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload) as {
      skillId: string;
      extensionPoint: string;
      durationMs: number;
    };
    expect(payload.skillId).toBe("quick-goal");
    expect(payload.extensionPoint).toBe("goal.create");
    expect(typeof payload.durationMs).toBe("number");
    expect(Number.isInteger(payload.durationMs)).toBe(true);
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("goal.created payload is { title, description } — unchanged from M1", () => {
    const { db, ctx } = setup();
    const goal = createGoal({ title: "Payload invariant", description: "keep me" }, ctx);

    const row = db
      .prepare("SELECT payload FROM events WHERE goal_id = ? AND type = 'goal.created'")
      .get(goal.id) as { payload: string } | undefined;

    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload) as { title: string; description: string };
    expect(payload).toEqual({ title: "Payload invariant", description: "keep me" });
  });

  it("goals projection has exactly one row matching the new Goal id", () => {
    const { db, ctx } = setup();
    const goal = createGoal({ title: "Projection check" }, ctx);

    const rows = db
      .prepare("SELECT id FROM goals WHERE id = ?")
      .all(goal.id) as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(goal.id);
  });

  it("rolls back both event rows when the goals projection insert fails; bus not called", () => {
    const { db, ctx } = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");
    forceGoalInsertFailure(db);

    expect(() => createGoal({ title: "Rollback both" }, ctx)).toThrow();

    const count = (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c;
    expect(count).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("blank title throws ValidationError; no event or goal rows written; bus not called", () => {
    const { db, ctx } = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");

    expect(() => createGoal({ title: "  " }, ctx)).toThrow(ValidationError);

    const eventCount = (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c;
    const goalCount = (db.prepare("SELECT count(*) AS c FROM goals").get() as { c: number }).c;
    expect(eventCount).toBe(0);
    expect(goalCount).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("normalizes title whitespace — returned Goal.title is trimmed", () => {
    const { ctx } = setup();
    const goal = createGoal({ title: "  trimmed  " }, ctx);
    expect(goal.title).toBe("trimmed");
  });
});

describe("listGoals", () => {
  it("returns the created goal", () => {
    const { ctx } = setup();

    const created = createGoal({ title: "Beta" }, ctx);
    const goals = listGoals();

    expect(goals).toHaveLength(1);
    expect(goals[0]!.id).toBe(created.id);
    expect(goals[0]!.title).toBe("Beta");
    expect(goals[0]!.status).toBe("active");
  });
});

describe("updateGoal", () => {
  it("persists title/description and writes a goal.updated event with the patch payload", () => {
    const { db, ctx } = setup();
    const created = createGoal({ title: "Original", description: "old" }, ctx);

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
    const { ctx } = setup();
    const created = createGoal({ title: "Orig" }, ctx);
    const updated = updateGoal(created.id, { title: "T", description: "D" });
    expect(updated.title).toBe("T");
    expect(updated.description).toBe("D");
  });

  it("throws NotFoundError for unknown id", () => {
    setup();
    expect(() => updateGoal("missing-id", { title: "x" })).toThrow(NotFoundError);
  });

  it("throws ValidationError when no fields provided", () => {
    const { ctx } = setup();
    const created = createGoal({ title: "A" }, ctx);
    expect(() => updateGoal(created.id, {})).toThrow(ValidationError);
  });

  it("publishes goal.updated event with numeric seq", () => {
    const { ctx } = setup();
    const created = createGoal({ title: "A" }, ctx);
    const publishSpy = vi.spyOn(eventBus, "publish");

    updateGoal(created.id, { title: "B" });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0]![0]!;
    expect(event.type).toBe("goal.updated");
    expect(event.goalId).toBe(created.id);
    expect(typeof event.seq).toBe("number");
    expect(event.seq).toBeGreaterThan(0);
  });

  it("throws NotFoundError when updating an archived goal", () => {
    const { ctx } = setup();
    const created = createGoal({ title: "X" }, ctx);
    archiveGoal(created.id);

    expect(() => updateGoal(created.id, { title: "Y" })).toThrow(NotFoundError);
  });

  it("does not append a goal.updated event when target is archived", () => {
    const { db, ctx } = setup();
    const created = createGoal({ title: "X" }, ctx);
    archiveGoal(created.id);

    expect(() => updateGoal(created.id, { title: "Y" })).toThrow(NotFoundError);

    const updatedCount = (
      db
        .prepare(
          "SELECT count(*) AS c FROM events WHERE goal_id = ? AND type = 'goal.updated'"
        )
        .get(created.id) as { c: number }
    ).c;
    expect(updatedCount).toBe(0);
  });

  it("appends goal.updated event before updating the goals projection", () => {
    const { db, ctx } = setup();
    const created = createGoal({ title: "OrderProof" }, ctx);

    db.exec(`
      CREATE TRIGGER enforce_update_event_first
      BEFORE UPDATE ON goals
      FOR EACH ROW
      WHEN OLD.archived_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'projection_updated_before_event')
        WHERE NOT EXISTS (
          SELECT 1 FROM events
          WHERE goal_id = NEW.id
            AND type = 'goal.updated'
            AND created_at = NEW.updated_at
        );
      END;
    `);

    expect(() => updateGoal(created.id, { title: "After" })).not.toThrow();
  });
});

describe("archiveGoal", () => {
  it("sets archived_at, removes goal from listGoals, and emits goal.archived event", () => {
    const { db, ctx } = setup();
    const created = createGoal({ title: "ToArchive" }, ctx);

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

  it("throws NotFoundError when archiving an already-archived goal", () => {
    const { ctx } = setup();
    const created = createGoal({ title: "X" }, ctx);
    archiveGoal(created.id);

    expect(() => archiveGoal(created.id)).toThrow(NotFoundError);
  });

  it("emits exactly one goal.archived event across two archive calls", () => {
    const { db, ctx } = setup();
    const created = createGoal({ title: "X" }, ctx);
    archiveGoal(created.id);
    expect(() => archiveGoal(created.id)).toThrow(NotFoundError);

    const count = (
      db
        .prepare(
          "SELECT count(*) AS c FROM events WHERE goal_id = ? AND type = 'goal.archived'"
        )
        .get(created.id) as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it("appends goal.archived event before updating the goals projection", () => {
    const { db, ctx } = setup();
    const created = createGoal({ title: "ArchiveOrderProof" }, ctx);

    db.exec(`
      CREATE TRIGGER enforce_archive_event_first
      BEFORE UPDATE ON goals
      FOR EACH ROW
      WHEN NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'archive_projection_updated_before_event')
        WHERE NOT EXISTS (
          SELECT 1 FROM events
          WHERE goal_id = NEW.id
            AND type = 'goal.archived'
            AND created_at = NEW.archived_at
        );
      END;
    `);

    expect(() => archiveGoal(created.id)).not.toThrow();
  });
});

describe("projection schema parsing", () => {
  it("throws when a goal row in the projection has an invalid status", () => {
    const { db, ctx } = setup();
    const created = createGoal({ title: "X" }, ctx);

    db.prepare("UPDATE goals SET status = 'bogus' WHERE id = ?").run(created.id);

    expect(() => listGoals()).toThrow();
  });
});
