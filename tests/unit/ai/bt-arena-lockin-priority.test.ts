/**
 * BT priority tests for the arena lock-in slot (Priority 1.5).
 *
 * Verifies:
 *   - When the player is locked in a spawner arena, `poll()` selects the
 *     spawner as the movement target instead of the default Progress goal
 *     (Tutorial Goon on a fresh Floor-1 world).
 *   - Retreat (Priority 1) still takes precedence over ArenaLockin.
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

const RATS_NEST_INDEX = getSpawnerArchetypeIndex('rats-nest');
const RATS_NEST = getSpawnerArchetype('rats-nest')!;

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

  it('retreat (priority 1) still wins over arena lock-in at low HP with a nearby threat', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    // Wound the player severely so retreat qualifies (retreatThreshold=0.15).
    world.stores.health.current[player] = 5;
    world.stores.health.max[player] = 100;

    // Retreat needs a nearby Enemy-tagged threat within retreatDangerRadius
    // (20 ft). Spawn one AND set up the arena lock-in — both conditions hold
    // simultaneously, and retreat must win.
    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    spawnEnemy(world, px + 3, py, 20);
    makeLockedSpawnerNearPlayer(world, px, py);

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.RETREAT);
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

  it('boss lock-in: clears an immediate add at defensive melee HP before resuming the boss', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 30; // below MELEE_DEFENSIVE_HP_FRACTION (0.4), above retreat

    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    const bossEid = startStaircaseBossLockin(world, px, py, 4, 0);
    const addEid = spawnEnemy(world, px + 4, py + 1, 40);

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.targetEid).toBe(addEid);
    expect(decision.targetEid).not.toBe(bossEid);
    expect(decision.reason).toContain('immediate add');
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

  it('boss lock-in: peels nearby adds under melee crowd pressure even at healthy HP', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    world.stores.health.max[player] = 100;
    world.stores.health.current[player] = 80; // healthy: crowd pressure, not low-hp survival mode

    const px = world.stores.position.x[player]!;
    const py = world.stores.position.y[player]!;
    const bossEid = startStaircaseBossLockin(world, px, py, 4, 0);
    for (let i = 0; i < 10; i += 1) {
      const angle = (i / 10) * Math.PI * 2;
      const radius = 4 + (i % 3);
      spawnEnemy(world, px + Math.cos(angle) * radius, py + Math.sin(angle) * radius, 40);
    }

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.ENGAGE);
    expect(decision.targetEid).not.toBe(bossEid);
    expect(decision.reason).toContain('add pressure');
  });
});
