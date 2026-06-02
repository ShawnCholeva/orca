import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

const listModelProvidersMock = vi.fn();

vi.mock("../../api", () => ({
  listModelProviders: (...args: unknown[]) => listModelProvidersMock(...args),
  toErrorMessage: (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback,
}));

describe("OrchestratorModelPicker", () => {
  beforeEach(() => {
    listModelProvidersMock.mockReset();
  });

  it("renders available provider/model options and emits the selected choice", async () => {
    listModelProvidersMock.mockResolvedValue([
      {
        id: "orca/openai",
        displayName: "OpenAI",
        available: true,
        models: [{ id: "gpt-5", displayName: "GPT 5", capabilities: ["planning"] }],
      },
    ]);
    const onChange = vi.fn();
    const { OrchestratorModelPicker } = await import("./OrchestratorModelPicker");

    render(<OrchestratorModelPicker value={null} onChange={onChange} />);

    const select = await screen.findByLabelText("Orchestrator LLM");
    fireEvent.change(select, { target: { value: "orca/openai:gpt-5" } });

    expect(onChange).toHaveBeenCalledWith({
      providerId: "orca/openai",
      modelId: "gpt-5",
    });
  });

  it("shows canonical provider names and readiness badges", async () => {
    listModelProvidersMock.mockResolvedValue([
      {
        id: "orca/openai",
        displayName: "OpenAI",
        available: true,
        models: [{ id: "gpt-5", displayName: "GPT 5", capabilities: ["planning"] }],
      },
      {
        id: "orca/anthropic",
        displayName: "Anthropic",
        available: true,
        reason: "Claude Code is not signed in",
        models: [{ id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", capabilities: ["planning"] }],
      },
    ]);
    const { OrchestratorModelPicker } = await import("./OrchestratorModelPicker");

    render(<OrchestratorModelPicker value={null} onChange={vi.fn()} />);

    expect(await screen.findByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Automated ready")).toBeInTheDocument();
    expect(screen.getAllByText("Needs setup")).toHaveLength(1);
    expect(screen.getByText("Claude Code is not signed in")).toBeInTheDocument();
  });

  it("shows the human-review fallback copy when no automated provider is healthy", async () => {
    listModelProvidersMock.mockResolvedValue([
      {
        id: "orca/openai",
        displayName: "OpenAI",
        available: true,
        reason: "Codex CLI is not signed in",
        models: [{ id: "gpt-5", displayName: "GPT 5", capabilities: ["planning"] }],
      },
      {
        id: "orca/anthropic",
        displayName: "Claude",
        available: true,
        reason: "Claude Code is not signed in",
        models: [{ id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", capabilities: ["planning"] }],
      },
    ]);
    const { OrchestratorModelPicker } = await import("./OrchestratorModelPicker");

    render(<OrchestratorModelPicker value={null} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(
        screen.getByText(/Automated orchestration can use a signed-in local CLI or explicit SDK configuration\./i),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/this Goal can still proceed with human-reviewed orchestration/i),
    ).toBeInTheDocument();
  });
});
