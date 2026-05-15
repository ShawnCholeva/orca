import path from "node:path";
import Database from "better-sqlite3";

import type { Config } from "./config.js";

let database: Database.Database | null = null;

export function openDatabase(config: Config): Database.Database {
  if (database !== null) {
    return database;
  }

  const databasePath = path.join(config.dataDir, "orca.db");
  const db = new Database(databasePath);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  database = db;

  return db;
}

export function getDatabase(): Database.Database {
  if (database === null) {
    throw new Error("Database has not been opened");
  }

  return database;
}

export function closeDatabase(): void {
  if (database === null) {
    return;
  }

  database.close();
  database = null;
}
