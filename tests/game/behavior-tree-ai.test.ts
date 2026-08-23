import { describe, expect, it } from 'vitest';
import { addComponent, query, removeEntity, set } from 'bitecs';
import {
  spawnBehaviorEnemy,
  spawnEnemy,
  spawnGold,
  spawnHarvestableNode,
  spawnNpc,
  spawnPlayer,
  spawnXpGem,
} from '../../src/core/helpers.js';
import { spawnDroppedItem } from '../../src/core/spawners/pickups.js';
import { spawnBossChestEntity } from '../../src/core/spawners/world-objects.js';
import { spawnEnemyProjectile, spawnAoeProjectile } from '../../src/core/spawners/projectiles.js';
import { FLOOR1_SPELL_BROKER_COST } from '../../src/shared/constants.js';
import { createInputState } from '../../src/shared/input.js';
import { GAME, TeamId } from '../../src/shared/constants.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import {
  BehaviorTreeAI,
  SAFE_ROOM_EGRESS_EXIT_HYSTERESIS_FRAMES,
  SAFE_ROOM_EGRESS_NO_PROGRESS_FRAMES,
  SAFE_ROOM_EGRESS_SUPPRESS_FRAMES,
} from '../../src/game/ai/bt-ai-provider.js';
import { runSimulationStep } from '../../src/game/ai/simulation-step.js';
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
import { unlockAchievement } from '../../src/game/systems/achievementSystem.js';
import {
  configureSettlementReturnRouting,
  getSettlementReturnIntent,
  updateSettlementReturnIntent,
} from '../../src/game/ai/settlement-return-router.js';
import {
  configureSpellBrokerPurchase,
  ensureSpellBrokerDecision,
  updateSpellBrokerIntent,
} from '../../src/game/ai/spell-broker-intent.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { makeDiagonalCornerMap } from '../helpers/map-fixtures.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import type { TilePoint } from '../../src/core/map/pathfinding.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { AI_TYPE, enemyAISystem } from '../../src/game/enemyAISystem.js';
import { isEnemyProjectileTelegraphActive } from '../../src/core/systems/enemyTelegraph.js';
import {
  AINpcInteractionAction,
  AIProgressSuppressionSource,
  AIPathingMode,
  AIState,
  type AIStateValue,
} from '../../src/game/ai/types.js';
import {
  CONTACT_RETREAT_EPISODE_GAP_FRAMES,
  CONTACT_RETREAT_PROGRESS_FRAMES,
  CONTACT_RETREAT_PROGRESS_FT,
  CONTACT_SAFE_ORBIT_FT,
  ENGAGE_GIVEUP_FRAMES,
  FLOOR2_HUNT_ENGAGE_FRAMES,
  FLOOR2_HUNT_NO_PROGRESS_FRAMES,
  FLOOR2_HUNT_RECOVERY_FRAMES,
  NPC_APPROACH_THREAT_NO_PROGRESS_FRAMES,
  RETREAT_DAMAGE_WINDOW_FRAMES,
  RETREAT_DAMAGE_WINDOW_MIN_DAMAGE,
  RETREAT_HYSTERESIS_MULT,
  RETREAT_OBJECTIVE_MEMORY_FRAMES,
  PROJECTILE_DODGE_AOE_BUFFER_FT,
  PROJECTILE_DODGE_CLEARANCE_FT,
  PROJECTILE_DODGE_VECTOR_SCALE,
  SAFE_LOOT_ENEMY_CLEARANCE_FT,
  LOOT_DETOUR_MAX_FT,
} from '../../src/game/ai/bt-ai-tuning.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';
import { FLOOR1_TUTORIAL_QUEST_ID } from '../../src/shared/quest-types.js';
import {
  FamilyMembership,
  AoeOnImpact,
  EnemyProjectile,
  Projectile,
} from '../../src/core/components.js';
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

function suppressProgressGoals(
  ai: BehaviorTreeAI,
  untilFrame: number = Number.MAX_SAFE_INTEGER,
): void {
  (
    ai as unknown as {
      progressGoalSuppressedUntilFrame: number;
    }
  ).progressGoalSuppressedUntilFrame = untilFrame;
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
    // Drop the player to 1% HP — below the minimum supported retreatThreshold
    // (KNOB_RANGES min = 0.05), so RETREAT triggers no matter how the knob is
    // tuned in the future.
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 1;

    // Pinned to LEGACY pathing: this test exercises the retreat-latch/ignore-set
    // mechanism specifically, which is orthogonal to the pathingMode A/B axis —
    // pinning keeps its geometry stable across future default-pathing promotions.
    const ai = new BehaviorTreeAI({ seed: 7, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
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

  it('does not drop an active melee retreat on the second tick for the same threat', () => {
    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 10, 0, 20);
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 1;
    setActiveWeapon(world, getWeaponDef('sword')!);

    const ai = new BehaviorTreeAI({ seed: 7, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
    const harness = ai as unknown as {
      retreating: boolean;
      retreatThreatEid: number | null;
      localThreatRecoveryEid: number | null;
    };

    ai.poll(createInputState(), world);
    expect(ai.getDecision().state).toBe(AIState.RETREAT);
    expect(harness.retreating).toBe(true);
    expect(harness.retreatThreatEid).toBe(enemy);
    expect(harness.localThreatRecoveryEid).toBe(enemy);

    world.frameCount += 1;
    ai.poll(createInputState(), world);
    expect(ai.getDecision().state).toBe(AIState.RETREAT);
    expect(harness.retreating).toBe(true);
    expect(harness.retreatThreatEid).toBe(enemy);
  });

  it('biases the retreat lane toward the remembered progression objective', () => {
    // Regression: the release sweep at 187bc7d6 lost Floor 1 on bow/35 and
    // throwing-knife/44 because retreat scored flee tiles purely by open space.
    // The escape lane ran backwards off the route, and the next progression poll
    // re-walked the same ground into the same pursuers.
    const world = createTestWorld({ seed: 90 });
    world.floorMap = makeOpenRoom(40, 40);
    spawnPlayer(world, 80, 80);
    const threat = { x: 60, y: 80 };
    spawnEnemy(world, threat.x, threat.y, 20);

    const ai = new BehaviorTreeAI({ seed: 90, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
    const harness = ai as unknown as {
      retreatObjectiveX: number | null;
      retreatObjectiveY: number | null;
      retreatObjectiveFrame: number;
      retreatObjectiveMap: unknown;
      config: { retreatDangerRadius: number };
      rememberRetreatObjective(world: GameWorld, x: number, y: number): void;
      getRetreatObjective(world: GameWorld): { x: number; y: number } | null;
      pickRetreatTarget(
        world: GameWorld,
        playerX: number,
        playerY: number,
        threat: { x: number; y: number },
        wedged: boolean,
      ): { x: number; y: number };
    };

    const objective = { x: 140, y: 30 };
    const unbiased = harness.pickRetreatTarget(world, 80, 80, threat, false);
    harness.rememberRetreatObjective(world, objective.x, objective.y);
    const biased = harness.pickRetreatTarget(world, 80, 80, threat, false);

    const distTo = (p: { x: number; y: number }) =>
      Math.hypot(objective.x - p.x, objective.y - p.y);
    expect(distTo(biased)).toBeLessThan(distTo(unbiased));

    // A remote objective in the opposite direction must not overwhelm the
    // primary enemy-clearance score. Route bias can trade at most the existing
    // retreat hysteresis band of safety.
    harness.rememberRetreatObjective(world, 20, 80);
    const opposed = harness.pickRetreatTarget(world, 80, 80, threat, false);
    const safety = (p: { x: number; y: number }) => Math.hypot(threat.x - p.x, threat.y - p.y);
    const maxSafetyTradeoff = harness.config.retreatDangerRadius * (RETREAT_HYSTERESIS_MULT - 1);
    expect(safety(opposed)).toBeGreaterThanOrEqual(safety(unbiased) - maxSafetyTradeoff);

    // The objective memory is dropped once stale so a retreat never chases an
    // objective the AI has since abandoned.
    world.frameCount = harness.retreatObjectiveFrame + RETREAT_OBJECTIVE_MEMORY_FRAMES + 1;
    expect(harness.getRetreatObjective(world)).toBeNull();

    // ...and once the AI is on a different floor map.
    world.frameCount = harness.retreatObjectiveFrame;
    expect(harness.getRetreatObjective(world)).not.toBeNull();
    world.floorMap = makeOpenRoom(40, 40);
    expect(harness.getRetreatObjective(world)).toBeNull();
  });

  it('breaks a cornered retreat out past the pack instead of into the wall', () => {
    // Regression: the release sweep at 3f733218 lost Floor 1 on
    // throwing-knife/25 because a retreat that wedged into a room corner kept
    // aiming at the naive away-from-threat fallback, which points INTO the
    // corner the player is already pressed against. Collision cancelled both
    // axes, so the runner stood at exactly one position for ~500 frames at full
    // throttle while contact damage took it from 67% HP to 0.
    const world = createTestWorld({ seed: 92 });
    const map = makeOpenRoom(40, 40);
    world.floorMap = map;
    // Inner corner tile (1,1) of a wall-bordered room: everything on the -x/-y
    // side is wall, so the whole away-from-the-swarm arc is unreachable.
    const corner = map.tileToWorld(1, 1);
    spawnPlayer(world, corner.x, corner.y);
    const threat = { x: corner.x + 12, y: corner.y + 12 };
    spawnEnemy(world, threat.x, threat.y, 20);

    const ai = new BehaviorTreeAI({ seed: 92, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
    const harness = ai as unknown as {
      pickRetreatTarget(
        world: GameWorld,
        playerX: number,
        playerY: number,
        threat: { x: number; y: number },
        wedged: boolean,
      ): { x: number; y: number };
    };

    const isPassableTarget = (p: { x: number; y: number }): boolean => {
      const tile = map.worldToTile(p.x, p.y);
      return map.tileMap.isPassable(tile.x, tile.y);
    };

    // Un-wedged (still travelling): unchanged behavior — the arc scan finds
    // nothing reachable in the corner and falls back to the away-vector, which
    // lies outside the room.
    const cornered = harness.pickRetreatTarget(world, corner.x, corner.y, threat, false);
    expect(isPassableTarget(cornered)).toBe(false);

    // Wedged: the breakout arc must produce a target the runner can actually
    // walk to, even though it means running past the threat.
    const breakout = harness.pickRetreatTarget(world, corner.x, corner.y, threat, true);
    expect(isPassableTarget(breakout)).toBe(true);
    expect(Math.hypot(breakout.x - corner.x, breakout.y - corner.y)).toBeGreaterThan(0);
  });

  it('retreats on sustained damage rate before the remaining-HP threshold trips', () => {
    // Regression: the release sweep at 187bc7d6 lost Floor 1 on baseball-bat/34
    // because the fixed remaining-HP retreat threshold (10%) only reacts to HP
    // left, never to damage RATE — a pinned melee runner bled 121 -> 21 HP in
    // 5.3s before retreat could trigger.
    const ai = new BehaviorTreeAI({ seed: 91 });
    const harness = ai as unknown as {
      bleedingOut: boolean;
      updateBleedOutRisk(frame: number, health: number): void;
      resetBleedOutRisk(): void;
    };
    // The provider samples health every poll, so feed a contiguous frame run.
    const bleed = (from: number, to: number, frames: number): void => {
      harness.resetBleedOutRisk();
      for (let frame = 0; frame <= frames; frame += 1) {
        harness.updateBleedOutRisk(frame, from + ((to - from) * frame) / frames);
      }
    };

    // A slow, survivable exchange: 12 HP per damage window with 100 HP left is
    // far outside the bleed-out horizon.
    bleed(124, 100, 2 * RETREAT_DAMAGE_WINDOW_FRAMES);
    expect(harness.bleedingOut).toBe(false);

    // The same window at a lethal rate: 60 HP per window with 40 HP left is
    // well inside it.
    bleed(160, 40, 2 * RETREAT_DAMAGE_WINDOW_FRAMES);
    expect(harness.bleedingOut).toBe(true);

    // Chip damage under the minimum-damage floor never trips the trigger, so a
    // single graze at low HP cannot masquerade as a sustained exchange.
    bleed(RETREAT_DAMAGE_WINDOW_MIN_DAMAGE - 7, 2, 2 * RETREAT_DAMAGE_WINDOW_FRAMES);
    expect(harness.bleedingOut).toBe(false);

    // Health gains (a Constitution level-up) clear the flag rather than
    // extrapolating a negative damage rate.
    bleed(160, 40, 2 * RETREAT_DAMAGE_WINDOW_FRAMES);
    expect(harness.bleedingOut).toBe(true);
    for (let frame = 1; frame <= RETREAT_DAMAGE_WINDOW_FRAMES; frame += 1) {
      harness.updateBleedOutRisk(2 * RETREAT_DAMAGE_WINDOW_FRAMES + frame, 40 + frame);
    }
    expect(harness.bleedingOut).toBe(false);
  });

  it('enters RETREAT while bleeding out even above the remaining-HP threshold', () => {
    const world = createTestWorld({ seed: 92 });
    world.floorMap = makeOpenRoom(40, 40);
    const player = spawnPlayer(world, 80, 80);
    // Inside retreatDangerRadius (20ft) so the threat gate is satisfied.
    spawnEnemy(world, 90, 80, 20);
    world.stores.health.max[player] = 100;
    // 60% HP — far above the 10% retreatThreshold, so only the damage-rate
    // trigger can produce RETREAT here.
    world.stores.health.current[player] = 60;

    const ai = new BehaviorTreeAI({ seed: 92, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
    const harness = ai as unknown as { bleedingOut: boolean };

    ai.poll(createInputState(), world);
    expect(harness.bleedingOut).toBe(false);
    expect(ai.getDecision().state).not.toBe(AIState.RETREAT);

    // Sustained lethal chip across the damage window, holding HP well above the
    // 10% remaining-HP retreatThreshold the whole time.
    const frames = RETREAT_DAMAGE_WINDOW_FRAMES;
    for (let frame = 1; frame <= frames; frame += 1) {
      world.frameCount += 1;
      world.stores.health.current[player] = 60 - (40 * frame) / frames;
      ai.poll(createInputState(), world);
    }
    expect(world.stores.health.current[player]).toBeGreaterThan(10);
    expect(harness.bleedingOut).toBe(true);
    expect(ai.getDecision().state).toBe(AIState.RETREAT);
  });

  it('retreats from a critical-health point-blank hit even against a long-range attacker', () => {
    // Regression: the release sweep at fb35e05 lost Floor 1 on
    // throwing-knife/39 because the stair boss (attackRange=280, far above
    // retreatEscapeRadius=30) bailed Retreat out unconditionally once it
    // qualified as a "shooter", even after it had already closed to melee
    // contact — leaving no escape behavior at all at critical health.
    const world = createTestWorld({ seed: 39 });
    const player = spawnPlayer(world, 0, 0);
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 8; // below the 10% retreatThreshold
    // A boss-like enemy with a large attackRange (a projectile/ranged stat)
    // that has already closed to point-blank contact distance.
    spawnBehaviorEnemy(world, 3, 0, 400, AI_TYPE.CHASE, 5, 300, 280);

    const ai = new BehaviorTreeAI({ seed: 39, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
    ai.poll(createInputState(), world);

    expect(ai.getDecision().state).toBe(AIState.RETREAT);
  });

  it('still defers to Engage for a long-range attacker still outside contact distance', () => {
    // Same critical-health/long-attackRange setup as above, but the threat has
    // NOT yet closed to melee contact (distance > CONTACT_SAFE_ORBIT_FT), so
    // the "let Engage's kite/strafe handle a real shooter" bail-out must still
    // apply — this fix only narrows the bail-out, it does not remove it.
    const world = createTestWorld({ seed: 39 });
    const player = spawnPlayer(world, 0, 0);
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 8;
    expect(CONTACT_SAFE_ORBIT_FT).toBeLessThan(10);
    spawnBehaviorEnemy(world, 10, 0, 400, AI_TYPE.CHASE, 5, 300, 280);

    const ai = new BehaviorTreeAI({ seed: 39, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
    ai.poll(createInputState(), world);

    expect(ai.getDecision().state).not.toBe(AIState.RETREAT);
  });

  it('releases the contact-range retreat once it provably cannot move the player', () => {
    // Regression: the release sweep at 3f733218 lost Floor 1 on pistol/33
    // because the contact carve-out above kept RETREAT active while the player
    // was cornered — pickRetreatTarget found no reachable escape tile, the AI
    // stood on one spot for ~250 frames, and contact damage took it from 110 HP
    // to 12 HP. A retreat that cannot move must hand the fight back to Engage.
    const world = createTestWorld({ seed: 33 });
    const player = spawnPlayer(world, 0, 0);
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 8;
    const boss = spawnBehaviorEnemy(world, 3, 0, 400, AI_TYPE.CHASE, 5, 300, 280);

    const ai = new BehaviorTreeAI({ seed: 33, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
    ai.poll(createInputState(), world);
    expect(ai.getDecision().state).toBe(AIState.RETREAT);

    // Pin the player: hold its position (and the boss at contact range) fixed
    // across the whole futility window, exactly as the cornered sweep run did.
    for (let frame = 1; frame <= CONTACT_RETREAT_PROGRESS_FRAMES; frame += 1) {
      world.frameCount += 1;
      world.stores.position.x[player] = 0;
      world.stores.position.y[player] = 0;
      world.stores.position.x[boss] = 3;
      world.stores.position.y[boss] = 0;
      ai.poll(createInputState(), world);
    }

    expect(ai.getDecision().state).not.toBe(AIState.RETREAT);
  });

  it('keeps the contact-range retreat while it is actually creating separation', () => {
    // Counterpart to the pinned case: the futility guard must only fire when
    // the retreat produces no displacement. A kite that is genuinely moving
    // keeps RETREAT (the throwing-knife/39 fix), so the guard cannot silently
    // revert that regression fix.
    const world = createTestWorld({ seed: 33 });
    const player = spawnPlayer(world, 0, 0);
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 8;
    const boss = spawnBehaviorEnemy(world, 3, 0, 400, AI_TYPE.CHASE, 5, 300, 280);

    const ai = new BehaviorTreeAI({ seed: 33, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
    ai.poll(createInputState(), world);
    expect(ai.getDecision().state).toBe(AIState.RETREAT);

    // The kite moves a full progress step per window while the boss stays glued
    // at contact range — this is a retreat that is working, not a pin.
    const step = CONTACT_RETREAT_PROGRESS_FT / CONTACT_RETREAT_PROGRESS_FRAMES;
    for (let frame = 1; frame <= 2 * CONTACT_RETREAT_PROGRESS_FRAMES; frame += 1) {
      world.frameCount += 1;
      const y = frame * step;
      world.stores.position.x[player] = 0;
      world.stores.position.y[player] = y;
      world.stores.position.x[boss] = 3;
      world.stores.position.y[boss] = y;
      ai.poll(createInputState(), world);
    }

    expect(ai.getDecision().state).toBe(AIState.RETREAT);
    expect(CONTACT_RETREAT_EPISODE_GAP_FRAMES).toBeGreaterThan(CONTACT_RETREAT_PROGRESS_FRAMES);
  });

  it('does not declare the player pinned after a brief out-of-contact interruption', () => {
    // The futility window must only accumulate carve-out polls that actually
    // ran. If a short gap where the threat backs out of contact (so the
    // carve-out does not fire) were counted as elapsed progress time, a single
    // fresh poll right after re-contact could be declared "pinned" immediately
    // even though Retreat only had one real frame to try to move the player.
    const world = createTestWorld({ seed: 33 });
    const player = spawnPlayer(world, 0, 0);
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 8;
    const boss = spawnBehaviorEnemy(world, 3, 0, 400, AI_TYPE.CHASE, 5, 300, 280);

    const ai = new BehaviorTreeAI({ seed: 33, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
    ai.poll(createInputState(), world);
    expect(ai.getDecision().state).toBe(AIState.RETREAT);

    // One pinned (no-displacement) poll in contact starts the futility window.
    world.frameCount += 1;
    world.stores.position.x[boss] = 3;
    world.stores.position.y[boss] = 0;
    ai.poll(createInputState(), world);

    // A brief gap, well under CONTACT_RETREAT_EPISODE_GAP_FRAMES, where the
    // threat backs out of melee contact so the carve-out itself does not fire.
    const gapFrames = CONTACT_RETREAT_PROGRESS_FRAMES - 1;
    expect(gapFrames).toBeLessThan(CONTACT_RETREAT_EPISODE_GAP_FRAMES);
    for (let frame = 0; frame < gapFrames; frame += 1) {
      world.frameCount += 1;
      world.stores.position.x[boss] = CONTACT_SAFE_ORBIT_FT + 5;
      world.stores.position.y[boss] = 0;
      ai.poll(createInputState(), world);
    }

    // Re-contact: the episode continues (gap under the threshold), but only
    // one active carve-out poll has actually elapsed, so this must not
    // immediately declare the player pinned.
    world.frameCount += 1;
    world.stores.position.x[boss] = 3;
    world.stores.position.y[boss] = 0;
    ai.poll(createInputState(), world);
    expect(ai.getDecision().state).toBe(AIState.RETREAT);
  });

  it('re-opens the pinned verdict once the player is moved off the pinned spot', () => {
    // The pin is positional, so the latch must not outlive the position that
    // produced it: if Engage drags the player off that spot while the fight
    // stays in continuous contact (so the episode never gaps), Retreat has to
    // become eligible again rather than staying suppressed for the whole floor.
    const world = createTestWorld({ seed: 33 });
    const player = spawnPlayer(world, 0, 0);
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 8;
    const boss = spawnBehaviorEnemy(world, 3, 0, 400, AI_TYPE.CHASE, 5, 300, 280);

    const ai = new BehaviorTreeAI({ seed: 33, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
    const pin = (): void => {
      for (let frame = 1; frame <= CONTACT_RETREAT_PROGRESS_FRAMES; frame += 1) {
        world.frameCount += 1;
        ai.poll(createInputState(), world);
      }
    };

    ai.poll(createInputState(), world);
    pin();
    expect(ai.getDecision().state).not.toBe(AIState.RETREAT);

    // Moved a full progress step away from the pinned spot, still in contact.
    world.frameCount += 1;
    world.stores.position.x[player] = CONTACT_RETREAT_PROGRESS_FT;
    world.stores.position.y[player] = 0;
    world.stores.position.x[boss] = CONTACT_RETREAT_PROGRESS_FT + 3;
    world.stores.position.y[boss] = 0;
    ai.poll(createInputState(), world);
    expect(ai.getDecision().state).toBe(AIState.RETREAT);
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

  it('keeps focused Floor 2 melee hunts synchronized to the weapon cadence', () => {
    const bat = getWeaponDef('baseball-bat')!;
    const targetX = 3.75;
    const makeFocusedDecision = (elapsedMs: number) => {
      const world = createTestWorld({ seed: 7, floor: 2 });
      const player = spawnPlayer(world, 0, 0);
      const enemy = spawnEnemy(world, targetX, 0, 40);
      world.elapsedMs = 5000;
      setActiveWeapon(world, bat);
      world.elapsedMs = elapsedMs;
      const ai = new BehaviorTreeAI({ seed: 7 });
      const harness = ai as unknown as {
        findProgressObjective(
          currentWorld: GameWorld,
          playerEid: number,
          playerX: number,
          playerY: number,
        ): {
          eid: number;
          x: number;
          y: number;
          distance: number;
          reason: string;
          npcInteraction: null;
        } | null;
      };
      harness.findProgressObjective = (_currentWorld, playerEid, playerX, playerY) => {
        expect(playerEid).toBe(player);
        return {
          eid: enemy,
          x: targetX,
          y: 0,
          distance: Math.hypot(targetX - playerX, -playerY),
          reason: 'Focused Floor 2 hunt target',
          npcInteraction: null,
        };
      };
      ai.poll(createInputState(), world);
      return ai.getDecision();
    };

    const readyDecision = makeFocusedDecision(5000);
    const cooldownDecision = makeFocusedDecision(5000 - bat.cooldownMs);
    const readyDistance = Math.hypot(readyDecision.targetX! - targetX, readyDecision.targetY!);
    const cooldownDistance = Math.hypot(
      cooldownDecision.targetX! - targetX,
      cooldownDecision.targetY!,
    );

    expect(readyDecision.state).toBe(AIState.ENGAGE);
    expect(cooldownDecision.state).toBe(AIState.ENGAGE);
    expect(readyDecision.reason).toContain('Focused Floor 2 hunt target');
    expect(readyDecision.reason).toContain('Kiting');
    expect(cooldownDecision.reason).toContain('Kiting');
    expect(readyDecision.targetX).not.toBe(targetX);
    expect(cooldownDistance).toBeGreaterThan(readyDistance + 0.5);
  });

  it('keeps focused Floor 2 melee hunts committed while outside strike range', () => {
    const world = createTestWorld({ seed: 7, floor: 2 });
    const player = spawnPlayer(world, 0, 0);
    const enemy = spawnEnemy(world, 20, 0, 40);
    setActiveWeapon(world, getWeaponDef('baseball-bat')!);
    const ai = new BehaviorTreeAI({ seed: 7 });
    const harness = ai as unknown as {
      findProgressObjective(
        currentWorld: GameWorld,
        playerEid: number,
        playerX: number,
        playerY: number,
      ): {
        eid: number;
        x: number;
        y: number;
        distance: number;
        reason: string;
        npcInteraction: null;
      } | null;
    };
    harness.findProgressObjective = (_currentWorld, playerEid, playerX, playerY) => {
      expect(playerEid).toBe(player);
      return {
        eid: enemy,
        x: 20,
        y: 0,
        distance: Math.hypot(20 - playerX, -playerY),
        reason: 'Focused Floor 2 hunt target',
        npcInteraction: null,
      };
    };

    ai.poll(createInputState(), world);
    const decision = ai.getDecision();

    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.reason).toContain('Focused Floor 2 hunt target');
    expect(decision.reason).toContain('Closing to melee range');
    expect(decision.targetX).toBeGreaterThan(0);
    expect(decision.targetX).toBeLessThan(20);
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
    it('detours toward an on-path dropped item, which the sweep never targets', () => {
      const s = pollQuestNavHeading(42);
      // The loot sweep only claims XP and gold, so a dropped item on the forward
      // path is the regime the tactical travel bend still owns.
      spawnDroppedItem(s.world, s.px + s.ux * 10, s.py + s.uy * 10, 1);

      s.ai.poll(s.input, s.world);

      // Track A stays on the quest objective (Progress outranks Collect), so the
      // item is ignored by Track A. Tactical travel owns the loot bend, keeping
      // the legacy Track-B pull at zero so the same pickup is not double-counted.
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
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 8;

    const farThreat = spawnEnemy(world, 18, 10, 20);

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

    // Genuinely leaving the safe room (not a flicker): the egress commitment
    // must survive the *first* poll after the transition too, since a single
    // false frame is indistinguishable from a doorway flicker at the moment it
    // happens (see "holds a committed egress waypoint through a
    // playerInSafeRoom flicker" below for the pure-flicker case). It should
    // keep the same latched waypoint, not instantly jump to Hunt.
    world.playerInSafeRoom = false;
    world.stores.position.x[player] = 20;
    world.stores.position.y[player] = 10;

    ai.poll(input, world);
    const justExited = ai.getDecision();
    expect(justExited.reason).toContain('Leaving safe room');
    expect(justExited.targetX).toBeCloseTo(firstTargetX, 6);
    expect(justExited.targetY).toBeCloseTo(firstTargetY, 6);

    // Once genuinely outside for SAFE_ROOM_EGRESS_EXIT_HYSTERESIS_FRAMES
    // consecutive frames, the egress latch itself releases the commitment
    // (bounded — not "until arrival at the far overshoot waypoint"), and Hunt
    // picks up the same distant threat.
    let postExit = ai.getDecision();
    for (let i = 0; i < SAFE_ROOM_EGRESS_EXIT_HYSTERESIS_FRAMES + 2; i += 1) {
      ai.poll(input, world);
      postExit = ai.getDecision();
    }
    expect(postExit.state).toBe(AIState.ENGAGE);
    expect(postExit.targetEid).toBe(farThreat);
    expect(postExit.reason).toContain('Hunting enemy');
  });

  it('holds a committed egress waypoint through a playerInSafeRoom flicker (does not livelock at the doorway)', () => {
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

    // Far threat (outside engage range) so LeaveSafeRoom, not Engage, drives.
    spawnEnemy(world, 84, 10, 20);

    const ai = new BehaviorTreeAI({ seed: 31 });
    const input = createInputState();
    ai.poll(input, world);

    const initial = ai.getDecision();
    expect(initial.reason).toContain('Leaving safe room');
    expect(initial.targetX).not.toBeNull();
    expect(initial.targetY).not.toBeNull();
    const { targetX, targetY } = initial;
    if (targetX === null || targetY === null) {
      throw new Error('LeaveSafeRoom should commit both egress coordinates');
    }

    // Simulate the doorway flicker directly at the sword@14 root cause: the
    // coarse single-tile boundary flag flips false then true again on
    // consecutive polls, with the player's position essentially unchanged
    // (straddling the threshold). Pre-fix, the first false poll instantly
    // dropped LeaveSafeRoom to a lower-priority behavior (Hunt), which then
    // pulled the player back across the boundary every alternate frame
    // forever — a frame-perfect livelock with zero net progress. Post-fix, the
    // already-committed waypoint must survive every one of these flips.
    for (let i = 0; i < 6; i += 1) {
      world.playerInSafeRoom = i % 2 === 0 ? false : true;
      ai.poll(input, world);
      const decision = ai.getDecision();
      expect(decision.reason).toContain('Leaving safe room');
      expect(decision.targetX).toBeCloseTo(targetX, 6);
      expect(decision.targetY).toBeCloseTo(targetY, 6);
    }
  });

  it('preserves the safe-room egress suppress cooldown across an outside poll', () => {
    const world = createTestWorld({ seed: 32 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    meetTutorialGoon(world);
    world.playerLevel.level = 0;
    world.floorMap = makeOpenRoom(40, 20);
    world.stores.position.x[player] = 14;
    world.stores.position.y[player] = 10;
    world.playerInSafeRoom = true;

    spawnEnemy(world, 84, 10, 20);

    const ai = new BehaviorTreeAI({ seed: 32 });
    const input = createInputState();
    ai.poll(input, world);
    expect(ai.getDecision().reason).toContain('Leaving safe room');

    for (let i = 0; i < SAFE_ROOM_EGRESS_NO_PROGRESS_FRAMES + 1; i += 1) {
      ai.poll(input, world);
    }

    world.playerInSafeRoom = false;
    ai.poll(input, world);
    expect(ai.getDecision().reason).not.toContain('Leaving safe room');

    world.playerInSafeRoom = true;
    for (let i = 0; i < SAFE_ROOM_EGRESS_SUPPRESS_FRAMES; i += 1) {
      ai.poll(input, world);
      expect(ai.getDecision().reason).not.toContain('Leaving safe room');
    }

    ai.poll(input, world);
    expect(ai.getDecision().reason).toContain('Leaving safe room');
  });

  it('clears the safe-room egress suppress cooldown on reset', () => {
    const world = createTestWorld({ seed: 33 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    meetTutorialGoon(world);
    world.playerLevel.level = 0;
    world.floorMap = makeOpenRoom(40, 20);
    world.stores.position.x[player] = 14;
    world.stores.position.y[player] = 10;
    world.playerInSafeRoom = true;

    spawnEnemy(world, 84, 10, 20);

    const ai = new BehaviorTreeAI({ seed: 33 });
    const input = createInputState();
    ai.poll(input, world);
    expect(ai.getDecision().reason).toContain('Leaving safe room');

    for (let i = 0; i < SAFE_ROOM_EGRESS_NO_PROGRESS_FRAMES + 1; i += 1) {
      ai.poll(input, world);
    }

    world.playerInSafeRoom = false;
    ai.poll(input, world);
    world.playerInSafeRoom = true;

    ai.reset();
    ai.poll(input, world);

    expect(ai.getDecision().reason).toContain('Leaving safe room');
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
    suppressProgressGoals(unlockedButInactiveAi);
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

  it('does not navigate to a sealed (unreachable) boss den while progress is suppressed', () => {
    // Regression: when progress is suppressed and the boss den is sealed behind
    // a wall, findNearestFloor2Boss falls back to the nearest candidate regardless
    // of reachability.  createFloor2BossProgressTarget then builds an eid:-1
    // EXPLORE goal that the watchdog immediately re-selects after the no-path
    // clear, perpetuating the clear/reselect loop.  The guard must return null
    // when suppressed and the boss is not reachable.
    const world = createTestWorld({ seed: 64, floor: 2 });
    // Wall at tile x=14 (feet x=56) splits the map: player on the left, boss on the right.
    world.floorMap = makeSealedRoom(40, 20, 14);
    // spawnPlayer is required for the AI to have a valid subject; the eid is not asserted.
    spawnPlayer(world, 10, 10);
    const familyId = asFamilyId('imps');
    const bossEid = spawnEnemy(world, 66, 10, 100);
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
    world.goalFlags.set(denUnlockGoalId(familyId), true);

    const ai = new BehaviorTreeAI({ seed: 64 });
    suppressProgressGoals(ai);
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    // When suppressed, the unreachable sealed boss must not become an EXPLORE
    // target — it would immediately re-create the same fixed goal the watchdog
    // just paused, keeping the no-path clear/reselect loop alive.
    expect(decision.targetEid).not.toBe(bossEid);
    expect(decision.reason).not.toContain('boss');
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

  it('keeps Floor 2 family enemy progress available while fixed goals are suppressed', () => {
    const world = createTestWorld({ seed: 61, floor: 2 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor2Scenario(world, player);
    world.goalFlags.set(FLOOR2_SETTLEMENT_FOUND_GOAL_ID, true);
    world.goalFlags.set(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID, true);
    const familyId = world.floorExtendedState!.familyState!.presentFamilies[0]!;
    const familyIndex = 0;
    world.floorMap = makeOpenRoom(40, 20);
    (
      world.floorMap as unknown as {
        territoryZones: Array<{
          familyIndex: number;
          centerX: number;
          centerY: number;
          radius: number;
        }>;
      }
    ).territoryZones = [{ familyIndex, centerX: 10, centerY: 10, radius: 8 }];
    const playerPos = world.floorMap.tileToWorld(10, 10);
    world.stores.position.x[player] = playerPos.x;
    world.stores.position.y[player] = playerPos.y;
    const familyEnemy = spawnEnemy(world, playerPos.x + 8, playerPos.y, 20);
    addComponent(world.ecs, familyEnemy, FamilyMembership);
    world.stores.familyMembership.familyId[familyEnemy] = familyIndex;
    world.stores.familyMembership.isBoss[familyEnemy] = 0;
    const quest = world.questLog.get(`floor2-den-${familyId}-unlock`);
    expect(quest?.status).toBe('active');

    const target = (
      new BehaviorTreeAI({ seed: 61 }) as unknown as {
        findFloor2QuestProgressTarget(
          world: GameWorld,
          playerEid: number,
          playerX: number,
          playerY: number,
          activeQuest: NonNullable<typeof quest>,
          progressSuppressed: boolean,
        ): { eid: number } | null;
      }
    ).findFloor2QuestProgressTarget(world, player, playerPos.x, playerPos.y, quest!, true);

    expect(target?.eid).toBe(familyEnemy);
  });

  it('does not flip the Floor 2 hunt objective target when parked on the zone boundary (2026-08-21 wiggle fix)', () => {
    // Regression: seed 42 Floor 2 — `isWorldPositionInFloor2TerritoryZone` is a
    // plain tile-radius circle check with no hysteresis. A player parked
    // essentially on the boundary flipped `playerInTerritory` true/false every
    // single poll, which flipped the ENGAGE-vs-patrol decision every frame —
    // an unrecoverable ping-pong that manifested as a 36s wiggle episode.
    // `resolveFloor2HuntTerritoryMembership` fixes this with a Schmitt
    // trigger: once latched inside/outside, membership only flips after
    // crossing `FLOOR2_TERRITORY_HYSTERESIS_TILES` tiles past the plain
    // radius, not right at it. Exercised here through the real objective
    // callsite (`findFloor2QuestProgressTarget`), alternating the player
    // between positions just inside/outside the OLD plain-radius boundary —
    // a plain radius check (or a call that bypassed the hysteresis entirely)
    // would flip the selected target on every one of these polls.
    const world = createTestWorld({ seed: 42, floor: 2 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor2Scenario(world, player);
    world.goalFlags.set(FLOOR2_SETTLEMENT_FOUND_GOAL_ID, true);
    world.goalFlags.set(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID, true);
    const familyId = world.floorExtendedState!.familyState!.presentFamilies[0]!;
    const familyIndex = 0;
    world.floorMap = makeOpenRoom(60, 40);
    (
      world.floorMap as unknown as {
        territoryZones: Array<{
          familyIndex: number;
          centerX: number;
          centerY: number;
          radius: number;
        }>;
      }
    ).territoryZones = [{ familyIndex, centerX: 20, centerY: 20, radius: 10 }];
    // A non-family enemy sits at the territory center. It is found only by the
    // territory-scoped clearing branch, so this test continues to exercise the
    // membership latch independently from the family-target chase behavior.
    const centerPos = world.floorMap.tileToWorld(20, 20);
    const territoryEnemy = spawnEnemy(world, centerPos.x, centerPos.y, 20);
    const quest = world.questLog.get(`floor2-den-${familyId}-unlock`);
    expect(quest?.status).toBe('active');

    const ai = new BehaviorTreeAI({ seed: 42 }) as unknown as {
      findFloor2QuestProgressTarget(
        world: GameWorld,
        playerEid: number,
        playerX: number,
        playerY: number,
        activeQuest: NonNullable<typeof quest>,
        progressSuppressed: boolean,
      ): { eid: number } | null;
    };
    const floorMap = world.floorMap;
    const pollAt = (tx: number, ty: number): { eid: number } | null => {
      const pos = floorMap.tileToWorld(tx, ty);
      return ai.findFloor2QuestProgressTarget(world, player, pos.x, pos.y, quest!, true);
    };

    // Latch inside first (well within the plain radius).
    expect(pollAt(20, 20)?.eid).toBe(territoryEnemy);

    // Alternate between tile distance 9 (just inside the OLD plain radius of
    // 10) and tile distance 11 (just outside it, but still within the
    // hysteresis band of radius + 3 = 13) for several consecutive polls.
    // Under the OLD plain-circle check this alternation would flip
    // `playerInTerritory` — and therefore the selected target — every poll.
    for (let i = 0; i < 5; i += 1) {
      expect(pollAt(29, 20)?.eid).toBe(territoryEnemy); // tile dist 9
      expect(pollAt(31, 20)?.eid).toBe(territoryEnemy); // tile dist 11
    }

    // Push well past the hysteresis band (tile dist 20, past radius +
    // HYSTERESIS = 13). Membership is now genuinely false, so the
    // territory-scoped clearing target disappears. Because progress is
    // suppressed, patrol fallback is also intentionally unavailable.
    expect(pollAt(40, 20)).toBeNull();
  });

  it('does not drop the last family member sitting outside its own territory zone (2026-08-23 last-family-hunt-pacing fix)', () => {
    // Regression: release-sweep floor2/floor1-chain timeouts on the LAST
    // remaining family were caused by a self-defeating feedback loop, not by
    // slow combat. `familyEnemy` (the den-unlock kill-quota target) used to
    // be gated on `playerInTerritory && territoryZone`, unlike `territoryEnemy`
    // (the in-zone patrol/clear target). On maps where a live family member
    // roams outside the authored territory circle, chasing it pulled the
    // player out of the zone, which flipped the Schmitt-trigger zone latch to
    // false, which dropped `familyEnemy` on the very next poll and fell back
    // to the in-zone patrol point — pulling the player back inside, re-
    // latching true, and re-acquiring the same distant enemy. That produced a
    // stable ~1s two-state oscillation (confirmed via frame-exact telemetry
    // on release-sweep seed 1: distance to target dropping for ~58 frames,
    // then jumping back up over the next ~60) that made zero net progress on
    // the den-unlock quota and could burn the remainder of Floor 2's collapse
    // timer without ever unlocking the last den. The fix un-gates the
    // `familyEnemy` search from zone membership (kept bounded only by
    // FLOOR2_HUNT_CHASE_RADIUS_FT, same as before) since the trash-kill quota
    // itself is not territory-scoped (`floor2Scenario.ts` counts a kill
    // anywhere on the map).
    const world = createTestWorld({ seed: 1, floor: 2 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor2Scenario(world, player);
    world.goalFlags.set(FLOOR2_SETTLEMENT_FOUND_GOAL_ID, true);
    world.goalFlags.set(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID, true);
    const familyId = world.floorExtendedState!.familyState!.presentFamilies[0]!;
    const familyIndex = 0;
    world.floorMap = makeOpenRoom(60, 40);
    (
      world.floorMap as unknown as {
        territoryZones: Array<{
          familyIndex: number;
          centerX: number;
          centerY: number;
          radius: number;
        }>;
      }
    ).territoryZones = [{ familyIndex, centerX: 20, centerY: 20, radius: 6 }];
    // Place the sole remaining family member well outside the territory
    // circle (tile dist ~19 from center vs. radius 6 + hysteresis 3 = 9), but
    // still within FLOOR2_HUNT_CHASE_RADIUS_FT (120ft = 30 tiles).
    const enemyPos = world.floorMap.tileToWorld(39, 20);
    const familyEnemy = spawnEnemy(world, enemyPos.x, enemyPos.y, 20);
    addComponent(world.ecs, familyEnemy, FamilyMembership);
    world.stores.familyMembership.familyId[familyEnemy] = familyIndex;
    world.stores.familyMembership.isBoss[familyEnemy] = 0;
    const quest = world.questLog.get(`floor2-den-${familyId}-unlock`);
    expect(quest?.status).toBe('active');

    const ai = new BehaviorTreeAI({ seed: 1 }) as unknown as {
      findFloor2QuestProgressTarget(
        world: GameWorld,
        playerEid: number,
        playerX: number,
        playerY: number,
        activeQuest: NonNullable<typeof quest>,
        progressSuppressed: boolean,
      ): { eid: number } | null;
    };
    const floorMap = world.floorMap;
    const pollAt = (tx: number, ty: number): { eid: number } | null => {
      const pos = floorMap.tileToWorld(tx, ty);
      return ai.findFloor2QuestProgressTarget(world, player, pos.x, pos.y, quest!, true);
    };

    // Simulate the old feedback loop's two poles: the player oscillating
    // between "inside the zone, chasing back toward it" (tile 20,20, the
    // in-zone patrol point the old code fell back to) and "closing the
    // distance on the actual family target" (progressively closer to tile
    // 39,20, mirroring the real chase). At every single one of these polls —
    // including every "inside the zone" pole — the family enemy must remain
    // the selected target; it must never be dropped in favor of a null/patrol
    // fallback just because the player is momentarily back inside the zone.
    const playerTrack: Array<[number, number]> = [
      [20, 20], // deep inside zone (old code's patrol-fallback pole)
      [30, 20], // outside zone, closing on the enemy
      [20, 20], // pulled back inside zone (old latch would flip true here)
      [34, 20], // outside zone again, closer still
      [20, 20],
      [38, 20], // nearly on top of the enemy
    ];
    for (const [tx, ty] of playerTrack) {
      expect(pollAt(tx, ty)?.eid).toBe(familyEnemy);
    }
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
    suppressProgressGoals(ai);

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
    suppressProgressGoals(ai);

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

  it.each([
    { health: 40, expectedState: AIState.ENGAGE, behavior: 'expands when wounded' },
    { health: 80, expectedState: AIState.EXPLORE, behavior: 'keeps the 8 ft cap when healthy' },
  ])('$behavior for melee NPC-approach threat clearing', ({ health, expectedState }) => {
    const { world, player, enemies } = setupNpcApproachThreat('baseball-bat');
    world.stores.health.current[player] = health;
    world.stores.health.max[player] = 100;
    world.stores.position.x[enemies[0]!] = 24;
    world.stores.position.y[enemies[0]!] = 14;
    world.stores.position.x[enemies[1]!] = 25;
    world.stores.position.y[enemies[1]!] = 15;
    const ai = new BehaviorTreeAI({ seed: 12 });

    ai.poll(createInputState(), world);

    expect(ai.getDecision().state).toBe(expectedState);
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

  it('clears nearby NPC-approach threats for wounded projectile users', () => {
    const { world, player } = setupNpcApproachThreat('throwing-knife');
    world.stores.health.current[player] = 20;
    world.stores.health.max[player] = 100;
    const ai = new BehaviorTreeAI({ seed: 12 });

    ai.poll(createInputState(), world);

    expect(ai.getDecision().state).toBe(AIState.ENGAGE);
    expect(ai.getDecision().reason).toContain('Clearing nearby threat before NPC interaction');
  });

  it.each(['bow', 'fireball'])(
    'clears nearby threats before long NPC approach paths when a wounded %s user routes to an NPC',
    (weaponId) => {
      const { world, player, enemies } = setupNpcApproachThreat(weaponId);
      world.stores.health.current[player] = 120;
      world.stores.health.max[player] = 240;
      const ai = new BehaviorTreeAI({ seed: 12 });
      ai.poll(createInputState(), world);

      const decision = ai.getDecision();
      expect(decision.state).toBe(AIState.ENGAGE);
      expect(enemies).toContain(decision.targetEid);
      expect(decision.reason).toContain('Clearing nearby threat before NPC interaction');
    },
  );

  it('resolves the retreat-triggering threat before resuming remote progression', () => {
    const { world, player, enemies, shopkeeperNpcEid } = setupNpcApproachThreat('throwing-knife');
    world.stores.health.current[player] = 8;
    world.stores.health.max[player] = 100;
    const ai = new BehaviorTreeAI({ seed: 12 });

    ai.poll(createInputState(), world);
    expect(ai.getDecision().state).toBe(AIState.RETREAT);

    const retreatThreatEid = (ai as unknown as { retreatThreatEid: number | null })
      .retreatThreatEid;
    expect(retreatThreatEid).not.toBeNull();
    for (const [index, enemy] of enemies.entries()) {
      world.stores.position.x[enemy] = 46 + index * 2;
      world.stores.position.y[enemy] = 14;
    }

    ai.poll(createInputState(), world);
    expect(ai.getDecision()).toMatchObject({
      state: AIState.ENGAGE,
      targetEid: retreatThreatEid,
    });
    expect(ai.getDecision().reason).toContain('Resolving retreat threat before progression');

    world.stores.health.current[retreatThreatEid!] = 0;
    ai.poll(createInputState(), world);
    expect(ai.getDecision()).toMatchObject({
      state: AIState.EXPLORE,
      targetEid: shopkeeperNpcEid,
    });
  });

  it('does not let the engage watchdog preempt post-retreat local threat recovery', () => {
    const { world, player, enemies } = setupNpcApproachThreat('throwing-knife');
    world.stores.health.current[player] = 8;
    world.stores.health.max[player] = 100;
    const ai = new BehaviorTreeAI({ seed: 12 });

    ai.poll(createInputState(), world);
    const internals = ai as unknown as {
      localThreatRecoveryEid: number | null;
      engageNoProgressFrames: number;
      engageBaselinesByEid: Map<number, { bestDistance: number; bestHp: number }>;
      ignoredEnemyUntilFrame: Map<number, number>;
    };
    const retreatThreatEid = internals.localThreatRecoveryEid;
    expect(retreatThreatEid).not.toBeNull();
    for (const [index, enemy] of enemies.entries()) {
      world.stores.position.x[enemy] = 46 + index * 2;
      world.stores.position.y[enemy] = 14;
    }

    ai.poll(createInputState(), world);
    const decision = ai.getDecision();
    expect(decision).toMatchObject({
      state: AIState.ENGAGE,
      targetEid: retreatThreatEid,
    });

    internals.engageNoProgressFrames = ENGAGE_GIVEUP_FRAMES;
    const ex = world.stores.position.x[retreatThreatEid!] ?? 0;
    const ey = world.stores.position.y[retreatThreatEid!] ?? 0;
    const hp = world.stores.health.current[retreatThreatEid!] ?? 0;
    internals.engageBaselinesByEid.set(retreatThreatEid!, {
      bestDistance: Math.hypot(
        ex - (world.stores.position.x[player] ?? 0),
        ey - (world.stores.position.y[player] ?? 0),
      ),
      bestHp: hp,
    });

    ai.poll(createInputState(), world);

    expect(ai.getDecision()).toMatchObject({
      state: AIState.ENGAGE,
      targetEid: retreatThreatEid,
    });
    expect(internals.ignoredEnemyUntilFrame.has(retreatThreatEid!)).toBe(false);
  });

  it('abandons post-retreat recovery after the local no-damage budget', () => {
    const { world, player, enemies, shopkeeperNpcEid } = setupNpcApproachThreat('throwing-knife');
    world.stores.health.current[player] = 8;
    world.stores.health.max[player] = 100;
    const ai = new BehaviorTreeAI({ seed: 12 });

    ai.poll(createInputState(), world);
    const harness = ai as unknown as {
      localThreatRecoveryEid: number | null;
      localThreatRecoveryStartFrame: number | null;
      localThreatRecoveryBestHealth: number | null;
      ignoredEnemyUntilFrame: Map<number, number>;
    };
    const retreatThreatEid = harness.localThreatRecoveryEid;
    expect(retreatThreatEid).not.toBeNull();
    for (const [index, enemy] of enemies.entries()) {
      world.stores.position.x[enemy] = 46 + index * 2;
      world.stores.position.y[enemy] = 14;
    }

    harness.localThreatRecoveryStartFrame =
      world.frameCount - NPC_APPROACH_THREAT_NO_PROGRESS_FRAMES - 1;
    const currentThreatHealth = world.stores.health.current[retreatThreatEid!] ?? 0;
    harness.localThreatRecoveryBestHealth = currentThreatHealth + 1;
    ai.poll(createInputState(), world);

    expect(ai.getDecision().state).toBe(AIState.ENGAGE);
    expect(harness.localThreatRecoveryStartFrame).toBe(world.frameCount);

    harness.localThreatRecoveryStartFrame =
      world.frameCount - NPC_APPROACH_THREAT_NO_PROGRESS_FRAMES - 1;
    harness.localThreatRecoveryBestHealth = currentThreatHealth;
    ai.poll(createInputState(), world);

    expect(ai.getDecision()).toMatchObject({
      state: AIState.EXPLORE,
      targetEid: shopkeeperNpcEid,
    });
    expect(harness.ignoredEnemyUntilFrame.get(retreatThreatEid!)).toBeGreaterThan(world.frameCount);
    expect(harness.localThreatRecoveryEid).toBeNull();
  });

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

  it('persists the ENGAGE no-progress baseline across a flipping nearest-enemy target', () => {
    // Regression test for a legacy AI deadlock found via headless weapon-sweep
    // repro (GitHub Actions run 29453994290, bow-seed91 / throwing-knife-seed14 /
    // throwing-knife-seed18): two enemies sitting at a near-tied distance can
    // cause the behavior tree's "nearest enemy" target to flip between them
    // every frame. The watchdog used to reset its no-progress baseline whenever
    // the tracked eid changed, so a flip-flopping pair reset the counter back to
    // 0 every single frame and giveup could never fire -- ENGAGE deadlocked
    // forever against an oscillating RETREAT. The shared no-progress counter must
    // keep incrementing regardless of eid swaps while per-eid baselines ensure
    // each target is measured against its own history.
    const world = createTestWorld({ seed: 5 });
    const player = spawnPlayer(world, 0, 0);
    world.stores.position.x[player] = 0;
    world.stores.position.y[player] = 0;

    // Both enemies sit at the exact same distance/HP so neither swap ever looks
    // like progress -- isolates the eid-churn behavior from ordinary distance/HP
    // improvement, which already correctly resets the baseline.
    const enemyA = spawnEnemy(world, 20, 0, 20);
    const enemyB = spawnEnemy(world, 20, 0, 20);

    const ai = new BehaviorTreeAI({ seed: 5 });
    const internals = ai as unknown as {
      decision: { state: AIStateValue; targetEid: number | null };
      engageNoProgressFrames: number;
      engageBaselinesByEid: Map<number, { bestDistance: number; bestHp: number }>;
      updateEngageWatchdog: (world: GameWorld, playerX: number, playerY: number) => void;
    };
    internals.decision.state = AIState.ENGAGE;

    // Pre-establish baselines for both enemies (first-sight is a neutral
    // baseline-recording call that does not affect the counter).
    internals.decision.targetEid = enemyA;
    internals.updateEngageWatchdog(world, 0, 0);
    expect(internals.engageNoProgressFrames).toBe(0);

    internals.decision.targetEid = enemyB;
    internals.updateEngageWatchdog(world, 0, 0);
    expect(internals.engageNoProgressFrames).toBe(0);

    // Flip the tracked target every frame for exactly ENGAGE_GIVEUP_FRAMES
    // frames. Both baselines are now established, so none of these frames show
    // progress; the shared no-progress counter must keep incrementing regardless
    // of the eid swap.
    for (let frame = 0; frame < ENGAGE_GIVEUP_FRAMES; frame += 1) {
      internals.decision.targetEid = frame % 2 === 0 ? enemyA : enemyB;
      internals.updateEngageWatchdog(world, 0, 0);
    }
    expect(internals.engageNoProgressFrames).toBe(ENGAGE_GIVEUP_FRAMES);
    expect(internals.decision.targetEid).not.toBeNull();

    // One more no-progress frame must trip giveup.
    internals.decision.targetEid = enemyB;
    internals.updateEngageWatchdog(world, 0, 0);
    expect(internals.decision.targetEid).toBeNull();

    // Giveup must clear the entire baseline map so the next enemy the BT
    // retargets starts fresh rather than inheriting a stale bar.
    expect(internals.engageBaselinesByEid.size).toBe(0);
  });

  it('resets the ENGAGE progress baseline when the tracked target dies', () => {
    // Companion regression test for the per-eid baseline design: the death/
    // despawn branch removes the eid's entry from engageBaselinesByEid so that
    // the next enemy is measured against its own starting position, not the
    // tight bar the dead target had established (e.g. killed at 1 ft / 20 HP,
    // fresh enemy at 30 ft would look like no progress without this reset).
    const world = createTestWorld({ seed: 6 });
    const player = spawnPlayer(world, 0, 0);
    world.stores.position.x[player] = 0;
    world.stores.position.y[player] = 0;

    const nearlyDeadEnemy = spawnEnemy(world, 1, 0, 20);
    const freshEnemy = spawnEnemy(world, 30, 0, 20);

    const ai = new BehaviorTreeAI({ seed: 6 });
    const internals = ai as unknown as {
      decision: { state: AIStateValue; targetEid: number | null };
      engageNoProgressFrames: number;
      engageBaselinesByEid: Map<number, { bestDistance: number; bestHp: number }>;
      updateEngageWatchdog: (world: GameWorld, playerX: number, playerY: number) => void;
    };
    internals.decision.state = AIState.ENGAGE;

    // First-sight of nearlyDeadEnemy records its baseline (1 ft / 20 HP).
    internals.decision.targetEid = nearlyDeadEnemy;
    internals.updateEngageWatchdog(world, 0, 0);
    expect(internals.engageBaselinesByEid.get(nearlyDeadEnemy)?.bestDistance).toBeCloseTo(1, 5);
    expect(internals.engageBaselinesByEid.get(nearlyDeadEnemy)?.bestHp).toBe(20);

    // Kill it; the death branch removes its entry and resets the counter.
    world.stores.health.current[nearlyDeadEnemy] = 0;
    internals.updateEngageWatchdog(world, 0, 0);
    expect(internals.engageBaselinesByEid.has(nearlyDeadEnemy)).toBe(false);

    // Switch to a distant fresh enemy. First-sight establishes its baseline at
    // 30 ft -- not the dead target's 1 ft bar -- so the next comparison frame
    // will correctly detect that the fresh enemy is making progress.
    internals.decision.targetEid = freshEnemy;
    internals.updateEngageWatchdog(world, 0, 0);
    expect(internals.engageNoProgressFrames).toBe(0);
    expect(internals.engageBaselinesByEid.get(freshEnemy)?.bestDistance).toBeCloseTo(30, 5);
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

    // RISK_REWARD_FUSED folds the dodge through the danger-scoring fan rather than
    // blending it additively, so the lateral contribution is smaller than the old
    // LEGACY additive path. The primary invariant is that the dodge is computed
    // (dodgeY > 1) and produces measurable lateral movement (moveY > 0).
    const ai = new BehaviorTreeAI({ seed: 42, pathingMode: AIPathingMode.RISK_REWARD_FUSED });
    const input = createInputState();
    ai.poll(input, world);
    const decision = ai.getDecision();
    const dodge = ai.getOpportunisticDebug();

    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.targetX).toBeGreaterThan(0);
    expect(input.moveX).toBeGreaterThan(0);
    expect(Math.abs(input.moveY)).toBeGreaterThan(0.03);
    expect(Math.abs(dodge.dodgeY)).toBeGreaterThan(1);
  });

  it('sidesteps a telegraphed-but-not-yet-fired shot using the LOCKED aim (no privileged prediction)', () => {
    // Same geometry as the real-projectile dodge test above, but the shot has
    // not spawned yet — it is only telegraphing. The dodge must react to the
    // locked origin/direction read from the shared public EnemyBehavior store
    // (see core/systems/enemyTelegraph.ts), the same state the render cue uses.
    const sword = getWeaponDef('sword')!;
    const world = createTestWorld({ seed: 42 });
    world.enemyTelegraphMs = 250;
    world.elapsedMs = 5000;
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 20, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    setActiveWeapon(world, sword);

    // Drive the real fire logic to start (but not resolve) a telegraph aimed
    // at the player, exactly as the real game loop would.
    enemyAISystem(world);
    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(true);
    expect(query(world.ecs, [EnemyProjectile]).length).toBe(0);

    const ai = new BehaviorTreeAI({ seed: 42 });
    const input = createInputState();
    ai.poll(input, world);
    const decision = ai.getDecision();
    const dodge = ai.getOpportunisticDebug();

    // No projectile exists yet — the only way a dodge triggers here is via the
    // telegraphed-shot virtual-projectile loop reading locked origin/dir.
    expect(query(world.ecs, [EnemyProjectile]).length).toBe(0);
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(Math.abs(dodge.dodgeY)).toBeGreaterThan(1);
  });

  it('uses committed mob-ability cue geometry to flee a telegraph circle from inside the footprint', () => {
    const world = createTestWorld({ seed: 42 });
    world.elapsedMs = 5000;
    spawnPlayer(world, 3, 0);
    spawnBehaviorEnemy(world, 20, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    setActiveWeapon(world, getWeaponDef('sword')!);
    world.mobAbilities.cues.push({
      abilityId: 'queen-mab-verdigris-glamour',
      casterEid: 99,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry: { kind: 'circle', x: 0, y: 0, radiusFt: 12 },
      dangerColor: 'hostile-red',
      announcementText: 'VERDIGRIS GLAMOUR — All that glitters will corrode!',
    });

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);
    const dodge = ai.getOpportunisticDebug();

    expect(dodge.dodgeX).toBeCloseTo(PROJECTILE_DODGE_VECTOR_SCALE);
    expect(dodge.dodgeY).toBe(0);
  });

  it('uses full dodge scale when the player is exactly at the committed mob-ability circle center', () => {
    const world = createTestWorld({ seed: 42 });
    world.elapsedMs = 5000;
    spawnPlayer(world, 0, 0);
    spawnBehaviorEnemy(world, 20, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    setActiveWeapon(world, getWeaponDef('sword')!);
    world.mobAbilities.cues.push({
      abilityId: 'queen-mab-verdigris-glamour',
      casterEid: 99,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry: { kind: 'circle', x: 0, y: 0, radiusFt: 12 },
      dangerColor: 'hostile-red',
      announcementText: 'VERDIGRIS GLAMOUR — All that glitters will corrode!',
    });

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);
    const dodge = ai.getOpportunisticDebug();

    expect(Math.abs(dodge.dodgeX)).toBeCloseTo(PROJECTILE_DODGE_VECTOR_SCALE);
    expect(dodge.dodgeY).toBe(0);
  });

  it('ignores committed mob-ability cue circles when the player is outside the footprint', () => {
    const world = createTestWorld({ seed: 42 });
    world.elapsedMs = 5000;
    spawnPlayer(world, 12.5, 0);
    spawnBehaviorEnemy(world, 20, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    setActiveWeapon(world, getWeaponDef('sword')!);
    world.mobAbilities.cues.push({
      abilityId: 'queen-mab-verdigris-glamour',
      casterEid: 99,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry: { kind: 'circle', x: 0, y: 0, radiusFt: 12 },
      dangerColor: 'hostile-red',
      announcementText: 'VERDIGRIS GLAMOUR — All that glitters will corrode!',
    });

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);
    const dodge = ai.getOpportunisticDebug();

    expect(dodge.dodgeX).toBe(0);
    expect(dodge.dodgeY).toBe(0);
  });

  it('uses committed mob-ability lane geometry to flee sideways from inside the footprint', () => {
    const world = createTestWorld({ seed: 42 });
    world.elapsedMs = 5000;
    spawnPlayer(world, 0, 0);
    spawnBehaviorEnemy(world, 20, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    setActiveWeapon(world, getWeaponDef('sword')!);
    world.mobAbilities.cues.push({
      abilityId: 'overseer-fizzwick-clockwork-kill-saw',
      casterEid: 99,
      phase: 'telegraph',
      telegraphProgress: 0.5,
      geometry: {
        kind: 'lane',
        originX: -16,
        originY: 0,
        endX: 16,
        endY: 0,
        dirX: 1,
        dirY: 0,
        widthFt: 6,
        lengthFt: 32,
      },
      dangerColor: 'hostile-red',
      announcementText: 'CLOCKWORK KILL-SAW — Mandatory overtime starts now!',
    });

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);
    const dodge = ai.getOpportunisticDebug();

    expect(dodge.dodgeX).toBeCloseTo(0, 10);
    expect(Math.abs(dodge.dodgeY)).toBeCloseTo(PROJECTILE_DODGE_VECTOR_SCALE, 6);
  });

  it('uses the raw locked pivot for the telegraphed virtual-projectile dodge, matching the real fire-time spawn point', () => {
    // The real and virtual shots both spawn at the raw locked origin. Geometry
    // puts the player directly above that pivot so impactFramesAfterSpawn is 0.
    // Reintroducing a forward offset would put the projectile past the player
    // and moving away, causing this threat candidate to be skipped.
    const world = createTestWorld({ seed: 42 });
    world.elapsedMs = 0;
    spawnPlayer(world, 0, 1);
    const enemy = spawnBehaviorEnemy(world, 0, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    setActiveWeapon(world, getWeaponDef('sword')!);

    const REMAINING_FRAMES = 89.8;
    const { enemyBehavior } = world.stores;
    enemyBehavior.telegraphActive[enemy] = 1;
    enemyBehavior.telegraphStartMs[enemy] = 0;
    enemyBehavior.telegraphDelayMs[enemy] = REMAINING_FRAMES * GAME.DELTA_MS;
    enemyBehavior.telegraphOriginX[enemy] = 0;
    enemyBehavior.telegraphOriginY[enemy] = 0;
    enemyBehavior.telegraphDirX[enemy] = 1;
    enemyBehavior.telegraphDirY[enemy] = 0;

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);
    const dodge = ai.getOpportunisticDebug();

    // Only reachable when dodge math uses the same raw pivot as real fire.
    expect(dodge.dodgeY).toBeGreaterThan(2);
  });

  it('counts the discrete pre-fire movement steps for the telegraphed-shot dodge horizon, not the raw fractional quotient (regression: copilot-pull-request-reviewer finding)', () => {
    // The AI's poll() runs BEFORE runSimulationStep() advances world.elapsedMs
    // and runs preSystems for the CURRENT step (see headless-runner.ts's main
    // loop), while isEnemyProjectileTelegraphReady's fire check runs AFTER
    // that increment but BEFORE that step's movementSystem
    // (simulation-core-step.ts's preSystems -> movementSystem order). So the
    // step on which the shot fires still advances elapsedMs and trips the
    // fire check, but that step's OWN player movement happens after the fire
    // (never before the shot spawns). The raw fractional quotient
    // (remainingMs / DELTA_MS) overcounts the pre-fire player movements by
    // exactly one step; the correct count is
    // ceil(remainingMs / DELTA_MS) - 1.
    //
    // Geometry mirrors the pivot-origin test above: the player sits exactly
    // at the virtual shot's raw-origin spawn x with zero velocity, so
    // impactFramesAfterSpawn = 0 and
    // totalImpactFrames = remainingFrames exactly — isolating the horizon
    // gate (PROJECTILE_DODGE_HORIZON_FRAMES = 90) to the remainingFrames
    // formula alone, independent of projected player position.
    //   - delayMs = 91 whole frames.
    //   - Raw fractional quotient: remainingFrames = 91 -> totalImpactFrames
    //     = 91 > 90 -> candidate skipped -> dodgeY stays 0 (a real dodge is
    //     missed one frame early).
    //   - Correct discrete count: remainingFrames = ceil(91) - 1 = 90 ->
    //     totalImpactFrames = 90 (not > 90) -> candidate accepted -> dodgeY
    //     > 0.
    const world = createTestWorld({ seed: 42 });
    world.elapsedMs = 0;
    spawnPlayer(world, 0, 1);
    const enemy = spawnBehaviorEnemy(world, 0, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    setActiveWeapon(world, getWeaponDef('sword')!);

    const DELAY_FRAMES = 91;
    const { enemyBehavior } = world.stores;
    enemyBehavior.telegraphActive[enemy] = 1;
    enemyBehavior.telegraphStartMs[enemy] = 0;
    enemyBehavior.telegraphDelayMs[enemy] = DELAY_FRAMES * GAME.DELTA_MS;
    enemyBehavior.telegraphOriginX[enemy] = 0;
    enemyBehavior.telegraphOriginY[enemy] = 0;
    enemyBehavior.telegraphDirX[enemy] = 1;
    enemyBehavior.telegraphDirY[enemy] = 0;

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);
    const dodge = ai.getOpportunisticDebug();

    // Only reachable with the discrete pre-fire movement count: the raw
    // fractional quotient would put this candidate one frame beyond the
    // dodge horizon, silently skipping a shot the player can genuinely still
    // react to.
    expect(dodge.dodgeY).toBeGreaterThan(2);
  });

  it("dodges a telegraphed shot only once the shooter's tile is in LIVE FOV, not merely discovered/remembered tile memory (regression: copilot-pull-request-reviewer finding)", () => {
    // canCurrentlyPerceiveWorldPosition (used solely for this telegraph-dodge
    // gate) is a STRICT sibling of canPerceiveWorldPosition: it requires the
    // shooter's LIVE tile to be in current FOV, not merely discovered/
    // remembered — matching PhaserBridge's render-cue gate exactly, so the AI
    // never reacts to a threat the player cannot currently see rendered.
    // This distinguishes it from every OTHER perception check in this file
    // (which use the looser canPerceiveWorldPosition and accept discovered-
    // but-not-currently-visible tiles).
    const world = createTestWorld({ seed: 42 });
    world.floorMap = makeOpenRoom(24, 24);
    world.enemyTelegraphMs = 250;
    world.elapsedMs = 5000;
    spawnPlayer(world, 0, 0);
    // 20ft away, and makeOpenRoom's tileSizeFt = 4 -> a distinct tile from
    // the player's (tile x = 5 vs 0), so marking the player's tile visible
    // does not incidentally also mark the shooter's tile visible.
    const enemy = spawnBehaviorEnemy(world, 20, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    setActiveWeapon(world, getWeaponDef('sword')!);

    const floorMap = world.floorMap;
    const playerTile = floorMap.worldToTile(0, 0);
    const enemyTile = floorMap.worldToTile(20, 0);
    expect(enemyTile.x).not.toBe(playerTile.x);
    // Player tile visible+discovered triggers hasPerceptionData = true
    // (restrictive mode) — matching the established pattern above.
    floorMap.setVisible(playerTile.x * 2, playerTile.y * 2);
    floorMap.setDiscovered(playerTile.x * 2, playerTile.y * 2);
    // Shooter's tile: discovered (remembered from an earlier visit) but NOT
    // currently visible.
    floorMap.setDiscovered(enemyTile.x * 2, enemyTile.y * 2);

    const ai = new BehaviorTreeAI({ seed: 42 });
    const input = createInputState();

    // Drive the real fire logic to start (but not resolve) a telegraph aimed
    // at the player, exactly as the real game loop would.
    enemyAISystem(world);
    expect(isEnemyProjectileTelegraphActive(world, enemy)).toBe(true);

    ai.poll(input, world);
    let dodge = ai.getOpportunisticDebug();
    // Discovered-but-not-currently-visible: the strict gate must reject this
    // candidate even though the looser discovered-tile memory would allow it.
    expect(dodge.dodgeY).toBe(0);

    // Once the shooter's tile also enters LIVE FOV, the same telegraph must
    // be dodged.
    floorMap.setVisible(enemyTile.x * 2, enemyTile.y * 2);
    ai.poll(input, world);
    dodge = ai.getOpportunisticDebug();
    expect(Math.abs(dodge.dodgeY)).toBeGreaterThan(1);
  });

  it('ignores a telegraphed shot from a shooter that already died this simulation step (regression: copilot-pull-request-reviewer finding)', () => {
    // The input-polling AI runs before enemyAISystem in the frame order, so a
    // shooter killed earlier this step can still have `telegraphActive` set
    // here — enemyAISystem only cancels it once its own DeathTimer branch
    // runs. Without filtering non-positive health (the same filter the
    // closing-speed danger scorer already applies), the player would dodge a
    // shot that is guaranteed to be cancelled and never actually fire.
    const world = createTestWorld({ seed: 42 });
    world.elapsedMs = 0;
    spawnPlayer(world, 1.5, 1);
    const enemy = spawnBehaviorEnemy(world, 0, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    setActiveWeapon(world, getWeaponDef('sword')!);

    const REMAINING_FRAMES = 89.8;
    const { enemyBehavior } = world.stores;
    enemyBehavior.telegraphActive[enemy] = 1;
    enemyBehavior.telegraphStartMs[enemy] = 0;
    enemyBehavior.telegraphDelayMs[enemy] = REMAINING_FRAMES * GAME.DELTA_MS;
    enemyBehavior.telegraphOriginX[enemy] = 0;
    enemyBehavior.telegraphOriginY[enemy] = 0;
    enemyBehavior.telegraphDirX[enemy] = 1;
    enemyBehavior.telegraphDirY[enemy] = 0;
    // The shooter died earlier this step; DeathTimer hasn't cancelled the
    // telegraph yet (that happens later, in enemyAISystem).
    world.stores.health.current[enemy] = 0;

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);
    const dodge = ai.getOpportunisticDebug();

    // Same geometry that produces dodgeY > 2 in the live-shooter case above —
    // here it must stay at 0 because the dead shooter's telegraph is ignored.
    expect(dodge.dodgeY).toBe(0);
  });

  it("ignores a telegraphed shot whose closest approach lies beyond the real projectile's range (regression: copilot-pull-request-reviewer finding)", () => {
    // The real fire path spawns via spawnAoeProjectile(..., FIREBALL_DEF.range)
    // (enemyAISystem.ts's fireEnemyProjectileFrom) and projectileCleanupSystem
    // despawns the projectile once it has traveled that far (32ft for
    // fireball) from its spawn point. The virtual-projectile dodge model must
    // respect the same bound — otherwise the AI dodges a shot that will
    // despawn long before it could ever reach the player.
    const world = createTestWorld({ seed: 42 });
    world.elapsedMs = 0;
    // Stand directly on the aim ray, 38.5ft from the (muzzle-offset) spawn
    // point — well beyond the fireball's 32ft range — so the shot would
    // despawn in flight and can never actually hit.
    spawnPlayer(world, 40, 0);
    const enemy = spawnBehaviorEnemy(world, 0, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    setActiveWeapon(world, getWeaponDef('sword')!);

    const { enemyBehavior } = world.stores;
    enemyBehavior.telegraphActive[enemy] = 1;
    enemyBehavior.telegraphStartMs[enemy] = 0;
    enemyBehavior.telegraphDelayMs[enemy] = 0; // ready to fire immediately
    enemyBehavior.telegraphOriginX[enemy] = 0;
    enemyBehavior.telegraphOriginY[enemy] = 0;
    enemyBehavior.telegraphDirX[enemy] = 1;
    enemyBehavior.telegraphDirY[enemy] = 0;

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);
    const dodge = ai.getOpportunisticDebug();

    // Without the range bound, this dead-center trajectory (well within the
    // dodge horizon) would trigger a nonzero perpendicular dodge; with the
    // bound in place the candidate is out of the real projectile's reach and
    // must be skipped, leaving dodgeY at 0.
    expect(dodge.dodgeY).toBe(0);
  });

  it("dodges a telegraphed shot whose closest approach lands just PAST nominal range, within the real pipeline's one-step grace (regression: copilot-pull-request-reviewer finding)", () => {
    // projectileCleanupSystem despawns a projectile once its traveled
    // distance EXCEEDS maxRange, but that check runs AFTER movement +
    // collision + damage each step (simulation-core-step.ts), so the real
    // shot can still land on the exact step it first crosses maxRange —
    // one whole step beyond the nominal boundary. A hard `> rangeFt`
    // rejection (the previous fix) would make the AI ignore a threat that
    // can genuinely still hit. Fireball: range=32ft, projectileSpeed=0.5ft/
    // frame -> last reachable step is floor(32/0.5)+1 = 65 frames (32.5ft).
    //
    // The enemy's LIVE body sits close to the player (15ft, well inside the
    // player-AI's own melee-engage threshold) purely so the opportunistic
    // dodge action actually runs — travel steering zeroes the dodge vector
    // outright while the player AI is in EXPLORE (see
    // buildOpportunisticDodge's travel-steering block), which would
    // otherwise mask this candidate's math regardless of the fix under
    // test. The telegraph's locked origin (what the range/geometry math
    // reads) is set independently, 34ft behind the player, so the shot
    // itself still has to travel the full 32.5ft grace distance to connect
    // — exactly like a shooter that telegraphed at max range and then the
    // player closed distance toward it during the delay.
    const world = createTestWorld({ seed: 42 });
    world.elapsedMs = 0;
    spawnPlayer(world, 0, 0);
    const enemy = spawnBehaviorEnemy(world, 15, 0, 40, AI_TYPE.RANGED, 5, 200, 160);
    setActiveWeapon(world, getWeaponDef('sword')!);

    const { enemyBehavior } = world.stores;
    enemyBehavior.telegraphActive[enemy] = 1;
    enemyBehavior.telegraphStartMs[enemy] = 0;
    enemyBehavior.telegraphDelayMs[enemy] = 0; // ready to fire immediately
    // 32.5ft (muzzle-offset-adjusted) west of the player — just past the
    // nominal 32ft range but exactly at the one-step grace boundary.
    enemyBehavior.telegraphOriginX[enemy] = -34;
    enemyBehavior.telegraphOriginY[enemy] = 0;
    enemyBehavior.telegraphDirX[enemy] = 1;
    enemyBehavior.telegraphDirY[enemy] = 0;

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);
    const dodge = ai.getOpportunisticDebug();

    // Without the grace fix, this candidate's raw analytic frame (65) would
    // have been hard-rejected for exceeding the nominal 32ft range,
    // leaving dodgeX/Y at 0.
    expect(Math.abs(dodge.dodgeX) + Math.abs(dodge.dodgeY)).toBeGreaterThan(0);
  });

  it('real pipeline: an enemy AoE projectile can still hit the player on the exact step it first exceeds nominal maxRange, before cleanup removes it (validates the dodge grace window above)', () => {
    // Proves the "one-step grace" the dodge-math fix above models is real:
    // movementSystem -> collisionSystem -> damageSystem all run BEFORE
    // projectileCleanupSystem removes a projectile that has exceeded
    // maxRange (simulation-core-step.ts ordering), so a hit landing exactly
    // on the range-crossing step is genuine, not a modeling artifact.
    // Fireball travels only 0.5ft/frame, so rather than simulate 64 steps to
    // reach the boundary, fast-forward the projectile's Position to the
    // last-safe distance (32ft, exactly at range) while leaving its
    // Projectile.originX/Y at the true spawn point (0,0) — one real
    // simulation step then advances it to 32.5ft (past the nominal 32ft
    // range) in the same step collision/damage run.
    const world = createTestWorld({ seed: 42 });
    const fireballDef = getWeaponDef('fireball')!;
    const enemy = spawnBehaviorEnemy(world, -50, 0, 40, AI_TYPE.RANGED, 0, 1, 1);
    const player = spawnPlayer(world, 32.5, 0);

    const projectile = spawnAoeProjectile(
      world,
      0,
      0,
      fireballDef.projectileSpeed,
      0,
      fireballDef.baseDamage,
      fireballDef.aoeRadius,
      fireballDef.baseDamage,
      enemy,
      TeamId.ENEMY,
      fireballDef.range,
    );
    // spawnAoeProjectile does not tag EnemyProjectile itself — the real fire
    // path (enemyAISystem.ts's fireEnemyProjectileFrom) adds it right after
    // spawning; damageSystem's applyEnemyProjectileHit requires it to treat a
    // hit as a legitimate enemy-on-player attack.
    addComponent(world.ecs, projectile, EnemyProjectile);
    // Fast-forward: already traveled to exactly the nominal range boundary
    // (32ft); origin stays at the true spawn point for the cleanup system's
    // distance-from-origin check.
    world.stores.position.x[projectile] = fireballDef.range;
    world.stores.position.y[projectile] = 0;

    const healthBefore = world.stores.health.current[player] ?? 0;
    runSimulationStep(world, createInputState(), GAME.DELTA_MS);

    expect(world.stores.health.current[player] ?? 0).toBeLessThan(healthBefore);
    // The same step that lands the hit also removes the now-out-of-range projectile.
    expect(query(world.ecs, [Projectile]).includes(projectile)).toBe(false);
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

  it('retreats from a second enemy closing from another angle while orbiting the primary ranged target', () => {
    // Regression for the packed-swarm HP-crash root cause: computeRangedKiteTarget
    // used to derive its escape motion purely from the nearest enemy's own axis,
    // so a second enemy closing in from a different angle never bent the kite
    // path away from it — only the nearest one ever influenced movement. The
    // nearest enemy (B, at (0, 3)) is the engagement target; a second enemy (A,
    // at (5, 0)) sits farther away but still inside the standoff ring, at a
    // right angle to B. A's escape-push contribution is purely along -X (since
    // A is directly on the +X axis from the player), so it shifts targetX
    // without touching targetY — isolating the fix from the pre-existing
    // radial/strafe motion (driven by B) and from hasThreatFromBehind's
    // dot-product check (which stays false for both scenarios: A sits at 90°
    // from B's axis, not behind).
    const baselineWorld = createTestWorld({ seed: 7 });
    spawnPlayer(baselineWorld, 0, 0);
    spawnEnemy(baselineWorld, 0, 3, 20);
    setActiveWeapon(baselineWorld, getWeaponDef('bow')!);
    const baselineAi = new BehaviorTreeAI({ seed: 7 });
    baselineAi.poll(createInputState(), baselineWorld);
    const baseline = baselineAi.getDecision();
    expect(baseline.reason).toContain('Ranged orbit');

    const multiThreatWorld = createTestWorld({ seed: 7 });
    spawnPlayer(multiThreatWorld, 0, 0);
    spawnEnemy(multiThreatWorld, 0, 3, 20);
    spawnEnemy(multiThreatWorld, 5, 0, 20);
    setActiveWeapon(multiThreatWorld, getWeaponDef('bow')!);
    const multiThreatAi = new BehaviorTreeAI({ seed: 7 });
    multiThreatAi.poll(createInputState(), multiThreatWorld);
    const withSecondThreat = multiThreatAi.getDecision();
    expect(withSecondThreat.reason).toContain('Ranged orbit');

    // The second enemy's escape push is purely along -X (before the shared
    // fixed-length step renormalization couples both axes), so targetY only
    // shifts a little while targetX shifts clearly negative relative to the
    // baseline (nearest-only) case.
    expect(Math.abs(withSecondThreat.targetY! - baseline.targetY!)).toBeLessThan(0.5);
    expect(withSecondThreat.targetX!).toBeLessThan(baseline.targetX! - 0.5);
  });

  it('detours for nearby loot mid-kite once every enemy has cleared the safe-loot radius', () => {
    // Maintainer-requested behavior: "if I have time (enemies pushed far enough
    // away) and there's enough loot to be worth it, circle around to collect."
    // No enemies within SAFE_LOOT_ENEMY_CLEARANCE_FT and gold within
    // LOOT_DETOUR_MAX_FT — the AI must detour toward the gold while still in
    // AIState.ENGAGE (no BT state-machine change) rather than orbit-kiting.
    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);
    // Primary target sits beyond SAFE_LOOT_ENEMY_CLEARANCE_FT (so the "no nearby
    // threat" gate is satisfied) but still within the bow's ~44ft engage radius
    // (so ENGAGE stays active and planRangedEngagement's "closing" phase, where
    // the detour check now lives, actually runs instead of falling to Collect).
    const farFt = SAFE_LOOT_ENEMY_CLEARANCE_FT + 8;
    spawnEnemy(world, farFt, 0, 20);
    spawnGold(world, 5, 0, 3);
    setActiveWeapon(world, getWeaponDef('bow')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.reason).toContain('Detouring for');
    expect(decision.reason).toContain('loot mid-kite');
    expect(decision.targetX!).toBeCloseTo(5, 0);
    expect(decision.targetY!).toBeCloseTo(0, 0);
  });

  it('does not detour for loot while a secondary (flanking) enemy is within the safe-loot clearance radius', () => {
    // The loot detour fires when the ACTIVE target is in the closing phase and
    // no OTHER (secondary) enemy is nearby. This test verifies that a secondary
    // threat within SAFE_LOOT_ENEMY_CLEARANCE_FT correctly blocks the detour
    // even though the active target itself is in the closing phase.
    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);
    // Nearest enemy becomes the active target (15ft — closing phase for bow,
    // since contactThreatRadius ~= 9ft). The detour alone would fire, but a
    // second live enemy within SAFE_LOOT_ENEMY_CLEARANCE_FT (at ~25ft) should
    // block it.
    spawnEnemy(world, 15, 0, 20); // active target, closing phase
    spawnEnemy(world, 0, 25, 20); // secondary flanker — blocks detour
    spawnGold(world, 5, 0, 3);
    setActiveWeapon(world, getWeaponDef('bow')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.reason).not.toContain('Detouring for');
  });

  it('detours for loot mid-kite with a short-range weapon (throwing-knife) during the closing phase', () => {
    // Regression for the short-range-weapon reachability bug: throwing-knife
    // has engage radius ~30ft and contactThreatRadius ~9ft. Previously the
    // detour was unreachable because the all-enemy clearance scan (30ft) always
    // found the active target itself (also ≤30ft by definition). With the fix,
    // only OTHER enemies are scanned; the active target's distance is checked
    // separately against contactThreatRadius (~9ft), so a TK user at 15ft
    // (closing phase: 15 > 9) with no secondary enemies in range can detour.
    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);
    // TK engage radius = max(19, 30) = 30ft; contactThreatRadius ~= 9ft.
    // At 15ft the enemy is in the closing phase (15 > 9) — previously blocked.
    spawnEnemy(world, 15, 0, 20);
    spawnGold(world, 5, 0, 3);
    setActiveWeapon(world, getWeaponDef('throwing-knife')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.reason).toContain('Detouring for');
    expect(decision.reason).toContain('loot mid-kite');
    expect(decision.targetX!).toBeCloseTo(5, 0);
    expect(decision.targetY!).toBeCloseTo(0, 0);
  });

  it('does not detour for loot farther away than LOOT_DETOUR_MAX_FT even when safe', () => {
    // No enemy nearby (clear), but the gold sits beyond LOOT_DETOUR_MAX_FT — the
    // detour must stay bounded and not wander toward it mid-kite.
    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);
    const farFt = SAFE_LOOT_ENEMY_CLEARANCE_FT + 8;
    spawnEnemy(world, farFt, 0, 20);
    spawnGold(world, LOOT_DETOUR_MAX_FT + 5, 0, 3);
    setActiveWeapon(world, getWeaponDef('bow')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.reason).not.toContain('Detouring for');
  });

  it('does not let a dead (lingering-corpse) enemy block the safe-loot detour', () => {
    // Regression: findNearestOtherEnemyDistance/computeOtherThreatEscapePush must
    // exclude dead (HP<=0) entities. A killed enemy lingers in the ECS with its
    // Enemy+Position intact for its DeathTimer duration (see deathTimerSystem.ts),
    // sitting at the exact spot it just dropped loot. Without a health filter, that
    // corpse would count as "a nearby threat" and permanently block the detour for
    // the very drop the AI just earned.
    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);
    const farFt = SAFE_LOOT_ENEMY_CLEARANCE_FT + 8;
    spawnEnemy(world, farFt, 0, 20);
    // A corpse (hp=0) sitting right next to the gold, well inside
    // SAFE_LOOT_ENEMY_CLEARANCE_FT — must NOT block the detour.
    spawnEnemy(world, 5, 0.5, 0);
    spawnGold(world, 5, 0, 3);
    setActiveWeapon(world, getWeaponDef('bow')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.reason).toContain('Detouring for');
  });

  it('does not let a dead (lingering-corpse) enemy bend the multi-threat kiting escape push', () => {
    // Same corpse-exclusion fix, but for computeOtherThreatEscapePush: a dead
    // second enemy inside the standoff ring must contribute zero escape push,
    // so the decision should match the single-live-enemy baseline exactly.
    const baselineWorld = createTestWorld({ seed: 7 });
    spawnPlayer(baselineWorld, 0, 0);
    spawnEnemy(baselineWorld, 0, 3, 20);
    setActiveWeapon(baselineWorld, getWeaponDef('bow')!);
    const baselineAi = new BehaviorTreeAI({ seed: 7 });
    baselineAi.poll(createInputState(), baselineWorld);
    const baseline = baselineAi.getDecision();
    expect(baseline.reason).toContain('Ranged orbit');

    const corpseWorld = createTestWorld({ seed: 7 });
    spawnPlayer(corpseWorld, 0, 0);
    spawnEnemy(corpseWorld, 0, 3, 20);
    // Dead (hp=0) "enemy" at the same spot the live second threat used in the
    // sibling multi-threat test (5,0) — well inside the standoff ring — must be
    // fully ignored by the escape-push scan.
    spawnEnemy(corpseWorld, 5, 0, 0);
    setActiveWeapon(corpseWorld, getWeaponDef('bow')!);
    const corpseAi = new BehaviorTreeAI({ seed: 7 });
    corpseAi.poll(createInputState(), corpseWorld);
    const withCorpse = corpseAi.getDecision();
    expect(withCorpse.reason).toContain('Ranged orbit');

    expect(withCorpse.targetX!).toBeCloseTo(baseline.targetX!, 5);
    expect(withCorpse.targetY!).toBeCloseTo(baseline.targetY!, 5);
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

  describe('spell broker optional goal resolver paths (regression)', () => {
    /** Find the first seed in 1-100 where the seeded 25% decision says shouldBuy. */
    function findBuySeed(): number {
      for (let seed = 1; seed <= 100; seed++) {
        const w = createTestWorld({ seed });
        configureSpellBrokerPurchase(w, true);
        if (ensureSpellBrokerDecision(w).shouldBuy) return seed;
      }
      throw new Error('No buy seed found in range 1-100');
    }

    /**
     * A world where the whole Floor 1 mandatory chain is done EXCEPT the
     * staircase boss (started=false, defeated=false), so the planner still
     * has a required goal to emit and `resolveFloor1MiddleChainObjective` will
     * run the full switch.
     */
    function setupPostBossBattleWorld(seed: number): {
      world: GameWorld;
      player: number;
      brokerX: number;
      brokerY: number;
    } {
      const world = createTestWorld({ seed });
      const player = spawnPlayer(world, 4, 4);
      initializeFloor1Scenario(world, player);
      selectFloor1StarterWeapon(world, 0);
      meetTutorialGoon(world);
      world.playerLevel.level = 2;
      world.floorScenario!.objective.questCompleted = true;
      // Complete the pre-chain goal flags
      world.goalFlags.set('floor1-leveling-quest-complete', true);
      world.goalFlags.set('floor1-goon-quest-complete', true);
      // Shop chain complete
      world.goalFlags.set('floor1-shop-quest-complete', true);
      // Accept the boss battle quest so bossBattleAccepted===true in the snapshot
      meetSpellQuestGiver(world);
      // Slime Rat defeated → spells unlocked and boss battle complete
      const slimeRat = world.floorScenario!.objective.bossBattles.get('slime-rat')!;
      slimeRat.started = true;
      slimeRat.defeated = true;
      world.featureUnlocks.spells = true;
      world.goalFlags.set('floor1-boss-battle-complete', true);
      // Staircase NOT started so there is still a required goal in the graph
      // (staircase boss + take-stairs keep the resolver active)
      world.floorMap = makeOpenRoom(40, 20);
      world.stores.position.x[player] = 4;
      world.stores.position.y[player] = 4;
      // Put the broker far to the right so a returning-state planner routes there
      const brokerX = 36;
      const brokerY = 4;
      // Put the staircase boss at the same far-right position so neither is
      // trivially closer; the key invariant is just no-throw in both paths.
      world.floorScenario!.objective = {
        ...world.floorScenario!.objective,
        spellQuestGiverPos: { x: brokerX, y: brokerY },
        staircasePos: { x: brokerX, y: brokerY },
        deadlineMs: 600_000,
      };
      return { world, player, brokerX, brokerY };
    }

    it('buy-broker-spell: resolver routes AI toward the spell quest giver without throwing', () => {
      const buySeed = findBuySeed();
      const { world, player, brokerX, brokerY } = setupPostBossBattleWorld(buySeed);

      // Activate spell broker intent in returning state (gold >= cost).
      configureSpellBrokerPurchase(world, true);
      ensureSpellBrokerDecision(world);
      world.playerGold = FLOOR1_SPELL_BROKER_COST + 1; // affordable → returning
      updateSpellBrokerIntent(world, null, 3_000); // transitions idle → returning

      const ai = new BehaviorTreeAI({ seed: buySeed });
      // Must not throw — that was the pre-fix defect (unhandled switch case).
      expect(() => ai.poll(createInputState(), world)).not.toThrow();

      const decision = ai.getDecision();
      expect(decision.state).toBe(AIState.EXPLORE);
      // The resolver's buy-broker-spell case emits 'Spell Broker' in the reason.
      expect(decision.reason).toContain('Spell Broker');
      // Target must be non-null and close to the broker position.
      expect(decision.targetX).not.toBeNull();
      expect(decision.targetX!).toBeCloseTo(brokerX, -1);

      void player; // used in setup
      void brokerY; // declared above
    });

    it('farm-spell-broker-gold: resolver does not throw even with no gold or enemies nearby', () => {
      const buySeed = findBuySeed();
      const { world, player } = setupPostBossBattleWorld(buySeed);

      // Activate spell broker intent in farming state (gold < cost).
      configureSpellBrokerPurchase(world, true);
      ensureSpellBrokerDecision(world);
      world.playerGold = 0; // below FLOOR1_SPELL_BROKER_COST
      updateSpellBrokerIntent(world, null, 3_000); // transitions idle → farming

      const ai = new BehaviorTreeAI({ seed: buySeed });
      // Must not throw — that was the pre-fix defect (unhandled switch case).
      expect(() => ai.poll(createInputState(), world)).not.toThrow();

      void player; // used in setup
    });
  });
});

describe('settlement return routing (BT integration)', () => {
  /** Arms an eligible floor2 world: settlement/broker done, one unclaimed
   * achievement (guarantees positive utility), routing enabled. Returns the
   * player eid and the resolved settlement anchor. */
  function armEligibleSettlementReturnWorld(seed: number): {
    world: GameWorld;
    player: number;
    anchor: { x: number; y: number };
  } {
    const world = createTestWorld({ seed, floor: 2 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor2Scenario(world, player);
    world.goalFlags.set(FLOOR2_SETTLEMENT_FOUND_GOAL_ID, true);
    world.goalFlags.set(FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID, true);
    configureSettlementReturnRouting(world, true);
    unlockAchievement(world, 'first-bonk');

    const anchor = resolveFloor2SettlementAnchor(world);
    expect(anchor).not.toBeNull();
    // Ten feet out: netUtility = achievementGain(40) - travelCostPerFoot(0.5)*10
    // = 35, comfortably above the default triggerThreshold (20).
    world.stores.position.x[player] = anchor!.x + 10;
    world.stores.position.y[player] = anchor!.y;

    return { world, player, anchor: anchor! };
  }

  it('routes an armed/traveling settlement-return intent into Progress, subordinate to the mandatory settlement/broker/staircase objectives', () => {
    const { world, player, anchor } = armEligibleSettlementReturnWorld(70);

    // Drive the router directly (bypassing the BT's per-poll pre-tick hook)
    // to confirm findFloor2ProgressObjective reads the router's status on its
    // own merits, independent of the tree-tick wiring exercised below.
    updateSettlementReturnIntent(
      world,
      player,
      world.stores.position.x[player]!,
      world.stores.position.y[player]!,
      anchor,
      false,
      false,
    );
    expect(getSettlementReturnIntent(world).status).toBe('armed');

    const ai = new BehaviorTreeAI({ seed: 70 });
    const harness = ai as unknown as {
      findFloor2ProgressObjective(
        world: GameWorld,
        playerEid: number,
        playerX: number,
        playerY: number,
      ): { x: number; y: number; reason: string } | null;
    };
    const target = harness.findFloor2ProgressObjective(
      world,
      player,
      world.stores.position.x[player]!,
      world.stores.position.y[player]!,
    );

    expect(target).not.toBeNull();
    expect(target!.x).toBeCloseTo(anchor.x, 6);
    expect(target!.y).toBeCloseTo(anchor.y, 6);
    expect(target!.reason).toBe(
      'Returning to the settlement to run maintenance (equip/shop/claim)',
    );
  });

  it('suppresses the settlement-return Progress branch while progress goals are suppressed, even when the router is armed', () => {
    const { world, player, anchor } = armEligibleSettlementReturnWorld(71);
    updateSettlementReturnIntent(
      world,
      player,
      world.stores.position.x[player]!,
      world.stores.position.y[player]!,
      anchor,
      false,
      false,
    );
    expect(getSettlementReturnIntent(world).status).toBe('armed');

    const ai = new BehaviorTreeAI({ seed: 71 });
    suppressProgressGoals(ai, world.frameCount + 1000);
    const harness = ai as unknown as {
      findFloor2ProgressObjective(
        world: GameWorld,
        playerEid: number,
        playerX: number,
        playerY: number,
      ): { x: number; y: number; reason: string } | null;
    };

    const target = harness.findFloor2ProgressObjective(
      world,
      player,
      world.stores.position.x[player]!,
      world.stores.position.y[player]!,
    );
    expect(target).toBeNull();
  });

  it('preserves ENGAGE combat priority over an armed settlement-return goal, and the router self-aborts (not stalls) under danger', () => {
    const { world, player, anchor } = armEligibleSettlementReturnWorld(72);
    setActiveWeapon(world, getWeaponDef('sword')!);

    const ai = new BehaviorTreeAI({ seed: 72 });
    const input = createInputState();

    // Poll 1: no threat nearby -> the router's unconditional pre-tick hook
    // arms it (idle -> armed happens within a single call), and Progress
    // routes the AI toward the settlement to run maintenance.
    ai.poll(input, world);
    const armedDecision = ai.getDecision();
    expect(getSettlementReturnIntent(world).status).toBe('armed');
    expect(armedDecision).toMatchObject({
      state: AIState.EXPLORE,
      targetX: anchor.x,
      targetY: anchor.y,
      reason: 'Returning to the settlement to run maintenance (equip/shop/claim)',
    });

    // Poll 2: a threat appears 5ft away (well within any engage radius) ->
    // combat wins, and the router safely self-aborts (never overridden or
    // silently stalled) rather than staying latched in a stale 'armed' state.
    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    spawnEnemy(world, px + 5, py, 20);
    ai.poll(input, world);

    expect(ai.getDecision().state).toBe(AIState.ENGAGE);
    expect(getSettlementReturnIntent(world).status).toBe('aborted-danger');
  });
});

describe('BehaviorTreeAI boss-chest objective', () => {
  const CHEST_REASON = 'Claiming boss chest equipment';

  /** Floor-1-style world with a boss chest 30 ft east of the player. */
  const chestWorld = (): { world: GameWorld; player: number; chest: number } => {
    const world = createTestWorld({ seed: 11 });
    const player = spawnPlayer(world, 0, 0);
    setActiveWeapon(world, getWeaponDef('sword')!);
    const chest = spawnBossChestEntity(world, 30, 0, 'boss-chest-test');
    return { world, player, chest };
  };

  it('routes to the chest, outranking Engage on a nearby enemy', () => {
    // A chest is one guaranteed piece of equipment, so it is treated like a
    // quest objective rather than like loot (loot sits below Engage and would
    // lose to any enemy that happened to be closer).
    const { world } = chestWorld();
    spawnEnemy(world, 8, 0, 20);

    const ai = new BehaviorTreeAI({ seed: 11 });
    ai.poll(createInputState(), world);

    expect(ai.getDecision()).toMatchObject({
      state: AIState.EXPLORE,
      targetX: 30,
      targetY: 0,
      reason: CHEST_REASON,
    });
  });

  it('yields to Retreat when the player is wounded with a threat nearby', () => {
    // "Treat them like quest objectives while still safely dodging" — survival
    // still owns the low-health case.
    const { world, player } = chestWorld();
    spawnEnemy(world, 10, 0, 20);
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 1;

    const ai = new BehaviorTreeAI({ seed: 11 });
    ai.poll(createInputState(), world);

    expect(ai.getDecision().state).toBe(AIState.RETREAT);
  });

  it('falls through to another branch instead of deadlocking on an unreachable chest', () => {
    const { world } = chestWorld();
    const ai = new BehaviorTreeAI({ seed: 11 });
    // Force the reachability verdict negative for every target, the same way a
    // chest sealed behind a locked boss door reads.
    (ai as unknown as { isTargetReachable: () => boolean }).isTargetReachable = () => false;

    ai.poll(createInputState(), world);

    expect(ai.getDecision().reason).not.toBe(CHEST_REASON);
  });

  it('stops targeting the chest once it has been picked up', () => {
    const { world, chest } = chestWorld();
    const ai = new BehaviorTreeAI({ seed: 11 });
    ai.poll(createInputState(), world);
    expect(ai.getDecision().reason).toBe(CHEST_REASON);

    // bossChestPickupSystem removes both the sidecar entry and the entity.
    world.bossChestEids.delete('boss-chest-test');
    removeEntity(world.ecs, chest);
    world.frameCount += 1;
    ai.poll(createInputState(), world);

    expect(ai.getDecision().reason).not.toBe(CHEST_REASON);
  });
});
