import { describe, expect, it } from 'vitest';
import { spawnBehaviorEnemy, spawnEnemy, spawnGold, spawnPlayer } from '../../src/core/helpers.js';
import { createInputState } from '../../src/shared/input.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import {
  initializeFloor1Scenario,
  meetTutorialGoon,
  selectFloor1StarterWeapon,
} from '../../src/game/floor1Scenario.js';
import { setActiveWeapon } from '../../src/game/weaponSystem.js';
import type { GameWorld } from '../../src/core/world.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import type { TilePoint } from '../../src/core/map/pathfinding.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { AI_TYPE } from '../../src/game/enemyAISystem.js';
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
      tileMap.flags[idx] = isBorder || x === wallColumnX ? TilePresets.WALL : TilePresets.FLOOR;
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

  it('collects gold reachable across open ground', () => {
    const world = createTestWorld({ seed: 99 });
    world.floorMap = makeOpenRoom(16, 16);
    spawnPlayer(world, 112, 112); // tile (3,3)
    // Gold ~288px away at tile (12,3): inside the collect scan radius and, with no
    // interior wall, reachable by A* — so it remains a valid COLLECT goal.
    spawnGold(world, 400, 112, 3);

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
    spawnPlayer(world, 112, 112); // tile (3,3) — left half
    spawnGold(world, 400, 112, 3); // tile (12,3) — right half, unreachable

    const ai = new BehaviorTreeAI({ seed: 99 });
    const input = createInputState();
    ai.poll(input, world);

    const decision = ai.getDecision();
    // The unreachable gold must not become a collect goal (pre-fix the AI parked
    // on it and wiggled until the dwell watchdog abandoned it ~180 frames later).
    expect(decision.state).not.toBe(AIState.COLLECT);
    expect(decision.reason).not.toContain('gold');
  });

  it('drops a previously collectable gold target once it becomes unreachable', () => {
    const world = createTestWorld({ seed: 99 });
    world.floorMap = makeOpenRoom(16, 16);
    spawnPlayer(world, 112, 112);
    spawnGold(world, 400, 112, 3);

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

  it('expands to defensive orbit when player HP drops below 40%', () => {
    // bat reach = ftToPx(5.5) = 44px. innerOrbit=36, outerOrbit=50 (36+14),
    // strikeGate=66 (44*1.5). Enemy attackRange=40 → safeOrbit=54 (40+14).
    // safeOrbit(54) > outerOrbit(50), so the healthy branch leaves desiredOrbit
    // unchanged (can't reach safety at full HP cap). In the wounded branch,
    // safeOrbitCap expands to strikeGate(66), so safeOrbit(54) fits and the orbit
    // is pushed out to 54px — the defensive expansion.
    const bat = getWeaponDef('baseball-bat')!;

    // HEALTHY player — full HP, orbit stays in the normal strike band.
    const healthyWorld = createTestWorld({ seed: 7 });
    spawnPlayer(healthyWorld, 0, 0);
    spawnBehaviorEnemy(healthyWorld, 60, 0, 40, AI_TYPE.CHASE, 40, 200, 40);
    healthyWorld.elapsedMs = 5000;
    setActiveWeapon(healthyWorld, bat);
    const healthyAi = new BehaviorTreeAI({ seed: 7 });
    healthyAi.poll(createInputState(), healthyWorld);
    const healthyDecision = healthyAi.getDecision();
    const healthyDist = Math.hypot(healthyDecision.targetX! - 60, healthyDecision.targetY!);

    // WOUNDED player — 29% HP crosses MELEE_DEFENSIVE_HP_FRACTION (0.4), expanding
    // safeOrbitCap to the full strikeGate so the orbit is pushed out to safeOrbit.
    const woundedWorld = createTestWorld({ seed: 7 });
    const woundedPlayer = spawnPlayer(woundedWorld, 0, 0);
    // Set HP to 29% of max (100) to cross the 40% MELEE_DEFENSIVE_HP_FRACTION.
    woundedWorld.stores.health.current[woundedPlayer] = 29;
    spawnBehaviorEnemy(woundedWorld, 60, 0, 40, AI_TYPE.CHASE, 40, 200, 40);
    woundedWorld.elapsedMs = 5000;
    setActiveWeapon(woundedWorld, bat);
    const woundedAi = new BehaviorTreeAI({ seed: 7 });
    woundedAi.poll(createInputState(), woundedWorld);
    const woundedDecision = woundedAi.getDecision();
    const woundedDist = Math.hypot(woundedDecision.targetX! - 60, woundedDecision.targetY!);

    expect(healthyDecision.reason).toContain('Kiting');
    expect(woundedDecision.reason).toContain('Kiting');
    // Wounded AI targets farther from the enemy: defensive orbit expansion holds it
    // outside the enemy's own attackRange rather than trading blows in the strike band.
    expect(woundedDist).toBeGreaterThan(healthyDist + 4);
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

  // Regression guard for the BFS path-resolver refactor (PR #324). The goal-tile
  // resolver flood-fills `dist` once and reads it via `dist[y * width + x]`. A goal
  // from FloorMap.pixelToTile is NOT clamped to the map, so an out-of-bounds goal
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
});
