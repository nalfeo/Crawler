import { describe, expect, it } from 'vitest';
import {
  mergeWeaponSweepShards,
  normalizeWeaponSweepFloors,
  summarizeWeaponRecords,
  type WeaponSweepOutput,
  type WeaponSweepRecord,
} from '../../scripts/agent/perf/weapon-sweep-results';

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

function shard(
  seeds: number[],
  weaponPersonas = false,
  floors: number[] | null = [1],
): WeaponSweepOutput {
  const records = seeds.map((seed) => record(seed));
  return {
    runAt: 'ignored',
    ...(floors === null ? {} : { floors }),
    seeds,
    weapons: ['sword'],
    maxFrames: 19_800,
    weaponPersonas,
    budgetSec: 330,
    summaries: [summarizeWeaponRecords('sword', records)],
    allRecords: records,
  };
}

describe('mergeWeaponSweepShards', () => {
  it('restores canonical seed order and recomputes the summary', () => {
    const result = mergeWeaponSweepShards([shard([2, 4]), shard([1, 3])], 'sword', [1, 2, 3, 4]);

    expect(result.seeds).toEqual([1, 2, 3, 4]);
    expect(result.floors).toEqual([1]);
    expect(result.allRecords.map(({ seed }) => seed)).toEqual([1, 2, 3, 4]);
    expect(result.summaries[0]).toMatchObject({
      weapon: 'sword',
      runs: 4,
      victories: 2,
      winRate: 0.5,
      meanScore: 12.5,
    });
    expect(result.weaponPersonas).toBe(false);
  });

  it('rejects duplicate seed coverage', () => {
    expect(() =>
      mergeWeaponSweepShards([shard([1, 2]), shard([2, 3])], 'sword', [1, 2, 3]),
    ).toThrow('Duplicate sweep record for sword/2');
  });

  it('rejects missing seed coverage', () => {
    expect(() => mergeWeaponSweepShards([shard([1, 3])], 'sword', [1, 2, 3])).toThrow(
      'Missing 1 sweep record(s) for sword: 2',
    );
  });

  it('rejects out-of-order records inside a shard', () => {
    const malformed = shard([1, 2]);
    malformed.allRecords.reverse();
    expect(() => mergeWeaponSweepShards([malformed], 'sword', [1, 2])).toThrow(
      'Out-of-order shard record for sword/1',
    );
  });

  it('rejects malformed records with missing numeric fields', () => {
    const malformed = shard([1]);
    malformed.allRecords[0] = {
      weapon: 'sword',
      seed: 1,
      outcome: 'victory',
    } as unknown as WeaponSweepRecord;
    expect(() => mergeWeaponSweepShards([malformed], 'sword', [1])).toThrow(
      'Malformed shard record for sword/1',
    );
  });

  it('rejects malformed summary payloads without records arrays', () => {
    const malformed = shard([1]);
    malformed.summaries = [{} as (typeof malformed.summaries)[number]];
    expect(() => mergeWeaponSweepShards([malformed], 'sword', [1])).toThrow(
      'Malformed shard payload for weapon "sword"',
    );
  });

  it('preserves persona mode when all shards agree', () => {
    const result = mergeWeaponSweepShards(
      [shard([1, 3], true), shard([2, 4], true)],
      'sword',
      [1, 2, 3, 4],
    );
    expect(result.weaponPersonas).toBe(true);
  });

  it('rejects mixed persona-mode shard payloads', () => {
    expect(() =>
      mergeWeaponSweepShards([shard([1], true), shard([2], false)], 'sword', [1, 2]),
    ).toThrow('Shard persona-mode mismatch for "sword": false vs true');
  });

  it('normalizes and unions floor provenance across shards', () => {
    const result = mergeWeaponSweepShards(
      [shard([1], false, [2, 1, 2]), shard([2], false, [3, 2])],
      'sword',
      [1, 2],
    );
    expect(result.floors).toEqual([1, 2, 3]);
  });

  it('omits floor provenance when any legacy shard lacks metadata', () => {
    const result = mergeWeaponSweepShards(
      [shard([1], false, [1]), shard([2], false, null)],
      'sword',
      [1, 2],
    );
    expect(result).not.toHaveProperty('floors');
  });

  it('rejects malformed present floor metadata instead of treating it as legacy', () => {
    expect(() => normalizeWeaponSweepFloors([])).toThrow(
      'Sweep floor metadata must be a non-empty array of positive integers',
    );
    expect(() => normalizeWeaponSweepFloors(['1'])).toThrow(
      'Sweep floor metadata must be a non-empty array of positive integers',
    );
  });
});
