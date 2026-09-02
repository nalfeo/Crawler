import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const modulePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.github/scripts/goobers-shadow.mjs',
);

const { compareLegacyAndGoobers, buildShadowReport, makeIdempotencyKey } = await import(modulePath);

describe('Goobers shadow-mode parity', () => {
  it('keeps duplicate replays idempotent', () => {
    const first = makeIdempotencyKey({ scope: 'ci-recovery', reportDay: '2026-09-02', verdict: 'recommended' });
    const second = makeIdempotencyKey({ scope: 'ci-recovery', reportDay: '2026-09-02', verdict: 'recommended' });

    expect(first).toBe(second);
    expect(first).toHaveLength(16);
  });

  it('reports clean parity when legacy and shadow decisions align', () => {
    const result = compareLegacyAndGoobers(
      {
        workflowName: 'ci-recovery',
        prNumber: '42',
        trigger: 'merge-train-noop',
        verdict: 'recommended',
        action: 'reconcile',
        markerState: 'resolved',
        mutates: false,
      },
      {
        workflowName: 'goobers-shadow',
        prNumber: '42',
        trigger: 'merge-train-noop',
        verdict: 'recommended',
        action: 'reconcile',
        markerState: 'resolved',
        mutates: false,
      },
    );

    expect(result.parityPassed).toBe(true);
    expect(result.divergences).toEqual([]);
  });

  it('flags marker state divergence without writing any mutation intent', () => {
    const report = buildShadowReport({
      scope: 'ci-recovery',
      reportDay: '2026-09-02',
      legacyDecision: {
        workflowName: 'ci-recovery',
        prNumber: '42',
        trigger: 'ci-recovery',
        verdict: 'risky',
        action: 'reconcile',
        markerState: 'resolved',
        mutates: false,
      },
      shadowDecision: {
        workflowName: 'goobers-shadow',
        prNumber: '42',
        trigger: 'ci-recovery',
        verdict: 'risky',
        action: 'reconcile',
        markerState: 'unresolved',
        mutates: false,
      },
    });

    expect(report.parityStatus).toBe('divergence');
    expect(report.isReadOnly).toBe(true);
    expect(report.writesAllowed).toBe(false);
    expect(report.divergences.join(' ')).toContain('marker mismatch');
  });
});
