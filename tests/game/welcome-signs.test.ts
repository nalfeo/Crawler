import { query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Sprite } from '../../src/core/components.js';
import { findTilePath } from '../../src/core/map/pathfinding.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { initializeFloor1Scenario } from '../../src/game/floor1Scenario.js';
import { createTestWorld } from '../helpers/world-factory.js';

// Mirror of the module-local SPRITE_TEX_WELCOME_SIGN in floor1Scenario.ts and
// PhaserBridge.ts. Kept local so the test fails loudly if that id ever changes.
const WELCOME_SIGN_TEXTURE_ID = 3;

// A spread of seeds: the earlier adjacency bug produced zero signs on every
// seed, so we sample enough distinct dungeons to catch regressions.
const SEEDS = [1, 2, 3, 5, 7, 11, 13, 17, 23, 42, 99, 256];

function welcomeSignEids(world: ReturnType<typeof createTestWorld>): number[] {
  return Array.from(query(world.ecs, [Sprite])).filter(
    (eid) => world.stores.sprite.textureId[eid] === WELCOME_SIGN_TEXTURE_ID,
  );
}

function initFloor1(seed: number): ReturnType<typeof createTestWorld> {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, player);
  return world;
}

function navigableRoomPath(world: ReturnType<typeof createTestWorld>): number[] {
  const floorMap = world.floorMap!;
  const welcomeTile = floorMap.pixelToTile(
    world.floor1!.objective.welcomeOfficePos.x,
    world.floor1!.objective.welcomeOfficePos.y,
  );
  const tilePath = findTilePath(floorMap, floorMap.playerSpawn, welcomeTile, {
    isTilePassable: (x, y) => floorMap.tileMap.isPassable(x, y) || floorMap.tileMap.isDoor(x, y),
  });
  const roomPath: number[] = [];
  for (const point of tilePath) {
    const roomId = floorMap.roomGraph.getRoomAt(point.x, point.y);
    if (roomId >= 0 && roomPath[roomPath.length - 1] !== roomId) {
      roomPath.push(roomId);
    }
  }
  return roomPath;
}

describe('floor 1 welcome signs', () => {
  it('spawns at least one welcome sign on every seed', () => {
    for (const seed of SEEDS) {
      const signs = welcomeSignEids(initFloor1(seed));
      expect(signs.length, `seed ${seed} should spawn a welcome sign`).toBeGreaterThanOrEqual(1);
    }
  });

  it('always places a welcome sign in the spawn room, but never on the player spawn tile', () => {
    for (const seed of SEEDS) {
      const world = initFloor1(seed);
      const floorMap = world.floorMap;
      expect(floorMap, `seed ${seed} should have a floor map`).not.toBeNull();

      const spawnRoom = floorMap!.spawnRoom;
      expect(spawnRoom, `seed ${seed} should have a spawn room`).not.toBeNull();

      const { x: rx, y: ry, width, height } = spawnRoom!.bounds;
      const spawnTile = floorMap!.playerSpawn;

      const signTiles = welcomeSignEids(world).map((eid) =>
        floorMap!.pixelToTile(world.stores.position.x[eid] ?? 0, world.stores.position.y[eid] ?? 0),
      );

      // A sign still guides the player out of the spawn room...
      const hasSpawnRoomSign = signTiles.some(
        (t) => t.x >= rx && t.x < rx + width && t.y >= ry && t.y < ry + height,
      );
      expect(hasSpawnRoomSign, `seed ${seed} should place a sign in the spawn room`).toBe(true);

      // ...but no sign is ever planted directly under the player's spawn tile.
      const onSpawnTile = signTiles.some((t) => t.x === spawnTile.x && t.y === spawnTile.y);
      expect(onSpawnTile, `seed ${seed} must not place a sign on the spawn tile`).toBe(false);
    }
  });

  it('regression: seed 731683 follows the navigable room path instead of pointing straight at the goal', () => {
    const world = initFloor1(731683);
    const floorMap = world.floorMap!;
    const roomPath = navigableRoomPath(world);
    expect(roomPath.length).toBeGreaterThan(6);

    const signSummaries = welcomeSignEids(world)
      .map((eid) => {
        const x = world.stores.position.x[eid] ?? 0;
        const y = world.stores.position.y[eid] ?? 0;
        const tile = floorMap.pixelToTile(x, y);
        return {
          roomId: floorMap.roomGraph.getRoomAt(tile.x, tile.y),
          angle: world.stores.rotation.angle[eid] ?? 0,
        };
      })
      .sort((a, b) => roomPath.indexOf(a.roomId) - roomPath.indexOf(b.roomId));

    expect(signSummaries.length).toBeGreaterThan(1);
    expect(signSummaries[0]?.roomId).toBe(roomPath[0]);

    let previousRoomIndex = -1;
    for (const sign of signSummaries) {
      const roomIndex = roomPath.indexOf(sign.roomId);
      expect(roomIndex).toBeGreaterThanOrEqual(0);
      expect(roomIndex).toBeGreaterThan(previousRoomIndex);
      if (previousRoomIndex >= 0) {
        expect(roomIndex - previousRoomIndex).toBeGreaterThanOrEqual(2);
        expect(roomIndex - previousRoomIndex).toBeLessThanOrEqual(3);
      }

      const room = floorMap.roomGraph.get(sign.roomId)!;
      const nextRoom = floorMap.roomGraph.get(roomPath[roomIndex + 1]!)!;
      const roomCenter = {
        x: Math.floor(room.bounds.x + room.bounds.width / 2),
        y: Math.floor(room.bounds.y + room.bounds.height / 2),
      };
      const nextCenter = {
        x: Math.floor(nextRoom.bounds.x + nextRoom.bounds.width / 2),
        y: Math.floor(nextRoom.bounds.y + nextRoom.bounds.height / 2),
      };
      const expectedAngle = Math.atan2(nextCenter.y - roomCenter.y, nextCenter.x - roomCenter.x);
      expect(sign.angle).toBeCloseTo(expectedAngle, 5);
      previousRoomIndex = roomIndex;
    }
  });
});
