import { describe, expect, it } from 'vitest';
import { spawnBehaviorEnemy, spawnEnemy, spawnGold, spawnPlayer } from '../../src/core/helpers.js';
import { createInputState } from '../../src/shared/input.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { AI_TYPE } from '../../src/game/enemyAISystem.js';
import {
  initializeFloor1Scenario,
  meetShopkeeper,
  meetTutorialGoon,
  selectFloor1StarterWeapon,
} from '../../src/game/floor1Scenario.js';
import { questSystem } from '../../src/core/systems/questSystem.js';
import { setActiveWeapon } from '../../src/game/weaponSystem.js';
import type { GameWorld } from '../../src/core/world.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { AIState } from '../../src/game/ai/types.js';
import { BiomeType, TilePresets, type MapConfig } from '../../src/shared/map-types.js';

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

  it('micro-spaces with weapon cadence: pokes in when ready, eases out on cooldown', () => {
    // Baseball-bat reach = ftToPx(5.5) = 44px, strike gate = 66px. Enemy at 30px
    // is inside the gate so the player kites. When the swing is READY it pokes in
    // toward the strike band; right after firing (on cooldown) it eases out toward
    // the recover band — the human "hold ground + micro forward/back" tactic. This
    // in/out delta was dead before the fix (inner === outer orbit radius).
    const bat = getWeaponDef('baseball-bat')!;

    // READY: the last swing was a full cooldown ago.
    const readyWorld = createTestWorld({ seed: 7 });
    spawnPlayer(readyWorld, 0, 0);
    spawnEnemy(readyWorld, 30, 0, 40);
    readyWorld.elapsedMs = 5000;
    setActiveWeapon(readyWorld, bat); // lastFireMs = 5000 - cooldown → ready now
    const readyAi = new BehaviorTreeAI({ seed: 7 });
    readyAi.poll(createInputState(), readyWorld);
    const readyDecision = readyAi.getDecision();
    const readyDist = Math.hypot(readyDecision.targetX! - 30, readyDecision.targetY!);

    // ON COOLDOWN: rewind the clock to the instant of the last shot.
    const cooldownWorld = createTestWorld({ seed: 7 });
    spawnPlayer(cooldownWorld, 0, 0);
    spawnEnemy(cooldownWorld, 30, 0, 40);
    cooldownWorld.elapsedMs = 5000;
    setActiveWeapon(cooldownWorld, bat); // lastFireMs = 5000 - cooldown
    cooldownWorld.elapsedMs = 5000 - bat.cooldownMs; // elapsed == lastFire → just fired
    const cooldownAi = new BehaviorTreeAI({ seed: 7 });
    cooldownAi.poll(createInputState(), cooldownWorld);
    const cooldownDecision = cooldownAi.getDecision();
    const cooldownDist = Math.hypot(cooldownDecision.targetX! - 30, cooldownDecision.targetY!);

    expect(readyDecision.reason).toContain('Kiting');
    expect(cooldownDecision.reason).toContain('Kiting');
    // The cooldown step holds the enemy farther away (dodge between hits); the
    // ready step pokes in closer to land the swing.
    expect(cooldownDist).toBeGreaterThan(readyDist + 4);
  });

  it('expands orbit to defensive wide-band when player HP drops below 40%', () => {
    // Sword reach = 40px; strike gate = 60px (reach × 1.5). Normal outerOrbit
    // caps at 50px (innerOrbit 36 + dodge amplitude 14). When wounded below the
    // defensive threshold (40% HP), safeOrbitCap expands to the full strike gate
    // (60px) so the AI can stand just outside an enemy's attackRange and poke
    // from safety. Use a CHASE enemy with attackRange = 40px so safeOrbit = 54px:
    //   - Full health: safeOrbitCap = outerOrbit = 50  → 54 > 50 → no expansion.
    //   - Low health:  safeOrbitCap = strikeGate = 60  → 54 ≤ 60 → bumps orbit to 54+.
    const fullHpWorld = createTestWorld({ seed: 7 });
    spawnPlayer(fullHpWorld, 0, 0);
    // attackRange in pixels: the stores store raw px. ftToPx(5)=40, safeOrbit=40+14=54.
    const ATTACK_RANGE_PX = 40;
    spawnBehaviorEnemy(fullHpWorld, 30, 0, 20, AI_TYPE.CHASE, 2, 200, ATTACK_RANGE_PX);
    setActiveWeapon(fullHpWorld, getWeaponDef('sword')!);
    // Full health: no expansion.
    const fullAi = new BehaviorTreeAI({ seed: 7 });
    fullAi.poll(createInputState(), fullHpWorld);
    const fullDist = Math.hypot(fullAi.getDecision().targetX! - 30, fullAi.getDecision().targetY!);

    const lowHpWorld = createTestWorld({ seed: 7 });
    const lowPlayer = spawnPlayer(lowHpWorld, 0, 0);
    spawnBehaviorEnemy(lowHpWorld, 30, 0, 20, AI_TYPE.CHASE, 2, 200, ATTACK_RANGE_PX);
    setActiveWeapon(lowHpWorld, getWeaponDef('sword')!);
    // Wound to 30% (below the 40% defensive threshold).
    lowHpWorld.stores.health.current[lowPlayer] = 30;
    const lowAi = new BehaviorTreeAI({ seed: 7 });
    lowAi.poll(createInputState(), lowHpWorld);
    const lowDist = Math.hypot(lowAi.getDecision().targetX! - 30, lowAi.getDecision().targetY!);

    expect(lowAi.getDecision().reason).toContain('Kiting');
    // Defensive orbit (low HP) must sit farther from the enemy than full-health orbit.
    // At full HP: safeOrbitCap = outerOrbit = 50px, so safeOrbit (54px) is unreachable
    // and the step lands at ~52-53px from the enemy.
    // At low HP:  safeOrbitCap = strikeGate = 60px, so safeOrbit (54px) IS reachable
    // and the step targets ~57px — measurably farther.
    expect(lowDist).toBeGreaterThan(fullDist + 3);
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
    world.stores.position.x[player] = 112;
    world.stores.position.y[player] = 112;

    // Quest enemy inside the sword strike gate (reach 40px, gate 60px). Use an
    // open-room floor map so the fixture isolates the progress-to-engage handoff
    // from dungeon reachability noise. The old Progress branch walked straight
    // onto the enemy center; it must now route through planEngagement and kite
    // (same as Engage/Hunt).
    const rat = spawnEnemy(world, 142, 112, 20);
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

  it('approaches a distant enemy to the close ranged standoff with a ranged weapon', () => {
    // Bow range = 44ft × 8px/ft = 352px. The AI now uses a deliberately close
    // standoff: max(CONTACT_SAFE_ORBIT_PX=36, min(352 × 0.5, RANGED_STANDOFF_ABS_PX=48))
    // = 48px. Projectiles fire at the enemy's CURRENT position with no leading, so
    // a tight standoff is what makes shots actually connect with wandering swarm
    // enemies (the bow was nearly useless at the old 264px standoff). Enemy at
    // 350px is within the engage radius and far beyond 48px, so the AI must plan a
    // target at ~48px from the enemy, not at the enemy's position.
    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 350, 0, 20);
    setActiveWeapon(world, getWeaponDef('bow')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.reason).toContain('Closing to ranged standoff');
    // Target must be between the player and the enemy (approaching), but not at
    // the enemy position (not walking onto it).
    expect(decision.targetX).not.toBeNull();
    expect(decision.targetX!).toBeGreaterThan(0);
    expect(decision.targetX!).toBeLessThan(350);
    // Target should land close to the absolute standoff distance from the enemy.
    const standoffPx = 48;
    expect(decision.targetX!).toBeCloseTo(350 - standoffPx, 0);
  });

  it('orbits away from enemies that are closer than ranged standoff distance', () => {
    // Enemy at 30px is inside the close bow standoff band (48px). The orbit step
    // must push the AI away (targetX < 0 when enemy is on the +X side).
    const world = createTestWorld({ seed: 7 });
    spawnPlayer(world, 0, 0);
    spawnEnemy(world, 30, 0, 20);
    setActiveWeapon(world, getWeaponDef('bow')!);

    const ai = new BehaviorTreeAI({ seed: 7 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.reason).toContain('Ranged orbit');
    // Radial correction pushes the AI away from the enemy (negative X when enemy
    // is at +X), so the target must be to the left of the player's start.
    expect(decision.targetX!).toBeLessThan(0);
  });

  it('skips the merchant sub-quest and heads to the Spell Broker when floor clock is urgent', () => {
    // When > 75% of the floor timer has elapsed the AI must stop spending time on
    // the optional merchant errand and drive straight to the boss-battle path so
    // the run doesn't time out on gold-farming or prize-retrieval.
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    // Advance to the post-kill-quest state with shopkeeper not yet met.
    meetTutorialGoon(world);
    world.playerLevel.level = 2;
    world.floor1!.objective.questCompleted = true;
    // No FLOOR1_SHOP_QUEST_ID in questLog → shopStage === 'not-met'.

    const ai = new BehaviorTreeAI({ seed: 42 });

    // Before clock urgency: Progress should target the shopkeeper.
    ai.poll(createInputState(), world);
    const earlyDecision = ai.getDecision();
    expect(earlyDecision.reason).toContain('Shopkeeper');

    // At 80% of deadline: shopkeeper sub-quest is skipped in favour of the Spell Broker.
    world.elapsedMs = world.floor1!.objective.deadlineMs * 0.8;
    const lateAi = new BehaviorTreeAI({ seed: 42 });
    lateAi.poll(createInputState(), world);
    const lateDecision = lateAi.getDecision();
    expect(lateDecision.reason).not.toContain('Shopkeeper');
    expect(lateDecision.reason).toContain('Spell Broker');
  });

  it('routes fetch-item navigation through the DroppedItem entity to avoid tile-A* wiggle', () => {
    // When in the awaiting-prize stage the AI should track the questItemEid entity
    // directly (not just the fixed spawn-position) so the close-approach direct-slide
    // activates and the body physically overlaps the item for collection.
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    // Advance to the awaiting-prize shopkeeper stage.
    meetTutorialGoon(world);
    world.playerLevel.level = 2;
    world.floor1!.objective.questCompleted = true;
    // meetShopkeeper requires the leveling quest to be complete.
    world.goalFlags.set('floor1-leveling-quest-complete', true);
    meetShopkeeper(world); // now sets shopStage → 'awaiting-prize'
    questSystem(world); // flush the quest.npc.talked event so quest.done['meet-merchant'] is set

    const questItemEid = world.floor1!.questItemEid!;
    expect(questItemEid).toBeDefined();
    // The quest item should be spawned at questItemPos.
    const qx = world.stores.position.x[questItemEid]!;
    const qy = world.stores.position.y[questItemEid]!;

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);
    const decision = ai.getDecision();

    expect(decision.reason).toContain('fetch item');
    // Decision must target the entity's pixel position (not a different fixed point).
    expect(decision.targetX).toBeCloseTo(qx, 0);
    expect(decision.targetY).toBeCloseTo(qy, 0);
    // The entity EID must be carried through so watchdogs and close-approach logic
    // can reference the live entity instead of an anonymous position.
    expect(decision.targetEid).toBe(questItemEid);
  });
});
