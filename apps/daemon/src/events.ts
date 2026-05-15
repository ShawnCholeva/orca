import { EventEmitter } from "node:events";

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

export function listEventsSince(sinceSeq: number, limit: number): DomainEvent[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      "SELECT seq, id, type, goal_id, payload, created_at FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?"
    )
    .all(sinceSeq, limit) as EventRow[];

  return rows.map((row) => ({
    seq: row.seq,
    id: row.id,
    type: row.type as DomainEventType,
    goalId: row.goal_id,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    createdAt: row.created_at
  }));
}
