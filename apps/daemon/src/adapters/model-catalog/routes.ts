import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { AdapterId } from "@orca/contracts";
import { SEED_PROFILES } from "./profiles.js";
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
        const loaded = await deps.load(deps.db, adapterId, { force });
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
