import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations, defaultMigrationsDir } from "../migrations.js";
import { getSupervisionMode, setSupervisionMode } from "./store.js";

function freshDb(): Database.Database {
  const d = new Database(":memory:");
  runMigrations(d, defaultMigrationsDir());
  return d;
}

describe("settings store", () => {
  let d: Database.Database;
  beforeEach(() => {
    d = freshDb();
  });

  it("defaults to supervised when unset", () => {
    expect(getSupervisionMode(d)).toBe("supervised");
  });

  it("persists and reads back unsupervised", () => {
    setSupervisionMode(d, "unsupervised", "2026-06-11T00:00:00.000Z");
    expect(getSupervisionMode(d)).toBe("unsupervised");
  });

  it("upserts on repeated writes", () => {
    setSupervisionMode(d, "unsupervised", "2026-06-11T00:00:00.000Z");
    setSupervisionMode(d, "supervised", "2026-06-11T00:01:00.000Z");
    expect(getSupervisionMode(d)).toBe("supervised");
  });
});
