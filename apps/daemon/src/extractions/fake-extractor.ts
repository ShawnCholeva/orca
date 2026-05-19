import type { SessionExtractionInput, SessionExtractionOutput } from '@orca/contracts';

export interface SessionMemoryExtractor {
  readonly version: string;
  extract(input: SessionExtractionInput): Promise<SessionExtractionOutput>;
}

export type FakeScript =
  | { kind: 'output'; output: SessionExtractionOutput }
  | { kind: 'error'; message: string };

export class FakeExtractor implements SessionMemoryExtractor {
  readonly version = 'fake-1.0.0';
  private readonly scripts = new Map<string, FakeScript>();

  setOutput(sessionId: string, output: SessionExtractionOutput): void {
    this.scripts.set(sessionId, { kind: 'output', output });
  }

  setError(sessionId: string, message: string): void {
    this.scripts.set(sessionId, { kind: 'error', message });
  }

  async extract(input: SessionExtractionInput): Promise<SessionExtractionOutput> {
    const script = this.scripts.get(input.session.id);
    if (!script) {
      return { memoryCandidates: [], decisionCandidates: [] };
    }
    if (script.kind === 'error') {
      throw new Error(script.message);
    }
    return script.output;
  }
}
