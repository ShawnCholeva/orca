import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { createOrchestratorMessage } from "./usecases.js";

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE goals (id TEXT PRIMARY KEY, title TEXT, description TEXT,
      orchestrator_provider TEXT, orchestrator_model TEXT, active_workflow_run_id TEXT, archived_at TEXT);
    CREATE TABLE orchestrator_messages (id TEXT PRIMARY KEY, goal_id TEXT, role TEXT, kind TEXT,
      body TEXT, correlation_id TEXT, created_at TEXT);
    CREATE TABLE events (id TEXT, type TEXT, goal_id TEXT, payload TEXT, created_at TEXT);
    INSERT INTO goals VALUES ('G1','T','D','orca/anthropic','claude-haiku-4-5',NULL,NULL);
  `);
  return db;
}

describe("createOrchestratorMessage shadow path", () => {
  it("uses shadow ask() (not SDK) for orca/anthropic with no active run, returns reply", async () => {
    const db = setup();
    const ask = vi.fn().mockResolvedValue({ text: '{"replyText":"hi from shadow"}' });
    let idN = 0;
    const res = await createOrchestratorMessage(
      {
        db,
        bus: { publish: vi.fn() } as any,
        modelProviderRegistry: { get: vi.fn(() => { throw new Error("SDK must not be used"); }) } as any,
        shadowAsk: ask,
        now: () => "2026-05-29T00:00:00Z",
        idFactory: () => `id${++idN}`,
      } as any,
      "G1",
      { body: "hello" }
    );
    expect(ask).toHaveBeenCalledTimes(1);
    expect(res.reply?.body).toBe("hi from shadow");
  });

  it("returns reply:null when a workflow run is active (defers to mediator)", async () => {
    const db = setup();
    db.prepare("UPDATE goals SET active_workflow_run_id = 'R1' WHERE id = 'G1'").run();
    const ask = vi.fn();
    let idN = 0;
    const res = await createOrchestratorMessage(
      {
        db,
        bus: { publish: vi.fn() } as any,
        modelProviderRegistry: { get: vi.fn() } as any,
        shadowAsk: ask,
        now: () => "2026-05-29T00:00:00Z",
        idFactory: () => `id${++idN}`,
      } as any,
      "G1",
      { body: "hello" }
    );
    expect(res.reply).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
});
