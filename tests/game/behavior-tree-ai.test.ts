import { describe, expect, it } from 'vitest';
import { addComponent, set } from 'bitecs';
import {
  spawnBehaviorEnemy,
  spawnEnemy,
  spawnGold,
  spawnHarvestableNode,
  spawnNpc,
  spawnPlayer,
  spawnXpGem,
} from '../../src/core/helpers.js';
import { spawnEnemyProjectile } from '../../src/core/spawners/projectiles.js';
import { createInputState } from '../../src/shared/input.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { hasClearLineOfSight } from '../../src/game/ai/bt-ai-geometry.js';
import {
  initializeFloor1Scenario,
  meetTutorialGoon,
  meetSpellQuestGiver,
  selectFloor1StarterWeapon,
} from '../../src/game/floorScenario.js';
import {
  FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID,
  FLOOR2_SETTLEMENT_FOUND_GOAL_ID,
  initializeFloor2Scenario,
  denUnlockGoalId,
} from '../../src/game/floor2Scenario.js';
import { setActiveWeapon } from '../../src/game/weaponSystem.js';
import type { GameWorld } from '../../src/core/world.js';
import { resolveFloor2SettlementAnchor } from '../../src/core/floor2-settlement-anchor.js';
import { acceptQuest } from '../../src/core/systems/questSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { makeDiagonalCornerMap } from '../helpers/map-fixtures.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import type { TilePoint } from '../../src/core/map/pathfinding.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { AI_TYPE } from '../../src/game/enemyAISystem.js';
import {
  AINpcInteractionAction,
  AIProgressSuppressionSource,
  AIState,
} from '../../src/game/ai/types.js';
import {
  ENGAGE_GIVEUP_FRAMES,
  FLOOR2_HUNT_ENGAGE_FRAMES,
  FLOOR2_HUNT_NO_PROGRESS_FRAMES,
  FLOOR2_HUNT_RECOVERY_FRAMES,
  NPC_APPROACH_THREAT_NO_PROGRESS_FRAMES,
  PROJECTILE_DODGE_AOE_BUFFER_FT,
  PROJECTILE_DODGE_CLEARANCE_FT,
} from '../../src/game/ai/bt-ai-tuning.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { FLOOR1_TUTORIAL_QUEST_ID } from '../../src/shared/quest-types.js';
import { FamilyMembership, AoeOnImpact } from '../../src/core/components.js';
import { asFamilyId, type FamilyId } from '../../src/core/faction-relations.js';

/**
 * Build an all-open room (walls only on the border) so A* has a clear straight
 * shot between any two interior tiles. Used to prove that path-follow
 * string-pulling converts the 4-connected A* path into diagonal motion instead
 * of stair-stepping.
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

/**
 * Build a room split into two disconnected halves by a full-height interior wall
 * column at `wallColumnX`. A* can never cross it, so anything on the far side of
 * the player is genuinely unreachable — models loot stranded behind the still
 * locked boss door.
 */
function makeSealedRoom(widthTiles: number, heightTiles: number, wallColumnX: number): FloorMap {
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
      tileMap.flags[idx] = isBorder || x === wallColumnX ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }
  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 1, y: 1 });
}

/**
 * Build a 1-tile-tall horizontal corridor split into two A*-disconnected floor
 * segments by a full-height wall column at `wallColumnX`. An entity standing on
 * the far (right) segment is within feet range of a player on the near (left)
 * segment but has no walkable path to it. This is the asymmetry the opportunistic
 * dodge/detour scans (which reason in raw feet space) rely on versus Track A's
 * reachable-target selection — letting an enemy trigger a dodge while the AI is
 * still idle-wandering (EXPLORE + null target) instead of flipping to ENGAGE.
 */
function makeSealedCorridor(
  widthTiles: number,
  heightTiles: number,
  tileSizeFt: number,
  wallColumnX: number,
): FloorMap {
  const tileMap = new TileMap(widthTiles, heightTiles);
  const terrain = new Uint8Array(widthTiles * heightTiles);
  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt,
    biome: BiomeType.ARENA,
    seed: 1,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 1,
  };
  const openRow = Math.floor(heightTiles / 2);
  for (let y = 0; y < heightTiles; y += 1) {
    for (let x = 0; x < widthTiles; x += 1) {
      const idx = y * widthTiles + x;
      const open = y === openRow && x >= 1 && x <= widthTiles - 2 && x !== wallColumnX;
      tileMap.flags[idx] = open ? TilePresets.FLOOR : TilePresets.WALL;
    }
  }
  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 1, y: openRow });
}

const MIN_DIAGONAL_COMPONENT = 0.15;

/**
 * Advance a freshly-initialised Floor 1 world into the boss-unlock kill-grind
 * stage: tutorial quest accepted, player at level 2, kill quest not yet
 * complete. This is the state in which the AI must commit to hunting the
 * ambient swarm (regression: seed 2 wandered ~285s without a single kill).
 */
function enterKillGrindStage(world: GameWorld): void {
  meetTutorialGoon(world);
  world.playerLevel.level = 2;
  world.floorScenario!.objective.questCompleted = false;
}

/** Keep shop-navigation tests focused on the shop chain while preserving a
 * coherent completed state for every independent Floor 1 objective chain. */
function completeNonShopObjectives(world: GameWorld): void {
  const scenario = world.floorScenario!;
  world.goalFlags.set('floor1-leveling-quest-complete', true);
  world.goalFlags.set('floor1-goon-quest-complete', true);
  meetSpellQuestGiver(world);
  const slimeRat = scenario.objective.bossBattles.get('slime-rat')!;
  slimeRat.started = true;
  slimeRat.defeated = true;
  world.featureUnlocks.spells = true;
  world.goalFlags.set('floor1-boss-battle-complete', true);
  const staircase = scenario.objective.bossBattles.get('staircase')!;
  staircase.started = true;
  staircase.defeated = true;
  scenario.objective = {
    ...scenario.objective,
    staircaseUnlocked: true,
    staircaseDiscovered: true,
  };
}

function setupNpcApproachThreat(weaponId: string): {
  world: GameWorld;
  player: number;
  enemies: number[];
  shopkeeperNpcEid: number;
} {
  const world = createTestWorld({ seed: 12 });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, player);
  selectFloor1StarterWeapon(world, 0);
  setActiveWeapon(world, getWeaponDef(weaponId)!);
  meetTutorialGoon(world);
  world.playerLevel.level = 2;
  world.floorScenario!.objective.questCompleted = true;
  completeNonShopObjectives(world);
  world.floorMap = makeOpenRoom(40, 20);
  world.stores.position.x[player] = 14;
  world.stores.position.y[player] = 14;

  const shopkeeperNpcEid = world.floorScenario!.shopkeeperNpcEid;
  expect(shopkeeperNpcEid).toBeDefined();
  world.stores.position.x[shopkeeperNpcEid!] = 38;
  world.stores.position.y[shopkeeperNpcEid!] = 14;
  world.floorScenario!.objective = {
    ...world.floorScenario!.objective,
    shopRoomPos: { x: 38, y: 14 },
    questItemPos: { x: 50, y: 14 },
  };

  const enemies = [spawnEnemy(world, 22, 14, 20), spawnEnemy(world, 21, 15, 20)];
  return { world, player, enemies, shopkeeperNpcEid: shopkeeperNpcEid! };
}

/**
 * Put the AI into Progress-driven quest navigation (heading for the Welcome
 * Office) and poll once so a travel heading is established. Returns the player's
 * static position plus the unit heading vector, so a test can place loot relative
 * to the *forward path* the on-path detour layer reasons about. No movement system
 * runs in these unit tests, so the player stays put between polls and the heading
 * captured here is exactly the reference the next poll's detour uses.
 */
function pollQuestNavHeading(seed: number): {
  world: GameWorld;
  ai: BehaviorTreeAI;
  input: ReturnType<typeof createInputState>;
  player: number;
  px: number;
  py: number;
  ux: number;
  uy: number;
} {
  const world = createTestWorld({ seed });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, player);
  selectFloor1StarterWeapon(world, 0);

  const ai = new BehaviorTreeAI({ seed });
  const input = createInputState();
  ai.poll(input, world);

  // Precondition: Track A is navigating the quest (EXPLORE), not collecting, and
  // actually moving — otherwise the detour scenario is meaningless.
  expect(ai.getDecision().state).toBe(AIState.EXPLORE);
  const headingMag = Math.hypot(input.moveX, input.moveY);
  expect(headingMag).toBeGreaterThan(0.05);

  const px = world.stores.position.x[player]!;
  const py = world.stores.position.y[player]!;
  return {
    world,
    ai,
    input,
    player,
    px,
    py,
    ux: input.moveX / headingMag,
    uy: input.moveY / headingMag,
  };
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
    const guideNpcEid = world.floorScenario?.guideNpcEid ?? -1;
    expect(decision.targetEid).toBe(guideNpcEid);
    expect(decision.targetX).not.toBeNull();
    expect(decision.targetY).not.toBeNull();
    if (guideNpcEid >= 0 && world.floorMap) {
      const floorMap = world.floorMap;
      const npcX = world.stores.position.x[guideNpcEid] ?? 0;
      const npcY = world.stores.position.y[guideNpcEid] ?? 0;
      const anchorX = decision.targetX ?? 0;
      const anchorY = decision.targetY ?? 0;
      // Anchor must land on a passable tile (reachable by the pathfinder).
      const anchorTile = floorMap.worldToTile(anchorX, anchorY);
      expect(floorMap.tileMap.isPassable(anchorTile.x, anchorTile.y)).toBe(true);
      // Anchor must be no farther from the NPC than the player spawn — the BFS
      // anchor is the closest reachable tile to the NPC by Euclidean distance.
      const anchorToNpc = Math.hypot(anchorX - npcX, anchorY - npcY);
      const playerX = world.stores.position.x[player] ?? 0;
      const playerY = world.stores.position.y[player] ?? 0;
      const playerToNpc = Math.hypot(playerX - npcX, playerY - npcY);
      expect(anchorToNpc).toBeLessThanOrEqual(playerToNpc);
    }
  });

  it('labels EXPLORE fallback caused by suppressed fixed-position post-tutorial progress navigation', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    meetTutorialGoon(world);
    world.playerLevel.level = 2;
    world.floorScenario!.objective.questCompleted = true;
    completeNonShopObjectives(world);

    const ai = new BehaviorTreeAI({ seed: 42, scanRadius: 0 });
    const suppressionHarness = ai as unknown as {
      progressGoalSuppressedUntilFrame: number;
      progressGoalSuppressionSource: string | null;
    };
    suppressionHarness.progressGoalSuppressedUntilFrame = world.frameCount + 120;
    suppressionHarness.progressGoalSuppressionSource =
      AIProgressSuppressionSource.EXPLORE_DWELL_FIXED_POSITION_TARGET;

    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.EXPLORE);
    expect(decision.reason).toBe('Exploring map');
    expect(decision.debug).toMatchObject({
      state: 'suppressedProgressNav',
      reason: 'progressGoalSuppressed',
      source: AIProgressSuppressionSource.EXPLORE_DWELL_FIXED_POSITION_TARGET,
      criticalChainPhase: 'shop',
      blockedTargetReason: 'Seeking Shopkeeper to start the merchant errand',
      suppressedUntilFrame: 120,
      remainingFrames: 120,
    });
  });

  it('approaches enemies into honest melee range instead of targeting their center', () => {
    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 12.5, 0, 20);
    setActiveWeapon(world, getWeaponDef('sword')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    const input = createInputState();
    ai.poll(input, world);

    const decision = ai.getDecision();
    expect(decision.reason).toContain('Closing to melee range');
    expect(decision.targetX).not.toBeNull();
    expect(decision.targetX!).toBeGreaterThan(0);
    expect(decision.targetX!).toBeLessThan(12.5);
  });

  it('kites inside strike range instead of standing still and trading blows', () => {
    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);
    // Sword reach = 5ft, strike gate = 7.5ft. Place the enemy at 3.75ft
    // so the player is already inside the gate: the old behavior parked on the
    // enemy (returned the player's own position); the kite must keep it moving.
    spawnEnemy(world, 3.75, 0, 20);
    setActiveWeapon(world, getWeaponDef('sword')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.reason).toContain('Kiting');
    // Must not park on the player's current position (the regression).
    const playerX = world.stores.position.x[player]!;
    const playerY = world.stores.position.y[player]!;
    const movedFt = Math.hypot(decision.targetX! - playerX, decision.targetY! - playerY);
    expect(movedFt).toBeGreaterThan(1.25);
    // Strafe target stays within the strike gate (still able to land hits).
    const gateFt = (5 * 3) / 2;
    const distToEnemy = Math.hypot(decision.targetX! - 3.75, decision.targetY! - 0);
    expect(distToEnemy).toBeLessThanOrEqual(gateFt + 0.001);
  });

  it('strafes tangentially when kiting rather than only closing the gap', () => {
    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);
    // Enemy purely along +X: a stand-still or pure-radial plan keeps targetY ~0.
    // A tangential orbit step moves the player substantially along Y.
    spawnEnemy(world, 3.75, 0, 20);
    setActiveWeapon(world, getWeaponDef('sword')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(Math.abs(decision.targetY!)).toBeGreaterThan(1.25);
  });

  it('latches a retreating threat into the ignore set when it disengages at low health', () => {
    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);
    // Enemy well within retreatDangerRadius (20ft) so a retreat starts.
    const enemy = spawnEnemy(world, 10, 0, 20);
    // Drop the player to 10% HP, below the 15% retreat threshold.
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 10;

    const ai = new BehaviorTreeAI({ seed: 7 });
    const harness = ai as unknown as {
      retreating: boolean;
      retreatThreatEid: number | null;
      ignoredEnemyUntilFrame: Map<number, number>;
    };

    // Poll 1: low health + a nearby threat => RETREAT, threat latched, no ignore yet.
    ai.poll(createInputState(), world);
    expect(ai.getDecision().state).toBe(AIState.RETREAT);
    expect(harness.retreating).toBe(true);
    expect(harness.retreatThreatEid).toBe(enemy);
    expect(harness.ignoredEnemyUntilFrame.has(enemy)).toBe(false);

    // The threat disengages well beyond the hysteresis radius while HP stays low.
    world.stores.position.x[enemy] = 60;
    world.frameCount += 1;

    // Poll 2: threat left danger range => endRetreat latches it as ignored so the
    // wounded AI does not immediately re-target it and re-enter RETREAT.
    ai.poll(createInputState(), world);
    const ignoredUntil = harness.ignoredEnemyUntilFrame.get(enemy);
    expect(ignoredUntil).toBeDefined();
    expect(ignoredUntil!).toBeGreaterThan(world.frameCount);
    expect(harness.retreating).toBe(false);
    expect(ai.getDecision().state).not.toBe(AIState.RETREAT);

    // Ignore suppresses re-engagement, not physical threat sensing. If that same
    // enemy closes again while the player is still wounded, retreat must resume.
    world.stores.position.x[enemy] = 10;
    world.frameCount += 1;
    ai.poll(createInputState(), world);
    expect(ai.getDecision().state).toBe(AIState.RETREAT);
    expect(harness.retreatThreatEid).toBe(enemy);
  });

  it('micro-spaces with weapon cadence: pokes in when ready, eases out on cooldown', () => {
    // Baseball-bat reach = 5.5ft, strike gate = 8.25ft. Enemy at 3.75ft
    // is inside the gate so the player kites. When the swing is READY it pokes in
    // toward the strike band; right after firing (on cooldown) it eases out toward
    // the recover band — the human "hold ground + micro forward/back" tactic. This
    // in/out delta was dead before the fix (inner === outer orbit radius).
    const bat = getWeaponDef('baseball-bat')!;

    // READY: the last swing was a full cooldown ago.
    const readyWorld = createTestWorld({ seed: 7 });
    spawnPlayer(readyWorld, 0, 0);
    spawnEnemy(readyWorld, 3.75, 0, 40);
    readyWorld.elapsedMs = 5000;
    setActiveWeapon(readyWorld, bat); // lastFireMs = 5000 - cooldown → ready now
    const readyAi = new BehaviorTreeAI({ seed: 7 });
    readyAi.poll(createInputState(), readyWorld);
    const readyDecision = readyAi.getDecision();
    const readyDist = Math.hypot(readyDecision.targetX! - 3.75, readyDecision.targetY!);

    // ON COOLDOWN: rewind the clock to the instant of the last shot.
    const cooldownWorld = createTestWorld({ seed: 7 });
    spawnPlayer(cooldownWorld, 0, 0);
    spawnEnemy(cooldownWorld, 3.75, 0, 40);
    cooldownWorld.elapsedMs = 5000;
    setActiveWeapon(cooldownWorld, bat); // lastFireMs = 5000 - cooldown
    cooldownWorld.elapsedMs = 5000 - bat.cooldownMs; // elapsed == lastFire → just fired
    const cooldownAi = new BehaviorTreeAI({ seed: 7 });
    cooldownAi.poll(createInputState(), cooldownWorld);
    const cooldownDecision = cooldownAi.getDecision();
    const cooldownDist = Math.hypot(cooldownDecision.targetX! - 3.75, cooldownDecision.targetY!);

    expect(readyDecision.reason).toContain('Kiting');
    expect(cooldownDecision.reason).toContain('Kiting');
    // The cooldown step holds the enemy farther away (dodge between hits); the
    // ready step pokes in closer to land the swing.
    expect(cooldownDist).toBeGreaterThan(readyDist + 0.5);
  });

  it('collects gold as loot when no higher-priority progression target is active', () => {
    const world = createTestWorld({ seed: 99 });
    spawnPlayer(world, 0, 0);
    spawnGold(world, 6, 0, 3);

    const ai = new BehaviorTreeAI({ seed: 99 });
    const input = createInputState();
    ai.poll(input, world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(3);
    expect(decision.reason).toContain('gold');
    expect(decision.targetX).toBe(6);
    expect(decision.targetY).toBe(0);
  });

  it('collects gold reachable across open ground', () => {
    const world = createTestWorld({ seed: 99 });
    world.floorMap = makeOpenRoom(16, 16);
    spawnPlayer(world, 14, 14); // tile (3,3)
    // Gold ~36ft away at tile (12,3): inside the collect scan radius and, with no
    // interior wall, reachable by A* — so it remains a valid COLLECT goal.
    spawnGold(world, 50, 14, 3);

    const ai = new BehaviorTreeAI({ seed: 99 });
    const input = createInputState();
    ai.poll(input, world);

    expect(ai.getDecision().state).toBe(AIState.COLLECT);
  });

  it('does not target gold sealed behind a wall it cannot path to', () => {
    const world = createTestWorld({ seed: 99 });
    // Full-height wall column at tile x=8 splits the room into two disconnected
    // halves; the gold is stranded on the far side, exactly like loot behind the
    // still-locked boss door.
    world.floorMap = makeSealedRoom(16, 16, 8);
    spawnPlayer(world, 14, 14); // tile (3,3) — left half
    spawnGold(world, 50, 14, 3); // tile (12,3) — right half, unreachable

    const ai = new BehaviorTreeAI({ seed: 99 });
    const input = createInputState();
    ai.poll(input, world);

    const decision = ai.getDecision();
    // The unreachable gold must not become a collect goal (pre-fix the AI parked
    // on it and wiggled until the dwell watchdog abandoned it ~180 frames later).
    expect(decision.state).not.toBe(AIState.COLLECT);
    expect(decision.reason).not.toContain('gold');
  });

  it('treats blocked diagonal corners as obstructed when string-pulling a path', () => {
    const world = createTestWorld({ seed: 7 });
    world.floorMap = makeDiagonalCornerMap({ seed: 1, floorDensity: 1 });

    // hasClearLineOfSight was extracted from BehaviorTreeAI into ./bt-ai-geometry
    // as a pure function; assert the same corner-cut rejection through it.
    expect(hasClearLineOfSight(world.floorMap, 6, 6, 10, 10)).toBe(false);
  });

  it('drops a previously collectable gold target once it becomes unreachable', () => {
    const world = createTestWorld({ seed: 99 });
    world.floorMap = makeOpenRoom(16, 16);
    spawnPlayer(world, 14, 14);
    spawnGold(world, 50, 14, 3);

    const ai = new BehaviorTreeAI({ seed: 99 });
    const input = createInputState();
    ai.poll(input, world);
    expect(ai.getDecision().state).toBe(AIState.COLLECT);

    // The boss door slams shut: a wall now seals the gold off. Advance past the
    // reachability cache TTL (20 frames) so the gate recomputes on the next poll
    // and the sticky loot target is dropped instead of pursued through the wall.
    world.floorMap = makeSealedRoom(16, 16, 8);
    world.frameCount += 30;
    ai.poll(input, world);

    expect(ai.getDecision().state).not.toBe(AIState.COLLECT);
  });

  describe('on-path loot detour (tactical travel)', () => {
    it('detours toward loot within 5 ft of its forward path during quest navigation', () => {
      const s = pollQuestNavHeading(42);
      // Gem 10 ft dead ahead along the travel heading: inside the 15 ft grab radius
      // and squarely within the 5 ft forward corridor.
      spawnXpGem(s.world, s.px + s.ux * 10, s.py + s.uy * 10, 5);

      s.ai.poll(s.input, s.world);

      // Track A stays on the quest objective (Progress outranks Collect), so the
      // gem is ignored by Track A. Tactical travel now owns the loot bend, keeping
      // the legacy Track-B pull at zero so the same gem is not double-counted.
      expect(s.ai.getDecision().state).toBe(AIState.EXPLORE);
      const steer = s.ai.getTravelSteeringDebug();
      expect(steer).not.toBeNull();
      expect(steer!.selectedPickupEid).not.toBeNull();
      expect(steer!.lootBonus).toBeGreaterThan(0);
      const dbg = s.ai.getOpportunisticDebug();
      expect(dbg.pullX).toBe(0);
      expect(dbg.pullY).toBe(0);
      const tactical = s.ai.getTacticalRunDebug();
      expect(tactical.runPlan?.criticalPathObjective).toBeTruthy();
      expect(tactical.opportunities?.acceptedPickups).toHaveLength(1);
    });

    it('ignores loot behind the player (not on the forward path)', () => {
      const s = pollQuestNavHeading(42);
      // 10 ft directly behind the heading: within the grab radius but off-path.
      spawnXpGem(s.world, s.px - s.ux * 10, s.py - s.uy * 10, 5);

      s.ai.poll(s.input, s.world);

      const dbg = s.ai.getOpportunisticDebug();
      expect(dbg.pullX).toBe(0);
      expect(dbg.pullY).toBe(0);
    });

    it('suppresses on-path loot detours in low-time beeline mode', () => {
      const s = pollQuestNavHeading(42);
      spawnXpGem(s.world, s.px + s.ux * 10, s.py + s.uy * 10, 5);

      s.ai.poll(s.input, s.world);
      const control = s.ai.getTravelSteeringDebug();
      expect(control?.selectedPickupEid).not.toBeNull();

      const objective = s.world.floorScenario!.objective;
      objective.staircaseUnlocked = false;
      objective.staircaseDiscovered = false;
      s.world.elapsedMs = objective.deadlineMs - 55_000;

      s.ai.poll(s.input, s.world);
      const panic = s.ai.getTravelSteeringDebug();
      expect(panic?.selectedPickupEid).toBeNull();
      const tactical = s.ai.getTacticalRunDebug();
      expect(tactical.runPlan?.urgency).toBeGreaterThan(0.9);
      expect(tactical.opportunities?.acceptedPickups).toHaveLength(0);
    });

    it('does not switch to COLLECT in low-time beeline fallback windows', () => {
      const world = createTestWorld({ seed: 42 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);
      meetTutorialGoon(world); // puts progression in level-1 grind (no explicit progress objective)

      const px = world.stores.position.x[player] ?? 0;
      const py = world.stores.position.y[player] ?? 0;
      spawnXpGem(world, px + 6, py, 5);

      const ai = new BehaviorTreeAI({ seed: 42 });
      const input = createInputState();
      ai.poll(input, world);
      expect(ai.getDecision().state).toBe(AIState.COLLECT);

      const objective = world.floorScenario!.objective;
      objective.staircaseUnlocked = false;
      objective.staircaseDiscovered = false;
      world.elapsedMs = objective.deadlineMs - 55_000;

      ai.poll(input, world);
      expect(ai.getDecision().state).not.toBe(AIState.COLLECT);
    });

    it('ignores loot farther than 5 ft to the side of its path', () => {
      const s = pollQuestNavHeading(42);
      // 7.5 ft forward + 10 ft lateral (perp to heading): total 12.5 ft is inside the
      // grab radius, so only the 5 ft corridor gate excludes it.
      const perpX = -s.uy;
      const perpY = s.ux;
      spawnXpGem(s.world, s.px + s.ux * 7.5 + perpX * 10, s.py + s.uy * 7.5 + perpY * 10, 5);

      s.ai.poll(s.input, s.world);

      const dbg = s.ai.getOpportunisticDebug();
      expect(dbg.pullX).toBe(0);
      expect(dbg.pullY).toBe(0);
    });

    it('does not detour for loot while fighting an enemy', () => {
      const world = createTestWorld({ seed: 7 });
      const player = spawnPlayer(world, 0, 0);
      spawnEnemy(world, 12.5, 0, 20);
      setActiveWeapon(world, getWeaponDef('sword')!);

      const ai = new BehaviorTreeAI({ seed: 7 });
      const input = createInputState();
      ai.poll(input, world);
      expect(ai.getDecision().state).toBe(AIState.ENGAGE);

      // Gem sitting right on the approach line to the enemy.
      const px = world.stores.position.x[player]!;
      const py = world.stores.position.y[player]!;
      spawnXpGem(world, px + 5, py, 5);

      ai.poll(input, world);

      // Still fighting → the detour stays suppressed ("not while fighting").
      expect(ai.getDecision().state).toBe(AIState.ENGAGE);
      const dbg = ai.getOpportunisticDebug();
      expect(dbg.pullX).toBe(0);
      expect(dbg.pullY).toBe(0);
    });

    it('suppresses the loot detour while dodging a charging enemy (idle-wander)', () => {
      // The dodge-suppression gate in buildOpportunisticCollect is only reachable
      // in the one Track-A state where the detour is otherwise live AND a dodge can
      // run: EXPLORE with a null target (idle-wander). The ENGAGE-suppression test
      // above is gated out earlier by the COLLECT/ENGAGE state check and never hits
      // the dodgeVec gate, so this exercises it directly.
      //
      // Holding idle-wander with a dodge-triggering enemy on screen needs the enemy
      // to be close in pixels (so the dodge scan reacts) yet A*-unreachable (so Track
      // A's reachability filter skips it instead of flipping to ENGAGE). A 1-tile
      // corridor sealed by a wall column gives exactly that: the player wanders the
      // left segment heading +x toward the wall while the gem and enemy sit on the
      // disconnected right floor — seen by the raw-pixel detour/dodge scans, unseen
      // by reachable-target selection.
      const setup = (withEnemy: boolean): BehaviorTreeAI => {
        const world = createTestWorld({ seed: 5 });
        // 2.5 ft tiles keep the unreachable far floor (>=3 tiles past the wall, to clear
        // the 2-tile approach-search) inside the 15 ft grab / 12 ft dodge radii.
        world.floorMap = makeSealedCorridor(10, 3, 2.5, 3);
        // Tile (1,1) = feet (3.75,3.75), the left end, so the wander heads +x.
        spawnPlayer(world, 3.75, 3.75);
        const ai = new BehaviorTreeAI({ seed: 5 });
        const input = createInputState();
        ai.poll(input, world); // establishes the +x travel heading
        expect(ai.getDecision().state).toBe(AIState.EXPLORE);
        expect(ai.getDecision().targetEid).toBeNull();

        // On-path gem on the unreachable far floor: tile (6,1)=12.5 ft dead ahead,
        // inside the 15 ft grab radius and the 5 ft forward corridor.
        spawnXpGem(world, 16.25, 3.75, 5);
        if (withEnemy) {
          // Enemy on the far floor 10 ft ahead (inside the 12 ft dodge radius) charging
          // straight at the player, well over the 0.1875 ft/frame closing-speed threshold.
          const enemy = spawnEnemy(world, 13.75, 3.75, 20);
          world.stores.velocity.x[enemy] = -0.375;
          world.stores.velocity.y[enemy] = 0;
        }
        ai.poll(input, world);
        return ai;
      };

      // Control: with no enemy the on-path gem drives the detour, proving the gem is
      // genuinely on the forward path and would otherwise be grabbed this frame.
      const control = setup(false);
      expect(control.getDecision().state).toBe(AIState.EXPLORE);
      expect(control.getDecision().targetEid).toBeNull();
      const controlDbg = control.getOpportunisticDebug();
      expect(Math.hypot(controlDbg.pullX, controlDbg.pullY)).toBeGreaterThan(0.5);

      // Suppressed: the same gem yields zero pull once a dodge is active this frame.
      const dodging = setup(true);
      // Still idle-wandering — the unreachable enemy must NOT have flipped Track A to
      // ENGAGE, or the suppression would be the ENGAGE gate (already covered above)
      // rather than the dodge gate under test.
      expect(dodging.getDecision().state).toBe(AIState.EXPLORE);
      expect(dodging.getDecision().targetEid).toBeNull();
      // Travel steering (not the retired additive dodge) now owns the heading, and
      // the opportunistic loot detour stays suppressed while a perceived threat sits
      // on the forward path — the runner won't bend toward the gem into danger.
      expect(dodging.getTravelSteeringDebug()).not.toBeNull();
      const dodgeDbg = dodging.getOpportunisticDebug();
      expect(dodgeDbg.pullX).toBe(0); // loot detour suppressed this frame
      expect(dodgeDbg.pullY).toBe(0);
    });

    it('arcs around a charging enemy while pathing to quest objectives (travel steering)', () => {
      const s = pollQuestNavHeading(42);
      const enemy = spawnEnemy(s.world, s.px + s.ux * 9, s.py + s.uy * 3, 20);
      const toPlayerX = s.px - (s.world.stores.position.x[enemy] ?? 0);
      const toPlayerY = s.py - (s.world.stores.position.y[enemy] ?? 0);
      const len = Math.hypot(toPlayerX, toPlayerY) || 1;
      s.world.stores.velocity.x[enemy] = (toPlayerX / len) * 0.375;
      s.world.stores.velocity.y[enemy] = (toPlayerY / len) * 0.375;

      s.ai.poll(s.input, s.world);

      // Track A still navigates the quest (EXPLORE); predictive travel steering —
      // not the retired additive dodge — now shapes the heading into a safe arc.
      expect(s.ai.getDecision().state).toBe(AIState.EXPLORE);
      expect(s.ai.getDecision().targetEid).not.toBeNull();
      const steer = s.ai.getTravelSteeringDebug();
      expect(steer).not.toBeNull();
      expect(steer!.progressDot).toBeGreaterThan(0); // never reverses off-objective
      // The additive travel dodge is folded into the steered heading (retired).
      const dbg = s.ai.getOpportunisticDebug();
      expect(Math.hypot(dbg.dodgeX, dbg.dodgeY)).toBe(0);
    });

    it('arcs around a stationary enemy parked on the beeline instead of charging through', () => {
      // Regression: a still/idle enemy never "closes", so the old additive dodge
      // ignored it and the player bulldozed into body contact. Predictive steering
      // reasons about the *current* predicted gap, so a blocker dead ahead draws a
      // lateral arc that keeps forward progress.
      const s = pollQuestNavHeading(42);
      const enemy = spawnEnemy(s.world, s.px + s.ux * 4, s.py + s.uy * 4, 20);
      s.world.stores.velocity.x[enemy] = 0;
      s.world.stores.velocity.y[enemy] = 0;

      s.ai.poll(s.input, s.world);

      expect(s.ai.getDecision().state).toBe(AIState.EXPLORE);
      const steer = s.ai.getTravelSteeringDebug();
      expect(steer).not.toBeNull();
      // Forward progress preserved (never reverses off-objective)...
      expect(steer!.progressDot).toBeGreaterThan(0);
      // ...but deflected laterally off the head-on line. The enemy sits exactly on
      // objDir, so any nonzero cross-product between objDir and the chosen heading
      // is a genuine sidestep, and the heading does not point straight at the mob.
      const lateral = Math.abs(s.ux * steer!.moveY - s.uy * steer!.moveX);
      expect(lateral).toBeGreaterThan(0.05);
      const into = steer!.moveX * s.ux + steer!.moveY * s.uy;
      expect(into).toBeLessThan(0.99);
    });

    it('does not dodge a stationary enemy that is behind the travel heading', () => {
      const s = pollQuestNavHeading(42);
      const enemy = spawnEnemy(s.world, s.px - s.ux * 4, s.py - s.uy * 4, 20);
      s.world.stores.velocity.x[enemy] = 0;
      s.world.stores.velocity.y[enemy] = 0;

      s.ai.poll(s.input, s.world);

      const dbg = s.ai.getOpportunisticDebug();
      expect(dbg.dodgeX).toBe(0);
      expect(dbg.dodgeY).toBe(0);
    });

    it('farms enemies ahead on the quest path, never behind, and only when weighted', () => {
      // Enemy ~12 ft AHEAD on the quest-nav heading → forward-cone pull fires.
      const ahead = pollQuestNavHeading(42);
      spawnEnemy(ahead.world, ahead.px + ahead.ux * 12, ahead.py + ahead.uy * 12, 20);
      ahead.ai.poll(ahead.input, ahead.world);
      expect(ahead.ai.getDecision().state).toBe(AIState.EXPLORE);
      const aheadDbg = ahead.ai.getOpportunisticDebug();
      expect(Math.hypot(aheadDbg.farmX, aheadDbg.farmY)).toBeGreaterThan(0);
      expect(aheadDbg.farmX * ahead.ux + aheadDbg.farmY * ahead.uy).toBeGreaterThan(0);

      // Same enemy BEHIND the heading → outside the forward cone → no pull.
      const behind = pollQuestNavHeading(42);
      spawnEnemy(behind.world, behind.px - behind.ux * 12, behind.py - behind.uy * 12, 20);
      behind.ai.poll(behind.input, behind.world);
      const behindDbg = behind.ai.getOpportunisticDebug();
      expect(behindDbg.farmX).toBe(0);
      expect(behindDbg.farmY).toBe(0);

      // farmPullWeight = 0 keeps the layer fully dormant even with prey ahead.
      const off = pollQuestNavHeading(42);
      const offAi = new BehaviorTreeAI({ seed: 42, farmPullWeight: 0 });
      spawnEnemy(off.world, off.px + off.ux * 12, off.py + off.uy * 12, 20);
      offAi.poll(off.input, off.world);
      const offDbg = offAi.getOpportunisticDebug();
      expect(offDbg.farmX).toBe(0);
      expect(offDbg.farmY).toBe(0);
    });
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
    const playerX = world.stores.position.x[player]!;
    const playerY = world.stores.position.y[player]!;
    const rat = spawnEnemy(world, playerX + 0.75, playerY, 20);
    world.floorScenario!.enemyArchetypes.set(rat, 'rat');

    const ai = new BehaviorTreeAI({ seed: 2 });
    const input = createInputState();
    ai.poll(input, world);

    const decision = ai.getDecision();
    expect(decision.reason).toContain('Hunting quest enemies');
    expect(decision.targetX).not.toBeNull();
    expect(decision.targetY).not.toBeNull();
  });

  it('detours to a visible quest giver when the extra path is short', () => {
    const world = createTestWorld({ seed: 2 });
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
    expect(spellNpcEid).toBeDefined();
    world.stores.position.x[spellNpcEid!] = 30;
    world.stores.position.y[spellNpcEid!] = 14;

    const ai = new BehaviorTreeAI({ seed: 2 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.EXPLORE);
    expect(decision.targetEid).toBe(spellNpcEid);
    expect(decision.reason).toContain('Detouring to spell-quest-giver');
  });

  it('detours to quest NPC interactions that are not accept-* steps', () => {
    const world = createTestWorld({ seed: 11 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    enterKillGrindStage(world);
    world.floorMap = makeOpenRoom(40, 20);
    world.stores.position.x[player] = 14;
    world.stores.position.y[player] = 14;

    const questEnemy = spawnEnemy(world, 50, 14, 20);
    world.floorScenario!.enemyArchetypes.set(questEnemy, 'rat');
    const shopkeeperNpcEid = world.floorScenario!.shopkeeperNpcEid;
    expect(shopkeeperNpcEid).toBeDefined();
    world.stores.position.x[shopkeeperNpcEid!] = 30;
    world.stores.position.y[shopkeeperNpcEid!] = 14;

    const ai = new BehaviorTreeAI({ seed: 11 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.EXPLORE);
    expect(decision.targetEid).toBe(shopkeeperNpcEid);
    expect(decision.reason).toContain('Detouring to shopkeeper');
    expect(decision.reason).toContain('meet shopkeeper');
  });

  it('prioritizes a safe-room quest NPC interaction even when another objective exists', () => {
    const world = createTestWorld({ seed: 31 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    enterKillGrindStage(world);
    world.playerInSafeRoom = true;
    const shopPos = world.floorScenario!.objective.shopRoomPos;
    world.stores.position.x[player] = shopPos.x;
    world.stores.position.y[player] = shopPos.y;

    const shopkeeperNpcEid = world.floorScenario!.shopkeeperNpcEid;
    expect(shopkeeperNpcEid).toBeDefined();
    world.stores.position.x[shopkeeperNpcEid!] = shopPos.x + 2;
    world.stores.position.y[shopkeeperNpcEid!] = shopPos.y;

    // All three NPCs now share the welcome bar. Move the tutorial goon and spell
    // broker far away so only the shopkeeper is in the player's interaction radius.
    const guideNpcEid = world.floorScenario!.guideNpcEid;
    if (guideNpcEid != null) {
      world.stores.position.x[guideNpcEid] = shopPos.x + 500;
      world.stores.position.y[guideNpcEid] = shopPos.y;
    }
    const spellBrokerEid = world.floorScenario!.spellQuestGiverNpcEid;
    if (spellBrokerEid != null) {
      world.stores.position.x[spellBrokerEid] = shopPos.x + 500;
      world.stores.position.y[spellBrokerEid] = shopPos.y;
    }

    // Keep a valid non-NPC progress objective active (kill-grind enemy) so the
    // safe-room override has to actively choose the NPC.
    const questEnemy = spawnEnemy(world, shopPos.x + 28, shopPos.y, 20);
    world.floorScenario!.enemyArchetypes.set(questEnemy, 'rat');

    const ai = new BehaviorTreeAI({ seed: 31 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.INTERACT);
    expect(decision.targetEid).toBe(shopkeeperNpcEid);
    expect(decision.reason).toContain('Interacting with shopkeeper');
  });

  it('latches a leave-safe-room waypoint, then resumes hunting after egress', () => {
    const world = createTestWorld({ seed: 31 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    meetTutorialGoon(world);
    world.playerLevel.level = 0;
    world.floorMap = makeOpenRoom(40, 20);
    world.stores.position.x[player] = 14;
    world.stores.position.y[player] = 10;
    world.playerInSafeRoom = true;

    const farThreat = spawnEnemy(world, 84, 10, 20);

    const ai = new BehaviorTreeAI({ seed: 31 });
    const input = createInputState();
    ai.poll(input, world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.targetEid).toBeNull();
    expect(decision.reason).toContain('Leaving safe room');
    expect(decision.targetX).not.toBeNull();
    expect(decision.targetY).not.toBeNull();
    const firstTargetX = decision.targetX!;
    const firstTargetY = decision.targetY!;

    // Threat movement should not retarget the egress waypoint while still in a safe room.
    world.stores.position.x[farThreat] = 120;
    world.stores.position.y[farThreat] = 12;
    ai.poll(input, world);
    const latched = ai.getDecision();
    expect(latched.state).toBe(AIState.ENGAGE);
    expect(latched.targetEid).toBeNull();
    expect(latched.reason).toContain('Leaving safe room');
    expect(latched.targetX).toBeCloseTo(firstTargetX, 6);
    expect(latched.targetY).toBeCloseTo(firstTargetY, 6);

    // Next frame outside safe room, threat still >50ft away: the AI should keep
    // committing to the same far threat (Hunt), not drop to EXPLORE.
    world.playerInSafeRoom = false;
    world.stores.position.x[player] = 20;
    world.stores.position.y[player] = 10;

    ai.poll(input, world);
    const postExit = ai.getDecision();
    expect(postExit.state).toBe(AIState.ENGAGE);
    expect(postExit.targetEid).toBe(farThreat);
    expect(postExit.reason).toContain('Hunting enemy');
  });

  it('prioritizes the broker while floor2 reputation is locked, then drops broker targeting after intro completion', () => {
    const world = createTestWorld({ seed: 52, floor: 2 });
    const player = spawnPlayer(world, 0, 0);
    world.floorMap = makeOpenRoom(40, 20);
    world.stores.position.x[player] = 14;
    world.stores.position.y[player] = 10;
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [],
        contestedResource: 'gold-veins' as never,
        betrayerFlag: false,
        reputationSystemActive: false,
      },
    };
    world.goalFlags.set(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID, false);

    const brokerEid = spawnNpc(world, 16, 10, 'the-broker');
    const closerNpcEid = spawnNpc(world, 15, 10, 'shopkeeper');
    void closerNpcEid;

    const lockedAi = new BehaviorTreeAI({ seed: 52 });
    lockedAi.poll(createInputState(), world);
    const lockedDecision = lockedAi.getDecision();
    expect(lockedDecision.state).toBe(AIState.INTERACT);
    expect(lockedDecision.targetEid).toBe(brokerEid);

    world.goalFlags.set(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID, true);
    if (world.floorExtendedState?.familyState) {
      world.floorExtendedState.familyState.reputationSystemActive = true;
    }
    const unlockedAi = new BehaviorTreeAI({ seed: 52 });
    unlockedAi.poll(createInputState(), world);
    const unlockedDecision = unlockedAi.getDecision();
    expect(unlockedDecision.state).not.toBe(AIState.INTERACT);
    expect(unlockedDecision.targetEid).not.toBe(brokerEid);
  });

  it('never engages a Floor 2 boss before both den unlock and encounter activation', () => {
    const world = createTestWorld({ seed: 57, floor: 2 });
    spawnPlayer(world, 10, 10);
    world.floorMap = makeOpenRoom(40, 20);
    const familyId = asFamilyId('imps');
    const bossEid = spawnEnemy(world, 18, 10, 100);
    addComponent(world.ecs, bossEid, FamilyMembership);
    world.stores.familyMembership.familyId[bossEid] = 0;
    world.stores.familyMembership.isBoss[bossEid] = 1;
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [familyId],
        contestedResource: 'gold-veins' as never,
        betrayerFlag: false,
        reputationSystemActive: true,
        trashKillsByFamily: new Map([[familyId, 0]]),
        bossEncounters: new Map([
          [
            familyId,
            {
              familyId,
              roomId: -1,
              doorEids: [],
              activeGoalId: 'floor2-den-imps-boss-active',
              started: false,
              bossEid,
              defeated: false,
              displayName: 'Imp Boss',
              lootTableId: 'boss',
            },
          ],
        ]),
      },
    };
    world.goalFlags.set(FLOOR2_SETTLEMENT_FOUND_GOAL_ID, true);
    world.goalFlags.set(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID, true);

    const lockedAi = new BehaviorTreeAI({ seed: 57 });
    lockedAi.poll(createInputState(), world);
    expect(lockedAi.getDecision().targetEid).not.toBe(bossEid);

    world.goalFlags.set(denUnlockGoalId(familyId), true);
    const unlockedButInactiveAi = new BehaviorTreeAI({ seed: 57 });
    unlockedButInactiveAi.poll(createInputState(), world);
    expect(unlockedButInactiveAi.getDecision()).toMatchObject({
      state: AIState.EXPLORE,
      targetEid: -1,
      reason: 'Entering the imps den to confront its boss',
    });

    world.floorExtendedState.familyState!.bossEncounters!.get(familyId)!.started = true;
    const activeAi = new BehaviorTreeAI({ seed: 57 });
    activeAi.poll(createInputState(), world);
    expect(activeAi.getDecision()).toMatchObject({
      state: AIState.ENGAGE,
      targetEid: bossEid,
    });
  });

  it('selects reachable live trash from the committed Floor 2 family', () => {
    const world = createTestWorld({ seed: 58, floor: 2 });
    spawnPlayer(world, 14, 14);
    world.floorMap = makeSealedRoom(50, 18, 14);
    const familyId = asFamilyId('imps');
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [familyId],
        contestedResource: 'gold-veins' as never,
        betrayerFlag: false,
      },
    };
    const tagFamilyTrash = (eid: number): void => {
      addComponent(world.ecs, eid, FamilyMembership);
      world.stores.familyMembership.familyId[eid] = 0;
      world.stores.familyMembership.isBoss[eid] = 0;
    };
    const deadTrash = spawnEnemy(world, 18, 14, 20);
    tagFamilyTrash(deadTrash);
    world.stores.health.current[deadTrash] = 0;
    const unreachableTrash = spawnEnemy(world, 70, 14, 20);
    tagFamilyTrash(unreachableTrash);
    const reachableTrash = spawnEnemy(world, 30, 14, 20);
    tagFamilyTrash(reachableTrash);

    const target = (
      new BehaviorTreeAI({ seed: 58 }) as unknown as {
        findNearestFloor2HuntEnemy(
          world: GameWorld,
          familyId: FamilyId,
          playerX: number,
          playerY: number,
          maxRadius: number,
          requirePerception: boolean,
        ): { eid: number } | null;
      }
    ).findNearestFloor2HuntEnemy(world, familyId, 14, 14, 100, false);

    expect(target?.eid).toBe(reachableTrash);
  });

  it('selects the nearest unresolved Floor 2 territory before kill-count tiebreaks', () => {
    const farFamily = asFamilyId('imps');
    const nearFamily = asFamilyId('myconids');
    const world = createTestWorld({ seed: 42, floor: 2 });
    const player = spawnPlayer(world, 18, 18);
    world.floorMap = makeOpenRoom(60, 30);
    (
      world.floorMap as unknown as {
        territoryZones: Array<{
          familyIndex: number;
          centerX: number;
          centerY: number;
          radius: number;
        }>;
      }
    ).territoryZones = [
      { familyIndex: 0, centerX: 50, centerY: 15, radius: 10 },
      { familyIndex: 1, centerX: 6, centerY: 6, radius: 10 },
    ];
    world.stores.position.x[player] = 18;
    world.stores.position.y[player] = 18;
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [farFamily, nearFamily],
        contestedResource: 'gold-veins' as never,
        betrayerFlag: false,
        trashKillsByFamily: new Map([
          [farFamily, 90],
          [nearFamily, 0],
        ]),
      },
    };

    const ai = new BehaviorTreeAI({ seed: 42 });
    const harness = ai as unknown as {
      selectFloor2HuntFamily(world: GameWorld): FamilyId | null;
    };

    expect(harness.selectFloor2HuntFamily(world)).toBe(nearFamily);
  });

  it('advances the Floor 2 patrol anchor after a full no-progress window', () => {
    const familyId = asFamilyId('imps');
    const world = createTestWorld({ seed: 59, floor: 2 });
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [familyId],
        contestedResource: 'gold-veins' as never,
        betrayerFlag: false,
        trashKillsByFamily: new Map([[familyId, 0]]),
      },
    };
    world.frameCount = FLOOR2_HUNT_NO_PROGRESS_FRAMES + 1;
    const ai = new BehaviorTreeAI({ seed: 59 });
    const harness = ai as unknown as {
      floor2HuntLastKillCount: number;
      floor2HuntLastProgressFrame: number;
      floor2HuntPatrolIndex: number;
      floor2HuntPatrolTarget: TilePoint | null;
      updateFloor2HuntProgress(world: GameWorld, familyId: FamilyId): boolean;
    };
    harness.floor2HuntLastKillCount = 0;
    harness.floor2HuntLastProgressFrame = 0;
    harness.floor2HuntPatrolIndex = 2;
    harness.floor2HuntPatrolTarget = { x: 5, y: 5 };

    expect(harness.updateFloor2HuntProgress(world, familyId)).toBe(true);
    expect(harness.floor2HuntPatrolIndex).toBe(3);
    expect(harness.floor2HuntPatrolTarget).toBeNull();
  });

  it('paces Floor 2 hunts at three ENGAGE frames per recovery frame', () => {
    const world = createTestWorld({ seed: 60, floor: 2 });
    const ai = new BehaviorTreeAI({ seed: 60 });
    const harness = ai as unknown as {
      floor2HuntCadenceStartFrame: number;
      isFloor2HuntRecoveryWindow(world: GameWorld): boolean;
    };
    harness.floor2HuntCadenceStartFrame = 100;

    world.frameCount = 100 + FLOOR2_HUNT_ENGAGE_FRAMES - 1;
    expect(harness.isFloor2HuntRecoveryWindow(world)).toBe(false);
    world.frameCount = 100 + FLOOR2_HUNT_ENGAGE_FRAMES;
    expect(harness.isFloor2HuntRecoveryWindow(world)).toBe(true);
    world.floorId = 'floor2';
    world.elapsedMs = 900_000;
    expect(harness.isFloor2HuntRecoveryWindow(world)).toBe(false);
    world.elapsedMs = 0;
    world.frameCount = 100 + FLOOR2_HUNT_ENGAGE_FRAMES + FLOOR2_HUNT_RECOVERY_FRAMES - 1;
    expect(harness.isFloor2HuntRecoveryWindow(world)).toBe(true);
    world.frameCount = 100 + FLOOR2_HUNT_ENGAGE_FRAMES + FLOOR2_HUNT_RECOVERY_FRAMES;
    expect(harness.isFloor2HuntRecoveryWindow(world)).toBe(false);
  });

  it('routes direct Floor 2 starts to the settlement before den, enemy, or loot goals', () => {
    const world = createTestWorld({ seed: 54, floor: 2 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor2Scenario(world, player);
    const anchor = resolveFloor2SettlementAnchor(world);
    expect(anchor).not.toBeNull();

    const px = world.stores.position.x[player] ?? 0;
    const py = world.stores.position.y[player] ?? 0;
    const dx = anchor!.x - px;
    const dy = anchor!.y - py;
    const distance = Math.hypot(dx, dy);
    const ux = distance > 0 ? dx / distance : 1;
    const uy = distance > 0 ? dy / distance : 0;
    spawnEnemy(world, px + ux * 20, py + uy * 20, 20);
    spawnXpGem(world, px + ux * 4 - uy * 2, py + uy * 4 + ux * 2, 5);

    const ai = new BehaviorTreeAI({ seed: 54, farmPullWeight: 0.35 });
    const input = createInputState();
    ai.poll(input, world);
    ai.poll(input, world);

    expect(ai.getDecision()).toMatchObject({
      state: AIState.EXPLORE,
      targetEid: -1,
      targetX: anchor!.x,
      targetY: anchor!.y,
      reason: 'Heading to the Floor 2 settlement',
    });
    expect(ai.getOpportunisticDebug()).toMatchObject({
      pullX: 0,
      pullY: 0,
      farmX: 0,
      farmY: 0,
    });
  });

  it('keeps simulated carry-over runs on the Broker after settlement discovery despite nearby threats', () => {
    const world = createTestWorld({ seed: 55, floor: 2 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor2Scenario(world, player);
    acceptQuest(world, FLOOR1_TUTORIAL_QUEST_ID);
    world.goalFlags.set(FLOOR2_SETTLEMENT_FOUND_GOAL_ID, true);

    const brokerEid = world.floorExtendedState!.settlement!.brokerEid;
    const px = world.stores.position.x[player] ?? 0;
    const py = world.stores.position.y[player] ?? 0;
    spawnEnemy(world, px + 6, py, 20);
    spawnXpGem(world, px + 3, py + 2, 5);

    const ai = new BehaviorTreeAI({ seed: 55 });
    ai.poll(createInputState(), world);

    expect(ai.getDecision()).toMatchObject({
      state: AIState.EXPLORE,
      targetEid: brokerEid,
      reason: 'Heading to the Floor 2 Broker introduction',
    });
  });

  it.each([
    ['invalid Broker eid', -1],
    ['missing Broker entity', 2999],
  ])('holds the Broker phase at the settlement anchor for a %s', (_label, brokerEid) => {
    const world = createTestWorld({ seed: 56, floor: 2 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor2Scenario(world, player);
    world.goalFlags.set(FLOOR2_SETTLEMENT_FOUND_GOAL_ID, true);
    const settlement = world.floorExtendedState!.settlement!;
    world.floorExtendedState!.settlement = { ...settlement, brokerEid };
    const anchor = resolveFloor2SettlementAnchor(world);
    expect(anchor).not.toBeNull();

    const ai = new BehaviorTreeAI({ seed: 56 });
    ai.poll(createInputState(), world);

    expect(ai.getDecision()).toMatchObject({
      state: AIState.EXPLORE,
      targetEid: -1,
      targetX: anchor!.x,
      targetY: anchor!.y,
      reason: 'Heading to the Floor 2 Broker introduction',
    });
  });

  it('routes to spawned Floor 2 exit stairs as the terminal progress objective', () => {
    const world = createTestWorld({ seed: 53, floor: 2 });
    spawnPlayer(world, 8, 8);
    world.floorMap = makeOpenRoom(40, 20);
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [],
        contestedResource: 'gold-veins' as never,
        betrayerFlag: false,
        reputationSystemActive: true,
        staircaseSpawned: true,
        staircaseUnlocked: true,
        staircaseDiscovered: false,
        staircasePos: { x: 80, y: 40 },
      },
    };
    world.goalFlags.set(FLOOR2_SETTLEMENT_FOUND_GOAL_ID, true);
    world.goalFlags.set(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID, true);

    const ai = new BehaviorTreeAI({ seed: 53 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.EXPLORE);
    expect(decision.targetX).toBe(80);
    expect(decision.targetY).toBe(40);
    expect(decision.reason).toBe('Heading to the Floor 2 exit stairs');
  });

  it('clears EXPLORE target and stops movement when A* finds no path (Floor 2 staircase behind wall)', () => {
    // Regression: seed 42 Floor 2 — AI wiggled against unreachable territory door
    // because the EXPLORE no-path handler fell through to moveWithLocalNavigation
    // instead of clearing the target. Fix 1 adds an early return that zeroes movement
    // and clears the target so the DwellTracker can accumulate and suppress the goal.
    //
    // The goal tile must be more than PATH_GOAL_SEARCH_RADIUS_TILES (6) tiles from
    // the wall column so the ring search inside resolveReachableGoalTile never finds
    // a left-side reachable fallback tile — only then does A* receive the unreachable
    // raw goal and return an empty path. Wall at x=14, door at tile (22, 8): gap of 8.
    // World coords: tileToWorld(22, 8) = (22 × 4 + 2, 8 × 4 + 2) = (90, 34).
    const world = createTestWorld({ seed: 63, floor: 2 });
    spawnPlayer(world, 14, 14); // tile (3, 3) — left half of the sealed room
    world.floorMap = makeSealedRoom(50, 18, 14); // 50-wide map; wall column at x=14
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [],
        contestedResource: 'gold-veins' as never,
        betrayerFlag: false,
        reputationSystemActive: true,
        staircaseSpawned: true,
        staircaseUnlocked: true,
        staircaseDiscovered: false,
        // tile (22, 8) i.e. world (90, 34) — 8 tiles past the wall, outside radius 6
        staircasePos: { x: 90, y: 34 },
      },
    };
    world.goalFlags.set(FLOOR2_SETTLEMENT_FOUND_GOAL_ID, true);
    world.goalFlags.set(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID, true);

    const ai = new BehaviorTreeAI({ seed: 63 });
    const input = createInputState();
    ai.poll(input, world);

    // BT assigns the staircase as an EXPLORE target; A* cannot reach tile (22,8)
    // and resolveReachableGoalTile finds no reachable ring tile within radius 6.
    // Fix 1 must clear the target and stop movement immediately.
    const decision = ai.getDecision();
    expect(decision.targetX).toBeNull();
    expect(decision.targetY).toBeNull();
    expect(input.moveX).toBe(0);
    expect(input.moveY).toBe(0);
  });

  it('does not re-target Floor 2 territory when progressGoalSuppressedUntilFrame is in the future', () => {
    // Regression: seed 42 Floor 2 — after Fix 1 clears the stuck target the
    // DwellTracker fires and sets progressGoalSuppressedUntilFrame, but the Floor 2
    // objective path bypassed the suppression check and immediately re-assigned the
    // same unreachable territory target every frame. Fix 2 passes the suppression
    // flag into findFloor2QuestProgressTarget and gates the territory fallback on it.
    const world = createTestWorld({ seed: 60, floor: 2 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor2Scenario(world, player);
    world.goalFlags.set(FLOOR2_SETTLEMENT_FOUND_GOAL_ID, true);
    world.goalFlags.set(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID, true);
    if (world.floorExtendedState?.familyState) {
      world.floorExtendedState.familyState.reputationSystemActive = true;
    }

    const ai = new BehaviorTreeAI({ seed: 60 });
    // Simulate the DwellTracker having just fired: suppress all fixed-position
    // progress goals far into the future.
    (
      ai as unknown as { progressGoalSuppressedUntilFrame: number }
    ).progressGoalSuppressedUntilFrame = Number.MAX_SAFE_INTEGER;

    ai.poll(createInputState(), world);

    // With suppression active the territory fallback must be skipped — the AI
    // should pick any target OTHER than a territory sweep.
    expect(ai.getDecision().reason).not.toMatch(/territory/i);
  });

  it('does not re-target Floor 2 staircase progress when progressGoalSuppressedUntilFrame is in the future', () => {
    const world = createTestWorld({ seed: 59, floor: 2 });
    spawnPlayer(world, 14, 14);
    world.floorMap = makeSealedRoom(50, 18, 14);
    world.floorExtendedState = {
      familyState: {
        presentFamilies: [],
        contestedResource: 'gold-veins' as never,
        betrayerFlag: false,
        reputationSystemActive: true,
        staircaseSpawned: true,
        staircaseUnlocked: true,
        staircaseDiscovered: false,
        staircasePos: { x: 90, y: 34 },
      },
    };
    world.goalFlags.set(FLOOR2_SETTLEMENT_FOUND_GOAL_ID, true);
    world.goalFlags.set(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID, true);

    const ai = new BehaviorTreeAI({ seed: 59 });
    (
      ai as unknown as { progressGoalSuppressedUntilFrame: number }
    ).progressGoalSuppressedUntilFrame = Number.MAX_SAFE_INTEGER;

    for (let frame = 0; frame < 8; frame++) {
      world.frameCount = frame;
      ai.poll(createInputState(), world);
      expect(ai.getDecision().reason).not.toBe('Heading to the Floor 2 exit stairs');
    }
  });

  it('engages nearby enemies before long NPC approach paths', () => {
    const { world } = setupNpcApproachThreat('sword');
    const ai = new BehaviorTreeAI({ seed: 12 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.reason).toContain('Clearing nearby threat before NPC interaction');
  });

  it.each(['bow', 'fireball', 'boomerang', 'laser'])(
    'keeps %s travelling toward an NPC while auto-fire handles nearby threats',
    (weaponId) => {
      const { world, shopkeeperNpcEid } = setupNpcApproachThreat(weaponId);
      const ai = new BehaviorTreeAI({ seed: 12 });
      ai.poll(createInputState(), world);

      const decision = ai.getDecision();
      expect(decision.state).toBe(AIState.EXPLORE);
      expect(decision.targetEid).toBe(shopkeeperNpcEid);
      expect(decision.targetX).toBe(38);
      expect(decision.targetY).toBe(14);
      expect(decision.reason).not.toContain('Clearing nearby threat');
    },
  );

  it('abandons a melee NPC threat clear after sustained no progress', () => {
    const { world, shopkeeperNpcEid } = setupNpcApproachThreat('sword');
    const ai = new BehaviorTreeAI({ seed: 12 });

    // Poll past the per-enemy ENGAGE_GIVEUP_FRAMES watchdog: the nearest enemy
    // gets blacklisted and the second in-range enemy takes over, but the
    // per-NPC no-progress valve spans that switch, so ENGAGE must persist.
    for (let poll = 0; poll < ENGAGE_GIVEUP_FRAMES + 2; poll += 1) {
      ai.poll(createInputState(), world);
    }
    expect(ai.getDecision().state).toBe(AIState.ENGAGE);
    expect(ai.getDecision().reason).toContain('Clearing nearby threat before NPC interaction');

    // Keep polling until the per-NPC valve itself times out (total polls =
    // NPC_APPROACH_THREAT_NO_PROGRESS_FRAMES + 2), proving the new valve — not
    // the old per-enemy ignore — is what eventually gives up.
    for (
      let poll = ENGAGE_GIVEUP_FRAMES + 2;
      poll < NPC_APPROACH_THREAT_NO_PROGRESS_FRAMES + 2;
      poll += 1
    ) {
      ai.poll(createInputState(), world);
    }

    expect(ai.getDecision()).toMatchObject({
      state: AIState.EXPLORE,
      targetEid: shopkeeperNpcEid,
      targetX: 38,
      targetY: 14,
    });

    ai.reset();
    ai.poll(createInputState(), world);

    expect(ai.getDecision().state).toBe(AIState.ENGAGE);
    expect(ai.getDecision().reason).toContain('Clearing nearby threat before NPC interaction');
  });

  it('resets NPC threat-clear progress when the nearby-threat gate exits', () => {
    const { world, enemies } = setupNpcApproachThreat('sword');
    const ai = new BehaviorTreeAI({ seed: 12 });

    // Latch the no-progress bypass first, so the reset below is the ONLY thing
    // that can restore ENGAGE (proves the no-nearby-threat reset call matters).
    for (let poll = 0; poll < NPC_APPROACH_THREAT_NO_PROGRESS_FRAMES + 2; poll += 1) {
      ai.poll(createInputState(), world);
    }
    expect(ai.getDecision().state).toBe(AIState.EXPLORE);

    for (const enemy of enemies) {
      world.stores.position.x[enemy] = 100;
    }
    ai.poll(createInputState(), world);

    const originalEnemyX = [22, 21];
    enemies.forEach((enemy, index) => {
      const x = originalEnemyX[index];
      expect(x).toBeDefined();
      world.stores.position.x[enemy] = x!;
    });
    ai.poll(createInputState(), world);

    expect(ai.getDecision().state).toBe(AIState.ENGAGE);
    expect(ai.getDecision().reason).toContain('Clearing nearby threat before NPC interaction');
  });

  it('clears NPC threat-clear bypass after higher-priority Progress preemption', () => {
    const { world, shopkeeperNpcEid } = setupNpcApproachThreat('sword');
    const ai = new BehaviorTreeAI({ seed: 12 });

    for (let poll = 0; poll < NPC_APPROACH_THREAT_NO_PROGRESS_FRAMES + 2; poll += 1) {
      ai.poll(createInputState(), world);
    }
    expect(ai.getDecision().state).toBe(AIState.EXPLORE);

    // Force Track A to end at Interact so Progress is pre-empted this poll.
    world.stores.position.x[shopkeeperNpcEid] = 15;
    world.stores.position.y[shopkeeperNpcEid] = 14;
    ai.poll(createInputState(), world);
    expect(ai.getDecision().state).toBe(AIState.INTERACT);

    world.stores.position.x[shopkeeperNpcEid] = 38;
    world.stores.position.y[shopkeeperNpcEid] = 14;
    ai.poll(createInputState(), world);

    expect(ai.getDecision().state).toBe(AIState.ENGAGE);
    expect(ai.getDecision().reason).toContain('Clearing nearby threat before NPC interaction');
  });

  it('routes merchant progress through a reachable NPC anchor instead of raw NPC center', () => {
    const world = createTestWorld({ seed: 12 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    meetTutorialGoon(world);
    world.playerLevel.level = 2;
    world.floorScenario!.objective.questCompleted = true;
    completeNonShopObjectives(world);
    world.floorMap = makeSealedRoom(24, 20, 10);
    const playerPos = world.floorMap.tileToWorld(6, 6);
    world.stores.position.x[player] = playerPos.x;
    world.stores.position.y[player] = playerPos.y;

    const shopkeeperNpcEid = world.floorScenario!.shopkeeperNpcEid;
    const spellBrokerEid = world.floorScenario!.spellQuestGiverNpcEid;
    expect(shopkeeperNpcEid).toBeDefined();
    expect(spellBrokerEid).toBeDefined();
    const shopkeeperPos = world.floorMap.tileToWorld(11, 6);
    const spellBrokerPos = world.floorMap.tileToWorld(16, 6);
    const expectedAnchor = world.floorMap.tileToWorld(9, 6);
    world.stores.position.x[shopkeeperNpcEid!] = shopkeeperPos.x;
    world.stores.position.y[shopkeeperNpcEid!] = shopkeeperPos.y;
    world.stores.position.x[spellBrokerEid!] = spellBrokerPos.x;
    world.stores.position.y[spellBrokerEid!] = spellBrokerPos.y;
    // `shopRoomPos`/`spellQuestGiverPos` are readonly on the objective type, so
    // override them by reassigning the whole (mutable) objective with a spread.
    world.floorScenario!.objective = {
      ...world.floorScenario!.objective,
      shopRoomPos: expectedAnchor,
      questItemPos: world.floorMap.tileToWorld(8, 6),
      spellQuestGiverPos: spellBrokerPos,
    };

    const ai = new BehaviorTreeAI({ seed: 12 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.EXPLORE);
    expect(decision.targetEid).toBe(shopkeeperNpcEid);
    expect(decision.reason).toBe('Seeking Shopkeeper to start the merchant errand');
    expect(decision.npcInteraction).toEqual({
      npcEid: shopkeeperNpcEid,
      action: AINpcInteractionAction.MEET_SHOPKEEPER,
      allowWhileExploring: true,
    });
    expect(decision.targetX).toBe(expectedAnchor.x);
    expect(decision.targetY).toBe(expectedAnchor.y);
    expect(decision.targetX).not.toBe(shopkeeperPos.x);

    const cacheHarness = ai as unknown as {
      floor1MiddleChainCache: object | null;
    };
    const initialRoute = cacheHarness.floor1MiddleChainCache;
    expect(initialRoute).not.toBeNull();

    world.frameCount += 1_000;
    world.elapsedMs += 100_000;
    ai.poll(createInputState(), world);
    expect(cacheHarness.floor1MiddleChainCache).toBe(initialRoute);

    world.goalFlags.set('floor1-shop-prize-returned', true);
    ai.poll(createInputState(), world);
    expect(cacheHarness.floor1MiddleChainCache).not.toBe(initialRoute);
  });

  it('plumbs a committed quest-giver detour into run planning as its exact graph goal', () => {
    const world = createTestWorld({ seed: 12 });
    const player = spawnPlayer(world, 14, 14);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    meetTutorialGoon(world);
    world.playerLevel.level = 2;
    world.floorScenario!.objective.questCompleted = true;
    world.goalFlags.set('floor1-leveling-quest-complete', true);
    world.goalFlags.set('floor1-goon-quest-complete', true);
    world.floorMap = makeOpenRoom(40, 20);

    const spellBrokerEid = world.floorScenario!.spellQuestGiverNpcEid;
    expect(spellBrokerEid).toBeDefined();
    world.stores.position.x[spellBrokerEid!] = 38;
    world.stores.position.y[spellBrokerEid!] = 14;

    const ai = new BehaviorTreeAI({ seed: 12 });
    const harness = ai as unknown as {
      committedDetourNpcEid: number | null;
      merchantDecisionRunPlan: object | null;
      merchantDecisionRunPlanFrame: number;
      estimateCurrentRunPlan(
        gameWorld: GameWorld,
        playerEid: number,
        playerX: number,
        playerY: number,
        playerSpeedFtPerFrame: number,
      ): {
        segments: readonly { id: string }[];
      } | null;
      releaseDetourCommitment(): void;
    };
    harness.committedDetourNpcEid = spellBrokerEid!;

    const plan = harness.estimateCurrentRunPlan(world, player, 14, 14, 0.2);

    expect(plan?.segments[0]?.id).toBe('current-detour');
    expect(plan?.segments.map((segment) => segment.id)).not.toContain('accept-spell-quest');
    expect(plan?.segments.map((segment) => segment.id)).toContain('kill-slime-rat');

    harness.merchantDecisionRunPlan = plan;
    harness.merchantDecisionRunPlanFrame = world.frameCount;
    harness.releaseDetourCommitment();
    expect(harness.merchantDecisionRunPlan).toBeNull();
    expect(harness.merchantDecisionRunPlanFrame).toBe(Number.NEGATIVE_INFINITY);
  });

  it('does not poison the cached NPC anchor after a close-range first visit', () => {
    const world = createTestWorld({ seed: 18 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    meetTutorialGoon(world);
    world.playerLevel.level = 2;
    world.floorScenario!.objective.questCompleted = true;
    world.floorMap = makeSealedRoom(24, 20, 10);

    const shopkeeperNpcEid = world.floorScenario!.shopkeeperNpcEid!;
    const shopkeeperPos = world.floorMap.tileToWorld(11, 6);
    const nearPlayerPos = world.floorMap.tileToWorld(9, 6);
    const farPlayerPos = world.floorMap.tileToWorld(6, 6);
    const expectedAnchor = world.floorMap.tileToWorld(9, 6);
    world.stores.position.x[shopkeeperNpcEid] = shopkeeperPos.x;
    world.stores.position.y[shopkeeperNpcEid] = shopkeeperPos.y;

    const ai = new BehaviorTreeAI({ seed: 18 });
    const resolveNpcInteractionAnchor = ai['resolveNpcInteractionAnchor'].bind(ai) as (
      world: GameWorld,
      playerX: number,
      playerY: number,
      npcX: number,
      npcY: number,
      npcEid: number,
    ) => { x: number; y: number };

    const firstVisit = resolveNpcInteractionAnchor(
      world,
      nearPlayerPos.x,
      nearPlayerPos.y,
      shopkeeperPos.x,
      shopkeeperPos.y,
      shopkeeperNpcEid,
    );
    expect(firstVisit).toEqual(shopkeeperPos);

    const revisit = resolveNpcInteractionAnchor(
      world,
      farPlayerPos.x,
      farPlayerPos.y,
      shopkeeperPos.x,
      shopkeeperPos.y,
      shopkeeperNpcEid,
    );
    expect(revisit).toEqual(expectedAnchor);
  });

  it('does not engage an unseen enemy once minimap/FOV perception is initialized', () => {
    const world = createTestWorld({ seed: 19 });
    spawnPlayer(world, 10, 10);
    world.floorMap = makeOpenRoom(24, 24);
    setActiveWeapon(world, getWeaponDef('sword')!);

    const hiddenEnemy = spawnEnemy(world, 18, 10, 20);
    const floorMap = world.floorMap;
    const playerTile = floorMap.worldToTile(10, 10);
    const hiddenTile = floorMap.worldToTile(18, 10);
    // Use matching visible/discovered sub-tile coords (TL quadrant = tile * 2).
    floorMap.setVisible(playerTile.x * 2, playerTile.y * 2);
    floorMap.setDiscovered(playerTile.x * 2, playerTile.y * 2);
    // hiddenTile starts with all sub-tiles = 0 (dark), no action needed.

    const ai = new BehaviorTreeAI({ seed: 19 });
    ai.poll(createInputState(), world);
    expect(ai.getDecision().targetEid).not.toBe(hiddenEnemy);

    // Once the enemy appears in FOV/minimap-known tiles, it becomes a valid target.
    floorMap.setVisible(hiddenTile.x * 2, hiddenTile.y * 2);
    floorMap.setDiscovered(hiddenTile.x * 2, hiddenTile.y * 2);
    ai.poll(createInputState(), world);
    expect(ai.getDecision().targetEid).toBe(hiddenEnemy);
  });

  it('transitions from permissive (no FOV) to restrictive (FOV initialized) perception', () => {
    const world = createTestWorld({ seed: 25 });
    spawnPlayer(world, 10, 10);
    world.floorMap = makeOpenRoom(24, 24);
    setActiveWeapon(world, getWeaponDef('sword')!);

    const hiddenEnemy = spawnEnemy(world, 18, 10, 20);
    const floorMap = world.floorMap;
    const playerTile = floorMap.worldToTile(10, 10);

    // Before FOV initialization: no visibility set yet (permissive mode)
    const ai = new BehaviorTreeAI({ seed: 25 });
    ai.poll(createInputState(), world);
    // In permissive mode (no FOV data yet), hidden enemy is accessible
    expect(ai.getDecision().targetEid).toBe(hiddenEnemy);

    // After FOV initialization with visibility bitmap (restrictive mode).
    // Set the player tile visible (triggers hasPerceptionData = true).
    floorMap.setVisible(playerTile.x * 2, playerTile.y * 2);
    floorMap.setDiscovered(playerTile.x * 2, playerTile.y * 2);
    // hiddenTile stays dark (all sub-tiles = 0 by default).

    ai.poll(createInputState(), world);
    // Now that FOV is initialized, hidden enemy should NOT be targeted
    expect(ai.getDecision().targetEid).not.toBe(hiddenEnemy);
  });

  it('recalculates destination immediately after accepting a new quest', () => {
    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    meetTutorialGoon(world);
    world.playerLevel.level = 2;
    world.goalFlags.set('floor1-leveling-quest-complete', true);
    world.goalFlags.set('floor1-shop-quest-complete', true);
    world.floorScenario!.objective.questCompleted = true;

    const ai = new BehaviorTreeAI({ seed: 7 });
    const input = createInputState();
    ai.poll(input, world);
    const before = ai.getDecision();
    expect(before.reason).toContain('Spell Broker');

    meetSpellQuestGiver(world);
    ai.poll(input, world);
    const after = ai.getDecision();
    expect(after.reason).toContain('Slime Rat room');
    expect(after.targetX).toBe(world.floorScenario!.objective.slimeRatRoomPos.x);
    expect(after.targetY).toBe(world.floorScenario!.objective.slimeRatRoomPos.y);
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
    // Place an enemy 25ft to the right so the AI targets it and outputs (1, 0).
    spawnEnemy(world, 25, 0, 20);
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
    // Distance ~28ft: beyond CLOSE_APPROACH_DIRECT_FT (6) so A* builds a path,
    // and inside scanRadius (50) so Collect fires. The 4-connected path's first
    // waypoint is a cardinal neighbour (~zero on one axis); string-pulling must
    // advance to the line-of-sight-visible goal so BOTH axes drive.
    spawnPlayer(world, 14, 14);
    spawnGold(world, 34, 34, 3);

    const ai = new BehaviorTreeAI({ seed: 99 });
    const input = createInputState();
    ai.poll(input, world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.COLLECT);
    // Pre-fix: one axis is ~0 (cardinal first hop). Post-fix: diagonal steer.
    // With MOVE_SMOOTH_FACTOR=0.5, first-frame diagonal components are ~0.35; keep
    // 0.15 low enough to allow smoothing while high enough to reject cardinal hops.
    expect(Math.abs(input.moveX)).toBeGreaterThan(MIN_DIAGONAL_COMPONENT);
    expect(Math.abs(input.moveY)).toBeGreaterThan(MIN_DIAGONAL_COMPONENT);
  });

  it('reuses the engagement kite while farming quest mobs instead of trading blows', () => {
    const world = createTestWorld({ seed: 2 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    enterKillGrindStage(world);
    setActiveWeapon(world, getWeaponDef('sword')!);
    world.floorMap = makeOpenRoom(16, 16);
    world.stores.position.x[player] = 14;
    world.stores.position.y[player] = 14;

    // Quest enemy inside the sword strike gate (reach 5ft, gate 7.5ft). Use an
    // open-room floor map so the fixture isolates the progress-to-engage handoff
    // from dungeon reachability noise. The old Progress branch walked straight
    // onto the enemy center; it must now route through planEngagement and kite
    // (same as Engage/Hunt).
    const rat = spawnEnemy(world, 17.75, 14, 20);
    world.floorScenario!.enemyArchetypes.set(rat, 'rat');

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
    expect(distToEnemy).toBeGreaterThan(1.25);
  });

  it('approaches a distant enemy to the close ranged standoff with a ranged weapon', () => {
    // Bow range = 44ft. The AI now uses a deliberately close standoff:
    // max(CONTACT_SAFE_ORBIT_FT=4.5, min(44 × 0.5, RANGED_STANDOFF_ABS_FT=6)) = 6ft.
    // Projectiles fire at the enemy's CURRENT position with no leading, so a tight
    // standoff is what makes shots actually connect with wandering swarm enemies
    // (the bow was nearly useless at the old 33ft standoff). Enemy at 43.75ft is
    // within the engage radius and far beyond 6ft, so the AI must plan a target at
    // ~6ft from the enemy, not at the enemy's position.
    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 43.75, 0, 20);
    setActiveWeapon(world, getWeaponDef('bow')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.reason).toContain('Closing to ranged standoff');
    // Target must be between the player and the enemy (approaching), but not at
    // the enemy position (not walking onto it).
    expect(decision.targetX).not.toBeNull();
    expect(decision.targetX!).toBeGreaterThan(0);
    expect(decision.targetX!).toBeLessThan(43.75);
    // Target should land close to the absolute standoff distance from the enemy.
    const standoffFt = 6;
    expect(decision.targetX!).toBeCloseTo(43.75 - standoffFt, 0);
  });

  it('expands wounded projectile spacing only when a nearby enemy creates pressure', () => {
    const pistol = getWeaponDef('pistol')!;

    const healthyWorld = createTestWorld({ seed: 7 });
    spawnPlayer(healthyWorld, 0, 0);
    spawnEnemy(healthyWorld, 12, 0, 20);
    setActiveWeapon(healthyWorld, pistol);
    const healthyAi = new BehaviorTreeAI({ seed: 7 });
    healthyAi.poll(createInputState(), healthyWorld);
    const healthyDecision = healthyAi.getDecision();

    const woundedWorld = createTestWorld({ seed: 7 });
    const woundedPlayer = spawnPlayer(woundedWorld, 0, 0);
    woundedWorld.stores.health.current[woundedPlayer] = 50;
    woundedWorld.stores.health.max[woundedPlayer] = 100;
    spawnEnemy(woundedWorld, 12, 0, 20);
    setActiveWeapon(woundedWorld, pistol);
    const woundedAi = new BehaviorTreeAI({ seed: 7 });
    woundedAi.poll(createInputState(), woundedWorld);
    const woundedDecision = woundedAi.getDecision();

    expect(healthyDecision.reason).toContain('Closing to ranged standoff (6.0ft)');
    expect(healthyDecision.targetX).toBeGreaterThan(0);
    expect(woundedDecision.reason).toContain('Ranged orbit');
    expect(woundedDecision.targetX).toBeLessThan(healthyDecision.targetX!);
  });

  it('holds wounded projectile spacing until the pressure bubble is fully clear', () => {
    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);
    world.stores.health.current[player] = 50;
    world.stores.health.max[player] = 100;
    const enemy = spawnEnemy(world, 12, 0, 20);
    setActiveWeapon(world, getWeaponDef('pistol')!);
    const ai = new BehaviorTreeAI({ seed: 7 });

    ai.poll(createInputState(), world);
    world.stores.position.x[enemy] = 20;
    ai.poll(createInputState(), world);

    expect(ai.getDecision().reason).toContain('ranged standoff (10.0ft)');

    world.stores.position.x[enemy] = 31;
    ai.poll(createInputState(), world);

    expect(ai.getDecision().reason).toContain('ranged standoff (6.0ft)');
  });

  it('clears defensive spacing latch on hostile encounter revision', () => {
    // Bug: rangedDefensiveSpacing was not cleared in
    // invalidateTransientDecisionForHostileEncounter(), so a reused AI that
    // had latched spacing (enemy at 12ft while wounded) would keep the 10ft
    // orbit after a revision boundary even when the only remaining enemy is
    // at 25ft — outside the 15ft pressure radius.
    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);
    world.stores.health.current[player] = 50;
    world.stores.health.max[player] = 100;
    const enemy = spawnEnemy(world, 12, 0, 20);
    setActiveWeapon(world, getWeaponDef('pistol')!);
    const ai = new BehaviorTreeAI({ seed: 7 });

    // First poll: enemy at 12ft while wounded → latches defensive spacing.
    ai.poll(createInputState(), world);
    expect(ai.getDecision().reason).toContain('Ranged orbit');

    // Simulate a hostile encounter revision (e.g. a boss encounter starts).
    world.hostileEncounterRevision += 1;

    // Move enemy to 25ft — outside the 15ft pressure radius but inside the
    // 30ft release radius, so without the fix the latch would survive.
    world.stores.position.x[enemy] = 25;
    ai.poll(createInputState(), world);

    // After the revision boundary the latch must be cleared; AI should use
    // the healthy 6ft standoff, not the defensive 10ft standoff.
    expect(ai.getDecision().reason).toContain('ranged standoff (6.0ft)');
  });

  it('keeps the healthy ranged baseline when wounded without nearby pressure', () => {
    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);
    world.stores.health.current[player] = 50;
    world.stores.health.max[player] = 100;
    spawnEnemy(world, 30, 0, 20);
    setActiveWeapon(world, getWeaponDef('pistol')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.reason).toContain('Closing to ranged standoff (6.0ft)');
    expect(decision.targetX).toBeCloseTo(24, 0);
  });

  it('retreats a wounded projectile user from contact without changing healthy behavior', () => {
    const pistol = getWeaponDef('pistol')!;

    const healthyWorld = createTestWorld({ seed: 7 });
    spawnPlayer(healthyWorld, 0, 0);
    spawnEnemy(healthyWorld, 4, 0, 20);
    setActiveWeapon(healthyWorld, pistol);
    const healthyAi = new BehaviorTreeAI({ seed: 7 });
    healthyAi.poll(createInputState(), healthyWorld);

    const woundedWorld = createTestWorld({ seed: 7 });
    const woundedPlayer = spawnPlayer(woundedWorld, 0, 0);
    woundedWorld.stores.health.current[woundedPlayer] = 50;
    woundedWorld.stores.health.max[woundedPlayer] = 100;
    const woundedEnemy = spawnEnemy(woundedWorld, 4, 0, 20);
    setActiveWeapon(woundedWorld, pistol);
    const woundedAi = new BehaviorTreeAI({ seed: 7 });
    woundedAi.poll(createInputState(), woundedWorld);

    expect(healthyAi.getDecision().state).toBe(AIState.ENGAGE);
    expect(woundedAi.getDecision().state).toBe(AIState.RETREAT);
    expect(woundedAi.getDecision().reason).toContain('contact pressure');

    woundedWorld.stores.position.x[woundedEnemy] = 16;
    woundedAi.poll(createInputState(), woundedWorld);

    expect(woundedAi.getDecision().state).toBe(AIState.ENGAGE);
  });

  it('arms defensive spacing latch when contact retreat starts so wider orbit persists after release', () => {
    // If the first threat is already within contact range (4.5ft), Retreat
    // preempts planRangedEngagement, so rangedDefensiveSpacing is never set
    // by the normal pressure-check path. The latch must be armed when the
    // contact retreat is entered so that after retreat releases (enemy backs
    // past rangedSafeDistance=15ft) the AI holds the 10ft defensive orbit
    // instead of immediately snapping back to the 6ft healthy orbit.
    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);
    world.stores.health.current[player] = 50;
    world.stores.health.max[player] = 100;
    const enemy = spawnEnemy(world, 4, 0, 20);
    setActiveWeapon(world, getWeaponDef('pistol')!);
    const ai = new BehaviorTreeAI({ seed: 7 });

    // First poll: enemy within contact range → emergency retreat (latch armed here).
    ai.poll(createInputState(), world);
    expect(ai.getDecision().state).toBe(AIState.RETREAT);
    expect(ai.getDecision().reason).toContain('contact pressure');

    // Enemy backs past the 15ft rangedSafeDistance release radius.
    world.stores.position.x[enemy] = 16;
    ai.poll(createInputState(), world);

    // Latch armed → defensive orbit (10ft), not the healthy 6ft orbit.
    expect(ai.getDecision().state).toBe(AIState.ENGAGE);
    expect(ai.getDecision().reason).toContain('ranged standoff (10.0ft)');
  });

  it('expands to defensive orbit when player HP drops below 40%', () => {
    // bat reach = 5.5ft. innerOrbit=4.5, outerOrbit=6.25 (4.5+1.75),
    // fireGate=8.25 (5.5*1.5). Enemy attackRange=5 → safeOrbit=6.75 (5+1.75).
    // safeOrbit(6.75) > outerOrbit(6.25), so the healthy branch leaves desiredOrbit
    // unchanged. In the wounded branch, safeOrbitCap expands to real blade reach
    // (5.5), producing a defensive expansion without leaving guaranteed hit geometry.
    const bat = getWeaponDef('baseball-bat')!;

    // HEALTHY player — full HP, orbit stays in the normal strike band.
    const healthyWorld = createTestWorld({ seed: 7 });
    spawnPlayer(healthyWorld, 0, 0);
    spawnBehaviorEnemy(healthyWorld, 7.5, 0, 40, AI_TYPE.CHASE, 5, 25, 5);
    healthyWorld.elapsedMs = 5000;
    setActiveWeapon(healthyWorld, bat);
    const healthyAi = new BehaviorTreeAI({ seed: 7 });
    healthyAi.poll(createInputState(), healthyWorld);
    const healthyDecision = healthyAi.getDecision();
    const healthyDist = Math.hypot(healthyDecision.targetX! - 7.5, healthyDecision.targetY!);

    // WOUNDED player — 29% HP crosses MELEE_DEFENSIVE_HP_FRACTION (0.4).
    const woundedWorld = createTestWorld({ seed: 7 });
    const woundedPlayer = spawnPlayer(woundedWorld, 0, 0);
    // Set HP to 29% of max (100) to cross the 40% MELEE_DEFENSIVE_HP_FRACTION.
    woundedWorld.stores.health.current[woundedPlayer] = 29;
    spawnBehaviorEnemy(woundedWorld, 7.5, 0, 40, AI_TYPE.CHASE, 5, 25, 5);
    woundedWorld.elapsedMs = 5000;
    setActiveWeapon(woundedWorld, bat);
    const woundedAi = new BehaviorTreeAI({ seed: 7 });
    woundedAi.poll(createInputState(), woundedWorld);
    const woundedDecision = woundedAi.getDecision();
    const woundedDist = Math.hypot(woundedDecision.targetX! - 7.5, woundedDecision.targetY!);

    expect(healthyDecision.reason).toContain('Kiting');
    expect(woundedDecision.reason).toContain('Kiting');
    // Wounded AI targets farther from the enemy: defensive orbit expansion holds it
    // at real blade reach rather than trading blows in the inner strike band.
    expect(woundedDist).toBeGreaterThan(healthyDist + 0.1);
    expect(woundedDist).toBeLessThanOrEqual(bat.aoeRadius);
  });

  it('does not orbit a ranged enemy outside guaranteed melee hit reach when wounded', () => {
    const sword = getWeaponDef('sword')!;
    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);
    world.stores.health.current[player] = 29;
    spawnBehaviorEnemy(world, 7.4, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    world.elapsedMs = 5000;
    setActiveWeapon(world, sword);

    const ai = new BehaviorTreeAI({ seed: 7 });
    ai.poll(createInputState(), world);
    const decision = ai.getDecision();
    const plannedDistance = Math.hypot(decision.targetX! - 7.4, decision.targetY!);

    expect(decision.reason).toContain('Kiting');
    // The 1.5x auto-fire gate (7.5ft) may begin a swing while closing, but the
    // planner must commit inside the sword's real 5ft blade reach so it can connect.
    expect(plannedDistance).toBeLessThanOrEqual(sword.aoeRadius);
  });

  it('keeps direct melee pressure against an outranging enemy', () => {
    const sword = getWeaponDef('sword')!;
    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 10;
    spawnBehaviorEnemy(world, 20, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    world.elapsedMs = 5000;
    setActiveWeapon(world, sword);

    const ai = new BehaviorTreeAI({ seed: 7 });
    ai.poll(createInputState(), world);
    const decision = ai.getDecision();

    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.reason).toContain('Closing to melee range');
    expect(decision.targetX).toBeGreaterThan(0);
    expect(decision.targetY).toBeCloseTo(0);
  });

  it('sidesteps collision-course projectiles without abandoning an engagement target', () => {
    const sword = getWeaponDef('sword')!;
    const world = createTestWorld({ seed: 42 });
    spawnPlayer(world, 0, 0);
    spawnBehaviorEnemy(world, 20, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    spawnEnemyProjectile(world, 15, 0, -0.5, 0, 8);
    world.elapsedMs = 5000;
    setActiveWeapon(world, sword);

    const ai = new BehaviorTreeAI({ seed: 42 });
    const input = createInputState();
    ai.poll(input, world);
    const decision = ai.getDecision();
    const dodge = ai.getOpportunisticDebug();

    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.targetX).toBeGreaterThan(0);
    expect(input.moveX).toBeGreaterThan(0);
    expect(Math.abs(input.moveY)).toBeGreaterThan(0.25);
    expect(Math.abs(dodge.dodgeY)).toBeGreaterThan(1);
  });

  it('triggers dodge for an AoE fireball that misses the direct-hit clearance but lands within splash radius+buffer, and ignores one just outside', () => {
    // PROJECTILE_DODGE_CLEARANCE_FT = 2.5 ft (direct projectile threshold)
    // PROJECTILE_DODGE_AOE_BUFFER_FT = 1.5 ft
    // Fireball aoeRadius = 3.0 ft → requiredClearance = 3.0 + 1.5 = 4.5 ft
    //
    // Geometry: player at origin, fireball at (20, offsetY) travelling -X at
    // 0.5 ft/frame.  impactFrames = 40; closest point = (0, offsetY).
    // offsetY 3.5 ft: misses direct threshold (3.5 > 2.5) but within AoE (3.5 < 4.5) → dodge
    // offsetY 4.6 ft: outside AoE clearance (4.6 > 4.5) → no dodge
    const AOE_RADIUS = 3.0;

    function makeAoeWorld(offsetY: number): ReturnType<typeof createTestWorld> {
      const world = createTestWorld({ seed: 42 });
      spawnPlayer(world, 0, 0);
      spawnBehaviorEnemy(world, 20, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
      world.elapsedMs = 5000;
      setActiveWeapon(world, getWeaponDef('sword')!);
      const eid = spawnEnemyProjectile(world, 20, offsetY, -0.5, 0, 8);
      addComponent(world.ecs, eid, set(AoeOnImpact, { radius: AOE_RADIUS, damage: 5 }));
      return world;
    }

    // Case A — within AoE splash: closest distance 3.5 ft > 2.5 (direct miss) but < 4.5 (AoE hit).
    const worldA = makeAoeWorld(3.5);
    const aiA = new BehaviorTreeAI({ seed: 42 });
    aiA.poll(createInputState(), worldA);
    const dodgeA = aiA.getOpportunisticDebug();
    expect(
      Math.abs(dodgeA.dodgeX) + Math.abs(dodgeA.dodgeY),
      `AoE fireball at ${3.5} ft offset (inside ${AOE_RADIUS + PROJECTILE_DODGE_AOE_BUFFER_FT} ft clearance) must trigger a dodge`,
    ).toBeGreaterThan(0);

    // Case B — just outside AoE splash: closest distance 4.6 ft > 4.5 → no dodge.
    const worldB = makeAoeWorld(4.6);
    const aiB = new BehaviorTreeAI({ seed: 42 });
    aiB.poll(createInputState(), worldB);
    const dodgeB = aiB.getOpportunisticDebug();
    expect(
      Math.abs(dodgeB.dodgeX) + Math.abs(dodgeB.dodgeY),
      `AoE fireball at ${4.6} ft offset (outside ${AOE_RADIUS + PROJECTILE_DODGE_AOE_BUFFER_FT} ft clearance) must NOT trigger a dodge`,
    ).toBe(0);

    // Confirm the tested clearance is strictly above the direct-projectile
    // threshold so the two paths are actually distinct.
    expect(AOE_RADIUS + PROJECTILE_DODGE_AOE_BUFFER_FT).toBeGreaterThan(
      PROJECTILE_DODGE_CLEARANCE_FT,
    );
  });

  it('orbits away from enemies that are closer than ranged standoff distance', () => {
    // Enemy at 3.75ft is inside the close bow standoff band (6ft). The orbit step
    // must push the AI away (targetX < 0 when enemy is on the +X side).
    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 3.75, 0, 20);
    setActiveWeapon(world, getWeaponDef('bow')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.reason).toContain('Ranged orbit');
    // Radial correction pushes the AI away from the enemy (negative X when enemy
    // is at +X), so the target must be to the left of the player's start.
    expect(decision.targetX!).toBeLessThan(0);
  });

  it('preempts a farther quest target with a nearby threat while keeping the quest eid', () => {
    // Ranged preemption (planRangedEngagement): when the primary engaged target is a
    // far quest enemy but a *different* enemy has pushed inside contactThreatRadius,
    // the movement plan is redirected to orbit the near threat while decision.targetEid
    // stays the far quest enemy (preemption rewrites targetX/targetY/reason, never the
    // eid). Deleting the preemption block makes the AI "close to ranged standoff" on the
    // far target instead — driving targetX toward +44ft rather than orbiting the +X near
    // threat away to -X — so both movement assertions below fail without it.
    const world = createTestWorld({ seed: 2 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    enterKillGrindStage(world);
    world.floorMap = makeOpenRoom(40, 20);
    world.stores.position.x[player] = 14;
    world.stores.position.y[player] = 14;
    setActiveWeapon(world, getWeaponDef('bow')!);

    // Far quest enemy (30ft): the only enemy in enemyArchetypes, so Progress (which
    // outranks Engage during the kill-grind) makes it the primary engaged target.
    const farQuestEnemy = spawnEnemy(world, 44, 14, 20);
    world.floorScenario!.enemyArchetypes.set(farQuestEnemy, 'rat');
    // Close non-quest threat (3.75ft) sitting inside the standoff bubble on the +X side.
    const closeThreat = spawnEnemy(world, 17.75, 14, 20);

    const ai = new BehaviorTreeAI({ seed: 2 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    // Primary target stays the far quest enemy — preemption never rewrites targetEid.
    expect(decision.reason).toContain('Hunting quest enemies');
    expect(decision.targetEid).toBe(farQuestEnemy);
    expect(decision.targetEid).not.toBe(closeThreat);
    // Movement is redirected to orbit the near threat: it orbits (not "Closing to ranged
    // standoff") and pushes to -X, away from the +X near enemy — the opposite direction
    // from closing on the far quest target at +44ft.
    expect(decision.reason).toContain('Ranged orbit');
    expect(decision.targetX!).toBeLessThan(14);
  });

  it('kites with a magic weapon instead of charging onto the enemy', () => {
    // Regression: MAGIC (fireball, range 32ft) used to fall through to the generic
    // "engage at distance" branch and walk straight onto the enemy. It must now
    // kite at the ranged standoff like bows/pistols. Standoff =
    // max(4.5, min(32 × 0.5, 6)) = 6ft, so a distant enemy is approached only to
    // ~6ft and a close one is orbited away.
    const distantWorld = createTestWorld({ seed: 7 });
    spawnPlayer(distantWorld, 0, 0);
    spawnEnemy(distantWorld, 30, 0, 20);
    setActiveWeapon(distantWorld, getWeaponDef('fireball')!);
    const distantAi = new BehaviorTreeAI({ seed: 7 });
    distantAi.poll(createInputState(), distantWorld);
    const distant = distantAi.getDecision();
    expect(distant.reason).toContain('Closing to ranged standoff');
    expect(distant.targetX!).toBeGreaterThan(0);
    expect(distant.targetX!).toBeLessThan(30);
    expect(distant.targetX!).toBeCloseTo(30 - 6, 0);

    const closeWorld = createTestWorld({ seed: 7 });
    spawnPlayer(closeWorld, 0, 0);
    spawnEnemy(closeWorld, 3.75, 0, 20);
    setActiveWeapon(closeWorld, getWeaponDef('fireball')!);
    const closeAi = new BehaviorTreeAI({ seed: 7 });
    closeAi.poll(createInputState(), closeWorld);
    const close = closeAi.getDecision();
    expect(close.reason).toContain('Ranged orbit');
    expect(close.targetX!).toBeLessThan(0);
  });

  // Regression guard for the BFS path-resolver refactor (PR #324). The goal-tile
  // resolver flood-fills `dist` once and reads it via `dist[y * width + x]`. A goal
  // from FloorMap.worldToTile is NOT clamped to the map, so an out-of-bounds goal
  // whose linear index aliases an in-bounds *reachable* tile (e.g. x = width + 1
  // wraps to column 1 of the next row) read a real distance and was returned as a
  // bogus "direct" hit. The caller then ran A* against that OOB tile, got [], and
  // abandoned the path instead of taking the ring fallback — a divergence from the
  // pre-refactor logic, where findTilePath rejected the OOB goal so the ring search
  // ran. The fix bounds-checks the read so OOB goals fall through to the ring.
  describe('reachable-goal resolution rejects out-of-bounds goals', () => {
    type GoalResolver = {
      computeReachableGoalTile(
        floorMap: FloorMap,
        startTile: TilePoint,
        goalTile: TilePoint,
        maxRadius?: number,
      ): TilePoint;
    };

    const resolveGoal = (floorMap: FloorMap, start: TilePoint, goal: TilePoint): TilePoint =>
      (new BehaviorTreeAI({ seed: 1 }) as unknown as GoalResolver).computeReachableGoalTile(
        floorMap,
        start,
        goal,
      );

    it('returns an in-bounds reachable goal unchanged (control)', () => {
      const floorMap = makeOpenRoom(16, 16);
      // (1,3) is interior floor and reachable from (3,3), so it resolves directly.
      // This also proves the tile the OOB case aliases is genuinely reachable.
      expect(resolveGoal(floorMap, { x: 3, y: 3 }, { x: 1, y: 3 })).toEqual({ x: 1, y: 3 });
    });

    it('does not return an out-of-bounds goal that aliases a reachable tile', () => {
      const floorMap = makeOpenRoom(16, 16);
      const { tileMap } = floorMap;
      const start: TilePoint = { x: 3, y: 3 };

      // (17,2) is out of bounds (x >= width = 16). Its linear index 2*16 + 17 = 49
      // aliases in-bounds interior tile (1,3) — reachable per the control above —
      // which made the unchecked dist[] read report a phantom "direct" hit.
      const oobGoal: TilePoint = { x: 17, y: 2 };
      expect(tileMap.inBounds(oobGoal.x, oobGoal.y)).toBe(false);
      expect((oobGoal.y * tileMap.width + oobGoal.x) % (tileMap.width * tileMap.height)).toBe(
        3 * tileMap.width + 1,
      );

      const resolved = resolveGoal(floorMap, start, oobGoal);

      // The fix takes the ring fallback: the resolved tile must be a real in-bounds
      // passable tile, never the out-of-bounds goal the caller cannot path to.
      expect(resolved).not.toEqual(oobGoal);
      expect(tileMap.inBounds(resolved.x, resolved.y)).toBe(true);
      expect(tileMap.isPassable(resolved.x, resolved.y)).toBe(true);
    });
  });

  // Regression guard: reset() is the provider's "start fresh" hook and clears the
  // analogous per-run caches (resolvedGoalCache, targetReachableCache). The BFS
  // refactor (PR #324) added the resolveGoalMemo + navEpoch/navSignature cache,
  // which must be cleared too — otherwise a reused provider whose new world's
  // (floor + blocked-door) signature collides with the previous one skips the
  // navEpoch bump and serves stale reachability from a different floor topology.
  describe('reset() restores the reachable-goal memo and navigation epoch', () => {
    type NavCacheState = {
      resolveGoalMemo: Map<string, TilePoint>;
      resolveGoalMemoEpoch: number;
      navEpoch: number;
      navSignature: string | null;
    };

    it('clears the memo and resets the nav signature/epoch to construction state', () => {
      const world = createTestWorld({ seed: 99 });
      world.floorMap = makeOpenRoom(16, 16);
      spawnPlayer(world, 112, 112); // tile (3,3)
      spawnGold(world, 400, 112, 3); // distant gold drives Collect path planning

      const ai = new BehaviorTreeAI({ seed: 99 });
      ai.poll(createInputState(), world);

      const state = ai as unknown as NavCacheState;
      // Precondition: the poll populated the nav cache (refreshed every poll, and
      // Collect plans a path through the memoised resolver), so reset() has real
      // state to clear.
      expect(state.navSignature).not.toBeNull();
      expect(state.navEpoch).toBeGreaterThan(0);
      expect(state.resolveGoalMemo.size).toBeGreaterThan(0);

      ai.reset();

      // Post-reset the nav cache must match a freshly-constructed provider.
      expect(state.resolveGoalMemo.size).toBe(0);
      expect(state.resolveGoalMemoEpoch).toBe(-1);
      expect(state.navEpoch).toBe(0);
      expect(state.navSignature).toBeNull();
    });
  });

  describe('harvestable gathering', () => {
    it('targets a nearby harvestable node when nothing else competes', () => {
      const world = createTestWorld({ seed: 7 });
      spawnPlayer(world, 0, 0);
      const node = spawnHarvestableNode(world, 6, 0, 0);

      const ai = new BehaviorTreeAI({ seed: 7 });
      ai.poll(createInputState(), world);

      const decision = ai.getDecision();
      expect(decision.state).toBe(AIState.COLLECT);
      expect(decision.targetEid).toBe(node);
      expect(decision.reason).toContain('harvest');
    });

    it('does not abandon a node while standing on it past the dwell window', () => {
      const world = createTestWorld({ seed: 7 });
      spawnPlayer(world, 0, 0);
      // Player parked exactly on the node: harvestSystem accrues progress while it
      // nets zero displacement. The dwell watchdog (180f) must read that as
      // progress and keep the target, not blacklist it.
      const node = spawnHarvestableNode(world, 0, 0, 0);

      const ai = new BehaviorTreeAI({ seed: 7 });
      const input = createInputState();
      for (let i = 0; i < 240; i++) {
        ai.poll(input, world);
      }

      const decision = ai.getDecision();
      expect(decision.state).toBe(AIState.COLLECT);
      expect(decision.targetEid).toBe(node);
    });

    it('prioritises engaging an enemy over harvesting', () => {
      const world = createTestWorld({ seed: 7 });
      spawnPlayer(world, 0, 0);
      spawnHarvestableNode(world, 6, 0, 0);
      spawnEnemy(world, 5, 0, 20);
      setActiveWeapon(world, getWeaponDef('sword')!);

      const ai = new BehaviorTreeAI({ seed: 7 });
      ai.poll(createInputState(), world);

      expect(ai.getDecision().state).toBe(AIState.ENGAGE);
    });
  });
});
