import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Harvestable, Position } from '../../src/core/components.js';
import { RoomRole } from '../../src/shared/map-types.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { initializeFloor1Scenario } from '../../src/game/floorScenario.js';
import { createTestWorld } from '../helpers/world-factory.js';

const SEEDS = [1, 2, 3, 5, 7, 11, 13, 17, 23, 42, 99, 256];

function harvestableTiles(
  world: ReturnType<typeof createTestWorld>,
): Array<{ x: number; y: number }> {
  const floorMap = world.floorMap!;
  return Array.from(query(world.ecs, [Harvestable, Position])).map((eid) =>
    floorMap.worldToTile(world.stores.position.x[eid] ?? 0, world.stores.position.y[eid] ?? 0),
  );
}

describe('floor 1 harvestable placement', () => {
  it('never places harvestables in special rooms on representative seeds', () => {
    for (const seed of SEEDS) {
      const world = createTestWorld({ seed });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);

      const invalidTiles = harvestableTiles(world).filter((tile) => {
        const roomId = world.floorMap!.roomGraph.getRoomAt(tile.x, tile.y);
        const room = roomId >= 0 ? world.floorMap!.roomGraph.get(roomId) : undefined;
        return room?.role !== RoomRole.NORMAL;
      });
      expect(invalidTiles, `seed ${seed} must not place harvestables in special rooms`).toEqual([]);
    }
  });

  it('never places a harvestable on the player spawn tile', () => {
    for (const seed of SEEDS) {
      const world = createTestWorld({ seed });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);

      const spawnTile = world.floorMap!.playerSpawn;
      const onSpawnTile = harvestableTiles(world).some(
        (tile) => tile.x === spawnTile.x && tile.y === spawnTile.y,
      );
      expect(onSpawnTile, `seed ${seed} must not place a harvestable on the spawn tile`).toBe(
        false,
      );
    }
  });
});
