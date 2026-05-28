import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  AdapterExecutionModeConfig,
  type ExecutionMode,
} from "@orca/contracts";
import {
  getAdapterExecutionModeConfig,
  listAdapterExecutionModeConfigs,
  upsertAdapterExecutionModeConfig,
} from "./execution-modes.js";

export interface AdapterExecutionModeRouteDeps {
  db: Database.Database;
  now: () => string;
  supportedByAdapter: Record<string, ExecutionMode[]>;
}

export function registerAdapterExecutionModeRoutes(
  server: FastifyInstance,
  deps: AdapterExecutionModeRouteDeps
): void {
  server.get("/v1/adapters/execution-modes", async () => {
    const configs = listAdapterExecutionModeConfigs(deps.db);
    return { configs };
  });

  server.get("/v1/adapters/:id/execution-modes", async (request, reply) => {
    const { id } = request.params as { id: string };
    const cfg = getAdapterExecutionModeConfig(deps.db, id);
    if (!cfg) {
      reply.status(404);
      return { error: { code: "adapter_not_found", message: `No execution-mode config for adapter ${id}` } };
    }
    return cfg;
  });

  server.put("/v1/adapters/:id/execution-modes", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = AdapterExecutionModeConfig.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: { code: "validation_failed", issues: parsed.error.issues } };
    }
    if (parsed.data.adapterId !== id) {
      reply.status(400);
      return { error: { code: "adapter_id_mismatch", message: "URL adapter id must match body adapter id" } };
    }
    const supported = deps.supportedByAdapter[id];
    if (!supported) {
      reply.status(404);
      return { error: { code: "adapter_not_registered", message: `Adapter ${id} is not registered in this daemon` } };
    }
    try {
      const stored = upsertAdapterExecutionModeConfig(deps.db, deps.now, parsed.data, supported, "settings_api");
      return stored;
    } catch (err) {
      reply.status(400);
      return { error: { code: "invariant_violation", message: err instanceof Error ? err.message : "unknown" } };
    }
  });
}
