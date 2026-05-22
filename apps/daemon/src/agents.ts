import type Database from "better-sqlite3";
import { Agent, AgentReadinessReport, type AgentReadinessReport as Report } from "@orca/contracts";

interface AgentRow {
  id: string;
  name: string;
  short_label: string;
  description: string;
  swatch: string;
  recommended: number;
  connected: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  readiness_status: string | null;
  readiness_checked_at: string | null;
  readiness_detail: string | null;
  readiness_repair: string | null;
  readiness_version: string | null;
}

function rowToAgent(row: AgentRow): Agent {
  let readiness: Agent["readiness"] = null;
  if (row.readiness_status && row.readiness_status !== "unchecked" && row.readiness_checked_at) {
    try {
      readiness = AgentReadinessReport.parse({
        agentId: row.id,
        status: row.readiness_status,
        steps: row.readiness_detail ? JSON.parse(row.readiness_detail) : [],
        repair: row.readiness_repair ? JSON.parse(row.readiness_repair) : undefined,
        checkedAt: row.readiness_checked_at,
        version: row.readiness_version ?? undefined,
      });
    } catch {
      // Partial/corrupt persisted readiness - treat as unchecked rather than crash listAgents.
      readiness = null;
    }
  }

  return Agent.parse({
    id: row.id,
    name: row.name,
    shortLabel: row.short_label,
    description: row.description,
    swatch: row.swatch,
    recommended: row.recommended === 1,
    connected: row.connected === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readiness,
  });
}

interface SeedAgent {
  id: string;
  name: string;
  short_label: string;
  description: string;
  swatch: string;
  recommended: 0 | 1;
  sort_order: number;
}

const SEED_AGENTS: SeedAgent[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    short_label: "Anthropic · CLI",
    description:
      "Deep planning and long-context reasoning. Strong default for architects and reviewers.",
    swatch: "#D97757",
    recommended: 1,
    sort_order: 10,
  },
  {
    id: "codex",
    name: "Codex CLI",
    short_label: "OpenAI · CLI",
    description: "Fast tool-use loops. Reliable for implementation and bounded refactors.",
    swatch: "#10A37F",
    recommended: 1,
    sort_order: 20,
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    short_label: "Google · CLI",
    description: "Massive context window. Good for repo-wide search, indexing, and Q/A.",
    swatch: "#4F8AFE",
    recommended: 1,
    sort_order: 30,
  },
  {
    id: "opencode",
    name: "OpenCode",
    short_label: "Open source · CLI",
    description:
      "Self-hosted runner. Bring your own model. Great for local-only sessions.",
    swatch: "#A78BFA",
    recommended: 0,
    sort_order: 40,
  },
];

export class AgentNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Agent not found: ${id}`);
    this.name = "AgentNotFoundError";
  }
}

export function seedAgents(db: Database.Database, now: string = new Date().toISOString()): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO agents
      (id, name, short_label, description, swatch, recommended, connected, sort_order, created_at, updated_at)
     VALUES (@id, @name, @short_label, @description, @swatch, @recommended, 0, @sort_order, @now, @now)`,
  );

  const updateMeta = db.prepare(
    `UPDATE agents
       SET name = @name,
           short_label = @short_label,
           description = @description,
           swatch = @swatch,
           recommended = @recommended,
           sort_order = @sort_order,
           updated_at = @now
     WHERE id = @id`,
  );

  // Drop any agents that were seeded by previous releases but are no longer
  // part of the official catalogue. Uses a parameterised IN-clause so the
  // query matches whatever ids are currently shipped.
  const placeholders = SEED_AGENTS.map(() => "?").join(", ");
  const removeObsolete = db.prepare(
    `DELETE FROM agents WHERE id NOT IN (${placeholders})`,
  );

  db.transaction(() => {
    for (const a of SEED_AGENTS) {
      insert.run({ ...a, now });
      // Keep built-in metadata in sync if it changes between releases; do not
      // touch the user's `connected` choice.
      updateMeta.run({ ...a, now });
    }
    removeObsolete.run(...SEED_AGENTS.map((a) => a.id));
  })();
}

export function listAgents(db: Database.Database): Agent[] {
  const rows = db
    .prepare(
      `SELECT id, name, short_label, description, swatch, recommended, connected, sort_order,
              created_at, updated_at,
              readiness_status, readiness_checked_at, readiness_detail, readiness_repair, readiness_version
         FROM agents
        ORDER BY sort_order ASC, name ASC`,
    )
    .all() as AgentRow[];
  return rows.map(rowToAgent);
}

export function setAgentConnected(
  db: Database.Database,
  id: string,
  connected: boolean,
  now: string = new Date().toISOString(),
): Agent {
  const row = db
    .prepare(`SELECT id FROM agents WHERE id = ?`)
    .get(id) as { id: string } | undefined;
  if (!row) throw new AgentNotFoundError(id);

  db.prepare(
    `UPDATE agents SET connected = ?, updated_at = ? WHERE id = ?`,
  ).run(connected ? 1 : 0, now, id);

  const updated = db
    .prepare(
      `SELECT id, name, short_label, description, swatch, recommended, connected, sort_order,
              created_at, updated_at,
              readiness_status, readiness_checked_at, readiness_detail, readiness_repair, readiness_version
         FROM agents WHERE id = ?`,
    )
    .get(id) as AgentRow;
  return rowToAgent(updated);
}

export function hasConnectedAgents(db: Database.Database): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM agents WHERE connected = 1`)
    .get() as { n: number };
  return row.n > 0;
}

export function persistReadiness(
  db: Database.Database,
  report: Report,
  now: string = new Date().toISOString(),
): void {
  db.prepare(
    `UPDATE agents
        SET readiness_status     = @status,
            readiness_checked_at = @checkedAt,
            readiness_detail     = @detail,
            readiness_repair     = @repair,
            readiness_version    = @version,
            updated_at           = @now
      WHERE id = @id`,
  ).run({
    status: report.status,
    checkedAt: report.checkedAt,
    detail: JSON.stringify(report.steps),
    repair: report.repair ? JSON.stringify(report.repair) : null,
    version: report.version ?? null,
    now,
    id: report.agentId,
  });
}
