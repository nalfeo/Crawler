/**
 * Unit coverage for `selectSearchPromotion` — the legacy `--stage search`
 * hill-climb's round-to-round promotion gate in
 * `scripts/agent/perf/sweep-eval.ts`.
 *
 * A multi-model review round (gpt-5.3-codex) found this legacy local-smoke
 * path still promoted candidates by raw composite score alone
 * (`totalScoreOf`), never routing through `selectQualifiedWinner`'s hard
 * safety gate — reintroducing the exact GH-run-29597840666 bug
 * (>=90%-win, higher-scoring candidate with a win→loss flip vs the
 * incumbent) in the local path instead of CI. `selectSearchPromotion` was
 * extracted as a pure function so this fix is locked in without needing to
 * run headless games.
 */
import { describe, expect, it } from 'vitest';
import { selectSearchPromotion } from '../../../scripts/agent/perf/sweep-eval.js';
import type { RunRow } from '../../../scripts/agent/perf/aggregate-shards.js';

const VICTORY_SCORE = 1_000_000;
const BUDGET_MS = 360_000;

function row(
  partial: Partial<RunRow> & Pick<RunRow, 'combo' | 'configId' | 'weapon' | 'seed'>,
): RunRow {
  return {
    outcome: 'victory',
    officialWin: true,
    gameTimeMs: 100_000,
    safeRoomMs: 0,
    score: VICTORY_SCORE,
    xp: 100,
    gold: 50,
    minHealthPercent: 0.5,
    finalLevel: 5,
    ...partial,
  };
}

function loss(
  partial: Partial<RunRow> & Pick<RunRow, 'combo' | 'configId' | 'weapon' | 'seed'>,
): RunRow {
  return row({
    outcome: 'timeout',
    officialWin: false,
    gameTimeMs: 396_000,
    score: 30,
    ...partial,
  });
}

const COMBO = 'legacy+legacy';

describe('selectSearchPromotion', () => {
  it('rejects a higher-scoring flip-tainted candidate and returns null (GH run 29597840666, legacy search path)', () => {
    // Incumbent (base.id): wins seeds 1-9, loses seed 10.
    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      rows.push(
        seed === 10
          ? loss({ combo: COMBO, configId: 'base', weapon: 'sword', seed })
          : row({ combo: COMBO, configId: 'base', weapon: 'sword', seed }),
      );
    }
    // Candidate: flips seed 5 (a win→loss flip) but scores much higher overall
    // and still clears the 90% win-rate floor (9/10 = 90%).
    const candidateRows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      candidateRows.push(
        seed === 5
          ? loss({ combo: COMBO, configId: 'flip-tainted', weapon: 'sword', seed })
          : row({
              combo: COMBO,
              configId: 'flip-tainted',
              weapon: 'sword',
              seed,
              score: 5_000_000,
            }),
      );
    }
    const allRows = [...rows, ...candidateRows];
    const currentScore = rows.reduce((a, r) => a + r.score, 0);

    const promotion = selectSearchPromotion(
      allRows,
      {},
      COMBO,
      'base',
      new Set(['flip-tainted']),
      BUDGET_MS,
      currentScore,
    );

    expect(promotion).toBeNull();
  });

  it('promotes a higher-scoring, zero-flip, qualifying candidate', () => {
    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      rows.push(row({ combo: COMBO, configId: 'base', weapon: 'sword', seed }));
    }
    const candidateRows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      candidateRows.push(
        row({ combo: COMBO, configId: 'qualified', weapon: 'sword', seed, score: 2_000_000 }),
      );
    }
    const allRows = [...rows, ...candidateRows];
    const currentScore = rows.reduce((a, r) => a + r.score, 0);

    const promotion = selectSearchPromotion(
      allRows,
      {},
      COMBO,
      'base',
      new Set(['qualified']),
      BUDGET_MS,
      currentScore,
    );

    expect(promotion).not.toBeNull();
    expect(promotion?.bestId).toBe('qualified');
    expect(promotion?.bestScore).toBe(2_000_000 * 10);
  });

  it('returns null when the only qualifying candidate does not out-score the current position', () => {
    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      rows.push(row({ combo: COMBO, configId: 'base', weapon: 'sword', seed }));
    }
    // Qualifies (zero flips, 100% wins) but scores LOWER than the current
    // position — must not be promoted (caller should halve steps instead).
    const candidateRows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      candidateRows.push(
        row({ combo: COMBO, configId: 'lower-score', weapon: 'sword', seed, score: 10 }),
      );
    }
    const allRows = [...rows, ...candidateRows];
    const currentScore = rows.reduce((a, r) => a + r.score, 0);

    const promotion = selectSearchPromotion(
      allRows,
      {},
      COMBO,
      'base',
      new Set(['lower-score']),
      BUDGET_MS,
      currentScore,
    );

    expect(promotion).toBeNull();
  });

  it('only considers rows in candidateIds, ignoring other configIds present in allRows', () => {
    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      rows.push(row({ combo: COMBO, configId: 'base', weapon: 'sword', seed }));
    }
    // A high-scoring, qualifying config NOT in candidateIds (e.g. from a prior
    // round) must be ignored — only this round's new neighbours are eligible.
    const staleRows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      staleRows.push(
        row({
          combo: COMBO,
          configId: 'stale-prior-round',
          weapon: 'sword',
          seed,
          score: 9_000_000,
        }),
      );
    }
    const allRows = [...rows, ...staleRows];
    const currentScore = rows.reduce((a, r) => a + r.score, 0);

    const promotion = selectSearchPromotion(
      allRows,
      {},
      COMBO,
      'base',
      new Set(['this-round-candidate-not-present']),
      BUDGET_MS,
      currentScore,
    );

    expect(promotion).toBeNull();
  });
});
