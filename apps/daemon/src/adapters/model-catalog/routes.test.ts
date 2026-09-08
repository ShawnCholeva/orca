import Fastify from "fastify";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { registerModelCatalogRoutes } from "./routes.js";
import { SEED_CATALOG } from "./seed.js";
import type { CatalogModel } from "./types.js";

const MODEL: CatalogModel = {
  id: "claude-opus-5", family: "opus", displayName: "Opus 5", contextWindow: 1_000_000,
  supports1mSuffix: true, pricingTier: "tier_5_25", advisorRank: 4,
  supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high",
};

function appWith(source: "extracted" | "cached" | "seed") {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE model_catalog_cache (
    adapter_id TEXT NOT NULL, adapter_version TEXT NOT NULL,
    extracted_at TEXT NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY (adapter_id, adapter_version))`);
  const app = Fastify();
  registerModelCatalogRoutes(app, {
    db,
    load: async (_db, adapterId) => ({
      models: adapterId === "claude-code" ? [MODEL] : [],
      source,
      adapterVersion: "2.1.263",
    }),
  });
  return app;
}

describe("GET /v1/model-catalog", () => {
  it("returns each adapter's models with its display names", async () => {
    const res = await appWith("extracted").inject({ method: "GET", url: "/v1/model-catalog" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const claude = body.adapters.find((a: { adapterId: string }) => a.adapterId === "claude-code");
    expect(claude.models[0].displayName).toBe("Opus 5");
  });

  it("reports the source so a stale catalog can be shown as stale", async () => {
    const body = (await appWith("seed").inject({ method: "GET", url: "/v1/model-catalog" })).json();
    expect(body.adapters.every((a: { source: string }) => a.source === "seed")).toBe(true);
  });

  it("reports the detected CLI version", async () => {
    const body = (await appWith("extracted").inject({ method: "GET", url: "/v1/model-catalog" })).json();
    expect(body.adapters[0].adapterVersion).toBe("2.1.263");
  });

  it("returns the profiles a node can reference", async () => {
    const body = (await appWith("extracted").inject({ method: "GET", url: "/v1/model-catalog" })).json();
    expect(body.profiles.map((p: { id: string }) => p.id)).toContain("reasoning");
  });
});

describe("POST /v1/model-catalog/refresh", () => {
  it("returns the catalog after re-reading it", async () => {
    const res = await appWith("extracted").inject({ method: "POST", url: "/v1/model-catalog/refresh" });
    expect(res.statusCode).toBe(200);
    expect(res.json().adapters).toBeDefined();
  });

  it("passes force=true on refresh and force=false on read", async () => {
    const seen: Array<boolean | undefined> = [];
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE model_catalog_cache (
      adapter_id TEXT NOT NULL, adapter_version TEXT NOT NULL,
      extracted_at TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY (adapter_id, adapter_version))`);
    const app = Fastify();
    registerModelCatalogRoutes(app, {
      db,
      load: async (_db, adapterId, opts) => {
        seen.push(opts?.force);
        return { models: adapterId === "claude-code" ? [MODEL] : [], source: "extracted", adapterVersion: "2.1.263" };
      },
    });

    await app.inject({ method: "GET", url: "/v1/model-catalog" });
    await app.inject({ method: "POST", url: "/v1/model-catalog/refresh" });

    expect(seen).toEqual([false, false, false, true, true, true]);
  });
});

describe("adapter isolation", () => {
  it("serves the seed for an adapter whose load rejects, without dropping the others", async () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE model_catalog_cache (
      adapter_id TEXT NOT NULL, adapter_version TEXT NOT NULL,
      extracted_at TEXT NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY (adapter_id, adapter_version))`);
    const app = Fastify();
    registerModelCatalogRoutes(app, {
      db,
      load: async (_db, adapterId) => {
        if (adapterId === "codex") throw new Error("db locked");
        return { models: adapterId === "claude-code" ? [MODEL] : [], source: "extracted", adapterVersion: "2.1.263" };
      },
    });

    const res = await app.inject({ method: "GET", url: "/v1/model-catalog" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.adapters).toHaveLength(3);

    const claude = body.adapters.find((a: { adapterId: string }) => a.adapterId === "claude-code");
    expect(claude.source).toBe("extracted");

    const codex = body.adapters.find((a: { adapterId: string }) => a.adapterId === "codex");
    expect(codex.source).toBe("seed");
    expect(codex.adapterVersion).toBeNull();
    expect(codex.models).toEqual(SEED_CATALOG.codex);
  });

  it("warns, naming the adapter and the reason, when it degrades to the seed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = new Database(":memory:");
      const app = Fastify();
      registerModelCatalogRoutes(app, {
        db,
        load: async (_db, adapterId) => {
          if (adapterId === "codex") throw new Error("db locked");
          return { models: [MODEL], source: "extracted", adapterVersion: "2.1.263" };
        },
      });

      await app.inject({ method: "GET", url: "/v1/model-catalog" });
      const line = warn.mock.calls.map((c) => String(c[0])).find((c) => c.includes("codex"));
      expect(line).toBeDefined();
      expect(line).toContain("db locked");
    } finally {
      warn.mockRestore();
    }
  });
});
