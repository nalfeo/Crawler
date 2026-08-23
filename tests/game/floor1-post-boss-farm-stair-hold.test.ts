/**
 * Post-boss farm window — the Progress objective must honour the hold on the
 * **live** goal-graph path, not just the legacy fallback.
 *
 * Release-sweep regression (#3351, seed 11 / throwing-knife): the farm window
 * was wired into the headless auto-progression driver and into the legacy
 * `take-stairs` branch of `findProgressObjective`, but NOT into
 * `resolveFloor1MiddleChainObjective` — the goal-graph planner that actually
 * owns `take-stairs` whenever a floor map exists (i.e. in every real run). The
 * provider therefore kept routing the player onto the staircase while the
 * driver refused to confirm the descend underneath it. The player parked on the
 * stairs, thrashed against the pre-exit loot sweep, and the explore-dwell
 * watchdog re-armed `progressGoalSuppressed` indefinitely — a livelock that ran
 * the run into the frame cap.
 *
 * These tests pin the contract `post-boss-farm-window.ts` documents: while the
 * window is open the Progress objective yields nothing (so the normal
 * Engage/Collect/Explore ladder farms the floor), and the staircase target comes
 * back the moment the window closes.
 */
import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { FLOOR1_ACTIVE_TIME_BUDGET_MS } from '../../src/game/ai/floor1-run-budget.js';
import { initializeFloor1Scenario } from '../../src/game/floorScenario.js';
import { acceptQuest } from '../../src/core/systems/questSystem.js';
import { FLOOR1_BOSS_BATTLE_QUEST_ID } from '../../src/shared/quest-types.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import type { GameWorld } from '../../src/core/world.js';
import { createTestWorld } from '../helpers/world-factory.js';

interface ProgressTargetLike {
  readonly x: number;
  readonly y: number;
  readonly reason: string;
}

/** Private goal-graph entry point under test. */
interface MiddleChainHarness {
  resolveFloor1MiddleChainObjective(
    world: GameWorld,
    playerEid: number,
    playerX: number,
    playerY: number,
    floorScenario: NonNullable<GameWorld['floorScenario']>,
    objective: NonNullable<GameWorld['floorScenario']>['objective'],
    shopStage: string,
    hasFetchItem: boolean,
    progressSuppressed: boolean,
    maybeDetourToQuestGiver: (target: ProgressTargetLike) => ProgressTargetLike,
  ): ProgressTargetLike | null | undefined;
}

const STAIRS_REASON = 'Heading to the stairs to clear the floor';

/**
 * A Floor 1 world parked at the final `take-stairs` goal: every chain goal
 * satisfied, the staircase unlocked, and the descend not yet confirmed.
 */
function takeStairsWorld(elapsedMs: number): { world: GameWorld; player: number } {
  const world = createTestWorld({ seed: 42 });
  const player = spawnPlayer(world, 0, 0);
  initializeFloor1Scenario(world, player);
  world.state = 'playing';
  world.elapsedMs = elapsedMs;
  world.featureUnlocks.spells = true;
  world.goalFlags.set('floor1-boss-battle-complete', true);
  acceptQuest(world, FLOOR1_BOSS_BATTLE_QUEST_ID);

  const objective = world.floorScenario!.objective;
  objective.questAccepted = true;
  objective.questCompleted = true;
  objective.ratsKilled = objective.requiredRats;
  objective.slimesKilled = objective.requiredSlimes;
  objective.staircaseUnlocked = true;
  objective.staircaseDiscovered = false;
  for (const key of ['slime-rat', 'staircase'] as const) {
    const battle = objective.bossBattles.get(key);
    if (battle) {
      battle.started = true;
      battle.defeated = true;
    }
  }
  return { world, player };
}

function resolveStairTarget(
  world: GameWorld,
  player: number,
  reserveFraction: number,
): ProgressTargetLike | null | undefined {
  const ai = new BehaviorTreeAI({ seed: 42, postBossFarmReserveFraction: reserveFraction });
  const harness = ai as unknown as MiddleChainHarness;
  const scenario = world.floorScenario!;
  return harness.resolveFloor1MiddleChainObjective(
    world,
    player,
    world.stores.position.x[player] ?? 0,
    world.stores.position.y[player] ?? 0,
    scenario,
    scenario.objective,
    'complete',
    false,
    false,
    (target) => target,
  );
}

describe('Floor 1 post-boss farm window — goal-graph stair hold', () => {
  it('yields no Progress target while the farm window is still open', () => {
    const { world, player } = takeStairsWorld(60_000);
    expect(resolveStairTarget(world, player, 0.2)).toBeNull();
  });

  it('routes to the staircase once only the exit reserve is left', () => {
    // Past `budget - reserve`, so the window has closed permanently.
    const { world, player } = takeStairsWorld(FLOOR1_ACTIVE_TIME_BUDGET_MS * 0.9);
    const target = resolveStairTarget(world, player, 0.2);
    expect(target?.reason).toBe(STAIRS_REASON);
  });

  it('routes to the staircase immediately for a cohort that opts out of farming', () => {
    const { world, player } = takeStairsWorld(60_000);
    const target = resolveStairTarget(world, player, 1);
    expect(target?.reason).toBe(STAIRS_REASON);
  });

  it('keeps the provider and the headless driver on the same verdict', () => {
    const { world, player } = takeStairsWorld(60_000);
    const ai = new BehaviorTreeAI({ seed: 42, postBossFarmReserveFraction: 0.2 });
    // The driver asks the provider; the provider's own Progress objective must
    // agree, or the run parks on stairs the driver will not take.
    expect(ai.isFarmingPostBossFloorTime(world, world.floorScenario!.objective.deadlineMs)).toBe(
      true,
    );
    expect(resolveStairTarget(world, player, 0.2)).toBeNull();
  });
});
