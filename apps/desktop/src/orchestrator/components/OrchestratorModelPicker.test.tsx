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

  it("shows a configured-empty message when no provider is available", async () => {
    listModelProvidersMock.mockResolvedValue([
      {
        id: "orca/openai",
        displayName: "OpenAI",
        available: false,
        reason: "missing api key",
        models: [{ id: "gpt-5", displayName: "GPT 5", capabilities: ["planning"] }],
      },
    ]);
    const { OrchestratorModelPicker } = await import("./OrchestratorModelPicker");

    render(<OrchestratorModelPicker value={null} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/No LLM providers configured/i)).toBeInTheDocument();
    });
  });
});
