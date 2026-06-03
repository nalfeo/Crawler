import { setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { spawnEnemy, Velocity, type GameWorld } from '../../src/core/index.js';
import { runSimFrame } from '../helpers/run-sim-frame.js';
import { createTestWorld } from '../helpers/world-factory.js';

function seedWorld(world: GameWorld, count: number): number[] {
  const entities: number[] = [];

  for (let i = 0; i < count; i++) {
    const eid = spawnEnemy(
      world,
      world.rng.nextInt(-500, 500),
      world.rng.nextInt(-500, 500),
      world.rng.nextInt(1, 100),
    );

    setComponent(world.ecs, eid, Velocity, {
      x: world.rng.nextInt(-4, 4),
      y: world.rng.nextInt(-4, 4),
    });

    entities.push(eid);
  }

  return entities;
}

describe('deterministic simulation', () => {
  it('produces identical positions for worlds with the same seed', () => {
    const worldA = createTestWorld({ seed: 1337 });
    const worldB = createTestWorld({ seed: 1337 });
    const entitiesA = seedWorld(worldA, 8);
    const entitiesB = seedWorld(worldB, 8);

    expect(entitiesA).toEqual(entitiesB);

    for (let frame = 0; frame < 120; frame++) {
      runSimFrame(worldA);
      runSimFrame(worldB);
    }

    const positionsA = entitiesA.map((eid) => ({
      x: worldA.stores.position.x[eid],
      y: worldA.stores.position.y[eid],
    }));
    const positionsB = entitiesB.map((eid) => ({
      x: worldB.stores.position.x[eid],
      y: worldB.stores.position.y[eid],
    }));

    expect(positionsA).toEqual(positionsB);
    expect(worldA.frameCount).toBe(worldB.frameCount);
    expect(worldA.elapsedMs).toBe(worldB.elapsedMs);
  });
});
