import type { AgentAdapter } from "../adapters/types.js";

interface OrchestratorSessionSpawnInput {
  goalId: string;
  adapterId: string;
  modelId: string;
}

interface OrchestratorOneShotInput {
  adapterId: string;
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
}

interface OrchestratorOneShotResult {
  text: string;
}

interface OrchestratorOneShotClient {
  request(input: OrchestratorOneShotInput): Promise<OrchestratorOneShotResult>;
}

interface OrchestratorSpawnCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

interface OrchestratorSessionHandle {
  sessionId: string;
}

/**
 * Local PTY runtime interface for orchestrator-LLM shadow sessions.
 * Production wiring adapts the daemon's PTY runtime to this surface.
 */
interface OrchestratorSessionRuntime {
  spawnPty(input: OrchestratorSpawnCommand): Promise<OrchestratorSessionHandle>;
  sendStdin(sessionId: string, input: string): Promise<void>;
  terminate(sessionId: string): Promise<void>;
}

interface OrchestratorSessionDeps {
  adapter: AgentAdapter;
  runtime: OrchestratorSessionRuntime;
  oneShotClient?: OrchestratorOneShotClient;
}

export class OrchestratorSessionManager {
  private active: Record<string, string> = {}; // goalId -> sessionId

  constructor(private readonly deps: OrchestratorSessionDeps) {}

  async spawn(input: OrchestratorSessionSpawnInput): Promise<string> {
    const spawn = await this.deps.adapter.resolveSpawn({
      goalId: input.goalId,
      sessionId: `orchsess-${input.goalId}`,
      workspacePath: ".",
    });
    const handle = await this.deps.runtime.spawnPty({
      command: spawn.command,
      args: spawn.args,
      env: spawn.env,
      cwd: spawn.cwd,
    });
    this.active[input.goalId] = handle.sessionId;
    return handle.sessionId;
  }

  async sendShadowPrompt(goalId: string, prompt: string): Promise<void> {
    const sid = this.active[goalId];
    if (!sid) throw new Error(`no active orchestrator session for goal ${goalId}`);
    await this.deps.runtime.sendStdin(sid, prompt);
  }

  async terminate(goalId: string): Promise<void> {
    const sid = this.active[goalId];
    if (!sid) return;
    await this.deps.runtime.terminate(sid);
    delete this.active[goalId];
  }

  async invokeOneShot(input: OrchestratorOneShotInput): Promise<OrchestratorOneShotResult> {
    if (!this.deps.oneShotClient) throw new Error("oneShotClient not configured");
    return this.deps.oneShotClient.request(input);
  }
}
