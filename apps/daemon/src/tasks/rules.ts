import { z } from 'zod';
import {
  M7_TASK_MAX_DESCRIPTION_CHARS,
  M7_TASK_MAX_SOURCES,
  M7_TASK_MAX_TITLE_CHARS,
  TaskRole,
  TaskSourceRef,
  type TaskRole as TaskRoleType,
} from '@orca/contracts';
import { taskFingerprint } from './fingerprint.js';
import type { TaskGenerationInput } from './input.js';

const TASK_CANDIDATE_MAX_COUNT = 20;
const TASK_TITLE_FROM_ITEM_MAX_CHARS = 80;

const TaskCandidate = z
  .object({
    title: z.string().trim().min(1).max(M7_TASK_MAX_TITLE_CHARS),
    description: z.string().max(M7_TASK_MAX_DESCRIPTION_CHARS),
    role: TaskRole,
    workspaceId: z.string().nullable(),
    sources: z.array(TaskSourceRef).max(M7_TASK_MAX_SOURCES),
  })
  .strict();

export type TaskCandidate = z.infer<typeof TaskCandidate>;

export const TaskGenerationOutputSchema = z
  .object({
    candidates: z.array(TaskCandidate).max(TASK_CANDIDATE_MAX_COUNT),
    sparse: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict();

export type TaskGenerationOutput = z.infer<typeof TaskGenerationOutputSchema>;

export interface TaskGenerator {
  readonly id: string;
  readonly version: string;
  generate(input: TaskGenerationInput): Promise<TaskGenerationOutput>;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function splitCriteriaIntoUnits(successCriteria: string[]): string[] {
  const chunks: string[] = [];
  for (const criterion of successCriteria) {
    const normalized = criterion.replace(/\r\n/g, '\n');
    const pieces = normalized.split(/(?:\n|;|\band then\b)/gi);
    for (const piece of pieces) {
      const unit = collapseWhitespace(piece);
      if (unit.length > 0) chunks.push(unit);
    }
  }
  return chunks;
}

function classifyRole(text: string): TaskRoleType {
  const normalized = text.toLowerCase();
  if (/\b(implement|build|add|create|fix|refactor)\b/.test(normalized)) {
    return 'engineer';
  }
  if (/\b(review|audit)\b/.test(normalized) || /\bverify\s+diff\b/.test(normalized)) {
    return 'reviewer';
  }
  if (/\b(design|plan|architect|spec)\b/.test(normalized)) {
    return 'architect';
  }
  if (/\b(verify|test|validate|qa)\b/.test(normalized)) {
    return 'qa';
  }
  return 'generalist';
}

function toCandidate(
  input: TaskGenerationInput,
  unit: string,
  reason: 'driver' | 'objective_only'
): TaskCandidate {
  const title = collapseWhitespace(unit).slice(0, TASK_TITLE_FROM_ITEM_MAX_CHARS);
  const description = unit.slice(0, M7_TASK_MAX_DESCRIPTION_CHARS);
  const role = classifyRole(unit);
  const workspaceId = input.workspaces.length === 1 ? input.workspaces[0].id : null;
  const sources = input.refinement
    ? [{ type: 'refinement' as const, id: input.refinement.id, reason }]
    : [];

  return TaskCandidate.parse({
    title,
    description,
    role,
    workspaceId,
    sources,
  });
}

export function generateTasks(input: TaskGenerationInput): TaskGenerationOutput {
  const warnings: string[] = [];
  const existingFingerprints = new Set(
    input.existingGeneratorTasks.map((task) => task.fingerprint)
  );

  const units = input.refinement
    ? splitCriteriaIntoUnits(input.refinement.successCriteria)
    : [];

  const candidates: TaskCandidate[] = [];

  for (const unit of units) {
    const candidate = toCandidate(input, unit, 'driver');
    const fingerprint = taskFingerprint(input.goalId, candidate.title, candidate.role);
    if (existingFingerprints.has(fingerprint)) {
      continue;
    }
    candidates.push(candidate);
    existingFingerprints.add(fingerprint);
  }

  if (candidates.length === 0 && input.refinement && input.objective.length > 0) {
    const objectiveCandidate = toCandidate(input, input.objective, 'objective_only');
    const fingerprint = taskFingerprint(
      input.goalId,
      objectiveCandidate.title,
      objectiveCandidate.role
    );
    if (!existingFingerprints.has(fingerprint)) {
      candidates.push(objectiveCandidate);
    }
  }

  const sparse = candidates.length === 0;
  const trimmedCandidates = candidates.slice(0, TASK_CANDIDATE_MAX_COUNT);
  if (candidates.length > trimmedCandidates.length) {
    warnings.push(`truncated task candidates to ${TASK_CANDIDATE_MAX_COUNT}`);
  }

  return TaskGenerationOutputSchema.parse({
    candidates: trimmedCandidates,
    sparse,
    warnings,
  });
}

export class DeterministicTaskGenerator implements TaskGenerator {
  readonly id = 'orca/deterministic-task-generator';
  readonly version = '0.1.0';

  async generate(input: TaskGenerationInput): Promise<TaskGenerationOutput> {
    return generateTasks(input);
  }
}

export class FakeTaskGenerator implements TaskGenerator {
  readonly id: string;
  readonly version: string;
  private readonly impl: (input: TaskGenerationInput) => Promise<TaskGenerationOutput>;

  constructor(
    output:
      | TaskGenerationOutput
      | ((input: TaskGenerationInput) => Promise<TaskGenerationOutput> | TaskGenerationOutput),
    id = 'test/fake-task-generator',
    version = '0.0.0'
  ) {
    this.id = id;
    this.version = version;
    this.impl = async (input) => {
      if (typeof output === 'function') {
        return await output(input);
      }
      return output;
    };
  }

  async generate(input: TaskGenerationInput): Promise<TaskGenerationOutput> {
    return this.impl(input);
  }
}

