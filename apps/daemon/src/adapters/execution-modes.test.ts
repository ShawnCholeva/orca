import { describe, expect, it } from "vitest";
import { ADAPTER_EXECUTION_MODE_DEFAULTS } from "./execution-modes.js";
import { runMigrations } from "../migrations.js";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAdapterExecutionModeConfig,
  upsertAdapterExecutionModeConfig,
  seedAdapterExecutionModes,
} from "./execution-modes.js";
import { EventBus } from "../events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.resolve(__dirname, "../../migrations");

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db, MIG_DIR);
  return db;
}

describe("ADAPTER_EXECUTION_MODE_DEFAULTS", () => {
  it("claude-code preferred shadow_session, disabled one_shot with billing reason", () => {
    const cfg = ADAPTER_EXECUTION_MODE_DEFAULTS["claude-code"];
    expect(cfg).toBeDefined();
    const preferred = cfg.enabledExecutionModes.find((e) => e.preferred === true);
    expect(preferred?.mode).toBe("shadow_session");
    const disabled = cfg.disabledExecutionModes.find((e) => e.mode === "one_shot");
    expect(disabled?.reason).toMatch(/2026-06-15/);
  });

  it("codex preferred shadow_session and disables one_shot API-key orchestration", () => {
    const cfg = ADAPTER_EXECUTION_MODE_DEFAULTS["codex"];
    const preferred = cfg.enabledExecutionModes.find((e) => e.preferred === true);
    expect(preferred?.mode).toBe("shadow_session");
    expect(cfg.disabledExecutionModes.find((e) => e.mode === "one_shot")?.reason).toMatch(/API keys/i);
  });
});

describe("adapter execution-mode repository", () => {
  it("seeds defaults on first call; idempotent on second call", () => {
    const db = makeDb();
    const supportedByAdapter: Record<string, ("shadow_session"|"one_shot")[]> = {
      "claude-code": ["shadow_session", "one_shot"],
      codex: ["one_shot", "shadow_session"],
    };
    const now = () => "2026-05-28T00:00:00.000Z";
    seedAdapterExecutionModes(db, now, supportedByAdapter);
    const cc = getAdapterExecutionModeConfig(db, "claude-code");
    expect(cc).not.toBeNull();
    expect(cc!.enabledExecutionModes.find((e) => e.preferred)?.mode).toBe("shadow_session");

    // idempotent: second call doesn't change rows
    const before = db.prepare("SELECT updated_at FROM adapter_execution_modes WHERE adapter_id=?").get("claude-code") as { updated_at: string };
    seedAdapterExecutionModes(db, () => "2026-06-01T00:00:00.000Z", supportedByAdapter);
    const after = db.prepare("SELECT updated_at FROM adapter_execution_modes WHERE adapter_id=?").get("claude-code") as { updated_at: string };
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("updates old system-seeded codex mode rows to shadow_session", () => {
    const db = makeDb();
    const supportedByAdapter: Record<string, ("shadow_session"|"one_shot")[]> = {
      codex: ["one_shot", "shadow_session"],
    };
    db.prepare(
      `INSERT INTO adapter_execution_modes
         (adapter_id, enabled_modes_json, disabled_modes_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 'system_seed')`
    ).run(
      "codex",
      JSON.stringify([{ mode: "one_shot", preferred: true }, { mode: "shadow_session" }]),
      JSON.stringify([]),
      "2026-05-28T00:00:00.000Z"
    );

    seedAdapterExecutionModes(db, () => "2026-06-01T00:00:00.000Z", supportedByAdapter);

    const codex = getAdapterExecutionModeConfig(db, "codex");
    expect(codex!.enabledExecutionModes.find((e) => e.preferred)?.mode).toBe("shadow_session");
    expect(codex!.disabledExecutionModes.find((e) => e.mode === "one_shot")).toBeDefined();
  });

  it("upsert validates invariants", () => {
    const db = makeDb();
    const now = () => "2026-05-28T00:00:00.000Z";

    expect(() =>
      upsertAdapterExecutionModeConfig(
        db,
        now,
        {
          adapterId: "claude-code",
          enabledExecutionModes: [{ mode: "shadow_session" }],  // no preferred
          disabledExecutionModes: [{ mode: "one_shot", reason: "x" }],
        },
        ["shadow_session", "one_shot"],
        "test"
      )
    ).toThrow(/preferred/);
  });

  it("upsert writes valid config", () => {
    const db = makeDb();
    const now = () => "2026-05-28T00:00:00.000Z";
    upsertAdapterExecutionModeConfig(
      db,
      now,
      {
        adapterId: "codex",
        enabledExecutionModes: [
          { mode: "shadow_session", preferred: true },
          { mode: "one_shot" },
        ],
        disabledExecutionModes: [],
      },
      ["one_shot", "shadow_session"],
      "user"
    );
    const cfg = getAdapterExecutionModeConfig(db, "codex");
    expect(cfg!.enabledExecutionModes.find((e) => e.preferred)?.mode).toBe("shadow_session");
  });
});

describe("audit event on upsert", () => {
  it("appends adapter.execution_modes.changed event and publishes it", () => {
    const db = makeDb();
    const bus = new EventBus();
    const seen: { type: string; payload: unknown }[] = [];
    bus.subscribe((event) => seen.push({ type: event.type, payload: event.payload }));

    upsertAdapterExecutionModeConfig(
      db,
      () => "2026-05-28T01:00:00.000Z",
      {
        adapterId: "codex",
        enabledExecutionModes: [
          { mode: "shadow_session", preferred: true },
          { mode: "one_shot" },
        ],
        disabledExecutionModes: [],
      },
      ["one_shot", "shadow_session"],
      "user",
      { bus }
    );

    const changed = seen.find((e) => e.type === "adapter.execution_modes.changed");
    expect(changed).toBeDefined();
    expect((changed!.payload as { adapterId: string }).adapterId).toBe("codex");

    // also persisted to events table
    const rows = db.prepare(
      "SELECT type, payload FROM events WHERE type = 'adapter.execution_modes.changed'"
    ).all() as { type: string; payload: string }[];
    expect(rows.length).toBe(1);
    const parsed = JSON.parse(rows[0]!.payload) as { adapterId: string; updatedBy: string };
    expect(parsed.adapterId).toBe("codex");
    expect(parsed.updatedBy).toBe("user");
  });
});
