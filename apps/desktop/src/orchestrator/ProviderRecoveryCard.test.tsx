import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProviderRecoveryCheckpoint } from "@orca/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const waitForProviderRecoveryMock = vi.fn();
const retryProviderRecoveryMock = vi.fn();
const refreshProviderRecoveryMock = vi.fn();
const switchProviderRecoveryMock = vi.fn();

vi.mock("../api", () => ({
  waitForProviderRecovery: (...args: unknown[]) => waitForProviderRecoveryMock(...args),
  retryProviderRecovery: (...args: unknown[]) => retryProviderRecoveryMock(...args),
  refreshProviderRecovery: (...args: unknown[]) => refreshProviderRecoveryMock(...args),
  switchProviderRecovery: (...args: unknown[]) => switchProviderRecoveryMock(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

function mkRecovery(over: Partial<ProviderRecoveryCheckpoint> = {}): ProviderRecoveryCheckpoint {
  return {
    id: "recovery-1",
    mode: "choose",
    failureCode: "session_limit",
    message: "Claude Code session limit reached",
    currentSessionId: "session-1",
    currentAdapterId: "claude-code",
    currentProviderName: "Claude Code",
    resetTimeText: "4:20am (America/New_York)",
    resetAt: null,
    timezone: "America/New_York",
    detectedAt: "2026-06-12T05:00:00.000Z",
    retryOutputSeq: null,
    retryKind: "preserved_session",
    replacementSessionId: null,
    replacementOutputSeq: null,
    pendingGuidance: [],
    lastError: null,
    choices: [],
    ...over,
  };
}

describe("ProviderRecoveryCard", () => {
  beforeEach(() => {
    waitForProviderRecoveryMock.mockReset();
    retryProviderRecoveryMock.mockReset();
    refreshProviderRecoveryMock.mockReset();
    switchProviderRecoveryMock.mockReset();
    waitForProviderRecoveryMock.mockResolvedValue(undefined);
    retryProviderRecoveryMock.mockResolvedValue(undefined);
    refreshProviderRecoveryMock.mockResolvedValue(undefined);
    switchProviderRecoveryMock.mockResolvedValue(undefined);
  });

  it("renders reset label when resetTimeText is present", async () => {
    const { ProviderRecoveryCard } = await import("./ProviderRecoveryCard");
    render(
      <ProviderRecoveryCard
        runId="run-1"
        recovery={mkRecovery({ resetTimeText: "4:20am (America/New_York)" })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText("Available again at 4:20am (America/New_York)")).toBeInTheDocument();
  });

  it("renders fallback label when resetTimeText is null", async () => {
    const { ProviderRecoveryCard } = await import("./ProviderRecoveryCard");
    render(
      <ProviderRecoveryCard
        runId="run-1"
        recovery={mkRecovery({ resetTimeText: null })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText("Reset time unavailable")).toBeInTheDocument();
  });

  it("shows only Wait button when choices is empty (choose mode)", async () => {
    const { ProviderRecoveryCard } = await import("./ProviderRecoveryCard");
    render(
      <ProviderRecoveryCard
        runId="run-1"
        recovery={mkRecovery({ choices: [] })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Wait for Claude Code/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Refresh providers/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Switch to/ })).toBeNull();
  });

  it("shows only Retry button when choices is empty (waiting mode, preserved_session)", async () => {
    const { ProviderRecoveryCard } = await import("./ProviderRecoveryCard");
    render(
      <ProviderRecoveryCard
        runId="run-1"
        recovery={mkRecovery({ mode: "waiting", choices: [], resetAt: null })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Retry Claude Code/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Refresh providers/ })).toBeNull();
  });

  it("renders enabled Codex switch button and disabled Antigravity with reason", async () => {
    const { ProviderRecoveryCard } = await import("./ProviderRecoveryCard");
    render(
      <ProviderRecoveryCard
        runId="run-1"
        recovery={mkRecovery({
          choices: [
            { adapterId: "codex", displayName: "Codex", modelId: "gpt-5.4-mini", enabled: true, reason: null },
            { adapterId: "antigravity", displayName: "Antigravity", modelId: null, enabled: false, reason: "not configured for this step" },
          ],
        })}
        onChanged={vi.fn()}
      />,
    );
    const codexBtn = screen.getByRole("button", { name: "Switch to Codex" });
    expect(codexBtn).toBeEnabled();
    const antigravBtn = screen.getByRole("button", { name: "Switch to Antigravity" });
    expect(antigravBtn).toBeDisabled();
    expect(screen.getByText("not configured for this step")).toBeInTheDocument();
  });

  it("Refresh providers calls the refresh endpoint and invokes onChanged", async () => {
    const onChanged = vi.fn();
    const { ProviderRecoveryCard } = await import("./ProviderRecoveryCard");
    render(
      <ProviderRecoveryCard
        runId="run-1"
        recovery={mkRecovery({
          choices: [
            { adapterId: "codex", displayName: "Codex", modelId: null, enabled: true, reason: null },
          ],
        })}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh providers" }));
    await waitFor(() => {
      expect(refreshProviderRecoveryMock).toHaveBeenCalledWith("run-1", { checkpointId: "recovery-1" });
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
  });

  it("displays waiting message in waiting mode", async () => {
    const { ProviderRecoveryCard } = await import("./ProviderRecoveryCard");
    render(
      <ProviderRecoveryCard
        runId="run-1"
        recovery={mkRecovery({ mode: "waiting", resetAt: null })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText(/existing agent session and context will be preserved/i)).toBeInTheDocument();
  });

  it("disables Retry when resetAt is in the future (preserved_session, waiting mode)", async () => {
    const futureResetAt = new Date(Date.now() + 60_000).toISOString();
    const { ProviderRecoveryCard } = await import("./ProviderRecoveryCard");
    render(
      <ProviderRecoveryCard
        runId="run-1"
        recovery={mkRecovery({
          mode: "waiting",
          retryKind: "preserved_session",
          resetAt: futureResetAt,
        })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Retry Claude Code/ })).toBeDisabled();
  });

  it("keeps Retry enabled when resetAt is null (unknown reset time)", async () => {
    const { ProviderRecoveryCard } = await import("./ProviderRecoveryCard");
    render(
      <ProviderRecoveryCard
        runId="run-1"
        recovery={mkRecovery({
          mode: "waiting",
          retryKind: "preserved_session",
          resetAt: null,
        })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Retry Claude Code/ })).toBeEnabled();
  });

  it("uses 'Restart Claude Code session' label for fresh_session retryKind in waiting mode", async () => {
    const { ProviderRecoveryCard } = await import("./ProviderRecoveryCard");
    render(
      <ProviderRecoveryCard
        runId="run-1"
        recovery={mkRecovery({
          mode: "waiting",
          retryKind: "fresh_session",
          resetAt: null,
        })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Restart Claude Code session" })).toBeInTheDocument();
  });

  it("disables all action buttons in retrying mode", async () => {
    const { ProviderRecoveryCard } = await import("./ProviderRecoveryCard");
    render(
      <ProviderRecoveryCard
        runId="run-1"
        recovery={mkRecovery({
          mode: "retrying",
          choices: [
            { adapterId: "codex", displayName: "Codex", modelId: null, enabled: true, reason: null },
          ],
        })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Retrying Claude Code…/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Switch to Codex" })).toBeDisabled();
  });

  it("disables all action buttons in switching mode", async () => {
    const { ProviderRecoveryCard } = await import("./ProviderRecoveryCard");
    render(
      <ProviderRecoveryCard
        runId="run-1"
        recovery={mkRecovery({
          mode: "switching",
          choices: [
            { adapterId: "codex", displayName: "Codex", modelId: null, enabled: true, reason: null },
          ],
        })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Starting replacement provider…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Switch to Codex" })).toBeDisabled();
  });

  it("restores buttons and shows inline error when an action fails", async () => {
    waitForProviderRecoveryMock.mockRejectedValueOnce(new Error("Checkpoint stale"));
    const onChanged = vi.fn();
    const { ProviderRecoveryCard } = await import("./ProviderRecoveryCard");
    render(
      <ProviderRecoveryCard
        runId="run-1"
        recovery={mkRecovery()}
        onChanged={onChanged}
      />,
    );
    const btn = screen.getByRole("button", { name: /Wait for Claude Code/ });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Checkpoint stale");
    });
    expect(btn).toBeEnabled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("renders persisted lastError from the server checkpoint", async () => {
    const { ProviderRecoveryCard } = await import("./ProviderRecoveryCard");
    render(
      <ProviderRecoveryCard
        runId="run-1"
        recovery={mkRecovery({ lastError: "The provider failed to start." })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("The provider failed to start.");
  });

  it("calls waitForProviderRecovery and onChanged when Wait is clicked in choose mode", async () => {
    const onChanged = vi.fn();
    const { ProviderRecoveryCard } = await import("./ProviderRecoveryCard");
    render(
      <ProviderRecoveryCard
        runId="run-1"
        recovery={mkRecovery()}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Wait for Claude Code/ }));
    await waitFor(() => {
      expect(waitForProviderRecoveryMock).toHaveBeenCalledWith("run-1", { checkpointId: "recovery-1" });
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
  });

  it("calls switchProviderRecovery and onChanged when Switch to Codex is clicked", async () => {
    const onChanged = vi.fn();
    const { ProviderRecoveryCard } = await import("./ProviderRecoveryCard");
    render(
      <ProviderRecoveryCard
        runId="run-1"
        recovery={mkRecovery({
          choices: [
            { adapterId: "codex", displayName: "Codex", modelId: "gpt-5.4-mini", enabled: true, reason: null },
          ],
        })}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch to Codex" }));
    await waitFor(() => {
      expect(switchProviderRecoveryMock).toHaveBeenCalledWith("run-1", {
        checkpointId: "recovery-1",
        adapterId: "codex",
      });
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
  });
});
