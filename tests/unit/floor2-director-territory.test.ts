import { describe, expect, it } from 'vitest';
import { addComponent, query, set } from 'bitecs';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
import { Enemy, FamilyMembership, type GameWorld } from '../../src/core/index.js';
import { BiomeType } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import { SeededRandom } from '../../src/shared/random.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import {
  FLOOR2_TIMEOUT_GOAL_ID,
  floor2EnemyDirectorSystem,
  floor2ObjectiveTick,
  getQuadrantForPosition,
  getQuadrantSpawnWeights,
  resolveAmbientFamilyIndex,
} from '../../src/game/floor2Scenario.js';
import { spawnBehaviorEnemy } from '../../src/core/spawners/combatants.js';
import { createTestWorld } from '../helpers/world-factory.js';

function smallCaveConfig(seed: number): MapConfig {
  return {
    widthTiles: 80,
    heightTiles: 60,
    tileSizeFt: 4,
    biome: BiomeType.CAVE_SYSTEM,
    seed,
    roomWidthRange: [6, 12],
    roomHeightRange: [6, 12],
    maxRooms: 24,
    floorDensity: 0.45,
  };
}

function createFloor2World(seed: number): { world: GameWorld; playerEid: number } {
  const world = createTestWorld({ seed, floor: 2 });
  const floorMap = new CaveSystemGenerator({ presentCount: 4 }).generate(
    smallCaveConfig(seed),
    new SeededRandom(seed),
  );
  const spawnZoneRadius = Math.max(floorMap.width, floorMap.height);
  (
    floorMap as unknown as {
      territoryZones: Array<{
        familyIndex: number;
        centerX: number;
        centerY: number;
        radius: number;
      }>;
    }
  ).territoryZones = [
    {
      familyIndex: 0,
      centerX: floorMap.playerSpawn.x,
      centerY: floorMap.playerSpawn.y,
      radius: spawnZoneRadius,
    },
  ];
  world.floorMap = floorMap;
  world.floor = 2;
  world.floorId = 'floor2';
  world.state = 'playing';
  world.floorScenario = null;
  world.floorExtendedState = {
    familyState: {
      presentFamilies: ['goblins', 'llamas', 'geese', 'crabfolk'] as never,
      contestedResource: 'gold-veins' as never,
      betrayerFlag: false,
    },
    trashTerritories: new Map([
      ['N', 'cave-slime'],
      ['S', 'giant-cave-rat'],
      ['E', 'cave-bat-swarm'],
      ['W', 'rock-lice'],
    ]),
    ambientEnemyArchetypes: new Map<number, string>(),
  };
  const spawn = floorMap.tileToWorld(floorMap.playerSpawn.x, floorMap.playerSpawn.y);
  const playerEid = spawnPlayer(world, spawn.x, spawn.y);
  return { world, playerEid };
}

describe('Floor 2 quadrant helpers', () => {
  it('returns E/W for east-half positions and N/S for west-half positions', () => {
    const { world } = createFloor2World(77);
    const tileSize = world.floorMap!.config.tileSizeFt;
    const centerX = (world.floorMap!.width * tileSize) / 2;
    const centerY = (world.floorMap!.height * tileSize) / 2;

    expect(getQuadrantForPosition(world, centerX - 1, centerY - 1)).toBe('N');
    expect(getQuadrantForPosition(world, centerX - 1, centerY + 1)).toBe('S');
    expect(getQuadrantForPosition(world, centerX + 1, centerY - 1)).toBe('E');
    expect(getQuadrantForPosition(world, centerX + 1, centerY + 1)).toBe('W');
  });

  it('uses 50/20/20/10 weighting for the player quadrant and neighbors', () => {
    const east = getQuadrantSpawnWeights('E');
    expect(east.get('E')).toBe(0.5);
    expect(east.get('N')).toBe(0.2);
    expect(east.get('W')).toBe(0.2);
    expect(east.get('S')).toBe(0.1);
  });
});

describe('Floor 2 director/runtime behavior', () => {
  it('maps ambient family archetypes to present-family indices', () => {
    const { world } = createFloor2World(87);
    expect(resolveAmbientFamilyIndex(world, 'goblin-grunt')).toBe(0);
    expect(resolveAmbientFamilyIndex(world, 'llama-spitter')).toBe(1);
    expect(resolveAmbientFamilyIndex(world, 'cave-slime')).toBe(-1);
    expect(resolveAmbientFamilyIndex(world, 'not-a-real-archetype')).toBe(-1);
  });

  it('spawns and tracks ambient enemies when floorScenario is null', () => {
    const { world, playerEid } = createFloor2World(88);
    const firstZone = world.floorMap!.territoryZones[0];
    const spawn = firstZone
      ? world.floorMap!.tileToWorld(firstZone.centerX, firstZone.centerY)
      : world.floorMap!.tileToWorld(world.floorMap!.playerSpawn.x, world.floorMap!.playerSpawn.y);
    world.stores.position.x[playerEid] = spawn.x;
    world.stores.position.y[playerEid] = spawn.y;

    let tracked = world.floorExtendedState?.ambientEnemyArchetypes?.size ?? 0;
    for (let i = 0; i < 8 && tracked === 0; i += 1) {
      world.elapsedMs += 1000;
      floor2EnemyDirectorSystem(world);
      tracked = world.floorExtendedState?.ambientEnemyArchetypes?.size ?? 0;
    }

    expect(tracked).toBeGreaterThan(0);
    expect(query(world.ecs, [Enemy]).length).toBeGreaterThan(0);
  });

  it('transitions to game_over when the collapse timer expires', () => {
    const { world } = createFloor2World(99);
    world.elapsedMs = 1_200_000;
    world.state = 'playing';

    floor2ObjectiveTick(world);

    expect(world.state).toBe('game_over');
    expect(world.goalFlags.get(FLOOR2_TIMEOUT_GOAL_ID)).toBe(true);
  });

  it('nudges a boss off non-passable tiles before evaluating victory state', () => {
    const { world } = createFloor2World(101);
    const bossEid = spawnBehaviorEnemy(world, 0, 0, 50, 0, 0.12, 40, 0);
    addComponent(world.ecs, bossEid, set(FamilyMembership, { familyId: 0, isBoss: 1 }));

    const floorMap = world.floorMap!;
    const tileMap = floorMap.tileMap;
    let blockedTile: { x: number; y: number } | null = null;
    for (let y = 1; y < floorMap.height - 1 && blockedTile === null; y += 1) {
      for (let x = 1; x < floorMap.width - 1; x += 1) {
        if (tileMap.isPassable(x, y)) continue;
        const hasPassableNeighbor =
          tileMap.isPassable(x + 1, y) ||
          tileMap.isPassable(x - 1, y) ||
          tileMap.isPassable(x, y + 1) ||
          tileMap.isPassable(x, y - 1);
        if (hasPassableNeighbor) {
          blockedTile = { x, y };
          break;
        }
      }
    }
    expect(blockedTile).not.toBeNull();
    const blocked = floorMap.tileToWorld(blockedTile!.x, blockedTile!.y);
    world.stores.position.x[bossEid] = blocked.x;
    world.stores.position.y[bossEid] = blocked.y;

    floor2ObjectiveTick(world);

    const relocated = floorMap.worldToTile(
      world.stores.position.x[bossEid] ?? 0,
      world.stores.position.y[bossEid] ?? 0,
    );
    expect(floorMap.tileMap.isPassable(relocated.x, relocated.y)).toBe(true);
  });
});
