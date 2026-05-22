import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
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
}));

import * as api from "../api";

describe("OnboardingView", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.mocked(api.listAgents).mockResolvedValue(SEED_AGENTS);
    vi.mocked(api.updateAgentConnection).mockImplementation(async (id, connected) => ({
      ...(SEED_AGENTS.find((a) => a.id === id) ?? agent(id, id, false, 0)),
      connected,
      updatedAt: NOW,
    }));
  });

  afterEach(() => {
    document.body.removeChild(container);
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  async function render(onComplete: (ids: string[]) => void) {
    const root = createRoot(container);
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

    // Flush the parallel PATCH calls.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    expect(api.updateAgentConnection).toHaveBeenCalledTimes(SEED_AGENTS.length);
    expect(api.updateAgentConnection).toHaveBeenCalledWith("claude-code", true);
    expect(api.updateAgentConnection).toHaveBeenCalledWith("codex", true);
    expect(api.updateAgentConnection).toHaveBeenCalledWith("gemini-cli", false);
    expect(api.updateAgentConnection).toHaveBeenCalledWith("opencode", false);

    // Wait out the 800ms settle timer.
    await new Promise((r) => setTimeout(r, 900));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toEqual(["claude-code", "codex"]);
  });
});
