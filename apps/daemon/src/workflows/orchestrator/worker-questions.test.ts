import { describe, expect, it } from "vitest";
import { WorkerQuestionStore } from "./worker-questions.js";

describe("WorkerQuestionStore", () => {
  it("mints a fresh questionId per new toolUseId", () => {
    let n = 0;
    const store = new WorkerQuestionStore(() => `q-${++n}`);
    expect(store.record({ toolUseId: "toolu_1" })).toEqual({ questionId: "q-1", isNew: true });
    expect(store.record({ toolUseId: "toolu_2" })).toEqual({ questionId: "q-2", isNew: true });
  });

  it("dedupes by toolUseId: a repeat fire reuses the same questionId and reports isNew=false", () => {
    let n = 0;
    const store = new WorkerQuestionStore(() => `q-${++n}`);
    const first = store.record({ toolUseId: "toolu_1" });
    const second = store.record({ toolUseId: "toolu_1" });
    expect(first).toEqual({ questionId: "q-1", isNew: true });
    expect(second).toEqual({ questionId: "q-1", isNew: false });
  });
});
