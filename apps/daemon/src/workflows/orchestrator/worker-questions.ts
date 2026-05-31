export interface PendingWorkerQuestion { sessionId: string; optionCount: number; }

export class WorkerQuestionStore {
  private readonly pending = new Map<string, PendingWorkerQuestion>();
  constructor(private readonly idFactory: () => string = () => Math.random().toString(36).slice(2)) {}
  record(q: PendingWorkerQuestion): string { const id = this.idFactory(); this.pending.set(id, q); return id; }
  get(id: string): PendingWorkerQuestion | undefined { return this.pending.get(id); }
  resolve(id: string): void { this.pending.delete(id); }
}
