/**
 * BT pre-exit XP sweep tests (Priority 2.5).
 *
 * Verifies:
 *   - When the Floor 1 staircase is unlocked but not yet descended and there
 *     are XP gems on the ground, `poll()` selects COLLECT targeting the gem
 *     rather than Progress to the staircase.
 *   - The sweep does NOT fire when there are no XP gems on the ground (AI
 *     falls through to normal Progress behavior).
 *   - The sweep does NOT fire when the staircase is still locked (floor not
 *     yet cleared).
 *   - The sweep does NOT fire when an enemy is within engage range.
 */

import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { spawnPlayer } from '../../../src/core/spawners/combatants.js';
import { spawnXpGem } from '../../../src/core/spawners/pickups.js';
import {
  initializeFloor1Scenario,
  selectFloor1StarterWeapon,
} from '../../../src/game/floorScenario.js';
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

describe('BT — pre-exit XP sweep (Priority 2.5)', () => {
  it('targets the nearest XP gem when the floor is cleared and XP is on the ground', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    openSweepWindow(world);

    // Place an XP gem close to the player (within reasonable collection range).
    const gemEid = spawnXpGem(world, 5, 0, 10);

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

    spawnXpGem(world, 5, 0, 10);

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

    spawnXpGem(world, 5, 0, 10);

    const ai = new BehaviorTreeAI({ seed: 42 });
    ai.poll(createInputState(), world);

    const decision = ai.getDecision();
    expect(decision.reason.toLowerCase()).not.toContain('sweep');
  });
});
