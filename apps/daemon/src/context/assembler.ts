import type { ContextAssemblyInput, ContextAssemblyOutput } from '@orca/contracts';

export interface SessionPreparationAssembler {
  readonly version: string;
  assemble(input: ContextAssemblyInput): ContextAssemblyOutput;
}

type FakeOverride = 'output_too_large' | 'invalid_output' | 'internal_error' | null;

/**
 * Test double for SessionPreparationAssembler.
 * Returns a fixed two-source, one-warning output by default.
 * Use simulateFailure() to drive error paths.
 */
export class FakeContextAssembler implements SessionPreparationAssembler {
  readonly version = '0.1.0-fake';
  private _override: FakeOverride = null;

  simulateFailure(mode: NonNullable<FakeOverride>): void {
    this._override = mode;
  }

  resetOverride(): void {
    this._override = null;
  }

  assemble(_input: ContextAssemblyInput): ContextAssemblyOutput {
    if (this._override === 'internal_error') {
      throw new Error('fake internal error');
    }
    if (this._override === 'invalid_output') {
      return { invalid: 'data' } as unknown as ContextAssemblyOutput;
    }
    if (this._override === 'output_too_large') {
      return {
        sections: [
          {
            kind: 'objective',
            title: 'Objective',
            // 33 KiB body forces renderedBytes > 32768 after rendering
            body: 'x'.repeat(33 * 1024),
            markers: [],
          },
        ],
        sources: [],
        warnings: [],
        truncated: false,
        sparse: false,
        estimatedTokens: 9000,
      };
    }
    // Normal path: 2 sources, 1 warning
    return {
      sections: [
        {
          kind: 'objective',
          title: 'Objective',
          body: 'Implement the feature\n',
          markers: ['[goal:fake-goal]'],
        },
        {
          kind: 'memory',
          title: 'Memory',
          body: 'Key constraint: no side effects\n',
          markers: ['[mem:fake-mem]'],
        },
      ],
      sources: [
        {
          type: 'goal',
          id: 'fake-goal',
          label: 'Goal',
          reason: 'required',
          marker: '[goal:fake-goal]',
        },
        {
          type: 'memory_item',
          id: 'fake-mem',
          label: 'Constraint',
          reason: 'role_match',
          marker: '[mem:fake-mem]',
        },
      ],
      warnings: ['goal_not_refined'],
      truncated: false,
      sparse: false,
      estimatedTokens: 15,
    };
  }
}
