import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";

import type Database from "better-sqlite3";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { DuplicateWorkspaceError, listWorkspacesByGoal, findWorkspaceById, resetPreparedStatements as resetProjectionStmts } from "./projection.js";
import {
  createWorkspace,
  updateWorkspace,
  attachWorkspace,
  detachWorkspace,
  deleteWorkspace,
  type WorkspaceCtx,
} from "./usecases.js";
import type { InspectWorkspacePreview } from "@orca/contracts";
import type { DomainEvent } from "@orca/contracts";
import type { EventBus } from "../events.js";

type Config = { dataDir: string; port: number; logLevel: string; sessionOutputTailBytes: number; sessionStopGraceMs: number; sessionWsBufferLimitBytes: number; memoryExtractionMaxInputBytes: number; memoryExtractionTimeoutMs: number; hookResolverCommand: string[]; getAuthToken: () => string };

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

const published: DomainEvent[] = [];
const fakeBus = { publish: (e: DomainEvent) => { published.push(e); } } as unknown as EventBus;

function makeCtx(opts: { inspect: InspectWorkspacePreview }): WorkspaceCtx & { db: Database.Database } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-usecases4-test-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir) as Parameters<typeof openDatabase>[0]);
  runMigrations(db, defaultMigrationsDir());
  return {
    db,
    bus: fakeBus,
    inspectWorkspace: () => Promise.resolve(opts.inspect),
  };
}

function goal(db: Database.Database, id: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, 'Test Goal', '', 'active', 1, ?, ?, NULL)",
  ).run(id, now, now);
}

function session(db: Database.Database, id: string, goalId: string, workspaceId: string): void {
  db.prepare(
    "INSERT INTO sessions (id, goal_id, workspace_id, adapter_id, title, status, created_at) VALUES (?, ?, ?, 'claude', 'S', 'exited', ?)",
  ).run(id, goalId, workspaceId, new Date().toISOString());
}

function fkClean(db: Database.Database): boolean {
  return (db.pragma("foreign_key_check") as unknown[]).length === 0;
}

afterEach(() => {
  closeDatabase();
  resetProjectionStmts();
  published.splice(0);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("createWorkspace inserts entity and emits workspace.created", async () => {
  const ctx = makeCtx({ inspect: { path: "/r/a", name: "a", workspaceType: "repo", branch: "main", isDirty: false, gitProbe: "ok" } });
  const ws = await createWorkspace(ctx, { inputPath: "/r/a", description: "d" });
  expect(ws).toMatchObject({ path: "/r/a", name: "a", description: "d" });
  expect(published.map((e) => e.type)).toContain("workspace.created");
});

it("createWorkspace rejects a duplicate path", async () => {
  const ctx = makeCtx({ inspect: { path: "/r/a", name: "a", workspaceType: "repo", branch: null, isDirty: null, gitProbe: "ok" } });
  await createWorkspace(ctx, { inputPath: "/r/a" });
  await expect(createWorkspace(ctx, { inputPath: "/r/a" })).rejects.toBeInstanceOf(DuplicateWorkspaceError);
});

it("attachWorkspace find-or-creates the entity then links the goal", async () => {
  const ctx = makeCtx({ inspect: { path: "/r/a", name: "a", workspaceType: "repo", branch: null, isDirty: null, gitProbe: "ok" } });
  goal(ctx.db, "g1");
  const ws = await attachWorkspace(ctx, { goalId: "g1", inputPath: "/r/a" });
  goal(ctx.db, "g2");
  const ws2 = await attachWorkspace(ctx, { goalId: "g2", inputPath: "/r/a" });
  expect(ws2.id).toBe(ws.id); // same entity reused
  expect(listWorkspacesByGoal(ctx.db, "g2").map((w) => w.id)).toEqual([ws.id]);
});

it("updateWorkspace renames + emits workspace.updated", async () => {
  const ctx = makeCtx({ inspect: { path: "/r/a", name: "a", workspaceType: "repo", branch: null, isDirty: null, gitProbe: "ok" } });
  const ws = await createWorkspace(ctx, { inputPath: "/r/a" });
  const out = await updateWorkspace(ctx, { id: ws.id, name: "renamed" });
  expect(out.name).toBe("renamed");
  expect(published.map((e) => e.type)).toContain("workspace.updated");
});

it("detachWorkspace unlinks without deleting the entity", async () => {
  const ctx = makeCtx({ inspect: { path: "/r/a", name: "a", workspaceType: "repo", branch: null, isDirty: null, gitProbe: "ok" } });
  goal(ctx.db, "g1");
  const ws = await attachWorkspace(ctx, { goalId: "g1", inputPath: "/r/a" });
  await detachWorkspace(ctx, { goalId: "g1", workspaceId: ws.id });
  expect(listWorkspacesByGoal(ctx.db, "g1")).toEqual([]);
  expect(findWorkspaceById(ctx.db, ws.id)).not.toBeNull(); // entity survives
});

it("attachWorkspace emits workspace.attached with goalId", async () => {
  const ctx = makeCtx({ inspect: { path: "/r/b", name: "b", workspaceType: "folder", branch: null, isDirty: null, gitProbe: "not_a_repo" } });
  goal(ctx.db, "g1");
  await attachWorkspace(ctx, { goalId: "g1", inputPath: "/r/b" });
  const evt = published.find((e) => e.type === "workspace.attached");
  expect(evt).toBeDefined();
  expect(evt!.goalId).toBe("g1");
});

it("detachWorkspace emits workspace.removed with goalId", async () => {
  const ctx = makeCtx({ inspect: { path: "/r/c", name: "c", workspaceType: "folder", branch: null, isDirty: null, gitProbe: "not_a_repo" } });
  goal(ctx.db, "g1");
  const ws = await attachWorkspace(ctx, { goalId: "g1", inputPath: "/r/c" });
  published.splice(0);
  await detachWorkspace(ctx, { goalId: "g1", workspaceId: ws.id });
  const evt = published.find((e) => e.type === "workspace.removed");
  expect(evt).toBeDefined();
  expect(evt!.goalId).toBe("g1");
});

it("deleteWorkspace purges the workspace, its exclusive goals, and their sessions", async () => {
  const ctx = makeCtx({ inspect: { path: "/r/a", name: "a", workspaceType: "repo", branch: null, isDirty: null, gitProbe: "ok" } });
  goal(ctx.db, "g1");
  const ws = await attachWorkspace(ctx, { goalId: "g1", inputPath: "/r/a" });
  // A session referencing the workspace via ON DELETE RESTRICT is exactly what
  // used to make the delete throw a FK error and 500.
  session(ctx.db, "s1", "g1", ws.id);
  published.splice(0);

  const res = await deleteWorkspace(ctx, { id: ws.id });

  expect(res).toEqual({ goalsDeleted: 1, sessionsDeleted: 1 });
  expect(findWorkspaceById(ctx.db, ws.id)).toBeNull();
  expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM goals WHERE id='g1'").get()).toEqual({ n: 0 });
  expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id='s1'").get()).toEqual({ n: 0 });
  expect(fkClean(ctx.db)).toBe(true);
  const evt = published.find((e) => e.type === "workspace.deleted");
  expect(evt!.payload).toMatchObject({ workspaceId: ws.id, goalsDeleted: 1, sessionsDeleted: 1 });
});

it("deleteWorkspace keeps a goal shared with another workspace, dropping only this link", async () => {
  const ctx = makeCtx({ inspect: { path: "/r/a", name: "a", workspaceType: "repo", branch: null, isDirty: null, gitProbe: "ok" } });
  goal(ctx.db, "g1");
  const wsA = await attachWorkspace(ctx, { goalId: "g1", inputPath: "/r/a" });
  // Attach a second workspace to the same goal.
  ctx.inspectWorkspace = () => Promise.resolve({ path: "/r/b", name: "b", workspaceType: "repo", branch: null, isDirty: null, gitProbe: "ok" });
  const wsB = await attachWorkspace(ctx, { goalId: "g1", inputPath: "/r/b" });

  const res = await deleteWorkspace(ctx, { id: wsA.id });

  expect(res.goalsDeleted).toBe(0); // g1 is shared, so it survives
  expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM goals WHERE id='g1'").get()).toEqual({ n: 1 });
  expect(findWorkspaceById(ctx.db, wsB.id)).not.toBeNull();
  expect(listWorkspacesByGoal(ctx.db, "g1").map((w) => w.id)).toEqual([wsB.id]);
  expect(fkClean(ctx.db)).toBe(true);
});

it("deleteWorkspace throws NotFoundError for an unknown workspace", async () => {
  const ctx = makeCtx({ inspect: { path: "/r/a", name: "a", workspaceType: "repo", branch: null, isDirty: null, gitProbe: "ok" } });
  const { NotFoundError } = await import("../goals.js");
  await expect(deleteWorkspace(ctx, { id: randomUUID() })).rejects.toBeInstanceOf(NotFoundError);
});

it("attachWorkspace throws NotFoundError for nonexistent goal", async () => {
  const ctx = makeCtx({ inspect: { path: "/r/a", name: "a", workspaceType: "repo", branch: null, isDirty: null, gitProbe: "ok" } });
  const { NotFoundError } = await import("../goals.js");
  await expect(attachWorkspace(ctx, { goalId: randomUUID(), inputPath: "/r/a" })).rejects.toBeInstanceOf(NotFoundError);
});
