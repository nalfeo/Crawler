import { afterEach, describe, expect, it } from 'vitest';
import { query } from 'bitecs';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
import { DoorState } from '../../src/core/index.js';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType, RoomRole } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system.js';
import type { FloorMap } from '../../src/core/map/FloorMap.js';
import { FLOOR2_STAIR_MARKER_RADIUS_FT } from '../../src/shared/constants.js';
import { initializeFloor2Scenario } from '../../src/game/floor2Scenario.js';
import { getFloorManifest, registerFloorManifest } from '../../src/shared/floor-registry.js';
import { getQuestDef } from '../../src/shared/quest-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

const originalFloor2Manifest = structuredClone(getFloorManifest('floor2')!);

function createScenarioWorld() {
  const world = createTestWorld({ seed: 42, floor: 2 });
  const playerEid = spawnPlayer(world, 0, 0);
  return { world, playerEid };
}

function smallCaveConfig(seed: number): MapConfig {
  return {
    widthTiles: 80,
    heightTiles: 60,
    tileSizeFt: 4,
    biome: BiomeType.CAVE_SYSTEM,
    seed,
    roomWidthRange: [5, 12],
    roomHeightRange: [5, 12],
    maxRooms: 20,
    floorDensity: 0.45,
  };
}

function hashBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function serializeFloor(floor: FloorMap): Record<string, unknown> {
  return {
    width: floor.width,
    height: floor.height,
    spawn: `${floor.playerSpawn.x},${floor.playerSpawn.y}`,
    terrainHash: hashBytes(floor.terrain),
    flagsHash: hashBytes(floor.tileMap.flags),
    rooms: floor.rooms.map((room) => ({
      id: room.id,
      role: room.role,
      familyIndex: room.familyIndex ?? null,
      bounds: `${room.bounds.x},${room.bounds.y},${room.bounds.width},${room.bounds.height}`,
      doors: room.doors.map((door) => `${door.x},${door.y}->${door.connectsTo}`),
    })),
  };
}

afterEach(() => {
  registerFloorManifest('floor2', structuredClone(originalFloor2Manifest));
});

describe('initializeFloor2Scenario manifest validation', () => {
  it('throws an actionable error when familyPool contains unknown ids', () => {
    const badManifest = structuredClone(originalFloor2Manifest);
    badManifest.floor2 = {
      ...badManifest.floor2,
      familyPool: ['unknown-family'],
    };
    registerFloorManifest('floor2', badManifest);

    const { world, playerEid } = createScenarioWorld();
    expect(() => initializeFloor2Scenario(world, playerEid)).toThrowError(
      /floor2\.familyPool contains unknown family ids/,
    );
  });

  it('throws an actionable error when familyPool resolves below roster minimum', () => {
    const badManifest = structuredClone(originalFloor2Manifest);
    badManifest.floor2 = {
      ...badManifest.floor2,
      familyPool: ['goblins', 'llamas', 'pandas'],
    };
    registerFloorManifest('floor2', badManifest);

    const { world, playerEid } = createScenarioWorld();
    expect(() => initializeFloor2Scenario(world, playerEid)).toThrowError(/minimum 4 required/);
  });

  it('throws an actionable error when resourcePool contains unknown ids', () => {
    const badManifest = structuredClone(originalFloor2Manifest);
    badManifest.floor2 = {
      ...badManifest.floor2,
      resourcePool: ['unknown-resource'],
    };
    registerFloorManifest('floor2', badManifest);

    const { world, playerEid } = createScenarioWorld();
    expect(() => initializeFloor2Scenario(world, playerEid)).toThrowError(
      /floor2\.resourcePool contains unknown resource ids/,
    );
  });

  it('throws an actionable error when settlement shopArchetypes contains unknown ids', () => {
    const badManifest = structuredClone(originalFloor2Manifest);
    badManifest.floor2 = {
      ...badManifest.floor2,
      settlement: {
        ...badManifest.floor2!.settlement,
        shopCountRange: badManifest.floor2!.settlement?.shopCountRange ?? [1, 1],
        shopArchetypes: ['unknown-archetype'],
      },
    };
    registerFloorManifest('floor2', badManifest);

    const { world, playerEid } = createScenarioWorld();
    expect(() => initializeFloor2Scenario(world, playerEid)).toThrowError(
      /floor2\.settlement\.shopArchetypes contains unknown ids/,
    );
  });

  it('seeds the Floor 2 den quests into the active quest log', () => {
    const seed = 4444;
    const gen = new CaveSystemGenerator({ presentCount: 3 });
    const floorMap = gen.generate(smallCaveConfig(seed), new SeededRandom(seed));
    const world = createTestWorld({ seed, floor: 2 });
    world.floorMap = floorMap;
    const playerEid = spawnPlayer(world, 400, 400);

    initializeFloor2Scenario(world, playerEid);

    const activeQuestIds = [...world.questLog.values()]
      .filter((quest) => quest.status === 'active')
      .map((quest) => quest.questId);
    expect(activeQuestIds.length).toBeGreaterThan(0);
    expect(activeQuestIds.every((questId) => questId.startsWith('floor2-den-'))).toBe(true);
    expect([...world.questLog.values()].some((quest) => quest.tracked)).toBe(true);
    expect(
      activeQuestIds.every((questId) =>
        getQuestDef(questId)?.objectives.every((objective) => objective.kind === 'counter'),
      ),
    ).toBe(true);
  });

  it('does not let settlement shop-count rolls perturb Floor 2 map generation', () => {
    const makeManifest = (shopCountRange: [number, number]) => {
      const manifest = structuredClone(originalFloor2Manifest);
      manifest.floor2 = {
        ...manifest.floor2!,
        settlement: {
          ...(manifest.floor2?.settlement ?? {}),
          shopCountRange,
        },
      };
      return manifest;
    };

    registerFloorManifest('floor2', makeManifest([1, 1]));
    const first = createScenarioWorld();
    initializeFloor2Scenario(first.world, first.playerEid);
    const firstFloor = serializeFloor(first.world.floorMap!);

    registerFloorManifest('floor2', makeManifest([2, 2]));
    const second = createScenarioWorld();
    initializeFloor2Scenario(second.world, second.playerEid);
    const secondFloor = serializeFloor(second.world.floorMap!);

    expect(secondFloor).toEqual(firstFloor);
  });

  it('installs a locked resource-heart door that unlocks on floor2-victory', () => {
    const { world, playerEid } = createScenarioWorld();
    initializeFloor2Scenario(world, playerEid);

    const floorMap = world.floorMap!;
    const heart = floorMap.roomGraph
      .getAll()
      .find((room) => room.role === RoomRole.RESOURCE_HEART)!;
    expect(heart.doors.length).toBeGreaterThan(0);

    const doorStates = query(world.ecs, [DoorState]);
    const lockedHeartDoor = heart.doors.some((door) =>
      doorStates.some(
        (eid) =>
          (world.stores.doorState.tileX[eid] ?? -1) === door.x &&
          (world.stores.doorState.tileY[eid] ?? -1) === door.y &&
          (world.stores.doorState.isLocked[eid] ?? 0) === 1 &&
          (world.stores.doorState.isOpen[eid] ?? 0) === 0,
      ),
    );
    expect(lockedHeartDoor).toBe(true);
  });
});

describe('Floor 2 stair marker radius', () => {
  it('keeps FLOOR2_STAIR_MARKER_RADIUS_FT in lockstep with the floor2 manifest markerRadiusFt', () => {
    // Floor 2 is not yet fully data-driven: the engine/game read the radius from
    // the shared constant, while the manifest carries its own markerRadiusFt.
    // This assertion is the drift guard promised by the constant's doc comment.
    expect(FLOOR2_STAIR_MARKER_RADIUS_FT).toBe(originalFloor2Manifest.objectives.markerRadiusFt);
  });
});
