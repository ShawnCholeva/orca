import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  AdapterExecutionModeConfig,
  validateAdapterExecutionModeConfig,
  type AdapterId,
  type DomainEvent,
  type ExecutionMode,
} from "@orca/contracts";
import type { EventBus } from "../events.js";

export const ADAPTER_EXECUTION_MODE_DEFAULTS: Record<AdapterId, AdapterExecutionModeConfig> = {
  "claude-code": {
    adapterId: "claude-code",
    enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
    disabledExecutionModes: [
      {
        mode: "one_shot",
        reason: "post 2026-06-15 the -p flag bills against API budget; shadow_session uses interactive subscription",
      },
    ],
  },
  codex: {
    adapterId: "codex",
    enabledExecutionModes: [{ mode: "shadow_session", preferred: true }],
    disabledExecutionModes: [
      { mode: "one_shot", reason: "Codex orchestration uses interactive shadow sessions, not OpenAI API keys" },
    ],
  },
};

interface Row {
  adapter_id: string;
  enabled_modes_json: string;
  disabled_modes_json: string;
  updated_at: string;
  updated_by: string | null;
}

export function getAdapterExecutionModeConfig(
  db: Database.Database,
  adapterId: string
): AdapterExecutionModeConfig | null {
  const row = db
    .prepare(
      "SELECT adapter_id, enabled_modes_json, disabled_modes_json, updated_at, updated_by FROM adapter_execution_modes WHERE adapter_id=?"
    )
    .get(adapterId) as Row | undefined;
  if (!row) return null;
  return {
    adapterId: row.adapter_id as AdapterExecutionModeConfig["adapterId"],
    enabledExecutionModes: JSON.parse(row.enabled_modes_json),
    disabledExecutionModes: JSON.parse(row.disabled_modes_json),
  };
}

export function listAdapterExecutionModeConfigs(
  db: Database.Database
): AdapterExecutionModeConfig[] {
  const rows = db
    .prepare(
      "SELECT adapter_id, enabled_modes_json, disabled_modes_json, updated_at, updated_by FROM adapter_execution_modes ORDER BY adapter_id"
    )
    .all() as Row[];
  return rows.map((row) => ({
    adapterId: row.adapter_id as AdapterExecutionModeConfig["adapterId"],
    enabledExecutionModes: JSON.parse(row.enabled_modes_json),
    disabledExecutionModes: JSON.parse(row.disabled_modes_json),
  }));
}

export interface UpsertOptions {
  bus?: EventBus;
}

export function upsertAdapterExecutionModeConfig(
  db: Database.Database,
  now: () => string,
  config: AdapterExecutionModeConfig,
  supportedModes: ExecutionMode[],
  updatedBy: string,
  options: UpsertOptions = {}
): AdapterExecutionModeConfig {
  const validation = validateAdapterExecutionModeConfig(config, supportedModes);
  if (!validation.ok) throw new Error(validation.reason);

  const ts = now();
  let publishedEvent: DomainEvent | null = null;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO adapter_execution_modes
         (adapter_id, enabled_modes_json, disabled_modes_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(adapter_id) DO UPDATE SET
         enabled_modes_json=excluded.enabled_modes_json,
         disabled_modes_json=excluded.disabled_modes_json,
         updated_at=excluded.updated_at,
         updated_by=excluded.updated_by`
    ).run(
      config.adapterId,
      JSON.stringify(config.enabledExecutionModes),
      JSON.stringify(config.disabledExecutionModes),
      ts,
      updatedBy
    );

    if (options.bus) {
      const eventId = randomUUID();
      const payload = {
        adapterId: config.adapterId,
        enabledExecutionModes: config.enabledExecutionModes,
        disabledExecutionModes: config.disabledExecutionModes,
        updatedBy,
      };
      const result = db.prepare(
        "INSERT INTO events (id, type, goal_id, payload, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(eventId, "adapter.execution_modes.changed", null, JSON.stringify(payload), ts);
      publishedEvent = {
        seq: Number(result.lastInsertRowid),
        id: eventId,
        type: "adapter.execution_modes.changed",
        goalId: null,
        payload,
        createdAt: ts,
      };
    }
  })();

  if (publishedEvent && options.bus) {
    options.bus.publish(publishedEvent);
  }

  return config;
}

export function seedAdapterExecutionModes(
  db: Database.Database,
  now: () => string,
  supportedByAdapter: Record<string, ExecutionMode[]>
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO adapter_execution_modes
       (adapter_id, enabled_modes_json, disabled_modes_json, updated_at, updated_by)
     VALUES (?, ?, ?, ?, 'system_seed')`
  );
  const select = db.prepare(
    "SELECT enabled_modes_json, disabled_modes_json, updated_by FROM adapter_execution_modes WHERE adapter_id = ?"
  );
  const updateSystemSeed = db.prepare(
    "UPDATE adapter_execution_modes SET enabled_modes_json = ?, disabled_modes_json = ?, updated_at = ? WHERE adapter_id = ? AND updated_by = 'system_seed'"
  );
  for (const [adapterId, defaults] of Object.entries(ADAPTER_EXECUTION_MODE_DEFAULTS)) {
    const supported = supportedByAdapter[adapterId];
    if (!supported) continue;
    const validation = validateAdapterExecutionModeConfig(defaults, supported);
    if (!validation.ok) {
      throw new Error(`seed defaults invalid for adapter ${adapterId}: ${validation.reason}`);
    }
    insert.run(
      defaults.adapterId,
      JSON.stringify(defaults.enabledExecutionModes),
      JSON.stringify(defaults.disabledExecutionModes),
      now()
    );
    const row = select.get(defaults.adapterId) as
      | { enabled_modes_json: string; disabled_modes_json: string; updated_by: string | null }
      | undefined;
    const enabledJson = JSON.stringify(defaults.enabledExecutionModes);
    const disabledJson = JSON.stringify(defaults.disabledExecutionModes);
    if (
      row?.updated_by === "system_seed" &&
      (row.enabled_modes_json !== enabledJson || row.disabled_modes_json !== disabledJson)
    ) {
      updateSystemSeed.run(enabledJson, disabledJson, now(), defaults.adapterId);
    }
  }
}
