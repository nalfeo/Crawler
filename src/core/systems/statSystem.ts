/**
 * Stat System — sole per-frame stat/HP maintenance.
 *
 * Recomputes `EffectiveStats` for every entity with Equipment + BaseStats using
 * the shared `applyEffectiveStats` formula (base stats + level-up core-stat
 * points + equipment + active ability/skill modifiers + derived secondaries,
 * clamped) and then syncs `Health.max`/`Health.current` from the freshly
 * derived `maxHp` via a delta — never an absolute overwrite — so repeated
 * ticks can never creep max HP, and external bonuses (e.g. per-floor +HP
 * written directly to `health.max`) are never erased.
 *
 * Delta is computed against the PREVIOUS DERIVED `effectiveStats.maxHp` (not
 * against `health.max`), so only changes in the stat formula propagate; any
 * additive floor/external bonus already baked into `health.max` above the
 * derived value is preserved across every tick.
 *
 * A fresh player's `Health` is seeded to the derived max at spawn (see
 * `equipmentSystem.initializeBaseStats`). Since `effectiveStats.maxHp` is
 * also set to that same value during initialization, the very first tick here
 * sees `prevDerivedMaxHp === newDerivedMaxHp` (delta 0) and changes nothing.
 *
 * `EffectiveStats` is the sole runtime stat snapshot — there is no separate
 * computed `Stats` component/system. Equipment changes also recompute eagerly
 * inside `equipmentSystem`; running this each frame in the sim loop guarantees
 * level-up core-stat allocation AND ability/skill modifiers flow into
 * combat-read stats (crit/dodge/cooldown/max HP) even when no equip event fired.
 *
 * Pure function: (world: GameWorld) => void — idempotent and deterministic.
 */

import { query } from 'bitecs';
import { Equipment, BaseStats, EffectiveStats } from '../components.js';
import type { GameWorld } from '../world.js';
import { applyEffectiveStats } from '../effective-stats.js';
import { syncHealthFromDerivedMaxHpDelta } from '../derived-max-hp.js';
import { getEquipmentState } from './equipmentSystem.js';

/**
 * Recompute EffectiveStats for all entities with Equipment + BaseStats, fold
 * in active (non-expired) ability/skill modifiers, and sync Health.max/current
 * from the derived maxHp via delta against the previously computed derived
 * value. External floor/HP bonuses written to health.max above the derived
 * value are preserved. Safe to call every frame — idempotent, deterministic.
 */
export function statSystem(world: GameWorld): void {
  const frameCount = world.frameCount;
  const activeModifiers = world.statModifiers.filter(
    (m) => m.expiresFrame === undefined || m.expiresFrame > frameCount,
  );
  if (activeModifiers.length !== world.statModifiers.length) {
    world.statModifiers = activeModifiers;
  }

  const entities = query(world.ecs, [Equipment, BaseStats, EffectiveStats]);
  for (const entity of entities) {
    // Snapshot the PREVIOUSLY DERIVED max HP (from EffectiveStats, not from
    // health.max) so external/floor bonuses written directly to health.max are
    // never erased by a no-stat-change tick. Only the *change* in the derived
    // value propagates; external additive bonuses are preserved.
    const prevDerivedMaxHp = world.stores.effectiveStats.maxHp[entity] ?? 0;

    applyEffectiveStats(world, entity, getEquipmentState(world, entity), activeModifiers);
    syncHealthFromDerivedMaxHpDelta(world, entity, prevDerivedMaxHp);
  }
}
