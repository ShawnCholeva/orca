import type Database from "better-sqlite3";
import type { AgentReadinessReport, AgentReadinessStatus, CheckStep } from "@orca/contracts";
import { AdapterRegistry } from "../adapters/registry.js";
import { listAgents, persistReadiness } from "../agents.js";
import { sanitizeOutput } from "./sanitize.js";

export class UnknownAgentError extends Error {
  constructor(public readonly id: string) {
    super(`Unknown adapter: ${id}`);
    this.name = "UnknownAgentError";
  }
}

export class NotConnectedError extends Error {
  constructor(public readonly id: string) {
    super(`Agent not connected: ${id}`);
    this.name = "NotConnectedError";
  }
}

const AGENT_BUDGET_MS = 12_000;

export class ReadinessService {
  private readonly inFlight = new Map<string, Promise<AgentReadinessReport>>();

  constructor(
    private readonly db: Database.Database,
    private readonly registry: AdapterRegistry,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  checkAgent(agentId: string): Promise<AgentReadinessReport> {
    const existing = this.inFlight.get(agentId);
    if (existing) return existing;
    const p = this.runOne(agentId).finally(() => this.inFlight.delete(agentId));
    this.inFlight.set(agentId, p);
    return p;
  }

  async checkSelected(): Promise<AgentReadinessReport[]> {
    const connected = listAgents(this.db).filter((a) => a.connected);
    const outcomes = await Promise.allSettled(connected.map((a) => this.checkAgent(a.id)));
    return outcomes.map((o, i) => {
      if (o.status === "fulfilled") return o.value;
      return this.persistedFailedReport(connected[i]!.id, o.reason);
    });
  }

  private async runOne(agentId: string): Promise<AgentReadinessReport> {
    const adapter = this.registry.get(agentId);
    if (!adapter) throw new UnknownAgentError(agentId);

    const checkedAt = this.clock();
    try {
      const report = await this.withBudget(agentId, adapter, checkedAt);
      persistReadiness(this.db, report, checkedAt);
      return report;
    } catch (err) {
      return this.persistedFailedReport(agentId, err);
    }
  }

  private async withBudget(
    agentId: string,
    adapter: ReturnType<AdapterRegistry["get"]> & {},
    checkedAt: string,
  ): Promise<AgentReadinessReport> {
    let budgetTimer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.runChecks(agentId, adapter, checkedAt),
        new Promise<AgentReadinessReport>((_, reject) => {
          budgetTimer = setTimeout(() => reject(new Error("agent budget exceeded")), AGENT_BUDGET_MS);
        }),
      ]);
    } finally {
      // Note: budget timeout does not cancel adapter work — adapters do not yet accept
      // AbortSignal. The losing branch continues and is GC'd when its promise settles.
      if (budgetTimer) clearTimeout(budgetTimer);
    }
  }

  private async runChecks(
    agentId: string,
    adapter: NonNullable<ReturnType<AdapterRegistry["get"]>>,
    checkedAt: string,
  ): Promise<AgentReadinessReport> {
    const installed = await adapter.checkInstalled();
    const steps: CheckStep[] = [installed];

    if (!installed.ok) {
      const status: AgentReadinessStatus = "missing";
      return {
        agentId,
        status,
        steps,
        repair: adapter.repairFor(status),
        checkedAt,
        version: installed.version,
      };
    }

    const auth = await adapter.checkAuth();
    steps.push(auth);

    const status: AgentReadinessStatus =
      auth.authStatus === "ready"
        ? "ready"
        : auth.authStatus === "needs_auth"
          ? "needs_auth"
          : "misconfigured";

    return {
      agentId,
      status,
      steps,
      repair: adapter.repairFor(status),
      checkedAt,
      version: installed.version,
    };
  }

  private persistedFailedReport(agentId: string, reason: unknown): AgentReadinessReport {
    const checkedAt = this.clock();
    const message = reason instanceof Error ? reason.message : String(reason);
    const adapter = this.registry.get(agentId);
    const repair =
      adapter?.repairFor("failed") ??
      { kind: "run_command" as const, command: "", label: "Retry" };

    const report: AgentReadinessReport = {
      agentId,
      status: "failed",
      steps: [
        {
          name: "installed",
          ok: false,
          command: "(check)",
          detail: sanitizeOutput(message),
          errorOutput: sanitizeOutput(message),
        },
      ],
      repair,
      checkedAt,
    };
    persistReadiness(this.db, report, checkedAt);
    return report;
  }
}
