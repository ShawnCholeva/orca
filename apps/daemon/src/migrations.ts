import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const SUGGESTED_ORCHESTRATION_MIGRATION = "0008_suggested_orchestration.sql";
const WORKFLOW_RECOMMENDATION_TYPES_MIGRATION =
  "0011_workflow_recommendation_types.sql";

export const migrationFiles = [
  "0001_init.sql",
  "0002_workspaces_refinements.sql",
  "0004_sessions.sql",
  "0005_memory.sql",
  "0006_context.sql",
  "0007_agents.sql",
  SUGGESTED_ORCHESTRATION_MIGRATION,
  "0009_agent_readiness.sql",
  "0010_workflows.sql",
  WORKFLOW_RECOMMENDATION_TYPES_MIGRATION
] as const;

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

  const discoveredFiles = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const discoveredSet = new Set(discoveredFiles);
  const knownSet = new Set<string>(migrationFiles);
  const knownFiles = migrationFiles.filter((file) => discoveredSet.has(file));
  const extraFiles = discoveredFiles.filter((file) => !knownSet.has(file));
  const files = [...knownFiles, ...extraFiles];

  const applied: string[] = [];

  const insertMigration = db.prepare(
    "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)"
  );

  for (const file of files) {
    if (alreadyApplied.has(file)) continue;

    const now = new Date().toISOString();

    if (
      file === SUGGESTED_ORCHESTRATION_MIGRATION &&
      suggestedOrchestrationSchemaExists(db)
    ) {
      insertMigration.run(file, now);
      applied.push(file);
      continue;
    }

    const sql = readFileSync(path.join(dir, file), "utf-8");

    if (file === WORKFLOW_RECOMMENDATION_TYPES_MIGRATION) {
      const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;
      db.pragma("foreign_keys = OFF");
      try {
        db.transaction(() => {
          db.exec(sql);
          insertMigration.run(file, now);
        })();
      } finally {
        db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
      }
      applied.push(file);
      continue;
    }

    db.transaction(() => {
      db.exec(sql);
      insertMigration.run(file, now);
    })();

    applied.push(file);
  }

  return { applied };
}

function suggestedOrchestrationSchemaExists(db: Database.Database): boolean {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)"
    )
    .all("tasks", "recommendations", "conflicts") as { name: string }[];

  return new Set(rows.map((row) => row.name)).size === 3;
}

// Lazy: in CJS bundles `import.meta.url` is empty, so evaluating this at
// module load would crash. Sidecar callers use a different source.
export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}
