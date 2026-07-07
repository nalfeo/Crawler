import { describe, expect, it } from 'vitest';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { createInputState } from '../../src/shared/input.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import {
  initializeFloor1Scenario,
  meetTutorialGoon,
  selectFloor1StarterWeapon,
} from '../../src/game/floorScenario.js';
import { QUEST_GIVER_DETOUR_ABANDON_FRAMES } from '../../src/game/ai/bt-ai-tuning.js';
import type { GameWorld } from '../../src/core/world.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { AIState } from '../../src/game/ai/types.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';

/**
 * All-open room (walls only on the border) with an EMPTY room graph, so
 * `getRoomsByRole(SAFE)` is empty and `isPointInSafeSpace` is always false. That
 * lets a test flip `world.playerInSafeRoom` on/off to model the safe-room-mouth
 * flicker: while `playerInSafeRoom` is true, every NPC (outside the — nonexistent
 * — safe space) is filtered by `findNearestRelevantNpc`, exactly reproducing the
 * frame where the detour would otherwise be dropped.
 */
function makeOpenRoom(widthTiles: number, heightTiles: number): FloorMap {
  const tileMap = new TileMap(widthTiles, heightTiles);
  const terrain = new Uint8Array(widthTiles * heightTiles);
  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt: 4,
    biome: BiomeType.ARENA,
    seed: 1,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 1,
  };
  for (let y = 0; y < heightTiles; y += 1) {
    for (let x = 0; x < widthTiles; x += 1) {
      const idx = y * widthTiles + x;
      const isBorder = x === 0 || y === 0 || x === widthTiles - 1 || y === heightTiles - 1;
      tileMap.flags[idx] = isBorder ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }
  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 1, y: 1 });
}

/** Put the AI into kill-grind-stage progression (post-tutorial, quest not done). */
function enterKillGrindStage(world: GameWorld): void {
  meetTutorialGoon(world);
  world.playerLevel.level = 2;
  world.floorScenario!.objective.questCompleted = false;
}

/**
 * Set up the canonical "short detour to the spell quest giver" scenario (mirrors
 * the accepted-detour case in behavior-tree-ai.test.ts): a far main objective
 * (quest enemy to the east) plus a nearby-on-path spell quest giver the detour
 * layer commits to. Returns the provider, world, and the committed NPC eid.
 */
function setUpAcceptedDetour(seed: number): {
  ai: BehaviorTreeAI;
  world: GameWorld;
  spellNpcEid: number;
  player: number;
} {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, player);
  selectFloor1StarterWeapon(world, 0);
  enterKillGrindStage(world);
  world.goalFlags.set('floor1-leveling-quest-complete', true);
  world.floorMap = makeOpenRoom(40, 20);
  world.stores.position.x[player] = 14;
  world.stores.position.y[player] = 14;

  const questEnemy = spawnEnemy(world, 50, 14, 20);
  world.floorScenario!.enemyArchetypes.set(questEnemy, 'rat');
  const spellNpcEid = world.floorScenario!.spellQuestGiverNpcEid;
  expect(spellNpcEid).toEqual(expect.any(Number));
  world.stores.position.x[spellNpcEid!] = 30;
  world.stores.position.y[spellNpcEid!] = 14;

  const ai = new BehaviorTreeAI({ seed });
  return { ai, world, spellNpcEid: spellNpcEid!, player };
}

describe('Quest-giver detour hysteresis', () => {
  it('commits to a fresh on-path detour with the strict base cap', () => {
    const { ai, world, spellNpcEid } = setUpAcceptedDetour(2);

    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.EXPLORE);
    expect(decision.targetEid).toBe(spellNpcEid);
    expect(decision.reason).toContain('Detouring to spell-quest-giver');
  });

  it('holds the committed detour across a playerInSafeRoom flicker', () => {
    const { ai, world, spellNpcEid } = setUpAcceptedDetour(2);

    // Frame 1: accept + commit to the detour while outside a safe room.
    ai.poll(createInputState(), world);
    expect(ai.getDecision().targetEid).toBe(spellNpcEid);
    expect(ai.getDecision().reason).toContain('Detouring to spell-quest-giver');

    // Frame 2: the body straddles the mouth so playerInSafeRoom flips true. The
    // spell NPC now sits "outside the safe space" (there is none), so
    // findNearestRelevantNpc filters it and would return null — the exact frame
    // the pre-fix code dropped the detour and re-targeted the far main objective.
    // The commitment must survive: re-derived live, bypassing the filter.
    world.playerInSafeRoom = true;
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.targetEid).toBe(spellNpcEid);
    expect(decision.reason).toContain('Detouring to spell-quest-giver');
  });

  it('does not persist a stalled committed detour beyond the no-progress valve', () => {
    const { ai, world, spellNpcEid } = setUpAcceptedDetour(2);

    // Commit while eligible, then wedge: playerInSafeRoom pinned true (NPC always
    // filtered) with the player held stationary, so distance never improves.
    ai.poll(createInputState(), world);
    expect(ai.getDecision().targetEid).toBe(spellNpcEid);
    world.playerInSafeRoom = true;

    // Immediately after the flip the commitment still holds (bounded, not gone).
    ai.poll(createInputState(), world);
    expect(ai.getDecision().targetEid).toBe(spellNpcEid);

    // Within the no-progress abandon window the commitment must self-release; once
    // released, the filtered NPC can no longer be re-committed, so the detour is
    // gone and the AI no longer steers to the NPC.
    let released = false;
    for (let i = 0; i < QUEST_GIVER_DETOUR_ABANDON_FRAMES + 5; i += 1) {
      ai.poll(createInputState(), world);
      if (ai.getDecision().targetEid !== spellNpcEid) {
        released = true;
        break;
      }
    }
    expect(released).toBe(true);
  });
});
