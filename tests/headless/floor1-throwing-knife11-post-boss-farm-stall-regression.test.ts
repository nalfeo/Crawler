import { describe, expect, it } from 'vitest';
import { BehaviorTreeAI } from '../../src/game/ai/bt-ai-provider.js';
import { FLOOR1_DEFAULT_MAX_FRAMES } from '../../src/game/ai/floor1-run-budget.js';
import { runHeadless } from '../../src/game/ai/headless-runner.js';
import type { RunStats } from '../../src/game/ai/types.js';
import { FLOOR1_LEAVE_FLOOR_QUEST_ID } from '../../src/shared/quest-types.js';

function deterministicStats(stats: RunStats): Omit<RunStats, 'wallTimeMs'> {
  const { wallTimeMs: _wallTimeMs, ...deterministic } = stats;
  return deterministic;
}

async function runThrowingKnife11(): Promise<RunStats> {
  return runHeadless(new BehaviorTreeAI({ seed: 11 }), {
    seed: 11,
    maxFrames: FLOOR1_DEFAULT_MAX_FRAMES,
    maxWallTimeMs: 120_000,
    forceWeaponId: 'throwing-knife',
    enemyDamageMultiplier: 1,
  });
}

// Release sweep regression (#3351): the post-boss farm window was consulted by
// the headless auto-progression driver and by the LEGACY `take-stairs` branch of
// `findProgressObjective`, but not by `resolveFloor1MiddleChainObjective` — the
// goal-graph planner that actually owns that goal whenever a floor map exists.
// So the provider routed the player onto the staircase while the driver refused
// to confirm the descend, the player parked on the stairs thrashing against the
// pre-exit loot sweep, and the explore-dwell watchdog re-armed
// `progressGoalSuppressed` forever. This seed timed out at the frame cap with
// `suppressedProgressNav` as its dominant decision state. Fixed by applying the
// same farm-window hold on the goal-graph path.
describe('Floor 1 release sweep throwing-knife-11 post-boss farm-window stall regression', () => {
  it('clears the reported forced-throwing-knife seed with deterministic paired reruns', async () => {
    const first = await runThrowingKnife11();
    const second = await runThrowingKnife11();

    expect(first.startingWeapon).toBe('throwing-knife');
    expect(first.outcome).toBe('victory');
    expect(first.totalFrames).toBeLessThanOrEqual(FLOOR1_DEFAULT_MAX_FRAMES);
    expect(first.quests.questLogCompletions[FLOOR1_LEAVE_FLOOR_QUEST_ID]).toBeDefined();
    // The stall showed up as a dominant `suppressedProgressNav` decision state:
    // over half the run was spent wanting the staircase and being blocked.
    expect(first.aiTelemetry?.suppressedProgressNavMs ?? 0).toBeLessThan(first.gameTimeMs * 0.25);
    expect(deterministicStats(second)).toEqual(deterministicStats(first));
  }, 240_000);
});
