import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../migrations.js";
import { EventBus } from "../events.js";
import { listOrchestratorMessagesByGoal } from "./projection.js";
import { insertMessageWithEvent, recordWorkerQuestionAnswer } from "./usecases.js";

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

describe("listOrchestratorMessagesByGoal pendingRevision", () => {
  it("round-trips a message's pendingRevision payload", () => {
    const db = makeMigratedDb();
    seedGoal(db, "g1");
    const pr = JSON.stringify({ workflowRunId: "r1" });
    db.prepare(
      "INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at, pending_revision) VALUES (?,?,?,?,?,?,?,?)"
    ).run("m1", "g1", "orchestrator", "message", "Revision needed", "c1", "2026-01-01T00:00:01.000Z", pr);
    const msgs = listOrchestratorMessagesByGoal(db, "g1");
    expect(msgs[0]!.pendingRevision?.workflowRunId).toBe("r1");
  });
});

describe("recordWorkerQuestionAnswer", () => {
  it("merges the answer into the matching worker-question message", () => {
    const db = makeMigratedDb();
    seedGoal(db, "g1");
    const bus = new EventBus();
    const publishSpy = vi.spyOn(bus, "publish");
    const ctx = { db, bus, idFactory: () => "evt-1" };
    insertMessageWithEvent(
      { db, bus: stubBus(), idFactory: () => "m1" },
      {
        id: "m1", goalId: "g1", role: "orchestrator", body: "Which?",
        correlationId: "c1", createdAt: "2026-06-18T00:00:00.000Z",
        pendingQuestion: {
          questionId: "q1", toolUseId: "t1", source: "worker",
          questions: [{ header: "H", question: "Which?", multiSelect: false, options: [{ label: "A", description: "a" }] }],
        },
      },
    );

    const ok = recordWorkerQuestionAnswer(ctx, {
      goalId: "g1", questionId: "q1",
      answer: { answers: [{ questionIndex: 0, selectedLabels: ["A"] }] },
    });

    expect(ok).toBe(true);
    const msgs = listOrchestratorMessagesByGoal(db, "g1");
    expect(msgs[0]!.pendingQuestion?.answer?.answers?.[0]?.selectedLabels).toEqual(["A"]);
    expect(publishSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "orchestrator.message.updated", goalId: "g1" }),
    );
  });

  it("returns false when no message matches", () => {
    const db = makeMigratedDb();
    const ctx = { db, bus: new EventBus(), idFactory: () => "evt" };
    expect(recordWorkerQuestionAnswer(ctx, { goalId: "g1", questionId: "nope", answer: { viaChat: true } })).toBe(false);
  });
});
