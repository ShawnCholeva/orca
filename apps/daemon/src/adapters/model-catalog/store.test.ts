import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SEED_CATALOG } from "./seed.js";
import { loadCatalog, readCachedCatalog } from "./store.js";
import type { CatalogModel } from "./types.js";

const MODEL: CatalogModel = {
  id: "claude-fable-5-1", family: "fable", displayName: "Fable 5.1",
  contextWindow: 1_000_000, supports1mSuffix: true, pricingTier: "tier_10_50",
  advisorRank: 5, supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
  defaultEffort: "high",
};

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE model_catalog_cache (
    adapter_id TEXT NOT NULL, adapter_version TEXT NOT NULL,
    extracted_at TEXT NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY (adapter_id, adapter_version))`);
  return db;
}

describe("loadCatalog", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("extracts and caches when the version is unseen", async () => {
    const extract = vi.fn().mockResolvedValue([MODEL]);
    const got = await loadCatalog(db, "claude-code", {
      version: async () => "2.1.263", extract, now: () => "2026-09-07T00:00:00Z",
    });
    expect(got.source).toBe("extracted");
    expect(got.models).toEqual([MODEL]);
    expect(readCachedCatalog(db, "claude-code", "2.1.263")).toEqual([MODEL]);
  });

  it("does not re-extract a version already cached", async () => {
    const extract = vi.fn().mockResolvedValue([MODEL]);
    const deps = { version: async () => "2.1.263", extract, now: () => "2026-09-07T00:00:00Z" };
    await loadCatalog(db, "claude-code", deps);
    const second = await loadCatalog(db, "claude-code", deps);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(second.source).toBe("cached");
  });

  it("re-extracts when the version changes", async () => {
    const extract = vi.fn().mockResolvedValue([MODEL]);
    const now = () => "2026-09-07T00:00:00Z";
    await loadCatalog(db, "claude-code", { version: async () => "2.1.263", extract, now });
    const upgraded = await loadCatalog(db, "claude-code", { version: async () => "2.2.0", extract, now });
    expect(extract).toHaveBeenCalledTimes(2);
    expect(upgraded.source).toBe("extracted");
  });

  it("falls back to the newest cached row when extraction returns nothing", async () => {
    const now = () => "2026-09-07T00:00:00Z";
    await loadCatalog(db, "claude-code", { version: async () => "2.1.263", extract: async () => [MODEL], now });
    const got = await loadCatalog(db, "claude-code", {
      version: async () => "2.2.0", extract: async () => [], now,
    });
    expect(got.source).toBe("cached");
    expect(got.models).toEqual([MODEL]);
  });

  it("falls back to the seed when extraction fails and nothing is cached", async () => {
    const got = await loadCatalog(db, "claude-code", {
      version: async () => "2.1.263", extract: async () => [], now: () => "2026-09-07T00:00:00Z",
    });
    expect(got.source).toBe("seed");
    expect(got.models).toEqual(SEED_CATALOG["claude-code"]);
  });

  it("falls back to the seed when the version cannot be read at all", async () => {
    const got = await loadCatalog(db, "claude-code", {
      version: async () => null, extract: async () => [MODEL], now: () => "2026-09-07T00:00:00Z",
    });
    expect(got.source).toBe("seed");
  });

  it("serves the seed for an adapter with no extractor", async () => {
    const got = await loadCatalog(db, "codex", {
      version: async () => "1.0.0", extract: async () => [], now: () => "2026-09-07T00:00:00Z",
    });
    expect(got.source).toBe("seed");
    expect(got.models).toEqual(SEED_CATALOG.codex);
  });

  it("reports the version the cached models actually came from, not the installed one", async () => {
    const now = () => "2026-09-07T00:00:00Z";
    await loadCatalog(db, "claude-code", { version: async () => "1.9.0", extract: async () => [MODEL], now });
    const got = await loadCatalog(db, "claude-code", {
      version: async () => "2.2.0", extract: async () => [], now,
    });
    expect(got.source).toBe("cached");
    expect(got.adapterVersion).toBe("1.9.0");
  });

  it("reports no version for a seed-sourced catalog", async () => {
    const got = await loadCatalog(db, "claude-code", {
      version: async () => "2.1.263", extract: async () => [], now: () => "2026-09-07T00:00:00Z",
    });
    expect(got.source).toBe("seed");
    expect(got.adapterVersion).toBeNull();
  });

  it("prefers the most recently extracted row when timestamps tie", async () => {
    const now = () => "2026-09-07T00:00:00Z";
    await loadCatalog(db, "claude-code", { version: async () => "1.0.0", extract: async () => [MODEL], now });
    await loadCatalog(db, "claude-code", { version: async () => "1.1.0", extract: async () => [{ ...MODEL, id: "claude-newer" }], now });
    const got = await loadCatalog(db, "claude-code", { version: async () => "9.9.9", extract: async () => [], now });
    expect(got.adapterVersion).toBe("1.1.0");
    expect(got.models[0].id).toBe("claude-newer");
  });
});
