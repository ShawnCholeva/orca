import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RepairBlock } from "./RepairBlock";

describe("RepairBlock", () => {
  it("renders the command in a <code> block and copies it on click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <RepairBlock
        repair={{ kind: "run_command", command: "codex login", label: "Sign in to Codex" }}
        onOpenUrl={vi.fn()}
      />,
    );
    expect(screen.getByTestId("repair-command")).toHaveTextContent("codex login");
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("codex login");
  });

  it("renders install_url with a clickable Install button", () => {
    const onOpenUrl = vi.fn();
    render(
      <RepairBlock
        repair={{ kind: "install_url", url: "https://example.com", label: "Install Gemini CLI" }}
        onOpenUrl={onOpenUrl}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /install/i }));
    expect(onOpenUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("shows 'Restart Orca' hint when requiresAppRestart is true", () => {
    render(
      <RepairBlock
        repair={{
          kind: "run_command",
          command: "export GEMINI_API_KEY=...",
          label: "Set API key",
          requiresAppRestart: true,
        }}
        onOpenUrl={vi.fn()}
      />,
    );
    expect(screen.getByText(/restart orca/i)).toBeInTheDocument();
  });
});
