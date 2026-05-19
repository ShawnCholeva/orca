import type {
  DecisionCandidate,
  MemoryCandidate,
  SessionExtractionInput,
  SessionExtractionOutput,
} from '@orca/contracts';
import type { SessionMemoryExtractor } from './fake-extractor.js';

export const DETERMINISTIC_EXTRACTOR_VERSION = 'deterministic-1.0.0';

const MAX_SUMMARY_LINES = 10;
const EXIT_BLOCKER_WINDOW_BYTES = 1024;
const VALIDATION_WINDOW_BYTES = 2048;
const MAX_FATAL_BLOCKERS = 5;
const MAX_TODO_QUESTIONS = 5;
const MAX_LINE_QUESTIONS = 5;
const MAX_DECISIONS = 5;
const MAX_MEMORY_CANDIDATES = 25;
const MAX_DECISION_CANDIDATES = 10;

interface LineRange {
  raw: string;
  clean: string;
  startChar: number;
  endChar: number;
}

export class DeterministicExtractor implements SessionMemoryExtractor {
  readonly version = DETERMINISTIC_EXTRACTOR_VERSION;

  async extract(input: SessionExtractionInput): Promise<SessionExtractionOutput> {
    const outputText = typeof input.outputTail.text === 'string' ? input.outputTail.text : '';
    const lines = splitLines(outputText);

    const memoryCandidates: MemoryCandidate[] = [];
    const decisionCandidates: DecisionCandidate[] = [];

    const summaryLines = lines
      .map((line) => sanitizeLine(line.raw))
      .filter((line) => line.length > 0)
      .slice(-MAX_SUMMARY_LINES);

    const status = deriveStatus(input.session.exitCode, input.session.terminalReason);
    const duration = deriveDuration(input.session.startedAt, input.session.terminatedAt);

    const summaryText =
      summaryLines.length > 0
        ? summaryLines.join('\n')
        : `Session ${status} in ${duration}. No terminal output captured.`;

    const summary = {
      headline: truncateText(`${input.session.adapterId} ${status} in ${duration}`, 200),
      text: truncateText(summaryText, 4000),
      truncated: input.outputTail.truncated,
    };

    if (input.session.exitCode !== null && input.session.exitCode !== 0) {
      const window = trailingWindow(
        input.outputTail.byteOffsetFirst,
        input.outputTail.byteOffsetLast,
        EXIT_BLOCKER_WINDOW_BYTES,
      );
      const reasonSuffix = input.session.terminalReason ? `: ${input.session.terminalReason}` : '';
      addMemoryCandidate(memoryCandidates, {
        type: 'blocker',
        content: truncateText(`Session exited with code ${input.session.exitCode}${reasonSuffix}`, 4000),
        confidence: 0.95,
        confirmationRequired: false,
        sourceOffsetFirst: window.first,
        sourceOffsetLast: window.last,
      });
    }

    const seenFatalLines = new Set<string>();
    for (const line of lines) {
      if (memoryCandidates.length >= MAX_MEMORY_CANDIDATES || seenFatalLines.size >= MAX_FATAL_BLOCKERS) {
        break;
      }
      const match = /(?:^|\W)(ERROR|FATAL):?\s+(.+)$/.exec(line.clean);
      if (!match) continue;

      const key = line.clean.toLowerCase();
      if (seenFatalLines.has(key)) continue;
      seenFatalLines.add(key);

      const matchStart = line.startChar + (match.index ?? 0);
      const matchEnd = matchStart + match[0].length;
      const offsets = toSourceOffsets(input, outputText, matchStart, matchEnd);

      addMemoryCandidate(memoryCandidates, {
        type: 'blocker',
        content: truncateText(line.clean, 4000),
        confidence: 0.7,
        sourceOffsetFirst: offsets.first,
        sourceOffsetLast: offsets.last,
      });
    }

    const seenOpenQuestions = new Set<string>();
    let todoCount = 0;
    for (const line of lines) {
      if (memoryCandidates.length >= MAX_MEMORY_CANDIDATES || todoCount >= MAX_TODO_QUESTIONS) {
        break;
      }
      const match = /(?:TODO|FIXME)[:\s]+(.+)$/.exec(line.clean);
      if (!match) continue;

      const content = truncateText(match[1].trim(), 4000);
      const key = content.toLowerCase();
      if (!content || seenOpenQuestions.has(key)) continue;

      seenOpenQuestions.add(key);
      todoCount++;

      const matchStart = line.startChar + (match.index ?? 0);
      const matchEnd = matchStart + match[0].length;
      const offsets = toSourceOffsets(input, outputText, matchStart, matchEnd);

      addMemoryCandidate(memoryCandidates, {
        type: 'open_question',
        content,
        confidence: 0.5,
        sourceOffsetFirst: offsets.first,
        sourceOffsetLast: offsets.last,
      });
    }

    let questionLineCount = 0;
    for (const line of lines) {
      if (memoryCandidates.length >= MAX_MEMORY_CANDIDATES || questionLineCount >= MAX_LINE_QUESTIONS) {
        break;
      }
      if (!line.clean.endsWith('?')) continue;

      const content = truncateText(line.clean, 4000);
      const key = content.toLowerCase();
      if (!content || seenOpenQuestions.has(key)) continue;

      seenOpenQuestions.add(key);
      questionLineCount++;

      const offsets = toSourceOffsets(input, outputText, line.startChar, line.endChar);

      addMemoryCandidate(memoryCandidates, {
        type: 'open_question',
        content,
        confidence: 0.5,
        sourceOffsetFirst: offsets.first,
        sourceOffsetLast: offsets.last,
      });
    }

    if (input.session.exitCode === 0) {
      const textBytes = Buffer.from(outputText, 'utf8');
      const tailBytes =
        textBytes.length > VALIDATION_WINDOW_BYTES
          ? textBytes.subarray(textBytes.length - VALIDATION_WINDOW_BYTES)
          : textBytes;
      const tailText = tailBytes.toString('utf8');

      if (/(PASS|OK|SUCCESS|tests? passed)\b/i.test(tailText)) {
        const window = trailingWindow(
          input.outputTail.byteOffsetFirst,
          input.outputTail.byteOffsetLast,
          VALIDATION_WINDOW_BYTES,
        );

        addMemoryCandidate(memoryCandidates, {
          type: 'validation_result',
          content: 'Validation signal detected after clean session completion.',
          confidence: 0.9,
          confirmationRequired: false,
          sourceOffsetFirst: window.first,
          sourceOffsetLast: window.last,
        });
      }
    }

    for (const line of lines) {
      if (decisionCandidates.length >= MAX_DECISIONS || decisionCandidates.length >= MAX_DECISION_CANDIDATES) {
        break;
      }
      const match = /^\s*(?:DECISION|DECIDED)[:\s]+(.+)$/.exec(line.clean);
      if (!match) continue;

      const decisionText = truncateText(line.clean, 4000);
      const offsets = toSourceOffsets(input, outputText, line.startChar, line.endChar);

      const candidate: DecisionCandidate = {
        title: truncateText(decisionText, 80),
        decisionText,
        confirmationRequired: true,
        confidence: 0.6,
        sourceOffsetFirst: offsets.first,
        sourceOffsetLast: offsets.last,
      };
      decisionCandidates.push(candidate);
    }

    return {
      summary,
      memoryCandidates: memoryCandidates.slice(0, MAX_MEMORY_CANDIDATES),
      decisionCandidates: decisionCandidates.slice(0, MAX_DECISION_CANDIDATES),
    };
  }
}

function splitLines(text: string): LineRange[] {
  const ranges: LineRange[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n') continue;

    const end = i > start && text[i - 1] === '\r' ? i - 1 : i;
    const raw = text.slice(start, end);
    ranges.push({
      raw,
      clean: sanitizeLine(raw),
      startChar: start,
      endChar: end,
    });
    start = i + 1;
  }

  if (start <= text.length) {
    const raw = text.slice(start);
    ranges.push({
      raw,
      clean: sanitizeLine(raw),
      startChar: start,
      endChar: text.length,
    });
  }

  return ranges;
}

function sanitizeLine(line: string): string {
  return line
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trim();
}

function deriveStatus(exitCode: number | null, terminalReason: string | null): string {
  if (exitCode === 0) return 'succeeded';
  if (exitCode !== null) return `failed (exit ${exitCode})`;
  if (terminalReason) return `ended (${terminalReason})`;
  return 'ended';
}

function deriveDuration(startedAt: string | null, terminatedAt: string | null): string {
  if (!startedAt || !terminatedAt) {
    return 'unknown duration';
  }

  const started = Date.parse(startedAt);
  const terminated = Date.parse(terminatedAt);
  if (!Number.isFinite(started) || !Number.isFinite(terminated) || terminated < started) {
    return 'unknown duration';
  }

  const seconds = Math.floor((terminated - started) / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  if (minutes < 60) return remainSeconds > 0 ? `${minutes}m ${remainSeconds}s` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
}

function trailingWindow(first: number, last: number, size: number): { first: number; last: number } {
  if (last <= first) return { first, last };
  const nextFirst = Math.max(first, last - size);
  return { first: nextFirst, last };
}

function toSourceOffsets(
  input: SessionExtractionInput,
  text: string,
  startChar: number,
  endChar: number,
): { first: number; last: number } {
  const boundedStart = Math.max(0, Math.min(startChar, text.length));
  const boundedEnd = Math.max(boundedStart, Math.min(endChar, text.length));

  const startByteDelta = Buffer.byteLength(text.slice(0, boundedStart), 'utf8');
  const endByteDelta = Buffer.byteLength(text.slice(0, boundedEnd), 'utf8');

  const first = input.outputTail.byteOffsetFirst + startByteDelta;
  const last = input.outputTail.byteOffsetFirst + endByteDelta;

  return {
    first: Math.max(input.outputTail.byteOffsetFirst, Math.min(first, input.outputTail.byteOffsetLast)),
    last: Math.max(input.outputTail.byteOffsetFirst, Math.min(last, input.outputTail.byteOffsetLast)),
  };
}

function addMemoryCandidate(
  target: MemoryCandidate[],
  candidate: Omit<MemoryCandidate, 'promoteEligible'> & { promoteEligible?: boolean },
): void {
  if (target.length >= MAX_MEMORY_CANDIDATES) {
    return;
  }
  target.push({
    ...candidate,
    promoteEligible: candidate.promoteEligible ?? false,
  });
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}
