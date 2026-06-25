import { addComponent, entityExists } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Stats } from '../../src/core/components.js';
import {
  spawnEnemy,
  spawnEnemyProjectile,
  spawnPlayer,
  spawnProjectile,
} from '../../src/core/helpers.js';
import { collisionSystem } from '../../src/core/systems/collisionSystem.js';
import { damageSystem } from '../../src/core/systems/damageSystem.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { BiomeType, RoomRole, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

const MAP_CFG: MapConfig = {
  widthTiles: 12,
  heightTiles: 12,
  tileSizePx: 32,
  biome: BiomeType.DUNGEON,
  seed: 1,
  roomWidthRange: [4, 8],
  roomHeightRange: [4, 8],
  maxRooms: 2,
  floorDensity: 0.5,
};

/** Safe room covering tiles (1,1)–(4,4). */
function makeSafeRoomMap(): FloorMap {
  const w = 12;
  const h = 12;
  const tileMap = new TileMap(w, h);
  for (let i = 0; i < w * h; i += 1) {
    tileMap.flags[i] = TilePresets.FLOOR;
  }
  const graph = new RoomGraph();
  graph.add({ x: 1, y: 1, width: 4, height: 4 }, [], [], RoomRole.SAFE);
  return new FloorMap(MAP_CFG, tileMap, graph, new Uint8Array(w * h), { x: 2, y: 2 });
}

describe('damageSystem enemy-projectile and safe-space branches', () => {
  it('damages the player and destroys an enemy projectile on hit', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const projectile = spawnEnemyProjectile(world, 4, 0, 0, 0, 7);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBeLessThan(100);
    expect(entityExists(world.ecs, projectile)).toBe(false);
  });

  it('destroys an enemy projectile without damage when the player is in a safe space', () => {
    const world = createTestWorld();
    world.floorMap = makeSafeRoomMap();
    // Tile (2,2) centre -> inside the safe room.
    const player = spawnPlayer(world, 2 * 32 + 16, 2 * 32 + 16);
    const projectile = spawnEnemyProjectile(world, 2 * 32 + 18, 2 * 32 + 16, 0, 0, 7);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBe(100);
    expect(entityExists(world.ecs, projectile)).toBe(false);
  });

  it('blocks an enemy projectile during the invincibility window', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    spawnEnemyProjectile(world, 4, 0, 0, 0, 7);

    damageSystem(world, collisionSystem(world));
    const healthAfterFirst = world.stores.health.current[player]!;
    world.combatEvents.length = 0;

    // Second projectile within the invincibility window is blocked.
    spawnEnemyProjectile(world, 4, 0, 0, 0, 7);
    world.elapsedMs += 50;
    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBe(healthAfterFirst);
    expect(world.combatEvents.some((e) => e.type === 'blocked')).toBe(true);
  });

  it('does not damage the player from enemy contact while in a safe space', () => {
    const world = createTestWorld();
    world.floorMap = makeSafeRoomMap();
    const player = spawnPlayer(world, 2 * 32 + 16, 2 * 32 + 16);
    spawnEnemy(world, 2 * 32 + 18, 2 * 32 + 16, 25);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBe(100);
  });

  it('reduces contact damage by the player armor stat (min 1)', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    // Stats component gates armor mitigation; the armor value lives in the stats store.
    addComponent(world.ecs, player, Stats);
    world.stores.stats.armor[player] = 100;
    spawnEnemy(world, 8, 0, 25);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[player]).toBe(99);
  });
});

describe('damageSystem hit-gated weapon-skill XP', () => {
  it('emits weapon_fired events for both skills when a player-owned projectile hits an enemy', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 100, 0, 50);
    // Mirror a successful weapon dispatch registering the active weapon's skills.
    world.attackerWeaponSkills.set(player, { classSkillId: 'slashing', typeSkillId: 'sword' });
    // Player-owned projectile overlapping the enemy so the collision lands.
    spawnProjectile(world, 100, 0, 0, 0, 10, 0, 0, 1, player);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[enemy]).toBeLessThan(50);
    const fired = world.skillUsageEvents.filter((e) => e.metric === 'weapon_fired');
    expect(fired).toHaveLength(2);
    expect(fired.map((e) => e.skillId).sort()).toEqual(['slashing', 'sword']);
    expect(fired.every((e) => e.holderEid === player)).toBe(true);
  });

  it('emits no skill events when an owner-less projectile hits an enemy (-1 guard)', () => {
    const world = createTestWorld();
    const enemy = spawnEnemy(world, 100, 0, 50);
    // No Owner component → ownerEid resolves to -1 and the emission is skipped.
    spawnProjectile(world, 100, 0, 0, 0, 10);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[enemy]).toBeLessThan(50);
    expect(world.skillUsageEvents).toHaveLength(0);
  });

  it('emits no skill events when the owner has no registered weapon skills', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 100, 0, 50);
    // Owner present but attackerWeaponSkills not populated (no prior dispatch).
    spawnProjectile(world, 100, 0, 0, 0, 10, 0, 0, 1, player);

    damageSystem(world, collisionSystem(world));

    expect(world.stores.health.current[enemy]).toBeLessThan(50);
    expect(world.skillUsageEvents).toHaveLength(0);
  });
});
