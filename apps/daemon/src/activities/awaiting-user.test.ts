import { describe, expect, it } from "vitest";
import { isAwaitingUser, liveActivityJoin, LIVE_ACTIVITY_COLUMNS } from "./awaiting-user.js";

describe("isAwaitingUser", () => {
  it("is true for a parked activity", () => {
    expect(isAwaitingUser("paused_for_input", "step_confirmation_pending")).toBe(true);
  });

  it("is true for permission_pending even though its status stays active", () => {
    // openActivity inserts EVERY activity as `active` and only the park paths flip
    // the status, so a worker waiting on tool approval reads as active while
    // genuinely being parked. This is the exception that makes it two conditions.
    expect(isAwaitingUser("active", "permission_pending")).toBe(true);
  });

  it("is false while the agent has the turn", () => {
    expect(isAwaitingUser("active", "tool_use")).toBe(false);
    expect(isAwaitingUser("active", "turn_completed")).toBe(false);
  });

  it("is false when there is no live activity at all", () => {
    // A step run with no activity row: the LEFT JOIN yields nulls, and "nobody is
    // parked" is the right reading — never a crash and never a default of true.
    expect(isAwaitingUser(null, null)).toBe(false);
    expect(isAwaitingUser(undefined, undefined)).toBe(false);
  });
});

describe("liveActivityJoin", () => {
  it("matches only live activities, so a completed one cannot resurrect a park", () => {
    const sql = liveActivityJoin("wsr");
    expect(sql).toContain("a.step_run_id = wsr.id");
    expect(sql).toContain("'active', 'paused_for_input'");
    expect(sql).not.toContain("completed");
    expect(sql).not.toContain("expired");
  });

  it("selects the two columns the predicate consumes", () => {
    expect(LIVE_ACTIVITY_COLUMNS).toContain("activity_status");
    expect(LIVE_ACTIVITY_COLUMNS).toContain("activity_source_kind");
  });
});
