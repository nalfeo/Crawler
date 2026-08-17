/**
 * BT priority tests for the arena lock-in slot (Priority 1.5).
 *
 * Verifies:
 *   - When the player is locked in a spawner arena, `poll()` selects the
 *     spawner as the movement target instead of the default Progress goal
 *     (Tutorial Goon on a fresh Floor-1 world).
 *   - In lock-in scenarios, retreat yields so ArenaLockin can run defensive
 *     engagement instead of endless cage-kiting.
 *   - When no arena lock-in fires, normal Progress behavior is selected.
 */

import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { spawnEnemy, spawnPlayer, spawnSpawner } from '../../../src/core/spawners/combatants.js';
import { spawnGold } from '../../../src/core/helpers.js';
import {
  getSpawnerArchetype,
  getSpawnerArchetypeIndex,
} from '../../../src/game/spawners/registry.js';
import { createInputState } from '../../../src/shared/input.js';
import {
  initializeFloor1Scenario,
  selectFloor1StarterWeapon,
} from '../../../src/game/floorScenario.js';
import { createTestWorld } from '../../helpers/world-factory.js';
import { AIState } from '../../../src/game/ai/types.js';
import { activateHostileEncounter } from '../../../src/game/hostile-encounter-lifecycle.js';
import { FloorMap } from '../../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../../src/core/map/RoomGraph.js';
import { TileMap } from '../../../src/core/map/TileMap.js';
import { BiomeType, TilePresets, type MapConfig } from '../../../src/shared/map-types.js';

const RATS_NEST_INDEX = getSpawnerArchetypeIndex('rats-nest');
const RATS_NEST = getSpawnerArchetype('rats-nest')!;

function makeAdjacentRooms(): FloorMap {
  const width = 10;
  const height = 6;
  const tileMap = new TileMap(width, height);
  tileMap.fill(TilePresets.FLOOR);
  const roomGraph = new RoomGraph();
  roomGraph.add({ x: 0, y: 0, width: 6, height: 6 });
  roomGraph.add({ x: 5, y: 0, width: 5, height: 6 });
  const config: MapConfig = {
    widthTiles: width,
    heightTiles: height,
    tileSizeFt: 4,
    biome: BiomeType.ARENA,
    seed: 42,
    roomWidthRange: [4, 4],
    roomHeightRange: [4, 4],
    maxRooms: 2,
    floorDensity: 1,
  };
  return new FloorMap(config, tileMap, roomGraph, new Uint8Array(width * height), {
    x: 4,
    y: 2,
  });
}

function makeLockedSpawnerNearPlayer(
  world: ReturnType<typeof createTestWorld>,
  px: number,
  py: number,
): number {
  // Place spawner inside the disc from the player (open-fence path). We
  // override arenaState=1 directly instead of running spawnerArenaSystem so
  // the test is scoped to BT priority selection, not the arena state
  // machine (that's covered by spawner-arena.test.ts + integration).
  const spawnerEid = spawnSpawner(world, px + 2, py, RATS_NEST.hp, {
    defIndex: RATS_NEST_INDEX,
    contactDamage: RATS_NEST.contactDamage,
    arenaRadiusFt: 6,
  });
  world.stores.spawner.arenaState[spawnerEid] = 1; // locked
  world.stores.spawner.arenaKind[spawnerEid] = 1; // open-fence
  // Mirror createRingWallBarrier's ANALYTIC ring-WALL handle (tiles:[] + a
  // BarrierRingShape) so the detector's barrier-presence check (see
  // arena-lockin.ts) treats the AI as actually stuck — matches the real
  // open-fence runtime snapshot.
  world.spawnerArenaBarriers.set(spawnerEid, {
    id: 1,
    kind: 'fence',
    tiles: [],
    shape: { type: 'ring', cxFt: px + 2, cyFt: py, innerRadiusFt: 5, outerRadiusFt: 6 },
  });
  return spawnerEid;
}

function startStaircaseBossLockin(
  world: ReturnType<typeof createTestWorld>,
  px: number,
  py: number,
  bossOffsetX: number,
  bossOffsetY: number,
): number {
  const objective = world.floorScenario?.objective;
  const staircase = objective?.bossBattles.get('staircase');
  if (!staircase) {
    throw new Error('Missing staircase battle in Floor 1 objective setup');
  }
  const bossEid = spawnEnemy(world, px + bossOffsetX, py + bossOffsetY, 300);
  staircase.started = true;
  staircase.defeated = false;
  staircase.bossEid = bossEid;
  return bossEid;
}

function markEnemyIgnored(ai: BehaviorTreeAI, eid: number, untilFrame: number): void {
  (ai as unknown as { ignoredEnemyUntilFrame: Map<number, number> }).ignoredEnemyUntilFrame.set(
    eid,
    untilFrame,
  );
}

describe('BT — arena lock-in priority (1.5)', () => {
  it('selects the spawner as the movement target when locked in an arena', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    // Without the lock-in, Progress would target the Tutorial Goon (covered
    // by tests/game/behavior-tree-ai.test.ts). Here we assert that adding a
    // locked spawner right next to the player overrides that decision.
    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    const spawnerEid = makeLockedSpawnerNearPlayer(world, px, py);

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.targetEid).toBe(spawnerEid);
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.reason.toLowerCase()).toContain('arena');
    // Progression target (Tutorial Goon) must NOT be the selected target.
    expect(decision.reason.toLowerCase()).not.toContain('tutorial goon');
  });

  it('spawner lock-in keeps spacing movement instead of parking on spawner center', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    const spawnerEid = makeLockedSpawnerNearPlayer(world, px, py);
    const sx = world.stores.position.x[spawnerEid]!;
    const sy = world.stores.position.y[spawnerEid]!;

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.targetEid).toBe(spawnerEid);
    expect(decision.targetX).not.toBeNull();
    expect(decision.targetY).not.toBeNull();
    const tx = decision.targetX!;
    const ty = decision.targetY!;
    expect(Math.hypot(tx - sx, ty - sy)).toBeGreaterThan(0.1);
    expect(decision.reason.toLowerCase()).toContain('arena lock-in');
    expect(decision.reason.toLowerCase()).not.toContain('attacking spawner');
  });

  it('falls through to normal Progress behavior when no arena lock-in fires', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    // No spawner — Progress (Tutorial Goon) must be selected.

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.reason).toContain('Tutorial Goon');
  });

  it('invalidates stale pre-encounter targeting before reacting to a new lock-in', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    const input = createInputState();
    const ai = new BehaviorTreeAI({ seed: 42 });

    ai.poll(input, world);
    const staleTargetEid = ai.getDecision().targetEid;
    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    const bossEid = startStaircaseBossLockin(world, px, py, 4, 0);
    markEnemyIgnored(ai, bossEid, world.frameCount + 300);
    world.frameCount = 17;
    activateHostileEncounter(world);

    ai.poll(input, world);

    expect(ai.getDecision().targetEid).toBe(bossEid);
    expect(ai.getDecision().targetEid).not.toBe(staleTargetEid);
    expect(ai.getDecision().reason).toContain('boss');
    expect(ai.getHostileEncounterLifecycleDebug()).toEqual({
      observedRevision: 1,
      invalidationCount: 1,
      lastInvalidationFrame: 17,
    });
  });

  it('does not invalidate decisions again on ordinary non-transition polls', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    const input = createInputState();
    const ai = new BehaviorTreeAI({ seed: 42 });

    activateHostileEncounter(world);
    ai.poll(input, world);
    const firstDecision = ai.getDecision();
    ai.poll(input, world);

    expect(ai.getHostileEncounterLifecycleDebug().invalidationCount).toBe(1);
    expect(ai.getDecision().state).toBe(firstDecision.state);
    expect(ai.getDecision().targetEid).toBe(firstDecision.targetEid);
    expect(ai.getDecision().reason).toBe(firstDecision.reason);
  });

  it('low-HP lock-in uses defensive arena engagement instead of retreat loops', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    // Wound the player severely so retreat qualifies (retreatThreshold=0.15).
    world.stores.health.current[player] = 5;
    world.stores.health.max[player] = 100;

    // Spawn a nearby enemy and lock in the arena simultaneously. In lock-in,
    // retreat must yield so the AI commits to the objective instead of running
    // in circles inside a sealed space.
    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    spawnEnemy(world, px + 3, py, 20);
    const spawnerEid = makeLockedSpawnerNearPlayer(world, px, py);

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.targetEid).toBe(spawnerEid);
    expect(decision.reason.toLowerCase()).toContain('arena');
  });

  it('boss lock-in preserves point-blank escape from a long-range boss', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    world.stores.health.current[player] = 5;
    world.stores.health.max[player] = 100;

    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    const bossEid = startStaircaseBossLockin(world, px, py, 3, 0);
    world.stores.enemyBehavior.attackRange[bossEid] = 280;

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.RETREAT);
    expect(decision.targetEid).toBeNull();
  });

  it('ignores loot outside the arena while locked in (arena objective wins)', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    const spawnerEid = makeLockedSpawnerNearPlayer(world, px, py);
    // A juicy gold pile just outside the arena disc (radius 6). While locked,
    // the AI must NOT break lock-in to Collect it — the spawner (the only exit)
    // outranks every outside goal (Collect is priority 5, lock-in is 1.5).
    spawnGold(world, px + 40, py, 100);

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.targetEid).toBe(spawnerEid);
    expect(decision.reason.toLowerCase()).toContain('arena');
    expect(decision.state).not.toBe(AIState.COLLECT);
  });

  it('boss lock-in: keeps targeting the boss when add pressure is not immediate', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 30;

    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    const bossEid = startStaircaseBossLockin(world, px, py, 4, 0);
    spawnEnemy(world, px + 10, py, 40); // non-immediate add: outside melee strike gate

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.targetEid).toBe(bossEid);
    expect(decision.reason).toContain('boss');
  });

  it('boss lock-in: wounded player clears an add inside immediate pressure range', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 30;

    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    // Exact tied geometry: boss at (px+7, py) and add at (px, py+7) are both
    // 7 ft away. Without the excludeEid fix, the boss (lower eid) would win
    // the distance-tie sort and `nearestEnemy.eid === target.eid`, so
    // defensiveAddPressure would never fire and the wounded AI would stay on
    // the boss instead of clearing the add.
    const bossEid = startStaircaseBossLockin(world, px, py, 7, 0);
    const addEid = spawnEnemy(world, px, py + 7, 40);

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.targetEid).toBe(addEid);
    expect(decision.targetEid).not.toBe(bossEid);
    expect(decision.reason).toContain('clearing add');
  });

  it('boss lock-in: healthy player preserves boss focus at equal add pressure', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 80;

    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    // Exact tied geometry: boss at (px+7, py) and add at (px, py+7) both at
    // distance 7. A healthy player (80% HP ≥ ARENA_LOCKIN_DEFENSIVE_HP_FRACTION
    // 60%) does not trigger defensiveAddPressure, and the add is not closer
    // enough by ARENA_LOCKIN_ADD_HYSTERESIS_FT (3 ft) to steal priority, so
    // the AI correctly maintains boss focus.
    const bossEid = startStaircaseBossLockin(world, px, py, 7, 0);
    spawnEnemy(world, px, py + 7, 40);

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.targetEid).toBe(bossEid);
    expect(decision.reason).toContain('boss');
  });

  it('boss lock-in: ignores closer enemies outside the locked boss room', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    world.floorMap = makeAdjacentRooms();
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 30;

    const playerPos = world.floorMap.tileToWorld(4, 2);
    const bossPos = world.floorMap.tileToWorld(2, 2);
    const outsidePos = world.floorMap.tileToWorld(6, 2);
    world.stores.position.x[player] = playerPos.x;
    world.stores.position.y[player] = playerPos.y;
    const bossEid = startStaircaseBossLockin(
      world,
      playerPos.x,
      playerPos.y,
      bossPos.x - playerPos.x,
      bossPos.y - playerPos.y,
    );
    const outsideEnemyEid = spawnEnemy(world, outsidePos.x, outsidePos.y, 40);

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.targetEid).toBe(bossEid);
    expect(decision.targetEid).not.toBe(outsideEnemyEid);
    expect(decision.reason).toContain('boss');
  });

  it('boss lock-in: ignored closest add is neither selected nor counted for crowd pressure', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 80;

    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    const bossEid = startStaircaseBossLockin(world, px, py, 4, 0);
    const ignoredAddEid = spawnEnemy(world, px + 4, py + 0.5, 40);
    for (let i = 0; i < 9; i += 1) {
      const angle = ((i + 1) / 10) * Math.PI * 2;
      const radius = 4.5 + (i % 2);
      spawnEnemy(world, px + Math.cos(angle) * radius, py + Math.sin(angle) * radius, 40);
    }

    const ai = new BehaviorTreeAI({ seed: 42 });
    markEnemyIgnored(ai, ignoredAddEid, world.frameCount + 300);
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.targetEid).toBe(bossEid);
    expect(decision.targetEid).not.toBe(ignoredAddEid);
    expect(decision.reason).toContain('boss');
  });

  it('boss lock-in: ignores a nearby ignored add and stays on the boss target', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 30;

    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    const bossEid = startStaircaseBossLockin(world, px, py, 4, 0);
    const ignoredStickyAddEid = spawnEnemy(world, px + 3.8, py + 0.4, 40);
    // Non-ignored add placed outside the 9-ft defensive-pressure zone so a
    // wounded player's add-pressure logic fires only for non-ignored adds that
    // are actually close. The ignored add above must be skipped entirely.
    spawnEnemy(world, px + 10, py, 40);

    const ai = new BehaviorTreeAI({ seed: 42 });
    markEnemyIgnored(ai, ignoredStickyAddEid, world.frameCount + 300);
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.targetEid).toBe(bossEid);
    expect(decision.targetEid).not.toBe(ignoredStickyAddEid);
    expect(decision.reason).toContain('boss');
  });
});
