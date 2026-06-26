import { describe, expect, it } from "vitest";
import type { PendingQuestionItem } from "@orca/contracts";
import { validateAnswers, assembleAnswerReason, assembleFreeTextReason } from "./worker-answer-format.js";

const single: PendingQuestionItem = {
  header: "Color", question: "favorite color?", multiSelect: false,
  options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }],
};
const multi: PendingQuestionItem = {
  header: "Feat", question: "which features?", multiSelect: true,
  options: [{ label: "A", description: "" }, { label: "B", description: "" }],
};

describe("validateAnswers", () => {
  it("accepts a valid single-select answer", () => {
    expect(validateAnswers([single], [{ questionIndex: 0, selectedLabels: ["Red"] }])).toBeNull();
  });
  it("rejects a missing answer for a question", () => {
    expect(validateAnswers([single, multi], [{ questionIndex: 0, selectedLabels: ["Red"] }])).toBe("incomplete_answers");
  });
  it("rejects an out-of-range questionIndex", () => {
    expect(validateAnswers([single], [{ questionIndex: 1, selectedLabels: ["Red"] }])).toBe("question_index_out_of_range");
  });
  it("rejects a label not in the options", () => {
    expect(validateAnswers([single], [{ questionIndex: 0, selectedLabels: ["Green"] }])).toBe("unknown_label");
  });
  it("rejects >1 label on a single-select question", () => {
    expect(validateAnswers([single], [{ questionIndex: 0, selectedLabels: ["Red", "Blue"] }])).toBe("too_many_labels");
  });
  it("accepts multiple labels on a multiSelect question", () => {
    expect(validateAnswers([multi], [{ questionIndex: 0, selectedLabels: ["A", "B"] }])).toBeNull();
  });
});

describe("assembleAnswerReason", () => {
  it("produces a deterministic, answer-bearing deny reason", () => {
    const reason = assembleAnswerReason(
      [single, multi],
      [{ questionIndex: 0, selectedLabels: ["Red"] }, { questionIndex: 1, selectedLabels: ["A", "B"] }],
    );
    expect(reason).toContain("Q1 'Color': Red");
    expect(reason).toContain("Q2 'Feat': A, B");
    expect(reason).toContain("Do not call AskUserQuestion again");
  });
});

describe("assembleFreeTextReason", () => {
  it("wraps the user's words as a final, answer-bearing deny reason", () => {
    expect(assembleFreeTextReason("a dedicated workspaces tab")).toBe(
      "User answered via Orca chat with a custom response: \"a dedicated workspaces tab\". " +
        "Treat the AskUserQuestion as fully answered with this response and continue. " +
        "Do not call AskUserQuestion again.",
    );
  });
});
