import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentParaphrasedMessage } from "./AgentParaphrasedMessage";

describe("AgentParaphrasedMessage", () => {
  it("renders paraphrased body, raw transcript collapsed by default", () => {
    render(<AgentParaphrasedMessage body="I asked the user two questions." rawAgentText="Two questions to start: ..." whyRationale="step instructions said..." />);
    expect(screen.getByText(/I asked the user two questions\./)).toBeInTheDocument();
    expect(screen.queryByText(/Two questions to start/)).not.toBeInTheDocument();
  });

  it("reveals raw transcript on toggle", () => {
    render(<AgentParaphrasedMessage body="paraphrase" rawAgentText="RAW TRANSCRIPT HERE" />);
    fireEvent.click(screen.getByText(/raw agent transcript/i));
    expect(screen.getByText(/RAW TRANSCRIPT HERE/)).toBeInTheDocument();
  });

  it("reveals why rationale on toggle", () => {
    render(<AgentParaphrasedMessage body="paraphrase" whyRationale="because the schema required it" />);
    expect(screen.queryByText(/because the schema required it/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/Why\?/));
    expect(screen.getByText(/because the schema required it/)).toBeInTheDocument();
  });

  it("renders no toggles when neither rawAgentText nor whyRationale provided", () => {
    render(<AgentParaphrasedMessage body="just a paraphrase" />);
    expect(screen.queryByText(/raw agent transcript/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Why\?/)).not.toBeInTheDocument();
  });
});
