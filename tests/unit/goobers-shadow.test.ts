import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const modulePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.github/scripts/goobers-shadow.mjs',
);
const { buildShadowReport, makeIdempotencyKey, parseMarkerState } = await import(modulePath);

const resolvedThread = {
  isResolved: true,
  comments: [{ body: '✅ Addressed in abc1234: fixed the lifecycle gate' }],
};
const unresolvedThread = { isResolved: false, comments: [{ body: 'still investigating' }] };

describe('Goobers shadow-mode parity', () => {
  it('keeps duplicate replays idempotent', () => {
    const input = { scope: 'ci-recovery', reportDay: '2026-09-02', run: '77' };
    expect(makeIdempotencyKey(input)).toBe(
      makeIdempotencyKey({ reportDay: '2026-09-02', run: '77', scope: 'ci-recovery' }),
    );
  });

  it('replays representative CI Recovery and Merge Train outcomes from captured runs', () => {
    const report = buildShadowReport({
      scope: 'ci-recovery,merge-train',
      reportDay: '2026-09-02',
      triggers: [
        {
          workflowName: 'merge-train',
          runId: '22',
          prNumber: '42',
          trigger: 'schedule',
          conclusion: 'success',
          reviewThreads: [resolvedThread],
        },
        {
          workflowName: 'ci-recovery',
          runId: '11',
          prNumber: '41',
          trigger: 'workflow_dispatch',
          conclusion: 'failure',
          reviewThreads: [unresolvedThread],
        },
      ],
    });

    expect(report.parityStatus).toBe('clean');
    expect(report.representativeCoverage).toEqual({
      requestedWorkflows: ['ci-recovery', 'merge-train'],
      coveredWorkflows: ['ci-recovery', 'merge-train'],
      missingCoverage: [],
    });
    expect(
      report.decisions.map((decision: { sourceRunId: string }) => decision.sourceRunId),
    ).toEqual(['11', '22']);
    expect(report.writesAllowed).toBe(false);
  });

  it('rejects malformed or quoted resolution markers and records the marker divergence', () => {
    expect(parseMarkerState('> ✅ Addressed in abc1234: quoted evidence')).toBe('unresolved');
    expect(parseMarkerState('✅ Addressed in not-a-sha: invalid')).toBe('unresolved');
    expect(parseMarkerState('✅ Not applicable: deterministic reason')).toBe('resolved');

    const report = buildShadowReport({
      scope: 'ci-recovery',
      reportDay: '2026-09-02',
      triggers: [
        {
          workflowName: 'ci-recovery',
          runId: '11',
          prNumber: '41',
          trigger: 'workflow_dispatch',
          conclusion: 'success',
          reviewThreads: [
            { isResolved: true, comments: [{ body: '> ✅ Addressed in abc1234: quoted' }] },
          ],
        },
      ],
    });

    expect(report.parityStatus).toBe('divergence');
    expect(report.divergences).toContain(
      'run=11 marker mismatch legacy=resolved shadow=unresolved',
    );
  });

  it('fails closed when a requested legacy workflow has no captured runs', () => {
    const report = buildShadowReport({
      scope: 'ci-recovery,merge-train',
      reportDay: '2026-09-02',
      triggers: [{ workflowName: 'ci-recovery', runId: '11', reviewThreads: [] }],
    });

    expect(report.parityStatus).toBe('divergence');
    expect(report.divergences).toContain('missing representative coverage for merge-train');
  });
});
