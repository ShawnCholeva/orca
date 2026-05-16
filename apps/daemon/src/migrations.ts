import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export function runMigrations(
  db: Database.Database,
  dir: string
): { applied: string[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      applied_at  TEXT NOT NULL
    )
  `);

  const alreadyApplied = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map(
      (r) => r.name
    )
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied: string[] = [];

  const insertMigration = db.prepare(
    "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)"
  );

  for (const file of files) {
    if (alreadyApplied.has(file)) continue;

    const sql = readFileSync(path.join(dir, file), "utf-8");
    const now = new Date().toISOString();

    db.transaction(() => {
      db.exec(sql);
      insertMigration.run(file, now);
    })();

    applied.push(file);
  }

  return { applied };
}

// Lazy: in CJS bundles `import.meta.url` is empty, so evaluating this at
// module load would crash. Sidecar callers use a different source.
export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}
