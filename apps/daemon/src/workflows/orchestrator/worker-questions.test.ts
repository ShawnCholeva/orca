import { describe, expect, it } from "vitest";
import type { PendingQuestionItem } from "@orca/contracts";
import { WorkerQuestionStore } from "./worker-questions.js";

const q: PendingQuestionItem = {
  header: "Color", question: "favorite color?", multiSelect: false,
  options: [{ label: "Red", description: "" }],
};
const base = { toolUseId: "toolu_1", sessionId: "s1", goalId: "g1", questions: [q] };

describe("WorkerQuestionStore", () => {
  it("records a question and exposes its data by questionId", () => {
    let n = 0;
    const store = new WorkerQuestionStore(() => `q-${++n}`);
    const { questionId } = store.record(base);
    expect(questionId).toBe("q-1");
    expect(store.get(questionId)).toMatchObject({ sessionId: "s1", goalId: "g1" });
  });

  it("resolveAnswers resolves the deferred once and removes the entry", async () => {
    const store = new WorkerQuestionStore(() => "q-1");
    const { questionId, answered } = store.record(base);
    expect(store.resolveAnswers(questionId, "ANSWER")).toBe(true);
    await expect(answered).resolves.toBe("ANSWER");
    expect(store.get(questionId)).toBeUndefined();
    expect(store.resolveAnswers(questionId, "AGAIN")).toBe(false); // already resolved
  });

  it("dedupes by toolUseId: a repeat fire reuses the same questionId + deferred", () => {
    let n = 0;
    const store = new WorkerQuestionStore(() => `q-${++n}`);
    const first = store.record(base);
    const second = store.record(base); // same toolUseId
    expect(second.questionId).toBe(first.questionId);
    expect(second.answered).toBe(first.answered);
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false); // dedup hit → caller skips re-posting to chat
  });
});
