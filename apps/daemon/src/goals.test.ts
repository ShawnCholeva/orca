import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { closeDatabase, openDatabase } from "./db.js";
import { defaultMigrationsDir, runMigrations } from "./migrations.js";
import { eventBus } from "./events.js";
import { setSupervisionMode } from "./settings/store.js";
import { quickGoalSkill } from "./skills/quick-goal.js";
import { guidedGoalRefinementSkill } from "./skills/guided-goal-refinement.js";
import { SkillRegistry } from "./registry/skill-registry.js";
import {
  archiveGoal,
  createGoal,
  type CreateGoalCtx,
  getGoalById,
  listGoals,
  NotFoundError,
  updateGoal,
  updateGoalOrchestratorModel,
  ValidationError,
  DuplicateWorkspaceInRequestError,
  DuplicateDocumentInRequestError,
} from "./goals.js";
import type { InspectWorkspacePreview, Workspace } from "@orca/contracts";
import { insertWorkspaceEntity, linkGoalWorkspace } from "./workspaces/projection.js";
import { ModelProviderRegistry } from "./llm/registry.js";
import type { ModelProvider } from "./llm/types.js";

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
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => "test-token",
  };
}

// Stub inspectWorkspace that fails if called — used for tests that don't exercise workspaces.
function noopInspect(): Promise<InspectWorkspacePreview> {
  return Promise.reject(new Error("inspectWorkspace not expected in this test"));
}

function buildRegistry(): ModelProviderRegistry {
  const registry = new ModelProviderRegistry();
  const mk = (
    id: ModelProvider["id"],
    models: string[]
  ): ModelProvider => ({
    id,
    displayName: id,
    version: "0.1.0",
    async isAvailable() {
      return { available: true };
    },
    async listModels() {
      return models.map((modelId) => ({
        id: modelId,
        displayName: modelId,
        capabilities: ["test"],
      }));
    },
    async complete() {
      throw new Error("unused in test");
    },
  });
  registry.register(mk("orca/anthropic", ["claude-sonnet-4-6"]));
  registry.register(mk("orca/openai", ["gpt-5", "gpt-4o-mini"]));
  return registry;
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
  return {
    db,
    ctx: {
      db,
      bus: eventBus,
      skills,
      modelProviderRegistry: buildRegistry(),
      inspectWorkspace: noopInspect,
    },
  };
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

describe("createGoal operating_mode default", () => {
  it("defaults a new goal to human_review when the global supervision setting is supervised", async () => {
    const { db, ctx } = setup();
    setSupervisionMode(db, "supervised", new Date().toISOString());

    const goal = await createGoal({ title: "X", intent: "test intent" }, ctx);

    expect(goal.operatingMode).toBe("human_review");
  });

  it("inherits automated from the global supervision setting when it is unsupervised", async () => {
    const { db, ctx } = setup();
    setSupervisionMode(db, "unsupervised", new Date().toISOString());

    const goal = await createGoal({ title: "X", intent: "test intent" }, ctx);

    expect(goal.operatingMode).toBe("automated");
    const row = db
      .prepare("SELECT operating_mode FROM goals WHERE id = ?")
      .get(goal.id) as { operating_mode: string };
    expect(row.operating_mode).toBe("automated");
  });
});

describe("createGoal", () => {
  it("returns a Goal; events table has two rows (skill.invoked + goal.created) and goals has one row", async () => {
    const { db, ctx } = setup();

    const goal = await createGoal({ title: "X", intent: "test intent" }, ctx);

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

    await expect(createGoal({ title: "Y", intent: "test intent" }, ctx)).rejects.toThrow();

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

    await expect(createGoal({ title: "Z", intent: "test intent" }, ctx)).rejects.toThrow();

    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("persists and round-trips successCriteria", async () => {
    const { ctx } = setup();
    const goal = await createGoal(
      { title: "T", intent: "do the thing", successCriteria: ["  all tests pass  ", "", "docs updated"] },
      ctx,
    );
    // blanks filtered, entries trimmed
    expect(goal.successCriteria).toEqual(["all tests pass", "docs updated"]);
    const fetched = getGoalById(ctx.db, goal.id);
    expect(fetched?.successCriteria).toEqual(["all tests pass", "docs updated"]);
  });

  it("defaults successCriteria to [] for a goal created without it (legacy path)", async () => {
    const { ctx } = setup();
    const goal = await createGoal({ title: "T", intent: "x" }, ctx);
    expect(goal.successCriteria).toEqual([]);
  });

  it("publishes skill.invoked then goal.created on success, both with numeric seqs", async () => {
    const { ctx } = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");

    await createGoal({ title: "Alpha", intent: "test intent" }, ctx);

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
    await expect(createGoal({ title: "", intent: "test intent" }, ctx)).rejects.toThrow(ValidationError);
    await expect(createGoal({ title: "a".repeat(201) }, ctx)).rejects.toThrow(ValidationError);
  });
});

describe("createGoal — event ordering and payload invariants", () => {
  it("skill.invoked has a strictly smaller seq than goal.created, both share the same goalId", async () => {
    const { db, ctx } = setup();
    const goal = await createGoal({ title: "event ordering", intent: "test intent" }, ctx);

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
    const goal = await createGoal({ title: "Timing check", intent: "test intent" }, ctx);

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

  it("goal.created payload remains limited to title and intent", async () => {
    const { db, ctx } = setup();
    const goal = await createGoal({ title: "Payload invariant", intent: "keep me" }, ctx);

    const row = db
      .prepare("SELECT payload FROM events WHERE goal_id = ? AND type = 'goal.created'")
      .get(goal.id) as { payload: string } | undefined;

    expect(row).toBeDefined();
    const payload = JSON.parse(row!.payload) as { title: string; intent: string };
    expect(payload).toEqual({ title: "Payload invariant", intent: "keep me" });
  });

  it("goals projection has exactly one row matching the new Goal id", async () => {
    const { db, ctx } = setup();
    const goal = await createGoal({ title: "Projection check", intent: "test intent" }, ctx);

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

    await expect(createGoal({ title: "Rollback both", intent: "test intent" }, ctx)).rejects.toThrow();

    const count = (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c;
    expect(count).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("blank title throws ValidationError; no event or goal rows written; bus not called", async () => {
    const { db, ctx } = setup();
    const publishSpy = vi.spyOn(eventBus, "publish");

    await expect(createGoal({ title: "  ", intent: "test intent" }, ctx)).rejects.toThrow(ValidationError);

    const eventCount = (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c;
    const goalCount = (db.prepare("SELECT count(*) AS c FROM goals").get() as { c: number }).c;
    expect(eventCount).toBe(0);
    expect(goalCount).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("normalizes title whitespace — returned Goal.title is trimmed", async () => {
    const { ctx } = setup();
    const goal = await createGoal({ title: "  trimmed  ", intent: "test intent" }, ctx);
    expect(goal.title).toBe("trimmed");
  });
});

describe("createGoal — refined goal path", () => {
  function makeRefined(overrides?: object) {
    return {
      skillId: "guided-goal-refinement" as const,
      title: "Build a search engine",
      intent: "Index and retrieve documents efficiently.",
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
      .prepare("SELECT w.path AS path FROM workspaces w JOIN goal_workspaces gw ON gw.workspace_id = w.id WHERE gw.goal_id = ?")
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

  it("goal title and intent in goals row come from refined payload", async () => {
    const { db, ctx } = setup();
    const refined = makeRefined({ title: "Refined Title", intent: "Refined desc" });

    const goal = await createGoal({ title: "Rough Title", intent: "Rough desc", refined }, ctx);

    expect(goal.title).toBe("Refined Title");
    expect(goal.intent).toBe("Refined desc");

    const row = db
      .prepare("SELECT title, intent FROM goals WHERE id = ?")
      .get(goal.id) as { title: string; intent: string };
    expect(row.title).toBe("Refined Title");
    expect(row.intent).toBe("Refined desc");
  });

  it("falls back to request intent when refined.intent is empty, preserving the min-1 floor", async () => {
    const { db, ctx } = setup();
    const refined = makeRefined({ intent: "" });

    const goal = await createGoal({ title: "Rough Title", intent: "Rough desc", refined }, ctx);

    expect(goal.intent).toBe("Rough desc");

    const row = db.prepare("SELECT intent FROM goals WHERE id = ?").get(goal.id) as { intent: string };
    expect(row.intent).toBe("Rough desc");

    const createdRow = db
      .prepare("SELECT payload FROM events WHERE goal_id = ? AND type = 'goal.created'")
      .get(goal.id) as { payload: string };
    expect((JSON.parse(createdRow.payload) as { intent: string }).intent).toBe("Rough desc");
  });

  it("keeps refined.intent when it is non-empty (unchanged behavior)", async () => {
    const { db, ctx } = setup();
    const refined = makeRefined({ intent: "Refined desc" });

    const goal = await createGoal({ title: "Rough Title", intent: "Rough desc", refined }, ctx);

    expect(goal.intent).toBe("Refined desc");

    const row = db.prepare("SELECT intent FROM goals WHERE id = ?").get(goal.id) as { intent: string };
    expect(row.intent).toBe("Refined desc");
  });

  it("workspace.attached event payload includes workspaceId, path, name", async () => {
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
      .prepare("SELECT w.name AS name FROM workspaces w JOIN goal_workspaces gw ON gw.workspace_id = w.id WHERE gw.goal_id = ?")
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

  it("minimal create path response shape is preserved (same fields, 2 events)", async () => {
    const { db, ctx } = setup();

    const goal = await createGoal({ title: "Minimal", intent: "no change" }, ctx);

    expect(goal.title).toBe("Minimal");
    expect(goal.intent).toBe("no change");
    expect(goal.status).toBe("active");
    expect(goal.autonomyLevel).toBe(1);
    expect(goal.archivedAt).toBeNull();

    const eventCount = (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c;
    expect(eventCount).toBe(2);
    const refCount = (db.prepare("SELECT count(*) AS c FROM goal_refinements").get() as { c: number }).c;
    expect(refCount).toBe(0);
  });
});

describe("createGoal — documents", () => {
  function writeDoc(content: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-goals-doc-"));
    tempDirs.push(dir);
    const file = path.join(dir, "spec.md");
    writeFileSync(file, content);
    return file;
  }

  it("inserts goal_documents rows and document.attached events atomically", async () => {
    const { db, ctx } = setup();
    const file = writeDoc("# Plan");

    const goal = await createGoal(
      { title: "With doc", intent: "test intent", documents: [{ kind: "file", ref: file, name: "The Plan" }] },
      ctx,
    );

    const rows = db
      .prepare("SELECT name, content, kind FROM goal_documents WHERE goal_id = ?")
      .all(goal.id) as Array<{ name: string; content: string; kind: string }>;
    expect(rows).toEqual([{ name: "The Plan", content: "# Plan", kind: "file" }]);
    const events = db
      .prepare("SELECT payload FROM events WHERE type = 'document.attached' AND goal_id = ?")
      .all(goal.id) as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload).name).toBe("The Plan");
  });

  it("aborts the whole create when a document snapshot fails — no goal row", async () => {
    const { db, ctx } = setup();

    await expect(
      createGoal({ title: "Bad doc", documents: [{ kind: "file", ref: "/tmp/definitely-missing-orca-doc.md" }] }, ctx),
    ).rejects.toThrow();

    const goalCount = (db.prepare("SELECT count(*) AS c FROM goals").get() as { c: number }).c;
    const eventCount = (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c;
    expect(goalCount).toBe(0);
    expect(eventCount).toBe(0);
  });

  it("rejects duplicate document refs in the request", async () => {
    const { db, ctx } = setup();
    const file = writeDoc("# Plan");

    await expect(
      createGoal(
        { title: "Dup docs", documents: [{ kind: "file", ref: file }, { kind: "file", ref: file }] },
        ctx,
      ),
    ).rejects.toThrow(DuplicateDocumentInRequestError);

    const goalCount = (db.prepare("SELECT count(*) AS c FROM goals").get() as { c: number }).c;
    expect(goalCount).toBe(0);
  });
});

describe("listGoals", () => {
  it("returns the created goal", async () => {
    const { ctx } = setup();

    const created = await createGoal({ title: "Beta", intent: "test intent" }, ctx);
    const goals = listGoals();

    expect(goals).toHaveLength(1);
    expect(goals[0]!.id).toBe(created.id);
    expect(goals[0]!.title).toBe("Beta");
    expect(goals[0]!.status).toBe("active");
  });

  it("populates per-goal workspace identity ({id,name}) for zero, one, and many workspaces", async () => {
    const { db, ctx } = setup();

    const none = await createGoal({ title: "No workspace", intent: "test intent" }, ctx);
    const one = await createGoal({ title: "One workspace", intent: "test intent" }, ctx);
    const many = await createGoal({ title: "Many workspaces", intent: "test intent" }, ctx);

    const at = "2026-01-01T00:00:00.000Z";
    const mkWs = (id: string, name: string): Workspace => ({
      id, path: `/tmp/${id}`, name, description: "", createdAt: at, updatedAt: at,
    });
    const alpha = mkWs("ws-alpha", "Alpha");
    const beta = mkWs("ws-beta", "Beta");
    for (const ws of [alpha, beta]) insertWorkspaceEntity(db, ws);

    linkGoalWorkspace(db, one.id, alpha.id, at);
    // attach in beta-then-alpha order to assert attached_at ordering is preserved
    linkGoalWorkspace(db, many.id, beta.id, "2026-01-01T00:00:01.000Z");
    linkGoalWorkspace(db, many.id, alpha.id, "2026-01-01T00:00:02.000Z");

    const byId = new Map(listGoals().map((g) => [g.id, g.workspaces]));

    expect(byId.get(none.id)).toEqual([]);
    expect(byId.get(one.id)).toEqual([{ id: "ws-alpha", name: "Alpha" }]);
    expect(byId.get(many.id)).toEqual([
      { id: "ws-beta", name: "Beta" },
      { id: "ws-alpha", name: "Alpha" },
    ]);
  });
});

describe("updateGoal", () => {
  it("persists title/intent and writes a goal.updated event with the patch payload", async () => {
    const { db, ctx } = setup();
    const created = await createGoal({ title: "Original", intent: "old" }, ctx);

    const updated = updateGoal(created.id, { title: "New Title" });
    expect(updated.title).toBe("New Title");
    expect(updated.intent).toBe("old");
    expect(updated.updatedAt >= created.updatedAt).toBe(true);

    const eventRow = db
      .prepare(
        "SELECT type, goal_id, payload FROM events WHERE goal_id = ? AND type = 'goal.updated'"
      )
      .get(created.id) as { type: string; goal_id: string; payload: string } | undefined;

    expect(eventRow?.type).toBe("goal.updated");
    expect(JSON.parse(eventRow!.payload)).toEqual({ title: "New Title" });
  });

  it("can update both title and intent in one call", async () => {
    const { ctx } = setup();
    const created = await createGoal({ title: "Orig", intent: "orig intent" }, ctx);
    const updated = updateGoal(created.id, { title: "T", intent: "D" });
    expect(updated.title).toBe("T");
    expect(updated.intent).toBe("D");
  });

  it("throws NotFoundError for unknown id", () => {
    setup();
    expect(() => updateGoal("missing-id", { title: "x" })).toThrow(NotFoundError);
  });

  it("throws ValidationError when no fields provided", async () => {
    const { ctx } = setup();
    const created = await createGoal({ title: "A", intent: "test intent" }, ctx);
    expect(() => updateGoal(created.id, {})).toThrow(ValidationError);
  });

  it("publishes goal.updated event with numeric seq", async () => {
    const { ctx } = setup();
    const created = await createGoal({ title: "A", intent: "test intent" }, ctx);
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
    const created = await createGoal({ title: "X", intent: "test intent" }, ctx);
    archiveGoal(created.id);

    expect(() => updateGoal(created.id, { title: "Y" })).toThrow(NotFoundError);
  });

  it("does not append a goal.updated event when target is archived", async () => {
    const { db, ctx } = setup();
    const created = await createGoal({ title: "X", intent: "test intent" }, ctx);
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
    const created = await createGoal({ title: "OrderProof", intent: "test intent" }, ctx);

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

describe("orchestrator model selection", () => {
  it("persists orchestrator provider/model on create when selection is valid", async () => {
    const { db, ctx } = setup();

    const goal = await createGoal(
      {
        title: "With provider",
        intent: "test intent",
        orchestratorModel: {
          providerId: "orca/openai",
          modelId: "gpt-5",
        },
      },
      ctx
    );

    expect(goal.orchestratorProvider).toBe("orca/openai");
    expect(goal.orchestratorModel).toBe("gpt-5");

    const row = db
      .prepare("SELECT orchestrator_provider, orchestrator_model FROM goals WHERE id = ?")
      .get(goal.id) as
      | { orchestrator_provider: string | null; orchestrator_model: string | null }
      | undefined;
    expect(row?.orchestrator_provider).toBe("orca/openai");
    expect(row?.orchestrator_model).toBe("gpt-5");
  });

  it("rejects create when provider/model pair is invalid", async () => {
    const { ctx } = setup();

    await expect(
      createGoal(
        {
          title: "Bad model",
          orchestratorModel: {
            providerId: "orca/openai",
            modelId: "does-not-exist",
          },
        },
        ctx
      )
    ).rejects.toThrow(ValidationError);
  });

  it("patches orchestrator model and emits goal.orchestrator_model_changed", async () => {
    const { db, ctx } = setup();
    const created = await createGoal({ title: "Patch me", intent: "test intent" }, ctx);
    const publishSpy = vi.spyOn(eventBus, "publish");

    const updated = await updateGoalOrchestratorModel(
      created.id,
      { providerId: "orca/anthropic", modelId: "claude-sonnet-4-6" },
      ctx.modelProviderRegistry
    );

    expect(updated).toEqual({
      goalId: created.id,
      orchestratorProvider: "orca/anthropic",
      orchestratorModel: "claude-sonnet-4-6",
    });

    const row = db
      .prepare("SELECT orchestrator_provider, orchestrator_model FROM goals WHERE id = ?")
      .get(created.id) as
      | { orchestrator_provider: string | null; orchestrator_model: string | null }
      | undefined;
    expect(row?.orchestrator_provider).toBe("orca/anthropic");
    expect(row?.orchestrator_model).toBe("claude-sonnet-4-6");

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "goal.orchestrator_model_changed",
        goalId: created.id,
        payload: {
          providerId: "orca/anthropic",
          modelId: "claude-sonnet-4-6",
        },
      })
    );

    const eventRow = db
      .prepare(
        "SELECT payload FROM events WHERE goal_id = ? AND type = 'goal.orchestrator_model_changed'"
      )
      .get(created.id) as { payload: string } | undefined;
    expect(JSON.parse(eventRow!.payload)).toEqual({
      providerId: "orca/anthropic",
      modelId: "claude-sonnet-4-6",
    });
  });
});

describe("archiveGoal", () => {
  it("sets archived_at, removes goal from listGoals, and emits goal.archived event", async () => {
    const { db, ctx } = setup();
    const created = await createGoal({ title: "ToArchive", intent: "test intent" }, ctx);

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

  it("reaps the goal's gate_approval_counts rows on archive", async () => {
    const { db, ctx } = setup();
    const created = await createGoal({ title: "X", intent: "test intent" }, ctx);
    const other = await createGoal({ title: "Y", intent: "test intent" }, ctx);
    const now = new Date().toISOString();
    const ins = db.prepare(
      "INSERT INTO gate_approval_counts (goal_id, action_class, consecutive_approvals, last_decision, updated_at) VALUES (?, ?, ?, 'allow', ?)"
    );
    ins.run(created.id, "Bash:full_access", 3, now);
    ins.run(other.id, "Edit:sandbox_edit", 2, now);

    archiveGoal(created.id);

    const remaining = db
      .prepare("SELECT goal_id FROM gate_approval_counts")
      .all() as { goal_id: string }[];
    expect(remaining.map((r) => r.goal_id)).toEqual([other.id]);
  });

  it("throws NotFoundError for unknown id", () => {
    setup();
    expect(() => archiveGoal("missing-id")).toThrow(NotFoundError);
  });

  it("throws NotFoundError when archiving an already-archived goal", async () => {
    const { ctx } = setup();
    const created = await createGoal({ title: "X", intent: "test intent" }, ctx);
    archiveGoal(created.id);

    expect(() => archiveGoal(created.id)).toThrow(NotFoundError);
  });

  it("emits exactly one goal.archived event across two archive calls", async () => {
    const { db, ctx } = setup();
    const created = await createGoal({ title: "X", intent: "test intent" }, ctx);
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
    const created = await createGoal({ title: "ArchiveOrderProof", intent: "test intent" }, ctx);

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

describe("workerPermissionMode", () => {
  it("new goals default workerPermissionMode to 'ask' and round-trip through the DB", async () => {
    const { db, ctx } = setup();

    const created = await createGoal({ title: "Permission Mode Test", intent: "test intent" }, ctx);
    expect(created.workerPermissionMode).toBe("ask");

    const row = db
      .prepare("SELECT worker_permission_mode FROM goals WHERE id = ?")
      .get(created.id) as { worker_permission_mode: string } | undefined;
    expect(row?.worker_permission_mode).toBe("ask");

    // Verify rowToGoal mapping path: read back through getGoalById
    const fetched = getGoalById(db, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.workerPermissionMode).toBe("ask");

    // Update to a non-default value and confirm the mapping path reflects it
    db.prepare("UPDATE goals SET worker_permission_mode = 'auto' WHERE id = ?").run(created.id);
    const fetchedAfterUpdate = getGoalById(db, created.id);
    expect(fetchedAfterUpdate).not.toBeNull();
    expect(fetchedAfterUpdate!.workerPermissionMode).toBe("auto");
  });
});

describe("projection schema parsing", () => {
  it("throws when a goal row in the projection has an invalid status", async () => {
    const { db, ctx } = setup();
    const created = await createGoal({ title: "X", intent: "test intent" }, ctx);

    db.prepare("UPDATE goals SET status = 'bogus' WHERE id = ?").run(created.id);

    expect(() => listGoals()).toThrow();
  });
});
