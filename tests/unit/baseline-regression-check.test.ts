import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  evaluateBaselineRegression,
  type BaselineFile,
  type BaselineIndexEntry,
} from '../../scripts/agent/perf/baseline-regression-check';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/baseline-regression',
);

function fixture(name: string): BaselineFile {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as BaselineFile;
}

function indexEntry(baseline: BaselineFile): BaselineIndexEntry {
  return {
    ...baseline.meta,
    winRate: baseline.winRate,
    totalWins: baseline.totalWins,
    totalRuns: baseline.totalRuns,
    path: `by-sha/${baseline.meta.commit}.json`,
  };
}

describe('release baseline regression check', () => {
  const previous = fixture('previous');
  const regression = fixture('regression');
  const noise = fixture('noise');

  it('detects the real 596/600 to 584/600 regression and renders investigation evidence', () => {
    const decision = evaluateBaselineRegression(
      regression,
      [indexEntry(regression), indexEntry(previous)],
      [previous.meta.commit],
    );

    expect(decision.regression).toBe(true);
    expect(decision.winRateDrop).toBeCloseTo(0.02);
    expect(decision.additionalLosses).toBe(12);
    expect(decision.issue?.body).toContain('99.33%');
    expect(decision.issue?.body).toContain('97.33%');
    expect(decision.issue?.body).toContain('596/600');
    expect(decision.issue?.body).toContain('584/600');
    expect(decision.issue?.body).toContain(regression.meta.commitSubject);
    expect(decision.issue?.body).toContain(regression.meta.runUrl);
  });

  it('suppresses a two-loss change comfortably inside tolerance', () => {
    const decision = evaluateBaselineRegression(
      noise,
      [indexEntry(noise), indexEntry(previous)],
      [previous.meta.commit],
    );
    expect(decision.regression).toBe(false);
    expect(decision.winRateDrop).toBeCloseTo(2 / 600, 10);
    expect(decision.additionalLosses).toBe(2);
  });

  it('suppresses the exact rate boundary and detects the first value above it', () => {
    const atBoundary = {
      ...regression,
      winRate: 593 / 600,
      totalWins: 593,
    };
    const aboveBoundary = {
      ...regression,
      winRate: 592 / 600,
      totalWins: 592,
    };
    const history = [indexEntry(previous)];

    const boundaryDecision = evaluateBaselineRegression(atBoundary, history, [
      previous.meta.commit,
    ]);
    expect(boundaryDecision.winRateDrop).toBeCloseTo(0.005, 10);
    expect(boundaryDecision.additionalLosses).toBe(3);
    expect(boundaryDecision.regression).toBe(false);

    const aboveDecision = evaluateBaselineRegression(aboveBoundary, history, [
      previous.meta.commit,
    ]);
    expect(aboveDecision.winRateDrop).toBeCloseTo(4 / 600, 10);
    expect(aboveDecision.additionalLosses).toBe(4);
    expect(aboveDecision.regression).toBe(true);
  });

  it('selects the prior first-parent baseline even when a newer release published first', () => {
    const future = {
      ...indexEntry(noise),
      commit: 'a'.repeat(40),
      capturedAt: '2026-08-12T00:00:00Z',
    };
    const decision = evaluateBaselineRegression(
      regression,
      [future, indexEntry(previous), indexEntry(regression)],
      [previous.meta.commit],
    );
    expect(decision.previous?.commit).toBe(previous.meta.commit);
  });

  it('reports no regression when no prior release exists on the lineage', () => {
    const decision = evaluateBaselineRegression(regression, [indexEntry(regression)], []);
    expect(decision.regression).toBe(false);
    expect(decision.reason).toContain('no earlier release baseline');
  });

  it('skips exactly one comparison when the sweep matrix is intentionally resized', () => {
    // The multi-floor rollout resizes the Floor-1 leg (600 → 300 runs). Rates
    // across different sample sizes are not comparable, and the
    // additional-losses half of the tolerance rule is meaningless across them.
    // Previously this threw, which would hard-fail the release job on the first
    // post-resize run; it now reports a skipped comparison and resumes at full
    // strength on the next release.
    const mismatched = { ...indexEntry(previous), totalRuns: 300, totalWins: 298 };
    mismatched.winRate = mismatched.totalWins / mismatched.totalRuns;
    const decision = evaluateBaselineRegression(regression, [mismatched], [previous.meta.commit]);
    expect(decision.regression).toBe(false);
    expect(decision.seriesMigrated).toBe(true);
    expect(decision.reason).toContain('sweep matrix resized');
    // Crucially it does NOT file an issue for a comparison it never made.
    expect(decision.issue).toBeUndefined();
  });

  it('resumes detecting regressions on the release after a resize', () => {
    // The migration must be a one-release skip, not a permanent hole: once both
    // baselines share the new size, the same drop is caught normally.
    const resizedPrev = { ...previous, totalRuns: 600, totalWins: 596 };
    resizedPrev.winRate = resizedPrev.totalWins / resizedPrev.totalRuns;
    const decision = evaluateBaselineRegression(
      regression,
      [indexEntry(resizedPrev)],
      [previous.meta.commit],
    );
    expect(decision.regression).toBe(true);
  });

  it('rejects inconsistent metrics instead of silently accepting malformed history', () => {
    const malformed = { ...indexEntry(previous), winRate: 0.5 };
    expect(() =>
      evaluateBaselineRegression(regression, [malformed], [previous.meta.commit]),
    ).toThrow('does not match totalWins/totalRuns');
  });
});
