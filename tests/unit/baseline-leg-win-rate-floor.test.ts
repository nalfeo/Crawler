import { describe, expect, it } from 'vitest';

import {
  LEG_WIN_RATE_FLOOR_MARKER,
  REPORT_ONLY_LEG_IDS,
  REPORT_ONLY_LEG_WIN_RATE_FLOOR,
  evaluateLegWinRateFloor,
  type BaselineFile,
  type BaselineLegMetrics,
} from '../../scripts/agent/perf/baseline-regression-check';
import { RELEASE_SWEEP_LEGS, RELEASE_SWEEP_REVISION } from '../../scripts/agent/perf/sweep-legs';

function leg(totalWins: number, totalRuns: number): BaselineLegMetrics {
  return { totalWins, totalRuns, winRate: totalWins / totalRuns };
}

function baseline(
  legs: Record<string, BaselineLegMetrics> | undefined,
  revision: number | undefined = RELEASE_SWEEP_REVISION,
): BaselineFile {
  return {
    meta: {
      commit: 'a'.repeat(40),
      commitDate: '2026-08-20T07:29:59Z',
      commitSubject: 'feat: something',
      capturedAt: '2026-08-20T08:45:32.263Z',
      runUrl: 'https://github.com/nalfeo/Crawler/actions/runs/1',
      ...(revision === undefined ? {} : { sweep: { seeds: '1-50', kind: 'winrate', revision } }),
    },
    winRate: 1,
    totalWins: 300,
    totalRuns: 300,
    ...(legs ? { legs: { floor1: leg(300, 300), ...legs } } : {}),
  };
}

describe('report-only leg win-rate floor', () => {
  it('monitors exactly the non-blocking legs of the release sweep matrix', () => {
    // Derived from the matrix rather than a second hardcoded copy, so a renamed
    // or newly added report-only leg cannot silently go unwatched.
    expect([...REPORT_ONLY_LEG_IDS].sort()).toEqual(
      RELEASE_SWEEP_LEGS.filter((l) => !l.blocking)
        .map((l) => l.id)
        .sort(),
    );
    expect(REPORT_ONLY_LEG_IDS).toContain('floor2');
    expect(REPORT_ONLY_LEG_IDS).toContain('floor1-chain');
  });

  it('files an issue when a report-only leg is below the target', () => {
    const decision = evaluateLegWinRateFloor(
      baseline({ floor2: leg(41, 150), 'floor1-chain': leg(140, 150) }),
    );
    expect(decision.regression).toBe(true);
    expect(decision.reason).toContain('floor2');
    expect(decision.issue?.marker).toBe(LEG_WIN_RATE_FLOOR_MARKER);
    expect(decision.issue?.body).toContain(LEG_WIN_RATE_FLOOR_MARKER);
    expect(decision.issue?.body).toContain('27.33%');
    expect(decision.issue?.body).toContain('41/150');
    // The healthy leg is still reported for context, marked as not below.
    expect(decision.issue?.body).toContain('`floor1-chain`');
    expect(decision.issue?.body).toContain('src/game/ai');
    expect(decision.issue?.body).toContain(`by-sha/${'a'.repeat(40)}.json`);
  });

  it('is silent when every monitored leg meets the target', () => {
    const decision = evaluateLegWinRateFloor(
      baseline({ floor2: leg(140, 150), 'floor1-chain': leg(139, 150) }),
    );
    expect(decision.regression).toBe(false);
    expect(decision.issue).toBeUndefined();
  });

  it('treats exactly the target as meeting it', () => {
    // 135/150 is exactly 90%: the boundary must not fire, or a leg sitting
    // precisely on target would file an issue every single release.
    const exact = Math.round(150 * REPORT_ONLY_LEG_WIN_RATE_FLOOR);
    const decision = evaluateLegWinRateFloor(
      baseline({ floor2: leg(exact, 150), 'floor1-chain': leg(exact, 150) }),
    );
    expect(exact).toBe(135);
    expect(decision.regression).toBe(false);
    const justBelow = evaluateLegWinRateFloor(
      baseline({ floor2: leg(exact - 1, 150), 'floor1-chain': leg(exact, 150) }),
    );
    expect(justBelow.regression).toBe(true);
  });

  it('reuses one stable marker so a long-running breach updates one issue', () => {
    const first = evaluateLegWinRateFloor(
      baseline({ floor2: leg(41, 150), 'floor1-chain': leg(90, 150) }),
    ).issue?.marker;
    const next = baseline({ floor2: leg(40, 150), 'floor1-chain': leg(89, 150) });
    const second = evaluateLegWinRateFloor({
      ...next,
      meta: { ...next.meta, commit: 'b'.repeat(40) },
    }).issue?.marker;
    expect(first).toBe(second);
    expect(first).not.toContain('a'.repeat(40));
  });

  it('skips a baseline captured before this leg matrix instead of firing', () => {
    const legacy = evaluateLegWinRateFloor(baseline(undefined, 1));
    expect(legacy.regression).toBe(false);
    expect(legacy.reason).toContain('no leg metrics');

    const partialLegacy = evaluateLegWinRateFloor(baseline({ floor2: leg(140, 150) }, 1));
    expect(partialLegacy.regression).toBe(false);
    expect(partialLegacy.legs.map((l) => l.legId)).toEqual(['floor2']);
  });

  it('fails closed when the current matrix publishes no monitored leg', () => {
    // A leg that vanished (truncated publisher, silent rename) would otherwise
    // retire this check without anyone noticing.
    expect(() => evaluateLegWinRateFloor(baseline(undefined))).toThrow(/has no leg metrics/);
    expect(() => evaluateLegWinRateFloor(baseline({ floor2: leg(140, 150) }))).toThrow(
      /missing report-only leg metrics: floor1-chain/,
    );
  });

  it('rejects a leg whose winRate disagrees with wins/runs', () => {
    expect(() =>
      evaluateLegWinRateFloor(
        baseline({
          floor2: { totalWins: 41, totalRuns: 150, winRate: 0.99 },
          'floor1-chain': leg(140, 150),
        }),
      ),
    ).toThrow(/does not match totalWins\/totalRuns/);
  });

  it('rejects a monitored leg with zero runs rather than dividing by it', () => {
    expect(() =>
      evaluateLegWinRateFloor(
        baseline({
          floor2: { totalWins: 0, totalRuns: 0, winRate: 0 },
          'floor1-chain': leg(9, 10),
        }),
      ),
    ).toThrow(/totalRuns must be a positive integer/);
  });
});
