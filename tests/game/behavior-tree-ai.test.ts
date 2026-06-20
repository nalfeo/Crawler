import { describe, expect, it } from 'vitest';
import { spawnEnemy, spawnGold, spawnPlayer } from '../../src/core/helpers.js';
import { createInputState } from '../../src/shared/input.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import {
  initializeFloor1Scenario,
  selectFloor1StarterWeapon,
} from '../../src/game/floor1Scenario.js';
import { setActiveWeapon } from '../../src/game/weaponSystem.js';
import { acceptQuest } from '../../src/core/systems/questSystem.js';
import { FLOOR1_TUTORIAL_QUEST_ID } from '../../src/shared/quest-types.js';
import type { GameWorld } from '../../src/core/world.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { AIState } from '../../src/game/ai/types.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';

/**
 * Build an all-open room (walls only on the border) so A* has a clear straight
 * shot between any two interior tiles. Used to prove the path-follow string-pulls
 * the 4-connected A* path into diagonal motion instead of stair-stepping.
 */
function makeOpenRoom(widthTiles: number, heightTiles: number): FloorMap {
  const tileMap = new TileMap(widthTiles, heightTiles);
  const terrain = new Uint8Array(widthTiles * heightTiles);
  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizePx: 32,
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

/**
 * Advance a freshly-initialised Floor 1 world into the boss-unlock kill-grind
 * stage: tutorial quest accepted, player at level 2, kill quest not yet
 * complete. This is the state in which the AI must commit to hunting the
 * ambient swarm (regression: seed 2 wandered ~285s without a single kill).
 */
function enterKillGrindStage(world: GameWorld): void {
  acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);
  world.playerLevel.level = 2;
  world.floor1!.objective.questCompleted = false;
}

describe('BehaviorTreeAI', () => {
  it('seeks the Tutorial Goon before starting the floor loop', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    const ai = new BehaviorTreeAI({ seed: 42 });
    const input = createInputState();
    ai.poll(input, world);

    const decision = ai.getDecision();
    expect(decision.reason).toContain('Tutorial Goon');
    expect(decision.targetX).toBe(world.floor1?.objective.welcomeOfficePos.x);
    expect(decision.targetY).toBe(world.floor1?.objective.welcomeOfficePos.y);
  });

  it('approaches enemies into honest melee range instead of targeting their center', () => {
    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 100, 0, 20);
    setActiveWeapon(world, getWeaponDef('sword')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    const input = createInputState();
    ai.poll(input, world);

    const decision = ai.getDecision();
    expect(decision.reason).toContain('Closing to melee range');
    expect(decision.targetX).not.toBeNull();
    expect(decision.targetX!).toBeGreaterThan(0);
    expect(decision.targetX!).toBeLessThan(100);
  });

  it('kites inside strike range instead of standing still and trading blows', () => {
    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);
    // Sword reach = ftToPx(5) = 40px, strike gate = 60px. Place the enemy at 30px
    // so the player is already inside the gate: the old behavior parked on the
    // enemy (returned the player's own position); the kite must keep it moving.
    spawnEnemy(world, 30, 0, 20);
    setActiveWeapon(world, getWeaponDef('sword')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.reason).toContain('Kiting');
    // Must not park on the player's current position (the regression).
    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    const movedPx = Math.hypot(decision.targetX! - px, decision.targetY! - py);
    expect(movedPx).toBeGreaterThan(10);
    // Strafe target stays within the strike gate (still able to land hits).
    const gatePx = (40 * 3) / 2;
    const distToEnemy = Math.hypot(decision.targetX! - 30, decision.targetY! - 0);
    expect(distToEnemy).toBeLessThanOrEqual(gatePx + 0.001);
  });

  it('strafes tangentially when kiting rather than only closing the gap', () => {
    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);
    // Enemy purely along +X: a stand-still or pure-radial plan keeps targetY ~0.
    // A tangential orbit step moves the player substantially along Y.
    spawnEnemy(world, 30, 0, 20);
    setActiveWeapon(world, getWeaponDef('sword')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(Math.abs(decision.targetY!)).toBeGreaterThan(10);
  });

  it('collects gold as loot when no higher-priority progression target is active', () => {
    const world = createTestWorld({ seed: 99 });
    spawnPlayer(world, 0, 0);
    spawnGold(world, 48, 0, 3);

    const ai = new BehaviorTreeAI({ seed: 99 });
    const input = createInputState();
    ai.poll(input, world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(3);
    expect(decision.reason).toContain('gold');
    expect(decision.targetX).toBe(48);
    expect(decision.targetY).toBe(0);
  });

  it('hunts the ambient swarm during the boss-unlock kill-grind', () => {
    const world = createTestWorld({ seed: 2 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    enterKillGrindStage(world);

    // initializeFloor1Scenario repositions the player to the floor entrance, so
    // spawn the rat relative to the player's actual position. Placing it within
    // the direct-move epsilon makes reachability trivially satisfied and
    // findNearestQuestEnemy returns it without running A*.
    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    const rat = spawnEnemy(world, px + 6, py, 20);
    world.floor1!.enemyArchetypes.set(rat, 'rat');

    const ai = new BehaviorTreeAI({ seed: 2 });
    const input = createInputState();
    ai.poll(input, world);

    const decision = ai.getDecision();
    expect(decision.reason).toContain('Hunting quest enemies');
    expect(decision.targetX).not.toBeNull();
    expect(decision.targetY).not.toBeNull();
  });

  it('does not force a kill-grind Progress target when no swarm enemy is registered', () => {
    const world = createTestWorld({ seed: 2 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    enterKillGrindStage(world);
    // No enemyArchetypes registered: the AI must fall through to exploration
    // rather than fabricate a hunt target.

    const ai = new BehaviorTreeAI({ seed: 2 });
    const input = createInputState();
    ai.poll(input, world);

    const decision = ai.getDecision();
    expect(decision.reason).not.toContain('Hunting quest enemies');
  });

  it('smoothly blends output direction across polls instead of snapping instantly', () => {
    // Verify that the exponential smoothing produces a gradual transition:
    // on the first poll the output direction must be closer to zero than to the
    // full target, and after several polls it converges to within a small epsilon
    // of the desired direction.
    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);
    // Place an enemy 200px to the right so the AI targets it and outputs (1, 0).
    spawnEnemy(world, 200, 0, 20);
    setActiveWeapon(world, getWeaponDef('sword')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    const input = createInputState();

    // Poll once — the AI starts from (0,0) and blends toward the desired
    // direction, so the first output must be smaller in magnitude than 1.
    ai.poll(input, world);
    const firstMag = Math.hypot(input.moveX, input.moveY);
    expect(firstMag).toBeGreaterThan(0);
    expect(firstMag).toBeLessThan(1);

    // After enough polls the output converges to near the desired magnitude.
    let finalMag = firstMag;
    for (let i = 0; i < 30; i++) {
      ai.poll(input, world);
      finalMag = Math.hypot(input.moveX, input.moveY);
    }
    expect(finalMag).toBeGreaterThan(0.95);
  });

  it('steers diagonally across open ground instead of stair-stepping cardinal hops', () => {
    const world = createTestWorld({ seed: 99 });
    world.floorMap = makeOpenRoom(16, 16);
    // Player at interior tile (3,3) center; gold diagonally at tile (8,8) center.
    // Distance ~226px: beyond CLOSE_APPROACH_DIRECT_PX (48) so A* builds a path,
    // and inside scanRadius (400) so Collect fires. The 4-connected path's first
    // waypoint is a cardinal neighbour (~zero on one axis); string-pulling must
    // advance to the line-of-sight-visible goal so BOTH axes drive.
    spawnPlayer(world, 112, 112);
    spawnGold(world, 272, 272, 3);

    const ai = new BehaviorTreeAI({ seed: 99 });
    const input = createInputState();
    ai.poll(input, world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.COLLECT);
    // Pre-fix: one axis is ~0 (cardinal first hop). Post-fix: diagonal steer.
    // With MOVE_SMOOTH_FACTOR=0.5, first-frame diagonal components are ~0.21; keep
    // the threshold low enough to allow smoothing while still rejecting cardinal hops.
    expect(Math.abs(input.moveX)).toBeGreaterThan(0.15);
    expect(Math.abs(input.moveY)).toBeGreaterThan(0.15);
  });

  it('reuses the engagement kite while farming quest mobs instead of trading blows', () => {
    const world = createTestWorld({ seed: 2 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    enterKillGrindStage(world);
    setActiveWeapon(world, getWeaponDef('sword')!);

    // Quest enemy inside the sword strike gate (reach 40px, gate 60px). The old
    // Progress branch walked straight onto the enemy center; it must now route
    // through planEngagement and kite (same as Engage/Hunt).
    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    const rat = spawnEnemy(world, px + 45, py, 20);
    world.floor1!.enemyArchetypes.set(rat, 'rat');

    const ai = new BehaviorTreeAI({ seed: 2 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.reason).toContain('Hunting quest enemies');
    expect(decision.reason).toContain('Kiting');
    // Must not park on the enemy center (the single-minded regression).
    const ex = world.stores.position.x[rat]!;
    const ey = world.stores.position.y[rat]!;
    const distToEnemy = Math.hypot(decision.targetX! - ex, decision.targetY! - ey);
    expect(distToEnemy).toBeGreaterThan(10);
  });
});
