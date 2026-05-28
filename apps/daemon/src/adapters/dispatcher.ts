import type Database from "better-sqlite3";
import type { ExecutionMode } from "@orca/contracts";
import { getAdapterExecutionModeConfig } from "./execution-modes.js";

export interface ResolvedMode {
  adapterId: string;
  mode: ExecutionMode;
  fallbacks: ExecutionMode[];
}

export interface AdapterDispatcherDeps {
  db: Database.Database;
}

export class AdapterDispatcher {
  constructor(private readonly deps: AdapterDispatcherDeps) {}

  resolveMode(adapterId: string): ResolvedMode {
    const cfg = getAdapterExecutionModeConfig(this.deps.db, adapterId);
    if (!cfg) throw new Error(`no execution-mode config for adapter ${adapterId}`);
    const preferred = cfg.enabledExecutionModes.find((e) => e.preferred === true);
    if (!preferred) throw new Error(`adapter ${adapterId} has no preferred enabled mode`);
    const fallbacks = cfg.enabledExecutionModes.filter((e) => e !== preferred).map((e) => e.mode);
    return { adapterId, mode: preferred.mode, fallbacks };
  }
}
