import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { LearningEvent, type LearningEventPayload } from "@orca/contracts";

export class TemplateNotFoundError extends Error {}

const MAX_PAYLOAD_CHARS = 4096;

interface Row {
  id: string; template_id: string; proposal_id: string | null; step_template_id: string | null;
  event_type: string; template_version: number; payload_json: string; created_at: string;
}

function rowToEvent(r: Row): LearningEvent {
  return LearningEvent.parse({
    id: r.id, templateId: r.template_id, proposalId: r.proposal_id, stepTemplateId: r.step_template_id,
    eventType: r.event_type, templateVersion: r.template_version,
    payload: JSON.parse(r.payload_json) as LearningEventPayload, createdAt: r.created_at,
  });
}

export function recordEvent(db: Database.Database, e: Omit<LearningEvent, "id" | "createdAt">, now: string): void {
  const event = LearningEvent.parse({ ...e, id: randomUUID(), createdAt: now });
  const payloadJson = JSON.stringify(event.payload);
  if (payloadJson.length > MAX_PAYLOAD_CHARS) {
    throw new Error(`learning event payload too large (${payloadJson.length} chars, max ${MAX_PAYLOAD_CHARS})`);
  }
  db.prepare(
    `INSERT INTO learning_events (id, template_id, proposal_id, step_template_id, event_type, template_version, payload_json, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    event.id, event.templateId, event.proposalId, event.stepTemplateId,
    event.eventType, event.templateVersion, payloadJson, event.createdAt,
  );
}

export function listEventsByTemplate(db: Database.Database, templateId: string, limit = 50): LearningEvent[] {
  // Math.floor: a non-integral LIMIT binding throws SqliteError datatype mismatch.
  const clamped = Math.max(1, Math.min(100, Math.floor(Number.isFinite(limit) ? limit : 50)));
  const rows = db.prepare(
    `SELECT * FROM learning_events WHERE template_id = ? ORDER BY seq DESC LIMIT ?`
  ).all(templateId, clamped) as Row[];
  return rows.map(rowToEvent);
}

export function currentTemplateVersion(db: Database.Database, templateId: string): number {
  const row = db.prepare(`SELECT version FROM workflow_templates WHERE id = ?`).get(templateId) as { version: number } | undefined;
  if (!row) throw new TemplateNotFoundError(`template ${templateId} not found`);
  return row.version;
}
