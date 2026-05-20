export class SessionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

export class GoalNotFoundError extends SessionError {
  constructor(goalId: string) {
    super('goal_not_found', `Goal not found: ${goalId}`);
    this.name = 'GoalNotFoundError';
  }
}

export class GoalArchivedError extends SessionError {
  constructor(goalId: string) {
    super('goal_archived', `Goal is archived: ${goalId}`);
    this.name = 'GoalArchivedError';
  }
}

export class WorkspaceNotFoundError extends SessionError {
  constructor(workspaceId: string) {
    super('workspace_not_found', `Workspace not found: ${workspaceId}`);
    this.name = 'WorkspaceNotFoundError';
  }
}

export class WorkspaceNotAttachedError extends SessionError {
  constructor(workspaceId: string, goalId: string) {
    super('workspace_not_attached', `Workspace ${workspaceId} not attached to goal ${goalId}`);
    this.name = 'WorkspaceNotAttachedError';
  }
}

export class WorkspaceUnavailableError extends SessionError {
  constructor(workspacePath: string) {
    super('workspace_unavailable', `Workspace path not accessible: ${workspacePath}`);
    this.name = 'WorkspaceUnavailableError';
  }
}

export class AdapterNotFoundError extends SessionError {
  constructor(adapterId: string) {
    super('adapter_not_found', `Adapter not found: ${adapterId}`);
    this.name = 'AdapterNotFoundError';
  }
}

export class SessionNotFoundError extends SessionError {
  constructor(sessionId: string) {
    super('session_not_found', `Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

export class SessionWrongStateError extends SessionError {
  constructor(sessionId: string, currentStatus: string) {
    super('session_not_startable', `Session ${sessionId} cannot be started (status: ${currentStatus})`);
    this.name = 'SessionWrongStateError';
  }
}

export class SessionNotStoppableError extends SessionError {
  constructor(sessionId: string, currentStatus: string) {
    super('session_not_stoppable', `Session ${sessionId} cannot be stopped (status: ${currentStatus})`);
    this.name = 'SessionNotStoppableError';
  }
}

export class CommandNotFoundError extends SessionError {
  constructor(adapterId: string) {
    super('command_not_found', `Command not found for adapter: ${adapterId}`);
    this.name = 'CommandNotFoundError';
  }
}

export class SpawnFailedError extends SessionError {
  constructor(sessionId: string, detail: string) {
    super('spawn_failed', `Failed to spawn PTY for session ${sessionId}: ${detail}`);
    this.name = 'SpawnFailedError';
  }
}

export class ContextPackageNotFoundError extends SessionError {
  constructor(packageId: string) {
    super('context_package_not_found', `Context package not found: ${packageId}`);
    this.name = 'ContextPackageNotFoundError';
  }
}

export class ContextPackageMismatchError extends SessionError {
  constructor(reason: string) {
    super('context_package_mismatch', reason);
    this.name = 'ContextPackageMismatchError';
  }
}
