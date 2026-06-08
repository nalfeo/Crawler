import { entityExists } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { spawnProjectile } from '../../src/core/helpers.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { projectileCleanupSystem } from '../../src/core/systems/projectileCleanupSystem.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

function makeOpenMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: 20,
    heightTiles: 20,
    tileSizePx: 32,
    biome: BiomeType.ARENA,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(20, 20);
  tileMap.fill(TilePresets.FLOOR);
  return new FloorMap(config, tileMap, new RoomGraph(), new Uint8Array(400), { x: 10, y: 10 });
}

describe('projectileCleanupSystem', () => {
  it('removes projectiles that leave game bounds', () => {
    const world = createTestWorld();
    const offscreenRight = spawnProjectile(world, 1500, 360, 5, 0, 10);
    const offscreenTop = spawnProjectile(world, 640, -200, 0, -5, 10);
    const inBounds = spawnProjectile(world, 640, 360, 5, 0, 10);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, offscreenRight)).toBe(false);
    expect(entityExists(world.ecs, offscreenTop)).toBe(false);
    expect(entityExists(world.ecs, inBounds)).toBe(true);
  });

  it('keeps projectiles within the cull margin', () => {
    const world = createTestWorld();
    // Just barely inside margin (GAME.WIDTH + 100 = 1380 is the boundary)
    const nearEdge = spawnProjectile(world, 1370, 360, 5, 0, 10);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, nearEdge)).toBe(true);
  });

  it('removes projectiles that hit impassable map tiles (stationary in wall)', () => {
    const world = createTestWorld();
    const floorMap = makeOpenMap();
    world.floorMap = floorMap;
    // Wall at tile (8, 8) -> projectile at pixel center should be culled.
    floorMap.tileMap.setFlags(8, 8, TilePresets.WALL);
    const inWall = spawnProjectile(world, 8 * 32 + 16, 8 * 32 + 16, 0, 0, 10);
    const inFloor = spawnProjectile(world, 9 * 32 + 16, 8 * 32 + 16, 0, 0, 10);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, inWall)).toBe(false);
    expect(entityExists(world.ecs, inFloor)).toBe(true);
  });

  it('removes projectiles whose next position is fully blocked by a wall', () => {
    const world = createTestWorld();
    const floorMap = makeOpenMap();
    world.floorMap = floorMap;
    // Wall at tile (10, 10). Projectile is on tile (9, 10) moving right (+vx)
    // into the wall — all three slide candidates blocked.
    floorMap.tileMap.setFlags(10, 10, TilePresets.WALL);
    const tileSize = 32;
    // Place projectile 1 pixel before the wall boundary, velocity = 5 px/frame (enters wall).
    const projX = 10 * tileSize - 1; // pixel just before wall tile
    const projY = 10 * tileSize + 16; // vertically centred in wall tile row
    const headingIntoWall = spawnProjectile(world, projX, projY, 5, 0, 10);
    // Another projectile moving away from the wall — should survive.
    const movingAway = spawnProjectile(world, projX, projY, -5, 0, 10);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, headingIntoWall)).toBe(false);
    expect(entityExists(world.ecs, movingAway)).toBe(true);
  });
});
