import { z } from 'zod';
import {
  ProposedAction,
  RecommendationType,
  RecommendationSourceRef,
  ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS,
  ORCHESTRATION_RECOMMENDATION_MAX_RATIONALE_CHARS,
  ORCHESTRATION_RECOMMENDATION_MAX_SOURCES,
  ORCHESTRATION_RECOMMENDATION_MAX_PROPOSED_ACTION_BYTES,
} from '@orca/contracts';
import type { RecommendationInput } from './input.js';
import type { RecommendationCandidate } from './rules.js';
import {
  refineGoalRule,
  createSessionRule,
  continueSessionRule,
  splitTaskRule,
  updatePlanRule,
  askUserRule,
  markCompleteRule,
  pauseWorkRule,
  runValidationRule,
  reviewOutputRule,
} from './rules.js';
import { recommendationFingerprint, canonicalizeProposedActionJson } from './fingerprint.js';

// ── Output schema ──────────────────────────────────────────────────────────────

export const RecommendationProviderOutputSchema = z
  .object({
    candidates: z
      .array(
        z.object({
          type: RecommendationType,
          title: z.string().trim().min(1).max(ORCHESTRATION_RECOMMENDATION_MAX_TITLE_CHARS),
          rationale: z.string().max(ORCHESTRATION_RECOMMENDATION_MAX_RATIONALE_CHARS),
          proposedAction: ProposedAction,
          confidence: z.number().min(0).max(1),
          sources: z.array(RecommendationSourceRef).max(ORCHESTRATION_RECOMMENDATION_MAX_SOURCES),
          relatedTaskId: z.string().optional(),
          relatedSessionId: z.string().optional(),
          relatedContextPackageId: z.string().optional(),
          relatedConflictId: z.string().optional(),
        })
      )
      .max(10),
    warnings: z.array(z.string()),
    sparse: z.boolean(),
  })
  .strict()
  .superRefine((val, ctx) => {
    for (let i = 0; i < val.candidates.length; i++) {
      const c = val.candidates[i];
      // type must match proposedAction.kind
      if (c.type !== c.proposedAction.kind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `candidates[${i}]: type '${c.type}' does not match proposedAction.kind '${c.proposedAction.kind}'`,
        });
      }
      // proposedAction JSON size cap
      const actionJson = JSON.stringify(c.proposedAction);
      if (new TextEncoder().encode(actionJson).length > ORCHESTRATION_RECOMMENDATION_MAX_PROPOSED_ACTION_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `candidates[${i}]: proposedAction exceeds ${ORCHESTRATION_RECOMMENDATION_MAX_PROPOSED_ACTION_BYTES} bytes`,
        });
      }
    }
  });

export type RecommendationProviderOutput = z.infer<typeof RecommendationProviderOutputSchema>;

// ── Interface ──────────────────────────────────────────────────────────────────

export interface RecommendationProvider {
  readonly id: string;
  readonly version: string;
  generate(input: RecommendationInput): Promise<RecommendationProviderOutput>;
}

// ── Candidate dedup within a single generation ────────────────────────────────

function candidateFingerprint(goalId: string, candidate: RecommendationCandidate): string {
  const canonical = canonicalizeProposedActionJson(JSON.stringify(candidate.proposedAction));
  return recommendationFingerprint(goalId, candidate.type, canonical);
}

// ── Deterministic provider ─────────────────────────────────────────────────────

const MAX_CANDIDATES = 10;

export class DeterministicRecommendationProvider implements RecommendationProvider {
  readonly id = 'orca/deterministic-recommendation-provider';
  readonly version = '0.1.0';

  async generate(input: RecommendationInput): Promise<RecommendationProviderOutput> {
    const all: RecommendationCandidate[] = [
      ...refineGoalRule(input),
      ...createSessionRule(input),
      ...continueSessionRule(input),
      ...splitTaskRule(input),
      ...updatePlanRule(input),
      ...askUserRule(input),
      ...markCompleteRule(input),
      ...pauseWorkRule(input),
      ...runValidationRule(input),
      ...reviewOutputRule(input),
    ];

    // Dedup within this generation by recommendation fingerprint
    const seen = new Set<string>();
    const deduped: RecommendationCandidate[] = [];
    for (const c of all) {
      const fp = candidateFingerprint(input.goalId, c);
      if (!seen.has(fp)) {
        seen.add(fp);
        deduped.push(c);
      }
    }

    const warnings: string[] = [];
    let candidates = deduped;
    if (candidates.length > MAX_CANDIDATES) {
      warnings.push(
        `Dropped ${candidates.length - MAX_CANDIDATES} excess candidates (limit ${MAX_CANDIDATES})`
      );
      candidates = candidates.slice(0, MAX_CANDIDATES);
    }

    const sparse = candidates.length === 0;

    return RecommendationProviderOutputSchema.parse({ candidates, warnings, sparse });
  }
}

// ── Fake provider for tests ────────────────────────────────────────────────────

export class FakeRecommendationProvider implements RecommendationProvider {
  readonly id = 'orca/fake-recommendation-provider';
  readonly version = '0.1.0';

  private _fixtures: RecommendationCandidate[] = [];
  private _sparse = false;
  private _error: Error | null = null;

  setFixtures(fixtures: RecommendationCandidate[]): void {
    this._fixtures = fixtures;
  }

  setSparse(sparse: boolean): void {
    this._sparse = sparse;
  }

  setError(err: Error): void {
    this._error = err;
  }

  async generate(_input: RecommendationInput): Promise<RecommendationProviderOutput> {
    if (this._error) throw this._error;
    return {
      candidates: this._fixtures,
      warnings: [],
      sparse: this._sparse || this._fixtures.length === 0,
    };
  }
}
