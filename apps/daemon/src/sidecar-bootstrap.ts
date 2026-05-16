// Helpers for the SEA-bundled sidecar binary. In a normal `node dist/index.js`
// run, sidecarMigrationsDir() returns null and callers use the on-disk path.

import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

interface SeaModule {
  isSea(): boolean;
  getAsset(key: string): ArrayBuffer;
  getAssetKeys?: () => string[];
}

function loadSea(): SeaModule | null {
  try {
    const req = createRequire(process.execPath);
    return req("node:sea") as SeaModule;
  } catch {
    return null;
  }
}

const sea = loadSea();
const isSidecar = sea?.isSea() ?? false;

function extractMigrations(seaMod: SeaModule): string {
  const keys = seaMod.getAssetKeys?.() ?? [];
  const migrationKeys = keys.filter(
    (k) => k.startsWith("migrations/") && k.endsWith(".sql")
  );
  if (migrationKeys.length === 0) {
    throw new Error("SEA bundle is missing migration assets");
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-migrations-"));
  for (const key of migrationKeys) {
    const buf = Buffer.from(seaMod.getAsset(key));
    const name = key.substring("migrations/".length);
    writeFileSync(path.join(dir, name), buf);
  }
  return dir;
}

let migrationsDirCache: string | null = null;

export function sidecarMigrationsDir(): string | null {
  if (!isSidecar || !sea) return null;
  if (migrationsDirCache) return migrationsDirCache;
  migrationsDirCache = extractMigrations(sea);
  return migrationsDirCache;
}
