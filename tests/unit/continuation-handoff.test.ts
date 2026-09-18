import { describe, expect, it } from 'vitest';
import { buildContinuationHandoff, MAX_WORDS } from '../../scripts/agent/docs/continuation-handoff';

const input = {
  objective: 'Ship a small deterministic tool.',
  successGate: 'The tool has focused coverage.',
  completed: 'Selected the existing token telemetry parser.',
  validation: 'Focused tests pass.',
  blockers: 'None.',
  nextStep: 'Open a fresh continuation thread.',
  branch: 'codex/continuation',
  base: 'main',
  changedFiles: ['scripts/tool.ts'],
  telemetry: { firstRequestInputTokens: 101, inputTokens: 303 },
};

describe('continuation handoff', () => {
  it('renders every continuation field and rollout telemetry', () => {
    const output = buildContinuationHandoff(input);
    for (const heading of [
      'Objective / Success Gate',
      'Git State',
      'Completed Decisions',
      'Validation Evidence',
      'Unresolved Blockers',
      'Next Concrete Step',
      'Rollout Telemetry',
    ])
      expect(output).toContain(heading);
    expect(output).toContain('First request input: 101 tokens');
    expect(output).toContain('Cumulative input: 303 tokens');
  });

  it('rejects missing required facts and output over the word cap', () => {
    expect(() => buildContinuationHandoff({ ...input, nextStep: '' })).toThrow(
      'Missing required --next-step',
    );
    expect(() =>
      buildContinuationHandoff({ ...input, objective: 'word '.repeat(MAX_WORDS + 1) }),
    ).toThrow(`maximum is ${MAX_WORDS}`);
  });
});
