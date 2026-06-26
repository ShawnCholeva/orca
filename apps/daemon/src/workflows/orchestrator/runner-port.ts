import type { SessionOutputStore } from "../../sessions/output-store.js";
import type { WorkflowSessionLauncher } from "./session-launcher.js";

/**
 * The execution-plane capability surface the control plane invokes — the in-process
 * precursor to FUTURE_ARCHITECTURE's network Runner Protocol (the "local runner is
 * the first runner"). Grows to absorb workerTerminate/workerInterrupt when their
 * consumer (interruptStepAgent) is extracted.
 */
export interface RunnerPort {
  launch: WorkflowSessionLauncher["launch"];
  workerSpawn: (input: { sessionId: string; goalId: string; adapterId: string }) => Promise<void>;
  workerDeliver: (sessionId: string, text: string) => Promise<"delivered" | "no_session" | "timeout">;
  workerWait: (sessionId: string, adapterId: string) => Promise<void>;
  readTail: SessionOutputStore["readTail"];
}
