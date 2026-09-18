import { describe, expect, it } from 'vitest';

import {
  TASK_ROUTES,
  parseArgs,
  renderRecommendation,
  routeTask,
} from '../../scripts/agent/task-routing';

describe('task routing policy', () => {
  it.each([
    ['narrow-telemetry-report', 'gpt-5.6-luna', 'low', 3],
    ['routine-tooling-docs', 'gpt-5.6-terra', 'low', 5],
    ['bounded-implementation', 'gpt-5.6-terra', 'medium', 8],
  ] as const)('maps %s to the low-cost baseline', (taskClass, model, reasoningEffort, loops) => {
    expect(TASK_ROUTES[taskClass]).toMatchObject({
      model,
      reasoningEffort,
      maxModelToolLoops: loops,
    });
  });

  it('permits Sol only for an evidence-backed escalation and caps it at ten loops', () => {
    expect(() => routeTask({ taskClass: 'complex-escalated' })).toThrow(/requires recorded/i);
    expect(
      routeTask({ taskClass: 'complex-escalated', evidence: 'PR #42: Terra exhausted 8 loops.' }),
    ).toMatchObject({
      evidence: 'PR #42: Terra exhausted 8 loops.',
      route: { model: 'gpt-5.6-sol', maxModelToolLoops: 10 },
    });
  });

  it('rejects invalid and incomplete CLI input', () => {
    expect(() => parseArgs([])).toThrow(/Missing required --class/);
    expect(() => parseArgs(['--class', 'routine'])).toThrow(/Unsupported task class/);
    expect(() => parseArgs(['--class', 'routine-tooling-docs', '--unknown'])).toThrow(
      /Unknown argument/,
    );
    expect(() => parseArgs(['--class'])).toThrow(/Missing value/);
  });

  it('renders concise auditable telemetry and the advisory boundary', () => {
    const output = renderRecommendation(routeTask({ taskClass: 'routine-tooling-docs' }));
    expect(output).toContain('telemetry: schema=crawler-task-routing/v1');
    expect(output).toContain('Does not apply Codex app settings.');
  });
});
