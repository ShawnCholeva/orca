import type Database from "better-sqlite3";
import { SupervisionMode } from "@orca/contracts";

const SUPERVISION_KEY = "supervision_mode";

export function getSupervisionMode(db: Database.Database): SupervisionMode {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(SUPERVISION_KEY) as { value: string } | undefined;
  if (row === undefined) return "supervised";
  const parsed = SupervisionMode.safeParse(row.value);
  return parsed.success ? parsed.data : "supervised";
}

export function setSupervisionMode(
  db: Database.Database,
  mode: SupervisionMode,
  now: string
): void {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(SUPERVISION_KEY, mode, now);
}
