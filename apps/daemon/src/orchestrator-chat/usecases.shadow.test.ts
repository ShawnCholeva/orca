import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { createOrchestratorMessage, OrchestratorChatProviderUnavailableError } from "./usecases.js";

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE goals (id TEXT PRIMARY KEY, title TEXT, description TEXT,
      orchestrator_provider TEXT, orchestrator_model TEXT, active_workflow_run_id TEXT, archived_at TEXT);
    CREATE TABLE orchestrator_messages (id TEXT PRIMARY KEY, goal_id TEXT, role TEXT, kind TEXT,
      body TEXT, correlation_id TEXT, created_at TEXT, pending_question TEXT);
    CREATE TABLE events (id TEXT, type TEXT, goal_id TEXT, payload TEXT, created_at TEXT);
    INSERT INTO goals VALUES ('G1','T','D','orca/anthropic','claude-haiku-4-5',NULL,NULL);
  `);
  return db;
}

describe("createOrchestratorMessage shadow path", () => {
  it("shadow_session mode: returns reply:null and posts the orchestrator reply asynchronously", async () => {
    const db = setup(); // goal G1, provider orca/anthropic, NO active run
    const inserted: string[] = [];
    let resolveAsk: (r: { text: string }) => void = () => {};
    const ask = vi.fn(() => new Promise<{ text: string }>((r) => { resolveAsk = r; }));
    let idN = 0;
    const ctx: any = {
      db, bus: { publish: vi.fn() },
      modelProviderRegistry: { get: vi.fn(() => { throw new Error("SDK must not be used"); }) },
      shadowAsk: ask,
      resolveOrchestratorMode: () => "shadow_session",
      onOrchestratorReply: (goalId: string, body: string) => { inserted.push(body); },
      now: () => "2026-05-29T00:00:00Z",
      idFactory: () => `id${++idN}`,
    };
    const res = await createOrchestratorMessage(ctx, "G1", { body: "hello" });
    expect(res.reply).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(inserted).toEqual([]);
    resolveAsk({ text: '{"replyText":"hi async"}' });
    await new Promise((r) => setImmediate(r));
    expect(inserted).toEqual(["hi async"]);
  });

  it("shadow_session mode: posts fallback message when shadowAsk rejects", async () => {
    const db = setup();
    const inserted: string[] = [];
    const ask = vi.fn().mockRejectedValue(new Error("network error"));
    let idN = 0;
    const ctx: any = {
      db, bus: { publish: vi.fn() },
      modelProviderRegistry: { get: vi.fn(() => { throw new Error("SDK must not be used"); }) },
      shadowAsk: ask,
      resolveOrchestratorMode: () => "shadow_session",
      onOrchestratorReply: (_goalId: string, body: string) => { inserted.push(body); },
      now: () => "2026-05-29T00:00:00Z",
      idFactory: () => `id${++idN}`,
    };
    const res = await createOrchestratorMessage(ctx, "G1", { body: "hello" });
    expect(res.reply).toBeNull();
    await new Promise((r) => setImmediate(r));
    expect(inserted).toEqual(["Orchestrator is unavailable right now. Please try again."]);
  });

  it("shadow_session mode: posts unreadable-reply message when shadowAsk output is malformed", async () => {
    const db = setup();
    const inserted: string[] = [];
    const ask = vi.fn().mockResolvedValue({ text: "not json {{{" });
    let idN = 0;
    const ctx: any = {
      db, bus: { publish: vi.fn() },
      modelProviderRegistry: { get: vi.fn(() => { throw new Error("SDK must not be used"); }) },
      shadowAsk: ask,
      resolveOrchestratorMode: () => "shadow_session",
      onOrchestratorReply: (_goalId: string, body: string) => { inserted.push(body); },
      now: () => "2026-05-29T00:00:00Z",
      idFactory: () => `id${++idN}`,
    };
    const res = await createOrchestratorMessage(ctx, "G1", { body: "hello" });
    expect(res.reply).toBeNull();
    await new Promise((r) => setImmediate(r));
    expect(inserted).toEqual(["Orchestrator returned an unreadable reply."]);
  });

  it("shadow_session mode: throws OrchestratorChatProviderUnavailableError when shadowAsk or onOrchestratorReply is missing", async () => {
    const db = setup();
    let idN = 0;
    await expect(
      createOrchestratorMessage(
        {
          db,
          bus: { publish: vi.fn() } as any,
          modelProviderRegistry: { get: vi.fn() } as any,
          resolveOrchestratorMode: () => "shadow_session",
          // shadowAsk intentionally omitted
          now: () => "2026-05-29T00:00:00Z",
          idFactory: () => `id${++idN}`,
        } as any,
        "G1",
        { body: "hello" }
      )
    ).rejects.toMatchObject({ code: "orchestrator_provider_unavailable" });
  });

  it("one_shot mode: calls SDK provider and returns reply synchronously", async () => {
    const db = setup();
    db.exec(`UPDATE goals SET orchestrator_provider = 'orca/openai' WHERE id = 'G1'`);
    const fakeProvider = {
      complete: vi.fn().mockResolvedValue({ parsed: { replyText: "sync hi" } }),
    };
    let idN = 0;
    const res = await createOrchestratorMessage(
      {
        db,
        bus: { publish: vi.fn() } as any,
        modelProviderRegistry: { get: vi.fn(() => fakeProvider) } as any,
        resolveOrchestratorMode: () => "one_shot",
        now: () => "2026-05-29T00:00:00Z",
        idFactory: () => `id${++idN}`,
      } as any,
      "G1",
      { body: "hello" }
    );
    expect(fakeProvider.complete).toHaveBeenCalledTimes(1);
    expect(res.reply?.body).toBe("sync hi");
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
        resolveOrchestratorMode: () => "shadow_session",
        onOrchestratorReply: vi.fn(),
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
