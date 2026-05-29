import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InternalThoughtRow } from "./InternalThoughtRow";

describe("InternalThoughtRow", () => {
  it("renders the body", () => {
    render(<InternalThoughtRow body="Starting Intake" kind="step_started" />);
    expect(screen.getByText(/Starting Intake/)).toBeInTheDocument();
  });

  it("toggles Why expander on click", () => {
    render(<InternalThoughtRow body="Starting Intake" kind="step_started" whyRationale="step instructions said so" />);
    expect(screen.queryByText(/step instructions said so/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/Why\?/));
    expect(screen.getByText(/step instructions said so/)).toBeInTheDocument();
  });

  it("renders no Why button when no rationale", () => {
    render(<InternalThoughtRow body="thinking" kind="thinking" />);
    expect(screen.queryByText(/Why\?/)).not.toBeInTheDocument();
  });
});
