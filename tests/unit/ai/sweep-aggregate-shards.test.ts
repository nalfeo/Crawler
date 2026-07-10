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
  buildLeaderboard,
  deriveRunFacts,
  mergeShards,
  renderMarkdown,
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

  it('throws on a conflicting config definition for the same id', () => {
    const r = row({ combo: 'legacy+legacy', configId: 'c', weapon: 'sword', seed: 1 });
    const s1: ShardArtifact = {
      meta: META,
      configs: { c: { pathingMode: AIPathingMode.LEGACY, decisionMode: AIDecisionMode.LEGACY } },
      rows: [r],
    };
    const s2: ShardArtifact = {
      meta: META,
      // same id, different knobs → definitionally a runner bug / tamper
      configs: { c: { pathingMode: AIPathingMode.NAVMESH, decisionMode: AIDecisionMode.LEGACY } },
      rows: [row({ ...r, weapon: 'bow' })],
    };
    expect(() => mergeShards([s1, s2])).toThrow(/Conflicting config definition for id c/);
  });

  it('merges config definitions across shards', () => {
    const cfg = { pathingMode: AIPathingMode.LEGACY, decisionMode: AIDecisionMode.LEGACY };
    const s1: ShardArtifact = {
      meta: META,
      configs: { c: cfg },
      rows: [row({ combo: 'legacy+legacy', configId: 'c', weapon: 'sword', seed: 1 })],
    };
    const s2: ShardArtifact = {
      meta: META,
      configs: {},
      rows: [row({ combo: 'legacy+legacy', configId: 'c', weapon: 'bow', seed: 1 })],
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
    const cfg = { pathingMode: AIPathingMode.LEGACY, decisionMode: AIDecisionMode.LEGACY };
    const rows = [row({ combo: 'legacy+legacy', configId: 'c', weapon: 'sword', seed: 1 })];
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
});
