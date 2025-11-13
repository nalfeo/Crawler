import { addComponent, set } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import {
  FamilyMembership,
  asFamilyId,
  initializeFactionRelations,
  spawnBehaviorEnemy,
  spawnPlayer,
} from '../../src/core/index.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import { AI_TYPE } from '../../src/game/enemyAISystem.js';
import { resolveFloor2ArchetypeAIType } from '../../src/game/floor2Scenario.js';
import { floor2EnemyPack } from '../../src/shared/enemy-packs.js';
import { createInputState } from '../../src/shared/input.js';
import { GAME } from '../../src/shared/constants.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

const HOSTILE_ARCHETYPES = floor2EnemyPack.archetypes.filter(
  (archetype) => archetype.isBoss !== true,
);
const FAMILY_IDS = [
  ...new Set(
    HOSTILE_ARCHETYPES.flatMap((archetype) =>
      archetype.familyId === undefined ? [] : [asFamilyId(archetype.familyId)],
    ),
  ),
];
const FLOOR2_PRE_SYSTEMS = createFloorMainSceneOptions('floor2').preSystems ?? [];

function createOpenFloorMap(splitSemanticRooms = false, blockRoomBoundary = false): FloorMap {
  const widthTiles = 40;
  const heightTiles = 20;
  const tileMap = new TileMap(widthTiles, heightTiles);
  const terrain = new Uint8Array(widthTiles * heightTiles);
  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt: 4,
    biome: BiomeType.ARENA,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 1,
  };
  for (let y = 0; y < heightTiles; y += 1) {
    for (let x = 0; x < widthTiles; x += 1) {
      const index = y * widthTiles + x;
      const border = x === 0 || y === 0 || x === widthTiles - 1 || y === heightTiles - 1;
      tileMap.flags[index] =
        border || (blockRoomBoundary && x === 12) ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }
  const roomGraph = new RoomGraph();
  if (splitSemanticRooms) {
    roomGraph.add(
      { x: 1, y: 1, width: 11, height: 18 },
      [],
      [1],
      undefined,
      undefined,
      undefined,
      Array.from({ length: 18 * 11 }, (_, index) => ({
        x: 1 + (index % 11),
        y: 1 + Math.floor(index / 11),
      })),
    );
    roomGraph.add(
      { x: 12, y: 1, width: 27, height: 18 },
      [{ x: 20, y: 0, connectsTo: 0 }],
      [0],
      undefined,
      undefined,
      undefined,
      Array.from({ length: 18 * 27 }, (_, index) => ({
        x: 12 + (index % 27),
        y: 1 + Math.floor(index / 27),
      })),
    );
  }
  return new FloorMap(config, tileMap, roomGraph, terrain, { x: 10, y: 10 });
}

function runImpBoundaryScenario(blockRoomBoundary: boolean): number {
  const world = createTestWorld({ floor: 2 });
  world.state = 'playing';
  world.floorMap = createOpenFloorMap(true, blockRoomBoundary);
  world.floorExtendedState = {
    familyState: {
      presentFamilies: FAMILY_IDS,
      contestedResource: asFamilyId('ore') as never,
      betrayerFlag: false,
    },
  };
  initializeFactionRelations(world, FAMILY_IDS);

  const playerEid = spawnPlayer(world, 42, 42);
  const archetype = floor2EnemyPack.archetypes.find(
    (candidate) => candidate.id === 'imp-chain-brawler',
  )!;
  const initialDistance = 30;
  const enemyEid = spawnBehaviorEnemy(
    world,
    42 + initialDistance,
    42,
    archetype.hp,
    resolveFloor2ArchetypeAIType(archetype),
    archetype.speed,
    archetype.detectRange,
    0,
  );
  addComponent(
    world.ecs,
    enemyEid,
    set(FamilyMembership, {
      familyId: FAMILY_IDS.indexOf(asFamilyId(archetype.familyId!)),
      isBoss: 0,
    }),
  );

  for (let elapsed = 0; elapsed < 2_000; elapsed += GAME.DELTA_MS) {
    runSimulationStep(world, createInputState(), GAME.DELTA_MS, {
      preSystems: FLOOR2_PRE_SYSTEMS,
    });
  }

  const finalDistance = Math.hypot(
    world.stores.position.x[enemyEid]! - world.stores.position.x[playerEid]!,
    world.stores.position.y[enemyEid]! - world.stores.position.y[playerEid]!,
  );
  return initialDistance - finalDistance;
}

describe('Floor 2 hostile activity', () => {
  it('engages a visible hostile across an irregular cave room boundary', () => {
    expect(runImpBoundaryScenario(false)).toBeGreaterThan(8);
  });

  it('does not engage a hostile through a closed wall boundary', () => {
    // Baseline idle-drift for a walled-off imp is ~0.08 ft; 2 ft gives ample
    // margin while ensuring a wall-bypass regression (closes 8+ ft) fails.
    expect(runImpBoundaryScenario(true)).toBeLessThan(2);
  });

  it.each(HOSTILE_ARCHETYPES)(
    '$id closes to within 90% of initial distance after two seconds in detection range',
    (archetype) => {
      const world = createTestWorld({ floor: 2 });
      world.state = 'playing';
      // Use the split-room fixture so isEnemyRoomDoorOpen returns false and
      // detection relies exclusively on the new seam-LOS path, not the
      // open-door or same-room shortcuts.
      world.floorMap = createOpenFloorMap(true);
      world.floorExtendedState = {
        familyState: {
          presentFamilies: FAMILY_IDS,
          contestedResource: asFamilyId('ore') as never,
          betrayerFlag: false,
        },
      };
      initializeFactionRelations(world, FAMILY_IDS);

      const playerEid = spawnPlayer(world, 42, 42);
      const initialDistance = Math.max(2, archetype.detectRange * 0.8);
      const aiType = resolveFloor2ArchetypeAIType(archetype);
      const enemyEid = spawnBehaviorEnemy(
        world,
        42 + initialDistance,
        42,
        archetype.hp,
        aiType,
        archetype.speed,
        archetype.detectRange,
        aiType === AI_TYPE.RANGED ? archetype.detectRange * 0.65 : 0,
      );
      if (archetype.familyId !== undefined) {
        addComponent(
          world.ecs,
          enemyEid,
          set(FamilyMembership, {
            familyId: FAMILY_IDS.indexOf(asFamilyId(archetype.familyId)),
            isBoss: 0,
          }),
        );
      }

      for (let elapsed = 0; elapsed < 2_000; elapsed += GAME.DELTA_MS) {
        runSimulationStep(world, createInputState(), GAME.DELTA_MS, {
          preSystems: FLOOR2_PRE_SYSTEMS,
        });
      }

      const finalDistance = Math.hypot(
        world.stores.position.x[enemyEid]! - world.stores.position.x[playerEid]!,
        world.stores.position.y[enemyEid]! - world.stores.position.y[playerEid]!,
      );
      // Sustained engagement: final position must be within 90% of initial
      // distance. A single idle-wander step or random drift cannot satisfy
      // this; only a mob that actively chased the player for the full window.
      expect(finalDistance).toBeLessThan(initialDistance * 0.9);
    },
  );
});
