import { describe, expect, it } from "vitest";
import {
  isParkedOnHuman,
  liveActivityJoin,
  LIVE_ACTIVITY_COLUMNS,
  openQuestionColumn,
  openQuestionSql,
} from "./awaiting-user.js";

/** The three channels, defaulted to "nobody is parked" so each test names its own. */
const park = (over: Partial<Parameters<typeof isParkedOnHuman>[0]> = {}) =>
  isParkedOnHuman({
    activityStatus: null,
    activitySourceKind: null,
    chatReplyPending: false,
    openQuestion: false,
    ...over,
  });

describe("isParkedOnHuman", () => {
  // THREE channels, each covering something the others miss. Every case below is
  // a false negative for at least one of them, which is why the union is the only
  // correct reading — and why the halves are not exported.

  it("catches a park the other two channels miss", () => {
    // The live 39-hour run: awaiting_user was 0 because no orchestrator action had
    // posted a chat reply, while the activity had been parked since the day before.
    expect(park({ activityStatus: "paused_for_input", activitySourceKind: "step_confirmation_pending" })).toBe(true);
  });

  it("catches permission_pending, whose status stays active", () => {
    // openActivity inserts EVERY activity as `active` and only the park paths flip
    // the status, so a worker waiting on tool approval reads as active while
    // genuinely being parked. This is the exception that makes the park half two
    // conditions rather than one.
    expect(park({ activityStatus: "active", activitySourceKind: "permission_pending" })).toBe(true);
  });

  it("catches a chat reply the activity misses", () => {
    // paraphrase_agent_message / answer_user_directly / escalate_to_user only
    // postOrchestratorMessage — they raise no activity, so nothing in `activities`
    // represents "the orchestrator answered and stopped".
    expect(park({ chatReplyPending: true })).toBe(true);
    expect(park({ activityStatus: "active", activitySourceKind: "turn_completed", chatReplyPending: true })).toBe(true);
  });

  it("catches an open question BOTH other channels miss", () => {
    // The watchdog failure: an orchestrator-source ask_user raises no activity, and
    // its awaiting_user flag is cleared by the next action that posts no chat reply
    // — the prompt gate suppressing a duplicate ask does it with no user involved.
    // The question is still on screen and unanswered while both others read false.
    expect(park({ openQuestion: true })).toBe(true);
    expect(park({ activityStatus: "active", activitySourceKind: "tool_use", openQuestion: true })).toBe(true);
  });

  it("is false only when EVERY channel says Orca owes the next move", () => {
    expect(park({ activityStatus: "active", activitySourceKind: "tool_use" })).toBe(false);
    expect(park()).toBe(false);
  });

  it("reads a missing live activity as nobody parked, never as a crash or a default true", () => {
    // A step run with no activity row: the LEFT JOIN yields nulls.
    expect(park({ activityStatus: undefined, activitySourceKind: undefined })).toBe(false);
  });
});

describe("openQuestionSql", () => {
  it("counts only questions that are unanswered, not withdrawn, and on this step run", () => {
    const sql = openQuestionSql("wsr.id");
    expect(sql).toContain("'$.stepRunId') = wsr.id");
    expect(sql).toContain("'$.answer') IS NULL");
    expect(sql).toContain("'$.withdrawn') IS NULL");
  });

  it("is source-agnostic — an orchestrator question counts as much as a worker one", () => {
    // readOpenWorkerQuestion filters source='worker' for its own reasons; this
    // predicate must not, or the mediator's own questions go unseen.
    expect(openQuestionSql("wsr.id")).not.toContain("$.source");
  });

  it("exposes the same predicate as a named column", () => {
    expect(openQuestionColumn("wsr")).toContain("AS open_question");
    expect(openQuestionColumn("wsr")).toContain("wsr.id");
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

  it("selects the columns the park half consumes", () => {
    expect(LIVE_ACTIVITY_COLUMNS).toContain("activity_status");
    expect(LIVE_ACTIVITY_COLUMNS).toContain("activity_source_kind");
  });
});
