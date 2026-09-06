import { z } from "zod";

/**
 * One session the harness ran, as an interval. The Workflows dashboard samples
 * these into "sessions active during each interval" on whatever window and step
 * the reader chose, so the daemon returns the FACTS — when each session began and
 * ended — rather than a series bucketed on its own terms.
 *
 * Read from the `sessions` table, which is hard-deleted with its workspace: a
 * session whose workspace is gone is not here. The event log survives that purge
 * but records no exit, so it cannot say how long a session lived.
 */
export const SessionInterval = z.object({
  sessionId: z.string(),
  goalId: z.string(),
  adapterId: z.string(),
  status: z.string(),
  startedAt: z.string(),
  /** Null while the session is still running. */
  endedAt: z.string().nullable(),
}).strict();
export type SessionInterval = z.infer<typeof SessionInterval>;
