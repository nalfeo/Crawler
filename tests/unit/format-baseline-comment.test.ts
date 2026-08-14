import { describe, expect, it } from 'vitest';

import { formatBaselineComment } from '../../scripts/agent/perf/format-baseline-comment';

const options = {
  baselineBlobUrl: 'https://example.test/baseline.json',
  fallbackRunUrl: 'https://example.test/fallback-run',
};

function entry(day: number, winRate: number) {
  const suffix = String(day).padStart(2, '0');
  return {
    commit: `${suffix}`.repeat(20),
    commitDate: `2026-07-${suffix}T12:00:00Z`,
    winRate,
  };
}

describe('formatBaselineComment', () => {
  it('renders short history in chronological order with percentage-point deltas', () => {
    const body = formatBaselineComment(
      {
        meta: { runUrl: 'https://example.test/sweep-run' },
        winRate: 0.84,
        totalWins: 252,
        totalRuns: 300,
      },
      [entry(10, 0.84), entry(9, 0.81), entry(8, 0.82)],
      options,
    );

    expect(body).toContain('📊 Baseline win-rate for this release: **84%** (252/300)');
    expect(body).toContain('📈 Last 3 recorded baselines (oldest → newest):');
    expect(body).toContain(
      [
        '- 2026-07-08 `0808080` — **82.0%** (—)',
        '- 2026-07-09 `0909090` — **81.0%** (-1.0 pp)',
        '- 2026-07-10 `1010101` — **84.0%** (+3.0 pp)',
      ].join('\n'),
    );
    expect(body).toContain('[Sweep run](https://example.test/sweep-run)');
  });

  it('limits output to five baselines while comparing the oldest shown entry to its predecessor', () => {
    const body = formatBaselineComment(
      { winRate: 0.85, totalWins: 255, totalRuns: 300 },
      [
        entry(10, 0.85),
        entry(9, 0.84),
        entry(8, 0.83),
        entry(7, 0.82),
        entry(6, 0.81),
        entry(5, 0.79),
      ],
      options,
    );

    expect(body).toContain('📈 Last 5 recorded baselines (oldest → newest):');
    expect(body).not.toContain('2026-07-05');
    expect(body).toContain('- 2026-07-06 `0606060` — **81.0%** (+2.0 pp)');
    expect(body).toContain('[Sweep run](https://example.test/fallback-run)');
  });

  it('orders timestamps by absolute time across UTC offsets and leaves undated entries last', () => {
    const body = formatBaselineComment(
      { winRate: 0.84, totalWins: 252, totalRuns: 300 },
      [
        {
          commit: 'a'.repeat(40),
          commitDate: '2026-07-10T00:30:00+02:00',
          winRate: 0.82,
        },
        {
          commit: 'b'.repeat(40),
          commitDate: '2026-07-09T23:00:00-02:00',
          winRate: 0.84,
        },
        {
          commit: 'c'.repeat(40),
          commitDate: 'not-a-date',
          capturedAt: '2026-07-08T12:00:00Z',
          winRate: 0.8,
        },
      ],
      options,
    );

    expect(body).toContain(
      [
        '- 2026-07-08 `ccccccc` — **80.0%** (—)',
        '- 2026-07-09 `aaaaaaa` — **82.0%** (+2.0 pp)',
        '- 2026-07-10 `bbbbbbb` — **84.0%** (+2.0 pp)',
      ].join('\n'),
    );
  });

  it('rejects invalid history instead of silently omitting the trend', () => {
    expect(() =>
      formatBaselineComment({ winRate: 0.84, totalWins: 252, totalRuns: 300 }, [], options),
    ).toThrow('baseline index is empty or invalid');
  });

  it('shows slow-victory breakdown line when totalSlowVictories and totalTrueLosses are present', () => {
    const body = formatBaselineComment(
      {
        winRate: 0.97,
        totalWins: 582,
        totalRuns: 600,
        totalSlowVictories: 15,
        totalTrueLosses: 18,
      },
      [entry(10, 0.97)],
      options,
    );

    expect(body).toContain('📊 Baseline win-rate for this release: **97%** (582/600)');
    expect(body).toContain('↳ 567 fast wins · 15 slow victories · 18 true losses');
  });

  it('shows every complete-floor leg with its gate status', () => {
    const body = formatBaselineComment(
      {
        winRate: 0.99,
        totalWins: 297,
        totalRuns: 300,
        legs: {
          floor1: { winRate: 0.99, totalWins: 297, totalRuns: 300 },
          floor2: { winRate: 1, totalWins: 150, totalRuns: 150 },
          'floor1-chain': { winRate: 0.98, totalWins: 147, totalRuns: 150 },
        },
      },
      [entry(10, 0.99)],
      options,
    );

    expect(body).toContain('### Complete-floor coverage');
    expect(body).toContain('| `floor1` | 99.0% | 297/300 | yes |');
    expect(body).toContain('| `floor2` | 100.0% | 150/150 | report-only |');
    expect(body).toContain('| `floor1-chain` | 98.0% | 147/150 | report-only |');
  });

  it('omits breakdown line when totalSlowVictories is absent (backward-compatible with old baselines)', () => {
    const body = formatBaselineComment(
      { winRate: 0.84, totalWins: 252, totalRuns: 300 },
      [entry(10, 0.84)],
      options,
    );

    expect(body).not.toContain('↳');
    expect(body).toContain('📊 Baseline win-rate for this release: **84%** (252/300)');
  });
});
