/**
 * statSystem — max-HP delta tracking regression tests.
 *
 * Verifies that statSystem tracks the delta against the previously DERIVED
 * effectiveStats.maxHp (not health.max), so external/floor bonuses written
 * directly to health.max are never erased by a no-stat-change tick, and CON
 * changes correctly add only their derived delta on top of the existing bonus.
 */
import { addComponent, addEntity, set } from 'bitecs';
import { describe, expect, it, beforeEach } from 'vitest';
import { createTestWorld } from '../helpers/world-factory.js';
import type { GameWorld } from '../../src/core/world.js';
import { Health } from '../../src/core/components.js';
import { initializeBaseStats } from '../../src/core/systems/equipmentSystem.js';
import { statSystem } from '../../src/core/systems/statSystem.js';
import { CORE_STAT_TO_SECONDARY } from '../../src/shared/stats.js';

const CON_TO_MAX_HP = CORE_STAT_TO_SECONDARY.constitution.maxHp!; // 10 HP per point

describe('statSystem — max-HP delta vs derived (floor bonus regression)', () => {
  let world: GameWorld;
  let entity: number;

  beforeEach(() => {
    world = createTestWorld();
    world.state = 'safe_room';
    entity = addEntity(world.ecs);
    // initializeBaseStats adds Equipment + BaseStats + EffectiveStats and
    // seeds health.max/current to the derived maxHp if Health is present.
    addComponent(world.ecs, entity, set(Health, { current: 0, max: 0 }));
    initializeBaseStats(world, entity);
    // After initialization health.max == effectiveStats.maxHp (derived).
    // Run one tick to ensure the first-tick delta-0 invariant holds.
    statSystem(world);
  });

  it('spawn seeds full HP correctly — health.max equals derived maxHp at start', () => {
    const derivedMax = world.stores.effectiveStats.maxHp[entity] ?? 0;
    const healthMax = world.stores.health.max[entity] ?? 0;
    expect(healthMax).toBe(derivedMax);
    expect(derivedMax).toBeGreaterThan(0);
  });

  it('repeated ticks with no stat change do not creep health.max', () => {
    const maxBefore = world.stores.health.max[entity] ?? 0;
    statSystem(world);
    statSystem(world);
    statSystem(world);
    expect(world.stores.health.max[entity]).toBe(maxBefore);
  });

  it('external floor +20 max-HP bonus persists across ticks with no stat change', () => {
    const derivedMax = world.stores.effectiveStats.maxHp[entity] ?? 0;
    // Simulate a per-floor manifest bonus written directly to health.max.
    world.stores.health.max[entity] = derivedMax + 20;

    // Multiple ticks without any CON change — bonus must be preserved.
    statSystem(world);
    statSystem(world);
    statSystem(world);

    expect(world.stores.health.max[entity]).toBe(derivedMax + 20);
  });

  it('CON increase after a floor bonus adds only its derived delta, not a reset', () => {
    const derivedMax = world.stores.effectiveStats.maxHp[entity] ?? 0;
    // Apply floor bonus.
    world.stores.health.max[entity] = derivedMax + 20;
    world.stores.health.current[entity] = derivedMax + 20;

    // Stable tick after bonus — bonus must persist.
    statSystem(world);
    expect(world.stores.health.max[entity]).toBe(derivedMax + 20);

    // Now allocate +1 CON (worth +10 maxHp from CORE_STAT_TO_SECONDARY).
    world.stores.coreStatPoints.constitution[entity] =
      (world.stores.coreStatPoints.constitution[entity] ?? 0) + 1;
    statSystem(world);

    // health.max must be (derivedMax + 20) + CON_DELTA, not derivedMax + CON_DELTA.
    const expectedMax = derivedMax + 20 + CON_TO_MAX_HP;
    expect(world.stores.health.max[entity]).toBe(expectedMax);
    expect(world.stores.health.current[entity]).toBe(expectedMax);
  });

  it('multiple CON changes each add exactly their derived delta', () => {
    const derivedMax = world.stores.effectiveStats.maxHp[entity] ?? 0;
    world.stores.health.max[entity] = derivedMax + 20;
    world.stores.health.current[entity] = derivedMax;

    statSystem(world);

    // CON +2 (two separate allocated points)
    world.stores.coreStatPoints.constitution[entity] = 2;
    statSystem(world);

    const expectedMax = derivedMax + 20 + 2 * CON_TO_MAX_HP;
    expect(world.stores.health.max[entity]).toBe(expectedMax);
    // current HP was below max and delta > 0, so it rises by delta.
    expect(world.stores.health.current[entity]).toBe(derivedMax + 2 * CON_TO_MAX_HP);
  });
});
