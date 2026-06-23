import { addComponent, entityExists, removeComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Bouncing, Velocity } from '../../src/core/components.js';
import {
  spawnBouncingProjectile,
  spawnProjectile,
  spawnReturningProjectile,
} from '../../src/core/helpers.js';
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
    tileSizeFt: 4,
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
    const offscreenRight = spawnProjectile(world, 187.5, 45, 0.625, 0, 10);
    const offscreenTop = spawnProjectile(world, 80, -25, 0, -0.625, 10);
    const inBounds = spawnProjectile(world, 80, 45, 0.625, 0, 10);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, offscreenRight)).toBe(false);
    expect(entityExists(world.ecs, offscreenTop)).toBe(false);
    expect(entityExists(world.ecs, inBounds)).toBe(true);
  });

  it('keeps projectiles within the cull margin', () => {
    const world = createTestWorld();
    // Just barely inside margin (ARENA.WIDTH_FT + 12.5 = 172.5 is the boundary)
    const nearEdge = spawnProjectile(world, 171.25, 45, 0.625, 0, 10);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, nearEdge)).toBe(true);
  });

  it('bounces bouncing projectiles off arena bounds and decrements remaining bounces', () => {
    const world = createTestWorld();
    const bouncing = spawnBouncingProjectile(world, -0.625, 45, -0.5, 0, 10, 2);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, bouncing)).toBe(true);
    expect(world.stores.bouncing.remainingBounces[bouncing]).toBe(1);
    expect(world.stores.velocity.x[bouncing]).toBe(0.5);
    expect(world.stores.position.x[bouncing]).toBe(0);
  });

  it('removes bouncing projectiles that leave play bounds with no bounces left', () => {
    const world = createTestWorld();
    const bouncing = spawnBouncingProjectile(world, -0.125, 45, -0.5, 0, 10, 0);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, bouncing)).toBe(false);
  });

  it('keeps non-bouncing projectiles using existing cleanup behavior', () => {
    const world = createTestWorld();
    const projectile = spawnProjectile(world, -0.125, 45, -0.5, 0, 10);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, projectile)).toBe(true);
  });

  it('does not process bounce for entities missing velocity component', () => {
    const world = createTestWorld();
    const bouncing = spawnProjectile(world, -0.625, 45, -0.5, 0, 10);
    // Simulate malformed data where bounce metadata exists but velocity tag was removed.
    world.stores.bouncing.remainingBounces[bouncing] = 1;
    addComponent(world.ecs, bouncing, Bouncing);
    removeComponent(world.ecs, bouncing, Velocity);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, bouncing)).toBe(true);
  });

  it('removes projectiles that hit impassable map tiles (stationary in wall)', () => {
    const world = createTestWorld();
    const floorMap = makeOpenMap();
    world.floorMap = floorMap;
    // Wall at tile (8, 8) -> projectile at pixel center should be culled.
    floorMap.tileMap.setFlags(8, 8, TilePresets.WALL);
    const inWall = spawnProjectile(world, 8 * 4 + 2, 8 * 4 + 2, 0, 0, 10);
    const inFloor = spawnProjectile(world, 9 * 4 + 2, 8 * 4 + 2, 0, 0, 10);

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
    const tileSize = 4;
    // Place projectile 0.125 ft before the wall boundary, velocity = 0.625 ft/frame (enters wall).
    const projX = 10 * tileSize - 0.125; // just before wall tile
    const projY = 10 * tileSize + 2; // vertically centred in wall tile row
    const headingIntoWall = spawnProjectile(world, projX, projY, 0.625, 0, 10);
    // Another projectile moving away from the wall — should survive.
    const movingAway = spawnProjectile(world, projX, projY, -0.625, 0, 10);

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, headingIntoWall)).toBe(false);
    expect(entityExists(world.ecs, movingAway)).toBe(true);
  });

  it('removes non-returning projectiles when they exceed max range', () => {
    const world = createTestWorld();
    const maxRange = 12.5;
    // Projectile spawned at (62.5, 45) with maxRange=12.5
    const eid = spawnProjectile(world, 62.5, 45, 0, 0, 10, 0, maxRange);
    // Move projectile to exactly at max range (12.5 feet away)
    world.stores.position.x[eid] = 62.5 + 12.5;
    world.stores.position.y[eid] = 45;

    projectileCleanupSystem(world);

    // Projectile at exactly max range should survive
    expect(entityExists(world.ecs, eid)).toBe(true);

    // Move projectile slightly beyond max range
    world.stores.position.x[eid] = 62.5 + 12.5125;
    projectileCleanupSystem(world);

    // Projectile beyond max range should be despawned
    expect(entityExists(world.ecs, eid)).toBe(false);
  });

  it('removes non-returning projectiles that exceed diagonal max range', () => {
    const world = createTestWorld();
    const maxRange = 12.5;
    const eid = spawnProjectile(world, 62.5, 45, 0, 0, 10, 0, maxRange);
    // Move projectile diagonally to distance > 12.5
    // sqrt(8.75^2 + 8.75^2) = ~12.37, sqrt(8.875^2 + 8.875^2) = ~12.55
    world.stores.position.x[eid] = 62.5 + 8.875;
    world.stores.position.y[eid] = 45 + 8.875;

    projectileCleanupSystem(world);

    expect(entityExists(world.ecs, eid)).toBe(false);
  });

  it('keeps projectiles with zero or no max range', () => {
    const world = createTestWorld();
    // Projectile with no maxRange tracking (legacy behavior)
    const noRange = spawnProjectile(world, 62.5, 45, 0.125, 0, 10, 0, 0);
    // Simulate movement far from origin, but within bounds (bounds are 0-160, 0-90, + 12.5 cull margin)
    world.stores.position.x[noRange] = 150;
    world.stores.position.y[noRange] = 85;

    projectileCleanupSystem(world);

    // Should be kept because maxRange=0 means unlimited range
    expect(entityExists(world.ecs, noRange)).toBe(true);
  });

  it('does not despawn returning projectiles at max range', () => {
    const world = createTestWorld();
    const player = 999; // Mock player entity ID
    const maxRange = 12.5;
    const returning = spawnReturningProjectile(
      world,
      62.5,
      45,
      1.25,
      0,
      10,
      player,
      0.625, // returnSpeed
      maxRange,
      0, // teamId
    );

    // Move returning projectile beyond maxRange
    world.stores.position.x[returning] = 62.5 + 18.75;
    world.stores.position.y[returning] = 45;

    projectileCleanupSystem(world);

    // Returning projectile should NOT be despawned (even though it's beyond max range)
    // It's managed by the Returning component, not the Projectile maxRange check
    expect(entityExists(world.ecs, returning)).toBe(true);
  });
});
