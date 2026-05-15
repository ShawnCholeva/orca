import { EventEmitter } from "node:events";

import type Database from "better-sqlite3";

import type { DomainEvent, DomainEventType } from "@orca/contracts";

import { getDatabase } from "./db.js";

type EventHandler = (event: DomainEvent) => void;

const EVENT_NAME = "committed";

export class EventBus {
  private readonly emitter = new EventEmitter();

  subscribe(handler: EventHandler): () => void {
    const safeHandler: EventHandler = (event) => {
      try {
        handler(event);
      } catch (error) {
        console.error("EventBus handler threw", error);
      }
    };

    this.emitter.on(EVENT_NAME, safeHandler);

    return () => {
      this.emitter.off(EVENT_NAME, safeHandler);
    };
  }

  publish(event: DomainEvent): void {
    this.emitter.emit(EVENT_NAME, event);
  }
}

export const eventBus = new EventBus();

export function emitCommitted(event: DomainEvent): void {
  eventBus.publish(event);
}

interface EventRow {
  seq: number;
  id: string;
  type: string;
  goal_id: string | null;
  payload: string;
  created_at: string;
}

// Caches the prepared statement; re-prepares on DB swap (test reopen cycles).
let _db: Database.Database | null = null;
let _selectEventsSince: Database.Statement | null = null;

function ensureSelectEventsSince(): Database.Statement {
  const db = getDatabase();
  if (db !== _db) {
    _db = db;
    _selectEventsSince = db.prepare(
      "SELECT seq, id, type, goal_id, payload, created_at FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?"
    );
  }
  return _selectEventsSince!;
}

export function listEventsSince(sinceSeq: number, limit: number): DomainEvent[] {
  const rows = ensureSelectEventsSince().all(sinceSeq, limit) as EventRow[];

  return rows.map((row) => ({
    seq: row.seq,
    id: row.id,
    type: row.type as DomainEventType,
    goalId: row.goal_id,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    createdAt: row.created_at
  }));
}
