import { describe, expect, it } from 'vitest';
import {
  ContextAssemblyInput,
  ContextAssemblyOutput,
  CONTEXT_PACKAGE_MAX_RENDERED_BYTES,
  type SelectableDecision,
  type SelectableMemory,
  type SelectableSummary,
} from '@orca/contracts';
import { DeterministicAssembler } from '../src/context/deterministic-assembler.js';
import { renderToCanonical } from '../src/context/renderer.js';

function iso(day: number): string {
  return `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;
}

function makeMemory(id: string, overrides: Partial<SelectableMemory> = {}): SelectableMemory {
  return {
    id,
    type: 'constraint',
    status: 'promoted',
    content: `Memory content for ${id}`,
    contentHash: `hash-${id}`,
    confidence: 0.9,
    sourceSessionId: null,
    createdAt: iso(1),
    updatedAt: iso(1),
    ...overrides,
  };
}

function makeDecision(id: string, overrides: Partial<SelectableDecision> = {}): SelectableDecision {
  return {
    id,
    title: `Decision ${id}`,
    decisionText: `Decision text for ${id}`,
    rationale: null,
    status: 'proposed',
    confirmationRequired: false,
    confidence: 0.9,
    sourceSessionId: null,
    createdAt: iso(1),
    confirmedAt: null,
    updatedAt: iso(1),
    ...overrides,
  };
}

function makeSummary(id: string, overrides: Partial<SelectableSummary> = {}): SelectableSummary {
  return {
    id,
    sessionId: `session-${id}`,
    headline: `Session ${id} headline`,
    summaryText: `Session ${id} summary text`,
    truncated: false,
    createdAt: iso(1),
    ...overrides,
  };
}

function makeInput(overrides: Partial<ContextAssemblyInput> = {}): ContextAssemblyInput {
  return ContextAssemblyInput.parse({
    goal: { id: 'goal-1', title: 'Build Feature', status: 'active', archivedAt: null },
    refinement: {
      id: 'goal-1',
      constraints: ['No side effects'],
      successCriteria: ['All tests pass'],
    },
    workspace: {
      id: 'ws-1',
      name: 'main-repo',
      pathDisplay: '/code/main',
      branch: 'main',
      dirty: false,
    },
    role: 'engineer',
    adapterId: 'claude-code',
    objective: 'Implement the feature end-to-end',
    memory: [
      makeMemory('mem-1', { type: 'constraint' }),
      makeMemory('mem-2', { type: 'architecture_note' }),
    ],
    decisions: [
      makeDecision('dec-conf', { confirmationRequired: true, status: 'proposed' }),
      makeDecision('dec-1', { status: 'confirmed', confirmedAt: iso(2) }),
    ],
    siblingSummaries: [makeSummary('sum-1')],
    budget: { maxBytes: 32768, perSectionMaxBytes: 8192, estimatedTokenBudget: 8000 },
    ...overrides,
  });
}

const ROLES = ['architect', 'engineer', 'reviewer', 'generalist'] as const;

const EXPECTED_ORDER_BY_ROLE: Record<string, string[]> = {
  architect:  ['objective', 'refinement', 'decisions', 'decisions', 'memory', 'sibling_summaries', 'workspace'],
  engineer:   ['objective', 'workspace', 'refinement', 'memory', 'decisions', 'decisions', 'sibling_summaries'],
  reviewer:   ['objective', 'decisions', 'decisions', 'memory', 'sibling_summaries', 'refinement', 'workspace'],
  generalist: ['objective', 'refinement', 'memory', 'decisions', 'decisions', 'sibling_summaries', 'workspace'],
};

describe('DeterministicAssembler', () => {
  const assembler = new DeterministicAssembler();

  it('version is 0.1.0', () => {
    expect(assembler.version).toBe('0.1.0');
  });

  describe('role-aware section ordering', () => {
    for (const role of ROLES) {
      it(`${role} sections are in the correct order`, () => {
        const input = makeInput({ role });
        const output = assembler.assemble(input);
        const kinds = output.sections.map((s) => s.kind);
        expect(kinds).toEqual(EXPECTED_ORDER_BY_ROLE[role]);
      });
    }

    it('section bodies are identical across roles for the same input', () => {
      const outputs = ROLES.map((role) => assembler.assemble(makeInput({ role })));

      // Collect body by section title from each role output
      const bodyByTitle = (idx: number) =>
        Object.fromEntries(outputs[idx]!.sections.map((s) => [s.title, s.body]));

      const ref = bodyByTitle(0);
      for (let i = 1; i < ROLES.length; i++) {
        const cur = bodyByTitle(i);
        for (const [title, body] of Object.entries(ref)) {
          if (title in cur) {
            expect(cur[title]).toBe(body);
          }
        }
      }
    });
  });

  describe('markers and source refs', () => {
    it('markers map 1:1 to sources — no dangling marker, no dangling source', () => {
      const output = assembler.assemble(makeInput());

      const allMarkers = new Set<string>();
      for (const section of output.sections) {
        for (const m of section.markers) allMarkers.add(m);
      }

      const sourceMarkers = new Set(output.sources.map((s) => s.marker));

      // Every section marker has a source
      for (const m of allMarkers) {
        expect(sourceMarkers, `marker ${m} has no source`).toContain(m);
      }

      // Every source marker appears in a section
      for (const m of sourceMarkers) {
        expect(allMarkers, `source marker ${m} appears in no section`).toContain(m);
      }
    });

    it('each marker appears in the section body where it is listed', () => {
      const output = assembler.assemble(makeInput());
      for (const section of output.sections) {
        for (const marker of section.markers) {
          expect(section.body).toContain(marker);
        }
      }
    });
  });

  describe('sparse flag', () => {
    it('sparse=true when input has no memory, decisions, or sibling summaries', () => {
      const output = assembler.assemble(
        makeInput({ memory: [], decisions: [], siblingSummaries: [] })
      );
      expect(output.sparse).toBe(true);
    });

    it('sparse=false when input has any memory', () => {
      const output = assembler.assemble(makeInput({ decisions: [], siblingSummaries: [] }));
      expect(output.sparse).toBe(false);
    });
  });

  describe('truncated flag', () => {
    it('truncated=true when low-priority items are dropped to fit per-section cap', () => {
      // Many large memory items — all promoted so they compete for space
      const bigMemory = Array.from({ length: 5 }, (_, i) =>
        makeMemory(`mem-big-${i}`, {
          type: 'assumption',
          content: 'x'.repeat(2000),
        })
      );
      const output = assembler.assemble(
        makeInput({ memory: bigMemory, budget: { maxBytes: 32768, perSectionMaxBytes: 3000, estimatedTokenBudget: 8000 } })
      );
      expect(output.truncated).toBe(true);
      expect(output.warnings).toContain('truncated_low_priority');
    });

    it('truncated=false when all items fit within section cap', () => {
      const output = assembler.assemble(makeInput());
      expect(output.truncated).toBe(false);
    });
  });

  describe('confirmation-required decision pinning', () => {
    it('confirmation-required decisions are never dropped even under tight budget', () => {
      const bigMemory = Array.from({ length: 10 }, (_, i) =>
        makeMemory(`mem-big-${i}`, { content: 'x'.repeat(1000) })
      );
      const confirmedDec = makeDecision('dec-conf', {
        confirmationRequired: true,
        status: 'proposed',
        decisionText: 'Must use this approach',
      });
      const output = assembler.assemble(
        makeInput({
          memory: bigMemory,
          decisions: [confirmedDec],
          budget: { maxBytes: 32768, perSectionMaxBytes: 2000, estimatedTokenBudget: 8000 },
        })
      );

      const confSection = output.sections.find(
        (s) => s.title === 'Decisions — Needs Confirmation'
      );
      expect(confSection).toBeDefined();
      expect(confSection!.body).toContain('dec-conf');
    });

    it('output_too_large path: confirmation block content alone can exceed 32 KiB', () => {
      // 10 confirmation-required decisions × ~3.9 KiB decisionText each ≈ 39 KiB
      const bigConfDecs = Array.from({ length: 10 }, (_, i) =>
        makeDecision(`dec-big-${i}`, {
          confirmationRequired: true,
          status: 'proposed',
          decisionText: 'y'.repeat(3900),
        })
      );
      const output = assembler.assemble(
        makeInput({ decisions: bigConfDecs, memory: [], siblingSummaries: [] })
      );

      // Assembler never drops confirmation-required items; global cap caught by usecases.ts
      const { renderedBytes } = renderToCanonical(output.sections);
      expect(renderedBytes).toBeGreaterThan(CONTEXT_PACKAGE_MAX_RENDERED_BYTES);

      // Confirmation section is present and intact
      const confSection = output.sections.find(
        (s) => s.title === 'Decisions — Needs Confirmation'
      );
      expect(confSection).toBeDefined();
      expect(confSection!.markers).toHaveLength(bigConfDecs.length);
    });
  });

  describe('warnings', () => {
    it('warns goal_not_refined when no refinement', () => {
      const output = assembler.assemble(makeInput({ refinement: null }));
      expect(output.warnings).toContain('goal_not_refined');
    });

    it('warns no_decisions when input has no decisions', () => {
      const output = assembler.assemble(makeInput({ decisions: [] }));
      expect(output.warnings).toContain('no_decisions');
    });

    it('warns no_sibling_summaries when input has none', () => {
      const output = assembler.assemble(makeInput({ siblingSummaries: [] }));
      expect(output.warnings).toContain('no_sibling_summaries');
    });

    it('warns no_promoted_memory when input has memory but none promoted', () => {
      const candidateOnly = [makeMemory('m1', { status: 'candidate', confidence: 0.8 })];
      const output = assembler.assemble(makeInput({ memory: candidateOnly }));
      expect(output.warnings).toContain('no_promoted_memory');
    });

    it('does not warn no_promoted_memory when there is no memory at all', () => {
      const output = assembler.assemble(makeInput({ memory: [] }));
      expect(output.warnings).not.toContain('no_promoted_memory');
    });
  });

  describe('zod schema validation', () => {
    it('output passes ContextAssemblyOutput schema for all roles', () => {
      for (const role of ROLES) {
        const output = assembler.assemble(makeInput({ role }));
        const result = ContextAssemblyOutput.safeParse(output);
        expect(result.success, `role=${role} failed: ${!result.success ? JSON.stringify((result as { error: unknown }).error) : ''}`).toBe(true);
      }
    });

    it('output passes schema when sparse', () => {
      const output = assembler.assemble(
        makeInput({ memory: [], decisions: [], siblingSummaries: [] })
      );
      const result = ContextAssemblyOutput.safeParse(output);
      expect(result.success).toBe(true);
    });
  });

  describe('documents section', () => {
    const makeDoc = (id: string, content = `Body of ${id}`) => ({
      id,
      name: `${id}.md`,
      kind: 'file' as const,
      ref: `/docs/${id}.md`,
      content,
      contentHash: `hash-${id}`,
    });

    it('renders a Reference Documents section with [doc:] markers and document source refs', () => {
      const output = assembler.assemble(makeInput({ documents: [makeDoc('d1'), makeDoc('d2')] }));
      const section = output.sections.find((s) => s.kind === 'documents');
      expect(section).toBeDefined();
      expect(section!.title).toBe('Reference Documents');
      expect(section!.body).toContain('[doc:d1] d1.md (source: /docs/d1.md)');
      expect(section!.body).toContain('Body of d2');
      expect(section!.markers).toEqual(['[doc:d1]', '[doc:d2]']);
      const refs = output.sources.filter((s) => s.type === 'document');
      expect(refs.map((r) => r.id)).toEqual(['d1', 'd2']);
      expect(refs[0]!.reason).toBe('required');
    });

    it('places documents immediately after refinement for the engineer role', () => {
      const output = assembler.assemble(makeInput({ role: 'engineer', documents: [makeDoc('d1')] }));
      const kinds = output.sections.map((s) => s.kind);
      expect(kinds.indexOf('documents')).toBe(kinds.indexOf('refinement') + 1);
    });

    it('omits the section when there are no documents', () => {
      const output = assembler.assemble(makeInput());
      expect(output.sections.some((s) => s.kind === 'documents')).toBe(false);
    });

    it('over budget: trims content but keeps every doc as a name+ref handle, warns truncated_low_priority', () => {
      const big = 'z'.repeat(6 * 1024);
      const docs = [makeDoc('d1', big), makeDoc('d2', big), makeDoc('d3', big)];
      const output = assembler.assemble(makeInput({ documents: docs }));
      const section = output.sections.find((s) => s.kind === 'documents');
      expect(section).toBeDefined();
      expect(Buffer.byteLength(section!.body, 'utf8')).toBeLessThanOrEqual(8 * 1024);
      // every doc still present by marker — never silently dropped
      expect(section!.markers).toEqual(['[doc:d1]', '[doc:d2]', '[doc:d3]']);
      expect(section!.body).toMatch(/\[truncated — see \/docs\/d\d\.md\]|\[content omitted — read at source\]/);
      expect(output.truncated).toBe(true);
      expect(output.warnings).toContain('truncated_low_priority');
    });

    it('output passes schema with documents present', () => {
      const output = assembler.assemble(makeInput({ documents: [makeDoc('d1')] }));
      expect(ContextAssemblyOutput.safeParse(output).success).toBe(true);
    });
  });
});
