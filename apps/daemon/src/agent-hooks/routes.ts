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

const AgentToolUseQuery = z
  .object({
    sessionId: z.string().min(1).max(200),
  })
  .strict();

const AgentToolUsePayload = z
  .object({
    session_id: z.string().min(1).max(200).optional(),
    transcript_path: z.string().max(1000).optional(),
    cwd: z.string().max(1000).optional(),
    permission_mode: z.string().max(100).optional(),
    hook_event_name: z.literal("PreToolUse").optional(),
    tool_name: z.string().min(1).max(200),
    tool_input: z.unknown().optional(),
    tool_use_id: z.string().max(200).default(""),
  })
  .passthrough();

export interface AgentHookRouteDeps {
  onResponseDone(payload: AgentResponseDonePayload): Promise<void>;
  // Resolve the adapter id for a session (DB lookup in prod); tags the response.
  resolveAdapterForSession(sessionId: string): string;
  onWorkerQuestion(sessionId: string, payload: { questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>; toolUseId: string }): Promise<string>;
  /**
   * Decide a worker tool-permission request: "allow" or "deny". The implementation
   * resolves immediately for auto-mode goals, otherwise holds until the user answers
   * in chat or a long timeout elapses (then "deny").
   */
  onPermissionRequest(
    sessionId: string,
    payload: { toolName: string; toolInput: unknown; toolUseId: string },
  ): Promise<"allow" | "deny">;
  onToolUse(
    sessionId: string,
    payload: { toolName: string; toolInput: unknown; toolUseId: string; transcriptPath: string | undefined },
  ): Promise<void>;
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

  server.post("/v1/agent-hooks/tool-use", async (request, reply) => {
    const query = AgentToolUseQuery.safeParse(request.query);
    const body = AgentToolUsePayload.safeParse(request.body);
    if (!query.success || !body.success) {
      reply.status(400);
      return {
        error: {
          code: "validation_failed",
          issues: [
            ...(query.success ? [] : query.error.issues),
            ...(body.success ? [] : body.error.issues),
          ],
        },
      };
    }
    if (body.data.tool_name !== "AskUserQuestion") {
      await deps.onToolUse(query.data.sessionId, {
        toolName: body.data.tool_name,
        toolInput: body.data.tool_input,
        toolUseId: body.data.tool_use_id,
        transcriptPath: body.data.transcript_path,
      });
    }
    return { continue: true };
  });

  server.post("/v1/agent-hooks/elicit", async (request) => {
    const { sessionId } = request.query as { sessionId?: string };
    const body = (request.body ?? {}) as { tool_input?: { questions?: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }> }; tool_use_id?: string };
    const questions = body.tool_input?.questions ?? [];
    if (!sessionId || questions.length === 0) {
      // Nothing to relay — fall back to the native menu.
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
    }
    // Hold open until the user answers in chat (or the daemon times out); the
    // returned reason is delivered to Claude as the answer. deny pre-empts the
    // tool so no tmux menu paints.
    const reason = await deps.onWorkerQuestion(sessionId, { questions, toolUseId: body.tool_use_id ?? "" });
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  });

  server.post("/v1/agent-hooks/permission", async (request) => {
    const { sessionId } = request.query as { sessionId?: string };
    const body = (request.body ?? {}) as { tool_name?: string; tool_input?: unknown; tool_use_id?: string };
    // Safe default: anything we cannot attribute to a session is denied, never allowed.
    let behavior: "allow" | "deny" = "deny";
    if (sessionId) {
      behavior = await deps.onPermissionRequest(sessionId, {
        toolName: body.tool_name ?? "",
        toolInput: body.tool_input ?? {},
        toolUseId: body.tool_use_id ?? "",
      });
    }
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior } } };
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
