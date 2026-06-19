import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../migrations.js";
import { EventBus } from "../events.js";
import { listOrchestratorMessagesByGoal } from "./projection.js";
import { insertMessageWithEvent } from "./usecases.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.resolve(__dirname, "../../migrations");

function makeMigratedDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db, MIG_DIR);
  return db;
}

function seedGoal(db: Database.Database, goalId: string) {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).run(goalId, "t", "d", "active", 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

function stubBus(): EventBus {
  return new EventBus();
}

describe("listOrchestratorMessagesByGoal pendingQuestion", () => {
  it("parses a multi-question pending_question blob", () => {
    const db = new Database(":memory:");
    runMigrations(db, MIG_DIR);
    seedGoal(db, "g1");
    const pq = JSON.stringify({
      questionId: "q1",
      toolUseId: "t1",
      questions: [
        { header: "H", question: "Q?", multiSelect: false, options: [{ label: "A", description: "" }] },
      ],
    });
    db.prepare(
      "INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at, pending_question) VALUES (?,?,?,?,?,?,?,?)"
    ).run("m1", "g1", "orchestrator", "message", "Agent asks", "c1", "2026-01-01T00:00:01.000Z", pq);
    const msgs = listOrchestratorMessagesByGoal(db, "g1");
    expect(msgs[0]!.pendingQuestion?.questions).toHaveLength(1);
  });

  it("drops a legacy single-shape pending_question instead of throwing", () => {
    const db = new Database(":memory:");
    runMigrations(db, MIG_DIR);
    seedGoal(db, "g1");
    const legacy = JSON.stringify({
      questionId: "q1",
      header: "Color",
      question: "c?",
      options: [{ label: "Red", description: "" }],
    });
    db.prepare(
      "INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at, pending_question) VALUES (?,?,?,?,?,?,?,?)"
    ).run("m1", "g1", "orchestrator", "message", "old", "c1", "2026-01-01T00:00:01.000Z", legacy);
    const msgs = listOrchestratorMessagesByGoal(db, "g1");
    expect(msgs[0]!.pendingQuestion).toBeUndefined(); // dropped, row still returned
  });
});

describe("listOrchestratorMessagesByGoal pendingApproval", () => {
  it("round-trips a message's pendingApproval payload", () => {
    const db = makeMigratedDb();
    seedGoal(db, "g1");
    const approval = { approvalId: "a1", sessionId: "s1", toolName: "Bash", summary: "ls" };
    insertMessageWithEvent(
      { db, bus: stubBus(), idFactory: () => "m1" },
      { id: "m1", goalId: "g1", role: "orchestrator", body: "The agent wants to run a command.",
        correlationId: "c1", createdAt: "2026-06-03T00:00:00.000Z", pendingApproval: approval },
    );
    const messages = listOrchestratorMessagesByGoal(db, "g1");
    expect(messages[0]!.pendingApproval).toMatchObject(approval);
  });
});
