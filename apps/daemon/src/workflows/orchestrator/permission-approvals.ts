export type PermissionDecision = "allow" | "deny";

export interface PendingPermissionApproval {
  toolUseId: string;
  sessionId: string;
  goalId: string;
  toolName: string;
  summary: string;
  detail?: string;
  resolve: (decision: PermissionDecision) => void;
  answered: Promise<PermissionDecision>;
}

export interface RecordApprovalInput {
  toolUseId: string;
  sessionId: string;
  goalId: string;
  toolName: string;
  summary: string;
  detail?: string;
}

export interface ApprovalHandle {
  approvalId: string;
  answered: Promise<PermissionDecision>;
  /** False when a duplicate hook fire (same toolUseId) reuses an existing approval. */
  isNew: boolean;
}

export class PermissionApprovalStore {
  private readonly pending = new Map<string, PendingPermissionApproval>();
  private readonly byToolUseId = new Map<string, string>();

  constructor(private readonly idFactory: () => string = () => Math.random().toString(36).slice(2)) {}

  record(input: RecordApprovalInput): ApprovalHandle {
    const existingId = this.byToolUseId.get(input.toolUseId);
    if (existingId) {
      const existing = this.pending.get(existingId);
      if (existing) return { approvalId: existingId, answered: existing.answered, isNew: false };
    }
    const approvalId = this.idFactory();
    let resolve!: (decision: PermissionDecision) => void;
    const answered = new Promise<PermissionDecision>((res) => { resolve = res; });
    this.pending.set(approvalId, { ...input, resolve, answered });
    this.byToolUseId.set(input.toolUseId, approvalId);
    return { approvalId, answered, isNew: true };
  }

  get(approvalId: string): PendingPermissionApproval | undefined {
    return this.pending.get(approvalId);
  }

  /** Resolves the held hook with the decision. Returns false if absent/already resolved. */
  resolveDecision(approvalId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    this.pending.delete(approvalId);
    this.byToolUseId.delete(entry.toolUseId);
    entry.resolve(decision);
    return true;
  }
}
