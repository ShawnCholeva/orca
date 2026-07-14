import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { isHumanPromptOpen } from "./human-prompt-gate.js";

const tempDirs: string[] = [];
const NOW = "2026-06-29T05:00:00.000Z";

function config(dir: string): Config {
  return {
    dataDir: dir, port: 8787, logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024, sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024, memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000, hookResolverCommand: ["node", "x.js"],
    getAuthToken: () => "t",
  };
}

function setup(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-gate-"));
  tempDirs.push(dir);
  const db = openDatabase(config(dir));
  runMigrations(db, defaultMigrationsDir());
  db.prepare(
    "INSERT INTO goals (id, title, intent, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES ('g1','G','d','active',1,?,?,NULL,'orca/openai','gpt-5')"
  ).run(NOW, NOW);
  return db;
}

function insertQuestion(db: Database.Database, id: string, pq: Record<string, unknown>): void {
  db.prepare(
    "INSERT INTO orchestrator_messages (id, goal_id, role, kind, body, correlation_id, created_at, pending_question) VALUES (?, 'g1', 'orchestrator', 'message', 'b', ?, ?, ?)"
  ).run(id, id, NOW, JSON.stringify(pq));
}

function insertConfirmationCard(db: Database.Database, id: string, stepRunId: string): void {
  db.prepare(
    `INSERT INTO activities (id, goal_id, workflow_run_id, step_run_id, agent_session_id, turn_ordinal, status, current_text, final_summary, source_kind, work_category, confidence, pending_question, created_at, updated_at, completed_at)
     VALUES (?, 'g1', 'run1', ?, NULL, 0, 'paused_for_input', 'Confirm', NULL, 'step_confirmation_pending', NULL, NULL, NULL, ?, ?, NULL)`
  ).run(id, stepRunId, NOW, NOW);
}

afterEach(() => {
  closeDatabase();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("isHumanPromptOpen", () => {
  it("false when nothing is open for the step run", () => {
    const db = setup();
    expect(isHumanPromptOpen(db, "sr1")).toBe(false);
  });

  it("true for an unanswered worker question scoped to the step run", () => {
    const db = setup();
    insertQuestion(db, "m1", { questionId: "q1", toolUseId: "t1", questions: [{ question: "?", header: "h", options: [{ label: "a", description: "d" }] }], source: "worker", stepRunId: "sr1" });
    expect(isHumanPromptOpen(db, "sr1")).toBe(true);
  });

  it("false when that question has been answered", () => {
    const db = setup();
    insertQuestion(db, "m1", { questionId: "q1", toolUseId: "t1", questions: [{ question: "?", header: "h", options: [{ label: "a", description: "d" }] }], source: "worker", stepRunId: "sr1", answer: { viaChat: true } });
    expect(isHumanPromptOpen(db, "sr1")).toBe(false);
  });

  it("false when the question is withdrawn", () => {
    const db = setup();
    insertQuestion(db, "m1", { questionId: "q1", toolUseId: "t1", questions: [{ question: "?", header: "h", options: [{ label: "a", description: "d" }] }], source: "orchestrator", stepRunId: "sr1", withdrawn: true });
    expect(isHumanPromptOpen(db, "sr1")).toBe(false);
  });

  it("does not leak across step runs", () => {
    const db = setup();
    insertQuestion(db, "m1", { questionId: "q1", toolUseId: "t1", questions: [{ question: "?", header: "h", options: [{ label: "a", description: "d" }] }], source: "worker", stepRunId: "sr1" });
    expect(isHumanPromptOpen(db, "sr2")).toBe(false);
  });

  it("true for an open step-confirmation card", () => {
    const db = setup();
    insertConfirmationCard(db, "a1", "sr1");
    expect(isHumanPromptOpen(db, "sr1")).toBe(true);
  });
});
