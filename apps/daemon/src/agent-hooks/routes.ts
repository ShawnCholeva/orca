import type { FastifyInstance } from "fastify";
import { z } from "zod";

export const AgentResponseDonePayload = z
  .object({
    sessionId: z.string().min(1).max(200),
    adapterId: z.string().min(1).max(50),
    responseText: z.string().max(200_000),
    transcriptPath: z.string().max(1000).optional(),
  })
  .strict();
export type AgentResponseDonePayload = z.infer<typeof AgentResponseDonePayload>;

export interface AgentHookRouteDeps {
  onResponseDone(payload: AgentResponseDonePayload): Promise<void>;
  // Resolve the adapter id for a session (DB lookup in prod); tags the response.
  resolveAdapterForSession(sessionId: string): string;
}

export function registerAgentHookRoutes(server: FastifyInstance, deps: AgentHookRouteDeps): void {
  server.post("/v1/agent-hooks/response-done", async (request, reply) => {
    const parsed = AgentResponseDonePayload.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: { code: "validation_failed", issues: parsed.error.issues } };
    }
    await deps.onResponseDone(parsed.data);
    return { ok: true };
  });

  server.post("/v1/agent-hooks/stop", async (request, reply) => {
    const { sessionId, failure } = request.query as { sessionId?: string; failure?: string };
    if (!sessionId) { reply.status(400); return { error: { code: "missing_session" } }; }
    if (failure === "1") { reply.status(200); return { ok: true }; } // StopFailure: nothing to judge
    const body = (request.body ?? {}) as { last_assistant_message?: string };
    await deps.onResponseDone({
      sessionId,
      adapterId: deps.resolveAdapterForSession(sessionId),
      responseText: body.last_assistant_message ?? "",
    });
    return { ok: true };
  });
}
