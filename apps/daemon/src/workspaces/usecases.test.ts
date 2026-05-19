import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { eventBus } from "../events.js";
import { WorkspaceInspectionError } from "./errors.js";
import { DuplicateWorkspaceError, resetPreparedStatements as resetProjectionStmts } from "./projection.js";
import { inspectWorkspace as realInspect } from "./inspect.js";
import {
  attachWorkspace,
  detachWorkspace,
  resetPreparedStatements,
  type WorkspaceCtx,
} from "./usecases.js";
import { NotFoundError } from "../goals.js";
import type { InspectWorkspacePreview } from "@orca/contracts";

const execFile = promisify(execFileCb);

const tempDirs: string[] = [];

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    getAuthToken: () => "test-token",
  };
}

function makeFolderPreview(folderPath: string): InspectWorkspacePreview {
  return {
    path: folderPath,
    name: path.basename(folderPath),
    workspaceType: "folder",
    branch: null,
    isDirty: null,
    gitProbe: "not_a_repo",
  };
}

function setup(inspectFn?: WorkspaceCtx["inspectWorkspace"]): { db: Database.Database; ctx: WorkspaceCtx } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-usecases-test-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  const ctx: WorkspaceCtx = {
    db,
    bus: eventBus,
    inspectWorkspace:
      inspectFn ?? (() => Promise.reject(new Error("inspectWorkspace not expected in this test"))),
  };
  return { db, ctx };
}

// Insert a goal row directly — avoids skills dependency in use-case tests.
function insertGoalRow(db: Database.Database, archived = false): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES (?, 'Test Goal', '', 'active', 1, ?, ?, ?)",
  ).run(id, now, now, archived ? now : null);
  return id;
}

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-usecases-ws-"));
  tempDirs.push(dir);
  return dir;
}

async function initGitRepoWithCommit(dir: string): Promise<string> {
  await execFile("git", ["init", dir]);
  await execFile("git", ["-C", dir, "config", "user.name", "Test User"]);
  await execFile("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await fs.writeFile(path.join(dir, "README.md"), "# Test");
  await execFile("git", ["-C", dir, "add", "."]);
  await execFile("git", ["-C", dir, "commit", "-m", "init"]);
  const { stdout } = await execFile("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
  return stdout.trim();
}

afterEach(async () => {
  closeDatabase();
  resetPreparedStatements();
  resetProjectionStmts();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("attachWorkspace", () => {
  it("attaches a non-git folder — row inserted, event broadcast post-commit", async () => {
    const { db, ctx } = setup((p) => Promise.resolve(makeFolderPreview(p)));
    const goalId = insertGoalRow(db);
    const wsPath = "/tmp/orca-uc-folder-" + Date.now();

    const publishSpy = vi.spyOn(eventBus, "publish");

    const workspace = await attachWorkspace(ctx, { goalId, inputPath: wsPath });

    expect(workspace.goalId).toBe(goalId);
    expect(workspace.path).toBe(wsPath);
    expect(workspace.workspaceType).toBe("folder");
    expect(workspace.gitProbe).toBe("not_a_repo");
    expect(workspace.branch).toBeNull();
    expect(workspace.isDirty).toBeNull();

    // Row exists in DB
    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspace.id);
    expect(row).toBeDefined();

    // Event broadcast exactly once, after commit
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0]![0]!;
    expect(event.type).toBe("workspace.attached");
    expect(event.goalId).toBe(goalId);
    expect(typeof event.seq).toBe("number");
    expect(event.seq).toBeGreaterThan(0);
  });

  it("attaches a real git repo — branch and isDirty captured", async () => {
    const repoDir = await makeTmpDir();
    const branch = await initGitRepoWithCommit(repoDir);

    const { db, ctx } = setup(realInspect);
    const goalId = insertGoalRow(db);

    const workspace = await attachWorkspace(ctx, { goalId, inputPath: repoDir });

    expect(workspace.workspaceType).toBe("repo");
    expect(workspace.branch).toBe(branch);
    expect(workspace.isDirty).toBe(false);
    expect(workspace.gitProbe).toBe("ok");
  });

  it("same canonical path twice — DuplicateWorkspaceError; second call does not insert or broadcast", async () => {
    const wsPath = "/tmp/orca-uc-dup-" + Date.now();
    const { db, ctx } = setup((p) => Promise.resolve(makeFolderPreview(p)));
    const goalId = insertGoalRow(db);

    await attachWorkspace(ctx, { goalId, inputPath: wsPath });

    const publishSpy = vi.spyOn(eventBus, "publish");

    await expect(attachWorkspace(ctx, { goalId, inputPath: wsPath })).rejects.toThrow(
      DuplicateWorkspaceError,
    );

    expect(publishSpy).not.toHaveBeenCalled();

    const wsCount = (
      db.prepare("SELECT count(*) AS c FROM workspaces WHERE goal_id = ?").get(goalId) as {
        c: number;
      }
    ).c;
    expect(wsCount).toBe(1);
  });

  it("nonexistent Goal — NotFoundError, no event, no row", async () => {
    const { db, ctx } = setup();

    const publishSpy = vi.spyOn(eventBus, "publish");

    await expect(
      attachWorkspace(ctx, { goalId: "no-such-goal", inputPath: "/tmp/something" }),
    ).rejects.toThrow(NotFoundError);

    expect(publishSpy).not.toHaveBeenCalled();
    const wsCount = (db.prepare("SELECT count(*) AS c FROM workspaces").get() as { c: number }).c;
    expect(wsCount).toBe(0);
  });

  it("archived Goal — NotFoundError, no event, no row", async () => {
    const { db, ctx } = setup();
    const goalId = insertGoalRow(db, true /* archived */);

    const publishSpy = vi.spyOn(eventBus, "publish");

    await expect(
      attachWorkspace(ctx, { goalId, inputPath: "/tmp/something" }),
    ).rejects.toThrow(NotFoundError);

    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("inspection failure — no event, no row, error propagated", async () => {
    const { db, ctx: baseCtx } = setup();
    const goalId = insertGoalRow(db);

    const failCtx: WorkspaceCtx = {
      ...baseCtx,
      inspectWorkspace: () =>
        Promise.reject(new WorkspaceInspectionError("not_found", "path not found")),
    };

    const publishSpy = vi.spyOn(eventBus, "publish");

    await expect(
      attachWorkspace(failCtx, { goalId, inputPath: "/tmp/missing" }),
    ).rejects.toThrow(WorkspaceInspectionError);

    expect(publishSpy).not.toHaveBeenCalled();
    const wsCount = (
      db.prepare("SELECT count(*) AS c FROM workspaces WHERE goal_id = ?").get(goalId) as {
        c: number;
      }
    ).c;
    expect(wsCount).toBe(0);
  });
});

describe("detachWorkspace", () => {
  it("detaches an existing workspace — row gone, event broadcast", async () => {
    const wsPath = "/tmp/orca-uc-detach-" + Date.now();
    const { db, ctx } = setup((p) => Promise.resolve(makeFolderPreview(p)));
    const goalId = insertGoalRow(db);
    const workspace = await attachWorkspace(ctx, { goalId, inputPath: wsPath });

    const publishSpy = vi.spyOn(eventBus, "publish");

    await detachWorkspace(ctx, { goalId, workspaceId: workspace.id });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const event = publishSpy.mock.calls[0]![0]!;
    expect(event.type).toBe("workspace.removed");
    expect(event.goalId).toBe(goalId);
    expect((event.payload as { workspaceId: string }).workspaceId).toBe(workspace.id);

    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspace.id);
    expect(row).toBeUndefined();
  });

  it("goalId does not match workspace's goal_id — NotFoundError, no event", async () => {
    const wsPath = "/tmp/orca-uc-mismatch-" + Date.now();
    const { db, ctx } = setup((p) => Promise.resolve(makeFolderPreview(p)));
    const goalA = insertGoalRow(db);
    const goalB = insertGoalRow(db);
    const workspace = await attachWorkspace(ctx, { goalId: goalA, inputPath: wsPath });

    const publishSpy = vi.spyOn(eventBus, "publish");

    await expect(
      detachWorkspace(ctx, { goalId: goalB, workspaceId: workspace.id }),
    ).rejects.toThrow(NotFoundError);

    expect(publishSpy).not.toHaveBeenCalled();

    // Workspace still present
    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspace.id);
    expect(row).toBeDefined();
  });

  it("nonexistent workspaceId — NotFoundError, no event", async () => {
    const { db, ctx } = setup();
    const goalId = insertGoalRow(db);

    const publishSpy = vi.spyOn(eventBus, "publish");

    await expect(
      detachWorkspace(ctx, { goalId, workspaceId: "no-such-workspace" }),
    ).rejects.toThrow(NotFoundError);

    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("rolls back event when workspace delete fails — workspace row preserved, no broadcast", async () => {
    const wsPath = "/tmp/orca-uc-detach-fail-" + Date.now();
    const { db, ctx } = setup((p) => Promise.resolve(makeFolderPreview(p)));
    const goalId = insertGoalRow(db);
    const workspace = await attachWorkspace(ctx, { goalId, inputPath: wsPath });

    db.exec(`
      CREATE TRIGGER force_workspace_delete_failure BEFORE DELETE ON workspaces
      BEGIN SELECT RAISE(ABORT, 'forced delete failure'); END;
    `);

    const publishSpy = vi.spyOn(eventBus, "publish");

    await expect(
      detachWorkspace(ctx, { goalId, workspaceId: workspace.id }),
    ).rejects.toThrow();

    expect(publishSpy).not.toHaveBeenCalled();

    const row = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspace.id);
    expect(row).toBeDefined();

    const removedEventCount = (
      db.prepare("SELECT count(*) AS c FROM events WHERE type = 'workspace.removed'").get() as { c: number }
    ).c;
    expect(removedEventCount).toBe(0);
  });
});
