import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { waitFor } from "@testing-library/react";
import type { Agent } from "@orca/contracts";
import { OnboardingView } from "./OnboardingView";
import { ThemeProvider } from "../theme/ThemeProvider";

const NOW = "2026-01-01T00:00:00.000Z";

function agent(id: string, name: string, recommended: boolean, sortOrder: number): Agent {
  return {
    id,
    name,
    shortLabel: "Vendor · CLI",
    description: "Test description.",
    swatch: "#888888",
    recommended,
    connected: false,
    sortOrder,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const SEED_AGENTS: Agent[] = [
  agent("claude-code", "Claude Code", true, 10),
  agent("codex", "Codex CLI", true, 20),
  agent("gemini-cli", "Gemini CLI", true, 30),
  agent("opencode", "OpenCode", false, 40),
];

vi.mock("../api", () => ({
  listAgents: vi.fn(),
  updateAgentConnection: vi.fn(),
  runReadinessCheck: vi.fn(),
  runReadinessCheckForAgent: vi.fn(),
  runSystemReadinessCheck: vi.fn(),
}));

import * as api from "../api";

describe("OnboardingView", () => {
  let container: HTMLDivElement;
  let currentRoot: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentRoot = null;
    vi.mocked(api.listAgents).mockResolvedValue(SEED_AGENTS);
    vi.mocked(api.updateAgentConnection).mockImplementation(async (id, connected) => ({
      ...(SEED_AGENTS.find((a) => a.id === id) ?? agent(id, id, false, 0)),
      connected,
      updatedAt: NOW,
    }));
    vi.mocked(api.runReadinessCheck).mockResolvedValue([]);
    vi.mocked(api.runReadinessCheckForAgent).mockResolvedValue({
      agentId: "claude-code",
      status: "ready",
      steps: [],
      checkedAt: NOW,
    });
    vi.mocked(api.runSystemReadinessCheck).mockResolvedValue({
      dependency: "tmux",
      status: "ready",
      steps: [{ name: "installed", ok: true, command: "tmux -V", detail: "tmux 3.4" }],
      checkedAt: NOW,
      version: "3.4",
    });
  });

  afterEach(async () => {
    if (currentRoot) {
      await act(async () => { currentRoot!.unmount(); });
    }
    document.body.removeChild(container);
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function render(onComplete: (ids: string[]) => void) {
    const root = createRoot(container);
    currentRoot = root;
    await act(async () => {
      root.render(
        <ThemeProvider>
          <OnboardingView onComplete={onComplete} />
        </ThemeProvider>,
      );
    });
    // Flush the listAgents promise.
    await act(async () => { await Promise.resolve(); });
    return root;
  }

  function clickByText(text: string) {
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes(text),
    )!;
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("starts on welcome step", async () => {
    await render(() => {});
    expect(container.textContent).toContain("Operational");
    expect(container.querySelector('button[data-agent-id="claude-code"]')).toBeNull();
  });

  it("advances to agent picker on Get started", async () => {
    await render(() => {});
    clickByText("Get started");
    expect(container.querySelector('button[data-agent-id="claude-code"]')).not.toBeNull();
    expect(container.textContent).toContain("Connect your agents");
  });

  it("starts with no agents selected and Continue disabled", async () => {
    await render(() => {});
    clickByText("Get started");
    const claude = container.querySelector('button[data-agent-id="claude-code"]')!;
    const codex = container.querySelector('button[data-agent-id="codex"]')!;
    const gemini = container.querySelector('button[data-agent-id="gemini-cli"]')!;
    expect(claude.getAttribute("aria-pressed")).toBe("false");
    expect(codex.getAttribute("aria-pressed")).toBe("false");
    expect(gemini.getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).toContain("0 agents selected");
    const continueBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Continue",
    ) as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(true);
  });

  it("enables Continue once at least one agent is selected", async () => {
    await render(() => {});
    clickByText("Get started");
    const claude = container.querySelector('button[data-agent-id="claude-code"]') as HTMLButtonElement;
    act(() => {
      claude.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const continueBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Continue",
    ) as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(false);
  });

  it("persists selections via updateAgentConnection then calls onComplete", async () => {
    vi.mocked(api.runReadinessCheckForAgent).mockImplementation(async (id: string) => ({
      agentId: id,
      status: "ready" as const,
      steps: [],
      checkedAt: NOW,
      version: "1.0.0",
    }));
    const onComplete = vi.fn();
    await render(onComplete);
    clickByText("Get started");

    // User picks claude-code + codex, leaves gemini-cli + opencode off.
    act(() => {
      (container.querySelector('button[data-agent-id="claude-code"]') as HTMLButtonElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      (container.querySelector('button[data-agent-id="codex"]') as HTMLButtonElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    clickByText("Continue");
    expect(container.textContent).toContain("Preparing your workspace");

    // Flush updateAgentConnection promises.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(api.updateAgentConnection).toHaveBeenCalledTimes(SEED_AGENTS.length);
    expect(api.updateAgentConnection).toHaveBeenCalledWith("claude-code", true);
    expect(api.updateAgentConnection).toHaveBeenCalledWith("codex", true);
    expect(api.updateAgentConnection).toHaveBeenCalledWith("gemini-cli", false);
    expect(api.updateAgentConnection).toHaveBeenCalledWith("opencode", false);

    // In test mode, infra timers fire at 0ms. waitFor polls until animation completes
    // and auto-complete fires (all agents ready → onComplete called automatically).
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });
    expect(onComplete.mock.calls[0][0]).toEqual(["claude-code", "codex"]);
  });

  it("step 2 runs readiness checks and disables Continue until ≥1 ready", async () => {
    vi.mocked(api.runReadinessCheckForAgent).mockImplementation(async (id: string) => ({
      agentId: id,
      status: "needs_auth" as const,
      steps: [],
      repair: { kind: "run_command" as const, command: "claude auth login", label: "Sign in" },
      checkedAt: NOW,
    }));
    await render(vi.fn());
    clickByText("Get started");
    act(() => {
      (container.querySelector('button[data-agent-id="claude-code"]') as HTMLButtonElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    clickByText("Continue");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await waitFor(() => expect(api.runReadinessCheckForAgent).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => {
      const cont = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Continue",
      ) as HTMLButtonElement | undefined;
      expect(cont?.disabled).toBe(true);
    }, { timeout: 3000 });
  });

  it("when 0 ready and all settled, shows 'Continue anyway'", async () => {
    vi.mocked(api.runReadinessCheckForAgent).mockImplementation(async (id: string) => ({
      agentId: id,
      status: "missing" as const,
      steps: [],
      checkedAt: NOW,
    }));
    const onComplete = vi.fn();
    await render(onComplete);
    clickByText("Get started");
    act(() => {
      (container.querySelector('button[data-agent-id="claude-code"]') as HTMLButtonElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    clickByText("Continue");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await waitFor(() => {
      expect(Array.from(container.querySelectorAll("button")).some(
        (b) => b.textContent?.includes("Continue anyway"),
      )).toBe(true);
    }, { timeout: 3000 });
    clickByText("Continue anyway");
    expect(onComplete).toHaveBeenCalled();
  });

  it("blocks Continue (no bypass) when tmux is missing, then unblocks on retry", async () => {
    vi.mocked(api.runSystemReadinessCheck).mockResolvedValue({
      dependency: "tmux",
      status: "missing",
      steps: [{ name: "installed", ok: false, command: "tmux -V", detail: "tmux not found on PATH" }],
      repair: { kind: "run_command", command: "brew install tmux", label: "Install tmux (Homebrew)" },
      checkedAt: NOW,
    });
    const onComplete = vi.fn();
    await render(onComplete);
    clickByText("Get started");
    act(() => {
      (container.querySelector('button[data-agent-id="claude-code"]') as HTMLButtonElement)
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    clickByText("Continue");
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // tmux repair surfaces and the agent is ready, but Continue stays disabled
    // and there is NO "Continue anyway" bypass while the system gate fails.
    await waitFor(() => {
      expect(container.textContent).toContain("tmux not found on PATH");
    }, { timeout: 3000 });
    const continueBtn = () => Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Continue",
    ) as HTMLButtonElement | undefined;
    expect(continueBtn()?.disabled).toBe(true);
    expect(Array.from(container.querySelectorAll("button")).some(
      (b) => b.textContent?.includes("Continue anyway"),
    )).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();

    // User installs tmux and retries → system gate passes → onboarding completes.
    vi.mocked(api.runSystemReadinessCheck).mockResolvedValue({
      dependency: "tmux",
      status: "ready",
      steps: [{ name: "installed", ok: true, command: "tmux -V", detail: "tmux 3.4" }],
      checkedAt: NOW,
      version: "3.4",
    });
    clickByText("Retry");
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    }, { timeout: 3000 });
    expect(onComplete.mock.calls[0][0]).toEqual(["claude-code"]);
  });
});
