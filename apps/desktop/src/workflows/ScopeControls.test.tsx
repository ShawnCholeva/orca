import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScopeBadge, ScopeFilter, ScopePicker } from "./ScopeControls";

describe("ScopeBadge", () => {
  it("renders 'global' info pill for global scope", () => {
    render(<ScopeBadge scope="global" />);
    expect(screen.getByText("global")).toBeDefined();
  });

  it("renders scope · scopeName for workspace scope", () => {
    render(<ScopeBadge scope="workspace" scopeName="gravitas/platform" />);
    expect(screen.getByText("workspace · gravitas/platform")).toBeDefined();
  });

  it("renders scope only when scopeName is absent", () => {
    render(<ScopeBadge scope="goal" />);
    expect(screen.getByText("goal")).toBeDefined();
  });

  it("renders nothing when scope is null", () => {
    const { container } = render(<ScopeBadge scope={null} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("ScopeFilter", () => {
  it("shows all four filter buttons", () => {
    render(<ScopeFilter value="all" setValue={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^all$/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /^global$/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /^workspace$/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /^goal$/i })).toBeDefined();
  });

  it("calls setValue when a filter is clicked", () => {
    const setValue = vi.fn();
    render(<ScopeFilter value="all" setValue={setValue} />);

    fireEvent.click(screen.getByRole("button", { name: /^workspace$/i }));
    expect(setValue).toHaveBeenCalledWith("workspace");
  });

  it("displays counts when provided", () => {
    render(
      <ScopeFilter
        value="all"
        setValue={vi.fn()}
        counts={{ all: 5, global: 3, workspace: 2, goal: 1 }}
      />,
    );

    expect(screen.getByText("5")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
    expect(screen.getByText("1")).toBeDefined();
  });
});

describe("ScopePicker", () => {
  const goalOptions = ["sprint-42", "auth-overhaul"];

  it("shows a goal select when Goal scope is active", () => {
    render(
      <ScopePicker
        scope="goal"
        scopeName=""
        onChange={vi.fn()}
        goalOptions={goalOptions}
      />,
    );

    const select = screen.getByDisplayValue("Select goal…") as HTMLSelectElement;
    expect(select).toBeDefined();
    expect(screen.getByRole("option", { name: "sprint-42" })).toBeDefined();
    expect(screen.getByRole("option", { name: "auth-overhaul" })).toBeDefined();
  });

  it("shows a free-text input when Workspace scope is active", () => {
    render(
      <ScopePicker
        scope="workspace"
        scopeName=""
        onChange={vi.fn()}
        goalOptions={[]}
      />,
    );

    const input = screen.getByPlaceholderText(/workspace path/i) as HTMLInputElement;
    expect(input).toBeDefined();
    // Make sure it's not a select
    expect(input.tagName.toLowerCase()).toBe("input");
  });

  it("selecting Global calls onChange with empty scopeName", () => {
    const onChange = vi.fn();
    render(
      <ScopePicker
        scope="workspace"
        scopeName="gravitas/platform"
        onChange={onChange}
        goalOptions={[]}
      />,
    );

    fireEvent.click(screen.getByText("Global"));
    expect(onChange).toHaveBeenCalledWith({ scope: "global", scopeName: "" });
  });

  it("selecting Goal calls onChange with the current scopeName preserved", () => {
    const onChange = vi.fn();
    render(
      <ScopePicker
        scope="global"
        scopeName=""
        onChange={onChange}
        goalOptions={goalOptions}
      />,
    );

    fireEvent.click(screen.getByText("Goal"));
    expect(onChange).toHaveBeenCalledWith({ scope: "goal", scopeName: "" });
  });

  it("typing in the workspace input calls onChange", () => {
    const onChange = vi.fn();
    render(
      <ScopePicker
        scope="workspace"
        scopeName=""
        onChange={onChange}
        goalOptions={[]}
      />,
    );

    const input = screen.getByPlaceholderText(/workspace path/i);
    fireEvent.change(input, { target: { value: "gravitas/edge" } });
    expect(onChange).toHaveBeenCalledWith({ scope: "workspace", scopeName: "gravitas/edge" });
  });

  it("selecting from the goal dropdown calls onChange", () => {
    const onChange = vi.fn();
    render(
      <ScopePicker
        scope="goal"
        scopeName=""
        onChange={onChange}
        goalOptions={goalOptions}
      />,
    );

    const select = screen.getByDisplayValue("Select goal…");
    fireEvent.change(select, { target: { value: "sprint-42" } });
    expect(onChange).toHaveBeenCalledWith({ scope: "goal", scopeName: "sprint-42" });
  });
});
