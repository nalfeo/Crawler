/**
 * BT pre-exit XP sweep tests (Priority 2.5).
 *
 * Verifies:
 *   - When the Floor 1 staircase is unlocked but not yet descended and there
 *     are XP gems on the ground, `poll()` selects COLLECT targeting the gem
 *     rather than Progress to the staircase.
 *   - The same sweep window works for the distinct Floor 2 staircase guards.
 *   - The sweep does NOT fire when there are no XP gems on the ground (AI
 *     falls through to normal Progress behavior).
 *   - The sweep does NOT fire when the staircase is still locked (floor not
 *     yet cleared).
 *   - The sweep does NOT fire when an enemy is within engage range, including
 *     enemies currently ignored for target selection.
 */

import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { spawnEnemy, spawnPlayer } from '../../../src/core/spawners/combatants.js';
import { spawnXpGem } from '../../../src/core/spawners/pickups.js';
import {
  initializeFloor1Scenario,
  selectFloor1StarterWeapon,
} from '../../../src/game/floorScenario.js';
import { initializeFloor2Scenario } from '../../../src/game/floor2Scenario.js';
import { createInputState } from '../../../src/shared/input.js';
import { createTestWorld } from '../../helpers/world-factory.js';
import { AIState } from '../../../src/game/ai/types.js';

/** Unlock the Floor 1 staircase without marking it discovered (= sweep window). */
function openSweepWindow(world: ReturnType<typeof createTestWorld>): void {
  const obj = world.floorScenario?.objective;
  if (!obj) throw new Error('No floor scenario objective');
  obj.staircaseUnlocked = true;
  obj.staircaseDiscovered = false;
}

function playerPos(
  world: ReturnType<typeof createTestWorld>,
  playerEid: number,
): { x: number; y: number } {
  return {
    x: world.stores.position.x[playerEid] ?? 0,
    y: world.stores.position.y[playerEid] ?? 0,
  };
}

describe('BT — pre-exit XP sweep (Priority 2.5)', () => {
  it('targets the nearest XP gem when the floor is cleared and XP is on the ground', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    openSweepWindow(world);

    const { x: px, y: py } = playerPos(world, player);
    const gemEid = spawnXpGem(world, px + 5, py, 10);

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.COLLECT);
    expect(decision.targetEid).toBe(gemEid);
    expect(decision.reason.toLowerCase()).toContain('sweep');
  });

  it('falls through to Progress when the floor is cleared but no XP gems remain', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    openSweepWindow(world);
    // No XP gems spawned — sweep has nothing to target, Progress should win.

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    // Pre-exit sweep has no XP to collect, Progress takes over.
    expect(decision.state).not.toBe(AIState.COLLECT);
  });

  it('does NOT fire the sweep when the staircase is still locked', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    // Staircase locked → floor not cleared → sweep should not fire.
    const obj = world.floorScenario?.objective;
    if (obj) {
      obj.staircaseUnlocked = false;
      obj.staircaseDiscovered = false;
    }

    const { x: px, y: py } = playerPos(world, player);
    spawnXpGem(world, px + 5, py, 10);

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    // Sweep should not fire while the floor is still active.
    const decision = ai.getDecision();
    expect(decision.reason.toLowerCase()).not.toContain('sweep');
  });

  it('does NOT fire once the staircase has been discovered (player already descending)', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    const obj = world.floorScenario?.objective;
    if (obj) {
      obj.staircaseUnlocked = true;
      obj.staircaseDiscovered = true; // already descending
    }

    const { x: px, y: py } = playerPos(world, player);
    spawnXpGem(world, px + 5, py, 10);

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.reason.toLowerCase()).not.toContain('sweep');
  });

  it('targets XP on Floor 2 once the staircase is unlocked, spawned, positioned, and undiscovered', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor2Scenario(world, player);

    const floor2State = world.floorExtendedState?.familyState;
    if (!floor2State) throw new Error('No Floor 2 family state');
    const { x: px, y: py } = playerPos(world, player);
    floor2State.staircaseUnlocked = true;
    floor2State.staircaseSpawned = true;
    floor2State.staircaseDiscovered = false;
    floor2State.staircasePos = { x: px, y: py };

    const gemEid = spawnXpGem(world, px + 5, py, 10);

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).toBe(AIState.COLLECT);
    expect(decision.targetEid).toBe(gemEid);
    expect(decision.reason.toLowerCase()).toContain('sweep');
  });

  it.each([
    'staircase still locked',
    'staircase not spawned yet',
    'staircase already discovered',
    'staircase position missing',
  ] as const)('does NOT fire on Floor 2 when %s', (caseLabel: string) => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor2Scenario(world, player);

    const floor2State = world.floorExtendedState?.familyState;
    if (!floor2State) throw new Error('No Floor 2 family state');
    const { x: px, y: py } = playerPos(world, player);
    floor2State.staircaseUnlocked = true;
    floor2State.staircaseSpawned = true;
    floor2State.staircaseDiscovered = false;
    floor2State.staircasePos = { x: px, y: py };
    switch (caseLabel) {
      case 'staircase still locked':
        floor2State.staircaseUnlocked = false;
        break;
      case 'staircase not spawned yet':
        floor2State.staircaseSpawned = false;
        break;
      case 'staircase already discovered':
        floor2State.staircaseDiscovered = true;
        break;
      case 'staircase position missing':
        delete floor2State.staircasePos;
        break;
    }
    spawnXpGem(world, px + 5, py, 10);

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.reason.toLowerCase()).not.toContain('sweep');
  });

  it('does NOT sweep when an ignored enemy is already inside engage range', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);
    openSweepWindow(world);

    const { x: px, y: py } = playerPos(world, player);
    spawnXpGem(world, px + 5, py, 10);
    const enemy = spawnEnemy(world, px + 6, py, 20);

    const ai = new BehaviorTreeAI({ seed: 42 });
    const harness = ai as unknown as {
      ignoredEnemyUntilFrame: Map<number, number>;
    };
    harness.ignoredEnemyUntilFrame.set(enemy, world.frameCount + 120);

    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.state).not.toBe(AIState.COLLECT);
    expect(decision.reason.toLowerCase()).not.toContain('sweep');
  });
});
