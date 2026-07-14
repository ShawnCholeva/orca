import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations, defaultMigrationsDir } from "../migrations.js";
import * as P from "./projection.js";

function freshDb() {
  const db = new Database(":memory:");
  runMigrations(db, defaultMigrationsDir());
  P.resetPreparedStatements();
  return db;
}

const ISO = "2026-06-19T00:00:00.000Z";

function goal(db: Database.Database, id: string, status = "active") {
  db.prepare("INSERT INTO goals (id,title,intent,status,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, id, "", status, ISO, ISO);
}

it("insert + find by id and path", () => {
  const db = freshDb();
  P.insertWorkspaceEntity(db, { id: "w1", path: "/r/a", name: "a", description: "", createdAt: ISO, updatedAt: ISO });
  expect(P.findWorkspaceById(db, "w1")!.path).toBe("/r/a");
  expect(P.findWorkspaceByPath(db, "/r/a")!.id).toBe("w1");
  expect(P.findWorkspaceByPath(db, "/nope")).toBeNull();
});

it("update entity returns patched row", () => {
  const db = freshDb();
  P.insertWorkspaceEntity(db, { id: "w1", path: "/r/a", name: "a", description: "", createdAt: ISO, updatedAt: ISO });
  const out = P.updateWorkspaceEntity(db, "w1", { name: "renamed", description: "d" }, "2026-06-20T00:00:00.000Z");
  expect(out!.name).toBe("renamed");
  expect(out!.description).toBe("d");
  expect(out!.updatedAt).toBe("2026-06-20T00:00:00.000Z");
});

it("link/unlink and summaries with goalCounts", () => {
  const db = freshDb();
  goal(db, "g1", "active"); goal(db, "g2", "completed");
  P.insertWorkspaceEntity(db, { id: "w1", path: "/r/a", name: "a", description: "", createdAt: ISO, updatedAt: ISO });
  P.linkGoalWorkspace(db, "g1", "w1", ISO);
  P.linkGoalWorkspace(db, "g2", "w1", ISO);
  const [s] = P.listWorkspaceSummaries(db);
  expect(s.goalCounts).toEqual({ active: 1, completed: 1, archived: 0 });
  expect(P.listWorkspacesByGoal(db, "g1").map((w) => w.id)).toEqual(["w1"]);
  expect(P.unlinkGoalWorkspace(db, "g2", "w1")).toBe(true);
  expect(P.listWorkspaceSummaries(db)[0].goalCounts.completed).toBe(0);
});

it("goal views for a workspace include archived via archived_at", () => {
  const db = freshDb();
  goal(db, "g1", "active");
  db.prepare("UPDATE goals SET status='archived', archived_at=? WHERE id='g1'").run(ISO);
  P.insertWorkspaceEntity(db, { id: "w1", path: "/r/a", name: "a", description: "", createdAt: ISO, updatedAt: ISO });
  P.linkGoalWorkspace(db, "g1", "w1", ISO);
  const views = P.listGoalViewsForWorkspace(db, "w1");
  expect(views[0]).toMatchObject({ id: "g1", status: "archived", progress: null });
});

it("a completed goal's view reports full (100%) progress", () => {
  const db = freshDb();
  goal(db, "g1", "completed");
  P.insertWorkspaceEntity(db, { id: "w1", path: "/r/a", name: "a", description: "", createdAt: ISO, updatedAt: ISO });
  P.linkGoalWorkspace(db, "g1", "w1", ISO);
  const views = P.listGoalViewsForWorkspace(db, "w1");
  expect(views[0]).toMatchObject({ id: "g1", status: "completed", progress: 1 });
});

it("getWorkspaceByIdAndGoal returns entity when linked, null when not linked", () => {
  const db = freshDb();
  goal(db, "g1");
  goal(db, "g2");
  P.insertWorkspaceEntity(db, { id: "w1", path: "/r/a", name: "a", description: "", createdAt: ISO, updatedAt: ISO });
  P.linkGoalWorkspace(db, "g1", "w1", ISO);
  const found = P.getWorkspaceByIdAndGoal(db, "w1", "g1");
  expect(found).not.toBeNull();
  expect(found!.id).toBe("w1");
  expect(P.getWorkspaceByIdAndGoal(db, "w1", "g2")).toBeNull();
  expect(P.getWorkspaceByIdAndGoal(db, "w1", "nonexistent")).toBeNull();
});

it("insertWorkspaceEntity throws DuplicateWorkspaceError on duplicate path", () => {
  const db = freshDb();
  P.insertWorkspaceEntity(db, { id: "w1", path: "/r/a", name: "a", description: "", createdAt: ISO, updatedAt: ISO });
  expect(() =>
    P.insertWorkspaceEntity(db, { id: "w2", path: "/r/a", name: "b", description: "", createdAt: ISO, updatedAt: ISO })
  ).toThrow(P.DuplicateWorkspaceError);
  expect(() =>
    P.insertWorkspaceEntity(db, { id: "w2", path: "/r/a", name: "b", description: "", createdAt: ISO, updatedAt: ISO })
  ).toThrow(expect.objectContaining({ path: "/r/a" }));
});

it("updateWorkspaceEntity returns null for missing id", () => {
  const db = freshDb();
  expect(P.updateWorkspaceEntity(db, "nonexistent", { name: "x" }, ISO)).toBeNull();
});

it("active goal with workflow run but no step-runs has progress === null", () => {
  const db = freshDb();
  goal(db, "g1", "active");
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, ?)"
  ).run("tpl1", "T", "", 1, "[]", "[]", ISO, ISO);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, started_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("run1", "g1", "tpl1", 1, "active", ISO);
  db.prepare("UPDATE goals SET active_workflow_run_id = ? WHERE id = ?").run("run1", "g1");
  P.insertWorkspaceEntity(db, { id: "w1", path: "/r/a", name: "a", description: "", createdAt: ISO, updatedAt: ISO });
  P.linkGoalWorkspace(db, "g1", "w1", ISO);
  const views = P.listGoalViewsForWorkspace(db, "w1");
  expect(views[0]).toMatchObject({ id: "g1", status: "active", progress: null });
});
