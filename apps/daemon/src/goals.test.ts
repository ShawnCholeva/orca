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
import { guidedGoalRefinementSkill } from "./skills/guided-goal-refinement.js";
import { SkillRegistry } from "./registry/skill-registry.js";
import {
  archiveGoal,
  createGoal,
  type CreateGoalCtx,
  listGoals,
  NotFoundError,
  updateGoal,
  ValidationError,
  DuplicateWorkspaceInRequestError,
} from "./goals.js";
import type { InspectWorkspacePreview } from "@orca/contracts";

const tempDirs: string[] = [];

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    getAuthToken: () => "test-token",
  };
}

// Stub inspectWorkspace that fails if called — used for tests that don't exercise workspaces.
function noopInspect(): Promise<InspectWorkspacePreview> {
  return Promise.reject(new Error("inspectWorkspace not expected in this test"));
}

function setup(): { db: Database.Database; ctx: CreateGoalCtx } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-goals-test-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  const skills = new SkillRegistry();
  skills.register(quickGoalSkill);
  skills.register(guidedGoalRefinementSkill);
  skills.freeze();
  return { db, ctx: { db, bus: eventBus, skills, inspectWorkspace: noopInspect } };
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
  it("returns a Goal; events table has two rows (skill.invoked + goal.created) and goals has one row", async () => {
    const { db, ctx } = setup();

    const goal = await createGoal({ title: "X" }, ctx);

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

  it("rolls back both event and goal rows when the goal insert fails", async () => {
    const { db, ctx } = setup();
    forceGoalInsertFailure(db);

    await expect(createGoal({ title: "Y" }, ctx)).rejects.toThrow();

    const eventCount = (
      db.prepare("SELECT count(*) as cnt FROM events").get() as { cnt: number }
    ).cnt;
    const goalCount = (
      db.prepare("SELECT count(*) as cnt FROM goals").get() as { cnt: number }
    ).cnt;

    expect(eventCount).toBe(0);
    expect(goalCount).toBe(0);
  });

  it("does not call bus.publish when the transaction rolls back", async () => {
    const { db, ctx } = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");
    forceGoalInsertFailure(db);

    await expect(createGoal({ title: "Z" }, ctx)).rejects.toThrow();

    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("publishes skill.invoked then goal.created on success, both with numeric seqs", async () => {
    const { ctx } = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");

    await createGoal({ title: "Alpha" }, ctx);

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

  it("throws ValidationError for invalid input", async () => {
    const { ctx } = setup();
    await expect(createGoal({ title: "" }, ctx)).rejects.toThrow(ValidationError);
    await expect(createGoal({ title: "a".repeat(201) }, ctx)).rejects.toThrow(ValidationError);
  });
});

describe("createGoal — M2-008 event ordering and payload invariants", () => {
  it("skill.invoked has a strictly smaller seq than goal.created, both share the same goalId", async () => {
    const { db, ctx } = setup();
    const goal = await createGoal({ title: "M2 ordering" }, ctx);

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

  it("skill.invoked payload has skillId, extensionPoint, and non-negative integer durationMs", async () => {
    const { db, ctx } = setup();
    const goal = await createGoal({ title: "Timing check" }, ctx);

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

  it("goal.created payload is { title, description } — unchanged from M1", async () => {
    const { db, ctx } = setup();
    const goal = await createGoal({ title: "Payload invariant", description: "keep me" }, ctx);

    const row = db
      .prepare("SELECT payload FROM events WHERE goal_id = ? AND type = 'goal.created'")
      .get(goal.id) as { payload: string } | undefined;

    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload) as { title: string; description: string };
    expect(payload).toEqual({ title: "Payload invariant", description: "keep me" });
  });

  it("goals projection has exactly one row matching the new Goal id", async () => {
    const { db, ctx } = setup();
    const goal = await createGoal({ title: "Projection check" }, ctx);

    const rows = db
      .prepare("SELECT id FROM goals WHERE id = ?")
      .all(goal.id) as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(goal.id);
  });

  it("rolls back both event rows when the goals projection insert fails; bus not called", async () => {
    const { db, ctx } = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");
    forceGoalInsertFailure(db);

    await expect(createGoal({ title: "Rollback both" }, ctx)).rejects.toThrow();

    const count = (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c;
    expect(count).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("blank title throws ValidationError; no event or goal rows written; bus not called", async () => {
    const { db, ctx } = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");

    await expect(createGoal({ title: "  " }, ctx)).rejects.toThrow(ValidationError);

    const eventCount = (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c;
    const goalCount = (db.prepare("SELECT count(*) AS c FROM goals").get() as { c: number }).c;
    expect(eventCount).toBe(0);
    expect(goalCount).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("normalizes title whitespace — returned Goal.title is trimmed", async () => {
    const { ctx } = setup();
    const goal = await createGoal({ title: "  trimmed  " }, ctx);
    expect(goal.title).toBe("trimmed");
  });
});

describe("createGoal — M3-006 refined path", () => {
  function makeRefined(overrides?: object) {
    return {
      skillId: "guided-goal-refinement" as const,
      title: "Build a search engine",
      description: "Index and retrieve documents efficiently.",
      successCriteria: ["P95 query latency < 50ms"],
      constraints: ["Must run on-premises"],
      assumptions: ["Dataset fits in RAM"],
      ...overrides,
    };
  }

  function makePreview(canonical: string): InspectWorkspacePreview {
    return {
      path: canonical,
      name: path.basename(canonical),
      workspaceType: "folder",
      branch: null,
      isDirty: null,
      gitProbe: "not_a_repo",
    };
  }

  it("refined-only create seeds promoted memory rows from constraints and success criteria", async () => {
    const { db, ctx } = setup();
    const refined = makeRefined();

    const goal = await createGoal({ title: refined.title, refined }, ctx);

    const rows = db
      .prepare("SELECT seq, type FROM events WHERE goal_id = ? ORDER BY seq ASC")
      .all(goal.id) as { seq: number; type: string }[];

    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row.type)).toEqual([
      "skill.invoked",
      "goal.created",
      "goal.refined",
      "memory.item.created",
      "memory.item.promoted",
      "memory.item.created",
      "memory.item.promoted",
    ]);
    expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq);
    expect(rows[1]!.seq).toBeLessThan(rows[2]!.seq);

    const skillRow = db
      .prepare("SELECT payload FROM events WHERE goal_id = ? AND type = 'skill.invoked'")
      .get(goal.id) as { payload: string };
    const skillPayload = JSON.parse(skillRow.payload) as { skillId: string; extensionPoint: string; durationMs: number };
    expect(skillPayload.skillId).toBe("guided-goal-refinement");
    expect(skillPayload.extensionPoint).toBe("goal.refine");
    expect(skillPayload.durationMs).toBe(0);

    const refRow = db
      .prepare("SELECT * FROM goal_refinements WHERE goal_id = ?")
      .get(goal.id) as { skill_id: string; success_criteria: string } | undefined;
    expect(refRow).toBeDefined();
    expect(refRow!.skill_id).toBe("guided-goal-refinement");
    expect(JSON.parse(refRow!.success_criteria)).toEqual(refined.successCriteria);

    const memoryRows = db
      .prepare(
        "SELECT type, status, content, source_type, source_id FROM goal_memory_items WHERE goal_id = ? ORDER BY type ASC, content ASC"
      )
      .all(goal.id) as Array<{
      type: string;
      status: string;
      content: string;
      source_type: string;
      source_id: string | null;
    }>;

    expect(memoryRows).toEqual([
      {
        type: "constraint",
        status: "promoted",
        content: "Must run on-premises",
        source_type: "refinement",
        source_id: goal.id,
      },
      {
        type: "success_criterion",
        status: "promoted",
        content: "P95 query latency < 50ms",
        source_type: "refinement",
        source_id: goal.id,
      },
    ]);
  });

  it("refined + 2 workspaces: seed-memory events are appended after the existing workspace events", async () => {
    const { db, ctx } = setup();
    const refined = makeRefined();
    const pathA = "/tmp/ws-a";
    const pathB = "/tmp/ws-b";

    const ctxWithInspect: CreateGoalCtx = {
      ...ctx,
      inspectWorkspace: (p) => Promise.resolve(makePreview(p)),
    };

    const goal = await createGoal(
      { title: refined.title, refined, workspaces: [{ inputPath: pathA }, { inputPath: pathB }] },
      ctxWithInspect,
    );

    const rows = db
      .prepare("SELECT seq, type FROM events WHERE goal_id = ? ORDER BY seq ASC")
      .all(goal.id) as { seq: number; type: string }[];

    expect(rows).toHaveLength(9);
    expect(rows.map((row) => row.type)).toEqual([
      "skill.invoked",
      "goal.created",
      "goal.refined",
      "workspace.attached",
      "workspace.attached",
      "memory.item.created",
      "memory.item.promoted",
      "memory.item.created",
      "memory.item.promoted",
    ]);

    const wsRows = db
      .prepare("SELECT path FROM workspaces WHERE goal_id = ?")
      .all(goal.id) as { path: string }[];
    expect(wsRows).toHaveLength(2);
    const wsPaths = wsRows.map((r) => r.path).sort();
    expect(wsPaths).toEqual([pathA, pathB].sort());

    const refCount = (
      db.prepare("SELECT count(*) AS c FROM goal_refinements WHERE goal_id = ?").get(goal.id) as { c: number }
    ).c;
    expect(refCount).toBe(1);
  });

  it("inspection failure on any workspace rejects the request — no DB writes, no events, no broadcasts", async () => {
    const { db, ctx } = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");
    const refined = makeRefined();

    const ctxWithFailInspect: CreateGoalCtx = {
      ...ctx,
      inspectWorkspace: () => Promise.reject(new Error("path not found")),
    };

    await expect(
      createGoal(
        { title: refined.title, refined, workspaces: [{ inputPath: "/tmp/missing" }] },
        ctxWithFailInspect,
      ),
    ).rejects.toThrow("path not found");

    const eventCount = (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c;
    const goalCount = (db.prepare("SELECT count(*) AS c FROM goals").get() as { c: number }).c;
    expect(eventCount).toBe(0);
    expect(goalCount).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("duplicate canonical paths in request → DuplicateWorkspaceInRequestError, no partial write", async () => {
    const { db, ctx } = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");
    const refined = makeRefined();
    const sameCanonical = "/tmp/same-path";

    const ctxWithInspect: CreateGoalCtx = {
      ...ctx,
      inspectWorkspace: () => Promise.resolve(makePreview(sameCanonical)),
    };

    await expect(
      createGoal(
        { title: refined.title, refined, workspaces: [{ inputPath: sameCanonical }, { inputPath: sameCanonical + "-symlink" }] },
        ctxWithInspect,
      ),
    ).rejects.toThrow(DuplicateWorkspaceInRequestError);

    const eventCount = (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c;
    expect(eventCount).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("bus broadcasts occur only after COMMIT: no broadcasts on transaction rollback", async () => {
    const { db, ctx } = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");
    const refined = makeRefined();
    forceGoalInsertFailure(db);

    await expect(createGoal({ title: refined.title, refined }, ctx)).rejects.toThrow();

    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("broadcasts refined-goal events in committed order, including seed-memory events", async () => {
    const { ctx } = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");
    const refined = makeRefined();

    await createGoal({ title: refined.title, refined }, ctx);

    expect(publishSpy).toHaveBeenCalledTimes(7);
    const types = publishSpy.mock.calls.map((c) => c[0]!.type);
    expect(types).toEqual([
      "skill.invoked",
      "goal.created",
      "goal.refined",
      "memory.item.created",
      "memory.item.promoted",
      "memory.item.created",
      "memory.item.promoted",
    ]);
    const seqs = publishSpy.mock.calls.map((c) => c[0]!.seq);
    expect(seqs[0]!).toBeLessThan(seqs[1]!);
    expect(seqs[1]!).toBeLessThan(seqs[2]!);
  });

  it("invalid refined payload (wrong skillId) throws ValidationError before any DB write", async () => {
    const { db, ctx } = setup();

    const badRefined = { ...makeRefined(), skillId: "unknown-skill" };
    await expect(createGoal({ title: "X", refined: badRefined as never }, ctx)).rejects.toThrow(ValidationError);

    const eventCount = (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c;
    expect(eventCount).toBe(0);
  });

  it("goal title and description in goals row come from refined payload", async () => {
    const { db, ctx } = setup();
    const refined = makeRefined({ title: "Refined Title", description: "Refined desc" });

    const goal = await createGoal({ title: "Rough Title", description: "Rough desc", refined }, ctx);

    expect(goal.title).toBe("Refined Title");
    expect(goal.description).toBe("Refined desc");

    const row = db
      .prepare("SELECT title, description FROM goals WHERE id = ?")
      .get(goal.id) as { title: string; description: string };
    expect(row.title).toBe("Refined Title");
    expect(row.description).toBe("Refined desc");
  });

  it("workspace.attached event payload includes workspaceId, path, name, workspaceType, branch, isDirty, gitProbe", async () => {
    const { db, ctx } = setup();
    const refined = makeRefined();
    const wsPath = "/tmp/my-repo";

    const ctxWithInspect: CreateGoalCtx = {
      ...ctx,
      inspectWorkspace: () =>
        Promise.resolve({
          path: wsPath,
          name: "my-repo",
          workspaceType: "repo",
          branch: "main",
          isDirty: false,
          gitProbe: "ok",
        }),
    };

    const goal = await createGoal(
      { title: refined.title, refined, workspaces: [{ inputPath: wsPath }] },
      ctxWithInspect,
    );

    const wsEventRow = db
      .prepare("SELECT payload FROM events WHERE goal_id = ? AND type = 'workspace.attached'")
      .get(goal.id) as { payload: string } | undefined;

    expect(wsEventRow).toBeDefined();
    const wsPayload = JSON.parse(wsEventRow!.payload) as Record<string, unknown>;
    expect(typeof wsPayload.workspaceId).toBe("string");
    expect(wsPayload.path).toBe(wsPath);
    expect(wsPayload.name).toBe("my-repo");
    expect(wsPayload.workspaceType).toBe("repo");
    expect(wsPayload.branch).toBe("main");
    expect(wsPayload.isDirty).toBe(false);
    expect(wsPayload.gitProbe).toBe("ok");
  });

  it("caller-supplied workspace name overrides the inferred name", async () => {
    const { db, ctx } = setup();
    const refined = makeRefined();

    const ctxWithInspect: CreateGoalCtx = {
      ...ctx,
      inspectWorkspace: (p) => Promise.resolve(makePreview(p)),
    };

    const goal = await createGoal(
      { title: refined.title, refined, workspaces: [{ inputPath: "/tmp/the-folder", name: "custom-name" }] },
      ctxWithInspect,
    );

    const wsRow = db
      .prepare("SELECT name FROM workspaces WHERE goal_id = ?")
      .get(goal.id) as { name: string } | undefined;
    expect(wsRow!.name).toBe("custom-name");
  });

  it("rolls back all rows when goal_refinements insert fails — no events, no goal, no refinements, no broadcasts", async () => {
    const { db, ctx } = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");
    const refined = makeRefined();

    db.exec(`
      CREATE TRIGGER force_refinement_insert_failure BEFORE INSERT ON goal_refinements
      BEGIN SELECT RAISE(ABORT, 'forced refinement failure'); END;
    `);

    await expect(createGoal({ title: refined.title, refined }, ctx)).rejects.toThrow();

    const eventCount = (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c;
    const goalCount = (db.prepare("SELECT count(*) AS c FROM goals").get() as { c: number }).c;
    const refCount = (db.prepare("SELECT count(*) AS c FROM goal_refinements").get() as { c: number }).c;
    expect(eventCount).toBe(0);
    expect(goalCount).toBe(0);
    expect(refCount).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("rolls back all rows when workspace insert fails — no events, no goal, no refinements, no workspaces, no broadcasts", async () => {
    const { db, ctx } = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");
    const refined = makeRefined();

    const ctxWithInspect: CreateGoalCtx = {
      ...ctx,
      inspectWorkspace: (p) => Promise.resolve(makePreview(p)),
    };

    db.exec(`
      CREATE TRIGGER force_workspace_insert_failure BEFORE INSERT ON workspaces
      BEGIN SELECT RAISE(ABORT, 'forced workspace failure'); END;
    `);

    await expect(
      createGoal({ title: refined.title, refined, workspaces: [{ inputPath: "/tmp/ws-fail" }] }, ctxWithInspect),
    ).rejects.toThrow();

    const eventCount = (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c;
    const goalCount = (db.prepare("SELECT count(*) AS c FROM goals").get() as { c: number }).c;
    const refCount = (db.prepare("SELECT count(*) AS c FROM goal_refinements").get() as { c: number }).c;
    const wsCount = (db.prepare("SELECT count(*) AS c FROM workspaces").get() as { c: number }).c;
    expect(eventCount).toBe(0);
    expect(goalCount).toBe(0);
    expect(refCount).toBe(0);
    expect(wsCount).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("M2 minimal path response shape is preserved (same fields, 2 events)", async () => {
    const { db, ctx } = setup();

    const goal = await createGoal({ title: "Minimal", description: "no change" }, ctx);

    expect(goal.title).toBe("Minimal");
    expect(goal.description).toBe("no change");
    expect(goal.status).toBe("active");
    expect(goal.autonomyLevel).toBe(1);
    expect(goal.archivedAt).toBeNull();

    const eventCount = (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c;
    expect(eventCount).toBe(2);
    const refCount = (db.prepare("SELECT count(*) AS c FROM goal_refinements").get() as { c: number }).c;
    expect(refCount).toBe(0);
  });
});

describe("listGoals", () => {
  it("returns the created goal", async () => {
    const { ctx } = setup();

    const created = await createGoal({ title: "Beta" }, ctx);
    const goals = listGoals();

    expect(goals).toHaveLength(1);
    expect(goals[0]!.id).toBe(created.id);
    expect(goals[0]!.title).toBe("Beta");
    expect(goals[0]!.status).toBe("active");
  });
});

describe("updateGoal", () => {
  it("persists title/description and writes a goal.updated event with the patch payload", async () => {
    const { db, ctx } = setup();
    const created = await createGoal({ title: "Original", description: "old" }, ctx);

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

  it("can update both title and description in one call", async () => {
    const { ctx } = setup();
    const created = await createGoal({ title: "Orig" }, ctx);
    const updated = updateGoal(created.id, { title: "T", description: "D" });
    expect(updated.title).toBe("T");
    expect(updated.description).toBe("D");
  });

  it("throws NotFoundError for unknown id", () => {
    setup();
    expect(() => updateGoal("missing-id", { title: "x" })).toThrow(NotFoundError);
  });

  it("throws ValidationError when no fields provided", async () => {
    const { ctx } = setup();
    const created = await createGoal({ title: "A" }, ctx);
    expect(() => updateGoal(created.id, {})).toThrow(ValidationError);
  });

  it("publishes goal.updated event with numeric seq", async () => {
    const { ctx } = setup();
    const created = await createGoal({ title: "A" }, ctx);
    const publishSpy = vi.spyOn(eventBus, "publish");

    updateGoal(created.id, { title: "B" });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0]![0]!;
    expect(event.type).toBe("goal.updated");
    expect(event.goalId).toBe(created.id);
    expect(typeof event.seq).toBe("number");
    expect(event.seq).toBeGreaterThan(0);
  });

  it("throws NotFoundError when updating an archived goal", async () => {
    const { ctx } = setup();
    const created = await createGoal({ title: "X" }, ctx);
    archiveGoal(created.id);

    expect(() => updateGoal(created.id, { title: "Y" })).toThrow(NotFoundError);
  });

  it("does not append a goal.updated event when target is archived", async () => {
    const { db, ctx } = setup();
    const created = await createGoal({ title: "X" }, ctx);
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

  it("appends goal.updated event before updating the goals projection", async () => {
    const { db, ctx } = setup();
    const created = await createGoal({ title: "OrderProof" }, ctx);

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
  it("sets archived_at, removes goal from listGoals, and emits goal.archived event", async () => {
    const { db, ctx } = setup();
    const created = await createGoal({ title: "ToArchive" }, ctx);

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

  it("throws NotFoundError when archiving an already-archived goal", async () => {
    const { ctx } = setup();
    const created = await createGoal({ title: "X" }, ctx);
    archiveGoal(created.id);

    expect(() => archiveGoal(created.id)).toThrow(NotFoundError);
  });

  it("emits exactly one goal.archived event across two archive calls", async () => {
    const { db, ctx } = setup();
    const created = await createGoal({ title: "X" }, ctx);
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

  it("appends goal.archived event before updating the goals projection", async () => {
    const { db, ctx } = setup();
    const created = await createGoal({ title: "ArchiveOrderProof" }, ctx);

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
  it("throws when a goal row in the projection has an invalid status", async () => {
    const { db, ctx } = setup();
    const created = await createGoal({ title: "X" }, ctx);

    db.prepare("UPDATE goals SET status = 'bogus' WHERE id = ?").run(created.id);

    expect(() => listGoals()).toThrow();
  });
});
