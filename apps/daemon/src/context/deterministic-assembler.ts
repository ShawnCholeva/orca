import type {
  ContextAssemblyInput,
  ContextAssemblyOutput,
  ContextSection,
  ContextSourceRef,
  ContextRole,
} from '@orca/contracts';
import { CONTEXT_PACKAGE_MAX_WARNING_COUNT } from '@orca/contracts';
import type { SessionPreparationAssembler } from './assembler.js';
import {
  selectMemory,
  selectDecisions,
  selectSiblingSummaries,
} from './selection.js';
import type { SelectedMemory, SelectedDecisions, SelectedSummary } from './selection.js';
import type { SelectableDecision } from '@orca/contracts';

export const ASSEMBLER_VERSION = '0.1.0';

type SectionGroupKey =
  | 'objective'
  | 'refinement'
  | 'workspace'
  | 'memory'
  | 'decisions'
  | 'sibling_summaries'
  | 'notes';

const ROLE_ORDER: Record<ContextRole, SectionGroupKey[]> = {
  architect:  ['objective', 'refinement', 'decisions', 'memory', 'sibling_summaries', 'workspace', 'notes'],
  engineer:   ['objective', 'workspace', 'refinement', 'memory', 'decisions', 'sibling_summaries', 'notes'],
  reviewer:   ['objective', 'decisions', 'memory', 'sibling_summaries', 'refinement', 'workspace', 'notes'],
  generalist: ['objective', 'refinement', 'memory', 'decisions', 'sibling_summaries', 'workspace', 'notes'],
};

interface SectionGroup {
  sections: ContextSection[];
  sources: ContextSourceRef[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Section builders — pure functions that produce section + source refs
// ---------------------------------------------------------------------------

function buildObjectiveSection(
  goal: ContextAssemblyInput['goal'],
  objective: string
): { section: ContextSection; sources: ContextSourceRef[] } {
  const marker = `[goal:${goal.id}]`;
  const body = `${marker}\nGoal: ${goal.title}\n\n${objective}\n`;
  return {
    section: { kind: 'objective', title: 'Objective', body, markers: [marker] },
    sources: [{ type: 'goal', id: goal.id, label: 'Goal', reason: 'required', marker }],
  };
}

function buildRefinementSection(
  refinement: NonNullable<ContextAssemblyInput['refinement']>
): { section: ContextSection; sources: ContextSourceRef[] } {
  const marker = `[ref:${refinement.id}]`;
  const lines: string[] = [marker];

  if (refinement.constraints && refinement.constraints.length > 0) {
    lines.push('Constraints:');
    for (const c of refinement.constraints) lines.push(`- ${c}`);
  }
  if (refinement.successCriteria && refinement.successCriteria.length > 0) {
    if (lines.length > 1) lines.push('');
    lines.push('Success Criteria:');
    for (const c of refinement.successCriteria) lines.push(`- ${c}`);
  }

  const body = lines.join('\n') + '\n';
  return {
    section: { kind: 'refinement', title: 'Refinement', body, markers: [marker] },
    sources: [{ type: 'refinement', id: refinement.id, label: 'Refinement', reason: 'required', marker }],
  };
}

function buildWorkspaceSection(
  workspace: NonNullable<NonNullable<ContextAssemblyInput['workspace']>>
): { section: ContextSection; sources: ContextSourceRef[] } {
  const marker = `[ws:${workspace.id}]`;
  const lines: string[] = [
    marker,
    `Name: ${workspace.name}`,
    `Path: ${workspace.pathDisplay}`,
    `Branch: ${workspace.branch ?? '(none)'}`,
  ];
  if (workspace.dirty != null) {
    lines.push(`Status: ${workspace.dirty ? 'dirty' : 'clean'}`);
  }
  const body = lines.join('\n') + '\n';
  const label = workspace.name.slice(0, 64);
  return {
    section: { kind: 'workspace', title: 'Workspace', body, markers: [marker] },
    sources: [{ type: 'workspace', id: workspace.id, label, reason: 'required', marker }],
  };
}

function renderMemoryItems(items: SelectedMemory[]): { body: string; markers: string[]; refs: ContextSourceRef[] } {
  const markers: string[] = [];
  const refs: ContextSourceRef[] = [];
  const lines: string[] = [];

  for (const m of items) {
    const marker = `[mem:${m.id}]`;
    const candidateTag = m.labelAsCandidate ? ' (candidate)' : '';
    markers.push(marker);
    refs.push({
      type: 'memory_item',
      id: m.id,
      sourceSessionId: m.sourceSessionId,
      label: m.type,
      reason: 'role_match',
      marker,
    });
    lines.push(`${marker} [${m.type}]${candidateTag} ${m.content}`);
  }

  return { body: lines.join('\n') + '\n', markers, refs };
}

function buildMemorySection(selected: SelectedMemory[], perSectionMaxBytes: number): SectionGroup {
  if (selected.length === 0) return { sections: [], sources: [], truncated: false };

  let items = [...selected];
  let truncated = false;

  while (items.length > 0) {
    const r = renderMemoryItems(items);
    if (Buffer.byteLength(r.body, 'utf8') <= perSectionMaxBytes) {
      return {
        sections: [{ kind: 'memory', title: 'Memory', body: r.body, markers: r.markers }],
        sources: r.refs,
        truncated,
      };
    }
    items.pop();
    truncated = true;
  }

  return { sections: [], sources: [], truncated };
}

function renderNeedsConfirmationItems(decisions: SelectableDecision[]): {
  body: string;
  markers: string[];
  refs: ContextSourceRef[];
} {
  const markers: string[] = [];
  const refs: ContextSourceRef[] = [];
  const parts: string[] = [];

  for (const d of decisions) {
    const marker = `[dec:${d.id}]`;
    markers.push(marker);
    refs.push({ type: 'decision', id: d.id, label: d.title.slice(0, 64), reason: 'required', marker });
    const lines = [marker, `Title: ${d.title}`, `Decision: ${d.decisionText}`];
    if (d.rationale) lines.push(`Rationale: ${d.rationale}`);
    parts.push(lines.join('\n'));
  }

  return { body: parts.join('\n\n') + '\n', markers, refs };
}

function renderRegularDecisionItems(decisions: SelectableDecision[]): {
  body: string;
  markers: string[];
  refs: ContextSourceRef[];
} {
  const markers: string[] = [];
  const refs: ContextSourceRef[] = [];
  const parts: string[] = [];

  for (const d of decisions) {
    const marker = `[dec:${d.id}]`;
    const confirmedTag = d.status === 'confirmed' ? ' (confirmed)' : '';
    markers.push(marker);
    refs.push({ type: 'decision', id: d.id, label: d.title.slice(0, 64), reason: 'high_confidence', marker });
    const lines = [`${marker}${confirmedTag}`, `Title: ${d.title}`, `Decision: ${d.decisionText}`];
    if (d.rationale) lines.push(`Rationale: ${d.rationale}`);
    parts.push(lines.join('\n'));
  }

  return { body: parts.join('\n\n') + '\n', markers, refs };
}

function buildDecisionsSections(selected: SelectedDecisions, perSectionMaxBytes: number): SectionGroup {
  const sections: ContextSection[] = [];
  const sources: ContextSourceRef[] = [];
  let truncated = false;

  // Confirmation-required decisions: never trimmed
  if (selected.needsConfirmation.length > 0) {
    const r = renderNeedsConfirmationItems(selected.needsConfirmation);
    sections.push({
      kind: 'decisions',
      title: 'Decisions — Needs Confirmation',
      body: r.body,
      markers: r.markers,
    });
    sources.push(...r.refs);
  }

  // Confirmed + proposed: trimmable
  const others = [...selected.confirmed, ...selected.proposed];
  if (others.length > 0) {
    let items = [...others];
    while (items.length > 0) {
      const r = renderRegularDecisionItems(items);
      if (Buffer.byteLength(r.body, 'utf8') <= perSectionMaxBytes) {
        sections.push({ kind: 'decisions', title: 'Decisions', body: r.body, markers: r.markers });
        sources.push(...r.refs);
        break;
      }
      items.pop();
      truncated = true;
    }
    // If all items were dropped, section is omitted (truncated=true already set)
  }

  return { sections, sources, truncated };
}

function renderSummaryItems(items: SelectedSummary[]): {
  body: string;
  markers: string[];
  refs: ContextSourceRef[];
} {
  const markers: string[] = [];
  const refs: ContextSourceRef[] = [];
  const parts: string[] = [];

  for (const s of items) {
    const marker = `[sum:${s.id}]`;
    markers.push(marker);
    refs.push({ type: 'session_summary', id: s.id, label: s.headline.slice(0, 64), reason: 'sibling', marker });
    parts.push(`${marker} ${s.headline}\n${s.summaryText}`);
  }

  return { body: parts.join('\n\n') + '\n', markers, refs };
}

function buildSiblingSection(selected: SelectedSummary[], perSectionMaxBytes: number): SectionGroup {
  if (selected.length === 0) return { sections: [], sources: [], truncated: false };

  let items = [...selected];
  let truncated = false;

  while (items.length > 0) {
    const r = renderSummaryItems(items);
    if (Buffer.byteLength(r.body, 'utf8') <= perSectionMaxBytes) {
      return {
        sections: [{ kind: 'sibling_summaries', title: 'Sibling Sessions', body: r.body, markers: r.markers }],
        sources: r.refs,
        truncated,
      };
    }
    items.pop();
    truncated = true;
  }

  return { sections: [], sources: [], truncated };
}

function buildNotesSection(
  refinement: ContextAssemblyInput['refinement']
): { section: ContextSection | null } {
  if (!refinement?.scopeNotes) return { section: null };
  // scopeNotes is part of refinement, already referenced by [ref:<id>] in Refinement section.
  return {
    section: {
      kind: 'notes',
      title: 'Notes',
      body: refinement.scopeNotes + '\n',
      markers: [],
    },
  };
}

// ---------------------------------------------------------------------------
// DeterministicAssembler
// ---------------------------------------------------------------------------

export class DeterministicAssembler implements SessionPreparationAssembler {
  readonly version = ASSEMBLER_VERSION;

  assemble(input: ContextAssemblyInput): ContextAssemblyOutput {
    const { goal, refinement, workspace, memory, decisions, siblingSummaries, budget, objective, role } = input;
    const { perSectionMaxBytes } = budget;

    // Select from bounded projection sources
    const selectedMemory = selectMemory(memory, role);
    const selectedDecisions = selectDecisions(decisions, role);
    const selectedSummaries = selectSiblingSummaries(siblingSummaries, role);

    // Build section groups
    const objResult = buildObjectiveSection(goal, objective);
    const refResult = refinement ? buildRefinementSection(refinement) : null;
    const wsResult = workspace ? buildWorkspaceSection(workspace) : null;
    const memGroup = buildMemorySection(selectedMemory, perSectionMaxBytes);
    const decGroup = buildDecisionsSections(selectedDecisions, perSectionMaxBytes);
    const sumGroup = buildSiblingSection(selectedSummaries, perSectionMaxBytes);
    const notesResult = buildNotesSection(refinement ?? null);

    const groupMap: Record<SectionGroupKey, SectionGroup> = {
      objective: { sections: [objResult.section], sources: objResult.sources, truncated: false },
      refinement: refResult
        ? { sections: [refResult.section], sources: refResult.sources, truncated: false }
        : { sections: [], sources: [], truncated: false },
      workspace: wsResult
        ? { sections: [wsResult.section], sources: wsResult.sources, truncated: false }
        : { sections: [], sources: [], truncated: false },
      memory: memGroup,
      decisions: decGroup,
      sibling_summaries: sumGroup,
      notes: notesResult.section
        ? { sections: [notesResult.section], sources: [], truncated: false }
        : { sections: [], sources: [], truncated: false },
    };

    // Assemble in role order
    const order = ROLE_ORDER[role] ?? ROLE_ORDER.generalist;
    const allSections: ContextSection[] = [];
    const sourcesByMarker = new Map<string, ContextSourceRef>();
    let anyTruncated = false;

    for (const kind of order) {
      const group = groupMap[kind];
      for (const s of group.sections) allSections.push(s);
      for (const ref of group.sources) {
        if (!sourcesByMarker.has(ref.marker)) sourcesByMarker.set(ref.marker, ref);
      }
      if (group.truncated) anyTruncated = true;
    }

    // Warnings
    const warnings: string[] = [];
    if (!refinement) warnings.push('goal_not_refined');
    if (memory.length > 0 && !memory.some((m) => m.status === 'promoted')) {
      warnings.push('no_promoted_memory');
    }
    if (decisions.length === 0) warnings.push('no_decisions');
    if (siblingSummaries.length === 0) warnings.push('no_sibling_summaries');
    if (anyTruncated) warnings.push('truncated_low_priority');

    // Flags
    const sparse = memory.length === 0 && decisions.length === 0 && siblingSummaries.length === 0;

    // Estimate tokens from section sizes (pre-render approximation)
    let totalBytes = 0;
    for (const s of allSections) {
      totalBytes += Buffer.byteLength(`# ${s.title}\n${s.body}`, 'utf8');
    }
    if (allSections.length > 1) totalBytes += allSections.length - 1; // separating newlines
    totalBytes += 1; // final newline
    const estimatedTokens = Math.ceil(totalBytes / 4);

    return {
      sections: allSections,
      sources: Array.from(sourcesByMarker.values()),
      warnings: warnings.slice(0, CONTEXT_PACKAGE_MAX_WARNING_COUNT),
      truncated: anyTruncated,
      sparse,
      estimatedTokens,
    };
  }
}
