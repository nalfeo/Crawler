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
  // Simulate raiseFence's real barrier snapshot so the detector's barrier-
  // presence check (see arena-lockin.ts) treats the AI as actually stuck.
  world.spawnerArenaBarriers.set(spawnerEid, { id: 1, kind: 'fence', tiles: [0] });
  return spawnerEid;
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
});
