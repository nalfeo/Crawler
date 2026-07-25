/**
 * Interleaved same-process A/B microbench for `applyEffectiveStats`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The perf-optimizer skill (`.github/skills/perf-optimizer/SKILL.md`, rule 4
 * "report the win as a number... and the exact command that measures it")
 * requires that a perf claim be re-measurable by any future agent from the
 * committed tree. This bench is the reproducible evidence for the scratch-
 * buffer optimization in `src/core/effective-stats.ts`.
 *
 * Cross-process comparison of this codebase's ns/call has ~2.7x spread across
 * runs (JIT warmup, GC scheduling, background load), so a "run BEFORE, then
 * `git stash`, then run AFTER" workflow is NOT trustworthy — the noise
 * envelope is wider than most legitimate wins. This bench instead runs both
 * variants in the **same process**, interleaved round-by-round, so JIT state
 * and OS noise are shared.
 *
 * The BEFORE variant is inlined here (mirroring the pre-optimization shape of
 * `applyEffectiveStats`). It uses the still-exported allocating wrappers
 * `uniqueEquippedDefs` and `computeEffectiveStatsFromLoadout`, plus fresh
 * `base` / `core` records per call, reproducing the exact allocation pattern
 * from before the change. The AFTER variant is the shipped
 * `applyEffectiveStats` which reuses module-level scratch buffers.
 *
 * USAGE
 * -----
 *   npx tsx scripts/agent/perf/bench-effective-stats.ts
 *   npx tsx scripts/agent/perf/bench-effective-stats.ts 500000 9
 *                                                       ^iters  ^rounds
 *
 * OUTPUT
 * ------
 * JSON on stdout with per-round ns/call for both variants, medians, and the
 * BEFORE-worst / AFTER-best gap (a rough separation check).
 */

import { addEntity, addComponent } from 'bitecs';
import { createGameWorld } from '../../../src/core/world.js';
import { Health, Player } from '../../../src/core/components.js';
import {
  applyEffectiveStats,
  computeEffectiveStatsFromLoadout,
  uniqueEquippedDefs,
} from '../../../src/core/effective-stats.js';
import {
  equip,
  getEquipmentState,
  initializeBaseStats,
} from '../../../src/core/systems/equipmentSystem.js';
import {
  ALL_STAT_IDS,
  PRIMARY_STATS,
  type LegacyStatModifierLike,
} from '../../../src/shared/stats.js';
import { getEquipmentDefForStarterWeapon } from '../../../src/shared/equipmentDefs.js';
import type { GameWorld } from '../../../src/core/world.js';
import type { StatId, PrimaryStatId } from '../../../src/shared/stats.js';
import type { EquipmentState } from '../../../src/shared/equipment-types.js';

/**
 * Pre-optimization shape of `applyEffectiveStats`, kept in this bench file
 * only. Do NOT re-export this — it exists solely to measure the allocation
 * pattern the shipped version replaced. Behavior is identical to the current
 * `applyEffectiveStats`; the only difference is that each call allocates
 * fresh containers (base, core, defs, seen, eff) instead of reusing scratch.
 */
function applyEffectiveStatsAllocating(
  world: GameWorld,
  entity: number,
  equipmentState: EquipmentState | undefined,
  activeModifiers: readonly LegacyStatModifierLike[] = [],
): void {
  const stores = world.stores;
  const base = {} as Record<StatId, number>;
  for (const statId of ALL_STAT_IDS) {
    base[statId] = stores.baseStats[statId][entity] ?? 0;
  }
  const core = {} as Record<PrimaryStatId, number>;
  for (const p of PRIMARY_STATS) {
    core[p] = stores.coreStatPoints[p][entity] ?? 0;
  }
  // `uniqueEquippedDefs` allocates a fresh `Set` + fresh array per call;
  // `computeEffectiveStatsFromLoadout` allocates a fresh `Record` per call.
  // Together these reproduce the pre-optimization allocation churn.
  const eff = computeEffectiveStatsFromLoadout(
    base,
    core,
    uniqueEquippedDefs(world, equipmentState),
    activeModifiers,
  );
  for (const statId of ALL_STAT_IDS) {
    stores.effectiveStats[statId][entity] = eff[statId];
  }
}

interface BenchResult {
  iters: number;
  rounds: number;
  before: {
    perRoundNsPerCall: number[];
    medianNsPerCall: number;
    worstNsPerCall: number;
    bestNsPerCall: number;
  };
  after: {
    perRoundNsPerCall: number[];
    medianNsPerCall: number;
    worstNsPerCall: number;
    bestNsPerCall: number;
  };
  ratio: {
    medianSpeedup: number;
    afterBestVsBeforeWorst: number;
    distributionsDisjoint: boolean;
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function timeCalls(fn: () => void, iters: number): number {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i += 1) fn();
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / iters;
}

function main(): void {
  const iters = Number(process.argv[2] ?? '200000');
  const rounds = Number(process.argv[3] ?? '9');
  if (!Number.isFinite(iters) || iters <= 0) throw new Error('iters must be > 0');
  if (!Number.isFinite(rounds) || rounds <= 0) throw new Error('rounds must be > 0');

  const world = createGameWorld({ seed: 1 });
  world.state = 'playing';
  const eid = addEntity(world.ecs);
  addComponent(world.ecs, eid, Player);
  addComponent(world.ecs, eid, Health);
  world.stores.health.max[eid] = 170;
  world.stores.health.current[eid] = 170;
  initializeBaseStats(world, eid);

  // Equip a starter sword to represent the steady-state Floor 1 path:
  // `writeUniqueEquippedDefsInto` still allocates a wrapper object per
  // equipped instance, so an empty loadout would understate per-call cost.
  const swordDef = getEquipmentDefForStarterWeapon('sword');
  if (!swordDef) throw new Error('iron-sword def not found — equipmentDefs.ts changed?');
  const equipResult = equip(world, eid, swordDef, { force: true });
  if (!equipResult.ok) throw new Error('Failed to equip starter sword in bench');

  const state = getEquipmentState(world, eid);

  // Warm up both paths so the first measured round isn't a JIT outlier.
  for (let i = 0; i < 50000; i += 1) applyEffectiveStatsAllocating(world, eid, state, []);
  for (let i = 0; i < 50000; i += 1) applyEffectiveStats(world, eid, state, []);

  const before: number[] = [];
  const after: number[] = [];
  // Interleave BEFORE and AFTER round-by-round so JIT state, GC scheduling,
  // and OS noise apply symmetrically to both variants.
  for (let r = 0; r < rounds; r += 1) {
    before.push(timeCalls(() => applyEffectiveStatsAllocating(world, eid, state, []), iters));
    after.push(timeCalls(() => applyEffectiveStats(world, eid, state, []), iters));
  }

  const beforeMedian = median(before);
  const afterMedian = median(after);
  const beforeWorst = Math.max(...before);
  const beforeBest = Math.min(...before);
  const afterWorst = Math.max(...after);
  const afterBest = Math.min(...after);

  const result: BenchResult = {
    iters,
    rounds,
    before: {
      perRoundNsPerCall: before.map((v) => Math.round(v)),
      medianNsPerCall: Math.round(beforeMedian),
      worstNsPerCall: Math.round(beforeWorst),
      bestNsPerCall: Math.round(beforeBest),
    },
    after: {
      perRoundNsPerCall: after.map((v) => Math.round(v)),
      medianNsPerCall: Math.round(afterMedian),
      worstNsPerCall: Math.round(afterWorst),
      bestNsPerCall: Math.round(afterBest),
    },
    ratio: {
      medianSpeedup: Number((beforeMedian / afterMedian).toFixed(2)),
      afterBestVsBeforeWorst: Number((beforeWorst / afterBest).toFixed(2)),
      // Distributions are disjoint when even the worst AFTER round is faster
      // than the best BEFORE round — a strong (though not statistical) signal
      // that the observed win is not noise.
      distributionsDisjoint: afterWorst < beforeBest,
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main();
