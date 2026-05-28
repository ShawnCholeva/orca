import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../migrations.js";
import { seedAdapterExecutionModes } from "./execution-modes.js";
import { AdapterDispatcher } from "./dispatcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.resolve(__dirname, "../../migrations");

function makeDb() {
  const db = new Database(":memory:");
  runMigrations(db, MIG_DIR);
  seedAdapterExecutionModes(db, () => "t0", {
    "claude-code": ["shadow_session", "one_shot"],
    codex: ["one_shot", "shadow_session"],
  });
  return db;
}

describe("AdapterDispatcher.resolveMode", () => {
  it("returns the preferred enabled mode", () => {
    const db = makeDb();
    const d = new AdapterDispatcher({ db });
    expect(d.resolveMode("claude-code")).toEqual({ adapterId: "claude-code", mode: "shadow_session", fallbacks: [] });
    expect(d.resolveMode("codex")).toEqual({ adapterId: "codex", mode: "one_shot", fallbacks: ["shadow_session"] });
  });

  it("throws when adapter has no config", () => {
    const db = makeDb();
    const d = new AdapterDispatcher({ db });
    expect(() => d.resolveMode("opencode")).toThrow(/no execution-mode config/);
  });
});
