import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { closeDatabase, openDatabase } from "../db.js";
import { defaultMigrationsDir, runMigrations } from "../migrations.js";
import { eventBus } from "../events.js";
import {
  attachGoalDocument,
  detachGoalDocument,
  refreshGoalDocuments,
  DuplicateDocumentError,
  DocumentSnapshotError,
  type GoalDocumentCtx,
} from "./usecases.js";
import { NotFoundError } from "../goals.js";
import { findGoalDocument, listGoalDocumentsByGoal } from "./projection.js";

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

function setup(): { db: Database.Database; ctx: GoalDocumentCtx; dir: string; goalId: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-goal-docs-test-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  const goalId = "goal-1";
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at) VALUES (?, 'T', '', 'active', 1, ?, ?)",
  ).run(goalId, now, now);
  return { db, ctx: { db, bus: eventBus }, dir, goalId };
}

function eventsOfType(db: Database.Database, type: string): Array<{ payload: string }> {
  return db.prepare("SELECT payload FROM events WHERE type = ?").all(type) as Array<{ payload: string }>;
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("attachGoalDocument", () => {
  it("persists the row and emits document.attached", async () => {
    const { db, ctx, dir, goalId } = setup();
    const file = path.join(dir, "spec.md");
    writeFileSync(file, "# Spec");

    const doc = await attachGoalDocument(ctx, { goalId, kind: "file", ref: file });

    expect(doc.name).toBe("spec.md");
    expect(doc.kind).toBe("file");
    const row = findGoalDocument(db, goalId, doc.id);
    expect(row?.content).toBe("# Spec");
    const events = eventsOfType(db, "document.attached");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload).documentId).toBe(doc.id);
  });

  it("rejects a duplicate ref with DuplicateDocumentError", async () => {
    const { ctx, dir, goalId } = setup();
    const file = path.join(dir, "spec.md");
    writeFileSync(file, "# Spec");

    await attachGoalDocument(ctx, { goalId, kind: "file", ref: file });
    await expect(
      attachGoalDocument(ctx, { goalId, kind: "file", ref: file }),
    ).rejects.toBeInstanceOf(DuplicateDocumentError);
  });

  it("fails the attach on an unreadable ref and writes no row", async () => {
    const { db, ctx, dir, goalId } = setup();
    await expect(
      attachGoalDocument(ctx, { goalId, kind: "file", ref: path.join(dir, "missing.md") }),
    ).rejects.toBeInstanceOf(DocumentSnapshotError);
    expect(listGoalDocumentsByGoal(db, goalId)).toHaveLength(0);
  });

  it("throws NotFoundError for an unknown or archived goal", async () => {
    const { ctx, dir } = setup();
    const file = path.join(dir, "spec.md");
    writeFileSync(file, "# Spec");
    await expect(
      attachGoalDocument(ctx, { goalId: "nope", kind: "file", ref: file }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("detachGoalDocument", () => {
  it("removes the row and emits document.removed", async () => {
    const { db, ctx, dir, goalId } = setup();
    const file = path.join(dir, "spec.md");
    writeFileSync(file, "# Spec");
    const doc = await attachGoalDocument(ctx, { goalId, kind: "file", ref: file });

    await detachGoalDocument(ctx, { goalId, documentId: doc.id });

    expect(listGoalDocumentsByGoal(db, goalId)).toHaveLength(0);
    expect(eventsOfType(db, "document.removed")).toHaveLength(1);
  });

  it("throws NotFoundError for an unknown document", async () => {
    const { ctx, goalId } = setup();
    await expect(
      detachGoalDocument(ctx, { goalId, documentId: "nope" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("refreshGoalDocuments", () => {
  it("updates hash + fetched_at and emits one document.refreshed when the source changed", async () => {
    const { db, ctx, dir, goalId } = setup();
    const file = path.join(dir, "spec.md");
    writeFileSync(file, "v1");
    const doc = await attachGoalDocument(ctx, { goalId, kind: "file", ref: file });
    const before = findGoalDocument(db, goalId, doc.id)!;

    writeFileSync(file, "v2 with more content");
    await refreshGoalDocuments(db, eventBus, goalId);

    const after = findGoalDocument(db, goalId, doc.id)!;
    expect(after.content).toBe("v2 with more content");
    expect(after.content_hash).not.toBe(before.content_hash);
    expect(eventsOfType(db, "document.refreshed")).toHaveLength(1);
  });

  it("bumps fetched_at without an event when the source is unchanged", async () => {
    const { db, ctx, dir, goalId } = setup();
    const file = path.join(dir, "spec.md");
    writeFileSync(file, "same");
    const doc = await attachGoalDocument(ctx, { goalId, kind: "file", ref: file });
    db.prepare("UPDATE goal_documents SET fetched_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(doc.id);

    await refreshGoalDocuments(db, eventBus, goalId);

    const after = findGoalDocument(db, goalId, doc.id)!;
    expect(after.fetched_at).not.toBe("2000-01-01T00:00:00.000Z");
    expect(eventsOfType(db, "document.refreshed")).toHaveLength(0);
  });

  it("keeps the last snapshot untouched when the source becomes unreachable", async () => {
    const { db, ctx, dir, goalId } = setup();
    const file = path.join(dir, "spec.md");
    writeFileSync(file, "keep me");
    const doc = await attachGoalDocument(ctx, { goalId, kind: "file", ref: file });

    rmSync(file);
    await expect(refreshGoalDocuments(db, eventBus, goalId)).resolves.toBeUndefined();

    const after = findGoalDocument(db, goalId, doc.id)!;
    expect(after.content).toBe("keep me");
    expect(eventsOfType(db, "document.refreshed")).toHaveLength(0);
  });
});
