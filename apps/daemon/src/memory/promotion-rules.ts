import type { MemoryCandidate } from '@orca/contracts';

export interface ExtractionContext {
  sourceType: 'refinement' | 'session' | 'manual';
  derivedFromExitCode: boolean;
  derivedFromCleanCompletion: boolean;
}

export function shouldAutoPromote(
  candidate: MemoryCandidate,
  ctx: ExtractionContext
): boolean {
  if (ctx.sourceType === 'refinement') {
    return candidate.type === 'constraint' || candidate.type === 'success_criterion';
  }

  if (ctx.sourceType === 'session') {
    if (
      candidate.type === 'blocker' &&
      (candidate.confidence ?? 0) >= 0.9 &&
      ctx.derivedFromExitCode
    ) {
      return true;
    }
    if (
      candidate.type === 'validation_result' &&
      (candidate.confidence ?? 0) >= 0.9 &&
      ctx.derivedFromCleanCompletion
    ) {
      return true;
    }
  }

  return false;
}
