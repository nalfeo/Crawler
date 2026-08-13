import type { RunStats } from '../../../src/game/ai/types.js';

/**
 * Sentinel weapon ID used when running a sweep without a forced weapon (i.e.
 * each seed uses its own seed-determined default starting loadout).  This
 * allows the existing weapon-matrix pipeline to produce a single-arm A/B run
 * without requiring callers to pick an arbitrary real weapon.
 */
export const DEFAULT_LOADOUT_WEAPON_ID = 'default';

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
  floors?: number[];
  seeds: number[];
  weapons: string[];
  maxFrames: number;
  weaponPersonas: boolean;
  budgetSec: number;
  summaries: WeaponSweepSummary[];
  allRecords: WeaponSweepRecord[];
  /**
   * Whether optional AI purchases (merchant weapon + Spell Broker) were
   * enabled for this sweep arm.  Absent on pre-feature artifacts; treat as
   * `false` when missing.
   */
  optionalPurchases?: boolean;
  /**
   * Full RunStats for every run, in the same order as `allRecords`.  Present
   * when the sweep was run with full-stats recording enabled.  Consumed by
   * `fun-score.ts --input` via its `{ runs: RunStats[] }` normalisation path.
   * Absent on older artifacts written before this field was added.
   */
  runs?: RunStats[];
}

const VALID_RUN_OUTCOMES: ReadonlySet<RunStats['outcome']> = new Set([
  'victory',
  'death',
  'timeout',
  'stalled',
  'error',
]);

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

export function normalizeWeaponSweepFloors(value: unknown): number[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every(isPositiveInteger)) {
    throw new Error('Sweep floor metadata must be a non-empty array of positive integers');
  }
  return [...new Set(value)].sort((left, right) => left - right);
}

function isValidSweepRecord(value: unknown, expectedWeapon: string): value is WeaponSweepRecord {
  if (!isPlainObject(value)) {
    return false;
  }
  const record = value as Partial<WeaponSweepRecord>;
  return (
    record.weapon === expectedWeapon &&
    isPositiveInteger(record.seed) &&
    typeof record.outcome === 'string' &&
    VALID_RUN_OUTCOMES.has(record.outcome as RunStats['outcome']) &&
    isFiniteNumber(record.gameTimeSec) &&
    isFiniteNumber(record.finalLevel) &&
    isFiniteNumber(record.totalKills) &&
    isFiniteNumber(record.totalXp) &&
    isFiniteNumber(record.totalGold) &&
    isFiniteNumber(record.score) &&
    isFiniteNumber(record.minHealthPct) &&
    isFiniteNumber(record.closeCallCount) &&
    isFiniteNumber(record.questsCompleted)
  );
}

function isValidShardShape(value: unknown, expectedWeapon: string): value is WeaponSweepOutput {
  if (!isPlainObject(value)) {
    return false;
  }
  const shard = value as Partial<WeaponSweepOutput>;
  // `runs` is an optional backward-compatible field; validate its shape when present.
  const runsOk =
    shard.runs === undefined ||
    (Array.isArray(shard.runs) && shard.runs.every((r) => isPlainObject(r)));
  return (
    typeof shard.runAt === 'string' &&
    Array.isArray(shard.seeds) &&
    shard.seeds.every((seed) => isPositiveInteger(seed)) &&
    Array.isArray(shard.weapons) &&
    shard.weapons.length === 1 &&
    shard.weapons[0] === expectedWeapon &&
    isPositiveInteger(shard.maxFrames) &&
    typeof shard.weaponPersonas === 'boolean' &&
    isFiniteNumber(shard.budgetSec) &&
    Array.isArray(shard.summaries) &&
    shard.summaries.length === 1 &&
    isPlainObject(shard.summaries[0]) &&
    Array.isArray((shard.summaries[0] as { records?: unknown }).records) &&
    Array.isArray(shard.allRecords) &&
    runsOk
  );
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
  const firstShard = shards[0] as unknown;
  if (!isValidShardShape(firstShard, weapon)) {
    throw new Error(`Malformed shard payload for weapon "${weapon}"`);
  }
  const maxFrames = firstShard.maxFrames;
  const weaponPersonas = firstShard.weaponPersonas;
  // `optionalPurchases` is optional — absent on pre-feature shards (treat as false).
  const firstOptionalPurchases = firstShard.optionalPurchases ?? false;
  const bySeed = new Map<number, WeaponSweepRecord>();
  const runsBySeed = new Map<number, RunStats | undefined>();
  const includedFloors = new Set<number>();
  let hasLegacyFloorMetadata = false;

  for (const shard of shards) {
    if (!isValidShardShape(shard, weapon)) {
      throw new Error(`Malformed shard payload for weapon "${weapon}"`);
    }
    if (shard.maxFrames !== maxFrames) {
      throw new Error(`Shard frame-budget mismatch: ${shard.maxFrames} vs ${maxFrames}`);
    }
    if (shard.weaponPersonas !== weaponPersonas) {
      throw new Error(
        `Shard persona-mode mismatch for "${weapon}": ${shard.weaponPersonas} vs ${weaponPersonas}`,
      );
    }
    const shardOptionalPurchases = shard.optionalPurchases ?? false;
    if (shardOptionalPurchases !== firstOptionalPurchases) {
      throw new Error(
        `Shard optional-purchases mismatch for "${weapon}": expected ${firstOptionalPurchases} but got ${shardOptionalPurchases}. ` +
          'Mix of true/false shards in one aggregate run is not supported.',
      );
    }
    const shardFloors = normalizeWeaponSweepFloors(shard.floors);
    if (shardFloors === undefined) {
      hasLegacyFloorMetadata = true;
    } else {
      for (const floor of shardFloors) includedFloors.add(floor);
    }
    if (
      shard.seeds.length !== shard.allRecords.length ||
      shard.summaries.length !== 1 ||
      shard.summaries[0]?.records.length !== shard.allRecords.length
    ) {
      throw new Error(`Malformed shard coverage for weapon "${weapon}"`);
    }
    // Validate runs array length when present
    if (shard.runs !== undefined && shard.runs.length !== shard.seeds.length) {
      throw new Error(
        `Shard runs length mismatch for weapon "${weapon}": expected ${shard.seeds.length} but got ${shard.runs.length}`,
      );
    }
    for (let index = 0; index < shard.seeds.length; index += 1) {
      const seed = shard.seeds[index]!;
      const record = shard.allRecords[index];
      if (!isValidSweepRecord(record, weapon)) {
        throw new Error(`Malformed shard record for ${weapon}/${seed}`);
      }
      if (record.seed !== seed) {
        throw new Error(`Out-of-order shard record for ${weapon}/${seed}`);
      }
      if (bySeed.has(seed)) {
        throw new Error(`Duplicate sweep record for ${weapon}/${seed}`);
      }
      bySeed.set(seed, record);
      runsBySeed.set(seed, shard.runs?.[index]);
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

  // Only emit `runs` in the merged output when every shard contributed them.
  const hasRuns = expectedSeeds.every((seed) => runsBySeed.get(seed) !== undefined);
  const mergedRuns: RunStats[] | undefined = hasRuns
    ? expectedSeeds.map((seed) => runsBySeed.get(seed) as RunStats)
    : undefined;

  return {
    runAt: new Date().toISOString(),
    ...(hasLegacyFloorMetadata
      ? {}
      : { floors: [...includedFloors].sort((left, right) => left - right) }),
    seeds: [...expectedSeeds],
    weapons: [weapon],
    maxFrames,
    weaponPersonas,
    budgetSec: maxFrames / 60,
    summaries: [summary],
    allRecords,
    optionalPurchases: firstOptionalPurchases,
    ...(mergedRuns !== undefined ? { runs: mergedRuns } : {}),
  };
}
