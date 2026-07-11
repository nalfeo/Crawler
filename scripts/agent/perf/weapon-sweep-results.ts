import type { RunStats } from '../../../src/game/ai/types.js';

export interface WeaponSweepRecord {
  weapon: string;
  seed: number;
  outcome: RunStats['outcome'];
  gameTimeSec: number;
  finalLevel: number;
  totalKills: number;
  totalXp: number;
  totalGold: number;
  score: number;
  minHealthPct: number;
  closeCallCount: number;
  questsCompleted: number;
}

export interface WeaponSweepSummary {
  weapon: string;
  runs: number;
  victories: number;
  winRate: number;
  meanGameTimeSec: number;
  meanLevel: number;
  meanKills: number;
  meanXp: number;
  meanScore: number;
  meanMinHealthPct: number;
  meanCloseCallCount: number;
  meanQuestsCompleted: number;
  records: WeaponSweepRecord[];
}

export interface WeaponSweepOutput {
  runAt: string;
  seeds: number[];
  weapons: string[];
  maxFrames: number;
  budgetSec: number;
  summaries: WeaponSweepSummary[];
  allRecords: WeaponSweepRecord[];
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeWeaponRecords(
  weapon: string,
  records: WeaponSweepRecord[],
): WeaponSweepSummary {
  if (records.length === 0) {
    throw new Error(`Cannot summarize weapon "${weapon}" without records`);
  }
  const victories = records.filter((record) => record.outcome === 'victory').length;
  return {
    weapon,
    runs: records.length,
    victories,
    winRate: victories / records.length,
    meanGameTimeSec: mean(records.map((record) => record.gameTimeSec)),
    meanLevel: mean(records.map((record) => record.finalLevel)),
    meanKills: mean(records.map((record) => record.totalKills)),
    meanXp: mean(records.map((record) => record.totalXp)),
    meanScore: mean(records.map((record) => record.score)),
    meanMinHealthPct: mean(records.map((record) => record.minHealthPct)),
    meanCloseCallCount: mean(records.map((record) => record.closeCallCount)),
    meanQuestsCompleted: mean(records.map((record) => record.questsCompleted)),
    records,
  };
}

export function mergeWeaponSweepShards(
  shards: readonly WeaponSweepOutput[],
  weapon: string,
  expectedSeeds: readonly number[],
): WeaponSweepOutput {
  if (shards.length === 0) {
    throw new Error(`No sweep shards found for weapon "${weapon}"`);
  }
  const maxFrames = shards[0]!.maxFrames;
  const bySeed = new Map<number, WeaponSweepRecord>();

  for (const shard of shards) {
    if (shard.maxFrames !== maxFrames) {
      throw new Error(`Shard frame-budget mismatch: ${shard.maxFrames} vs ${maxFrames}`);
    }
    if (shard.weapons.length !== 1 || shard.weapons[0] !== weapon) {
      throw new Error(`Shard weapon mismatch: expected only "${weapon}"`);
    }
    if (
      shard.seeds.length !== shard.allRecords.length ||
      shard.summaries.length !== 1 ||
      shard.summaries[0]?.records.length !== shard.allRecords.length
    ) {
      throw new Error(`Malformed shard coverage for weapon "${weapon}"`);
    }
    for (let index = 0; index < shard.seeds.length; index += 1) {
      const seed = shard.seeds[index]!;
      const record = shard.allRecords[index];
      if (!record || record.seed !== seed || record.weapon !== weapon) {
        throw new Error(`Out-of-order shard record for ${weapon}/${seed}`);
      }
      if (bySeed.has(seed)) {
        throw new Error(`Duplicate sweep record for ${weapon}/${seed}`);
      }
      bySeed.set(seed, record);
    }
  }

  const expectedSet = new Set(expectedSeeds);
  for (const seed of bySeed.keys()) {
    if (!expectedSet.has(seed)) {
      throw new Error(`Unexpected sweep record for ${weapon}/${seed}`);
    }
  }
  const missing = expectedSeeds.filter((seed) => !bySeed.has(seed));
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.length} sweep record(s) for ${weapon}: ${missing.join(', ')}`,
    );
  }

  const allRecords = expectedSeeds.map((seed) => bySeed.get(seed)!);
  const summary = summarizeWeaponRecords(weapon, allRecords);
  return {
    runAt: new Date().toISOString(),
    seeds: [...expectedSeeds],
    weapons: [weapon],
    maxFrames,
    budgetSec: maxFrames / 60,
    summaries: [summary],
    allRecords,
  };
}
