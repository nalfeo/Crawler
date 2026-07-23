/**
 * knockbackSystem — Flying entity bounds-clamping paths.
 *
 * The existing knockback-system.test.ts covers ground-entity movement (wall
 * collisions, substep blocking) but does not exercise the `isFlying` branch.
 * These tests pin the per-axis in-bounds check so each independently guards
 * against out-of-bounds displacement while the other axis moves freely.
 */
import { describe, expect, it } from 'vitest';
import { addComponent, set } from 'bitecs';
import { Flying, Knockback } from '../../src/core/components.js';
import { knockbackSystem } from '../../src/core/systems/knockbackSystem.js';
import { spawnEnemy } from '../../src/core/helpers.js';
import { makeWalledMap } from '../helpers/map-fixtures.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * makeWalledMap: 10×10 tiles at 32 ft/tile → widthFt = heightFt = 320.
 */
function makeWorldWithMap() {
  const world = createTestWorld();
  world.floorMap = makeWalledMap();
  return world;
}

describe('knockbackSystem — Flying entity bounds clamping', () => {
  it('moves a flying entity freely when the new position is within map bounds', () => {
    const world = makeWorldWithMap();
    const eid = spawnEnemy(world, 100, 100, 10);
    world.stores.weight.value[eid] = 120;
    addComponent(world.ecs, eid, Flying);
    addComponent(world.ecs, eid, set(Knockback, { dirX: 1, dirY: 0, remaining: 5, speed: 5 }));

    knockbackSystem(world);

    expect(world.stores.position.x[eid]).toBeCloseTo(105);
    expect(world.stores.position.y[eid]).toBeCloseTo(100);
  });

  it('clamps X but not Y when only the new X position is out of map bounds', () => {
    const world = makeWorldWithMap();
    // Place near left edge; knock back left so newX < 0.
    const eid = spawnEnemy(world, 2, 100, 10);
    world.stores.weight.value[eid] = 120;
    addComponent(world.ecs, eid, Flying);
    addComponent(world.ecs, eid, set(Knockback, { dirX: -1, dirY: 1, remaining: 5, speed: 5 }));

    knockbackSystem(world);

    // X would have been 2 + (-1 * 5) = -3, which is out of bounds → unchanged.
    expect(world.stores.position.x[eid]).toBeCloseTo(2);
    // Y would be 100 + 1 * 5 = 105, well within [0, 320) → updated.
    expect(world.stores.position.y[eid]).toBeCloseTo(105);
  });

  it('clamps Y but not X when only the new Y position is out of map bounds', () => {
    const world = makeWorldWithMap();
    // Place near bottom edge; knock back down so newY >= 320.
    const eid = spawnEnemy(world, 100, 318, 10);
    world.stores.weight.value[eid] = 120;
    addComponent(world.ecs, eid, Flying);
    addComponent(world.ecs, eid, set(Knockback, { dirX: 1, dirY: 1, remaining: 5, speed: 5 }));

    knockbackSystem(world);

    // X: 100 + 5 = 105, in bounds → updated.
    expect(world.stores.position.x[eid]).toBeCloseTo(105);
    // Y: 318 + 5 = 323 >= 320 → clamped, unchanged.
    expect(world.stores.position.y[eid]).toBeCloseTo(318);
  });

  it('clamps both X and Y when both new positions are out of map bounds', () => {
    const world = makeWorldWithMap();
    // Near the top-left corner; knock back diagonally out of bounds.
    const eid = spawnEnemy(world, 2, 2, 10);
    world.stores.weight.value[eid] = 120;
    addComponent(world.ecs, eid, Flying);
    addComponent(world.ecs, eid, set(Knockback, { dirX: -1, dirY: -1, remaining: 5, speed: 5 }));

    knockbackSystem(world);

    // Both newX = -3 and newY = -3 are out of bounds → neither updated.
    expect(world.stores.position.x[eid]).toBeCloseTo(2);
    expect(world.stores.position.y[eid]).toBeCloseTo(2);
  });

  it('updates maxKnockbackStepThisFrame for a flying entity that moves', () => {
    const world = makeWorldWithMap();
    const eid = spawnEnemy(world, 100, 100, 10);
    world.stores.weight.value[eid] = 120;
    addComponent(world.ecs, eid, Flying);
    addComponent(world.ecs, eid, set(Knockback, { dirX: 1, dirY: 0, remaining: 5, speed: 5 }));

    knockbackSystem(world);

    // Realized displacement = 5 ft along X.
    expect(world.maxKnockbackStepThisFrame).toBeCloseTo(5);
  });

  it('does not update maxKnockbackStepThisFrame when a flying entity is fully clamped', () => {
    const world = makeWorldWithMap();
    // Knock the entity straight out of bounds on both axes so realized displacement = 0.
    const eid = spawnEnemy(world, 1, 1, 10);
    world.stores.weight.value[eid] = 120;
    addComponent(world.ecs, eid, Flying);
    addComponent(world.ecs, eid, set(Knockback, { dirX: -1, dirY: -1, remaining: 5, speed: 5 }));

    knockbackSystem(world);

    expect(world.maxKnockbackStepThisFrame).toBe(0);
  });
});
