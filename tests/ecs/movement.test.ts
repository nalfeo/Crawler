import { addComponent, addEntity, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Position, Velocity } from '../../src/core/components.js';
import { movementSystem } from '../../src/core/systems/movementSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('movementSystem', () => {
  it('moves an entity by its velocity each frame', () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 10, y: 20 }));
    addComponent(world.ecs, eid, set(Velocity, { x: 1.5, y: -2.25 }));

    movementSystem(world);

    expect(world.stores.position.x[eid]).toBeCloseTo(11.5);
    expect(world.stores.position.y[eid]).toBeCloseTo(17.75);
  });

  it("doesn't move an entity with zero velocity", () => {
    const world = createTestWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: -8, y: 14 }));
    addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));

    movementSystem(world);

    expect(world.stores.position.x[eid]).toBe(-8);
    expect(world.stores.position.y[eid]).toBe(14);
  });

  it('moves multiple entities independently', () => {
    const world = createTestWorld();
    const first = addEntity(world.ecs);
    const second = addEntity(world.ecs);

    addComponent(world.ecs, first, set(Position, { x: 0, y: 0 }));
    addComponent(world.ecs, first, set(Velocity, { x: 2, y: 3 }));
    addComponent(world.ecs, second, set(Position, { x: 10, y: -5 }));
    addComponent(world.ecs, second, set(Velocity, { x: -4, y: 1 }));

    movementSystem(world);

    expect(world.stores.position.x[first]).toBe(2);
    expect(world.stores.position.y[first]).toBe(3);
    expect(world.stores.position.x[second]).toBe(6);
    expect(world.stores.position.y[second]).toBe(-4);
  });
});
