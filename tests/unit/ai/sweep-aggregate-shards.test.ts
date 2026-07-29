/**
 * Unit coverage for the cloud eval pipeline's PURE fan-in aggregator
 * (`scripts/agent/perf/aggregate-shards.ts`).
 *
 * This module is the trust boundary of the whole sweep: it merges untrusted
 * shard artifacts from many cloud runners into the leaderboard the S4 decision
 * packet is built from. Its paranoia is what makes the packet trustworthy, so
 * that paranoia is locked here:
 *   - identical duplicate rows collapse (cross-shard determinism proof) but
 *     CONFLICTING duplicates throw (a determinism violation);
 *   - provenance mismatch (schema / win-budget / frame-budget) throws — rows
 *     from incomparable runs must never be summed together;
 *   - missing expected coverage throws;
 *   - every total is RECOMPUTED from the per-run rows, never trusted from a
 *     shard-reported sum;
 *   - both orderings are produced (Σ composite score AND win-count-first
 *     lexicographic) and their divergence is flagged for the human;
 *   - the A/B safety contract carries forward as explicit columns (win→loss
 *     flips vs the LEGACY incumbent + win-rate delta).
 */
import { describe, expect, it } from 'vitest';
import {
  aggregate,
  assertComplete,
  assertRowsConsistent,
  assertSearchArtifactProvenance,
  buildLeaderboard,
  deriveRunFacts,
  mergeShards,
  QUALIFICATION_MIN_WIN_RATE,
  renderMarkdown,
  selectQualifiedWinner,
  SHARD_SCHEMA_VERSION,
  sortByComposite,
  sortByLexicographic,
  type RunRow,
  type ShardArtifact,
  type ShardMeta,
} from '../../../scripts/agent/perf/aggregate-shards.js';
import { AIDecisionMode, AIPathingMode } from '../../../src/game/ai/types.js';

const VICTORY_SCORE = 1_000_000;

const META: ShardMeta = {
  schemaVersion: SHARD_SCHEMA_VERSION,
  budgetMs: 360_000,
  floorId: 'floor1',
  maxFrames: 23_760,
  stage: 'test',
  runnerOs: 'linux',
  nodeVersion: 'v22.0.0',
  packageLockHash: 'abc123def456abc123def456',
  workflowSha: 'deadbeefcafe0000deadbeefcafe0000',
};

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

function shard(rows: RunRow[], metaOverride: Partial<ShardMeta> = {}): ShardArtifact {
  return { meta: { ...META, ...metaOverride }, configs: {}, rows };
}

/**
 * A row whose stored (officialWin, score) are filled from the SSOT recompute for
 * its raw facts — i.e. a row the fan-in fact check accepts. Tests that exercise
 * the integrity guard tamper with exactly one field of a `consistent()` row so
 * the failure is unambiguous.
 */
function consistent(
  partial: Partial<RunRow> & Pick<RunRow, 'combo' | 'configId' | 'weapon' | 'seed'>,
): RunRow {
  const base = row(partial);
  const { officialWin, score } = deriveRunFacts(
    {
      outcome: base.outcome,
      gameTimeMs: base.gameTimeMs,
      safeRoomMs: base.safeRoomMs,
      totalXp: base.xp,
      totalGold: base.gold,
      finalLevel: base.finalLevel,
    },
    META.budgetMs,
  );
  return { ...base, officialWin, score };
}

describe('mergeShards', () => {
  it('throws when no shards are provided', () => {
    expect(() => mergeShards([])).toThrow(/no shard artifacts/);
  });

  it('collapses identical duplicate rows as a determinism proof', () => {
    const r = row({ combo: 'legacy+legacy', configId: 'c', weapon: 'sword', seed: 1 });
    const merged = mergeShards([shard([r]), shard([{ ...r }])]);
    expect(merged.rows).toHaveLength(1);
    expect(merged.collapsedDuplicates).toBe(1);
  });

  it('throws on a conflicting duplicate (same key, differing facts)', () => {
    const a = row({ combo: 'legacy+legacy', configId: 'c', weapon: 'sword', seed: 1 });
    const b = row({ ...a, score: 42 }); // same key, different score
    expect(() => mergeShards([shard([a]), shard([b])])).toThrow(/determinism violation/);
  });

  it.each([
    ['schema version', { schemaVersion: 999 }, /schema version mismatch/],
    ['win budget', { budgetMs: 1 }, /win-budget mismatch/],
    ['floor', { floorId: 'floor2' }, /floor mismatch/],
    ['frame budget', { maxFrames: 1 }, /frame-budget mismatch/],
    ['stage', { stage: 'other' }, /stage mismatch/],
    ['runner OS', { runnerOs: 'windows' }, /runner-OS mismatch/],
    ['node version', { nodeVersion: 'v20.0.0' }, /node-version mismatch/],
    ['package lock', { packageLockHash: 'ffffffffffffffffffffffff' }, /package-lock mismatch/],
    [
      'workflow sha',
      { workflowSha: '0000000000000000000000000000000000000000' },
      /workflow-sha mismatch/,
    ],
  ])('throws on %s provenance mismatch', (_label, override, pattern) => {
    const r = row({ combo: 'legacy+legacy', configId: 'c', weapon: 'sword', seed: 1 });
    expect(() => mergeShards([shard([r]), shard([r], override)])).toThrow(pattern as RegExp);
  });

  it('rejects an all-stale-schema batch that agrees internally but predates the SSOT', () => {
    // Every shard reports the SAME older schema version, so the per-shard
    // "agrees with each other" check passes — but the batch still predates the
    // current SSOT. Pre-v2 rows lack safeRoomMs, which would silently revert to
    // raw-time win classification, so the batch must be rejected outright.
    const r = row({ combo: 'legacy+legacy', configId: 'c', weapon: 'sword', seed: 1 });
    const stale = { schemaVersion: SHARD_SCHEMA_VERSION - 1 };
    expect(() => mergeShards([shard([r], stale), shard([{ ...r }], stale)])).toThrow(
      /schema version .* != current/,
    );
  });

  it('rejects an all-floor2 batch — safe-room win credit is Floor-1-specific', () => {
    // Every shard agrees on floorId=floor2, so the per-shard cross-shard check
    // passes, but deriveRunFacts/isOfficialWin apply Floor-1 safe-room credit
    // unconditionally. A non-floor1 batch would be misclassified with Floor-1
    // win semantics, so the fan-in rejects it outright (defense-in-depth behind
    // sweep-eval's own producer-side --floor guard).
    const r = row({ combo: 'legacy+legacy', configId: 'c', weapon: 'sword', seed: 1 });
    const floor2 = { floorId: 'floor2' };
    expect(() => mergeShards([shard([r], floor2), shard([{ ...r }], floor2)])).toThrow(
      /floorId 'floor2' is not supported/,
    );
  });

  it.each([
    ['a missing (undefined)', undefined],
    ['a NaN', NaN],
    ['a negative', -1],
    ['an over-gameTimeMs', 200_000],
  ])('rejects %s safeRoomMs at the fan-in boundary', (_label, safeRoomMs) => {
    // safeRoomMs is typed `number` but arrives via JSON.parse cast to RunRow, so
    // an omitted/NaN/out-of-range value slips past the type. activeTimeMs would
    // coalesce a missing value to 0 (raw-time classification) or clamp a value >
    // gameTimeMs to 0 active time (manufacturing an official win), so the merge
    // boundary must reject it. gameTimeMs stays 100_000 so 200_000 is over-range.
    const r = row({
      combo: 'legacy+legacy',
      configId: 'c',
      weapon: 'sword',
      seed: 1,
      gameTimeMs: 100_000,
      safeRoomMs: safeRoomMs as number,
    });
    expect(() => mergeShards([shard([r])])).toThrow(/safeRoomMs/);
  });

  it('throws on a conflicting config definition for the same id', () => {
    const r = row({ combo: 'riskRewardFused+legacy', configId: 'c', weapon: 'sword', seed: 1 });
    const s1: ShardArtifact = {
      meta: META,
      configs: {
        c: { pathingMode: AIPathingMode.RISK_REWARD_FUSED, decisionMode: AIDecisionMode.LEGACY },
      },
      rows: [r],
    };
    const s2: ShardArtifact = {
      meta: META,
      // same id, different knobs → definitionally a runner bug / tamper
      configs: {
        c: {
          pathingMode: AIPathingMode.RISK_REWARD_FUSED,
          decisionMode: AIDecisionMode.LEGACY,
          aggression: 1.5,
        },
      },
      rows: [row({ ...r, weapon: 'bow' })],
    };
    expect(() => mergeShards([s1, s2])).toThrow(/Conflicting config definition for id c/);
  });

  it('merges config definitions across shards', () => {
    const cfg = {
      pathingMode: AIPathingMode.RISK_REWARD_FUSED,
      decisionMode: AIDecisionMode.LEGACY,
    };
    const s1: ShardArtifact = {
      meta: META,
      configs: { c: cfg },
      rows: [row({ combo: 'riskRewardFused+legacy', configId: 'c', weapon: 'sword', seed: 1 })],
    };
    const s2: ShardArtifact = {
      meta: META,
      configs: {},
      rows: [row({ combo: 'riskRewardFused+legacy', configId: 'c', weapon: 'bow', seed: 1 })],
    };
    const merged = mergeShards([s1, s2]);
    expect(merged.configs.c).toEqual(cfg);
    expect(merged.rows).toHaveLength(2);
  });
});

describe('assertComplete', () => {
  const rows = [row({ combo: 'legacy+legacy', configId: 'c', weapon: 'sword', seed: 1 })];

  it('is a no-op when no expectation is supplied', () => {
    expect(() => assertComplete(rows, [])).not.toThrow();
  });

  it('throws listing the missing coverage cells', () => {
    expect(() =>
      assertComplete(rows, [
        { combo: 'legacy+legacy', configId: 'c', weapon: 'sword', seed: 1 },
        { combo: 'legacy+legacy', configId: 'c', weapon: 'bow', seed: 1 },
      ]),
    ).toThrow(/Missing 1 expected run\(s\).*bow\/1/);
  });
});

describe('buildLeaderboard', () => {
  it('recomputes wins, totals, win-rate and per-weapon splits from the rows', () => {
    const rows = [
      row({
        combo: 'legacy+legacy',
        configId: 'c',
        weapon: 'sword',
        seed: 1,
        score: 10,
        xp: 10,
        gold: 5,
      }),
      row({
        combo: 'legacy+legacy',
        configId: 'c',
        weapon: 'sword',
        seed: 2,
        score: 30,
        xp: 30,
        gold: 15,
      }),
      loss({ combo: 'legacy+legacy', configId: 'c', weapon: 'bow', seed: 1 }),
    ];
    const [lb] = buildLeaderboard(rows);
    expect(lb!.runs).toBe(3);
    expect(lb!.wins).toBe(2);
    expect(lb!.winRate).toBeCloseTo(2 / 3);
    expect(lb!.totalScore).toBe(10 + 30 + 30); // loss() score default is 30
    expect(lb!.perWeaponWins.sword).toEqual({ wins: 2, runs: 2 });
    expect(lb!.perWeaponWins.bow).toEqual({ wins: 0, runs: 1 });
    expect(lb!.meanClearTimeMsWins).toBe(100_000); // only winning runs counted
  });

  it('computes win→loss flips and win-rate delta vs the incumbent', () => {
    const rows = [
      // incumbent LEGACY: wins sword s1, loses bow s1
      row({ combo: 'legacy+legacy', configId: 'inc', weapon: 'sword', seed: 1 }),
      loss({ combo: 'legacy+legacy', configId: 'inc', weapon: 'bow', seed: 1 }),
      // challenger: loses sword s1 (a flip!), wins bow s1 (a recovery, not a flip)
      loss({ combo: 'navmesh+legacy', configId: 'nav', weapon: 'sword', seed: 1 }),
      row({ combo: 'navmesh+legacy', configId: 'nav', weapon: 'bow', seed: 1 }),
    ];
    const lb = buildLeaderboard(rows, {
      incumbentCombo: 'legacy+legacy',
      incumbentConfigId: 'inc',
    });
    const incumbent = lb.find((r) => r.isIncumbent)!;
    const challenger = lb.find((r) => !r.isIncumbent)!;
    expect(incumbent.flipsVsIncumbent).toBeNull(); // self → no flips
    expect(challenger.flipsVsIncumbent).toBe(1); // sword s1 win→loss
    // both have win-rate 0.5 → delta 0
    expect(challenger.winRateDeltaVsIncumbent).toBeCloseTo(0);
  });

  it('attaches config definitions when provided', () => {
    const cfg = {
      pathingMode: AIPathingMode.RISK_REWARD_FUSED,
      decisionMode: AIDecisionMode.LEGACY,
    };
    const rows = [
      row({ combo: 'riskRewardFused+legacy', configId: 'c', weapon: 'sword', seed: 1 }),
    ];
    const [lb] = buildLeaderboard(rows, { configs: { c: cfg } });
    expect(lb!.config).toEqual(cfg);
  });

  it('recomputes officialWin from budgetMs, overriding a stale/lying stored flag', () => {
    // Raw facts = an over-budget timeout (a loss), but the stored flag lies "win".
    const rows = [
      {
        ...loss({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 }),
        officialWin: true,
      },
    ];
    // Without a budget the stored flag is trusted (primitive ranking path)…
    const [trusting] = buildLeaderboard(rows);
    expect(trusting!.wins).toBe(1);
    // …but with the SSOT budget the win is recomputed from the raw facts → not a win.
    const [recomputed] = buildLeaderboard(rows, { budgetMs: META.budgetMs });
    expect(recomputed!.wins).toBe(0);
  });
  it('scopes incumbent identity to the exact (combo, configId) pair, not configId alone', () => {
    // Regression for plan-review concern #2: buildLeaderboard supports exactly
    // ONE incumbent identity per call (see BuildLeaderboardOptions doc). A row
    // sharing the incumbent's configId but under a DIFFERENT combo must NOT be
    // treated as "the incumbent" — it is just an unrelated candidate group.
    const rows = [
      // true incumbent: legacy+legacy / 'shared-id'
      row({ combo: 'legacy+legacy', configId: 'shared-id', weapon: 'sword', seed: 1 }),
      // same configId, but a DIFFERENT combo — must be its own independent group
      row({ combo: 'navmesh+legacy', configId: 'shared-id', weapon: 'sword', seed: 1 }),
      loss({ combo: 'navmesh+legacy', configId: 'shared-id', weapon: 'sword', seed: 2 }),
    ];
    const lb = buildLeaderboard(rows, {
      incumbentCombo: 'legacy+legacy',
      incumbentConfigId: 'shared-id',
    });
    expect(lb).toHaveLength(2);
    const trueIncumbent = lb.find((r) => r.combo === 'legacy+legacy')!;
    const lookalike = lb.find((r) => r.combo === 'navmesh+legacy')!;
    expect(trueIncumbent.isIncumbent).toBe(true);
    expect(lookalike.isIncumbent).toBe(false); // combo differs → not the incumbent
    expect(lookalike.runs).toBe(2); // its own 2 rows, not merged with the incumbent's 1
  });
});

describe('selectQualifiedWinner', () => {
  it('defaults to the approved 90% hard-gate win-rate floor', () => {
    expect(QUALIFICATION_MIN_WIN_RATE).toBe(0.9);
  });

  /**
   * Reproduces the exact real-world shape the hard gate was built around:
   * GitHub run 29597840666 (full untuned graduation). `riskRewardFused+legacy`
   * scored 292/300 wins (97.3%) vs the incumbent's 286/300 (95.3%) — a
   * candidate with 5 win→loss flips vs the incumbent, but whose absolute win
   * COUNT still strictly exceeds the incumbent's. Per the human-approved
   * net-win rule, that candidate now QUALIFIES (see the dedicated 292/300 vs
   * 286/300 regression test below). This scaled-down 10-cell fixture instead
   * covers the case the rule still rejects: incumbent wins 9/10 (seeds 1-9,
   * loses seed10); the high-scoring challenger ("riskRewardFused+legacy") also
   * wins 9/10 — TIED with the incumbent's total, not strictly more — because it
   * flips one of the incumbent's wins into a loss (seed5) while only recovering
   * the incumbent's single loss (seed10), netting zero. A tie is not a strict
   * increase, so it must still be REJECTED despite its much higher composite
   * score. A second, lower-scoring, zero-flip challenger ("navmeshFused+legacy")
   * — which strictly outperforms the incumbent (10 wins > 9) — is selected
   * instead.
   */
  function graduationScenarioRows(): RunRow[] {
    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      // Incumbent: wins seeds 1-9, loses seed 10.
      rows.push(
        seed === 10
          ? loss({ combo: 'legacy+legacy', configId: 'inc', weapon: 'sword', seed })
          : row({
              combo: 'legacy+legacy',
              configId: 'inc',
              weapon: 'sword',
              seed,
              score: 1_000_000,
            }),
      );
      // High-score challenger: wins everything EXCEPT seed 5 (a flip — incumbent
      // won seed5) and additionally wins seed10 (a recovery, not a flip). Net
      // wins = 9 (9 - 1 flip + 1 recovery), TIED with the incumbent's 9.
      rows.push(
        seed === 5
          ? loss({ combo: 'riskRewardFused+legacy', configId: 'rrf', weapon: 'sword', seed })
          : row({
              combo: 'riskRewardFused+legacy',
              configId: 'rrf',
              weapon: 'sword',
              seed,
              score: 5_000_000, // deliberately the highest composite score
            }),
      );
      // Lower-score, zero-flip challenger: wins every cell the incumbent won
      // PLUS the one it lost — 10 wins, strictly more than the incumbent's 9.
      rows.push(
        row({
          combo: 'navmeshFused+legacy',
          configId: 'nfq',
          weapon: 'sword',
          seed,
          score: 1_000_000,
        }),
      );
    }
    return rows;
  }

  it('rejects a flip-tainted candidate whose total wins only TIE the incumbent, and selects the strictly-more-wins qualifier (GH run 29597840666 shape)', () => {
    const lb = buildLeaderboard(graduationScenarioRows(), {
      incumbentCombo: 'legacy+legacy',
      incumbentConfigId: 'inc',
    });
    const rrf = lb.find((r) => r.configId === 'rrf')!;
    const nfq = lb.find((r) => r.configId === 'nfq')!;
    // Sanity-check the fixture actually reproduces the reported shape: the
    // flip-tainted candidate both meets the win-rate floor AND out-scores the
    // strictly-more-wins qualifier — so a naive score-only ranking would
    // wrongly pick it — but its win count only ties the incumbent's, not
    // strictly exceeds it.
    expect(rrf.winRate).toBeCloseTo(0.9);
    expect(rrf.flipsVsIncumbent).toBe(1);
    expect(rrf.winsVsIncumbentDelta).toBe(0);
    expect(nfq.winRate).toBe(1);
    expect(nfq.flipsVsIncumbent).toBe(0);
    expect(nfq.winsVsIncumbentDelta).toBe(1);
    expect(rrf.totalScore).toBeGreaterThan(nfq.totalScore);

    const selection = selectQualifiedWinner(lb);
    expect(selection.winner?.combo).toBe('navmeshFused+legacy');
    expect(selection.winner?.winsVsIncumbentDelta).toBe(1);
    expect(selection.qualifying.map((r) => r.combo)).toEqual(['navmeshFused+legacy']);
    expect(selection.reason).toMatch(
      /riskRewardFused\+legacy.*disqualified by the hard safety gate/,
    );
  });

  /**
   * The exact real-world regression the net-win rule change was written for:
   * GitHub run 29597840666 at full scale. Incumbent wins 286/300 (95.3%,
   * loses the last 14 seeds). Candidate flips 5 of the incumbent's wins
   * (seeds 1-5) into losses but recovers 11 of the incumbent's 14 losses
   * (seeds 287-297), netting 292/300 (97.3%) — 5 flips, but 6 MORE total wins
   * than the incumbent. Under the old zero-flips gate this was rejected;
   * under the human-approved net-win rule (candidate must have >=90% wins AND
   * strictly more total wins than the incumbent — flips are not disqualifying
   * on their own) it now QUALIFIES.
   */
  function netWinRegressionRows(): RunRow[] {
    const rows: RunRow[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      // Incumbent: wins seeds 1-286, loses seeds 287-300 (14 losses).
      const incumbentWins = seed <= 286;
      rows.push(
        incumbentWins
          ? row({
              combo: 'legacy+legacy',
              configId: 'inc',
              weapon: 'sword',
              seed,
              score: 1_000_000,
            })
          : loss({ combo: 'legacy+legacy', configId: 'inc', weapon: 'sword', seed }),
      );
      // Candidate: flips seeds 1-5 (was a win, now a loss) and recovers seeds
      // 287-297 (was a loss, now a win) => 286 - 5 + 11 = 292 total wins.
      const flipped = seed >= 1 && seed <= 5;
      const recovered = seed >= 287 && seed <= 297;
      const candidateWins = (incumbentWins && !flipped) || (!incumbentWins && recovered);
      rows.push(
        candidateWins
          ? row({
              combo: 'riskRewardFused+legacy',
              configId: 'rrf',
              weapon: 'sword',
              seed,
              score: 5_000_000,
            })
          : loss({ combo: 'riskRewardFused+legacy', configId: 'rrf', weapon: 'sword', seed }),
      );
    }
    return rows;
  }

  it('qualifies a flip-tainted candidate whose total wins STRICTLY EXCEED the incumbent (292/300 vs 286/300, 5 flips — GH run 29597840666)', () => {
    const lb = buildLeaderboard(netWinRegressionRows(), {
      incumbentCombo: 'legacy+legacy',
      incumbentConfigId: 'inc',
    });
    const rrf = lb.find((r) => r.configId === 'rrf')!;
    expect(rrf.wins).toBe(292);
    expect(rrf.winRate).toBeCloseTo(292 / 300);
    expect(rrf.flipsVsIncumbent).toBe(5);
    expect(rrf.winsVsIncumbentDelta).toBe(6); // 292 - 286

    const selection = selectQualifiedWinner(lb);
    expect(selection.winner?.combo).toBe('riskRewardFused+legacy');
    expect(selection.reason).toBeNull();
  });

  it('rejects a candidate whose total wins only TIE the incumbent, even with zero flips', () => {
    const rows = [
      row({ combo: 'legacy+legacy', configId: 'inc', weapon: 'sword', seed: 1 }),
      row({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 }),
    ];
    const lb = buildLeaderboard(rows, {
      incumbentCombo: 'legacy+legacy',
      incumbentConfigId: 'inc',
    });
    const candidate = lb.find((r) => r.configId === 'a')!;
    expect(candidate.flipsVsIncumbent).toBe(0);
    expect(candidate.winsVsIncumbentDelta).toBe(0); // 1 win == incumbent's 1 win
    const selection = selectQualifiedWinner(lb);
    expect(selection.winner).toBeNull();
    expect(selection.reason).toMatch(/No candidate met the hard gate/);
  });

  it('rejects a candidate whose total wins DECREASE relative to the incumbent at the win-rate floor', () => {
    // Use the same 10-seed panel for both groups so the panel-alignment guard
    // permits a non-null delta. Incumbent wins all 10 seeds (100%); candidate
    // wins 9 out of the same 10 seeds (exactly 90% — clears the win-rate
    // floor). Asserting winRate here ensures the floor is not what causes
    // the rejection: removing the win-decrease clause would flip this test
    // from failing to passing.
    const seeds = Array.from({ length: 10 }, (_, i) => i + 1);
    const rows = [
      ...seeds.map((seed) =>
        row({ combo: 'legacy+legacy', configId: 'inc', weapon: 'sword', seed }),
      ),
      ...seeds.map((seed) =>
        seed === 10
          ? loss({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed })
          : row({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed }),
      ),
    ];
    const lb = buildLeaderboard(rows, {
      incumbentCombo: 'legacy+legacy',
      incumbentConfigId: 'inc',
    });
    const candidate = lb.find((r) => r.configId === 'a')!;
    expect(candidate.wins).toBe(9);
    expect(candidate.winRate).toBeCloseTo(0.9); // passes the 90% floor…
    expect(candidate.winsVsIncumbentDelta).toBe(-1); // …but 9 < 10 incumbent wins
    const selection = selectQualifiedWinner(lb);
    expect(selection.winner).toBeNull();
    expect(selection.reason).toMatch(/No candidate met the hard gate/);
  });

  it('rejects a candidate evaluated on a different weapon/seed panel', () => {
    const rows = [
      loss({ combo: 'legacy+legacy', configId: 'inc', weapon: 'sword', seed: 1 }),
      row({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 }),
      row({ combo: 'a+legacy', configId: 'a', weapon: 'bow', seed: 1 }),
    ];
    const lb = buildLeaderboard(rows, {
      incumbentCombo: 'legacy+legacy',
      incumbentConfigId: 'inc',
    });
    const candidate = lb.find((r) => r.configId === 'a')!;
    expect(candidate.winRate).toBe(1);
    expect(candidate.winsVsIncumbentDelta).toBeNull();
    expect(selectQualifiedWinner(lb).winner).toBeNull();
  });

  it('leaves winsVsIncumbentDelta null when the candidate group contains duplicate (weapon,seed) rows', () => {
    // A candidate with a duplicated winning row satisfies the unique-cell-count
    // panel check (1 unique cell == 1 incumbent cell) but has runs=2 / wins=2,
    // giving an inflated positive delta. The fix: require one row per cell.
    const rows = [
      loss({ combo: 'legacy+legacy', configId: 'inc', weapon: 'sword', seed: 1 }),
      row({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 }),
      row({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 }), // duplicate
    ];
    const lb = buildLeaderboard(rows, {
      incumbentCombo: 'legacy+legacy',
      incumbentConfigId: 'inc',
    });
    const candidate = lb.find((r) => r.configId === 'a')!;
    expect(candidate.runs).toBe(2);
    expect(candidate.wins).toBe(2);
    // Delta must be null — duplicate rows make the comparison untrustworthy.
    expect(candidate.winsVsIncumbentDelta).toBeNull();
    expect(selectQualifiedWinner(lb).winner).toBeNull();
  });

  it('leaves winsVsIncumbentDelta null when the incumbent group contains duplicate (weapon,seed) rows', () => {
    // If the incumbent itself has a duplicated row its incumbentWins count is
    // inflated. The fix: treat the incumbent as having duplicate rows and null
    // out the delta rather than comparing against an inflated baseline.
    const rows = [
      loss({ combo: 'legacy+legacy', configId: 'inc', weapon: 'sword', seed: 1 }),
      loss({ combo: 'legacy+legacy', configId: 'inc', weapon: 'sword', seed: 1 }), // duplicate
      row({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 }),
    ];
    const lb = buildLeaderboard(rows, {
      incumbentCombo: 'legacy+legacy',
      incumbentConfigId: 'inc',
    });
    const candidate = lb.find((r) => r.configId === 'a')!;
    // Delta must be null — duplicate incumbent rows make the comparison untrustworthy.
    expect(candidate.winsVsIncumbentDelta).toBeNull();
    expect(selectQualifiedWinner(lb).winner).toBeNull();
  });

  it('rejects a candidate below the win-rate floor even with strictly more total wins than the incumbent', () => {
    const rows = [
      loss({ combo: 'legacy+legacy', configId: 'inc', weapon: 'sword', seed: 1 }),
      loss({ combo: 'legacy+legacy', configId: 'inc', weapon: 'bow', seed: 1 }),
      // Candidate has MORE total wins (1) than the incumbent (0), isolating
      // the win-rate floor clause: 50% < 90% must disqualify it on its own.
      row({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 }),
      loss({ combo: 'a+legacy', configId: 'a', weapon: 'bow', seed: 1 }),
    ];
    const lb = buildLeaderboard(rows, {
      incumbentCombo: 'legacy+legacy',
      incumbentConfigId: 'inc',
    });
    const candidate = lb.find((r) => r.configId === 'a')!;
    expect(candidate.winsVsIncumbentDelta).toBe(1); // strictly more wins…
    expect(candidate.winRate).toBe(0.5); // …but below the 90% floor.
    const selection = selectQualifiedWinner(lb);
    expect(selection.winner).toBeNull();
    expect(selection.reason).toMatch(/No candidate met the hard gate/);
  });

  it('disqualifies every candidate when no incumbent is identifiable (winsVsIncumbentDelta is null)', () => {
    // No incumbentCombo/incumbentConfigId supplied → winsVsIncumbentDelta is
    // null for every row, which must NEVER be treated as "strictly more wins".
    const rows = [
      row({ combo: 'legacy+legacy', configId: 'inc', weapon: 'sword', seed: 1 }),
      row({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 }),
    ];
    const lb = buildLeaderboard(rows);
    expect(lb.every((r) => r.winsVsIncumbentDelta === null)).toBe(true);
    const selection = selectQualifiedWinner(lb);
    expect(selection.winner).toBeNull();
    expect(selection.reason).toMatch(/No candidate met the hard gate/);
  });

  it('returns a "no candidates" reason when only the incumbent row is present', () => {
    const rows = [row({ combo: 'legacy+legacy', configId: 'inc', weapon: 'sword', seed: 1 })];
    const lb = buildLeaderboard(rows, {
      incumbentCombo: 'legacy+legacy',
      incumbentConfigId: 'inc',
    });
    const selection = selectQualifiedWinner(lb);
    expect(selection.winner).toBeNull();
    expect(selection.qualifying).toEqual([]);
    expect(selection.reason).toMatch(/No non-incumbent candidates/);
  });

  it('breaks ties among qualifiers by mean clear time (faster wins) when scores are equal', () => {
    const rows = [
      // Incumbent loses its only cell (0 wins) so both candidates below
      // strictly exceed it (1 win > 0), keeping them both qualified while
      // preserving the score tie the clear-time tie-break is meant to test.
      loss({ combo: 'legacy+legacy', configId: 'inc', weapon: 'sword', seed: 1 }),
      row({
        combo: 'a+legacy',
        configId: 'a',
        weapon: 'sword',
        seed: 1,
        score: 1_000_000,
        gameTimeMs: 90_000, // faster clear
      }),
      row({
        combo: 'b+legacy',
        configId: 'b',
        weapon: 'sword',
        seed: 1,
        score: 1_000_000,
        gameTimeMs: 120_000, // slower clear
      }),
    ];
    const lb = buildLeaderboard(rows, {
      incumbentCombo: 'legacy+legacy',
      incumbentConfigId: 'inc',
    });
    const selection = selectQualifiedWinner(lb);
    expect(selection.winner?.combo).toBe('a+legacy'); // faster clear wins the tie
  });

  it('honors a custom minWinRate override', () => {
    const rows = [
      // Incumbent: 1 win / 4 runs = 25% win rate, 1 total win.
      row({ combo: 'legacy+legacy', configId: 'inc', weapon: 'sword', seed: 1 }),
      loss({ combo: 'legacy+legacy', configId: 'inc', weapon: 'bow', seed: 1 }),
      loss({ combo: 'legacy+legacy', configId: 'inc', weapon: 'dagger', seed: 1 }),
      loss({ combo: 'legacy+legacy', configId: 'inc', weapon: 'staff', seed: 1 }),
      // Candidate: 2 wins / 4 runs = 50% win rate, 2 total wins — strictly
      // more than the incumbent's 1, so only the win-rate floor gates it.
      row({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 }),
      row({ combo: 'a+legacy', configId: 'a', weapon: 'bow', seed: 1 }),
      loss({ combo: 'a+legacy', configId: 'a', weapon: 'dagger', seed: 1 }),
      loss({ combo: 'a+legacy', configId: 'a', weapon: 'staff', seed: 1 }),
    ];
    const lb = buildLeaderboard(rows, {
      incumbentCombo: 'legacy+legacy',
      incumbentConfigId: 'inc',
    });
    const candidate = lb.find((r) => r.configId === 'a')!;
    expect(candidate.winsVsIncumbentDelta).toBe(1);
    // 50% win rate fails the default 90% floor…
    expect(selectQualifiedWinner(lb).winner).toBeNull();
    // …but qualifies under a relaxed 40% floor.
    expect(selectQualifiedWinner(lb, { minWinRate: 0.4 }).winner?.combo).toBe('a+legacy');
  });
});

describe('orderings', () => {
  it('sortByComposite ranks by Σ score; sortByLexicographic ranks wins-first', () => {
    // A: 1 win (huge time-bonus-laden score). B: 2 wins but lower total score.
    const rows = [
      row({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1, score: 5_000_000 }),
      loss({ combo: 'a+legacy', configId: 'a', weapon: 'bow', seed: 1 }),
      row({ combo: 'b+legacy', configId: 'b', weapon: 'sword', seed: 1, score: 1_000_000 }),
      row({ combo: 'b+legacy', configId: 'b', weapon: 'bow', seed: 1, score: 1_000_000 }),
    ];
    const lb = buildLeaderboard(rows);
    expect(sortByComposite(lb)[0]!.combo).toBe('a+legacy'); // 5M > 2M
    expect(sortByLexicographic(lb)[0]!.combo).toBe('b+legacy'); // 2 wins > 1 win
  });
});

describe('aggregate (end-to-end)', () => {
  it('flags divergence when the composite winner differs from the win-count winner', () => {
    const shards = [
      shard([
        row({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1, score: 5_000_000 }),
        loss({ combo: 'a+legacy', configId: 'a', weapon: 'bow', seed: 1 }),
        row({ combo: 'b+legacy', configId: 'b', weapon: 'sword', seed: 1, score: 1_000_000 }),
        row({ combo: 'b+legacy', configId: 'b', weapon: 'bow', seed: 1, score: 1_000_000 }),
      ]),
    ];
    // Synthetic scores (5M) can't arise under real scoring — they exist only to
    // force a ranking divergence — so opt out of the row-fact integrity check.
    const result = aggregate(shards, { verifyRowFacts: false });
    expect(result.winnersDiverge).toBe(true);
    expect(result.compositeWinner!.combo).toBe('a+legacy');
    expect(result.lexicographicWinner!.combo).toBe('b+legacy');
    expect(result.totalRuns).toBe(4);
  });

  it('does not flag divergence when both orderings agree', () => {
    const shards = [
      shard([
        row({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 }),
        row({ combo: 'a+legacy', configId: 'a', weapon: 'bow', seed: 1 }),
        loss({ combo: 'b+legacy', configId: 'b', weapon: 'sword', seed: 1 }),
        loss({ combo: 'b+legacy', configId: 'b', weapon: 'bow', seed: 1 }),
      ]),
    ];
    // row()/loss() fixtures are officialWin-consistent but use round synthetic
    // scores, so opt out of the row-fact integrity check for this ranking test.
    const result = aggregate(shards, { verifyRowFacts: false });
    expect(result.winnersDiverge).toBe(false);
    expect(result.compositeWinner!.combo).toBe('a+legacy');
  });

  it('propagates a completeness failure through the expected manifest', () => {
    const shards = [shard([row({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 })])];
    expect(() =>
      aggregate(shards, {
        expected: [
          { combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 },
          { combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 2 },
        ],
      }),
    ).toThrow(/Missing 1 expected run/);
  });

  it('accepts fully consistent rows under the default fact check', () => {
    const shards = [
      shard([
        consistent({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 }),
        consistent({
          combo: 'a+legacy',
          configId: 'a',
          weapon: 'bow',
          seed: 1,
          outcome: 'timeout',
          gameTimeMs: 396_000,
        }),
      ]),
    ];
    expect(() => aggregate(shards)).not.toThrow();
  });

  it('rejects (default) a row whose stored officialWin contradicts its raw facts', () => {
    // Raw facts are an over-budget timeout (a loss); flip the stored flag to lie "win".
    const liar = consistent({
      combo: 'a+legacy',
      configId: 'a',
      weapon: 'sword',
      seed: 1,
      outcome: 'timeout',
      gameTimeMs: 396_000,
    });
    liar.officialWin = true;
    expect(() => aggregate([shard([liar])])).toThrow(/officialWin/);
  });

  it('rejects (default) a row whose stored score contradicts a fresh recompute', () => {
    const inflated = consistent({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 });
    inflated.score += 1000; // tamper with the composite score only
    expect(() => aggregate([shard([inflated])])).toThrow(/score/);
  });
});

describe('assertRowsConsistent', () => {
  it('is a no-op for rows whose stored facts match the recompute', () => {
    const rows = [
      consistent({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 }),
      consistent({
        combo: 'a+legacy',
        configId: 'a',
        weapon: 'bow',
        seed: 1,
        outcome: 'timeout',
        gameTimeMs: 396_000,
      }),
    ];
    expect(() => assertRowsConsistent(rows, META.budgetMs)).not.toThrow();
  });

  it('throws when a stored score disagrees with the SSOT recompute', () => {
    const r = consistent({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 });
    r.score += 1;
    expect(() => assertRowsConsistent([r], META.budgetMs)).toThrow(/a\+legacy.*score/);
  });
});

describe('renderMarkdown', () => {
  it('renders the headline table and the divergence warning', () => {
    const shards = [
      shard([
        row({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1, score: 5_000_000 }),
        loss({ combo: 'a+legacy', configId: 'a', weapon: 'bow', seed: 1 }),
        row({ combo: 'b+legacy', configId: 'b', weapon: 'sword', seed: 1, score: 1_000_000 }),
        row({ combo: 'b+legacy', configId: 'b', weapon: 'bow', seed: 1, score: 1_000_000 }),
      ]),
    ];
    const md = renderMarkdown(aggregate(shards, { verifyRowFacts: false }));
    expect(md).toContain('AI combo eval');
    expect(md).toContain('Ranked by Σ composite score');
    expect(md).toContain('Composite-score winner ≠ win-count winner');
  });

  it('renders the qualified-winner section, calling out a disqualified composite leader', () => {
    const shards = [
      shard([
        // Incumbent wins 1 of the shared 2-cell panel.
        row({ combo: 'legacy+legacy', configId: 'inc', weapon: 'sword', seed: 1 }),
        loss({ combo: 'legacy+legacy', configId: 'inc', weapon: 'bow', seed: 1 }),
        // Flip-tainted, highest-score challenger: flips the incumbent's win
        // and recovers the incumbent's loss, so its total (1 win) only TIES
        // the incumbent — must be flagged as disqualified despite the huge score.
        loss({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 }),
        row({ combo: 'a+legacy', configId: 'a', weapon: 'bow', seed: 1, score: 9_000_000 }),
        // Lower-score qualifier with 2 wins — strictly more than the
        // incumbent's 1 — must be the recommended winner.
        row({ combo: 'b+legacy', configId: 'b', weapon: 'sword', seed: 1, score: 1_000_000 }),
        row({ combo: 'b+legacy', configId: 'b', weapon: 'bow', seed: 1, score: 1_000_000 }),
      ]),
    ];
    const md = renderMarkdown(
      aggregate(shards, {
        verifyRowFacts: false,
        incumbentCombo: 'legacy+legacy',
        incumbentConfigId: 'inc',
      }),
    );
    expect(md).toContain('Qualified winner (safety-gated recommendation)');
    expect(md).toContain('✅ **`b+legacy`** qualifies');
    expect(md).toContain('disqualified by the hard safety gate');
  });

  it('renders a "no candidate qualifies" line when the hard gate rejects everything', () => {
    const shards = [
      shard([
        row({ combo: 'legacy+legacy', configId: 'inc', weapon: 'sword', seed: 1 }),
        loss({ combo: 'a+legacy', configId: 'a', weapon: 'sword', seed: 1 }),
      ]),
    ];
    const md = renderMarkdown(
      aggregate(shards, {
        verifyRowFacts: false,
        incumbentCombo: 'legacy+legacy',
        incumbentConfigId: 'inc',
      }),
    );
    expect(md).toContain('🚫 **No candidate qualifies.**');
  });
});

describe('assertSearchArtifactProvenance', () => {
  const SEARCH_META: ShardMeta = { ...META, stage: 'search' };
  const EXPECTED = {
    combo: 'navmeshFused+slackAware',
    floorId: 'floor1',
    budgetMs: META.budgetMs,
    maxFrames: META.maxFrames,
    runnerOs: META.runnerOs,
    nodeVersion: META.nodeVersion,
    packageLockHash: META.packageLockHash,
    workflowSha: META.workflowSha,
  } as const;

  it('accepts a matching, current-schema search artifact', () => {
    expect(() =>
      assertSearchArtifactProvenance(SEARCH_META, EXPECTED.combo, EXPECTED),
    ).not.toThrow();
  });

  it('rejects a legacy artifact with no meta/provenance block', () => {
    expect(() => assertSearchArtifactProvenance(undefined, EXPECTED.combo, EXPECTED)).toThrow(
      /no meta\/provenance block/,
    );
  });

  it('rejects a pre-safe-room (older schema) artifact whose finalist used the raw-time win', () => {
    expect(() =>
      assertSearchArtifactProvenance(
        { ...SEARCH_META, schemaVersion: SHARD_SCHEMA_VERSION - 1 },
        EXPECTED.combo,
        EXPECTED,
      ),
    ).toThrow(/schema version .* != current/);
  });

  it('rejects a non-search-stage artifact', () => {
    expect(() =>
      assertSearchArtifactProvenance(
        { ...SEARCH_META, stage: 'validate' },
        EXPECTED.combo,
        EXPECTED,
      ),
    ).toThrow(/stage 'validate' != 'search'/);
  });

  it('rejects an artifact tuned on a different floor', () => {
    expect(() =>
      assertSearchArtifactProvenance(
        { ...SEARCH_META, floorId: 'floor2' },
        EXPECTED.combo,
        EXPECTED,
      ),
    ).toThrow(/floorId 'floor2' != 'floor1'/);
  });

  it('rejects an artifact tuned against a different win budget', () => {
    expect(() =>
      assertSearchArtifactProvenance(
        { ...SEARCH_META, budgetMs: EXPECTED.budgetMs - 1 },
        EXPECTED.combo,
        EXPECTED,
      ),
    ).toThrow(/win-budget .* != current/);
  });

  it('rejects an artifact tuned under a different frame cap', () => {
    expect(() =>
      assertSearchArtifactProvenance(
        { ...SEARCH_META, maxFrames: EXPECTED.maxFrames - 1 },
        EXPECTED.combo,
        EXPECTED,
      ),
    ).toThrow(/frame-cap .* != current/);
  });

  it('rejects an artifact whose finalist belongs to a different combo', () => {
    expect(() => assertSearchArtifactProvenance(SEARCH_META, 'legacy+legacy', EXPECTED)).toThrow(
      /combo 'legacy\+legacy' != requested/,
    );
  });

  it('rejects an artifact produced on a different runner OS', () => {
    expect(() =>
      assertSearchArtifactProvenance(
        { ...SEARCH_META, runnerOs: 'darwin-arm64' },
        EXPECTED.combo,
        EXPECTED,
      ),
    ).toThrow(/runner-OS 'darwin-arm64' != current/);
  });

  it('rejects an artifact produced under a different Node runtime', () => {
    expect(() =>
      assertSearchArtifactProvenance(
        { ...SEARCH_META, nodeVersion: 'v18.0.0' },
        EXPECTED.combo,
        EXPECTED,
      ),
    ).toThrow(/node-version 'v18\.0\.0' != current/);
  });

  it('rejects an artifact produced against different dependencies (package-lock hash)', () => {
    expect(() =>
      assertSearchArtifactProvenance(
        { ...SEARCH_META, packageLockHash: 'stalehash0000stalehash0000' },
        EXPECTED.combo,
        EXPECTED,
      ),
    ).toThrow(/package-lock 'stalehash0000stalehash0000' != current/);
  });

  it('rejects an artifact produced by a different code revision (workflow SHA) — the exact gap that let a stale --legacy-baseline be trusted', () => {
    expect(() =>
      assertSearchArtifactProvenance(
        { ...SEARCH_META, workflowSha: 'stalesha0000stalesha0000stalesha0' },
        EXPECTED.combo,
        EXPECTED,
      ),
    ).toThrow(/workflow-sha 'stalesha0000stalesha0000stalesha0' != current/);
  });
});
