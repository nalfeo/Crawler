/**
 * BT loot sweep tests (Priority 2.5).
 *
 * Two mutually-exclusive windows share this node:
 *   - **mid-run** (default, whenever the pre-exit window is not open): bounded
 *     to `LOOT_SWEEP_RADIUS_FT`, a local post-combat cleanup so drops from the
 *     fight that just ended aren't left behind while the AI moves on.
 *   - **pre-exit**: bounded to the AI scan radius, active while the floor
 *     staircase is unlocked and not yet discovered, because descending destroys
 *     every uncollected pickup.
 *
 * Verifies:
 *   - the window targets the nearest reachable XP gem (and gold);
 *   - loot beyond `LOOT_SWEEP_RADIUS_FT` but within `scanRadius` is swept in the
 *     pre-exit window but NOT in the mid-run window, for both the Floor 1 and the
 *     distinct Floor 2 staircase guards;
 *   - the sweep does NOT fire with nothing on the ground;
 *   - the sweep does NOT fire when an enemy is within engage range, including
 *     enemies currently ignored for target selection;
 *   - the mid-run window additionally stands down for any enemy inside the scan
 *     radius, so it never preempts post-retreat local threat recovery.
 */

import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { DEFAULT_CONFIG, LOOT_SWEEP_RADIUS_FT } from '../../../src/game/ai/bt-ai-tuning.js';
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

/** Distance (ft) that is unambiguously outside the mid-run sweep window. */
const BEYOND_LOCAL_WINDOW_FT = LOOT_SWEEP_RADIUS_FT + 5;

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

function pollDecision(world: ReturnType<typeof createTestWorld>) {
  const ai = new BehaviorTreeAI({ seed: 42 });
  ai.poll(createInputState(), world);
  return ai.getDecision();
}

function makeFloor1World() {
  const world = createTestWorld({ seed: 42 });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, player);
  selectFloor1StarterWeapon(world, 0);
  return { world, player, ...playerPos(world, player) };
}

describe('BT — loot sweep (Priority 2.5)', () => {
  describe('pre-exit (scan-radius) window', () => {
    it('targets the nearest XP gem when the floor is cleared and XP is on the ground', () => {
      const { world, x, y } = makeFloor1World();
      openSweepWindow(world);

      const gemEid = spawnXpGem(world, x + 5, y, 10);

      const decision = pollDecision(world);
      expect(decision.state).toBe(AIState.COLLECT);
      expect(decision.targetEid).toBe(gemEid);
      expect(decision.reason.toLowerCase()).toContain('sweep');
    });

    it('reaches past the local radius, which the mid-run window will not', () => {
      const { world, x, y } = makeFloor1World();
      openSweepWindow(world);

      const gemEid = spawnXpGem(world, x + BEYOND_LOCAL_WINDOW_FT, y, 10);

      const decision = pollDecision(world);
      expect(decision.state).toBe(AIState.COLLECT);
      expect(decision.targetEid).toBe(gemEid);
      expect(decision.reason.toLowerCase()).toContain('sweep');
    });

    it('does NOT chase loot beyond the scan radius', () => {
      const { world, x, y } = makeFloor1World();
      openSweepWindow(world);

      spawnXpGem(world, x + DEFAULT_CONFIG.scanRadius + 5, y, 10);

      const decision = pollDecision(world);
      expect(decision.reason.toLowerCase()).not.toContain('sweep');
    });

    it('does NOT sweep while an enemy sits inside the scan radius but outside engage range', () => {
      const { world, x, y } = makeFloor1World();
      openSweepWindow(world);

      spawnXpGem(world, x + 5, y, 10);
      // 32 ft: well outside the 20 ft melee engage radius, well inside the 50 ft
      // scan radius. The pre-exit window uses the same threat radius as its target
      // bound so nearby lingering enemies can still preempt the sweep.
      spawnEnemy(world, x + 32, y, 20);

      const decision = pollDecision(world);
      expect(decision.reason.toLowerCase()).not.toContain('sweep');
    });

    it('falls through to Progress when the floor is cleared but no loot remains', () => {
      const { world } = makeFloor1World();
      openSweepWindow(world);
      // No loot spawned — sweep has nothing to target, Progress should win.

      const decision = pollDecision(world);
      expect(decision.state).not.toBe(AIState.COLLECT);
    });

    it('does NOT sweep while an enemy sits inside the scan radius but outside engage range', () => {
      const { world, x, y } = makeFloor1World();
      openSweepWindow(world);

      spawnXpGem(world, x + 5, y, 10);
      spawnEnemy(world, x + 32, y, 20);

      const decision = pollDecision(world);
      expect(decision.reason.toLowerCase()).not.toContain('sweep');
    });
  });

  describe('mid-run (local) window', () => {
    it('sweeps a nearby XP gem while no staircase sweep window is open', () => {
      const { world, x, y } = makeFloor1World();
      // No `openSweepWindow` call — the pre-exit window is closed, so any sweep
      // that fires here must be the mid-run window.

      const gemEid = spawnXpGem(world, x + 5, y, 10);

      const decision = pollDecision(world);
      expect(decision.state).toBe(AIState.COLLECT);
      expect(decision.targetEid).toBe(gemEid);
      expect(decision.reason.toLowerCase()).toContain('sweep');
    });

    it('does NOT reach past LOOT_SWEEP_RADIUS_FT', () => {
      const { world, x, y } = makeFloor1World();

      spawnXpGem(world, x + BEYOND_LOCAL_WINDOW_FT, y, 10);

      const decision = pollDecision(world);
      expect(decision.reason.toLowerCase()).not.toContain('sweep');
    });

    it('falls through when nothing is on the ground', () => {
      const { world } = makeFloor1World();

      const decision = pollDecision(world);
      expect(decision.state).not.toBe(AIState.COLLECT);
    });

    it('does NOT sweep while an enemy sits inside the scan radius but outside engage range', () => {
      const { world, x, y } = makeFloor1World();

      spawnXpGem(world, x + 5, y, 10);
      // 32 ft: well outside the 20 ft melee engage radius, well inside the 50 ft
      // scan radius. The mid-run window deliberately uses the full scan radius so
      // it stays strictly post-combat and can never preempt LocalThreatRecovery,
      // which only ever latches a threat inside the scan radius.
      spawnEnemy(world, x + 32, y, 20);

      const decision = pollDecision(world);
      expect(decision.reason.toLowerCase()).not.toContain('sweep');
    });
  });

  describe('Floor 2 staircase guards', () => {
    function makeFloor2World() {
      const world = createTestWorld({ seed: 42, floor: 2 });
      const player = spawnPlayer(world, 0, 0);
      initializeFloor2Scenario(world, player);

      const floor2State = world.floorExtendedState?.familyState;
      if (!floor2State) throw new Error('No Floor 2 family state');
      const { x, y } = playerPos(world, player);
      floor2State.staircaseUnlocked = true;
      floor2State.staircaseSpawned = true;
      floor2State.staircaseDiscovered = false;
      floor2State.staircasePos = { x, y };
      return { world, floor2State, x, y };
    }

    it('sweeps distant XP once the staircase is unlocked, spawned, positioned, and undiscovered', () => {
      const { world, x, y } = makeFloor2World();

      const gemEid = spawnXpGem(world, x + BEYOND_LOCAL_WINDOW_FT, y, 10);

      const decision = pollDecision(world);
      expect(decision.state).toBe(AIState.COLLECT);
      expect(decision.targetEid).toBe(gemEid);
      expect(decision.reason.toLowerCase()).toContain('sweep');
    });

    it.each([
      'staircase still locked',
      'staircase not spawned yet',
      'staircase already discovered',
      'staircase position missing',
    ] as const)('does NOT open the unbounded window on Floor 2 when %s', (caseLabel: string) => {
      const { world, floor2State, x, y } = makeFloor2World();
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
      spawnXpGem(world, x + BEYOND_LOCAL_WINDOW_FT, y, 10);

      const decision = pollDecision(world);
      expect(decision.reason.toLowerCase()).not.toContain('sweep');
    });
  });

  it('does NOT sweep when an ignored enemy is already inside engage range', () => {
    const { world, x, y } = makeFloor1World();
    openSweepWindow(world);

    spawnXpGem(world, x + 5, y, 10);
    const enemy = spawnEnemy(world, x + 6, y, 20);

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
