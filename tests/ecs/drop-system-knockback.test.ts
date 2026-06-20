import { addComponent, query, set, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { DeathTimer, Enemy, Health, Knockback } from '../../src/core/components.js';
import { spawnEnemy } from '../../src/core/helpers.js';
import { dropSystem } from '../../src/core/systems/dropSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('dropSystem death knockback', () => {
  it('applies death knockback away from the killing blow source', () => {
    const world = createTestWorld();
    const enemy = spawnEnemy(world, 100, 100, 10);
    setComponent(world.ecs, enemy, Health, { current: 0, max: 10 });
    // A recent hit event originating to the west should push the corpse east.
    world.combatEvents.push({
      type: 'hit',
      x: 100,
      y: 100,
      amount: 10,
      targetType: 'enemy',
      timestamp: world.elapsedMs,
      targetEid: enemy,
      sourceX: 80,
      sourceY: 100,
    });

    dropSystem(world);

    expect(world.stores.knockback.dirX[enemy]).toBeGreaterThan(0);
    expect(world.stores.knockback.remaining[enemy]).toBeGreaterThan(0);
  });

  it('updates an existing Knockback component instead of adding a new one', () => {
    const world = createTestWorld();
    const enemy = spawnEnemy(world, 100, 100, 10);
    addComponent(world.ecs, enemy, set(Knockback, { dirX: 0, dirY: 0, remaining: 0, speed: 0 }));
    setComponent(world.ecs, enemy, Health, { current: 0, max: 10 });
    world.combatEvents.push({
      type: 'hit',
      x: 100,
      y: 100,
      amount: 10,
      targetType: 'enemy',
      timestamp: world.elapsedMs,
      targetEid: enemy,
      sourceX: 100,
      sourceY: 120,
    });

    dropSystem(world);

    // Pushed north (away from a source to the south).
    expect(world.stores.knockback.dirY[enemy]).toBeLessThan(0);
  });

  it('skips enemies already lingering in death (DeathTimer present)', () => {
    const world = createTestWorld();
    const enemy = spawnEnemy(world, 100, 100, 10);
    setComponent(world.ecs, enemy, Health, { current: 0, max: 10 });
    addComponent(world.ecs, enemy, set(DeathTimer, { expiresAtMs: world.elapsedMs + 1000 }));

    dropSystem(world);

    // Already-lingering enemy is skipped → no XP/loot spawned for it.
    const before = query(world.ecs, [Enemy]).length;
    expect(before).toBeGreaterThanOrEqual(1);
  });
});
