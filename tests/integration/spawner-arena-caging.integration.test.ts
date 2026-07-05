/**
 * Integration test — a fired spawner-arena PHYSICALLY cages the player.
 *
 * This is the acceptance test the rule-12 miss called out: it doesn't matter
 * whether the fence VFX plays, whether the announcement fires, or whether
 * banked XP arithmetic is right — the primitive requirement is that once the
 * arena is armed, the player CANNOT walk out of the disc until the spawner
 * dies. The old flag-mutation fence path passed most tests while shipping a
 * cage that leaked through walls; this test drives the movement system
 * directly and asserts containment tick-by-tick.
 *
 * Scenario:
 *   1. Build a floor map WITHOUT a room (open cave) so the arena resolves as
 *      an open-fence ring — the path that used to leak.
 *   2. Place a spawner near the player.
 *   3. Walk the player into the disc so the arena arms.
 *   4. Then drive the player continuously OUTWARD via the movement system for
 *      120 ticks. Assert distance never exceeds the arena radius while the
 *      spawner is alive.
 *   5. Kill the spawner (deathResolved=1), tick, and assert the player is now
 *      free to leave (distance can grow past the radius).
 */
import { describe, expect, it } from 'vitest';
import { Velocity } from '../../src/core/components.js';
import { spawnPlayer, spawnSpawner } from '../../src/core/helpers.js';
import { movementSystem } from '../../src/core/systems/movementSystem.js';
import { spawnerArenaSystem } from '../../src/game/spawners/spawnerArenaSystem.js';
import { getSpawnerArchetype, getSpawnerArchetypeIndex } from '../../src/game/spawners/registry.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { attachBarriersToFloorMap } from '../../src/core/barriers/index.js';
import { setComponent } from 'bitecs';

const RATS_NEST_INDEX = getSpawnerArchetypeIndex('rats-nest');
const RATS_NEST = getSpawnerArchetype('rats-nest')!;

/** 40×40 all-floor map with a walled border — open-fence arena territory. */
function makeOpenFloorMap(): FloorMap {
  const w = 40;
  const h = 40;
  const config: MapConfig = {
    widthTiles: w,
    heightTiles: h,
    tileSizeFt: 4,
    biome: BiomeType.DUNGEON,
    seed: 1,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(w, h);
  tileMap.fill(TilePresets.FLOOR);
  for (let x = 0; x < w; x += 1) {
    tileMap.flags[x] = TilePresets.WALL;
    tileMap.flags[(h - 1) * w + x] = TilePresets.WALL;
  }
  for (let y = 0; y < h; y += 1) {
    tileMap.flags[y * w] = TilePresets.WALL;
    tileMap.flags[y * w + (w - 1)] = TilePresets.WALL;
  }
  // Add a scattering of interior walls that a naive fence-tile snapshot
  // would land on: this is the "ring includes a wall tile" case that used
  // to leak, forcing the test to demonstrate the barrier still cages.
  tileMap.flags[10 * w + 15] = TilePresets.WALL;
  tileMap.flags[10 * w + 25] = TilePresets.WALL;
  tileMap.flags[20 * w + 15] = TilePresets.WALL;
  tileMap.flags[20 * w + 25] = TilePresets.WALL;
  return new FloorMap(config, tileMap, new RoomGraph(), new Uint8Array(w * h), { x: 20, y: 20 });
}

function distance(x0: number, y0: number, x1: number, y1: number): number {
  return Math.hypot(x0 - x1, y0 - y1);
}

describe('spawner-arena caging — integration', () => {
  it('player cannot leave the arena disc once the arena is armed', () => {
    const world = createTestWorld();
    world.floorMap = makeOpenFloorMap();
    attachBarriersToFloorMap(world);

    // Spawner at the middle of the map.
    const spawnerX = 20 * 4 + 2;
    const spawnerY = 20 * 4 + 2;
    const spawnerEid = spawnSpawner(world, spawnerX, spawnerY, RATS_NEST.hp, {
      defIndex: RATS_NEST_INDEX,
      contactDamage: RATS_NEST.contactDamage,
      arenaRadiusFt: RATS_NEST.arenaRadiusFt,
    });

    // Player one tile away.
    const playerEid = spawnPlayer(world, spawnerX + 4, spawnerY);
    // Arm the arena.
    spawnerArenaSystem(world);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(1);

    const radiusFt = world.stores.spawner.arenaRadiusFt[spawnerEid]!;
    const startDist = distance(
      world.stores.position.x[playerEid]!,
      world.stores.position.y[playerEid]!,
      spawnerX,
      spawnerY,
    );
    expect(startDist).toBeLessThanOrEqual(radiusFt);

    // Drive the player straight OUTWARD via the movement system for 120 ticks.
    // Velocity is expressed as feet-per-tick (movementSystem integrates
    // directly without a dt scale) so we push ~1 ft/tick — well inside a
    // tile so the collision check cannot teleport the entity over the ring.
    const maxTicks = 200;
    let maxDistSeen = startDist;
    for (let tick = 0; tick < maxTicks; tick += 1) {
      const px = world.stores.position.x[playerEid]!;
      const py = world.stores.position.y[playerEid]!;
      const dx = px - spawnerX;
      const dy = py - spawnerY;
      const len = Math.hypot(dx, dy) || 1;
      setComponent(world.ecs, playerEid, Velocity, {
        x: (dx / len) * 1,
        y: (dy / len) * 1,
      });
      world.frameCount += 1;
      world.elapsedMs += 40;
      movementSystem(world);
      const d = distance(
        world.stores.position.x[playerEid]!,
        world.stores.position.y[playerEid]!,
        spawnerX,
        spawnerY,
      );
      if (d > maxDistSeen) maxDistSeen = d;
    }

    // Physical cage: player must not have escaped past the barrier ring. The
    // ring band centres on radiusFt with a half-tile tolerance either side —
    // the assertion is that the player never reached the OUTER edge of the
    // ring plus one tile of penetration.
    expect(maxDistSeen).toBeLessThanOrEqual(radiusFt + world.floorMap!.config.tileSizeFt);

    // ── Kill the spawner and confirm the barrier drops.
    world.stores.health.current[spawnerEid] = 0;
    world.stores.spawner.deathResolved[spawnerEid] = 1;
    spawnerArenaSystem(world);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(2);
    expect(world.barriers.blockedTiles.size).toBe(0);

    // Drive the player outward again — this time distance must grow past the radius.
    let escapedDist = 0;
    for (let tick = 0; tick < 200; tick += 1) {
      const px = world.stores.position.x[playerEid]!;
      const py = world.stores.position.y[playerEid]!;
      const dx = px - spawnerX;
      const dy = py - spawnerY;
      const len = Math.hypot(dx, dy) || 1;
      setComponent(world.ecs, playerEid, Velocity, {
        x: (dx / len) * 1,
        y: (dy / len) * 1,
      });
      world.frameCount += 1;
      world.elapsedMs += 40;
      movementSystem(world);
      escapedDist = distance(
        world.stores.position.x[playerEid]!,
        world.stores.position.y[playerEid]!,
        spawnerX,
        spawnerY,
      );
      if (escapedDist > radiusFt + world.floorMap!.config.tileSizeFt * 3) {
        break;
      }
    }
    expect(escapedDist).toBeGreaterThan(radiusFt + world.floorMap!.config.tileSizeFt);
  });
});
