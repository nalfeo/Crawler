/**
 * Floor 3 persistent player reward track — REAL pipeline coverage (spec R7,
 * slice 10).
 *
 * The unit suite (`tests/unit/floor3-companion-rewards.test.ts`) calls the
 * reward pass and `floor3ObjectiveTick` directly. This test proves the same
 * behavior through the shared runtime pipeline instead: the canonical
 * `createFloorMainSceneOptions('floor3')` pre/post systems driven by
 * `runSimulationStep` — the exact wiring the headless AI runner and the visual
 * game both use. A rival Companion knocked out by real damage must move the
 * player's persistent track (`world.playerLevel.xp` / `world.playerGold`)
 * without any test-only shortcut.
 */
import { describe, expect, it } from 'vitest';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { spawnPlayer, spawnRosterCompanion, type GameWorld } from '../../src/core/index.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
import {
  initializeFloor3Scenario,
  selectFloor3StarterCompanion,
} from '../../src/game/floor3Scenario.js';
import { GAME } from '../../src/shared/constants.js';
import { createInputState } from '../../src/shared/input.js';
import { BiomeType, RoomRole, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

const FLOOR3_SCENE_OPTIONS = createFloorMainSceneOptions('floor3');
const WIDTH_TILES = 24;
const HEIGHT_TILES = 24;
const TILE_SIZE_FT = 4;
/** A rival roster team id — Floor 3 Studio teams start at 10. */
const RIVAL_TEAM_ID = 10;

function createOpenFloor3Map(): FloorMap {
  const tileMap = new TileMap(WIDTH_TILES, HEIGHT_TILES);
  const terrain = new Uint8Array(WIDTH_TILES * HEIGHT_TILES);
  const config: MapConfig = {
    widthTiles: WIDTH_TILES,
    heightTiles: HEIGHT_TILES,
    tileSizeFt: TILE_SIZE_FT,
    biome: BiomeType.ARENA,
    seed: 3,
    roomWidthRange: [6, 6],
    roomHeightRange: [6, 6],
    maxRooms: 1,
    floorDensity: 1,
  };
  for (let y = 0; y < HEIGHT_TILES; y += 1) {
    for (let x = 0; x < WIDTH_TILES; x += 1) {
      const border = x === 0 || y === 0 || x === WIDTH_TILES - 1 || y === HEIGHT_TILES - 1;
      tileMap.flags[y * WIDTH_TILES + x] = border ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }
  const roomGraph = new RoomGraph();
  roomGraph.add({ x: 1, y: 1, width: 10, height: 10 }, [], [], RoomRole.TERRITORY);
  return new FloorMap(config, tileMap, roomGraph, terrain, { x: 3, y: 3 });
}

function createPipelineWorld(seed: number): { world: GameWorld; playerEid: number } {
  const world = createTestWorld({ seed, floor: 3 });
  const map = createOpenFloor3Map();
  const spawn = map.tileToWorld(map.playerSpawn.x, map.playerSpawn.y);
  const playerEid = spawnPlayer(world, spawn.x, spawn.y);
  initializeFloor3Scenario(world, playerEid, { floorMapOverride: map });
  selectFloor3StarterCompanion(world, 0);
  expect(world.state).toBe('playing');
  return { world, playerEid };
}

function step(world: GameWorld, frames: number): void {
  const input = createInputState();
  for (let i = 0; i < frames; i += 1) {
    runSimulationStep(world, input, GAME.DELTA_MS, {
      preSystems: FLOOR3_SCENE_OPTIONS.preSystems,
      postSystems: FLOOR3_SCENE_OPTIONS.postSystems,
    });
  }
}

describe('floor3 reward track through the shared runtime pipeline', () => {
  it('moves the persistent player track when a rival Companion is defeated', () => {
    const { world, playerEid } = createPipelineWorld(3131);
    const playerX = world.stores.position.x[playerEid] ?? 0;
    const playerY = world.stores.position.y[playerEid] ?? 0;

    const rival = spawnRosterCompanion(world, {
      x: playerX,
      y: playerY,
      hp: 8,
      aiType: 0,
      speed: 0.1,
      aggroRange: 10,
      attackRange: 0,
      speciesToken: 1,
      level: 3,
      ownerTeam: RIVAL_TEAM_ID,
      form: 1,
    });

    // Baseline: nothing has paid the player yet.
    step(world, 2);
    expect(world.playerLevel.xp).toBe(0);
    expect(world.playerGold).toBe(0);

    // Defeat the rival the way combat does — drop it to 0 HP and let the
    // pipeline's own companionKOSystem/objective tick observe it.
    world.stores.health.current[rival] = 0;
    step(world, 6);

    expect(world.stores.companion.knockedOut[rival]).toBe(1);
    expect(world.stores.companion.defeatRewarded[rival]).toBe(1);
    expect(world.playerLevel.xp).toBeGreaterThan(0);
    expect(world.lootLedger.xpCollected).toBe(world.playerLevel.xp);
  });
});
