import type Database from "better-sqlite3";
import type { AdapterId } from "@orca/contracts";
import { SEED_CATALOG } from "./seed.js";
import type { CatalogModel } from "./types.js";

export type CatalogSource = "extracted" | "cached" | "seed";

export interface LoadCatalogDeps {
  /** The installed CLI's version string, or null when it cannot be read. */
  version: () => Promise<string | null>;
  extract: () => Promise<CatalogModel[]>;
  now: () => string;
}

export interface LoadedCatalog {
  models: CatalogModel[];
  source: CatalogSource;
  adapterVersion: string | null;
}

export function readCachedCatalog(
  db: Database.Database,
  adapterId: AdapterId,
  version: string,
): CatalogModel[] | null {
  const row = db
    .prepare("SELECT payload_json FROM model_catalog_cache WHERE adapter_id=? AND adapter_version=?")
    .get(adapterId, version) as { payload_json: string } | undefined;
  return row ? (JSON.parse(row.payload_json) as CatalogModel[]) : null;
}

function readNewestCached(db: Database.Database, adapterId: AdapterId): CatalogModel[] | null {
  const row = db
    .prepare("SELECT payload_json FROM model_catalog_cache WHERE adapter_id=? ORDER BY extracted_at DESC LIMIT 1")
    .get(adapterId) as { payload_json: string } | undefined;
  return row ? (JSON.parse(row.payload_json) as CatalogModel[]) : null;
}

/**
 * extracted(this version) -> newest cached -> checked-in seed. The chosen source
 * travels with the models so callers can render staleness instead of presenting
 * a fallback as current.
 */
export async function loadCatalog(
  db: Database.Database,
  adapterId: AdapterId,
  deps: LoadCatalogDeps,
): Promise<LoadedCatalog> {
  const version = await deps.version();

  if (version) {
    const cached = readCachedCatalog(db, adapterId, version);
    if (cached && cached.length > 0) {
      return { models: cached, source: "cached", adapterVersion: version };
    }
    const extracted = await deps.extract();
    if (extracted.length > 0) {
      db.prepare(
        "INSERT OR REPLACE INTO model_catalog_cache (adapter_id, adapter_version, extracted_at, payload_json) VALUES (?,?,?,?)",
      ).run(adapterId, version, deps.now(), JSON.stringify(extracted));
      return { models: extracted, source: "extracted", adapterVersion: version };
    }
  }

  const newest = readNewestCached(db, adapterId);
  if (newest && newest.length > 0) {
    return { models: newest, source: "cached", adapterVersion: version };
  }
  return { models: SEED_CATALOG[adapterId] ?? [], source: "seed", adapterVersion: version };
}
