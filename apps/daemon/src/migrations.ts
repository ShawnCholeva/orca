import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const SUGGESTED_ORCHESTRATION_MIGRATION = "0008_suggested_orchestration.sql";
const WORKFLOW_RECOMMENDATION_TYPES_MIGRATION =
  "0011_workflow_recommendation_types.sql";
const ORCHESTRATION_TRANSPORT_MIGRATION = "0012_orchestration_transport.sql";
const ORCHESTRATOR_MESSAGES_MIGRATION = "0013_orchestrator_messages.sql";
const WORKFLOW_STEP_RUNS_OPERATOR_SELECTION_MIGRATION =
  "0014_workflow_step_runs_operator_selection.sql";

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
  WORKFLOW_RECOMMENDATION_TYPES_MIGRATION,
  ORCHESTRATION_TRANSPORT_MIGRATION,
  ORCHESTRATOR_MESSAGES_MIGRATION,
  WORKFLOW_STEP_RUNS_OPERATOR_SELECTION_MIGRATION,
  "0015_adapter_execution_modes.sql",
  "0016_workflow_step_runs_revise_attempts.sql",
  "0017_orchestrator_messages_chat_kinds.sql",
  "0018_workflow_step_runs_crash_retries.sql",
  "0019_orchestrator_messages_pending_question.sql",
  "0020_drop_removed_provider_execution_modes.sql",
  "0021_workflow_template_scope_graph.sql",
  "0022_workflow_step_result.sql",
  "0023_worker_permission_mode.sql",
  "0024_activities.sql",
  "0025_activity_step_result.sql",
  "0026_app_settings.sql",
  "0027_step_run_pending_completion.sql",
  "0028_step_revision_signals.sql",
  "0029_workflow_graph_cursor.sql",
  "0030_provider_recovery.sql",
  "0031_workflow_ledger.sql",
  "0032_gate_decision_ledger_version.sql",
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
