import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../migrations.js";
import { listOrchestratorMessagesByGoal } from "./projection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.resolve(__dirname, "../../migrations");

function seedGoal(db: Database.Database, goalId: string) {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  ).run(goalId, "t", "d", "active", 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
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
