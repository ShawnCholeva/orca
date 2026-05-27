import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmptyGoalsView } from "./EmptyGoalsView";

describe("EmptyGoalsView", () => {
  it("renders the hero heading and create action", () => {
    render(<EmptyGoalsView onCreate={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: /start with a goal/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /create your first goal/i }),
    ).toBeInTheDocument();
  });

  it("fires onCreate when the button is clicked", () => {
    const onCreate = vi.fn();
    render(<EmptyGoalsView onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: /create your first goal/i }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("disables the button and blocks onCreate when disabled", () => {
    const onCreate = vi.fn();
    render(<EmptyGoalsView onCreate={onCreate} disabled />);
    const btn = screen.getByRole("button", { name: /create your first goal/i });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onCreate).not.toHaveBeenCalled();
  });
});
