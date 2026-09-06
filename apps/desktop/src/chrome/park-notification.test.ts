import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunSummary } from "@orca/contracts";
import { appOutOfSight, newlyWaiting, notifyParked } from "./park-notification";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));

const w = (sinceMs: number): RunSummary["awaitingYou"] => ({ count: 1, sinceMs, sourceKind: "question_pending" });

describe("newlyWaiting", () => {
  it("names only the goals that just started waiting", () => {
    const prev = new Map([["g-old", w(1000)]]);
    const next = new Map([["g-old", w(2000)], ["g-new", w(10)]]);
    expect(newlyWaiting(prev, next)).toEqual(["g-new"]);
    // A goal that keeps waiting is not news, and one that stopped is not either.
    expect(newlyWaiting(next, prev)).toEqual([]);
  });
});

describe("appOutOfSight", () => {
  it("is true when hidden, or visible but behind another window", () => {
    expect(appOutOfSight({ visibilityState: "hidden", hasFocus: () => true } as unknown as Document)).toBe(true);
    expect(appOutOfSight({ visibilityState: "visible", hasFocus: () => false } as unknown as Document)).toBe(true);
    expect(appOutOfSight({ visibilityState: "visible", hasFocus: () => true } as unknown as Document)).toBe(false);
  });
});

describe("notifyParked (browser)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("sends through the Web Notification API once permission is granted", async () => {
    const ctor = vi.fn();
    const Fake = Object.assign(function (this: unknown, ...args: unknown[]) { ctor(...args); }, {
      permission: "default" as NotificationPermission,
      requestPermission: vi.fn(async () => { Fake.permission = "granted"; return "granted" as NotificationPermission; }),
    });
    vi.stubGlobal("Notification", Fake);
    await notifyParked("Add a Kelvin conversion", "Waiting on you · a question from the agent");
    expect(Fake.requestPermission).toHaveBeenCalledTimes(1);
    expect(ctor).toHaveBeenCalledWith("Add a Kelvin conversion", { body: "Waiting on you · a question from the agent" });
  });

  it("stays silent when permission was denied", async () => {
    const ctor = vi.fn();
    const Fake = Object.assign(function (this: unknown, ...args: unknown[]) { ctor(...args); }, {
      permission: "denied" as NotificationPermission,
      requestPermission: vi.fn(async () => "denied" as NotificationPermission),
    });
    vi.stubGlobal("Notification", Fake);
    await notifyParked("x", "y");
    expect(Fake.requestPermission).not.toHaveBeenCalled();
    expect(ctor).not.toHaveBeenCalled();
  });
});
