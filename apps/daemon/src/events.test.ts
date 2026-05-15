import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "@orca/contracts";

import { EventBus } from "./events.js";

function createEvent(seq: number): DomainEvent {
  return {
    seq,
    id: `event-${seq}`,
    type: "goal.created",
    goalId: `goal-${seq}`,
    payload: { title: `Goal ${seq}`, description: "" },
    createdAt: new Date().toISOString()
  };
}

describe("EventBus", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers published events to subscribers in order", () => {
    const bus = new EventBus();
    const seen: number[] = [];

    bus.subscribe((event) => {
      seen.push(event.seq);
    });

    bus.publish(createEvent(1));
    bus.publish(createEvent(2));
    bus.publish(createEvent(3));

    expect(seen).toEqual([1, 2, 3]);
  });

  it("continues dispatch when one subscriber throws", () => {
    const bus = new EventBus();
    const receiver = vi.fn<(event: DomainEvent) => void>();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(receiver);

    const event = createEvent(1);
    expect(() => bus.publish(event)).not.toThrow();

    expect(receiver).toHaveBeenCalledTimes(1);
    expect(receiver).toHaveBeenCalledWith(event);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("stops delivering events after unsubscribe", () => {
    const bus = new EventBus();
    const receiver = vi.fn<(event: DomainEvent) => void>();

    const unsubscribe = bus.subscribe(receiver);
    bus.publish(createEvent(1));
    unsubscribe();
    bus.publish(createEvent(2));

    expect(receiver).toHaveBeenCalledTimes(1);
    expect(receiver).toHaveBeenCalledWith(expect.objectContaining({ seq: 1 }));
  });
});
