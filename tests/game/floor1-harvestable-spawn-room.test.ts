import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Harvestable, Position } from '../../src/core/components.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { initializeFloor1Scenario } from '../../src/game/floorScenario.js';
import { createTestWorld } from '../helpers/world-factory.js';

const SEEDS = [1, 2, 3, 5, 7, 11, 13, 17, 23, 42, 99, 256];

function spawnRoomHarvestableTiles(
  world: ReturnType<typeof createTestWorld>,
): Array<{ x: number; y: number }> {
  const floorMap = world.floorMap!;
  const spawnRoom = floorMap.spawnRoom;
  if (!spawnRoom) {
    return [];
  }
  return Array.from(query(world.ecs, [Harvestable, Position]))
    .map((eid) =>
      floorMap.worldToTile(world.stores.position.x[eid] ?? 0, world.stores.position.y[eid] ?? 0),
    )
    .filter(
      (tile) =>
        tile.x >= spawnRoom.bounds.x &&
        tile.x < spawnRoom.bounds.x + spawnRoom.bounds.width &&
        tile.y >= spawnRoom.bounds.y &&
        tile.y < spawnRoom.bounds.y + spawnRoom.bounds.height,
    );
}

describe('floor 1 spawn-room harvestables', () => {
  it('places at least one harvestable in the spawn room on representative seeds', () => {
    for (const seed of SEEDS) {
      const world = createTestWorld({ seed });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);

      expect(
        spawnRoomHarvestableTiles(world).length,
        `seed ${seed} should spawn at least one harvestable in the spawn room`,
      ).toBeGreaterThan(0);
    }
  });

  it('never places the spawn-room harvestable on the player spawn tile', () => {
    for (const seed of SEEDS) {
      const world = createTestWorld({ seed });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);

      const spawnTile = world.floorMap!.playerSpawn;
      const onSpawnTile = spawnRoomHarvestableTiles(world).some(
        (tile) => tile.x === spawnTile.x && tile.y === spawnTile.y,
      );
      expect(onSpawnTile, `seed ${seed} must not place a harvestable on the spawn tile`).toBe(
        false,
      );
    }
  });
});
