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
