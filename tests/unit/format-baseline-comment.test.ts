import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { formatBaselineComment } from '../../scripts/agent/perf/format-baseline-comment';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

function funReport(score: number, pass: boolean) {
  return {
    report: {
      runs: 2,
      overall_fun_score: score,
      dimensions: {
        engagement: 70,
        challenge_balance: 70,
        excitement: 70,
        pacing: 70,
        competence_growth: 70,
        choice_depth: 70,
        run_distinctness: 70,
      },
      criteria: {
        unsafe_combat_uptime: { observed: 0.7 },
        survivability_variance: { observed: 0.3 },
        run_variety: { observed: 70 },
        dopamine_cadence: { observed: 60 },
        snowball_frequency: { observed: 0.1 },
        meta_progression: { observed: null },
        item_viability: { observed: 0.1 },
        early_death_rate: { observed: 0 },
      },
      persona_scores: {},
      gate: { pass },
    },
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

  it('renders compatible loot, active-time DPS, fun, and Pages report details', () => {
    const current = {
      meta: { commit: 'a'.repeat(40), sweep: { revision: 2 } },
      winRate: 1,
      totalWins: 2,
      totalRuns: 2,
      legs: { floor1: { winRate: 1, totalWins: 2, totalRuns: 2 } },
      runs: [
        {
          gameTimeMs: 60_000,
          safeRoomMs: 10_000,
          combat: { damageDealt: 500 },
          lootEfficiency: {
            xpSpawned: 100,
            xpCollected: 80,
            goldSpawned: 20,
            goldCollected: 10,
          },
        },
        {
          gameTimeMs: 60_000,
          safeRoomMs: 0,
          combat: { damageDealt: 600 },
          lootEfficiency: {
            xpSpawned: 100,
            xpCollected: 100,
            goldSpawned: 20,
            goldCollected: 20,
          },
        },
      ],
    };
    const previous = {
      ...current,
      meta: { commit: 'b'.repeat(40), sweep: { revision: 2 } },
      runs: current.runs.map((run) => ({
        ...run,
        combat: { damageDealt: 400 },
        lootEfficiency: {
          xpSpawned: 100,
          xpCollected: 70,
          goldSpawned: 20,
          goldCollected: 10,
        },
      })),
    };

    const body = formatBaselineComment(current, [entry(10, 1), entry(9, 0.98)], {
      ...options,
      previousBaseline: previous,
      funReport: funReport(75, true),
      previousFunReport: funReport(72, true),
      reportUrl:
        'https://example.test/release-baseline-report.html?commit=aaaaaaaa&repo=owner%2Frepo',
    });

    expect(body).toContain('### Loot efficiency');
    expect(body).toContain('XP **90.0%** (+20.0 pp)');
    expect(body).toContain('gold **75.0%** (+25.0 pp)');
    expect(body).toContain('combined **87.5%** (+20.8 pp)');
    expect(body).toContain('### Damage rate');
    expect(body).toContain('**600.0 damage / active min** (+163.6)');
    expect(body).toContain('### Fun evaluation');
    expect(body).toContain('**75.0/100** · gate **pass** · 2 runs · Δ +3.0 (improving)');
    expect(body).toContain(
      '[Release report](https://example.test/release-baseline-report.html?commit=aaaaaaaa&repo=owner%2Frepo)',
    );
  });

  it('withholds the fun delta when optional release legs differ', () => {
    const current = {
      meta: { commit: 'a'.repeat(40), sweep: { revision: 2 } },
      winRate: 1,
      totalWins: 2,
      totalRuns: 2,
      legs: {
        floor1: { winRate: 1, totalWins: 2, totalRuns: 2 },
        floor2: { winRate: 1, totalWins: 2, totalRuns: 2 },
      },
    };
    const previous = {
      ...current,
      meta: { commit: 'b'.repeat(40), sweep: { revision: 2 } },
      legs: {
        floor1: { winRate: 1, totalWins: 2, totalRuns: 2 },
        'floor1-chain': { winRate: 1, totalWins: 2, totalRuns: 2 },
      },
    };

    const body = formatBaselineComment(current, [entry(10, 1), entry(9, 1)], {
      ...options,
      previousBaseline: previous,
      funReport: funReport(75, true),
      previousFunReport: funReport(72, true),
    });

    expect(body).toContain(
      '**75.0/100** · gate **pass** · 2 runs · Δ inconclusive (cohort changed)',
    );
  });

  it('links the report from the current dev Pages tier', () => {
    const formatter = readFileSync(
      path.join(REPO_ROOT, 'scripts/agent/perf/format-baseline-comment.ts'),
      'utf8',
    );

    expect(formatter).toContain("new URL('dev/release-baseline-report.html', base)");
  });
});
