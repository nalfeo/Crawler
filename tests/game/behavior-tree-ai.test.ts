import { describe, expect, it } from 'vitest';
import {
  spawnBehaviorEnemy,
  spawnEnemy,
  spawnGold,
  spawnPlayer,
  spawnXpGem,
} from '../../src/core/helpers.js';
import { createInputState } from '../../src/shared/input.js';
import { getWeaponDef } from '../../src/shared/weaponDefs.js';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import {
  initializeFloor1Scenario,
  meetTutorialGoon,
  meetSpellQuestGiver,
  selectFloor1StarterWeapon,
} from '../../src/game/floorScenario.js';
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

function makeDiagonalCornerMap(): FloorMap {
  const tileMap = new TileMap(5, 5);
  const terrain = new Uint8Array(25);
  const config: MapConfig = {
    widthTiles: 5,
    heightTiles: 5,
    tileSizeFt: 4,
    biome: BiomeType.ARENA,
    seed: 1,
    roomWidthRange: [3, 5],
    roomHeightRange: [3, 5],
    maxRooms: 1,
    floorDensity: 1,
  };
  tileMap.fill(TilePresets.FLOOR);
  tileMap.setFlags(2, 1, TilePresets.WALL);
  tileMap.setFlags(1, 2, TilePresets.WALL);
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
    expect(decision.targetX).toBe(world.floor1?.objective.welcomeOfficePos.x);
    expect(decision.targetY).toBe(world.floor1?.objective.welcomeOfficePos.y);
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
    world.floorMap = makeDiagonalCornerMap();
    const ai = new BehaviorTreeAI({ seed: 7 }) as unknown as {
      hasClearLineOfSight: (
        world: GameWorld,
        startX: number,
        startY: number,
        endX: number,
        endY: number,
      ) => boolean;
    };

    expect(ai.hasClearLineOfSight(world, 6, 6, 10, 10)).toBe(false);
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

  describe('on-path loot detour (Track B opportunistic collect)', () => {
    it('detours toward loot within 5 ft of its forward path during quest navigation', () => {
      const s = pollQuestNavHeading(42);
      // Gem 10 ft dead ahead along the travel heading: inside the 15 ft grab radius
      // and squarely within the 5 ft forward corridor.
      spawnXpGem(s.world, s.px + s.ux * 10, s.py + s.uy * 10, 5);

      s.ai.poll(s.input, s.world);

      // Track A stays on the quest objective (Progress outranks Collect), so the
      // gem is ignored by Track A — the detour layer is what grabs it.
      expect(s.ai.getDecision().state).toBe(AIState.EXPLORE);
      const dbg = s.ai.getOpportunisticDebug();
      expect(Math.hypot(dbg.pullX, dbg.pullY)).toBeGreaterThan(0.5);
      // Pull is aligned with the heading (points at the on-path gem).
      expect(dbg.pullX * s.ux + dbg.pullY * s.uy).toBeGreaterThan(0.9);
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
      const dodgeDbg = dodging.getOpportunisticDebug();
      expect(Math.hypot(dodgeDbg.dodgeX, dodgeDbg.dodgeY)).toBeGreaterThan(0); // dodge active
      expect(dodgeDbg.pullX).toBe(0); // loot detour suppressed this frame
      expect(dodgeDbg.pullY).toBe(0);
    });

    it('dodges charging enemies while pathing to quest objectives', () => {
      const s = pollQuestNavHeading(42);
      const enemy = spawnEnemy(s.world, s.px + s.ux * 9, s.py + s.uy * 3, 20);
      const toPlayerX = s.px - (s.world.stores.position.x[enemy] ?? 0);
      const toPlayerY = s.py - (s.world.stores.position.y[enemy] ?? 0);
      const len = Math.hypot(toPlayerX, toPlayerY) || 1;
      s.world.stores.velocity.x[enemy] = (toPlayerX / len) * 0.375;
      s.world.stores.velocity.y[enemy] = (toPlayerY / len) * 0.375;

      s.ai.poll(s.input, s.world);

      expect(s.ai.getDecision().state).toBe(AIState.EXPLORE);
      expect(s.ai.getDecision().targetEid).not.toBeNull();
      const dbg = s.ai.getOpportunisticDebug();
      expect(Math.hypot(dbg.dodgeX, dbg.dodgeY)).toBeGreaterThan(0);
    });

    it('keeps the enemy-farm pull dormant unless explicitly weighted', () => {
      const buildWanderWorld = (): { world: GameWorld; cx: number; cy: number } => {
        const world = createTestWorld({ seed: 5 });
        world.floorMap = makeOpenRoom(60, 60);
        const cx = 120;
        const cy = 120;
        spawnPlayer(world, cx, cy);
        // Lone enemy 75 ft away: beyond the 50 ft Track A scan (so the AI just
        // idle-wanders, EXPLORE + null target) but within the 150 ft farm scan.
        spawnEnemy(world, cx + 75, cy, 20);
        return { world, cx, cy };
      };

      const idle = buildWanderWorld();
      const idleAi = new BehaviorTreeAI({ seed: 5 });
      idleAi.poll(createInputState(), idle.world);
      expect(idleAi.getDecision().state).toBe(AIState.EXPLORE);
      // Default farmPullWeight = 0 → the enemy-farm layer never fires.
      const dormant = idleAi.getOpportunisticDebug();
      expect(dormant.farmX).toBe(0);
      expect(dormant.farmY).toBe(0);

      // Same scenario with a non-zero farm weight DOES drift toward the enemy.
      const active = buildWanderWorld();
      const farmAi = new BehaviorTreeAI({ seed: 5, farmPullWeight: 1 });
      farmAi.poll(createInputState(), active.world);
      expect(farmAi.getDecision().state).toBe(AIState.EXPLORE);
      const farmDbg = farmAi.getOpportunisticDebug();
      expect(Math.hypot(farmDbg.farmX, farmDbg.farmY)).toBeGreaterThan(0);
      expect(farmDbg.farmX).toBeGreaterThan(0);
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
    world.floor1!.enemyArchetypes.set(rat, 'rat');

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
    world.floor1!.enemyArchetypes.set(questEnemy, 'rat');
    const spellNpcEid = world.floor1!.spellQuestGiverNpcEid;
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
    world.floor1!.enemyArchetypes.set(questEnemy, 'rat');
    const shopkeeperNpcEid = world.floor1!.shopkeeperNpcEid;
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

  it('engages nearby enemies before long NPC approach paths', () => {
    const world = createTestWorld({ seed: 12 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    meetTutorialGoon(world);
    world.playerLevel.level = 2;
    world.floor1!.objective.questCompleted = true;
    world.floorMap = makeOpenRoom(40, 20);
    world.stores.position.x[player] = 14;
    world.stores.position.y[player] = 14;

    const shopkeeperNpcEid = world.floor1!.shopkeeperNpcEid;
    expect(shopkeeperNpcEid).toBeDefined();
    world.stores.position.x[shopkeeperNpcEid!] = 38;
    world.stores.position.y[shopkeeperNpcEid!] = 14;

    spawnEnemy(world, 22, 14, 20);

    const ai = new BehaviorTreeAI({ seed: 12 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.reason).toContain('Clearing nearby threat before NPC interaction');
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
    world.floor1!.objective.questCompleted = true;

    const ai = new BehaviorTreeAI({ seed: 7 });
    const input = createInputState();
    ai.poll(input, world);
    const before = ai.getDecision();
    expect(before.reason).toContain('Spell Broker');

    meetSpellQuestGiver(world);
    ai.poll(input, world);
    const after = ai.getDecision();
    expect(after.reason).toContain('Slime Rat room');
    expect(after.targetX).toBe(world.floor1!.objective.slimeRatRoomPos.x);
    expect(after.targetY).toBe(world.floor1!.objective.slimeRatRoomPos.y);
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

  it('expands to defensive orbit when player HP drops below 40%', () => {
    // bat reach = 5.5ft. innerOrbit=4.5, outerOrbit=6.25 (4.5+1.75),
    // strikeGate=8.25 (5.5*1.5). Enemy attackRange=5 → safeOrbit=6.75 (5+1.75).
    // safeOrbit(6.75) > outerOrbit(6.25), so the healthy branch leaves desiredOrbit
    // unchanged (can't reach safety at full HP cap). In the wounded branch,
    // safeOrbitCap expands to strikeGate(8.25), so safeOrbit(6.75) fits and the orbit
    // is pushed out to 6.75ft — the defensive expansion.
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

    // WOUNDED player — 29% HP crosses MELEE_DEFENSIVE_HP_FRACTION (0.4), expanding
    // safeOrbitCap to the full strikeGate so the orbit is pushed out to safeOrbit.
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
    // outside the enemy's own attackRange rather than trading blows in the strike band.
    expect(woundedDist).toBeGreaterThan(healthyDist + 0.5);
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
});
