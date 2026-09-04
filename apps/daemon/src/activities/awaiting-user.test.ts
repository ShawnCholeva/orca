import { describe, expect, it } from "vitest";
import {
  isAwaitingUser,
  isParkedOnActivity,
  liveActivityJoin,
  LIVE_ACTIVITY_COLUMNS,
} from "./awaiting-user.js";

describe("isParkedOnActivity", () => {
  it("is true for a parked activity", () => {
    expect(isParkedOnActivity("paused_for_input", "step_confirmation_pending")).toBe(true);
  });

  it("is true for permission_pending even though its status stays active", () => {
    // openActivity inserts EVERY activity as `active` and only the park paths flip
    // the status, so a worker waiting on tool approval reads as active while
    // genuinely being parked. This is the exception that makes it two conditions.
    expect(isParkedOnActivity("active", "permission_pending")).toBe(true);
  });

  it("is false while the agent has the turn", () => {
    expect(isParkedOnActivity("active", "tool_use")).toBe(false);
    expect(isParkedOnActivity("active", "turn_completed")).toBe(false);
  });

  it("is false when there is no live activity at all", () => {
    // A step run with no activity row: the LEFT JOIN yields nulls, and "nobody is
    // parked" is the right reading — never a crash and never a default of true.
    expect(isParkedOnActivity(null, null)).toBe(false);
    expect(isParkedOnActivity(undefined, undefined)).toBe(false);
  });
});

describe("isAwaitingUser", () => {
  // The two sources cover different halves and NEITHER is complete alone. Each
  // case below is a false negative for one of them, which is why the union is the
  // only correct reading.

  it("catches a park the chat-reply flag misses", () => {
    // The live 39-hour run: awaiting_user was 0 because no orchestrator action had
    // posted a chat reply, while the activity had been parked since the day before.
    expect(isAwaitingUser("paused_for_input", "step_confirmation_pending", false)).toBe(true);
  });

  it("catches a chat reply the activity misses", () => {
    // paraphrase_agent_message / answer_user_directly / escalate_to_user only
    // postOrchestratorMessage — they raise no activity, so nothing in `activities`
    // represents "the orchestrator answered and stopped".
    expect(isAwaitingUser(null, null, true)).toBe(true);
    expect(isAwaitingUser("active", "turn_completed", true)).toBe(true);
  });

  it("is false only when neither source says the human owes the next move", () => {
    expect(isAwaitingUser("active", "tool_use", false)).toBe(false);
    expect(isAwaitingUser(null, null, false)).toBe(false);
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

  it("selects the two columns the park predicate consumes", () => {
    expect(LIVE_ACTIVITY_COLUMNS).toContain("activity_status");
    expect(LIVE_ACTIVITY_COLUMNS).toContain("activity_source_kind");
  });
});
