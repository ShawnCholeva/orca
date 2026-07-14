import { describe, it, expect } from "vitest";
import { quickGoalSkill } from "./quick-goal.js";
import { ValidationError } from "../goals.js";

const ctx = { now: () => new Date().toISOString() };

describe("quickGoalSkill", () => {
  it("returns trimmed title and intent on happy path", () => {
    const result = quickGoalSkill.invoke(
      { title: "  My Goal  ", intent: "  Some desc  " },
      ctx
    );
    expect(result).toEqual({ title: "My Goal", intent: "Some desc" });
  });

  it("rejects missing intent", () => {
    expect(() =>
      quickGoalSkill.invoke({ title: "A goal" }, ctx)
    ).toThrow(ValidationError);
  });

  it("rejects empty intent after trim", () => {
    expect(() =>
      quickGoalSkill.invoke({ title: "A goal", intent: "   " }, ctx)
    ).toThrow(ValidationError);
  });

  it("rejects empty title after trim", () => {
    expect(() =>
      quickGoalSkill.invoke({ title: "   ", intent: "Some desc" }, ctx)
    ).toThrow(ValidationError);
  });

  it("rejects title longer than 200 chars after trim", () => {
    expect(() =>
      quickGoalSkill.invoke({ title: "a".repeat(201), intent: "Some desc" }, ctx)
    ).toThrow(ValidationError);
  });

  it("rejects intent longer than 4000 chars after trim", () => {
    expect(() =>
      quickGoalSkill.invoke({ title: "Valid", intent: "x".repeat(4001) }, ctx)
    ).toThrow(ValidationError);
  });

  it("thrown error is instance of ValidationError", () => {
    let err: unknown;
    try {
      quickGoalSkill.invoke({ title: "" }, ctx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
  });

  it("rejects non-string title (wrong type)", () => {
    expect(() =>
      quickGoalSkill.invoke({ title: 42 } as unknown as { title: string }, ctx)
    ).toThrow(ValidationError);
  });

  it("rejects non-object input", () => {
    expect(() =>
      quickGoalSkill.invoke("not an object" as unknown as { title: string }, ctx)
    ).toThrow(ValidationError);
  });

  it("has no side effects — no DB or bus access", () => {
    // Calling invoke should not throw due to missing DB/bus — it is pure computation.
    const result = quickGoalSkill.invoke({ title: "No side effects", intent: "Some desc" }, ctx);
    expect(result.title).toBe("No side effects");
  });

  it("accepts exactly 200-char title", () => {
    const title = "a".repeat(200);
    const result = quickGoalSkill.invoke({ title, intent: "Some desc" }, ctx);
    expect(result.title).toBe(title);
  });

  it("accepts exactly 4000-char intent", () => {
    const intent = "x".repeat(4000);
    const result = quickGoalSkill.invoke({ title: "Valid", intent }, ctx);
    expect(result.intent).toBe(intent);
  });
});
