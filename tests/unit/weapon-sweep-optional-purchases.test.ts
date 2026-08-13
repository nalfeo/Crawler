/**
 * Focused tests for the optional-purchases and default-loadout extensions to
 * the existing weapon-sweep pipeline.
 *
 * All tests are pure and side-effect-free — no headless simulation.
 */
import { describe, expect, it } from 'vitest';
import type { RunStats } from '../../src/game/ai/types.js';
import {
  DEFAULT_LOADOUT_WEAPON_ID,
  mergeWeaponSweepShards,
  summarizeWeaponRecords,
  type WeaponSweepOutput,
  type WeaponSweepRecord,
} from '../../scripts/agent/perf/weapon-sweep-results.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function record(seed: number, weapon = 'sword'): WeaponSweepRecord {
  return {
    weapon,
    seed,
    outcome: seed % 2 === 0 ? 'death' : 'victory',
    gameTimeSec: seed * 10,
    finalLevel: seed,
    totalKills: seed * 2,
    totalXp: seed * 3,
    totalGold: seed * 4,
    score: seed * 5,
    minHealthPct: seed / 10,
    closeCallCount: seed,
    questsCompleted: seed,
  };
}

/**
 * Minimal RunStats stub — only the fields that `isRunStats` in fun-score-lib
 * validates are populated.
 */
function stubRunStats(seed: number): RunStats {
  return {
    outcome: seed % 2 === 0 ? 'death' : 'victory',
    gameTimeMs: seed * 10_000,
    safeRoomMs: 0,
    startingWeapon: 'sword',
    finalLevel: seed,
    totalXp: seed * 3,
    totalGold: seed * 4,
    levelUps: [],
    combat: {
      totalKills: seed * 2,
      combatTimeMs: seed * 3_000,
      engagementCount: seed,
      damageDealt: seed * 100,
    },
    health: {
      minHealthPercent: seed / 10,
      closeCallCount: seed,
      lowHealthCount: seed,
      finalHealthPercent: 0.5,
    },
    quests: {
      questsAccepted: seed,
      questsCompleted: seed,
      firstQuestCompletedMs: null,
    },
  } as unknown as RunStats;
}

function shard(
  seeds: number[],
  weapon = 'sword',
  opts: { optionalPurchases?: boolean; runs?: RunStats[] } = {},
): WeaponSweepOutput {
  const records = seeds.map((s) => record(s, weapon));
  return {
    runAt: 'ignored',
    floors: [1],
    seeds,
    weapons: [weapon],
    maxFrames: 19_800,
    weaponPersonas: false,
    budgetSec: 330,
    summaries: [summarizeWeaponRecords(weapon, records)],
    allRecords: records,
    ...('optionalPurchases' in opts ? { optionalPurchases: opts.optionalPurchases } : {}),
    ...(opts.runs !== undefined ? { runs: opts.runs } : {}),
  };
}

// ---------------------------------------------------------------------------
// optionalPurchases field propagation
// ---------------------------------------------------------------------------

describe('mergeWeaponSweepShards — optionalPurchases propagation', () => {
  it('propagates optionalPurchases=false from shards (absent → defaults to false)', () => {
    // Shards written before the feature lack the field; default is false.
    const result = mergeWeaponSweepShards([shard([1, 2]), shard([3, 4])], 'sword', [1, 2, 3, 4]);
    expect(result.optionalPurchases).toBe(false);
  });

  it('propagates optionalPurchases=true when all shards carry true', () => {
    const result = mergeWeaponSweepShards(
      [
        shard([1, 2], 'sword', { optionalPurchases: true }),
        shard([3, 4], 'sword', { optionalPurchases: true }),
      ],
      'sword',
      [1, 2, 3, 4],
    );
    expect(result.optionalPurchases).toBe(true);
  });

  it('throws an actionable error when shards have mismatched optionalPurchases', () => {
    expect(() =>
      mergeWeaponSweepShards(
        [
          shard([1, 2], 'sword', { optionalPurchases: false }),
          shard([3, 4], 'sword', { optionalPurchases: true }),
        ],
        'sword',
        [1, 2, 3, 4],
      ),
    ).toThrow(/optional-purchases mismatch/i);
  });
});

// ---------------------------------------------------------------------------
// runs field merging
// ---------------------------------------------------------------------------

describe('mergeWeaponSweepShards — runs field', () => {
  it('merges runs from shards into canonical seed order', () => {
    const runs1 = [stubRunStats(2), stubRunStats(4)];
    const runs2 = [stubRunStats(1), stubRunStats(3)];
    const result = mergeWeaponSweepShards(
      [shard([2, 4], 'sword', { runs: runs1 }), shard([1, 3], 'sword', { runs: runs2 })],
      'sword',
      [1, 2, 3, 4],
    );
    expect(result.runs).toBeDefined();
    expect(result.runs).toHaveLength(4);
    // Canonical order: seed 1, 2, 3, 4 — verify the gameTimeMs tracks seed
    expect(result.runs![0]!.gameTimeMs).toBe(1 * 10_000);
    expect(result.runs![1]!.gameTimeMs).toBe(2 * 10_000);
    expect(result.runs![2]!.gameTimeMs).toBe(3 * 10_000);
    expect(result.runs![3]!.gameTimeMs).toBe(4 * 10_000);
  });

  it('omits runs from merged output when no shards carry runs', () => {
    // Pre-feature shards lack runs — merged result must not emit a partial array
    const result = mergeWeaponSweepShards([shard([1, 2]), shard([3, 4])], 'sword', [1, 2, 3, 4]);
    expect(result.runs).toBeUndefined();
  });

  it('omits runs when only some shards carry runs (partial is worse than none)', () => {
    const result = mergeWeaponSweepShards(
      [
        shard([1, 2], 'sword', { runs: [stubRunStats(1), stubRunStats(2)] }),
        shard([3, 4]), // no runs
      ],
      'sword',
      [1, 2, 3, 4],
    );
    expect(result.runs).toBeUndefined();
  });

  it('throws when runs length disagrees with seeds length in a shard', () => {
    expect(() =>
      mergeWeaponSweepShards(
        [shard([1, 2], 'sword', { runs: [stubRunStats(1)] })], // 2 seeds but 1 run
        'sword',
        [1, 2],
      ),
    ).toThrow(/runs length mismatch/i);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_LOADOUT_WEAPON_ID sentinel
// ---------------------------------------------------------------------------

describe('DEFAULT_LOADOUT_WEAPON_ID sentinel', () => {
  it('is the string "default"', () => {
    expect(DEFAULT_LOADOUT_WEAPON_ID).toBe('default');
  });

  it('mergeWeaponSweepShards accepts "default" as the weapon label', () => {
    const w = DEFAULT_LOADOUT_WEAPON_ID;
    const records2 = [2, 4].map((s) => record(s, w));
    const records1 = [1, 3].map((s) => record(s, w));
    const shardA: WeaponSweepOutput = {
      runAt: 'x',
      floors: [1],
      seeds: [2, 4],
      weapons: [w],
      maxFrames: 23_760,
      weaponPersonas: false,
      budgetSec: 396,
      summaries: [summarizeWeaponRecords(w, records2)],
      allRecords: records2,
    };
    const shardB: WeaponSweepOutput = {
      runAt: 'x',
      floors: [1],
      seeds: [1, 3],
      weapons: [w],
      maxFrames: 23_760,
      weaponPersonas: false,
      budgetSec: 396,
      summaries: [summarizeWeaponRecords(w, records1)],
      allRecords: records1,
    };
    const result = mergeWeaponSweepShards([shardA, shardB], w, [1, 2, 3, 4]);
    expect(result.weapons).toEqual([w]);
    expect(result.allRecords).toHaveLength(4);
    expect(result.allRecords[0]!.weapon).toBe(w);
  });
});
