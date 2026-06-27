import { query, removeEntity } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { AreaDamage } from '../../src/core/components.js';
import { spawnAoeProjectile, spawnPlayer } from '../../src/core/helpers.js';
import {
  aoeOnImpactPostDamage,
  aoeOnImpactPreDamage,
} from '../../src/core/systems/aoeOnImpactSystem.js';
import { TeamId } from '../../src/shared/constants.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { BiomeType, RoomRole, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

const MAP_CFG: MapConfig = {
  widthTiles: 20,
  heightTiles: 20,
  tileSizeFt: 32,
  biome: BiomeType.DUNGEON,
  seed: 1,
  roomWidthRange: [4, 8],
  roomHeightRange: [4, 8],
  maxRooms: 4,
  floorDensity: 0.5,
};

function makeMapWithSafeRoom(): FloorMap {
  const w = 20;
  const h = 20;
  const tileMap = new TileMap(w, h);
  for (let i = 0; i < w * h; i += 1) {
    tileMap.flags[i] = TilePresets.FLOOR;
  }
  const graph = new RoomGraph();
  graph.add({ x: 1, y: 1, width: 4, height: 4 }, [], [], RoomRole.SAFE);
  return new FloorMap(MAP_CFG, tileMap, graph, new Uint8Array(w * h), { x: 12, y: 12 });
}

const SAFE_FT = { x: 3 * 32 + 16, y: 3 * 32 + 16 };

function countAreaAttacks(world: ReturnType<typeof createTestWorld>): number {
  return Array.from(query(world.ecs, [AreaDamage])).length;
}

describe('aoeOnImpactSystem', () => {
  it('spawns an area attack when a destroyed AoE projectile had a radius', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 200, 200);
    const proj = spawnAoeProjectile(world, 100, 100, 1, 0, 10, 30, 20, player, TeamId.PLAYER);

    aoeOnImpactPreDamage(world);
    // Simulate the projectile being destroyed by damageSystem.
    removeEntity(world.ecs, proj);
    aoeOnImpactPostDamage(world);

    expect(countAreaAttacks(world)).toBe(1);
  });

  it('does not spawn an explosion while the projectile is still alive', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 200, 200);
    spawnAoeProjectile(world, 100, 100, 1, 0, 10, 30, 20, player, TeamId.PLAYER);

    aoeOnImpactPreDamage(world);
    aoeOnImpactPostDamage(world);

    expect(countAreaAttacks(world)).toBe(0);
  });

  it('suppresses the explosion when the owner is inside a safe room', () => {
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoom();
    const player = spawnPlayer(world, SAFE_FT.x, SAFE_FT.y);
    const proj = spawnAoeProjectile(
      world,
      SAFE_FT.x,
      SAFE_FT.y,
      1,
      0,
      10,
      30,
      20,
      player,
      TeamId.PLAYER,
    );

    aoeOnImpactPreDamage(world);
    removeEntity(world.ecs, proj);
    aoeOnImpactPostDamage(world);

    expect(countAreaAttacks(world)).toBe(0);
  });

  it('is a no-op when there are no AoE projectiles', () => {
    const world = createTestWorld();
    aoeOnImpactPreDamage(world);
    expect(() => aoeOnImpactPostDamage(world)).not.toThrow();
    expect(countAreaAttacks(world)).toBe(0);
  });
});
