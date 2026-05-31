import { describe, expect, it } from "vitest";
import { WorkerQuestionStore } from "./worker-questions.js";

describe("WorkerQuestionStore", () => {
  it("records and resolves a pending question by id", () => {
    const store = new WorkerQuestionStore(() => "q-1");
    const id = store.record({ sessionId: "s1", optionCount: 3 });
    expect(id).toBe("q-1");
    expect(store.get(id)).toMatchObject({ sessionId: "s1", optionCount: 3 });
    store.resolve(id);
    expect(store.get(id)).toBeUndefined();
  });
});
