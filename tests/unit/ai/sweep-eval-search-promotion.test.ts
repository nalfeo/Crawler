/**
 * Unit coverage for `selectSearchPromotion` — the legacy `--stage search`
 * hill-climb's round-to-round promotion gate in
 * `scripts/agent/perf/sweep-eval.ts`.
 *
 * A multi-model review round (gpt-5.3-codex) found this legacy local-smoke
 * path still promoted candidates by raw composite score alone
 * (`totalScoreOf`), never routing through `selectQualifiedWinner`'s hard
 * safety gate — reintroducing the exact GH-run-29597840666 bug class in the
 * local path instead of CI. `selectSearchPromotion` was extracted as a pure
 * function so the shared gate (human-approved net-win rule: >=90% official
 * wins AND strictly more total wins than the incumbent — win→loss flips
 * alone are no longer disqualifying) is locked in without needing to run
 * headless games.
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
  it('rejects a flip-tainted candidate whose total wins only TIE the incumbent (GH run 29597840666 shape, legacy search path)', () => {
    // Incumbent (base.id): wins seeds 1-9, loses seed 10. Total wins = 9.
    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      rows.push(
        seed === 10
          ? loss({ combo: COMBO, configId: 'base', weapon: 'sword', seed })
          : row({ combo: COMBO, configId: 'base', weapon: 'sword', seed }),
      );
    }
    // Candidate: flips seed 5 (a win→loss flip) but recovers nothing else, so
    // its total wins (9) only TIE the incumbent's (9) — not a strict
    // increase — even though it clears the 90% win-rate floor and scores
    // much higher overall.
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

    const promotion = selectSearchPromotion(
      allRows,
      {},
      COMBO,
      'base',
      new Set(['flip-tainted']),
      BUDGET_MS,
      'base',
    );

    expect(promotion).toBeNull();
  });

  it('qualifies a flip-tainted candidate whose total wins STRICTLY EXCEED the incumbent (292/300 vs 286/300, 5 flips — GH run 29597840666, human-approved net-win rule)', () => {
    // Incumbent (base.id): wins seeds 1-286, loses seeds 287-300 (14 losses).
    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      rows.push(
        seed <= 286
          ? row({ combo: COMBO, configId: 'base', weapon: 'sword', seed })
          : loss({ combo: COMBO, configId: 'base', weapon: 'sword', seed }),
      );
    }
    // Candidate: flips seeds 1-5 (was a win, now a loss) and recovers seeds
    // 287-297 (was a loss, now a win) => 286 - 5 + 11 = 292 total wins, 5
    // flips, but strictly MORE total wins than the incumbent's 286.
    const candidateRows: RunRow[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const incumbentWins = seed <= 286;
      const flipped = seed >= 1 && seed <= 5;
      const recovered = seed >= 287 && seed <= 297;
      const candidateWins = (incumbentWins && !flipped) || (!incumbentWins && recovered);
      candidateRows.push(
        candidateWins
          ? row({ combo: COMBO, configId: 'net-win', weapon: 'sword', seed, score: 5_000_000 })
          : loss({ combo: COMBO, configId: 'net-win', weapon: 'sword', seed }),
      );
    }
    const allRows = [...rows, ...candidateRows];

    const promotion = selectSearchPromotion(
      allRows,
      {},
      COMBO,
      'base',
      new Set(['net-win']),
      BUDGET_MS,
      'base',
    );

    expect(promotion).not.toBeNull();
    expect(promotion?.bestId).toBe('net-win');
  });

  it('promotes a higher-scoring, strictly-more-wins qualifying candidate', () => {
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
    // One extra winning cell the incumbent never ran => 11 total wins,
    // strictly more than the incumbent's 10.
    candidateRows.push(
      row({ combo: COMBO, configId: 'qualified', weapon: 'bow', seed: 1, score: 2_000_000 }),
    );
    const allRows = [...rows, ...candidateRows];

    const promotion = selectSearchPromotion(
      allRows,
      {},
      COMBO,
      'base',
      new Set(['qualified']),
      BUDGET_MS,
      'base',
    );

    expect(promotion).not.toBeNull();
    expect(promotion?.bestId).toBe('qualified');
    expect(promotion?.bestScore).toBe(2_000_000 * 11);
  });

  it('returns null when the only qualifying candidate does not out-score the current position', () => {
    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      rows.push(row({ combo: COMBO, configId: 'base', weapon: 'sword', seed }));
    }
    // Qualifies (11 wins, strictly more than the incumbent's 10) but scores
    // LOWER than the current position — must not be promoted (caller should
    // halve steps instead).
    const candidateRows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      candidateRows.push(
        row({ combo: COMBO, configId: 'lower-score', weapon: 'sword', seed, score: 10 }),
      );
    }
    candidateRows.push(
      row({ combo: COMBO, configId: 'lower-score', weapon: 'bow', seed: 1, score: 10 }),
    );
    const allRows = [...rows, ...candidateRows];

    const promotion = selectSearchPromotion(
      allRows,
      {},
      COMBO,
      'base',
      new Set(['lower-score']),
      BUDGET_MS,
      'base',
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

    const promotion = selectSearchPromotion(
      allRows,
      {},
      COMBO,
      'base',
      new Set(['this-round-candidate-not-present']),
      BUDGET_MS,
      'base',
    );

    expect(promotion).toBeNull();
  });
});
