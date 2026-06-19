import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { WorkerQuestionAnswered } from "./WorkerQuestionAnswered";
import type { PendingQuestion } from "@orca/contracts";

const base: PendingQuestion = {
  questionId: "q1", toolUseId: "t1", source: "worker",
  questions: [{
    header: "Layout", question: "Which layout?", multiSelect: false,
    options: [{ label: "Top nav", description: "top" }, { label: "Sidebar", description: "side" }],
  }],
};

describe("WorkerQuestionAnswered", () => {
  it("marks the chosen option", () => {
    render(<WorkerQuestionAnswered pending={{ ...base, answer: { answers: [{ questionIndex: 0, selectedLabels: ["Top nav"] }] } }} />);
    expect(screen.getByText(/✓\s*Top nav/)).toBeInTheDocument();
  });

  it("shows inline free-text", () => {
    render(<WorkerQuestionAnswered pending={{ ...base, answer: { freeText: "do it my way" } }} />);
    expect(screen.getByText("do it my way")).toBeInTheDocument();
  });

  it("shows an answered-in-chat hint for viaChat", () => {
    render(<WorkerQuestionAnswered pending={{ ...base, answer: { viaChat: true } }} />);
    expect(screen.getByText(/answered in chat/i)).toBeInTheDocument();
  });
});
