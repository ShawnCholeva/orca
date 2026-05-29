import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { buildContextFromDb } from "./build-context.js";

function seed(db: Database.Database) {
  db.exec(`
    CREATE TABLE goals (id TEXT, title TEXT, description TEXT);
    CREATE TABLE orchestrator_messages (id TEXT, goal_id TEXT, role TEXT, kind TEXT, body TEXT, created_at TEXT);
    INSERT INTO goals VALUES ('G1','T','D');
    INSERT INTO orchestrator_messages VALUES ('m1','G1','user','message','hello','2026-05-29T00:00:00Z');
  `);
}

describe("buildContextFromDb", () => {
  it("includes goal metadata and recent chat messages", () => {
    const db = new Database(":memory:");
    seed(db);
    const ctx = buildContextFromDb(db, {
      goalId: "G1",
      runId: null,
      stepRunId: null,
      payloadBudgetBytes: 64 * 1024,
    });
    expect(ctx.goal.title).toBe("T");
    expect(ctx.conversation.chatMessages.some((m) => m.body === "hello")).toBe(true);
  });
});
