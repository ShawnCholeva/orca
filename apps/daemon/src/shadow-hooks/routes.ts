import type { FastifyInstance } from "fastify";

export interface OrchestratorHookRouteDeps {
  resolvePending: (goalId: string, result: { text: string; failure: boolean }) => void;
}

export function registerShadowHookRoutes(server: FastifyInstance, deps: OrchestratorHookRouteDeps): void {
  server.post("/v1/shadow-hooks/stop", async (request, reply) => {
    const q = request.query as { goalId?: string; failure?: string };
    const goalId = q.goalId;
    if (!goalId) {
      reply.status(200);
      return { ok: true, dropped: "no_goal_id" };
    }
    const body = (request.body ?? {}) as { last_assistant_message?: string };
    deps.resolvePending(goalId, {
      text: body.last_assistant_message ?? "",
      failure: q.failure === "1",
    });
    reply.status(200);
    return { ok: true };
  });
}
