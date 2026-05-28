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

  it("codex preferred one_shot with shadow_session as fallback enabled", () => {
    const cfg = ADAPTER_EXECUTION_MODE_DEFAULTS["codex"];
    const preferred = cfg.enabledExecutionModes.find((e) => e.preferred === true);
    expect(preferred?.mode).toBe("one_shot");
    const fallback = cfg.enabledExecutionModes.find((e) => e.preferred !== true);
    expect(fallback?.mode).toBe("shadow_session");
  });

  it("opencode preferred shadow_session, disabled one_shot", () => {
    const cfg = ADAPTER_EXECUTION_MODE_DEFAULTS["opencode"];
    const preferred = cfg.enabledExecutionModes.find((e) => e.preferred === true);
    expect(preferred?.mode).toBe("shadow_session");
    expect(cfg.disabledExecutionModes.find((e) => e.mode === "one_shot")).toBeDefined();
  });
});

describe("adapter execution-mode repository", () => {
  it("seeds defaults on first call; idempotent on second call", () => {
    const db = makeDb();
    const supportedByAdapter: Record<string, ("shadow_session"|"one_shot")[]> = {
      "claude-code": ["shadow_session", "one_shot"],
      codex: ["one_shot", "shadow_session"],
      opencode: ["shadow_session"],
      "gemini-cli": ["one_shot"],
      "shell-manual": ["shadow_session"],
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
