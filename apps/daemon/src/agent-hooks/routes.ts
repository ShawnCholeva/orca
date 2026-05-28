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
}
