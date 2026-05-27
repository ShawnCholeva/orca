import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReadinessPanel } from "./ReadinessPanel";

const agents = [
  { id: "claude-code", name: "Claude Code", connected: true, recommended: true, sortOrder: 10, shortLabel: "x", description: "x", swatch: "#000", createdAt: "2026-05-22T00:00:00.000Z", updatedAt: "2026-05-22T00:00:00.000Z", readiness: null },
];

const mockRunAll = vi.fn();
const mockRunOne = vi.fn();
const mockOpenUrl = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  mockRunAll.mockReset();
  mockRunOne.mockReset();
});

describe("ReadinessPanel", () => {
  it("calls runReadinessCheck on mount and renders a row per agent", async () => {
    mockRunAll.mockResolvedValue([
      { agentId: "claude-code", status: "ready", steps: [], checkedAt: "2026-05-22T00:00:00.000Z", version: "1.2.3" },
    ]);
    render(
      <ReadinessPanel
        agents={agents as never}
        runAll={mockRunAll}
        runOne={mockRunOne}
        onOpenUrl={mockOpenUrl}
        onChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(mockRunAll).toHaveBeenCalled());
    expect(screen.getByText(/Claude Code/)).toBeInTheDocument();
  });

  it("Retry on a row calls runOne and replaces only that row's report", async () => {
    mockRunAll.mockResolvedValue([
      { agentId: "claude-code", status: "needs_auth", steps: [], repair: { kind: "run_command", command: "claude auth login", label: "Sign in" }, checkedAt: "2026-05-22T00:00:00.000Z" },
    ]);
    mockRunOne.mockResolvedValue({ agentId: "claude-code", status: "ready", steps: [], checkedAt: "2026-05-22T00:01:00.000Z", version: "1.2.3" });
    render(
      <ReadinessPanel
        agents={agents as never}
        runAll={mockRunAll}
        runOne={mockRunOne}
        onOpenUrl={mockOpenUrl}
        onChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(mockRunAll).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(mockRunOne).toHaveBeenCalledWith("claude-code"));
    await waitFor(() => expect(screen.getByText(/Ready/)).toBeInTheDocument());
  });

  it("uses cached <60s reports without auto-rechecking", async () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    render(
      <ReadinessPanel
        agents={[
          { ...agents[0], readiness: { agentId: "claude-code", status: "ready", steps: [], checkedAt: recent, version: "1.2.3" } } as never,
        ]}
        runAll={mockRunAll}
        runOne={mockRunOne}
        onOpenUrl={mockOpenUrl}
        onChange={vi.fn()}
      />,
    );
    expect(mockRunAll).not.toHaveBeenCalled();
    expect(screen.getByText(/last checked/i)).toBeInTheDocument();
  });

  it("emits onChange with readyCount so parent can gate Continue", async () => {
    mockRunAll.mockResolvedValue([
      { agentId: "claude-code", status: "ready", steps: [], checkedAt: "2026-05-22T00:00:00.000Z" },
    ]);
    const onChange = vi.fn();
    render(
      <ReadinessPanel
        agents={agents as never}
        runAll={mockRunAll}
        runOne={mockRunOne}
        onOpenUrl={mockOpenUrl}
        onChange={onChange}
      />,
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ readyCount: 1, settled: true }),
    );
  });
});
