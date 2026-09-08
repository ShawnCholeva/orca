import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { AdapterId } from "@orca/contracts";
import { SEED_PROFILES } from "./profiles.js";
import { SEED_CATALOG } from "./seed.js";
import type { LoadedCatalog } from "./store.js";

const ADAPTERS: AdapterId[] = ["claude-code", "codex", "antigravity"];

export interface ModelCatalogRouteDeps {
  db: Database.Database;
  load: (db: Database.Database, adapterId: AdapterId, opts?: { force?: boolean }) => Promise<LoadedCatalog>;
}

export function registerModelCatalogRoutes(
  app: FastifyInstance,
  deps: ModelCatalogRouteDeps,
): void {
  const body = async (force: boolean) => ({
    adapters: await Promise.all(
      ADAPTERS.map(async (adapterId) => {
        // One adapter's load failing (e.g. a cache-write error) must not take
        // down the other two — serve the seed for that adapter and say so via
        // its own source badge, same as any other extraction failure.
        let loaded: LoadedCatalog;
        try {
          loaded = await deps.load(deps.db, adapterId, { force });
        } catch (err) {
          // Say it out loud. Dropping from ~19 extracted models to the 5-entry
          // seed is invisible in the response apart from a source badge, which
          // is how a stale catalog goes unnoticed for weeks.
          console.warn(
            `[model-catalog] ${adapterId}: load failed, serving the seed — ${err instanceof Error ? err.message : String(err)}`,
          );
          loaded = { models: SEED_CATALOG[adapterId] ?? [], source: "seed", adapterVersion: null };
        }
        return {
          adapterId,
          adapterVersion: loaded.adapterVersion,
          source: loaded.source,
          models: loaded.models,
        };
      }),
    ),
    profiles: SEED_PROFILES,
  });

  app.get("/v1/model-catalog", async () => body(false));
  app.post("/v1/model-catalog/refresh", async () => body(true));
}
