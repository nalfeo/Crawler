import { describe, expect, it } from 'vitest';
import { createGameWorld } from '../../src/core/world.js';
import { SeededRandom } from '../../src/shared/random.js';
import { addEntity, addComponent, query } from 'bitecs';
import { Position, Health } from '../../src/core/components.js';
import { set } from 'bitecs';

describe('createGameWorld', () => {
  it('returns a world with ECS state, RNG, stores, and frame metadata', () => {
    const world = createGameWorld();

    expect(world.ecs).toBeDefined();
    expect(typeof world.ecs).toBe('object');
    expect(world.stores).toBeDefined();
    expect(world.stores.position.x).toBeInstanceOf(Float32Array);
    expect(world.rng).toBeInstanceOf(SeededRandom);
    expect(world.frameCount).toBe(0);
    expect(world.elapsedMs).toBe(0);
  });

  it('uses the default seed of 42', () => {
    const world = createGameWorld();
    const expected = new SeededRandom(42);

    expect(world.rng.next()).toBe(expected.next());
  });

  it('uses the default floor of 1', () => {
    const world = createGameWorld();

    expect(world.floor).toBe(1);
  });

  it("starts in the 'playing' state", () => {
    const world = createGameWorld();

    expect(world.state).toBe('playing');
  });

  it('allows custom options to override defaults', () => {
    const world = createGameWorld({ seed: 7, floor: 3 });
    const expected = new SeededRandom(7);

    expect(world.floor).toBe(3);
    expect(world.rng.next()).toBe(expected.next());
  });

  it('wires component stores via onSet observers', () => {
    const world = createGameWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Position, { x: 42.5, y: 99.1 }));

    expect(world.stores.position.x[eid]).toBeCloseTo(42.5, 1);
    expect(world.stores.position.y[eid]).toBeCloseTo(99.1, 1);
  });

  it('wires Health store correctly', () => {
    const world = createGameWorld();
    const eid = addEntity(world.ecs);

    addComponent(world.ecs, eid, set(Health, { current: 80, max: 100 }));

    expect(world.stores.health.current[eid]).toBe(80);
    expect(world.stores.health.max[eid]).toBe(100);
  });

  it('supports querying entities by component', () => {
    const world = createGameWorld();
    const eid = addEntity(world.ecs);
    addComponent(world.ecs, eid, Position);

    const results = query(world.ecs, [Position]);
    expect(Array.from(results)).toContain(eid);
  });
});
