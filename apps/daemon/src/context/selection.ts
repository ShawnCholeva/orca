import type {
  ContextRole,
  SelectableDecision,
  SelectableMemory,
  SelectableSummary,
} from '@orca/contracts';

export const MEMORY_SELECTION_HARD_CAP = 30;
export const DECISION_SELECTION_HARD_CAP = 20;
export const SUMMARY_SELECTION_HARD_CAP = 5;

const RECENT_PROMOTED_NOTE_LIMIT = 3;

const OPEN_QUESTION_ROLES = new Set<ContextRole>(['architect', 'engineer', 'reviewer']);
const ALWAYS_INCLUDED_MEMORY_TYPES = new Set<SelectableMemory['type']>([
  'constraint',
  'success_criterion',
  'architecture_note',
]);
const OPTIONAL_PROMOTED_MEMORY_TYPES = new Set<SelectableMemory['type']>([
  'blocker',
  'validation_result',
  'assumption',
]);
const MEMORY_TYPE_PRIORITY: Record<SelectableMemory['type'], number> = {
  constraint: 0,
  success_criterion: 1,
  architecture_note: 2,
  blocker: 3,
  validation_result: 4,
  assumption: 5,
  open_question: 6,
  note: 7,
};

export interface SelectionBudget {
  maxItems?: number;
}

export interface SelectedMemory extends SelectableMemory {
  labelAsCandidate: boolean;
}

export interface SelectedDecisions {
  needsConfirmation: SelectableDecision[];
  confirmed: SelectableDecision[];
  proposed: SelectableDecision[];
}

export type SelectedSummary = SelectableSummary;

function resolveLimit(hardCap: number, budget?: SelectionBudget): number {
  if (!budget || budget.maxItems === undefined) {
    return hardCap;
  }
  return Math.max(0, Math.min(hardCap, budget.maxItems));
}

function compareDescendingTime(left: string, right: string): number {
  if (left > right) {
    return -1;
  }
  if (left < right) {
    return 1;
  }
  return 0;
}

function compareMemory(left: SelectableMemory, right: SelectableMemory): number {
  const typePriorityDiff = MEMORY_TYPE_PRIORITY[left.type] - MEMORY_TYPE_PRIORITY[right.type];
  if (typePriorityDiff !== 0) {
    return typePriorityDiff;
  }

  if (left.status !== right.status) {
    return left.status === 'promoted' ? -1 : 1;
  }

  const createdAtDiff = compareDescendingTime(left.createdAt, right.createdAt);
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  return left.id.localeCompare(right.id);
}

function compareMemoryRecency(left: SelectableMemory, right: SelectableMemory): number {
  const createdAtDiff = compareDescendingTime(left.createdAt, right.createdAt);
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  return left.id.localeCompare(right.id);
}

function compareDecisionConfirmed(left: SelectableDecision, right: SelectableDecision): number {
  const confirmedAtDiff = compareDescendingTime(left.confirmedAt ?? '', right.confirmedAt ?? '');
  if (confirmedAtDiff !== 0) {
    return confirmedAtDiff;
  }

  return left.id.localeCompare(right.id);
}

function compareDecisionProposed(left: SelectableDecision, right: SelectableDecision): number {
  const createdAtDiff = compareDescendingTime(left.createdAt, right.createdAt);
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  return left.id.localeCompare(right.id);
}

function compareSummary(left: SelectableSummary, right: SelectableSummary): number {
  const createdAtDiff = compareDescendingTime(left.createdAt, right.createdAt);
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  return left.id.localeCompare(right.id);
}

function canIncludeOpenQuestion(role: ContextRole): boolean {
  return OPEN_QUESTION_ROLES.has(role);
}

function isEligibleMemory(memory: SelectableMemory, role: ContextRole): boolean {
  if (memory.status === 'archived') {
    return false;
  }
  if (memory.type === 'open_question' && !canIncludeOpenQuestion(role)) {
    return false;
  }
  return true;
}

function isRecentPromotedNote(
  memory: SelectableMemory,
  recentPromotedNoteIds: ReadonlySet<string>
): boolean {
  if (memory.type !== 'note' || memory.status !== 'promoted') {
    return true;
  }
  return recentPromotedNoteIds.has(memory.id);
}

function buildRecentPromotedNoteSet(memoryItems: SelectableMemory[]): ReadonlySet<string> {
  return new Set(
    memoryItems
      .filter((memory) => memory.status === 'promoted' && memory.type === 'note')
      .sort(compareMemoryRecency)
      .slice(0, RECENT_PROMOTED_NOTE_LIMIT)
      .map((memory) => memory.id)
  );
}

function toSelectedMemory(memory: SelectableMemory): SelectedMemory {
  return {
    ...memory,
    labelAsCandidate: memory.status === 'candidate',
  };
}

function takeUntilLimit<T>(items: T[], limit: number): T[] {
  if (limit <= 0) {
    return [];
  }
  if (items.length <= limit) {
    return items.slice();
  }
  return items.slice(0, limit);
}

export function selectMemory(
  memoryItems: SelectableMemory[],
  role: ContextRole,
  budget?: SelectionBudget
): SelectedMemory[] {
  const limit = resolveLimit(MEMORY_SELECTION_HARD_CAP, budget);
  if (limit === 0 || memoryItems.length === 0) {
    return [];
  }

  const recentPromotedNoteIds = buildRecentPromotedNoteSet(memoryItems);
  const eligible = memoryItems.filter(
    (memory) => isEligibleMemory(memory, role) && isRecentPromotedNote(memory, recentPromotedNoteIds)
  );

  const alwaysIncluded = eligible
    .filter(
      (memory) =>
        memory.status === 'promoted' && ALWAYS_INCLUDED_MEMORY_TYPES.has(memory.type)
    )
    .sort(compareMemory);

  const optionalPromoted = eligible
    .filter(
      (memory) =>
        memory.status === 'promoted' &&
        (OPTIONAL_PROMOTED_MEMORY_TYPES.has(memory.type) ||
          memory.type === 'open_question' ||
          memory.type === 'note')
    )
    .sort(compareMemory);

  const candidateItems = eligible
    .filter(
      (memory) =>
        memory.status === 'candidate' &&
        memory.confidence !== null &&
        memory.confidence >= 0.7
    )
    .sort(compareMemory);

  const selected: SelectedMemory[] = [];
  const seen = new Set<string>();

  for (const pool of [alwaysIncluded, optionalPromoted, candidateItems]) {
    for (const memory of pool) {
      if (selected.length >= limit) {
        return selected;
      }
      if (seen.has(memory.id)) {
        continue;
      }
      selected.push(toSelectedMemory(memory));
      seen.add(memory.id);
    }
  }

  return selected;
}

export function selectDecisions(
  decisions: SelectableDecision[],
  _role: ContextRole,
  budget?: SelectionBudget
): SelectedDecisions {
  const limit = resolveLimit(DECISION_SELECTION_HARD_CAP, budget);
  if (decisions.length === 0) {
    return { needsConfirmation: [], confirmed: [], proposed: [] };
  }

  const activeDecisions = decisions.filter((decision) => decision.status !== 'archived');

  const needsConfirmation = activeDecisions
    .filter(
      (decision) => decision.status === 'proposed' && decision.confirmationRequired
    )
    .sort(compareDecisionProposed);

  const confirmed = activeDecisions
    .filter((decision) => decision.status === 'confirmed')
    .sort(compareDecisionConfirmed);

  const proposed = activeDecisions
    .filter(
      (decision) => decision.status === 'proposed' && !decision.confirmationRequired
    )
    .sort(compareDecisionProposed);

  const remainingSlots = Math.max(0, limit - needsConfirmation.length);
  const confirmedSelection = takeUntilLimit(confirmed, remainingSlots);
  const proposedSelection = takeUntilLimit(
    proposed,
    Math.max(0, remainingSlots - confirmedSelection.length)
  );

  return {
    needsConfirmation,
    confirmed: confirmedSelection,
    proposed: proposedSelection,
  };
}

export function selectSiblingSummaries(
  summaries: SelectableSummary[],
  _role: ContextRole,
  budget?: SelectionBudget
): SelectedSummary[] {
  const limit = resolveLimit(SUMMARY_SELECTION_HARD_CAP, budget);
  if (limit === 0 || summaries.length === 0) {
    return [];
  }

  return summaries.sort(compareSummary).slice(0, limit);
}
