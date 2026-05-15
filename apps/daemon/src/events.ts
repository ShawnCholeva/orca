import { EventEmitter } from "node:events";

import type { DomainEvent } from "@orca/contracts";

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
