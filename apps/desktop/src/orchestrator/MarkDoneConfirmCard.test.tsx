import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkDoneConfirmCard } from "./MarkDoneConfirmCard";

describe("MarkDoneConfirmCard", () => {
  it("renders summary and both action buttons", () => {
    render(<MarkDoneConfirmCard summary="All done." onConfirm={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByText(/All done\./)).toBeInTheDocument();
    expect(screen.getByText(/Confirm done/)).toBeInTheDocument();
    expect(screen.getByText(/Not yet/)).toBeInTheDocument();
  });

  it("calls onConfirm when Confirm done clicked", () => {
    const onConfirm = vi.fn();
    render(<MarkDoneConfirmCard summary="x" onConfirm={onConfirm} onDecline={vi.fn()} />);
    fireEvent.click(screen.getByText(/Confirm done/));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onDecline when Not yet clicked", () => {
    const onDecline = vi.fn();
    render(<MarkDoneConfirmCard summary="x" onConfirm={vi.fn()} onDecline={onDecline} />);
    fireEvent.click(screen.getByText(/Not yet/));
    expect(onDecline).toHaveBeenCalledTimes(1);
  });
});
