import { describe, expect, it } from 'vitest';
import { addComponent, hasComponent, set } from 'bitecs';
import { knockbackSystem } from '../../src/core/systems/knockbackSystem.js';
import { Knockback } from '../../src/core/components.js';
import { spawnEnemy } from '../../src/core/helpers.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('knockbackSystem', () => {
  it('removes the Knockback component immediately when speed is zero', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 10);
    addComponent(world.ecs, eid, set(Knockback, { dirX: 1, dirY: 0, remaining: 10, speed: 0 }));

    knockbackSystem(world);

    expect(hasComponent(world.ecs, eid, Knockback)).toBe(false);
  });

  it('removes the Knockback component when no distance remains', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 10);
    addComponent(world.ecs, eid, set(Knockback, { dirX: 1, dirY: 0, remaining: 0, speed: 5 }));

    knockbackSystem(world);

    expect(hasComponent(world.ecs, eid, Knockback)).toBe(false);
  });

  it('displaces the entity by one step and clears the component once exhausted', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 100, 100, 10);
    // remaining < speed so a single step exhausts the knockback.
    addComponent(world.ecs, eid, set(Knockback, { dirX: 1, dirY: 0, remaining: 4, speed: 10 }));

    knockbackSystem(world);

    // step = min(speed, remaining) = 4 -> moves +4 on x.
    expect(world.stores.position.x[eid]).toBeCloseTo(104);
    expect(hasComponent(world.ecs, eid, Knockback)).toBe(false);
  });

  it('keeps the component while distance remains across multiple frames', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 0, 0, 10);
    addComponent(world.ecs, eid, set(Knockback, { dirX: 0, dirY: 1, remaining: 10, speed: 4 }));

    knockbackSystem(world);
    expect(world.stores.position.y[eid]).toBeCloseTo(4);
    expect(hasComponent(world.ecs, eid, Knockback)).toBe(true);

    knockbackSystem(world);
    expect(world.stores.position.y[eid]).toBeCloseTo(8);
    expect(hasComponent(world.ecs, eid, Knockback)).toBe(true);

    knockbackSystem(world);
    expect(world.stores.position.y[eid]).toBeCloseTo(10);
    expect(hasComponent(world.ecs, eid, Knockback)).toBe(false);
  });
});
