/**
 * Attack Wave Lab reset regression coverage.
 *
 * The lab's Reset action used to clear only the scheduler state, leaving every
 * previously spawned wave rat alive in the ECS. Once the lab reached
 * `maxAliveFromWaves`, a reset therefore left the population pinned at the cap
 * and the next Spawn action silently produced nothing at all. `despawnWaveRats`
 * is the extracted, DOM-free half of that reset so it can be covered here.
 */
import { describe, expect, it } from 'vitest';
import { query } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import { makeMapWithSafeRoom } from '../helpers/map-fixtures.js';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
import { attackWaveSystem } from '../../src/game/attack-wave-system.js';
import { despawnWaveRats } from '../../src/labs/attack-wave-lab/index.js';
import { AttackWaveRat, Enemy } from '../../src/core/components.js';
import tuning from '../../src/shared/data/tuning.json';

type TuningSchema = typeof tuning & {
  attackWaves: { intervalMs: number; packSize: number; maxAliveFromWaves: number };
};
const TUNING = tuning as TuningSchema;

function makeLabLikeWorld(): ReturnType<typeof createTestWorld> {
  const world = createTestWorld();
  world.floorId = 'floor1';
  world.floorMap = makeMapWithSafeRoom({ widthTiles: 120, heightTiles: 120 });
  spawnPlayer(world, 400, 400);
  world.attackWaveFlags.attackWaves = true;
  return world;
}

describe('attack wave lab reset', () => {
  it('despawns every wave rat and clears its side-car store state', () => {
    const world = makeLabLikeWorld();
    world.elapsedMs = TUNING.attackWaves.intervalMs;
    attackWaveSystem(world);

    const spawned = query(world.ecs, [Enemy, AttackWaveRat]);
    expect(spawned.length).toBe(TUNING.attackWaves.packSize);
    for (const eid of spawned) {
      expect(world.enemyAppearanceKeys.has(eid)).toBe(true);
    }
    const spawnedIds = Array.from(spawned);

    const removed = despawnWaveRats(world);

    expect(removed).toBe(TUNING.attackWaves.packSize);
    expect(query(world.ecs, [Enemy]).length).toBe(0);
    for (const eid of spawnedIds) {
      expect(world.enemyAppearanceKeys.has(eid)).toBe(false);
    }
  });

  it('lets a fresh wave spawn again after the alive cap was reached', () => {
    const world = makeLabLikeWorld();

    // Fill the wave population up to the configured cap.
    let guard = 0;
    while (
      query(world.ecs, [Enemy, AttackWaveRat]).length < TUNING.attackWaves.maxAliveFromWaves &&
      guard < 100
    ) {
      world.elapsedMs += TUNING.attackWaves.intervalMs;
      attackWaveSystem(world);
      guard += 1;
    }
    const atCap = query(world.ecs, [Enemy, AttackWaveRat]).length;
    expect(atCap).toBe(TUNING.attackWaves.maxAliveFromWaves);

    // At the cap the system is a no-op — this is what made the old reset look
    // broken to a lab user.
    world.elapsedMs += TUNING.attackWaves.intervalMs;
    attackWaveSystem(world);
    expect(query(world.ecs, [Enemy, AttackWaveRat]).length).toBe(atCap);

    // Reset behaviour: despawn, clear scheduler, spawn again.
    despawnWaveRats(world);
    world.attackWaveState = undefined;
    world.playerInSafeRoom = false;
    world.elapsedMs = TUNING.attackWaves.intervalMs;
    attackWaveSystem(world);

    expect(query(world.ecs, [Enemy, AttackWaveRat]).length).toBe(TUNING.attackWaves.packSize);
  });
});
