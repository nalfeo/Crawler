import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Harvestable, Position } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { isPointInSafeSpace } from '../../src/core/safe-space.js';
import { initializeFloor1Scenario } from '../../src/game/floorScenario.js';
import { createTestWorld } from '../helpers/world-factory.js';

const SEEDS = [1, 2, 3, 5, 7, 11, 13, 17, 23, 42, 99, 256];

function safeSpaceHarvestableCount(world: ReturnType<typeof createTestWorld>): number {
  return query(world.ecs, [Harvestable, Position]).filter((eid) =>
    isPointInSafeSpace(world, world.stores.position.x[eid] ?? 0, world.stores.position.y[eid] ?? 0),
  ).length;
}

describe('floor 1 harvestables in safe-space regions', () => {
  it('never places harvestables in safe-space regions on representative seeds', () => {
    for (const seed of SEEDS) {
      const world = createTestWorld({ seed });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);

      expect(
        safeSpaceHarvestableCount(world),
        `seed ${seed} must keep safe space harvestable-free`,
      ).toBe(0);
    }
  });

  it('continues spawning harvestables in ordinary rooms', () => {
    for (const seed of SEEDS) {
      const world = createTestWorld({ seed });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);

      expect(query(world.ecs, [Harvestable, Position]).length).toBeGreaterThan(0);
    }
  });

  it('keeps the slime-rat room harvestable-free after it transitions to runtime safe space', () => {
    for (const seed of SEEDS) {
      const world = createTestWorld({ seed });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);

      const slimePos = world.floorScenario?.objective.slimeRatRoomPos;
      const floorMap = world.floorMap;
      expect(slimePos).toBeDefined();
      expect(floorMap).toBeDefined();
      const slimeTile = floorMap!.worldToTile(slimePos!.x, slimePos!.y);
      const slimeRoomId = floorMap!.roomGraph.getRoomAt(slimeTile.x, slimeTile.y);
      expect(slimeRoomId).toBeGreaterThanOrEqual(0);
      if (slimeRoomId < 0) {
        throw new Error(`seed ${seed} did not resolve slime-rat room id`);
      }
      world.clearedSafeRoomMap = floorMap!;
      world.clearedSafeRoomIds.add(slimeRoomId);

      expect(
        safeSpaceHarvestableCount(world),
        `seed ${seed} must keep runtime safe-space harvestable-free`,
      ).toBe(0);
    }
  });
});
